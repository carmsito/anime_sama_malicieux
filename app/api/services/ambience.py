"""
Ambiance sonore des planches — orchestration côté app.

Le classifieur (torch/open_clip) n'est PAS dans le conteneur → le job délègue la
classification à un script HÔTE (venv) via SSH (clé console + host.docker.internal),
exactement comme la console. Le script écrit les segments RLE dans la table
`ambience_segments` de la même DB (montée). Ici on : lit les segments, liste les
chapitres analysés, et lance le job d'analyse (fetch EPUB → classif hôte).
"""
from __future__ import annotations

import json
import re
import shlex
import subprocess

from . import db, jobs as jobs_svc, library, storage
from ..config import (
    AMBIENCE_PYTHON, AMBIENCE_SCRIPT, CONSOLE_SSH_KEY, CONSOLE_SSH_TARGET,
)

_SAFE_ID = re.compile(r"^[A-Za-z0-9_.-]+$")
_SAFE_KIND = re.compile(r"^[A-Za-z]+$")


def _ensure_table(conn) -> None:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS ambience_segments (
            manga_id TEXT, chapter_number REAL, kind TEXT,
            data TEXT, created_at TEXT,
            PRIMARY KEY (manga_id, chapter_number, kind))"""
    )


def get_segments(manga_id: str, chapter_number: float, kind: str | None = None):
    conn = db._connect()
    try:
        _ensure_table(conn)
        if kind:
            row = conn.execute(
                "SELECT data FROM ambience_segments WHERE manga_id=? AND chapter_number=? AND kind=?",
                (manga_id, float(chapter_number), kind)).fetchone()
        else:
            row = conn.execute(
                "SELECT data FROM ambience_segments WHERE manga_id=? AND chapter_number=? "
                "ORDER BY created_at DESC LIMIT 1",
                (manga_id, float(chapter_number))).fetchone()
        return json.loads(row["data"]) if row else None
    finally:
        conn.close()


def analyzed_chapters(manga_id: str) -> list[float]:
    conn = db._connect()
    try:
        _ensure_table(conn)
        rows = conn.execute(
            "SELECT DISTINCT chapter_number FROM ambience_segments WHERE manga_id=?",
            (manga_id,)).fetchall()
        return sorted(r["chapter_number"] for r in rows)
    finally:
        conn.close()


def _chapter_kind(m: dict, chn: float) -> str:
    meta = (m or {}).get("meta", {}) or {}
    for c in ((m or {}).get("chapters", []) or []):
        try:
            if float(c.get("number", -1)) == chn:
                return c.get("kind") or meta.get("kind") or "Chapitre"
        except (TypeError, ValueError):
            continue
    return meta.get("kind") or "Chapitre"


def _classify_on_host(manga_id: str, chapter: float, kind: str) -> None:
    # Anti-injection : les args partent dans une commande SSH distante → on valide + quote.
    if not _SAFE_ID.match(str(manga_id)) or not _SAFE_KIND.match(str(kind)):
        raise ValueError(f"args invalides ({manga_id!r}, {kind!r})")
    remote = "{py} {sc} {mid} {ch} {kd}".format(
        py=shlex.quote(AMBIENCE_PYTHON), sc=shlex.quote(AMBIENCE_SCRIPT),
        mid=shlex.quote(str(manga_id)), ch=shlex.quote(str(float(chapter))),
        kd=shlex.quote(str(kind)))
    cmd = [
        "ssh", "-i", CONSOLE_SSH_KEY,
        "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=10",
        CONSOLE_SSH_TARGET, remote,
    ]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout or "classif hôte échouée").strip()[-300:])


def run_analysis(job_id: str, manga_id: str, chapters: list[float]) -> None:
    """Worker : pour chaque chapitre, s'assure que l'EPUB est en cache puis délègue
    la classif à l'hôte (qui écrit les segments en DB). Borné : 1 chapitre à la fois."""
    m = library.get_manga(manga_id)
    jobs_svc.update_job(job_id, status="running", total=len(chapters), progress=0)
    done = 0
    for ch in chapters:
        chn = float(ch)
        kind = _chapter_kind(m, chn)
        try:
            storage.fetch_epub(manga_id, chn, kind)          # EPUB en cache hôte
            _classify_on_host(manga_id, chn, kind)           # torch sur l'hôte → segments en DB
        except Exception as e:
            print(f"[ambience] {manga_id} ch{chn}: {e}", flush=True)
        done += 1
        jobs_svc.update_job(job_id, progress=done)
    jobs_svc.update_job(job_id, status="done", progress=done)
