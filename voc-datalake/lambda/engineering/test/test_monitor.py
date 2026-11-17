"""The run monitor: the overview of a run (its agents as the supervisor's session rows hold them, their tokens and
session time, the totals, and what of it can be reached from here, each by its own flag), and a person's signals
(checked against the attempt they saw, then sent through voc-engineering-start, which records and hands them on: never
said on the bus, 7.51.02), their Stop, and their answers and steering (the bus)."""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

import pytest
from botocore.exceptions import ClientError

from engineering.board.store import BoardStore
from engineering.board.test.table import RUN, TABLE, board, engineering_table
from engineering.bus.schema import Message, Party, parse
from engineering.bus.test.messages import message
from engineering.conversation.store import ConversationStore
from engineering.monitor import (
    MAX_LINE,
    Actor,
    LambdaSignaller,
    LambdaStopper,
    MonitorError,
    RunMonitor,
    Signal,
    parse_message,
    parse_signal,
    parse_steer,
    parse_stop,
)
from engineering.rows import run_pk
from engineering.runtime.sessions import AgentSession
from engineering.test.run_fixture import FIXER, LambdaClient
from engineering.views_thread import TAIL

ADMIN = Actor('admin-sub', 'ada')
START = datetime(2026, 11, 12, 9, 0, tzinfo=UTC)
COORDINATOR = replace(FIXER, agent_id='coordinator-1', role='coordinator', task_id='', status='waiting',
                      microvm_seconds=0, tokens={'model-a': {'in': 50, 'out': 5}, 'model-b': {'in': 7, 'out': 1}},
                      inspect={'stuck_why': 'x' * 400, 'heartbeat_age': True})


class Publisher:
    """Records what it is given; ``fail`` makes the bus refuse it."""

    def __init__(self) -> None:
        self.sent: list[Message] = []
        self.fail: Exception | None = None

    def publish(self, message: Message) -> None:
        checked = parse(message.to_dict())
        if self.fail is not None:
            raise self.fail
        self.sent.append(checked)


class Sessions:
    def __init__(self, *sessions: AgentSession) -> None:
        self.sessions = list(sessions)

    def of_run(self, run_id: str) -> list[AgentSession]:
        return [session for session in self.sessions if session.run_id == run_id]


class Signaller:
    """voc-engineering-start's ``signal_run`` as the monitor calls it: records each call (the agent, the signal, the
    attempt, who, a restart's start, the note), answers it sent (``fail``: it raises)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, int]] = []
        self.fail: Exception | None = None
        self.actors: list[str] = []
        self.restarts: list[str] = []
        self.notes: list[str] = []

    def signal(self, run_id: str, signal: Signal, *, actor: str, agent_id: str = '') -> dict[str, Any]:
        if self.fail is not None:
            raise self.fail
        self.calls.append((run_id, agent_id, signal.name, signal.attempt))
        self.actors.append(actor)
        self.restarts.append(signal.restart_from)
        self.notes.append(signal.note)
        return {'run_id': run_id, 'signal': signal.name, 'status': 'sent', 'at': '2026-11-12T09:00:00Z'}


@pytest.fixture
def run() -> Iterator[tuple[Any, RunMonitor, Signaller, Publisher, str]]:
    """A run with a goal, a claimed task, two agent sessions, the monitor, its signaller and its publisher."""
    with engineering_table() as client:
        client.update_item(TableName=TABLE, Key={'pk': {'S': run_pk('default', RUN)}, 'sk': {'S': 'META'}},
                           UpdateExpression='SET goal = :g, repo = :r, flow = :f, #s = :s, started_at = :t, msg_seq = :m',
                           ExpressionAttributeNames={'#s': 'status'},
                           ExpressionAttributeValues={':g': {'S': 'Fix the paging bug'}, ':r': {'S': 'example/shop'},
                                                      ':f': {'S': 'wf_bugfix'}, ':s': {'S': 'running'},
                                                      ':t': {'S': '2026-11-12T08:00:00Z'}, ':m': {'N': '12'}})
        tasks = board(client)
        task = tasks.post('default', RUN, role='fixer', title='Fix the page size', spec={'issue': 7}, parent_task='',
                          priority=1, actor='coordinator-1').task
        tasks.claim('default', RUN, task.task_id, role='fixer', agent='fixer-1')
        signaller, publisher = Signaller(), Publisher()
        monitor = RunMonitor(client, TABLE, Sessions(FIXER, COORDINATOR), signaller=signaller, publisher=publisher,
                             now=lambda: START)
        yield client, monitor, signaller, publisher, task.task_id


@pytest.mark.parametrize(('fields', 'budget'), [
    ({':b': {'S': '50.0'}, ':a': {'N': '0'}, ':m': {'S': ''}}, {'monthly_usd': 50.0, 'alert_percent': None,
                                                               'alert_month': None}),
    ({':b': {'S': '50.0'}, ':a': {'N': '150'}, ':m': {'S': '2026-11'}}, {'monthly_usd': 50.0, 'alert_percent': 150,
                                                                       'alert_month': '2026-11'}),
    ({':b': {'S': 'lots'}, ':a': {'N': '80'}, ':m': {'S': '2026-11'}}, None),   # (unreadable: no budget shown)
])
def test_the_overview_shows_the_runs_flow_budget_and_its_flag(run, fields: dict[str, Any], budget: Any) -> None:
    client, monitor, _, _, _ = run
    client.update_item(TableName=TABLE, Key={'pk': {'S': run_pk('default', RUN)}, 'sk': {'S': 'META'}},
                       UpdateExpression='SET budget_usd = :b, budget_alert = :a, budget_alert_month = :m',
                       ExpressionAttributeValues=fields)
    view = monitor.overview(RUN)
    assert view is not None
    assert view['run']['budget'] == budget


def test_the_overview_shows_the_run_and_its_agents_as_the_supervisor_saw_them(run) -> None:
    _, monitor, _, _, _ = run
    view = monitor.overview(RUN)
    assert view is not None
    assert view['run'] == {'run_id': RUN, 'goal': 'Fix the paging bug', 'repo': 'example/shop', 'flow': 'wf_bugfix',
                           'status': 'running', 'started_at': '2026-11-12T08:00:00Z', 'ended_at': None,
                           'budget': None, 'flow_revision': None, 'flow_copied_at': None, 'flow_definition': None,
                           'flow_steps': None, 'flow_outcome': None,   # (a run started without a flow: nothing to light)
                           'expansion': [],   # (7.52.00: no flow, so no call expanded)
                           'issue': None, 'pull_request': None,   # (started from no issue, no pull request yet)
                           'waiting_at': '', 'waiting_detail': None,   # (at no person's decision point)
                           'stop': None,   # (nobody stopped it)
                           # (7.51.00: no session row priced yet, no cap, no parent; a live run has no manifest)
                           'cost_usd': 0.0, 'learn_cost_usd': 0.0, 'cost_cap_usd': None, 'parent': None,
                           'manifest': None}
    coordinator, fixer = view['agents']
    assert fixer == {
        'agent': 'fixer-1', 'role': 'fixer', 'task_id': 'task-1', 'status': 'working', 'continuation': 0,
        'started_at': 1000, 'step': 'fix', 'microvm_state': 'running', 'microvm_age': 600, 'heartbeat_age': 30,
        'last_progress_at': 1500, 'stuck_why': None, 'recent_tools': ['read_file', 'run_tests'],
        'microvm_seconds': 300, 'tokens': [{'model': 'model-a', 'input_tokens': 1000, 'output_tokens': 200}],
        # (7.51.00: its session row's cost and labels, none written here; its attempt, commit and thread's tail)
        'cost_usd': 0.0, 'attempt': 1, 'commit': 'a' * 40, 'skill_label': None, 'model': None,
        'card': None, 'card_version': None,   # (7.52.00: a role's own step, made from no Registry card)
        'transcript_cursor': TAIL, 'last_exit': None, 'last_failure': None}   # (7.51.04: it has not failed)
    assert (view['lanes'], view['gates'], view['children']) == ({}, {}, [])
    assert (coordinator['task_id'], coordinator['heartbeat_age'], len(coordinator['stuck_why'])) == (None, None, MAX_LINE)
    assert view['totals'] == {'messages': 12, 'microvm_seconds': 300, 'by_model': [
        {'model': 'model-a', 'input_tokens': 1050, 'output_tokens': 205},
        {'model': 'model-b', 'input_tokens': 7, 'output_tokens': 1}]}
    # (this monitor reaches the start function's signals and the bus; it names no Stop; no board action reaches a run)
    assert [view[flag] for flag in FLAGS] == [True, True, False, False]
    assert 'actions_available' not in view


#: What of a run can be reached from here (7.51.02), each by its own flag.
FLAGS = ('steer_available', 'signals_available', 'stop_available', 'board_available')


@pytest.mark.parametrize(('signals', 'bus', 'stop', 'flags'), [
    (True, False, False, [False, True, False, False]),
    (False, True, False, [True, False, False, False]),
    (False, False, True, [False, False, True, False]),
    (True, True, True, [True, True, True, False]),
    (False, False, False, [False, False, False, False]),
])
def test_the_overview_says_what_reaches_the_run_each_by_its_own_flag(run, signals: bool, bus: bool, stop: bool,
                                                                      flags: list[bool]) -> None:
    client, _, signaller, publisher, _ = run
    monitor = RunMonitor(client, TABLE, Sessions(FIXER), signaller=signaller if signals else None,
                         publisher=publisher if bus else None, stopper=Stopper() if stop else None)
    view = monitor.overview(RUN)
    assert view is not None
    assert [view[flag] for flag in FLAGS] == flags


def test_a_persons_board_actions_reach_no_run_since_the_api_says_only_steering_and_answers(run) -> None:
    """Their task.* events would go out from the API's source, which the bus does not take from it (7.51.02)."""
    _, monitor, _, publisher, _ = run
    assert monitor.board_available is False
    with pytest.raises(MonitorError, match='board actions cannot reach the run') as refused:
        monitor.board_bus()
    assert (refused.value.kind, publisher.sent) == ('unavailable', [])


def test_an_unknown_run_has_no_overview() -> None:
    with engineering_table() as client:
        monitor = RunMonitor(client, TABLE, Sessions(), signaller=None, publisher=None)
        assert monitor.overview('01JD0000000000000000000009') is None
        view = monitor.overview(RUN)
        assert view is not None
        assert (view['agents'], view['totals']['messages']) == ([], 0)


def test_a_signal_to_an_agent_goes_through_the_start_function_at_the_attempt_seen(run) -> None:
    _, monitor, signaller, publisher, task_id = run
    sent = monitor.signal(RUN, parse_signal({'signal': 'pause', 'task_id': task_id, 'attempt': 1,
                                             'note': ' Holding for the review '}), ADMIN)
    # The agent holding the task at the attempt seen, who sent it and why: the start function records it (D4).
    assert (signaller.calls, signaller.actors, signaller.notes) == (
        [(RUN, 'fixer-1', 'pause', 1)], [ADMIN.subject], ['Holding for the review'])
    assert sent == {'signal': 'pause', 'target': {'kind': 'agent', 'id': 'fixer-1'}, 'attempt': 1, 'status': 'sent',
                    'agents': {}, 'applied': {}, 'at': '2026-11-12T09:00:00Z'}
    # Nothing is said on the bus: the API's source says only steering and answers (7.51.02).
    assert publisher.sent == []


def test_a_signal_to_the_whole_run_names_no_agent(run) -> None:
    _, monitor, signaller, publisher, _ = run
    sent = monitor.signal(RUN, parse_signal({'signal': 'save'}), ADMIN)
    assert (signaller.calls, sent['target'], publisher.sent) == ([(RUN, '', 'save', 0)], {'kind': 'run', 'id': RUN}, [])


def test_a_signal_for_an_attempt_that_moved_on_is_refused_before_anything_is_done(run) -> None:
    client, monitor, signaller, publisher, task_id = run
    with pytest.raises(MonitorError) as stale:
        monitor.signal(RUN, parse_signal({'signal': 'shutdown', 'task_id': task_id, 'attempt': 2}), ADMIN)
    with pytest.raises(MonitorError) as missing:
        monitor.signal(RUN, parse_signal({'signal': 'shutdown', 'task_id': 'task-9', 'attempt': 1}), ADMIN)
    tasks = board(client)
    tasks.move('default', RUN, task_id, agent='fixer-1', epoch=1, to_state='in_progress', result_keys=[])
    tasks.move('default', RUN, task_id, agent='fixer-1', epoch=1, to_state='done', result_keys=[])
    with pytest.raises(MonitorError) as ended:   # (its lease stays on a done task: the state says it has ended)
        monitor.signal(RUN, parse_signal({'signal': 'pause', 'task_id': task_id, 'attempt': 1}), ADMIN)
    assert (stale.value.kind, missing.value.kind, ended.value.kind) == ('conflict', 'not_found', 'conflict')
    assert (signaller.calls, publisher.sent) == ([], [])


def test_an_open_task_has_no_agent_to_signal(run) -> None:
    client, monitor, signaller, _, _ = run
    task = BoardStore(client, TABLE, new_id=lambda: 'task-open').post(
        'default', RUN, role='fixer', title='Another', spec={'issue': 8}, parent_task='', priority=1,
        actor='coordinator-1').task
    with pytest.raises(MonitorError) as open_task:
        monitor.signal(RUN, parse_signal({'signal': 'pause', 'task_id': task.task_id, 'attempt': 1}), ADMIN)
    assert (open_task.value.kind, signaller.calls) == ('conflict', [])


def test_an_ended_or_unknown_run_takes_no_action(run) -> None:
    client, monitor, signaller, publisher, _ = run
    with pytest.raises(MonitorError) as unknown:
        monitor.signal('01JD0000000000000000000009', parse_signal({'signal': 'save'}), ADMIN)
    client.update_item(TableName=TABLE, Key={'pk': {'S': run_pk('default', RUN)}, 'sk': {'S': 'META'}},
                       UpdateExpression='SET ended_at = :e', ExpressionAttributeValues={':e': {'S': '2026-11-12T09:30:00Z'}})
    with pytest.raises(MonitorError) as ended:
        monitor.message(RUN, parse_message({'to': 'conductor', 'text': 'Hello'}, RUN), ADMIN)
    assert (unknown.value.kind, ended.value.kind, signaller.calls, publisher.sent) == (
        'not_found', 'conflict', [], [])


@pytest.mark.parametrize(('body', 'says'), [
    ({'signal': 'reboot'}, 'signal is one of'),
    ({'signal': 'stop_now'}, 'confirm: true'),
    ({'signal': 'stop_now', 'confirm': 'yes'}, 'confirm: true'),
    ({'signal': 'save', 'attempt': 1}, 'attempt goes with a task_id'),
    ({'signal': 'save', 'task_id': 'a b', 'attempt': 1}, 'task_id is a task id'),
    ({'signal': 'save', 'task_id': 'task-1'}, 'the attempt you saw'),
    ({'signal': 'save', 'task_id': 'task-1', 'attempt': True}, 'the attempt you saw'),
    ({'signal': 'save', 'note': 'é' * 251}, 'note is a string'),
    ({'signal': 'save', 'note': 7}, 'note is a string'),
    ({'signal': 'save', 'note': 'the key is AKIA' + 'ABCDEFGHIJKLMNOP'}, 'credential'),
])
def test_a_malformed_signal_says_what_to_send(body: dict[str, Any], says: str) -> None:
    with pytest.raises(MonitorError, match=says) as refused:
        parse_signal(body)
    assert refused.value.kind == 'invalid'


def test_stop_now_with_confirm_is_sent() -> None:
    assert parse_signal({'signal': 'stop_now', 'confirm': True}).name == 'stop_now'


def test_a_signal_the_start_function_cannot_take_says_so(run) -> None:
    _, monitor, signaller, publisher, _ = run
    signaller.fail = MonitorError('unavailable', 'The run could not be reached: send the signal again')
    with pytest.raises(MonitorError, match='send the signal again') as down:
        monitor.signal(RUN, parse_signal({'signal': 'resume'}), ADMIN)
    signaller.fail = MonitorError('conflict', 'run R is being stopped: it takes no other signal')
    with pytest.raises(MonitorError, match='being stopped') as stopping:
        monitor.signal(RUN, parse_signal({'signal': 'resume'}), ADMIN)
    assert (down.value.kind, stopping.value.kind, publisher.sent) == ('unavailable', 'conflict', [])


def test_without_the_start_function_the_signals_are_unavailable_and_without_the_bus_the_words(run) -> None:
    client, _, signaller, publisher, _ = run
    with pytest.raises(MonitorError, match='names no start function') as unsignalled:
        RunMonitor(client, TABLE, Sessions(FIXER), signaller=None, publisher=publisher).signal(
            RUN, parse_signal({'signal': 'save'}), ADMIN)
    unconnected = RunMonitor(client, TABLE, Sessions(FIXER), signaller=signaller, publisher=None)
    with pytest.raises(MonitorError) as unsent:
        unconnected.message(RUN, parse_message({'to': 'conductor', 'text': 'Hi'}, RUN), ADMIN)
    with pytest.raises(MonitorError) as unsteered:
        unconnected.steer(RUN, parse_steer({'text': 'Hi'}), ADMIN)
    assert [refused.value.kind for refused in (unsignalled, unsent, unsteered)] == ['unavailable'] * 3
    # Each needs its own wiring only: the signals reach the run without the bus.
    assert unconnected.signal(RUN, parse_signal({'signal': 'save'}), ADMIN)['status'] == 'sent'
    assert (signaller.calls, publisher.sent) == ([(RUN, '', 'save', 0)], [])


def _asks(client: Any, thread: str, agent: str = 'fixer-1') -> None:
    """The agent's question on ``thread``, in the conversation as the router writes it."""
    ConversationStore(client, TABLE).append_to_conversation(parse(message(
        run_id=RUN, thread_id=thread, **{'from': {'kind': 'agent', 'id': agent}}, to={'kind': 'run', 'id': RUN},
        refs={'s3': []})))


def test_a_person_answers_an_agent_or_the_conductor_in_a_thread(run) -> None:
    client, monitor, _, publisher, _ = run
    _asks(client, 't-7')
    reply = monitor.message(RUN, parse_message({'to': 'agent', 'agent': 'fixer-1', 'text': ' Yes, inclusive. ',
                                                'thread_id': 't-7'}, RUN), ADMIN)
    fresh = monitor.message(RUN, parse_message({'to': 'conductor', 'text': 'Skip the docs task'}, RUN), ADMIN)
    first, second = publisher.sent
    assert (first.type, first.to.kind, first.to.id, first.summary, first.thread_id) == (
        'msg.answer', 'agent', 'fixer-1', 'Yes, inclusive.', 't-7')
    assert (second.to.kind, second.to.id, second.thread_id) == ('conductor', RUN, fresh['thread_id'])
    assert fresh['thread_id'].startswith('human-')
    assert reply['thread_id'] == 't-7'


def test_an_answer_to_an_agent_not_in_the_run_is_refused(run) -> None:
    _, monitor, _, publisher, _ = run
    with pytest.raises(MonitorError) as missing:
        monitor.message(RUN, parse_message({'to': 'agent', 'agent': 'fixer-9', 'text': 'Hi', 'thread_id': 't-1'}, RUN),
                        ADMIN)
    assert (missing.value.kind, publisher.sent) == ('not_found', [])


@pytest.mark.parametrize(('asker', 'thread'), [
    ('', 't-7'),                 # (no question at all)
    ('fixer-1', 't-8'),          # (its question is on another thread)
    ('coordinator-1', 't-7'),    # (another agent's question on that thread)
], ids=['no question', 'another thread', 'another agent'])
def test_an_answer_to_an_agent_goes_only_on_a_thread_its_own_question_opened(run, asker: str, thread: str) -> None:
    # (D51-4, 7.51.00: anything else a person tells an agent is steering, through the orchestrator)
    client, monitor, _, publisher, _ = run
    if asker:
        _asks(client, thread, asker)
    with pytest.raises(MonitorError, match='asked no question on this thread') as refused:
        monitor.message(RUN, parse_message({'to': 'agent', 'agent': 'fixer-1', 'text': 'Yes', 'thread_id': 't-7'}, RUN),
                        ADMIN)
    assert (refused.value.kind, publisher.sent) == ('not_found', [])


def test_an_answer_to_an_agent_names_the_thread_of_its_question() -> None:
    with pytest.raises(MonitorError, match='names the thread_id of its question'):
        parse_message({'to': 'agent', 'agent': 'fixer-1', 'text': 'Yes'}, RUN)


@pytest.mark.parametrize(('body', 'says'), [
    ({'to': 'everyone', 'text': 'Hi'}, 'to is'),
    ({'to': 'agent', 'text': 'Hi'}, 'to is'),
    ({'to': 'conductor', 'text': '  '}, 'text is'),
    ({'to': 'conductor', 'text': 'x' * 1025}, 'text is'),
    ({'to': 'conductor', 'text': 'Hi', 'thread_id': 'a b'}, 'thread_id'),
])
def test_a_malformed_answer_says_what_to_send(body: dict[str, Any], says: str) -> None:
    with pytest.raises(MonitorError, match=says):
        parse_message(body, RUN)


def test_an_answer_holding_a_credential_is_refused(run) -> None:
    _, monitor, _, publisher, _ = run
    secret = 'the key is AKIA' + 'ABCDEFGHIJKLMNOP'
    with pytest.raises(MonitorError, match='credential') as refused:
        monitor.message(RUN, parse_message({'to': 'conductor', 'text': secret}, RUN), ADMIN)
    assert (refused.value.kind, publisher.sent) == ('invalid', [])


def test_the_lambda_signaller_calls_the_start_functions_signal_run() -> None:
    client = LambdaClient({'run_id': RUN, 'signal': 'pause', 'status': 'sent', 'at': '2026-11-12T09:00:00Z'})
    pause = parse_signal({'signal': 'pause', 'task_id': 'task-1', 'attempt': 2, 'note': 'Lunch'})
    sent = LambdaSignaller(client, 'voc-engineering-start').signal(RUN, pause, actor='admin-1', agent_id='fixer-1')
    assert sent['status'] == 'sent'
    (request,) = client.requests
    # voc-engineering-start, never voc-engineering-runtime: its signal_run checks, records and hands it on.
    assert (request['FunctionName'], request['InvocationType'], json.loads(request['Payload'])) == (
        'voc-engineering-start', 'RequestResponse', {'action': 'signal_run', 'run_id': RUN, 'signal': 'pause',
                                                     'actor': 'admin-1', 'note': 'Lunch', 'agent_id': 'fixer-1',
                                                     'task_id': 'task-1', 'attempt': 2})
    run_wide = LambdaClient({'status': 'sent'})
    LambdaSignaller(run_wide, 'f').signal(RUN, parse_signal({'signal': 'save'}), actor='admin-1')
    assert json.loads(run_wide.requests[0]['Payload']) == {'action': 'signal_run', 'run_id': RUN, 'signal': 'save',
                                                           'actor': 'admin-1'}


def test_the_start_function_refusing_or_failing_a_signal_says_so() -> None:
    kinds = []
    unsent = 'The signal could not be sent: send it again'
    for failing in (LambdaClient({'errorType': 'RuntimeRefused', 'errorMessage': 'run R is being stopped'}, 'Unhandled'),
                    LambdaClient({'errorType': 'RunNotActive', 'errorMessage': 'run R has ended'}, 'Unhandled'),
                    LambdaClient({'errorType': 'KeyError'}, 'Unhandled'), LambdaClient({'status': 'applied'}),
                    LambdaClient('not an answer')):
        with pytest.raises(MonitorError) as refused:
            LambdaSignaller(failing, 'f').signal(RUN, parse_signal({'signal': 'resume'}), actor='admin-1')
        kinds.append((refused.value.kind, str(refused.value)))
    assert kinds == [('conflict', 'run R is being stopped'), ('conflict', 'run R has ended'), ('unavailable', unsent),
                     ('unavailable', unsent), ('unavailable', unsent)]

    class Unreachable:
        def invoke(self, **_request: Any) -> Any:
            raise ClientError({'Error': {'Code': 'TooManyRequestsException'}}, 'Invoke')

    with pytest.raises(MonitorError, match='could not be reached: send the signal again') as down:
        LambdaSignaller(Unreachable(), 'f').signal(RUN, parse_signal({'signal': 'save'}), actor='admin-1')
    assert down.value.kind == 'unavailable'


def test_an_agents_stop_now_carries_the_attempt_and_who_sent_it(run) -> None:
    _, monitor, signaller, _, task_id = run
    sent = monitor.signal(RUN, parse_signal({'signal': 'stop_now', 'confirm': True, 'task_id': task_id,
                                             'attempt': 1}), ADMIN)
    # (the person who sent it, for the record and for who changed the run's status: D4)
    assert (signaller.calls, signaller.actors, sent['status']) == ([(RUN, 'fixer-1', 'stop_now', 1)], [ADMIN.subject],
                                                                    'sent')


def test_a_signal_to_a_task_a_person_took_is_refused_and_nothing_is_sent(run) -> None:
    client, monitor, signaller, publisher, task_id = run
    board(client).take('default', RUN, task_id, actor='human:admin-1')
    with pytest.raises(MonitorError, match='A person holds this task') as held:
        monitor.signal(RUN, parse_signal({'signal': 'pause', 'task_id': task_id, 'attempt': 1}), ADMIN)
    assert (held.value.kind, signaller.calls, publisher.sent) == ('conflict', [], [])


def test_a_reposted_task_has_no_agent_to_signal(run) -> None:
    client, monitor, signaller, _, task_id = run
    client.update_item(TableName=TABLE, Key={'pk': {'S': run_pk('default', RUN)}, 'sk': {'S': f'TASK#{task_id}'}},
                       UpdateExpression='SET #s = :open', ExpressionAttributeNames={'#s': 'state'},
                       ExpressionAttributeValues={':open': {'S': 'open'}})   # (back to open, its old lease still set)
    with pytest.raises(MonitorError) as reposted:
        monitor.signal(RUN, parse_signal({'signal': 'pause', 'task_id': task_id, 'attempt': 1}), ADMIN)
    assert (reposted.value.kind, signaller.calls) == ('conflict', [])


def test_the_overview_lights_the_runs_flow_from_its_own_copy(run) -> None:
    from engineering.flow.test.fixtures import TEMPLATES, put_flow
    client, monitor, _, _, _ = run
    put_flow(client, TABLE, RUN, revision=7)
    view = monitor.overview(RUN)
    assert view is not None
    flow = {key: value for key, value in view['run'].items() if key.startswith('flow_')}
    assert (flow['flow_revision'], flow['flow_copied_at'], flow['flow_outcome']) == (
        7, '2026-11-14T09:00:00Z', {'outcome': 'running', 'at': None, 'reason': None})
    assert (flow['flow_steps']['hunt'], flow['flow_steps']['board'], flow['flow_steps']['gate']) == (
        'ready', 'collecting', 'waiting')
    # The run's own copy, as its start wrote it: what the monitor draws.
    assert flow['flow_definition'] == TEMPLATES['bug-hunt-and-fix']
    assert view['run']['expansion'] == []   # (7.52.00: a flow that calls no other)
    # A copy the conductor cannot follow lights nothing (and is logged); the rest of the overview stands.
    put_flow(client, TABLE, RUN, definition='{')
    broken = monitor.overview(RUN)
    assert broken is not None
    assert (broken['run']['flow_steps'], broken['run']['goal']) == (None, 'Fix the paging bug')


# --- a person's Stop of the whole run (7.50.03) ---------------------------------------------------------------------

class Stopper:
    """voc-engineering-start's ``stop_run`` as the monitor calls it: records each call, answers ``answer``."""

    def __init__(self, answer: dict[str, Any] | None = None) -> None:
        self.calls: list[tuple[str, str, str]] = []
        self.answer = answer or {'run_id': RUN, 'status': 'stopped', 'mode': 'stop', 'tasks_closed': ['task-1'],
                                 'holds_released': [], 'saving': [], 'already': False, 'fell_back': False,
                                 'agents': {}}

    def stop(self, run_id: str, mode: str, *, actor: str) -> dict[str, Any]:
        self.calls.append((run_id, mode, actor))
        return self.answer


def _stopping_monitor(client: Any, stopper: Stopper, publisher: Publisher | None = None) -> RunMonitor:
    """A monitor that reaches neither the signals nor (by default) the bus: only the start function's Stop."""
    return RunMonitor(client, TABLE, Sessions(FIXER), signaller=None, publisher=publisher, now=lambda: START,
                      stopper=stopper)


@pytest.mark.parametrize(('body', 'mode'), [({}, 'stop'), ({'now': False}, 'stop'),
                                            ({'now': True, 'confirm': True}, 'stop_now')])
def test_a_stop_is_a_stop_or_a_confirmed_stop_now(body: dict[str, Any], mode: str) -> None:
    assert parse_stop(body).mode == mode


@pytest.mark.parametrize(('body', 'says'), [({'now': True}, 'confirm: true'), ({'now': 'yes'}, 'now is true')])
def test_a_malformed_stop_says_what_to_send(body: dict[str, Any], says: str) -> None:
    with pytest.raises(MonitorError, match=says) as refused:
        parse_stop(body)
    assert refused.value.kind == 'invalid'


def test_a_stop_reaches_the_run_through_the_start_function_without_the_runtime_or_the_bus(run) -> None:
    client, _, _, _, _ = run
    stopper = Stopper()
    monitor = _stopping_monitor(client, stopper)
    view = monitor.overview(RUN)
    assert view is not None
    # (neither the signals nor the bus reach this run, its Stop does: the run monitor offers Stop alone)
    assert [view[flag] for flag in FLAGS] == [False, False, True, False]
    stopped = monitor.stop(RUN, parse_stop({}), ADMIN)
    assert stopper.calls == [(RUN, 'stop', 'admin-sub')]
    assert (stopped['status'], stopped['tasks_closed'], 'recorded' in stopped) == ('stopped', ['task-1'], False)


def test_a_whole_run_shut_down_or_stop_now_signal_is_the_runs_stop(run) -> None:
    client, _, _, _, _ = run
    stopper = Stopper({'status': 'stopping', 'saving': ['fixer-1'], 'agents': {'fixer-1': 'pause_requested'}})
    monitor = _stopping_monitor(client, stopper)
    sent = monitor.signal(RUN, parse_signal({'signal': 'shutdown'}), ADMIN)
    assert (sent['agents'], sent['run']['status'], sent['run']['saving']) == (
        {'fixer-1': 'pause_requested'}, 'stopping', ['fixer-1'])
    monitor.signal(RUN, parse_signal({'signal': 'stop_now', 'confirm': True}), ADMIN)
    assert [mode for _, mode, _ in stopper.calls] == ['stop', 'stop_now']
    # An agent's Shut down is still the agent's signal: it needs the start function's signal_run, unnamed here.
    with pytest.raises(MonitorError) as agent:
        monitor.signal(RUN, parse_signal({'signal': 'shutdown', 'task_id': 'task-1', 'attempt': 1}), ADMIN)
    assert agent.value.kind == 'unavailable'


def test_a_stop_says_nothing_on_the_bus_even_where_the_bus_is_named(run) -> None:
    """Its record is the run's RUNLOG# row (D4): the API's source says only steering and answers (7.51.02)."""
    client, _, _, publisher, _ = run
    stopper = Stopper()
    _stopping_monitor(client, stopper, publisher).stop(RUN, parse_stop({'now': True, 'confirm': True}), ADMIN)
    assert (stopper.calls, publisher.sent) == ([(RUN, 'stop_now', 'admin-sub')], [])


def test_an_ended_run_or_a_deployment_without_the_start_function_takes_no_stop(run) -> None:
    client, _, _, _, _ = run
    with pytest.raises(MonitorError) as nowhere:
        RunMonitor(client, TABLE, Sessions(), signaller=None, publisher=None).stop(RUN, parse_stop({}), ADMIN)
    client.update_item(TableName=TABLE, Key={'pk': {'S': run_pk('default', RUN)}, 'sk': {'S': 'META'}},
                       UpdateExpression='SET ended_at = :e', ExpressionAttributeValues={':e': {'S': '2026-11-12T09:30:00Z'}})
    stopper = Stopper()
    with pytest.raises(MonitorError) as ended:
        _stopping_monitor(client, stopper).stop(RUN, parse_stop({}), ADMIN)
    assert (nowhere.value.kind, ended.value.kind, stopper.calls) == ('unavailable', 'conflict', [])


def test_the_overview_shows_a_stop_under_way_and_the_decision_point_a_run_waits_at(run) -> None:
    client, monitor, _, _, _ = run
    client.update_item(TableName=TABLE, Key={'pk': {'S': run_pk('default', RUN)}, 'sk': {'S': 'META'}},
                       UpdateExpression='SET #s = :s, needs_human = :c, stop_requested_at = :at, stop_mode = :m',
                       ExpressionAttributeNames={'#s': 'status'},
                       ExpressionAttributeValues={':s': {'S': 'needs_human'}, ':c': {'S': 'coordinator'},
                                                  ':at': {'N': '1794470400'}, ':m': {'S': 'stop'}})
    view = monitor.overview(RUN)
    assert view is not None
    assert (view['run']['waiting_at'], view['run']['stop']) == (
        'coordinator', {'mode': 'stop', 'requested_at': '2026-11-12T08:00:00Z'})


#: A GitHub token's shape (the redaction's own pattern), in a failed command's output.
TOKEN = 'ghp_' + 'A1b2C3d4' * 5


def test_the_overview_says_why_an_agent_failed_redacted_and_bounded(run) -> None:
    client, _, signaller, publisher, _ = run
    failed = replace(COORDINATOR, status='failed', inspect={
        'last_failure': f'the boot took too long\x07 ({TOKEN})',
        'last_exit': {'exit_code': 128, 'timed_out': False, 'duration_seconds': 3, 'stdout_tail': 'never shown',
                      'stderr_tail': f"fatal: detected dubious ownership in repository at '/mnt/voc-cache/x'\x00 {TOKEN}"}})
    long_tail = replace(FIXER, inspect={'last_exit': {'exit_code': None, 'timed_out': True, 'stderr_tail': 'e' * 900}})
    monitor = RunMonitor(client, TABLE, Sessions(long_tail, failed), signaller=signaller, publisher=publisher,
                         now=lambda: START)
    view = monitor.overview(RUN)
    assert view is not None
    coordinator, fixer = view['agents']
    assert coordinator['last_exit'] == {
        'exit_code': 128, 'timed_out': False, 'duration_seconds': 3,
        'stderr_tail': "fatal: detected dubious ownership in repository at '/mnt/voc-cache/x' <redacted>"}
    assert coordinator['last_failure'] == 'the boot took too long (<redacted>)'
    assert (fixer['last_exit']['exit_code'], fixer['last_exit']['timed_out'], fixer['last_exit']['duration_seconds'],
            len(fixer['last_exit']['stderr_tail']), fixer['last_failure']) == (None, True, None, 500, None)
    assert 'never shown' not in json.dumps(view)


@pytest.mark.parametrize(('status', 'reason', 'shown'), [
    ('needs_human', f'The repository checkout failed (exit 128): fatal: {TOKEN}',
     'The repository checkout failed (exit 128): fatal: <redacted>'),
    ('needs_human', '   ', None),   # (nothing said)
    ('running', 'The repository checkout failed (exit 128)', None),   # (resumed since: the old wait's reason is moot)
])
def test_a_run_at_a_person_says_why_in_its_supervisors_words(run, status: str, reason: str, shown: str | None) -> None:
    client, monitor, _, _, _ = run
    client.update_item(TableName=TABLE, Key={'pk': {'S': run_pk('default', RUN)}, 'sk': {'S': 'META'}},
                       UpdateExpression='SET #s = :s, needs_human = :c, needs_human_detail = :r',
                       ExpressionAttributeNames={'#s': 'status'},
                       ExpressionAttributeValues={':s': {'S': status}, ':c': {'S': 'coordinator'}, ':r': {'S': reason}})
    view = monitor.overview(RUN)
    assert view is not None
    assert view['run']['waiting_detail'] == shown


def test_the_lambda_stopper_calls_the_start_functions_stop_and_says_how_it_failed() -> None:
    client = LambdaClient({'status': 'stopped', 'tasks_closed': ['coordinate']})
    assert LambdaStopper(client, 'voc-engineering-start').stop(RUN, 'stop_now', actor='admin-1')['status'] == 'stopped'
    (request,) = client.requests
    assert (request['FunctionName'], request['InvocationType'], json.loads(request['Payload'])) == (
        'voc-engineering-start', 'RequestResponse',
        {'action': 'stop_run', 'run_id': RUN, 'mode': 'stop_now', 'actor': 'admin-1'})
    kinds = []
    for failing in (LambdaClient({'errorType': 'RuntimeRefused', 'errorMessage': 'no run R'}, 'Unhandled'),
                    LambdaClient({'errorType': 'ClientError'}, 'Unhandled'), LambdaClient({'status': 'teleported'})):
        with pytest.raises(MonitorError) as refused:
            LambdaStopper(failing, 'f').stop(RUN, 'stop', actor='admin-1')
        kinds.append(refused.value.kind)
    assert kinds == ['conflict', 'unavailable', 'unavailable']


def test_the_origin_is_the_engineering_agents_run_its_start_recorded(run) -> None:
    client, monitor, _, _, _ = run
    assert monitor.origin(RUN) is None   # (a run an administrator started by hand)
    client.put_item(TableName=TABLE, Item={
        'pk': {'S': run_pk('default', RUN)}, 'sk': {'S': 'RUNLOG#2026-11-12T08:00:00Z#active#ab12cd34'},
        'kind': {'S': 'run_status'}, 'status': {'S': 'active'},
        'via': {'M': {'agent_id': {'S': 'ag_cd22db36272d'}, 'agent_run_id': {'S': 'ar_01a1e7bd34969e48d125'},
                      'trigger': {'S': 'github_issue'}}}})
    assert monitor.origin(RUN) == {'agent_id': 'ag_cd22db36272d', 'agent_run_id': 'ar_01a1e7bd34969e48d125'}
# --- 7.51.00: an agent's restart, a person's steering ---------------------------------------------------------------

@pytest.mark.parametrize('start', ['checkpoint', 'fresh'])
def test_a_restart_goes_through_the_start_function_with_where_it_starts(run, start: str) -> None:
    _, monitor, signaller, publisher, task_id = run
    sent = monitor.signal(RUN, parse_signal({'signal': 'restart', 'from': start, 'task_id': task_id, 'attempt': 1,
                                             'confirm': True}), ADMIN)
    assert (signaller.calls, signaller.restarts, sent['signal'], publisher.sent) == (
        [(RUN, 'fixer-1', 'restart', 1)], [start], 'restart', [])


def test_the_lambda_signaller_sends_a_restarts_start() -> None:
    client = LambdaClient({'status': 'sent'})
    restart = parse_signal({'signal': 'restart', 'from': 'fresh', 'task_id': 'task-1', 'attempt': 2, 'confirm': True})
    LambdaSignaller(client, 'voc-engineering-start').signal(RUN, restart, actor='admin-sub', agent_id='fixer-1')
    assert json.loads(client.requests[0]['Payload']) == {
        'action': 'signal_run', 'run_id': RUN, 'signal': 'restart', 'actor': 'admin-sub', 'agent_id': 'fixer-1',
        'task_id': 'task-1', 'attempt': 2, 'restart_from': 'fresh'}


@pytest.mark.parametrize(('body', 'says'), [
    ({'signal': 'restart', 'task_id': 'task-1', 'attempt': 1, 'confirm': True}, "restart's from"),
    ({'signal': 'restart', 'from': 'scratch', 'task_id': 'task-1', 'attempt': 1, 'confirm': True}, "restart's from"),
    ({'signal': 'restart', 'from': 'fresh', 'task_id': 'task-1', 'attempt': 1}, 'confirm: true'),
    ({'signal': 'restart', 'from': 'checkpoint', 'confirm': True}, "a restart is an agent's"),
    ({'signal': 'pause', 'from': 'fresh'}, 'from goes with a restart'),
])
def test_a_restart_off_its_rule_says_what_to_send(body: dict[str, Any], says: str) -> None:
    with pytest.raises(MonitorError, match=says):
        parse_signal(body)


def test_a_person_steers_the_orchestrator_about_an_agent(run) -> None:
    _, monitor, signaller, publisher, _ = run
    sent = monitor.steer(RUN, parse_steer({'text': ' Keep the signature. ', 'about': 'fixer-1'}), ADMIN)
    [steer] = publisher.sent
    assert (steer.type, steer.sender, steer.to, steer.summary, steer.thread_id) == (
        'msg.steer', Party('human', 'admin-sub'), Party('conductor', RUN), 'About fixer-1: Keep the signature.',
        sent['thread_id'])
    assert sent['thread_id'].startswith('steer-')
    assert signaller.calls == []
    plain = monitor.steer(RUN, parse_steer({'text': 'Skip the docs', 'thread_id': 'steer-7'}), ADMIN)
    assert (publisher.sent[1].summary, plain['thread_id']) == ('Skip the docs', 'steer-7')


def test_steering_about_an_agent_not_in_the_run_or_in_an_ended_run_is_refused(run) -> None:
    client, monitor, _, publisher, _ = run
    with pytest.raises(MonitorError) as missing:
        monitor.steer(RUN, parse_steer({'text': 'Hi', 'about': 'fixer-9'}), ADMIN)
    client.update_item(TableName=TABLE, Key={'pk': {'S': run_pk('default', RUN)}, 'sk': {'S': 'META'}},
                       UpdateExpression='SET ended_at = :t', ExpressionAttributeValues={':t': {'S': '2026-11-12T10:00Z'}})
    with pytest.raises(MonitorError) as ended:
        monitor.steer(RUN, parse_steer({'text': 'Hi'}), ADMIN)
    assert (missing.value.kind, ended.value.kind, publisher.sent) == ('not_found', 'conflict', [])


@pytest.mark.parametrize(('body', 'says'), [
    ({}, 'text is'), ({'text': ' '}, 'text is'), ({'text': 'x' * 1020, 'about': 'fixer-1'}, 'text is'),
    ({'text': 'Hi', 'about': 'a b'}, 'about is'), ({'text': 'Hi', 'thread_id': 'a b'}, 'thread_id'),
    ({'text': 'Hi', 'to': 'agent'}, 'the body is'),
])
def test_steering_off_its_rule_says_what_to_send(body: dict[str, Any], says: str) -> None:
    with pytest.raises(MonitorError, match=says):
        parse_steer(body)


def test_the_overview_shows_the_lanes_the_gates_the_cost_and_the_family_of_a_run() -> None:
    from moto import mock_aws

    from engineering.run_objects import RunObjects
    from engineering.runtime.runs import RunStore
    from engineering.runtime.sessions import SessionStore
    from engineering.test import run_workspace_world as world

    with mock_aws():
        built = world.build()
        import boto3
        table = boto3.resource('dynamodb', region_name='us-east-1').Table(world.TABLE)
        monitor = RunMonitor(built.client, world.TABLE, SessionStore(table, RunStore(table)), signaller=None,
                             publisher=None, objects=RunObjects(built.s3, world.BUCKET))
        view = monitor.overview(world.RUN)
        assert view is not None
        assert {step: [lane['agent'] for lane in lanes] for step, lanes in view['lanes'].items()} == {
            'board': [world.FIXER], 'gate': [world.GATE_RUNNER, world.FINAL_GO]}
        assert view['gates'] == {'gate': 'GO'}
        assert (view['run']['cost_usd'], view['run']['cost_cap_usd'], view['run']['manifest']) == (1.6095, 50.0, None)
        fixer = next(agent for agent in view['agents'] if agent['agent'] == world.FIXER)
        assert (fixer['cost_usd'], fixer['attempt'], fixer['skill_label'], fixer['model']) == (
            0.9375, 2, 'fixer@v3', 'model-medium')
        # (7.52.00: the Registry card its step was made from, as its launch recorded it)
        assert (fixer['card'], fixer['card_version'], view['run']['expansion']) == ('fixer-careful', 2, [])
        ended = monitor.overview(world.ENDED_RUN)
        child = monitor.overview(world.CHILD_RUN)
        assert ended is not None
        assert child is not None
        assert [child_run['run_id'] for child_run in ended['children']] == [world.CHILD_RUN]
        assert (ended['run']['manifest']['cost_usd'], ended['run']['manifest']['version']) == (3.1415, 1)
        assert child['run']['parent'] == {'run_id': world.ENDED_RUN, 'mode': 'resume', 'by': 'admin-sub',
                                          'at': world.at(-60)}
        # (7.51.04) The run at a person: where it waits and why, its failed orchestrator's last exit, the step it is on.
        failed = monitor.overview(world.FAILED_RUN)
        assert failed is not None
        assert (failed['run']['status'], failed['run']['waiting_at'], failed['run']['waiting_detail']) == (
            'needs_human', world.CHECKOUT_FAILED, world.FAILED_REASON)
        [coordinator] = failed['agents']
        assert (coordinator['status'], coordinator['continuation'], coordinator['last_failure']) == (
            'failed', 2, world.FAILED_REASON)
        assert coordinator['last_exit'] == {'exit_code': 128, 'timed_out': False, 'duration_seconds': 2,
                                            'stderr_tail': world.CHECKOUT_STDERR}
        assert (failed['run']['flow_steps']['classify'], failed['lanes'], failed['run']['cost_usd']) == (
            'ready', {}, 0.03)


def test_the_overview_answers_the_calls_its_flow_expanded(run) -> None:
    # (7.52.00, gap I: a run's copy is flat; the overview says which steps came from which call, at which revision)
    from engineering.flow.test.fixtures import put_flow
    from shared.flow_expand import expand
    from shared.test.test_flow_expand import ROOT, A, Saved, calling, two_agents
    from shared.workflow_schema import encode_definition
    client, monitor, _, _, _ = run
    flat = expand(calling(f'{A}@2'), Saved(**{f'{A}_r2': two_agents()}), root=ROOT).definition
    put_flow(client, TABLE, RUN, revision=4, definition=encode_definition(flat))
    view = monitor.overview(RUN)
    assert view is not None
    assert view['run']['expansion'] == [{'step': 'call', 'flow': A, 'revision': 2}]
    assert [node['id'] for node in view['run']['flow_definition']['nodes']] == [
        'start', 'call.hunt', 'call.fix', 'build', 'end']
