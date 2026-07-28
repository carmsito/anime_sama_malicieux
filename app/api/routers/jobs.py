import asyncio
import json
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from ..services import jobs as jobs_svc
from ..models.schemas import Job

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("", response_model=list[Job], summary="Lister tous les jobs d'extraction")
def list_jobs():
    return [Job(**j) for j in jobs_svc.list_jobs()]


@router.get("/{job_id}", response_model=Job, summary="Statut d'un job")
def get_job(job_id: str):
    job = jobs_svc.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job introuvable")
    return Job(**job)


@router.get("/{job_id}/stream", summary="Flux SSE de progression du job")
async def stream_job(job_id: str):
    async def event_generator():
        while True:
            job = jobs_svc.get_job(job_id)
            if not job:
                yield f"data: {json.dumps({'error': 'not found'})}\n\n"
                break
            yield f"data: {json.dumps(job)}\n\n"
            if job["status"] in ("done", "error", "interrupted"):
                break
            await asyncio.sleep(1)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
