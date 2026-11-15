"""The board in a run that follows its flow: the coordinator reads the conductor's plan (``flow``) and records its own
steps (``step``), and the board takes a post or a launch only for a live step, for the roles it takes, from the
posters it allows. A run started without a flow is as before."""
from __future__ import annotations

import json
from collections.abc import Iterator
from itertools import count
from typing import Any

import boto3
import pytest
from moto import mock_aws

from engineering.board.api import BoardApi, person_request
from engineering.board.flow_guard import NO_FLOW, FlowGuard
from engineering.board.inbox import Inbox
from engineering.board.store import BoardError, BoardStore, slot_sk
from engineering.board.test.table import RUN, TABLE, create_table
from engineering.board.test.test_board_ops import Board, Launcher, call
from engineering.board.test.test_progress_repost import Bus
from engineering.bus.publish import EventBridgePublisher
from engineering.connectors.identity import Caller
from engineering.connectors.test.test_records import checked_record, gate_record
from engineering.flow.record import FLOW_SK
from engineering.flow.test.fixtures import TEMPLATES
from engineering.quality_gate.record import GateRecord
from engineering.rows import run_pk, run_rows
from engineering.runtime.runs import RunCaps, RunStore
from shared.workflow_schema import encode_definition

WS = 'default'
COORDINATOR = Caller('coordinator', RUN, 1)
HUNTER = Caller('hunter', RUN, 2)
FIXER = Caller('fixer', RUN, 3)
SPEC = {'instructions': 'Find the paging bug.', 'paths': ['core']}


def _board(template: str | None, max_tasks: int = 20, gate_records: Any = None) -> Board:
    client = create_table()
    table = boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE)
    RunStore(table).start(RUN, caps=RunCaps(max_tasks=max_tasks), now=1_700_000_000, flow='wf_bugs',
                          connection='repo-1', commit='a' * 40, actor='admin-1',
                          flow_definition=encode_definition(TEMPLATES[template]) if template else '',
                          flow_revision=3 if template else 0)
    ids = count(1)
    store = BoardStore(client, TABLE, new_id=lambda: f'task-{next(ids)}')
    launcher = Launcher()
    api = BoardApi(store, EventBridgePublisher(Bus(), 'voc-engineering', 'voc.engineering/board'),
                   Inbox(client, TABLE), launcher=launcher, skill=lambda role: f'{role}-skill',
                   gate_records=gate_records)
    return Board(client, store, api, launcher, knowledge=None)


@pytest.fixture
def bugs() -> Iterator[Board]:
    with mock_aws():
        yield _board('bug-hunt-and-fix')


def post(board: Board, caller: Caller = COORDINATOR, **body: Any) -> tuple[int, dict[str, Any]]:
    return call(board, caller, op='post', **{'title': 'Hunt the paging bug', 'spec': SPEC, **body})


def steps(answer: dict[str, Any]) -> dict[str, str]:
    return {item['step']: item['status'] for item in answer['flow']['steps']}


def test_the_coordinator_reads_its_flows_plan_and_nobody_else_does(bugs: Board) -> None:
    status, answer = call(bugs, COORDINATOR, op='flow')
    assert (status, answer['flow']['outcome']) == (200, 'running')
    assert steps(answer) == {'start': 'done', 'hunt': 'ready', 'board': 'collecting', 'gate': 'waiting',
                             'commit': 'waiting', 'pr_author': 'waiting', 'pr': 'waiting', 'human': 'waiting'}
    assert call(bugs, FIXER, op='flow')[0] == 403
    assert call(bugs, FIXER, op='step', step='board', action='complete')[0] == 403


def test_a_post_names_a_live_step_for_a_role_it_takes_and_the_task_records_it(bugs: Board) -> None:
    assert post(bugs, role='hunter')[0] == 400   # (no step: in a run that follows a flow, every post names one)
    status, body = post(bugs, role='fixer', flow_step='gate')
    assert (status, 'waiting' in body['error']) == (409, True)
    assert post(bugs, role='fixer', flow_step='hunt')[0] == 403
    assert post(bugs, role='hunter', flow_step='nope')[0] == 400
    status, body = post(bugs, role='hunter', flow_step='hunt')
    assert (status, body['task']['flow_step'], body['task']['shard']) == (200, 'hunt', None)
    # A retry of the same post is answered as it is; other work for the step while its task is under way is not.
    again = post(bugs, role='hunter', flow_step='hunt')
    assert (again[0], again[1]['duplicate'], again[1]['task']['task_id']) == (200, True, body['task']['task_id'])
    status, refused = post(bugs, role='hunter', flow_step='hunt', title='Hunt another bug',
                           spec={'instructions': 'Hunt another bug.'})
    assert (status, refused['error']) == (409, 'step hunt has its task under way')
    listed = call(bugs, COORDINATOR, op='tasks')[1]['tasks']
    assert [(task['flow_step'], task['shard']) for task in listed if task['task_id'] != 'coordinate'] == [
        ('hunt', None)]


def test_the_hunter_posts_its_fixes_on_the_board_while_it_hunts_within_who_posts_for_whom(bugs: Board) -> None:
    fix = {'title': 'Fix the paging bug', 'spec': {'instructions': 'Fix it.'}}
    status, body = call(bugs, HUNTER, op='post', role='fixer', flow_step='board', **fix)
    assert (status, body['task']['flow_step']) == (200, 'board')
    # The board takes the understander's tasks, but the hunter posts only fixes (board/api.py POSTERS).
    assert call(bugs, HUNTER, op='post', role='understander', flow_step='board', **fix)[0] == 403
    # Only on a board that names it a poster: never for an agent step.
    assert call(bugs, HUNTER, op='post', role='fixer', flow_step='hunt', **fix)[0] == 403


def test_a_launch_is_only_for_a_task_of_a_live_step(bugs: Board) -> None:
    hunt = post(bugs, role='hunter', flow_step='hunt')[1]['task']['task_id']
    status, answer = call(bugs, COORDINATOR, op='launch', task_id=hunt, role='hunter', language='python')
    assert (status, answer['agent_id']) == (200, 'hunter-2')
    fix = call(bugs, HUNTER, op='post', role='fixer', flow_step='board', title='Fix it',
               spec={'instructions': 'Fix it.'})[1]['task']['task_id']
    # A person blocks the hunt: the run waits at it for them, and the board, no longer collecting, launches nothing.
    person_request(bugs.store, {'op': 'act', 'run_id': RUN, 'subject': 'admin-1', 'task_id': hunt, 'action': 'block',
                                'body': {'reason': 'not this one'}})
    status, refused = call(bugs, COORDINATOR, op='launch', task_id=fix, role='fixer', language='python')
    assert (status, 'is waiting' in refused['error'], len(bugs.launcher.requests)) == (409, True, 1)
    assert call(bugs, COORDINATOR, op='flow')[1]['flow']['at'] == 'hunt'
    # The coordinate task is refused by the store, as in any run (its coordinator comes from the run).
    assert call(bugs, COORDINATOR, op='launch', task_id='coordinate', role='hunter', language='python')[0] == 400


def _finish(board: Board, task_id: str, agent: str, caller: Caller) -> None:
    """The agent launched for the task claims it and moves it to done."""
    assert call(board, caller, op='claim', task_id=task_id)[1]['task']['lease']['agent'] == agent
    for state in ('in_progress', 'done'):
        assert call(board, caller, op='move', task_id=task_id, epoch=1, to=state)[0] == 200


def test_the_coordinator_closes_a_board_only_once_its_turn_has_come_and_nothing_is_under_way(bugs: Board) -> None:
    status, refused = call(bugs, COORDINATOR, op='step', step='board', action='complete')
    assert (status, 'collecting' in refused['error']) == (409, True)
    hunt = post(bugs, role='hunter', flow_step='hunt')[1]['task']['task_id']
    call(bugs, COORDINATOR, op='launch', task_id=hunt, role='hunter', language='python')
    _finish(bugs, hunt, 'hunter-2', HUNTER)
    status, answer = call(bugs, COORDINATOR, op='step', step='board', action='complete')
    assert (status, answer['recorded'], steps(answer)['board'], steps(answer)['gate']) == (200, True, 'done', 'ready')
    row = next(r for r in run_rows(bugs.client, TABLE, WS, RUN, 'STEP#'))
    assert (row['record']['S'], row['by']['S'], row['step']['S']) == ('done', 'coordinator-1', 'board')
    assert call(bugs, COORDINATOR, op='step', step='hunt', action='complete')[0] == 409
    assert call(bugs, COORDINATOR, op='step', step='board', action='close')[0] == 400
    assert call(bugs, COORDINATOR, op='step', step='board', action='fan_out', shards=['core'])[0] == 409


def test_a_maps_shards_are_listed_by_the_coordinator_and_each_task_names_its_shard() -> None:
    with mock_aws():
        board = _board('understand-repository')
        assert call(board, COORDINATOR, op='step', step='map', action='fan_out', shards='core')[0] == 400
        assert call(board, COORDINATOR, op='step', step='map', action='fan_out', shards=['../etc'])[0] == 400
        status, answer = call(board, COORDINATOR, op='step', step='map', action='fan_out', shards=['core', 'web/'])
        mapper = next(item for item in answer['flow']['steps'] if item['step'] == 'mapper')
        assert (status, mapper['status'], mapper['shards_left']) == (200, 'ready', ['core', 'web'])
        assert call(board, COORDINATOR, op='step', step='map', action='fan_out', shards=['core'])[0] == 409
        spec = {'title': 'Map core', 'spec': {'instructions': 'Map it.'}}
        assert post(board, role='mapper', flow_step='mapper', **spec)[0] == 409   # (no shard)
        status, body = post(board, role='mapper', flow_step='mapper', shard='core', **spec)
        assert (status, body['task']['shard']) == (200, 'core')
        assert post(board, role='mapper', flow_step='mapper', shard='core', title='Map core again',
                    spec={'instructions': 'Again.'})[0] == 409
        assert post(board, role='mapper', flow_step='mapper', shard='/core', **spec)[0] == 400


def test_the_steps_not_run_yet_are_recorded_once_when_the_plan_is_read() -> None:
    with mock_aws():
        board = _board('issue-triage')
        assert steps(call(board, COORDINATOR, op='flow')[1])['memory'] == 'not_yet_run'
        call(board, COORDINATOR, op='flow')
        rows = run_rows(board.client, TABLE, WS, RUN, 'STEP#')
        assert [(row['step']['S'], row['record']['S'], 'not run yet' in row['reason']['S']) for row in rows] == [
            ('memory', 'not_yet_run', True)]


def test_two_posts_racing_for_one_step_never_both_land(bugs: Board) -> None:
    slot = slot_sk('hunt', '', 0)
    bugs.store.post(WS, RUN, role='hunter', title='One', spec={'n': 1}, parent_task='', priority=0, actor='c',
                    step='hunt', slot=slot)
    with pytest.raises(BoardError, match='at the same time'):
        bugs.store.post(WS, RUN, role='hunter', title='Two', spec={'n': 2}, parent_task='', priority=0, actor='c',
                        step='hunt', slot=slot)


def test_a_person_posts_for_a_live_step_or_a_task_of_their_own_which_is_launched_too(bugs: Board) -> None:
    def person(**body: Any) -> dict[str, Any]:
        return person_request(bugs.store, {'op': 'post', 'run_id': RUN, 'subject': 'admin-1',
                                           'body': {'title': 'Look at the cache', 'spec': {'note': 1}, **body}})

    own = person(role='understander')
    assert (own['status'], own['answer']['task']['flow_step']) == ('ok', None)
    assert person(role='fixer', flow_step='gate')['kind'] == 'conflict'
    assert person(role='fixer', shard='core')['kind'] == 'invalid'
    assert person(role='fixer', flow_step='board', spec={'note': 2})['answer']['task']['flow_step'] == 'board'
    task = own['answer']['task']['task_id']
    assert call(bugs, COORDINATOR, op='launch', task_id=task, role='understander', language='python')[0] == 200


def test_a_run_without_a_flow_posts_and_launches_as_before() -> None:
    with mock_aws():
        board = _board(None)
        assert call(board, COORDINATOR, op='flow')[1] == {'flow': None, 'note': NO_FLOW}
        assert post(board, role='hunter', flow_step='hunt')[0] == 400
        assert call(board, COORDINATOR, op='step', step='hunt', action='complete')[0] == 409
        status, body = post(board, role='hunter')
        assert (status, body['task']['flow_step']) == (200, None)
        task = body['task']['task_id']
        assert call(board, COORDINATOR, op='launch', task_id=task, role='hunter', language='python')[0] == 200


def test_a_copy_of_the_flow_the_conductor_cannot_follow_is_a_conflict(bugs: Board) -> None:
    bugs.client.update_item(TableName=TABLE, Key={'pk': {'S': run_pk(WS, RUN)}, 'sk': {'S': FLOW_SK}},
                            UpdateExpression='SET #d = :d', ExpressionAttributeNames={'#d': 'definition'},
                            ExpressionAttributeValues={':d': {'S': '['}})
    fresh = BoardApi(BoardStore(bugs.client, TABLE, new_id=lambda: 'x'), bugs.api.publisher, bugs.api.inbox)
    answer = fresh.handle_request(COORDINATOR, json.dumps({'op': 'flow'}))
    assert (answer['statusCode'], 'cannot be followed' in answer['body']) == (409, True)
    assert fresh.handle_request(COORDINATOR, json.dumps({'op': 'post', 'role': 'hunter', 'title': 't', 'spec': SPEC,
                                                         'flow_step': 'hunt'}))['statusCode'] == 409


@pytest.mark.parametrize('body', [{'flow_step': 7}, {'flow_step': 'x' * 65}, {'shard': 'x' * 513}])
def test_a_step_or_shard_off_its_shape_is_refused(bugs: Board, body: dict[str, Any]) -> None:
    assert post(bugs, role='hunter', **body)[0] == 400


GATE_KEY = f'ws/default/runs/{RUN}/final-go-4/commits/{"a" * 40}/_gate/attempt-1/record.json'
RUNNER_KEY = f'ws/default/runs/{RUN}/gate-runner-3/commits/{"a" * 40}/_gate/attempt-1/record.json'


def _ended(board: Board, role: str, step: str, *, holder: str = '', keys: tuple[str, ...] = (),
           patch: str = '') -> str:
    """A task of ``step`` posted by the coordinator (naming ``patch``) and ended done (as its agent's moves leave
    it)."""
    spec = {'role': role, **({'patch': patch} if patch else {})}
    task = board.store.post(WS, RUN, role=role, title=f'{role} work', spec=spec, parent_task='', priority=0,
                            actor='coordinator-1', step=step).task
    values: dict[str, Any] = {':done': {'S': 'done'}}
    expression = 'SET #s = :done'
    if holder:
        expression += ', lease_agent = :holder, result_keys = :keys'
        values.update({':holder': {'S': holder}, ':keys': {'SS': list(keys)}})
    board.client.update_item(TableName=TABLE, Key={'pk': {'S': run_pk(WS, RUN)}, 'sk': {'S': f'TASK#{task.task_id}'}},
                             UpdateExpression=expression, ExpressionAttributeNames={'#s': 'state'},
                             ExpressionAttributeValues=values)
    return task.task_id


@pytest.mark.parametrize(('verdict', 'commit', 'at'), [('GO', 200, None), ('NO-GO', 409, 'human')],
                         ids=['go-record', 'no-go-record'])
def test_a_final_go_that_ended_done_with_a_no_go_record_takes_the_gates_fail_arrow(
        verdict: str, commit: int, at: str | None) -> None:
    """The gate's verdict is the GO ledger's read of the record, never the final-go task's state alone."""
    read: list[str] = []

    def records(key: str) -> GateRecord:
        read.append(key)
        return GateRecord.from_dict(checked_record() if key == RUNNER_KEY else gate_record(verdict))

    with mock_aws():
        board = _board('bug-hunt-and-fix', gate_records=records)
        _ended(board, 'hunter', 'hunt')
        assert call(board, COORDINATOR, op='step', step='board', action='complete')[0] == 200
        _ended(board, 'gate-runner', 'gate', holder='gate-runner-3', keys=(RUNNER_KEY,))
        decider = _ended(board, 'final-go', 'gate', holder='final-go-4', keys=(GATE_KEY,))
        flow = call(board, COORDINATOR, op='flow')[1]['flow']
        # The deciding record, and behind a GO the gate runner's GO on its tree (the GO ledger's one rule).
        assert (flow['at'], read[-2:] if verdict == 'GO' else read[-1:]) == (
            at, [GATE_KEY, RUNNER_KEY] if verdict == 'GO' else [GATE_KEY])
        # The GO's step after the gate is the commit (the broker pushes only a GO'd tree).
        status, _ = post(board, role='committer', flow_step='commit', title='Commit the fix the gate passed')
        assert status == commit
        # The verdict is kept for the readers without the gate records (the run monitor), by its deciding task.
        rows = [row for row in run_rows(board.client, TABLE, WS, RUN, 'STEP#') if row['record']['S'] == 'verdict']
        assert [(row['task_id']['S'], row['verdict']['S']) for row in rows] == [
            (decider, 'go' if verdict == 'GO' else 'no_go')]


def test_without_the_gate_records_no_final_go_is_taken_for_a_go(bugs: Board) -> None:
    _ended(bugs, 'hunter', 'hunt')
    call(bugs, COORDINATOR, op='step', step='board', action='complete')
    _ended(bugs, 'gate-runner', 'gate')
    _ended(bugs, 'final-go', 'gate', holder='final-go-4', keys=(GATE_KEY,))
    assert steps(call(bugs, COORDINATOR, op='flow')[1])['pr_author'] == 'waiting'
    assert post(bugs, role='pr-author', flow_step='pr_author', title='Open the draft pull request')[0] == 409


PATCH = f'ws/default/runs/{RUN}/fixer-2/commits/{"a" * 40}/_patches/attempt-1/task-2-0a1b2c3d.diff'


@pytest.mark.parametrize(('checked', 'named', 'status'), [
    (checked_record(), PATCH, 200),
    (checked_record('STOPPED', stop='tool_missing', status='fail'), PATCH, 400),
    (checked_record('NO-GO', status='fail'), PATCH, 400),
    (checked_record(), PATCH.replace('task-2-', 'task-9-'), 400),       # (another patch than the one checked)
    (checked_record('STOPPED', stop='tool_missing', status='fail'), '', 200),   # (no patch: it can only say NO-GO)
], ids=['after-a-go', 'after-stopped', 'after-no-go', 'another-patch', 'no-patch'])
def test_a_final_go_judging_a_patch_is_taken_only_after_the_gate_runners_go_on_it(
        checked: dict[str, Any], named: str, status: int) -> None:
    with mock_aws():
        board = _board('bug-hunt-and-fix', gate_records=lambda _key: GateRecord.from_dict(checked))
        _ended(board, 'hunter', 'hunt')
        assert call(board, COORDINATOR, op='step', step='board', action='complete')[0] == 200
        _ended(board, 'gate-runner', 'gate', holder='gate-runner-3', keys=(RUNNER_KEY,), patch=PATCH)
        spec = {'instructions': 'The final go.', **({'patch': named} if named else {})}
        answer = post(board, role='final-go', flow_step='gate', title='The final go', spec=spec)
        assert answer[0] == status, answer
        if status == 400:
            assert "a final go judges the patch the gate runner's checks passed on" in json.dumps(answer[1])


def test_a_retried_post_whose_equal_task_ended_is_refused_never_made_a_new_task(bugs: Board) -> None:
    status, body = post(bugs, role='hunter', flow_step='hunt')
    assert status == 200
    # The retry's check read the task under way (an answer only); the task ends before the retry's write lands.
    fields = FlowGuard(bugs.store).post_fields(RUN, {'flow_step': 'hunt'}, role='hunter', poster='coordinator',
                                               spec=SPEC, parent_task='')
    assert (fields.retry, fields.slot) == (True, '')
    bugs.client.update_item(TableName=TABLE, Key={'pk': {'S': run_pk(WS, RUN)},
                                                  'sk': {'S': f'TASK#{body["task"]["task_id"]}'}},
                            UpdateExpression='SET #s = :failed', ExpressionAttributeNames={'#s': 'state'},
                            ExpressionAttributeValues={':failed': {'S': 'failed'}})
    with pytest.raises(BoardError, match='has ended'):
        bugs.store.post(WS, RUN, role='hunter', title='Hunt the paging bug', spec=SPEC, parent_task='', priority=0,
                        actor='coordinator-1', step='hunt', answer_only=fields.retry)
    assert len([task for task in bugs.store.tasks(WS, RUN) if task.flow_step == 'hunt']) == 1


def test_a_close_racing_a_post_between_its_plan_read_and_its_write_is_refused(bugs: Board) -> None:
    """The close is held in its own write to the tasks its plan read for the board (``POSTS#<board>``)."""
    _ended(bugs, 'hunter', 'hunt')
    _ended(bugs, 'fixer', 'board')
    guard = FlowGuard(bugs.store)
    plan = guard.plan(RUN)
    assert plan is not None
    assert (plan.steps['board'].status, plan.steps['board'].task_count) == ('ready', 1)
    # A post lands after the close read the plan (the board ready, its one task ended) and before its write.
    assert post(bugs, role='fixer', flow_step='board', title='Fix one more', spec={'instructions': 'One more.'})[0] == 200
    read = bugs.store.tasks(WS, RUN)[:-1]   # (the tasks the close's plan read: before the post)
    with pytest.raises(BoardError, match='posted for board board meanwhile'):
        guard.record.close(WS, RUN, 'board', read=read, actor='coordinator-1', at='now')
    assert not [row for row in run_rows(bugs.client, TABLE, WS, RUN, 'STEP#') if row['record']['S'] == 'done']
    counted = run_rows(bugs.client, TABLE, WS, RUN, 'POSTS#board')
    assert [row['posts']['N'] for row in counted] == ['2']


def test_a_launch_racing_its_steps_close_starts_no_agent_on_the_closed_step(bugs: Board) -> None:
    """The launch's record is held in its own write to its step's not being closed."""
    fix = call(bugs, HUNTER, op='post', role='fixer', flow_step='board', title='Fix it',
               spec={'instructions': 'Fix it.'})[1]['task']['task_id']
    guard = FlowGuard(bugs.store)
    absent = guard.launch_check(RUN, bugs.store.task(WS, RUN, fix))
    assert absent == ('STEP#board#done',)
    # The close lands after the launch's check and before its write.
    assert guard.record.record(WS, RUN, 'board', 'done', actor='coordinator-1', at='now') is True
    with pytest.raises(BoardError, match='closed meanwhile'):
        bugs.store.launch(WS, RUN, fix, role='fixer', actor='coordinator-1', language='python', absent=absent)
    assert bugs.store.task(WS, RUN, fix).launched_agent == ''
    # (refused before an agent is numbered: the run's agent count is the coordinator's alone)
    meta = bugs.store.meta(WS, RUN)
    assert meta is not None
    assert meta['agent_count']['N'] == '1'


def test_a_close_landing_between_a_launchs_read_and_its_write_is_refused_in_the_write(
        bugs: Board, monkeypatch: pytest.MonkeyPatch) -> None:
    fix = call(bugs, HUNTER, op='post', role='fixer', flow_step='board', title='Fix it',
               spec={'instructions': 'Fix it.'})[1]['task']['task_id']
    guard = FlowGuard(bugs.store)
    absent = guard.launch_check(RUN, bugs.store.task(WS, RUN, fix))
    original = bugs.store._next_agent

    def numbered_then_closed(ws: str, run_id: str, role: str) -> str:
        agent = original(ws, run_id, role)
        guard.record.record(WS, RUN, 'board', 'done', actor='coordinator-1', at='now')   # (the close lands now)
        return agent

    monkeypatch.setattr(bugs.store, '_next_agent', numbered_then_closed)
    with pytest.raises(BoardError, match='closed meanwhile'):
        bugs.store.launch(WS, RUN, fix, role='fixer', actor='coordinator-1', language='python', absent=absent)
    assert bugs.store.task(WS, RUN, fix).launched_agent == ''


def test_a_board_holding_tasks_posted_before_its_count_existed_never_closes(bugs: Board) -> None:
    """k old ended tasks (posted before the count: uncounted) and one new task under way: the count (1) cannot vouch
    for the board, whatever the close read."""
    _ended(bugs, 'hunter', 'hunt')
    for n in range(2):
        old = bugs.store.post(WS, RUN, role='fixer', title=f'Old fix {n}', spec={'old': n}, parent_task='',
                              priority=0, actor='coordinator-1').task   # (no step: as before the count)
        bugs.client.update_item(TableName=TABLE, Key={'pk': {'S': run_pk(WS, RUN)}, 'sk': {'S': f'TASK#{old.task_id}'}},
                                UpdateExpression='SET #s = :done, flow_step = :board',
                                ExpressionAttributeNames={'#s': 'state'},
                                ExpressionAttributeValues={':done': {'S': 'done'}, ':board': {'S': 'board'}})
    read = bugs.store.tasks(WS, RUN)   # (the close's plan read: the old ones, all ended)
    assert post(bugs, role='fixer', flow_step='board', title='A new fix', spec={'instructions': 'New.'})[0] == 200
    guard = FlowGuard(bugs.store)
    with pytest.raises(BoardError, match='posted before its count existed'):
        guard.record.close(WS, RUN, 'board', read=read, actor='coordinator-1', at='now')
    with pytest.raises(BoardError, match='posted before its count existed'):
        guard.record.close(WS, RUN, 'board', read=bugs.store.tasks(WS, RUN), actor='coordinator-1', at='now')
    assert not [row for row in run_rows(bugs.client, TABLE, WS, RUN, 'STEP#') if row['record']['S'] == 'done']


def test_a_launch_losing_to_another_before_the_close_is_answered_with_the_agent_recorded(
        bugs: Board, monkeypatch: pytest.MonkeyPatch) -> None:
    fix = call(bugs, HUNTER, op='post', role='fixer', flow_step='board', title='Fix it',
               spec={'instructions': 'Fix it.'})[1]['task']['task_id']
    absent = FlowGuard(bugs.store).launch_check(RUN, bugs.store.task(WS, RUN, fix))
    stale = bugs.store.task(WS, RUN, fix)   # (what the second launch read: no agent recorded yet)
    first = bugs.store.launch(WS, RUN, fix, role='fixer', actor='coordinator-1', language='python', absent=absent)
    FlowGuard(bugs.store).record.record(WS, RUN, 'board', 'done', actor='coordinator-1', at='now')
    reads = iter([stale])
    original = bugs.store.task
    monkeypatch.setattr(bugs.store, 'task', lambda ws, run_id, task_id: next(reads, None) or original(ws, run_id,
                                                                                                        task_id))
    second = bugs.store.launch(WS, RUN, fix, role='fixer', actor='coordinator-1', language='python', absent=absent)
    assert (second.launched_agent, second.launched_attempt) == (first.launched_agent, 1)


def test_a_post_racing_the_boards_close_never_lands_on_the_closed_board(bugs: Board) -> None:
    _ended(bugs, 'hunter', 'hunt')
    spec = {'instructions': 'Fix it.'}
    # The post's check read the board open; the coordinator closes it before the post's write lands.
    fields = FlowGuard(bugs.store).post_fields(RUN, {'flow_step': 'board'}, role='fixer', poster='coordinator',
                                               spec=spec, parent_task='')
    assert fields.absent == ('STEP#board#done',)
    assert call(bugs, COORDINATOR, op='step', step='board', action='complete')[0] == 200
    with pytest.raises(BoardError, match='closed meanwhile'):
        bugs.store.post(WS, RUN, role='fixer', title='Fix it', spec=spec, parent_task='', priority=0,
                        actor='coordinator-1', step='board', absent=fields.absent)
    assert [task.flow_step for task in bugs.store.tasks(WS, RUN)].count('board') == 0
