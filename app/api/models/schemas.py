from __future__ import annotations
from pydantic import BaseModel
from typing import Optional


class Chapter(BaseModel):
    number: float
    title: str
    has_epub: bool
    kind: Optional[str] = None


class Manga(BaseModel):
    id: str
    name: str
    category: str
    source: Optional[str] = None
    cover_url: Optional[str] = None
    chapter_count: int
    kind: Optional[str] = None
    chapters: Optional[list[Chapter]] = None
    work_url: Optional[str] = None


class SearchResult(BaseModel):
    title: str
    subtitle: str
    work_url: str
    image_url: Optional[str] = None


class ScanCategory(BaseModel):
    label: str
    url: str


class ChapterMap(BaseModel):
    scan_title: str
    first_chapter: int
    last_chapter: int
    chapters: dict[str, int]  # {chapter_number: image_count}


# ── MangaDex models ───────────────────────────────────────────────────────────

class MangaDexLang(BaseModel):
    lang: str
    label: str
    count: int


class MangaDexChapters(BaseModel):
    manga_id: str
    lang: str
    first_chapter: str
    last_chapter: str
    total: int


# ── Sushiscan models ──────────────────────────────────────────────────────────

class SushiscanKindInfo(BaseModel):
    first: float
    last: float
    total: int


class SushiscanChapters(BaseModel):
    manga_url: str
    first_chapter: float
    last_chapter: float
    total: int
    kind: str  # "Volume" | "Chapitre"
    kinds: Optional[dict[str, SushiscanKindInfo]] = None


# ── Extract request (multi-source) ────────────────────────────────────────────

class ExtractRequest(BaseModel):
    source: str = "anime-sama"  # "anime-sama" | "mangadex" | "sushiscan"
    manga_name: str
    start_chapter: float = 1
    end_chapter: float = 1
    page_height: int = 1878
    make_epub: bool = True
    keep_images: bool = False
    # Anime-Sama fields
    work_url: Optional[str] = None
    category_url: Optional[str] = None
    category_label: Optional[str] = None
    scan_title: Optional[str] = None
    # MangaDex fields
    manga_id: Optional[str] = None
    lang: Optional[str] = None
    start_chapter_str: Optional[str] = None  # MangaDex chapter nums can be "1.5"
    end_chapter_str: Optional[str] = None
    # Sushiscan fields
    manga_url: Optional[str] = None
    kind: Optional[str] = None  # "Chapitre" | "Volume" | "Tome"
    batch_size: int = 5


class Job(BaseModel):
    id: str
    status: str  # pending | running | done | error
    manga_name: str
    category: str
    source: str = "anime-sama"
    start_chapter: float = 0
    end_chapter: float = 0
    progress: int = 0
    total: int = 0
    created_at: str
    completed_at: Optional[str] = None
    error: Optional[str] = None


class UserCreate(BaseModel):
    username: str
    password: str
    role: Optional[str] = None


class UserLogin(BaseModel):
    username: str
    password: str


class UserOut(BaseModel):
    id: str
    username: str
    role: str = "scrapper"
    created_at: Optional[str] = None


class RoleUpdate(BaseModel):
    role: str


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut
