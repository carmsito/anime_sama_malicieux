"""Playlist musique par manga.

- Stockage : table SQLite `manga_music` (juste l'URL YouTube + titre, RIEN n'est téléchargé).
- Lecture LIVE : yt-dlp résout l'URL audio directe (googlevideo) à la volée — avec les
  cookies YouTube (bot check) + deno (déchiffrement du "n challenge") — et le routeur
  re-streame ce flux au navigateur. Zéro fichier stocké, zéro pub.
"""
import os
import time
import uuid
import shutil
import tempfile
import subprocess

from ..config import YOUTUBE_COOKIES, DATA_DIR
from . import db

# Cache yt-dlp (dont le solveur EJS téléchargé UNE fois) sur le volume persistant.
_YTDLP_CACHE = str(DATA_DIR / "ytdlp-cache")
# Sidecar bgutil qui fournit le PO token (proof-of-origin) → bot check YouTube fiable.
_BGUTIL_URL = os.environ.get("BGUTIL_BASE_URL", "").strip()
# Egress : l'IP datacenter du serveur est bloquée par YouTube. Poser YTDLP_PROXY dans .env
# (ex. socks5://user:pass@host:port — proxy résidentiel, VPN, ou ta connexion maison) route
# yt-dlp par une IP non-bloquée → l'extraction repasse. Vide = pas de proxy.
_PROXY = os.environ.get("YTDLP_PROXY", "").strip()

# Cache des URLs audio résolues (elles expirent côté Google ~6 h) → on évite de relancer
# yt-dlp à chaque requête Range du <audio>.
_URL_CACHE: dict[str, tuple[str, float]] = {}
_URL_TTL = 5 * 3600


def _ensure_table(conn):
    conn.execute(
        """CREATE TABLE IF NOT EXISTS manga_music (
            manga_id TEXT, id TEXT, url TEXT, title TEXT,
            position INTEGER, created_at TEXT,
            PRIMARY KEY (manga_id, id))"""
    )


def _ytdlp(*args, timeout=90):
    # --remote-components ejs:github : récupère le solveur JS officiel de yt-dlp (exécuté
    # dans deno) pour résoudre le "n challenge" YouTube — sinon aucun format audio.
    # --cache-dir : le solveur est mis en cache sur srv-data → téléchargé une seule fois.
    cmd = ["yt-dlp", "--no-warnings", "--no-playlist",
           "--remote-components", "ejs:github", "--cache-dir", _YTDLP_CACHE]
    if _BGUTIL_URL:
        cmd += ["--extractor-args", f"youtubepot-bgutilhttp:base_url={_BGUTIL_URL}"]
    if _PROXY:
        cmd += ["--proxy", _PROXY]
    tmp_cookies = None
    if YOUTUBE_COOKIES.exists():
        # yt-dlp RÉÉCRIT le fichier passé à --cookies après chaque appel. Si on lui donnait
        # le fichier maître, un challenge YouTube le dégraderait (perte des cookies d'auth)
        # et casserait tout. → on passe une COPIE JETABLE ; le fichier maître reste intact.
        fd, tmp_cookies = tempfile.mkstemp(prefix="ytc_", suffix=".txt")
        os.close(fd)
        shutil.copy(str(YOUTUBE_COOKIES), tmp_cookies)
        cmd += ["--cookies", tmp_cookies]
    cmd += list(args)
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    finally:
        if tmp_cookies:
            try:
                os.remove(tmp_cookies)
            except OSError:
                pass


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
    try:
        out = _ytdlp("--skip-download", "--print", "%(title)s", url, timeout=60)
        lines = [l for l in out.stdout.strip().splitlines() if l.strip()]
        return lines[0] if lines else url
    except Exception:
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
    """URL audio directe (googlevideo) de la piste, mise en cache (TTL). None si KO."""
    now = time.time()
    cached = _URL_CACHE.get(track_id)
    if cached and cached[1] > now:
        return cached[0]
    src = _track_source(manga_id, track_id)
    if not src:
        return None
    try:
        out = _ytdlp("-f", "bestaudio[ext=m4a]/bestaudio/best", "-g", src, timeout=90)
        lines = [l for l in out.stdout.strip().splitlines() if l.startswith("http")]
        url = lines[0] if lines else None
    except Exception:
        url = None
    if url:
        _URL_CACHE[track_id] = (url, now + _URL_TTL)
    return url
