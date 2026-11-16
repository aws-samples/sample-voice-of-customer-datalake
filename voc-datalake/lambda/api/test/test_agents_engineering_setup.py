"""The engineering setup guide's progress (shared/agents_engineering_setup_routes.py, through api/agents_handler.py).

``GET``/``PUT /agents/engineering/setup``: one row in voc-agents with a create-only history row per change, written
in one transaction; a PUT names the revision it was made from (409 once it moved) and changes only the steps it names.
Administrators acting for themselves only (403 for a plain user and a delegated credential), 404 while the module is
off, 503 when the table fails.
"""
from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock

import pytest
from agents_handler_fixtures import USER
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call
from boto3.dynamodb.conditions import Key
from botocore.exceptions import BotoCoreError, ClientError

from shared import agents_engineering_setup_routes as setup
from shared.test.agents_fixtures import AgentsEnv

PATH = '/agents/engineering/setup'
#: An MCP credential an administrator minted: delegated, so never an administrator here.
DELEGATED_ADMIN = {'sub': 'mcp:tok_1', 'cognito:username': 'alice', 'voc:acting_subject': 'admin-sub',
                   'cognito:groups': 'admins'}
NOTHING_CHOSEN = dict.fromkeys(setup.STEP_IDS, 'pending')


def _blank_with(**steps: str) -> dict[str, Any]:
    return {'steps': {**NOTHING_CHOSEN, **steps}, 'intro': 'unseen', 'revision': 0, 'updated_at': None, 'updated_by': None}


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[AgentsEnv]:
    with _api() as agents:
        monkeypatch.setenv('ENGINEERING_AGENTS', 'on')
        monkeypatch.setenv('ENGINEERING_TABLE', 'test-engineering')
        yield agents


def _history(env: AgentsEnv) -> list[dict[str, Any]]:
    found = env.agents.query(KeyConditionExpression=Key('pk').eq(setup.SETUP_KEY['pk']) & Key('sk').begins_with('LOG#'))
    return found['Items']


@pytest.mark.usefixtures('env')
def test_a_deployment_that_never_saved_one_reads_as_nothing_chosen(lambda_context: Any) -> None:
    assert _call(lambda_context, 'GET', PATH) == (200, {
        'steps': NOTHING_CHOSEN, 'intro': 'unseen', 'revision': 0, 'updated_at': None, 'updated_by': None})


def test_a_change_saves_only_what_it_names_with_its_history_row(lambda_context: Any, env: AgentsEnv) -> None:
    status, saved = _call(lambda_context, 'PUT', PATH, body={'revision': 0, 'intro': 'started'})
    assert (status, saved['intro'], saved['revision'], saved['updated_by']) == (200, 'started', 1, 'alice')
    status, saved = _call(lambda_context, 'PUT', PATH, body={'revision': 1, 'steps': {'understand': 'skipped'}})
    assert (status, saved['steps'], saved['intro'], saved['revision']) \
        == (200, {**NOTHING_CHOSEN, 'understand': 'skipped'}, 'started', 2)
    status, saved = _call(lambda_context, 'PUT', PATH, body={'revision': 2, 'steps': {'tenets': 'skipped', 'ready': 'done'}})
    assert saved['steps'] == {**NOTHING_CHOSEN, 'understand': 'skipped', 'tenets': 'skipped', 'ready': 'done'}
    assert _call(lambda_context, 'GET', PATH) == (200, saved)
    # (D1, D4: one create-only row per change, naming who, when and only what changed)
    rows = sorted(_history(env), key=lambda row: row['revision'])
    assert [(row['revision'], row.get('intro'), row.get('steps'), row['by']) for row in rows] == [
        (1, 'started', None, 'alice'),
        (2, None, {'understand': 'skipped'}, 'alice'),
        (3, None, {'tenets': 'skipped', 'ready': 'done'}, 'alice'),
    ]
    assert all(row['at'] == row['sk'].split('#')[1] for row in rows)


def test_a_change_made_from_an_older_revision_is_refused(lambda_context: Any, env: AgentsEnv) -> None:
    assert _call(lambda_context, 'PUT', PATH, body={'revision': 0, 'steps': {'triage': 'skipped'}})[0] == 200
    status, refused = _call(lambda_context, 'PUT', PATH, body={'revision': 0, 'steps': {'triage': 'done'}})
    assert (status, refused['error']) == (409, setup.CHANGED)
    assert _call(lambda_context, 'PUT', PATH, body={'revision': 5, 'intro': 'skipped'})[0] == 409
    assert _call(lambda_context, 'GET', PATH)[1]['steps']['triage'] == 'skipped'
    assert len(_history(env)) == 1


def test_a_write_racing_another_is_a_conflict_not_an_overwrite(env: AgentsEnv) -> None:
    """Two administrators read revision 0 and save at once: the transaction's condition refuses the second."""
    at = datetime(2026, 11, 16, 12, tzinfo=UTC)
    setup.save_setup(env.agents, revision=0, steps={'triage': 'done'}, intro=None, by='alice', at=at)
    reads = MagicMock(wraps=env.agents)
    reads.get_item.return_value = {}   # (the second still sees the row it read before the first saved)
    reads.name, reads.meta = env.agents.name, env.agents.meta
    with pytest.raises(setup.ConflictError):
        setup.save_setup(reads, revision=0, steps={'triage': 'skipped'}, intro=None, by='bob', at=at)
    assert setup.read_setup(env.agents)['steps']['triage'] == 'done'


@pytest.mark.parametrize('body', [
    {}, {'steps': {'triage': 'done'}}, {'revision': '1', 'intro': 'started'}, {'revision': True, 'intro': 'started'},
    {'revision': -1, 'intro': 'started'}, {'revision': 0}, {'revision': 0, 'steps': {}},
    {'revision': 0, 'steps': {'deploy': 'done'}}, {'revision': 0, 'steps': {'triage': 'finished'}},
    {'revision': 0, 'steps': ['triage']}, {'revision': 0, 'intro': 'unseen'}, {'revision': 0, 'intro': 'later'},
    {'revision': 0, 'intro': 'started', 'more': 1},
], ids=['empty', 'no revision', 'revision text', 'revision bool', 'revision negative', 'no change', 'no steps',
        'unknown step', 'unknown state', 'steps list', 'intro unseen', 'intro unknown', 'extra key'])
def test_a_change_is_known_steps_and_states_from_a_revision(lambda_context: Any, env: AgentsEnv,
                                                          body: dict[str, Any]) -> None:
    assert _call(lambda_context, 'PUT', PATH, body=body)[0] == 400
    assert _history(env) == []


@pytest.mark.usefixtures('env')
@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN], ids=['plain user', 'MCP credential of an admin'])
def test_the_guide_is_an_administrators_alone(lambda_context: Any, claims: dict[str, Any]) -> None:
    assert _call(lambda_context, 'GET', PATH, claims=claims)[0] == 403
    assert _call(lambda_context, 'PUT', PATH, claims=claims, body={'revision': 0, 'intro': 'skipped'})[0] == 403


def test_the_guide_is_404_while_the_module_is_off(lambda_context: Any, env: AgentsEnv,
                                                  monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('ENGINEERING_AGENTS')
    assert (_call(lambda_context, 'GET', PATH)[0], _call(lambda_context, 'PUT', PATH, body={'revision': 0, 'intro': 'skipped'})[0]) \
        == (404, 404)
    monkeypatch.setenv('ENGINEERING_AGENTS', 'on')
    monkeypatch.delenv('ENGINEERING_TABLE')
    assert _call(lambda_context, 'GET', PATH)[0] == 404
    assert _history(env) == []


@pytest.mark.usefixtures('env')
@pytest.mark.parametrize('failure', [BotoCoreError(), ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'GetItem')],
                         ids=['botocore', 'client error'])
def test_a_failed_read_or_write_is_503(lambda_context: Any, monkeypatch: pytest.MonkeyPatch, failure: Exception) -> None:
    monkeypatch.setattr(setup, 'read_setup', MagicMock(side_effect=failure))
    assert _call(lambda_context, 'GET', PATH)[0] == 503
    assert _call(lambda_context, 'PUT', PATH, body={'revision': 0, 'intro': 'skipped'})[0] == 503


@pytest.mark.parametrize(('item', 'view'), [
    (None, {'steps': NOTHING_CHOSEN, 'intro': 'unseen', 'revision': 0, 'updated_at': None, 'updated_by': None}),
    ({'steps': {'triage': 'done', 'gone': 'done', 'bug_fixer': 'maybe'}, 'intro': 'later', 'revision': 3,
      'updated_at': '2026-11-16T12:00:00+00:00', 'updated_by': 'alice'},
     {'steps': {**NOTHING_CHOSEN, 'triage': 'done'}, 'intro': 'unseen', 'revision': 3,
      'updated_at': '2026-11-16T12:00:00+00:00', 'updated_by': 'alice'}),
    ({'steps': {'ready': 'done'}, 'revision': Decimal('2')}, {**_blank_with(ready='done'), 'revision': 2}),
    ({'steps': 'all', 'revision': True, 'updated_by': ''},
     {'steps': NOTHING_CHOSEN, 'intro': 'unseen', 'revision': 0, 'updated_at': None, 'updated_by': None}),
], ids=['none', 'unknown entries ignored', 'as DynamoDB answers it', 'malformed'])
def test_a_stored_row_reads_only_what_the_guide_knows(item: dict[str, Any] | None, view: dict[str, Any]) -> None:
    assert setup.setup_view(item) == view
