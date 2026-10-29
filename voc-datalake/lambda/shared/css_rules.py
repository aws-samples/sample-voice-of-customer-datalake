"""A small, deterministic CSS rule scanner for the design-reference parsers (no model, no CSS engine).

``leaf_rules`` returns every rule whose body holds no nested rule — ``.btn { … }`` inside
``@layer components { … }``, ``:root { … }`` inside ``@media (prefers-color-scheme: dark) { … }``
— with the selectors of the blocks around it, so a caller can tell a theme variant or a media
override from a plain rule. ``declarations`` splits a body into ``(property, value)`` pairs,
keeping ``;`` inside parentheses and quotes (``url("data:…;base64,…")``), and reports
``@apply a b c`` as the pseudo property ``@apply``.

Comments are removed first. Braces inside strings are rare in stylesheets and are not special-cased:
a malformed file yields fewer rules, never an error.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final

COMMENT_RE: Final = re.compile(r'/\*.*?\*/', re.DOTALL)
_APPLY_RE: Final = re.compile(r'^@apply\s+(.+)\Z', re.DOTALL)
_PROPERTY_RE: Final = re.compile(r'^(--[\w-]{1,60}|-?[a-z][a-z-]{0,40})\s*:\s*(.+)\Z', re.DOTALL | re.IGNORECASE)
IMPORTANT_RE: Final = re.compile(r'\s*!important\s*\Z', re.IGNORECASE)
_WS_RE: Final = re.compile(r'\s+')
MAX_RULES: Final = 4_000


@dataclass(frozen=True)
class Rule:
    """One leaf rule: its selector, the selectors (``@layer x``, ``@media (…)``) around it, its body."""
    selector: str
    parents: tuple[str, ...]
    body: str

    def selector_parts(self) -> list[str]:
        """The comma-separated selectors, whitespace collapsed."""
        return [_WS_RE.sub(' ', part).strip() for part in self.selector.split(',') if part.strip()]

    def in_media(self) -> bool:
        return any(parent.lower().startswith('@media') for parent in self.parents)


@dataclass
class _Open:
    selector: str
    start: int
    has_child: bool = False


def leaf_rules(css: str) -> list[Rule]:
    """Every rule of ``css`` with no nested rule, in source order (at most MAX_RULES)."""
    text = COMMENT_RE.sub(' ', css)
    rules: list[Rule] = []
    stack: list[_Open] = []
    boundary = 0
    for index, char in enumerate(text):
        if char == '{':
            if stack:
                stack[-1].has_child = True
            stack.append(_Open(_WS_RE.sub(' ', text[boundary:index]).strip(), index + 1))
            boundary = index + 1
        elif char == '}':
            if stack:
                block = stack.pop()
                if not block.has_child and len(rules) < MAX_RULES:
                    rules.append(Rule(block.selector, tuple(o.selector for o in stack), text[block.start:index]))
            boundary = index + 1
        elif char == ';':
            boundary = index + 1  # a statement or declaration (`@import "x";`, `color: red;`) ends before a selector
    return rules


def _split_body(body: str) -> list[str]:
    """``body`` split at the ``;`` that are outside parentheses and quotes."""
    parts: list[str] = []
    depth, quote, start = 0, '', 0
    for index, char in enumerate(body):
        if quote:
            quote = '' if char == quote else quote
        elif char in '"\'':
            quote = char
        elif char in '([':
            depth += 1
        elif char in ')]':
            depth = max(0, depth - 1)
        elif char == ';' and depth == 0:
            parts.append(body[start:index])
            start = index + 1
    parts.append(body[start:])
    return [part.strip() for part in parts if part.strip()]


def declarations(body: str) -> list[tuple[str, str]]:
    """``(property, value)`` pairs of a rule body (property lower-cased, ``!important`` dropped);
    ``@apply`` utilities as ``('@apply', 'a b c')``."""
    pairs: list[tuple[str, str]] = []
    for part in _split_body(body):
        apply = _APPLY_RE.match(part)
        if apply:
            pairs.append(('@apply', _WS_RE.sub(' ', apply.group(1)).strip()))
            continue
        match = _PROPERTY_RE.match(part)
        if match:
            name = match.group(1)
            prop = name if name.startswith('--') else name.lower()
            pairs.append((prop, IMPORTANT_RE.sub('', _WS_RE.sub(' ', match.group(2)).strip())))
    return pairs
