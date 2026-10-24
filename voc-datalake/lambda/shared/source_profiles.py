"""Source profiles: per-source data-protection and default-tagging policy.

A profile is keyed by the item's ``source_platform`` (a plugin id, ``feedback_form``,
``manual_import`` or an admin-defined import source such as ``support_tickets``)
and says how that source's feedback is handled: whether PII is kept, redacted or
reduced to derived fields only, how long items are retained, whether the source
is restricted to explicitly granted users, and the dimension values and tags
every item from it starts with. Stored shape (``pk SETTINGS#sources``, ``sk
config`` in the aggregates table)::

    {sources: [{id, label, pii, retention_days, restricted,
                dimension_defaults: {key: value}, tags: [str],
                radar_brand?, radar_domains?}],     # Radar sources only (shared.radar_brands)
     updated_at, updated_by}

A source without a profile gets ``profile_for``'s defaults: PII allowed, kept
forever, not restricted, no defaults (``email_intake``, the public inbox, defaults to redact). Validation normalises (every field is
present in the output) and raises ValueError with a client-safe message.

``cached_source_profile_strict`` reads the whole list once per container per
``_CACHE_TTL_SECONDS`` and FAILS CLOSED: every ingestion path uses it, so a
failed read raises ``SourceProfilesUnavailable``
(a 503 ``ServiceUnavailableError``) and the SQS / webhook / HTTP caller retries
instead of ingesting a redact or summary-only source under the allow default.
"""

from __future__ import annotations

import os
import re
import time
from collections.abc import Mapping
from decimal import Decimal
from typing import Any, Final

from shared.aws import get_dynamodb_resource
from shared.dimension_config import (
    allowed_values,
    as_object,
    bounded_list,
    bounded_text,
    strict_bool,
    validate_tags,
)
from shared.exceptions import ServiceUnavailableError
from shared.logging import logger
from shared.radar_brands import radar_profile_fields

__all__ = [
    'PII_ALLOW',
    'PII_POLICIES',
    'PII_SUMMARY_ONLY',
    'SOURCES_SETTINGS_KEY',
    'SOURCE_ID_RE',
    'SourceProfilesUnavailable',
    'cached_source_profile_strict',
    'clear_source_profiles_cache',
    'load_source_profiles',
    'profile_for',
    'validate_source_profiles',
]

SOURCES_SETTINGS_KEY: Final = {'pk': 'SETTINGS#sources', 'sk': 'config'}

PII_ALLOW: Final = 'allow'
PII_REDACT: Final = 'redact'
PII_SUMMARY_ONLY: Final = 'summary_only'
PII_POLICIES: Final = (PII_ALLOW, PII_REDACT, PII_SUMMARY_ONLY)

MAX_SOURCE_PROFILES: Final = 50
MAX_LABEL_CHARS: Final = 64
MIN_RETENTION_DAYS: Final = 30
MAX_RETENTION_DAYS: Final = 3650
# `\Z`, not `$` (see shared.dimension_config.DIMENSION_KEY_RE).
SOURCE_ID_RE: Final = re.compile(r'^[a-z0-9][a-z0-9_-]{0,47}\Z')

_CACHE_TTL_SECONDS: Final = 300
_ERROR_CACHE_TTL_SECONDS: Final = 30
# `profiles` None = nothing cached; `expires` and `failed` are written with every read.
_cache: dict[str, Any] = {'profiles': None}


class SourceProfilesUnavailable(ServiceUnavailableError):
    """The source profiles could not be read, so no ingestion policy can be applied (client-safe message)."""

    def __init__(self) -> None:
        super().__init__('Source settings are temporarily unavailable; please retry shortly')


def _source_id(entry: Mapping[str, Any]) -> str:
    source_id = bounded_text(entry, 'id', MAX_LABEL_CHARS, 'Source id')
    if not SOURCE_ID_RE.match(source_id):
        raise ValueError('Source ids must be 1-48 characters of a-z, 0-9, "_" or "-", starting with a letter or digit')
    return source_id


def _pii(entry: Mapping[str, Any], what: str) -> str:
    raw = entry.get('pii')
    if raw is None:
        return PII_ALLOW
    if raw not in PII_POLICIES:
        raise ValueError(f'{what} pii must be one of {", ".join(PII_POLICIES)}')
    return raw


def _retention_days(entry: Mapping[str, Any], what: str) -> int | None:
    """None (keep forever) or a whole number of days in range; a DynamoDB Decimal is accepted."""
    raw = entry.get('retention_days')
    if raw is None:
        return None
    integral = isinstance(raw, int) or (isinstance(raw, Decimal) and raw == raw.to_integral_value())
    if isinstance(raw, bool) or not integral or not MIN_RETENTION_DAYS <= raw <= MAX_RETENTION_DAYS:
        raise ValueError(
            f'{what} retention_days must be empty (keep forever) or a whole number '
            f'from {MIN_RETENTION_DAYS} to {MAX_RETENTION_DAYS}')
    return int(raw)


def _dimension_defaults(
    entry: Mapping[str, Any], what: str, dimensions_config: list[dict[str, Any]] | None,
) -> dict[str, str]:
    """The profile's default dimension values; checked against the config unless it is None."""
    raw = entry.get('dimension_defaults')
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        raise ValueError(f'{what} dimension_defaults must be an object')
    by_key = {dimension['key']: dimension for dimension in dimensions_config or []}
    defaults: dict[str, str] = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not isinstance(value, str):
            raise ValueError(f'{what} dimension_defaults must map dimension keys to value names')
        if dimensions_config is None:
            defaults[key] = value
            continue
        if key not in by_key:
            raise ValueError(f'{what} dimension_defaults names an unknown dimension "{key}"')
        if value not in allowed_values(by_key[key]):
            raise ValueError(f'{what} dimension_defaults: "{value}" is not a value of dimension "{key}"')
        defaults[key] = value
    return defaults


def _profile(entry: object, dimensions_config: list[dict[str, Any]] | None) -> dict[str, Any]:
    source = as_object(entry, 'source profile')
    source_id = _source_id(source)
    what = f'Source "{source_id}"'
    try:
        tags = validate_tags(source.get('tags'))
    except ValueError as e:
        raise ValueError(f'{what}: {e}') from e
    return {
        'id': source_id,
        'label': bounded_text(source, 'label', MAX_LABEL_CHARS, f'{what} label') or source_id,
        'pii': _pii(source, what),
        'retention_days': _retention_days(source, what),
        'restricted': strict_bool(source, 'restricted', False, f'{what} restricted'),
        'dimension_defaults': _dimension_defaults(source, what, dimensions_config),
        'tags': tags,
        # Radar sources (docs/radar.md): present only when the profile tracks another brand.
        **radar_profile_fields(source, what),
    }


def _profiles(value: object, dimensions_config: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    profiles = [_profile(entry, dimensions_config)
                for entry in bounded_list(value, MAX_SOURCE_PROFILES, 'source profiles')]
    ids = [profile['id'] for profile in profiles]
    if len(set(ids)) != len(ids):
        raise ValueError('Source ids must be unique')
    return profiles


def validate_source_profiles(value: object, dimensions_config: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The normalised profiles list, or ValueError with a client-safe message.

    ``dimension_defaults`` must name configured dimensions and their values
    (exact value names, as the Settings editor offers them).
    """
    return _profiles(value, dimensions_config)


def load_source_profiles(table: Any) -> list[dict[str, Any]]:
    """The stored profiles, normalised; [] when none are configured.

    Uncached and strongly consistent. A DynamoDB error propagates, and so does a
    corrupt row (ValueError): silently dropping a profile would un-restrict its
    source. ``dimension_defaults`` are NOT re-checked against today's dimensions
    (the dimensions may have changed since the save); every consumer passes them
    through ``resolve_dimensions``.
    """
    item = table.get_item(Key=SOURCES_SETTINGS_KEY, ConsistentRead=True).get('Item') or {}
    return _profiles(item.get('sources'), None)


# Sources whose UNCONFIGURED default is stricter than allow. The public email inbox
# (docs/email-intake.md) redacts until an admin saves a profile for it.
_BUILT_IN_DEFAULTS: Final = {'email_intake': {'label': 'Email inbox', 'pii': PII_REDACT}}


def _default_profile(source_id: str) -> dict[str, Any]:
    return {
        'id': source_id, 'label': source_id, 'pii': PII_ALLOW, 'retention_days': None,
        'restricted': False, 'dimension_defaults': {}, 'tags': [],
        **_BUILT_IN_DEFAULTS.get(source_id, {}),
    }


def profile_for(profiles: list[dict[str, Any]], source_id: str) -> dict[str, Any]:
    """The profile for ``source_id`` (a copy the caller may mutate), or the defaults."""
    for profile in profiles:
        if profile.get('id') == source_id:
            return {
                **_default_profile(source_id), **profile,
                'dimension_defaults': dict(profile.get('dimension_defaults') or {}),
                'tags': list(profile.get('tags') or []),
                **({'radar_domains': list(profile['radar_domains'])} if 'radar_domains' in profile else {}),
            }
    return _default_profile(source_id)


def clear_source_profiles_cache() -> None:
    """Reset the container cache (tests, and the settings Lambda after a save)."""
    _cache['profiles'] = None


def _cached_profiles() -> tuple[list[dict[str, Any]], bool]:
    """``(profiles, failed)``: the cached list, and whether it stands in for a failed read."""
    table_name = os.environ.get('AGGREGATES_TABLE', '')
    if not table_name:
        return [], False
    now = time.time()
    if _cache['profiles'] is not None and now < _cache['expires']:
        return _cache['profiles'], bool(_cache.get('failed'))
    profiles: list[dict[str, Any]] = []
    ttl, failed = _CACHE_TTL_SECONDS, False
    try:
        profiles = load_source_profiles(get_dynamodb_resource().Table(table_name))
    except Exception:
        logger.exception('Source profiles lookup failed; using defaults')
        ttl, failed = _ERROR_CACHE_TTL_SECONDS, True
    _cache['profiles'] = profiles
    _cache['expires'] = now + ttl
    _cache['failed'] = failed
    return profiles, failed


def cached_source_profile_strict(source_id: str) -> dict[str, Any]:
    """``source_id``'s profile from a per-container cache; raises when the read failed.

    The whole list is read once per ``_CACHE_TTL_SECONDS``; with no ``AGGREGATES_TABLE``
    the defaults apply. The ingestion paths' reader: a source whose policy cannot be
    read is not ingested (nor archived) under the allow default; the caller retries.
    The failed read is cached for ``_ERROR_CACHE_TTL_SECONDS``, so a retry storm does
    not hammer the table.
    """
    profiles, failed = _cached_profiles()
    if failed:
        raise SourceProfilesUnavailable
    return profile_for(profiles, source_id)
