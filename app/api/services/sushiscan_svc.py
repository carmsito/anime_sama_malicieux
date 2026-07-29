"""
Service wrapper for Sushiscan scraper (scripts/sushiscan.py).
Uses a threading.Lock to serialize all Chrome operations since
sushiscan.py maintains a single Chrome/DrissionPage instance.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import threading
from pathlib import Path
from urllib.request import Request, urlopen

# Set CHROME_BIN env var before importing the module so it picks up the right path.
os.environ.setdefault("CHROME_BIN", "/opt/google/chrome/chrome")

from ..config import EXTRACTION_DIR, COVERS_DIR, PROJECT_ROOT

import re as _re

# Single lock to serialize all Chrome operations (search, fetch_chapters, download)
_chrome_lock = threading.Lock()


def _make_manga_id(manga_name: str, category: str = "sushiscan") -> str:
    """Same algorithm as library._make_manga_id."""
    def slug(s: str) -> str:
        return _re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return f"{slug(manga_name)}_{slug(category)}"

# Lazy-loaded module — populated on first use so import errors don't crash the API
_mod = None
split_fixed = None
create_epub = None
_AVAILABLE = None  # None = not checked yet, True/False after first attempt


def _load_module() -> bool:
    """Load sushiscan.py and helpers on first use. Returns True if successful."""
    global _mod, split_fixed, create_epub, _AVAILABLE
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

        _AVAILABLE = True
    except Exception as e:
        _AVAILABLE = False
        print(f"[sushiscan_svc] DrissionPage indisponible: {e}", flush=True)
    return _AVAILABLE


# ── Public API ────────────────────────────────────────────────────────────────

def search(query: str) -> list[dict]:
    """
    Search manga on Sushiscan. Acquires Chrome lock for the duration.
    Returns [{title, subtitle, work_url (catalogue URL), image_url, source}].
    """
    if not _load_module():
        raise RuntimeError("Sushiscan indisponible (DrissionPage non installé)")
    with _chrome_lock:
        try:
            results = _mod.search_manga(query)
        except Exception as e:
            raise RuntimeError(f"Erreur Sushiscan lors de la recherche : {e}") from e

    return [
        {
            "title": r.title,
            "subtitle": "",
            "work_url": r.url,
            "image_url": (
                f"/api/search/sushiscan/image?url={getattr(r, 'image_url', '')}"
                if getattr(r, "image_url", None)
                else None
            ),
            "source": "sushiscan",
        }
        for r in results
    ]


def get_chapters(manga_url: str) -> dict | None:
    """
    Fetch chapter list for a manga URL (acquires Chrome lock).
    Returns {manga_url, first_chapter, last_chapter, total, kind} or None.
    """
    if not _load_module():
        raise RuntimeError("Sushiscan indisponible (DrissionPage non installé)")
    with _chrome_lock:
        try:
            chapters = _mod.fetch_chapters(manga_url)
        except Exception as e:
            raise RuntimeError(f"Erreur Sushiscan lors de la récupération des chapitres : {e}") from e

    if not chapters:
        return None

    # Sépare chapitres et volumes (Sushiscan peut avoir les deux mélangés)
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

    # Rétro-compat : si un seul type, renvoie aussi les anciens champs
    first_kind = next(iter(kinds_info))
    return {
        "manga_url": manga_url,
        "kinds": kinds_info,
        # legacy fields for single-kind mangas
        "kind": first_kind,
        "first_chapter": kinds_info[first_kind]["first"],
        "last_chapter": kinds_info[first_kind]["last"],
        "total": sum(v["total"] for v in kinds_info.values()),
    }


def get_meta(manga_url: str, manga_id: str | None = None) -> dict:
    """
    Scrape manga metadata + optionally cache cover (if manga_id given).
    Returns {synopsis, genres, cover_url, year, creator}.
    """
    if not _load_module():
        return {}

    meta: dict = {}
    soup = None
    html = ""

    with _chrome_lock:
        try:
            from bs4 import BeautifulSoup
            import re as _re2
            html = _mod.fetch_html(manga_url, wait=3.0)
            soup = BeautifulSoup(html, "html.parser")

            # Cover — og:image is most reliable
            cover_url = None
            og = soup.find("meta", property="og:image")
            if og and og.get("content"):
                cover_url = og["content"]
            else:
                for sel in [".summary_image img", "[class*=thumbnail] img", ".wp-post-image"]:
                    img = soup.select_one(sel)
                    if img:
                        src = img.get("data-src") or img.get("src") or ""
                        if src and not src.startswith("data:"):
                            cover_url = src
                            break

            if cover_url:
                meta["cover_url"] = cover_url
                # Télécharge la cover via CDP listen (bypass CF — même contexte que la page)
                if manga_id:
                    cover_path = COVERS_DIR / f"{manga_id}.jpg"
                    if not cover_path.exists():
                        try:
                            driver = _mod.get_driver()
                            driver.listen.start(targets=cover_url)
                            driver.run_js(
                                "(function(src){"
                                "var i=document.createElement('img');"
                                "i.src=src;"
                                "i.style.cssText='position:fixed;width:1px;height:1px;opacity:0;left:-9999px';"
                                "document.body.appendChild(i);"
                                "})(arguments[0]);",
                                cover_url,
                            )
                            pkt = driver.listen.wait(count=1, timeout=15)
                            driver.listen.stop()
                            if pkt and pkt is not False:
                                body = pkt.response.body
                                data = body if isinstance(body, bytes) else (body.encode("latin-1") if body else b"")
                                if len(data) > 1000 and data[:1] != b"<":
                                    cover_path.write_bytes(data)
                                    print(f"[cover] {manga_id}.jpg → {len(data)} bytes", flush=True)
                                else:
                                    print(f"[cover] invalid data ({len(data)}b, starts {data[:4]})", flush=True)
                            else:
                                print(f"[cover] timeout for {manga_id}", flush=True)
                        except Exception as e:
                            print(f"[cover] error: {e}", flush=True)
        except Exception as e:
            print(f"[get_meta] error: {e}", flush=True)
            return meta

    if not soup:
        return meta

    import re as _re3

    # Synopsis
    p = soup.select_one(".entry-content p")
    if p:
        text = p.get_text(strip=True)
        if len(text) > 20:
            meta["synopsis"] = text

    # Genres
    genre_tags = soup.select(".genres-content a, [class*=genre] a")
    genres = [a.get_text(strip=True) for a in genre_tags if a.get_text(strip=True)]
    if genres:
        meta["genres"] = genres

    # Year
    m = _re3.search(r'\b(19[5-9]\d|20[0-2]\d)\b', html)
    if m:
        meta["year"] = m.group(0)

    # Creator / author
    for sel in [".author-content a", "[class*=author] a"]:
        el = soup.select_one(sel)
        if el:
            meta["creator"] = el.get_text(strip=True)
            break

    return meta


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
    Background download function for Sushiscan chapters.
    Holds the Chrome lock for the entire duration.
    """
    from . import jobs as jobs_svc

    if not _load_module():
        jobs_svc.update_job(job_id, status="error", error="Sushiscan indisponible (DrissionPage non installé)")
        return

    jobs_svc.update_job(job_id, status="running")

    # Hold the lock for the entire download — Chrome is used throughout
    with _chrome_lock:
        try:
            chapters = _mod.fetch_chapters(manga_url)
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

            kind = kind_filter or (targets[0].kind if targets else "Chapitre")
            safe_name = _mod.sanitize_name(manga_name)
            # Category subdir = "sushiscan" so library finds it as manga/sushiscan/Volume N.epub
            base_dir = EXTRACTION_DIR / safe_name / "sushiscan"
            base_dir.mkdir(parents=True, exist_ok=True)

            # manga_id must match library._make_manga_id(manga_name, "sushiscan")
            manga_id = _make_manga_id(safe_name, "sushiscan")

            # Fetch and save metadata
            meta: dict = {
                "manga_name": manga_name,
                "manga_url": manga_url,
                "source": "sushiscan",
                "kind": kind,
            }
            try:
                from bs4 import BeautifulSoup
                import re
                html = _mod.fetch_html(manga_url, wait=3.0)
                soup = BeautifulSoup(html, "html.parser")

                # Cover
                og = soup.find("meta", property="og:image")
                if og and og.get("content"):
                    meta["cover_url"] = og["content"]
                else:
                    for sel in [".summary_image img", "[class*=thumbnail] img"]:
                        img = soup.select_one(sel)
                        if img:
                            src = img.get("data-src") or img.get("src") or ""
                            if src and not src.startswith("data:"):
                                meta["cover_url"] = src
                                break

                # Cache cover using same ID as library._make_manga_id
                if "cover_url" in meta:
                    _cache_cover(manga_id, meta["cover_url"])

                # Synopsis
                p = soup.select_one(".entry-content p")
                if p:
                    text = p.get_text(strip=True)
                    if len(text) > 20:
                        meta["synopsis"] = text

                # Genres
                genre_tags = soup.select(".genres-content a, [class*=genre] a")
                genres = [a.get_text(strip=True) for a in genre_tags if a.get_text(strip=True)]
                if genres:
                    meta["genres"] = genres

                # Year
                m = re.search(r'\b(19[5-9]\d|20[0-2]\d)\b', html)
                if m:
                    meta["year"] = m.group(0)

                # Creator
                for sel in [".author-content a", "[class*=author] a"]:
                    el = soup.select_one(sel)
                    if el:
                        meta["creator"] = el.get_text(strip=True)
                        break
            except Exception:
                pass

            (base_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))

            for progress, chapter in enumerate(targets, 1):
                label = f"{chapter.kind} {chapter.number}"
                chapter_dir = base_dir / label
                chapter_dir.mkdir(parents=True, exist_ok=True)

                try:
                    _mod._download_one_chapter(chapter.url, chapter_dir, batch_size)
                except Exception as e:
                    jobs_svc.update_job(job_id, progress=progress)
                    continue

                if make_epub:
                    try:
                        _mod._process_epub(
                            chapter_dir,
                            manga_name,
                            chapter.number,
                            chapter.kind,
                            page_height,
                            keep_images,
                            create_epub,
                            split_fixed,
                        )
                    except Exception as epub_err:
                        print(f"[epub ERROR] {chapter.kind} {chapter.number}: {epub_err}", flush=True)

                jobs_svc.update_job(job_id, progress=progress)

            jobs_svc.update_job(job_id, status="done")

        except Exception as exc:
            jobs_svc.update_job(job_id, status="error", error=str(exc))
        finally:
            close_driver()


def _cache_cover(slug: str, url: str) -> None:
    """Download cover via Chrome driver (Sushiscan CDN blocks plain HTTP)."""
    cover_path = COVERS_DIR / f"{slug}.jpg"
    if cover_path.exists():
        return
    if not _load_module():
        return
    try:
        # Use the Chrome driver to download (bypasses CF cookie requirement)
        driver = _mod.get_driver()
        # listen for the image request
        driver.listen.start(targets=url)
        # Inject as sub-resource from the current page context
        driver.run_js(f"""
            (function() {{
                const img = document.createElement('img');
                img.src = arguments[0];
                img.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;left:-9999px';
                document.body.appendChild(img);
            }})();
        """, url)
        import time
        pkt = driver.listen.wait(count=1, timeout=15)
        driver.listen.stop()
        if pkt:
            body = pkt.response.body
            data = body if isinstance(body, bytes) else body.encode("latin-1")
            if data and data[:1] not in (b"<", b"{"):
                cover_path.write_bytes(data)
                print(f"[cover] {slug}.jpg → {len(data)} bytes", flush=True)
    except Exception as e:
        print(f"[cover] failed for {slug}: {e}", flush=True)


def close_driver() -> None:
    """Ferme le driver Chromium si ouvert."""
    global _mod
    if _mod is None:
        return
    try:
        driver = _mod._driver
        if driver:
            driver.close()
            _mod._driver = None
    except Exception:
        pass


def fetch_image(url: str) -> tuple[bytes | None, str]:
    """Proxy a Sushiscan image with headers that avoid hotlink failures."""
    if not url:
        return None, "application/octet-stream"
    req = Request(url, headers={
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://sushiscan.net/",
    })
    with urlopen(req, timeout=20) as r:
        data = r.read()
        return data, r.headers.get_content_type() or "image/jpeg"
