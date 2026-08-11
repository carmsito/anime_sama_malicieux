"""Sidecar d'extraction audio YouTube via un VRAI navigateur (Chromium/Playwright).

Pourquoi : yt-dlp est détecté comme bot par YouTube depuis l'IP datacenter, mais un vrai
navigateur passe (cf. FlareSolverr). Ici on ouvre la vidéo en embed, on laisse le lecteur
démarrer (autoplay muet) et on CAPTURE l'URL du flux audio (`videoplayback ... mime=audio`)
que le navigateur récupère lui-même. Cette URL est verrouillée sur l'IP de sortie du
serveur → l'app peut la relayer. Rien n'est téléchargé.
"""
import re
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from playwright.async_api import async_playwright

_pw = None
_browser = None
_lock = asyncio.Lock()

_ID_RE = re.compile(r"(?:v=|vi?=|youtu\.be/|/embed/|/shorts/|/v/)([A-Za-z0-9_-]{11})")
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
_STEALTH = "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"


@asynccontextmanager
async def lifespan(app):
    global _pw, _browser
    _pw = await async_playwright().start()
    _browser = await _pw.chromium.launch(headless=True, args=[
        "--no-sandbox", "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--autoplay-policy=no-user-gesture-required",
        "--mute-audio",
    ])
    yield
    try:
        await _browser.close()
        await _pw.stop()
    except Exception:
        pass


app = FastAPI(lifespan=lifespan)


def _vid(raw: str) -> str | None:
    raw = (raw or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", raw):
        return raw
    m = _ID_RE.search(raw)
    return m.group(1) if m else None


@app.get("/health")
async def health():
    return {"ok": _browser is not None}


@app.get("/extract")
async def extract(id: str):
    vid = _vid(id)
    if not vid:
        raise HTTPException(400, "identifiant vidéo invalide")

    async with _lock:  # 1 extraction à la fois (serveur modeste)
        ctx = await _browser.new_context(user_agent=_UA, viewport={"width": 1280, "height": 720},
                                         locale="fr-FR")
        await ctx.add_init_script(_STEALTH)
        page = await ctx.new_page()
        found: dict[str, str] = {}

        def on_request(req):
            u = req.url
            if "videoplayback" in u and ("mime=audio" in u or "mime%3Daudio" in u) and "url" not in found:
                found["url"] = u

        page.on("request", on_request)
        try:
            await page.goto(f"https://www.youtube.com/embed/{vid}?autoplay=1&mute=1",
                            wait_until="commit", timeout=30000)
            # le lecteur démarre seul (autoplay muet) ; sinon on clique une fois
            for i in range(60):
                if found.get("url"):
                    break
                if i == 6 and not found.get("url"):
                    try:
                        await page.mouse.click(640, 360)
                    except Exception:
                        pass
                await page.wait_for_timeout(500)
        finally:
            try:
                await ctx.close()
            except Exception:
                pass

        if not found.get("url"):
            raise HTTPException(504, "flux audio non capturé")
        return {"url": found["url"], "id": vid}
