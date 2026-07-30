"""
Service Sushiscan — s'appuie sur scripts/sushiscan.py.

Concurrence : plus de lock global tenu pendant tout un job. On utilise un
BrowserPool prioritaire (voir browser_pool.py) :
  • search / get_chapters / get_meta / image  → priorité HAUTE (interactif)
  • download                                   → priorité BASSE, bail RELÂCHÉ
                                                  entre chaque chapitre
Résultat : une recherche d'un user n'est jamais bloquée par le download d'un autre.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re as _re
import sys
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

# CHROME_BIN avant l'import du module pour qu'il prenne le bon binaire.
os.environ.setdefault("CHROME_BIN", "/opt/google/chrome/chrome")

from ..config import (
    EXTRACTION_DIR, COVERS_DIR, PROJECT_ROOT,
    SUSHISCAN_POOL_SIZE, SUSHISCAN_IDLE_TIMEOUT,
)
from .browser_pool import BrowserPool, PRIO_SEARCH, PRIO_DOWNLOAD


def _make_manga_id(manga_name: str, category: str = "sushiscan") -> str:
    """Même algo que library._make_manga_id."""
    def slug(s: str) -> str:
        return _re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return f"{slug(manga_name)}_{slug(category)}"


# ── Chargement paresseux du module scraper ────────────────────────────────────

_mod = None
split_fixed = None
create_epub = None
_AVAILABLE = None
_pool: BrowserPool | None = None


def _load_module() -> bool:
    """Charge scripts/sushiscan.py + helpers au premier usage."""
    global _mod, split_fixed, create_epub, _AVAILABLE, _pool
    if _AVAILABLE is not None:
        return _AVAILABLE
    try:
        spec = importlib.util.spec_from_file_location(
            "sushiscan", PROJECT_ROOT / "scripts" / "sushiscan.py"
        )
        mod = importlib.util.module_from_spec(spec)
        sys.modules["sushiscan"] = mod
        spec.loader.exec_module(mod)
        mod.CHROME_BIN = os.environ.get("CHROME_BIN", "/opt/google/chrome/chrome")
        _mod = mod

        sys.path.insert(0, str(PROJECT_ROOT / "scripts"))
        from split_manga import split_fixed as sf  # noqa: E402
        from make_epub import create_epub as ce    # noqa: E402
        split_fixed = sf
        create_epub = ce

        # Pool de navigateurs (create_driver = factory multi-instances)
        _pool = BrowserPool(
            SUSHISCAN_POOL_SIZE, mod.create_driver, name="sushiscan",
            idle_timeout=SUSHISCAN_IDLE_TIMEOUT,
        )

        _AVAILABLE = True
    except Exception as e:
        _AVAILABLE = False
        print(f"[sushiscan_svc] DrissionPage indisponible: {e}", flush=True)
    return _AVAILABLE


def _require() -> None:
    if not _load_module():
        raise RuntimeError("Sushiscan indisponible (DrissionPage non installé)")


# ── Helpers bas niveau ────────────────────────────────────────────────────────

def _guess_image_media_type(url: str) -> str:
    suffix = Path(urlparse(url).path).suffix.lower()
    return {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif",
    }.get(suffix, "image/jpeg")


def _is_image_bytes(data: bytes) -> bool:
    if not data or len(data) < 16:
        return False
    if data[:1] == b"<":
        return False
    if data[:2] == b"\xff\xd8":
        return True
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return True
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return True
    if data[:4] == b"GIF8":
        return True
    if b"ftyp" in data[4:12]:
        return True
    return False


def _grab_via_listen(driver, url: str, timeout: float = 15) -> bytes | None:
    """
    Télécharge une ressource protégée CF en l'injectant comme sous-ressource
    dans le contexte de la page (mêmes cookies) et en captant la réponse CDP.
    `driver` doit être un navigateur déjà baillé (aucun lease pris ici).
    """
    try:
        driver.listen.start(targets=url)
        driver.run_js(
            "(function(src){"
            "var i=document.createElement('img');"
            "i.src=src;"
            "i.style.cssText='position:fixed;width:1px;height:1px;opacity:0;left:-9999px;top:-9999px';"
            "document.body.appendChild(i);"
            "})(arguments[0]);",
            url,
        )
        pkt = driver.listen.wait(count=1, timeout=timeout)
        driver.listen.stop()
        if not pkt or pkt is False:
            return None
        body = pkt.response.body
        data = body if isinstance(body, bytes) else (body.encode("latin-1") if body else b"")
        return data if _is_image_bytes(data) else None
    except Exception:
        try:
            driver.listen.stop()
        except Exception:
            pass
        return None


def _cache_cover(slug: str, url: str, driver) -> None:
    """Sauvegarde la cover localement via le navigateur baillé fourni."""
    cover_path = COVERS_DIR / f"{slug}.jpg"
    if cover_path.exists() or not url:
        return
    data = _grab_via_listen(driver, url)
    if data:
        cover_path.write_bytes(data)
        print(f"[cover] {slug}.jpg → {len(data)} bytes", flush=True)


def _scrape_meta(html: str) -> dict:
    """Extrait synopsis/genres/year/creator/cover_url depuis le HTML d'une fiche."""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "html.parser")
    meta: dict = {}

    og = soup.find("meta", property="og:image")
    if og and og.get("content"):
        meta["cover_url"] = og["content"]
    else:
        for sel in [".summary_image img", "[class*=thumbnail] img", ".wp-post-image"]:
            img = soup.select_one(sel)
            if img:
                src = img.get("data-src") or img.get("src") or ""
                if src and not src.startswith("data:"):
                    meta["cover_url"] = src
                    break

    p = soup.select_one(".entry-content p")
    if p:
        text = p.get_text(strip=True)
        if len(text) > 20:
            meta["synopsis"] = text

    genres = [a.get_text(strip=True) for a in soup.select(".genres-content a, [class*=genre] a") if a.get_text(strip=True)]
    if genres:
        meta["genres"] = genres

    m = _re.search(r'\b(19[5-9]\d|20[0-2]\d)\b', html)
    if m:
        meta["year"] = m.group(0)

    for sel in [".author-content a", "[class*=author] a"]:
        el = soup.select_one(sel)
        if el:
            meta["creator"] = el.get_text(strip=True)
            break

    return meta


# ── API publique ──────────────────────────────────────────────────────────────

def search(query: str) -> list[dict]:
    _require()
    with _pool.lease(PRIO_SEARCH) as drv:
        try:
            results = _mod.search_manga(query, driver=drv)
        except Exception as e:
            raise RuntimeError(f"Erreur Sushiscan lors de la recherche : {e}") from e

    return [
        {
            "title": r.title,
            "subtitle": "",
            "work_url": r.url,
            "image_url": (
                f"/api/search/sushiscan/image?url={getattr(r, 'image_url', '')}"
                if getattr(r, "image_url", None) else None
            ),
            "source": "sushiscan",
        }
        for r in results
    ]


def get_chapters(manga_url: str) -> dict | None:
    _require()
    with _pool.lease(PRIO_SEARCH) as drv:
        try:
            chapters = _mod.fetch_chapters(manga_url, driver=drv)
        except Exception as e:
            raise RuntimeError(f"Erreur Sushiscan lors de la récupération des chapitres : {e}") from e

    if not chapters:
        return None

    # Sépare chapitres et volumes (Sushiscan peut mélanger les deux)
    by_kind: dict[str, list] = {}
    for c in chapters:
        by_kind.setdefault(c.kind, []).append(c)

    kinds_info = {}
    for k, lst in by_kind.items():
        lst_sorted = sorted(lst, key=lambda c: c.number)
        kinds_info[k] = {
            "first": lst_sorted[0].number,
            "last": lst_sorted[-1].number,
            "total": len(lst_sorted),
        }

    first_kind = next(iter(kinds_info))
    return {
        "manga_url": manga_url,
        "kinds": kinds_info,
        "kind": first_kind,
        "first_chapter": kinds_info[first_kind]["first"],
        "last_chapter": kinds_info[first_kind]["last"],
        "total": sum(v["total"] for v in kinds_info.values()),
    }


def get_meta(manga_url: str, manga_id: str | None = None) -> dict:
    if not _load_module():
        return {}
    try:
        with _pool.lease(PRIO_SEARCH) as drv:
            html = _mod.fetch_html(manga_url, wait=3.0, driver=drv)
            meta = _scrape_meta(html)
            if manga_id and meta.get("cover_url"):
                _cache_cover(manga_id, meta["cover_url"], drv)
            return meta
    except Exception as e:
        print(f"[get_meta] error: {e}", flush=True)
        return {}


def download(
    job_id: str,
    manga_name: str,
    manga_url: str,
    start: float,
    end: float,
    kind_filter: str | None = None,
    make_epub: bool = True,
    keep_images: bool = False,
    page_height: int = 1878,
    batch_size: int = 5,
) -> None:
    """
    Download d'un job Sushiscan. Prend un bail navigateur PAR CHAPITRE et le
    relâche entre chaque → les recherches interactives peuvent s'intercaler.
    """
    from . import jobs as jobs_svc

    if not _load_module():
        jobs_svc.update_job(job_id, status="error", error="Sushiscan indisponible (DrissionPage non installé)")
        return

    jobs_svc.update_job(job_id, status="running")

    try:
        # 1) Liste des chapitres (bail court, priorité download)
        with _pool.lease(PRIO_DOWNLOAD) as drv:
            chapters = _mod.fetch_chapters(manga_url, driver=drv)
        if not chapters:
            jobs_svc.update_job(job_id, status="error", error="Aucun chapitre trouvé")
            return

        targets = [
            c for c in chapters
            if start <= c.number <= end and (not kind_filter or c.kind == kind_filter)
        ]
        if not targets:
            jobs_svc.update_job(job_id, status="error", error="Aucun chapitre dans cette plage")
            return

        jobs_svc.update_job(job_id, total=len(targets))

        kind = kind_filter or targets[0].kind
        safe_name = _mod.sanitize_name(manga_name)
        base_dir = EXTRACTION_DIR / safe_name / "sushiscan"
        base_dir.mkdir(parents=True, exist_ok=True)
        manga_id = _make_manga_id(safe_name, "sushiscan")

        # 2) Métadonnées + cover (bail court)
        meta: dict = {
            "manga_name": manga_name, "manga_url": manga_url,
            "source": "sushiscan", "kind": kind,
        }
        try:
            with _pool.lease(PRIO_DOWNLOAD) as drv:
                html = _mod.fetch_html(manga_url, wait=3.0, driver=drv)
                meta.update(_scrape_meta(html))
                if meta.get("cover_url"):
                    _cache_cover(manga_id, meta["cover_url"], drv)
        except Exception:
            pass
        (base_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))

        # 3) Chapitres — un bail par chapitre (relâché entre chaque)
        for progress, chapter in enumerate(targets, 1):
            label = f"{chapter.kind} {chapter.number}"
            chapter_dir = base_dir / label
            chapter_dir.mkdir(parents=True, exist_ok=True)

            try:
                with _pool.lease(PRIO_DOWNLOAD) as drv:
                    _mod._download_one_chapter(chapter.url, chapter_dir, batch_size, driver=drv)
            except Exception as e:
                print(f"[download] {label}: {e}", flush=True)
                jobs_svc.update_job(job_id, progress=progress)
                continue

            if make_epub:
                try:
                    _mod._process_epub(
                        chapter_dir, manga_name, chapter.number, chapter.kind,
                        page_height, keep_images, create_epub, split_fixed,
                    )
                    # Offload vers le backend de stockage (no-op en mode local)
                    epub_path = base_dir / f"{chapter.kind} {chapter.number}.epub"
                    if epub_path.exists():
                        try:
                            from . import storage
                            storage.store_epub(manga_id, chapter.number, chapter.kind, epub_path)
                        except Exception as se:
                            print(f"[storage] offload {label}: {se}", flush=True)
                except Exception as epub_err:
                    print(f"[epub ERROR] {label}: {epub_err}", flush=True)

            jobs_svc.update_job(job_id, progress=progress)

        jobs_svc.update_job(job_id, status="done")

    except Exception as exc:
        jobs_svc.update_job(job_id, status="error", error=str(exc))


def fetch_image(url: str) -> tuple[bytes | None, str]:
    """Proxy image Sushiscan : HTTP direct d'abord, fallback via navigateur baillé."""
    if not url:
        return None, "application/octet-stream"
    # 1) HTTP simple (rapide, souvent suffisant)
    try:
        req = Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://sushiscan.net/"})
        with urlopen(req, timeout=20) as r:
            data = r.read()
            media_type = r.headers.get_content_type() or _guess_image_media_type(url)
            if _is_image_bytes(data):
                return data, media_type
    except Exception:
        pass
    # 2) Fallback CF via un navigateur du pool (priorité interactive)
    if not _load_module():
        return None, _guess_image_media_type(url)
    try:
        with _pool.lease(PRIO_SEARCH) as drv:
            data = _grab_via_listen(drv, url)
            if data:
                return data, _guess_image_media_type(url)
    except Exception:
        pass
    return None, _guess_image_media_type(url)


def close_driver() -> None:
    """Ferme les navigateurs inactifs du pool (libère la RAM). Sans effet sur les baux actifs."""
    if _pool is not None:
        _pool.shutdown()


def pool_stats() -> dict:
    return _pool.stats() if _pool is not None else {"available": False}
