from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from ..services import scraper
from ..services import mangadex_svc, sushiscan_svc
from ..models.schemas import (
    SearchResult,
    ScanCategory,
    ChapterMap,
    MangaDexLang,
    MangaDexChapters,
    SushiscanChapters,
)

router = APIRouter(prefix="/search", tags=["search"])


# ── Multi-source search ───────────────────────────────────────────────────────

@router.get("", response_model=list[SearchResult], summary="Rechercher un manga (multi-source)")
def search(q: str = Query(..., min_length=1), source: str = Query("anime-sama")):
    if source == "mangadex":
        try:
            return mangadex_svc.search(q)
        except Exception as e:
            raise HTTPException(503, f"MangaDex inaccessible : {e}")
    elif source == "sushiscan":
        try:
            return sushiscan_svc.search(q)
        except Exception as e:
            raise HTTPException(503, f"Sushiscan inaccessible : {e}")
    else:
        # Anime-Sama (default / backward-compat)
        try:
            results = scraper.search_with_images(q)
            return [SearchResult(**r) for r in results]
        except Exception as e:
            raise HTTPException(503, f"Anime-Sama inaccessible : {e}")


# ── Anime-Sama endpoints (unchanged, kept for backward compat) ────────────────

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


# ── MangaDex endpoints ────────────────────────────────────────────────────────

@router.get("/mangadex/languages", response_model=list[MangaDexLang], summary="Langues disponibles MangaDex")
def get_mangadex_languages(manga_id: str = Query(...)):
    try:
        langs = mangadex_svc.get_languages(manga_id)
        return [MangaDexLang(**l) for l in langs]
    except Exception as e:
        raise HTTPException(503, f"MangaDex inaccessible : {e}")


@router.get("/mangadex/chapters", response_model=MangaDexChapters, summary="Plage de chapitres MangaDex")
def get_mangadex_chapters(manga_id: str = Query(...), lang: str = Query(...)):
    try:
        result = mangadex_svc.get_chapter_range(manga_id, lang)
    except Exception as e:
        raise HTTPException(503, f"MangaDex inaccessible : {e}")
    if not result:
        raise HTTPException(404, "Aucun chapitre disponible")
    return MangaDexChapters(**result)


# ── Sushiscan endpoints ───────────────────────────────────────────────────────

@router.get("/sushiscan/chapters", response_model=SushiscanChapters, summary="Plage de chapitres Sushiscan")
def get_sushiscan_chapters(url: str = Query(...)):
    try:
        result = sushiscan_svc.get_chapters(url)
    except Exception as e:
        raise HTTPException(503, f"Sushiscan inaccessible : {e}")
    if not result:
        raise HTTPException(404, "Aucun chapitre disponible")
    return SushiscanChapters(**result)


@router.post("/sushiscan/close", summary="Fermer l'instance Sushiscan/Chromium")
def close_sushiscan():
    try:
        sushiscan_svc.close_driver()
        return {"status": "closed"}
    except Exception as e:
        raise HTTPException(500, f"Impossible de fermer Sushiscan : {e}")


@router.get("/sushiscan/image", summary="Proxy image Sushiscan")
def proxy_sushiscan_image(url: str = Query(...)):
    try:
        data, media_type = sushiscan_svc.fetch_image(url)
    except Exception as e:
        raise HTTPException(502, f"Image Sushiscan inaccessible : {e}")
    if not data:
        raise HTTPException(404, "Image introuvable")
    return Response(content=data, media_type=media_type, headers={"Cache-Control": "public, max-age=86400"})


@router.get("/mangadex/cover", summary="Proxy cover MangaDex")
def proxy_mangadex_cover(url: str = Query(...)):
    # Sécurité : on ne proxifie QUE le CDN de covers MangaDex (pas d'open proxy).
    if not url.startswith("https://uploads.mangadex.org/covers/"):
        raise HTTPException(400, "URL non autorisée")
    from urllib.request import Request, urlopen
    try:
        req = Request(url, headers={"User-Agent": "mangadex-dl/1.0"})
        with urlopen(req, timeout=15) as r:
            data = r.read()
            media_type = r.headers.get_content_type() or "image/jpeg"
    except Exception as e:
        raise HTTPException(502, f"Cover MangaDex inaccessible : {e}")
    return Response(content=data, media_type=media_type, headers={"Cache-Control": "public, max-age=86400"})
