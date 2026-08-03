from fastapi import APIRouter, Depends, HTTPException
from ..auth import require_scraper
from ..models.schemas import ExtractRequest, Job
from ..services import jobs as jobs_svc, scraper
from ..services import mangadex_svc, sushiscan_svc
from ..services import job_queue, library

router = APIRouter(prefix="/extract", tags=["extract"])


@router.post("/repair", response_model=list[Job],
             summary="Re-scraper des chapitres/volumes (réparer un EPUB cassé) — scrapper/admin")
def repair(body: dict, user: dict = Depends(require_scraper)):
    """Relance l'extraction de chapitres précis, PAR SOURCE (recréé + réuploadé sur Telegram
    en écrasant l'ancien lien). Utile pour réparer les EPUB tronqués/illisibles."""
    manga_id = body.get("manga_id")
    chapters = body.get("chapter_numbers") or []
    m = library.get_manga(manga_id)
    if not m:
        raise HTTPException(404, "Manga introuvable")
    if not chapters:
        raise HTTPException(422, "Aucun chapitre sélectionné")
    meta = m.get("meta", {})
    source = meta.get("source", "anime-sama")
    name = m["name"]
    created = []

    for ch in chapters:
        chn = float(ch)
        if source == "sushiscan":
            if not meta.get("manga_url"):
                continue
            job = jobs_svc.create_job(manga_name=name, category="sushiscan",
                                      start_chapter=chn, end_chapter=chn, source="sushiscan")
            job_queue.enqueue(sushiscan_svc.download, {
                "job_id": job["id"], "manga_name": name, "manga_url": meta["manga_url"],
                "start": chn, "end": chn, "kind_filter": meta.get("kind"),
                "make_epub": True, "keep_images": False, "page_height": 1878, "batch_size": 5,
            })
        elif source == "mangadex":
            if not meta.get("manga_id"):
                continue
            lang = meta.get("lang") or m.get("category") or "en"
            chs = str(int(chn)) if chn.is_integer() else str(chn)
            job = jobs_svc.create_job(manga_name=name, category=lang,
                                      start_chapter=0, end_chapter=0, source="mangadex")
            job_queue.enqueue(mangadex_svc.download, {
                "job_id": job["id"], "manga_id": meta["manga_id"], "manga_name": name,
                "lang": lang, "start": chs, "end": chs,
                "make_epub": True, "keep_images": False, "page_height": 1878,
            })
        else:  # anime-sama
            if not meta.get("work_url"):
                continue
            job = jobs_svc.create_job(manga_name=name, category=m["category"],
                                      start_chapter=int(chn), end_chapter=int(chn), source="anime-sama")
            job_queue.enqueue(scraper.download_chapters, {
                "job_id": job["id"], "work_url": meta.get("work_url"),
                "category_url": meta.get("category_url"), "manga_name": name,
                "category_label": m["category"], "scan_title": meta.get("scan_title", name),
                "start_chapter": int(chn), "end_chapter": int(chn),
                "page_height": 1878, "make_epub": True, "keep_images": False,
            })
        created.append(job)

    if not created:
        raise HTTPException(400, "Réparation impossible : métadonnées de source manquantes")
    return [Job(**j) for j in created]


@router.post("", response_model=Job, summary="Lancer l'extraction de chapitres en arrière-plan")
def extract(body: ExtractRequest, user: dict = Depends(require_scraper)):
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
        job_queue.enqueue(
            mangadex_svc.download,
            {
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
        job_queue.enqueue(
            sushiscan_svc.download,
            {
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
        job_queue.enqueue(
            scraper.download_chapters,
            {
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
        )

    return Job(**job)
