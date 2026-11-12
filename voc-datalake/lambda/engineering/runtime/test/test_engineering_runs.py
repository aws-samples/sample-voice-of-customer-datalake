"""A run's start and end on voc-engineering: the META row the board and the router count on, the listed runs."""
import math
from typing import Any

import boto3
import pytest

from engineering.board.store import BoardStore
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.runs import RunCaps, RunExists, RunNotActive, RunStore, TableRunControl
from engineering.runtime.test.conftest import RUN

OTHER = '01JD3R4NZXQ7Y2W8K4M6P9T0CD'
META = {'pk': f'WS#default#RUN#{RUN}', 'sk': 'META'}


def test_a_run_starts_with_the_meta_row_the_board_and_the_router_count_on(aws):
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=20, max_tokens=1000, max_cost_usd=2.5), now=86_400,
               goal='fix the parser', repo='example/app', flow='bug-hunt')
    meta = aws[1].get_item(Key=META)['Item']
    assert (meta['max_tasks'], meta['status'], meta['started_at'], meta['goal']) == (
        20, 'active', '1970-01-02T00:00:00Z', 'fix the parser')
    # The board's post adds to the task count under max_tasks; the router numbers the conversation on it.
    aws[1].update_item(Key=META, UpdateExpression='ADD task_count :one, msg_seq :one',
                       ConditionExpression='attribute_exists(max_tasks) AND (attribute_not_exists(task_count) '
                                           'OR task_count < max_tasks)', ExpressionAttributeValues={':one': 1})
    run = runs.get(RUN)
    assert run is not None
    assert (run.started_at, run.caps) == (86_400, RunCaps(20, 1000, 2.5))
    assert runs.listed() == [RUN]


def test_an_ended_run_keeps_the_counters_and_stays_listed_until_released(aws):
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0)
    runs.start(OTHER, caps=RunCaps(max_tasks=5), now=0)
    aws[1].update_item(Key=META, UpdateExpression='ADD task_count :n', ExpressionAttributeValues={':n': 3})
    runs.end(RUN, 'done', now=60)
    meta = aws[1].get_item(Key=META)['Item']
    assert (meta['status'], meta['ended_at'], meta['task_count']) == ('done', '1970-01-01T00:01:00Z', 3)
    # Its agents are ended before it stops being watched.
    assert runs.listed() == [RUN, OTHER]
    runs.release(RUN)
    runs.release(RUN)
    assert runs.listed() == [OTHER]


@pytest.mark.parametrize(('step', 'refused'), [
    (lambda runs: runs.start(RUN, caps=RunCaps(max_tasks=1), now=0), RunExists),
    (lambda runs: runs.end(OTHER, 'done', now=0), RunNotActive),
    (lambda runs: runs.needs_human(OTHER, 'budget'), RunNotActive),
    (lambda runs: runs.resume(RUN), RunNotActive),
    (lambda runs: runs.end(RUN, 'active', now=0), RuntimeRefused),
], ids=['started-twice', 'end-never-started', 'decision-never-started', 'resume-not-waiting', 'not-an-end'])
def test_a_run_starts_once_and_only_a_live_run_ends(aws, step: Any, refused: type[Exception]):
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=1), now=0)
    with pytest.raises(refused):
        step(runs)
    run = runs.get(RUN)
    assert (run.status if run else None, runs.listed()) == ('active', [RUN])


def test_an_ended_run_does_not_end_twice(aws):
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=1), now=0)
    runs.end(RUN, 'failed', now=1)
    with pytest.raises(RunNotActive):
        runs.end(RUN, 'done', now=2)
    run = runs.get(RUN)
    assert run is not None
    assert run.status == 'failed'


def test_a_run_at_a_decision_point_is_resumed_or_ended(aws):
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=1), now=0)
    runs.needs_human(RUN, 'budget')
    runs.resume(RUN)
    meta = aws[1].get_item(Key=META)['Item']
    assert (meta['status'], 'needs_human' in meta) == ('active', False)
    runs.needs_human(RUN, 'thirty_days')
    # That decision point offers only "stop".
    with pytest.raises(RunNotActive):
        runs.resume(RUN)
    runs.end(RUN, 'stopped', now=5)
    assert aws[1].get_item(Key=META)['Item']['status'] == 'stopped'


@pytest.mark.parametrize('caps', [{'max_tasks': 0}, {'max_tasks': 10_001}, {'max_tasks': 1, 'max_tokens': 0},
                                  {'max_tasks': 1, 'max_cost_usd': -1.0}, {'max_tasks': 1, 'max_cost_usd': math.nan},
                                  {'max_tasks': 1, 'max_cost_usd': math.inf}],
                         ids=['no-tasks', 'too-many', 'no-tokens', 'negative-cost', 'nan-cost', 'infinite-cost'])
def test_a_cap_must_be_a_real_limit(caps):
    with pytest.raises(RuntimeRefused, match='max_'):
        RunCaps(**caps)


def test_the_run_control_reads_the_runs_caps_spend_start_and_stop(aws):
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5, max_tokens=100, max_cost_usd=1.0), now=500)
    for agent, tokens, cost in (('fixer-1', 30, 0.25), ('hunter-1', 50, 0.5)):
        aws[1].put_item(Item={'pk': META['pk'], 'sk': f'AGENT#{agent}', 'input_tokens': tokens, 'output_tokens': 0,
                              'cost_usd': str(cost)})
    control = TableRunControl(runs)
    budget = control.budget(RUN)
    assert (budget.tokens, budget.cost_usd, budget.exceeded) == (80, 0.75, False)
    assert (control.started_at(RUN), control.stop_requested(RUN)) == (500, False)
    control.needs_human(RUN, 'budget')
    assert aws[1].get_item(Key=META)['Item']['needs_human'] == 'budget'
    assert not control.stop_requested(RUN)
    runs.end(RUN, 'done', now=600)
    # Any end, not only a person's stop, ends every MicroVM of the run.
    assert control.stop_requested(RUN)
    with pytest.raises(RunNotActive):
        control.started_at(OTHER)


def test_a_runs_connection_and_base_commit_are_kept_for_the_boards_launch(aws: Any):
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=1000, connection='conn-1', commit='a' * 40)
    run = runs.get(RUN)
    assert run is not None
    assert (run.connection, run.commit) == ('conn-1', 'a' * 40)


@pytest.mark.parametrize(('connection', 'commit', 'error'), [
    ('conn 1', '', 'connection'), ('', 'abc123', 'full hexadecimal'), ('', 'A' * 40, 'full hexadecimal')])
def test_a_bad_connection_or_commit_starts_no_run(aws: Any, connection: str, commit: str, error: str):
    runs = RunStore(aws[1])
    with pytest.raises(RuntimeRefused, match=error):
        runs.start(RUN, caps=RunCaps(max_tasks=5), now=1000, connection=connection, commit=commit)
    assert runs.get(RUN) is None


def test_a_runs_start_posts_its_coordinators_task(aws: Any):
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=1000)
    task = aws[1].get_item(Key={'pk': f'WS#default#RUN#{RUN}', 'sk': 'TASK#coordinate'})['Item']
    assert (task['role'], task['state'], task['attempt']) == ('coordinator', 'open', 1)
    with pytest.raises(RunExists):  # a retried start writes nothing again
        runs.start(RUN, caps=RunCaps(max_tasks=5), now=1001)


def test_the_coordinator_is_the_runs_first_agent_so_the_board_numbers_its_launches_from_two(aws: Any):
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=1000, connection='conn-1', commit='a' * 40, language='python')
    # The board's own client: a low-level one (a resource table's client would serialize its typed items again).
    board = BoardStore(boto3.client('dynamodb', region_name='us-east-1'), aws[1].name, new_id=lambda: 'task-1')
    posted = board.post('default', RUN, role='fixer', title='Fix the parser', spec={'goal': 'fix it'},
                        parent_task='', priority=1, actor='coordinator-1')
    launched = board.launch('default', RUN, posted.task.task_id, role='fixer', actor='coordinator-1')
    assert launched.task.launched_agent == 'fixer-2'
