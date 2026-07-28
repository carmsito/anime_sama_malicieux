import re
import zipfile
from pathlib import Path
from typing import Optional

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
MEDIA_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
               ".webp": "image/webp", ".gif": "image/gif"}

_cache: dict[str, list[str]] = {}


def _natural_key(name: str) -> list:
    return [int(p) if p.isdigit() else p.lower() for p in re.split(r"(\d+)", name)]


def _list_images(epub_path: Path) -> list[str]:
    key = str(epub_path)
    if key not in _cache:
        with zipfile.ZipFile(epub_path) as zf:
            imgs = [n for n in zf.namelist() if Path(n).suffix.lower() in IMAGE_EXTS]
        _cache[key] = sorted(imgs, key=_natural_key)
    return _cache[key]


def get_image_count(epub_path: Path) -> int:
    return len(_list_images(epub_path))


def get_image_data(epub_path: Path, idx: int) -> tuple[Optional[bytes], Optional[str]]:
    images = _list_images(epub_path)
    if idx < 0 or idx >= len(images):
        return None, None
    with zipfile.ZipFile(epub_path) as zf:
        data = zf.read(images[idx])
    ext = Path(images[idx]).suffix.lower()
    return data, MEDIA_TYPES.get(ext, "image/jpeg")
