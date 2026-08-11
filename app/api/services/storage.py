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
import time
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
        from . import library
        library.invalidate_list_cache()   # nouveau chapitre → visible tout de suite
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
        expected = rec.get("size")
        # Cache valide UNIQUEMENT si la taille correspond à celle indexée en DB.
        # Un cache tronqué (download interrompu « à l'époque ») serait sinon resservi
        # indéfiniment → EPUB sans EOCD → couverture/lecture en 500.
        if out.exists() and out.stat().st_size > 0:
            if not expected or out.stat().st_size == expected:
                try:
                    out.touch()           # marque « lu récemment » → LRU
                except OSError:
                    pass
                _trim_cache(cache, keep=out)
                return out
            out.unlink(missing_ok=True)   # cache tronqué → on re-télécharge
        get_client().download(rec["msg_id"], str(out))
        # Ne JAMAIS cacher un download tronqué : mieux vaut échouer que persister un fichier cassé.
        if out.exists() and expected and out.stat().st_size != expected:
            out.unlink(missing_ok=True)
            return None
        _trim_cache(cache, keep=out)       # borne le cache après chaque download
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


def _sweep_dir(directory: Path, ttl: int, max_bytes: int,
               pattern: str = "*", keep: Optional[Path] = None) -> int:
    """Borne un dossier de cache : supprime les fichiers plus vieux que `ttl` (s), puis, si le
    total dépasse `max_bytes`, évince les moins récemment lus (LRU par mtime). Ne touche
    jamais `keep`. Retourne le nb de fichiers supprimés."""
    removed = 0
    try:
        if not directory.exists():
            return 0
        now = time.time()
        items = []
        for f in directory.glob(pattern):
            if not f.is_file():
                continue
            try:
                st = f.stat()
            except OSError:
                continue
            items.append((f, st.st_mtime, st.st_size))
        if ttl:                                   # 1) TTL
            for f, mt, _ in items:
                if (keep and f == keep) or (now - mt) <= ttl:
                    continue
                f.unlink(missing_ok=True); removed += 1
        alive = [(f, mt, sz) for f, mt, sz in items if f.exists()]
        total = sum(sz for _, _, sz in alive)
        if max_bytes and total > max_bytes:       # 2) plafond → LRU (plus vieux mtime d'abord)
            for f, mt, sz in sorted(alive, key=lambda x: x[1]):
                if keep and f == keep:
                    continue
                f.unlink(missing_ok=True); removed += 1; total -= sz
                if total <= max_bytes:
                    break
    except Exception:
        pass
    return removed


def _trim_cache(cache: Path, keep: Optional[Path] = None) -> None:
    """Borne le cache EPUB de lecture (appelé après chaque fetch)."""
    from ..config import LOCAL_CACHE_TTL, LOCAL_CACHE_MAX_BYTES
    _sweep_dir(cache, LOCAL_CACHE_TTL, LOCAL_CACHE_MAX_BYTES, "*.epub", keep)


def sweep_all() -> dict:
    """Balaye TOUS les caches disque bornés (EPUB de lecture + vignettes de chapitres).
    Retourne le nb de fichiers évincés par cache."""
    from ..config import (DATA_DIR, COVERS_DIR, LOCAL_CACHE_TTL, LOCAL_CACHE_MAX_BYTES,
                          COVER_CACHE_TTL, COVER_CACHE_MAX_BYTES)
    n1 = _sweep_dir(DATA_DIR / "epub_cache", LOCAL_CACHE_TTL, LOCAL_CACHE_MAX_BYTES, "*.epub")
    n2 = _sweep_dir(COVERS_DIR / "ch", COVER_CACHE_TTL, COVER_CACHE_MAX_BYTES, "*.jpg")
    if n1 or n2:
        print(f"[cache] balayage : {n1} EPUB + {n2} vignettes évincés", flush=True)
    return {"epub_removed": n1, "cover_removed": n2}


def _dir_size(directory: Path, pattern: str) -> tuple[int, int]:
    total = count = 0
    if directory.exists():
        for f in directory.glob(pattern):
            try:
                total += f.stat().st_size
                count += 1
            except OSError:
                pass
    return total, count


def _tree_size(directory: Path) -> int:
    total = 0
    if directory.exists():
        for f in directory.rglob("*"):
            try:
                if f.is_file():
                    total += f.stat().st_size
            except OSError:
                pass
    return total


def cache_stats() -> dict:
    """État disque pour l'admin. On raisonne sur l'empreinte de l'APP (données + caches),
    en OMETTANT l'OS/système : l'espace « pour l'app » = empreinte app + espace libre."""
    import shutil
    from ..config import (DATA_DIR, COVERS_DIR, EXTRACTION_DIR,
                          LOCAL_CACHE_MAX_BYTES, COVER_CACHE_MAX_BYTES)
    epub_bytes, epub_n = _dir_size(DATA_DIR / "epub_cache", "*.epub")
    cov_bytes, cov_n = _dir_size(COVERS_DIR / "ch", "*.jpg")
    app_bytes = _tree_size(DATA_DIR) + _tree_size(EXTRACTION_DIR)  # tout ce que l'app pose sur disque
    try:
        du = shutil.disk_usage(str(DATA_DIR))
        disk = {"total": du.total, "used": du.used, "free": du.free}
    except Exception:
        disk = {"total": 0, "used": 0, "free": 0}
    return {
        "epub": {"bytes": epub_bytes, "count": epub_n, "cap": LOCAL_CACHE_MAX_BYTES},
        "covers": {"bytes": cov_bytes, "count": cov_n, "cap": COVER_CACHE_MAX_BYTES},
        "app_bytes": app_bytes,                                    # empreinte totale de l'app
        "other_bytes": max(0, app_bytes - epub_bytes - cov_bytes),  # DB, sessions, extraction…
        "disk": disk,
    }


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
    from . import library
    library.invalidate_list_cache()
