#!/usr/bin/env python3
"""
split_manga.py - Découpe une image manga fusionnée en pages individuelles.

Usage:
    python3 split_manga.py <image.jpg> [dossier_sortie] [--min-page N]

Si dossier_sortie est omis, crée un dossier du même nom que l'image (sans extension).
--min-page N : hauteur minimale d'une page en pixels (défaut: 300)
"""

import subprocess
import re
import os
import sys


def get_dimensions(img_path):
    result = subprocess.run(
        ['identify', '-format', '%wx%h', img_path],
        capture_output=True, text=True, check=True
    )
    w, h = map(int, result.stdout.strip().split('x'))
    return w, h


def get_row_brightness(img_path, h):
    """Brightness grayscale moyenne par ligne (gère images couleur et N&B)."""
    proc = subprocess.run(
        ['magick', img_path, '-colorspace', 'Gray', '-resize', f'1x{h}!', 'txt:-'],
        capture_output=True, text=True
    )
    rows = []
    for line in proc.stdout.splitlines():
        m = re.match(r'0,\d+: \((\d+)', line)
        if m:
            rows.append(int(m.group(1)))
    return rows


def get_margin_brightness(img_path, h, margin_px=60):
    """Brightness grayscale moyenne par ligne dans la marge droite."""
    w, _ = get_dimensions(img_path)
    proc = subprocess.run(
        ['magick', img_path,
         '-colorspace', 'Gray',
         '-crop', f'{margin_px}x{h}+{w - margin_px}+0',
         '-resize', f'1x{h}!', 'txt:-'],
        capture_output=True, text=True
    )
    rows = []
    for line in proc.stdout.splitlines():
        m = re.match(r'0,\d+: \((\d+)', line)
        if m:
            rows.append(int(m.group(1)))
    return rows


def find_zones(rows, threshold, cmp='gt', min_run=25, merge_gap=15):
    """
    Trouve des zones consécutives selon un seuil de luminosité.
    cmp='gt' → luminosité > threshold (zones blanches)
    cmp='lt' → luminosité < threshold (zones sombres)
    """
    raw = []
    start = None
    for y, b in enumerate(rows):
        hit = (b > threshold) if cmp == 'gt' else (b < threshold)
        if hit:
            if start is None:
                start = y
        else:
            if start is not None and (y - start) >= min_run:
                raw.append([start, y - 1])
            start = None
    if start is not None and (len(rows) - start) >= min_run:
        raw.append([start, len(rows) - 1])

    merged = []
    for z in raw:
        if merged and z[0] - merged[-1][1] <= merge_gap:
            merged[-1][1] = z[1]
        else:
            merged.append(list(z))
    return merged


def merge_close_zones(zones, gap):
    """Fusionne toutes les zones séparées par moins de `gap` pixels."""
    if not zones:
        return zones
    merged = [zones[0][:]]
    for z in zones[1:]:
        if z[0] - merged[-1][1] <= gap:
            merged[-1][1] = z[1]
        else:
            merged.append(z[:])
    return merged


def find_secondary_break(section_start, section_end, margin_rows,
                         margin_threshold=240, min_white_run=40):
    """
    Pour une section trop haute (pages collées sans séparateur),
    cherche la fin de la première page via la marge droite.
    """
    section = margin_rows[section_start:section_end]
    n = len(section)

    white_zones = []
    start = None
    for i, b in enumerate(section):
        if b > margin_threshold:
            if start is None:
                start = i
        else:
            if start is not None and (i - start) >= min_white_run:
                white_zones.append((section_start + start, section_start + i - 1))
            start = None
    if start is not None and (n - start) >= min_white_run:
        white_zones.append((section_start + start, section_start + n - 1))

    section_70pct = section_start + (section_end - section_start) * 7 // 10
    candidates = [z for z in white_zones if z[1] < section_70pct]
    if not candidates:
        return None

    best = max(candidates, key=lambda z: z[1])
    return best[1] + 1


def compute_cuts(img_path, max_ratio=1.8, min_page=300):
    w, h = get_dimensions(img_path)
    print(f"Image: {w}x{h} px")

    rows = get_row_brightness(img_path, h)

    # Détection des zones blanches (séparateurs blancs entre pages)
    white_zones = find_zones(rows, threshold=240, cmp='gt', min_run=25, merge_gap=15)
    # Détection des zones sombres (bannières titre comme KATEKYO HITMAN REBORN)
    dark_zones  = find_zones(rows, threshold=90,  cmp='lt', min_run=25, merge_gap=15)

    # Combiner et trier tous les séparateurs
    all_zones = sorted(white_zones + dark_zones, key=lambda z: z[0])
    # Fusionner les séparateurs proches (jusqu'à 200px d'écart = une même zone de transition)
    all_zones = merge_close_zones(all_zones, gap=200)

    print(f"\nSéparateurs détectés ({len(all_zones)}):")
    for s, e in all_zones:
        avg = sum(rows[s:e+1]) / (e - s + 1)
        kind = "blanc" if avg > 150 else "sombre"
        print(f"  y={s}-{e} ({e-s+1}px, {kind}, moy={avg:.0f})")

    # Construire les coupures au milieu de chaque séparateur
    raw_cuts = [0]
    for s, e in all_zones:
        raw_cuts.append((s + e) // 2)
    raw_cuts.append(h)

    # Filtrer les sections trop petites : fusionner avec la plus petite section voisine
    cuts = raw_cuts[:]
    changed = True
    while changed:
        changed = False
        new_cuts = [cuts[0]]
        i = 1
        while i < len(cuts) - 1:
            page_h = cuts[i] - new_cuts[-1]
            if page_h < min_page:
                # Skip ce cut (fusionne avec la section précédente)
                changed = True
            else:
                new_cuts.append(cuts[i])
            i += 1
        new_cuts.append(cuts[-1])
        cuts = new_cuts

    # Vérifier encore une fois (dernière section)
    if len(cuts) >= 2 and (cuts[-1] - cuts[-2]) < min_page:
        cuts = cuts[:-1]

    # Détection secondaire pour les sections encore trop hautes
    margin_rows = get_margin_brightness(img_path, h)
    extra_cuts = []
    for y_start, y_end in zip(cuts[:-1], cuts[1:]):
        ratio = (y_end - y_start) / w
        if ratio > max_ratio:
            cut = find_secondary_break(y_start, y_end, margin_rows)
            if cut:
                print(f"\nCoupure secondaire à y={cut} dans section {y_start}-{y_end}")
                extra_cuts.append(cut)

    all_cuts = sorted(set(cuts + extra_cuts))

    # Calculer la taille minimale de page
    pages = list(zip(all_cuts[:-1], all_cuts[1:]))
    page_heights = [e - s for s, e in pages]
    min_h = min(page_heights)
    max_h = max(page_heights)
    print(f"\nTaille min de page: {min_h}px (ratio={min_h/w:.2f})")
    print(f"Taille max de page: {max_h}px (ratio={max_h/w:.2f})")

    return w, h, all_cuts


def split_image(img_path, output_dir, min_page=300, dry_run=False):
    os.makedirs(output_dir, exist_ok=True)
    w, h, cuts = compute_cuts(img_path, min_page=min_page)

    print(f"\nPages à créer ({len(cuts)-1}):")
    for i, (y_start, y_end) in enumerate(zip(cuts[:-1], cuts[1:]), 1):
        page_h = y_end - y_start
        ratio = page_h / w
        out_path = os.path.join(output_dir, f"{i:02d}.jpg")
        print(f"  Page {i:2d}: y={y_start:5d}-{y_end:5d} ({page_h:4d}px, ratio={ratio:.2f}) → {os.path.basename(out_path)}")
        if not dry_run:
            subprocess.run([
                'magick', img_path,
                '-crop', f'{w}x{page_h}+0+{y_start}',
                '+repage',
                out_path
            ], check=True)
    if not dry_run:
        print(f"\nDone. {len(cuts)-1} pages sauvegardées dans {output_dir}/")


def split_fixed(img_path: str, output_dir, page_height: int = 1878) -> list:
    """
    Découpe une image en pages de hauteur fixe (gabarit).
    Retourne la liste des fichiers créés, triés dans l'ordre.
    """
    from pathlib import Path
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    w, h = get_dimensions(str(img_path))
    n_full = h // page_height
    remainder = h % page_height

    pages = []
    for i in range(n_full):
        y = i * page_height
        out = output_dir / f"{i + 1:02d}.jpg"
        subprocess.run(
            ['magick', str(img_path), '-crop', f'{w}x{page_height}+0+{y}', '+repage', str(out)],
            check=True, capture_output=True
        )
        pages.append(out)

    if remainder > 0:
        y = n_full * page_height
        out = output_dir / f"{n_full + 1:02d}.jpg"
        subprocess.run(
            ['magick', str(img_path), '-crop', f'{w}x{remainder}+0+{y}', '+repage', str(out)],
            check=True, capture_output=True
        )
        pages.append(out)

    return pages


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    img = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) >= 3 else os.path.splitext(img)[0]

    min_p = 300
    page_h = None
    for i, arg in enumerate(sys.argv):
        if arg == '--min-page' and i + 1 < len(sys.argv):
            min_p = int(sys.argv[i + 1])
        if arg == '--page-height' and i + 1 < len(sys.argv):
            page_h = int(sys.argv[i + 1])

    if page_h is not None:
        pages = split_fixed(img, out, page_height=page_h)
        print(f"Done. {len(pages)} pages → {out}/")
    else:
        split_image(img, out, min_page=min_p)
