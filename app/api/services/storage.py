"""
Storage — backend de stockage des EPUB, pluggable.

But : ne garder sur le serveur (disque limité, gratuit) que le produit fini
*temporairement*, et déporter le stockage durable sur **Telegram**. La DB
(`db.telegram_files`) ne conserve que le lien (file_id / msg_id).

Deux backends :
  • LocalStorage    — défaut. Les EPUB restent dans extraction/ (comportement actuel).
  • TelegramStorage — MTProto (Telethon). Upload de l'EPUB fini → file_id → DB →
                      purge/cache local. Choisi car les volumes atteignent
                      75–106 Mo, au-delà des limites Bot API (50 Mo envoi / 20 Mo dl).

Activation par variables d'env (voir config). Sans creds → LocalStorage.
L'import de Telethon est paresseux : le reste de l'app fonctionne sans la lib.
"""
from __future__ import annotations

import re
import threading
from pathlib import Path
from typing import Optional

from ..config import (
    STORAGE_BACKEND, TELEGRAM_API_ID, TELEGRAM_API_HASH,
    TELEGRAM_CHANNEL, TELEGRAM_SESSION,
)
from . import db


class LocalStorage:
    """EPUB laissés sur le disque local. Aucun offload."""
    enabled = True
    name = "local"

    def store_epub(self, manga_id: str, chapter_number: float, kind: str, epub_path: Path) -> dict:
        # Rien à faire : le fichier reste servi depuis extraction/ par library/mangas router.
        return {"backend": "local", "path": str(epub_path)}

    def fetch_epub(self, manga_id: str, chapter_number: float, kind: str) -> Optional[Path]:
        return None  # le router lit directement le disque


class TelegramStorage:
    """
    Offload MTProto (via telegram_client, thread-safe). Upload de l'EPUB fini vers
    un canal privé → file_id/msg_id persistés en DB → suppression du local pour
    libérer le disque. Re-download à la demande dans un cache court-vécu.
    """
    name = "telegram"

    def __init__(self):
        self.enabled = bool(TELEGRAM_API_ID and TELEGRAM_API_HASH and TELEGRAM_CHANNEL)

    def store_epub(self, manga_id: str, chapter_number: float, kind: str, epub_path: Path) -> dict:
        import zipfile
        from .telegram_client import get_client
        size = epub_path.stat().st_size if epub_path.exists() else None

        # ── Garde-fou 1 : l'EPUB local est-il un ZIP COMPLET ? ──
        # (un EPUB tronqué à la création n'a pas de central directory → illisible plus tard,
        #  d'où les volumes "sans cover" impossibles à ouvrir). On refuse d'uploader ça.
        try:
            with zipfile.ZipFile(str(epub_path)) as zf:
                bad = zf.testzip()  # None si tout est OK
            if bad is not None:
                raise ValueError(f"entrée corrompue: {bad}")
        except Exception as e:
            raise RuntimeError(f"EPUB invalide/tronqué avant upload ({epub_path.name}): {e}")

        res = get_client().send_file(str(epub_path), caption=f"{manga_id} | {kind} {chapter_number}")

        # ── Garde-fou 2 : la taille uploadée correspond-elle au fichier local ? ──
        up = res.get("uploaded_size")
        if size and up is not None and up != size:
            # upload tronqué → on supprime le message bancal et on lève (le job réessaiera)
            try:
                get_client().delete(res["msg_id"])
            except Exception:
                pass
            raise RuntimeError(f"Upload tronqué {epub_path.name}: {up} != {size} (local)")

        db.put_file(
            manga_id, chapter_number, kind,
            file_id=res["file_id"], msg_id=res["msg_id"], size=size, filename=epub_path.name,
        )
        # Invalide un éventuel cache local (ré-upload/réparation) → prochain read = fichier frais.
        purge_cache(manga_id, chapter_number, kind)
        # Libère le disque : le fichier vit désormais sur Telegram (indexé en DB).
        try:
            epub_path.unlink(missing_ok=True)
        except Exception:
            pass
        return {"backend": "telegram", **res, "size": size}

    def fetch_epub(self, manga_id: str, chapter_number: float, kind: str) -> Optional[Path]:
        rec = db.get_file(manga_id, chapter_number, kind)
        if not rec:
            return None
        from ..config import DATA_DIR
        from .telegram_client import get_client
        cache = DATA_DIR / "epub_cache"
        cache.mkdir(parents=True, exist_ok=True)
        # Nom de cache UNIQUE par manga+kind+chapitre (sinon "Chapitre 1.epub"
        # collisionne entre mangas → mauvais contenu servi).
        import re as _re
        safe = _re.sub(r"[^A-Za-z0-9._-]+", "-", f"{manga_id}__{kind}__{chapter_number}")
        out = cache / f"{safe}.epub"
        if out.exists() and out.stat().st_size > 0:
            return out
        get_client().download(rec["msg_id"], str(out))
        return out if out.exists() else None


# ── Sélection du backend (singleton) ──────────────────────────────────────────

_backend = None
_backend_lock = threading.Lock()


def get_backend():
    global _backend
    if _backend is not None:
        return _backend
    with _backend_lock:
        if _backend is not None:
            return _backend
        if STORAGE_BACKEND == "telegram":
            tg = TelegramStorage()
            _backend = tg if tg.enabled else LocalStorage()
            if not tg.enabled:
                print("[storage] TELEGRAM_* incomplet → fallback LocalStorage", flush=True)
        else:
            _backend = LocalStorage()
        print(f"[storage] backend = {_backend.name}", flush=True)
        return _backend


def store_epub(manga_id: str, chapter_number: float, kind: str, epub_path: Path) -> dict:
    return get_backend().store_epub(manga_id, chapter_number, kind, Path(epub_path))


def fetch_epub(manga_id: str, chapter_number: float, kind: str) -> Optional[Path]:
    return get_backend().fetch_epub(manga_id, chapter_number, kind)


def purge_cache(manga_id: str, chapter_number: float, kind: str) -> None:
    """Supprime l'EPUB en cache local + la cover de chapitre en cache pour ce chapitre →
    force un re-download/re-extraction frais. Indispensable après un ré-upload (réparation)."""
    try:
        from ..config import DATA_DIR, COVERS_DIR
        cache = DATA_DIR / "epub_cache"
        if cache.exists():
            prefix = re.sub(r"[^A-Za-z0-9._-]+", "-", f"{manga_id}__{kind}__{chapter_number}")
            for f in cache.glob("*.epub"):
                if f.stem.startswith(prefix):
                    f.unlink(missing_ok=True)
        # cover de chapitre en cache (COVERS_DIR/ch/{manga_id}__{chapter}.jpg)
        cf = COVERS_DIR / "ch" / (re.sub(r"[^A-Za-z0-9._-]+", "-", f"{manga_id}__{chapter_number}") + ".jpg")
        cf.unlink(missing_ok=True)
    except Exception:
        pass


def delete_epub(manga_id: str, chapter_number: float, kind: str) -> None:
    """Supprime le message Telegram (si offloadé) + l'entrée DB + le cache local."""
    rec = db.get_file(manga_id, chapter_number, kind)
    if rec and rec.get("msg_id"):
        try:
            from .telegram_client import get_client
            get_client().delete(int(rec["msg_id"]))
        except Exception as e:
            print(f"[storage] delete Telegram msg échoué: {e}", flush=True)
    db.delete_file(manga_id, chapter_number, kind)
    purge_cache(manga_id, chapter_number, kind)
