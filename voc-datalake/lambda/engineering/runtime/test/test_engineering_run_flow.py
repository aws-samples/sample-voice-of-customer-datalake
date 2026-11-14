"""A run's own copy of its flow (written once, at its start), a person's decision on a step of it (their Resume at that
step's decision point), and the decision point the run control reads from the conductor's plan."""
import copy
import json
from typing import Any

import boto3
import pytest

from engineering.board.store import BoardStore
from engineering.flow.record import FLOW_SK, run_flow
from engineering.flow.test.fixtures import TEMPLATES
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.ports import FlowStop
from engineering.runtime.runs import RunCaps, RunExists, RunStore, TableRunControl, flow_step
from engineering.runtime.test.conftest import RUN, TABLE
from shared.workflow_schema import encode_definition

PK = f'WS#default#RUN#{RUN}'
UNDERSTAND = encode_definition(TEMPLATES['understand-repository'])


def _start(table: Any, definition: str = UNDERSTAND, revision: int = 4, flow: str = 'wf_understand') -> RunStore:
    runs = RunStore(table)
    runs.start(RUN, caps=RunCaps(max_tasks=10), now=86_400, flow=flow, flow_definition=definition,
               flow_revision=revision, actor='admin-1')
    return runs


def _rows(table: Any, prefix: str) -> list[dict[str, Any]]:
    return table.query(KeyConditionExpression='pk = :pk AND begins_with(sk, :p)', ConsistentRead=True,
                       ExpressionAttributeValues={':pk': PK, ':p': prefix})['Items']


def test_the_start_copies_the_stored_flow_into_the_runs_own_record_once(aws):
    table = aws[1]
    _start(table)
    row = table.get_item(Key={'pk': PK, 'sk': FLOW_SK})['Item']
    assert (row['workflow_id'], row['revision'], row['copied_at'], row['kind']) == (
        'wf_understand', 4, '1970-01-02T00:00:00Z', 'flow_copy')
    assert json.loads(row['definition'])['nodes'][1]['id'] == 'map'
    # A retry of the start, even with another definition, never changes the copy: the run follows what it started on.
    changed = copy.deepcopy(TEMPLATES['understand-repository'])
    changed['nodes'][1]['data']['params']['shard_cap'] = 3
    with pytest.raises(RunExists):
        _start(table, encode_definition(changed), revision=5)
    assert table.get_item(Key={'pk': PK, 'sk': FLOW_SK})['Item']['revision'] == 4


def test_a_run_started_without_a_flow_has_no_copy(aws):
    RunStore(aws[1]).start(RUN, caps=RunCaps(max_tasks=10), now=0, flow='wf_x')
    assert 'Item' not in aws[1].get_item(Key={'pk': PK, 'sk': FLOW_SK})


def _agents_workflow() -> str:
    from shared.workflow_schema import default_template
    return encode_definition(default_template())


def _cyclic() -> str:
    looped = copy.deepcopy(TEMPLATES['issue-triage'])
    looped['edges'].append({'id': 'back', 'source': 'propose', 'target': 'classify'})
    return encode_definition(looped)


@pytest.mark.parametrize(('definition', 'revision', 'flow', 'message'), [
    ('{', 4, 'wf_understand', 'not an engineering flow'),
    (None, 4, 'wf_understand', 'not an engineering flow'),
    ('agents', 4, 'wf_understand', 'not an engineering flow'),
    ('cycle', 4, 'wf_understand', 'not an engineering flow'),
    (UNDERSTAND, 0, 'wf_understand', 'revision'),
    (UNDERSTAND, True, 'wf_understand', 'revision'),
    (UNDERSTAND, 4, '', 'workflow id'),
], ids=['not-json', 'not-text', 'agents-workflow', 'a-cycle', 'no-revision', 'revision-bool', 'no-flow-id'])
def test_a_flow_the_conductor_cannot_follow_is_refused_before_anything_is_written(
        aws, definition: Any, revision: Any, flow: str, message: str):
    text = str({'agents': _agents_workflow(), 'cycle': _cyclic(), None: '[]'}.get(definition, definition))
    with pytest.raises(RuntimeRefused, match=message):
        _start(aws[1], text, revision=revision, flow=flow)
    assert RunStore(aws[1]).get(RUN) is None


def test_the_conductors_own_refusal_of_a_definition_is_said_as_it_is(aws, monkeypatch: pytest.MonkeyPatch):
    from engineering.flow.conductor import Flow, FlowError
    from engineering.runtime import runs as runs_module

    def refuse(_definition: Any) -> Flow:
        raise FlowError('the runtime follows only a flow whose arrows all go forward')

    monkeypatch.setattr(runs_module.Flow, 'from_definition', staticmethod(refuse))
    with pytest.raises(RuntimeRefused, match='go forward'):
        _start(aws[1])


def test_a_resume_at_a_flow_steps_decision_point_records_the_persons_decision(aws):
    table = aws[1]
    runs = _start(table)
    runs.needs_human(RUN, 'flow:approval', now=90_000)
    runs.resume(RUN, now=90_060, actor='admin-2')
    (decision,) = _rows(table, 'STEP#')
    assert (decision['step'], decision['record'], decision['by'], decision['at']) == (
        'approval', 'decision', 'admin-2', '1970-01-02T01:01:00Z')
    # Any other decision point's Resume decides no step.
    runs.needs_human(RUN, 'budget', now=90_100)
    runs.resume(RUN, now=90_200, actor='admin-2')
    assert len(_rows(table, 'STEP#')) == 1
    assert (flow_step('flow:gate'), flow_step('coordinator')) == ('gate', '')


def test_the_run_control_says_where_the_flow_waits_for_a_person_and_keeps_saying_it_there(aws):
    table = aws[1]
    runs = _start(table)
    control = TableRunControl(runs, clock=lambda: 90_000.0)
    assert control.flow_stop(RUN) is None   # (the map is the coordinator's to fan out: running)
    client = boto3.client('dynamodb', region_name='us-east-1')
    board = BoardStore(client, TABLE, new_id=lambda: 'task-1')
    table.put_item(Item={'pk': PK, 'sk': 'STEP#map#fan_out', 'kind': 'step_record', 'step': 'map',
                         'record': 'fan_out', 'shards': ['core'], 'by': 'coordinator-1', 'at': 'now'})
    for task_id, step, role, shard in (('task-1', 'mapper', 'mapper', 'core'), ('task-2', 'understander',
                                                                               'understander', '')):
        board.new_id = lambda task_id=task_id: task_id
        board.post('default', RUN, role=role, title=step, spec={'n': task_id}, parent_task='', priority=0,
                   actor='coordinator-1', step=step, shard=shard)
        table.update_item(Key={'pk': PK, 'sk': f'TASK#{task_id}'}, UpdateExpression='SET #s = :done',
                          ExpressionAttributeNames={'#s': 'state'}, ExpressionAttributeValues={':done': 'done'})
    assert control.flow_stop(RUN) == FlowStop('flow:approval')
    control.needs_human(RUN, 'flow:approval')
    assert control.flow_stop(RUN) == FlowStop('flow:approval', waiting=True)   # (waiting there: its agents stay held)
    runs.resume(RUN, now=90_100, actor='admin-1')
    assert control.flow_stop(RUN) is None   # (decided: the flow finished at the approval)
    found = run_flow(client, TABLE, 'default', RUN, None)
    assert found is not None
    assert (found.plan.outcome, found.plan.at, found.revision) == ('finished', 'approval', 4)
    runs.needs_human(RUN, 'budget', now=90_200)
    assert control.flow_stop(RUN) is None   # (another decision point: not the flow's to say)


def test_the_run_control_of_a_run_without_a_flow_says_nothing(aws):
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=10), now=0)
    control = TableRunControl(runs)
    assert (control.flow_stop(RUN), control.flow_stop('01JD3R4NZXQ7Y2W8K4M6P9T0CD')) == (None, None)
