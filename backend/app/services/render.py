"""Shared ANSI-to-PNG rendering for terminal screenshots."""

from __future__ import annotations

from io import BytesIO

import pyte
from PIL import Image, ImageDraw, ImageFont

# pyte color map (basic 8 + bright colors)
_COLOR_MAP = {
    "black": (0, 0, 0),
    "red": (205, 49, 49),
    "green": (13, 188, 121),
    "yellow": (229, 229, 16),
    "blue": (36, 114, 200),
    "magenta": (188, 63, 188),
    "cyan": (17, 168, 205),
    "white": (229, 229, 229),
    "default": (229, 229, 229),
    "brightblack": (102, 102, 102),
    "brightred": (241, 76, 76),
    "brightgreen": (35, 209, 139),
    "brightyellow": (245, 245, 67),
    "brightblue": (59, 142, 234),
    "brightmagenta": (214, 112, 214),
    "brightcyan": (41, 184, 219),
    "brightwhite": (255, 255, 255),
}

_DEFAULT_FG = (229, 229, 229)
_DEFAULT_BG = (30, 30, 30)


def _resolve_color(color_name: str, default: tuple) -> tuple:
    if not color_name or color_name == "default":
        return default
    name = color_name.lower().replace(" ", "")
    if name in _COLOR_MAP:
        return _COLOR_MAP[name]
    # Try parsing hex color from pyte (e.g. "00ff00")
    if len(name) == 6:
        try:
            return (int(name[0:2], 16), int(name[2:4], 16), int(name[4:6], 16))
        except ValueError:
            pass
    return default


def render_ansi_to_png(ansi_text: str, cols: int = 80) -> BytesIO:
    """Render ANSI terminal text to a PNG image using pyte + Pillow."""
    # Count visible rows from the raw text (for screen height)
    raw_lines = ansi_text.split("\n")
    # Strip trailing empty lines
    while raw_lines and not raw_lines[-1].strip():
        raw_lines.pop()
    rows = max(len(raw_lines), 1)

    # Feed the full ANSI text to pyte as a single stream so multi-line
    # escape sequences are handled correctly.
    # Replace bare \n with \r\n so pyte does a carriage return (back to
    # column 0) on each line feed — without this, text drifts rightward.
    normalized = ansi_text.replace("\r\n", "\n").replace("\n", "\r\n")
    screen = pyte.Screen(cols, rows)
    stream = pyte.Stream(screen)
    stream.feed(normalized)

    # Font setup
    char_width = 8
    char_height = 16
    padding = 10
    try:
        font = ImageFont.truetype("DejaVuSansMono.ttf", 14)
        bbox = font.getbbox("M")
        char_width = bbox[2] - bbox[0]
        char_height = bbox[3] - bbox[1] + 4
    except (OSError, AttributeError):
        try:
            font = ImageFont.truetype(
                "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 14
            )
            bbox = font.getbbox("M")
            char_width = bbox[2] - bbox[0]
            char_height = bbox[3] - bbox[1] + 4
        except (OSError, AttributeError):
            font = ImageFont.load_default()

    img_width = cols * char_width + padding * 2
    img_height = rows * char_height + padding * 2
    img = Image.new("RGB", (img_width, img_height), color=_DEFAULT_BG)
    draw = ImageDraw.Draw(img)

    for row_idx in range(rows):
        row_data = screen.buffer.get(row_idx, {})
        for col_idx in range(cols):
            char_data = row_data.get(col_idx)
            if not char_data:
                continue
            fg = _resolve_color(char_data.fg, _DEFAULT_FG)
            bg = _resolve_color(char_data.bg, _DEFAULT_BG)
            x = padding + col_idx * char_width
            y = padding + row_idx * char_height
            # Render background for any cell with a non-default bg
            if bg != _DEFAULT_BG:
                draw.rectangle(
                    [x, y, x + char_width, y + char_height],
                    fill=bg,
                )
            # Draw the character (skip plain spaces on default bg)
            if char_data.data != " " or bg != _DEFAULT_BG:
                draw.text((x, y), char_data.data, fill=fg, font=font)

    buf = BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf
