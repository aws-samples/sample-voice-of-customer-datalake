"""Settings -> Radar (admin): the release-scan cadence and its cost guards (docs/radar.md).

Stored in the ``voc-radar`` table at ``SETTINGS#radar`` / ``config``::

    {cadence: daily|weekly|monthly, max_brands: int, query_cap: int, updated_at, updated_by}

``query_cap`` bounds the web searches ONE scan may run across every brand; each
brand gets an equal share (at least one query). ``max_brands`` bounds how many
brands a scan covers (the first ones, in source-profile order).
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import timedelta
from decimal import Decimal
from typing import Any, Final

__all__ = [
    'SETTINGS_KEY',
    'cadence_interval',
    'load_settings',
    'per_brand_queries',
    'validate_settings',
]

SETTINGS_KEY: Final = {'pk': 'SETTINGS#radar', 'sk': 'config'}
CADENCES: Final = ('daily', 'weekly', 'monthly')
_INTERVALS: Final = {'daily': timedelta(days=1), 'weekly': timedelta(days=7), 'monthly': timedelta(days=30)}
MAX_BRANDS_LIMIT: Final = 25
QUERY_CAP_LIMIT: Final = 100
DEFAULT_SETTINGS: Final = {'cadence': 'weekly', 'max_brands': 10, 'query_cap': 30}
# A scheduled tick that lands a little early still counts as due (schedules drift by minutes).
_DUE_SLACK: Final = timedelta(hours=1)


def _bounded_int(raw: object, field: str, low: int, high: int) -> int:
    """A whole number in range; a stored DynamoDB ``Decimal`` counts (the row is read back as one)."""
    if isinstance(raw, bool) or not isinstance(raw, int | float | Decimal) or int(raw) != raw or not low <= raw <= high:
        raise ValueError(f'{field} must be a whole number from {low} to {high}')
    return int(raw)


def validate_settings(body: object) -> dict[str, Any]:
    """The normalised settings from a PUT body (missing fields keep the defaults), or ValueError."""
    if not isinstance(body, Mapping):
        raise ValueError('Request body must be a JSON object')
    cadence = body.get('cadence', DEFAULT_SETTINGS['cadence'])
    if cadence not in CADENCES:
        raise ValueError(f'cadence must be one of {", ".join(CADENCES)}')
    return {
        'cadence': cadence,
        'max_brands': _bounded_int(body.get('max_brands', DEFAULT_SETTINGS['max_brands']),
                                   'max_brands', 1, MAX_BRANDS_LIMIT),
        'query_cap': _bounded_int(body.get('query_cap', DEFAULT_SETTINGS['query_cap']),
                                  'query_cap', 1, QUERY_CAP_LIMIT),
    }


def load_settings(table: Any) -> dict[str, Any]:
    """The stored settings, or the defaults; a corrupt row falls back to the defaults too."""
    item = table.get_item(Key=SETTINGS_KEY).get('Item') or {}
    try:
        return validate_settings({key: item[key] for key in DEFAULT_SETTINGS if key in item})
    except ValueError:
        return dict(DEFAULT_SETTINGS)


def cadence_interval(cadence: str) -> timedelta:
    """How long a scheduled scan waits after the last one (minus a little slack for drift)."""
    return _INTERVALS.get(cadence, _INTERVALS['weekly']) - _DUE_SLACK


def per_brand_queries(query_cap: int, brands: int) -> int:
    """Each brand's equal share of the scan's query cap (at least one)."""
    return max(1, query_cap // max(1, brands))
