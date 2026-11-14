"""The harness's broker client (harness/broker_client.py) against the broker's own handler behind a SigV4-checking
function URL (``broker_stub``), and the runtime's handing of the broker's URL to each agent (``VOC_BROKER_URL`` in its
environment, its host on the agent's proxy only)."""
from __future__ import annotations

import http.client
import io
import json
import urllib.error
from dataclasses import dataclass, field
from email.message import Message
from typing import Any, Final

import pytest

from engineering.connectors import handler as connector_handler
from engineering.connectors.broker import EARLIER_UNKNOWN, HUMAN_DRIVEN_REFUSAL, Broker, write_key
from engineering.connectors.hosts import (
    WRITE_CLAIMED,
    WRITE_DONE,
    WRITE_REFUSED,
    WRITE_UNKNOWN,
    CommentTarget,
    Conflict,
    HostError,
    WriteClaim,
)
from engineering.connectors.identity import Caller
from engineering.connectors.test.fakes import (
    ACCOUNT,
    BRANCH,
    PATTERN,
    PERSON,
    RUN,
    TREE,
    FakeDial,
    FakeHost,
    FakeLedger,
    FakeWrites,
    connector,
    role_arn,
    url_event,
)
from engineering.runtime import egress, handler
from engineering.runtime.checkpoints import artifact_prefix
from engineering.runtime.harness import broker_client
from engineering.runtime.harness import main as harness_main
from engineering.runtime.harness.board_client import BoardHttp, BoardRefused, signed_post
from engineering.runtime.harness.broker_client import (
    MAX_ANSWER_BYTES,
    RETRY_WAITS,
    TIMEOUT_SECONDS,
    BrokerHttp,
    SignedBroker,
)
from engineering.runtime.harness.cli import ClaudeCli
from engineering.runtime.harness.ports import (
    OUTCOME_UNKNOWN,
    BrokerRefused,
    HarnessPortNotWired,
    WriteOutcomeUnknown,
)
from engineering.runtime.interface import AgentSpec
from engineering.runtime.test.broker_stub import AgentSessions, Answer, FunctionUrl
from engineering.runtime.test.conftest import BROKER_URL
from engineering.runtime.test.harness_fakes import HARNESS_COMMIT, RUN_ID, FakeBoard, world
from engineering.runtime.unit_runner import AGENT_ENV

URL = 'https://brk456ghi.lambda-url.us-east-1.on.aws/'
COMMIT = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'  # (the fakes' run commit, BASE)
#: A patch a fixer of the fakes' run submitted at its commit.
PATCH = f'{artifact_prefix(RUN, "fixer-2", COMMIT, 1, "patches")}task-2-0a1b2c3d.diff'


def _client(url: FunctionUrl, agent_id: str, *, sleep: Any = None, run_id: str = RUN, attempt: int = 1) -> BrokerHttp:
    transport = SignedBroker(URL, 'us-east-1', url.sessions.credentials(agent_id), opener=url,
                             **({'sleep': sleep} if sleep else {}))
    return BrokerHttp(transport, run_id, agent_id, COMMIT, attempt=attempt)


@dataclass
class FlakyHost(FakeHost):
    """The fakes' host, whose writes fail first as ``failures`` says (by write), each call recorded."""

    failures: dict[str, list[Exception]] = field(default_factory=dict)

    def _fail(self, write: str) -> None:
        if self.failures.get(write):
            raise self.failures[write].pop(0)

    def post_comment(self, connection_id: str, on: CommentTarget, number: int, body: str) -> str:
        self.calls.append(('post_comment', connection_id, on, number, body))
        self._fail('post_comment')
        return f'https://code.example.com/{on}/{number}#comment-{len(self.writes())}'

    def push_bundle(self, connection_id: str, branch: str, contents: Any, tree_hash: str, default_branch: str) -> None:
        self.calls.append(('push_bundle', connection_id, branch, contents, tree_hash, default_branch))
        self._fail('push_bundle')


REVIEW: Final = 'One nit, no blocker.'
#: The claim keys of the PR reviewer's comment and the committer's push below (broker.write_key).
COMMENT_KEY: Final = write_key(Caller('pr-reviewer', RUN, 5), 1, 'post_comment', 'pull_request', 7, REVIEW)
PUSH_KEY: Final = write_key(Caller('committer', RUN, 3), 1, 'push_bundle', BRANCH, PATCH, TREE, 'Fix the refund total')


def _comment(client: BrokerHttp, body: str = REVIEW) -> dict[str, Any]:
    return client.comment(RUN, client.agent_id, number=7, body=body)


def test_a_repeated_comment_answers_the_first_outcome_and_is_never_posted_twice():
    host, writes = FlakyHost(), FakeWrites()
    url = _broker(host=host, writes=writes)
    reviewer = _client(url, 'pr-reviewer-5')
    first = _comment(reviewer)
    # Its continuation asks again (it never heard back, say): the first answer, and no second comment.
    assert (_comment(reviewer), _comment(reviewer), host.writes()) == (first, first, ['post_comment'])
    assert writes.claims[(RUN, COMMENT_KEY)] == WriteClaim(WRITE_DONE, first)
    # Another comment is a write of its own, and so is the same one at a new attempt of the task.
    assert len({first['url'], _comment(reviewer, 'A second finding.')['url'],
                _comment(_client(url, 'pr-reviewer-5', attempt=2))['url']}) == 3
    assert host.writes() == ['post_comment'] * 3


def test_a_write_the_host_may_have_made_is_unknown_and_its_repeat_is_never_made():
    host, writes = FlakyHost(failures={'post_comment': [HostError('The host answered 500.')]}), FakeWrites()
    url = _broker(host=host, writes=writes)
    reviewer = _client(url, 'pr-reviewer-5')
    for _ in range(2):
        with pytest.raises(WriteOutcomeUnknown, match='outcome unknown'):
            _comment(reviewer)
    assert (host.writes(), [status for *_, status, _ in url.calls]) == (['post_comment'], [502, 502])
    assert writes.claims[(RUN, COMMENT_KEY)].state == WRITE_UNKNOWN
    # The broker's own answer to the repeat says why it was not made.
    response = connector_handler.handle(
        url_event(role_arn('pr-reviewer', f'{RUN}.5'),
                  {'operation': 'post_comment', 'args': {'on': 'pull_request', 'number': 7, 'body': REVIEW}}),
        PATTERN, ACCOUNT, url.broker)
    assert (response['statusCode'], json.loads(response['body'])) == (502, {'error': EARLIER_UNKNOWN})


def test_a_write_left_claimed_by_a_crash_is_never_made_again():
    host, writes = FlakyHost(), FakeWrites()
    writes.claims[(RUN, PUSH_KEY)] = WriteClaim(WRITE_CLAIMED)   # (the function died mid-push)
    with pytest.raises(WriteOutcomeUnknown):
        _client(_broker(host=host, writes=writes), 'committer-3').push(
            RUN, 'committer-3', branch=BRANCH, patch_key=PATCH, tree_hash=TREE, message='Fix the refund total')
    assert host.writes() == []


def test_a_refused_write_wrote_nothing_and_may_be_asked_again():
    host = FlakyHost(failures={'push_bundle': [Conflict('The branch moved; nothing was pushed.')]})
    writes = FakeWrites()
    committer = _client(_broker(host=host, writes=writes), 'committer-3')

    def push() -> dict[str, Any]:
        return committer.push(RUN, 'committer-3', branch=BRANCH, patch_key=PATCH, tree_hash=TREE,
                              message='Fix the refund total')

    with pytest.raises(BrokerRefused, match='The branch moved') as refused:
        push()
    assert (refused.value.status, writes.claims[(RUN, PUSH_KEY)].state) == (409, WRITE_REFUSED)
    assert push() == push() == {'branch': BRANCH, 'tree_hash': TREE}
    assert host.writes() == ['push_bundle', 'push_bundle']   # (the refused one, then the one made once)


def _broker(**collaborators: Any) -> FunctionUrl:
    return FunctionUrl(URL, Broker(connector(**collaborators)), AgentSessions(RUN))


def test_the_clients_read_kinds_and_bounds_are_the_brokers():
    assert set(connector_handler._READ_KINDS) == broker_client.READ_KINDS
    assert TIMEOUT_SECONDS > 120  # (the broker function's own limit: its answer always comes first)
    assert MAX_ANSWER_BYTES > connector_handler.MAX_ANSWER_BYTES


def test_each_writer_makes_its_one_write_as_its_own_session_through_the_brokers_checks():
    host = FakeHost()
    url = _broker(host=host)
    pushed = _client(url, 'committer-3').push(RUN, 'committer-3', branch=BRANCH, patch_key=PATCH, tree_hash=TREE,
                                               message='Fix the refund total (fb_0123abcd)')
    opened = _client(url, 'pr-author-4').open_draft_pr(RUN, 'pr-author-4', branch=BRANCH, title='Fix the refund total',
                                                       body='The total is rounded to cents (fb_0123abcd).')
    commented = _client(url, 'pr-reviewer-5').comment(RUN, 'pr-reviewer-5', number=7, body='One nit, no blocker.')
    page = _client(url, 'hunter-6').read(kind='file', target='src/refund.py')
    assert (pushed, opened, commented, page) == (
        {'branch': BRANCH, 'tree_hash': TREE}, {'number': 7, 'url': 'https://code.example.com/pull/7'},
        {'url': 'https://code.example.com/pull_request/7#comment-1'},
        {'content': 'file:src/refund.py', 'next_cursor': 'page-2'})
    assert host.writes() == ['push_bundle', 'open_or_update_draft_pr', 'post_comment']
    # The broker knew each caller from its signed session alone: the role, the run and the agent index.
    assert [(arn, operation, status) for arn, operation, status, _ in url.calls] == [
        (role_arn('committer', f'{RUN}.3'), 'push_bundle', 200),
        (role_arn('pr-author', f'{RUN}.4'), 'open_or_update_draft_pr', 200),
        (role_arn('pr-reviewer', f'{RUN}.5'), 'post_comment', 200), (role_arn('hunter', f'{RUN}.6'), 'read', 200)]
    assert {wait for *_, wait in url.calls} == {TIMEOUT_SECONDS}


@pytest.mark.parametrize(('agent_id', 'call', 'status', 'reason'), [
    # The write rules by role: a fixer pushes nothing; the committer comments on nothing.
    ('fixer-2', lambda c: c.push(RUN, 'fixer-2', branch=BRANCH, patch_key=PATCH, tree_hash=TREE, message='m'), 403,
     'The fixer role may not push bundle.'),
    ('committer-3', lambda c: c.comment(RUN, 'committer-3', number=7, body='b'), 403,
     'The committer role may not post comment.'),
    # The GO ledger: no final-go GO for this tree.
    ('committer-3', lambda c: c.push(RUN, 'committer-3', branch=BRANCH, patch_key=PATCH, tree_hash='f' * 40,
                                     message='m'), 409, 'The board holds no final-go GO for this tree'),
    # Another run's branch.
    ('committer-3', lambda c: c.push(RUN, 'committer-3', branch='voc-agent/01JC8Z3K4M5N6P7Q8R9S0T1V2X/x',
                                     patch_key=PATCH, tree_hash=TREE, message='m'), 422, ''),
    # The write rules on what is written: a person's address in the pull request's body.
    ('pr-author-4', lambda c: c.open_draft_pr(RUN, 'pr-author-4', branch=BRANCH, title='Fix the total',
                                              body=f'Reported by {PERSON}.'), 422, ''),
], ids=['fixer-push', 'committer-comment', 'no-go', 'other-run', 'personal-data'])
def test_the_broker_refuses_what_its_rules_forbid_and_the_client_says_why(agent_id: str, call: Any, status: int,
                                                                          reason: str):
    host = FakeHost()
    with pytest.raises(BrokerRefused) as refused:
        call(_client(_broker(host=host), agent_id))
    assert refused.value.status == status
    assert str(refused.value).startswith(f'the broker refused ({status}): {reason}')
    assert host.writes() == []


def test_a_human_driven_run_pushes_nothing_whatever_the_agent_asks():
    host = FakeHost()
    url = _broker(host=host, dial=FakeDial({'person-sub-1': 'human_driven'}))
    with pytest.raises(BrokerRefused, match='Human-driven') as refused:
        _client(url, 'committer-3').push(RUN, 'committer-3', branch=BRANCH, patch_key=PATCH, tree_hash=TREE,
                                         message='m')
    assert (refused.value.status, HUMAN_DRIVEN_REFUSAL[:40] in str(refused.value), host.writes()) == (409, True, [])


def test_an_unsigned_tampered_or_foreign_request_never_reaches_the_broker():
    from botocore.credentials import Credentials as Session
    host = FakeHost()
    url = _broker(host=host, ledger=FakeLedger({(RUN, TREE)}))
    session = url.sessions.credentials('committer-3')
    body = {'operation': 'read', 'args': {'kind': 'file', 'target': 'a.py'}}
    assert url.verified(signed_post(URL, 'us-east-1', session, body)) == role_arn('committer', f'{RUN}.3')
    tampered = signed_post(URL, 'us-east-1', session, body)
    tampered.data = json.dumps({'operation': 'read', 'args': {'kind': 'file', 'target': 'b.py'}}).encode()
    elsewhere = signed_post('https://abc123def.lambda-url.us-east-1.on.aws/', 'us-east-1', session, body)
    other_region = signed_post(URL, 'eu-west-1', session, body)
    unsigned = signed_post(URL, 'us-east-1', session, body)
    unsigned.remove_header('Authorization')
    stranger = signed_post(URL, 'us-east-1', Session('ASIAEXAMPLEEXAMPLE00', 'not-issued', 't'), body)
    assert [url.verified(request) for request in (tampered, elsewhere, other_region, unsigned, stranger)] == [None] * 5
    with pytest.raises(BrokerRefused, match='Forbidden') as forbidden:
        BrokerHttp(SignedBroker(URL, 'us-east-1', Session('ASIAEXAMPLEEXAMPLE00', 'x', 't'), opener=url), RUN,
                   'committer-3', COMMIT).read(kind='file', target='a.py')
    assert forbidden.value.status == 403
    # A role that is not an agent role, signed by a session the stub issued: the broker's own identity check.
    outsider = SignedBroker(URL, 'us-east-1', url.sessions.credentials('mapper-1', role_name='voc-other-role'),
                            opener=url)
    with pytest.raises(BrokerRefused, match='not an engineering agent') as refused:
        BrokerHttp(outsider, RUN, 'mapper-1', COMMIT).read(kind='file', target='a.py')
    assert (refused.value.status, host.calls) == (403, [])


class _Cut(Answer):
    """An answer whose body is cut on the way (``IncompleteRead``)."""

    def __init__(self) -> None:
        super().__init__(b'')

    def read(self, limit: int) -> bytes:
        del limit
        raise http.client.IncompleteRead(b'{"res', 40)


CUT: Final = _Cut()


class Replies:
    """The function URL's answers in turn: a status (an error: the broker's own 503 says it wrote nothing, any other
    the function URL's ``{"Message"}``), a ``(status, body)``, an exception, ``CUT``, or a JSON body."""

    def __init__(self, *replies: Any) -> None:
        self.replies = list(replies)
        self.calls = 0

    def open(self, request: Any, timeout: float) -> Any:
        del timeout
        self.calls += 1
        reply = self.replies.pop(0)
        if isinstance(reply, int):
            reply = (reply, b'{"error": "The host is rate limiting; retry."}' if reply == 503
                     else b'{"Message": "Forbidden"}')
        if isinstance(reply, tuple):
            raise urllib.error.HTTPError(request.full_url, reply[0], 'refused', Message(), io.BytesIO(reply[1]))
        if isinstance(reply, Exception):
            raise reply
        if reply is CUT:
            return CUT
        raw = reply if isinstance(reply, bytes) else json.dumps(reply).encode()
        return Answer(raw)


class Credentials:
    def get_frozen_credentials(self) -> Any:
        from botocore.credentials import ReadOnlyCredentials
        return ReadOnlyCredentials('AKIDEXAMPLE', 'secret', 'session-token')


def _http(replies: Replies, agent_id: str = 'committer-3') -> tuple[BrokerHttp, list[float]]:
    waits: list[float] = []
    return BrokerHttp(SignedBroker(URL, 'us-east-1', Credentials(), sleep=waits.append, opener=replies), RUN, agent_id,
                      COMMIT), waits


def test_a_read_is_retried_on_a_503_or_a_lost_connection_backing_off():
    replies = Replies(503, urllib.error.URLError('reset'), {'result': {'content': 'x', 'next_cursor': None}})
    client, waits = _http(replies)
    assert client.read(kind='issue', target='42') == {'content': 'x', 'next_cursor': None}
    assert (replies.calls, waits) == (3, list(RETRY_WAITS))


#: Each write, as the client sends it.
WRITES: Final = {
    'push': lambda c: c.push(RUN, 'committer-3', branch=BRANCH, patch_key=PATCH, tree_hash=TREE, message='m'),
    'open_draft_pr': lambda c: c.open_draft_pr(RUN, 'committer-3', branch=BRANCH, title='t', body='b'),
    'comment': lambda c: c.comment(RUN, 'committer-3', number=7, body='b'),
}
#: What may hide a write the broker made: no whole answer, a 5xx other than the broker's own 503, a 200 the client
#: cannot read.
UNKNOWN_REPLIES: Final = {
    'lost': urllib.error.URLError('reset'), 'timeout': TimeoutError(), 'reset': ConnectionResetError(),
    'incomplete-read': CUT, 'protocol': http.client.RemoteDisconnected('closed'),
    'function-url-502': (502, b'{"Message": "Internal Server Error"}'), 'function-url-504': (504, b''),
    'function-url-503': (503, b'{"Message": "Service Unavailable"}'),
    'brokers-502': (502, b'{"error": "The host answered 500. Whether the write was made is not known."}'),
    'cut-error-body': (502, b'{"error": "The ho'),
    'no-result': {'result': 'pushed'}, 'off-shape': {'result': {'branch': BRANCH, 'number': True}},
    'not-object': b'[1, 2]', 'not-json': b'{not json', 'too-large': b'x' * (MAX_ANSWER_BYTES + 1),
}


@pytest.mark.parametrize('write', sorted(WRITES))
@pytest.mark.parametrize('reply', sorted(UNKNOWN_REPLIES))
def test_a_write_whose_outcome_is_unknown_is_never_a_refusal_and_never_retried(write: str, reply: str):
    replies = Replies(UNKNOWN_REPLIES[reply], {'result': {}})
    client, waits = _http(replies)
    with pytest.raises(WriteOutcomeUnknown) as unknown:
        WRITES[write](client)
    assert (str(unknown.value), replies.calls, waits) == (OUTCOME_UNKNOWN, 1, [])
    assert not isinstance(unknown.value, BrokerRefused)


@pytest.mark.parametrize(('reply', 'status', 'said'), [
    (403, 403, 'Forbidden'),  # the function URL's own IAM refusal: the function never ran
    (503, 503, 'The host is rate limiting; retry.'),  # the broker's own 503: nothing written
    ((409, b'{"error": "The board holds no final-go GO for this tree."}'), 409, 'no final-go GO'),
    ((429, b'{"Message": "Too Many Requests"}'), 429, 'Too Many Requests'),  # throttled before the function ran
], ids=['iam', 'brokers-503', 'brokers-409', 'throttled'])
def test_a_write_the_broker_refused_is_a_plain_refusal_sent_once(reply: Any, status: int, said: str):
    for write in WRITES.values():
        replies = Replies(reply)
        client, waits = _http(replies)
        with pytest.raises(BrokerRefused, match=said) as refused:
            write(client)
        assert (refused.value.status, replies.calls, waits) == (status, 1, [])


@pytest.mark.parametrize('reply', [b'[1, 2]', b'x' * (MAX_ANSWER_BYTES + 1), CUT, {'result': 'page'}],
                         ids=['not-object', 'too-large', 'cut', 'no-result'])
def test_a_reads_unreadable_answer_is_a_refusal_it_retries_only_when_lost(reply: Any):
    replies = Replies(reply, {'result': {'content': 'x', 'next_cursor': None}})
    client, _ = _http(replies)
    if reply is CUT:   # (lost on the way: retried, as a read may be)
        assert client.read(kind='file', target='a.py')['content'] == 'x'
        return
    with pytest.raises(BrokerRefused) as refused:
        client.read(kind='file', target='a.py')
    assert (refused.value.status, replies.calls) == (502, 1)


def test_each_write_carries_the_agents_attempt():
    sent: list[dict[str, Any]] = []

    class Recording:
        def call(self, operation: str, args: Any) -> dict[str, Any]:
            sent.append({'operation': operation, **args})
            return {'branch': BRANCH, 'tree_hash': TREE, 'number': 7, 'url': 'u'}

    client = BrokerHttp(Recording(), RUN, 'committer-3', COMMIT, attempt=4)
    for write in WRITES.values():
        write(client)
    assert [(body['operation'], body['attempt']) for body in sent] == [
        ('push_bundle', 4), ('open_or_update_draft_pr', 4), ('post_comment', 4)]


def test_a_page_off_its_shape_and_a_read_of_an_unknown_kind_are_refused():
    client, _ = _http(Replies({'result': {'content': 1, 'next_cursor': None}}))
    with pytest.raises(BrokerRefused, match='no page'):
        client.read(kind='file', target='a.py', cursor='2')
    with pytest.raises(ValueError, match='a read is of one of'):
        client.read(kind='settings', target='a')


def test_a_redirect_is_refused_and_never_followed():
    with pytest.raises(BrokerRefused, match='redirect') as refused:
        broker_client._NoRedirect().redirect_request(None, None, 307, 'Temporary Redirect', {}, 'https://x.example.org/')
    assert refused.value.status == 307
    assert any(isinstance(h, broker_client._NoRedirect) for h in getattr(broker_client._OPENER, 'handlers', []))


def test_the_client_speaks_for_its_own_agent_only():
    replies = Replies()
    client, _ = _http(replies)
    for call in (lambda: client.push(RUN, 'committer-4', branch=BRANCH, patch_key=PATCH, tree_hash=TREE, message='m'),
                 lambda: client.open_draft_pr(RUN_ID, 'committer-3', branch=BRANCH, title='t', body='b'),
                 lambda: client.comment(RUN, 'pr-reviewer-5', number=7, body='b')):
        with pytest.raises(ValueError, match='its own agent only'):
            call()
    assert replies.calls == 0


def test_a_submission_is_the_patch_under_the_agents_own_keys_and_makes_no_call():
    replies = Replies()
    client, _ = _http(replies, 'fixer-2')
    assert 'quality gate' in client.submit(RUN, 'fixer-2', 'task-2', PATCH, 'the fix')
    for key in (PATCH.replace('fixer-2', 'fixer-3'),  # another agent's
                PATCH.replace(COMMIT, 'b' * 40),  # another commit's
                PATCH.replace('task-2-0a1b2c3d', 'checkpoint-000001'),  # a checkpoint's snapshot
                f'{artifact_prefix(RUN, "fixer-2", COMMIT, 1, "gate")}record.json'):
        with pytest.raises(ValueError, match='only a patch a fixer or builder'):
            client.submit(RUN, 'fixer-2', 'task-2', key, 'the fix')
    hunter, _ = _http(replies, 'hunter-1')
    with pytest.raises(ValueError, match='only a patch a fixer or builder'):
        hunter.submit(RUN, 'hunter-1', 'task-1', PATCH.replace('fixer-2', 'hunter-1'), 'not a fix')
    assert replies.calls == 0


def test_the_fixers_submit_work_reaches_the_broker_client_and_a_refusal_is_a_result_the_model_reads(tmp_path):
    fixer = world(tmp_path / 'fixer', role='fixer')
    fixer.session.context.broker = BrokerHttp(SignedBroker(URL, 'us-east-1', Credentials(), opener=Replies()), RUN_ID,
                                              'fixer-1', HARNESS_COMMIT)
    submitted = json.loads(fixer.session.tools.call('submit_work', {'summary': 'the fix'}).text)
    assert (submitted['patch'] in fixer.store.objects, 'quality gate' in submitted['broker']) == (True, True)
    assert fixer.session.context.result_keys == [submitted['patch']]
    committer = world(tmp_path / 'committer', role='committer')
    committer.session.context.agent_id = 'committer-1'
    committer.session.context.broker = BrokerHttp(SignedBroker(URL, 'us-east-1', Credentials(), opener=Replies(409)),
                                                  RUN_ID, 'committer-1', HARNESS_COMMIT)
    refused = committer.session.tools.call('push_commit', {
        'branch': f'voc-agent/{RUN_ID}/fix', 'patch': submitted['patch'], 'tree_hash': TREE, 'message': 'Fix it'})
    assert (refused.error, refused.text) == (True, 'push_commit refused: the broker refused (409): Forbidden')


@pytest.mark.parametrize(('role', 'tool', 'arguments'), [
    ('committer', 'push_commit', {'branch': f'voc-agent/{RUN_ID}/fix', 'tree_hash': TREE, 'message': 'Fix it'}),
    ('pr-author', 'open_draft_pr', {'branch': f'voc-agent/{RUN_ID}/fix', 'title': 't', 'body': 'b'}),
    ('pr-reviewer', 'post_comment', {'number': 7, 'body': 'One nit.'}),
])
def test_a_write_whose_outcome_is_unknown_is_told_as_unknown_never_refused_never_a_crash(
        tmp_path, role: str, tool: str, arguments: dict[str, Any]):
    w = world(tmp_path, role=role)
    w.session.context.agent_id = f'{role}-1'
    if tool == 'push_commit':
        arguments = {**arguments, 'patch': f'{artifact_prefix(RUN_ID, "fixer-2", HARNESS_COMMIT, 1, "patches")}t.diff'}
    for reply in (TimeoutError(), CUT, (504, b'')):
        w.session.context.broker = BrokerHttp(SignedBroker(URL, 'us-east-1', Credentials(), opener=Replies(reply)),
                                              RUN_ID, f'{role}-1', HARNESS_COMMIT)
        told = w.session.tools.call(tool, arguments)
        assert (told.error, told.text) == (True, f'{tool}: outcome unknown: do not repeat it; it stays unknown until a person checks the host')
        assert 'refused' not in told.text
    # The task's progress says so too, for the run (the board's last progress on the task).
    assert w.board.progress_seen[-1][3] == f'{tool}: {OUTCOME_UNKNOWN}'


class FailingBoard(FakeBoard):
    """A board that refuses (or cannot be reached for) every progress report."""

    def progress(self, run_id: str, task_id: str, agent_id: str, step: str) -> None:
        super().progress(run_id, task_id, agent_id, step)
        raise BoardRefused(503, 'retry')


@pytest.mark.parametrize(('role', 'tool', 'arguments', 'made'), [
    ('committer', 'push_commit', {'branch': f'voc-agent/{RUN_ID}/fix', 'tree_hash': TREE, 'message': 'Fix it'},
     {'result': {'branch': f'voc-agent/{RUN_ID}/fix', 'tree_hash': TREE}}),
    ('pr-author', 'open_draft_pr', {'branch': f'voc-agent/{RUN_ID}/fix', 'title': 't', 'body': 'b'},
     {'result': {'number': 7, 'url': 'https://code.example.com/pull/7'}}),
    ('pr-reviewer', 'post_comment', {'number': 7, 'body': 'One nit.'},
     {'result': {'url': 'https://code.example.com/pull/7#comment-1'}}),
])
def test_a_board_that_fails_after_a_write_never_crashes_the_session(tmp_path, role: str, tool: str,
                                                                     arguments: dict[str, Any], made: Any):
    w = world(tmp_path, role=role)
    w.session.context.agent_id = f'{role}-1'
    w.session.context.board = board = FailingBoard()
    if tool == 'push_commit':
        arguments = {**arguments, 'patch': f'{artifact_prefix(RUN_ID, "fixer-2", HARNESS_COMMIT, 1, "patches")}t.diff'}
    for reply, error in ((TimeoutError(), True), (made, False)):   # an unknown outcome, then a write made
        w.session.context.broker = BrokerHttp(SignedBroker(URL, 'us-east-1', Credentials(), opener=Replies(reply)),
                                              RUN_ID, f'{role}-1', HARNESS_COMMIT)
        told = w.session.tools.call(tool, arguments)
        assert told.error is error
        assert OUTCOME_UNKNOWN in told.text if error else json.loads(told.text)['broker'] == made['result']
    # Each was reported to the board (which refused it) and kept in the session's own status.
    assert len(board.progress_seen) == 2
    assert w.session.context.status.step == board.progress_seen[-1][3]


ENV = {'VOC_BOARD_URL': 'https://abc123def.lambda-url.us-east-1.on.aws/', 'VOC_BROKER_URL': URL,
       'AWS_REGION': 'us-east-1', 'VOC_RUN_ID': RUN, 'VOC_TASK_ID': 'task-3', 'VOC_AGENT_ID': 'committer-3',
       'VOC_COMMIT': COMMIT}


def test_the_harness_wires_its_broker_on_the_brokers_url_and_refuses_without_it():
    ports = harness_main.default_ports(ENV, Credentials())
    assert isinstance(ports.broker, BrokerHttp)
    assert isinstance(ports.broker.transport, SignedBroker)
    assert (ports.broker.transport.url, ports.broker.run_id, ports.broker.agent_id, ports.broker.commit) == (
        URL, RUN, 'committer-3', COMMIT)
    # Without a board URL the board stays unwired; without a broker URL the broker refuses.
    alone = harness_main.default_ports({**ENV, 'VOC_BOARD_URL': ''}, Credentials())
    assert (isinstance(alone.broker, BrokerHttp), isinstance(alone.board, BoardHttp)) == (True, False)
    without = harness_main.default_ports({**ENV, 'VOC_BROKER_URL': ''}, Credentials())
    with pytest.raises(HarnessPortNotWired, match=r'broker\.push'):
        without.broker.push(RUN, 'committer-3', branch=BRANCH, patch_key=PATCH, tree_hash=TREE, message='m')
    with pytest.raises(ValueError, match='not a function URL'):
        harness_main.default_ports({**ENV, 'VOC_BROKER_URL': 'https://broker.example.org/'}, Credentials())


def test_the_clis_tool_server_is_handed_the_brokers_url_too(tmp_path):
    args = harness_main._parser().parse_args(['run', '--adapter', 'cli', '--model', 'model-a'])
    env = {**ENV, 'HOME': str(tmp_path), 'AWS_CONFIG_FILE': str(tmp_path / 'config'), 'VOC_ROLE': 'committer'}
    cli = harness_main.adapter_for(args, env, lambda: None)
    assert isinstance(cli, ClaudeCli)
    assert cli._tool_env['VOC_BROKER_URL'] == URL


def test_the_agent_is_handed_the_brokers_url_and_the_runner_passes_it_on():
    spec = AgentSpec(run_id=RUN, agent_id='fixer-1', role='fixer', task_id='task-1', language='python', egress=(),
                     connection='conn-1', broker_url=URL)
    assert (spec.environment()['VOC_BROKER_URL'], 'VOC_BROKER_URL' in AGENT_ENV) == (URL, True)
    assert 'VOC_BROKER_URL' not in AgentSpec(run_id=RUN, agent_id='fixer-1', role='fixer', task_id='task-1',
                                             language='python', egress=(), connection='conn-1').environment()


def test_the_brokers_host_is_on_the_agents_proxy_and_never_on_repository_codes():
    host = 'brk456ghi.lambda-url.us-east-1.on.aws'
    for role in ('fixer', 'committer'):
        agent, code = egress.split(egress.egress_allowlist(
            role=role, language='python', region='us-east-1', bucket='voc-raw-test',
            service_urls=['https://abc123def.lambda-url.us-east-1.on.aws/', URL]))
        assert (host in agent, host in code, any(name.startswith('lambda.') for name in agent + code)) == (
            True, False, False)


def test_the_launch_hands_each_agent_the_brokers_url_and_its_host_on_the_agents_proxy(wired: Any,
                                                                                      monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    supervisor = handler._supervisor()
    specs: list[AgentSpec] = []
    started = supervisor.runtime.run
    monkeypatch.setattr(supervisor.runtime, 'run', lambda spec: specs.append(spec) or started(spec))
    handler.lambda_handler({'action': 'launch', 'run_id': '01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'agent_id': 'fixer-1',
                            'role': 'fixer', 'task_id': 'task-1', 'language': 'python', 'connection': 'conn-1',
                            'commit': 'a' * 40, 'paths': ['src']}, None)
    [spec] = specs
    agent, code = egress.split(spec.egress)
    host = BROKER_URL.removeprefix('https://').rstrip('/')
    assert (spec.environment()['VOC_BROKER_URL'], host in agent, host in code) == (BROKER_URL, True, False)
    # A continuation is handed it too: the supervisor's spec of the session it continues.
    session = supervisor.sessions.get('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1')
    assert session is not None
    continued = session.spec(None, supervisor.workspace_bucket, supervisor.board_url, supervisor.broker_url)
    assert (continued.environment()['VOC_BROKER_URL'], continued.egress) == (BROKER_URL, spec.egress)
