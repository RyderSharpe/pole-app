#!/usr/bin/env python3
"""Opens files made by the app with other programs' libraries, and prints what it finds as JSON.

The browser tests call this so that an export is never judged only by the code that wrote it.

  inspect_files.py make-images <folder>     writes the test pictures
  inspect_files.py pdf <file>               pages, text, pictures and a structure check of a PDF
                                            (pypdf, and poppler-utils and qpdf if installed)
  inspect_files.py zip <file>               entries of a ZIP file, after checking every checksum
  inspect_files.py image <file>             size and a few colours of a picture (Pillow)
  inspect_files.py csv <file>               rows of a CSV file (Python's csv module)

Needs: pip install pypdf Pillow, and the poppler-utils and qpdf programs
"""
import csv
import io
import json
import sys
import zipfile
from pathlib import Path


def make_images(folder):
    from PIL import Image, ImageDraw

    out = Path(folder)
    out.mkdir(parents=True, exist_ok=True)

    def scene(width, height, colour, text):
        image = Image.new("RGB", (width, height), colour)
        d = ImageDraw.Draw(image)
        # A pole-like bar and a red block in the top-left corner, so orientation can be checked.
        d.rectangle([width * 0.47, height * 0.1, width * 0.53, height * 0.95], fill=(90, 60, 30))
        d.rectangle([0, 0, width * 0.2, height * 0.2], fill=(220, 30, 30))
        d.text((width * 0.25, height * 0.05), text, fill=(255, 255, 255))
        return image

    scene(1600, 1200, (70, 120, 170), "landscape").save(out / "landscape.jpg", quality=88)
    scene(1200, 1600, (60, 140, 90), "portrait").save(out / "portrait.jpg", quality=88)
    scene(4032, 3024, (150, 110, 60), "big").save(out / "big.jpg", quality=85)
    scene(640, 480, (40, 40, 60), "small").save(out / "small.jpg", quality=80)

    # Taken with the phone turned: the stored pixels are landscape, and a tag says "rotate me".
    sideways = scene(1600, 1200, (120, 60, 140), "sideways")
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 degrees clockwise to display
    sideways.save(out / "sideways.jpg", quality=88, exif=exif)

    # A picture with see-through areas.
    clear = Image.new("RGBA", (800, 600), (0, 0, 0, 0))
    ImageDraw.Draw(clear).ellipse([200, 100, 600, 500], fill=(10, 107, 93, 255))
    clear.save(out / "transparent.png")

    # Close to what a phone camera produces: fine detail everywhere, so it does not compress to nothing.
    from PIL import ImageFilter

    busy = Image.effect_noise((2000, 1500), 60).filter(ImageFilter.GaussianBlur(1.0)).convert("RGB")
    tint = Image.new("RGB", (2000, 1500), (96, 124, 92))
    busy = Image.blend(busy, tint, 0.45)
    ImageDraw.Draw(busy).rectangle([940, 150, 1060, 1425], fill=(88, 62, 34))
    busy.save(out / "camera-full.jpg", quality=82)
    busy.resize((900, 675)).save(out / "camera-mid.jpg", quality=72)
    busy.resize((320, 240)).save(out / "camera-thumb.jpg", quality=70)

    (out / "not-a-picture.jpg").write_bytes(b"This is text, not a picture.\n" * 20)
    (out / "empty.jpg").write_bytes(b"")
    print(json.dumps({"folder": str(out), "files": sorted(p.name for p in out.iterdir())}))


def plain(value):
    if value is None or isinstance(value, (int, float, str, bool)):
        return value
    return str(value)


def pdf(path):
    """Pages as lines of cells (pdftotext keeps columns apart with runs of spaces), the pictures
    on each page (pdfimages), the document details (pdfinfo), and qpdf's structure check."""
    import re
    import subprocess

    def run(*args):
        return subprocess.run(args, capture_output=True, text=True)

    check = run("qpdf", "--check", path)
    info = {}
    for line in run("pdfinfo", path).stdout.splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            info[key.strip()] = value.strip()
    text = run("pdftotext", "-layout", "-enc", "UTF-8", path, "-").stdout
    pages = []
    for page_text in text.split("\f"):
        lines = []
        for line in page_text.splitlines():
            if line.strip():
                lines.append([cell for cell in re.split(r"\s{2,}", line.strip()) if cell])
        pages.append({"lines": lines, "text": " ".join(" ".join(l) for l in lines)})
    if pages and not pages[-1]["lines"]:
        pages.pop()
    images = []
    for line in run("pdfimages", "-list", path).stdout.splitlines()[2:]:
        cells = line.split()
        images.append({"page": int(cells[0]), "width": int(cells[3]), "height": int(cells[4]), "encoding": cells[8]})
    from pypdf import PdfReader

    reader = PdfReader(path, strict=True)
    print(json.dumps({
        "ok": check.returncode == 0,
        "check": (check.stdout + check.stderr).strip().splitlines()[-1:] ,
        "title": info.get("Title"),
        "producer": info.get("Producer"),
        "pageSize": info.get("Page size"),
        "pageCount": len(reader.pages),
        "pages": pages,
        "images": images,
    }))


def zip_info(path):
    with zipfile.ZipFile(path) as z:
        bad = z.testzip()
        entries = [{"name": i.filename, "size": i.file_size, "packed": i.compress_size, "method": i.compress_type, "utf8": bool(i.flag_bits & 0x800)} for i in z.infolist()]
    print(json.dumps({"badEntry": bad, "entries": entries}))


def image(path):
    from PIL import Image

    with Image.open(path) as im:
        im.load()
        rgb = im.convert("RGB")
        w, h = rgb.size
        points = {
            "topLeft": rgb.getpixel((int(w * 0.05), int(h * 0.05))),
            "topRight": rgb.getpixel((int(w * 0.95), int(h * 0.05))),
            "bottomLeft": rgb.getpixel((int(w * 0.05), int(h * 0.95))),
            "bottomRight": rgb.getpixel((int(w * 0.95), int(h * 0.95))),
            "centre": rgb.getpixel((w // 2, h // 2)),
        }
        exif_orientation = None
        try:
            exif_orientation = im.getexif().get(0x0112)
        except Exception:  # noqa: BLE001
            exif_orientation = None
        print(json.dumps({"format": im.format, "width": w, "height": h, "mode": im.mode, "points": points, "orientation": exif_orientation}))


def csv_rows(path):
    raw = Path(path).read_bytes()
    text = raw.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text, newline="")))
    print(json.dumps({"bom": raw[:3] == b"\xef\xbb\xbf", "crlf": b"\r\n" in raw, "rows": rows}))


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    mode, target = sys.argv[1], sys.argv[2]
    {"make-images": make_images, "pdf": pdf, "zip": zip_info, "image": image, "csv": csv_rows}[mode](target)


if __name__ == "__main__":
    main()
