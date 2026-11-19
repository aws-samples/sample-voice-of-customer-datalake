"""The engineering setup guide's progress (7.50.00; included by ``api/agents_handler.py``).

    GET /agents/engineering/setup                              -> {steps, intro, revision, updated_at, updated_by}
    PUT /agents/engineering/setup {revision, steps?, intro?}   -> the same, as saved

The guide (Agents → Setup guide, ``/agents/setup``: frontend ``pages/Agents/SetupGuide``) walks an administrator
through the deployment's engineering automations in a recommended order. What is set up is read from the deployment
itself, through the routes that already serve it (connections, GitHub Apps, sources, agents, readiness), and never
stored here; this row keeps only what a person chose: a step skipped for now or marked done (``steps``), and the
first visit's choice (``intro``: ``started`` for "Help me set up", ``skipped`` for "Skip").

One row per deployment in voc-agents, ``SETTINGS#engineering_setup`` / ``config``, beside the hard cap's
``SETTINGS#engineering`` (engineering/settings.py), written the same way: each change also writes a create-only
history row in the same partition, ``LOG#<at>#<n>`` (D1, D4: who, when, what changed), in the same transaction, so
the state and its history never drift. A PUT names the ``revision`` it was made from and changes only the steps it
names; a revision that moved since answers 409, so two administrators never overwrite each other unseen.

Administrators only, acting for themselves (403 for anyone else, a delegated credential included); 404 while the
engineering agents are off, as every ``/agents/engineering/*`` route; 503 when the table cannot be read or written.
The deployment's, like the agents (phase 3 of docs/multi-workspace.md).

Kept in ``shared/`` because an API bundle ships ``api/<handler>.py`` and ``shared/`` only
(api/test/test_api_bundle_imports.py).
"""
from __future__ import annotations

import secrets
from collections.abc import Mapping
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Final

from aws_lambda_powertools.event_handler.api_gateway import Router
from botocore.exceptions import BotoCoreError, ClientError

from shared.agents_store import require_agents_table as _table
from shared.dynamo_values import text_or_none as _text
from shared.engineering_agents import require_engineering_on as _engineering_on
from shared.exceptions import (
    ConflictError,
    ServiceUnavailableError,
    ValidationError,
)
from shared.logging import logger, tracer
from shared.project_gate import caller_from_event, require_admin_caller
from shared.request_body import json_object_body

__all__ = ['app']

#: The guide's one row (voc-agents).
SETUP_KEY: Final = {'pk': 'SETTINGS#engineering_setup', 'sk': 'config'}
#: The guide's steps, in the order it recommends them (frontend setupGuideRules.ts STEP_IDS, in lockstep).
STEP_IDS: Final = ('prerequisites', 'understand', 'tenets', 'triage', 'bug_fixer', 'feature_builder', 'ready')
#: What a person chose for a step: nothing yet, skipped for now, or marked done.
STEP_STATES: Final = ('pending', 'skipped', 'done')
#: The first visit's choice: not made yet, "Help me set up", or "Skip".
INTROS: Final = ('unseen', 'started', 'skipped')
#: Who a change with no caller name is recorded as (never a blank in the history).
NO_NAME: Final = 'unknown'
_MAX_NAME: Final = 128
_MAX_REVISION: Final = 1_000_000
_BODY_KEYS: Final = frozenset({'revision', 'steps', 'intro'})
CHANGED: Final = 'the setup guide changed since you opened it: read it again'
_SHAPE: Final = ('the body is {revision: <the revision read>, steps?: {<step>: pending | skipped | done}, '
                 'intro?: started | skipped}')

app = Router()


def _blank() -> dict[str, Any]:
    return {'steps': dict.fromkeys(STEP_IDS, 'pending'), 'intro': 'unseen', 'revision': 0,
            'updated_at': None, 'updated_by': None}


def setup_view(item: Mapping[str, Any] | None) -> dict[str, Any]:
    """The stored row as the guide reads it: every step (an unknown or missing one as ``pending``), the intro and the
    revision; a deployment that never saved one reads as nothing chosen at revision 0."""
    view = _blank()
    if not item:
        return view
    stored = item.get('steps')
    if isinstance(stored, Mapping):
        for step in STEP_IDS:
            state = stored.get(step)
            if state in STEP_STATES:
                view['steps'][step] = state
    intro = item.get('intro')
    view['intro'] = intro if intro in INTROS else 'unseen'
    revision = item.get('revision')   # (a Decimal as DynamoDB answers it)
    number = revision if isinstance(revision, int | Decimal) and not isinstance(revision, bool) else None
    view['revision'] = int(number) if number is not None and number == int(number) and number >= 0 else 0
    view['updated_at'] = _text(item.get('updated_at'))
    view['updated_by'] = _text(item.get('updated_by'))
    return view


def setup_change(body: Mapping[str, Any]) -> tuple[int, dict[str, str], str | None]:
    """A PUT's body as ``(revision, steps, intro)``: the revision it was made from, the steps it changes (each a known
    step and state) and the intro it sets (None: unchanged). A body that changes nothing is refused."""
    if not set(body) <= _BODY_KEYS or 'revision' not in body:
        raise ValidationError(_SHAPE)
    revision = body['revision']
    if isinstance(revision, bool) or not isinstance(revision, int) or not 0 <= revision < _MAX_REVISION:
        raise ValidationError('revision is the whole number the guide read (0 for a guide never saved)')
    steps = body.get('steps', {})
    if not isinstance(steps, Mapping):
        raise ValidationError(_SHAPE)
    unknown = sorted(str(step) for step in steps if step not in STEP_IDS)
    if unknown:
        raise ValidationError(f'steps are {", ".join(STEP_IDS)}: not {", ".join(unknown)}')
    if any(state not in STEP_STATES for state in steps.values()):
        raise ValidationError(f'a step is {" | ".join(STEP_STATES)}')
    intro = body.get('intro')
    if intro is not None and intro not in INTROS[1:]:
        raise ValidationError('intro is started or skipped')
    if not steps and intro is None:
        raise ValidationError('name the steps to change or the intro to set')
    return revision, {str(step): str(state) for step, state in steps.items()}, intro


def read_setup(table: Any) -> dict[str, Any]:
    """The guide's state as last saved (consistent: a change shows at once)."""
    return setup_view(table.get_item(Key=SETUP_KEY, ConsistentRead=True).get('Item'))


def _cancelled_by_condition(exc: ClientError) -> bool:
    error = exc.response.get('Error', {})
    if error.get('Code') == 'ConditionalCheckFailedException':
        return True
    reasons = exc.response.get('CancellationReasons') or []
    return error.get('Code') == 'TransactionCanceledException' and any(
        reason.get('Code') == 'ConditionalCheckFailed' for reason in reasons)


def save_setup(table: Any, *, revision: int, steps: Mapping[str, str], intro: str | None, by: str,
               at: datetime) -> dict[str, Any]:
    """Apply a change made from ``revision`` with its history row, in one transaction; the state as saved. Raises
    ConflictError when the stored revision is no longer ``revision``."""
    current = read_setup(table)
    if current['revision'] != revision:
        raise ConflictError(CHANGED)
    when = at.astimezone(UTC).isoformat()
    name = ''.join(char for char in by if char.isprintable())[:_MAX_NAME] or NO_NAME
    merged = {**current['steps'], **steps}
    saved_intro = intro or current['intro']
    following = revision + 1
    condition: dict[str, Any] = ({'ConditionExpression': 'attribute_not_exists(pk)'} if revision == 0
                 else {'ConditionExpression': 'revision = :expected', 'ExpressionAttributeValues': {':expected': revision}})
    values = {':steps': merged, ':intro': saved_intro, ':revision': following, ':at': when, ':by': name,
              **condition.get('ExpressionAttributeValues', {})}
    change: dict[str, Any] = {'steps': dict(steps)} if steps else {}
    if intro is not None:
        change['intro'] = intro
    try:
        table.meta.client.transact_write_items(TransactItems=[
            {'Update': {'TableName': table.name, 'Key': SETUP_KEY,
                        'UpdateExpression': ('SET steps = :steps, intro = :intro, revision = :revision, '
                                             'updated_at = :at, updated_by = :by'),
                        'ConditionExpression': condition['ConditionExpression'],
                        'ExpressionAttributeValues': values}},
            {'Put': {'TableName': table.name,
                     'Item': {'pk': SETUP_KEY['pk'], 'sk': f'LOG#{when}#{secrets.token_hex(4)}', **change,
                              'revision': following, 'by': name, 'at': when},
                     'ConditionExpression': 'attribute_not_exists(sk)'}},   # (D1: create-only)
        ])
    except ClientError as exc:
        if _cancelled_by_condition(exc):
            raise ConflictError(CHANGED) from None
        raise
    return {'steps': merged, 'intro': saved_intro, 'revision': following, 'updated_at': when, 'updated_by': name}


@app.get('/agents/engineering/setup')
@tracer.capture_method
def get_engineering_setup():
    """The setup guide's progress (module doc); administrators acting for themselves, 404 while the module is off."""
    _engineering_on()
    require_admin_caller(caller_from_event(app.current_event.raw_event))
    try:
        return read_setup(_table())
    except (ClientError, BotoCoreError) as exc:
        logger.exception('engineering: the setup guide could not be read')
        raise ServiceUnavailableError('the setup guide could not be read: retry') from exc


@app.put('/agents/engineering/setup')
@tracer.capture_method
def put_engineering_setup():
    """``{revision, steps?, intro?}``: an administrator acting for themselves records steps skipped or done, or the
    first visit's choice, saved with its history row; 409 when the guide changed since the revision read."""
    _engineering_on()
    caller = caller_from_event(app.current_event.raw_event)
    require_admin_caller(caller)
    revision, steps, intro = setup_change(json_object_body(app))
    try:
        saved = save_setup(_table(), revision=revision, steps=steps, intro=intro,
                           by=caller.username or caller.subject, at=datetime.now(UTC))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('engineering: the setup guide could not be saved')
        raise ServiceUnavailableError('the setup guide could not be saved: retry') from exc
    logger.info('engineering: setup guide saved', extra={'revision': saved['revision'], 'steps': sorted(steps),
                                                         'intro': intro})
    return saved
