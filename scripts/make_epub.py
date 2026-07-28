#!/usr/bin/env python3

from __future__ import annotations

import argparse
import html
import mimetypes
import re
import shutil
import subprocess
import uuid
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


def natural_sort_key(path: Path) -> list[object]:
    parts = re.split(r"(\d+)", path.name)
    key: list[object] = []
    for part in parts:
        if part.isdigit():
            key.append(int(part))
        else:
            key.append(part.lower())
    return key


def find_images(chapter_dir: Path) -> list[Path]:
    images = [
        path
        for path in chapter_dir.iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    ]
    return sorted(images, key=natural_sort_key)


def guess_media_type(path: Path) -> str:
    media_type, _ = mimetypes.guess_type(path.name)
    if not media_type:
        raise ValueError(f"Type MIME inconnu pour {path}")
    return media_type


def get_image_dimensions(path: Path) -> tuple[int, int]:
    magick_binary = shutil.which("magick")
    if not magick_binary:
        raise RuntimeError("ImageMagick est requis pour lire les dimensions des images.")

    command = [magick_binary, "identify", "-format", "%w %h", str(path)]
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    width_str, height_str = result.stdout.strip().split()
    return int(width_str), int(height_str)


def reset_optimization_stats() -> None:
    optimize_images._temp_dir = None  # type: ignore[attr-defined]
    optimize_images._stats = {  # type: ignore[attr-defined]
        "converted": 0,
        "kept_original": 0,
        "source_bytes": 0,
        "output_bytes": 0,
    }


def get_optimization_stats() -> dict[str, int]:
    return getattr(optimize_images, "_stats", {})


def optimize_images(
    images: list[Path],
    image_format: str,
    quality: int,
    max_width: int | None,
) -> list[Path]:
    reset_optimization_stats()
    if image_format == "original":
        stats = get_optimization_stats()
        total_bytes = sum(image.stat().st_size for image in images)
        stats["kept_original"] = len(images)
        stats["source_bytes"] = total_bytes
        stats["output_bytes"] = total_bytes
        return images

    magick_binary = shutil.which("magick")
    if not magick_binary:
        raise RuntimeError("ImageMagick est requis pour compresser les images.")

    converted_images: list[Path] = []
    temp_dir = TemporaryDirectory(prefix="epub_images_")

    try:
        for index, image in enumerate(images, start=1):
            stats = get_optimization_stats()
            stats["source_bytes"] += image.stat().st_size
            output_name = f"{index:03d}.webp"
            output_path = Path(temp_dir.name) / output_name
            command = [
                magick_binary,
                str(image),
                "-strip",
            ]
            if max_width:
                command.extend(["-resize", f"{max_width}x>"])
            command.extend(["-quality", str(quality), str(output_path)])

            subprocess.run(command, check=True, capture_output=True)

            if output_path.stat().st_size >= image.stat().st_size:
                stats["kept_original"] += 1
                stats["output_bytes"] += image.stat().st_size
                converted_images.append(image)
                continue

            stats["converted"] += 1
            stats["output_bytes"] += output_path.stat().st_size
            converted_images.append(output_path)

        optimize_images._temp_dir = temp_dir  # type: ignore[attr-defined]
        return converted_images
    except Exception:
        temp_dir.cleanup()
        raise


def build_page(title: str, image_name: str, width: int, height: int) -> str:
    safe_title = html.escape(title)
    safe_image_name = html.escape(image_name)
    return f"""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="fr">
  <head>
    <title>{safe_title}</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width={width},height={height}" />
    <style>
      @page {{
        margin: 0;
        size: {width}px {height}px;
      }}
      html, body {{
        margin: 0 !important;
        padding: 0 !important;
        background: #000;
        width: 100%;
        height: 100%;
      }}
      img {{
        display: block;
        width: 100%;
        height: 100%;
      }}
    </style>
  </head>
  <body>
    <img src="../images/{safe_image_name}" alt="{safe_title}" />
  </body>
</html>
"""


def build_content_opf(
    book_id: str,
    title: str,
    language: str,
    author: str,
    images: list[Path],
) -> str:
    manifest_items = [
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
    ]
    spine_items = []

    for index, image in enumerate(images, start=1):
        page_id = f"page{index}"
        image_id = f"img{index}"
        page_name = f"text/page-{index:03d}.xhtml"
        image_name = f"images/{image.name}"
        manifest_items.append(
            f'<item id="{page_id}" href="{page_name}" media-type="application/xhtml+xml"/>'
        )
        cover_prop = ' properties="cover-image"' if index == 1 else ""
        manifest_items.append(
            f'<item id="{image_id}" href="{image_name}" media-type="{guess_media_type(image)}"{cover_prop}/>'
        )
        spine_items.append(f'<itemref idref="{page_id}"/>')

    manifest = "\n    ".join(manifest_items)
    spine = "\n    ".join(spine_items)
    safe_title = html.escape(title)
    safe_author = html.escape(author)

    return f"""<?xml version="1.0" encoding="utf-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">{book_id}</dc:identifier>
    <dc:title>{safe_title}</dc:title>
    <dc:language>{language}</dc:language>
    <dc:creator>{safe_author}</dc:creator>
    <meta name="cover" content="img1"/>
    <meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:spread">none</meta>
    <meta property="rendition:orientation">portrait</meta>
  </metadata>
  <manifest>
    {manifest}
  </manifest>
  <spine>
    {spine}
  </spine>
</package>
"""


def build_nav(title: str, images: list[Path]) -> str:
    safe_title = html.escape(title)
    links = []
    for index, _image in enumerate(images, start=1):
        links.append(
            f'<li><a href="text/page-{index:03d}.xhtml">Page {index}</a></li>'
        )
    nav_items = "\n        ".join(links)
    return f"""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="fr">
  <head>
    <title>{safe_title}</title>
    <meta charset="utf-8" />
  </head>
  <body>
    <nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops" id="toc">
      <h1>{safe_title}</h1>
      <ol>
        {nav_items}
      </ol>
    </nav>
  </body>
</html>
"""


def create_epub(
    chapter_dir: Path,
    output_file: Path,
    title: str,
    author: str,
    language: str,
    image_format: str,
    quality: int,
    max_width: int | None,
) -> None:
    images = find_images(chapter_dir)
    if not images:
        raise ValueError(f"Aucune image trouvee dans {chapter_dir}")

    source_images = optimize_images(images, image_format, quality, max_width)
    book_id = f"urn:uuid:{uuid.uuid4()}"

    with zipfile.ZipFile(output_file, "w") as epub:
        epub.writestr(
            "mimetype",
            "application/epub+zip",
            compress_type=zipfile.ZIP_STORED,
        )
        epub.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
""",
        )
        epub.writestr(
            "OEBPS/content.opf",
            build_content_opf(book_id, title, language, author, source_images),
        )
        epub.writestr("OEBPS/nav.xhtml", build_nav(title, source_images))

        for index, image in enumerate(source_images, start=1):
            width, height = get_image_dimensions(image)
            epub.write(image, arcname=f"OEBPS/images/{image.name}")
            epub.writestr(
                f"OEBPS/text/page-{index:03d}.xhtml",
                build_page(f"{title} - Page {index}", image.name, width, height),
            )

    temp_dir = getattr(optimize_images, "_temp_dir", None)
    if temp_dir:
        temp_dir.cleanup()
        delattr(optimize_images, "_temp_dir")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Cree un fichier EPUB a partir d'un dossier d'images."
    )
    parser.add_argument("chapter_dir", type=Path, help="Dossier contenant les images")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Chemin du fichier EPUB a creer",
    )
    parser.add_argument("--title", help="Titre du livre")
    parser.add_argument("--author", default="Inconnu", help="Auteur du livre")
    parser.add_argument("--language", default="fr", help="Langue du livre")
    parser.add_argument(
        "--image-format",
        choices=["original", "webp"],
        default="webp",
        help="Format des images integrees dans l'EPUB",
    )
    parser.add_argument(
        "--quality",
        type=int,
        default=82,
        help="Qualite de compression pour WebP (0-100)",
    )
    parser.add_argument(
        "--max-width",
        type=int,
        help="Redimensionne les images si elles depassent cette largeur",
    )
    args = parser.parse_args()

    chapter_dir = args.chapter_dir.resolve()
    title = args.title or chapter_dir.name
    output_file = args.output or chapter_dir.with_suffix(".epub")

    create_epub(
        chapter_dir,
        output_file,
        title,
        args.author,
        args.language,
        args.image_format,
        args.quality,
        args.max_width,
    )
    stats = get_optimization_stats()
    print(
        "Images: "
        f"{stats.get('converted', 0)} converties, "
        f"{stats.get('kept_original', 0)} gardees en original, "
        f"{stats.get('source_bytes', 0)} -> {stats.get('output_bytes', 0)} octets"
    )
    print(f"EPUB cree: {output_file}")


if __name__ == "__main__":
    main()
