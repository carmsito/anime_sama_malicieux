"""
Service Sushiscan — bypass Cloudflare via FlareSolverr + curl_cffi.

Sushiscan est derrière un "managed challenge" Cloudflare qui bloque les navigateurs
headless sur IP datacenter. Solution (0€, sans proxy) :

  1. FlareSolverr (conteneur) résout le challenge JS et fournit le cookie
     `cf_clearance` + le User-Agent, par domaine (sushiscan.net ET c1.sushiscan.net).
  2. curl_cffi (impersonate=chrome → même empreinte TLS/JA3 que Chrome) réutilise ce
     cookie pour tout télécharger (HTML + images) en HTTP direct, rapide et parallèle.

Le cookie est mis en cache par domaine et rafraîchi automatiquement sur 403/challenge.
Plus de navigateur DrissionPage côté serveur → plus léger et beaucoup plus rapide.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote, urljoin, urlparse

from ..config import EXTRACTION_DIR, COVERS_DIR, PROJECT_ROOT

BASE_URL = "https://sushiscan.net"
FLARESOLVERR_URL = os.environ.get("FLARESOLVERR_URL", "http://flaresolverr:8191/v1")
CLEARANCE_TTL = 1800  # 30 min avant re-solve préventif
DL_WORKERS = int(os.environ.get("SUSHISCAN_DL_WORKERS", "6"))


def _make_manga_id(manga_name: str, category: str = "sushiscan") -> str:
    def slug(s: str) -> str:
        return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return f"{slug(manga_name)}_{slug(category)}"


# ── Chargement paresseux des helpers EPUB (make_epub / split / _process_epub) ──

_mod = None
split_fixed = None
create_epub = None
_AVAILABLE = None


def _load_module() -> bool:
    global _mod, split_fixed, create_epub, _AVAILABLE
    if _AVAILABLE is not None:
        return _AVAILABLE
    try:
        spec = importlib.util.spec_from_file_location(
            "sushiscan", PROJECT_ROOT / "scripts" / "sushiscan.py"
        )
        mod = importlib.util.module_from_spec(spec)
        sys.modules["sushiscan"] = mod
        spec.loader.exec_module(mod)
        _mod = mod
        sys.path.insert(0, str(PROJECT_ROOT / "scripts"))
        from split_manga import split_fixed as sf  # noqa: E402
        from make_epub import create_epub as ce    # noqa: E402
        split_fixed = sf
        create_epub = ce
        _AVAILABLE = True
    except Exception as e:
        _AVAILABLE = False
        print(f"[sushiscan_svc] helpers indisponibles: {e}", flush=True)
    return _AVAILABLE


def _sanitize(name: str) -> str:
    if _load_module():
        return _mod.sanitize_name(name)
    safe = re.sub(r'[\\/:*?"<>|]+', "_", name)
    return re.sub(r"\s+", " ", safe).strip() or "unknown"


# ── FlareSolverr + clearance cache ────────────────────────────────────────────

_clearance: dict[str, dict] = {}   # domain -> {cookies: {name:val}, ua: str, ts: float}
_clearance_lock = threading.Lock()
_solve_locks: dict[str, threading.Lock] = {}  # verrou par domaine (anti-stampede)
_solve_locks_guard = threading.Lock()


def _domain_lock(domain: str) -> threading.Lock:
    with _solve_locks_guard:
        lk = _solve_locks.get(domain)
        if lk is None:
            lk = _solve_locks[domain] = threading.Lock()
        return lk


def _domain(url: str) -> str:
    return urlparse(url).netloc


def _fs_solve(url: str) -> tuple[str, str, dict]:
    """Appelle FlareSolverr. Retourne (html, user_agent, {cookie: valeur})."""
    import urllib.request
    payload = json.dumps({"cmd": "request.get", "url": url, "maxTimeout": 75000}).encode()
    req = urllib.request.Request(FLARESOLVERR_URL, data=payload,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        d = json.load(r)
    if d.get("status") != "ok":
        raise RuntimeError(f"FlareSolverr: {d.get('message')}")
    sol = d.get("solution", {})
    cookies = {c["name"]: c["value"] for c in sol.get("cookies", [])}
    return sol.get("response", ""), sol.get("userAgent", ""), cookies


def _get_clearance(domain: str, force: bool = False) -> dict:
    """
    Clearance (cookies+UA) pour un domaine, mise en cache. Un verrou PAR DOMAINE
    sérialise la résolution FlareSolverr : si 6 workers la demandent en même temps,
    UN SEUL résout (~15s), les autres réutilisent le résultat (anti-stampede).
    """
    with _clearance_lock:
        c = _clearance.get(domain)
        if c and not force and (time.time() - c["ts"] < CLEARANCE_TTL):
            return c
    with _domain_lock(domain):
        # Double-check : un autre worker a peut-être résolu pendant l'attente du verrou.
        with _clearance_lock:
            c = _clearance.get(domain)
            if c and not force and (time.time() - c["ts"] < CLEARANCE_TTL):
                return c
        _, ua, cookies = _fs_solve(f"https://{domain}/")
        c = {"cookies": cookies, "ua": ua, "ts": time.time()}
        with _clearance_lock:
            _clearance[domain] = c
        print(f"[sushiscan] clearance obtenue pour {domain}", flush=True)
        return c


def _session(domain: str):
    """Session curl_cffi (impersonate chrome) primée avec la clearance du domaine."""
    from curl_cffi import requests as cr
    c = _get_clearance(domain)
    s = cr.Session(impersonate="chrome")
    for k, v in c["cookies"].items():
        s.cookies.set(k, v, domain="." + domain if not domain.startswith(".") else domain)
    s.headers.update({"User-Agent": c["ua"], "Referer": BASE_URL + "/"})
    return s


def _fetch(url: str, binary: bool = False, _retry: bool = True):
    """GET via curl_cffi avec clearance. Rafraîchit la clearance une fois sur 403/challenge."""
    dom = _domain(url)
    s = _session(dom)
    try:
        r = s.get(url, timeout=30)
    except Exception:
        if _retry:
            _get_clearance(dom, force=True)
            return _fetch(url, binary, _retry=False)
        raise
    blocked = r.status_code in (403, 503) or (
        not binary and "just a moment" in (r.text[:2000].lower() if r.text else "")
    )
    if blocked and _retry:
        _get_clearance(dom, force=True)
        return _fetch(url, binary, _retry=False)
    return r.content if binary else r.text


def _fetch_html(url: str) -> str:
    return _fetch(url, binary=False)


# ── Parsing (self-contained, depuis le HTML fourni par FlareSolverr/curl_cffi) ─

def _parse_search(html: str) -> list[dict]:
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "html.parser")
    out, seen = [], set()
    for card in soup.select("div.bsx"):
        a = card.select_one("a[href][title]")
        if not a:
            continue
        href = (a.get("href") or "").strip()
        title = (a.get("title") or "").strip()
        if not (href and title and "/catalogue/" in href) or href in seen:
            continue
        seen.add(href)
        image_url = None
        img = card.select_one("img")
        if img:
            src = (img.get("data-src") or img.get("data-lazy-src") or img.get("src") or "").strip()
            if not src and img.get("srcset"):
                src = img["srcset"].split(",", 1)[0].strip().split(" ", 1)[0]
            if src and not src.startswith("data:"):
                image_url = urljoin(BASE_URL, src)
        out.append({"title": title, "url": href, "image_url": image_url})
    return out


def _parse_chapters(html: str) -> list[dict]:
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "html.parser")
    chapters, seen = [], set()
    for div in soup.select("div.eph-num"):
        a = div.select_one("a[href]")
        if not a:
            continue
        href = (a.get("href") or "").strip()
        if not href or href == "#/" or href in seen:
            continue
        seen.add(href)
        raw = a.get_text(separator=" ", strip=True)
        raw_title = re.sub(r"\d{1,2}\s+\w+\.?\s+\d{4}$", "", raw).strip()
        m = re.search(r"(?P<kind>[Cc]hapitre|[Cc]hapter|[Vv]olume|[Vv]ol\.?|[Tt]ome)\s*(?P<num>[\d.]+)", raw)
        if not m:
            m = re.search(r"(?P<kind>chapitre|chapter|volume|vol|tome)-?(?P<num>[\d.]+)", href, re.I)
        if m:
            num = float(m.group("num"))
            kw = m.group("kind").lower()
            kind = "Volume" if kw in ("volume", "vol", "tome") else "Chapitre"
        else:
            num = float(len(chapters) + 1)
            kind = "Chapitre"
        chapters.append({"number": num, "title": raw_title or f"{kind} {num}", "url": href, "kind": kind})
    return sorted(chapters, key=lambda c: c["number"])


def _parse_images(html: str) -> list[str]:
    for pat in (r"ts_reader\.run\((\{.*?\})\)", None):
        if pat:
            m = re.search(pat, html, re.DOTALL)
            if m:
                try:
                    data = json.loads(m.group(1))
                    for src in data.get("sources", []):
                        imgs = [i.strip().replace("\\/", "/") for i in src.get("images", []) if i.strip()]
                        if imgs:
                            return imgs
                except json.JSONDecodeError:
                    pass
    m2 = re.search(r'"images"\s*:\s*(\[.*?\])', html, re.DOTALL)
    if m2:
        try:
            return [i.strip().replace("\\/", "/") for i in json.loads(m2.group(1)) if isinstance(i, str) and i.strip()]
        except json.JSONDecodeError:
            pass
    return []


def _scrape_meta(html: str) -> dict:
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "html.parser")
    meta: dict = {}
    og = soup.find("meta", property="og:image")
    if og and og.get("content"):
        meta["cover_url"] = og["content"]
    else:
        for sel in [".summary_image img", "[class*=thumbnail] img", ".wp-post-image"]:
            img = soup.select_one(sel)
            if img:
                src = img.get("data-src") or img.get("src") or ""
                if src and not src.startswith("data:"):
                    meta["cover_url"] = src
                    break
    p = soup.select_one(".entry-content p")
    if p:
        t = p.get_text(strip=True)
        if len(t) > 20:
            meta["synopsis"] = t
    genres = [a.get_text(strip=True) for a in soup.select(".genres-content a, [class*=genre] a") if a.get_text(strip=True)]
    if genres:
        meta["genres"] = genres
    m = re.search(r"\b(19[5-9]\d|20[0-2]\d)\b", html)
    if m:
        meta["year"] = m.group(0)
    for sel in [".author-content a", "[class*=author] a"]:
        el = soup.select_one(sel)
        if el:
            meta["creator"] = el.get_text(strip=True)
            break
    return meta


def _is_image(data: bytes) -> bool:
    if not data or len(data) < 16 or data[:1] == b"<":
        return False
    return (data[:2] == b"\xff\xd8" or data[:8] == b"\x89PNG\r\n\x1a\n"
            or (data[:4] == b"RIFF" and data[8:12] == b"WEBP") or data[:4] == b"GIF8"
            or b"ftyp" in data[4:12])


def _img_ext(url: str) -> str:
    e = url.rsplit(".", 1)[-1].split("?")[0].lower()
    return e if e in {"jpg", "jpeg", "png", "webp", "avif", "gif"} else "jpg"


# ── API publique ──────────────────────────────────────────────────────────────

def search(query: str) -> list[dict]:
    url = f"{BASE_URL}/?s={quote(query, safe='')}&post_type=wp-manga"
    try:
        html = _fetch_html(url)
    except Exception as e:
        raise RuntimeError(f"Erreur Sushiscan lors de la recherche : {e}") from e
    return [
        {
            "title": r["title"],
            "subtitle": "",
            "work_url": r["url"],
            "image_url": (f"/api/search/sushiscan/image?url={r['image_url']}" if r["image_url"] else None),
            "source": "sushiscan",
        }
        for r in _parse_search(html)
    ]


def get_chapters(manga_url: str) -> dict | None:
    try:
        chapters = _parse_chapters(_fetch_html(manga_url))
    except Exception as e:
        raise RuntimeError(f"Erreur Sushiscan lors de la récupération des chapitres : {e}") from e
    if not chapters:
        return None
    by_kind: dict[str, list] = {}
    for c in chapters:
        by_kind.setdefault(c["kind"], []).append(c)
    kinds_info = {}
    for k, lst in by_kind.items():
        lst.sort(key=lambda c: c["number"])
        kinds_info[k] = {"first": lst[0]["number"], "last": lst[-1]["number"], "total": len(lst)}
    first_kind = next(iter(kinds_info))
    return {
        "manga_url": manga_url,
        "kinds": kinds_info,
        "kind": first_kind,
        "first_chapter": kinds_info[first_kind]["first"],
        "last_chapter": kinds_info[first_kind]["last"],
        "total": sum(v["total"] for v in kinds_info.values()),
    }


def get_meta(manga_url: str, manga_id: str | None = None) -> dict:
    try:
        html = _fetch_html(manga_url)
        meta = _scrape_meta(html)
        if manga_id and meta.get("cover_url"):
            _cache_cover(manga_id, meta["cover_url"])
        return meta
    except Exception as e:
        print(f"[get_meta] error: {e}", flush=True)
        return {}


def _download_chapter_images(chapter_url: str, chapter_dir: Path) -> int:
    """Extrait puis télécharge en parallèle les images d'un chapitre. Retourne le nb OK."""
    html = _fetch_html(chapter_url)
    images = _parse_images(html)
    if not images:
        return 0

    # Pré-chauffe la clearance du CDN une seule fois (évite que N workers la résolvent
    # en parallèle) avant de lancer le téléchargement parallèle.
    try:
        _get_clearance(_domain(images[0]))
    except Exception:
        pass

    def _one(idx_url):
        idx, url = idx_url
        try:
            data = _fetch(url, binary=True)
            if _is_image(data):
                (chapter_dir / f"{idx:03d}.{_img_ext(url)}").write_bytes(data)
                return True
        except Exception as e:
            print(f"[img] {url.split('/')[-1]}: {e}", flush=True)
        return False

    with ThreadPoolExecutor(max_workers=DL_WORKERS) as ex:
        results = list(ex.map(_one, enumerate(images, 1)))
    return sum(results)


def download(job_id, manga_name, manga_url, start, end, kind_filter=None,
             make_epub=True, keep_images=False, page_height=1878, batch_size=5):
    from . import jobs as jobs_svc
    if not _load_module():
        jobs_svc.update_job(job_id, status="error", error="Helpers EPUB indisponibles")
        return
    jobs_svc.update_job(job_id, status="running")
    try:
        chapters = _parse_chapters(_fetch_html(manga_url))
        if not chapters:
            jobs_svc.update_job(job_id, status="error", error="Aucun chapitre trouvé")
            return
        targets = [c for c in chapters if start <= c["number"] <= end
                   and (not kind_filter or c["kind"] == kind_filter)]
        if not targets:
            jobs_svc.update_job(job_id, status="error", error="Aucun chapitre dans cette plage")
            return
        jobs_svc.update_job(job_id, total=len(targets))

        kind = kind_filter or targets[0]["kind"]
        safe_name = _sanitize(manga_name)
        base_dir = EXTRACTION_DIR / safe_name / "sushiscan"
        base_dir.mkdir(parents=True, exist_ok=True)
        manga_id = _make_manga_id(safe_name, "sushiscan")

        meta = {"manga_name": manga_name, "manga_url": manga_url, "source": "sushiscan", "kind": kind}
        try:
            meta.update(_scrape_meta(_fetch_html(manga_url)))
            if meta.get("cover_url"):
                _cache_cover(manga_id, meta["cover_url"])
        except Exception:
            pass
        (base_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))

        for progress, ch in enumerate(targets, 1):
            label = f"{ch['kind']} {ch['number']}"
            chapter_dir = base_dir / label
            chapter_dir.mkdir(parents=True, exist_ok=True)
            try:
                n = _download_chapter_images(ch["url"], chapter_dir)
                print(f"[download] {label}: {n} images", flush=True)
            except Exception as e:
                print(f"[download] {label}: {e}", flush=True)
                jobs_svc.update_job(job_id, progress=progress)
                continue

            if make_epub:
                try:
                    _mod._process_epub(chapter_dir, manga_name, ch["number"], ch["kind"],
                                       page_height, keep_images, create_epub, split_fixed)
                    epub_path = base_dir / f"{label}.epub"
                    if epub_path.exists():
                        try:
                            from . import storage
                            storage.store_epub(manga_id, ch["number"], ch["kind"], epub_path)
                        except Exception as se:
                            print(f"[storage] offload {label}: {se}", flush=True)
                except Exception as ee:
                    print(f"[epub ERROR] {label}: {ee}", flush=True)

            jobs_svc.update_job(job_id, progress=progress)

        jobs_svc.update_job(job_id, status="done")
    except Exception as exc:
        jobs_svc.update_job(job_id, status="error", error=str(exc))


def _cache_cover(slug: str, url: str) -> None:
    cover_path = COVERS_DIR / f"{slug}.jpg"
    if cover_path.exists() or not url:
        return
    try:
        data = _fetch(url, binary=True)
        if _is_image(data):
            cover_path.write_bytes(data)
            print(f"[cover] {slug}.jpg → {len(data)} octets", flush=True)
    except Exception as e:
        print(f"[cover] {slug}: {e}", flush=True)


def fetch_image(url: str) -> tuple[bytes | None, str]:
    """Proxy image Sushiscan (pour les vignettes de recherche)."""
    if not url:
        return None, "application/octet-stream"
    try:
        data = _fetch(url, binary=True)
        if _is_image(data):
            ext = _img_ext(url)
            mt = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
                  "webp": "image/webp", "avif": "image/avif", "gif": "image/gif"}.get(ext, "image/jpeg")
            return data, mt
    except Exception:
        pass
    return None, "image/jpeg"


# Compat (plus de navigateur ; no-op) ------------------------------------------
def close_driver() -> None:
    pass


def pool_stats() -> dict:
    with _clearance_lock:
        return {"backend": "flaresolverr+curl_cffi",
                "domains_cached": list(_clearance.keys())}
