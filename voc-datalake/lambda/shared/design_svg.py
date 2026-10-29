"""Sanitise an SVG logo before the managed browser draws it to a PNG (``voc-design-capture``).

Two SVG logos reach the browser as MARKUP instead of a URL: an inline ``<svg>`` in a live website's
header (serialised by the page's own collector, so it is untrusted) and a GitHub repository's
``*logo*.svg`` (read through the GitHub contents API, so a private repository works). Either way the
markup is rebuilt here, deny-by-default, before it becomes an ``<img src="data:image/svg+xml;base64,…">``:

- a ``<!DOCTYPE`` / ``<!ENTITY`` / processing instruction is refused outright (no entity expansion,
  no external entity: the parser never sees one);
- only the drawing elements in ``ALLOWED_ELEMENTS`` survive (shapes, groups, gradients, clip paths,
  masks, text, ``use``/``symbol``); ``script``, ``foreignObject``, ``style``, ``image``, ``a``,
  ``animate``/``set`` and everything else is dropped WITH its content;
- only presentation and geometry attributes in ``ALLOWED_ATTRIBUTES`` survive; every ``on*`` handler is
  gone; ``href`` / ``xlink:href`` only as a same-document ``#id``; a value carrying ``url(`` must be
  ``url(#id)``; a ``style`` attribute keeps only allowed properties with such values (no ``\\``, ``@``,
  ``expression``, ``javascript:``);
- the file's own ``<style>`` sheet is read first (``shared.design_svg_style``): its simple class / element
  rules become presentation attributes, checked like the others, so a tool-exported logo keeps its colours;
- the result is at most ``MAX_SVG_CHARS`` characters, and the root gets ``width`` / ``height`` when it
  has none (the box the page measured, else the ``viewBox``), so the browser can size the image.

The browser draws it as an image (``logo_render``): an image context runs no script and loads no
external reference anyway; this sanitiser is the second wall, not the only one.
"""
from __future__ import annotations

import base64
import re
import xml.etree.ElementTree as ET
from typing import Final
from xml.parsers import expat

from shared.design_svg_style import inline_style_sheets, local_name

SVG_NS: Final = 'http://www.w3.org/2000/svg'
XLINK_NS: Final = 'http://www.w3.org/1999/xlink'
#: The raw markup read (inline serialisation or a repository file) is refused above this size.
MAX_SVG_INPUT_BYTES: Final = 1_000_000
#: The sanitised markup handed to the browser. It rides in an async invoke payload (256 KB max, JSON-escaped
#: quotes included), so it stays well below that; a real logo is a few KB to a few tens of KB.
MAX_SVG_CHARS: Final = 100_000
MAX_ELEMENTS: Final = 5_000
#: One attribute value (a long path's ``d``) and one text run are cut / refused above these sizes.
MAX_ATTRIBUTE_CHARS: Final = 50_000
MAX_TEXT_CHARS: Final = 2_000
MAX_DEPTH: Final = 40
#: A measured or viewBox size outside this range is not used as the root's width / height.
MIN_SIDE_PX: Final = 1.0
MAX_SIDE_PX: Final = 4_096.0

ALLOWED_ELEMENTS: Final = frozenset({
    'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
    'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'use', 'symbol', 'title', 'desc',
})
ALLOWED_ATTRIBUTES: Final = frozenset({
    'id', 'class', 'viewbox', 'preserveaspectratio', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
    'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'pathlength', 'transform', 'fill', 'fill-opacity', 'fill-rule',
    'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
    'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'color', 'clip-path', 'clip-rule', 'mask', 'display',
    'visibility', 'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform', 'spreadmethod',
    'fx', 'fy', 'fr', 'clippathunits', 'maskunits', 'maskcontentunits', 'font-family', 'font-size',
    'font-weight', 'font-style', 'letter-spacing', 'text-anchor', 'dominant-baseline', 'dx', 'dy',
    'vector-effect', 'style', 'href',
})
#: CSS properties a ``style`` attribute may keep (the presentation attributes above, as properties).
ALLOWED_STYLE_PROPERTIES: Final = frozenset({
    'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
    'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'color',
    'clip-path', 'clip-rule', 'mask', 'display', 'visibility', 'stop-color', 'stop-opacity', 'font-family',
    'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-anchor', 'dominant-baseline',
    'transform', 'vector-effect',
})
_REFUSED_MARKUP_RE: Final = re.compile(r'<!DOCTYPE|<!ENTITY|<\?(?!xml\s)', re.IGNORECASE)
_URL_RE: Final = re.compile(r'url\(\s*([^)]*)\)', re.IGNORECASE)
_LOCAL_REF_RE: Final = re.compile(r"""^['"]?#[A-Za-z_][\w.:-]{0,120}['"]?\Z""")
_HREF_RE: Final = re.compile(r'^#[A-Za-z_][\w.:-]{0,120}\Z')
_UNSAFE_VALUE_RE: Final = re.compile(r'[\\@<>]|expression|javascript:|data:', re.IGNORECASE)
_LENGTH_RE: Final = re.compile(r'^\s*(\d+(?:\.\d+)?)\s*(px)?\s*\Z')


class SvgRefused(ValueError):
    """A short reason code the SVG could not be sanitised (logged, never shown)."""


def _safe_value(value: str) -> bool:
    if _UNSAFE_VALUE_RE.search(value):
        return False
    return all(_LOCAL_REF_RE.match(target.strip()) for target in _URL_RE.findall(value))


def _clean_style(value: str) -> str:
    kept = []
    for declaration in value.split(';'):
        name, sep, prop_value = declaration.partition(':')
        name, prop_value = name.strip().lower(), prop_value.strip()
        if sep and name in ALLOWED_STYLE_PROPERTIES and prop_value and _safe_value(prop_value):
            kept.append(f'{name}:{prop_value}')
    return ';'.join(kept)


def _clean_attribute(name: str, value: str) -> str | None:
    """The attribute's kept value, or None to drop it."""
    if name.startswith('on') or name not in ALLOWED_ATTRIBUTES or len(value) > MAX_ATTRIBUTE_CHARS:
        return None
    if name == 'href':
        return value if _HREF_RE.match(value.strip()) else None
    if name == 'style':
        return _clean_style(value) or None
    return value if _safe_value(value) else None


class _Rebuilder:
    """Copies the allowed part of a parsed tree into a fresh one (counting elements against MAX_ELEMENTS)."""

    def __init__(self) -> None:
        self.count = 0

    def element(self, source: ET.Element, depth: int) -> ET.Element | None:
        name = local_name(source.tag)
        if name not in ALLOWED_ELEMENTS or depth > MAX_DEPTH:
            return None
        self.count += 1
        if self.count > MAX_ELEMENTS:
            raise SvgRefused('too_many_elements')
        copy = ET.Element(f'{{{SVG_NS}}}{name}')
        for raw_name, raw_value in source.attrib.items():
            attribute = local_name(raw_name)
            if raw_name.startswith('{') and not raw_name.startswith((f'{{{XLINK_NS}}}', f'{{{SVG_NS}}}')):
                continue
            kept = _clean_attribute(attribute, raw_value)
            if kept is not None:
                copy.set(_canonical_attribute(attribute), kept)
        if name in ('text', 'tspan', 'title', 'desc') and source.text:
            copy.text = source.text[:MAX_TEXT_CHARS]
        for child in source:
            rebuilt = self.element(child, depth + 1)
            if rebuilt is not None:
                if name in ('text', 'tspan') and child.tail:
                    rebuilt.tail = child.tail[:MAX_TEXT_CHARS]
                copy.append(rebuilt)
        return copy


#: SVG attribute names are case-sensitive; the allowlist is lower-case, so map back the camel-case ones.
_CAMEL_CASE: Final = {name.lower(): name for name in (
    'viewBox', 'preserveAspectRatio', 'pathLength', 'gradientUnits', 'gradientTransform', 'spreadMethod',
    'clipPathUnits', 'maskUnits', 'maskContentUnits')}
_CAMEL_ELEMENTS: Final = {'lineargradient': 'linearGradient', 'radialgradient': 'radialGradient',
                          'clippath': 'clipPath'}


def _canonical_attribute(name: str) -> str:
    return _CAMEL_CASE.get(name, name)


def _restore_element_case(root: ET.Element) -> None:
    for element in root.iter():
        name = local_name(element.tag)
        if name in _CAMEL_ELEMENTS:
            element.tag = f'{{{SVG_NS}}}{_CAMEL_ELEMENTS[name]}'


def _side(value: object) -> float | None:
    number = float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None
    if isinstance(value, str):
        match = _LENGTH_RE.match(value)
        number = float(match.group(1)) if match else None
    return number if number is not None and MIN_SIDE_PX <= number <= MAX_SIDE_PX else None


def _view_box_size(root: ET.Element) -> tuple[float, float] | None:
    parts = re.split(r'[\s,]+', (root.get('viewBox') or '').strip())
    try:
        width, height = float(parts[2]), float(parts[3])
    except (IndexError, ValueError):
        return None
    sides = _side(width), _side(height)
    return (sides[0], sides[1]) if sides[0] and sides[1] else None


def _ensure_size(root: ET.Element, box: tuple[object, object] | None) -> None:
    """Give the root a usable width / height: its own, else the measured box, else its viewBox."""
    if _side(root.get('width')) and _side(root.get('height')):
        return
    measured = (_side(box[0]), _side(box[1])) if box else (None, None)
    size = (measured[0], measured[1]) if measured[0] and measured[1] else _view_box_size(root)
    if size is None:
        raise SvgRefused('no_size')
    root.set('width', f'{size[0]:g}')
    root.set('height', f'{size[1]:g}')


def _refuse_declaration(*_args: object) -> None:
    raise SvgRefused('doctype_or_entity')


def _refuse_external_entity(_context: str, _base: str | None, _system_id: str | None, _public_id: str | None) -> int:
    raise SvgRefused('doctype_or_entity')


def _parse(markup: str) -> ET.Element:
    """The markup as an element tree, parsed by expat with every declaration refused.

    ``ElementTree.fromstring`` would accept a DOCTYPE with internal entities (billion laughs); here a
    DOCTYPE, an entity or notation declaration, or an external entity reference stops the parse, and
    parameter entities are never parsed. The regex pre-check in ``sanitize_svg`` refuses most of these
    before; this is the parser-level guarantee.
    """
    builder = ET.TreeBuilder()
    parser = expat.ParserCreate(namespace_separator='}')
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    handlers: dict[str, object] = {
        'StartDoctypeDeclHandler': _refuse_declaration,
        'EntityDeclHandler': _refuse_declaration,
        'NotationDeclHandler': _refuse_declaration,
        'ExternalEntityRefHandler': _refuse_external_entity,
        'StartElementHandler': lambda name, attrs: builder.start(_qualified(name), {
            _qualified(k): v for k, v in attrs.items()}),
        'EndElementHandler': lambda name: builder.end(_qualified(name)),
        'CharacterDataHandler': builder.data,
    }
    for attribute, handler in handlers.items():
        setattr(parser, attribute, handler)  # expat reads these handler slots; a table keeps them in one place
    try:
        parser.Parse(markup, True)
        return builder.close()
    except (expat.ExpatError, AssertionError, IndexError) as exc:
        raise SvgRefused('not_xml') from exc


def _qualified(name: str) -> str:
    """expat's ``uri}local`` (namespace_separator='}') → ElementTree's ``{uri}local``."""
    return '{' + name if '}' in name else name


def sanitize_svg(markup: object, box: tuple[object, object] | None = None) -> str:
    """The sanitised, standalone SVG markup; SvgRefused with a short reason code otherwise.

    ``box`` is the ``(width, height)`` in px the page measured for an inline SVG (used only when the
    root has no usable size of its own).
    """
    if isinstance(markup, bytes):
        if len(markup) > MAX_SVG_INPUT_BYTES:
            raise SvgRefused('too_large')
        markup = markup.decode('utf-8', errors='replace')
    if not isinstance(markup, str) or not markup.strip():
        raise SvgRefused('empty')
    if len(markup) > MAX_SVG_INPUT_BYTES:
        raise SvgRefused('too_large')
    if _REFUSED_MARKUP_RE.search(markup):
        raise SvgRefused('doctype_or_entity')
    parsed = _parse(markup.strip().lstrip('\ufeff'))
    if local_name(parsed.tag) != 'svg':
        raise SvgRefused('not_svg')
    inline_style_sheets(parsed)
    root = _Rebuilder().element(parsed, 0)
    if root is None or len(root) == 0:
        raise SvgRefused('nothing_drawn')
    _ensure_size(root, box)
    _restore_element_case(root)
    ET.register_namespace('', SVG_NS)
    text = ET.tostring(root, encoding='unicode')
    if len(text) > MAX_SVG_CHARS:
        raise SvgRefused('too_large')
    return text


def svg_data_url(svg: str) -> str:
    """The ``data:image/svg+xml;base64,…`` URL the browser's ``<img>`` loads (no network involved)."""
    return 'data:image/svg+xml;base64,' + base64.b64encode(svg.encode('utf-8')).decode('ascii')
