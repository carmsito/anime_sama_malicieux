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

# Clés KV historiques (vérification) = _*_key("verification").
_KEY_CONF = "scenario_verification_conf"
_KEY_RESULT = "scenario_verification_result"
_KEY_RUNNING = "scenario_verification_running"

# secondes par unité de fréquence (fines pour le cache : 15 min → mois)
_UNIT_SECONDS = {
    "15min": 900, "30min": 1800, "1h": 3600, "6h": 21600, "12h": 43200,
    "day": 86400, "week": 604800, "month": 2592000,
}

_lock = threading.Lock()
_scheduler_started = False


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _conf_key(name: str) -> str: return f"scenario_{name}_conf"
def _result_key(name: str) -> str: return f"scenario_{name}_result"
def _running_key(name: str) -> str: return f"scenario_{name}_running"


def get_conf(name: str = "verification") -> dict:
    raw = db.kv_get(_conf_key(name))
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


def _save_conf(conf: dict, name: str = "verification") -> None:
    db.kv_set(_conf_key(name), json.dumps(conf))


def set_conf(enabled: bool, unit: str, count: int, name: str = "verification") -> dict:
    conf = get_conf(name)
    conf["enabled"] = bool(enabled)
    conf["unit"] = unit if unit in _UNIT_SECONDS else "week"
    conf["count"] = max(1, min(int(count), 100))
    if conf["enabled"]:
        conf["next_run"] = _iso(_now() + timedelta(seconds=_interval_seconds(conf)))
    else:
        conf["next_run"] = None
    _save_conf(conf, name)
    return conf


def get_result(name: str = "verification") -> dict:
    raw = db.kv_get(_result_key(name))
    if raw:
        return json.loads(raw)
    return {"ts": None, "checked": 0, "broken": []} if name == "verification" else {"ts": None}


def is_running(name: str = "verification") -> bool:
    return db.kv_get(_running_key(name)) == "1"


# ── Scénario : vérification d'intégrité ───────────────────────────────────────

def run_verification() -> dict:
    """Vrai test d'intégrité : télécharge la FIN de chaque EPUB et vérifie la présence du
    marqueur de fin de ZIP (EOCD). Absent → EPUB tronqué/cassé (détecte aussi les
    troncatures à la CRÉATION, que la comparaison de tailles ne voyait pas)."""
    if is_running():
        return {"skipped": "déjà en cours"}
    db.kv_set(_KEY_RUNNING, "1")
    from . import jobs as jobs_svc
    job = jobs_svc.create_job(manga_name="Vérification d'intégrité", category="maintenance",
                              start_chapter=0, end_chapter=0, source="maintenance")
    jid = job["id"]
    try:
        conn = db._connect()
        try:
            files = [dict(r) for r in conn.execute(
                "SELECT manga_id, chapter_number, kind, size, msg_id FROM telegram_files"
            ).fetchall()]
        finally:
            conn.close()

        jobs_svc.update_job(jid, status="running", total=len(files))
        broken = []
        valid = {}
        try:
            from .telegram_client import get_client
            valid = get_client().check_integrity(
                [f["msg_id"] for f in files],
                on_progress=lambda n: jobs_svc.update_job(jid, progress=n),
            ) or {}
        except Exception as e:
            print(f"[scenario] check_integrity: {e}", flush=True)
            jobs_svc.update_job(jid, status="error", error=str(e))

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

        n_true = sum(1 for v in valid.values() if v is True)
        n_false = sum(1 for v in valid.values() if v is False)
        n_none = sum(1 for v in valid.values() if v is None)
        print(f"[scenario] vérif : {len(files)} fichiers → {n_true} sains, "
              f"{n_false} cassés, {n_none} inconnus", flush=True)

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
        jobs_svc.update_job(jid, status="done", progress=len(files),
                            error=(f"{len(broken)} cassé(s)" if broken else None))

        conf = get_conf()
        conf["last_run"] = result["ts"]
        if conf.get("enabled"):
            conf["next_run"] = _iso(_now() + timedelta(seconds=_interval_seconds(conf)))
        _save_conf(conf)
        return result
    finally:
        db.kv_set(_KEY_RUNNING, "0")


# ── Scénario : nettoyage du cache ─────────────────────────────────────────────

def run_cache(silent: bool = False) -> dict:
    """Balaie tous les caches disque (storage.sweep_all) et enregistre résultat + stats.
    silent=True (balayage AUTOMATIQUE toutes les 15 min) : ne crée pas de job visible."""
    if is_running("cache"):
        return {"skipped": "déjà en cours"}
    db.kv_set(_running_key("cache"), "1")
    jid = None
    try:
        from . import storage
        if not silent:
            from . import jobs as jobs_svc
            job = jobs_svc.create_job(manga_name="Nettoyage du cache", category="maintenance",
                                      start_chapter=0, end_chapter=0, source="maintenance")
            jid = job["id"]
            jobs_svc.update_job(jid, status="running", total=1)
        counts = storage.sweep_all()
        result = {
            "ts": _iso(_now()),
            "epub_removed": counts.get("epub_removed", 0),
            "cover_removed": counts.get("cover_removed", 0),
            "stats": storage.cache_stats(),
        }
        db.kv_set(_result_key("cache"), json.dumps(result))
        if jid:
            from . import jobs as jobs_svc
            jobs_svc.update_job(jid, status="done", progress=1)
        # Le balayage AUTO (silent, 15 min) est DISSOCIÉ de la programmation : il ne touche
        # pas last_run/next_run (qui suivent uniquement le scénario que l'admin programme).
        if not silent:
            conf = get_conf("cache")
            conf["last_run"] = result["ts"]
            if conf.get("enabled"):
                conf["next_run"] = _iso(_now() + timedelta(seconds=_interval_seconds(conf)))
            _save_conf(conf, "cache")
        return result
    finally:
        db.kv_set(_running_key("cache"), "0")


def run_now(name: str = "verification") -> None:
    """Lance le scénario tout de suite, en arrière-plan (ne bloque pas la requête)."""
    target = (lambda: run_cache(False)) if name == "cache" else run_verification
    threading.Thread(target=target, daemon=True).start()


# ── Scheduler ─────────────────────────────────────────────────────────────────

def _scheduler_loop() -> None:
    last_auto_cache = 0.0
    while True:
        try:
            # Vérification d'intégrité (programmée)
            conf = get_conf("verification")
            if conf.get("enabled") and conf.get("next_run"):
                try:
                    nxt = datetime.fromisoformat(conf["next_run"])
                except Exception:
                    nxt = None
                if nxt and _now() >= nxt and not is_running("verification"):
                    print("[scenario] déclenchement vérification (programmée)", flush=True)
                    run_verification()
            # Nettoyage du cache (programmé)
            cconf = get_conf("cache")
            if cconf.get("enabled") and cconf.get("next_run"):
                try:
                    cnxt = datetime.fromisoformat(cconf["next_run"])
                except Exception:
                    cnxt = None
                if cnxt and _now() >= cnxt and not is_running("cache"):
                    print("[scenario] déclenchement nettoyage cache (programmé)", flush=True)
                    run_cache(False)
            # Garantie DYNAMIQUE : balayage silencieux du cache au moins toutes les 15 min
            # (indépendant de la programmation → les caches restent toujours bornés).
            if time.time() - last_auto_cache >= 900:
                last_auto_cache = time.time()
                if not is_running("cache"):
                    run_cache(silent=True)
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
