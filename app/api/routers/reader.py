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
