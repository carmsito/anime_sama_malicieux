#!/usr/bin/env python
"""
Analyse d'AMBIANCE des planches d'un chapitre → segments RLE en DB.

À lancer avec le venv qui a torch/open_clip (PAS le python du conteneur) :
  /home/emmanuel/ambience-proto/venv/bin/python scripts/ambience_analyze.py <manga_id> <chapter> <kind>

Pour chaque planche : ambiance de fond (zero-shot CLIP, depuis l'IMAGE) + score
d'action séparé. Lissage temporel → segments stables (RLE), stockés dans la table
`ambience_segments` de srv-data/app.db. Borné RAM : modèle chargé une fois, 1 image
à la fois, le process sort à la fin (RAM libérée).
"""
import sys, os, io, re, json, zipfile, sqlite3, time
from collections import Counter

REPO = "/root/anime_sama_malicieux"
DB = f"{REPO}/srv-data/app.db"
CACHE = f"{REPO}/srv-data/epub_cache"
IMG_EXT = (".jpg", ".jpeg", ".png", ".webp")
MODEL = ("ViT-B-32", "laion2b_s34b_b79k")

# AMBIANCE = décor de fond (→ boucle sonore). L'action est un signal SÉPARÉ (→ musique).
CLASSES = {
    "pluie":     "a manga panel of a rainy scene, rain falling, storm",
    "foret":     "a manga panel of a forest with trees and nature outdoors",
    "ville":     "a manga panel of a city street with buildings",
    "ocean":     "a manga panel of the ocean, the sea or a ship on water",
    "nuit":      "a manga panel of a dark scene at night",
    "interieur": "a manga panel of a calm indoor room, quiet interior",
    "foule":     "a manga panel of a crowd of people, a village or a market",
    "neige":     "a manga panel of snow, a cold winter landscape",
    "montagne":  "a manga panel of mountains, cliffs or wide open fields",
    "ciel":      "a manga panel of the open sky with clouds",
}
ACTION = [
    "a manga panel of intense action, fighting, explosion, motion and speed lines",
    "a calm, quiet, still manga panel with little motion",
]


def cache_epub(manga_id, chapter, kind):
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", f"{manga_id}__{kind}__{chapter}")
    return f"{CACHE}/{safe}.epub"


def load_model():
    os.environ.setdefault("OMP_NUM_THREADS", "2")
    import torch
    torch.set_num_threads(2)
    import open_clip
    m, _, prep = open_clip.create_model_and_transforms(MODEL[0], pretrained=MODEL[1])
    return torch, m.eval(), prep, open_clip.get_tokenizer(MODEL[0])


def classify(epub_path):
    from PIL import Image
    torch, model, preprocess, tok = load_model()
    labels = list(CLASSES)
    with torch.no_grad():
        tfeat = model.encode_text(tok([CLASSES[k] for k in labels])); tfeat /= tfeat.norm(dim=-1, keepdim=True)
        afeat = model.encode_text(tok(ACTION)); afeat /= afeat.norm(dim=-1, keepdim=True)
    z = zipfile.ZipFile(epub_path)
    names = sorted(n for n in z.namelist() if n.lower().endswith(IMG_EXT))
    preds = []
    for n in names:
        try:
            im = Image.open(io.BytesIO(z.read(n))).convert("RGB")
            im.thumbnail((320, 480))
            x = preprocess(im).unsqueeze(0)
            with torch.no_grad():
                f = model.encode_image(x); f /= f.norm(dim=-1, keepdim=True)
                amb = (100 * f @ tfeat.T).softmax(dim=-1)[0]
                act = (100 * f @ afeat.T).softmax(dim=-1)[0][0].item()
            i = int(amb.argmax())
            preds.append((labels[i], float(amb[i]), float(act)))
        except Exception as e:
            preds.append(("interieur", 0.0, 0.0))  # planche illisible → neutre
    return preds


def smooth_rle(preds, window=3, min_seg=2):
    """Mode-filter (fenêtre) puis fusion en segments, avec longueur mini."""
    labs = [p[0] for p in preds]
    n = len(labs)
    sm = []
    for i in range(n):
        w = labs[max(0, i - window // 2):i + window // 2 + 1]
        sm.append(Counter(w).most_common(1)[0][0])
    # segments consécutifs
    segs = []
    for i, lab in enumerate(sm):
        if segs and segs[-1]["amb"] == lab:
            segs[-1]["to"] = i
        else:
            segs.append({"amb": lab, "from": i, "to": i})
    # fusion des segments trop courts dans le voisin précédent
    merged = []
    for s in segs:
        length = s["to"] - s["from"] + 1
        if merged and length < min_seg:
            merged[-1]["to"] = s["to"]
        else:
            merged.append(s)
    # enrichit : confiance moyenne + action moyenne par segment
    out = []
    for s in merged:
        rng = preds[s["from"]:s["to"] + 1]
        conf = sum(p[1] for p in rng) / len(rng)
        act = sum(p[2] for p in rng) / len(rng)
        out.append({"from": s["from"], "to": s["to"], "ambience": s["amb"],
                    "conf": round(conf, 2), "action": round(act, 2)})
    return out


def store(manga_id, chapter, kind, segments, n_pages):
    con = sqlite3.connect(DB, timeout=30)
    con.execute("PRAGMA busy_timeout=30000")
    con.execute("""CREATE TABLE IF NOT EXISTS ambience_segments (
        manga_id TEXT, chapter_number REAL, kind TEXT,
        data TEXT, created_at TEXT,
        PRIMARY KEY (manga_id, chapter_number, kind))""")
    payload = json.dumps({"model": MODEL[0], "pages": n_pages, "segments": segments})
    con.execute("INSERT OR REPLACE INTO ambience_segments VALUES (?,?,?,?,?)",
                (manga_id, float(chapter), kind, payload, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
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
    print(f"[{manga_id} {kind} {chapter}] {len(preds)} planches → {len(segs)} segments "
          f"en {time.time() - t0:.0f}s")
    for s in segs:
        print(f"  p{s['from']:>3}-{s['to']:<3}  {s['ambience']:10s} "
              f"(conf {s['conf'] * 100:.0f}%, action {s['action'] * 100:.0f}%)")


if __name__ == "__main__":
    main()
