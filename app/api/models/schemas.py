from __future__ import annotations
from pydantic import BaseModel
from typing import Optional


class Chapter(BaseModel):
    number: int
    title: str
    has_epub: bool


class Manga(BaseModel):
    id: str
    name: str
    category: str
    cover_url: Optional[str] = None
    chapter_count: int
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


class ExtractRequest(BaseModel):
    work_url: str
    category_url: str
    manga_name: str
    category_label: str
    scan_title: str
    start_chapter: int
    end_chapter: int
    page_height: int = 1878
    make_epub: bool = True
    keep_images: bool = False


class Job(BaseModel):
    id: str
    status: str  # pending | running | done | error
    manga_name: str
    category: str
    start_chapter: int
    end_chapter: int
    progress: int = 0
    total: int = 0
    created_at: str
    completed_at: Optional[str] = None
    error: Optional[str] = None


class UserCreate(BaseModel):
    username: str
    password: str


class UserLogin(BaseModel):
    username: str
    password: str


class UserOut(BaseModel):
    id: str
    username: str
    created_at: str


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut
