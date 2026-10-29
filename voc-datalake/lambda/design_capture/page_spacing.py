"""Keep layout artefacts out of a website's spacing tokens (pure; no AWS).

The vision model sees a 1440 px-wide screenshot, and a centred page shows wide, equal side margins
(``margin: 0 auto`` around a ``max-width`` column, ``width: 60vw; margin: auto``). Those are not a
spacing scale: they are whatever is left of the viewport, so they change with the window and come
out fractional (example.com gave ``page-padding 203.25px``). The page itself reports the margins it
centres with (``auto_margins``: an element's computed left and right margins, equal and non-zero),
and a spacing token is dropped when

* its px value equals one of those margins (± 0.5 px), or
* its px value is fractional and the page never measured it (lengths, component paddings / gaps,
  ``:root`` custom properties) — a fraction nobody wrote comes from ``auto`` or the viewport.

Values in other units (``rem``, ``em``) and round px values are kept: they are what a scale is made of.
"""
from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Final

from page_styles import PageStyles

#: Two px values within this distance are the same length (sub-pixel layout rounding).
SAME_LENGTH_PX: Final = 0.5
_PX_RE: Final = re.compile(r'\s*(-?\d+(?:\.\d+)?)px\s*')
_LENGTH_IN_TEXT_RE: Final = re.compile(r'(-?\d+(?:\.\d+)?)px')


def px_value(value: object) -> float | None:
    """``12.5`` for ``'12.5px'``; None for any other unit or text."""
    match = _PX_RE.fullmatch(value) if isinstance(value, str) else None
    return float(match.group(1)) if match else None


def _lengths_in(texts: Iterable[str]) -> set[float]:
    return {float(m) for text in texts for m in _LENGTH_IN_TEXT_RE.findall(text)}


def measured_lengths(styles: PageStyles) -> set[float]:
    """Every px length the page itself reported (ranked lengths, component samples, custom properties)."""
    texts = [str(row.get('value', '')) for row in styles.lengths]
    texts += [str(v) for rows in styles.components.values() for sample in rows
              for k, v in sample.items() if k in ('padding', 'gap', 'radius', 'height')]
    texts += list(styles.root_vars.values())
    return _lengths_in(texts)


def _is_artefact(px: float, centring: set[float], measured: set[float]) -> bool:
    if any(abs(px - margin) <= SAME_LENGTH_PX for margin in centring):
        return True
    return not px.is_integer() and px not in measured


def grounded_spacing(spacing: list, styles: PageStyles) -> list:
    """*spacing* without the tokens that are a centring margin or a fraction derived from the viewport."""
    centring = {px for px in (px_value(m) for m in styles.auto_margins) if px is not None and px > 0}
    measured = measured_lengths(styles)
    kept = []
    for token in spacing:
        px = px_value(token.get('value')) if isinstance(token, dict) else None
        if px is None or not _is_artefact(px, centring, measured):
            kept.append(token)
    return kept


def without_layout_artefacts(design: dict | None, styles: PageStyles) -> dict | None:
    """*design* with its ``spacing`` group passed through ``grounded_spacing`` (None stays None)."""
    if not isinstance(design, dict) or not isinstance(design.get('spacing'), list):
        return design
    return {**design, 'spacing': grounded_spacing(design['spacing'], styles)}
