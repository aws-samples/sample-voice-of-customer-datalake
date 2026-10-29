"""Per-user morning-brief preferences (``GET/PUT /settings/my-briefing``).

Storage: the caller's own personal-context partition in the aggregates table,
``pk='USERCTX#{sub}'``, ``sk='briefing'`` — a sibling of the ``config`` row
(objectives) and the ``onboarding`` row, so no new table or API resource.

Fields (a PUT names only what it changes; the rest keep their stored value):

- ``enabled``      — the scheduled brief is on. Off by default: nothing runs and
                     nothing costs until the user subscribes (or presses Refresh).
- ``hour``         — local hour (0-23) the scheduled brief is built (and mailed).
- ``time_zone``    — IANA zone the hour is read in (the browser's, on subscribe).
- ``language``     — one of the 9 UI languages; the brief is written in it.
- ``language_source`` — ``ui`` (follow the language the reader uses the app in)
                     or ``chosen`` (picked in the brief settings: it wins for
                     Refresh, the scheduled brief and the email). A row without
                     it reads as ``ui``: every such row was written by Subscribe
                     with the UI language, or holds the 'en' default.
- ``instructions`` — "what I want in my brief" (≤ 2,000 chars, screened for text
                     that reads like instructions to the AI, as company context is).
- ``email``        — mail the scheduled brief to the user's own verified Cognito
                     email (the address is read from Cognito, never from a request).

Data-layer only: validation and the stored/wire shapes. The routes live in
``settings_handler.py``; the SNS subscription in ``shared/briefing_subscription.py``.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Final
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from shared.company_context import user_context_pk
from shared.exceptions import ValidationError
from shared.prompt_safety import injection_findings

BRIEFING_SK: Final = 'briefing'
#: The UI languages (frontend/src/i18n/languages.ts, lockstepped by a test).
LANGUAGES: Final = ('en', 'es', 'fr', 'de', 'pt', 'ja', 'zh', 'ko', 'pl')
MAX_INSTRUCTIONS_CHARS: Final = 2_000
MAX_TIME_ZONE_CHARS: Final = 64
DEFAULT_HOUR: Final = 8
DEFAULT_TIME_ZONE: Final = 'UTC'
FIELDS: Final = ('enabled', 'hour', 'time_zone', 'language', 'language_source', 'instructions', 'email')
LANGUAGE_UI: Final = 'ui'
LANGUAGE_CHOSEN: Final = 'chosen'
LANGUAGE_SOURCES: Final = (LANGUAGE_UI, LANGUAGE_CHOSEN)

EMAIL_OFF: Final = 'off'
EMAIL_PENDING: Final = 'pending'
EMAIL_CONFIRMED: Final = 'confirmed'
EMAIL_STATUSES: Final = (EMAIL_OFF, EMAIL_PENDING, EMAIL_CONFIRMED)

# Area/Location[/Sub] or a bare zone name such as UTC; the zone database decides the rest.
_ZONE_RE: Final = re.compile(r'^[A-Za-z][A-Za-z0-9_+\-]*(/[A-Za-z0-9_+\-]+){0,2}\Z')


def preferences_key(sub: str) -> dict[str, str]:
    return {'pk': user_context_pk(sub), 'sk': BRIEFING_SK}


def validate_time_zone(value: object) -> str:
    """An IANA zone the runtime's zone database knows; 400 otherwise."""
    message = 'time_zone must be an IANA time zone such as Europe/Paris'
    if not isinstance(value, str) or len(value) > MAX_TIME_ZONE_CHARS or not _ZONE_RE.match(value):
        raise ValidationError(message)
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValidationError(message) from exc
    return value


def zone_of(name: object) -> Any:
    """The stored zone, UTC when unreadable (a row never breaks a dispatch)."""
    if not isinstance(name, str) or not name:
        return UTC
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return UTC


def local_day(time_zone: object, now: datetime) -> str:
    """``YYYY-MM-DD`` in the user's zone: the day a personal brief is filed under."""
    return now.astimezone(zone_of(time_zone)).strftime('%Y-%m-%d')


def _bool(body: Mapping[str, Any], name: str) -> bool:
    value = body[name]
    if not isinstance(value, bool):
        raise ValidationError(f'{name} must be true or false')
    return value


def _hour(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 23:
        raise ValidationError('hour must be a whole number from 0 to 23')
    return value


def _language(value: object) -> str:
    if not isinstance(value, str) or value not in LANGUAGES:
        raise ValidationError(f"language must be one of: {', '.join(LANGUAGES)}")
    return value


def _language_source(value: object) -> str:
    if not isinstance(value, str) or value not in LANGUAGE_SOURCES:
        raise ValidationError(f"language_source must be one of: {', '.join(LANGUAGE_SOURCES)}")
    return value


def validate_instructions(value: object) -> str:
    """The custom prompt, stripped; 400 when too long or when it reads like a prompt injection."""
    if not isinstance(value, str):
        raise ValidationError('instructions must be a string')
    text = value.strip()
    if len(text) > MAX_INSTRUCTIONS_CHARS:
        raise ValidationError(f'instructions must be at most {MAX_INSTRUCTIONS_CHARS} characters')
    findings = injection_findings(text)
    if findings:
        raise ValidationError(
            f"instructions contain text that looks like instructions to the AI ({', '.join(findings)}); "
            'describe what you want in your brief as plain content')
    return text


_VALIDATORS: Final = {
    'hour': _hour,
    'time_zone': validate_time_zone,
    'language': _language,
    'language_source': _language_source,
    'instructions': validate_instructions,
}


def validate_changes(body: Mapping[str, Any]) -> dict[str, Any]:
    """The fields to change; 400 on an unknown field, a bad value, or no field at all."""
    unknown = set(body) - set(FIELDS)
    if unknown:
        raise ValidationError(f"Unknown field(s): {', '.join(sorted(unknown))}")
    if not any(name in body for name in FIELDS):
        raise ValidationError(f"Give at least one of: {', '.join(FIELDS)}")
    changes: dict[str, Any] = {}
    for name in FIELDS:
        if name not in body:
            continue
        validator = _VALIDATORS.get(name)
        changes[name] = _bool(body, name) if validator is None else validator(body[name])
    if 'language' in changes and 'language_source' not in changes:
        # A language named without a source is an explicit choice (an API caller, an older SPA).
        changes['language_source'] = LANGUAGE_CHOSEN
    return changes


def validate_refresh(body: Mapping[str, Any]) -> str | None:
    """The optional ``{language}`` of ``POST .../refresh``: the reader's UI language, or None."""
    unknown = set(body) - {'language'}
    if unknown:
        raise ValidationError(f"Unknown field(s): {', '.join(sorted(unknown))}")
    return _language(body['language']) if 'language' in body else None


def language_source(item: Mapping[str, Any] | None) -> str:
    """``chosen`` only when the reader picked the language in the brief settings; else ``ui``."""
    row = item if isinstance(item, Mapping) else {}
    return LANGUAGE_CHOSEN if row.get('language_source') == LANGUAGE_CHOSEN else LANGUAGE_UI


def _stored_hour(value: object) -> int:
    """A stored hour (DynamoDB answers ``Decimal``) as 0-23, the default when unreadable."""
    if isinstance(value, bool) or not isinstance(value, int | Decimal):
        return DEFAULT_HOUR
    hour = int(value)
    return hour if 0 <= hour <= 23 else DEFAULT_HOUR


def stored_preferences(item: Mapping[str, Any] | None) -> dict[str, Any]:
    """The seven preference fields read leniently from a stored row (defaults when absent)."""
    row = item if isinstance(item, Mapping) else {}
    language = row.get('language')
    zone = row.get('time_zone')
    instructions = row.get('instructions')
    return {
        'enabled': row.get('enabled') is True,
        'hour': _stored_hour(row.get('hour', DEFAULT_HOUR)),
        'time_zone': zone if isinstance(zone, str) and zone else DEFAULT_TIME_ZONE,
        'language': language if language in LANGUAGES else 'en',
        'language_source': language_source(row),
        'instructions': instructions if isinstance(instructions, str) else '',
        'email': row.get('email') is True,
    }


def email_status(item: Mapping[str, Any] | None) -> str:
    row = item if isinstance(item, Mapping) else {}
    status = row.get('email_status')
    if not row.get('subscription_arn') or status not in EMAIL_STATUSES:
        return EMAIL_OFF
    return str(status)


def preferences_view(item: Mapping[str, Any] | None) -> dict[str, Any]:
    """The ``GET/PUT /settings/my-briefing`` body. Never carries the address or the ARN."""
    row = item if isinstance(item, Mapping) else {}
    updated_at = row.get('updated_at')
    return {
        **stored_preferences(row),
        'email_status': email_status(row),
        'updated_at': updated_at if isinstance(updated_at, str) else None,
    }


def merged(item: Mapping[str, Any] | None, changes: Mapping[str, Any]) -> dict[str, Any]:
    """The preferences after ``changes`` apply to the stored row."""
    return {**stored_preferences(item), **changes}
