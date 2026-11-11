#!/usr/bin/env python3
"""Writes src/pdf-metrics.js: how wide each character is in the PDF's built-in fonts.

The PDF report uses fonts that every PDF reader already has (Helvetica and Helvetica-Bold), so no
font file has to be stored in the report. To wrap text, the app needs the width of each
character. Those widths come from Adobe's published font metric (AFM) files, which may be copied
and used freely.

Run from the project folder:  python3 tools/make-pdf-metrics.py [folder with the .afm files]
By default it looks for the copies that ship with matplotlib. The result is already in src/, so
this is only needed to check it.
"""
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "src" / "pdf-metrics.js"


def find_afm_folder():
    if len(sys.argv) > 1:
        return Path(sys.argv[1])
    import matplotlib

    return Path(matplotlib.get_data_path()) / "fonts" / "pdfcorefonts"


def read_afm(path):
    widths = {}
    for line in path.read_text(encoding="latin-1").splitlines():
        if not line.startswith("C "):
            continue
        parts = dict(p.strip().split(" ", 1) for p in line.split(";") if " " in p.strip())
        widths[parts["N"]] = int(float(parts["WX"]))
    return widths


def winansi_glyph_names():
    # The glyph name for each character code of the standard Latin (WinAnsi) set, 32 to 255.
    from reportlab.pdfbase._fontdata import encodings

    names = encodings["WinAnsiEncoding"]
    return [names[code] for code in range(32, 256)]


def main():
    folder = find_afm_folder()
    names = winansi_glyph_names()
    tables = {}
    for font in ("Helvetica", "Helvetica-Bold"):
        afm = read_afm(folder / (font + ".afm"))
        # A code with no glyph prints as nothing in most readers. It is never written (see pdf.js).
        tables[font] = [afm.get(name, 0) if name else 0 for name in names]
    # Characters that WinAnsi holds at codes 128 to 159, which are not their Unicode values.
    extra = {}
    for code in range(128, 160):
        try:
            extra[ord(bytes([code]).decode("cp1252"))] = code
        except UnicodeDecodeError:
            pass
    lines = [
        "// Made by tools/make-pdf-metrics.py from Adobe's font metric files. Do not edit by hand.",
        "// Widths of character codes 32 to 255 (the standard Latin set, WinAnsi), in 1/1000 of the",
        "// font size.",
        "",
        "export const HELVETICA = " + str(tables["Helvetica"]).replace(" ", "") + ";",
        "export const HELVETICA_BOLD = " + str(tables["Helvetica-Bold"]).replace(" ", "") + ";",
        "",
        "// Unicode characters that WinAnsi keeps at codes 128 to 159.",
        "export const WINANSI_EXTRA = {" + ",".join("0x%04x:%d" % (u, c) for u, c in sorted(extra.items())) + "};",
        "",
    ]
    OUT.write_text("\n".join(lines), encoding="utf-8")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
