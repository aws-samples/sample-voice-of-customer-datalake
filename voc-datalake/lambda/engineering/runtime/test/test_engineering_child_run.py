"""A person's Resume of an ended run is a child run (7.51.00): the start function's ``restart_run`` (the child's
META with its parent, the parent's ``CHILD#`` row, the inherited steps, the runs list), then the runtime's
``seed_restart`` (the parent ended first, a seed per task the child takes over, those tasks posted, the coordinator
launched)."""
from __future__ import annotations

import json
from typing import Any

import boto3
import pytest

from engineering.board.flow_guard import FlowGuard
from engineering.board.store import COORDINATE_TASK, BoardStore
from engineering.bus.publish import new_event_id
from engineering.bus.schema import parse
from engineering.bus.test.messages import message
from engineering.conversation.store import ConversationStore
from engineering.flow.test.fixtures import TEMPLATES
from engineering.runtime import handler, restart
from engineering.runtime.checkpoints import CheckpointReader, artifact_prefix, checkpoint_prefix
from engineering.runtime.harness import seed
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.runs import runlist_key
from engineering.runtime.test.conftest import COMMIT, TABLE, WORKSPACE_BUCKET
from engineering.runtime.test.test_engineering_runtime_handler import _recording
from shared import aws as shared_aws
from shared.workflow_schema import encode_definition

PARENT = '01JD3R4NZXQ7Y2W8K4M6P9T0CD'
CHILD = '01JD3R4NZXQ7Y2W8K4M6P9T0EF'
WS = 'default'
#: A person's Resume of the parent, as the Agents API asks voc-engineering-start for it.
RESUME = {'action': 'restart_run', 'run_id': PARENT, 'child_run_id': CHILD, 'mode': 'resume', 'base': 'same',
          'actor': 'admin-2'}


def _client() -> Any:
    return boto3.client('dynamodb', region_name='us-east-1')


def _parent(monkeypatch: pytest.MonkeyPatch) -> tuple[BoardStore, str, str]:
    """A bug hunt that ended failed: its hunter's task done, its fixer's under way with a checkpoint and a working
    tree, a person's steering in its conversation."""
    monkeypatch.setattr(handler, '_hand_on_launch', lambda *_: None)
    handler.start_handler({'action': 'start_run', 'run_id': PARENT, 'max_tasks': 10, 'goal': 'fix the floors',
                           'connection': 'conn-1', 'commit': COMMIT, 'language': 'python', 'repo': 'example/app',
                           'flow': 'wf_bug', 'flow_definition': encode_definition(TEMPLATES['bug-hunt-and-fix']),
                           'flow_revision': 3, 'actor': 'admin-1'}, None)
    store = BoardStore(_client(), TABLE, new_id=new_event_id)
    flows = FlowGuard(store)

    def post(role: str, step: str, title: str) -> str:
        body = {'flow_step': step, 'spec': {'instructions': f'{title}.'}}
        fields = flows.post_fields(PARENT, body, role=role, poster='coordinator', spec=body['spec'], parent_task='')
        return store.post(WS, PARENT, role=role, title=title, spec=body['spec'], parent_task='', priority=0,
                          actor='coordinator-1', step=fields.step, slot=fields.slot, absent=fields.absent).task.task_id

    hunt = post('hunter', 'hunt', 'Hunt the bugs')
    store.claim(WS, PARENT, hunt, role='hunter', agent='hunter-2')
    for state in ('in_progress', 'done'):
        store.move(WS, PARENT, hunt, agent='hunter-2', epoch=1, to_state=state, result_keys=[])
    fix = post('fixer', 'board', 'Fix the divide floor')
    store.launch(WS, PARENT, fix, role='fixer', actor='coordinator-1', language='python')
    store.claim(WS, PARENT, fix, role='fixer', agent='fixer-2')
    store.move(WS, PARENT, fix, agent='fixer-2', epoch=1, to_state='in_progress', result_keys=[])
    s3 = boto3.client('s3', region_name='us-east-1')
    tree = f'{artifact_prefix(PARENT, "fixer-2", COMMIT, 1, "patches")}checkpoint-000002-ab.diff'
    s3.put_object(Bucket=WORKSPACE_BUCKET, Key=tree, Body=b'diff --git a/calc.py b/calc.py\n')
    s3.put_object(Bucket=WORKSPACE_BUCKET, Key=f'{checkpoint_prefix(PARENT, "fixer-2", COMMIT, 1)}000002-ab.json',
                  Body=json.dumps({'position': {'turn': 4, 'task_id': fix}, 'plan': ['floor it'],
                                   'notes': 'divide uses /, not //.', 'patch': tree}))
    ConversationStore(_client(), TABLE).append_to_conversation(parse(message(
        run_id=PARENT, type='msg.steer', refs={'s3': []}, summary='Keep the public signature.',
        **{'from': {'kind': 'human', 'id': 'user-1'}, 'to': {'kind': 'conductor', 'id': PARENT}})))
    handler._runs().end(PARENT, 'failed', now=2_000, actor='supervisor')
    return store, hunt, fix



def _resumed(monkeypatch: pytest.MonkeyPatch) -> None:
    """The parent resumed (``RESUME``): its child started, the hand-on of its seeding to the runtime dropped."""
    monkeypatch.setattr(shared_aws, 'invoke_lambda_async', lambda *_: None)
    monkeypatch.setenv('ENGINEERING_RUNTIME_FUNCTION', 'voc-engineering-runtime')
    handler.start_handler(dict(RESUME), None)

def test_a_resume_starts_a_child_with_its_parent_its_inherited_steps_and_its_runs_list_row(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _parent(monkeypatch)
    handed: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setattr(shared_aws, 'invoke_lambda_async', lambda name, payload: handed.append((name, payload)))
    monkeypatch.setenv('ENGINEERING_RUNTIME_FUNCTION', 'voc-engineering-runtime')
    answer = handler.start_handler(dict(RESUME), None)
    assert answer == {'run_id': CHILD, 'parent_run_id': PARENT, 'status': 'active'}
    table: Any = boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE)   # (its rows as plain dicts)
    meta = table.get_item(Key={'pk': f'WS#default#RUN#{CHILD}', 'sk': 'META'})['Item']
    assert (meta['parent']['run_id'], meta['parent']['mode'], meta['parent']['by'], meta['commit'], meta['goal'],
            meta['connection'], meta['max_tasks']) == (PARENT, 'resume', 'admin-2', COMMIT, 'fix the floors', 'conn-1',
                                                       10)
    child_row = table.get_item(Key={'pk': f'WS#default#RUN#{PARENT}', 'sk': f'CHILD#{CHILD}'})['Item']
    assert (child_row['mode'], child_row['by']) == ('resume', 'admin-2')
    inherited = table.query(KeyConditionExpression='pk = :pk AND begins_with(sk, :p)',
                            ExpressionAttributeValues={':pk': f'WS#default#RUN#{CHILD}', ':p': 'STEP#'})['Items']
    assert [(row['step'], row['record']) for row in inherited] == [('hunt', 'inherited')]
    flow = table.get_item(Key={'pk': f'WS#default#RUN#{CHILD}', 'sk': 'FLOW'})['Item']
    assert flow['revision'] == 3   # (the same revision as the parent's copy)
    coordinate = BoardStore(_client(), TABLE, new_id=new_event_id).task(WS, CHILD, COORDINATE_TASK)
    assert json.loads(coordinate.spec)['seed_key'] == seed.seed_key(CHILD, COORDINATE_TASK)
    child = handler._runs().get(CHILD)
    assert child is not None
    listed = table.get_item(Key=runlist_key(CHILD, child.started_at))['Item']
    assert (listed['status'], listed['parent']['run_id'], listed['goal']) == ('active', PARENT, 'fix the floors')
    parent = handler._runs().get(PARENT)
    assert parent is not None
    parent_listed = table.get_item(Key=runlist_key(PARENT, parent.started_at))['Item']
    assert (parent_listed['status'], 'ended_at' in parent_listed, parent_listed['cost_usd']) == ('failed', True, 0)
    assert handed == [('voc-engineering-runtime', {'action': 'seed_restart', 'run_id': CHILD, 'actor': 'admin-2'})]
    # A retry with the same child id answers the child already there, writing nothing again.
    assert handler.start_handler(dict(RESUME), None)['run_id'] == CHILD
    assert len(handed) == 1


def test_seeding_writes_each_taken_over_tasks_seed_posts_it_and_launches_the_coordinator(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    store, _hunt, fix = _parent(monkeypatch)
    _resumed(monkeypatch)
    _runtime, started = _recording(monkeypatch)
    answer = handler.lambda_handler({'action': 'seed_restart', 'run_id': CHILD, 'actor': 'admin-2'}, None)
    assert (answer['seeded'], answer['skipped']) == ([fix], [])
    s3 = boto3.client('s3', region_name='us-east-1')
    record = seed.parse(s3.get_object(Bucket=WORKSPACE_BUCKET, Key=seed.seed_key(CHILD, fix))['Body'].read(), CHILD)
    assert record is not None
    assert (record['parent']['agent_id'], record['checkpoint']['notes'], record['steering'][0]['text']) == (
        'fixer-2', 'divide uses /, not //.', 'Keep the public signature.')
    assert s3.get_object(Bucket=WORKSPACE_BUCKET, Key=record['patch_key'])['Body'].read() == (
        b'diff --git a/calc.py b/calc.py\n')
    coordinator = seed.parse(s3.get_object(Bucket=WORKSPACE_BUCKET,
                                           Key=seed.seed_key(CHILD, COORDINATE_TASK))['Body'].read(), CHILD)
    assert coordinator is not None
    assert coordinator['parent']['agent_id'] == 'coordinator-1'
    [posted] = [task for task in store.tasks(WS, CHILD) if task.task_id != COORDINATE_TASK]
    assert (posted.role, posted.flow_step, json.loads(posted.spec)['seed_key']) == (
        'fixer', 'board', seed.seed_key(CHILD, fix))
    assert len(started) == 1   # (the child's coordinator)


def test_a_parents_saved_kiro_session_is_copied_beside_its_seed_for_the_childs_session_load(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    """7.53.00: a parent agent on the Kiro harness saved its ACP session with its checkpoint; the child's seed names a
    copy under the child's own _seed/, which its agent ``session/load``s (harness/kiro.py)."""
    assert wired is not None
    _store, _hunt, fix = _parent(monkeypatch)
    s3 = boto3.client('s3', region_name='us-east-1')
    state = f'{artifact_prefix(PARENT, "fixer-2", COMMIT, 1, "kiro")}000003-cd.tgz'
    s3.put_object(Bucket=WORKSPACE_BUCKET, Key=state, Body=b'packed kiro session')
    s3.put_object(Bucket=WORKSPACE_BUCKET, Key=f'{checkpoint_prefix(PARENT, "fixer-2", COMMIT, 1)}000003-cd.json',
                  Body=json.dumps({'position': {'turn': 5, 'task_id': fix, 'kiro': {'session_id': 'sess_parent',
                                                                                    'state': state}},
                                   'plan': [], 'notes': 'on kiro', 'patch': None}))
    _resumed(monkeypatch)
    _recording(monkeypatch)
    handler.lambda_handler({'action': 'seed_restart', 'run_id': CHILD, 'actor': 'admin-2'}, None)
    record = seed.parse(s3.get_object(Bucket=WORKSPACE_BUCKET, Key=seed.seed_key(CHILD, fix))['Body'].read(), CHILD)
    assert record is not None
    assert record['kiro'] == {'session_id': 'sess_parent', 'state': seed.kiro_key(CHILD, fix)}
    assert s3.get_object(Bucket=WORKSPACE_BUCKET, Key=seed.kiro_key(CHILD, fix))['Body'].read() == b'packed kiro session'


def test_a_live_run_is_restarted_through_its_signals_never_as_a_child(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    monkeypatch.setattr(handler, '_hand_on_launch', lambda *_: None)
    handler.start_handler({'action': 'start_run', 'run_id': PARENT, 'max_tasks': 5, 'actor': 'admin-1'}, None)
    with pytest.raises(RuntimeRefused, match='the run is live'):
        handler.start_handler(dict(RESUME), None)
    assert handler._runs().get(CHILD) is None


@pytest.mark.parametrize(('status', 'waiting', 'started', 'allowed'), [
    ('done', '', 0, True), ('stopped', '', 0, True), ('failed', '', 0, True),
    ('needs_human', 'budget', 0, True), ('needs_human', 'thirty_days', 0, True),
    ('active', '', 0, False), ('needs_human', 'coordinator', 0, False), ('needs_human', 'flow:gate', 0, False),
    ('active', '', -restart.THIRTY_DAYS, True),
])
def test_which_runs_start_a_child(status: str, waiting: str, started: int, allowed: bool):
    if allowed:
        restart.may_restart(status, waiting, started, 0)
    else:
        with pytest.raises(RuntimeRefused):
            restart.may_restart(status, waiting, started, 0)


def test_a_history_past_its_bounds_is_learns_summary_charged_to_the_child(aws):
    s3, _table = aws
    prefix = artifact_prefix(PARENT, 'fixer-2', COMMIT, 1, 'transcripts')
    events = '\n'.join(json.dumps({'kind': 'tool_call', 'tool': 'run', 'input': {'n': n}}) for n in range(60))
    s3.put_object(Bucket=WORKSPACE_BUCKET, Key=f'{prefix}0001.jsonl', Body=events.encode())
    charged: list[tuple[str, str, int, int]] = []

    class Reply:
        text, model_id, tokens_in, tokens_out = 'It floored the divide; the tests are left.', 'model-x', 900, 80

    # (a history reads the parent's transcripts alone: the board and the checkpoints are never asked)
    board, checkpoints = BoardStore(_client(), TABLE, new_id=new_event_id), CheckpointReader(s3, WORKSPACE_BUCKET)
    seeder = restart.Seeder(s3=s3, bucket=WORKSPACE_BUCKET, board=board, checkpoints=checkpoints,
                            summarize=lambda *_: Reply(), charge=lambda *a: charged.append(a))
    history = seeder.history(restart.Attempt(PARENT, 'fixer-2', COMMIT, 1), CHILD)
    assert (history['kind'], history['text'], history['tokens']) == ('summary', Reply.text, 980)
    assert charged == [(CHILD, 'model-x', 900, 80)]
    # Under the bounds: the excerpts, no model call.
    s3.put_object(Bucket=WORKSPACE_BUCKET, Key=f'{prefix}0001.jsonl', Body=events.split('\n', 1)[0].encode())
    short = restart.Seeder(s3=s3, bucket=WORKSPACE_BUCKET, board=board, checkpoints=checkpoints,
                           summarize=lambda *_: pytest.fail('no call'))
    assert short.history(restart.Attempt(PARENT, 'fixer-2', COMMIT, 1), CHILD)['kind'] == 'excerpts'


def test_a_resume_on_the_heads_base_takes_the_default_branchs_head_through_the_broker(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _parent(monkeypatch)
    monkeypatch.setattr(shared_aws, 'invoke_lambda_async', lambda *_: None)
    monkeypatch.setenv('ENGINEERING_RUNTIME_FUNCTION', 'voc-engineering-runtime')
    asked: list[tuple[str, ...]] = []

    def head(*where: str) -> str:
        asked.append(where)
        return 'b' * 40

    monkeypatch.setattr(handler, '_head_commit', head)
    handler.start_handler({**RESUME, 'base': 'head'}, None)
    child = handler._runs().get(CHILD)
    assert child is not None
    assert (child.commit, asked) == ('b' * 40, [('conn-1', 'example/app', '')])
