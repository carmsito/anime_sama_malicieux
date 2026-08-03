from fastapi import APIRouter, Depends

from ..auth import require_admin
from ..services import scenarios

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/scenarios", summary="État des scénarios de maintenance (admin)")
def get_scenarios(_: dict = Depends(require_admin)):
    return {
        "verification": {
            "conf": scenarios.get_conf(),
            "running": scenarios.is_running(),
            "result": scenarios.get_result(),
        }
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
    scenarios.run_now()
    return {"started": True}
