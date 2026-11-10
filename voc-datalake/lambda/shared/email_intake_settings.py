"""Email inbox settings and daily counters, shared by the intake worker and the settings API.

The inbox (docs/email-intake.md) is configured by two rows in the aggregates table:

- ``pk=SETTINGS#email_intake, sk=config``: the admin's caps
  ``{daily_cap, sender_daily_cap, daily_model_calls, updated_at, updated_by}``.
  A missing row, or a missing field, means the defaults below.
- ``pk=EMAIL_INTAKE#stats, sk=<YYYY-MM-DD>`` (UTC day): the day's counters. ``received``
  counts emails that passed the guards (the overall cap is checked against it),
  ``accepted`` the items queued, ``model_calls`` the Bedrock calls made, ``deferred``
  the emails held back until the next day (model budget spent or the overall daily cap
  reached: neither is ever a drop), ``dropped_<reason>`` / ``deduped_<reason>``
  the rest. The rows are written with atomic ``ADD``, so concurrent workers never
  lose a count.

Imports nothing that needs AWS: the settings Lambda and the tests use it as plain data.
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Final

__all__ = [
    'ALIASES',
    'CONFIG_KEY',
    'DEFAULT_CAPS',
    'EMAIL_INTAKE_SOURCE',
    'caps_from_row',
    'inbox_addresses',
    'stats_key',
    'stats_view',
    'today',
    'validate_caps',
]

#: The source id every email item carries (its source profile defaults to ``pii: redact``).
EMAIL_INTAKE_SOURCE: Final = 'email_intake'

CONFIG_KEY: Final = {'pk': 'SETTINGS#email_intake', 'sk': 'config'}
STATS_PK: Final = 'EMAIL_INTAKE#stats'

#: Owner defaults (plan Q8): 200 emails a day overall, 20 per sender a day.
#: ``daily_model_calls`` is the daily model budget: relevance gates plus attachment reads.
DEFAULT_CAPS: Final = {'daily_cap': 200, 'sender_daily_cap': 20, 'daily_model_calls': 400}
CAP_BOUNDS: Final = {'daily_cap': (1, 5000), 'sender_daily_cap': (1, 500), 'daily_model_calls': (0, 10000)}

#: The addresses the inbox answers, local part -> a value of the built-in ``feedback_type``
#: dimension (``shared.feedback_types``); None: the enrichment model decides. ``reviews@`` used to
#: force a ``review`` type, which the built-in list does not have, so the model types those mails.
ALIASES: Final = {'feedback': None, 'ideas': 'feature_request', 'bugs': 'bug', 'reviews': None}

DROP_REASONS: Final = (
    'spam', 'virus', 'auto_reply', 'bulk', 'loop_sender', 'sender_cap',
    'no_text', 'unparseable', 'too_large',
)
DEDUPE_REASONS: Final = ('duplicate_message', 'seen_in_thread', 'no_new_info', 'forward_duplicate')
_COUNTERS: Final = ('received', 'accepted', 'model_calls', 'deferred')


def today(now: datetime | None = None) -> str:
    """The UTC day the counters are kept under, ``YYYY-MM-DD``."""
    return (now or datetime.now(UTC)).strftime('%Y-%m-%d')


def stats_key(day: str) -> dict[str, str]:
    return {'pk': STATS_PK, 'sk': day}


def _whole(value: object) -> int | None:
    """An int from a JSON int or a DynamoDB Decimal; None for anything else (bools included)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, Decimal) and value == value.to_integral_value():
        return int(value)
    return None


def caps_from_row(row: Mapping[str, Any] | None) -> dict[str, int]:
    """The caps in force: the stored values that are in bounds, the defaults for the rest."""
    caps = dict(DEFAULT_CAPS)
    for key, (low, high) in CAP_BOUNDS.items():
        value = _whole((row or {}).get(key))
        if value is not None and low <= value <= high:
            caps[key] = value
    return caps


def validate_caps(body: object) -> dict[str, int]:
    """The caps an admin PUT asks for, every field required; ValueError with a client-safe message."""
    if not isinstance(body, Mapping):
        raise ValueError('Body must be an object')
    caps: dict[str, int] = {}
    for key, (low, high) in CAP_BOUNDS.items():
        value = _whole(body.get(key))
        if value is None or not low <= value <= high:
            raise ValueError(f'{key} must be a whole number from {low} to {high}')
        caps[key] = value
    return caps


def stats_view(day: str, row: Mapping[str, Any] | None) -> dict[str, Any]:
    """One day's counters as the API answers them: every counter present, zero when unset."""
    source = row or {}
    view: dict[str, Any] = {'date': day}
    for counter in _COUNTERS:
        view[counter] = _whole(source.get(counter)) or 0
    view['dropped'] = {reason: _whole(source.get(f'dropped_{reason}')) or 0 for reason in DROP_REASONS}
    view['deduped'] = {reason: _whole(source.get(f'deduped_{reason}')) or 0 for reason in DEDUPE_REASONS}
    return view


def inbox_addresses(domain: str) -> list[str]:
    """Every address the inbox answers at ``domain`` (empty when the inbox is off)."""
    return [f'{alias}@{domain}' for alias in ALIASES] if domain else []

