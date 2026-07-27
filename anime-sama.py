#!/usr/bin/env python3
from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import ssl
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urljoin, urlparse
from urllib.request import Request, urlopen

# Import split and epub utilities from the same directory
sys.path.insert(0, str(Path(__file__).parent))
from split_manga import split_fixed  # noqa: E402
from make_epub import create_epub    # noqa: E402


DEFAULT_PAGE_HEIGHT = 1878

MIRRORS = [
    ("https://anime-sama.to/", True),
    ("https://anime-sama.tv/", True),
    ("https://anime-sama.si/", True),
    ("https://anime-sama.org/", True),
    ("https://179.43.149.218/", False),
]
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)
REQUEST_TIMEOUT = 20
RETRY_DELAYS = (0, 1, 2)


@dataclass
class SearchResult:
    title: str
    subtitle: str
    url: str


@dataclass
class ScanCategory:
    label: str
    url: str


def print_flush(message: str) -> None:
    print(message, flush=True)


def request_bytes(url: str, *, data: dict[str, str] | None = None, verify_ssl: bool = True) -> tuple[bytes, str, dict[str, str]]:
    payload = None
    headers = {"User-Agent": USER_AGENT}
    if data is not None:
        payload = urlencode(data).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"

    request = Request(url, data=payload, headers=headers)
    context = None if verify_ssl else ssl._create_unverified_context()
    last_error: Exception | None = None

    for delay in RETRY_DELAYS:
        if delay:
            time.sleep(delay)
        try:
            with urlopen(request, timeout=REQUEST_TIMEOUT, context=context) as response:
                return response.read(), response.geturl(), dict(response.headers.items())
        except (HTTPError, URLError, TimeoutError, ssl.SSLError, ValueError) as error:
            last_error = error

    raise RuntimeError(f"Requete impossible vers {url}: {last_error}")


def request_text(url: str, *, data: dict[str, str] | None = None, verify_ssl: bool = True) -> tuple[str, str]:
    body, final_url, _headers = request_bytes(url, data=data, verify_ssl=verify_ssl)
    return body.decode("utf-8", errors="ignore"), final_url


def request_json(url: str, *, verify_ssl: bool = True) -> dict[str, int]:
    text, _final_url = request_text(url, verify_ssl=verify_ssl)
    return json.loads(text)


def resolve_base_url() -> tuple[str, bool]:
    for candidate, verify_ssl in MIRRORS:
        try:
            body, final_url, _headers = request_bytes(candidate, verify_ssl=verify_ssl)
        except RuntimeError:
            continue
        if b"Anime-Sama" not in body:
            continue
        parsed = urlparse(final_url)
        return f"{parsed.scheme}://{parsed.netloc}/", verify_ssl
    raise RuntimeError("Impossible de joindre un miroir Anime-Sama fonctionnel.")


def strip_tags(raw_html: str) -> str:
    text = re.sub(r"<[^>]+>", "", raw_html)
    return html.unescape(text).strip()


def search_scans(base_url: str, verify_ssl: bool, query: str) -> list[SearchResult]:
    endpoint = urljoin(base_url, "template-php/defaut/fetch.php")
    page, _final_url = request_text(endpoint, data={"query": query}, verify_ssl=verify_ssl)

    pattern = re.compile(
        r'<a href="(?P<href>[^"]+)" class="asn-search-result">.*?'
        r"<h3[^>]*>(?P<title>.*?)</h3>.*?"
        r"<p[^>]*>(?P<subtitle>.*?)</p>",
        re.IGNORECASE | re.DOTALL,
    )

    results: list[SearchResult] = []
    seen_urls: set[str] = set()
    for match in pattern.finditer(page):
        href = html.unescape(match.group("href").strip())
        full_url = urljoin(base_url, href)
        if full_url in seen_urls:
            continue
        seen_urls.add(full_url)
        results.append(
            SearchResult(
                title=strip_tags(match.group("title")) or "(sans titre)",
                subtitle=strip_tags(match.group("subtitle")),
                url=full_url,
            )
        )
    return results


def fetch_scan_categories(base_url: str, verify_ssl: bool, work_url: str) -> list[ScanCategory]:
    page, final_url = request_text(work_url, verify_ssl=verify_ssl)
    pattern = re.compile(r'panneauScan\("(?P<label>.*?)",\s*"(?P<path>.*?)"\);')

    categories: list[ScanCategory] = []
    seen_urls: set[str] = set()
    for match in pattern.finditer(page):
        label = html.unescape(match.group("label")).strip()
        path = html.unescape(match.group("path")).strip()
        if not path or path.lower() == "url":
            continue
        full_url = urljoin(final_url, path)
        if full_url in seen_urls:
            continue
        seen_urls.add(full_url)
        categories.append(ScanCategory(label=label, url=full_url))

    if categories:
        return categories

    fallback = re.findall(r'href="([^"]*scan[^"]*)"', page, flags=re.IGNORECASE)
    for path in fallback:
        full_url = urljoin(final_url, html.unescape(path))
        if full_url in seen_urls:
            continue
        seen_urls.add(full_url)
        categories.append(ScanCategory(label=full_url.rstrip("/").split("/")[-2], url=full_url))
    return categories


def fetch_scan_title(category_url: str, verify_ssl: bool) -> str:
    page, _final_url = request_text(category_url, verify_ssl=verify_ssl)
    match = re.search(r'id="titreOeuvre"[^>]*>(.*?)</h3>', page, re.IGNORECASE | re.DOTALL)
    if not match:
        raise RuntimeError("Impossible de trouver le titre du scan sur la page.")
    return strip_tags(match.group(1))


def fetch_chapter_map(base_url: str, verify_ssl: bool, scan_title: str) -> dict[int, int]:
    endpoint = urljoin(base_url, f"s2/scans/get_nb_chap_et_img.php?oeuvre={quote(scan_title, safe='')}")
    raw_data = request_json(endpoint, verify_ssl=verify_ssl)

    chapters: dict[int, int] = {}
    for chapter_key, image_count in raw_data.items():
        try:
            chapter_number = int(chapter_key)
            chapters[chapter_number] = int(image_count)
        except (TypeError, ValueError):
            continue

    if not chapters:
        raise RuntimeError(f"Aucun chapitre numerique trouve pour {scan_title}.")
    return chapters


def sanitize_name(name: str) -> str:
    safe = re.sub(r'[\\/:*?"<>|]+', "_", name)
    safe = re.sub(r"\s+", " ", safe).strip()
    return safe or "unknown"


def prompt_choice(items: list[str], label: str, forced_index: int | None = None) -> int:
    if not items:
        raise RuntimeError(f"Aucune option disponible pour {label}.")

    if forced_index is not None:
        if 1 <= forced_index <= len(items):
            return forced_index - 1
        raise RuntimeError(f"Selection invalide pour {label}: {forced_index}")

    while True:
        user_input = input(f"{label} [1-{len(items)}] : ").strip()
        if not user_input:
            print_flush("Choix obligatoire.")
            continue
        if user_input.isdigit() and 1 <= int(user_input) <= len(items):
            return int(user_input) - 1
        print_flush("Choix invalide.")


def prompt_int(label: str, default_value: int | None = None) -> int:
    while True:
        suffix = f" [{default_value}]" if default_value is not None else ""
        user_input = input(f"{label}{suffix} : ").strip()
        if not user_input and default_value is not None:
            return default_value
        if user_input.isdigit():
            return int(user_input)
        print_flush("Nombre invalide.")


def should_download(default_yes: bool) -> bool:
    if default_yes:
        return True
    answer = input("Telecharger maintenant ? [o/N] : ").strip().lower()
    return answer in {"o", "oui", "y", "yes"}


def build_image_url(base_url: str, scan_title: str, chapter: int, page: int) -> str:
    encoded_title = quote(scan_title, safe="")
    return urljoin(base_url, f"s2/scans/{encoded_title}/{chapter}/{page}.jpg")


def download_range(
    *,
    base_url: str,
    verify_ssl: bool,
    scan_title: str,
    manga_name: str,
    category_name: str,
    chapter_map: dict[int, int],
    start_chapter: int,
    end_chapter: int,
    make_epub: bool = False,
    keep_images: bool = False,
    page_height: int = DEFAULT_PAGE_HEIGHT,
) -> None:
    total_downloaded = 0
    base_dir = Path("extraction") / sanitize_name(manga_name) / sanitize_name(category_name)

    for chapter in range(start_chapter, end_chapter + 1):
        image_count = chapter_map.get(chapter)
        if image_count is None:
            print_flush(f"[Chapitre {chapter}] absent, ignore.")
            continue

        chapter_dir = base_dir / f"Chapitre {chapter}"
        chapter_dir.mkdir(parents=True, exist_ok=True)
        downloaded_in_chapter = 0
        print_flush(f"[Chapitre {chapter}] {image_count} page(s)")

        for page_number in range(1, image_count + 1):
            output_path = chapter_dir / f"{page_number}.jpg"
            if output_path.exists():
                continue

            image_url = build_image_url(base_url, scan_title, chapter, page_number)
            try:
                payload, _final_url, headers = request_bytes(image_url, verify_ssl=verify_ssl)
            except RuntimeError as error:
                print_flush(f"  - page {page_number}: echec ({error})")
                break

            content_type = headers.get("Content-Type", "")
            if content_type.startswith("text/") or b"Page introuvable" in payload[:512]:
                print_flush(f"  - page {page_number}: contenu invalide, arret du chapitre")
                break

            output_path.write_bytes(payload)
            downloaded_in_chapter += 1
            total_downloaded += 1

        print_flush(f"[Chapitre {chapter}] telecharge {downloaded_in_chapter} nouvelle(s) page(s)")

        if make_epub:
            try:
                process_chapter_epub(chapter_dir, manga_name, chapter, page_height, keep_images)
            except Exception as err:
                print_flush(f"[Chapitre {chapter}] Erreur EPUB : {err}")

    print_flush(f"Termine. {total_downloaded} nouvelle(s) page(s) telechargee(s).")


def _sorted_source_files(chapter_dir: Path) -> list[Path]:
    """Return downloaded source files (1.jpg, 2.jpg, ...) sorted numerically."""
    files = [p for p in chapter_dir.iterdir() if p.suffix.lower() == ".jpg" and p.stem.isdigit()]
    return sorted(files, key=lambda p: int(p.stem))


def _image_height(img_path: Path) -> int:
    import subprocess as _sp
    result = _sp.run(
        ['identify', '-format', '%h', str(img_path)],
        capture_output=True, text=True, check=True
    )
    return int(result.stdout.strip())


def prompt_keep_images(forced: bool | None) -> bool:
    """Ask the user if they want to keep the images folder."""
    if forced is not None:
        return forced
    answer = input("Conserver le dossier images ? [o/N] : ").strip().lower()
    return answer in {"o", "oui", "y", "yes"}


def process_chapter_epub(
    chapter_dir: Path,
    manga_name: str,
    chapter_number: int,
    page_height: int,
    keep_images: bool,
) -> None:
    """Split downloaded source files (if merged), create EPUB, optionally keep images."""
    source_files = _sorted_source_files(chapter_dir)
    if not source_files:
        print_flush(f"[Chapitre {chapter_number}] Aucune source a decouper.")
        return

    images_dir = chapter_dir / "images"
    images_dir.mkdir(exist_ok=True)
    all_pages: list[Path] = []

    # Detect if pages are already split (height ≈ page_height) or merged
    first_height = _image_height(source_files[0])
    needs_split = first_height > page_height

    if needs_split:
        print_flush(f"[Chapitre {chapter_number}] Images fusionnees detectees ({first_height}px) — decoupage en cours...")
        tmp_dirs: list[Path] = []
        for source in source_files:
            tmp = chapter_dir / f"_tmp_{source.stem}"
            pages = split_fixed(str(source), tmp, page_height=page_height)
            all_pages.extend(pages)
            tmp_dirs.append(tmp)
        for global_idx, page in enumerate(all_pages, start=1):
            shutil.copy2(page, images_dir / f"{global_idx:03d}.jpg")
        for tmp in tmp_dirs:
            shutil.rmtree(tmp, ignore_errors=True)
    else:
        print_flush(f"[Chapitre {chapter_number}] Pages deja decoupees ({first_height}px) — renumerotation...")
        for global_idx, source in enumerate(source_files, start=1):
            shutil.copy2(source, images_dir / f"{global_idx:03d}.jpg")
        all_pages = list(images_dir.iterdir())

    epub_title = f"{manga_name} - Chapitre {chapter_number}"
    epub_path = chapter_dir.parent / f"Chapitre {chapter_number}.epub"
    print_flush(f"[Chapitre {chapter_number}] Creation EPUB ({len(all_pages)} pages)...")
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
    print_flush(f"[Chapitre {chapter_number}] EPUB : {epub_path}")

    if not keep_images:
        shutil.rmtree(images_dir, ignore_errors=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Recherche et telechargement de scans Anime-Sama sans Selenium.")
    parser.add_argument("query", nargs="?", help="Recherche initiale")
    parser.add_argument("--result", type=int, help="Index du resultat a ouvrir (1-based)")
    parser.add_argument("--category", type=int, help="Index de la categorie scan a ouvrir (1-based)")
    parser.add_argument("--start", type=int, help="Chapitre de debut")
    parser.add_argument("--end", type=int, help="Chapitre de fin")
    parser.add_argument("--yes", action="store_true", help="Lance le telechargement sans confirmation")
    parser.add_argument("--no-epub", action="store_true", help="Ne cree pas d'EPUB apres le telechargement")
    parser.add_argument("--keep-images", action="store_true", default=None,
                        help="Conserve le dossier images/ apres creation de l'EPUB (demande si absent)")
    parser.add_argument("--no-images", action="store_true", help="Supprime les images sans demander")
    parser.add_argument("--page-height", type=int, default=DEFAULT_PAGE_HEIGHT,
                        help=f"Hauteur de page en pixels pour le decoupage (defaut: {DEFAULT_PAGE_HEIGHT})")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    base_url, verify_ssl = resolve_base_url()
    print_flush(f"Miroir detecte : {base_url}")

    query = (args.query or input("Quel scan veux-tu regarder ? ").strip()).strip()
    if not query:
        print_flush("Recherche vide.")
        return 1

    results = search_scans(base_url, verify_ssl, query)
    if not results:
        print_flush("Aucun resultat.")
        return 1

    print_flush("")
    print_flush("Resultats trouves :")
    for index, result in enumerate(results, start=1):
        subtitle = f" - {result.subtitle}" if result.subtitle else ""
        print_flush(f"{index}. {result.title}{subtitle}")

    result_index = prompt_choice([item.title for item in results], "Choisis un manga", args.result)
    selected_result = results[result_index]

    categories = fetch_scan_categories(base_url, verify_ssl, selected_result.url)
    if not categories:
        print_flush("Aucune categorie scan detectee sur cette oeuvre.")
        return 1

    print_flush("")
    print_flush("Categories disponibles :")
    for index, category in enumerate(categories, start=1):
        print_flush(f"{index}. {category.label}")

    category_index = prompt_choice([item.label for item in categories], "Choisis une categorie", args.category)
    selected_category = categories[category_index]

    scan_title = fetch_scan_title(selected_category.url, verify_ssl)
    chapter_map = fetch_chapter_map(base_url, verify_ssl, scan_title)
    first_chapter = min(chapter_map)
    last_chapter = max(chapter_map)

    print_flush("")
    print_flush(f"Scan detecte : {scan_title}")
    print_flush(f"Chapitres disponibles : {first_chapter} -> {last_chapter}")

    start_chapter = args.start if args.start is not None else prompt_int("Chapitre debut", first_chapter)
    end_chapter = args.end if args.end is not None else prompt_int("Chapitre fin", last_chapter)

    if start_chapter > end_chapter:
        raise RuntimeError("Le chapitre de debut doit etre <= au chapitre de fin.")

    if not should_download(args.yes):
        print_flush("Telechargement annule.")
        return 0

    make_epub = not args.no_epub
    # Determine keep_images: --keep-images forces True, --no-images forces False, else ask once
    if args.no_images:
        keep_images: bool | None = False
    elif args.keep_images:
        keep_images = True
    elif make_epub and not args.yes:
        keep_images = prompt_keep_images(None)
    else:
        keep_images = False

    download_range(
        base_url=base_url,
        verify_ssl=verify_ssl,
        scan_title=scan_title,
        manga_name=selected_result.title,
        category_name=selected_category.label,
        chapter_map=chapter_map,
        start_chapter=start_chapter,
        end_chapter=end_chapter,
        make_epub=make_epub,
        keep_images=keep_images,
        page_height=args.page_height,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print_flush("\nInterrompu.")
        raise SystemExit(130)
    except RuntimeError as error:
        print_flush(f"Erreur: {error}")
        raise SystemExit(1)
