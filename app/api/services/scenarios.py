"""
Scénarios de maintenance programmables (façon "routine" Google Home).

- Un scénario = une action + des déclencheurs de temps (unité + nombre de passages).
- Un thread scheduler vérifie périodiquement si un scénario est dû et le lance.
- On peut aussi lancer un scénario IMMÉDIATEMENT ("run now").

Scénario disponible :
- "verification" : vérifie l'intégrité des EPUB stockés sur Telegram (taille DB vs taille
  réelle Telegram — léger, sans téléchargement) et liste les cassés PAR SOURCE.
"""
from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timedelta, timezone

from . import db, library

_KEY_CONF = "scenario_verification_conf"
_KEY_RESULT = "scenario_verification_result"
_KEY_RUNNING = "scenario_verification_running"

# secondes par unité de fréquence
_UNIT_SECONDS = {"day": 86400, "week": 604800, "month": 2592000}

_lock = threading.Lock()
_scheduler_started = False


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def get_conf() -> dict:
    raw = db.kv_get(_KEY_CONF)
    conf = json.loads(raw) if raw else {}
    return {
        "enabled": conf.get("enabled", False),
        "unit": conf.get("unit", "week"),      # day | week | month
        "count": int(conf.get("count", 1)),     # nombre de passages par unité
        "last_run": conf.get("last_run"),
        "next_run": conf.get("next_run"),
    }


def _interval_seconds(conf: dict) -> float:
    unit = _UNIT_SECONDS.get(conf.get("unit", "week"), 604800)
    count = max(1, int(conf.get("count", 1)))
    return unit / count


def _save_conf(conf: dict) -> None:
    db.kv_set(_KEY_CONF, json.dumps(conf))


def set_conf(enabled: bool, unit: str, count: int) -> dict:
    conf = get_conf()
    conf["enabled"] = bool(enabled)
    conf["unit"] = unit if unit in _UNIT_SECONDS else "week"
    conf["count"] = max(1, min(int(count), 100))
    if conf["enabled"]:
        conf["next_run"] = _iso(_now() + timedelta(seconds=_interval_seconds(conf)))
    else:
        conf["next_run"] = None
    _save_conf(conf)
    return conf


def get_result() -> dict:
    raw = db.kv_get(_KEY_RESULT)
    return json.loads(raw) if raw else {"ts": None, "checked": 0, "broken": []}


def is_running() -> bool:
    return db.kv_get(_KEY_RUNNING) == "1"


# ── Scénario : vérification d'intégrité ───────────────────────────────────────

def run_verification() -> dict:
    """Vrai test d'intégrité : télécharge la FIN de chaque EPUB et vérifie la présence du
    marqueur de fin de ZIP (EOCD). Absent → EPUB tronqué/cassé (détecte aussi les
    troncatures à la CRÉATION, que la comparaison de tailles ne voyait pas)."""
    if is_running():
        return {"skipped": "déjà en cours"}
    db.kv_set(_KEY_RUNNING, "1")
    try:
        conn = db._connect()
        try:
            files = [dict(r) for r in conn.execute(
                "SELECT manga_id, chapter_number, kind, size, msg_id FROM telegram_files"
            ).fetchall()]
        finally:
            conn.close()

        broken = []
        valid = {}
        try:
            from .telegram_client import get_client
            valid = get_client().check_integrity([f["msg_id"] for f in files]) or {}
        except Exception as e:
            print(f"[scenario] check_integrity: {e}", flush=True)

        mangas = {m["id"]: m for m in library.list_mangas()}
        for f in files:
            v = valid.get(int(f["msg_id"])) if f.get("msg_id") is not None else False
            if v is False:   # explicitement cassé (None = inconnu → on ne flag pas)
                m = mangas.get(f["manga_id"]) or {}
                broken.append({
                    "manga_id": f["manga_id"],
                    "manga_name": m.get("name", f["manga_id"]),
                    "chapter_number": f["chapter_number"],
                    "kind": f.get("kind"),
                    "source": (m.get("meta", {}) or {}).get("source", "?"),
                    "db_size": f.get("size"),
                })

        # groupé par source (pour réparer correctement)
        by_source: dict[str, int] = {}
        for b in broken:
            by_source[b["source"]] = by_source.get(b["source"], 0) + 1

        result = {
            "ts": _iso(_now()),
            "checked": len(files),
            "broken": broken,
            "by_source": by_source,
        }
        db.kv_set(_KEY_RESULT, json.dumps(result))

        conf = get_conf()
        conf["last_run"] = result["ts"]
        if conf.get("enabled"):
            conf["next_run"] = _iso(_now() + timedelta(seconds=_interval_seconds(conf)))
        _save_conf(conf)
        return result
    finally:
        db.kv_set(_KEY_RUNNING, "0")


def run_now() -> None:
    """Lance la vérification tout de suite, en arrière-plan (ne bloque pas la requête)."""
    threading.Thread(target=run_verification, daemon=True).start()


# ── Scheduler ─────────────────────────────────────────────────────────────────

def _scheduler_loop() -> None:
    while True:
        try:
            conf = get_conf()
            if conf.get("enabled") and conf.get("next_run"):
                try:
                    nxt = datetime.fromisoformat(conf["next_run"])
                except Exception:
                    nxt = None
                if nxt and _now() >= nxt and not is_running():
                    print("[scenario] déclenchement vérification (programmée)", flush=True)
                    run_verification()
        except Exception as e:
            print(f"[scenario] scheduler: {e}", flush=True)
        time.sleep(60)   # vérifie chaque minute (léger)


def start_scheduler() -> None:
    global _scheduler_started
    with _lock:
        if _scheduler_started:
            return
        _scheduler_started = True
    threading.Thread(target=_scheduler_loop, daemon=True).start()
    print("[scenario] scheduler démarré", flush=True)
