"""Design tokens read deterministically from CSS custom properties (no model involved).

``custom_properties`` collects every ``--name: value`` declaration of a stylesheet — in
``:root``, ``html``, Tailwind v4's ``@theme`` or any other block — first declaration wins
(the light/default theme comes first in the files measured), and resolves ``var(--x)``
references between them. ``tokens_from_properties`` sorts them into the four token groups
by name AND value; anything the token editor would refuse is left out. The result is a raw
``extracted_design`` part, still cleaned by ``shared.extracted_design.clean_extracted_design``.
"""
from __future__ import annotations

import re

from shared.company_context import is_css_color, is_css_length, is_font_family

_COMMENT_RE = re.compile(r'/\*.*?\*/', re.DOTALL)
_DECLARATION_RE = re.compile(r'--([A-Za-z0-9_-]{1,60})\s*:\s*([^;{}]{1,300})')
_VAR_RE = re.compile(r'^var\(\s*--([A-Za-z0-9_-]{1,60})\s*(?:,\s*([^()]*))?\)\Z')
_IMPORTANT_RE = re.compile(r'\s*!important\s*\Z', re.IGNORECASE)
#: Colour values taken without a colour-ish name: written as a hex or a colour function only
#: (a bare word such as ``inherit`` or ``none`` is not a design colour).
_EXPLICIT_COLOR_RE = re.compile(r'^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\()', re.IGNORECASE)
_RESOLVE_DEPTH = 4
_SPACING_WORDS = ('space', 'spacing', 'gap', 'gutter')
_RADIUS_WORDS = ('radius', 'rounded')
_FONT_SKIP_WORDS = ('weight', 'size', 'leading', 'tracking', 'line-height', 'feature', 'variation')
_FONT_ROLES = (
    (('mono', 'code'), 'mono'),
    (('display',), 'display'),
    (('heading', 'head', 'title'), 'heading'),
    (('sans', 'body', 'base', 'text', 'ui'), 'body'),
    (('serif',), 'serif'),
)
_COLOR_PREFIXES = ('color-', 'colour-', 'clr-')


def custom_properties(css: str) -> dict[str, str]:
    """Every custom property in ``css`` (comments removed), first declaration wins, ``var()`` resolved."""
    raw: dict[str, str] = {}
    for name, value in _DECLARATION_RE.findall(_COMMENT_RE.sub(' ', css)):
        raw.setdefault(name.lower(), _IMPORTANT_RE.sub('', value.strip()))
    return {name: _resolved(raw, value) for name, value in raw.items()}


def _resolved(props: dict[str, str], value: str) -> str:
    current = value
    for _ in range(_RESOLVE_DEPTH):
        match = _VAR_RE.match(current)
        if not match:
            return current
        target = props.get(match.group(1).lower())
        if target is None:
            fallback = (match.group(2) or '').strip()
            return fallback or current
        current = target
    return current


def _font_role(name: str) -> str | None:
    stem = name.removeprefix('font-family-').removeprefix('font-').removeprefix('family-')
    if any(word in name for word in _FONT_SKIP_WORDS):
        return None
    for words, role in _FONT_ROLES:
        if any(word in stem for word in words):
            return role
    return stem or None


def _color_name(name: str) -> str:
    for prefix in _COLOR_PREFIXES:
        if name.startswith(prefix):
            return name.removeprefix(prefix)
    return name


def _is_font_name(name: str) -> bool:
    return name.startswith(('font', 'family')) or '-font' in name


def _classify(name: str, value: str, tokens: dict[str, list[dict]]) -> None:
    if _is_font_name(name):
        role = _font_role(name)
        if role and is_font_family(value) and not is_css_length(value) and any(c.isalpha() for c in value):
            tokens['typography'].append({'role': role, 'family': value})
        return
    if _EXPLICIT_COLOR_RE.match(value) and is_css_color(value):
        tokens['colors'].append({'name': _color_name(name), 'value': value})
    elif is_css_length(value) and any(word in name for word in _RADIUS_WORDS):
        tokens['radius'].append({'name': name, 'value': value})
    elif is_css_length(value) and any(word in name for word in _SPACING_WORDS):
        tokens['spacing'].append({'name': name, 'value': value})


def tokens_from_properties(props: dict[str, str]) -> dict[str, list[dict]]:
    """``{colors, typography, spacing, radius}`` from custom properties, in declaration order.

    Not de-duplicated or capped here: ``clean_extracted_design`` keeps the first entry per
    name / role and caps every group, for this source and every other alike.
    """
    tokens: dict[str, list[dict]] = {'colors': [], 'typography': [], 'spacing': [], 'radius': []}
    for name, value in props.items():
        _classify(name, value, tokens)
    return tokens


def tokens_from_css(css: str) -> dict[str, list[dict]]:
    """``tokens_from_properties(custom_properties(css))``."""
    return tokens_from_properties(custom_properties(css))
