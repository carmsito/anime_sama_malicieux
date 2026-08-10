import os

import requests
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from ..auth import get_current_user, require_scraper
from ..services import music

router = APIRouter(tags=["music"])

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
# Même proxy que yt-dlp : l'URL googlevideo est verrouillée sur l'IP qui a résolu (le proxy)
# → on doit relayer le flux par le même egress, sinon 403.
_PROXY = os.environ.get("YTDLP_PROXY", "").strip()
_PROXIES = {"http": _PROXY, "https": _PROXY} if _PROXY else None


@router.get("/mangas/{manga_id}/music", summary="Playlist musique d'un manga")
def list_music(manga_id: str, _: dict = Depends(get_current_user)):
    return {"tracks": music.list_tracks(manga_id)}


@router.post("/mangas/{manga_id}/music", summary="Ajouter une piste YouTube — scrapper/admin")
def add_music(manga_id: str, body: dict, _: dict = Depends(require_scraper)):
    url = (body.get("url") or "").strip()
    if not url:
        raise HTTPException(422, "URL manquante")
    return music.add_track(manga_id, url)


@router.delete("/mangas/{manga_id}/music/{track_id}", summary="Retirer une piste — scrapper/admin")
def del_music(manga_id: str, track_id: str, _: dict = Depends(require_scraper)):
    music.delete_track(manga_id, track_id)
    return {"ok": True}


@router.get("/mangas/{manga_id}/music/{track_id}/stream",
            summary="Stream LIVE de l'audio (proxy, rien stocké)")
def stream_music(manga_id: str, track_id: str, request: Request):
    # Public (comme les images) : un <audio src> ne peut pas envoyer de header Authorization.
    audio_url = music.resolve_audio(manga_id, track_id)
    if not audio_url:
        raise HTTPException(404, "Piste introuvable ou indisponible")

    fwd = {"User-Agent": _UA}
    rng = request.headers.get("range")
    if rng:
        fwd["Range"] = rng   # seek : on relaie la plage au CDN Google

    try:
        upstream = requests.get(audio_url, headers=fwd, stream=True, timeout=30, proxies=_PROXIES)
    except Exception:
        raise HTTPException(502, "Flux audio injoignable")

    headers = {"Accept-Ranges": "bytes"}
    for h in ("Content-Range", "Content-Length"):
        if h in upstream.headers:
            headers[h] = upstream.headers[h]
    media_type = upstream.headers.get("Content-Type", "audio/mp4")

    def gen():
        try:
            for chunk in upstream.iter_content(chunk_size=64 * 1024):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    return StreamingResponse(gen(), status_code=upstream.status_code,
                             headers=headers, media_type=media_type)
