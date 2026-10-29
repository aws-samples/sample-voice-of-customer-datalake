"""``color-mix()`` evaluated to a plain colour (no CSS engine; the design-reference parsers only).

Design tokens often tint a status colour with ``color-mix(in srgb, var(--info) 12%, transparent)``
(5.35 live: the voc-v2 ``--color-info-subtle``), and a focus glow writes one inside a box-shadow. The
design system's value rules accept hex / rgb() / hsl() / oklch() but not ``color-mix()``, so such a
value used to be dropped and the Badge ``info`` variant, or the Input focus ring, disappeared.

``evaluate_color_mix`` replaces every ``color-mix(...)`` it can compute, after ``var()`` resolution:

- one side ``transparent``: the other colour with the alpha of its percentage (in every colour
  space: premultiplied interpolation towards transparent keeps the hue);
- two colours ``in srgb``: the channel-wise mix;
- anything else (another space with two real colours, an unknown colour) stays as it is, and the
  caller's value rules drop it.

Colours read: ``#rgb[a]`` / ``#rrggbb[aa]``, ``rgb()`` / ``rgba()`` (commas or spaces, ``/ alpha``),
``transparent``, ``white``, ``black``.
"""
from __future__ import annotations

import re
from typing import Final

_FUNCTION: Final = 'color-mix('
_MAX_MIXES: Final = 20
_HEX_RE: Final = re.compile(r'^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\Z', re.IGNORECASE)
_RGB_RE: Final = re.compile(r'^rgba?\(\s*([^()]*)\)\Z', re.IGNORECASE)
_PERCENT_RE: Final = re.compile(r'^\d{1,3}(\.\d{1,3})?%\Z')
_KEYWORDS: Final = {'white': (255.0, 255.0, 255.0, 1.0), 'black': (0.0, 0.0, 0.0, 1.0)}

Rgba = tuple[float, float, float, float]


def _hex(text: str) -> Rgba | None:
    match = _HEX_RE.match(text)
    if not match:
        return None
    digits = match.group(1)
    if len(digits) <= 4:
        digits = ''.join(ch * 2 for ch in digits)
    channels = [int(digits[i:i + 2], 16) for i in range(0, len(digits), 2)]
    alpha = channels[3] / 255 if len(channels) == 4 else 1.0
    return float(channels[0]), float(channels[1]), float(channels[2]), alpha


def _number(text: str, scale: float) -> float | None:
    try:
        return float(text[:-1]) / 100 * scale if text.endswith('%') else float(text)
    except ValueError:
        return None


def _rgb(text: str) -> Rgba | None:
    match = _RGB_RE.match(text)
    if not match:
        return None
    body = match.group(1).replace('/', ' ').replace(',', ' ').split()
    if len(body) not in (3, 4):
        return None
    red, green, blue = (_number(part, 255) for part in body[:3])
    alpha = _number(body[3], 1) if len(body) == 4 else 1.0
    if red is None or green is None or blue is None or alpha is None:
        return None
    return red, green, blue, alpha


def parse_color(text: str) -> Rgba | None:
    """``(r, g, b, alpha)`` of a hex / rgb() / keyword colour, or None."""
    value = text.strip().lower()
    if value == 'transparent':
        return 0.0, 0.0, 0.0, 0.0
    return _KEYWORDS.get(value) or _hex(value) or _rgb(value)


def format_color(color: Rgba) -> str:
    red, green, blue, alpha = (round(color[0]), round(color[1]), round(color[2]), round(color[3], 3))
    if alpha >= 1:
        return f'#{red:02x}{green:02x}{blue:02x}'
    return f'rgba({red}, {green}, {blue}, {alpha:g})'


def _split_args(body: str) -> list[str]:
    parts, depth, start = [], 0, 0
    for index, char in enumerate(body):
        depth += (char == '(') - (char == ')')
        if char == ',' and depth == 0:
            parts.append(body[start:index].strip())
            start = index + 1
    parts.append(body[start:].strip())
    return parts


def _side(text: str) -> tuple[str, float | None]:
    """``'#fff 12%'`` / ``'12% #fff'`` → ('#fff', 12.0); no percentage → (text, None). No regex
    backtracking over the colour: the percentage is a whole whitespace-separated token at either end."""
    tokens = text.split()
    if len(tokens) >= 2 and _PERCENT_RE.match(tokens[-1]):
        return ' '.join(tokens[:-1]), float(tokens[-1][:-1])
    if len(tokens) >= 2 and _PERCENT_RE.match(tokens[0]):
        return ' '.join(tokens[1:]), float(tokens[0][:-1])
    return text.strip(), None


def _weights(first: float | None, second: float | None) -> tuple[float, float] | None:
    if first is None and second is None:
        return 0.5, 0.5
    if first is None:
        first = 100 - (second or 0)
    if second is None:
        second = 100 - first
    total = first + second
    return (first / total, second / total) if total > 0 else None


def _mix(body: str) -> str | None:
    args = _split_args(body)
    if len(args) != 3 or not args[0].lower().startswith('in '):
        return None
    space = args[0][3:].strip().lower()
    (text_a, pct_a), (text_b, pct_b) = _side(args[1]), _side(args[2])
    color_a, color_b = parse_color(text_a), parse_color(text_b)
    weights = _weights(pct_a, pct_b)
    if color_a is None or color_b is None or weights is None:
        return None
    w_a, w_b = weights
    if color_b[3] == 0 or color_a[3] == 0:
        solid, weight = (color_a, w_a) if color_b[3] == 0 else (color_b, w_b)
        return format_color((solid[0], solid[1], solid[2], solid[3] * weight))
    if space != 'srgb':
        return None
    mixed = tuple(a * w_a + b * w_b for a, b in zip(color_a, color_b, strict=True))
    return format_color((mixed[0], mixed[1], mixed[2], mixed[3]))


def _closing(text: str, start: int) -> int:
    """The index of the ``)`` closing the parenthesis opened just before ``start``, or -1."""
    depth = 1
    for index in range(start, len(text)):
        depth += (text[index] == '(') - (text[index] == ')')
        if depth == 0:
            return index
    return -1


def evaluate_color_mix(text: str) -> str:
    """``text`` with every computable ``color-mix(...)`` replaced by its colour (innermost first)."""
    current, cursor = text, 0
    for _ in range(_MAX_MIXES):
        start = current.lower().find(_FUNCTION, cursor)
        if start < 0:
            break
        body_start = start + len(_FUNCTION)
        end = _closing(current, body_start)
        if end < 0:
            break
        body = evaluate_color_mix(current[body_start:end])
        mixed = _mix(body)
        if mixed is None:
            cursor = end + 1
            continue
        current = current[:start] + mixed + current[end + 1:]
        cursor = start + len(mixed)
    return current
