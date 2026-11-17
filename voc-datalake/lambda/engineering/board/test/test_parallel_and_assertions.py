"""A step's ``max_parallel`` (7.51.00: the board's launch refuses past it) and a done step's assertions, evaluated and
recorded on the board side (``ASSERT#<step>#<attempt>``, create-only) from what its tasks recorded."""
from __future__ import annotations

import copy
import json
from collections.abc import Iterator
from itertools import count
from typing import Any

import boto3
import pytest
from moto import mock_aws

from engineering.board.api import BoardApi
from engineering.board.inbox import Inbox
from engineering.board.model import Task
from engineering.board.store import BoardStore
from engineering.board.test.table import RUN, TABLE, create_table
from engineering.board.test.test_board_ops import Board, Launcher, call
from engineering.board.test.test_flow_ops import COORDINATOR, HUNTER, _finish
from engineering.board.test.test_progress_repost import Bus
from engineering.bus.publish import EventBridgePublisher
from engineering.connectors.identity import Caller
from engineering.flow.assertion_record import recorded, results
from engineering.flow.test.fixtures import TEMPLATES
from engineering.orchestration.assertions import Recorded
from engineering.rows import run_rows
from engineering.runtime.runs import RunCaps, RunStore
from shared.workflow_engineering import params_issues
from shared.workflow_schema import encode_definition

WS = 'default'
FINDINGS = f'ws/default/runs/{RUN}/hunter-2/commits/{"a" * 40}/core/attempt-1/shard-0.jsonl'


def _board(objects: dict[str, bytes]) -> Board:
    client = create_table()
    flow = copy.deepcopy(TEMPLATES['bug-hunt-and-fix'])
    board_step = next(node for node in flow['nodes'] if node['id'] == 'board')
    board_step['data']['params']['max_parallel'] = 1
    table = boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE)
    RunStore(table).start(RUN, caps=RunCaps(max_tasks=20), now=1_700_000_000, flow='wf_bugs', connection='repo-1',
                          commit='a' * 40, actor='admin-1', flow_definition=encode_definition(flow), flow_revision=1)
    ids = count(1)
    store = BoardStore(client, TABLE, new_id=lambda: f'task-{next(ids)}')
    launcher = Launcher()
    api = BoardApi(store, EventBridgePublisher(Bus(), 'voc-engineering', 'voc.engineering/board'),
                   Inbox(client, TABLE), launcher=launcher, skill=lambda role: f'{role}-skill',
                   outputs=lambda key, _limit: objects.get(key))
    return Board(client, store, api, launcher, knowledge=None)


@pytest.fixture
def bugs() -> Iterator[tuple[Board, dict[str, bytes]]]:
    objects: dict[str, bytes] = {}
    with mock_aws():
        yield _board(objects), objects


def _hunt_done(board: Board, objects: dict[str, bytes]) -> list[str]:
    """The hunt, done: its hunter posted two fixes and recorded a finding; the two fixes' ids."""
    hunt = call(board, COORDINATOR, op='post', role='hunter', flow_step='hunt', title='Hunt',
                spec={'instructions': 'Find the bugs.'})[1]['task']['task_id']
    call(board, COORDINATOR, op='launch', task_id=hunt, role='hunter', language='python')
    assert call(board, HUNTER, op='claim', task_id=hunt)[0] == 200
    assert call(board, HUNTER, op='move', task_id=hunt, epoch=1, to='in_progress')[0] == 200
    fixes = [call(board, HUNTER, op='post', role='fixer', flow_step='board', title=f'Fix {n}',
                  spec={'instructions': f'Fix bug {n}.'})[1]['task']['task_id'] for n in (1, 2)]
    objects[FINDINGS] = json.dumps({'schema': 'voc-finding/1', 'file': 'core/calc.py', 'line': 4,
                                    'evidence': 'divide uses /', 'severity': 'blocking'}).encode()
    assert call(board, HUNTER, op='move', task_id=hunt, epoch=1, to='done', result_keys=[FINDINGS])[0] == 200
    return fixes


def test_a_launch_past_the_steps_max_parallel_is_refused_until_one_ends(bugs) -> None:
    board, objects = bugs
    first, second = _hunt_done(board, objects)
    assert call(board, COORDINATOR, op='launch', task_id=first, role='fixer', language='python')[0] == 200
    status, refused = call(board, COORDINATOR, op='launch', task_id=second, role='fixer', language='python')
    assert (status, 'at most 1 agents at once' in refused['error'], len(board.launcher.requests)) == (409, True, 2)
    _finish(board, first, 'fixer-3', Caller('fixer', RUN, 3))
    assert call(board, COORDINATOR, op='launch', task_id=second, role='fixer', language='python')[0] == 200


def test_a_done_steps_assertions_are_recorded_once_at_its_attempt(bugs) -> None:
    board, objects = bugs
    _hunt_done(board, objects)
    assert call(board, COORDINATOR, op='flow')[0] == 200
    call(board, COORDINATOR, op='flow')   # (read again: recorded once)
    rows = run_rows(board.client, TABLE, WS, RUN, 'ASSERT#')
    assert [(row['sk']['S'], row['by']['S']) for row in rows] == [('ASSERT#hunt#1', 'coordinator-1')]
    assert [(item['check'], item['status']) for item in json.loads(rows[0]['results']['S'])] == [
        ('findings.cite_evidence', 'pass'), ('tasks.posted', 'pass')]


def test_a_tenets_draft_the_step_recorded_is_read_for_tenets_recorded() -> None:
    # (7.52.00: the Tenets flow's draft step; its understander's write_tenets key, recorded on the task)
    key = f'ws/default/runs/{RUN}/understander-1/commits/{"a" * 40}/_tenets/attempt-1/tenets.json'
    draft = {'schema': 'voc-tenets/1', 'summary': '', 'tenets': [
        {'id': 'T1', 'title': 'Fail closed', 'statement': 'A check that cannot run refuses.', 'rationale': '',
         'citations': []}]}
    task = Task(task_id='task-1', role='understander', state='done', title='Draft', spec='{}', spec_hash='', depth=0,
                priority=0, attempt=1, result_keys=(key,), launched_agent='understander-1', flow_step='draft')
    seen = recorded('draft', [task], lambda wanted, _limit: json.dumps(draft).encode() if wanted == key else None, [],
                    issue=None, pr_setting='ready')
    assert results([{'check': 'tenets.recorded'}], seen) == [
        {'check': 'tenets.recorded', 'status': 'pass', 'detail': '1 tenet(s) drafted', 'on_fail': 'block'}]


def test_a_check_whose_input_the_board_does_not_keep_is_recorded_unread() -> None:
    listed = results([{'check': 'pr.links_issue'}, {'check': 'patch.submitted'}], Recorded())
    assert [(item['check'], item['status']) for item in listed] == [('pr.links_issue', 'unread'),
                                                                    ('patch.submitted', 'fail')]


@pytest.mark.parametrize(('node_type', 'value', 'ok'), [
    ('board', 1, True), ('quality_gate', 50, True), ('agent', 3, True),
    ('board', 0, False), ('board', 51, False), ('board', True, False), ('map', 2, False),
])
def test_max_parallel_is_a_whole_number_on_a_step_that_takes_several_tasks(node_type: str, value: Any, ok: bool):
    params: dict[str, Any] = {'max_parallel': value}
    if node_type == 'board':
        params |= {'posters': ['hunter'], 'claimers': ['fixer']}
    elif node_type == 'agent':
        params['role'] = 'fixer'
    elif node_type == 'map':
        params |= {'shard_by': 'packages', 'shard_cap': 5}
    issues = [issue for issue in params_issues(node_type, params) if 'max_parallel' in issue]
    assert (issues == []) is ok
