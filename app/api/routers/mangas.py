from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response

from ..services import library, epub_reader
from ..config import COVERS_DIR
from ..models.schemas import Manga, Chapter

router = APIRouter(prefix="/mangas", tags=["mangas"])


def _work_url(meta: dict) -> str | None:
    return meta.get("work_url") or meta.get("manga_url") or meta.get("manga_id")


def _prefer_local_cover(manga_id: str, info: dict | None) -> dict:
    payload = dict(info or {})
    current = library.get_manga(manga_id)
    local_cover = current.get("cover_url") if current else None
    if local_cover:
        payload["cover_url"] = local_cover
    return payload


@router.get("", response_model=list[Manga], summary="Lister tous les mangas")
def list_mangas():
    return [
        Manga(
            id=m["id"], name=m["name"], category=m["category"],
            source=m.get("meta", {}).get("source", "anime-sama"),
            cover_url=m["cover_url"], chapter_count=m["chapter_count"],
            kind=m.get("meta", {}).get("kind"),
            work_url=_work_url(m.get("meta", {})),
        )
        for m in library.list_mangas()
    ]


@router.get("/{manga_id}", response_model=Manga, summary="Détail manga + chapitres")
def get_manga(manga_id: str):
    m = library.get_manga(manga_id)
    if not m:
        raise HTTPException(404, "Manga introuvable")
    return Manga(
        id=m["id"], name=m["name"], category=m["category"],
        source=m.get("meta", {}).get("source", "anime-sama"),
        cover_url=m["cover_url"], chapter_count=m["chapter_count"],
        kind=m.get("meta", {}).get("kind"),
        chapters=[Chapter(**c) for c in m["chapters"]],
        work_url=_work_url(m.get("meta", {})),
    )


@router.get("/{manga_id}/variants", summary="Récupérer toutes les catégories/sources d'un manga")
def get_manga_variants(manga_id: str):
    """Retourne toutes les variantes du même manga (Scans, Volume, etc.)"""
    m = library.get_manga(manga_id)
    if not m:
        raise HTTPException(404, "Manga introuvable")

    # Récupère toutes les variantes avec le même nom
    all_mangas = library.list_mangas()
    variants = [
        {
            "id": variant["id"],
            "category": variant["category"],
            "chapter_count": variant["chapter_count"],
        }
        for variant in all_mangas
        if variant["name"] == m["name"]
    ]

    return {"name": m["name"], "variants": sorted(variants, key=lambda v: v["category"])}


@router.get("/{manga_id}/chapters/{chapter_number}/epub", summary="Télécharger l'EPUB")
def get_epub(manga_id: str, chapter_number: float):
    path = library.get_epub_path(manga_id, chapter_number)
    if not path:
        raise HTTPException(404, "Chapitre introuvable")
    return FileResponse(str(path), media_type="application/epub+zip",
                        filename=path.name, headers={"Content-Disposition": "inline"})


@router.get("/{manga_id}/chapters/{chapter_number}/images", summary="Liste des images d'un chapitre")
def list_chapter_images(manga_id: str, chapter_number: float):
    path = library.get_epub_path(manga_id, chapter_number)
    if not path:
        raise HTTPException(404, "Chapitre introuvable")
    count = epub_reader.get_image_count(path)
    return {
        "count": count,
        "urls": [f"/api/mangas/{manga_id}/chapters/{chapter_number}/images/{i}" for i in range(count)],
    }


@router.get("/{manga_id}/chapters/{chapter_number}/images/{idx}", summary="Image d'un chapitre")
def get_chapter_image(manga_id: str, chapter_number: float, idx: int):
    path = library.get_epub_path(manga_id, chapter_number)
    if not path:
        raise HTTPException(404)
    data, media_type = epub_reader.get_image_data(path, idx)
    if data is None:
        raise HTTPException(404, "Image introuvable")
    return Response(content=data, media_type=media_type,
                    headers={"Cache-Control": "public, max-age=86400"})


@router.get("/{manga_id}/chapters/{chapter_number}/cover", summary="Cover du chapitre (1ère image)")
def get_chapter_cover(manga_id: str, chapter_number: float):
    path = library.get_epub_path(manga_id, chapter_number)
    if not path:
        raise HTTPException(404)
    data, media_type = epub_reader.get_image_data(path, 0)
    if data is None:
        raise HTTPException(404)
    return Response(content=data, media_type=media_type,
                    headers={"Cache-Control": "public, max-age=86400"})


def _refresh_info_sync(manga_id: str) -> dict:
    m = library.get_manga(manga_id)
    if not m:
        raise HTTPException(404, "Manga introuvable")

    meta = m.get("meta", {})
    source = meta.get("source", "anime-sama")

    if source == "mangadex":
        from ..services import mangadex_svc

        manga_id_param = meta.get("manga_id")
        if not manga_id_param:
            raise HTTPException(400, "Pas de manga_id MangaDex")

        detail = mangadex_svc._fetch_manga_detail(manga_id_param)
        info = mangadex_svc._extract_info_from_detail(manga_id_param, detail)
        library.save_manga_info(manga_id, info)
        return _prefer_local_cover(manga_id, info)

    if source == "sushiscan":
        from ..services import sushiscan_svc

        manga_url = meta.get("manga_url")
        if not manga_url:
            raise HTTPException(400, "Pas d'URL Sushiscan")
        try:
            info = sushiscan_svc.get_meta(manga_url, manga_id=manga_id)
            library.save_manga_info(manga_id, info)
            return _prefer_local_cover(manga_id, info)
        finally:
            sushiscan_svc.close_driver()

    from ..services import scraper as sc

    work_url = meta.get("work_url")
    if not work_url:
        raise HTTPException(400, "Pas d'URL anime-sama trouvée")
    info = sc.fetch_work_info(work_url, meta.get("verify_ssl", True))
    if info:
        library.save_manga_info(manga_id, info)
    return _prefer_local_cover(manga_id, info)


@router.post("/{manga_id}/info-refresh", summary="Rafraîchir les infos")
def post_refresh_info(manga_id: str):
    return _refresh_info_sync(manga_id)


@router.get("/{manga_id}/info", summary="Métadonnées (synopsis, genres, année…) — avec cache local")
def get_manga_info(manga_id: str, force: bool = False):
    from ..services import scraper as sc
    m = library.get_manga(manga_id)
    if not m:
        raise HTTPException(404, "Manga introuvable")
    meta = m.get("meta", {})
    source = meta.get("source", "anime-sama")

    # --- Force refresh: depends on source ---
    if force:
        return _refresh_info_sync(manga_id)

    # --- Cache hit ---
    INFO_KEYS = ["synopsis", "genres", "year", "status", "creator", "cover_url"]
    cached = {k: meta[k] for k in INFO_KEYS if k in meta}
    if cached:
        return _prefer_local_cover(manga_id, cached)

    # --- Cache miss: fetch based on source ---
    if source == "mangadex":
        from ..services import mangadex_svc
        try:
            manga_id_param = meta.get("manga_id")
            if not manga_id_param:
                return {}
            print(f"[INFO] Cache miss: fetching MangaDex {manga_id_param}", flush=True)
            detail = mangadex_svc._fetch_manga_detail(manga_id_param)
            info = mangadex_svc._extract_info_from_detail(manga_id_param, detail)
            library.save_manga_info(manga_id, info)
            return _prefer_local_cover(manga_id, info)
        except Exception as e:
            print(f"[ERROR] MangaDex cache miss fetch failed: {e}", flush=True)
            return {}

    elif source == "sushiscan":
        from ..services import sushiscan_svc
        try:
            manga_url = meta.get("manga_url")
            if not manga_url:
                return {}
            print(f"[INFO] Cache miss: fetching Sushiscan {manga_url}", flush=True)
            info = sushiscan_svc.get_meta(manga_url, manga_id=manga_id)
            print(f"[INFO] Cache miss: got {list(info.keys())}", flush=True)
            library.save_manga_info(manga_id, info)
            return _prefer_local_cover(manga_id, info)
        except Exception as e:
            print(f"[ERROR] Sushiscan cache miss fetch failed: {e}", flush=True)
            return {}

    else:  # anime-sama
        work_url = meta.get("work_url")
        if not work_url:
            return {}
        info = sc.fetch_work_info(work_url, meta.get("verify_ssl", True))
        if info:
            library.save_manga_info(manga_id, info)
        return _prefer_local_cover(manga_id, info)


@router.post("/{manga_id}/chapters/download", summary="Télécharger plusieurs chapitres en ZIP")
def download_chapters(manga_id: str, body: dict):
    import zipfile
    import io
    from pathlib import Path

    m = library.get_manga(manga_id)
    if not m:
        raise HTTPException(404, "Manga introuvable")

    chapter_numbers = body.get("chapter_numbers", [])
    if not chapter_numbers:
        raise HTTPException(400, "Aucun chapitre sélectionné")

    # Create ZIP in memory
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
        for ch_num in chapter_numbers:
            epub_path = library.get_epub_path(manga_id, ch_num)
            if not epub_path or not epub_path.exists():
                continue
            zf.write(str(epub_path), arcname=epub_path.name)

    zip_buffer.seek(0)
    return Response(
        content=zip_buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{m["name"]}_chapitres.zip"'}
    )


@router.get("/{manga_id}/cover", summary="Cover du manga")
def get_cover(manga_id: str):
    cover = COVERS_DIR / f"{manga_id}.jpg"
    if not cover.exists():
        raise HTTPException(404)
    return FileResponse(str(cover), media_type="image/jpeg")
