#!/usr/bin/env python3
"""Scraper interactif pour sushiscan.net — bypass Cloudflare via DrissionPage."""
from __future__ import annotations

import argparse
import collections
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, urljoin

try:
    from DrissionPage import ChromiumPage, ChromiumOptions
    from bs4 import BeautifulSoup
except ImportError as e:
    print(f"Dépendance manquante: {e}")
    print("pip install DrissionPage beautifulsoup4")
    sys.exit(1)

BASE_URL = "https://sushiscan.net"
CHROME_BIN = "/opt/google/chrome/chrome"
DEFAULT_PAGE_HEIGHT = 1878
PAGE_WAIT = 4.0
# Rate limit: 8000 requêtes max par 10 minutes
RATE_LIMIT_COUNT = 8000
RATE_LIMIT_WINDOW = 600


# ── Dataclasses ────────────────────────────────────────────────────────────────

@dataclass
class SearchResult:
    title: str
    url: str
    image_url: str | None = None


@dataclass
class Chapter:
    number: float
    title: str
    url: str
    kind: str = "Chapitre"  # "Chapitre" ou "Volume"


# ── Rate limiter ───────────────────────────────────────────────────────────────

_request_times: collections.deque = collections.deque()


def _rate_check() -> None:
    """Pause si on dépasse 8000 requêtes en 10 minutes."""
    now = time.time()
    while _request_times and _request_times[0] < now - RATE_LIMIT_WINDOW:
        _request_times.popleft()
    if len(_request_times) >= RATE_LIMIT_COUNT:
        wait = RATE_LIMIT_WINDOW - (now - _request_times[0]) + 0.5
        print_flush(f"  [Rate limit] Pause de {wait:.0f}s (8000 req/10min atteint)...")
        time.sleep(wait)
    _request_times.append(time.time())


# ── Xvfb (écran virtuel) ───────────────────────────────────────────────────────

_xvfb_proc: subprocess.Popen | None = None
_xvfb_display: str | None = None


def _start_xvfb() -> str | None:
    """Démarre Xvfb sur un display libre. Retourne ':N' ou None si indisponible."""
    global _xvfb_proc, _xvfb_display
    if not shutil.which("Xvfb"):
        return None
    for num in range(99, 120):
        if os.path.exists(f"/tmp/.X{num}-lock"):
            continue
        try:
            proc = subprocess.Popen(
                ["Xvfb", f":{num}", "-screen", "0", "1920x1080x24"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            time.sleep(0.8)
            if proc.poll() is None:
                _xvfb_proc = proc
                _xvfb_display = f":{num}"
                return _xvfb_display
            proc.terminate()
        except Exception:
            continue
    return None


def _stop_xvfb() -> None:
    global _xvfb_proc
    if _xvfb_proc:
        try:
            _xvfb_proc.terminate()
            _xvfb_proc.wait(timeout=3)
        except Exception:
            pass
        _xvfb_proc = None


# ── Browser singleton ──────────────────────────────────────────────────────────

_driver: ChromiumPage | None = None


def _in_docker() -> bool:
    return os.path.exists("/.dockerenv") or os.environ.get("container") == "docker"


def _ensure_display() -> None:
    """Démarre Xvfb une seule fois (partagé par toutes les instances Chrome)."""
    if os.environ.get("DISPLAY") and _xvfb_display is None:
        # Un DISPLAY existe déjà (session graphique) — rien à faire
        return
    if _xvfb_display is not None:
        return  # Xvfb déjà lancé par nous
    display = _start_xvfb()
    if display:
        os.environ["DISPLAY"] = display
        print_flush("Mode silencieux (Xvfb)")
    else:
        print_flush("Xvfb indisponible — installe xorg-server-xvfb pour cacher la fenêtre")
        if _in_docker():
            print_flush("  Dans le Dockerfile: RUN apt-get install -y xvfb")
        else:
            print_flush("  sudo pacman -S xorg-server-xvfb")


def create_driver() -> ChromiumPage:
    """
    Construit une NOUVELLE instance Chrome (sans singleton).
    Utilisé par le BrowserPool côté API pour paralléliser search/download.
    Chaque instance a son propre user-data-dir + port auto (multi-instances).
    """
    _ensure_display()
    print_flush("Lancement d'un navigateur (bypass Cloudflare)...")
    opts = ChromiumOptions()
    opts.set_browser_path(CHROME_BIN)
    opts.set_argument("--no-sandbox")
    opts.set_argument("--disable-dev-shm-usage")
    # WebGL logiciel activé : SANS ça (--disable-gpu), le navigateur n'a PAS de WebGL
    # → signal de bot évident pour Cloudflare. SwiftShader donne un vrai renderer.
    opts.set_argument("--use-gl=angle")
    opts.set_argument("--use-angle=swiftshader")
    opts.set_argument("--enable-unsafe-swiftshader")
    opts.set_argument("--window-size=1920,1080")
    opts.set_argument("--window-position=-2400,-2400")
    # Anti-détection : masque le flag d'automatisation que Cloudflare cherche.
    opts.set_argument("--disable-blink-features=AutomationControlled")
    # Proxy optionnel (ex: WARP sidecar) pour contourner le blocage CF des IP
    # datacenter : seul le trafic du navigateur passe par ce proxy.
    proxy = os.environ.get("SUSHISCAN_PROXY")
    if proxy:
        opts.set_argument(f"--proxy-server={proxy}")
        print_flush(f"Proxy navigateur : {proxy}")
    # auto_port() → port de debug + user-data-dir isolés : indispensable pour
    # faire tourner plusieurs Chrome en parallèle sans collision.
    try:
        opts.auto_port(True)
    except Exception:
        pass

    driver = ChromiumPage(addr_or_opts=opts)
    # Spoof du renderer WebGL : SwiftShader = signal de bot. On fait croire à un vrai
    # GPU Intel/Mesa (cohérent avec Linux) pour passer la détection Cloudflare.
    try:
        driver.run_cdp("Page.addScriptToEvaluateOnNewDocument", source=_WEBGL_SPOOF_JS)
    except Exception:
        pass
    driver.get(BASE_URL)
    driver.wait.doc_loaded()
    time.sleep(PAGE_WAIT)
    _try_solve_cf(driver)
    return driver


_WEBGL_SPOOF_JS = r"""
(function(){
  const spoof = {37445: 'Intel Inc.', 37446: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics (CML GT2), OpenGL 4.6)'};
  function patch(proto){
    if(!proto) return;
    const orig = proto.getParameter;
    proto.getParameter = function(p){ return (p in spoof) ? spoof[p] : orig.call(this, p); };
    try { proto.getParameter.toString = orig.toString.bind(orig); } catch(e){}
  }
  try { patch(WebGLRenderingContext.prototype); } catch(e){}
  try { patch(WebGL2RenderingContext.prototype); } catch(e){}
  try { Object.defineProperty(navigator, 'webdriver', {get: () => undefined}); } catch(e){}
})();
"""


def get_driver() -> ChromiumPage:
    """Singleton (usage CLI / rétro-compat). Le pool utilise create_driver()."""
    global _driver
    if _driver is not None:
        try:
            if _driver.states.is_alive:  # DrissionPage 4.x
                return _driver
        except Exception:
            pass
        print_flush("  [Chrome] Relancement du driver fermé...")
        _driver = None
    _driver = create_driver()
    return _driver


def _try_solve_cf(driver: ChromiumPage) -> None:
    """Clic sur la checkbox Cloudflare Turnstile si présente."""
    try:
        container = driver.ele("css:#PKVDd5 > div > div", timeout=3)
        if not container:
            return
        iframe = container.sr("@src^https://challenges.cloudflare.com/cdn-cgi", timeout=3)
        body = iframe.ele("tag:body")
        if body:
            body.sr(".cb-i").click()
            time.sleep(4)
    except Exception:
        pass


def close_driver() -> None:
    global _driver
    if _driver:
        try:
            _driver.close()
        except Exception:
            pass
        _driver = None
    _stop_xvfb()


def fetch_html(url: str, wait: float = PAGE_WAIT, driver=None) -> str:
    driver = driver or get_driver()
    driver.get(url)
    driver.wait.doc_loaded()
    time.sleep(wait)
    return driver.html


# ── Recherche ──────────────────────────────────────────────────────────────────

def search_manga(query: str, driver=None) -> list[SearchResult]:
    url = f"{BASE_URL}/?s={quote(query, safe='')}&post_type=wp-manga"
    html = fetch_html(url, wait=3.0, driver=driver)
    soup = BeautifulSoup(html, "html.parser")

    results: list[SearchResult] = []
    seen: set[str] = set()

    for card in soup.select("div.bsx"):
        a = card.select_one("a[href][title]")
        if not a:
            continue
        href = a.get("href", "").strip()
        title = a.get("title", "").strip()
        image_url = None
        img = card.select_one("img")
        if img:
            src = (
                img.get("data-src")
                or img.get("data-lazy-src")
                or img.get("src")
                or ""
            ).strip()
            if not src and img.get("srcset"):
                src = img.get("srcset", "").split(",", 1)[0].strip().split(" ", 1)[0]
            if src and not src.startswith("data:"):
                image_url = urljoin(BASE_URL, src)
        if href and title and "/catalogue/" in href and href not in seen:
            seen.add(href)
            results.append(SearchResult(title=title, url=href, image_url=image_url))

    return results


# ── Chapitres ──────────────────────────────────────────────────────────────────

def fetch_chapters(manga_url: str, driver=None) -> list[Chapter]:
    html = fetch_html(manga_url, wait=5.0, driver=driver)
    soup = BeautifulSoup(html, "html.parser")

    chapters: list[Chapter] = []
    seen: set[str] = set()

    for div in soup.select("div.eph-num"):
        a = div.select_one("a[href]")
        if not a:
            continue
        href = a.get("href", "").strip()
        if not href or href == "#/" or href in seen:
            continue
        seen.add(href)

        raw = a.get_text(separator=" ", strip=True)
        raw_title = re.sub(r"\d{1,2}\s+\w+\.?\s+\d{4}$", "", raw).strip()

        # Cherche le numéro ET le type dans le titre
        m = re.search(
            r"(?P<kind>[Cc]hapitre|[Cc]hapter|[Vv]olume|[Vv]ol\.?|[Tt]ome)\s*(?P<num>[\d.]+)",
            raw,
        )
        if not m:
            # Fallback URL
            m = re.search(r"(?P<kind>chapitre|chapter|volume|vol|tome)-?(?P<num>[\d.]+)", href, re.I)

        if m:
            num = float(m.group("num"))
            kw = m.group("kind").lower()
            kind = "Volume" if kw in ("volume", "vol", "tome") else "Chapitre"
        else:
            num = float(len(chapters) + 1)
            kind = "Chapitre"

        chapters.append(Chapter(number=num, title=raw_title or f"{kind} {num}", url=href, kind=kind))

    return sorted(chapters, key=lambda c: c.number)


# ── Images d'un chapitre ───────────────────────────────────────────────────────

def fetch_chapter_images(chapter_url: str) -> list[str]:
    html = fetch_html(chapter_url, wait=4.0)

    # ts_reader.run() est la source la plus fiable (Madara theme)
    m = re.search(r"ts_reader\.run\((\{.*?\})\)", html, re.DOTALL)
    if m:
        try:
            data = json.loads(m.group(1))
            for src in data.get("sources", []):
                imgs = [i.strip() for i in src.get("images", []) if i.strip()]
                if imgs:
                    return imgs
        except json.JSONDecodeError:
            pass

    # Fallback JSON inline
    m2 = re.search(r'"images"\s*:\s*(\[.*?\])', html, re.DOTALL)
    if m2:
        try:
            imgs = [i.strip() for i in json.loads(m2.group(1)) if isinstance(i, str) and i.strip()]
            if imgs:
                return imgs
        except json.JSONDecodeError:
            pass

    # Fallback DOM
    soup = BeautifulSoup(html, "html.parser")
    imgs = []
    for img in soup.select(".reading-content img, .page-break img, #readerarea img"):
        src = (img.get("data-src") or img.get("data-lazy-src") or img.get("src") or "").strip()
        if src and not src.startswith("data:"):
            imgs.append(src)
    return imgs


# ── Téléchargement d'images via listen CDP (sous-ressource, bypass CF CDN) ────

_IMG_EXTS = {"jpg", "jpeg", "png", "webp", "avif", "gif"}

DEFAULT_BATCH_SIZE = 5

# Injection d'une seule image (fallback retry)
_JS_INJECT_IMG = """
(function(src) {
    const old = document.getElementById('_sc_img_');
    if (old) old.remove();
    const img = document.createElement('img');
    img.id = '_sc_img_';
    img.src = src;
    img.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;left:-9999px;top:-9999px;pointer-events:none';
    document.body.appendChild(img);
})(arguments[0]);
"""

# Injection batch : plusieurs images simultanément → requêtes réseau parallèles
_JS_INJECT_BATCH = """
(function(srcs) {
    document.querySelectorAll('[id^="_scb_"]').forEach(e => e.remove());
    srcs.forEach(function(src, i) {
        var img = document.createElement('img');
        img.id = '_scb_' + i;
        img.src = src;
        img.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;left:-9999px;top:-9999px;pointer-events:none';
        document.body.appendChild(img);
    });
})(arguments[0]);
"""


def _img_ext(url: str) -> str:
    e = url.rsplit(".", 1)[-1].split("?")[0].lower()
    return e if e in _IMG_EXTS else "jpg"


_IMAGE_MAGIC = (
    b'\xff\xd8',                    # JPEG
    b'\x89PNG',                     # PNG
    b'RIFF',                        # WebP (vérifié aussi à offset 8)
    b'GIF8',                        # GIF
    b'\x00\x00\x00\x18ftypavif',   # AVIF
    b'\x00\x00\x00\x1cftypavif',   # AVIF variante
)


def _is_image_bytes(data: bytes) -> bool:
    """Vérifie que les bytes sont bien une image (pas une page CF/HTML)."""
    if len(data) < 16:
        return False
    if data[:1] == b'<':
        return False  # HTML/XML → page de blocage CF
    if data[:2] == b'\xff\xd8':
        return True
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return True
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return True
    if data[:4] == b'GIF8':
        return True
    if b'ftyp' in data[4:12]:
        return True  # AVIF / MP4 container
    return False


def _save_packet(packet, out_path: Path) -> bool:
    """Sauvegarde le body d'un packet listen si c'est bien une image."""
    try:
        if hasattr(packet, 'response') and packet.response.status not in (None, 200, 206):
            return False
        body = packet.response.body
        if not body:
            return False
        data = body if isinstance(body, bytes) else body.encode("latin-1")
        if not _is_image_bytes(data):
            return False  # Page HTML (ex. blocage Cloudflare) rejetée
        out_path.write_bytes(data)
        return True
    except Exception:
        return False


def _inject_and_capture(driver: ChromiumPage, img_url: str, out_path: Path) -> bool:
    """Injection séquentielle d'une image (utilisé en retry après échec batch)."""
    _rate_check()
    driver.listen.start(targets=img_url, method="GET")
    try:
        driver.run_js(_JS_INJECT_IMG, img_url)
        packet = driver.listen.wait(count=1, timeout=25)
        if not packet:
            return False
        return _save_packet(packet, out_path)
    except Exception:
        return False
    finally:
        try:
            driver.listen.stop()
        except Exception:
            pass


def _inject_batch(
    driver: ChromiumPage,
    items: list[tuple[str, Path]],
) -> set[str]:
    """
    Injecte N images simultanément, les requêtes réseau partent en parallèle.
    Collecte les réponses via listen (fit_count=False → retourne ce qui arrive
    dans le timeout sans bloquer sur les manquants).
    Retourne l'ensemble des URLs sauvegardées avec succès.
    """
    for _ in items:
        _rate_check()

    urls = [url for url, _ in items]
    path_map = {url: path for url, path in items}

    driver.listen.start(targets=urls, method="GET")
    packets: list = []
    try:
        driver.run_js(_JS_INJECT_BATCH, urls)
        count = len(urls)
        if count == 1:
            raw = driver.listen.wait(count=1, timeout=25)
            if raw:
                packets = [raw]
        else:
            raw = driver.listen.wait(count=count, fit_count=False, timeout=30)
            if not raw:
                packets = []
            elif isinstance(raw, list):
                packets = raw
            else:
                packets = [raw]
    except Exception:
        pass
    finally:
        try:
            driver.listen.stop()
        except Exception:
            pass

    saved: set[str] = set()
    for pkt in packets:
        try:
            url = pkt.url
            if url in path_map and _save_packet(pkt, path_map[url]):
                saved.add(url)
        except Exception:
            pass
    return saved


def _download_one_chapter(chapter_url: str, chapter_dir: Path, batch_size: int = DEFAULT_BATCH_SIZE, driver=None) -> tuple[list[str], int]:
    """
    Télécharge toutes les images d'un chapitre en deux phases :
    Phase 1 : listen actif AVANT la navigation → capture les images chargées
              automatiquement par le reader (ex. page 1 visible au chargement).
    Phase 2 : injection JS une par une pour les images restantes.
    Retourne (liste_urls, nb_téléchargées).
    """
    driver = driver or get_driver()

    # Phase 1 — listen ouvert avant navigate, capte les auto-loads du reader
    driver.listen.start(targets="")
    driver.get(chapter_url)
    driver.wait.doc_loaded()
    time.sleep(PAGE_WAIT)

    html = driver.html

    # Drainer le buffer : wait() retourne False (pas None) en timeout
    auto_packets: dict[str, object] = {}
    while True:
        pkt = driver.listen.wait(count=1, timeout=2)
        if not pkt:   # False = timeout, plus de paquets en attente
            break
        auto_packets[pkt.url] = pkt
    driver.listen.stop()

    # Extraire la liste des images depuis le HTML chargé
    images = _extract_images(html)
    if not images:
        return [], 0

    url_to_idx = {url: i for i, url in enumerate(images, 1)}
    saved: set[str] = set()

    # Sauvegarder les images auto-chargées capturées en phase 1
    for img_url in images:
        packet = auto_packets.get(img_url)
        if packet is None:
            continue
        idx = url_to_idx[img_url]
        out_path = chapter_dir / f"{idx}.{_img_ext(img_url)}"
        if out_path.exists():
            saved.add(img_url)
            continue
        _rate_check()
        if _save_packet(packet, out_path):
            saved.add(img_url)

    # Phase 2 — injection par batch, retry séquentiel pour les échecs
    remaining = [
        (url, chapter_dir / f"{url_to_idx[url]}.{_img_ext(url)}")
        for url in images
        if url not in saved and not (chapter_dir / f"{url_to_idx[url]}.{_img_ext(url)}").exists()
    ]

    for i in range(0, len(remaining), batch_size):
        batch = remaining[i:i + batch_size]
        got = _inject_batch(driver, batch)
        saved.update(got)

        # Retry séquentiel pour les images manquantes du batch
        for url, out_path in batch:
            if url in got or out_path.exists():
                continue
            if _inject_and_capture(driver, url, out_path):
                saved.add(url)
            else:
                print_flush(f"  - page {url_to_idx[url]}: échec")

    return images, len(saved)


def _extract_images(html: str) -> list[str]:
    """Extrait les URLs d'images depuis le HTML d'un chapitre."""
    m = re.search(r"ts_reader\.run\((\{.*?\})\)", html, re.DOTALL)
    if m:
        try:
            data = json.loads(m.group(1))
            for src in data.get("sources", []):
                imgs = [i.strip() for i in src.get("images", []) if i.strip()]
                if imgs:
                    return imgs
        except json.JSONDecodeError:
            pass

    m2 = re.search(r'"images"\s*:\s*(\[.*?\])', html, re.DOTALL)
    if m2:
        try:
            imgs = [i.strip() for i in json.loads(m2.group(1)) if isinstance(i, str) and i.strip()]
            if imgs:
                return imgs
        except json.JSONDecodeError:
            pass

    soup = BeautifulSoup(html, "html.parser")
    imgs = []
    for img in soup.select(".reading-content img, .page-break img, #readerarea img"):
        src = (img.get("data-src") or img.get("data-lazy-src") or img.get("src") or "").strip()
        if src and not src.startswith("data:"):
            imgs.append(src)
    return imgs


# ── Téléchargement des chapitres ───────────────────────────────────────────────

def download_chapters_range(
    *,
    manga_name: str,
    chapters: list[Chapter],
    start: float,
    end: float,
    make_epub: bool = True,
    keep_images: bool = False,
    page_height: int = DEFAULT_PAGE_HEIGHT,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> None:
    sys.path.insert(0, str(Path(__file__).parent))
    from split_manga import split_fixed  # noqa: E402
    from make_epub import create_epub    # noqa: E402

    base_dir = Path("extraction") / sanitize_name(manga_name)
    targets = [c for c in chapters if start <= c.number <= end]

    if not targets:
        print_flush("Aucun chapitre dans cette plage.")
        return

    total_dl = 0
    for chapter in targets:
        label = f"{chapter.kind} {chapter.number}"
        print_flush(f"\n[{label}] Chargement...")

        chapter_dir = base_dir / label
        chapter_dir.mkdir(parents=True, exist_ok=True)

        images, dl_count = _download_one_chapter(chapter.url, chapter_dir, batch_size)
        if not images:
            print_flush(f"[{label}] Aucune image trouvée, ignoré.")
            continue

        total_dl += dl_count
        print_flush(f"[{label}] {dl_count}/{len(images)} page(s) téléchargée(s)")

        if make_epub:
            try:
                _process_epub(
                    chapter_dir, manga_name, chapter.number, chapter.kind,
                    page_height, keep_images, create_epub, split_fixed,
                )
            except Exception as err:
                print_flush(f"[{label}] Erreur EPUB: {err}")

    print_flush(f"\nTerminé. {total_dl} page(s) téléchargée(s) au total.")


def _process_epub(
    chapter_dir: Path,
    manga_name: str,
    chapter_num: float,
    kind: str,
    page_height: int,
    keep_images: bool,
    create_epub,
    split_fixed,
) -> None:
    img_exts = {".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"}
    files = sorted(
        [p for p in chapter_dir.iterdir() if p.suffix.lower() in img_exts and re.match(r"^\d+", p.stem)],
        key=lambda p: int(re.match(r"^\d+", p.stem).group()),
    )
    if not files:
        return

    label = f"{kind} {chapter_num}"
    images_dir = chapter_dir / "images"
    images_dir.mkdir(exist_ok=True)

    result = subprocess.run(
        ["identify", "-format", "%h", str(files[0])],
        capture_output=True, text=True,
    )
    first_h = int(result.stdout.strip()) if result.returncode == 0 and result.stdout.strip().isdigit() else 0
    needs_split = first_h > 4000

    all_pages: list[Path] = []
    if needs_split:
        print_flush(f"[{label}] Images fusionnées ({first_h}px) — découpage...")
        tmp_dirs = []
        for src in files:
            tmp = chapter_dir / f"_tmp_{src.stem}"
            pages = split_fixed(str(src), tmp, page_height=page_height)
            all_pages.extend(pages)
            tmp_dirs.append(tmp)
        for i, p in enumerate(all_pages, 1):
            shutil.copy2(p, images_dir / f"{i:03d}{p.suffix}")
        for tmp in tmp_dirs:
            shutil.rmtree(tmp, ignore_errors=True)
    else:
        print_flush(f"[{label}] Pages découpées — renumérotation...")
        for i, src in enumerate(files, 1):
            shutil.copy2(src, images_dir / f"{i:03d}{src.suffix}")
        all_pages = list(images_dir.iterdir())

    epub_title = f"{manga_name} - {label}"
    epub_path = chapter_dir.parent / f"{label}.epub"
    print_flush(f"[{label}] Création EPUB ({len(all_pages)} pages)...")
    create_epub(
        chapter_dir=images_dir,
        output_file=epub_path,
        title=epub_title,
        author="Inconnu",
        language="fr",
        image_format="original",
        quality=82,
        max_width=None,
    )
    print_flush(f"[{label}] EPUB: {epub_path}")

    for src in files:
        src.unlink(missing_ok=True)
    if not keep_images:
        shutil.rmtree(images_dir, ignore_errors=True)


# ── Utilitaires ────────────────────────────────────────────────────────────────

def sanitize_name(name: str) -> str:
    safe = re.sub(r'[\\/:*?"<>|]+', "_", name)
    safe = re.sub(r"\s+", " ", safe).strip()
    return safe or "unknown"


def print_flush(msg: str) -> None:
    print(msg, flush=True)


def prompt_choice(items: list[str], label: str, forced: int | None = None) -> int:
    if not items:
        raise RuntimeError(f"Aucune option pour {label}.")
    if forced is not None:
        if 1 <= forced <= len(items):
            return forced - 1
        raise RuntimeError(f"Choix invalide: {forced}")
    while True:
        val = input(f"{label} [1-{len(items)}] : ").strip()
        if val.isdigit() and 1 <= int(val) <= len(items):
            return int(val) - 1
        print_flush("Choix invalide.")


def prompt_float(label: str, default: float | None = None) -> float:
    while True:
        suffix = f" [{default}]" if default is not None else ""
        val = input(f"{label}{suffix} : ").strip()
        if not val and default is not None:
            return default
        try:
            return float(val)
        except ValueError:
            print_flush("Nombre invalide.")


# ── CLI ────────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Scraper interactif sushiscan.net")
    p.add_argument("query", nargs="?", help="Terme de recherche initial")
    p.add_argument("--result", type=int, help="Index du résultat (1-based)")
    p.add_argument("--start", type=float, help="Chapitre de début")
    p.add_argument("--end", type=float, help="Chapitre de fin")
    p.add_argument("--yes", action="store_true", help="Lance sans confirmation")
    p.add_argument("--no-epub", action="store_true", help="Ne crée pas d'EPUB")
    p.add_argument("--keep-images", action="store_true", help="Conserve les images après EPUB")
    p.add_argument("--no-images", action="store_true", help="Supprime les images sans demander")
    p.add_argument("--page-height", type=int, default=DEFAULT_PAGE_HEIGHT,
                   help=f"Hauteur de page pour le découpage (défaut: {DEFAULT_PAGE_HEIGHT})")
    p.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE,
                   help=f"Images injectées en parallèle (défaut: {DEFAULT_BATCH_SIZE}, max recommandé: 8)")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    query = (args.query or input("Quel manga veux-tu chercher ? ").strip()).strip()
    if not query:
        print_flush("Recherche vide.")
        return 1

    print_flush(f"\nRecherche de « {query} »...")
    results = search_manga(query)
    if not results:
        print_flush("Aucun résultat trouvé.")
        return 1

    print_flush(f"\n{len(results)} résultat(s) :")
    for i, r in enumerate(results, 1):
        print_flush(f"  {i}. {r.title}")

    idx = prompt_choice([r.title for r in results], "Choisis un manga", args.result)
    selected = results[idx]
    print_flush(f"\n→ {selected.title}")

    print_flush("Récupération des chapitres...")
    chapters = fetch_chapters(selected.url)
    if not chapters:
        print_flush("Aucun chapitre trouvé.")
        return 1

    first_num = chapters[0].number
    last_num = chapters[-1].number
    print_flush(f"{len(chapters)} chapitre(s) : {first_num} → {last_num}")

    start = args.start if args.start is not None else prompt_float("Chapitre début", first_num)
    end = args.end if args.end is not None else prompt_float("Chapitre fin", last_num)

    if start > end:
        print_flush("Le chapitre de début doit être ≤ au chapitre de fin.")
        return 1

    if not args.yes:
        confirm = input(f"\nTélécharger les chapitres {start} → {end} ? [O/n] : ").strip().lower()
        if confirm and confirm not in {"o", "oui", "y", "yes"}:
            print_flush("Annulé.")
            return 0

    make_epub = not args.no_epub
    if args.no_images:
        keep_images = False
    elif args.keep_images:
        keep_images = True
    elif make_epub and not args.yes:
        ans = input("Conserver les images après création EPUB ? [o/N] : ").strip().lower()
        keep_images = ans in {"o", "oui", "y", "yes"}
    else:
        keep_images = False

    download_chapters_range(
        manga_name=selected.title,
        chapters=chapters,
        start=start,
        end=end,
        make_epub=make_epub,
        keep_images=keep_images,
        page_height=args.page_height,
        batch_size=args.batch_size,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print_flush("\nInterrompu.")
        raise SystemExit(130)
    except RuntimeError as err:
        print_flush(f"Erreur: {err}")
        raise SystemExit(1)
    finally:
        close_driver()
