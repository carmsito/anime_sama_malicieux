from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import FileResponse, Response

from ..services import library, epub_reader
from ..config import COVERS_DIR
from ..models.schemas import Manga, Chapter
from ..auth import require_admin, get_current_user as _require_user

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


# Cache du chemin EPUB résolu par (manga_id, chapitre) → évite de re-scanner TOUTE
# la bibliothèque à chaque image (le lecteur fait 1 requête par page).
_epub_path_cache: dict[tuple, "Path"] = {}


def _resolve_epub(manga_id: str, chapter_number: float):
    """
    Chemin de l'EPUB : cache → local → backend de stockage (Telegram).
    Utilisé par TOUTES les routes de lecture. Le cache rend le service des pages O(1).
    """
    key = (manga_id, float(chapter_number))
    cached = _epub_path_cache.get(key)
    if cached is not None and cached.exists():
        return cached

    path = library.get_epub_path(manga_id, chapter_number)
    if not path:
        try:
            from ..services import storage
            m = library.get_manga(manga_id)
            kind = None
            for ch in (m or {}).get("chapters", []) or []:
                if float(ch.get("number", -1)) == float(chapter_number):
                    kind = ch.get("kind")
                    break
            kind = kind or (m or {}).get("meta", {}).get("kind") or "Chapitre"
            path = storage.fetch_epub(manga_id, chapter_number, kind)
        except Exception:
            path = None

    if path:
        _epub_path_cache[key] = path
    return path


def _tg_record(manga_id: str, chapter_number: float):
    """(msg_id, size) de l'EPUB sur Telegram, ou None (stockage local / non indexé).
    Sert la lecture ZIP LIVE : lire les pages directement depuis Telegram, sans
    rapatrier l'EPUB entier sur le disque."""
    try:
        from ..services import db
        m = library.get_manga(manga_id)
        kind = None
        for ch in (m or {}).get("chapters", []) or []:
            if float(ch.get("number", -1)) == float(chapter_number):
                kind = ch.get("kind")
                break
        kind = kind or (m or {}).get("meta", {}).get("kind") or "Chapitre"
        rec = db.get_file(manga_id, chapter_number, kind)
        if rec and rec.get("msg_id") and rec.get("size"):
            return int(rec["msg_id"]), int(rec["size"])
    except Exception:
        pass
    return None


@router.get("/{manga_id}/chapters/{chapter_number}/epub", summary="Télécharger l'EPUB")
def get_epub(manga_id: str, chapter_number: float):
    path = _resolve_epub(manga_id, chapter_number)
    if not path:
        raise HTTPException(404, "Chapitre introuvable")
    return FileResponse(str(path), media_type="application/epub+zip",
                        filename=path.name, headers={"Content-Disposition": "inline"})


@router.delete("/{manga_id}/chapters/{chapter_number}", summary="Supprimer un chapitre (local + Telegram + DB)")
def delete_chapter(manga_id: str, chapter_number: float, user: dict = Depends(require_admin)):
    from ..config import EXTRACTION_DIR
    from ..services import storage
    m = library.get_manga(manga_id)
    if not m:
        raise HTTPException(404, "Manga introuvable")

    # kind du chapitre (Chapitre/Volume/Tome)
    kind = None
    for ch in m.get("chapters", []) or []:
        if float(ch.get("number", -1)) == float(chapter_number):
            kind = ch.get("kind")
            break
    kind = kind or m.get("meta", {}).get("kind") or "Chapitre"

    # 1) Telegram + DB + cache
    try:
        storage.delete_epub(manga_id, chapter_number, kind)
    except Exception as e:
        print(f"[delete] storage: {e}", flush=True)

    # 2) fichier local (essaie plusieurs noms : "Chapitre 5", "Volume 5.0"…)
    cat_dir = EXTRACTION_DIR / m["name"] / m["category"]
    removed = False
    for prefix in ("Chapitre", "Volume", "Tome"):
        for num in (str(chapter_number), str(int(chapter_number)) if float(chapter_number).is_integer() else None):
            if not num:
                continue
            for d in (cat_dir, cat_dir.parent):
                f = d / f"{prefix} {num}.epub"
                if f.exists():
                    f.unlink()
                    removed = True

    # invalide le cache de résolution
    _epub_path_cache.pop((manga_id, float(chapter_number)), None)
    return {"deleted": True, "local_removed": removed, "manga_id": manga_id, "chapter": chapter_number}


@router.delete("/{manga_id}", summary="Supprimer un manga entier (tous chapitres + Telegram + DB + fichiers)")
def delete_manga(manga_id: str, user: dict = Depends(require_admin)):
    import shutil
    from ..config import EXTRACTION_DIR
    from ..services import storage, db
    m = library.get_manga(manga_id)
    if not m:
        raise HTTPException(404, "Manga introuvable")

    # 1) Supprime chaque chapitre offloadé sur Telegram + entrées DB
    for rec in db.list_files(manga_id):
        try:
            storage.delete_epub(manga_id, rec["chapter_number"], rec.get("kind") or "Chapitre")
        except Exception as e:
            print(f"[delete_manga] {rec.get('chapter_number')}: {e}", flush=True)

    # 2) Supprime le dossier de la catégorie (et le dossier manga s'il devient vide)
    cat_dir = EXTRACTION_DIR / m["name"] / m["category"]
    shutil.rmtree(cat_dir, ignore_errors=True)
    manga_dir = EXTRACTION_DIR / m["name"]
    try:
        if manga_dir.exists() and not any(manga_dir.iterdir()):
            manga_dir.rmdir()
    except Exception:
        pass

    # 3) Cover locale + cache de résolution
    (COVERS_DIR / f"{manga_id}.jpg").unlink(missing_ok=True)
    for key in [k for k in _epub_path_cache if k[0] == manga_id]:
        _epub_path_cache.pop(key, None)

    return {"deleted": True, "manga_id": manga_id, "name": m["name"]}


@router.get("/{manga_id}/chapters/{chapter_number}/images", summary="Liste des images d'un chapitre")
def list_chapter_images(manga_id: str, chapter_number: float):
    # LIVE : on lit le nombre de pages directement depuis Telegram (table ZIP), sans
    # télécharger l'EPUB. Repli sur le download complet en cas de souci → aucune régression.
    rec = _tg_record(manga_id, chapter_number)
    if rec:
        try:
            from ..services import epub_remote
            count = epub_remote.image_count(rec[0], rec[1])
            if count > 0:
                return {"count": count,
                        "urls": [f"/api/mangas/{manga_id}/chapters/{chapter_number}/images/{i}" for i in range(count)]}
        except Exception as e:
            print(f"[epub_remote] list fallback {manga_id} ch{chapter_number}: {e}", flush=True)
    path = _resolve_epub(manga_id, chapter_number)
    if not path:
        raise HTTPException(404, "Chapitre introuvable")
    count = epub_reader.get_image_count(path)
    return {
        "count": count,
        "urls": [f"/api/mangas/{manga_id}/chapters/{chapter_number}/images/{i}" for i in range(count)],
    }


def chapter_image_bytes(manga_id: str, chapter_number: float, idx: int):
    """Octets d'UNE page (Telegram live, repli EPUB local). Réutilisé par la route image ET
    le découpage serveur (le serveur lit l'image lui-même → pas de réupload par le client)."""
    rec = _tg_record(manga_id, chapter_number)
    if rec:
        try:
            from ..services import epub_remote
            data, media_type = epub_remote.image_data(rec[0], rec[1], idx)
            if data is not None:
                return data, media_type
        except Exception as e:
            print(f"[epub_remote] image fallback {manga_id} ch{chapter_number} #{idx}: {e}", flush=True)
    path = _resolve_epub(manga_id, chapter_number)
    if not path:
        return None, None
    return epub_reader.get_image_data(path, idx)


@router.get("/{manga_id}/chapters/{chapter_number}/images/{idx}", summary="Image d'un chapitre")
def get_chapter_image(manga_id: str, chapter_number: float, idx: int):
    data, media_type = chapter_image_bytes(manga_id, chapter_number, idx)
    if data is None:
        raise HTTPException(404, "Image introuvable")
    return Response(content=data, media_type=media_type,
                    headers={"Cache-Control": "public, max-age=86400"})


def _chapter_cover_path(manga_id: str, chapter_number: float):
    import re
    ccache = COVERS_DIR / "ch"
    ccache.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", f"{manga_id}__{chapter_number}")
    return ccache / f"{safe}.jpg"


@router.get("/{manga_id}/chapters/{chapter_number}/cover", summary="Cover du chapitre (1ère image)")
def get_chapter_cover(manga_id: str, chapter_number: float):
    # Cache dédié (JPEG) → on ne télécharge PLUS l'EPUB entier depuis Telegram à chaque
    # affichage de la grille (gros gain perf pour les œuvres à beaucoup de chapitres).
    cf = _chapter_cover_path(manga_id, chapter_number)
    if cf.exists() and cf.stat().st_size > 0:
        return FileResponse(str(cf), media_type="image/jpeg",
                            headers={"Cache-Control": "public, max-age=604800"})
    # LIVE : on extrait SEULEMENT la 1ère image depuis Telegram (~qq centaines de Ko),
    # au lieu de rapatrier l'EPUB entier (150 Mo !) pour chaque vignette de la grille.
    rec = _tg_record(manga_id, chapter_number)
    if rec:
        try:
            from ..services import epub_remote
            data, media_type = epub_remote.image_data(rec[0], rec[1], 0)
            if data is not None:
                try:
                    cf.write_bytes(data)   # cache le thumbnail → instantané ensuite
                except Exception:
                    pass
                return Response(content=data, media_type=media_type,
                                headers={"Cache-Control": "public, max-age=604800"})
        except Exception as e:
            print(f"[epub_remote] cover fallback {manga_id} ch{chapter_number}: {e}", flush=True)
    path = _resolve_epub(manga_id, chapter_number)
    if not path:
        raise HTTPException(404)
    data, media_type = epub_reader.get_image_data(path, 0)
    if data is None:
        raise HTTPException(404)
    try:
        cf.write_bytes(data)   # met en cache pour les prochaines fois
    except Exception:
        pass
    return Response(content=data, media_type=media_type,
                    headers={"Cache-Control": "public, max-age=604800"})


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


# ── Progression de lecture (marque-page, par utilisateur) ─────────────────────

def _manga_percent(progress_rows: list[dict], total_chapters: int) -> int:
    """
    % de complétion d'un manga = somme des progressions fractionnaires / total chapitres.
    Un chapitre lu à 5 % compte pour 0,05 chapitre (et non 0), pour être cohérent avec
    'Reprendre la lecture'. Borné 0-100.
    """
    if not total_chapters or total_chapters < 0:
        return 0
    frac = 0.0
    for r in progress_rows:
        tp = r.get("total_pages") or 0
        pg = r.get("page", 0)
        if tp > 0 and pg >= 0:
            frac += min(1.0, (pg + 1) / tp)
    return max(0, min(100, round(frac / total_chapters * 100)))


def _resume_target(manga: dict, last: dict) -> tuple[float, int]:
    """
    Cible de reprise pour un manga d'après le dernier chapitre lu `last`.
    Si ce chapitre est terminé (dernière page), on passe au chapitre SUIVANT (page 0).
    Sinon on reprend le chapitre en cours à la page enregistrée.
    """
    cur = float(last["chapter_number"])
    finished = last.get("total_pages") and (last["page"] + 1) >= last["total_pages"]
    if finished:
        nums = sorted(float(c["number"]) for c in manga.get("chapters", []) or [])
        nexts = [n for n in nums if n > cur]
        if nexts:
            return nexts[0], 0
    return cur, int(last["page"])


@router.get("/continue/reading", summary="Reprendre la lecture (derniers chapitres lus)")
def continue_reading(response: Response, user: dict = Depends(_require_user)):
    from ..services import db
    response.headers["Cache-Control"] = "no-store"
    # progressions groupées par manga → % global (pour filtrer/afficher)
    prog_by_manga: dict[str, list[dict]] = {}
    for r in db.get_progress_all(user["id"]):
        prog_by_manga.setdefault(r["manga_id"], []).append(r)

    out = []
    for p in db.get_continue(user["id"]):
        m = library.get_manga(p["manga_id"])  # avec chapitres (pour la reprise)
        if not m:
            continue  # manga supprimé
        pct = _manga_percent(prog_by_manga.get(p["manga_id"], []), m.get("chapter_count", 0))
        if pct <= 0:
            continue  # ouvert par erreur / rien lu de significatif → pas dans "Reprendre"
        target_ch, target_page = _resume_target(m, p)
        out.append({
            "id": m["id"], "name": m["name"], "category": m["category"],
            "cover_url": m["cover_url"], "source": m.get("meta", {}).get("source", "anime-sama"),
            "chapter_number": target_ch, "page": target_page, "percent": pct,
            "updated_at": p["updated_at"],
        })
    return {"items": out}


@router.get("/favorites/list", summary="Mes favoris (œuvres non terminées en priorité)")
def list_favorites(user: dict = Depends(_require_user)):
    from ..services import db
    fav_ids = set(db.list_favorites(user["id"]))
    if not fav_ids:
        return {"items": []}
    # progressions groupées par manga
    prog_by_manga: dict[str, list[dict]] = {}
    for r in db.get_progress_all(user["id"]):
        prog_by_manga.setdefault(r["manga_id"], []).append(r)

    out = []
    for m in library.list_mangas():
        if m["id"] not in fav_ids:
            continue
        pct = _manga_percent(prog_by_manga.get(m["id"], []), m.get("chapter_count", 0))
        out.append({
            "id": m["id"], "name": m["name"], "category": m["category"],
            "cover_url": m["cover_url"], "source": m.get("meta", {}).get("source", "anime-sama"),
            "percent": pct,
        })
    # non terminés (pct < 100) d'abord, puis par nom
    out.sort(key=lambda x: (x["percent"] >= 100, x["name"].lower()))
    return {"items": out}


@router.get("/states/all", summary="États utilisateur par manga (favori + % lu)")
def user_states(response: Response, user: dict = Depends(_require_user)):
    from ..services import db
    response.headers["Cache-Control"] = "no-store"
    favs = set(db.list_favorites(user["id"]))
    prog_by_manga: dict[str, list[dict]] = {}
    for r in db.get_progress_all(user["id"]):
        prog_by_manga.setdefault(r["manga_id"], []).append(r)
    progress = {}
    for m in library.list_mangas():
        rows = prog_by_manga.get(m["id"])
        if rows:
            progress[m["id"]] = _manga_percent(rows, m.get("chapter_count", 0))
    statuses = db.get_manga_statuses(user["id"])
    return {"favorites": list(favs), "progress": progress, "statuses": statuses}


@router.put("/{manga_id}/favorite", summary="Ajouter/retirer un manga des favoris")
def toggle_favorite(manga_id: str, body: dict, user: dict = Depends(_require_user)):
    from ..services import db
    on = bool(body.get("favorite", True))
    db.set_favorite(user["id"], manga_id, on)
    return {"manga_id": manga_id, "favorite": on}


@router.put("/{manga_id}/status", summary="Statut de lecture (reading|completed|on_hold|plan, vide = aucun)")
def set_status(manga_id: str, body: dict, user: dict = Depends(_require_user)):
    from ..services import db
    status = (body.get("status") or "").strip()
    db.set_manga_status(user["id"], manga_id, status)
    return {"manga_id": manga_id, "status": status if status in db._STATUSES else ""}


@router.get("/stats/overview", summary="Statistiques de lecture de l'utilisateur")
def stats_overview(response: Response, user: dict = Depends(_require_user)):
    from ..services import db
    from collections import defaultdict
    response.headers["Cache-Control"] = "no-store"   # toujours frais (sync cross-device)

    mangas = {m["id"]: m for m in library.list_mangas()}
    by_manga: dict[str, list[dict]] = defaultdict(list)
    for r in db.get_progress_all(user["id"]):
        by_manga[r["manga_id"]].append(r)

    works, total_completed, total_pages = [], 0, 0
    by_source: dict[str, int] = defaultdict(int)
    for mid, rs in by_manga.items():
        m = mangas.get(mid)
        if not m:
            continue
        pct = _manga_percent(rs, m.get("chapter_count", 0))
        completed = sum(1 for r in rs if r.get("total_pages") and r.get("page", -1) >= 0 and (r["page"] + 1) >= r["total_pages"])
        pages = sum(min(r["page"] + 1, r["total_pages"]) for r in rs if r.get("total_pages") and r.get("page", -1) >= 0)
        total_completed += completed
        total_pages += pages
        src = m.get("meta", {}).get("source", "anime-sama")
        by_source[src] += 1
        works.append({
            "id": mid, "name": m["name"], "category": m["category"], "cover_url": m["cover_url"],
            "source": src, "percent": pct, "chapters_read": len(rs), "completed_chapters": completed,
            "chapter_count": m.get("chapter_count", 0),
            "updated_at": max((r.get("updated_at") or "" for r in rs), default=""),
        })

    started = len(works)
    completed_works = sum(1 for w in works if w["percent"] >= 100)
    recent = sorted(works, key=lambda w: w["updated_at"], reverse=True)
    top = sorted(works, key=lambda w: (w["completed_chapters"], w["percent"]), reverse=True)[:6]

    # ── Activité temporelle (dérivée des updated_at) : heatmap, streak, jour/heure ──
    from datetime import datetime, timezone, date as _date, timedelta
    day_counts: dict[str, int] = defaultdict(int)
    weekday = [0] * 7   # lundi..dimanche
    hour = [0] * 24
    for rs in by_manga.values():
        for r in rs:
            ts = r.get("updated_at") or ""
            try:
                dt = datetime.fromisoformat(ts)
            except Exception:
                continue
            day_counts[dt.date().isoformat()] += 1
            weekday[dt.weekday()] += 1
            hour[dt.hour] += 1

    today = datetime.now(timezone.utc).date()
    activity = [{"date": (today - timedelta(days=i)).isoformat(),
                 "count": day_counts.get((today - timedelta(days=i)).isoformat(), 0)}
                for i in range(370, -1, -1)]   # ~53 semaines

    active_dates = set(day_counts.keys())
    def _run_from(d: _date) -> int:
        n = 0
        while d.isoformat() in active_dates:
            n += 1; d = d - timedelta(days=1)
        return n
    current_streak = _run_from(today) or _run_from(today - timedelta(days=1))  # tolère « pas encore lu aujourd'hui »
    best_streak = 0
    if active_dates:
        ds = sorted(_date.fromisoformat(x) for x in active_dates)
        run = best_streak = 1
        for a, b in zip(ds, ds[1:]):
            run = run + 1 if (b - a).days == 1 else 1
            best_streak = max(best_streak, run)

    return {
        "activity": activity,
        "streak": {"current": current_streak, "best": best_streak},
        "by_weekday": weekday,
        "by_hour": hour,
        "totals": {
            "works_started": started,
            "works_completed": completed_works,
            "works_in_progress": started - completed_works,
            "chapters_read": total_completed,
            "pages_read": total_pages,
            "favorites": len(db.list_favorites(user["id"])),
            "library_size": len(mangas),
        },
        "by_source": dict(by_source),
        "recent": recent[:8],
        "top": top,
        "works": recent,
    }


@router.delete("/{manga_id}/progress", summary="Réinitialiser la progression d'une œuvre (→ jamais lu)")
def reset_manga_progress(manga_id: str, user: dict = Depends(_require_user)):
    from ..services import db
    n = db.reset_progress(user["id"], manga_id)
    return {"reset": True, "removed": n}


@router.get("/{manga_id}/progress", summary="Progression de lecture de l'utilisateur")
def get_progress(manga_id: str, response: Response, user: dict = Depends(_require_user)):
    from ..services import db
    response.headers["Cache-Control"] = "no-store"   # jamais mis en cache → pas de reprise à un vieux marque-page
    return {"progress": db.get_progress(user["id"], manga_id)}


@router.put("/{manga_id}/chapters/{chapter_number}/progress", summary="Enregistrer la progression")
def set_progress(manga_id: str, chapter_number: float, body: dict, user: dict = Depends(_require_user)):
    from ..services import db
    db.set_progress(user["id"], manga_id, chapter_number,
                    page=int(body.get("page", 0)), total_pages=int(body.get("total_pages", 0)))
    return {"saved": True}
