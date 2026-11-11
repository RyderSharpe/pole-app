#!/usr/bin/env python3
"""Draws the app icon: a white utility pole on green.

Run from the project folder:  python3 tools/make-icons.py
Needs Pillow (pip install Pillow). The icons are already in icons/, so this is only needed if
the design changes.
"""
from pathlib import Path
from PIL import Image, ImageDraw

GREEN = (10, 107, 93, 255)
WHITE = (255, 255, 255, 255)
OUT = Path(__file__).resolve().parent.parent / "icons"


def draw(size, inset):
    """size: final pixel size. inset: share of the icon kept clear around the drawing (0 to 0.5)."""
    scale = 4  # draw large, then shrink, for smooth edges
    s = size * scale
    image = Image.new("RGBA", (s, s), GREEN)
    d = ImageDraw.Draw(image)
    box = s * (1 - 2 * inset)
    left = s * inset
    top = s * inset

    def x(v):
        return left + box * v

    def y(v):
        return top + box * v

    w = box * 0.075
    # pole
    d.rounded_rectangle([x(0.5) - w / 2, y(0.10), x(0.5) + w / 2, y(0.92)], radius=w / 3, fill=WHITE)
    # crossarm
    d.rounded_rectangle([x(0.16), y(0.24), x(0.84), y(0.24) + w], radius=w / 3, fill=WHITE)
    # insulators
    for cx in (0.22, 0.5, 0.78):
        d.rounded_rectangle([x(cx) - w * 0.42, y(0.24) - w * 1.15, x(cx) + w * 0.42, y(0.24) + w * 0.2], radius=w * 0.3, fill=WHITE)
    # lower arm (secondary)
    d.rounded_rectangle([x(0.30), y(0.44), x(0.70), y(0.44) + w * 0.8], radius=w / 3, fill=WHITE)
    # ground line
    d.rounded_rectangle([x(0.26), y(0.90), x(0.74), y(0.90) + w * 0.7], radius=w / 3, fill=WHITE)
    return image.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(exist_ok=True)
    draw(180, 0.12).convert("RGB").save(OUT / "icon-180.png", optimize=True)
    draw(192, 0.12).save(OUT / "icon-192.png", optimize=True)
    draw(512, 0.12).save(OUT / "icon-512.png", optimize=True)
    # "Maskable" icons are cropped to a circle or a rounded square by the phone, so the drawing sits well inside.
    draw(512, 0.22).save(OUT / "icon-maskable-512.png", optimize=True)
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
