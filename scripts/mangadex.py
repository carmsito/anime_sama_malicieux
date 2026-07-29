#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

API_BASE = "https://api.mangadex.org"
REQUEST_TIMEOUT = 20
RETRY_DELAYS = (0, 1, 2)
RATE_LIMIT_DELAY = 0.3
SEARCH_PAGE_SIZE = 10

LANG_NAMES: dict[str, str] = {
    "en": "Anglais",
    "fr": "Français",
    "es": "Espagnol",
    "es-la": "Espagnol latino",
    "pt-br": "Portugais (Brésil)",
    "pt": "Portugais",
    "de": "Allemand",
    "it": "Italien",
    "ru": "Russe",
    "ar": "Arabe",
    "ja": "Japonais",
    "ko": "Coréen",
    "zh": "Chinois simplifié",
    "zh-hk": "Chinois traditionnel",
    "vi": "Vietnamien",
    "id": "Indonésien",
    "tr": "Turc",
    "pl": "Polonais",
    "nl": "Néerlandais",
    "uk": "Ukrainien",
}


@dataclass
class MangaResult:
    id: str
    title: str
    year: int | None
    status: str


@dataclass
class ChapterInfo:
    id: str
    number: str
    title: str
    volume: str | None


def print_flush(msg: str) -> None:
    print(msg, flush=True)


def ch_key(s: str) -> float:
    try:
        return float(s)
    except ValueError:
        return 0.0


def sanitize_name(name: str) -> str:
    safe = re.sub(r'[\\/:*?"<>|]+', "_", name)
    return re.sub(r"\s+", " ", safe).strip() or "unknown"


def api_get(path: str, params: dict | None = None) -> dict:
    from urllib.parse import urlencode
    url = f"{API_BASE}{path}"
    if params:
        url += "?" + urlencode(params, doseq=True)

    req = Request(url, headers={"User-Agent": "mangadex-dl/1.0"})
    last_err: Exception | None = None

    for delay in RETRY_DELAYS:
        if delay:
            time.sleep(delay)
        try:
            with urlopen(req, timeout=REQUEST_TIMEOUT) as r:
                return json.loads(r.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError) as e:
            last_err = e

    raise RuntimeError(f"Requête impossible vers {url} : {last_err}")


def search_manga(query: str, limit: int, offset: int) -> tuple[list[MangaResult], int]:
    data = api_get("/manga", {
        "title": query,
        "limit": limit,
        "offset": offset,
        "order[relevance]": "desc",
    })
    results: list[MangaResult] = []
    for item in data.get("data", []):
        attrs = item["attributes"]
        titles = attrs.get("title", {})
        title = (
            titles.get("en")
            or titles.get("ja-ro")
            or next(iter(titles.values()), "?")
        )
        for alt in attrs.get("altTitles", []):
            if "en" in alt:
                title = alt["en"]
                break
        results.append(MangaResult(
            id=item["id"],
            title=title,
            year=attrs.get("year"),
            status=attrs.get("status", "?"),
        ))
    return results, data.get("total", 0)


def fetch_available_languages(manga_id: str) -> list[str]:
    data = api_get(f"/manga/{manga_id}")
    langs = data["data"]["attributes"].get("availableTranslatedLanguages") or []
    return [lang for lang in langs if lang]


def fetch_chapter_count(manga_id: str, lang: str) -> int:
    data = api_get("/chapter", {
        "manga": manga_id,
        "translatedLanguage[]": lang,
        "limit": 1,
    })
    return data.get("total", 0)


def fetch_chapters(manga_id: str, lang: str) -> dict[str, ChapterInfo]:
    chapters: dict[str, ChapterInfo] = {}
    offset = 0
    limit = 100

    while True:
        data = api_get("/chapter", {
            "manga": manga_id,
            "translatedLanguage[]": lang,
            "order[chapter]": "asc",
            "limit": limit,
            "offset": offset,
        })
        for item in data.get("data", []):
            attrs = item["attributes"]
            num = attrs.get("chapter") or "0"
            chapters[num] = ChapterInfo(
                id=item["id"],
                number=num,
                title=attrs.get("title") or "",
                volume=attrs.get("volume"),
            )
        total = data.get("total", 0)
        offset += limit
        if offset >= total:
            break
        time.sleep(RATE_LIMIT_DELAY)

    return chapters


def fetch_chapter_pages(chapter_id: str) -> tuple[str, str, list[str]]:
    data = api_get(f"/at-home/server/{chapter_id}")
    base_url = data["baseUrl"]
    ch = data["chapter"]
    return base_url, ch["hash"], ch["data"]


def prompt_choice(items: list[str], label: str, forced: int | None = None) -> int:
    if not items:
        raise RuntimeError(f"Aucune option pour : {label}.")
    if forced is not None:
        if 1 <= forced <= len(items):
            return forced - 1
        raise RuntimeError(f"Sélection invalide : {forced}")
    while True:
        raw = input(f"{label} [1-{len(items)}] : ").strip()
        if raw.isdigit() and 1 <= int(raw) <= len(items):
            return int(raw) - 1
        print_flush("Choix invalide.")


def prompt_chapter(label: str, sorted_nums: list[str], default: str) -> str:
    while True:
        raw = input(f"{label} [{default}] : ").strip() or default
        try:
            target = float(raw)
            return min(sorted_nums, key=lambda n: abs(ch_key(n) - target))
        except ValueError:
            print_flush("Nombre invalide.")


def select_manga(query: str, forced_result: int | None) -> MangaResult:
    offset = 0
    forced = forced_result

    while True:
        print_flush(f"\nRecherche '{query}'...")
        results, total = search_manga(query, SEARCH_PAGE_SIZE, offset)

        if not results:
            raise RuntimeError("Aucun résultat.")

        page_start = offset + 1
        page_end = offset + len(results)
        print_flush(f"\nRésultats ({page_start}-{page_end} sur {total}) :")
        for i, r in enumerate(results, start=1):
            year = f" ({r.year})" if r.year else ""
            print_flush(f"  {i}. {r.title}{year}  [{r.status}]")

        nav_items: list[str] = []
        if offset + SEARCH_PAGE_SIZE < total:
            nav_items.append(">>> Page suivante")
        if offset > 0:
            nav_items.append("<<< Page précédente")

        options = [r.title for r in results] + nav_items
        if nav_items:
            print_flush("")
            for i, nav in enumerate(nav_items, start=len(results) + 1):
                print_flush(f"  {i}. {nav}")

        idx = prompt_choice(options, "Choisis un manga", forced)
        forced = None

        choice = options[idx]
        if choice == ">>> Page suivante":
            offset += SEARCH_PAGE_SIZE
            continue
        if choice == "<<< Page précédente":
            offset = max(0, offset - SEARCH_PAGE_SIZE)
            continue

        return results[idx]


def download_range(
    chapters: dict[str, ChapterInfo],
    manga_title: str,
    lang: str,
    start: str,
    end: str,
) -> None:
    sorted_nums = sorted(chapters.keys(), key=ch_key)
    start_f, end_f = ch_key(start), ch_key(end)
    to_download = [n for n in sorted_nums if start_f <= ch_key(n) <= end_f]

    if not to_download:
        print_flush("Aucun chapitre dans cette plage.")
        return

    base_dir = Path("extraction") / sanitize_name(manga_title) / lang
    print_flush(f"\nTéléchargement de {len(to_download)} chapitre(s) → {base_dir}/")
    total_pages = 0

    for ch_num in to_download:
        ch = chapters[ch_num]
        ch_dir = base_dir / f"Chapitre {ch_num}"
        ch_dir.mkdir(parents=True, exist_ok=True)

        suffix = f" - {ch.title}" if ch.title else ""
        print_flush(f"\n[Chapitre {ch_num}{suffix}]")

        try:
            base_url, hash_, pages = fetch_chapter_pages(ch.id)
        except RuntimeError as e:
            print_flush(f"  Erreur : {e}")
            continue

        print_flush(f"  {len(pages)} page(s)")

        for i, filename in enumerate(pages, start=1):
            ext = filename.rsplit(".", 1)[-1]
            out = ch_dir / f"{i:03d}.{ext}"
            if out.exists():
                continue

            url = f"{base_url}/data/{hash_}/{filename}"
            req = Request(url, headers={"User-Agent": "mangadex-dl/1.0"})
            try:
                with urlopen(req, timeout=REQUEST_TIMEOUT) as r:
                    out.write_bytes(r.read())
                total_pages += 1
            except Exception as e:
                print_flush(f"  - page {i} : échec ({e})")

            time.sleep(RATE_LIMIT_DELAY)

        print_flush(f"  OK → {ch_dir}")

    print_flush(f"\nTerminé. {total_pages} page(s) téléchargée(s).")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Téléchargeur MangaDex interactif")
    p.add_argument("query", nargs="?", help="Titre du manga")
    p.add_argument("--result", type=int, help="Index du résultat (1-based)")
    p.add_argument("--lang", help="Code langue (ex: en, fr)")
    p.add_argument("--start", help="Chapitre de début")
    p.add_argument("--end", help="Chapitre de fin")
    p.add_argument("--yes", action="store_true", help="Confirme sans demander")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    query = (args.query or input("Quel manga ? ").strip()).strip()
    if not query:
        print_flush("Recherche vide.")
        return 1

    selected = select_manga(query, args.result)
    print_flush(f"\nManga sélectionné : {selected.title}")

    print_flush("Récupération des langues disponibles...")
    langs = fetch_available_languages(selected.id)
    if not langs:
        print_flush("Aucune traduction disponible.")
        return 1

    lang_labels = [f"{LANG_NAMES.get(l, l)} ({l})" for l in langs]

    if args.lang and args.lang in langs:
        lang_idx = langs.index(args.lang)
    else:
        if args.lang:
            print_flush(f"Langue '{args.lang}' non disponible.")
        print_flush("\nRécupération du nombre de chapitres par langue...")
        counts: list[int] = []
        for lang in langs:
            counts.append(fetch_chapter_count(selected.id, lang))
            time.sleep(RATE_LIMIT_DELAY)
        print_flush("\nLangues disponibles :")
        for i, (label, count) in enumerate(zip(lang_labels, counts), start=1):
            print_flush(f"  {i}. {label}  —  {count} chapitre(s)")
        lang_idx = prompt_choice(lang_labels, "Langue")

    selected_lang = langs[lang_idx]

    print_flush(f"\nRécupération des chapitres en {selected_lang}...")
    chapters = fetch_chapters(selected.id, selected_lang)
    if not chapters:
        print_flush("Aucun chapitre disponible dans cette langue.")
        return 1

    sorted_nums = sorted(chapters.keys(), key=ch_key)
    first, last = sorted_nums[0], sorted_nums[-1]
    print_flush(f"Chapitres disponibles : {first} → {last}  ({len(chapters)} chapitres)")

    start_ch = args.start if args.start else prompt_chapter("Chapitre début", sorted_nums, first)
    end_ch = args.end if args.end else prompt_chapter("Chapitre fin", sorted_nums, last)

    if ch_key(start_ch) > ch_key(end_ch):
        print_flush("Le chapitre de début doit être ≤ au chapitre de fin.")
        return 1

    count = len([n for n in sorted_nums if ch_key(start_ch) <= ch_key(n) <= ch_key(end_ch)])
    print_flush(f"\n{count} chapitre(s) à télécharger ({start_ch} → {end_ch})")

    if not args.yes:
        answer = input("Télécharger ? [O/n] : ").strip().lower()
        if answer in {"n", "non", "no"}:
            print_flush("Annulé.")
            return 0

    download_range(chapters, selected.title, selected_lang, start_ch, end_ch)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print_flush("\nInterrompu.")
        raise SystemExit(130)
    except RuntimeError as e:
        print_flush(f"Erreur : {e}")
        raise SystemExit(1)
