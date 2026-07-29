"""
Scans the extraction/ folder to build the manga library.
No database — filesystem is the source of truth.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional

from ..config import EXTRACTION_DIR, COVERS_DIR


def _make_manga_id(manga_name: str, category: str) -> str:
    def slug(s: str) -> str:
        return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return f"{slug(manga_name)}_{slug(category)}"


def _read_meta(cat_dir: Path) -> dict:
    """Read meta.json from cat_dir, or fall back to parent (flat sushiscan structure)."""
    for search_dir in (cat_dir, cat_dir.parent):
        meta_file = search_dir / "meta.json"
        if meta_file.exists():
            try:
                return json.loads(meta_file.read_text())
            except Exception:
                pass
    return {}


def _cover_url(manga_id: str, meta: dict) -> Optional[str]:
    """Return local cached cover URL or fall back to direct cover_url from meta."""
    if (COVERS_DIR / f"{manga_id}.jpg").exists():
        return f"/api/covers/{manga_id}"
    # Fallback: return the raw URL stored in meta.json (works for MangaDex/Sushiscan)
    return meta.get("cover_url") or None


def _parse_epub_stem(stem: str) -> Optional[dict]:
    """Parse 'Chapitre 12', 'Volume 12.0', 'Tome 3' → {number, title, kind}."""
    parts = stem.rsplit(None, 1)
    if len(parts) != 2:
        return None
    try:
        num = float(parts[-1])
    except ValueError:
        return None
    kind = parts[0] if parts[0] in ("Chapitre", "Volume", "Tome") else "Chapitre"
    return {"number": num, "title": stem, "has_epub": True, "kind": kind}


def _list_chapters(cat_dir: Path) -> list[dict]:
    """
    List EPUB chapters in cat_dir.
    Falls back to cat_dir.parent when no EPUBs in cat_dir (old flat sushiscan structure
    where EPUBs sit at manga_dir level alongside chapter image folders).
    """
    chapters: list[dict] = []
    seen_nums: set[float] = set()

    # Primary: EPUBs inside cat_dir
    for epub in cat_dir.glob("*.epub"):
        ch = _parse_epub_stem(epub.stem)
        if ch and ch["number"] not in seen_nums:
            chapters.append(ch)
            seen_nums.add(ch["number"])

    # Fallback: EPUBs at parent level (old sushiscan flat structure)
    if not chapters:
        for epub in cat_dir.parent.glob("*.epub"):
            ch = _parse_epub_stem(epub.stem)
            if ch and ch["number"] not in seen_nums:
                chapters.append(ch)
                seen_nums.add(ch["number"])

    return sorted(chapters, key=lambda c: c["number"])


def list_mangas() -> list[dict]:
    mangas = []
    if not EXTRACTION_DIR.exists():
        return mangas
    for manga_dir in sorted(EXTRACTION_DIR.iterdir()):
        if not manga_dir.is_dir():
            continue
        for cat_dir in sorted(manga_dir.iterdir()):
            if not cat_dir.is_dir():
                continue
            chapters = _list_chapters(cat_dir)
            meta = _read_meta(cat_dir)
            manga_id = _make_manga_id(manga_dir.name, cat_dir.name)
            mangas.append({
                "id": manga_id,
                "name": manga_dir.name,
                "category": cat_dir.name,
                "cover_url": _cover_url(manga_id, meta),
                "chapter_count": len(chapters),
                "meta": meta,
            })
    return mangas


def get_manga(manga_id: str) -> Optional[dict]:
    for manga in list_mangas():
        if manga["id"] == manga_id:
            cat_dir = EXTRACTION_DIR / manga["name"] / manga["category"]
            manga["chapters"] = _list_chapters(cat_dir)
            return manga
    return None


def save_manga_info(manga_id: str, info: dict) -> None:
    """Persist scraped info into meta.json."""
    manga = get_manga(manga_id)
    if not manga:
        return
    cat_dir = EXTRACTION_DIR / manga["name"] / manga["category"]
    # Find the right meta.json (cat_dir or parent)
    meta_file = None
    for search_dir in (cat_dir, cat_dir.parent):
        f = search_dir / "meta.json"
        if f.exists():
            meta_file = f
            break
    if meta_file is None:
        meta_file = cat_dir / "meta.json"

    meta = _read_meta(cat_dir)
    meta.update({k: v for k, v in info.items() if v})
    try:
        meta_file.write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    except Exception:
        pass


def get_epub_path(manga_id: str, chapter_number: float) -> Optional[Path]:
    """Find the EPUB file for a given chapter number (supports int and float)."""
    manga = get_manga(manga_id)
    if not manga:
        return None
    cat_dir = EXTRACTION_DIR / manga["name"] / manga["category"]

    # Build candidate filenames: "Chapitre 1", "Volume 1.0", "Tome 1", etc.
    # Try both float and int representation (12.0 → also try 12)
    num_strs: list[str] = [str(chapter_number)]
    if chapter_number == int(chapter_number):
        num_strs.append(str(int(chapter_number)))

    search_dirs = [cat_dir, cat_dir.parent]
    for prefix in ("Chapitre", "Volume", "Tome"):
        for num_str in num_strs:
            for search_dir in search_dirs:
                epub = search_dir / f"{prefix} {num_str}.epub"
                if epub.exists():
                    return epub
    return None
