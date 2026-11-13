"""The board ops for the run's coordinator and the harness: the coordinate task (only the run's start writes it, only
the coordinator claims it), the claim answered again for its live holder, ``tasks``, ``launch`` (through the runtime's
launch action only, recorded once per attempt) and ``knowledge`` (the caller's own task's paths, or the root)."""
from __future__ import annotations

import json
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from itertools import count
from typing import Any

import boto3
import pytest

from engineering.board.api import BoardApi, LambdaLauncher, repost_task
from engineering.board.inbox import Inbox
from engineering.board.store import COORDINATE_TASK, MAX_AGENTS, BoardError, BoardStore
from engineering.board.test.table import RUN, TABLE, engineering_table
from engineering.board.test.test_progress_repost import Bus
from engineering.bus.publish import EventBridgePublisher
from engineering.connectors.identity import Caller
from engineering.knowledge.notes import Note
from engineering.knowledge.reduce import reduce_package
from engineering.knowledge.store import Actor, PackConflict, PackError, PackNotFound, PackStore, PackUnavailable
from engineering.knowledge.test.fixtures import pack_tables
from engineering.knowledge.workspaces import ROOT
from engineering.rows import run_pk
from engineering.test.run_fixture import LambdaClient

WS = 'default'
COORDINATOR = Caller('coordinator', RUN, 1)   # (coordinator-1: the run's start launches it)
FIXER = Caller('fixer', RUN, 1)
AT = '2026-11-12T09:00:00+00:00'



class Launcher:
    """The runtime's launch: records each request and answers it booting."""

    def __init__(self) -> None:
        self.requests: list[Mapping[str, Any]] = []

    def launch(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        self.requests.append(request)
        return {'run_id': request['run_id'], 'agent_id': request['agent_id'], 'status': 'booting'}


@dataclass(frozen=True)
class Pack:
    version: int
    text: str


#: Packages the fake store cannot read (its own faults, not the caller's).
FAULTS: dict[str, type[PackError]] = {'gone': PackNotFound, 'changed': PackConflict, 'unreadable': PackUnavailable}


class Knowledge:
    def __init__(self) -> None:
        self.reads: list[tuple[str, str, str]] = []

    def for_agent(self, ws: str, connection: str, package: str) -> Pack | None:
        self.reads.append((ws, connection, package))
        if package == 'bad':
            raise PackError('not a valid package')
        if package in FAULTS:
            raise FAULTS[package]('the approved version cannot be read')
        return Pack(3, f'<<DATA {package}>>') if package != 'none' else None


@dataclass
class Board:
    client: Any
    store: BoardStore
    api: BoardApi
    launcher: Launcher
    knowledge: Any


def _start(client: Any, store: BoardStore) -> None:
    """The run's start: META (as the run start writes it, with its commit and connection, and agent_count 1: its
    coordinator, coordinator-1, is the run's first agent) and the coordinate task,
    put as ``RunStore.start`` puts its rows: one transaction through a resource table's client."""
    client.update_item(TableName=TABLE, Key={'pk': {'S': run_pk(WS, RUN)}, 'sk': {'S': 'META'}},
                       UpdateExpression='SET #c = :commit, #n = :connection, agent_count = :one',
                       ExpressionAttributeNames={'#c': 'commit', '#n': 'connection'},
                       ExpressionAttributeValues={':commit': {'S': 'a' * 40}, ':connection': {'S': 'repo-1'},
                                                  ':one': {'N': '1'}})
    table = boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE)
    table.meta.client.transact_write_items(TransactItems=[
        {'Put': {'TableName': TABLE, 'Item': item, 'ConditionExpression': 'attribute_not_exists(pk)'}}
        for item in store.coordinate_items(WS, RUN, at=AT)])


def _board(client: Any, knowledge: Any) -> Board:
    ids = count(1)
    store = BoardStore(client, TABLE, new_id=lambda: f'task-{next(ids)}')
    _start(client, store)
    launcher = Launcher()
    api = BoardApi(store, EventBridgePublisher(Bus(), 'voc-engineering', 'voc.engineering/board'),
                   Inbox(client, TABLE), launcher=launcher, knowledge=knowledge)
    return Board(client, store, api, launcher, knowledge)


@pytest.fixture
def run() -> Iterator[Board]:
    with engineering_table() as client:
        yield _board(client, Knowledge())


def call(board: Board, caller: Caller, **body: Any) -> tuple[int, dict[str, Any]]:
    answer = board.api.handle_request(caller, json.dumps(body))
    return answer['statusCode'], json.loads(answer['body'])


def fixer_task(board: Board, paths: list[str] | None = None) -> str:
    spec: dict[str, Any] = {'issue': 1} if paths is None else {'issue': 1, 'paths': paths}
    status, body = call(board, COORDINATOR, op='post', role='fixer', title='Fix the page size', spec=spec)
    assert status == 200
    return body['task']['task_id']


# --- the coordinate task ----------------------------------------------------------------------------------------

def test_the_run_start_writes_the_coordinate_task_for_the_coordinator_alone(run: Board) -> None:
    assert not any(isinstance(value, dict) for item in run.store.coordinate_items(WS, RUN, at=AT)
                   for value in item.values())   # (plain values: the resource client serializes them)
    task = run.store.task(WS, RUN, COORDINATE_TASK)
    assert (task.role, task.state, task.attempt, task.posted_by) == ('coordinator', 'open', 1, 'run-start')
    assert run.store.history(WS, RUN)[COORDINATE_TASK][0].op == 'start'
    status, _ = call(run, FIXER, op='claim', task_id=COORDINATE_TASK)
    assert status == 403
    status, body = call(run, COORDINATOR, op='claim', task_id=COORDINATE_TASK)
    assert (status, body['task']['lease']['agent']) == (200, 'coordinator-1')
    assert call(run, COORDINATOR, op='renew', task_id=COORDINATE_TASK, epoch=1)[0] == 200
    assert call(run, COORDINATOR, op='progress', task_id=COORDINATE_TASK, epoch=1, step='Planning')[0] == 200


def test_the_coordinate_task_records_the_coordinator_its_start_launched(run: Board) -> None:
    task = run.store.task(WS, RUN, COORDINATE_TASK)
    assert (task.launched_agent, task.launched_attempt, task.launched_paths, task.launched_language) == (
        'coordinator-1', 1, (), '')


def test_a_coordinator_dead_before_its_claim_is_reposted_and_the_runtime_launches_the_next(run: Board) -> None:
    """A person's Resume of a run whose coordinator is gone: the runtime re-posts the coordinate task at the attempt
    it judged, then records a new coordinator on it (``launch_coordinator``), never through a board op."""
    reposted = run.store.repost(WS, RUN, COORDINATE_TASK, reason='the coordinator is gone', attempt=1)
    assert (reposted.state, reposted.attempt) == ('open', 2)
    with pytest.raises(BoardError, match='attempt 2, not 1'):
        run.store.launch_coordinator(WS, RUN, attempt=1)   # (a Resume judging the attempt before: fenced)
    launched = run.store.launch_coordinator(WS, RUN, attempt=2)
    again = run.store.launch_coordinator(WS, RUN, attempt=2)   # (a retried Resume: the same coordinator)
    assert (launched.task.launched_agent, launched.task.launched_attempt, launched.reused, again.reused,
            again.task.launched_agent) == ('coordinator-2', 2, False, True, 'coordinator-2')
    last = run.store.history(WS, RUN)[COORDINATE_TASK][-1]
    assert (last.op, last.actor, last.reason) == ('launch', 'runtime', 'launched coordinator-2')
    # The board's own launch op still refuses the coordinator's role, even to the run's current coordinator.
    assert call(run, Caller('coordinator', RUN, 2), op='launch', task_id=COORDINATE_TASK, role='coordinator',
                language='py', paths=[])[0] == 400


def test_a_replaced_coordinator_is_refused_every_op_and_the_new_one_works(run: Board) -> None:
    """After the runtime re-posts the coordinate task and records a new coordinator, the old one's session (still
    alive, say) can no longer post, list, launch, read knowledge, read its inbox or claim the coordinate task."""
    task_id = fixer_task(run)

    def old_ones() -> list[tuple[int, bool]]:
        answers = [call(run, COORDINATOR, op='post', role='fixer', title='More', spec={'issue': 2}),
                   call(run, COORDINATOR, op='tasks'),
                   call(run, COORDINATOR, op='launch', task_id=task_id, role='fixer', language='py', paths=[]),
                   call(run, COORDINATOR, op='knowledge', package=''),
                   call(run, COORDINATOR, op='inbox', after=0),
                   call(run, COORDINATOR, op='claim', task_id=COORDINATE_TASK)]
        return [(status, 'another coordinator' in body['error']) for status, body in answers]

    run.store.repost(WS, RUN, COORDINATE_TASK, reason='the coordinator is gone', attempt=1)
    # Between the re-post and the new coordinator's record, the old one is no longer the run's either.
    assert old_ones() == [(403, True)] * 6
    run.store.launch_coordinator(WS, RUN, attempt=2)
    assert old_ones() == [(403, True)] * 6
    new = Caller('coordinator', RUN, 2)
    assert call(run, new, op='claim', task_id=COORDINATE_TASK)[0] == 200
    assert call(run, new, op='tasks')[0] == 200


def test_the_supervisors_repost_of_the_coordinate_task_publishes_nothing(run: Board) -> None:
    """No role reads a task.posted for it (the bus has no queue role coordinator): written, never published."""
    bus = Bus()
    supervisor = EventBridgePublisher(bus, 'voc-engineering', 'voc.engineering/supervisor')
    other = fixer_task(run)
    call(run, FIXER, op='claim', task_id=other)
    task = repost_task(run.store, supervisor, WS, RUN, COORDINATE_TASK, 'the coordinator kept crashing', 1)
    assert (task.state, task.attempt, bus.entries) == ('open', 2, [])
    repost_task(run.store, supervisor, WS, RUN, other, 'the lease ran out', 1)
    assert [message.type for message in bus.messages()] == ['task.posted']   # (any other task: as before)


def test_the_coordinate_tasks_claim_checks_its_coordinator_in_the_write_itself(run: Board) -> None:
    """A re-post landing between the API's check and the claim: the store's own condition refuses the old one."""
    run.store.repost(WS, RUN, COORDINATE_TASK, reason='the coordinator is gone', attempt=1)
    run.store.launch_coordinator(WS, RUN, attempt=2)
    with pytest.raises(BoardError, match='not open'):
        run.store.claim(WS, RUN, COORDINATE_TASK, role='coordinator', agent='coordinator-1')
    assert run.store.claim(WS, RUN, COORDINATE_TASK, role='coordinator', agent='coordinator-2').lease_agent == \
        'coordinator-2'


def test_a_new_coordinator_is_only_for_an_open_coordinate_task(run: Board) -> None:
    assert call(run, COORDINATOR, op='claim', task_id=COORDINATE_TASK)[0] == 200
    with pytest.raises(BoardError, match='only an open task'):
        run.store.launch_coordinator(WS, RUN, attempt=1)


def test_the_stores_own_launch_never_numbers_a_coordinator(run: Board) -> None:
    """The store's guard, below the API's role check: only ``launch_coordinator`` records one."""
    with pytest.raises(BoardError, match='comes from the run, never from a launch'):
        run.store.launch(WS, RUN, COORDINATE_TASK, role='coordinator', actor='coordinator-1')
    meta = run.client.get_item(TableName=TABLE, Key={'pk': {'S': run_pk(WS, RUN)}, 'sk': {'S': 'META'}})['Item']
    assert meta['agent_count'] == {'N': '1'}   # (no number taken)


def test_nobody_posts_a_coordinate_task_and_the_coordinator_claims_nothing_else(run: Board) -> None:
    assert call(run, COORDINATOR, op='post', role='coordinator', title='x', spec={'a': 1})[0] == 403
    with pytest.raises(BoardError):
        run.store.post(WS, RUN, role='coordinator', title='x', spec={'a': 1}, parent_task='', priority=0, actor='x')
    task_id = fixer_task(run)
    assert call(run, COORDINATOR, op='claim', task_id=task_id)[0] == 403


# --- the claim answered again for its live holder ---------------------------------------------------------------

def test_the_holder_claiming_again_reads_its_task_and_epoch_until_it_ends(run: Board) -> None:
    task_id = fixer_task(run)
    assert call(run, FIXER, op='claim', task_id=task_id)[0] == 200
    for to in ('in_progress', 'in_review'):
        assert call(run, FIXER, op='move', task_id=task_id, epoch=1, to=to)[0] == 200
        status, body = call(run, FIXER, op='claim', task_id=task_id)
        assert (status, body['task']['state'], body['task']['lease']['epoch']) == (200, to, 1)
    assert call(run, Caller('fixer', RUN, 2), op='claim', task_id=task_id)[0] == 409   # (another agent)
    assert call(run, FIXER, op='move', task_id=task_id, epoch=1, to='done')[0] == 200
    assert call(run, FIXER, op='claim', task_id=task_id)[0] == 409   # (an ended task)


# --- tasks ------------------------------------------------------------------------------------------------------

def test_only_the_coordinator_lists_its_runs_tasks(run: Board) -> None:
    task_id = fixer_task(run)
    status, body = call(run, COORDINATOR, op='tasks')
    assert status == 200
    assert {(t['task_id'], t['role'], t['state'], t['attempt']) for t in body['tasks']} == {
        (COORDINATE_TASK, 'coordinator', 'open', 1), (task_id, 'fixer', 'open', 1)}
    assert call(run, FIXER, op='tasks')[0] == 403


# --- launch -----------------------------------------------------------------------------------------------------

def test_the_coordinator_launches_an_agent_for_an_open_task_once(run: Board) -> None:
    task_id = fixer_task(run)
    status, body = call(run, COORDINATOR, op='launch', task_id=task_id, role='fixer', language='python',
                        paths=['services/billing'])
    assert (status, body) == (200, {'agent_id': 'fixer-2', 'status': 'booting'})
    (request,) = run.launcher.requests
    assert request == {'run_id': RUN, 'agent_id': 'fixer-2', 'role': 'fixer', 'task_id': task_id, 'attempt': 1,
                       'language': 'python', 'paths': ['services/billing'], 'commit': 'a' * 40,
                       'connection': 'repo-1'}
    last = run.store.history(WS, RUN)[task_id][-1]
    assert (last.op, last.actor, last.reason) == ('launch', 'coordinator-1', 'launched fixer-2')
    again = call(run, COORDINATOR, op='launch', task_id=task_id, role='fixer', language='python', paths=[])
    assert again[1]['agent_id'] == 'fixer-2'   # (a retry: the same agent, no second number)
    assert run.launcher.requests[-1]['paths'] == ['services/billing']   # (with the paths it was launched on)
    other = fixer_task(run, ['x'])
    assert call(run, COORDINATOR, op='launch', task_id=other, role='fixer', language='go', paths=[])[1][
        'agent_id'] == 'fixer-3'


def test_a_reposted_task_gets_a_new_agent_at_its_new_attempt(run: Board) -> None:
    task_id = fixer_task(run)
    launch = {'op': 'launch', 'task_id': task_id, 'role': 'fixer', 'language': 'py', 'paths': []}
    assert call(run, COORDINATOR, **launch)[1]['agent_id'] == 'fixer-2'
    call(run, FIXER, op='claim', task_id=task_id)
    run.store.repost(WS, RUN, task_id, reason='the lease ran out', attempt=1)
    status, body = call(run, COORDINATOR, **launch)
    assert (status, body['agent_id']) == (200, 'fixer-3')
    assert run.launcher.requests[-1]['attempt'] == 2
    task = run.store.task(WS, RUN, task_id)
    assert (task.launched_agent, task.launched_attempt) == ('fixer-3', 2)


def test_a_launched_agent_that_never_claimed_is_reposted_and_the_next_launch_is_a_new_agent(run: Board) -> None:
    """The agent died or stalled before its claim: the task is still open at the attempt it was launched at."""
    task_id = fixer_task(run)
    launch = {'op': 'launch', 'task_id': task_id, 'role': 'fixer', 'language': 'py', 'paths': []}
    call(run, COORDINATOR, **launch)
    task = run.store.repost(WS, RUN, task_id, reason='crashed before its claim', attempt=1)
    assert (task.state, task.attempt) == ('open', 2)
    assert call(run, COORDINATOR, **launch)[1]['agent_id'] == 'fixer-3'
    never = fixer_task(run, ['other'])   # (open, no agent launched: nothing to re-post)
    with pytest.raises(BoardError):
        run.store.repost(WS, RUN, never, reason='x', attempt=1)


@pytest.mark.parametrize('missing', ['commit', 'connection'])
def test_a_launch_before_the_run_start_recorded_its_commit_and_connection_records_nothing(run: Board,
                                                                                          missing: str) -> None:
    task_id = fixer_task(run)
    run.store.client.update_item(TableName=TABLE, Key={'pk': {'S': run_pk(WS, RUN)}, 'sk': {'S': 'META'}},
                                 UpdateExpression='REMOVE #n', ExpressionAttributeNames={'#n': missing})
    status, body = call(run, COORDINATOR, op='launch', task_id=task_id, role='fixer', language='py', paths=[])
    assert (status, 'no commit or repository connection' in body['error']) == (503, True)
    task = run.store.task(WS, RUN, task_id)
    assert (task.launched_agent, run.launcher.requests, run.store.history(WS, RUN)[task_id][-1].op) == ('', [], 'post')


def test_a_retried_launch_keeps_the_language_it_was_launched_with(run: Board) -> None:
    task_id = fixer_task(run)
    call(run, COORDINATOR, op='launch', task_id=task_id, role='fixer', language='python', paths=[])
    call(run, COORDINATOR, op='launch', task_id=task_id, role='fixer', language='rust', paths=[])
    assert [request['language'] for request in run.launcher.requests] == ['python', 'python']


def test_a_launch_on_a_task_no_longer_open_never_reaches_the_runtime(run: Board) -> None:
    task_id = fixer_task(run)
    launch = {'op': 'launch', 'task_id': task_id, 'role': 'fixer', 'language': 'py', 'paths': []}
    call(run, COORDINATOR, **launch)
    call(run, FIXER, op='claim', task_id=task_id)
    assert call(run, FIXER, op='move', task_id=task_id, epoch=1, to='in_progress')[0] == 200
    assert call(run, COORDINATOR, **launch)[0] == 409   # (an agent recorded, but the task is in progress)
    assert len(run.launcher.requests) == 1


@pytest.mark.parametrize(('caller', 'body', 'status'), [
    (FIXER, {'role': 'fixer', 'language': 'python', 'paths': []}, 403),
    (COORDINATOR, {'role': 'hunter', 'language': 'python', 'paths': []}, 400),   # (not the task's role)
    (COORDINATOR, {'role': 'coordinator', 'language': 'python', 'paths': []}, 400),
    (COORDINATOR, {'role': 'fixer', 'language': 'x' * 41, 'paths': []}, 400),
    (COORDINATOR, {'role': 'fixer', 'language': 'python', 'paths': ['/etc']}, 400),
    (COORDINATOR, {'role': 'fixer', 'language': 'python', 'paths': ['a/../b']}, 400),
    (COORDINATOR, {'role': 'fixer', 'language': 'python', 'paths': ['p'] * 51}, 400),
])
def test_a_launch_is_the_coordinators_for_a_task_of_that_role(run: Board, caller: Caller, body: dict[str, Any],
                                                              status: int) -> None:
    task_id = fixer_task(run)
    assert call(run, caller, op='launch', task_id=task_id, **body)[0] == status
    assert run.launcher.requests == []


def test_only_an_open_task_gets_an_agent_and_a_run_launches_at_most_999(run: Board) -> None:
    task_id = fixer_task(run)
    call(run, FIXER, op='claim', task_id=task_id)
    assert call(run, COORDINATOR, op='launch', task_id=task_id, role='fixer', language='py', paths=[])[0] == 409
    run.client.update_item(TableName=TABLE, Key={'pk': {'S': run_pk(WS, RUN)}, 'sk': {'S': 'META'}},
                           UpdateExpression='SET agent_count = :n', ExpressionAttributeValues={':n': {'N': str(MAX_AGENTS)}})
    fresh = fixer_task(run, ['y'])
    assert call(run, COORDINATOR, op='launch', task_id=fresh, role='fixer', language='py', paths=[])[0] == 429



def test_the_lambda_launcher_reaches_the_runtimes_launch_action_only() -> None:
    client = LambdaClient({'status': 'booting'})
    assert LambdaLauncher(client, 'voc-engineering-runtime').launch({'action': 'tick', 'run_id': RUN}) == {
        'status': 'booting'}
    (request,) = client.requests
    assert (request['FunctionName'], json.loads(request['Payload'])['action']) == ('voc-engineering-runtime', 'launch')


def _runtime_error(error_type: str) -> LambdaLauncher:
    return LambdaLauncher(LambdaClient({'errorType': error_type, 'errorMessage': f'{error_type}: no'}, 'Unhandled'), 'f')


@pytest.mark.parametrize('error_type', ['RuntimeRefused', 'RunNotActive', 'RunExists', 'RunStopped', 'SessionBusy'])
def test_each_runtime_refusal_is_a_conflict_with_its_message(run: Board, error_type: str) -> None:
    run.api.launcher = _runtime_error(error_type)
    status, body = call(run, COORDINATOR, op='launch', task_id=fixer_task(run), role='fixer', language='py', paths=[])
    assert (status, body['error']) == (409, f'{error_type}: no')


@pytest.mark.parametrize('error_type', ['KeyError', 'MicroVmCallFailed', 'StaleSession'])
def test_the_runtime_failing_is_unavailable(run: Board, error_type: str) -> None:
    run.api.launcher = _runtime_error(error_type)   # (a session there for an agent just numbered: not a retry)
    assert call(run, COORDINATOR, op='launch', task_id=fixer_task(run), role='fixer', language='py', paths=[])[0] == 503
    run.api.launcher = None
    assert call(run, COORDINATOR, op='launch', task_id=fixer_task(run, ['z']), role='fixer', language='py',
                paths=[])[0] == 503


def test_a_retried_launch_whose_session_exists_already_is_launched(run: Board) -> None:
    task_id = fixer_task(run)
    launch = {'op': 'launch', 'task_id': task_id, 'role': 'fixer', 'language': 'py', 'paths': []}
    run.api.launcher = LambdaLauncher(LambdaClient({}, 'Unhandled'), 'f')   # (the answer lost: 503)
    assert call(run, COORDINATOR, **launch)[0] == 503
    run.api.launcher = _runtime_error('StaleSession')   # (the first try's session got through)
    assert call(run, COORDINATOR, **launch) == (200, {'agent_id': 'fixer-2', 'status': 'launched'})


# --- knowledge --------------------------------------------------------------------------------------------------

def test_an_agent_reads_the_pack_of_its_own_tasks_paths_or_the_root(run: Board) -> None:
    task_id = fixer_task(run, ['services/billing'])
    assert call(run, FIXER, op='knowledge', package='')[0] == 403   # (no task held yet)
    call(run, FIXER, op='claim', task_id=task_id)
    for package, read in (('', '.'), ('services/billing', 'services/billing')):   # (the root is the store's '.')
        status, body = call(run, FIXER, op='knowledge', package=package)
        assert (status, body) == (200, {'version': 3, 'text': f'<<DATA {read}>>'})
        assert run.knowledge.reads[-1] == (WS, 'repo-1', read)
    assert call(run, FIXER, op='knowledge', package='crates/ledger')[0] == 403
    assert call(run, FIXER, op='knowledge', package=7)[0] == 400


def test_an_agent_reads_the_packs_of_the_paths_it_was_launched_on(run: Board) -> None:
    task_id = fixer_task(run, ['services/billing'])
    call(run, COORDINATOR, op='launch', task_id=task_id, role='fixer', language='py', paths=['crates/ledger', 'bad'])
    call(run, FIXER, op='claim', task_id=task_id)
    assert call(run, FIXER, op='knowledge', package='crates/ledger')[1] == {'version': 3,
                                                                            'text': '<<DATA crates/ledger>>'}
    assert call(run, FIXER, op='knowledge', package='services/billing')[0] == 200
    status, body = call(run, FIXER, op='knowledge', package='bad')   # (the store refuses the package: 400)
    assert (status, 'not a valid package' in body['error']) == (400, True)


@pytest.mark.parametrize('package', sorted(FAULTS))
def test_a_pack_the_store_cannot_read_answers_503_not_the_callers_fault(run: Board, package: str) -> None:
    task_id = fixer_task(run, [package])
    call(run, FIXER, op='claim', task_id=task_id)
    status, body = call(run, FIXER, op='knowledge', package=package)
    assert (status, 'cannot be read right now' in body['error']) == (503, True)


def test_the_real_pack_store_reads_the_roots_pack_and_refuses_a_bad_package() -> None:
    long = 'p' * 301   # (a repository path, but longer than a package the store can key)
    with pack_tables() as (client, _s3, workspace):
        packs = PackStore(client, TABLE, workspace)
        root = reduce_package(ROOT, [Note('convention', ROOT, 'Two spaces.', ('a' * 40,), 'style')])
        version = packs.publish(WS, 'repo-1', root, author=Actor('understander-0', 'agent'), reason='refresh',
                                built_from='a' * 40).version
        packs.approve(WS, 'repo-1', ROOT, version, Actor('admin-1', 'person', admin=True))
        board = _board(client, packs)
        call(board, FIXER, op='claim', task_id=fixer_task(board, [long]))
        status, body = call(board, FIXER, op='knowledge', package='')
        assert (status, body['version'], 'Two spaces.' in body['text']) == (200, version, True)
        assert call(board, FIXER, op='knowledge', package=long)[0] == 400


def test_the_coordinator_reads_the_root_and_none_approved_is_a_null_version(run: Board) -> None:
    assert call(run, COORDINATOR, op='knowledge', package='')[1] == {'version': 3, 'text': '<<DATA .>>'}
    run.api.knowledge = Knowledge()
    run.store.client.update_item(TableName=TABLE, Key={'pk': {'S': run_pk(WS, RUN)}, 'sk': {'S': 'META'}},
                                 UpdateExpression='REMOVE #n', ExpressionAttributeNames={'#n': 'connection'})
    status, body = call(run, COORDINATOR, op='knowledge', package='')   # (no connection recorded: never 'none approved')
    assert (status, 'no repository connection' in body['error']) == (503, True)
    run.api.knowledge = None
    assert call(run, COORDINATOR, op='knowledge', package='')[0] == 503


def test_a_package_with_no_approved_pack_answers_a_null_version(run: Board) -> None:
    task_id = fixer_task(run, ['none'])
    call(run, FIXER, op='claim', task_id=task_id)
    assert call(run, FIXER, op='knowledge', package='none')[1] == {'version': None}
