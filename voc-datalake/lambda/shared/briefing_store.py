"""Morning-brief rows in the aggregates table (shared by the settings API and the worker).

Keys (docs/briefing.md):

- ``BRIEF#{sub}`` / ``{local day}`` — one personal brief per user per day: the cards,
  the headline, ``status`` (``pending | ready | failed``), ``card_state`` (``{card_id:
  seen | dismissed | acted}``, kept across a same-day refresh because card ids are
  stable for the same fact on the same day) and ``feedback_marker``.
- ``BRIEFORG#{scope_hash}`` / ``{UTC day}`` — the org layer of one scope group (users
  with identical category + source access), built once per group per day.
- ``BRIEFSUB`` / ``USER#{sub}`` — the subscriber index the dispatcher reads; only
  users with the scheduled brief ON have a row, so an idle deployment reads nothing.
"""
from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, Final

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from shared.aws import is_conditional_check_failure
from shared.category_access import CategoryScope
from shared.dynamo_values import plain
from shared.exceptions import NotFoundError, ValidationError
from shared.memory_policy import parse_datetime

BRIEF_PK_PREFIX: Final = 'BRIEF#'
ORG_PK_PREFIX: Final = 'BRIEFORG#'
SUBSCRIBERS_PK: Final = 'BRIEFSUB'
SUBSCRIBER_SK_PREFIX: Final = 'USER#'
DAILY_TOTAL_PK: Final = 'METRIC#daily_total'

STATUS_PENDING: Final = 'pending'
STATUS_READY: Final = 'ready'
STATUS_FAILED: Final = 'failed'
STATUSES: Final = (STATUS_PENDING, STATUS_READY, STATUS_FAILED)

CARD_STATES: Final = ('seen', 'dismissed', 'acted')
MAX_CARD_STATE_CHANGES: Final = 50
#: No new reviews and a brief younger than this: a refresh answers "up to date".
DEBOUNCE: Final = timedelta(minutes=15)
#: A pending build older than this is dead (the worker failed without saying so).
PENDING_TIMEOUT: Final = timedelta(minutes=15)

_CARD_ID_RE: Final = re.compile(r'^[a-z][a-z0-9_]{0,40}_[0-9a-f]{16}\Z')
_DAY_RE: Final = re.compile(r'^\d{4}-\d{2}-\d{2}\Z')


def brief_key(sub: str, day: str) -> dict[str, str]:
    return {'pk': f'{BRIEF_PK_PREFIX}{sub}', 'sk': day}


def org_key(scope_hash: str, day: str) -> dict[str, str]:
    return {'pk': f'{ORG_PK_PREFIX}{scope_hash}', 'sk': day}


def subscriber_key(sub: str) -> dict[str, str]:
    return {'pk': SUBSCRIBERS_PK, 'sk': f'{SUBSCRIBER_SK_PREFIX}{sub}'}


def scope_hash(scope: CategoryScope) -> str:
    """Stable id of a scope group: users whose category AND source access are identical."""
    canonical = json.dumps(scope.to_dict(), sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:24]


def _count(value: object) -> int:
    return int(value) if isinstance(value, int | Decimal) and not isinstance(value, bool) else 0


def feedback_marker(aggregates_table: Any, now: datetime) -> str:
    """``{UTC day}:{reviews processed that day}`` — changes whenever a review lands."""
    day = now.astimezone(UTC).strftime('%Y-%m-%d')
    item = aggregates_table.get_item(Key={'pk': DAILY_TOTAL_PK, 'sk': day}).get('Item') or {}
    return f'{day}:{_count(item.get("count"))}'


def latest_brief(aggregates_table: Any, sub: str) -> dict | None:
    """The newest personal brief row of ``sub`` (any day), or None."""
    page = aggregates_table.query(
        KeyConditionExpression=Key('pk').eq(f'{BRIEF_PK_PREFIX}{sub}'),
        ScanIndexForward=False, Limit=1,
    )
    items = page.get('Items') or []
    return items[0] if items and isinstance(items[0], dict) else None


def effective_status(item: Mapping[str, Any], now: datetime) -> str:
    """The stored status, with a pending build past ``PENDING_TIMEOUT`` read as failed."""
    status = item.get('status')
    if status == STATUS_PENDING:
        requested = parse_datetime(item.get('requested_at'))
        if requested is None or now - requested > PENDING_TIMEOUT:
            return STATUS_FAILED
    return str(status) if status in STATUSES else STATUS_FAILED


def _card_states(item: Mapping[str, Any]) -> dict[str, str]:
    raw = item.get('card_state')
    if not isinstance(raw, Mapping):
        return {}
    return {str(k): str(v) for k, v in raw.items() if v in CARD_STATES}


def _text(item: Mapping[str, Any], name: str) -> str | None:
    value = item.get(name)
    return value if isinstance(value, str) else None


def brief_view(item: Mapping[str, Any] | None, now: datetime) -> dict[str, Any]:
    """The ``GET /settings/my-briefing/brief`` body (``status: 'none'`` before the first brief)."""
    if not isinstance(item, Mapping):
        return {'status': 'none', 'day': None, 'generated_at': None, 'requested_at': None,
                'headline': '', 'summary': '', 'language': None, 'cards': [], 'card_state': {}}
    cards = [plain(card) for card in item.get('cards') or [] if isinstance(card, Mapping)]
    return {
        'status': effective_status(item, now),
        'day': _text(item, 'sk'),
        'generated_at': _text(item, 'generated_at'),
        'requested_at': _text(item, 'requested_at'),
        'headline': _text(item, 'headline') or '',
        'summary': _text(item, 'summary') or '',
        'language': _text(item, 'language'),
        'cards': cards,
        'card_state': _card_states(item),
    }


def settings_marker(settings: Mapping[str, Any]) -> str:
    """Fingerprint of the preferences that change a brief's WORDS (language, custom instructions).

    Stored on every built brief, so a Refresh after the reader changed either rebuilds instead of
    answering ``up_to_date`` with a brief written for the old settings.
    """
    canonical = json.dumps({'language': settings.get('language'), 'instructions': settings.get('instructions') or ''},
                           sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:16]


def is_up_to_date(item: Mapping[str, Any] | None, marker: str, now: datetime, settings: str | None = None) -> bool:
    """A ready brief younger than ``DEBOUNCE``, with no review processed since it was built and (when
    ``settings`` is given) built for the reader's current ``settings_marker``."""
    if not isinstance(item, Mapping) or item.get('status') != STATUS_READY:
        return False
    if settings is not None and item.get('settings_marker') != settings:
        return False
    generated = parse_datetime(item.get('generated_at'))
    return generated is not None and now - generated < DEBOUNCE and item.get('feedback_marker') == marker


def is_building(item: Mapping[str, Any] | None, now: datetime) -> bool:
    return isinstance(item, Mapping) and effective_status(item, now) == STATUS_PENDING


def mark_pending(aggregates_table: Any, sub: str, day: str, now: datetime) -> dict:
    """Flag the brief of ``day`` as being rebuilt and return the row; its cards stay readable meanwhile."""
    response = aggregates_table.update_item(
        Key=brief_key(sub, day),
        UpdateExpression='SET #status = :pending, requested_at = :now, '
                         'card_state = if_not_exists(card_state, :empty)',
        ExpressionAttributeNames={'#status': 'status'},
        ExpressionAttributeValues={':pending': STATUS_PENDING, ':now': now.isoformat(), ':empty': {}},
        ReturnValues='ALL_NEW',
    )
    return response.get('Attributes') or {}


def mark_failed(aggregates_table: Any, sub: str, day: str, now: datetime) -> None:
    """The build could not run (or crashed): readers stop waiting for it."""
    aggregates_table.update_item(
        Key=brief_key(sub, day),
        UpdateExpression='SET #status = :failed, failed_at = :now',
        ExpressionAttributeNames={'#status': 'status'},
        ExpressionAttributeValues={':failed': STATUS_FAILED, ':now': now.isoformat()},
    )


def validate_card_states(body: Mapping[str, Any]) -> tuple[str, dict[str, str]]:
    """``(day, {card_id: state})`` from ``{day, states}``; 400 on anything else."""
    unknown = set(body) - {'day', 'states'}
    if unknown:
        raise ValidationError(f"Unknown field(s): {', '.join(sorted(unknown))}")
    day = body.get('day')
    if not isinstance(day, str) or not _DAY_RE.match(day):
        raise ValidationError('day must be YYYY-MM-DD')
    states = body.get('states')
    if not isinstance(states, Mapping) or not states:
        raise ValidationError('states must be a non-empty object of card id to state')
    if len(states) > MAX_CARD_STATE_CHANGES:
        raise ValidationError(f'At most {MAX_CARD_STATE_CHANGES} cards per call')
    for card, state in states.items():
        if not isinstance(card, str) or not _CARD_ID_RE.match(card):
            raise ValidationError('states has an invalid card id')
        if state not in CARD_STATES:
            raise ValidationError(f"state must be one of: {', '.join(CARD_STATES)}")
    return day, {str(k): str(v) for k, v in states.items()}


def set_card_states(aggregates_table: Any, sub: str, day: str, states: Mapping[str, str]) -> dict[str, str]:
    """Record the caller's card states on their own brief of ``day``; 404 when there is none."""
    names = {f'#c{i}': card for i, card in enumerate(states)}
    values = {f':s{i}': state for i, state in enumerate(states.values())}
    sets = ', '.join(f'card_state.#c{i} = :s{i}' for i in range(len(states)))
    try:
        response = aggregates_table.update_item(
            Key=brief_key(sub, day), UpdateExpression=f'SET {sets}',
            ConditionExpression='attribute_exists(card_state)',
            ExpressionAttributeNames=names, ExpressionAttributeValues=values,
            ReturnValues='ALL_NEW',
        )
    except ClientError as exc:
        if is_conditional_check_failure(exc):
            raise NotFoundError('No brief for that day') from exc
        raise
    return _card_states(response.get('Attributes') or {})
