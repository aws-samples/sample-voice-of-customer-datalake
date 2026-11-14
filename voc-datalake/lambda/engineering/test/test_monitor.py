"""The run monitor: the overview of a run (its agents as the supervisor's session rows hold them, their tokens and
session time, the totals), and a person's signals (checked against the attempt they saw, applied by the supervisor,
recorded in the conversation) and answers."""
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
from engineering.bus.publish import PublishError
from engineering.bus.schema import Message, MessageError, parse
from engineering.monitor import (
    MAX_LINE,
    Actor,
    Applied,
    LambdaRuntime,
    MonitorError,
    RunMonitor,
    parse_message,
    parse_signal,
)
from engineering.rows import run_pk
from engineering.runtime.sessions import AgentSession
from engineering.test.run_fixture import FIXER, LambdaClient

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


class Runtime:
    """The supervisor's signal: records each call, answers each agent's status (``fail``: it raises)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str | None, str, int | None]] = []
        self.fail: Exception | None = None
        self.answer: dict[str, str] = {}
        self.not_applied: set[str] = set()
        self.actors: list[str] = []

    def signal(self, run_id: str, agent_id: str | None, signal: str, attempt: int | None, *, actor: str) -> Applied:
        if self.fail is not None:
            raise self.fail
        self.calls.append((run_id, agent_id, signal, attempt))
        self.actors.append(actor)
        agents = self.answer or {agent_id or 'fixer-1': 'paused'}
        return Applied(agents, {agent: agent not in self.not_applied and status not in {'busy', 'stale'}
                                for agent, status in agents.items()})


@pytest.fixture
def run() -> Iterator[tuple[Any, RunMonitor, Runtime, Publisher, str]]:
    """A run with a goal, a claimed task, two agent sessions, the monitor, its runtime and its publisher."""
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
        runtime, publisher = Runtime(), Publisher()
        monitor = RunMonitor(client, TABLE, Sessions(FIXER, COORDINATOR), runtime=runtime, publisher=publisher,
                             now=lambda: START)
        yield client, monitor, runtime, publisher, task.task_id


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
                           'flow_steps': None, 'flow_outcome': None}   # (a run started without a flow: nothing to light)
    coordinator, fixer = view['agents']
    assert fixer == {
        'agent': 'fixer-1', 'role': 'fixer', 'task_id': 'task-1', 'status': 'working', 'continuation': 0,
        'started_at': 1000, 'step': 'fix', 'microvm_state': 'running', 'microvm_age': 600, 'heartbeat_age': 30,
        'last_progress_at': 1500, 'stuck_why': None, 'recent_tools': ['read_file', 'run_tests'],
        'microvm_seconds': 300, 'tokens': [{'model': 'model-a', 'input_tokens': 1000, 'output_tokens': 200}]}
    assert (coordinator['task_id'], coordinator['heartbeat_age'], len(coordinator['stuck_why'])) == (None, None, MAX_LINE)
    assert view['totals'] == {'messages': 12, 'microvm_seconds': 300, 'by_model': [
        {'model': 'model-a', 'input_tokens': 1050, 'output_tokens': 205},
        {'model': 'model-b', 'input_tokens': 7, 'output_tokens': 1}]}
    assert view['actions_available'] is True


def test_the_overview_says_the_actions_are_unavailable_without_the_runtime_or_the_bus(run) -> None:
    client, _, runtime, publisher, _ = run
    for monitor in (RunMonitor(client, TABLE, Sessions(FIXER), runtime=None, publisher=publisher),
                    RunMonitor(client, TABLE, Sessions(FIXER), runtime=runtime, publisher=None),
                    RunMonitor(client, TABLE, Sessions(FIXER), runtime=None, publisher=None)):
        view = monitor.overview(RUN)
        assert view is not None
        assert view['actions_available'] is False


def test_an_unknown_run_has_no_overview() -> None:
    with engineering_table() as client:
        monitor = RunMonitor(client, TABLE, Sessions(), runtime=None, publisher=None)
        assert monitor.overview('01JD0000000000000000000009') is None
        view = monitor.overview(RUN)
        assert view is not None
        assert (view['agents'], view['totals']['messages']) == ([], 0)


def test_a_signal_to_an_agent_is_recorded_then_applied_by_the_supervisor(run) -> None:
    _, monitor, runtime, publisher, task_id = run
    sent = monitor.signal(RUN, parse_signal({'signal': 'pause', 'task_id': task_id, 'attempt': 1,
                                             'note': ' Holding for the review '}), ADMIN)
    assert runtime.calls == [(RUN, 'fixer-1', 'pause', 1)]   # (the attempt seen goes along)
    assert (sent['target'], sent['agents'], sent['attempt']) == ({'kind': 'agent', 'id': 'fixer-1'},
                                                                  {'fixer-1': 'paused'}, 1)
    record, outcome = publisher.sent
    assert (outcome.type, outcome.to.kind, outcome.summary) == (
        'signal.pause', 'run', f'signal.pause request {record.event_id}: applied: fixer-1 paused')
    assert (record.type, record.sender.kind, record.sender.id, record.to.kind, record.task_id) == (
        'signal.pause', 'human', 'admin-sub', 'run', task_id)   # (the supervisor tells the agent; the record stays)
    assert record.summary == ('pause requested from the run monitor by ada for agent fixer-1. '
                              'Note: Holding for the review')


def test_a_signal_to_the_whole_run_names_no_agent(run) -> None:
    _, monitor, runtime, publisher, _ = run
    sent = monitor.signal(RUN, parse_signal({'signal': 'save'}), ADMIN)
    assert (runtime.calls, sent['target'], publisher.sent[0].to.kind, publisher.sent[0].attempt) == (
        [(RUN, None, 'save', None)], {'kind': 'run', 'id': RUN}, 'run', 0)


def test_a_signal_for_an_attempt_that_moved_on_is_refused_before_anything_is_done(run) -> None:
    client, monitor, runtime, publisher, task_id = run
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
    assert (runtime.calls, publisher.sent) == ([], [])


def test_an_open_task_has_no_agent_to_signal(run) -> None:
    client, monitor, runtime, _, _ = run
    task = BoardStore(client, TABLE, new_id=lambda: 'task-open').post(
        'default', RUN, role='fixer', title='Another', spec={'issue': 8}, parent_task='', priority=1,
        actor='coordinator-1').task
    with pytest.raises(MonitorError) as open_task:
        monitor.signal(RUN, parse_signal({'signal': 'pause', 'task_id': task.task_id, 'attempt': 1}), ADMIN)
    assert (open_task.value.kind, runtime.calls) == ('conflict', [])


def test_an_ended_or_unknown_run_takes_no_action(run) -> None:
    client, monitor, runtime, publisher, _ = run
    with pytest.raises(MonitorError) as unknown:
        monitor.signal('01JD0000000000000000000009', parse_signal({'signal': 'save'}), ADMIN)
    client.update_item(TableName=TABLE, Key={'pk': {'S': run_pk('default', RUN)}, 'sk': {'S': 'META'}},
                       UpdateExpression='SET ended_at = :e', ExpressionAttributeValues={':e': {'S': '2026-11-12T09:30:00Z'}})
    with pytest.raises(MonitorError) as ended:
        monitor.message(RUN, parse_message({'to': 'conductor', 'text': 'Hello'}, RUN), ADMIN)
    assert (unknown.value.kind, ended.value.kind, runtime.calls, publisher.sent) == ('not_found', 'conflict', [], [])


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


def test_a_long_record_is_cut_to_a_summary_on_a_character_boundary(run) -> None:
    _, monitor, _, publisher, _ = run
    monitor.signal(RUN, parse_signal({'signal': 'pause', 'note': 'é' * 250}), Actor('admin-sub', 'é' * 300))
    summary = publisher.sent[0].summary
    assert 1000 < len(summary.encode('utf-8')) <= 1024
    assert summary.startswith('pause requested from the run monitor by éé')


def test_a_request_is_recorded_even_when_the_supervisor_cannot_be_reached(run) -> None:
    _, monitor, runtime, publisher, _ = run
    runtime.fail = ClientError({'Error': {'Code': 'TooManyRequestsException'}}, 'Invoke')
    with pytest.raises(MonitorError, match='send the signal again') as down:
        monitor.signal(RUN, parse_signal({'signal': 'resume'}), ADMIN)
    request, outcome = publisher.sent
    assert (down.value.kind, request.type) == ('unavailable', 'signal.resume')
    assert outcome.summary.endswith(f'{request.event_id}: not applied: the supervisor could not be reached')


def test_an_outcome_the_bus_refuses_still_answers_the_applied_signal(run) -> None:
    client, _, runtime, publisher, _ = run

    class FirstOnly(Publisher):
        def publish(self, message: Message) -> None:
            if self.sent:
                raise PublishError('refused')
            super().publish(message)

    once = FirstOnly()
    sent = RunMonitor(client, TABLE, Sessions(FIXER), runtime=runtime, publisher=once, now=lambda: START).signal(
        RUN, parse_signal({'signal': 'save'}), ADMIN)
    assert (sent['agents'], [record.type for record in once.sent], publisher.sent) == (
        {'fixer-1': 'paused'}, ['signal.save'], [])   # (the request is recorded; its outcome is best effort)


def test_nothing_is_applied_when_the_request_cannot_be_recorded(run) -> None:
    _, monitor, runtime, publisher, _ = run
    publisher.fail = PublishError('refused')
    with pytest.raises(MonitorError) as down:
        monitor.signal(RUN, parse_signal({'signal': 'shutdown'}), ADMIN)
    publisher.fail = MessageError('a credential-shaped part')
    with pytest.raises(MonitorError, match='credential') as refused:
        monitor.signal(RUN, parse_signal({'signal': 'shutdown'}), ADMIN)
    assert (down.value.kind, refused.value.kind, runtime.calls) == ('unavailable', 'invalid', [])   # (D4: never unrecorded)


def test_without_the_runtime_or_the_bus_the_actions_are_unavailable(run) -> None:
    client, _, runtime, publisher, _ = run
    for monitor in (RunMonitor(client, TABLE, Sessions(FIXER), runtime=None, publisher=publisher),
                    RunMonitor(client, TABLE, Sessions(FIXER), runtime=runtime, publisher=None)):
        with pytest.raises(MonitorError) as down:
            monitor.signal(RUN, parse_signal({'signal': 'save'}), ADMIN)
        assert down.value.kind == 'unavailable'
    with pytest.raises(MonitorError) as unsent:
        RunMonitor(client, TABLE, Sessions(FIXER), runtime=runtime, publisher=None).message(
            RUN, parse_message({'to': 'conductor', 'text': 'Hi'}, RUN), ADMIN)
    assert (unsent.value.kind, runtime.calls) == ('unavailable', [])


def test_a_person_answers_an_agent_or_the_conductor_in_a_thread(run) -> None:
    _, monitor, _, publisher, _ = run
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
        monitor.message(RUN, parse_message({'to': 'agent', 'agent': 'fixer-9', 'text': 'Hi'}, RUN), ADMIN)
    assert (missing.value.kind, publisher.sent) == ('not_found', [])


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


def test_the_lambda_runtime_calls_the_supervisors_signal_action() -> None:
    client = LambdaClient({'agents': {'fixer-1': 'pause_requested'}, 'applied': {'fixer-1': True}})
    assert LambdaRuntime(client, 'voc-engineering-runtime').signal(RUN, 'fixer-1', 'pause', 2, actor='admin-1') == Applied(
        {'fixer-1': 'pause_requested'}, {'fixer-1': True})
    (request,) = client.requests
    assert (request['FunctionName'], request['InvocationType'], json.loads(request['Payload'])) == (
        'voc-engineering-runtime', 'RequestResponse', {'action': 'signal', 'run_id': RUN, 'signal': 'pause',
                                                       'agent_id': 'fixer-1', 'attempt': 2, 'actor': 'admin-1'})
    run_wide = LambdaClient({'agents': []})
    assert LambdaRuntime(run_wide, 'f').signal(RUN, None, 'save', None, actor='admin-1') == Applied({}, {})
    assert {'agent_id', 'attempt'} & set(json.loads(run_wide.requests[0]['Payload'])) == set()
    left_out = LambdaClient({'agents': {'fixer-1': 'working', 'hunter-1': 'paused'}, 'applied': {'hunter-1': True}})
    assert LambdaRuntime(left_out, 'f').signal(RUN, None, 'save', None, actor='admin-1').applied == {
        'fixer-1': False, 'hunter-1': True}   # (an agent the map leaves out is never taken as done)
    earlier = LambdaClient({'agents': {'fixer-1': 'working', 'hunter-1': 'busy'}})   # (the runtime before applied)
    assert LambdaRuntime(earlier, 'f').signal(RUN, None, 'save', None, actor='admin-1').applied == {'fixer-1': True, 'hunter-1': False}


def test_the_supervisor_refusing_or_failing_says_so() -> None:
    refused = LambdaClient({'errorType': 'RuntimeRefused', 'errorMessage': 'run R is stopped: it cannot be resumed'},
                           'Unhandled')
    with pytest.raises(MonitorError, match='cannot be resumed') as conflict:
        LambdaRuntime(refused, 'f').signal(RUN, None, 'resume', None, actor='admin-1')
    with pytest.raises(MonitorError) as failed:
        LambdaRuntime(LambdaClient({'errorType': 'KeyError'}, 'Unhandled'), 'f').signal(RUN, None, 'save', None, actor='admin-1')
    assert (conflict.value.kind, failed.value.kind) == ('conflict', 'unavailable')


def test_a_stop_now_carries_the_attempt_and_is_applied(run) -> None:
    _, monitor, runtime, publisher, task_id = run
    runtime.answer = {'fixer-1': 'stopped'}
    sent = monitor.signal(RUN, parse_signal({'signal': 'stop_now', 'confirm': True, 'task_id': task_id,
                                             'attempt': 1}), ADMIN)
    assert (runtime.calls, sent['applied'], publisher.sent[1].summary.endswith('applied: fixer-1 stopped')) == (
        [(RUN, 'fixer-1', 'stop_now', 1)], {'fixer-1': True}, True)
    # The supervisor is told who sent it, the signal record's sender (D4: who changed the run's status).
    assert runtime.actors == [ADMIN.subject] == [publisher.sent[0].sender.id]


def test_a_signal_to_a_task_a_person_took_is_refused_and_nothing_is_sent(run) -> None:
    client, monitor, runtime, publisher, task_id = run
    board(client).take('default', RUN, task_id, actor='human:admin-1')
    with pytest.raises(MonitorError, match='A person holds this task') as held:
        monitor.signal(RUN, parse_signal({'signal': 'pause', 'task_id': task_id, 'attempt': 1}), ADMIN)
    assert (held.value.kind, runtime.calls, publisher.sent) == ('conflict', [], [])


def test_a_stale_attempt_is_a_conflict_and_nothing_was_done(run) -> None:
    _, monitor, runtime, publisher, task_id = run
    runtime.answer = {'fixer-1': 'stale'}
    with pytest.raises(MonitorError, match='moved on') as stale:
        monitor.signal(RUN, parse_signal({'signal': 'pause', 'task_id': task_id, 'attempt': 1}), ADMIN)
    _, outcome = publisher.sent
    assert (stale.value.kind, outcome.summary.endswith('not applied: the agent has moved on to another attempt')) == (
        'conflict', True)


def test_each_agent_the_supervisor_did_not_apply_to_is_recorded_and_answered_so(run) -> None:
    _, monitor, runtime, publisher, _ = run
    runtime.answer = {'fixer-1': 'paused', 'coordinator-1': 'working'}
    runtime.not_applied = {'coordinator-1'}   # (a Resume of an agent already running: nothing to do)
    sent = monitor.signal(RUN, parse_signal({'signal': 'pause'}), ADMIN)
    request, outcome = publisher.sent
    assert sent['applied'] == {'fixer-1': True, 'coordinator-1': False}
    assert outcome.summary == (f'signal.pause request {request.event_id}: applied: fixer-1 paused; '
                               'not applied: coordinator-1 working')


def test_a_signal_the_supervisor_did_not_apply_is_unavailable(run) -> None:
    _, monitor, runtime, publisher, task_id = run
    runtime.answer = {'fixer-1': 'busy'}
    with pytest.raises(MonitorError, match='send the signal again') as busy:
        monitor.signal(RUN, parse_signal({'signal': 'pause', 'task_id': task_id, 'attempt': 1}), ADMIN)
    request, outcome = publisher.sent   # (the request stays recorded, as asked, and so does what came of it)
    assert (busy.value.kind, outcome.summary) == (
        'unavailable', f'signal.pause request {request.event_id}: not applied: the agent was busy with another move')


def test_a_reposted_task_has_no_agent_to_signal(run) -> None:
    client, monitor, runtime, _, task_id = run
    client.update_item(TableName=TABLE, Key={'pk': {'S': run_pk('default', RUN)}, 'sk': {'S': f'TASK#{task_id}'}},
                       UpdateExpression='SET #s = :open', ExpressionAttributeNames={'#s': 'state'},
                       ExpressionAttributeValues={':open': {'S': 'open'}})   # (back to open, its old lease still set)
    with pytest.raises(MonitorError) as reposted:
        monitor.signal(RUN, parse_signal({'signal': 'pause', 'task_id': task_id, 'attempt': 1}), ADMIN)
    assert (reposted.value.kind, runtime.calls) == ('conflict', [])


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
    # A copy the conductor cannot follow lights nothing (and is logged); the rest of the overview stands.
    put_flow(client, TABLE, RUN, definition='{')
    broken = monitor.overview(RUN)
    assert broken is not None
    assert (broken['run']['flow_steps'], broken['run']['goal']) == (None, 'Fix the paging bug')
