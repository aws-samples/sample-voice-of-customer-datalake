"""The harness's board and inbox on the board API (harness/board_client.py), and the runtime's handing of the
board's function URL to each agent (its host on the egress, ``VOC_BOARD_URL`` in its environment)."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Self

import pytest

from engineering.runtime import egress
from engineering.runtime.harness import board_client
from engineering.runtime.harness import main as harness_main
from engineering.runtime.harness.board_client import (
    KEPT_SEEN,
    MAX_PAGES,
    PAGE,
    BoardHttp,
    BoardRefused,
    InboxHttp,
    SignedTransport,
    board_url,
)
from engineering.runtime.harness.ports import PAUSE, SAVE, HarnessPortNotWired, InboxMessage, TaskBrief
from engineering.runtime.interface import AgentSpec, RuntimeRefused
from engineering.runtime.unit_runner import AGENT_ENV

RUN = '01JD3R4NZXQ7Y2W8K4M6P9T0AB'
URL = 'https://abc123def.lambda-url.us-east-1.on.aws/'


@dataclass
class Board:
    """The board API as the transport sees it: records each body, answers from a script."""

    answers: list[dict[str, Any]] = field(default_factory=list)
    sent: list[dict[str, Any]] = field(default_factory=list)

    def post(self, body: dict[str, Any]) -> dict[str, Any]:
        self.sent.append(body)
        return self.answers.pop(0)


def _claimed(epoch: int = 3, spec: Any = None) -> dict[str, Any]:
    return {'task': {'task_id': 'task-1', 'title': 'Fix the parser', 'state': 'in_progress',
                     'spec': {'instructions': 'Read src/parse.py.'} if spec is None else spec,
                     'lease': {'agent': 'fixer-1', 'epoch': epoch, 'expires': 2000}}}


def test_the_brief_is_the_holders_claim_and_its_epoch_goes_with_every_lease_call():
    board = Board([_claimed(), {}, {}])
    http = BoardHttp(board, RUN, 'task-1', 3)
    assert http.brief(run_id=RUN, task_id='task-1') == TaskBrief('task-1', 'Fix the parser', 'Read src/parse.py.')
    http.heartbeat(run_id=RUN, task_id='task-1', agent_id='fixer-1')
    http.progress(RUN, 'task-1', 'fixer-1', 'reading the parser')
    assert board.sent == [{'op': 'claim', 'task_id': 'task-1'},
                          {'op': 'renew', 'task_id': 'task-1', 'epoch': 3},
                          {'op': 'progress', 'task_id': 'task-1', 'epoch': 3, 'step': 'reading the parser',
                           'waiting': False}]



def test_a_task_just_claimed_is_moved_in_progress_by_its_brief():
    claimed = _claimed()
    claimed['task']['state'] = 'claimed'
    board = Board([claimed, {}, {}])
    http = BoardHttp(board, RUN, 'task-1', 3)
    http.brief(run_id=RUN, task_id='task-1')
    http.move(RUN, 'task-1', to_state='done')
    assert board.sent[1:] == [{'op': 'move', 'task_id': 'task-1', 'epoch': 3, 'to': 'in_progress', 'result_keys': []},
                              {'op': 'move', 'task_id': 'task-1', 'epoch': 3, 'to': 'done', 'result_keys': []}]


def test_the_saved_cursor_stops_before_the_oldest_notice_not_yet_done():
    board = Board([_page((4, 'E4', 'msg.answer'), (5, 'E5', 'msg.finding'), (6, 'E6', 'signal.pause'), after=6)])
    inbox = InboxHttp(board, RUN, 'fixer-1')
    inbox.take(run_id=RUN, agent_id='fixer-1')
    inbox.done(['E5', 'E6'])
    # E4 never reached the model's notes: a continuation reads from just before it, and skips the two done.
    assert inbox.cursor() == {'after': 3, 'done': [{'id': 'E5', 'seq': 5}, {'id': 'E6', 'seq': 6}]}
    inbox.done(['E4'])
    assert inbox.cursor()['after'] == 6


def test_a_continuation_reads_again_what_never_reached_the_model_and_skips_what_was_done():
    page = _page((4, 'E4', 'msg.answer'), (5, 'E5', 'signal.pause'), after=5)
    fresh = InboxHttp(Board([page]), RUN, 'fixer-1')
    fresh.resume({'after': 3, 'done': [{'id': 'E5', 'seq': 5}]})
    assert (fresh.take(run_id=RUN, agent_id='fixer-1'), fresh.after) == (
        [InboxMessage('msg.answer', 'msg.answer 4', 'E4')], 5)


@pytest.mark.parametrize('bad', [None, 'x', {'after': -1, 'done': []}, {'after': 3, 'done': ['E1']},
                                 {'after': 3, 'done': [{'id': 'E1'}]}, {'after': 3}])
def test_a_cursor_that_is_not_one_is_ignored(bad: object):
    fresh = InboxHttp(Board(), RUN, 'fixer-1')
    fresh.resume(bad)
    assert (fresh.after, fresh.seen, fresh.finished) == (0, {}, {})


def test_a_checkpoint_keeps_every_done_id_its_continuation_can_meet_again_and_no_older():
    inbox = InboxHttp(Board(), RUN, 'fixer-1', after=99)
    inbox.open = {f'E{index}': index for index in range(100)}
    inbox.done([f'E{index}' for index in range(100) if index != 60])  # E60 never saved by the model
    cursor = inbox.cursor()
    # From just before E60; the done ids from the window behind it on (the board re-reads 20 behind its tail).
    assert (cursor['after'], cursor['done'][0], len(cursor['done'])) == (59, {'id': 'E40', 'seq': 40}, 59)
    assert len(cursor['done']) <= KEPT_SEEN


def test_a_spec_without_instructions_is_shown_whole_as_the_brief():
    board = Board([_claimed(spec={'issue': 7})])
    assert BoardHttp(board, RUN, 'task-1', 3).brief(run_id=RUN, task_id='task-1').instructions == '{"issue": 7}'


def test_a_claim_that_answers_no_lease_is_refused():
    with pytest.raises(BoardRefused, match='no lease'):
        BoardHttp(Board([{'task': {'task_id': 'task-1', 'lease': None}}]), RUN, 'task-1', 3).brief(
            run_id=RUN, task_id='task-1')


@pytest.mark.parametrize(('run_id', 'task_id'), [('01JD3R4NZXQ7Y2W8K4M6P9T0AC', 'task-1'), (RUN, 'task-2')])
def test_the_harness_reaches_its_own_task_only(run_id: str, task_id: str):
    board = Board()
    with pytest.raises(ValueError, match='its own task'):
        BoardHttp(board, RUN, 'task-1', 3).brief(run_id=run_id, task_id=task_id)
    assert board.sent == []


def _page(*notices: tuple[int, str, str], after: int) -> dict[str, Any]:
    return {'messages': [{'seq': seq, 'event_id': event, 'type': kind, 'summary': f'{kind} {seq}'}
                         for seq, event, kind in notices], 'next': after}


def test_the_inbox_reads_after_its_cursor_keeps_each_notice_once_and_acts_on_save_and_pause():
    board = Board([_page((1, 'E1', 'signal.save'), (2, 'E2', 'msg.question'), after=0),
                   # The next read starts a window behind the tail: E2 again, then E3.
                   _page((2, 'E2', 'msg.question'), (3, 'E3', 'signal.pause'), after=0)])
    inbox = InboxHttp(board, RUN, 'fixer-1')
    first = inbox.take(run_id=RUN, agent_id='fixer-1')
    second = inbox.take(run_id=RUN, agent_id='fixer-1')
    assert (first, second) == ([InboxMessage(SAVE, 'signal.save 1', 'E1'),
                                InboxMessage('msg.question', 'msg.question 2', 'E2')],
                               [InboxMessage(PAUSE, 'signal.pause 3', 'E3')])
    assert [body['after'] for body in board.sent] == [0, 0]


def test_a_full_page_reads_on_but_at_most_its_pages_per_take():
    full = [_page(*[(seq, f'E{page}-{seq}', 'msg.finding') for seq in range(PAGE)], after=(page + 1) * PAGE)
            for page in range(MAX_PAGES + 1)]
    inbox = InboxHttp(Board(full), RUN, 'fixer-1')
    assert (len(inbox.take(run_id=RUN, agent_id='fixer-1')), inbox.after) == (PAGE * MAX_PAGES, PAGE * MAX_PAGES)


@pytest.mark.parametrize('answer', [{}, {'messages': [], 'next': -1}, {'messages': 'x', 'next': 1}])
def test_an_inbox_answer_that_is_no_page_is_refused(answer: dict[str, Any]):
    with pytest.raises(BoardRefused, match='no page'):
        InboxHttp(Board([answer]), RUN, 'fixer-1').take(run_id=RUN, agent_id='fixer-1')


def test_the_harness_reads_its_own_inbox_only():
    with pytest.raises(ValueError, match='its own inbox'):
        InboxHttp(Board(), RUN, 'fixer-1').take(run_id=RUN, agent_id='fixer-2')


@pytest.mark.parametrize('url', ['http://abc.lambda-url.us-east-1.on.aws/', 'https://abc.lambda-url.us-east-1.on.aws/x',
                                 'https://abc.lambda-url.us-east-1.on.aws/?a=1', 'https:///',
                                 # https, but not a function URL's own host (the egress's rule: egress.py)
                                 'https://evil.example.org/', 'https://lambda.us-east-1.amazonaws.com/',
                                 'https://abc.lambda-url.us-east-1.on.aws.example.org/',
                                 'https://abc.lambda-url.us-east-1.on.aws:8443/', 'https://u@abc.lambda-url.us-east-1.on.aws/'])
def test_the_board_url_is_a_function_url_and_nothing_else(url: str):
    with pytest.raises(ValueError, match='not a function URL'):
        board_url(url)


def test_the_board_url_keeps_a_function_urls_own_host():
    assert board_url(URL.rstrip('/')) == URL


@pytest.mark.parametrize('url', ['http://abc.lambda-url.us-east-1.on.aws/', 'https://lambda.us-east-1.amazonaws.com/',
                                 'https://evil.example.org/'])
def test_only_a_function_urls_own_host_goes_on_the_egress(url: str):
    with pytest.raises(RuntimeRefused, match='not a function URL'):
        egress.service_host(url)


def test_every_agent_reaches_the_boards_own_host_by_name():
    for role in ('fixer', 'committer'):
        hosts = egress.egress_allowlist(role=role, language='python', region='us-east-1', bucket='voc-raw-test',
                                        service_urls=[URL])
        assert 'abc123def.lambda-url.us-east-1.on.aws' in hosts
        assert not any(host.startswith('lambda.') for host in hosts)


def test_the_agent_is_handed_the_boards_url_and_the_runner_passes_it_on():
    spec = AgentSpec(run_id=RUN, agent_id='fixer-1', role='fixer', task_id='task-1', language='python', egress=(),
                     connection='conn-1', board_url=URL)
    assert spec.environment()['VOC_BOARD_URL'] == URL
    assert 'VOC_BOARD_URL' in AGENT_ENV


class Credentials:
    def get_frozen_credentials(self) -> Any:
        from botocore.credentials import ReadOnlyCredentials
        return ReadOnlyCredentials('AKIDEXAMPLE', 'secret', 'session-token')


def test_the_harness_wires_its_board_and_inbox_on_the_url_and_refuses_without_it():
    env = {'VOC_BOARD_URL': URL, 'AWS_REGION': 'us-east-1', 'VOC_RUN_ID': RUN, 'VOC_TASK_ID': 'task-1',
           'VOC_AGENT_ID': 'fixer-1'}
    ports = harness_main.default_ports(env, Credentials())
    assert isinstance(ports.board, BoardHttp)
    assert isinstance(ports.inbox, InboxHttp)
    assert (ports.board.run_id, ports.board.task_id, ports.inbox.agent_id) == (RUN, 'task-1', 'fixer-1')
    with pytest.raises(HarnessPortNotWired):
        ports.broker.submit(RUN, 'fixer-1', 'task-1', 'k', 's')
    pending = harness_main.default_ports({'AWS_REGION': 'us-east-1'})
    with pytest.raises(HarnessPortNotWired):
        pending.board.brief(run_id=RUN, task_id='task-1')


def test_a_call_is_signed_as_the_agents_session_for_the_lambda_service(monkeypatch: pytest.MonkeyPatch):
    seen: list[Any] = []

    class Answer:
        def __enter__(self) -> Self:
            return self

        def __exit__(self, *_: object) -> None:
            return None

        def read(self, _limit: int) -> bytes:
            return b'{"ok": true}'

    def opened(request: Any, timeout: int) -> Answer:
        seen.append((request, timeout))
        return Answer()

    monkeypatch.setattr(board_client._OPENER, 'open', opened)
    answer = SignedTransport(URL, 'us-east-1', Credentials()).post({'op': 'inbox', 'after': 0})
    [(request, timeout)] = seen
    headers = {name.lower(): value for name, value in request.header_items()}
    assert (answer, request.full_url, request.get_method(), timeout) == ({'ok': True}, URL, 'POST', 30)
    assert headers['authorization'].startswith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/')
    assert '/us-east-1/lambda/aws4_request' in headers['authorization']
    assert json.loads(request.data) == {'op': 'inbox', 'after': 0}
    # The session's token and the date are sent, and signed: what the signature covers is what goes out.
    assert (headers['x-amz-security-token'], bool(headers['x-amz-date'])) == ('session-token', True)
    signed = headers['authorization'].split('SignedHeaders=')[1].split(',')[0].split(';')
    assert {'host', 'x-amz-date', 'x-amz-security-token'} <= set(signed)
    # A launch waits longer than the board function may run (120 s), so the board's answer always comes first.
    SignedTransport(URL, 'us-east-1', Credentials()).post({'op': 'launch', 'task_id': 'task-2'})
    assert seen[-1][1] == board_client.LAUNCH_TIMEOUT_SECONDS
    assert board_client.LAUNCH_TIMEOUT_SECONDS > 120
    assert all(name in headers or name == 'host' for name in signed)


def test_the_lease_epoch_is_the_tasks_attempt_so_no_lease_call_claims():
    env = {'VOC_BOARD_URL': URL, 'AWS_REGION': 'us-east-1', 'VOC_RUN_ID': RUN, 'VOC_TASK_ID': 'task-1',
           'VOC_AGENT_ID': 'fixer-1', 'VOC_ATTEMPT': '5'}
    board = Board([{}, {}, {}])
    # The harness, a continuation or the CLI's tool server: renew, progress and move go on epoch 5, never a claim.
    tool_board = harness_main.default_ports(env, Credentials()).board
    assert isinstance(tool_board, BoardHttp)
    tool_board.transport = board
    tool_board.heartbeat(run_id=RUN, task_id='task-1', agent_id='fixer-1')
    tool_board.progress(RUN, 'task-1', 'fixer-1', 'ran the tests')
    tool_board.move(RUN, 'task-1', to_state='done')
    assert [(body['op'], body.get('epoch')) for body in board.sent] == [('renew', 5), ('progress', 5), ('move', 5)]


def test_a_harness_without_an_attempt_works_on_the_first():
    env = {'VOC_BOARD_URL': URL, 'AWS_REGION': 'us-east-1', 'VOC_RUN_ID': RUN, 'VOC_TASK_ID': 'task-1',
           'VOC_AGENT_ID': 'fixer-1'}
    board = harness_main.default_ports(env, Credentials()).board
    assert isinstance(board, BoardHttp)
    assert board.epoch == 1


class Replies:
    """The board's answers in turn: an HTTP status (an error) or a JSON body."""

    def __init__(self, *replies: Any) -> None:
        self.replies = list(replies)
        self.calls = 0

    def open(self, request: Any, timeout: int) -> Any:
        del timeout
        self.calls += 1
        reply = self.replies.pop(0)
        if isinstance(reply, int):
            import io
            import urllib.error
            from email.message import Message
            raise urllib.error.HTTPError(request.full_url, reply, 'refused', Message(), io.BytesIO(b'{"error": "retry"}'))
        if isinstance(reply, Exception):
            raise reply

        class Answer:
            def __enter__(self) -> Any:
                return self

            def __exit__(self, *_: object) -> None:
                return None

            def read(self, _limit: int) -> bytes:
                return json.dumps(reply).encode()

        return Answer()


def _transport(monkeypatch: pytest.MonkeyPatch, replies: Replies) -> tuple[SignedTransport, list[float]]:
    waits: list[float] = []
    monkeypatch.setattr(board_client, '_OPENER', replies)
    return SignedTransport(URL, 'us-east-1', Credentials(), sleep=waits.append), waits


def test_a_503_or_a_lost_connection_is_retried_backing_off(monkeypatch: pytest.MonkeyPatch):
    import urllib.error
    replies = Replies(503, urllib.error.URLError('reset'), {'ok': True})
    transport, waits = _transport(monkeypatch, replies)
    assert (transport.post({'op': 'renew'}), replies.calls, waits) == ({'ok': True}, 3, [1.0, 3.0])


@pytest.mark.parametrize('replies', [(503, 503, 503), (409,)])
def test_a_refusal_or_a_503_past_its_retries_is_raised(monkeypatch: pytest.MonkeyPatch, replies: tuple[int, ...]):
    transport, _ = _transport(monkeypatch, Replies(*replies))
    with pytest.raises(BoardRefused) as refused:
        transport.post({'op': 'renew'})
    assert refused.value.status == replies[0]


def test_a_redirect_is_refused_and_never_followed():
    handler = board_client._NoRedirect()
    with pytest.raises(BoardRefused, match='redirect') as refused:
        handler.redirect_request(None, None, 307, 'Temporary Redirect', {}, 'https://elsewhere.example.org/')
    assert refused.value.status == 307
    # The module's opener is built with it: urllib's own redirect handler is replaced, never added beside it.
    assert any(isinstance(h, board_client._NoRedirect) for h in getattr(board_client._OPENER, 'handlers', []))


def test_the_saved_cursor_never_passes_the_read_cursor():
    inbox = InboxHttp(Board(), RUN, 'fixer-1')
    inbox.open, inbox.after = {'E40': 40}, 25  # the board answered a window behind its tail
    assert inbox.cursor()['after'] == 25


def test_the_coordinators_planner_lists_posts_and_launches_through_the_board():
    from engineering.runtime.harness.board_client import BoardPlanner
    board = Board([{'tasks': [{'task_id': 'task-1', 'role': 'hunter', 'title': 'Find it', 'state': 'open', 'attempt': 1}]},
                   {'task': {'task_id': 'task-2'}}, {'agent_id': 'fixer-3', 'status': 'booting'}])
    planner = BoardPlanner(board, RUN)
    assert [task.task_id for task in planner.tasks(run_id=RUN)] == ['task-1']
    assert planner.post(run_id=RUN, role='fixer', title='Fix it', instructions='Read src.', paths=('src',)) == 'task-2'
    assert planner.launch(run_id=RUN, task_id='task-2', role='fixer', language='python', paths=('src',)) == 'fixer-3'
    assert board.sent == [{'op': 'tasks'},
                          {'op': 'post', 'role': 'fixer', 'title': 'Fix it',
                           'spec': {'instructions': 'Read src.', 'paths': ['src']}},
                          {'op': 'launch', 'task_id': 'task-2', 'role': 'fixer', 'language': 'python', 'paths': ['src']}]
    with pytest.raises(ValueError, match='its own run'):
        planner.tasks(run_id='01JD3R4NZXQ7Y2W8K4M6P9T0AC')


def test_the_planner_follows_the_runs_flow_through_the_board():
    from engineering.runtime.harness.board_client import BoardPlanner
    plan = {'outcome': 'running', 'steps': []}
    board = Board([{'flow': plan}, {'flow': None, 'note': 'no flow'}, {'task': {'task_id': 'task-3'}},
                   {'step': 'map', 'recorded': True, 'flow': plan}, {'step': 'plan', 'recorded': False, 'flow': plan},
                   {'tasks': [{'task_id': 'task-3', 'flow_step': 'mapper'}, {'task_id': 'task-4', 'flow_step': None}]}])
    planner = BoardPlanner(board, RUN)
    assert (planner.flow(run_id=RUN), planner.flow(run_id=RUN)) == (plan, None)
    assert planner.post(run_id=RUN, role='mapper', title='Map core', instructions='Map it.', paths=(),
                        step='mapper', shard='core') == 'task-3'
    assert planner.record_step(run_id=RUN, step='map', action='fan_out', shards=('core',))['recorded'] is True
    assert planner.record_step(run_id=RUN, step='plan', action='complete')['recorded'] is False
    assert [task.step for task in planner.tasks(run_id=RUN)] == ['mapper', '']
    assert board.sent[2:5] == [
        {'op': 'post', 'role': 'mapper', 'title': 'Map core', 'spec': {'instructions': 'Map it.', 'paths': []},
         'flow_step': 'mapper', 'shard': 'core'},
        {'op': 'step', 'step': 'map', 'action': 'fan_out', 'shards': ['core']},
        {'op': 'step', 'step': 'plan', 'action': 'complete'}]


@pytest.mark.parametrize(('call', 'answer'), [
    (lambda planner: planner.flow(run_id=RUN), {}),
    (lambda planner: planner.flow(run_id=RUN), {'flow': []}),
    (lambda planner: planner.record_step(run_id=RUN, step='plan', action='complete'), {'recorded': True}),
], ids=['no-flow', 'flow-not-a-plan', 'no-step'])
def test_a_flow_answer_off_its_shape_is_refused(call: Any, answer: dict[str, Any]):
    from engineering.runtime.harness.board_client import BoardPlanner
    with pytest.raises(BoardRefused, match='502'):
        call(BoardPlanner(Board([answer]), RUN))


def test_until_the_planner_is_wired_its_flow_tools_refuse():
    from engineering.runtime.harness.ports import PendingHarnessPorts
    with pytest.raises(HarnessPortNotWired, match=r'board\.flow'):
        PendingHarnessPorts().flow(run_id=RUN)
    with pytest.raises(HarnessPortNotWired, match=r'board\.step'):
        PendingHarnessPorts().record_step(run_id=RUN, step='map', action='fan_out', shards=('core',))


def test_the_knowledge_reader_answers_a_packages_approved_pack_or_none():
    from engineering.runtime.harness.board_client import BoardKnowledge
    board = Board([{'version': 3, 'text': '<data>conventions</data>'}, {'version': None}])
    reader = BoardKnowledge(board, RUN, 'task-1')
    assert reader.read(run_id=RUN, task_id='task-1', package='') == ['<data>conventions</data>']
    assert reader.read(run_id=RUN, task_id='task-1', package='web') == []
    # The agent's own task goes with each read: the board checks its lease on that one row.
    assert board.sent == [{'op': 'knowledge', 'task_id': 'task-1', 'package': ''},
                          {'op': 'knowledge', 'task_id': 'task-1', 'package': 'web'}]
    with pytest.raises(ValueError, match='its own task'):
        reader.read(run_id=RUN, task_id='task-2', package='')
    assert len(board.sent) == 2
