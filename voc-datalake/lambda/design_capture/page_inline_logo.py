"""A live website's INLINE ``<svg>`` logo (an ``<svg>`` element in the header, not an ``<img src=….svg>``).

Many sites draw their logo as markup in the header, so ``page_styles`` (which names image URLs only)
finds no logo at all. When the page names no ``header`` logo image, the capture worker runs ONE more
``Runtime.evaluate`` in the page tab (``inline_logo_expression``): ``INLINE_LOGO_JS`` picks the inline SVG
that looks like the logo and serialises a standalone copy of it:

- candidates are ``<svg>`` elements in ``header`` / ``nav`` or in / named by a ``*logo*`` / ``*brand*``
  container, never inside a cookie / consent banner, never nested in another SVG, visible and at least
  ``MIN_WIDTH`` by ``MIN_HEIGHT`` px (icons such as a 16 px search glass are smaller);
- one is a LOGO when it, or one of its ``LOGO_ANCESTORS`` nearest ancestors, has an id / class /
  ``aria-label`` naming ``logo`` or ``brand``, or is a link to the site's root (``/``), or the SVG's own
  ``<title>`` says ``logo``; inside ``header`` / ``nav`` first, then the highest on the page;
- the copy carries each element's COMPUTED ``fill`` / ``stroke`` / opacity (when the element sets none
  itself and the value is not a ``url()``) and the root's computed ``color`` (``currentColor``), since the
  page's stylesheets do not travel with it; a ``<use href="#id">`` whose symbol lives elsewhere in the
  document (an icon sprite) gets that symbol copied into a ``<defs>``;
- the answer is ``{svg, width, height}`` (the measured box) or null; a serialisation longer than
  ``MAX_INLINE_SVG_CHARS`` is dropped in the page (a cut SVG would not parse anyway).

The markup is untrusted: ``shared.design_svg.sanitize_svg`` rebuilds it deny-by-default before the
browser draws it as an image (``logo_render``) — see that module.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Final

from page_consent import with_consent_check

from shared.llm_json import json_object_or_none

MIN_WIDTH: Final = 24
MIN_HEIGHT: Final = 12
LOGO_ANCESTORS: Final = 4
MAX_CANDIDATES: Final = 40
MAX_COPIED_ELEMENTS: Final = 3_000
MAX_INLINE_SVG_CHARS: Final = 200_000
INLINE_LIMITS: Final = {'min_w': MIN_WIDTH, 'min_h': MIN_HEIGHT, 'ancestors': LOGO_ANCESTORS,
                        'candidates': MAX_CANDIDATES, 'copied': MAX_COPIED_ELEMENTS, 'chars': MAX_INLINE_SVG_CHARS}

INLINE_LOGO_JS: Final = with_consent_check(r"""
((L) => {
  try {
    const LOGO = /logo|brand/i;
    /*IN_CONSENT*/
    const classOf = (node) => typeof node.className === 'string' ? node.className
      : (node.className && node.className.baseVal) || '';
    const labelOf = (node) => [node.id || '', classOf(node), node.getAttribute('aria-label') || ''].join(' ');
    const isRootLink = (node) => {
      if (node.tagName !== 'A') return false;
      try { const u = new URL(node.getAttribute('href') || '', location.href);
            return u.origin === location.origin && (u.pathname === '/' || u.pathname === ''); } catch (e) { return false; }
    };
    const looksLikeLogo = (svg) => {
      let node = svg;
      for (let i = 0; node && node !== document.body && i <= L.ancestors; i += 1, node = node.parentElement) {
        if (LOGO.test(labelOf(node)) || isRootLink(node)) return true;
      }
      const title = svg.querySelector('title');
      return !!(title && /logo/i.test(title.textContent || ''));
    };
    const selector = 'header svg, nav svg, [class*=logo i] svg, [id*=logo i] svg, [class*=brand i] svg, svg[class*=logo i], svg[aria-label*=logo i]';
    const placed = [];
    for (const svg of Array.from(document.querySelectorAll(selector)).slice(0, L.candidates)) {
      if (svg.parentElement && svg.parentElement.closest('svg')) continue;
      const r = svg.getBoundingClientRect(); const s = getComputedStyle(svg);
      if (r.width < L.min_w || r.height < L.min_h || s.visibility === 'hidden' || s.display === 'none') continue;
      if (inConsent(svg) || !looksLikeLogo(svg)) continue;
      placed.push({ svg, r, framed: svg.closest('header, nav') ? 0 : 1, top: r.top + scrollY });
    }
    placed.sort((a, b) => a.framed - b.framed || a.top - b.top);
    if (!placed.length) return JSON.stringify(null);
    const { svg, r } = placed[0];
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
    let defs = null;
    for (const use of Array.from(copy.querySelectorAll('use'))) {
      const ref = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
      if (!ref.startsWith('#') || ids.has(ref.slice(1))) continue;
      const symbol = document.getElementById(ref.slice(1));
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
""")


@dataclass(frozen=True)
class InlineSvg:
    """The page's inline SVG logo as the page serialised it (untrusted) and the box it measured."""
    markup: str
    width: float
    height: float


def inline_logo_expression() -> str:
    """``INLINE_LOGO_JS`` called with ``INLINE_LIMITS`` — the optional second ``Runtime.evaluate``."""
    return f'({INLINE_LOGO_JS})({json.dumps(INLINE_LIMITS)})'


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
    if width is None or height is None or width < MIN_WIDTH or height < MIN_HEIGHT:
        return None
    return InlineSvg(markup, width, height)


def wants_inline_logo(logos: list[dict], page_url: str) -> bool:
    """Whether to look for an inline SVG logo: the page names no ``header`` logo image, and the page is https
    (a rendered logo is recorded with the page as its ``source_url``, which must be https)."""
    return page_url.startswith('https://') and not any(logo.get('kind') == 'header' for logo in logos)
