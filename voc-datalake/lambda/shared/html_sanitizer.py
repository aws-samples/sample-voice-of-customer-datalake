"""A deny-by-default HTML sanitizer for a design-system component's ``example_html``.

The snippet comes from an admin, a model or a captured page, so it is untrusted. It is never
rendered in the app document (the editor shows it, if at all, in a sandboxed ``<iframe srcdoc>``),
but it is stored and served, so it is REBUILT from an allowlist rather than filtered:

- elements: ``div span button a input label p h1-h6 ul li img`` and the SVG basic shapes
  (``svg g path rect circle ellipse line polyline polygon``). Any other element is unwrapped
  (its text and allowed children are kept); the content of ``script``, ``style``, ``iframe``,
  ``object``, ``embed``, ``template``, ``noscript``, ``textarea``, ``select``, ``title``,
  ``math``, ``foreignObject``, ``use`` … is dropped whole. Comments, doctypes and processing
  instructions are dropped.
- attributes: ``class``, ``style``, ``type``, ``placeholder``, ``role``, ``aria-*``, ``alt``;
  ``href`` on ``a`` only when it is ``https://…`` or a ``#fragment``; ``src`` on ``img`` only
  when it is ``https://…`` or a raster ``data:image/(png|jpeg|gif|webp);base64,…``; SVG geometry
  attributes on the shapes with numeric / path-data values. Everything else — every ``on*``
  handler, ``srcdoc``, ``formaction``, ``action``, ``xlink:href``, ``target`` — is dropped.
- ``style``: each declaration is kept only when its property is a plain CSS name and its value
  uses no function outside the colour / ``var`` / ``calc`` allowlist (no ``url()``,
  ``expression()``, ``image-set()``), no backslash escape, no ``@`` and no ``javascript:``.

The parser decodes character references BEFORE the checks (so ``java&#115;cript:`` is seen as
``javascript:``) and every text and attribute value is re-escaped on output. The result is
balanced: unclosed elements are closed, stray end tags dropped.
"""
from __future__ import annotations

import html
import re
from html.parser import HTMLParser
from typing import Final

ALLOWED_TAGS: Final = frozenset({
    'div', 'span', 'button', 'a', 'input', 'label', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'li', 'img',
    'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
})
VOID_TAGS: Final = frozenset({'input', 'img'})
SVG_SHAPES: Final = frozenset({'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'})
#: Elements whose whole content is dropped, not unwrapped.
DROPPED_WITH_CONTENT: Final = frozenset({
    'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'template', 'noscript',
    'noembed', 'noframes', 'textarea', 'select', 'option', 'title', 'head', 'math', 'foreignobject', 'use',
    'xmp', 'plaintext', 'canvas', 'video', 'audio', 'picture', 'source', 'link', 'meta', 'base',
})
#: The dropped elements that are void in HTML (no end tag follows them).
DROPPED_VOID_TAGS: Final = frozenset({'link', 'meta', 'base', 'source', 'embed', 'frame'})
COMMON_ATTRIBUTES: Final = frozenset({'class', 'style', 'type', 'placeholder', 'role', 'alt'})
SVG_ATTRIBUTES: Final = frozenset({
    'viewbox', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
    'd', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'points', 'opacity',
})
MAX_ATTRIBUTE_CHARS: Final = 500
MAX_DEPTH: Final = 32

_ARIA_RE: Final = re.compile(r'^aria-[a-z]{1,30}\Z')
_HTTPS_RE: Final = re.compile(r'^https://[^\s<>"\'`\\]+\Z', re.IGNORECASE)
_FRAGMENT_RE: Final = re.compile(r'^#[\w.:-]{0,100}\Z')
_DATA_IMAGE_RE: Final = re.compile(r'^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]{1,400}\Z')
_SVG_VALUE_RE: Final = re.compile(r'^[\w\s.,#%()+-]{1,400}\Z')
_CONTROL_RE: Final = re.compile(r'[\x00-\x20\x7f]+')
_CSS_PROPERTY_RE: Final = re.compile(r'^-?[a-z][a-z-]{0,40}\Z')
_CSS_VALUE_RE: Final = re.compile(r'^[\w\s#%.,()/+\-"\'!]{1,200}\Z')
CSS_FUNCTION_RE: Final = re.compile(r'([a-zA-Z-]+)\s*\(')
CSS_FUNCTIONS: Final = frozenset({
    'rgb', 'rgba', 'hsl', 'hsla', 'oklch', 'oklab', 'lab', 'lch', 'var', 'calc', 'min', 'max', 'clamp',
    'linear-gradient', 'radial-gradient', 'translate', 'translatex', 'translatey', 'scale', 'rotate',
})
_CSS_DENIED_WORDS: Final = ('javascript', 'expression', 'behavior', 'binding', 'url', 'image', 'import')


def _clean_css_declaration(declaration: str) -> str | None:
    name, sep, value = declaration.partition(':')
    prop, val = name.strip().lower(), value.strip()
    if not sep or not _CSS_PROPERTY_RE.match(prop) or not _CSS_VALUE_RE.match(val):
        return None
    lowered = val.lower()
    if any(word in lowered for word in _CSS_DENIED_WORDS) or any(word in prop for word in _CSS_DENIED_WORDS):
        return None
    if any(fn.lower() not in CSS_FUNCTIONS for fn in CSS_FUNCTION_RE.findall(val)):
        return None
    return f'{prop}: {val}'


def clean_style(value: str) -> str:
    """The safe declarations of an inline ``style`` (``''`` when none survive)."""
    if '\\' in value or '@' in value or '<' in value or '/*' in value:
        return ''
    kept = [d for d in (_clean_css_declaration(part) for part in value.split(';') if part.strip()) if d]
    return '; '.join(kept)


def _clean_url(value: str, pattern: re.Pattern[str]) -> str | None:
    compact = _CONTROL_RE.sub('', value)
    return compact if pattern.match(compact) or _HTTPS_RE.match(compact) else None


def _clean_svg_value(value: str) -> str | None:
    if not _SVG_VALUE_RE.match(value):
        return None
    if any(fn.lower() not in CSS_FUNCTIONS for fn in CSS_FUNCTION_RE.findall(value)):
        return None
    return value


def clean_attribute(tag: str, name: str, value: str | None) -> str | None:
    """The attribute's safe value, or None to drop it (deny by default)."""
    text = (value or '').strip()
    if len(text) > MAX_ATTRIBUTE_CHARS:
        return None
    if name in COMMON_ATTRIBUTES or _ARIA_RE.match(name):
        if name == 'style':
            return clean_style(text) or None
        return text
    if name == 'href' and tag == 'a':
        return _clean_url(text, _FRAGMENT_RE)
    if name == 'src' and tag == 'img':
        return _clean_url(text, _DATA_IMAGE_RE)
    if tag in SVG_SHAPES and name in SVG_ATTRIBUTES:
        return _clean_svg_value(text)
    return None


class _Sanitizer(HTMLParser):
    """Rebuilds the document from allowed tokens only."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.open: list[str] = []
        self.dropping: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        """A self-closing ``<x/>`` arrives here too, then as an end tag (HTMLParser's default)."""
        name = tag.lower()
        if name in DROPPED_WITH_CONTENT:
            # A void element (<link>, <meta>) never gets an end tag: dropping it must not swallow the rest.
            if name not in DROPPED_VOID_TAGS:
                self.dropping.append(name)
            return
        if self.dropping or name not in ALLOWED_TAGS or len(self.open) >= MAX_DEPTH:
            return
        parts = [name]
        for raw_name, raw_value in attrs:
            attribute = raw_name.lower()
            cleaned = clean_attribute(name, attribute, raw_value)
            if cleaned is not None:
                parts.append(f'{attribute}="{html.escape(cleaned, quote=True)}"')
        self.out.append('<' + ' '.join(parts) + '>')
        if name not in VOID_TAGS:
            self.open.append(name)

    def handle_endtag(self, tag: str) -> None:
        name = tag.lower()
        if self.dropping:
            if name == self.dropping[-1]:
                self.dropping.pop()
            return
        if name not in self.open:
            return
        while self.open:
            current = self.open.pop()
            self.out.append(f'</{current}>')
            if current == name:
                return

    def handle_data(self, data: str) -> None:
        if not self.dropping:
            self.out.append(html.escape(data, quote=False))

    def result(self) -> str:
        self.close()
        while self.open:
            self.out.append(f'</{self.open.pop()}>')
        return ''.join(self.out).strip()


def sanitize_html(raw: str) -> str:
    """``raw`` rebuilt from the allowlist (see the module docstring); ``''`` when nothing survives."""
    parser = _Sanitizer()
    parser.feed(raw)
    return parser.result()
