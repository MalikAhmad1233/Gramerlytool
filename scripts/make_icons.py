"""Generates WriteMind AI brand icons (PNG for the extension, ICO for Windows).

Usage: python3 scripts/make_icons.py   (requires Pillow)
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
TOP = (79, 70, 229)  # indigo-600
BOTTOM = (124, 58, 237)  # violet-600
ACCENT = (52, 211, 153)  # emerald-400


def render(size: int) -> Image.Image:
    scale = 4
    s = size * scale
    gradient = Image.new("RGB", (1, s))
    for y in range(s):
        t = y / (s - 1)
        gradient.putpixel((0, y), tuple(int(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
    gradient = gradient.resize((s, s))
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * 0.23), fill=255)
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    img.paste(gradient, (0, 0), mask)

    draw = ImageDraw.Draw(img)
    stroke = max(int(s * 0.11), 2)
    # Stylised "W" whose last stroke rises into a check mark: suggestions you approve.
    points = [(0.20, 0.30), (0.33, 0.70), (0.47, 0.42), (0.60, 0.70), (0.80, 0.26)]
    draw.line([(x * s, y * s) for x, y in points[:4]], fill="white", width=stroke, joint="curve")
    draw.line([(points[3][0] * s, points[3][1] * s), (points[4][0] * s, points[4][1] * s)],
              fill=ACCENT, width=stroke, joint="curve")
    r = stroke / 2
    for (x, y), colour in zip(points, ["white", "white", "white", "white", ACCENT]):
        draw.ellipse((x * s - r, y * s - r, x * s + r, y * s + r), fill=colour)
    img = img.filter(ImageFilter.SMOOTH)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    ext = ROOT / "extension" / "public" / "icon"
    ext.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 96, 128):
        render(size).save(ext / f"{size}.png")
    desktop = ROOT / "desktop" / "src" / "WriteMind.Desktop" / "Assets"
    desktop.mkdir(parents=True, exist_ok=True)
    big = render(256)
    big.save(desktop / "writemind.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    big.save(desktop / "writemind.png")
    print("icons written")


if __name__ == "__main__":
    main()
