"""Carry an SVG's own ``<style>`` sheet over as presentation attributes before ``shared.design_svg`` drops it.

Logo files exported by drawing tools style their shapes through a sheet in the file
(``<style>.cls-1{fill:#e4002b}</style>`` + ``class="cls-1"``). The sanitiser drops every ``<style>``
element (a sheet can import, reach the network and match anything), so without this step such a logo
is drawn black. Here the sheet is READ, never kept: only simple rules survive — selectors that are one
class (``.cls-1``) or one element name (``path``), comma lists of those — and each declaration becomes
an attribute on the elements it matches (a class rule over a type rule, a later rule over an earlier
one, never over the element's own ``style`` attribute). The attributes then pass the sanitiser's own
allowlist and value checks like any other attribute, so nothing a sheet says reaches the output
unchecked. At-rules, comments, pseudo-classes, combinators and ``!important`` are ignored.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import Final

from shared.css_rules import COMMENT_RE as _COMMENT_RE

#: The sheet text read from one file (all its ``<style>`` elements together) and the rules kept.
MAX_SHEET_CHARS: Final = 50_000
MAX_RULES: Final = 500
_AT_BLOCK_RE: Final = re.compile(r'@[^{;]*(\{[^{}]*(\{[^{}]*\}[^{}]*)*\}|;)')
_RULE_RE: Final = re.compile(r'([^{}]+)\{([^{}]*)\}')
_CLASS_RE: Final = re.compile(r'^\.([A-Za-z_][\w-]{0,80})\Z')
_TYPE_RE: Final = re.compile(r'^([A-Za-z][\w-]{0,40})\Z')

#: (specificity, order, kind, name, declarations): kind 'class' or 'type'.
_Rule = tuple[int, int, str, str, list[tuple[str, str]]]


def local_name(tag: str) -> str:
    """The element / attribute name without its namespace, lower-cased (shared with ``shared.design_svg``)."""
    return tag.rsplit('}', 1)[-1].lower()


def _declarations(body: str) -> list[tuple[str, str]]:
    kept = []
    for declaration in body.split(';'):
        name, sep, value = declaration.partition(':')
        name, value = name.strip().lower(), value.replace('!important', '').strip()
        if sep and name and value:
            kept.append((name, value))
    return kept


def _rules(sheet: str) -> list[_Rule]:
    """The simple rules of ``sheet``, in source order, class rules ranked above type rules."""
    text = _AT_BLOCK_RE.sub('', _COMMENT_RE.sub('', sheet[:MAX_SHEET_CHARS]))
    rules: list[_Rule] = []
    for order, match in enumerate(_RULE_RE.finditer(text)):
        declarations = _declarations(match.group(2))
        for raw_selector in match.group(1).split(','):
            selector = raw_selector.strip()
            by_class, by_type = _CLASS_RE.match(selector), _TYPE_RE.match(selector)
            if declarations and by_class:
                rules.append((1, order, 'class', by_class.group(1), declarations))
            elif declarations and by_type:
                rules.append((0, order, 'type', by_type.group(1).lower(), declarations))
        if len(rules) >= MAX_RULES:
            break
    return sorted(rules[:MAX_RULES])


def _own_style_properties(element: ET.Element) -> set[str]:
    style = next((v for k, v in element.attrib.items() if local_name(k) == 'style'), '')
    return {part.partition(':')[0].strip().lower() for part in style.split(';') if ':' in part}


def _index(rules: list[_Rule]) -> dict[tuple[str, str], list[_Rule]]:
    """The rules by ``(kind, name)``, so each element looks up only the rules that can match it."""
    index: dict[tuple[str, str], list[_Rule]] = {}
    for rule in rules:
        index.setdefault((rule[2], rule[3]), []).append(rule)
    return index


def _matching(element: ET.Element, index: dict[tuple[str, str], list[_Rule]]) -> list[_Rule]:
    """The rules that match ``element``, lowest precedence first (type before class, earlier before later)."""
    classes = next((v for k, v in element.attrib.items() if local_name(k) == 'class'), '').split()
    keys = [('type', local_name(element.tag)), *(('class', name) for name in classes)]
    return sorted(rule for key in keys for rule in index.get(key, ()))


def inline_style_sheets(root: ET.Element) -> None:
    """Apply the simple rules of every ``<style>`` element in ``root`` as attributes, in place."""
    sheet = ''.join(''.join(el.itertext()) for el in root.iter() if local_name(el.tag) == 'style')
    index = _index(_rules(sheet)) if sheet.strip() else {}
    if not index:
        return
    for element in root.iter():
        matched = _matching(element, index)
        own = _own_style_properties(element) if matched else set()
        for *_rank, declarations in matched:
            for prop, value in declarations:
                if prop not in own:
                    element.set(prop, value)
