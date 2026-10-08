"""Validation of the categories config (``PUT /settings/categories``).

Each category maps to the product it belongs to and the product owners
accountable for it; owners implicitly see their categories' feedback (see
``shared.category_access``). Stored shape (``pk SETTINGS#categories``,
``sk config``)::

    {categories: [{id?, name, description, product?, owners?: [{sub, username, email}],
                   subcategories?: [{id?, name, description}]}], updated_at}

``name`` is the identifier every review is filed under and is spliced into
DynamoDB keys (``CATEGORY#{name}``, ``METRIC#daily_category#{name}``), so it may
not contain whitespace or ``#``; ``*`` is reserved for "all categories" in
access rows. Non-ASCII is allowed so categories can be named in any locale.

Validation normalises: unknown keys are dropped, strings are trimmed, empty
optional fields are omitted. Raises ValueError with a client-safe message.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Final

from shared.category_access import WILDCARD

MAX_CATEGORIES: Final = 50
MAX_SUBCATEGORIES: Final = 50
MAX_NAME_CHARS: Final = 64
# Wider than a name: the Settings editor derives a missing id as
# `cat_`/`sub_` + the slugged name (+ a `_N` de-duplication suffix), so a
# 64-character name yields an id longer than 64 that must still save.
MAX_ID_CHARS: Final = 128
MAX_DESCRIPTION_CHARS: Final = 500
MAX_PRODUCT_CHARS: Final = 120
MAX_OWNERS: Final = 20
MAX_OWNER_FIELD_CHARS: Final = 254
_NAME_RE: Final = re.compile(rf'[^\s#]{{1,{MAX_NAME_CHARS}}}')


def _text(entry: Mapping[str, Any], key: str, max_chars: int, label: str) -> str:
    value = entry.get(key)
    if value is None:
        return ''
    if not isinstance(value, str):
        raise ValueError(f'{label} must be a string')
    value = value.strip()
    if len(value) > max_chars:
        raise ValueError(f'{label} must be at most {max_chars} characters')
    return value


def _name(entry: Mapping[str, Any], label: str) -> str:
    name = _text(entry, 'name', MAX_NAME_CHARS, f'{label} name')
    if not _NAME_RE.fullmatch(name) or name == WILDCARD:
        raise ValueError(
            f'{label} name must be 1-{MAX_NAME_CHARS} characters with no spaces or "#"'
        )
    return name


def _object(entry: object, label: str) -> Mapping[str, Any]:
    if not isinstance(entry, Mapping):
        raise ValueError(f'Each {label} must be an object')
    return entry


def _base(entry: Mapping[str, Any], label: str) -> dict[str, str]:
    out = {'name': _name(entry, label.capitalize())}
    entry_id = _text(entry, 'id', MAX_ID_CHARS, f'{label.capitalize()} id')
    if entry_id:
        out['id'] = entry_id
    out['description'] = _text(
        entry, 'description', MAX_DESCRIPTION_CHARS, f'{label.capitalize()} description')
    return out


def _unique_names(entries: list[dict], label: str) -> None:
    names = [entry['name'] for entry in entries]
    if len(set(names)) != len(names):
        raise ValueError(f'{label} names must be unique')


def _owners(value: object) -> list[dict[str, str]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError('owners must be a list')
    if len(value) > MAX_OWNERS:
        raise ValueError(f'A category can have at most {MAX_OWNERS} owners')
    owners: list[dict[str, str]] = []
    for owner in value:
        if not isinstance(owner, Mapping):
            raise ValueError('Each owner must be an object')
        sub = _text(owner, 'sub', MAX_OWNER_FIELD_CHARS, 'Owner sub')
        if not sub:
            raise ValueError('Each owner needs a sub')
        owners.append({
            'sub': sub,
            'username': _text(owner, 'username', MAX_OWNER_FIELD_CHARS, 'Owner username'),
            'email': _text(owner, 'email', MAX_OWNER_FIELD_CHARS, 'Owner email'),
        })
    if len({owner['sub'] for owner in owners}) != len(owners):
        raise ValueError('owners must not repeat')
    return owners


def _subcategories(value: object) -> list[dict[str, str]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError('subcategories must be a list')
    if len(value) > MAX_SUBCATEGORIES:
        raise ValueError(f'A category can have at most {MAX_SUBCATEGORIES} subcategories')
    subcategories = [_base(_object(entry, 'subcategory'), 'subcategory') for entry in value]
    _unique_names(subcategories, 'Subcategory')
    return subcategories


def _category(entry: object) -> dict[str, Any]:
    source = _object(entry, 'category')
    category: dict[str, Any] = _base(source, 'category')
    product = _text(source, 'product', MAX_PRODUCT_CHARS, 'Category product')
    if product:
        category['product'] = product
    owners = _owners(source.get('owners'))
    if owners:
        category['owners'] = owners
    category['subcategories'] = _subcategories(source.get('subcategories'))
    return category


def validate_categories(value: object) -> list[dict[str, Any]]:
    """The normalised categories list, or ValueError."""
    if not isinstance(value, list):
        raise ValueError('categories must be a list')
    if len(value) > MAX_CATEGORIES:
        raise ValueError(f'At most {MAX_CATEGORIES} categories are allowed')
    categories = [_category(entry) for entry in value]
    _unique_names(categories, 'Category')
    return categories
