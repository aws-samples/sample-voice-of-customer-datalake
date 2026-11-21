"""Per-user onboarding-buddy preference + the two first-run signals only the
aggregates table can answer cheaply.

Storage: the caller's own personal-context partition in the aggregates table,
``pk='USERCTX#{sub}'`` (``company_context.user_context_pk``), ``sk='onboarding'``
— a sibling of the ``config`` row that holds their objectives, so no new table,
Lambda or API Gateway resource is needed (``/settings/{proxy+}`` carries it).

States (``PUT /settings/my-onboarding {state?, start_page?, guide?, subscribe_prompt?,
dismiss_decision_run?, playbook?, playbook_done?}``, at least one):

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

Role playbook (7.66.00, docs/playbooks.md, shared/playbooks.py): ``playbook`` is the
role the person picked (``product``, ``scrum_master``, ``qa``, ``engineering``; ``null``
clears it) and ``playbook_done`` the steps they ticked by hand (the list replaces the
stored one: known step ids of any role, so a tick survives a change of role). A role is
content only: it grants nothing and changes no workspace role.

The fields are independent: a PUT changes only the fields it names (one
``UpdateItem``; a dismissed run first reads the stored list to merge and trim it),
so choosing a start page never resets the buddy or the guide, nor the reverse.

``visible`` is computed here, on the server clock, so a skewed client clock
cannot make a snooze end early or never.

Signals (read-only, single-item reads or one-row queries), in the request's scope
(``scope``: the workspace ``X-Workspace-Id`` names, the deployment without it):

- ``feedback_present`` — the scope's earliest-data watermark (``METRIC#meta`` /
  ``earliest_date``, a workspace's ``WS#{ws}#METRIC#meta``) exists: at least one
  feedback item was ever processed there.
- ``feedback_form_configured`` — at least one row in the scope's forms partition
  (``FEEDBACK_FORM``, ``WS#{ws}#FEEDBACK_FORM``).
- the chosen playbook's own (``playbooks.server_signals_of``), only for that playbook:
  ``objectives_set`` (their objectives row holds one; the deployment's ``USERCTX#{sub}`` /
  ``config``, where ``PUT /settings/my-context`` writes it), ``form_test_response`` (a
  test response of a form of the scope exists: test links are anonymous, so not
  necessarily theirs). Whether their morning brief is on is the browser's to read (Home
  reads the brief's settings anyway: ``playbooks.BROWSER_EVIDENCE``).

Data-layer only; the routes live in ``settings_handler.py``.
"""
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, Final

from shared import playbooks
from shared.agents_store import is_run_id
from shared.company_context import get_my_context, user_context_pk
from shared.earliest_date import earliest_date_from_item, earliest_date_key
from shared.exceptions import ValidationError
from shared.form_test_responses import test_responses_partition
from shared.ingest_tables import table_view
from shared.request_body import require_known_change
from shared.scoped_query import query_partition

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceScope

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
_PLAYBOOK: Final = 'playbook'
_PLAYBOOK_DONE: Final = 'playbook_done'
_FIELDS: Final = (*_CHOICES, _DISMISS_RUN, _PLAYBOOK, _PLAYBOOK_DONE)


def forms_partition(scope: 'WorkspaceScope | None') -> str:
    """The feedback form configs' partition: ``FEEDBACK_FORM_PK``, or ``scope``'s workspace's ``WS#{ws}#FEEDBACK_FORM``
    (None: the deployment's). The one rule of the forms API (lambda/api/feedback_form_handler.py) and the forms' AI
    routes (shared/forms_v2_draft_routes.py, shared/forms_report_routes.py)."""
    return scope.key(FEEDBACK_FORM_PK) if scope is not None else FEEDBACK_FORM_PK


def _choice(body: dict, name: str, allowed: tuple[str, ...]) -> str:
    value = body[name]
    if not isinstance(value, str) or value not in allowed:
        raise ValidationError(f"{name} must be one of: {', '.join(allowed)}")
    return value


def validate_preference(body: dict) -> dict[str, Any]:
    """The fields to change; 400 on an unknown field, a bad value, or no field at all."""
    require_known_change(body, _FIELDS)
    changes: dict[str, Any] = {name: _choice(body, name, allowed) for name, allowed in _CHOICES.items() if name in body}
    if _DISMISS_RUN in body:
        run_id = body[_DISMISS_RUN]
        if not is_run_id(run_id):
            raise ValidationError(f'{_DISMISS_RUN} must be an agent run id')
        changes[_DISMISS_RUN] = run_id
    if _PLAYBOOK in body:
        changes[_PLAYBOOK] = playbooks.validate_role(body[_PLAYBOOK])
    if _PLAYBOOK_DONE in body:
        changes[_PLAYBOOK_DONE] = playbooks.validate_done(body[_PLAYBOOK_DONE])
    return changes


def _stored_runs(row: dict) -> list[str]:
    """The stored dismissed run ids that still look like run ids (a drifted entry is dropped)."""
    raw = row.get('dismissed_decision_runs')
    if not isinstance(raw, list):
        return []
    return [run for run in raw if is_run_id(run)]


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


def preference_update(changes: dict[str, Any], now: datetime,
                      dismissed_runs: list[str] | None = None) -> dict[str, Any]:
    """The ``UpdateItem`` arguments (minus ``Key``) that apply ``changes``.

    ``hidden_until`` is set only for a snooze and removed by any other state; a
    change of ``start_page`` or ``guide`` alone leaves the buddy's fields as they are.
    ``dismissed_runs`` (from ``merged_dismissed_runs``) replaces the stored list. A ``playbook`` of None removes
    the stored choice; ``playbook_done`` replaces the stored ticks.
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
    for name in ('start_page', 'guide', 'subscribe_prompt', _PLAYBOOK_DONE):
        if name in changes:
            sets.append(f'{name} = :{name}')
            values[f':{name}'] = changes[name]
    if _PLAYBOOK in changes:
        if changes[_PLAYBOOK] is None:
            removes.append(_PLAYBOOK)
        else:
            sets.append(f'{_PLAYBOOK} = :{_PLAYBOOK}')
            values[f':{_PLAYBOOK}'] = changes[_PLAYBOOK]
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


def _stored_playbook(row: dict) -> str | None:
    raw = row.get(_PLAYBOOK)
    return raw if isinstance(raw, str) and raw in playbooks.ROLES else None


def _stored_done(row: dict) -> list[str]:
    """The stored ticks that still name a step (a step a later release retired is dropped)."""
    raw = row.get(_PLAYBOOK_DONE)
    if not isinstance(raw, list):
        return []
    return sorted({step for step in raw if isinstance(step, str) and step in playbooks.STEP_IDS})


def preference_view(item: dict | None, now: datetime) -> dict:
    """``{state, hidden_until, updated_at, visible, start_page, guide, subscribe_prompt,
    dismissed_decision_runs, playbook, playbook_done}`` from a stored row (or none)."""
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
        'playbook': _stored_playbook(row),
        'playbook_done': _stored_done(row),
    }


def _has_a_row(table: Any, scope: 'WorkspaceScope | None', partition: str) -> bool:
    """Whether ``partition`` (of ``scope``) holds at least one row: a one-row, keys-only Query."""
    page = query_partition(scope, table, 'pk', partition, Limit=1, ProjectionExpression='pk')
    return bool(page.get('Items'))


def _playbook_signal(name: str, table: Any, sub: str, scope: 'WorkspaceScope | None') -> bool:
    """One playbook signal (``playbooks.SERVER_SIGNALS`` less the first-run two, which ``signals`` always reads)."""
    if name == 'objectives_set':
        return bool(get_my_context(table, sub)['objectives'])
    return _has_a_row(table, scope, test_responses_partition(scope))


def signals(table: Any, scope: 'WorkspaceScope | None' = None, *, sub: str = '',
            playbook: str | None = None) -> dict:
    """The first-run facts the aggregates table holds for ``scope`` (the deployment's when None), plus the server
    signals of ``playbook``'s steps (none without one)."""
    watermark = table_view(scope, table).get_item(earliest_date_key(scope)).get('Item')
    facts = {
        'feedback_present': earliest_date_from_item(watermark) is not None,
        'feedback_form_configured': _has_a_row(table, scope, forms_partition(scope)),
    }
    for name in playbooks.server_signals_of(playbook):
        if name not in facts:
            facts[name] = _playbook_signal(name, table, sub, scope)
    return facts


def _answer(view: dict, table: Any, sub: str, scope: 'WorkspaceScope | None') -> dict:
    return {**view, 'signals': signals(table, scope, sub=sub, playbook=view['playbook'])}


def get_onboarding(table: Any, sub: str, now: datetime | None = None, scope: 'WorkspaceScope | None' = None) -> dict:
    """The caller's preference view plus ``signals`` (in ``scope``)."""
    moment = now or datetime.now(UTC)
    item = table.get_item(Key={'pk': user_context_pk(sub), 'sk': ONBOARDING_SK}).get('Item')
    return _answer(preference_view(item, moment), table, sub, scope)


def put_onboarding(table: Any, sub: str, changes: dict[str, Any], now: datetime | None = None,
                   scope: 'WorkspaceScope | None' = None) -> dict:
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
    return _answer(preference_view(stored, moment), table, sub, scope)
