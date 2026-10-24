"""The CSS value rules of the design system — ONE place (the token editor, extracted designs,
component styles and the CSS custom-property parser all use these predicates).
"""
from __future__ import annotations

import re
from typing import Final

MAX_TOKEN_VALUE_CHARS: Final = 120

# CSS colour values a prompt can rely on: hex, rgb()/rgba()/hsl()/hsla(), the
# CSS Color 4 spaces modern design tokens use (oklch()/oklab()/lab()/lch()), or a
# bare keyword. Anything else (url(), var(), expressions, braces) is refused.
COLOR_RE: Final = re.compile(
    r'^(#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}'
    r'|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(\s*[0-9.%\s,/+-]+\)'
    r'|[a-zA-Z]{3,30})\Z'
)
# Lengths: 12px, 1.25rem, 0, 50%, 9999px.
LENGTH_RE: Final = re.compile(r'^(0|\d{1,4}(\.\d{1,3})?(px|rem|em|%|pt|vh|vw))\Z')
FONT_FAMILY_RE: Final = re.compile(r'^[\w\s,"\'.-]{1,200}\Z', re.UNICODE)
WEIGHT_RE: Final = re.compile(r'^([1-9]00|normal|bold|lighter|bolder)\Z')


def is_css_color(value: object) -> bool:
    """Whether ``value`` is a colour the token editor accepts."""
    return isinstance(value, str) and len(value) <= MAX_TOKEN_VALUE_CHARS and bool(COLOR_RE.match(value.strip()))


def is_css_length(value: object) -> bool:
    """Whether ``value`` is a length the token editor accepts (spacing, radius, font size)."""
    return isinstance(value, str) and len(value) <= MAX_TOKEN_VALUE_CHARS and bool(LENGTH_RE.match(value.strip()))


def is_font_family(value: object) -> bool:
    """Whether ``value`` is a font-family list the token editor accepts."""
    return isinstance(value, str) and bool(FONT_FAMILY_RE.match(value.strip()))


def is_font_weight(value: object) -> bool:
    """Whether ``value`` (a string or an integer) is a weight the token editor accepts."""
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return False
    return bool(WEIGHT_RE.match(str(value).strip()))
