"""What the managed browser reads of ONE page for its design (pure; no AWS, no network).

``STYLES_JS`` runs in the page as ONE ``Runtime.evaluate`` (``styles_expression``) and returns a JSON string with: the
final URL and title, the document's ``:root`` custom properties, the computed styles of the
landmark elements (body, h1-h6, a, button, input, nav, header, footer, ``[class*=card]``), the
most-used colours, lengths and font families across the first elements of the page, logo candidates
(header ``img``, ``link[rel~=icon|apple-touch-icon]``, ``og:image``), and a capped sample of
visible text and HTML for block detection. Every list and string is capped in the page AND
again here (``parse_page_styles``): the page's answer is untrusted.

Component samples (``components``): for each kind — buttons (one per visual variant: filled — one
per background, at most two —, outlined, text), links, inputs (input / textarea / select), cards (``[class*=card]`` / article /
section with a border or a shadow), nav / header, tabs (``[role=tab]``), badges (badge / chip / pill
classes, or pill-shaped filled spans), tables and dialogs — up to 3 visible, distinct elements with
their computed styles in THE CONTRACT's keys and a trimmed ``outerHTML`` (≤ 600 characters, only
class/type/placeholder/role/aria-*/https-or-# href kept in the page; ``shared.html_sanitizer`` is
the real gate). ``:hover`` cannot be computed, so ``rules`` lists the ``:hover`` / ``:focus-visible``
/ ``:focus`` rules of same-origin stylesheets (cross-origin sheets throw and are skipped) that name
an interactive element or a class a sample carries, with their colour / border / shadow / outline declarations.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Final
from urllib.parse import urlparse

from page_components import (
    MAX_KIND_CANDIDATES,
    MAX_RULES,
    MAX_SAMPLES,
    MAX_SNIPPET_CHARS,
    parse_components,
    parse_rules,
)
from page_consent import with_consent_check

from shared.extracted_design import LOGO_CONTENT_TYPES
from shared.url_policy import validate_url

MAX_TEXT_CHARS: Final = 4_000
MAX_HTML_CHARS: Final = 20_000
MAX_ROOT_VARS: Final = 400
MAX_ELEMENTS: Final = 40
MAX_RANKED: Final = 30
MAX_LOGOS: Final = 8
MAX_VALUE_CHARS: Final = 300

MAX_SCANNED_ELEMENTS: Final = 1_500
#: The caps the page applies itself; ``styles_expression`` hands them over, so they live here only.
PAGE_LIMITS: Final = {'vars': MAX_ROOT_VARS, 'els': MAX_SCANNED_ELEMENTS, 'ranked': MAX_RANKED,
                      'text': MAX_TEXT_CHARS, 'html': MAX_HTML_CHARS, 'logos': MAX_LOGOS, 'value': MAX_VALUE_CHARS,
                      'candidates': MAX_KIND_CANDIDATES, 'samples': MAX_SAMPLES,
                      'snippet': MAX_SNIPPET_CHARS, 'rules': MAX_RULES}

STYLES_JS: Final = with_consent_check(r"""
((L) => {
  const cut = (s, n) => String(s == null ? '' : s).slice(0, n);
  const out = { url: location.href, title: cut(document.title, 300), vars: {}, elements: [],
                colors: [], lengths: [], fonts: [], logos: [], status: 0, text: '', html: '',
                components: {}, rules: [], auto_margins: [] };
  try {
    const nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
    out.status = nav && nav.responseStatus ? nav.responseStatus : 0;
    const root = getComputedStyle(document.documentElement);
    let n = 0;
    for (const sheet of Array.from(document.styleSheets)) {
      let rules = [];
      try { rules = Array.from(sheet.cssRules || []); } catch (e) { continue; }
      for (const rule of rules) {
        if (!rule.style || !rule.selectorText || !/(^|,)\s*(:root|html)\b/.test(rule.selectorText)) continue;
        for (const name of Array.from(rule.style)) {
          if (!name.startsWith('--') || name in out.vars || n >= L.vars) continue;
          out.vars[name] = cut(root.getPropertyValue(name).trim(), L.value); n += 1;
        }
      }
    }
    const pick = (el, tag) => {
      const s = getComputedStyle(el);
      return { tag, color: s.color, background: s.backgroundColor, font: cut(s.fontFamily, L.value),
               size: s.fontSize, weight: s.fontWeight, radius: s.borderTopLeftRadius, padding: s.paddingTop };
    };
    const tags = ['body', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'button', 'input', 'nav', 'header', 'footer',
                  '[class*=card]'];
    for (const tag of tags) { const el = document.querySelector(tag); if (el) out.elements.push(pick(el, tag)); }
    const counts = { colors: {}, lengths: {}, fonts: {} };
    const autos = {};
    // Equal, non-zero side margins centre a box (margin: auto, or what is left of the viewport): never a spacing token.
    const centring = (s) => { const l = parseFloat(s.marginLeft); if (l > 0 && Math.abs(l - parseFloat(s.marginRight)) < 0.5) autos[s.marginLeft] = 1; };
    if (document.body) centring(getComputedStyle(document.body));
    const add = (bag, v) => { if (v && v !== 'rgba(0, 0, 0, 0)' && v !== '0px' && v !== 'normal') bag[v] = (bag[v] || 0) + 1; };
    for (const el of Array.from(document.querySelectorAll('body *')).slice(0, L.els)) {
      const s = getComputedStyle(el);
      add(counts.colors, s.color); add(counts.colors, s.backgroundColor); add(counts.colors, s.borderTopColor);
      add(counts.lengths, s.borderTopLeftRadius); add(counts.lengths, s.paddingTop); add(counts.lengths, s.gap);
      add(counts.fonts, cut(s.fontFamily, L.value));
      centring(s);
    }
    out.auto_margins = Object.keys(autos).slice(0, L.ranked);
    const top = (bag) => Object.entries(bag).sort((a, b) => b[1] - a[1]).slice(0, L.ranked)
      .map(([value, count]) => ({ value: cut(value, L.value), count }));
    out.colors = top(counts.colors); out.lengths = top(counts.lengths); out.fonts = top(counts.fonts);
    const abs = (href) => { try { return new URL(href, location.href).href; } catch (e) { return null; } };
    const logo = (href, kind) => { const u = abs(href); if (u && out.logos.length < L.logos) out.logos.push({ url: u, kind }); };
    // Page logos: never an image inside a cookie / consent banner (their markup often comes BEFORE the
    // site header and names its vendor "… logo"), never a hidden one; inside <header> / <nav> first,
    // then the highest on the page.
    /*IN_CONSENT*/
    const placed = (img) => { const r = img.getBoundingClientRect(); const s = getComputedStyle(img);
      const visible = r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      return visible ? { img, framed: img.closest('header, nav') ? 0 : 1, top: r.top + scrollY } : null; };
    const logoImgs = Array.from(document.querySelectorAll('header img, nav img, [class*=logo] img, img[alt*=logo i]'))
      .filter((img) => !inConsent(img)).map(placed).filter((entry) => entry !== null)
      .sort((a, b) => a.framed - b.framed || a.top - b.top);
    for (const { img } of logoImgs.slice(0, 4)) {
      logo(img.currentSrc || img.getAttribute('src'), 'header');
    }
    for (const link of Array.from(document.querySelectorAll('link[rel~="apple-touch-icon"][href], link[rel~="icon"][href]'))) {
      logo(link.getAttribute('href'), link.rel.includes('apple') ? 'touch-icon' : 'icon');
    }
    const og = document.querySelector('meta[property="og:image"][content]');
    if (og) logo(og.getAttribute('content'), 'og-image');
    const KEEP = /^(class|type|placeholder|role|aria-[a-z]+)$/;
    const DROP = /^(script|style|iframe|object|embed|template|noscript|svg|canvas|video|audio|form|link|meta)$/i;
    const trim = (node) => {
      for (const child of Array.from(node.children)) { if (DROP.test(child.tagName)) child.remove(); else trim(child); }
      for (const attr of Array.from(node.attributes)) {
        const href = attr.name === 'href' && /^(https:\/\/|#)/.test(attr.value);
        if (!KEEP.test(attr.name) && !href) node.removeAttribute(attr.name);
        else if (attr.name === 'class') node.setAttribute('class', cut(attr.value, 120));
      }
    };
    const snippet = (el) => { const copy = el.cloneNode(true); trim(copy); return cut(copy.outerHTML, L.snippet); };
    const clear = (v) => !v || v === 'rgba(0, 0, 0, 0)' || v === 'transparent';
    const sample = (el) => {
      const s = getComputedStyle(el);
      return { background: s.backgroundColor, color: s.color, border_color: s.borderTopColor,
               border_width: s.borderTopWidth, radius: s.borderTopLeftRadius,
               padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].join(' '),
               gap: s.gap, height: s.height, font_family: cut(s.fontFamily, L.value), font_size: s.fontSize,
               font_weight: s.fontWeight, letter_spacing: s.letterSpacing, text_transform: s.textTransform,
               shadow: cut(s.boxShadow, 200), html: snippet(el) };
    };
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const buttonVariant = (x) => !clear(x.background) ? 'filled' : (parseFloat(x.border_width) > 0 ? 'outlined' : 'text');
    const framed = (x) => parseFloat(x.border_width) > 0 || (x.shadow && x.shadow !== 'none');
    const pill = (el, x) => !clear(x.background) && parseFloat(x.radius) * 2 >= el.getBoundingClientRect().height;
    const KINDS = [
      ['buttons', 'button, [role=button], a[class*=btn i], a[class*=button i], input[type=submit]', null, buttonVariant],
      ['links', 'a[href]:not([class*=btn i]):not([class*=button i]):not([role=button])', null, null],
      ['inputs', 'input:not([type=hidden]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea, select', null, null],
      ['cards', '[class*=card i], article, section', (el, x) => framed(x), null],
      ['nav', 'nav, header', null, null],
      ['tabs', '[role=tab]', null, null],
      ['badges', '[class*=badge i], [class*=chip i], [class*=pill i], span', (el, x) => el.tagName !== 'SPAN' || pill(el, x), null],
      ['tables', 'table', null, null],
      ['modals', '[role=dialog], dialog, [aria-modal=true]', null, null],
    ];
    // Filled buttons are one variant per background (a purple CTA and a white nav button are two), at most
    // two of them so an outlined / text button still gets a slot. Every sampled class is remembered: a
    // state rule naming one is read even when its selector names no known kind (`.copy:hover`).
    const sampled = new Set();
    for (const [kind, selector, keep, variantOf] of KINDS) {
      const samples = []; const seen = new Set(); let filled = 0;
      for (const el of Array.from(document.querySelectorAll(selector)).slice(0, L.candidates)) {
        if (samples.length >= L.samples || !visible(el)) continue;
        const x = sample(el);
        if (keep && !keep(el, x)) continue;
        if (variantOf) x.variant = variantOf(x);
        const key = variantOf ? (x.variant === 'filled' ? 'filled ' + x.background : x.variant)
          : JSON.stringify(Object.assign({}, x, { html: '' }));
        if (seen.has(key) || (x.variant === 'filled' && filled >= 2)) continue;
        if (x.variant === 'filled') filled += 1;
        for (const name of Array.from(el.classList).slice(0, 20)) sampled.add(name);
        seen.add(key); samples.push(x);
      }
      if (samples.length) out.components[kind] = samples;
    }
    const STATE = /:(hover|focus-visible|focus)\b/;
    const TARGET = /(button|btn|\ba\b|link|input|textarea|select|tab|card|badge|chip|nav)/i;
    const namesSampled = (sel) => (sel.match(/\.[\w-]+/g) || []).some((c) => sampled.has(c.slice(1)));
    const visit = (rules, depth) => {
      for (const rule of rules) {
        if (out.rules.length >= L.rules) return;
        if (rule.cssRules && depth < 2 && !rule.selectorText) { visit(Array.from(rule.cssRules), depth + 1); continue; }
        const sel = rule.selectorText || '';
        const state = (sel.match(STATE) || [])[1];
        if (!state || !(TARGET.test(sel) || namesSampled(sel)) || !rule.style) continue;
        const st = rule.style;
        const styles = { background: st.backgroundColor || st.background, color: st.color, border_color: st.borderColor,
                         shadow: st.boxShadow, outline: st.outline };
        for (const k of Object.keys(styles)) { if (!styles[k]) delete styles[k]; else styles[k] = cut(styles[k], L.value); }
        if (Object.keys(styles).length) out.rules.push({ selector: cut(sel, 200), state, styles });
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      let rules = [];
      try { rules = Array.from(sheet.cssRules || []); } catch (e) { continue; }
      visit(rules, 0);
    }
    out.text = cut(document.body ? document.body.innerText : '', L.text);
    out.html = cut(document.documentElement ? document.documentElement.outerHTML : '', L.html);
  } catch (e) {
    out.error = cut(e && e.name ? e.name : e, 80);
  }
  return JSON.stringify(out);
})
""")


def styles_expression() -> str:
    """``STYLES_JS`` called with ``PAGE_LIMITS`` — the ONE ``Runtime.evaluate`` of a capture."""
    return f'({STYLES_JS})({json.dumps(PAGE_LIMITS)})'

_LOGO_KIND_ORDER = {'header': 0, 'touch-icon': 1, 'og-image': 2, 'icon': 3}
_UNRANKED: Final = 9
#: The logo kinds whose SVG is rendered to a PNG (an icon's SVG is a favicon, not a logo).
SVG_RENDER_KINDS: Final = ('header', 'og-image')
_EXTENSION_TYPES = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'}


@dataclass
class PageStyles:
    """The page as the capture worker uses it (every field already capped)."""
    url: str
    title: str = ''
    status: int = 0
    text: str = ''
    html: str = ''
    root_vars: dict[str, str] = field(default_factory=dict)
    elements: list[dict] = field(default_factory=list)
    colors: list[dict] = field(default_factory=list)
    lengths: list[dict] = field(default_factory=list)
    fonts: list[dict] = field(default_factory=list)
    logos: list[dict] = field(default_factory=list)
    #: ``{kind: [sample]}`` measured component styles (page_components); ``rules``: hover / focus rules.
    components: dict[str, list[dict[str, str]]] = field(default_factory=dict)
    rules: list[dict[str, Any]] = field(default_factory=list)
    #: Computed side margins that centre a box (left == right > 0) — layout, not spacing (page_spacing).
    auto_margins: list[str] = field(default_factory=list)

    def facts(self) -> dict[str, Any]:
        """What the vision model reads beside the screenshot (no page HTML or text: that is fenced apart).

        Component samples come first (without their snippets) so the facts' size cap never cuts them;
        the custom properties come last (they are parsed into tokens without the model anyway).
        """
        samples = {kind: [{k: v for k, v in s.items() if k != 'html' and v} for s in rows]
                   for kind, rows in self.components.items()}
        return {'measured_component_styles': samples, 'hover_and_focus_rules': self.rules,
                'landmark_elements': self.elements, 'most_used_colors': self.colors,
                'most_used_lengths': self.lengths, 'font_families': self.fonts,
                'root_custom_properties': self.root_vars}


def _str(value: object, limit: int) -> str:
    return str(value)[:limit] if isinstance(value, (str, int, float)) else ''


def _dicts(value: object, limit: int) -> list[dict]:
    rows = value if isinstance(value, list) else []
    return [{str(k)[:40]: _str(v, MAX_VALUE_CHARS) for k, v in row.items()} for row in rows[:limit] if isinstance(row, dict)]


def parse_page_styles(raw: object, fallback_url: str) -> PageStyles | None:
    """The evaluate answer, re-capped; None when it is not the expected JSON object."""
    if not isinstance(raw, str):
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(data, dict) or 'error' in data:
        return None
    vars_value = data.get('vars')
    raw_vars = vars_value if isinstance(vars_value, dict) else {}
    root_vars = {str(k)[:62]: _str(v, MAX_VALUE_CHARS) for k, v in list(raw_vars.items())[:MAX_ROOT_VARS]}
    status = data.get('status')
    margins = data.get('auto_margins')
    return PageStyles(
        url=_str(data.get('url'), 2_048) or fallback_url,
        title=_str(data.get('title'), 300),
        status=status if isinstance(status, int) and not isinstance(status, bool) else 0,
        text=_str(data.get('text'), MAX_TEXT_CHARS), html=_str(data.get('html'), MAX_HTML_CHARS),
        root_vars=root_vars, elements=_dicts(data.get('elements'), MAX_ELEMENTS),
        colors=_dicts(data.get('colors'), MAX_RANKED), lengths=_dicts(data.get('lengths'), MAX_RANKED),
        fonts=_dicts(data.get('fonts'), MAX_RANKED), logos=_dicts(data.get('logos'), MAX_LOGOS),
        components=parse_components(data.get('components')), rules=parse_rules(data.get('rules')),
        auto_margins=[_str(m, 40) for m in margins[:MAX_RANKED]] if isinstance(margins, list) else [],
    )


def css_text_of_vars(root_vars: dict[str, str]) -> str:
    """The custom properties as one ``:root`` block, for ``shared.css_tokens``."""
    return ':root{' + ';'.join(f'{name}:{value}' for name, value in root_vars.items()
                               if name.startswith('--') and ';' not in value and '}' not in value) + '}'


def _raster_type(url: str, kind: str) -> str | None:
    path = urlparse(url).path.lower()
    for extension, content_type in _EXTENSION_TYPES.items():
        if path.endswith(extension):
            return content_type
    # An apple-touch-icon is a PNG by Apple's definition; anything else must say what it is.
    return 'image/png' if kind == 'touch-icon' and not path.endswith(('.svg', '.ico', '.gif')) else None


def _rank(logo: dict) -> int:
    return _LOGO_KIND_ORDER.get(logo.get('kind', ''), _UNRANKED)


def _raster_choice(logos: list[dict]) -> tuple[int, dict] | None:
    """``(rank, candidate)`` of the best raster https logo that passes the URL policy, or None."""
    for logo in sorted(logos, key=_rank):
        url, kind = logo.get('url', ''), logo.get('kind', '')
        content_type = _raster_type(url, kind) if url.startswith('https://') else None
        if content_type in LOGO_CONTENT_TYPES and validate_url(url)[0]:
            return _rank(logo), {'source_url': url, 'content_type': content_type}
    return None


def logo_candidate(logos: list[dict]) -> dict | None:
    """The best raster (PNG / JPEG / WebP) https logo the page names that passes the URL policy; SVG refused."""
    choice = _raster_choice(logos)
    return choice[1] if choice else None


def _is_svg(url: str) -> bool:
    try:
        return urlparse(url).path.lower().endswith('.svg')
    except ValueError:
        return False


def svg_logo_to_render(logos: list[dict]) -> str | None:
    """The https SVG logo worth rendering to a PNG in the browser (``logo_render``), or None.

    Only a ``header`` or ``og-image`` SVG that passes the URL policy, and only when it ranks STRICTLY better
    than the raster candidate ``logo_candidate`` would choose: a header SVG beats a touch icon or a favicon,
    a header raster still wins over a header SVG.
    """
    choice = _raster_choice(logos)
    raster_rank = choice[0] if choice else _UNRANKED
    for logo in sorted(logos, key=_rank):
        if _rank(logo) >= raster_rank:
            return None
        url = logo.get('url', '')
        if (logo.get('kind') in SVG_RENDER_KINDS and url.startswith('https://') and _is_svg(url)
                and validate_url(url)[0]):
            return url
    return None
