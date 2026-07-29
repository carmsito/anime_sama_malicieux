import threading
from fastapi import APIRouter, Depends, HTTPException
from ..auth import get_current_user
from ..models.schemas import ExtractRequest, Job
from ..services import jobs as jobs_svc, scraper
from ..services import mangadex_svc, sushiscan_svc

router = APIRouter(prefix="/extract", tags=["extract"])


@router.post("", response_model=Job, summary="Lancer l'extraction de chapitres en arrière-plan")
def extract(body: ExtractRequest, user: dict = Depends(get_current_user)):
    if body.source == "mangadex":
        manga_id = body.manga_id
        if not manga_id:
            raise HTTPException(422, "manga_id requis pour MangaDex")
        lang = body.lang or "en"
        start_str = body.start_chapter_str or "1"
        end_str = body.end_chapter_str or start_str

        job = jobs_svc.create_job(
            manga_name=body.manga_name,
            category=lang,
            start_chapter=0,
            end_chapter=0,
            source="mangadex",
        )
        thread = threading.Thread(
            target=mangadex_svc.download,
            kwargs={
                "job_id": job["id"],
                "manga_id": manga_id,
                "manga_name": body.manga_name,
                "lang": lang,
                "start": start_str,
                "end": end_str,
                "make_epub": body.make_epub,
                "keep_images": body.keep_images,
                "page_height": body.page_height,
            },
            daemon=True,
        )

    elif body.source == "sushiscan":
        manga_url = body.manga_url
        if not manga_url:
            raise HTTPException(422, "manga_url requis pour Sushiscan")

        job = jobs_svc.create_job(
            manga_name=body.manga_name,
            category="sushiscan",
            start_chapter=body.start_chapter,
            end_chapter=body.end_chapter,
            source="sushiscan",
        )
        thread = threading.Thread(
            target=sushiscan_svc.download,
            kwargs={
                "job_id": job["id"],
                "manga_name": body.manga_name,
                "manga_url": manga_url,
                "start": body.start_chapter,
                "end": body.end_chapter,
                "kind_filter": body.kind or None,  # 'Chapitre' ou 'Volume' — filtre les résultats
                "make_epub": body.make_epub,
                "keep_images": body.keep_images,
                "page_height": body.page_height,
                "batch_size": body.batch_size,
            },
            daemon=True,
        )

    else:
        # Anime-Sama (default / backward compat)
        if not body.category_label:
            raise HTTPException(422, "category_label requis pour Anime-Sama")

        job = jobs_svc.create_job(
            manga_name=body.manga_name,
            category=body.category_label,
            start_chapter=body.start_chapter,
            end_chapter=body.end_chapter,
            source="anime-sama",
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
                "start_chapter": int(body.start_chapter),
                "end_chapter": int(body.end_chapter),
                "page_height": body.page_height,
                "make_epub": body.make_epub,
                "keep_images": body.keep_images,
            },
            daemon=True,
        )

    thread.start()
    return Job(**job)
