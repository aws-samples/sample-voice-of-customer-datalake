"""Feedback dimensions: the admin-defined axes every review can be filed on.

Categories answer "what is this about"; dimensions answer "where does it come
from" — product, module, user type and similar axes an admin configures in
Settings (``PUT /settings/dimensions``). Stored shape (``pk SETTINGS#dimensions``,
``sk config`` in the aggregates table)::

    {dimensions: [{key, label, description?, infer, parent?,
                   values: [{name, label?, description?, parent_value?}]}],
     updated_at, updated_by}

A dimension ``key`` becomes an item attribute key and a ``dims=key:value``
query term, so it is a short lowercase slug and may not shadow an existing item
attribute or query parameter (``RESERVED_DIMENSION_KEYS``). A value ``name`` is
spliced into the same query syntax, so it may not contain whitespace, ``#``,
``,`` or ``:``. One level of hierarchy: a dimension may name a ``parent``
dimension (which has no parent of its own), and each of its values may name the
``parent_value`` it belongs under (a module under a product).

Validation normalises like ``shared.category_config``: unknown keys are
dropped, strings are trimmed, empty optional fields are omitted, ``infer``
defaults to true. Every refusal is a ValueError with a client-safe message.

This module imports nothing from the rest of ``shared`` so the processing-queue
schema (``shared.ingest_schemas``) can reuse ``validate_tags`` without widening
its import graph.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping
from typing import Any, Final

__all__ = [
    'DIMENSIONS_SETTINGS_KEY',
    'DIMENSION_KEY_RE',
    'DIMENSION_VALUE_RE',
    'MAX_DIMENSIONS',
    'MAX_TAGS',
    'RESERVED_DIMENSION_KEYS',
    'TAG_RE',
    'allowed_values',
    'load_dimensions_config',
    'parse_dims_param',
    'resolve_dimensions',
    'validate_dimensions',
    'validate_tags',
]

DIMENSIONS_SETTINGS_KEY: Final = {'pk': 'SETTINGS#dimensions', 'sk': 'config'}

MAX_DIMENSIONS: Final = 10
MAX_DIMENSION_VALUES: Final = 200
MAX_LABEL_CHARS: Final = 64
MAX_DESCRIPTION_CHARS: Final = 300
MAX_TAGS: Final = 20
MAX_TAG_CHARS: Final = 64
# Raw entries read before normalisation: blanks and case-repeats are dropped
# before the MAX_TAGS bound applies (a union of message and profile tags often
# repeats), but the work per call stays bounded.
_MAX_RAW_TAGS: Final = 100

# `\Z`, not `$`: `$` also matches before a trailing newline, so `re.match` with a
# `$` pattern would admit "product\n". Anchored both ends so `.match` and
# `.fullmatch` agree.
DIMENSION_KEY_RE: Final = re.compile(r'^[a-z][a-z0-9_]{0,31}\Z')
DIMENSION_VALUE_RE: Final = re.compile(r'^[^\s#,:]{1,64}\Z')
TAG_RE: Final = re.compile(r'^[^\s#,:][^#,:\x00-\x1f\x7f]{0,63}\Z')

# Item attributes and query parameters a dimension key must not shadow.
RESERVED_DIMENSION_KEYS: Final = frozenset({
    'category', 'subcategory', 'source', 'channel', 'tag', 'tags',
    'sentiment', 'urgency', 'days', 'limit', 'offset', 'q',
})

_DIMS_PAIR_SEPARATOR: Final = ','
_DIMS_KEY_VALUE_SEPARATOR: Final = ':'


def _without_controls(value: str) -> str:
    """``value`` with every control character (Unicode Cc) removed, then trimmed."""
    return ''.join(ch for ch in value if unicodedata.category(ch) != 'Cc').strip()


def bounded_text(entry: Mapping[str, Any], field: str, limit: int, what: str) -> str:
    """The trimmed string at ``entry[field]`` ('' when absent), or ValueError.

    Shared with ``shared.source_profiles`` so both settings rows refuse a
    non-string or over-long field with the same wording.
    """
    raw = entry.get(field)
    if raw is None:
        return ''
    if not isinstance(raw, str):
        raise ValueError(f'{what} must be a string')
    text = raw.strip()
    if len(text) > limit:
        raise ValueError(f'{what} must be at most {limit} characters')
    return text


def strict_bool(entry: Mapping[str, Any], field: str, default: bool, what: str) -> bool:
    """``entry[field]`` when it is a real boolean, ``default`` when absent, else ValueError."""
    raw = entry.get(field)
    if raw is None:
        return default
    if not isinstance(raw, bool):
        raise ValueError(f'{what} must be true or false')
    return raw


def as_object(entry: object, what: str) -> Mapping[str, Any]:
    """``entry`` when it is a mapping, else ValueError naming ``what``."""
    if not isinstance(entry, Mapping):
        raise ValueError(f'Each {what} must be an object')
    return entry


def bounded_list(value: object, limit: int, what: str) -> list[Any]:
    """``value`` as a list of at most ``limit`` entries ([] when None), else ValueError."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f'{what} must be a list')
    if len(value) > limit:
        raise ValueError(f'At most {limit} {what} are allowed')
    return value


def _put_optional(out: dict[str, Any], field: str, text: str) -> None:
    if text:
        out[field] = text


def _value(entry: object, dimension_key: str) -> dict[str, str]:
    source = as_object(entry, 'dimension value')
    what = f'Dimension "{dimension_key}" value'
    name = bounded_text(source, 'name', MAX_LABEL_CHARS, f'{what} name')
    if not DIMENSION_VALUE_RE.match(name):
        raise ValueError(f'{what} names must be 1-64 characters with no spaces, "#", "," or ":"')
    out = {'name': name}
    _put_optional(out, 'label', bounded_text(source, 'label', MAX_LABEL_CHARS, f'{what} label'))
    _put_optional(out, 'description', bounded_text(
        source, 'description', MAX_DESCRIPTION_CHARS, f'{what} description'))
    _put_optional(out, 'parent_value', bounded_text(source, 'parent_value', MAX_LABEL_CHARS, f'{what} parent_value'))
    return out


def _values(value: object, dimension_key: str) -> list[dict[str, str]]:
    values = [_value(entry, dimension_key) for entry in bounded_list(
        value, MAX_DIMENSION_VALUES, f'values in dimension "{dimension_key}"')]
    folded = [entry['name'].casefold() for entry in values]
    if len(set(folded)) != len(folded):
        raise ValueError(f'Value names in dimension "{dimension_key}" must be unique (ignoring case)')
    return values


def _dimension(entry: object) -> dict[str, Any]:
    source = as_object(entry, 'dimension')
    key = bounded_text(source, 'key', MAX_LABEL_CHARS, 'Dimension key')
    if not DIMENSION_KEY_RE.match(key):
        raise ValueError(
            'Dimension keys must start with a lowercase letter and use only a-z, 0-9 and "_" (at most 32)')
    if key in RESERVED_DIMENSION_KEYS:
        raise ValueError(f'"{key}" is reserved and cannot be a dimension key')
    out: dict[str, Any] = {
        'key': key,
        'label': bounded_text(source, 'label', MAX_LABEL_CHARS, 'Dimension label') or key,
    }
    _put_optional(out, 'description', bounded_text(
        source, 'description', MAX_DESCRIPTION_CHARS, 'Dimension description'))
    out['infer'] = strict_bool(source, 'infer', True, 'Dimension infer')
    _put_optional(out, 'parent', bounded_text(source, 'parent', MAX_LABEL_CHARS, 'Dimension parent'))
    out['values'] = _values(source.get('values'), key)
    return out


def _parent_of(dimension: dict[str, Any], by_key: Mapping[str, dict[str, Any]]) -> dict[str, Any] | None:
    """The dimension's parent (None for a top-level one), or ValueError when the link is invalid."""
    parent_key = dimension.get('parent')
    if parent_key is None:
        return None
    parent = by_key.get(parent_key)
    if parent is None or parent_key == dimension['key']:
        raise ValueError(f'Dimension "{dimension["key"]}" names an unknown parent')
    if 'parent' in parent:
        raise ValueError(f'Dimension "{parent_key}" is itself a child, so it cannot be a parent')
    return parent


def _check_hierarchy(dimensions: list[dict[str, Any]]) -> None:
    by_key = {dimension['key']: dimension for dimension in dimensions}
    for dimension in dimensions:
        parent = _parent_of(dimension, by_key)
        parent_names = set(allowed_values(parent)) if parent is not None else set()
        for value in dimension['values']:
            parent_value = value.get('parent_value')
            if parent_value is None:
                continue
            if parent is None:
                raise ValueError(f'Dimension "{dimension["key"]}" has no parent, so its values cannot set parent_value')
            if parent_value not in parent_names:
                raise ValueError(
                    f'Value "{value["name"]}" of dimension "{dimension["key"]}" names an unknown parent_value')


def validate_dimensions(value: object) -> list[dict[str, Any]]:
    """The normalised dimensions list, or ValueError with a client-safe message."""
    dimensions = [_dimension(entry) for entry in bounded_list(value, MAX_DIMENSIONS, 'dimensions')]
    keys = [dimension['key'] for dimension in dimensions]
    if len(set(keys)) != len(keys):
        raise ValueError('Dimension keys must be unique')
    _check_hierarchy(dimensions)
    return dimensions


def load_dimensions_config(table: Any) -> list[dict[str, Any]]:
    """The stored dimensions, normalised; [] when none are configured.

    Uncached and strongly consistent, for callers that just saved or that run
    rarely. A DynamoDB error propagates; a stored row that no longer validates
    (written around ``PUT /settings/dimensions``) raises ValueError rather than
    being half-applied.
    """
    item = table.get_item(Key=DIMENSIONS_SETTINGS_KEY, ConsistentRead=True).get('Item') or {}
    return validate_dimensions(item.get('dimensions'))


def allowed_values(dimension: Mapping[str, Any]) -> list[str]:
    """The value names a dimension admits, in configured order."""
    values = dimension.get('values') or []
    return [value['name'] for value in values if isinstance(value, Mapping) and isinstance(value.get('name'), str)]


def _canonical_value(dimension: Mapping[str, Any], candidate: object) -> Mapping[str, Any] | None:
    """The configured value ``candidate`` names (case-insensitively), or None."""
    if not isinstance(candidate, str):
        return None
    wanted = candidate.strip().casefold()
    for value in dimension.get('values') or []:
        if isinstance(value, Mapping) and str(value.get('name', '')).casefold() == wanted:
            return value
    return None


def resolve_dimensions(config: list[dict[str, Any]], candidate: Mapping[str, Any]) -> dict[str, str]:
    """The subset of ``candidate`` the config admits, keyed by dimension key.

    A key is kept only when it is a configured dimension and its value names one
    of that dimension's values (matched ignoring case, returned in the configured
    spelling). A child dimension's value that names a ``parent_value`` is kept
    only when the parent dimension resolved to exactly that value; a child value
    with no ``parent_value`` belongs under every parent value. Parents are
    resolved first, so the order of ``candidate`` does not matter.
    """
    resolved: dict[str, str] = {}
    ordered = sorted(config, key=lambda dimension: 'parent' in dimension)
    for dimension in ordered:
        key = dimension['key']
        value = _canonical_value(dimension, candidate.get(key))
        if value is None:
            continue
        parent_value = value.get('parent_value')
        if parent_value is not None and resolved.get(dimension.get('parent', '')) != parent_value:
            continue
        resolved[key] = value['name']
    return resolved


def validate_tags(value: object) -> list[str]:
    """The normalised tags list, or ValueError with a client-safe message.

    Each tag has its control characters removed and is trimmed; blanks are
    dropped; repeats are dropped ignoring case (the first spelling is kept, case
    preserved). At most ``MAX_TAGS`` remain, each matching ``TAG_RE``.
    """
    tags: list[str] = []
    seen: set[str] = set()
    for raw in bounded_list(value, _MAX_RAW_TAGS, 'tags'):
        if not isinstance(raw, str):
            raise ValueError('Each tag must be a string')
        tag = _without_controls(raw)
        if not tag or tag.casefold() in seen:
            continue
        if not TAG_RE.match(tag):
            raise ValueError(f'Tags must be 1-{MAX_TAG_CHARS} characters with no "#", "," or ":"')
        seen.add(tag.casefold())
        tags.append(tag)
    if len(tags) > MAX_TAGS:
        raise ValueError(f'At most {MAX_TAGS} tags are allowed')
    return tags


def parse_dims_param(raw: str | None) -> dict[str, str]:
    """The ``dims=key:value[,key:value...]`` query parameter as a mapping.

    None or blank means no filter ({}). Every pair must be ``key:value`` with a
    well-formed key and value, at most ``MAX_DIMENSIONS`` pairs, and no key twice
    (two values for one key could never both match). Otherwise ValueError.
    Whether the keys and values are configured is the caller's business.
    """
    if raw is None or not raw.strip():
        return {}
    pairs = raw.split(_DIMS_PAIR_SEPARATOR)
    if len(pairs) > MAX_DIMENSIONS:
        raise ValueError(f'dims accepts at most {MAX_DIMENSIONS} key:value pairs')
    parsed: dict[str, str] = {}
    for pair in pairs:
        key, separator, value = pair.strip().partition(_DIMS_KEY_VALUE_SEPARATOR)
        if not separator or not DIMENSION_KEY_RE.match(key) or not DIMENSION_VALUE_RE.match(value):
            raise ValueError('dims must be key:value pairs separated by commas')
        if key in parsed:
            raise ValueError(f'dims names "{key}" more than once')
        parsed[key] = value
    return parsed
