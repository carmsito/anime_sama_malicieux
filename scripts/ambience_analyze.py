#!/usr/bin/env python
"""
Analyse d'AMBIANCE des planches → segments RLE en DB.

Classifieur = TAGGER ANIME/MANGA (SmilingWolf/wd-vit-tagger-v3, ONNX) : entraîné sur
7,2M images Danbooru → DOMAINE manga (ne confond pas l'encre avec la pluie, contrairement
à CLIP). Léger : onnxruntime CPU, pas de torch. Sort des tags de scène (rain, night,
forest, ocean, indoors…) et d'action (fighting, blood, weapon…).

Lancer avec le venv qui a onnxruntime/pillow (pas le python du conteneur) :
  /home/emmanuel/ambience-proto/venv/bin/python scripts/ambience_analyze.py <manga_id> <chapter> <kind>
"""
import sys, os, io, re, csv, json, zipfile, sqlite3, time
import numpy as np

REPO = "/root/anime_sama_malicieux"
DB = f"{REPO}/srv-data/app.db"
CACHE = f"{REPO}/srv-data/epub_cache"
IMG_EXT = (".jpg", ".jpeg", ".png", ".webp")
TAGGER = "SmilingWolf/wd-vit-tagger-v3"
THRESH = 0.35   # seuil pour retenir un tag de scène

# tag Danbooru (au-dessus du seuil) → ambiance, par PRIORITÉ (1er trouvé gagne).
PRIORITY = [
    (["rain"], "pluie"),
    (["snow", "snowing", "snowscape"], "neige"),
    (["fire"], "feu"),
    (["ocean", "beach", "water", "river", "waterfall"], "ocean"),
    (["forest", "bamboo_forest"], "foret"),
    (["crowd", "market"], "foule"),
    (["city", "cityscape", "ruins"], "ville"),
    (["indoors"], "interieur"),
    (["night", "moon", "night_sky", "starry_sky", "darkness"], "nuit"),
    (["outdoors", "field", "mountain", "nature", "tree", "sky", "cloud", "road", "day", "sunlight"], "exterieur"),
]
ACTION_TAGS = {"fighting", "battle", "war", "sword", "weapon", "blood", "explosion",
               "motion_lines", "emphasis_lines", "speed_lines", "smoke"}
# L'ACTION n'est pas un décor mais un AXE orthogonal (mouvement/combat) : on la superpose
# en COUCHE au décor (interieur+action, foret+action…) dès que le segment bouge assez.
ACTION_ON = 0.45   # score d'action moyen d'un segment à partir duquel on ajoute la couche


def cache_epub(manga_id, chapter, kind):
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", f"{manga_id}__{kind}__{chapter}")
    return f"{CACHE}/{safe}.epub"


def load_tagger():
    import onnxruntime as ort
    from huggingface_hub import hf_hub_download
    mp = hf_hub_download(TAGGER, "model.onnx")
    tp = hf_hub_download(TAGGER, "selected_tags.csv")
    names, cats = [], []
    with open(tp) as f:
        for row in csv.DictReader(f):
            names.append(row["name"]); cats.append(int(row["category"]))
    sess = ort.InferenceSession(mp, providers=["CPUExecutionProvider"])
    _, H, W, _ = sess.get_inputs()[0].shape
    return sess, sess.get_inputs()[0].name, H, W, names, cats


def prep(im, W, H):
    from PIL import Image
    im = im.convert("RGBA"); bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
    bg.alpha_composite(im); im = bg.convert("RGB")
    w, h = im.size; m = max(w, h)
    sq = Image.new("RGB", (m, m), (255, 255, 255)); sq.paste(im, ((m - w) // 2, (m - h) // 2))
    sq = sq.resize((W, H), Image.BICUBIC)
    return np.expand_dims(np.asarray(sq, dtype=np.float32)[:, :, ::-1], 0)  # RGB->BGR


HEAD_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ambience_head.npz")


def load_head():
    """Tête entraînée (distillation de mes labels vérifiés) : régression logistique sur
    le vecteur de tags. None si absente → repli sur la règle de priorité."""
    try:
        z = np.load(HEAD_PATH, allow_pickle=True)
        return (z["coef"].astype("float32"), z["intercept"].astype("float32"),
                [str(c) for c in z["classes"]])
    except Exception:
        return None


def predict(p, gen, name2i, head):
    """HYBRIDE : classes distinctives via tags fiables (la règle marche bien pour elles),
    sinon la tête LR tranche ext/int/forêt (les confusions que la règle ratait)."""
    def tg(name):
        i = name2i.get(name); return float(p[i]) if i is not None else 0.0
    # PLUIE : le tag "rain" seul déclenche BEAUCOUP de faux positifs (hachures
    # verticales, lignes de vitesse, trames sombres d'action). On ne garde la pluie
    # que si le tagger voit AUSSI de l'eau / du mouillé (gouttes, vêtements/cheveux
    # mouillés, flaque, parapluie…) ET que ce n'est pas une planche d'action.
    wet = max(tg("wet"), tg("wet_clothes"), tg("wet_hair"), tg("water_drop"),
              tg("puddle"), tg("water"), tg("umbrella"), tg("raincoat"), tg("rain_boots"))
    speed = max(tg("speed_lines"), tg("motion_lines"), tg("emphasis_lines"))
    if tg("rain") > 0.5 and wet > 0.30 and speed < 0.60: return "pluie"
    if max(tg("snow"), tg("snowing"), tg("snowscape")) > 0.5: return "neige"
    if tg("fire") > 0.55: return "feu"
    if max(tg("ocean"), tg("beach")) > 0.5: return "ocean"
    if max(tg("city"), tg("cityscape")) > 0.5: return "ville"
    if max(tg("night"), tg("moon"), tg("night_sky")) > 0.5: return "nuit"
    if head is not None:
        coef, intercept, classes = head
        gvec = np.array([p[i] for i in gen], dtype="float32")
        return classes[int(np.argmax(coef @ gvec + intercept))]
    tags = {n: p[i] for n, i in name2i.items() if p[i] > THRESH}   # repli règle
    for keys, label in PRIORITY:
        if any(tags.get(t, 0) > THRESH for t in keys): return label
    return None


def classify(epub_path):
    from PIL import Image
    sess, inp, H, W, names, cats = load_tagger()
    gen = [i for i in range(len(names)) if cats[i] == 0]   # tags "general" (liste ORDONNÉE)
    name2i = {names[i]: i for i in gen}
    head = load_head()
    z = zipfile.ZipFile(epub_path)
    files = sorted(n for n in z.namelist() if n.lower().endswith(IMG_EXT))
    preds = []
    for n in files:
        try:
            im = Image.open(io.BytesIO(z.read(n)))
            p = sess.run(None, {inp: prep(im, W, H)})[0][0]
            amb = predict(p, gen, name2i, head)
            action = max([float(p[name2i[t]]) for t in ACTION_TAGS if t in name2i] + [0.0])
            preds.append((amb, action))
        except Exception:
            preds.append((None, 0.0))
    return preds


def fill(preds):
    """Les planches sans décor (None) héritent de l'ambiance connue la plus proche."""
    amb = [p[0] for p in preds]
    n = len(amb)
    last = None
    for i in range(n):
        if amb[i] is not None: last = amb[i]
        elif last is not None: amb[i] = last
    nxt = None                              # back-fill des None de tête
    for i in range(n - 1, -1, -1):
        if amb[i] is not None: nxt = amb[i]
        elif nxt is not None: amb[i] = nxt
    return [a if a is not None else "exterieur" for a in amb]


def smooth_rle(preds, min_seg=2):
    amb = fill(preds)
    acts = [p[1] for p in preds]
    segs = []
    for i, a in enumerate(amb):
        if segs and segs[-1]["amb"] == a:
            segs[-1]["to"] = i
        else:
            segs.append({"amb": a, "from": i, "to": i})
    merged = []
    for s in segs:
        if merged and (s["to"] - s["from"] + 1) < min_seg:
            merged[-1]["to"] = s["to"]
        else:
            merged.append(s)
    out = []
    for s in merged:
        rng = acts[s["from"]:s["to"] + 1]
        avg_act = round(sum(rng) / len(rng), 2)
        # layers = décor de base (+ "action" en surcouche si ça bouge). Le lecteur mixe
        # toutes les couches simultanément ; "ambience" reste le décor pour compat.
        layers = [s["amb"]]
        if avg_act >= ACTION_ON and s["amb"] != "action":
            layers.append("action")
        out.append({"from": s["from"], "to": s["to"], "ambience": s["amb"],
                    "layers": layers, "action": avg_act})
    return out


def store(manga_id, chapter, kind, segments, n_pages):
    con = sqlite3.connect(DB, timeout=30)
    con.execute("PRAGMA busy_timeout=30000")
    con.execute("""CREATE TABLE IF NOT EXISTS ambience_segments (
        manga_id TEXT, chapter_number REAL, kind TEXT, data TEXT, created_at TEXT,
        PRIMARY KEY (manga_id, chapter_number, kind))""")
    payload = json.dumps({"model": "wd-vit-tagger-v3", "pages": n_pages, "segments": segments})
    con.execute("INSERT OR REPLACE INTO ambience_segments VALUES (?,?,?,?,?)",
                (manga_id, float(chapter), kind, payload,
                 time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
    con.commit(); con.close()


def main():
    if len(sys.argv) < 4:
        print("usage: ambience_analyze.py <manga_id> <chapter> <kind>"); sys.exit(1)
    manga_id, chapter, kind = sys.argv[1], sys.argv[2], sys.argv[3]
    epub = cache_epub(manga_id, chapter, kind)
    if not os.path.exists(epub):
        print("EPUB non trouvé en cache:", epub); sys.exit(2)
    t0 = time.time()
    preds = classify(epub)
    segs = smooth_rle(preds)
    store(manga_id, chapter, kind, segs, len(preds))
    print(f"[{manga_id} {kind} {chapter}] {len(preds)} planches → {len(segs)} segments en {time.time() - t0:.0f}s")
    for s in segs:
        print(f"  p{s['from']:>3}-{s['to']:<3}  {'+'.join(s['layers']):18s} (action {s['action'] * 100:.0f}%)")


if __name__ == "__main__":
    main()
