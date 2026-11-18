"""MCP for runs (7.53.00) at the Agents API: the routes the global MCP server's engineering tools reach, with the claims
that server sends (``voc:mcp_engineering`` = one operation, an ``mcp:`` subject acting for the minter, no group), on the
run workspace's world (engineering/test/run_workspace_world.py).

* each route admits the delegated call for its OWN operation only (runs list, overview, retrospective, steering), never
  for another's, never with the ``agents_run`` claim, never without the claim, never for an ``agent:`` principal;
* the signals, go, restart, Stop, answers, board actions and every other engineering route refuse it whatever
  operation it carries;
* its steering is the minter's ``msg.steer`` to the run's conductor, marked as sent over MCP, and logged with ``via``;
* the retrospective (also an administrator's) is Learn's record of the run: failures, scorecards, lessons, the coach.
"""
from __future__ import annotations

import json
import os
from typing import Any
from unittest.mock import patch

import pytest
from agents_handler_fixtures import ADMIN
from agents_handler_fixtures import call as _call
from engineering_run_workspace_fixture import Bus, Lambdas, reached

from engineering.learning.loop import CHOSEN_SK
from engineering.test import run_workspace_world as world
from shared.agents_engineering_run_routes import CROSS_RUN_UNAVAILABLE, MCP_STEER_MARK
from shared.project_access import MCP_ENGINEERING_OPS

BASE = f'/agents/engineering/{world.RUN}'
#: Each operation's route, as its tool calls it.
OWN: dict[str, tuple[str, str, Any]] = {
    'runs_list': ('GET', '/agents/engineering/runs', None),
    'run_get': ('GET', BASE, None),
    'run_analysis': ('GET', f'{BASE}/retrospective', None),
    'run_steer': ('POST', f'{BASE}/steer', {'text': 'Try ops.py first'}),
}
#: The engineering routes no tool reaches: each refuses every delegated call (403).
NEVER: tuple[tuple[str, str, Any], ...] = (
    ('POST', f'{BASE}/signals', {'signal': 'pause'}),
    ('POST', f'{BASE}/go', {}),
    ('POST', f'{BASE}/stop', {}),
    ('POST', f'{BASE}/messages', {'to': 'conductor', 'text': 'x'}),
    ('POST', f'{BASE}/restart', {'mode': 'resume', 'base': 'same', 'confirm': True}),
    ('POST', f'{BASE}/reactions', {}),
    ('POST', f'{BASE}/board/tasks', {'role': 'fixer', 'title': 't', 'spec': {}}),
    ('GET', f'{BASE}/board', None),
    ('GET', f'{BASE}/conversation', None),
    ('GET', f'{BASE}/reports', None),
    ('GET', f'{BASE}/assertions', None),
    ('GET', f'{BASE}/agents/{world.FIXER}/thread', None),
    ('GET', f'{BASE}/agents/{world.FIXER}/changes', None),
    ('GET', '/agents/engineering/connections', None),
    ('GET', '/agents/engineering/settings', None),
    ('PUT', '/agents/engineering/settings', {'hard_cap': False}),
    ('GET', '/agents/engineering/spend', None),
)


def mcp(op: str | None, **extra: str) -> dict[str, str]:
    """The claims the global MCP server sends for an engineering tool of ``op`` (none: a plain delegated call)."""
    claims = {'sub': 'mcp:tok_1', 'cognito:groups': '', 'email': 'mcp:tok_1', 'voc:acting_subject': 'admin-sub',
              **extra}
    if op is not None:
        claims['voc:mcp_engineering'] = op
    return claims


api = pytest.fixture(reached, name='api')


@pytest.mark.usefixtures('api')
@pytest.mark.parametrize('op', sorted(OWN))
def test_each_route_admits_the_mcp_tool_of_its_own_operation_only(lambda_context: Any, op: str) -> None:
    method, path, body = OWN[op]
    status, answer = _call(lambda_context, method, path, claims=mcp(op), body=body)
    assert status in (200, 202), answer
    for other in sorted(MCP_ENGINEERING_OPS - {op}):
        assert _call(lambda_context, method, path, claims=mcp(other), body=body)[0] == 403, other
    for claims in (mcp(None), mcp(None, **{'voc:mcp_agent_run': 'true'}), mcp(op, sub='agent:ag_1'),
                   mcp(op, **{'voc:acting_subject': ''}), mcp(op, **{'voc:acting_subject': 'mcp:tok_2'}),
                   mcp(f' {op}x')):
        assert _call(lambda_context, method, path, claims=claims, body=body)[0] == 403, claims


@pytest.mark.usefixtures('api')
@pytest.mark.parametrize(('method', 'path', 'body'), NEVER, ids=[f'{m} {p}' for m, p, _ in NEVER])
def test_no_signal_go_restart_stop_answer_or_other_route_is_reachable(lambda_context: Any, method: str, path: str,
                                                                    body: Any) -> None:
    for op in sorted(MCP_ENGINEERING_OPS):
        status, answer = _call(lambda_context, method, path, claims=mcp(op), body=body)
        assert status == 403, (op, answer)


def test_the_steering_is_the_minters_to_the_conductor_marked_as_sent_over_mcp(lambda_context: Any,
                                                                            api: tuple[Any, Bus, Lambdas]) -> None:
    _, bus, _ = api
    with patch('shared.agents_engineering_run_routes.logger') as logged:
        status, answer = _call(lambda_context, 'POST', f'{BASE}/steer', claims=mcp('run_steer'),
                               body={'text': '  Try ops.py first ', 'about': world.FIXER})
    assert status == 202, answer
    (entry,) = bus.entries
    sent = json.loads(entry['Detail'])
    assert (sent['type'], sent['from'], sent['to']) == ('msg.steer', {'kind': 'human', 'id': 'admin-sub'},
                                                        {'kind': 'conductor', 'id': world.RUN})
    assert sent['summary'] == f'About {world.FIXER}: {MCP_STEER_MARK}Try ops.py first'
    logged.info.assert_called_once_with('engineering: steering sent over MCP', extra={
        'run_id': world.RUN, 'via': 'mcp:tok_1', 'by': 'admin-sub', 'event_id': answer['message']['event_id']})


def test_an_administrators_steering_carries_no_mark(lambda_context: Any, api: tuple[Any, Bus, Lambdas]) -> None:
    _, bus, _ = api
    assert _call(lambda_context, 'POST', f'{BASE}/steer', claims=ADMIN, body={'text': 'Try ops.py'})[0] == 202
    assert json.loads(bus.entries[0]['Detail'])['summary'] == 'Try ops.py'


@pytest.mark.usefixtures('api')
def test_the_mark_counts_in_the_steerings_one_kilobyte(lambda_context: Any) -> None:
    text = 'x' * (1024 - len(MCP_STEER_MARK) + 1)
    assert _call(lambda_context, 'POST', f'{BASE}/steer', claims=ADMIN, body={'text': text})[0] == 202
    status, answer = _call(lambda_context, 'POST', f'{BASE}/steer', claims=mcp('run_steer'), body={'text': text})
    assert (status, 'at most 1024 bytes' in answer['error']) == (400, True)


@pytest.mark.usefixtures('api')
def test_the_retrospective_carries_the_newest_cross_run_record_of_its_flow_labelled(lambda_context: Any) -> None:
    import boto3

    from engineering.learning import cross_run
    s3 = boto3.client('s3', region_name='us-east-1')
    for week, convergence in (('2026-W45', 'older'), ('2026-W46', 'the fixes converge')):
        s3.put_object(Bucket=world.BUCKET, Key=cross_run.record_key(world.FLOW, week), Body=json.dumps({
            'schema': 'voc-cross-run/1', 'flow': world.FLOW, 'week': week, 'convergence': {'done_rate': 0.5},
            'failures': [{'index': n, 'role': 'fixer', 'kind': 'stalled'} for n in range(30)],
            'analysis': {'label': cross_run.MODEL_LABEL, 'convergence': convergence}}).encode())
    status, answer = _call(lambda_context, 'GET', f'{BASE}/retrospective', claims=mcp('run_analysis'))
    assert status == 200, answer
    summary = answer['cross_run']
    assert (summary['available'], summary['week'], summary['label']) == (True, '2026-W46', cross_run.MODEL_LABEL)
    assert (summary['analysis']['convergence'], len(summary['failures'])) == ('the fixes converge', 20)
    # (a run that follows no flow has none)
    assert CROSS_RUN_UNAVAILABLE == {'available': False, 'reason': 'the run follows no flow'}


@pytest.mark.usefixtures('api')
def test_the_retrospective_is_learns_record_of_the_run(lambda_context: Any) -> None:
    status, answer = _call(lambda_context, 'GET', f'{BASE}/retrospective', claims=ADMIN)
    assert status == 200, answer
    assert (answer['run_id'], answer['status'], answer['ended']) == (world.RUN, 'active', False)
    # (the run follows a flow with no weekly cross-run record yet)
    assert answer['cross_run'] == {'available': False, 'reason': 'no cross-run Learn record of this flow yet'}
    assert answer['coached'] is None   # (Learn has not chosen: the run is live)
    assert answer['learned'] == [{'key': f'{world.FIX_TASK}#1#stalled', 'lesson': (
        'A fixer that stalls on paging: read the helper before the tests.'), 'coach': 'proposed',
        'proposed_version': 4, 'memory_id': 'mem-paging-1', 'at': world.at(40)}]
    assert {line['role'] for line in answer['scorecards']} >= {'fixer'}
    assert all(set(line) == {'role', 'version', 'tasks_done', 'tasks_failed', 'needs_human', 'reposts',
                             'review_rounds', 'attempts', 'cost_usd', 'seconds'} for line in answer['scorecards'])
    assert answer['failure_count'] == len(answer['failures'])
    assert all(set(failure) == {'key', 'task_id', 'attempt', 'role', 'agent', 'version', 'how', 'reason'}
               for failure in answer['failures'])


def test_the_retrospective_names_the_failures_learn_took_to_the_coach(lambda_context: Any,
                                                                     api: tuple[Any, Bus, Lambdas]) -> None:
    built, _, _ = api
    built.client.put_item(TableName=world.TABLE, Item={
        'pk': {'S': f'WS#default#RUN#{world.ENDED_RUN}'}, 'sk': {'S': CHOSEN_SK},
        'keys': {'L': [{'S': 'task-x#1#failed'}]}})
    status, answer = _call(lambda_context, 'GET', f'/agents/engineering/{world.ENDED_RUN}/retrospective',
                           claims=mcp('run_analysis'))
    assert status == 200, answer
    assert (answer['status'], answer['ended'], answer['coached'], answer['learned']) == (
        'stopped', True, ['task-x#1#failed'], [])


@pytest.mark.usefixtures('api')
def test_the_retrospective_of_an_unknown_run_or_off_module_is_404(lambda_context: Any) -> None:
    assert _call(lambda_context, 'GET', '/agents/engineering/01JDZZZZZZZZZZZZZZZZZZZZZZ/retrospective',
                 claims=ADMIN)[0] == 404
    assert _call(lambda_context, 'GET', '/agents/engineering/a.b/retrospective', claims=ADMIN)[0] == 404
    # (inside the api fixture's own patch of the environment: a monkeypatch torn down after it would put the module's
    # 'on' back into os.environ, which every later test of the worker then reads)
    with patch.dict(os.environ, {'ENGINEERING_AGENTS': 'off'}):
        assert _call(lambda_context, 'GET', f'{BASE}/retrospective', claims=mcp('run_analysis'))[0] == 404
