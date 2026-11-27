"""runtime/step_retry.py (7.71.04): which of a step's tasks a person's Resume at its decision point posts again
(7.104.00, Q1: an agent step's newest, whatever its spec, each shard's on its own after a map; a gate's or a board's,
each spec's), which steps a whole-run Resume tries again (Q4: the decided one and every other agent step that takes a
task now), a refused post skipped (Q3, 7.104.00 review: one a store fault stops too, the later ones still made), the
run's tasks read once, and the handler's whole-run Resume (Q2: one decision
covers a gate's two tasks at a person; Q1: a shard at a person while a sibling's task is under way; Q4: a step decided
before 7.71.04; a retry that cannot read the run leaves the Resume applied). The Resume end to end is
test_engineering_bug_hunt_resume.py's."""
from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from typing import Any, override

import boto3
from botocore.exceptions import ClientError

from engineering.board.flow_guard import FlowGuard, PostFields
from engineering.board.model import Task
from engineering.board.store import BoardError, BoardStore, Posted
from engineering.flow.conductor import BoardState, Flow, Plan, StepTask, conduct, decided_until
from engineering.runtime.step_retry import retry_step, retry_steps, steps_to_retry, to_retry


def _task(task_id: str, state: str, *, step: str = 'commit', work: str = 'w1', at: str = '2026-11-25T10:00:00',
          shard: str = '', spec: str = '{"patch": "p"}') -> Task:
    return Task(task_id=task_id, role='committer', state=state, title='Commit the fix', spec=spec, spec_hash=work,
                depth=0, priority=0, attempt=1, flow_step=step, updated_at=at, shard=shard)


def _ids(tasks: list[Task]) -> list[str]:
    return [task.task_id for task in tasks]


def test_an_agent_steps_newest_task_at_a_person_is_posted_again_whatever_spec_an_earlier_one_named() -> None:
    # (Q1/Q8, 7.104.00) Two works at a person on one agent step: the committer's first task (patch p1), then the one
    # the coordinator posted with a revised patch (p2), both needs_human. 7.71.04 keyed works by spec, posted the
    # oldest (p1), and the board then refused the newest: the step takes one task at a time. Only the newest is posted.
    tasks = [_task('t1', 'needs_human', at='2026-11-25T09:00:00', work='w1', spec='{"patch": "p1"}'),
             _task('t2', 'needs_human', at='2026-11-25T10:00:00', work='w2', spec='{"patch": "p2"}'),
             _task('t3', 'needs_human', step='hunt', work='w3')]
    assert _ids(to_retry(tasks, 'commit', one_at_a_time=True)) == ['t2']
    # (the newest by its time, not by its id)
    assert _ids(to_retry([_task('t9', 'needs_human', at='2026-11-25T08:00:00', work='w9'), *tasks[:2]], 'commit',
                         one_at_a_time=True)) == ['t2']


def test_after_a_map_each_shards_newest_task_at_a_person_is_posted_again() -> None:
    tasks = [_task('t1', 'needs_human', shard='core', at='2026-11-25T09:00:00'),
             _task('t2', 'needs_human', shard='core', work='w2'), _task('t3', 'needs_human', shard='web', work='w3'),
             _task('t4', 'needs_human', shard='api', at='2026-11-25T09:00:00'),
             _task('t5', 'done', shard='api', work='w5')]
    assert _ids(to_retry(tasks, 'commit', one_at_a_time=True)) == ['t2', 't3']


def test_after_a_map_a_shard_at_a_person_is_posted_again_while_a_sibling_shards_task_is_under_way() -> None:
    # (Q1, 7.104.00 review) Shard core's task ended at a person while shard web's is still in progress (its agent held
    # while the run waited, then resumed): core's newest task is posted again, web is left alone. Until this review the
    # check was the whole step's, so nothing was posted and nothing else would post core's task again.
    tasks = [_task('t1', 'needs_human', shard='core', at='2026-11-25T09:00:00', work='w1'),
             _task('t2', 'needs_human', shard='core', work='w2'), _task('t3', 'in_progress', shard='web', work='w3'),
             _task('t4', 'needs_human', shard='api', at='2026-11-25T09:00:00', work='w4'),
             _task('t5', 'open', shard='api', work='w5')]
    assert _ids(to_retry(tasks, 'commit', one_at_a_time=True)) == ['t2']
    # (a gate's or a board's tasks run together: nothing of it is posted again while one is under way)
    assert to_retry(tasks, 'commit', one_at_a_time=False) == []


def test_a_gates_or_a_boards_tasks_at_a_person_are_each_posted_again() -> None:
    # (they run several at once: each spec its own work, its newest task posted again)
    tasks = [_task('t1', 'failed', at='2026-11-25T09:00:00'), _task('t2', 'needs_human'),
             _task('t3', 'needs_human', work='w2'), _task('t4', 'needs_human', step='hunt', work='w3')]
    assert _ids(to_retry(tasks, 'commit', one_at_a_time=False)) == ['t2', 't3']


def test_a_work_that_failed_last_or_was_done_and_a_step_under_way_post_nothing_again() -> None:
    for one_at_a_time in (True, False):
        assert to_retry([_task('t1', 'needs_human', at='2026-11-25T09:00:00'), _task('t2', 'failed')], 'commit',
                        one_at_a_time=one_at_a_time) == []
        assert to_retry([_task('t1', 'done', at='2026-11-25T09:00:00'), _task('t2', 'needs_human')], 'commit',
                        one_at_a_time=one_at_a_time) == []
        assert to_retry([_task('t1', 'needs_human'), _task('t2', 'claimed', work='w2')], 'commit',
                        one_at_a_time=one_at_a_time) == []


def _flow() -> Flow:
    """A start, then three agent steps side by side (hunt, commit, review) and a gate, each to the end."""
    steps = [('hunt', 'agent', {'role': 'hunter'}), ('commit', 'agent', {'role': 'committer'}),
             ('review', 'agent', {'role': 'pr-reviewer'}), ('gate', 'quality_gate', {})]
    nodes = [{'id': 'start', 'type': 'start', 'data': {'title': 'Start', 'params': {}}},
             *({'id': step, 'type': kind, 'data': {'title': step, 'params': params}} for step, kind, params in steps),
             {'id': 'end', 'type': 'end', 'data': {'title': 'End', 'params': {'status': 'completed'}}}]
    edges = [*({'source': 'start', 'target': step} for step, _, _ in steps),
             *({'source': step, 'target': 'end', 'label': 'pass' if step == 'gate' else ''} for step, _, _ in steps)]
    return Flow.from_definition({'schema': 'voc-workflow/2', 'nodes': nodes, 'edges': edges})


def test_a_whole_run_resume_tries_the_decided_step_then_every_other_ready_agent_step() -> None:
    # (Q4, 7.104.00) The commit step was decided before 7.71.04 (the decision, after its task at a person ended, covers
    # it) and the run now waits elsewhere: a Resume that decides no step still tries it, as ready. A blocked step, a
    # running one and a gate (no agent step) are not tried; a decided gate goes first.
    ended = '2026-11-24T09:00:00+00:00'
    tasks = (StepTask('t1', 'commit', 'committer', 'needs_human', updated_at=ended),
             StepTask('t2', 'review', 'pr-reviewer', 'failed', updated_at=ended),
             StepTask('t3', 'hunt', 'hunter', 'in_progress', updated_at=ended))
    plan = conduct(_flow(), BoardState(tasks, decisions={'commit': decided_until('2026-11-24T10:00:00Z')}))
    assert [(state.step, state.status) for state in plan.steps.values() if state.step != 'start'] == [
        ('hunt', 'running'), ('commit', 'ready'), ('review', 'blocked'), ('gate', 'ready'), ('end', 'waiting')]
    assert steps_to_retry(plan, '') == ['commit']
    assert steps_to_retry(plan, 'gate') == ['gate', 'commit']
    assert steps_to_retry(plan, 'commit') == ['commit']
    assert steps_to_retry(plan, 'nowhere') == ['commit']


def _mapped_flow() -> Flow:
    from engineering.flow.test.fixtures import TEMPLATES
    return Flow.from_definition(TEMPLATES['understand-repository'])


def test_a_whole_run_resume_tries_a_running_step_after_a_map_with_a_shard_left() -> None:
    # (Q1, 7.104.00 review) After a map, shard core's task at a person was decided (the decision after it ended covers
    # it) while shard web's is under way: the step is running with core left, so a whole-run Resume that decides no
    # step tries it too (a post an earlier Resume left out). A running step with no shard left is not tried.
    ended = '2026-11-24T09:00:00+00:00'
    core = StepTask('t1', 'mapper', 'mapper', 'needs_human', shard='core', updated_at=ended)
    web = StepTask('t2', 'mapper', 'mapper', 'in_progress', shard='web', updated_at=ended)
    decided = BoardState((core, web), fanned_out={'map': ('core', 'web')},
                         decisions={'mapper': decided_until('2026-11-24T10:00:00Z')})
    plan = conduct(_mapped_flow(), decided)
    assert (plan.steps['mapper'].status, plan.steps['mapper'].shards_left) == ('running', ('core',))
    assert steps_to_retry(plan, '') == ['mapper']
    busy = conduct(_mapped_flow(), BoardState((web,), fanned_out={'map': ('web',)}))
    assert (busy.steps['mapper'].status, steps_to_retry(busy, '')) == ('running', [])


class _CountingStore(BoardStore):
    """A board store whose task list is ``tasks``, each read counted."""

    def __init__(self, tasks: list[Task]) -> None:
        super().__init__(None, 'unused', new_id=lambda: 'unused')
        self.listed = tasks
        self.reads = 0

    @override
    def tasks(self, ws: str, run_id: str) -> list[Task]:
        self.reads += 1
        return self.listed


class _PlannedGuard(FlowGuard):
    """The board's flow checks on a counting store: its plan the conductor's of the tasks it is handed (none read
    here), every post refused."""

    def __init__(self, store: _CountingStore, flow: Flow, board: BoardState) -> None:
        super().__init__(store)
        self.flow, self.board = flow, board
        self.planned: list[Sequence[Task] | None] = []

    @override
    def plan(self, run_id: str, tasks: Sequence[Task] | None = None) -> Plan | None:
        self.planned.append(tasks)
        return conduct(self.flow, self.board)

    @override
    def post_fields(self, run_id: str, body: Mapping[str, Any], *, role: str, poster: str, spec: Mapping[str, Any],
                    parent_task: str, person: bool = False) -> PostFields:
        raise BoardError('conflict', 'refused')


def test_a_whole_run_resume_reads_the_runs_tasks_once() -> None:
    # (F4, 7.104.00 review) The plan is the conductor's of the tasks the retry reads, not a second read.
    store = _CountingStore([_task('t1', 'needs_human', step='mapper', shard='core')])
    guard = _PlannedGuard(store, _mapped_flow(), BoardState(fanned_out={'map': ('core',)}))
    assert retry_steps(guard, 'run-1', 'mapper', actor='admin-1') == []
    assert (store.reads, guard.planned) == (1, [store.listed])


class _RefusingGuard(FlowGuard):
    """The board's flow checks, refusing every post (the step not live), each one asked kept."""

    def __init__(self, store: BoardStore) -> None:   # (its flow record never read: the refusal comes first)
        super().__init__(store)
        self.asked: list[tuple[Any, ...]] = []

    def post_fields(self, run_id: str, body: Mapping[str, Any], *, role: str, poster: str, spec: Mapping[str, Any],
                    parent_task: str, person: bool = False) -> PostFields:
        self.asked.append((run_id, dict(body), role, poster, dict(spec), parent_task, person))
        raise BoardError('conflict', 'step commit is blocked: only a ready step takes tasks (read the flow)')


def test_a_post_the_board_refuses_is_skipped() -> None:
    guard = _RefusingGuard(BoardStore(None, 'unused', new_id=lambda: 'unused'))   # (no table is read)
    assert retry_step(guard, 'run-1', 'commit', [_task('t1', 'needs_human')], one_at_a_time=True,
                      actor='admin-1') == []
    # (asked as a person's post for the step, the same role, spec and parent)
    assert guard.asked == [('run-1', {'flow_step': 'commit', 'shard': ''}, 'committer', 'coordinator', {'patch': 'p'},
                            '', True)]


class _ThrottledFirstStore(BoardStore):
    """A board store whose first post is throttled (DynamoDB's ``ThrottlingException``) and whose later posts land,
    each kept."""

    def __init__(self) -> None:
        super().__init__(None, 'unused', new_id=lambda: 'unused')
        self.posts: list[str] = []

    @override
    def post(self, ws: str, run_id: str, *, role: str, title: str, spec: Mapping[str, Any], parent_task: str,
             priority: int, actor: str, step: str = '', shard: str = '', slot: str = '', absent: Sequence[str] = (),
             answer_only: bool = False) -> Posted:
        self.posts.append(shard)
        if len(self.posts) == 1:
            raise ClientError({'Error': {'Code': 'ThrottlingException', 'Message': 'slow down'}}, 'TransactWriteItems')
        return Posted(_task(f'new-{shard}', 'open', shard=shard), created=True)


class _AdmittingGuard(FlowGuard):
    """The board's flow checks, admitting every post on its own shard."""

    @override
    def post_fields(self, run_id: str, body: Mapping[str, Any], *, role: str, poster: str, spec: Mapping[str, Any],
                    parent_task: str, person: bool = False) -> PostFields:
        return PostFields(step=str(body['flow_step']), shard=str(body['shard']))


def test_a_post_a_store_fault_stops_is_skipped_and_the_later_ones_are_still_made() -> None:
    # (Q3, 7.104.00 review) Three shards at a person: the first post is throttled, and the other two are still posted.
    # Only BoardError was caught per post, so one ClientError (or BotoCoreError) skipped every later post of the Resume.
    store = _ThrottledFirstStore()
    tasks = [_task(f't{n}', 'needs_human', shard=shard, work=f'w{n}') for n, shard in enumerate(('api', 'core', 'web'))]
    assert retry_step(_AdmittingGuard(store), 'run-1', 'commit', tasks, one_at_a_time=True, actor='admin-1') == [
        'new-core', 'new-web']
    assert store.posts == ['api', 'core', 'web']


# --- the handler's whole-run Resume (voc-engineering-runtime's own wiring, on moto) ---------------------------------

GATED = '01JD3R4NZXQ7Y2W8K4M6P9T0GT'


def _step_row(step: str, record: str, **extra: Any) -> dict[str, Any]:
    """A step row of the run (``STEP#<step>#<record>``) as the coordinator recorded it."""
    return {'pk': {'S': f'WS#default#RUN#{GATED}'}, 'sk': {'S': f'STEP#{step}#{record}'}, 'kind': {'S': 'step_record'},
            'step': {'S': step}, 'record': {'S': record}, 'by': {'S': 'coordinator-1'}, 'at': {'S': 'now'}, **extra}


def _flow_run(template: str, tasks: list[tuple[str, str, str, dict[str, Any], str, str]],
              rows: list[dict[str, Any]]) -> BoardStore:
    """A run of ``template``'s flow (its flow copied, no connection: no coordinator is launched), its ``tasks`` posted
    (``(task id, step, role, spec, state, shard)``, each left in that state) and its step ``rows`` put."""
    from engineering.flow.test.fixtures import TEMPLATES
    from engineering.runtime import handler
    from engineering.runtime.test.conftest import TABLE
    from shared.workflow_schema import encode_definition
    handler.lambda_handler({'action': 'start_run', 'run_id': GATED, 'max_tasks': 20, 'goal': 'fix the parser',
                            'flow': 'wf_bugs', 'flow_definition': encode_definition(TEMPLATES[template]),
                            'flow_revision': 1}, None)
    client = boto3.client('dynamodb', region_name='us-east-1')
    for row in rows:
        client.put_item(TableName=TABLE, Item=row)
    for task_id, step, role, spec, state, shard in tasks:
        BoardStore(client, TABLE, new_id=lambda task_id=task_id: task_id).post(
            'default', GATED, role=role, title=f'The {role} task', spec=spec, parent_task='', priority=0,
            actor='coordinator-1', step=step, shard=shard)
        client.update_item(TableName=TABLE,
                           Key={'pk': {'S': f'WS#default#RUN#{GATED}'}, 'sk': {'S': f'TASK#{task_id}'}},
                           UpdateExpression='SET #s = :state', ExpressionAttributeNames={'#s': 'state'},
                           ExpressionAttributeValues={':state': {'S': state}})
    return BoardStore(client, TABLE, new_id=lambda: 'task-new')


def _bug_hunt_run(tasks: list[tuple[str, str, str, dict[str, Any], str]]) -> BoardStore:
    """A Bug hunt and fix run (``_flow_run``), its ``tasks`` on no shard and its fix board closed."""
    return _flow_run('bug-hunt-and-fix', [(*task, '') for task in tasks], [_step_row('board', 'done')])


def _resumed_by_a_person() -> None:
    from engineering.runtime import handler
    handler.lambda_handler({'action': 'signal', 'run_id': GATED, 'signal': 'resume', 'actor': 'admin-1'}, None)


def _posted_again(board: BoardStore) -> list[tuple[str, str, str, str]]:
    """The open tasks of the run's steps (its coordinate task, which names none, aside)."""
    return sorted((task.flow_step, task.role, task.spec, task.posted_by) for task in board.tasks('default', GATED)
                  if task.state == 'open' and task.flow_step)


def _at_the_gate(*runner_tasks: int) -> BoardStore:
    """A Bug hunt run whose hunt is done and whose gate runner tasks ``task-<n>`` (each ``runner_tasks`` n) ended at
    a person, waiting at the gate's decision point (``flow:gate``)."""
    from engineering.runtime import handler
    board = _bug_hunt_run([('task-1', 'hunt', 'hunter', {'n': 1}, 'done'),
                           *((f'task-{n}', 'gate', 'gate-runner', {'pack': 'python', 'n': n}, 'needs_human')
                             for n in runner_tasks)])
    handler._runs().needs_human(GATED, 'flow:gate', now=int(time.time()))
    return board


def test_one_resume_at_a_gate_with_two_tasks_at_a_person_tries_both_again(wired: Any):
    # (Q2/Q8, 7.104.00) Two gate runner tasks ended at a person: until 7.104.00 a decision covered one failed task, so
    # the gate stayed blocked after the person's Resume (failures 2 > decisions 1) and its posts were refused; a
    # second Resume was needed. The decision now covers every task that ended by its time, both: the gate is ready
    # again and both tasks are posted again, the person's.
    from engineering.runtime import handler
    assert wired is not None
    board = _at_the_gate(2, 3)
    _resumed_by_a_person()
    [decision] = handler._runs().typed_rows(GATED, 'STEP#gate#decision#')
    assert (decision['by']['S'], 'failures' in decision) == ('admin-1', False)
    assert _posted_again(board) == [('gate', 'gate-runner', '{"n": 2, "pack": "python"}', 'human:admin-1'),
                                    ('gate', 'gate-runner', '{"n": 3, "pack": "python"}', 'human:admin-1')]
    run = handler._runs().get(GATED)
    assert run is not None
    assert run.status == 'active'


def test_a_resume_after_a_map_posts_again_a_shards_task_at_a_person_while_a_sibling_shards_is_under_way(wired: Any):
    # (Q1, 7.104.00 review) Shard core's mapper task ended at a person while shard web's is in progress (its agent held,
    # checkpointed then paused, while the run waited at flow:mapper). The person's Resume decides the step and posts
    # core's task again, the person's, on its shard; web's is left as it was.
    from engineering.runtime import handler
    assert wired is not None
    board = _flow_run('understand-repository',
                      [('task-1', 'mapper', 'mapper', {'package': 'core'}, 'needs_human', 'core'),
                       ('task-2', 'mapper', 'mapper', {'package': 'web'}, 'in_progress', 'web')],
                      [_step_row('map', 'fan_out', shards={'L': [{'S': 'core'}, {'S': 'web'}]})])
    handler._runs().needs_human(GATED, 'flow:mapper', now=int(time.time()))
    _resumed_by_a_person()
    assert [row['by']['S'] for row in handler._runs().typed_rows(GATED, 'STEP#mapper#decision#')] == ['admin-1']
    assert _posted_again(board) == [('mapper', 'mapper', '{"package": "core"}', 'human:admin-1')]
    assert sorted((task.shard, task.state) for task in board.tasks('default', GATED) if task.flow_step == 'mapper') == [
        ('core', 'needs_human'), ('core', 'open'), ('web', 'in_progress')]


def test_a_resume_elsewhere_posts_again_a_ready_agent_steps_task_at_a_person(wired: Any):
    # (Q4, 7.104.00) An agent step's task ended at a person and a person decided the step before 7.71.04 (a decision
    # row of then, after the task ended: it covers it), then the run went back to the coordinator's decision point, as
    # 7.71.03 left the run on b- at its commit step. Only the coordinator's skill would have posted the step's task
    # again (a stored version 7 posts nothing for a task at a person): the whole-run Resume, deciding no step, posts
    # it, the person's, the same spec.
    from engineering.runtime import handler
    from engineering.runtime.test.conftest import TABLE
    assert wired is not None
    board = _bug_hunt_run([('task-1', 'hunt', 'hunter', {'packages': ['core']}, 'needs_human')])
    decided = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())   # (the task ended at its post, just before)
    boto3.client('dynamodb', region_name='us-east-1').put_item(TableName=TABLE, Item={
        'pk': {'S': f'WS#default#RUN#{GATED}'}, 'sk': {'S': f'STEP#hunt#decision#{decided}#ab12cd34'},
        'kind': {'S': 'step_record'}, 'step': {'S': 'hunt'}, 'record': {'S': 'decision'}, 'by': {'S': 'admin-1'},
        'at': {'S': decided}})
    handler._runs().needs_human(GATED, 'coordinator', now=int(time.time()))
    _resumed_by_a_person()
    assert _posted_again(board) == [('hunt', 'hunter', '{"packages": ["core"]}', 'human:admin-1')]
    assert len(handler._runs().typed_rows(GATED, 'STEP#hunt#decision#')) == 1   # (it decided nothing more)


def test_a_resume_whose_retry_cannot_read_the_run_is_applied_and_posts_nothing(wired: Any, monkeypatch: Any):
    # (Q3, 7.104.00) The retry is best effort (handler._retried): a plan read the board refuses is logged, and the
    # person's Resume stands, its decision on the gate recorded and the run active.
    from engineering.runtime import handler
    assert wired is not None
    board = _at_the_gate(2)

    def unreadable(*_args: Any, **_kwargs: Any) -> None:
        raise BoardError('conflict', 'the board could not be read')

    monkeypatch.setattr(FlowGuard, 'plan', unreadable)
    _resumed_by_a_person()
    assert [row['by']['S'] for row in handler._runs().typed_rows(GATED, 'STEP#gate#decision#')] == ['admin-1']
    assert _posted_again(board) == []
    run = handler._runs().get(GATED)
    assert run is not None
    assert run.status == 'active'
