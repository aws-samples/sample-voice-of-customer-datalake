"""The run workspace's routes (7.51.00, shared/agents_engineering_run_routes.py, included by agents_handler.py), and
the shared fixture the web app builds against (frontend/src/test/engineeringRunWorkspace.json).

Administrators acting for themselves only (403 for a plain user and a delegated credential), 404 while the module is
off, for an unknown run and for an agent not in the run; the steering goes to the run's conductor and is recorded as
the person's; a restart of an ended run is the start function's ``restart_run``, refused while the run is live.
"""
from __future__ import annotations

import json
import os
from typing import Any
from unittest.mock import patch

import pytest
from agents_handler_fixtures import ADMIN, USER
from agents_handler_fixtures import call as _call
from engineering_run_workspace_fixture import CHILD_ID, FIXTURE, Bus, Lambdas, answers, reached

from engineering.test import run_workspace_world as world
from engineering.thread_items import is_thread_item

BASE = f'/agents/engineering/{world.RUN}'
FIXER = f'{BASE}/agents/{world.FIXER}'
DELEGATED_ADMIN = {'sub': 'mcp:tok_1', 'cognito:username': 'alice', 'voc:acting_subject': 'admin-sub',
                   'cognito:groups': 'admins'}
READS = ('/agents/engineering/runs', f'{FIXER}/thread', f'{FIXER}/thread/c5', f'{FIXER}/changes',
         f'{FIXER}/changes/file', f'{FIXER}/files', f'{FIXER}/gate', f'{FIXER}/memory', f'{BASE}/assertions')
ACTIONS = (f'{BASE}/steer', f'{BASE}/restart')


api = pytest.fixture(reached, name='api')


@pytest.mark.usefixtures('api')
def test_the_shared_fixture_holds_the_servers_answers() -> None:
    found = json.loads(json.dumps(answers()))
    if os.environ.get('REWRITE_RUN_WORKSPACE_FIXTURE') == '1':
        FIXTURE.write_text(json.dumps(found, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
    assert json.loads(FIXTURE.read_text(encoding='utf-8')) == found, (
        'rewrite it: REWRITE_RUN_WORKSPACE_FIXTURE=1 .venv/bin/python -m pytest --no-cov '
        'lambda/api/test/test_engineering_run_workspace.py -k shared_fixture (from voc-datalake), and read the diff')


def test_every_thread_item_of_the_fixture_has_the_thread_items_shape() -> None:
    fixture = json.loads(FIXTURE.read_text(encoding='utf-8'))
    pages = [fixture[name]['answer'] for name in ('thread', 'thread_next', 'thread_tail')]
    items = [item for page in pages for item in page['items']]
    assert items
    assert all(is_thread_item(item) for item in items)
    statuses = {fixture[name]['status'] for name in fixture if isinstance(fixture[name], dict)}
    assert statuses == {200, 202}


@pytest.mark.usefixtures('api')
@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN], ids=['plain user', 'MCP credential of an admin'])
def test_every_route_is_403_for_anyone_but_an_administrator(lambda_context: Any, claims: dict[str, Any]) -> None:
    reads = [_call(lambda_context, 'GET', path, claims=claims)[0] for path in READS]
    actions = [_call(lambda_context, 'POST', path, claims=claims, body={})[0] for path in ACTIONS]
    assert reads + actions == [403] * (len(READS) + len(ACTIONS))


@pytest.mark.usefixtures('api')
@pytest.mark.parametrize('missing', ['ENGINEERING_AGENTS', 'ENGINEERING_TABLE', 'ENGINEERING_WORKSPACE_BUCKET'])
def test_every_route_is_404_while_the_module_is_off(lambda_context: Any, missing: str) -> None:
    with patch.dict(os.environ, {missing: ''}):
        for claims in (ADMIN, USER):   # (the 404 first: a non-admin learns nothing either)
            assert [_call(lambda_context, 'GET', path, claims=claims)[0] for path in READS] == [404] * len(READS)
            assert [_call(lambda_context, 'POST', path, claims=claims, body={})[0] for path in ACTIONS] == [404, 404]


@pytest.mark.usefixtures('api')
@pytest.mark.parametrize('path', [
    '/agents/engineering/01JD0000000000000000000009/agents/fixer-3/thread',   # (no such run)
    f'{BASE}/agents/fixer-9/thread', f'{BASE}/agents/fixer-9/changes',          # (no such agent)
    f'{BASE}/agents/bad%20id/files', '/agents/engineering/01JD0000000000000000000009/assertions',
    f'{FIXER}/thread/2.9.0', f'{FIXER}/thread/c3',   # (no such event; a message not about this agent)
    f'{FIXER}/thread/nonsense',
])
def test_what_is_not_there_is_404(lambda_context: Any, path: str) -> None:
    assert _call(lambda_context, 'GET', path)[0] == 404


@pytest.mark.usefixtures('api')
@pytest.mark.parametrize(('path', 'query'), [
    ('/agents/engineering/runs', {'month': '2026-13'}), ('/agents/engineering/runs', {'status': 'running'}),
    ('/agents/engineering/runs', {'flow': 'a b'}), ('/agents/engineering/runs', {'cursor': 'bm9wZQ'}),
    (f'{FIXER}/thread', {'after': 'not-a-cursor'}), (f'{FIXER}/changes', {'source': 'branch'}),
    (f'{FIXER}/changes', {'attempt': '0'}), (f'{FIXER}/changes/file', {'key': world.SUBMITTED_KEY}),
])
def test_a_query_off_its_rule_is_400(lambda_context: Any, path: str, query: dict[str, str]) -> None:
    assert _call(lambda_context, 'GET', path, query=query)[0] == 400


@pytest.mark.usefixtures('api')
def test_the_runs_list_filters_by_status_and_pages(lambda_context: Any) -> None:
    status, ended = _call(lambda_context, 'GET', '/agents/engineering/runs',
                          query={'month': world.MONTH, 'status': 'stopped'})
    assert (status, [run['run_id'] for run in ended['runs']]) == (200, [world.ENDED_RUN])
    status, first = _call(lambda_context, 'GET', '/agents/engineering/runs', query={'month': world.MONTH, 'limit': '1'})
    assert (status, [run['run_id'] for run in first['runs']]) == (200, [world.RUN])
    status, second = _call(lambda_context, 'GET', '/agents/engineering/runs',
                           query={'month': world.MONTH, 'limit': '1', 'cursor': first['next']})
    assert (status, [run['run_id'] for run in second['runs']]) == (200, [world.CHILD_RUN])
    # (a cursor of another month's list is refused)
    assert _call(lambda_context, 'GET', '/agents/engineering/runs',
                 query={'month': '2026-10', 'cursor': first['next']})[0] == 400


@pytest.mark.usefixtures('api')
def test_a_file_the_patch_does_not_hold_or_a_patch_of_another_agent_is_404(lambda_context: Any) -> None:
    assert _call(lambda_context, 'GET', f'{FIXER}/changes/file',
                 query={'key': world.SUBMITTED_KEY, 'path': 'src/nothing.py'})[0] == 404
    other = world.SUBMITTED_KEY.replace(world.FIXER, 'fixer-9')
    assert _call(lambda_context, 'GET', f'{FIXER}/changes/file', query={'key': other, 'path': 'src/paging.py'})[0] == 404


def test_steering_goes_to_the_conductor_as_the_person(lambda_context: Any, api: tuple[Any, Bus, Lambdas]) -> None:
    _, bus, _ = api
    status, answer = _call(lambda_context, 'POST', f'{BASE}/steer', body={'text': ' Skip the docs. ', 'about': 'fixer-3'})
    assert status == 202
    [entry] = bus.entries
    sent = json.loads(entry['Detail'])
    assert (entry['Source'], sent['type'], sent['from'], sent['to'], sent['summary']) == (
        'voc.engineering/api', 'msg.steer', {'kind': 'human', 'id': 'admin-sub'}, {'kind': 'conductor', 'id': world.RUN},
        'About fixer-3: Skip the docs.')
    assert answer['message']['thread_id'] == sent['thread_id']


@pytest.mark.usefixtures('api')
@pytest.mark.parametrize(('body', 'status'), [
    ({}, 400), ({'text': '  '}, 400), ({'text': 'x' * 1025}, 400), ({'text': 'Hi', 'about': 'fixer-9'}, 404),
    ({'text': 'Hi', 'to': 'fixer-3'}, 400), ({'text': 'the key is AKIA' + 'ABCDEFGHIJKLMNOP'}, 400),
])
def test_steering_off_its_rule_is_refused_and_nothing_is_sent(lambda_context: Any, api: tuple[Any, Bus, Lambdas],
                                                              body: dict[str, Any], status: int) -> None:
    assert _call(lambda_context, 'POST', f'{BASE}/steer', body=body)[0] == status
    assert api[1].entries == []


@pytest.mark.usefixtures('api')
def test_steering_without_the_bus_is_503(lambda_context: Any) -> None:
    with patch.dict(os.environ, {'ENGINEERING_BUS_NAME': ''}):
        assert _call(lambda_context, 'POST', f'{BASE}/steer', body={'text': 'Hi'})[0] == 503


def test_an_ended_run_restarts_as_a_child_through_the_start_function(lambda_context: Any,
                                                                     api: tuple[Any, Bus, Lambdas]) -> None:
    _, _, lambdas = api
    status, answer = _call(lambda_context, 'POST', f'/agents/engineering/{world.ENDED_RUN}/restart',
                           body={'mode': 'restart', 'base': 'head', 'confirm': True})
    assert (status, answer) == (202, {'run': {'run_id': CHILD_ID, 'parent_run_id': world.ENDED_RUN, 'status': 'active'}})
    assert lambdas.requests == [{'action': 'restart_run', 'run_id': world.ENDED_RUN, 'child_run_id': CHILD_ID,
                                 'mode': 'restart', 'base': 'head', 'actor': 'admin-sub'}]


def test_a_restart_may_name_one_model_for_every_role_of_its_child(lambda_context: Any,
                                                                  api: tuple[Any, Bus, Lambdas]) -> None:
    # (Q18) Kiro's refusal asks for another model: the Restart takes it, as Run now does; null keeps the parent's.
    _, _, lambdas = api
    body = {'mode': 'resume', 'base': 'same', 'model': 'haiku', 'confirm': True}
    assert _call(lambda_context, 'POST', f'/agents/engineering/{world.ENDED_RUN}/restart', body=body)[0] == 202
    assert lambdas.requests[-1]['model_choice'] == 'haiku'
    kept = {**body, 'model': None}
    assert _call(lambda_context, 'POST', f'/agents/engineering/{world.ENDED_RUN}/restart', body=kept)[0] == 202
    assert 'model_choice' not in lambdas.requests[-1]


@pytest.mark.usefixtures('api')
@pytest.mark.parametrize(('run', 'body', 'status'), [
    (world.RUN, {'mode': 'resume', 'base': 'same', 'confirm': True}, 409),   # (live: the signals restart its agents)
    (world.ENDED_RUN, {'mode': 'resume', 'base': 'same'}, 400),             # (no confirm)
    (world.ENDED_RUN, {'mode': 'rerun', 'base': 'same', 'confirm': True}, 400),
    (world.ENDED_RUN, {'mode': 'resume', 'base': 'tip', 'confirm': True}, 400),
    (world.ENDED_RUN, {'mode': 'resume', 'agents': ['fixer-9'], 'confirm': True}, 400),   # (not its agent)
    (world.ENDED_RUN, {'mode': 'resume', 'agents': [], 'confirm': True}, 400),
    (world.ENDED_RUN, {'mode': 'resume', 'model': 'not a model', 'confirm': True}, 400),
    (world.ENDED_RUN, {'mode': 'resume', 'model': 'global.anthropic.claude-opus-5', 'confirm': True}, 400),   # (unpriced)
    ('01JD0000000000000000000009', {'mode': 'resume', 'confirm': True}, 404),
])
def test_a_restart_off_its_rule_or_of_a_live_run_is_refused(lambda_context: Any, api: tuple[Any, Bus, Lambdas],
                                                            run: str, body: dict[str, Any], status: int) -> None:
    assert _call(lambda_context, 'POST', f'/agents/engineering/{run}/restart', body=body)[0] == status
    assert api[2].requests == []


def test_a_restart_whose_answer_is_lost_names_the_child_to_open(lambda_context: Any,
                                                                api: tuple[Any, Bus, Lambdas]) -> None:
    from botocore.exceptions import ReadTimeoutError

    with patch.object(api[2], 'invoke', side_effect=ReadTimeoutError(endpoint_url='x')):
        status, answer = _call(lambda_context, 'POST', f'/agents/engineering/{world.ENDED_RUN}/restart',
                               body={'mode': 'resume', 'confirm': True})
    assert (status, answer['run_id']) == (503, CHILD_ID)


def test_a_restart_signal_goes_through_the_start_function_with_where_it_starts(lambda_context: Any,
                                                                               api: tuple[Any, Bus, Lambdas]) -> None:
    _, bus, lambdas = api
    status, answer = _call(lambda_context, 'POST', f'{BASE}/signals', body={
        'signal': 'restart', 'from': 'fresh', 'task_id': world.FIX_TASK, 'attempt': 2, 'confirm': True})
    assert (status, answer['signal']['status']) == (200, 'sent')
    # (voc-engineering-start's signal_run records who asked on the run's RUNLOG# rows and hands it on: 7.51.02)
    assert lambdas.requests == [{'action': 'signal_run', 'run_id': world.RUN, 'signal': 'restart',
                                 'actor': 'admin-sub', 'agent_id': world.FIXER, 'task_id': world.FIX_TASK, 'attempt': 2,
                                 'restart_from': 'fresh'}]
    assert bus.entries == []   # (nothing on the bus: the API's source says only steering and answers)


def test_an_answer_to_an_agent_goes_only_on_its_own_questions_thread(lambda_context: Any,
                                                                     api: tuple[Any, Bus, Lambdas]) -> None:
    path = f'{BASE}/messages'
    assert _call(lambda_context, 'POST', path, body={'to': 'agent', 'agent': world.FIXER, 'text': 'Yes',
                                                     'thread_id': 'q-fixer-3-1'})[0] == 200
    assert _call(lambda_context, 'POST', path, body={'to': 'agent', 'agent': world.FIXER, 'text': 'Yes',
                                                     'thread_id': 'steer-1'})[0] == 404
    assert _call(lambda_context, 'POST', path, body={'to': 'agent', 'agent': world.FIXER, 'text': 'Yes'})[0] == 400
    assert len(api[1].entries) == 1
