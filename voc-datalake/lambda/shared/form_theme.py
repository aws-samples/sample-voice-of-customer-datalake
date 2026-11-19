"""A feedback form's `theme`: checked before it is stored (Well-Architected SEC11, finding FE-2), read with its
defaults, and judged for contrast by the rules the editor and the widget share (docs/feedback-forms.md, "Theming").

The embeddable widget (`lambda/api/static/feedback-widget.js`) runs on the CUSTOMER's own page and
concatenates the theme colours into `style.cssText`. Stored unchecked, a colour such as
`red;position:fixed;inset:0;background:url(https://…)` would let any app user restyle (cover, beacon from)
the customer's page. So the theme is a closed object of hex colours, a pixel radius and three closed choices; the
widget re-checks the colours on its side for themes stored before this rule.

The theme (7.55.01; every field optional, :func:`with_defaults` answers the missing ones):

* ``primary_color``, ``background_color``, ``text_color``: the LIGHT palette (``#rgb`` or ``#rrggbb``; an old
  form's ``#rrggbbaa`` is still accepted);
* ``border_radius``: ``'Npx'``, 0 to 99 (the editor offers 0 to 24);
* ``mode``: ``light`` | ``dark`` | ``auto`` (the respondent's ``prefers-color-scheme``), the palette shown;
* ``dark``: the DARK palette, the same three colours (``#rgb`` or ``#rrggbb``);
* ``font``: ``system`` | ``inherit`` (the script embed's page font) | ``serif`` | ``rounded`` | ``mono``: system
  stacks only, never a web font;
* ``text_size``: ``default`` | ``large`` (an 18 px body).

The contrast rules (WCAG 2), one set with the editor (frontend ``pages/FeedbackForms/theme/contrast.ts``) and the
widget, for every palette that can be shown (:func:`shown_palettes`):

* text on background, 4.5:1; under :data:`TEXT_PUBLISH_MINIMUM` (3:1) the form cannot be published, nor a live
  form's colours changed (shared/forms_v2.py ``validate_publishable``), from 3 a warning;
* primary on background (the focus ring, progress, selected edges), 3:1;
* the button label on primary (white or ``#19161d``, whichever contrasts more), 4.5:1;
* the option edge (the text colour at 55 % over the background, raised until it holds), 3:1.

Only the first decides anything on the server (the publish rule); the other three are the editor's warnings and the
widget's safeguards, computed there (``theme/contrast.ts``, the widget's ``readableOn`` and option edge).
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Final, Literal

from shared.exceptions import ValidationError

COLOR_FIELDS: Final = ('primary_color', 'background_color', 'text_color')
RADIUS_FIELD: Final = 'border_radius'
DARK_FIELD: Final = 'dark'
#: The closed choices and their allowed values, the first of each its default.
CHOICES: Final[dict[str, tuple[str, ...]]] = {
    'mode': ('light', 'dark', 'auto'),
    'font': ('system', 'inherit', 'serif', 'rounded', 'mono'),
    'text_size': ('default', 'large'),
}
FIELDS: Final = frozenset({*COLOR_FIELDS, RADIUS_FIELD, DARK_FIELD, *CHOICES})
#: `#rgb`, `#rrggbb` or `#rrggbbaa`: the shapes a colour picker produces. Mirrored by the widget's HEX_COLOR.
HEX_COLOR: Final = re.compile(r'^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\Z')
#: The dark palette is new (7.55.01), so it has no old `#rrggbbaa` values to keep: `#rgb` or `#rrggbb` only.
PALETTE_HEX: Final = re.compile(r'^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\Z')
#: A pixel radius from 0px to 99px.
RADIUS: Final = re.compile(r'^\d{1,2}px\Z')

#: VoC light (Kiro Light: accent, page, strong text) and VoC dark (Kiro Dark's accent text, page and strong text),
#: both AA-checked in frontend/src/styles/theme-palettes.css. Mirrored by frontend …/model/formsV2.ts.
VOC_LIGHT: Final = {'primary_color': '#8e48ff', 'background_color': '#ffffff', 'text_color': '#19161d'}
VOC_DARK: Final = {'primary_color': '#bd8fff', 'background_color': '#19161d', 'text_color': '#f2f1f4'}
DEFAULT_RADIUS: Final = '8px'

#: Text under this on its background cannot be published (WCAG 2's 4.5:1 for text is the editor's warning above it).
TEXT_PUBLISH_MINIMUM: Final = 3.0

Palette = Literal['light', 'dark']


def default_theme() -> dict[str, Any]:
    """A new form's theme: VoC light shown, VoC dark as its dark palette, the system font at the default size."""
    return {**VOC_LIGHT, RADIUS_FIELD: DEFAULT_RADIUS, 'mode': 'light', DARK_FIELD: dict(VOC_DARK),
            'font': 'system', 'text_size': 'default'}


def _closed(value: Mapping[str, Any], allowed: frozenset[str] | tuple[str, ...], where: str) -> None:
    unknown = sorted(str(key) for key in set(value) - set(allowed))
    if unknown:
        raise ValidationError(f'{where} has unknown fields: {", ".join(key[:40] for key in unknown[:5])}')


def _is_colour(value: object, pattern: re.Pattern[str]) -> bool:
    return isinstance(value, str) and pattern.match(value) is not None


def _check_colours(value: Mapping[str, Any], where: str, pattern: re.Pattern[str]) -> None:
    for field in COLOR_FIELDS:
        colour = value.get(field)
        if colour is not None and not _is_colour(colour, pattern):
            raise ValidationError(f'{where}.{field} must be a hex colour such as #8e48ff')


def check_theme(theme: object, where: str = 'theme') -> None:
    """400 unless ``theme`` is an object of the documented fields, each of its shape (all optional)."""
    if not isinstance(theme, Mapping):
        raise ValidationError(f'{where} must be an object')
    _closed(theme, FIELDS, where)
    _check_colours(theme, where, HEX_COLOR)
    radius = theme.get(RADIUS_FIELD)
    if radius is not None and not (isinstance(radius, str) and RADIUS.match(radius)):
        raise ValidationError(f'{where}.{RADIUS_FIELD} must be a pixel value such as 8px')
    for field, allowed in CHOICES.items():
        choice = theme.get(field)
        if choice is not None and not (isinstance(choice, str) and choice in allowed):
            raise ValidationError(f'{where}.{field} must be one of: {", ".join(allowed)}')
    dark = theme.get(DARK_FIELD)
    if dark is not None:
        if not isinstance(dark, Mapping):
            raise ValidationError(f'{where}.{DARK_FIELD} must be an object')
        _closed(dark, COLOR_FIELDS, f'{where}.{DARK_FIELD}')
        _check_colours(dark, f'{where}.{DARK_FIELD}', PALETTE_HEX)


def validate_theme(body: dict[str, Any]) -> None:
    """400 unless an included ``theme`` passes :func:`check_theme`."""
    if 'theme' in body:
        check_theme(body['theme'])


def with_defaults(theme: object) -> dict[str, Any]:
    """The theme as the widget and the editor read it: every field present, each one missing (a theme stored before
    7.55.01 has no mode, dark palette, font or size) or unusable (one stored before FE-2) answered with its default.
    The form's next save writes it back whole (the editor always sends every field)."""
    stored: Mapping[str, Any] = theme if isinstance(theme, Mapping) else {}
    out = default_theme()
    for field in COLOR_FIELDS:
        if _is_colour(stored.get(field), HEX_COLOR):
            out[field] = stored[field]
    radius = stored.get(RADIUS_FIELD)
    if isinstance(radius, str) and RADIUS.match(radius):
        out[RADIUS_FIELD] = radius
    for field, allowed in CHOICES.items():
        choice = stored.get(field)
        if isinstance(choice, str) and choice in allowed:
            out[field] = choice
    dark = stored.get(DARK_FIELD)
    if isinstance(dark, Mapping):
        kept = {field: dark[field] for field in COLOR_FIELDS if _is_colour(dark.get(field), PALETTE_HEX)}
        out[DARK_FIELD].update(kept)
    return out


def shown_palettes(theme: object) -> list[tuple[Palette, dict[str, str]]]:
    """The palettes respondents can be shown, by name: the light one for mode light, the dark one for mode dark, both
    for auto (the respondent's device picks)."""
    full = with_defaults(theme)
    light = {field: full[field] for field in COLOR_FIELDS}
    if full['mode'] == 'light':
        return [('light', light)]
    if full['mode'] == 'dark':
        return [('dark', full[DARK_FIELD])]
    return [('light', light), ('dark', full[DARK_FIELD])]


# ── WCAG 2 contrast ──────────────────────────────────────────────────────────────────────────────────────────────

Rgba = tuple[float, float, float, float]


def _rgba(colour: str) -> Rgba:
    """The channels (0 to 1) and alpha of a checked hex colour (`#rgb`, `#rrggbb`, `#rrggbbaa`)."""
    digits = colour[1:]
    if len(digits) == 3:
        digits = ''.join(ch * 2 for ch in digits)
    channels = [int(digits[i:i + 2], 16) / 255 for i in range(0, len(digits), 2)]
    alpha = channels[3] if len(channels) == 4 else 1.0
    return channels[0], channels[1], channels[2], alpha


def _over(top: Rgba, bottom: tuple[float, float, float]) -> tuple[float, float, float]:
    """``top`` painted at its alpha over the opaque ``bottom`` (sRGB, as a browser mixes)."""
    alpha = top[3]
    return (top[0] * alpha + bottom[0] * (1 - alpha), top[1] * alpha + bottom[1] * (1 - alpha),
            top[2] * alpha + bottom[2] * (1 - alpha))


def _luminance(rgb: tuple[float, float, float]) -> float:
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def _ratio(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    hi, lo = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def _opaque_background(background: str) -> tuple[float, float, float]:
    """A background as painted: an old `#rrggbbaa` one over white (the API's own page)."""
    return _over(_rgba(background), (1.0, 1.0, 1.0))


def contrast_ratio(foreground: str, background: str) -> float | None:
    """The WCAG 2 contrast of ``foreground`` painted on ``background`` (1 to 21), or None when either is not a hex
    colour. A translucent colour is composited first, as a browser paints it."""
    if not (_is_colour(foreground, HEX_COLOR) and _is_colour(background, HEX_COLOR)):
        return None
    under = _opaque_background(background)
    return _ratio(_over(_rgba(foreground), under), under)


def text_contrast_problem(palette: Mapping[str, str]) -> float | None:
    """The text-on-background ratio of ``palette`` when it is under :data:`TEXT_PUBLISH_MINIMUM` (unreadable: the
    form cannot be published), else None."""
    ratio = contrast_ratio(palette['text_color'], palette['background_color'])
    return ratio if ratio is not None and ratio < TEXT_PUBLISH_MINIMUM else None
