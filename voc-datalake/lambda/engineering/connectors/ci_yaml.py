"""A strict reader of a GitLab CI file, for the CI check (``gitlab_ci.py``): PyYAML's composer, never a hand parser.

The text is refused before it is read when GitLab and a YAML reader could see it differently: input that is not
UTF-8, a byte-order mark, a carriage return not followed by a line feed, the other line breaks YAML knows (U+0085,
U+2028, U+2029), a replacement character (U+FFFD), or more than ``MAX_BYTES``. Then PyYAML's pure-Python
``SafeLoader`` composes it into nodes (``compose``: nothing is constructed into Python objects), with every reading
that could hide or change an ``include`` refused (``Unreadable``): more than one document, an anchor or an alias, a
tag other than the standard ones and ``!reference`` (kept opaque: ``Opaque``), a merge key (``<<``), a duplicate key
at any level, or a key that is not printable ASCII text or is written with a backslash escape. A double-quoted value
written with an escape is marked (``Escaped``), so the CI check refuses one in an include. JSON is YAML too, so it is
read the same way.

The result is plain structure: ``dict`` (keys in order), ``list``, ``str`` for every scalar (the check reads strings),
``None`` for an empty document, and ``Opaque`` for a ``!reference``.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import cache
from typing import Any, Final

#: The most bytes a CI file may hold for the check to read it (a larger one is refused).
MAX_BYTES: Final = 512 * 1024
#: How deep the structure may nest for the reader to walk it.
MAX_DEPTH: Final = 64
#: Characters refused before parsing: a byte-order mark (U+FEFF), YAML's line breaks other than LF and CRLF (U+0085,
#: U+2028, U+2029), and the replacement character (U+FFFD: a decoding a reader may have repaired).
_REFUSED_CHARACTERS: Final = tuple(chr(code) for code in (0xFEFF, 0x85, 0x2028, 0x2029, 0xFFFD))
#: The tags a node may carry: YAML's standard ones as the safe resolver gives them, and GitLab's ``!reference``.
_STANDARD_TAGS: Final = frozenset(f'tag:yaml.org,2002:{name}' for name in (
    'str', 'int', 'float', 'bool', 'null', 'seq', 'map', 'timestamp'))
REFERENCE_TAG: Final = '!reference'


class Unreadable(ValueError):
    """The text is not one the check reads the way GitLab would (it refuses it)."""


@dataclass(frozen=True)
class Opaque:
    """A value the reader keeps unread: a ``!reference`` (GitLab's own tag)."""

    text: str


class Escaped(str):
    """A double-quoted scalar written with a backslash escape (``"ci/\\x2a.yml"``): its text as read, marked, so the CI
    check refuses one in an include entry rather than trust that GitLab decodes it the same way."""

    __slots__ = ()


Node = dict[str, 'Node'] | list['Node'] | str | Opaque | None


@cache
def _strict_loader() -> Any:
    """PyYAML's safe loader with no anchors or aliases, refused as they are met. Made on first use: PyYAML is imported
    only when a CI file is read (the broker's layer ships it; the checkout cache's writer, which imports this module's
    neighbours, never reads one)."""
    import yaml
    from yaml.events import AliasEvent, NodeEvent

    class StrictLoader(yaml.SafeLoader):
        def compose_node(self, parent: Any, index: Any) -> Any:
            event = self.peek_event()
            if isinstance(event, AliasEvent) or (isinstance(event, NodeEvent) and event.anchor is not None):
                raise Unreadable('an anchor or an alias')
            return super().compose_node(parent, index)

    return StrictLoader


def checked_text(data: bytes) -> str:
    """``data`` as text, or ``Unreadable`` for what GitLab and a reader could see differently."""
    if len(data) > MAX_BYTES:
        raise Unreadable('too large')
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        raise Unreadable('not UTF-8') from None
    if any(char in text for char in _REFUSED_CHARACTERS):
        raise Unreadable('a byte-order mark, a line break YAML reads apart, or a replacement character')
    if '\r' in text.replace('\r\n', ''):
        raise Unreadable('a carriage return without its line feed')
    return text


def _scalar(node: Any) -> str:
    """A scalar node's text, marked ``Escaped`` when it is double-quoted with a backslash in its source."""
    mark = node.start_mark
    source = mark.buffer[mark.index:node.end_mark.index] if mark.buffer else ''
    return Escaped(node.value) if node.style == '"' and '\\' in source else str(node.value)


def _key(node: Any) -> str:
    import yaml

    if not isinstance(node, yaml.ScalarNode) or node.tag not in _STANDARD_TAGS:
        raise Unreadable('a key that is not plain text')
    value = _scalar(node)
    if isinstance(value, Escaped) or not value.isascii() or not value.isprintable():
        raise Unreadable('a key that is not printable ASCII, or written with an escape')
    return str(value)


def _plain(node: Any, depth: int = 0) -> Node:
    """The node as plain structure, every rule held."""
    import yaml

    if depth > MAX_DEPTH:
        raise Unreadable('nested too deep')
    if node.tag == REFERENCE_TAG:
        return Opaque(REFERENCE_TAG)
    if node.tag not in _STANDARD_TAGS:
        raise Unreadable(f'a tag the reader does not take ({node.tag})')
    if isinstance(node, yaml.MappingNode):
        found: dict[str, Node] = {}
        for key_node, value_node in node.value:
            key = _key(key_node)
            if key == '<<' or key in found:
                raise Unreadable('a merge key or a duplicate key')
            found[key] = _plain(value_node, depth + 1)
        return found
    if isinstance(node, yaml.SequenceNode):
        return [_plain(item, depth + 1) for item in node.value]
    return _scalar(node)


def load(data: bytes) -> Node:
    """The one document ``data`` holds, as plain structure, or ``Unreadable``."""
    import yaml

    loader = _strict_loader()(checked_text(data))
    try:
        node = loader.get_single_node()
    except yaml.YAMLError as error:
        raise Unreadable('not YAML the reader reads') from error
    finally:
        loader.dispose()
    return None if node is None else _plain(node)
