import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..config import JOBS_FILE

_lock = threading.Lock()
_jobs: dict[str, dict] = {}


def _load_from_disk() -> None:
    if JOBS_FILE.exists():
        try:
            data = json.loads(JOBS_FILE.read_text())
            for job in data.values():
                if job.get("status") == "running":
                    job["status"] = "interrupted"
            _jobs.update(data)
        except Exception:
            pass


def _save_to_disk() -> None:
    try:
        JOBS_FILE.parent.mkdir(parents=True, exist_ok=True)
        JOBS_FILE.write_text(json.dumps(_jobs, ensure_ascii=False, indent=2))
    except Exception:
        pass


_load_from_disk()


def create_job(
    manga_name: str,
    category: str,
    start_chapter: int,
    end_chapter: int,
) -> dict:
    job_id = str(uuid.uuid4())
    job = {
        "id": job_id,
        "status": "pending",
        "manga_name": manga_name,
        "category": category,
        "start_chapter": start_chapter,
        "end_chapter": end_chapter,
        "progress": 0,
        "total": end_chapter - start_chapter + 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "completed_at": None,
        "error": None,
    }
    with _lock:
        _jobs[job_id] = job
        _save_to_disk()
    return job


def update_job(job_id: str, **kwargs) -> None:
    with _lock:
        if job_id not in _jobs:
            return
        _jobs[job_id].update(kwargs)
        if kwargs.get("status") in ("done", "error"):
            _jobs[job_id]["completed_at"] = datetime.now(timezone.utc).isoformat()
        _save_to_disk()


def get_job(job_id: str) -> Optional[dict]:
    with _lock:
        return _jobs.get(job_id)


def list_jobs() -> list[dict]:
    with _lock:
        return sorted(_jobs.values(), key=lambda j: j["created_at"], reverse=True)
