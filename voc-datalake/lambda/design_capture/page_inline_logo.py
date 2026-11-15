"""A standalone copy of the picked INLINE ``<svg>`` logo (an ``<svg>`` element in the page, not an ``<img src=….svg>``).

When the logo the pick chose (``logo_pick``) is an inline SVG, the capture worker runs ONE more
``Runtime.evaluate`` in the page tab (``inline_svg_expression``): ``INLINE_SVG_JS`` serialises a standalone copy of
that stashed candidate (``page_logo_candidates.STASH``), kept beside the PNG as a download-only SVG:

- the copy carries each element's COMPUTED ``fill`` / ``stroke`` / opacity (when the element sets none itself and
  the value is not a ``url()``) and the root's computed ``color`` (``currentColor``), since the page's stylesheets
  do not travel with it; a ``<use href="#id">`` whose symbol lives elsewhere in the document (an icon sprite) gets
  that symbol copied into a ``<defs>``;
- the answer is ``{svg, width, height}`` (the measured box) or null; a serialisation longer than
  ``MAX_INLINE_SVG_CHARS`` is dropped in the page (a cut SVG would not parse anyway).

The markup is untrusted: ``shared.design_svg.sanitize_svg`` rebuilds it deny-by-default (``page_logo``) — see that
module. The PNG the reference records is the browser's own drawing of the element (``logo_isolate``), so a copy that
does not survive sanitising only means no SVG download.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Final

from page_logo_candidates import STASH

from shared.llm_json import json_object_or_none

MIN_SIDE: Final = 8
MAX_COPIED_ELEMENTS: Final = 3_000
MAX_INLINE_SVG_CHARS: Final = 200_000
INLINE_LIMITS: Final = {'copied': MAX_COPIED_ELEMENTS, 'chars': MAX_INLINE_SVG_CHARS, 'stash': STASH}

INLINE_SVG_JS: Final = r"""
((L, n) => {
  try {
    const svg = (window[L.stash] || [])[n - 1];
    if (!svg || !svg.isConnected || String(svg.tagName).toLowerCase() !== 'svg') return JSON.stringify(null);
    const r = svg.getBoundingClientRect();
    const copy = svg.cloneNode(true);
    const PAINT = ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity'];
    const originals = [svg, ...Array.from(svg.querySelectorAll('*'))].slice(0, L.copied);
    const copies = [copy, ...Array.from(copy.querySelectorAll('*'))].slice(0, L.copied);
    originals.forEach((el, i) => {
      const target = copies[i]; if (!target) return;
      const s = getComputedStyle(el);
      for (const name of PAINT) {
        const value = s.getPropertyValue(name);
        if (value && !el.hasAttribute(name) && !/url\(/i.test(value)) target.setAttribute(name, value);
      }
    });
    copy.setAttribute('color', getComputedStyle(svg).color);
    const ids = new Set(Array.from(copy.querySelectorAll('[id]')).map((el) => el.id));
    const lookup = svg.getRootNode && svg.getRootNode().getElementById ? svg.getRootNode() : document;
    let defs = null;
    for (const use of Array.from(copy.querySelectorAll('use'))) {
      const ref = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
      if (!ref.startsWith('#') || ids.has(ref.slice(1))) continue;
      const symbol = lookup.getElementById(ref.slice(1)) || document.getElementById(ref.slice(1));
      if (!symbol || !symbol.closest('svg')) continue;
      if (!defs) { defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs'); copy.insertBefore(defs, copy.firstChild); }
      defs.appendChild(symbol.cloneNode(true)); ids.add(ref.slice(1));
    }
    if (!copy.getAttribute('xmlns')) copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const text = new XMLSerializer().serializeToString(copy);
    if (text.length > L.chars) return JSON.stringify(null);
    return JSON.stringify({ svg: text, width: Math.round(r.width), height: Math.round(r.height) });
  } catch (e) {
    return JSON.stringify(null);
  }
})
"""


@dataclass(frozen=True)
class InlineSvg:
    """The page's inline SVG logo as the page serialised it (untrusted) and the box it measured."""
    markup: str
    width: float
    height: float


def inline_svg_expression(number: int) -> str:
    """``INLINE_SVG_JS`` for stashed candidate ``number``."""
    return f'({INLINE_SVG_JS})({json.dumps(INLINE_LIMITS)}, {int(number)})'


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def parse_inline_logo(raw: object) -> InlineSvg | None:
    """The evaluate's answer, re-checked (it is untrusted); None for anything but ``{svg, width, height}``."""
    data = json_object_or_none(raw)
    if data is None:
        return None
    markup, width, height = data.get('svg'), _number(data.get('width')), _number(data.get('height'))
    if not isinstance(markup, str) or not markup or len(markup) > MAX_INLINE_SVG_CHARS:
        return None
    if width is None or height is None or width < MIN_SIDE or height < MIN_SIDE:
        return None
    return InlineSvg(markup, width, height)
