"""
Wrapper around the project's scraping/splitting scripts.
Imports utility functions from anime-sama.py via importlib to avoid the hyphen in filename.
"""
from __future__ import annotations

import importlib.util
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Callable, Optional

from ..config import EXTRACTION_DIR, COVERS_DIR, PROJECT_ROOT

# ── Load anime-sama.py functions ─────────────────────────────────────────────

_spec = importlib.util.spec_from_file_location(
    "anime_sama", PROJECT_ROOT / "anime-sama.py"
)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["anime_sama"] = _mod
_spec.loader.exec_module(_mod)

_resolve_base_url = _mod.resolve_base_url
search_scans = _mod.search_scans

# Cache the base URL so we don't re-resolve on every request
_base_url_cache: tuple[str, bool] | None = None


def resolve_base_url() -> tuple[str, bool]:
    global _base_url_cache
    if _base_url_cache is None:
        _base_url_cache = _resolve_base_url()
    return _base_url_cache


def warm_base_url() -> None:
    """Call once at startup to avoid slow first request."""
    resolve_base_url()
fetch_scan_categories = _mod.fetch_scan_categories
fetch_scan_title = _mod.fetch_scan_title
fetch_chapter_map = _mod.fetch_chapter_map
request_bytes = _mod.request_bytes
request_text = _mod.request_text
build_image_url = _mod.build_image_url
sanitize_name = _mod.sanitize_name

# ── Load split + epub functions ───────────────────────────────────────────────

sys.path.insert(0, str(PROJECT_ROOT))
from split_manga import split_fixed  # noqa: E402
from make_epub import create_epub    # noqa: E402


# ── Cover extraction ──────────────────────────────────────────────────────────

def fetch_work_info(work_url: str, verify_ssl: bool = True) -> dict:
    """Scrape synopsis, genres, year, status from the manga page."""
    from urllib.parse import urljoin
    try:
        page, _ = request_text(work_url, verify_ssl=verify_ssl)
        info: dict = {}

        # Synopsis — anime-sama uses id="synopsisOeuvre" or similar
        for pat in [
            r'id=["\']synopsisOeuvre["\'][^>]*>\s*<p[^>]*>(.*?)</p>',
            r'id=["\']synopsisOeuvre["\'][^>]*>(.*?)</div>',
            r'class=["\'][^"\']*synopsis[^"\']*["\'][^>]*>\s*<p[^>]*>(.*?)</p>',
            r'<p[^>]+class=["\'][^"\']*synopsis[^"\']*["\'][^>]*>(.*?)</p>',
        ]:
            m = re.search(pat, page, re.DOTALL | re.IGNORECASE)
            if m:
                text = _strip(m.group(1))
                if len(text) > 30:
                    info["synopsis"] = text
                    break

        # Cover (og:image)
        for pat in [
            r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
            r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']',
        ]:
            m = re.search(pat, page, re.IGNORECASE)
            if m:
                url = m.group(1)
                info["cover_url"] = url if url.startswith("http") else urljoin(work_url, url)
                break

        # Genres/Tags
        for pat in [
            r'class=["\'][^"\']*genre[^"\']*["\'][^>]*>([^<]{2,30})<',
            r'class=["\'][^"\']*tag[^"\']*["\'][^>]*>([^<]{2,30})<',
            r'class=["\'][^"\']*categ[^"\']*["\'][^>]*>([^<]{2,30})<',
        ]:
            found = re.findall(pat, page, re.IGNORECASE)
            genres = [g.strip() for g in found if g.strip() and not g.strip().isdigit()]
            if genres:
                info["genres"] = genres[:8]
                break

        # Year
        m = re.search(r'\b(19[5-9]\d|20[0-2]\d)\b', page)
        if m:
            info["year"] = m.group(0)

        # Status
        for pat in [
            r'[Ss]tatut\s*:?\s*<[^>]+>\s*([^<]{2,30})<',
            r'class=["\'][^"\']*statut[^"\']*["\'][^>]*>([^<]{2,30})<',
            r'[ÉEeé]tat\s*:?\s*<[^>]+>([^<]{2,30})<',
        ]:
            m = re.search(pat, page, re.IGNORECASE)
            if m:
                info["status"] = m.group(1).strip()
                break

        # Creator / Author
        for pat in [
            r'[Aa]uteur\s*:?\s*<[^>]+>([^<]{2,60})<',
            r'[Cc]r[eé]ateur\s*:?\s*<[^>]+>([^<]{2,60})<',
            r'class=["\'][^"\']*auteur[^"\']*["\'][^>]*>([^<]{2,60})<',
        ]:
            m = re.search(pat, page, re.IGNORECASE)
            if m:
                info["creator"] = m.group(1).strip()
                break

        return info
    except Exception:
        return {}


def _strip(html: str) -> str:
    import html as h
    return h.unescape(re.sub(r"<[^>]+>", "", html)).strip()


def search_with_images(query: str) -> list[dict]:
    """Enhanced search that also extracts thumbnail images from search results."""
    from urllib.parse import urljoin
    import html as html_mod

    base_url, verify_ssl = resolve_base_url()
    endpoint = urljoin(base_url, "template-php/defaut/fetch.php")
    page, _ = request_text(endpoint, data={"query": query}, verify_ssl=verify_ssl)

    result_pat = re.compile(
        r'<a\s+href="(?P<href>[^"]+)"\s+class="asn-search-result"[^>]*>(?P<inner>.*?)</a>',
        re.IGNORECASE | re.DOTALL,
    )
    img_pat = re.compile(r'<img[^>]+src=["\']([^"\']+)["\']', re.IGNORECASE)
    h3_pat = re.compile(r'<h3[^>]*>(.*?)</h3>', re.IGNORECASE | re.DOTALL)
    p_pat = re.compile(r'<p[^>]*>(.*?)</p>', re.IGNORECASE | re.DOTALL)

    results = []
    seen: set[str] = set()
    for m in result_pat.finditer(page):
        href = html_mod.unescape(m.group("href").strip())
        full_url = urljoin(base_url, href)
        if full_url in seen:
            continue
        seen.add(full_url)
        inner = m.group("inner")

        img_m = img_pat.search(inner)
        img_url: Optional[str] = None
        if img_m:
            src = img_m.group(1)
            img_url = src if src.startswith("http") else urljoin(base_url, src)

        h3_m = h3_pat.search(inner)
        title = _strip(h3_m.group(1)) if h3_m else ""
        p_m = p_pat.search(inner)
        subtitle = _strip(p_m.group(1)) if p_m else ""

        if not title:
            continue
        results.append({"title": title, "subtitle": subtitle, "work_url": full_url, "image_url": img_url})
    return results


def fetch_cover_url(work_url: str, verify_ssl: bool = True) -> Optional[str]:
    try:
        from urllib.parse import urljoin
        page, final_url = request_text(work_url, verify_ssl=verify_ssl)
        patterns = [
            r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
            r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']',
            r'<img[^>]+(?:class|id)=["\'][^"\']*(?:cover|affiche|poster)[^"\']*["\'][^>]+src=["\']([^"\']+)["\']',
            r'<img[^>]+src=["\']([^"\']+)["\'][^>]+(?:class|id)=["\'][^"\']*(?:cover|affiche|poster)[^"\']*["\']',
        ]
        for pattern in patterns:
            m = re.search(pattern, page, re.IGNORECASE)
            if m:
                url = m.group(1)
                return url if url.startswith("http") else urljoin(final_url, url)
    except Exception:
        pass
    return None


def cache_cover(manga_id: str, cover_url: str, verify_ssl: bool = True) -> bool:
    cover_path = COVERS_DIR / f"{manga_id}.jpg"
    if cover_path.exists():
        return True
    try:
        data, _, _ = request_bytes(cover_url, verify_ssl=verify_ssl)
        cover_path.write_bytes(data)
        return True
    except Exception:
        return False


# ── Chapter processing (mirrors process_chapter_epub with absolute paths) ────

def _process_chapter(
    chapter_dir: Path,
    manga_name: str,
    chapter_number: int,
    page_height: int,
    keep_images: bool,
) -> None:
    source_files = sorted(
        [p for p in chapter_dir.iterdir() if p.suffix.lower() == ".jpg" and p.stem.isdigit()],
        key=lambda p: int(p.stem),
    )
    if not source_files:
        return

    images_dir = chapter_dir / "images"
    images_dir.mkdir(exist_ok=True)
    all_pages: list[Path] = []

    import subprocess as _sp
    first_h = int(_sp.run(
        ["identify", "-format", "%h", str(source_files[0])],
        capture_output=True, text=True, check=True,
    ).stdout.strip())

    if first_h > 4000:
        tmp_dirs: list[Path] = []
        for source in source_files:
            tmp = chapter_dir / f"_tmp_{source.stem}"
            pages = split_fixed(str(source), tmp, page_height=page_height)
            all_pages.extend(pages)
            tmp_dirs.append(tmp)
        for idx, page in enumerate(all_pages, 1):
            shutil.copy2(page, images_dir / f"{idx:03d}.jpg")
        for tmp in tmp_dirs:
            shutil.rmtree(tmp, ignore_errors=True)
    else:
        for idx, source in enumerate(source_files, 1):
            shutil.copy2(source, images_dir / f"{idx:03d}.jpg")
        all_pages = list(sorted(images_dir.iterdir()))

    epub_path = chapter_dir.parent / f"Chapitre {chapter_number}.epub"
    create_epub(
        chapter_dir=images_dir,
        output_file=epub_path,
        title=f"{manga_name} - Chapitre {chapter_number}",
        author="Inconnu",
        language="fr",
        image_format="original",
        quality=82,
        max_width=None,
    )

    for source in source_files:
        source.unlink(missing_ok=True)

    if not keep_images:
        shutil.rmtree(images_dir, ignore_errors=True)


# ── Background download ───────────────────────────────────────────────────────

def download_chapters(
    job_id: str,
    work_url: str,
    category_url: str,
    manga_name: str,
    category_label: str,
    scan_title: str,
    start_chapter: int,
    end_chapter: int,
    page_height: int = 1878,
    make_epub: bool = True,
    keep_images: bool = False,
) -> None:
    from . import jobs as jobs_svc

    jobs_svc.update_job(job_id, status="running")
    try:
        base_url, verify_ssl = resolve_base_url()
        chapter_map = fetch_chapter_map(base_url, verify_ssl, scan_title)

        base_dir = EXTRACTION_DIR / sanitize_name(manga_name) / sanitize_name(category_label)
        base_dir.mkdir(parents=True, exist_ok=True)

        # Persist metadata so the library can find cover/origin info
        meta = {
            "scan_title": scan_title,
            "manga_name": manga_name,
            "category": category_label,
            "work_url": work_url,
            "scan_url": category_url,
            "base_url": base_url,
            "verify_ssl": verify_ssl,
        }
        # Fetch cover once if not already cached
        manga_id = _make_manga_id(manga_name, category_label)
        if not (COVERS_DIR / f"{manga_id}.jpg").exists():
            cover_url = fetch_cover_url(work_url, verify_ssl)
            if cover_url:
                meta["cover_url"] = cover_url
                cache_cover(manga_id, cover_url, verify_ssl)
        elif (base_dir / "meta.json").exists():
            try:
                existing = json.loads((base_dir / "meta.json").read_text())
                meta.get("cover_url") or (meta := {**meta, **{"cover_url": existing.get("cover_url")}})
            except Exception:
                pass

        (base_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))

        chapters_to_do = [c for c in range(start_chapter, end_chapter + 1) if c in chapter_map]
        jobs_svc.update_job(job_id, total=len(chapters_to_do))

        for progress, chapter in enumerate(chapters_to_do, 1):
            image_count = chapter_map[chapter]
            chapter_dir = base_dir / f"Chapitre {chapter}"
            chapter_dir.mkdir(parents=True, exist_ok=True)

            for page_number in range(1, image_count + 1):
                out = chapter_dir / f"{page_number}.jpg"
                if out.exists():
                    continue
                image_url = build_image_url(base_url, scan_title, chapter, page_number)
                try:
                    payload, _, headers = request_bytes(image_url, verify_ssl=verify_ssl)
                except RuntimeError:
                    break
                ct = headers.get("Content-Type", "")
                if ct.startswith("text/") or b"Page introuvable" in payload[:512]:
                    break
                out.write_bytes(payload)

            if make_epub:
                _process_chapter(chapter_dir, manga_name, chapter, page_height, keep_images)

            jobs_svc.update_job(job_id, progress=progress)

        jobs_svc.update_job(job_id, status="done")

    except Exception as exc:
        jobs_svc.update_job(job_id, status="error", error=str(exc))


def _make_manga_id(manga_name: str, category: str) -> str:
    def slug(s: str) -> str:
        return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return f"{slug(manga_name)}_{slug(category)}"
