"""Lecture ZIP « live » d'un EPUB stocké sur Telegram, SANS le rapatrier en entier.

Un EPUB est un ZIP. On lit seulement :
  1. la fin du fichier → l'EOCD (End Of Central Directory) → position/taille de la table,
  2. la table centrale → offsets/tailles de chaque entrée (mise en CACHE par msg_id),
  3. pour chaque page demandée : l'en-tête local + les octets compressés de CETTE image,
     qu'on décompresse à la volée.
Empreinte : quelques Ko par page, rien n'est stocké. Ordre des images identique à
epub_reader (extensions image + tri naturel) pour que les index de page coïncident.
"""
import re
import struct
import zlib
from typing import Optional

from . import telegram_client

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
MEDIA_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
               ".webp": "image/webp", ".gif": "image/gif"}

# Table centrale parsée, partagée entre tous les lecteurs (idée « table ZIP en cache »).
_cd_cache: dict[int, list] = {}
_MAX_CD_CACHE = 200


def _natural_key(name: str) -> list:
    return [int(p) if p.isdigit() else p.lower() for p in re.split(r"(\d+)", name)]


def _ext(name: str) -> str:
    i = name.rfind(".")
    return name[i:].lower() if i >= 0 else ""


def _entries(msg_id: int, size: int) -> list:
    """Liste ordonnée des entrées image : [{name, method, comp_size, lho}]. Mise en cache."""
    cached = _cd_cache.get(msg_id)
    if cached is not None:
        return cached
    if not size or size < 22:
        raise ValueError("taille inconnue")
    cli = telegram_client.get_client()

    # 1) EOCD dans la fin du fichier (22 + commentaire ≤ 65535).
    tail_len = min(size, 65557)
    tail = cli.read_range(msg_id, size - tail_len, tail_len)
    i = tail.rfind(b"PK\x05\x06")
    if i < 0:
        raise ValueError("EOCD introuvable")
    cd_size, cd_offset = struct.unpack("<II", tail[i + 12:i + 20])
    if cd_offset == 0xFFFFFFFF or cd_size == 0xFFFFFFFF:
        raise ValueError("ZIP64 non supporté")   # EPUB manga : jamais le cas → repli

    # 2) Table centrale.
    cd = cli.read_range(msg_id, cd_offset, cd_size)
    entries = []
    p = 0
    while p + 46 <= len(cd) and cd[p:p + 4] == b"PK\x01\x02":
        method = struct.unpack("<H", cd[p + 10:p + 12])[0]
        comp_size = struct.unpack("<I", cd[p + 20:p + 24])[0]
        name_len = struct.unpack("<H", cd[p + 28:p + 30])[0]
        extra_len = struct.unpack("<H", cd[p + 30:p + 32])[0]
        comment_len = struct.unpack("<H", cd[p + 32:p + 34])[0]
        lho = struct.unpack("<I", cd[p + 42:p + 46])[0]
        name = cd[p + 46:p + 46 + name_len].decode("utf-8", "replace")
        entries.append({"name": name, "method": method, "comp_size": comp_size, "lho": lho})
        p += 46 + name_len + extra_len + comment_len

    imgs = [e for e in entries if _ext(e["name"]) in IMAGE_EXTS]
    imgs.sort(key=lambda e: _natural_key(e["name"]))
    if len(_cd_cache) > _MAX_CD_CACHE:
        _cd_cache.clear()
    _cd_cache[msg_id] = imgs
    return imgs


def image_count(msg_id: int, size: int) -> int:
    return len(_entries(msg_id, size))


def image_data(msg_id: int, size: int, idx: int) -> tuple[Optional[bytes], Optional[str]]:
    imgs = _entries(msg_id, size)
    if idx < 0 or idx >= len(imgs):
        return None, None
    e = imgs[idx]
    cli = telegram_client.get_client()

    # En-tête local (30 o fixes) → longueurs nom/extra (peuvent différer de la table centrale).
    lh = cli.read_range(msg_id, e["lho"], 30)
    if len(lh) < 30 or lh[:4] != b"PK\x03\x04":
        return None, None
    name_len = struct.unpack("<H", lh[26:28])[0]
    extra_len = struct.unpack("<H", lh[28:30])[0]
    data_off = e["lho"] + 30 + name_len + extra_len

    raw = cli.read_range(msg_id, data_off, e["comp_size"])
    if e["method"] == 0:
        data = raw
    elif e["method"] == 8:
        data = zlib.decompress(raw, -15)
    else:
        return None, None
    return data, MEDIA_TYPES.get(_ext(e["name"]), "image/jpeg")
