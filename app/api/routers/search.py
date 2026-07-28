from fastapi import APIRouter, HTTPException, Query
from ..services import scraper
from ..models.schemas import SearchResult, ScanCategory, ChapterMap

router = APIRouter(prefix="/search", tags=["search"])


@router.get("", response_model=list[SearchResult], summary="Rechercher un manga sur Anime-Sama")
def search(q: str = Query(..., min_length=1)):
    try:
        results = scraper.search_with_images(q)
        return [SearchResult(**r) for r in results]
    except Exception as e:
        raise HTTPException(503, f"Anime-Sama inaccessible : {e}")


@router.get("/categories", response_model=list[ScanCategory], summary="Catégories scan")
def get_categories(url: str = Query(...)):
    try:
        base_url, verify_ssl = scraper.resolve_base_url()
        cats = scraper.fetch_scan_categories(base_url, verify_ssl, url)
        return [ScanCategory(label=c.label, url=c.url) for c in cats]
    except Exception as e:
        raise HTTPException(503, f"Erreur : {e}")


@router.get("/chapters", response_model=ChapterMap, summary="Carte des chapitres")
def get_chapters(url: str = Query(...)):
    try:
        base_url, verify_ssl = scraper.resolve_base_url()
        scan_title = scraper.fetch_scan_title(url, verify_ssl)
        chapter_map = scraper.fetch_chapter_map(base_url, verify_ssl, scan_title)
        return ChapterMap(
            scan_title=scan_title,
            first_chapter=min(chapter_map),
            last_chapter=max(chapter_map),
            chapters={str(k): v for k, v in chapter_map.items()},
        )
    except Exception as e:
        raise HTTPException(503, f"Erreur : {e}")
