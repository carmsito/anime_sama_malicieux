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
    meta_file = cat_dir / "meta.json"
    if meta_file.exists():
        try:
            return json.loads(meta_file.read_text())
        except Exception:
            pass
    return {}


def _cover_url(manga_id: str, meta: dict) -> Optional[str]:
    if (COVERS_DIR / f"{manga_id}.jpg").exists():
        return f"/api/covers/{manga_id}"
    return None


def _list_chapters(cat_dir: Path) -> list[dict]:
    chapters = []
    for epub in cat_dir.glob("Chapitre *.epub"):
        try:
            num = int(epub.stem.split()[-1])
        except (ValueError, IndexError):
            continue
        chapters.append({"number": num, "title": epub.stem, "has_epub": True})
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
            cat_dir = (
                EXTRACTION_DIR / manga["name"] / manga["category"]
            )
            manga["chapters"] = _list_chapters(cat_dir)
            return manga
    return None


def save_manga_info(manga_id: str, info: dict) -> None:
    """Persist scraped info into meta.json so the next request is served from disk."""
    manga = get_manga(manga_id)
    if not manga:
        return
    cat_dir = EXTRACTION_DIR / manga["name"] / manga["category"]
    meta = _read_meta(cat_dir)
    meta.update({k: v for k, v in info.items() if v})
    try:
        (cat_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    except Exception:
        pass


def get_epub_path(manga_id: str, chapter_number: int) -> Optional[Path]:
    manga = get_manga(manga_id)
    if not manga:
        return None
    epub = (
        EXTRACTION_DIR
        / manga["name"]
        / manga["category"]
        / f"Chapitre {chapter_number}.epub"
    )
    return epub if epub.exists() else None
