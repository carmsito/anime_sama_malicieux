import threading
from fastapi import APIRouter, Depends
from ..auth import get_current_user
from ..models.schemas import ExtractRequest, Job
from ..services import jobs as jobs_svc, scraper

router = APIRouter(prefix="/extract", tags=["extract"])


@router.post("", response_model=Job, summary="Lancer l'extraction de chapitres en arrière-plan")
def extract(body: ExtractRequest, user: dict = Depends(get_current_user)):
    job = jobs_svc.create_job(
        manga_name=body.manga_name,
        category=body.category_label,
        start_chapter=body.start_chapter,
        end_chapter=body.end_chapter,
    )

    thread = threading.Thread(
        target=scraper.download_chapters,
        kwargs={
            "job_id": job["id"],
            "work_url": body.work_url,
            "category_url": body.category_url,
            "manga_name": body.manga_name,
            "category_label": body.category_label,
            "scan_title": body.scan_title,
            "start_chapter": body.start_chapter,
            "end_chapter": body.end_chapter,
            "page_height": body.page_height,
            "make_epub": body.make_epub,
            "keep_images": body.keep_images,
        },
        daemon=True,
    )
    thread.start()

    return Job(**job)
