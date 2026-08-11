"""
Mini-DB — couche mince au-dessus de SQLite (WAL).

Rôle principal (cf. besoin utilisateur) : stocker UNIQUEMENT les liens entre les
données de l'app et Telegram (le stockage réel des EPUB, Phase 4). La DB reste un
index ; les fichiers vivent sur Telegram.

Seam Postgres : tout passe par `_connect()` + `_ph()` (placeholder). Pour migrer
vers Neon/Supabase, il suffira de brancher psycopg ici et d'utiliser `%s`.
Le volume visé (≈10 users) tient très large en SQLite.

Concurrence : connexions courtes par opération + WAL → lecteurs concurrents OK,
écritures sérialisées par SQLite. Suffisant à cette échelle.
"""
from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timezone
from typing import Optional

from ..config import DB_PATH

_init_lock = threading.Lock()
_initialized = False

_SCHEMA = """
CREATE TABLE IF NOT EXISTS telegram_files (
    manga_id       TEXT    NOT NULL,
    chapter_number REAL    NOT NULL,
    kind           TEXT    NOT NULL DEFAULT 'Chapitre',
    file_id        TEXT    NOT NULL,   -- id Telegram (MTProto) pour re-download
    msg_id         INTEGER,            -- id du message (canal de stockage)
    size           INTEGER,
    filename       TEXT,
    uploaded_at    TEXT    NOT NULL,
    PRIMARY KEY (manga_id, chapter_number, kind)
);
CREATE INDEX IF NOT EXISTS idx_tgfiles_manga ON telegram_files (manga_id);

-- Petit KV générique (settings, sessions, curseurs…)
CREATE TABLE IF NOT EXISTS kv (
    k TEXT PRIMARY KEY,
    v TEXT
);

-- Progression de lecture par utilisateur (marque-page)
CREATE TABLE IF NOT EXISTS reading_progress (
    user_id        TEXT    NOT NULL,
    manga_id       TEXT    NOT NULL,
    chapter_number REAL    NOT NULL,
    page           INTEGER NOT NULL DEFAULT 0,
    total_pages    INTEGER NOT NULL DEFAULT 0,
    updated_at     TEXT    NOT NULL,
    PRIMARY KEY (user_id, manga_id, chapter_number)
);
CREATE INDEX IF NOT EXISTS idx_progress_user_manga ON reading_progress (user_id, manga_id);

-- Favoris par utilisateur
CREATE TABLE IF NOT EXISTS favorites (
    user_id    TEXT NOT NULL,
    manga_id   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, manga_id)
);
CREATE INDEX IF NOT EXISTS idx_fav_user ON favorites (user_id);

-- Profils de lecture par utilisateur (blob JSON : profiles + defaultId + perManga + activeId).
-- Synchronisé par compte → multi-appareils, aucune gestion de cache locale.
CREATE TABLE IF NOT EXISTS reader_profiles (
    user_id    TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    return conn


def init() -> None:
    """Crée les tables (idempotent). Appelé au démarrage."""
    global _initialized
    with _init_lock:
        if _initialized:
            return
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = _connect()
        try:
            conn.executescript(_SCHEMA)
            conn.commit()
        finally:
            conn.close()
        _initialized = True


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── telegram_files (mapping data ↔ Telegram) ──────────────────────────────────

def put_file(manga_id: str, chapter_number: float, kind: str,
             file_id: str, msg_id: int | None = None,
             size: int | None = None, filename: str | None = None) -> None:
    """Enregistre/actualise le lien EPUB → Telegram."""
    init()
    conn = _connect()
    try:
        conn.execute(
            """INSERT INTO telegram_files
                 (manga_id, chapter_number, kind, file_id, msg_id, size, filename, uploaded_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(manga_id, chapter_number, kind) DO UPDATE SET
                 file_id=excluded.file_id, msg_id=excluded.msg_id,
                 size=excluded.size, filename=excluded.filename,
                 uploaded_at=excluded.uploaded_at""",
            (manga_id, float(chapter_number), kind, file_id, msg_id, size, filename, _now()),
        )
        conn.commit()
    finally:
        conn.close()


def get_file(manga_id: str, chapter_number: float, kind: str | None = None) -> Optional[dict]:
    """Retrouve le lien Telegram d'un chapitre/volume (kind optionnel)."""
    init()
    conn = _connect()
    try:
        if kind:
            row = conn.execute(
                "SELECT * FROM telegram_files WHERE manga_id=? AND chapter_number=? AND kind=?",
                (manga_id, float(chapter_number), kind),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM telegram_files WHERE manga_id=? AND chapter_number=?",
                (manga_id, float(chapter_number)),
            ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def list_files(manga_id: str) -> list[dict]:
    init()
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT * FROM telegram_files WHERE manga_id=? ORDER BY chapter_number",
            (manga_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def delete_file(manga_id: str, chapter_number: float, kind: str) -> None:
    init()
    conn = _connect()
    try:
        conn.execute(
            "DELETE FROM telegram_files WHERE manga_id=? AND chapter_number=? AND kind=?",
            (manga_id, float(chapter_number), kind),
        )
        conn.commit()
    finally:
        conn.close()


# ── KV générique ──────────────────────────────────────────────────────────────

def kv_get(k: str) -> Optional[str]:
    init()
    conn = _connect()
    try:
        row = conn.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
        return row["v"] if row else None
    finally:
        conn.close()


def kv_set(k: str, v: str) -> None:
    init()
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
            (k, v),
        )
        conn.commit()
    finally:
        conn.close()


# ── Profils de lecture (par utilisateur) ──────────────────────────────────────

def get_reader_profiles(user_id: str) -> Optional[str]:
    init()
    conn = _connect()
    try:
        row = conn.execute("SELECT data FROM reader_profiles WHERE user_id=?", (user_id,)).fetchone()
        return row["data"] if row else None
    finally:
        conn.close()


def set_reader_profiles(user_id: str, data: str) -> None:
    init()
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO reader_profiles (user_id, data, updated_at) VALUES (?,?,?) "
            "ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
            (user_id, data, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
    finally:
        conn.close()


# ── Progression de lecture ────────────────────────────────────────────────────

def set_progress(user_id: str, manga_id: str, chapter_number: float,
                 page: int, total_pages: int = 0) -> None:
    init()
    conn = _connect()
    try:
        conn.execute(
            """INSERT INTO reading_progress
                 (user_id, manga_id, chapter_number, page, total_pages, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(user_id, manga_id, chapter_number) DO UPDATE SET
                 page=excluded.page, total_pages=excluded.total_pages, updated_at=excluded.updated_at""",
            (user_id, manga_id, float(chapter_number), int(page), int(total_pages), _now()),
        )
        conn.commit()
    finally:
        conn.close()


def get_progress(user_id: str, manga_id: str) -> list[dict]:
    """Progression de tous les chapitres lus d'un manga par cet utilisateur."""
    init()
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT chapter_number, page, total_pages, updated_at FROM reading_progress "
            "WHERE user_id=? AND manga_id=? ORDER BY updated_at DESC",
            (user_id, manga_id),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_progress_all(user_id: str) -> list[dict]:
    """Toutes les progressions de l'utilisateur (pour % par manga + stats)."""
    init()
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT manga_id, chapter_number, page, total_pages, updated_at FROM reading_progress WHERE user_id=?",
            (user_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def reset_progress(user_id: str, manga_id: str) -> int:
    """Efface toute la progression d'un manga pour cet utilisateur (→ 'jamais lu')."""
    init()
    conn = _connect()
    try:
        cur = conn.execute(
            "DELETE FROM reading_progress WHERE user_id=? AND manga_id=?",
            (user_id, manga_id),
        )
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


# ── Favoris ───────────────────────────────────────────────────────────────────

def set_favorite(user_id: str, manga_id: str, on: bool) -> None:
    init()
    conn = _connect()
    try:
        if on:
            conn.execute(
                "INSERT OR IGNORE INTO favorites (user_id, manga_id, created_at) VALUES (?, ?, ?)",
                (user_id, manga_id, _now()),
            )
        else:
            conn.execute("DELETE FROM favorites WHERE user_id=? AND manga_id=?", (user_id, manga_id))
        conn.commit()
    finally:
        conn.close()


def list_favorites(user_id: str) -> list[str]:
    init()
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT manga_id FROM favorites WHERE user_id=? ORDER BY created_at DESC",
            (user_id,),
        ).fetchall()
        return [r["manga_id"] for r in rows]
    finally:
        conn.close()


def get_continue(user_id: str, limit: int = 20) -> list[dict]:
    """Dernier chapitre lu par manga (le plus récent d'abord) — pour 'Reprendre'."""
    init()
    conn = _connect()
    try:
        rows = conn.execute(
            """SELECT rp.manga_id, rp.chapter_number, rp.page, rp.total_pages, rp.updated_at
                 FROM reading_progress rp
                 JOIN (SELECT manga_id, MAX(updated_at) mu FROM reading_progress
                       WHERE user_id=? GROUP BY manga_id) x
                   ON rp.manga_id=x.manga_id AND rp.updated_at=x.mu
                WHERE rp.user_id=?
                ORDER BY rp.updated_at DESC LIMIT ?""",
            (user_id, user_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()
