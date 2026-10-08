"""Dimension values and tags a producer puts on its messages.

Scraper configs and feedback-form configs carry ``dimension_defaults`` and
``tags``; CSV/JSON uploads and the widget's ``dimensions`` embed option carry
per-item ones. Two halves:

- ``validate_label_config`` (save paths): refuses a malformed config with a
  client-safe ValueError, checking keys and values against the dimensions
  config when one is given.
- ``message_labels`` (ingest paths): never raises; keeps only well-formed
  entries so a stale config or a bad cell never dead-letters a message (the
  processor's ``resolve_dimensions`` decides what is configured).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.dimension_config import (
    DIMENSION_KEY_RE,
    DIMENSION_VALUE_RE,
    MAX_DIMENSIONS,
    MAX_TAGS,
    allowed_values,
    load_dimensions_config,
    validate_tags,
)
from shared.exceptions import ServiceError, ValidationError
from shared.logging import logger

__all__ = ['clean_dimensions', 'clean_tags', 'message_labels', 'normalise_label_fields', 'validate_label_config']

_MAX_RAW_TAGS: Final = 100
_LABEL_FIELDS: Final = ('dimension_defaults', 'tags')


def clean_dimensions(value: object) -> dict[str, str]:
    """The well-formed ``{key: value}`` pairs of ``value`` (stringified), at most ``MAX_DIMENSIONS``."""
    if not isinstance(value, Mapping):
        return {}
    out: dict[str, str] = {}
    for key, raw in value.items():
        if raw is None or isinstance(raw, (dict, list)):
            continue
        text = str(raw).strip()
        if isinstance(key, str) and DIMENSION_KEY_RE.match(key) and DIMENSION_VALUE_RE.match(text):
            out[key] = text
        if len(out) >= MAX_DIMENSIONS:
            break
    return out


def clean_tags(value: object) -> list[str]:
    """The valid tags of ``value`` (a list, or a comma/semicolon separated string), at most ``MAX_TAGS``."""
    if isinstance(value, str):
        value = value.replace(';', ',').split(',')
    if not isinstance(value, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for raw in value[:_MAX_RAW_TAGS]:
        if not isinstance(raw, str):
            continue
        try:
            tag = validate_tags([raw])
        except ValueError:
            continue
        if tag and tag[0].casefold() not in seen:
            seen.add(tag[0].casefold())
            out.append(tag[0])
        if len(out) >= MAX_TAGS:
            break
    return out


def message_labels(dimensions: object = None, tags: object = None) -> dict[str, Any]:
    """``{'dimensions': ..., 'tags': ...}`` for a queue message, each only when non-empty."""
    out: dict[str, Any] = {}
    cleaned_dimensions = clean_dimensions(dimensions)
    if cleaned_dimensions:
        out['dimensions'] = cleaned_dimensions
    cleaned_tags = clean_tags(tags)
    if cleaned_tags:
        out['tags'] = cleaned_tags
    return out


def _checked_defaults(raw: object, dimensions_config: list[dict[str, Any]] | None) -> dict[str, str]:
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        raise ValueError('dimension_defaults must be an object')
    if len(raw) > MAX_DIMENSIONS:
        raise ValueError(f'dimension_defaults accepts at most {MAX_DIMENSIONS} entries')
    by_key = {dimension['key']: dimension for dimension in dimensions_config or []}
    defaults: dict[str, str] = {}
    for key, value in raw.items():
        well_formed = (isinstance(key, str) and isinstance(value, str)
                       and DIMENSION_KEY_RE.match(key) and DIMENSION_VALUE_RE.match(value))
        if not well_formed:
            raise ValueError('dimension_defaults must map dimension keys to value names')
        if dimensions_config is not None and key not in by_key:
            raise ValueError(f'dimension_defaults names an unknown dimension "{key}"')
        if dimensions_config is not None and value not in allowed_values(by_key[key]):
            raise ValueError(f'dimension_defaults: "{value}" is not a value of dimension "{key}"')
        defaults[key] = value
    return defaults


def validate_label_config(
    entry: Mapping[str, Any], dimensions_config: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """``{'dimension_defaults', 'tags'}`` normalised from ``entry``, or ValueError.

    With ``dimensions_config`` the defaults must name configured dimensions and
    values; without it (the config could not be read) only the shape is checked.
    """
    return {
        'dimension_defaults': _checked_defaults(entry.get('dimension_defaults'), dimensions_config),
        'tags': validate_tags(entry.get('tags')),
    }


def normalise_label_fields(table: Any, entry: dict[str, Any]) -> None:
    """Validate a save body's ``dimension_defaults`` / ``tags`` against the stored
    dimensions config and normalise them IN PLACE; a body naming neither is untouched.

    ``ValidationError`` (400) for a bad value, ``ServiceError`` (500) when the
    dimensions config cannot be read: a write path must not store what it could
    not check.
    """
    if 'dimension_defaults' not in entry and 'tags' not in entry:
        return
    try:
        dimensions_config = load_dimensions_config(table)
    except (ClientError, BotoCoreError, ValueError) as e:
        logger.exception('Dimensions config could not be read to validate a save')
        raise ServiceError('Dimension settings could not be read') from e
    try:
        labels = validate_label_config(entry, dimensions_config)
    except ValueError as e:
        raise ValidationError(str(e)) from e
    for field in _LABEL_FIELDS:
        if field in entry:
            entry[field] = labels[field]
