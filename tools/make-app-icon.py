#!/usr/bin/env python3
"""Regenerate the Remote page's icons from the finished whale artwork.

Run from the repository root:

    python tools/make-app-icon.py

The artwork is a finished render (not something this script draws): a transparent-background PNG of the
DeepSeek whale with an iridescent metal finish. This script only has to trim it to its content, centre it
with a margin, and emit the sizes the page needs. Keeping it that way means re-running this never drifts
from the approved artwork.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "ui" / "public"
META = Path(__file__).resolve().parents[3] / ".meta" / "Dynesshely" / "dsh-plugin-remote"
SOURCE = META / "whale_iridescent_metal.png"

# The mark keeps this share of the canvas; the rest is margin on every side.
CONTENT_RATIO = 0.84

OUTPUTS = {
    "app-icon.png": 128,
    "favicon-64.png": 64,
    "favicon-32.png": 32,
    "apple-touch-icon.png": 180,
}


def centred(mark: Image.Image, size: int) -> Image.Image:
    """@returns the mark scaled to fit the safe area and centred on a transparent square."""
    margin = round(size * (1 - CONTENT_RATIO) / 2)
    inner = max(1, size - margin * 2)
    box_width, box_height = mark.size
    scale = min(inner / box_width, inner / box_height)
    scaled = mark.resize((max(1, round(box_width * scale)), max(1, round(box_height * scale))), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    offset = ((size - scaled.width) // 2, (size - scaled.height) // 2)
    canvas.paste(scaled, offset, scaled)
    return canvas


def main() -> None:
    """Trim the artwork and write every icon size."""
    if not SOURCE.exists():
        raise SystemExit(f"artwork missing: {SOURCE}")
    artwork = Image.open(SOURCE).convert("RGBA")
    bounds = artwork.getbbox()
    if bounds is None:
        raise SystemExit("artwork is fully transparent")
    trimmed = artwork.crop(bounds)

    # A preview on both backgrounds, so the finish can be judged against light and dark shells.
    for background, label in (((22, 22, 26), "dark"), ((244, 244, 245), "light")):
        preview = Image.new("RGBA", (320, 320), (*background, 255))
        icon = centred(trimmed, 256)
        preview.paste(icon, (32, 32), icon)
        preview.save(META / f"icon-preview-{label}.png")

    for name, size in OUTPUTS.items():
        icon = centred(trimmed, size)
        icon.save(PUBLIC / name, optimize=True)
        print(f"  wrote {name} ({size}x{size}, {icon.getbbox()})")


if __name__ == "__main__":
    main()
