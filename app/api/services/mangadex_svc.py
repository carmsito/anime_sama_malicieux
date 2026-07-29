"""
Service wrapper for MangaDex scraper (scripts/mangadex.py).
Imports via importlib to handle the module filename without issues.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen

from ..config import EXTRACTION_DIR, COVERS_DIR, PROJECT_ROOT

# ── Load mangadex.py ──────────────────────────────────────────────────────────

_spec = importlib.util.spec_from_file_location(
    "mangadex", PROJECT_ROOT / "scripts" / "mangadex.py"
)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["mangadex"] = _mod
_spec.loader.exec_module(_mod)

# ── Re-export commonly used symbols ──────────────────────────────────────────

_search_manga = _mod.search_manga
_fetch_available_languages = _mod.fetch_available_languages
_fetch_chapter_count = _mod.fetch_chapter_count
_fetch_chapters = _mod.fetch_chapters
_fetch_chapter_pages = _mod.fetch_chapter_pages
_api_get = _mod.api_get
_sanitize = _mod.sanitize_name
_ch_key = _mod.ch_key
LANG_NAMES: dict[str, str] = _mod.LANG_NAMES
RATE_LIMIT_DELAY: float = _mod.RATE_LIMIT_DELAY
REQUEST_TIMEOUT: int = _mod.REQUEST_TIMEOUT

# split_manga / make_epub loaded lazily in download() to avoid import errors
_split_fixed = None
_create_epub = None


def _load_epub_helpers() -> None:
    global _split_fixed, _create_epub
    if _split_fixed is None:
        sys.path.insert(0, str(PROJECT_ROOT / "scripts"))
        from split_manga import split_fixed  # noqa: E402
        from make_epub import create_epub    # noqa: E402
        _split_fixed = split_fixed
        _create_epub = create_epub


# ── Helpers ───────────────────────────────────────────────────────────────────

def _fetch_manga_detail(manga_id: str) -> dict:
    """GET /manga/{id}?includes[]=cover_art&includes[]=author"""
    return _api_get(f"/manga/{manga_id}", {
        "includes[]": ["cover_art", "author"],
    })


def _cover_url_from_detail(manga_id: str, data: dict) -> str | None:
    try:
        for rel in data["data"].get("relationships", []):
            if rel["type"] == "cover_art":
                filename = rel["attributes"]["fileName"]
                return f"https://uploads.mangadex.org/covers/{manga_id}/{filename}.512.jpg"
    except Exception:
        pass
    return None


def _cache_cover(manga_id_slug: str, url: str) -> None:
    cover_path = COVERS_DIR / f"{manga_id_slug}.jpg"
    if cover_path.exists():
        return
    try:
        req = Request(url, headers={"User-Agent": "mangadex-dl/1.0"})
        with urlopen(req, timeout=REQUEST_TIMEOUT) as r:
            cover_path.write_bytes(r.read())
    except Exception:
        pass


def _extract_info_from_detail(manga_id: str, detail: dict) -> dict:
    """Extract synopsis, genres, year, status, creator, cover_url from manga detail."""
    info: dict = {}
    try:
        attrs = detail["data"]["attributes"]

        # Description (prefer fr, then en, then first available)
        desc_map: dict = attrs.get("description", {}) or {}
        synopsis = desc_map.get("fr") or desc_map.get("en") or next(iter(desc_map.values()), "")
        if synopsis:
            info["synopsis"] = synopsis

        # Tags / genres
        tags = attrs.get("tags", []) or []
        genres = []
        for tag in tags:
            name_map = tag.get("attributes", {}).get("name", {})
            g = name_map.get("en") or next(iter(name_map.values()), "")
            if g:
                genres.append(g)
        if genres:
            info["genres"] = genres

        if attrs.get("year"):
            info["year"] = str(attrs["year"])
        if attrs.get("status"):
            info["status"] = attrs["status"]

        # Author and cover from relationships
        for rel in detail["data"].get("relationships", []):
            if rel["type"] == "author" and rel.get("attributes"):
                info["creator"] = rel["attributes"].get("name", "")
            if rel["type"] == "cover_art" and rel.get("attributes"):
                filename = rel["attributes"]["fileName"]
                cover_url = f"https://uploads.mangadex.org/covers/{manga_id}/{filename}.512.jpg"
                info["cover_url"] = cover_url
                _cache_cover(manga_id, cover_url)
    except Exception:
        pass
    return info


# ── Public API ────────────────────────────────────────────────────────────────

def search(query: str) -> list[dict]:
    """
    Search manga on MangaDex. Returns list of dicts with
    {title, subtitle, work_url (=manga_id), image_url, source}.
    """
    results, _total = _search_manga(query, limit=10, offset=0)
    out: list[dict] = []
    for r in results:
        cover_url: str | None = None
        try:
            detail = _fetch_manga_detail(r.id)
            cover_url = _cover_url_from_detail(r.id, detail)
        except Exception:
            pass
        time.sleep(RATE_LIMIT_DELAY)

        year_str = f" ({r.year})" if r.year else ""
        out.append({
            "title": r.title,
            "subtitle": f"{r.status}{year_str}",
            "work_url": r.id,          # manga_id acts as work_url
            "image_url": cover_url,
            "source": "mangadex",
        })
    return out


def get_languages(manga_id: str) -> list[dict]:
    """
    Returns available translation languages sorted by chapter count descending.
    [{lang, label, count}]
    """
    try:
        langs = _fetch_available_languages(manga_id)
    except Exception as e:
        raise RuntimeError(f"Impossible de récupérer les langues : {e}") from e

    result: list[dict] = []
    for lang in langs:
        try:
            count = _fetch_chapter_count(manga_id, lang)
        except Exception:
            count = 0
        time.sleep(RATE_LIMIT_DELAY)
        result.append({
            "lang": lang,
            "label": LANG_NAMES.get(lang, lang),
            "count": count,
        })

    return sorted(result, key=lambda x: x["count"], reverse=True)


def get_chapter_range(manga_id: str, lang: str) -> dict | None:
    """
    Fetch all chapters for a manga/lang combo and return the range metadata.
    Returns {manga_id, lang, first_chapter, last_chapter, total} or None.
    """
    try:
        chapters = _fetch_chapters(manga_id, lang)
    except Exception as e:
        raise RuntimeError(f"Impossible de récupérer les chapitres : {e}") from e

    if not chapters:
        return None

    sorted_nums = sorted(chapters.keys(), key=_ch_key)
    return {
        "manga_id": manga_id,
        "lang": lang,
        "first_chapter": sorted_nums[0],
        "last_chapter": sorted_nums[-1],
        "total": len(sorted_nums),
    }


def download(
    job_id: str,
    manga_id: str,
    manga_name: str,
    lang: str,
    start: str,
    end: str,
    make_epub: bool = True,
    keep_images: bool = False,
    page_height: int = 1878,
) -> None:
    """Background download function for MangaDex chapters."""
    import shutil

    from . import jobs as jobs_svc

    _load_epub_helpers()
    jobs_svc.update_job(job_id, status="running")
    try:
        # Fetch all chapters for this language
        chapters = _fetch_chapters(manga_id, lang)
        if not chapters:
            jobs_svc.update_job(job_id, status="error", error="Aucun chapitre disponible")
            return

        sorted_nums = sorted(chapters.keys(), key=_ch_key)
        start_f, end_f = _ch_key(start), _ch_key(end)
        to_download = [n for n in sorted_nums if start_f <= _ch_key(n) <= end_f]

        if not to_download:
            jobs_svc.update_job(job_id, status="error", error="Aucun chapitre dans cette plage")
            return

        jobs_svc.update_job(job_id, total=len(to_download))

        base_dir = EXTRACTION_DIR / _sanitize(manga_name) / lang
        base_dir.mkdir(parents=True, exist_ok=True)

        # Fetch manga metadata from API
        meta: dict = {
            "manga_name": manga_name,
            "manga_id": manga_id,
            "lang": lang,
            "source": "mangadex",
        }
        try:
            detail = _fetch_manga_detail(manga_id)
            attrs = detail["data"]["attributes"]

            # Description (prefer fr, then en, then first available)
            desc_map: dict = attrs.get("description", {}) or {}
            synopsis = desc_map.get("fr") or desc_map.get("en") or next(iter(desc_map.values()), "")
            if synopsis:
                meta["synopsis"] = synopsis

            # Tags / genres
            tags = attrs.get("tags", []) or []
            genres = []
            for tag in tags:
                name_map = tag.get("attributes", {}).get("name", {})
                g = name_map.get("en") or next(iter(name_map.values()), "")
                if g:
                    genres.append(g)
            if genres:
                meta["genres"] = genres

            if attrs.get("year"):
                meta["year"] = str(attrs["year"])
            if attrs.get("status"):
                meta["status"] = attrs["status"]

            # Author and cover from relationships
            for rel in detail["data"].get("relationships", []):
                if rel["type"] == "author" and rel.get("attributes"):
                    meta["creator"] = rel["attributes"].get("name", "")
                if rel["type"] == "cover_art" and rel.get("attributes"):
                    filename = rel["attributes"]["fileName"]
                    cover_url = f"https://uploads.mangadex.org/covers/{manga_id}/{filename}.512.jpg"
                    meta["cover_url"] = cover_url
                    _cache_cover(manga_id, cover_url)
        except Exception:
            pass

        # Write meta.json
        (base_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))

        # Download chapters
        for progress, ch_num in enumerate(to_download, 1):
            ch_info = chapters[ch_num]
            chapter_dir = base_dir / f"Chapitre {ch_num}"
            chapter_dir.mkdir(parents=True, exist_ok=True)

            try:
                base_url, hash_, pages = _fetch_chapter_pages(ch_info.id)
            except Exception:
                # Skip failed chapter but continue
                jobs_svc.update_job(job_id, progress=progress)
                continue

            for i, filename in enumerate(pages, start=1):
                ext = filename.rsplit(".", 1)[-1] if "." in filename else "jpg"
                out = chapter_dir / f"{i:03d}.{ext}"
                if out.exists():
                    continue

                img_url = f"{base_url}/data/{hash_}/{filename}"
                req = Request(img_url, headers={"User-Agent": "mangadex-dl/1.0"})
                try:
                    with urlopen(req, timeout=REQUEST_TIMEOUT) as r:
                        out.write_bytes(r.read())
                except Exception:
                    pass

                time.sleep(RATE_LIMIT_DELAY)

            if make_epub:
                _process_chapter_epub(chapter_dir, manga_name, ch_num, page_height, keep_images)

            jobs_svc.update_job(job_id, progress=progress)

        jobs_svc.update_job(job_id, status="done")

    except Exception as exc:
        jobs_svc.update_job(job_id, status="error", error=str(exc))


def _process_chapter_epub(
    chapter_dir: Path,
    manga_name: str,
    chapter_num: str,
    page_height: int,
    keep_images: bool,
) -> None:
    """Process downloaded images into an EPUB file."""
    import re
    import shutil
    import subprocess

    img_exts = {".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"}
    files = sorted(
        [p for p in chapter_dir.iterdir() if p.suffix.lower() in img_exts and re.match(r"^\d+", p.stem)],
        key=lambda p: int(re.match(r"^\d+", p.stem).group()),
    )
    if not files:
        return

    images_dir = chapter_dir / "images"
    images_dir.mkdir(exist_ok=True)

    try:
        result = subprocess.run(
            ["identify", "-format", "%h", str(files[0])],
            capture_output=True, text=True,
        )
        first_h = int(result.stdout.strip()) if result.returncode == 0 and result.stdout.strip().isdigit() else 0
    except Exception:
        first_h = 0

    all_pages: list[Path] = []
    if first_h > 4000:
        tmp_dirs = []
        for src in files:
            tmp = chapter_dir / f"_tmp_{src.stem}"
            pages = _split_fixed(str(src), tmp, page_height=page_height)
            all_pages.extend(pages)
            tmp_dirs.append(tmp)
        for i, p in enumerate(all_pages, 1):
            shutil.copy2(p, images_dir / f"{i:03d}{p.suffix}")
        for tmp in tmp_dirs:
            shutil.rmtree(tmp, ignore_errors=True)
    else:
        for i, src in enumerate(files, 1):
            shutil.copy2(src, images_dir / f"{i:03d}{src.suffix}")
        all_pages = list(sorted(images_dir.iterdir()))

    epub_path = chapter_dir.parent / f"Chapitre {chapter_num}.epub"
    _create_epub(
        chapter_dir=images_dir,
        output_file=epub_path,
        title=f"{manga_name} - Chapitre {chapter_num}",
        author="Inconnu",
        language="fr",
        image_format="original",
        quality=82,
        max_width=None,
    )

    for src in files:
        src.unlink(missing_ok=True)
    if not keep_images:
        shutil.rmtree(images_dir, ignore_errors=True)
