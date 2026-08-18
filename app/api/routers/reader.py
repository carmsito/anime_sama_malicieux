"""Profils de lecture par utilisateur (synchronisés par compte → multi-appareils).

Le backend ne fait que STOCKER/RENVOYER un blob JSON opaque ({profiles, defaultId,
activeId, perManga}). Toute la logique de modèle (profil par défaut, valeurs autorisées,
migration depuis l'ancien localStorage) vit côté client.
"""
import json

from fastapi import APIRouter, Depends

from ..auth import get_current_user
from ..services import db

router = APIRouter(tags=["reader"])


@router.get("/me/reader-profiles", summary="Profils de lecture de l'utilisateur")
def get_profiles(user: dict = Depends(get_current_user)):
    raw = db.get_reader_profiles(user["id"])
    return json.loads(raw) if raw else None


@router.put("/me/reader-profiles", summary="Enregistrer les profils de lecture")
def put_profiles(body: dict, user: dict = Depends(get_current_user)):
    db.set_reader_profiles(user["id"], json.dumps(body))
    return {"ok": True}


@router.post("/reader/panel-debug", summary="Enregistrer une image de découpe (debug détection de cases)")
def save_panel_debug(body: dict, user: dict = Depends(get_current_user)):
    """Reçoit un PNG (data URL) rendu côté client avec les contours des cases → l'écrit dans
    data/panel_debug/ (monté sur srv-data/) pour analyse serveur. Auth requise, taille bornée."""
    import base64, re
    from pathlib import Path
    from ..config import DATA_DIR
    data = (body.get("image") or "")
    m = re.match(r"^data:image/png;base64,(.+)$", data, re.DOTALL)
    if not m:
        return {"ok": False, "error": "image invalide"}
    try:
        raw = base64.b64decode(m.group(1))
    except Exception:
        return {"ok": False, "error": "base64 invalide"}
    if len(raw) > 8_000_000:
        return {"ok": False, "error": "image trop lourde"}
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", (body.get("name") or "page"))[:120]
    d = Path(DATA_DIR) / "panel_debug"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{safe}.png").write_bytes(raw)
    return {"ok": True, "name": f"{safe}.png"}


@router.post("/reader/panels", summary="Détecter les cases d'une planche (Mode Cinéma)")
def detect_panels_ep(body: dict, user: dict = Depends(get_current_user)):
    """Reçoit la planche courante (data URL, envoyée par le client) → renvoie les cases
    détectées (modèle YOLO manga109 + heuristique), normalisées [0..1], en ordre de lecture."""
    import base64, re
    data = (body.get("image") or "")
    m = re.match(r"^data:image/(?:png|jpeg);base64,(.+)$", data, re.DOTALL)
    if not m:
        return {"panels": []}
    try:
        raw = base64.b64decode(m.group(1))
    except Exception:
        return {"panels": []}
    if len(raw) > 8_000_000:
        return {"panels": []}
    try:
        from ..services import panels as panels_svc
        return {"panels": panels_svc.detect(raw)}
    except Exception as e:
        return {"panels": [], "error": str(e)[:200]}


@router.post("/reader/panels-page", summary="Détecter les cases d'une page (le serveur lit l'image)")
def detect_panels_by_page(body: dict, user: dict = Depends(get_current_user)):
    """Le client n'envoie que {mangaId, chapterNum, page} → le SERVEUR récupère l'image lui-même
    et découpe. Évite le réupload de la planche (le vrai goulot sur connexion lente) ; réponse
    minuscule + cache disque par empreinte d'image côté serveur."""
    mid = body.get("mangaId")
    try:
        ch = float(body.get("chapterNum"))
        idx = int(body.get("page"))
    except (TypeError, ValueError):
        return {"panels": []}
    if not mid:
        return {"panels": []}
    try:
        from . import mangas
        from ..services import panels as panels_svc
        data, _ = mangas.chapter_image_bytes(mid, ch, idx)
        if not data:
            return {"panels": []}
        return {"panels": panels_svc.detect(data)}
    except Exception as e:
        return {"panels": [], "error": str(e)[:200]}
