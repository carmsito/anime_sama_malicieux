"""
File de jobs + pool de workers.

Avant : chaque requête /extract lançait un threading.Thread(daemon=True) → nombre
de threads non borné, aucun contrôle de charge, jobs perdus au restart.

Maintenant : une file bornée consommée par N workers. La concurrence Chrome de
Sushiscan reste gérée par le BrowserPool ; ici on borne la concurrence *jobs*.

Le worker exécute simplement le `target(**kwargs)` fourni (les fonctions download
gèrent déjà leur propre statut). Un filet de sécurité met le job en erreur si le
target lève avant d'avoir pu se marquer.

Durabilité : le statut des jobs est persisté par jobs.py. La reprise des jobs
in-flight après un redémarrage arrivera avec la DB (Phase 3, où les paramètres
d'appel seront stockés). Ici, les jobs interrompus sont marqués `interrupted`.
"""
from __future__ import annotations

import os
import queue
import threading
from typing import Any, Callable

from . import jobs as jobs_svc

JOB_WORKERS = int(os.environ.get("JOB_WORKERS", "3"))

_q: "queue.Queue[tuple[Callable[..., Any], dict]]" = queue.Queue()
_workers: list[threading.Thread] = []
_started = False
_start_lock = threading.Lock()


def enqueue(target: Callable[..., Any], kwargs: dict) -> None:
    """Enfile un job. Retour immédiat (l'API n'est jamais bloquée)."""
    _q.put((target, kwargs))


def _worker_loop() -> None:
    while True:
        target, kwargs = _q.get()
        job_id = kwargs.get("job_id")
        try:
            target(**kwargs)
        except Exception as e:  # filet de sécurité
            if job_id:
                try:
                    jobs_svc.update_job(job_id, status="error", error=str(e))
                except Exception:
                    pass
            print(f"[job_queue] job {job_id} a échoué: {e}", flush=True)
        finally:
            _q.task_done()


def start(n_workers: int | None = None) -> None:
    """Démarre le pool de workers (idempotent)."""
    global _started
    with _start_lock:
        if _started:
            return
        n = n_workers or JOB_WORKERS
        for i in range(n):
            t = threading.Thread(target=_worker_loop, name=f"job-worker-{i}", daemon=True)
            t.start()
            _workers.append(t)
        _started = True
        print(f"[job_queue] {n} workers démarrés", flush=True)


def stats() -> dict:
    return {"workers": len(_workers), "pending": _q.qsize(), "started": _started}
