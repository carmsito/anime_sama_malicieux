from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pathlib import Path

from ..services import library, epub_reader
from ..config import COVERS_DIR
from ..models.schemas import Manga, Chapter

router = APIRouter(prefix="/mangas", tags=["mangas"])


@router.get("", response_model=list[Manga], summary="Lister tous les mangas")
def list_mangas():
    return [
        Manga(
            id=m["id"], name=m["name"], category=m["category"],
            cover_url=m["cover_url"], chapter_count=m["chapter_count"],
            work_url=m.get("meta", {}).get("work_url"),
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
        cover_url=m["cover_url"], chapter_count=m["chapter_count"],
        chapters=[Chapter(**c) for c in m["chapters"]],
        work_url=m.get("meta", {}).get("work_url"),
    )


@router.get("/{manga_id}/chapters/{chapter_number}/epub", summary="Télécharger l'EPUB")
def get_epub(manga_id: str, chapter_number: int):
    path = library.get_epub_path(manga_id, chapter_number)
    if not path:
        raise HTTPException(404, "Chapitre introuvable")
    return FileResponse(str(path), media_type="application/epub+zip",
                        filename=path.name, headers={"Content-Disposition": "inline"})


@router.get("/{manga_id}/chapters/{chapter_number}/images", summary="Liste des images d'un chapitre")
def list_chapter_images(manga_id: str, chapter_number: int):
    path = library.get_epub_path(manga_id, chapter_number)
    if not path:
        raise HTTPException(404, "Chapitre introuvable")
    count = epub_reader.get_image_count(path)
    return {
        "count": count,
        "urls": [f"/api/mangas/{manga_id}/chapters/{chapter_number}/images/{i}" for i in range(count)],
    }


@router.get("/{manga_id}/chapters/{chapter_number}/images/{idx}", summary="Image d'un chapitre")
def get_chapter_image(manga_id: str, chapter_number: int, idx: int):
    path = library.get_epub_path(manga_id, chapter_number)
    if not path:
        raise HTTPException(404)
    data, media_type = epub_reader.get_image_data(path, idx)
    if data is None:
        raise HTTPException(404, "Image introuvable")
    return Response(content=data, media_type=media_type,
                    headers={"Cache-Control": "public, max-age=86400"})


@router.get("/{manga_id}/chapters/{chapter_number}/cover", summary="Cover du chapitre (1ère image)")
def get_chapter_cover(manga_id: str, chapter_number: int):
    path = library.get_epub_path(manga_id, chapter_number)
    if not path:
        raise HTTPException(404)
    data, media_type = epub_reader.get_image_data(path, 0)
    if data is None:
        raise HTTPException(404)
    return Response(content=data, media_type=media_type,
                    headers={"Cache-Control": "public, max-age=86400"})


@router.get("/{manga_id}/info", summary="Métadonnées (synopsis, genres, année…) — avec cache local")
def get_manga_info(manga_id: str, force: bool = False):
    from ..services import scraper as sc
    m = library.get_manga(manga_id)
    if not m:
        raise HTTPException(404, "Manga introuvable")
    meta = m.get("meta", {})

    # --- Force refresh : ignore cache and scrape ---
    if force:
        work_url = meta.get("work_url")
        if not work_url:
            raise HTTPException(400, "Pas d'URL anime-sama trouvée")
        info = sc.fetch_work_info(work_url, meta.get("verify_ssl", True))
        if info:
            library.save_manga_info(manga_id, info)
        return info

    # --- Cache hit : if meta exists and has any info, serve it ---
    INFO_KEYS = ["synopsis", "genres", "year", "status", "creator", "cover_url"]
    cached = {k: meta[k] for k in INFO_KEYS if k in meta}
    if cached:  # Return anything in cache, even if incomplete
        return cached

    # --- Cache miss : scrape then persist ---
    work_url = meta.get("work_url")
    if not work_url:
        return {}
    info = sc.fetch_work_info(work_url, meta.get("verify_ssl", True))
    if info:
        library.save_manga_info(manga_id, info)
    return info


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
            # Filename: "Chapitre 5.epub"
            arcname = f"Chapitre {ch_num}.epub"
            zf.write(str(epub_path), arcname=arcname)

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
