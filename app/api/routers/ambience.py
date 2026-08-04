from fastapi import APIRouter, Depends, HTTPException

from ..auth import get_current_user, require_scraper
from ..models.schemas import Job
from ..services import ambience, job_queue, jobs as jobs_svc, library

router = APIRouter(tags=["ambience"])


@router.get("/mangas/{manga_id}/chapters/{chapter_number}/ambience",
            summary="Segments d'ambiance d'un chapitre (pour le lecteur)")
def get_ambience(manga_id: str, chapter_number: float, kind: str | None = None,
                 _: dict = Depends(get_current_user)):
    seg = ambience.get_segments(manga_id, chapter_number, kind)
    return seg or {"segments": None}


@router.get("/mangas/{manga_id}/ambience",
            summary="Liste des chapitres déjà analysés (ambiance)")
def list_ambience(manga_id: str, _: dict = Depends(get_current_user)):
    return {"analyzed": ambience.analyzed_chapters(manga_id)}


@router.post("/mangas/{manga_id}/ambience/analyze", response_model=list[Job],
             summary="Analyser l'ambiance de chapitres (job) — scrapper/admin")
def analyze(manga_id: str, body: dict, _: dict = Depends(require_scraper)):
    chapters = body.get("chapter_numbers") or []
    if not chapters:
        raise HTTPException(422, "Aucun chapitre sélectionné")
    m = library.get_manga(manga_id)
    if not m:
        raise HTTPException(404, "Manga introuvable")
    nums = sorted(float(c) for c in chapters)
    job = jobs_svc.create_job(manga_name=m["name"], category="ambiance",
                              start_chapter=nums[0], end_chapter=nums[-1], source="ambience")
    job_queue.enqueue(ambience.run_analysis,
                      {"job_id": job["id"], "manga_id": manga_id, "chapters": nums})
    return [job]
