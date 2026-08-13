"""Détection des CASES (panels) d'une planche de manga pour le Mode Cinéma.

Combine :
  • un MODÈLE pré-entraîné (deepghs/manga109_yolo, variante nano, classe `frame`) via imgutils
    + onnxruntime (CPU) — excellent sur le fond perdu / gouttières noires (Vagabond, Dr-Stone) ;
  • une HEURISTIQUE (flood-fill + carte de contours) — comble les GROSSES cases borderless que
    le modèle rate parfois (ex. corps pleine hauteur de Baki), SANS réintroduire le bruit des
    bulles (on n'ajoute qu'une case heuristique large ET non couverte par le modèle).
Ordre de lecture MANGA (droite→gauche, haut→bas). Résultats cachés par empreinte d'image.
"""
from __future__ import annotations
import io, hashlib
from collections import deque

import numpy as np
from PIL import Image

_REPO = "deepghs/manga109_yolo"
_MODEL = "v2023.12.07_n"
_CONF = 0.25
_cache: dict[str, list] = {}


def _order_manga(rects, w, h):
    rows = []
    for p in sorted(rects, key=lambda r: r["y"]):
        pb = p["y"] + p["h"]; row = None
        for r in rows:
            ov = min(pb, r["y1"]) - max(p["y"], r["y0"])
            if ov > 0.5 * min(p["h"], r["y1"] - r["y0"]):
                row = r; break
        if row:
            row["items"].append(p); row["y0"] = min(row["y0"], p["y"]); row["y1"] = max(row["y1"], pb)
        else:
            rows.append({"y0": p["y"], "y1": pb, "items": [p]})
    rows.sort(key=lambda r: r["y0"]); out = []
    for r in rows:
        r["items"].sort(key=lambda p: -(p["x"] + p["w"])); out += r["items"]
    return out


# ── Heuristique (repli / complément) : renvoie des cases normalisées [0..1] ──
def _proj_cut(mask, w, h, minSideF, minGutF, gapFrac):
    sat = np.zeros((h + 1, w + 1), dtype=np.int64)
    sat[1:, 1:] = np.cumsum(np.cumsum(mask, axis=0), axis=1)
    S = lambda x0, y0, x1, y1: int(sat[y1, x1] - sat[y0, x1] - sat[y1, x0] + sat[y0, x0])
    minSide = min(w, h) * minSideF; minGut = max(4, round(min(w, h) * minGutF))
    def gap(lo, hi, empty):
        best = None; i = lo
        while i < hi:
            if not empty(i): i += 1; continue
            j = i
            while j < hi and empty(j): j += 1
            if not (i == lo or j == hi) and (j - i) >= minGut and (best is None or (j - i) > best[2]): best = (i, j, j - i)
            i = j
        return best
    out = []; stack = [(0, 0, w, h, 0)]
    while stack:
        x0, y0, x1, y1, d = stack.pop(); bw = x1 - x0; bh = y1 - y0
        if bw < minSide or bh < minSide or d > 10: out.append((x0, y0, x1, y1)); continue
        rt = bw * gapFrac; ct = bh * gapFrac
        hG = gap(y0, y1, lambda y: S(x0, y, x1, y + 1) <= rt)
        vG = gap(x0, x1, lambda x: S(x, y0, x + 1, y1) <= ct)
        if hG and (vG is None or hG[2] >= vG[2]):
            stack += [(x0, y0, x1, hG[0], d + 1), (x0, hG[1], x1, y1, d + 1)]
        elif vG:
            stack += [(x0, y0, vG[0], y1, d + 1), (vG[1], y0, x1, y1, d + 1)]
        else: out.append((x0, y0, x1, y1))
    def trim(x0, y0, x1, y1):
        while x0 < x1 and S(x0, y0, x0 + 1, y1) == 0: x0 += 1
        while x1 > x0 and S(x1 - 1, y0, x1, y1) == 0: x1 -= 1
        while y0 < y1 and S(x0, y0, x1, y0 + 1) == 0: y0 += 1
        while y1 > y0 and S(x0, y1 - 1, x1, y1) == 0: y1 -= 1
        if x1 - x0 < minSide or y1 - y0 < minSide: return None
        return {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}
    ps = [t for t in (trim(*r) for r in out) if t]
    return _order_manga(ps, w, h) if len(ps) >= 2 else None


def _heuristic(img, maxW=700):
    iw, ih = img.size
    s = min(1.0, maxW / iw); w = max(1, round(iw * s)); h = max(1, round(ih * s))
    a = np.asarray(img.resize((w, h)), dtype=np.int16)
    b = np.concatenate([a[0], a[h - 1], a[:, 0], a[:, w - 1]], axis=0).mean(axis=0)
    dd = np.abs(a - b); TOL = 48
    raw = ((dd[:, :, 0] >= TOL) | (dd[:, :, 1] >= TOL) | (dd[:, :, 2] >= TOL)).astype(np.uint8)
    content = raw.astype(bool)
    for _ in range(2):
        n = content.copy()
        n[:-1] |= content[1:]; n[1:] |= content[:-1]; n[:, :-1] |= content[:, 1:]; n[:, 1:] |= content[:, :-1]
        content = n
    gutter = np.zeros((h, w), bool); dq = deque()
    def seed(y, x):
        if not content[y, x] and not gutter[y, x]: gutter[y, x] = True; dq.append((y, x))
    for x in range(w): seed(0, x); seed(h - 1, x)
    for y in range(h): seed(y, 0); seed(y, w - 1)
    while dq:
        y, x = dq.popleft()
        if x > 0: seed(y, x - 1)
        if x < w - 1: seed(y, x + 1)
        if y > 0: seed(y - 1, x)
        if y < h - 1: seed(y + 1, x)
    seen = np.zeros((h, w), bool); minArea = w * h * 0.008; minSide = min(w, h) * 0.05; rects = []
    for y0 in range(h):
        for x0 in range(w):
            if gutter[y0, x0] or seen[y0, x0]: continue
            q = deque([(y0, x0)]); seen[y0, x0] = True; xa = xb = x0; ya = yb = y0; area = 0
            while q:
                y, x = q.popleft(); area += 1
                xa = min(xa, x); xb = max(xb, x); ya = min(ya, y); yb = max(yb, y)
                for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and not gutter[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True; q.append((ny, nx))
            bw = xb - xa + 1; bh = yb - ya + 1
            if area >= minArea and bw >= minSide and bh >= minSide and area / (bw * bh) >= 0.18:
                rects.append({"x": xa, "y": ya, "w": bw, "h": bh})
    rects = [r for r in rects if r["w"] * r["h"] < w * h * 0.96]
    if len(rects) >= 2:
        ordered = _order_manga(rects, w, h)
    else:
        g = np.asarray(img.convert("L").resize((w, h)), dtype=np.int16)
        gx = np.abs(np.diff(g, axis=1, prepend=g[:, :1])); gy = np.abs(np.diff(g, axis=0, prepend=g[:1, :]))
        E = ((gx + gy) > 24).astype(np.uint8)
        ordered = _proj_cut(E, w, h, 0.07, 0.010, 0.020) or []
    return [{"x": r["x"] / w, "y": r["y"] / h, "w": r["w"] / w, "h": r["h"] / h} for r in ordered]


# ── Modèle YOLOv8 (deepghs/manga109_yolo, nano) exécuté DIRECTEMENT via onnxruntime ──
# Classes du modèle : {0:body, 1:face, 2:frame, 3:text} → on ne garde que `frame` (=2).
_FRAME_CLS = 2
_session = None

def _get_session():
    global _session
    if _session is None:
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        try:   # cache HF_HOME (srv-data) déjà présent → hors-ligne, pas de requête réseau
            path = hf_hub_download(_REPO, f"{_MODEL}/model.onnx", local_files_only=True)
        except Exception:
            path = hf_hub_download(_REPO, f"{_MODEL}/model.onnx")   # 1er coup : télécharge puis persiste
        _session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    return _session


def _nms(boxes, scores, thr):
    order = scores.argsort()[::-1]; keep = []
    while len(order):
        i = order[0]; keep.append(i)
        if len(order) == 1: break
        rest = order[1:]
        xx0 = np.maximum(boxes[i, 0], boxes[rest, 0]); yy0 = np.maximum(boxes[i, 1], boxes[rest, 1])
        xx1 = np.minimum(boxes[i, 2], boxes[rest, 2]); yy1 = np.minimum(boxes[i, 3], boxes[rest, 3])
        inter = np.clip(xx1 - xx0, 0, None) * np.clip(yy1 - yy0, 0, None)
        ai = (boxes[i, 2] - boxes[i, 0]) * (boxes[i, 3] - boxes[i, 1])
        ar = (boxes[rest, 2] - boxes[rest, 0]) * (boxes[rest, 3] - boxes[rest, 1])
        iou = inter / (ai + ar - inter + 1e-6)
        order = rest[iou < thr]
    return keep


def _model_frames(img):
    W, H = img.size
    size = 640
    scale = min(size / W, size / H)
    nw, nh = max(1, round(W * scale)), max(1, round(H * scale))
    canvas = Image.new("RGB", (size, size), (114, 114, 114))
    ox, oy = (size - nw) // 2, (size - nh) // 2
    canvas.paste(img.resize((nw, nh)), (ox, oy))
    arr = (np.asarray(canvas, dtype=np.float32) / 255.0).transpose(2, 0, 1)[None]  # 1,3,640,640
    out = _get_session().run(None, {"images": arr})[0][0].T   # [N, 8] = 4 box + 4 classes
    scores = out[:, 4:8]
    cls = scores.argmax(1); conf = scores.max(1)
    keep = (cls == _FRAME_CLS) & (conf >= _CONF)
    b = out[keep, :4]; c = conf[keep]
    if len(b) == 0:
        return []
    x0 = (b[:, 0] - b[:, 2] / 2 - ox) / scale; y0 = (b[:, 1] - b[:, 3] / 2 - oy) / scale
    x1 = (b[:, 0] + b[:, 2] / 2 - ox) / scale; y1 = (b[:, 1] + b[:, 3] / 2 - oy) / scale
    xyxy = np.stack([x0, y0, x1, y1], 1)
    res = []
    for i in _nms(xyxy, c, 0.45):
        X0 = max(0.0, min(W, xyxy[i, 0])); Y0 = max(0.0, min(H, xyxy[i, 1]))
        X1 = max(0.0, min(W, xyxy[i, 2])); Y1 = max(0.0, min(H, xyxy[i, 3]))
        if X1 - X0 > 0 and Y1 - Y0 > 0:
            res.append({"x": float(X0), "y": float(Y0), "w": float(X1 - X0), "h": float(Y1 - Y0)})
    return [r for r in res if r["w"] * r["h"] >= 0.015 * W * H]   # jette les slivers


def _overlap(a, m):
    ix = max(0, min(a["x"] + a["w"], m["x"] + m["w"]) - max(a["x"], m["x"]))
    iy = max(0, min(a["y"] + a["h"], m["y"] + m["h"]) - max(a["y"], m["y"]))
    inter = ix * iy
    return inter / (a["w"] * a["h"] + 1e-6)


def detect(raw_bytes: bytes) -> list:
    key = hashlib.sha1(raw_bytes).hexdigest()
    if key in _cache:
        return _cache[key]
    img = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
    W, H = img.size
    try:
        M = _model_frames(img)
    except Exception:
        M = []
    # heuristique (normalisée) → pixels
    Hn = _heuristic(img)
    Hpx = [{"x": r["x"] * W, "y": r["y"] * H, "w": r["w"] * W, "h": r["h"] * H} for r in Hn]
    merged = list(M)
    for hf in Hpx:                                   # ajoute seulement les GRANDES cases non couvertes
        if hf["w"] * hf["h"] < 0.06 * W * H: continue
        if max((_overlap(hf, m) for m in M), default=0) < 0.35:
            merged.append(hf)
    if not merged:
        merged = [{"x": 0, "y": 0, "w": W, "h": H}]
    ordered = _order_manga(merged, W, H)
    res = [{"x": r["x"] / W, "y": r["y"] / H, "w": r["w"] / W, "h": r["h"] / H} for r in ordered]
    if len(_cache) > 800:
        _cache.clear()
    _cache[key] = res
    return res
