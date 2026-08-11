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
