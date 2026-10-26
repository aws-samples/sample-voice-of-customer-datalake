"""Per-user onboarding-buddy preference + the two first-run signals only the
aggregates table can answer cheaply.

Storage: the caller's own personal-context partition in the aggregates table,
``pk='USERCTX#{sub}'`` (``company_context.user_context_pk``), ``sk='onboarding'``
— a sibling of the ``config`` row that holds their objectives, so no new table,
Lambda or API Gateway resource is needed (``/settings/{proxy+}`` carries it).

States (``PUT /settings/my-onboarding {state?, start_page?, guide?, subscribe_prompt?,
dismiss_decision_run?}``, at least one):

- ``active``    — the buddy shows on Home (also the default when no row exists).
- ``hidden``    — "Hide for now": hidden until ``hidden_until`` (server clock,
                  ``HIDE_FOR``), then it shows again by itself.
- ``dismissed`` — "Don't show again": hidden until the user reopens it.
- ``skipped``   — "Skip" before finishing: Home shows the checklist COLLAPSED
                  (``visible`` stays false); expanding it sets ``active`` again.

Start page (``start_page``): ``home`` (default) or ``dashboard`` — where the app
opens for this user (a fresh load of ``/`` or the redirect after sign-in). Home
stays reachable from the sidebar either way.

Guide (``guide``): ``open`` (default) or ``skipped`` — whether Home's "How it
works" section starts expanded or collapsed (the user pressed its Skip; expanding
it again sets ``open``).

Subscribe prompt (``subscribe_prompt``): ``shown`` (default) or ``dismissed`` —
whether Home shows its "Subscribe to the morning brief" card (the reader closed it
with its X; Account → Morning brief still subscribes).

Dismissed decisions (``dismiss_decision_run: <run id>``, write-only): the reader
closed Home's "<agent> needs your decision" card for that waiting run. The view
lists the ``MAX_DISMISSED_RUNS`` newest such run ids (run ids sort by start time)
as ``dismissed_decision_runs``; a LATER run that stops for a person shows its card
again. Closing a card decides nothing: the run still waits on the agent's Runs tab.

The fields are independent: a PUT changes only the fields it names (one
``UpdateItem``; a dismissed run first reads the stored list to merge and trim it),
so choosing a start page never resets the buddy or the guide, nor the reverse.

``visible`` is computed here, on the server clock, so a skewed client clock
cannot make a snooze end early or never.

Signals (read-only, two single-item reads):

- ``feedback_present`` — the earliest-data watermark (``METRIC#meta`` /
  ``earliest_date``) exists: at least one feedback item was ever processed.
- ``feedback_form_configured`` — at least one row in the ``FEEDBACK_FORM``
  partition.

Data-layer only; the routes live in ``settings_handler.py``.
"""
import re
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from boto3.dynamodb.conditions import Key

from shared.company_context import user_context_pk
from shared.earliest_date import EARLIEST_DATE_KEY, earliest_date_from_item
from shared.exceptions import ValidationError

ONBOARDING_SK: Final = 'onboarding'
STATES: Final = ('active', 'hidden', 'dismissed', 'skipped')
DEFAULT_STATE: Final = 'active'
START_PAGES: Final = ('home', 'dashboard')
DEFAULT_START_PAGE: Final = 'home'
GUIDES: Final = ('open', 'skipped')
DEFAULT_GUIDE: Final = 'open'
SUBSCRIBE_PROMPTS: Final = ('shown', 'dismissed')
DEFAULT_SUBSCRIBE_PROMPT: Final = 'shown'
MAX_DISMISSED_RUNS: Final = 50
HIDE_FOR: Final = timedelta(days=1)
FEEDBACK_FORM_PK: Final = 'FEEDBACK_FORM'
_CHOICES: Final = {'state': STATES, 'start_page': START_PAGES, 'guide': GUIDES, 'subscribe_prompt': SUBSCRIBE_PROMPTS}
_DISMISS_RUN: Final = 'dismiss_decision_run'
_FIELDS: Final = (*_CHOICES, _DISMISS_RUN)
# The agents runtime's run ids (``_RUN_ID_RE`` in shared/agents_store.py).
_RUN_ID_RE: Final = re.compile(r'ar_[0-9a-f]{12,20}')


def _choice(body: dict, name: str, allowed: tuple[str, ...]) -> str:
    value = body[name]
    if not isinstance(value, str) or value not in allowed:
        raise ValidationError(f"{name} must be one of: {', '.join(allowed)}")
    return value


def validate_preference(body: dict) -> dict[str, str]:
    """The fields to change; 400 on an unknown field, a bad value, or no field at all."""
    unknown = set(body) - set(_FIELDS)
    if unknown:
        raise ValidationError(f"Unknown field(s): {', '.join(sorted(unknown))}")
    if not any(name in body for name in _FIELDS):
        raise ValidationError(f"Give at least one of: {', '.join(_FIELDS)}")
    changes = {name: _choice(body, name, allowed) for name, allowed in _CHOICES.items() if name in body}
    if _DISMISS_RUN in body:
        run_id = body[_DISMISS_RUN]
        if not isinstance(run_id, str) or not _RUN_ID_RE.fullmatch(run_id):
            raise ValidationError(f'{_DISMISS_RUN} must be an agent run id')
        changes[_DISMISS_RUN] = run_id
    return changes


def _stored_runs(row: dict) -> list[str]:
    """The stored dismissed run ids that still look like run ids (a drifted entry is dropped)."""
    raw = row.get('dismissed_decision_runs')
    if not isinstance(raw, list):
        return []
    return [run for run in raw if isinstance(run, str) and _RUN_ID_RE.fullmatch(run)]


def merged_dismissed_runs(stored: dict | None, run_id: str) -> list[str]:
    """The stored list plus ``run_id``, de-duplicated, newest first, at most ``MAX_DISMISSED_RUNS``."""
    runs = set(_stored_runs(stored if isinstance(stored, dict) else {}))
    runs.add(run_id)
    return sorted(runs, reverse=True)[:MAX_DISMISSED_RUNS]


def _parse_iso(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def preference_update(changes: dict[str, str], now: datetime,
                      dismissed_runs: list[str] | None = None) -> dict[str, Any]:
    """The ``UpdateItem`` arguments (minus ``Key``) that apply ``changes``.

    ``hidden_until`` is set only for a snooze and removed by any other state; a
    change of ``start_page`` or ``guide`` alone leaves the buddy's fields as they are.
    ``dismissed_runs`` (from ``merged_dismissed_runs``) replaces the stored list.
    """
    sets = ['updated_at = :now']
    removes: list[str] = []
    names: dict[str, str] = {}
    values: dict[str, Any] = {':now': now.isoformat()}
    state = changes.get('state')
    if state is not None:
        # `state` is a DynamoDB reserved word.
        sets.append('#state = :state')
        names['#state'] = 'state'
        values[':state'] = state
        if state == 'hidden':
            sets.append('hidden_until = :until')
            values[':until'] = (now + HIDE_FOR).isoformat()
        else:
            removes.append('hidden_until')
    for name in ('start_page', 'guide', 'subscribe_prompt'):
        if name in changes:
            sets.append(f'{name} = :{name}')
            values[f':{name}'] = changes[name]
    if dismissed_runs is not None:
        sets.append('dismissed_decision_runs = :dismissed_runs')
        values[':dismissed_runs'] = dismissed_runs
    expression = 'SET ' + ', '.join(sets) + (' REMOVE ' + ', '.join(removes) if removes else '')
    update: dict[str, Any] = {'UpdateExpression': expression, 'ExpressionAttributeValues': values,
                              'ReturnValues': 'ALL_NEW'}
    if names:
        # DynamoDB refuses an empty ExpressionAttributeNames map.
        update['ExpressionAttributeNames'] = names
    return update


def preference_view(item: dict | None, now: datetime) -> dict:
    """``{state, hidden_until, updated_at, visible, start_page, guide, subscribe_prompt,
    dismissed_decision_runs}`` from a stored row (or none)."""
    row = item if isinstance(item, dict) else {}
    raw_state = row.get('state')
    state = raw_state if isinstance(raw_state, str) and raw_state in STATES else DEFAULT_STATE
    hidden_until = _parse_iso(row.get('hidden_until')) if state == 'hidden' else None
    if state == 'active':
        visible = True
    elif state == 'hidden':
        # A snooze row without a readable end shows again rather than hiding forever.
        visible = hidden_until is None or now >= hidden_until
    else:
        visible = False
    updated_at = row.get('updated_at')
    raw_start = row.get('start_page')
    raw_guide = row.get('guide')
    raw_prompt = row.get('subscribe_prompt')
    return {
        'state': state,
        'hidden_until': hidden_until.isoformat() if hidden_until is not None else None,
        'updated_at': updated_at if isinstance(updated_at, str) else None,
        'visible': visible,
        'start_page': raw_start if isinstance(raw_start, str) and raw_start in START_PAGES else DEFAULT_START_PAGE,
        'guide': raw_guide if isinstance(raw_guide, str) and raw_guide in GUIDES else DEFAULT_GUIDE,
        'subscribe_prompt': (raw_prompt if isinstance(raw_prompt, str) and raw_prompt in SUBSCRIBE_PROMPTS
                             else DEFAULT_SUBSCRIBE_PROMPT),
        'dismissed_decision_runs': sorted(_stored_runs(row), reverse=True)[:MAX_DISMISSED_RUNS],
    }


def signals(table: Any) -> dict:
    """The deployment-wide first-run facts the aggregates table holds."""
    watermark = table.get_item(Key=dict(EARLIEST_DATE_KEY)).get('Item')
    forms = table.query(KeyConditionExpression=Key('pk').eq(FEEDBACK_FORM_PK), Limit=1, ProjectionExpression='pk')
    return {
        'feedback_present': earliest_date_from_item(watermark) is not None,
        'feedback_form_configured': bool(forms.get('Items')),
    }


def get_onboarding(table: Any, sub: str, now: datetime | None = None) -> dict:
    """The caller's preference view plus ``signals``."""
    moment = now or datetime.now(UTC)
    item = table.get_item(Key={'pk': user_context_pk(sub), 'sk': ONBOARDING_SK}).get('Item')
    return {**preference_view(item, moment), 'signals': signals(table)}


def put_onboarding(table: Any, sub: str, changes: dict[str, str], now: datetime | None = None) -> dict:
    """Apply ``changes`` (from ``validate_preference``) to the caller's row and return the fresh view."""
    moment = now or datetime.now(UTC)
    key = {'pk': user_context_pk(sub), 'sk': ONBOARDING_SK}
    dismissed: list[str] | None = None
    run_id = changes.get(_DISMISS_RUN)
    if run_id is not None:
        # Read-merge-write: a second tab dismissing at the same instant can lose one
        # entry, which only shows that card again (closing it decides nothing).
        dismissed = merged_dismissed_runs(table.get_item(Key=key).get('Item'), run_id)
    stored = table.update_item(Key=key, **preference_update(changes, moment, dismissed)).get('Attributes')
    # The view comes from the row as written (ALL_NEW): no read-back of the same key.
    return {**preference_view(stored, moment), 'signals': signals(table)}
