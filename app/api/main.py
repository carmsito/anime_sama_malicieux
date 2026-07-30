from contextlib import asynccontextmanager
from fastapi import FastAPI
import asyncio
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path

from .routers import auth, mangas, search, extract, jobs
from .services.scraper import warm_base_url
from .services import job_queue, db


@asynccontextmanager
async def lifespan(app: FastAPI):
    loop = asyncio.get_event_loop()
    db.init()          # crée les tables (mapping Telegram, kv, progression)
    from .auth import ensure_admin
    ensure_admin()     # migration rôles : garantit un admin
    loop.run_in_executor(None, warm_base_url)  # non-blocking warm-up
    job_queue.start()  # démarre le pool de workers
    yield


app = FastAPI(
    lifespan=lifespan,
    title="Anime-Sama Library",
    description="API de gestion de bibliothèque manga — scraping, extraction et lecture.",
    version="1.0.0",
)

import os as _os

# Auth par Bearer token (pas de cookies) → credentials inutiles ; wildcard valide.
# En prod tu peux restreindre via CORS_ORIGINS="https://ton-domaine".
_origins = [o.strip() for o in _os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api")
app.include_router(mangas.router, prefix="/api")
app.include_router(search.router, prefix="/api")
app.include_router(extract.router, prefix="/api")
app.include_router(jobs.router, prefix="/api")

# Healthcheck (déploiement / CI-CD) — léger, sans auth, ne touche à rien.
@app.get("/api/health", tags=["ops"])
def health():
    from .services import job_queue, storage
    return {
        "status": "ok",
        "storage": storage.get_backend().name,
        "workers": job_queue.stats().get("workers", 0),
    }

# Serve cover images directly
from .config import COVERS_DIR
from fastapi.responses import FileResponse as FR
from fastapi import HTTPException

@app.get("/api/covers/{manga_id}", tags=["mangas"])
def serve_cover(manga_id: str):
    p = COVERS_DIR / f"{manga_id}.jpg"
    if not p.exists():
        raise HTTPException(404)
    return FR(str(p), media_type="image/jpeg")

# Serve built frontend (production)
FRONT_DIST = Path(__file__).parent.parent / "front" / "dist"
if FRONT_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONT_DIST / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def serve_spa(full_path: str):
        file = FRONT_DIST / full_path
        if file.exists() and file.is_file():
            return FileResponse(str(file))
        return FileResponse(str(FRONT_DIST / "index.html"))
