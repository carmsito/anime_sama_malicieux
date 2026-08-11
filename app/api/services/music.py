"""Playlist musique par manga.

- Stockage : table SQLite `manga_music` (juste l'URL YouTube + le titre, RIEN n'est
  téléchargé).
- Titre : via l'oembed YouTube (public, pas de bot check).
- Lecture LIVE : un sidecar navigateur (yt-extractor, vrai Chrome) capture l'URL du flux
  audio que YouTube sert au lecteur ; le routeur la relaie au navigateur. yt-dlp est
  détecté comme bot depuis l'IP serveur → on passe par un vrai navigateur à la place.
  Zéro fichier stocké, zéro pub.
"""
import os
import time
import uuid

import requests

from . import db

_EXTRACTOR = os.environ.get("YT_EXTRACTOR_URL", "http://yt-extractor:8080").strip().rstrip("/")

# Cache des URLs audio résolues (elles expirent côté Google ~6 h) → on évite de relancer
# le navigateur à chaque requête Range du <audio>.
_URL_CACHE: dict[str, tuple[str, float]] = {}
_URL_TTL = 3 * 3600


def _ensure_table(conn):
    conn.execute(
        """CREATE TABLE IF NOT EXISTS manga_music (
            manga_id TEXT, id TEXT, url TEXT, title TEXT,
            position INTEGER, created_at TEXT,
            PRIMARY KEY (manga_id, id))"""
    )


def list_tracks(manga_id: str) -> list[dict]:
    conn = db._connect()
    try:
        _ensure_table(conn)
        rows = conn.execute(
            "SELECT id, url, title, position FROM manga_music WHERE manga_id=? "
            "ORDER BY position, created_at",
            (manga_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def _fetch_title(url: str) -> str:
    # oembed : titre public sans bot check.
    try:
        r = requests.get("https://www.youtube.com/oembed",
                         params={"url": url, "format": "json"}, timeout=15)
        if r.ok:
            t = (r.json() or {}).get("title")
            if t:
                return t
    except Exception:
        pass
    return url


def add_track(manga_id: str, url: str) -> dict:
    url = url.strip()
    title = _fetch_title(url)
    tid = uuid.uuid4().hex[:12]
    conn = db._connect()
    try:
        _ensure_table(conn)
        pos = conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM manga_music WHERE manga_id=?",
            (manga_id,),
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO manga_music VALUES (?,?,?,?,?,?)",
            (manga_id, tid, url, title, pos,
             time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
        )
        conn.commit()
    finally:
        conn.close()
    return {"id": tid, "url": url, "title": title, "position": pos}


def delete_track(manga_id: str, track_id: str):
    conn = db._connect()
    try:
        _ensure_table(conn)
        conn.execute("DELETE FROM manga_music WHERE manga_id=? AND id=?", (manga_id, track_id))
        conn.commit()
    finally:
        conn.close()
    _URL_CACHE.pop(track_id, None)


def _track_source(manga_id: str, track_id: str) -> str | None:
    conn = db._connect()
    try:
        _ensure_table(conn)
        r = conn.execute(
            "SELECT url FROM manga_music WHERE manga_id=? AND id=?", (manga_id, track_id)
        ).fetchone()
        return r["url"] if r else None
    finally:
        conn.close()


def resolve_audio(manga_id: str, track_id: str) -> str | None:
    """URL audio directe (googlevideo) via le sidecar navigateur, mise en cache. None si KO."""
    now = time.time()
    cached = _URL_CACHE.get(track_id)
    if cached and cached[1] > now:
        return cached[0]
    src = _track_source(manga_id, track_id)
    if not src:
        return None
    try:
        r = requests.get(f"{_EXTRACTOR}/extract", params={"id": src}, timeout=90)
        url = (r.json() or {}).get("url") if r.ok else None
    except Exception:
        url = None
    if url:
        _URL_CACHE[track_id] = (url, now + _URL_TTL)
    return url
