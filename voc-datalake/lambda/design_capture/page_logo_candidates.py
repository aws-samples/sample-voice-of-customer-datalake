"""The logo CANDIDATES of a live page: every element near the top that could be the company logo, numbered.

``CANDIDATES_JS`` runs in the page tab as one ``Runtime.evaluate`` (``candidates_expression``), after the styles
and before the screenshots (the page is still scrolled to the top). It walks the document AND every open shadow
root (web-component headers draw their logo there) and lists, in reading order, up to ``MAX_CANDIDATES`` visible
elements whose box starts within the first ``TOP_PX`` of the page:

- ``img``: an ``<img>`` (its ``currentSrc``);
- ``inline-svg``: an outermost ``<svg>`` element;
- ``css-bg``: an element painted with a CSS ``background-image: url(…)`` (a logo file, or a sprite);
- ``text``: a link to the site's root, or a ``*logo*`` element, drawn with short text and no image.

Each comes with its box, its ``alt`` / ``aria-label`` / ``title``, its link's label, whether it sits in the header
and links home, whether it is inside a cookie / consent banner (``page_consent``), and a short class chain. The
page's ``<head>`` icons (touch icons, favicons) are listed apart: a logo of last resort. ``og:image`` is never a
candidate: it is a share card.

The elements themselves stay in the page (``STASH``) so that ``MARK_JS`` can outline them with their numbers for
the model (``logo_pick``), and ``logo_isolate`` can photograph the one picked. The answer is untrusted page
output: ``parse_candidates`` re-checks and re-caps every field.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Final

from page_consent import with_consent_check

from shared.llm_json import json_object_or_none

#: Where the logo is looked for: elements whose box starts above this, in document px.
TOP_PX: Final = 520
MAX_CANDIDATES: Final = 30
MAX_HEAD_ICONS: Final = 12
MAX_SCANNED: Final = 6_000
MAX_LABEL_CHARS: Final = 80
MAX_TEXT_CHARS: Final = 40
MAX_CLASS_CHARS: Final = 200
MAX_URL_CHARS: Final = 2_000
#: The page property holding the candidate elements (read by MARK_JS and ``logo_isolate``).
STASH: Final = '__vocLogoCandidates'
KINDS: Final = ('img', 'inline-svg', 'css-bg', 'text')
HEAD_KINDS: Final = ('touch-icon', 'icon')
CANDIDATE_LIMITS: Final = {'top': TOP_PX, 'max': MAX_CANDIDATES, 'head': MAX_HEAD_ICONS, 'scan': MAX_SCANNED,
                           'label': MAX_LABEL_CHARS, 'text': MAX_TEXT_CHARS, 'classes': MAX_CLASS_CHARS,
                           'url': MAX_URL_CHARS, 'stash': STASH}

CANDIDATES_JS: Final = with_consent_check(r"""
((L) => {
  try {
    /*IN_CONSENT*/
    const cut = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
    const abs = (h) => { try { return h ? new URL(h, location.href).href.slice(0, L.url) : null; } catch (e) { return null; } };
    const parentOf = (n) => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
    const up = (el, sel) => { for (let n = el; n; n = parentOf(n)) { if (n.nodeType === 1 && n.matches(sel)) return n; } return null; };
    // Every element, the open shadow roots included, in document order (capped).
    const all = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (all.length >= L.scan) return;
        all.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    const box = (el) => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      if (!(r.width >= 8 && r.height >= 8) || s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return null;
      const top = r.top + scrollY;
      if (r.bottom + scrollY <= 0 || top > L.top || r.right <= 0 || r.left >= innerWidth) return null;
      return { x: Math.round(r.left + scrollX), y: Math.round(top), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const host = (u) => u.host.replace(/^www\./, '');
    const isHome = (a) => {
      try { const u = new URL(a.getAttribute('href') || '', location.href);
            return host(u) === host(location) && (u.pathname === '/' || /^\/[a-z]{2}([-_][a-z]{2})?\/?$/i.test(u.pathname)); }
      catch (e) { return false; }
    };
    const classOf = (n) => typeof n.className === 'string' ? n.className : (n.className && n.className.baseVal) || '';
    const chain = (el) => {
      const parts = []; let n = el;
      for (let i = 0; n && n.nodeType === 1 && i < 4; i += 1, n = parentOf(n)) {
        const c = cut(classOf(n), 60); const id = cut(n.id, 40);
        if (c || id) parts.push((id ? '#' + id + ' ' : '') + c);
      }
      return cut(parts.join(' < '), L.classes);
    };
    const titleOf = (el) => { const t = el.querySelector && el.querySelector('title'); return t ? t.textContent : ''; };
    const label = (el) => cut(el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || titleOf(el), L.label);
    const linkOf = (el) => up(el, 'a[href]');
    const found = []; const seen = new Set();
    const add = (el, kind, url, extra) => {
      if (seen.has(el)) return;
      const b = box(el); if (!b) return;
      seen.add(el);
      const a = linkOf(el);
      found.push({ el, kind, url, box: b, label: label(el), link_label: a ? cut(a.getAttribute('aria-label') || a.getAttribute('title'), L.label) : '',
        in_header: !!up(el, 'header, nav, [role=banner]'), home_link: !!a && isHome(a), in_consent: inConsent(el),
        classes: chain(el), text: '', ...(extra || {}) });
    };
    const LOGOISH = /logo|brand/i;
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'img') { const u = abs(el.currentSrc || el.getAttribute('src')); if (u) add(el, 'img', u); continue; }
      if (tag === 'svg') { if (!(el.parentElement && el.parentElement.closest('svg'))) add(el, 'inline-svg', null); continue; }
      if (el.closest('svg')) continue;
      const bg = (getComputedStyle(el).backgroundImage || '').match(/url\(["']?([^"')]+)["']?\)/);
      if (bg && (up(el, 'header, nav, [role=banner], a[href]') || LOGOISH.test(classOf(el) + ' ' + el.id))) {
        const u = abs(bg[1]); if (u) { add(el, 'css-bg', u); continue; }
      }
      const homeLink = tag === 'a' && el.hasAttribute('href') && isHome(el);
      if ((homeLink || LOGOISH.test(classOf(el) + ' ' + el.id)) && !el.querySelector('img, svg, picture')) {
        const text = cut(el.innerText || el.textContent, L.text + 1);
        if (text && text.length <= L.text && !/\n/.test(text)) add(el, 'text', null, { text });
      }
    }
    found.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    const shown = found.slice(0, L.max);
    window[L.stash] = shown.map((c) => c.el);
    const head = [];
    for (const link of document.querySelectorAll('link[rel~="apple-touch-icon"][href], link[rel~="apple-touch-icon-precomposed"][href], link[rel~="icon"][href]')) {
      if (head.length >= L.head) break;
      const u = abs(link.getAttribute('href'));
      if (u) head.push({ kind: /apple/i.test(link.getAttribute('rel') || '') ? 'touch-icon' : 'icon', url: u, sizes: cut(link.getAttribute('sizes'), 40) });
    }
    return JSON.stringify({ url: location.href, candidates: shown.map(({ el, ...rest }, i) => ({ n: i + 1, ...rest })), head });
  } catch (e) {
    return JSON.stringify(null);
  }
})
""")

#: Outlines every stashed candidate with its number (set-of-marks), inside a CLOSED shadow root reset with
#: ``all: initial`` so the page's own CSS cannot restyle the marks. Returns how many were marked.
MARK_JS: Final = r"""
((stash) => {
  const els = window[stash] || [];
  const old = window[stash + 'Marks']; if (old) old.remove();
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
  const root = host.attachShadow({ mode: 'closed' });
  const base = 'position:absolute;box-sizing:border-box;margin:0;';
  els.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const mark = document.createElement('div');
    mark.style.cssText = `${base}left:${r.left + scrollX - 2}px;top:${r.top + scrollY - 2}px;width:${r.width + 4}px;height:${r.height + 4}px;border:2px solid #ff00aa`;
    const tag = document.createElement('div');
    tag.textContent = String(i + 1);
    tag.style.cssText = `${base}left:-2px;top:-16px;background:#ff00aa;color:#fff;font:bold 12px/14px Arial,sans-serif;padding:0 3px;white-space:nowrap`;
    mark.appendChild(tag);
    root.appendChild(mark);
  });
  document.documentElement.appendChild(host);
  window[stash + 'Marks'] = host;
  return els.length;
})
"""

#: Removes the marks again (the page is photographed for the design afterwards).
CLEAR_MARKS_JS: Final = r"""
((stash) => { const host = window[stash + 'Marks']; if (host) host.remove(); window[stash + 'Marks'] = null; return true; })
"""


def candidates_expression() -> str:
    """``CANDIDATES_JS`` called with ``CANDIDATE_LIMITS``."""
    return f'({CANDIDATES_JS})({json.dumps(CANDIDATE_LIMITS)})'


def mark_expression() -> str:
    return f'({MARK_JS})({json.dumps(STASH)})'


def clear_marks_expression() -> str:
    return f'({CLEAR_MARKS_JS})({json.dumps(STASH)})'


@dataclass(frozen=True)
class LogoCandidate:
    """One numbered element (``n`` is its 1-based place in the stash, the number the model sees)."""
    n: int
    kind: str
    url: str | None
    x: int
    y: int
    width: int
    height: int
    label: str = ''
    link_label: str = ''
    text: str = ''
    classes: str = ''
    in_header: bool = False
    home_link: bool = False
    in_consent: bool = False


@dataclass(frozen=True)
class HeadIcon:
    kind: str
    url: str
    sizes: str = ''


@dataclass(frozen=True)
class LogoCandidates:
    """What the page offered: the numbered candidates, and its ``<head>`` icons (a logo of last resort)."""
    page_url: str
    candidates: tuple[LogoCandidate, ...] = ()
    head: tuple[HeadIcon, ...] = ()

    def by_number(self, n: object) -> LogoCandidate | None:
        if isinstance(n, bool) or not isinstance(n, int):
            return None
        return next((c for c in self.candidates if c.n == n), None)

    def head_icon(self, kind: str) -> HeadIcon | None:
        """The largest https ``<head>`` icon of ``kind`` (by its declared ``sizes``), or None."""
        icons = [h for h in self.head if h.kind == kind and h.url.startswith('https://')]
        return max(icons, key=lambda h: _declared_side(h.sizes), default=None)


def _declared_side(sizes: str) -> int:
    sides = [int(m) for m in re.findall(r'(\d{1,4})x\d{1,4}', sizes)]
    return max(sides, default=0)


def _str(value: object, limit: int) -> str:
    return str(value)[:limit] if isinstance(value, str) else ''


def _int(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return int(value)


def _candidate(raw: object, expected_n: int) -> LogoCandidate | None:
    if not isinstance(raw, dict) or raw.get('n') != expected_n or raw.get('kind') not in KINDS:
        return None
    raw_box = raw.get('box')
    box = raw_box if isinstance(raw_box, dict) else {}
    x, y, w, h = (_int(box.get(k)) for k in ('x', 'y', 'w', 'h'))
    if x is None or y is None or w is None or h is None or w <= 0 or h <= 0:
        return None
    url = _str(raw.get('url'), MAX_URL_CHARS) or None
    if raw['kind'] in ('img', 'css-bg') and (url is None or not url.startswith(('https://', 'http://', 'data:'))):
        return None
    return LogoCandidate(
        n=expected_n, kind=raw['kind'], url=url, x=x, y=y, width=w, height=h,
        label=_str(raw.get('label'), MAX_LABEL_CHARS), link_label=_str(raw.get('link_label'), MAX_LABEL_CHARS),
        text=_str(raw.get('text'), MAX_TEXT_CHARS), classes=_str(raw.get('classes'), MAX_CLASS_CHARS),
        in_header=raw.get('in_header') is True, home_link=raw.get('home_link') is True,
        in_consent=raw.get('in_consent') is True)


def _head(raw: object) -> HeadIcon | None:
    if not isinstance(raw, dict) or raw.get('kind') not in HEAD_KINDS:
        return None
    url = _str(raw.get('url'), MAX_URL_CHARS)
    return HeadIcon(str(raw['kind']), url, _str(raw.get('sizes'), 40)) if url else None


def parse_candidates(raw: object, page_url: str) -> LogoCandidates:
    """The evaluate's answer, re-checked; an unreadable answer is no candidates (never an error).

    Candidates must be numbered 1, 2, 3… as the page stashed them: the first malformed one ends the list, so
    every kept number still names its stashed element.
    """
    data = json_object_or_none(raw)
    if data is None:
        return LogoCandidates(page_url)
    candidates: list[LogoCandidate] = []
    items = data.get('candidates')
    for n, item in enumerate(items if isinstance(items, list) else [], 1):
        if n > MAX_CANDIDATES:
            break
        candidate = _candidate(item, n)
        if candidate is None:
            break
        candidates.append(candidate)
    rows = data.get('head')
    head = [icon for icon in (_head(r) for r in (rows if isinstance(rows, list) else [])[:MAX_HEAD_ICONS])
            if icon is not None]
    return LogoCandidates(page_url, tuple(candidates), tuple(head))


# ── The model's listing, and the rules used without a model ───────────────────

def _file_name(url: str | None) -> str:
    if not url or url.startswith('data:'):
        return 'inline data' if url else ''
    return url.split('?', 1)[0].rstrip('/').rsplit('/', 1)[-1][-80:]


def listing(found: LogoCandidates) -> str:
    """The candidates as the model reads them, one line each (untrusted values JSON-quoted), then the head icons."""
    rows = []
    for c in found.candidates:
        flags = ''.join(f' {name}' for name, on in (('in-header', c.in_header), ('links-home', c.home_link),
                                                     ('in-cookie-banner', c.in_consent)) if on)
        text = f' text={json.dumps(c.text)}' if c.text else ''
        rows.append(f'#{c.n} {c.kind} at x={c.x} y={c.y} {c.width}x{c.height}px{flags} label={json.dumps(c.label)}'
                    f' link_label={json.dumps(c.link_label)}{text} classes={json.dumps(c.classes[:100])}'
                    f' file={json.dumps(_file_name(c.url))}')
    head = [' '.join(part for part in (h.kind, h.sizes, f'file={json.dumps(_file_name(h.url))}') if part)
            for h in found.head]
    return ('On-screen candidates:\n' + ('\n'.join(rows) or '(none)')
            + '\n\nIn <head> (not on screen):\n' + ('\n'.join(head) or '(none)'))


_LOGO_WORDS: Final = re.compile(r'logo|brand|wordmark|home', re.IGNORECASE)
#: A candidate the rules accept scores at least this (a home link in the header, logo-shaped, at the top: 6).
RULES_MIN_SCORE: Final = 4
_MAX_LOGO_HEIGHT: Final = 160
_MAX_LOGO_WIDTH: Final = 500
_GLYPH_PX: Final = 28


def _score(c: LogoCandidate) -> float:
    if c.height < 12 or c.height > _MAX_LOGO_HEIGHT or c.width > _MAX_LOGO_WIDTH or c.in_consent:
        return 0.0
    ratio = c.width / c.height
    return ((3 if c.home_link else 0)
            + (2 if _LOGO_WORDS.search(f'{c.label} {c.link_label} {c.classes}') else 0)
            + (1 if c.in_header else 0)
            + (1 if c.y < 150 else -1)
            + (1 if 1.5 <= ratio <= 8 else 0)
            - (2 if c.width < _GLYPH_PX and c.height < _GLYPH_PX else 0))


def rules_pick(found: LogoCandidates) -> int | None:
    """The candidate the scoring rules take as the logo (the highest score, first on a tie), or None below
    ``RULES_MIN_SCORE``: used when the model could not answer."""
    best, best_score = None, 0.0
    for c in found.candidates:
        score = _score(c)
        if score > best_score:
            best, best_score = c.n, score
    return best if best is not None and best_score >= RULES_MIN_SCORE else None
