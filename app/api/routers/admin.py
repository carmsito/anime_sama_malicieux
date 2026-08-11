from fastapi import APIRouter, Depends

from ..auth import require_admin
from ..services import scenarios, storage

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/scenarios", summary="État des scénarios de maintenance (admin)")
def get_scenarios(_: dict = Depends(require_admin)):
    return {
        "verification": {
            "conf": scenarios.get_conf("verification"),
            "running": scenarios.is_running("verification"),
            "result": scenarios.get_result("verification"),
        },
        "cache": {
            "conf": scenarios.get_conf("cache"),
            "running": scenarios.is_running("cache"),
            "result": scenarios.get_result("cache"),
            "stats": storage.cache_stats(),   # tailles/plafonds/disque → barre de progression
        },
    }


@router.put("/scenarios/verification", summary="Configurer la vérification (fréquence)")
def set_verification(body: dict, _: dict = Depends(require_admin)):
    conf = scenarios.set_conf(
        enabled=bool(body.get("enabled", False)),
        unit=body.get("unit", "week"),
        count=int(body.get("count", 1)),
    )
    return {"conf": conf}


@router.post("/scenarios/verification/run", summary="Lancer la vérification maintenant")
def run_verification_now(_: dict = Depends(require_admin)):
    scenarios.run_now("verification")
    return {"started": True}


@router.put("/scenarios/cache", summary="Configurer le nettoyage du cache (fréquence)")
def set_cache(body: dict, _: dict = Depends(require_admin)):
    conf = scenarios.set_conf(
        enabled=bool(body.get("enabled", False)),
        unit=body.get("unit", "week"),
        count=int(body.get("count", 1)),
        name="cache",
    )
    return {"conf": conf}


@router.post("/scenarios/cache/run", summary="Lancer le nettoyage du cache maintenant")
def run_cache_now(_: dict = Depends(require_admin)):
    scenarios.run_now("cache")
    return {"started": True}
