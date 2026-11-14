"""The broker's function URL: status codes, strict bodies, nothing echoed (docs/autonomous-engineering.md)."""
from __future__ import annotations

import base64
import json
from collections.abc import Callable, Mapping
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from moto import mock_aws

from engineering.board.test.table import create_table
from engineering.connectors import handler
from engineering.connectors.broker import Broker
from engineering.connectors.connections import PARAMETER_PREFIX_ENV
from engineering.connectors.dial import WaysOfWorking
from engineering.connectors.github import GitHubHost
from engineering.connectors.hosts import (
    NO_CONNECTION,
    STORED_BRANCH_MISSING,
    UNCONNECTED,
    Conflict,
    HostBusy,
    HostError,
    InvalidTarget,
    NoConnection,
    NotFound,
    ReadKind,
    ReadPage,
    RunRecord,
    Submission,
    Unavailable,
)
from engineering.connectors.patches import WorkspacePatches
from engineering.connectors.records import RunRecords
from engineering.connectors.test.fakes import (
    ACCOUNT,
    BASE,
    BRANCH,
    OTHER_RUN,
    PATTERN,
    REVIEW,
    RUN,
    STARTER,
    TREE,
    FakeBundles,
    FakeDial,
    FakeHost,
    FakeLedger,
    FakeRuns,
    connector,
    record,
    role_arn,
    url_event,
)

TOKEN = 'ghs_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
PATCH = f'ws/default/runs/{RUN}/committer-3/commits/{BASE}/_patches/attempt-1/task-1-0a1b2c3d.diff'
#: A committer's push: its submitted patch, as one commit, for the tree the GO names.
PUSH = {'branch': BRANCH, 'patch': PATCH, 'tree_hash': TREE, 'message': 'Fix the refund total (fb_0123abcd)'}


def answer(event: dict[str, object], broker: Broker | None = None) -> tuple[int, dict[str, Any]]:
    response = handler.handle(event, PATTERN, ACCOUNT, broker or Broker(connector()))
    assert response['headers'] == {'Content-Type': 'application/json'}
    return response['statusCode'], json.loads(response['body'])


def ask(role: str, operation: str, args: Mapping[str, object], broker: Broker | None = None) -> tuple[int, dict]:
    return answer(url_event(role_arn(role), {'operation': operation, 'args': args}), broker)


def test_an_answer_over_the_function_url_limit_is_refused_not_cut(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(handler, 'MAX_ANSWER_BYTES', 100)
    small = handler._response(200, {'x': 'y'})
    large = handler._response(200, {'x': 'é' * 60})
    assert (small['statusCode'], json.loads(small['body'])) == (200, {'x': 'y'})
    assert large['statusCode'] == 502
    assert 'smaller page' in json.loads(large['body'])['error']


def test_reads_for_any_agent() -> None:
    status, body = ask('mapper', 'read', {'kind': 'file', 'target': 'README.md'})
    assert (status, body) == (200, {'result': {'content': 'file:README.md', 'next_cursor': 'page-2'}})


def test_a_read_takes_a_cursor() -> None:
    status, body = ask('hunter', 'read', {'kind': 'issue', 'target': '42', 'cursor': 'page-2'})
    assert (status, body['result']['next_cursor']) == (200, None)


def test_posts_a_comment() -> None:
    status, body = ask('understander', 'post_comment', {'on': 'issue', 'number': 42, 'body': 'Bug: src/a.py:3.'})
    assert (status, body) == (200, {'result': {'url': 'https://code.example.com/issue/42#comment-1'}})


def test_pushes_the_committers_submitted_patch() -> None:
    host, bundles = FakeHost(), FakeBundles()
    status, body = ask('committer', 'push_bundle', PUSH, Broker(connector(host=host, bundles=bundles)))
    assert (status, body) == (200, {'result': {'branch': BRANCH, 'tree_hash': TREE}})
    (submission,) = bundles.read
    assert (submission.key, submission.agent_id, submission.tree_hash, submission.message) == (
        PATCH, 'committer-3', TREE, PUSH['message'])
    assert host.calls[-1] == ('push_bundle', 'conn-1', BRANCH, bundles.contents_, TREE, 'main')


def test_opens_a_draft_pull_request() -> None:
    status, body = ask('pr-author', 'open_or_update_draft_pr', {'branch': BRANCH, 'title': 'Fix', 'body': 'fb_01'})
    assert (status, body) == (200, {'result': {'number': 7, 'url': 'https://code.example.com/pull/7'}})


@pytest.mark.parametrize('user_arn', [None, 'arn:aws:iam::111111111111:user/someone',
                                      role_arn('committer', 'not-a-run.1'), role_arn('admin'),
                                      role_arn('mapper', account='222222222222')])
def test_403_for_a_caller_that_is_not_an_agent(user_arn: str | None) -> None:
    host = FakeHost()
    status, body = answer(url_event(user_arn, {'operation': 'read', 'args': {}}), Broker(connector(host=host)))
    assert (status, body) == (403, {'error': 'The caller is not an engineering agent.'})
    assert host.calls == []


def test_403_for_a_role_that_may_not_make_the_operation() -> None:
    status, body = ask('fixer', 'push_bundle', PUSH)
    assert (status, body) == (403, {'error': 'The fixer role may not push bundle.'})


def test_403_for_a_comment_on_another_issue() -> None:
    host = FakeHost()
    status, body = ask('understander', 'post_comment', {'on': 'issue', 'number': 41, 'body': 'Bug.'},
                       Broker(connector(host=host)))
    assert (status, body) == (403, {'error': "An agent comments only on its own run's issue."})
    assert host.writes() == []


@pytest.mark.parametrize('body', [
    None, '', 'not json', '[]', '{"operation": "read"}',
    {'operation': 'read', 'args': {}, 'role': 'committer'},
    {'operation': 'merge', 'args': {}},
    {'operation': 'approve', 'args': {}},
    {'operation': 'read', 'args': []},
    {'operation': 7, 'args': {}},
])
def test_400_for_a_body_that_is_not_a_request(body: object) -> None:
    status, answered = answer(url_event(role_arn('committer'), body))
    assert status == 400
    assert answered['error']


@pytest.mark.parametrize(('role', 'operation', 'args'), [
    ('mapper', 'read', {'kind': 'secrets', 'target': 'x'}),
    ('mapper', 'read', {'kind': 'file'}),
    ('mapper', 'read', {'kind': 'file', 'target': ''}),
    ('mapper', 'read', {'kind': 'file', 'target': 'x' * 1025}),
    ('mapper', 'read', {'kind': 'file', 'target': 'a', 'ref': 'main'}),
    ('mapper', 'read', {'kind': 'file', 'target': 'a', 'cursor': 3}),
    ('pr-reviewer', 'post_comment', {'on': 'issue', 'number': True, 'body': 'x'}),
    ('pr-reviewer', 'post_comment', {'on': 'issue', 'number': 0, 'body': 'x'}),
    ('pr-reviewer', 'post_comment', {'on': 'issue', 'number': '3', 'body': 'x'}),
    ('pr-reviewer', 'post_comment', {'on': 'commit', 'number': 3, 'body': 'x'}),
    ('pr-reviewer', 'post_comment', {'on': 'issue', 'number': 3, 'body': 'x' * 65_537}),
    ('committer', 'push_bundle', {**PUSH, 'tree_hash': 'not-a-tree'}),
    ('committer', 'push_bundle', {**PUSH, 'tree_hash': TREE.upper()}),
    ('committer', 'push_bundle', {**PUSH, 'message': ''}),
    ('committer', 'push_bundle', {**PUSH, 'patch': 'x' * 1025}),
    ('committer', 'push_bundle', {'branch': BRANCH, 'patch': PATCH}),
    ('committer', 'push_bundle', {**PUSH, 'bundle': 'Z2l0'}),
    ('committer', 'push_bundle', {**PUSH, 'run_id': OTHER_RUN}),
    ('pr-author', 'open_or_update_draft_pr', {'branch': BRANCH, 'title': 'Fix', 'body': 'x', 'draft': False}),
])
def test_400_for_args_that_are_not_the_operations(role: str, operation: str, args: dict[str, object]) -> None:
    host = FakeHost()
    status, body = ask(role, operation, args, Broker(connector(host=host)))
    assert status == 400
    assert body['error']
    assert host.writes() == []


def test_reads_a_base64_encoded_body() -> None:
    event = url_event(role_arn('mapper'))
    event.update(isBase64Encoded=True,
                 body=base64.b64encode(json.dumps({'operation': 'read', 'args': {'kind': 'file', 'target': 'a'}})
                                       .encode()).decode())
    assert answer(event)[0] == 200


def test_400_for_a_body_over_the_function_url_limit() -> None:
    event = url_event(role_arn('mapper'), 'x' * (handler.MAX_BODY_CHARS + 1))
    assert answer(event)[0] == 400


def test_409_for_a_stopped_run() -> None:
    broker = Broker(connector(runs=FakeRuns({RUN: record(status='stopped')})))
    status, body = ask('mapper', 'read', {'kind': 'file', 'target': 'a'}, broker)
    assert (status, body) == (409, {'error': 'The run is stopped; the broker refuses its operations.'})


def test_409_while_the_connections_stored_default_branch_is_not_on_the_repository() -> None:
    host = FakeHost(branches=('main',))
    broker = Broker(connector(host=host, runs=FakeRuns({RUN: record(stored_default_branch='gone')})))
    status, body = ask('mapper', 'read', {'kind': 'file', 'target': 'a'}, broker)
    assert (status, body) == (409, {'error': STORED_BRANCH_MISSING})
    assert host.calls == []


def test_409_for_a_push_without_a_go() -> None:
    broker = Broker(connector(ledger=FakeLedger()))
    status, body = ask('committer', 'push_bundle', PUSH, broker)
    assert status == 409
    assert 'no final-go GO' in body['error']


@pytest.mark.parametrize(('mode', 'expected'), [('human_driven', 'Human-driven'), ('ai_assisted', 'AI-assisted')])
def test_409_for_a_push_the_dial_holds(mode: str, expected: str) -> None:
    broker = Broker(connector(dial=FakeDial({STARTER: mode})))
    status, body = ask('committer', 'push_bundle', PUSH, broker)
    assert (status, expected in body['error']) == (409, True)


def test_422_for_another_runs_branch() -> None:
    status, body = ask('committer', 'push_bundle', {**PUSH, 'branch': f'voc-agent/{OTHER_RUN}/x'})
    assert status == 422
    assert "own run's branches" in body['error']


def test_503_while_the_runs_records_cannot_be_read() -> None:
    class Unreadable(FakeRuns):
        def run(self, run_id: str) -> RunRecord | None:  # noqa: ARG002 - FakeRuns's signature
            raise Unavailable("The run's record could not be read; retry.")

    status, body = ask('mapper', 'read', {'kind': 'file', 'target': 'a'}, Broker(connector(runs=Unreadable())))
    assert (status, body) == (503, {'error': "The run's record could not be read; retry."})


def test_422_for_a_comment_quoting_a_review_and_the_quote_is_not_echoed() -> None:
    status, body = ask('pr-reviewer', 'post_comment', {'on': 'pull_request', 'number': 7, 'body': REVIEW})
    assert status == 422
    assert REVIEW not in json.dumps(body)


def test_503_for_every_operation_with_no_connection() -> None:
    for role, operation, args in [('mapper', 'read', {'kind': 'file', 'target': 'a'}),
                                  ('committer', 'push_bundle', PUSH)]:
        assert ask(role, operation, args, Broker(None)) == (503, {'error': NO_CONNECTION})


def logged(caplog: pytest.LogCaptureFixture) -> str:
    """Every log record of the call, its extra fields included."""
    return json.dumps([{k: str(v) for k, v in vars(r).items()} for r in caplog.records])


@pytest.mark.parametrize('args', [
    {'kind': 'file', 'target': 'a', 'token': TOKEN},            # 400: an extra key
    {'kind': 'file', 'target': TOKEN, 'cursor': TOKEN * 40},     # 400: a cursor too long
])
def test_never_echoes_or_logs_a_token(args: dict[str, object], caplog: pytest.LogCaptureFixture) -> None:
    status, body = ask('mapper', 'read', args)
    assert status == 400
    assert TOKEN not in json.dumps(body)
    assert caplog.records
    assert TOKEN not in logged(caplog)


def test_the_log_line_has_the_caller_and_status_not_the_body(caplog: pytest.LogCaptureFixture) -> None:
    ask('pr-reviewer', 'post_comment', {'on': 'issue', 'number': 42, 'body': f'Secret {TOKEN}'})
    line = next(r for r in caplog.records if r.getMessage() == 'broker call')
    fields = vars(line)
    assert [fields[k] for k in ('operation', 'role', 'run_id', 'agent', 'status')] == [
        'post_comment', 'pr-reviewer', RUN, 3, 200]
    assert TOKEN not in logged(caplog)


def test_an_unknown_caller_is_logged_without_its_request(caplog: pytest.LogCaptureFixture) -> None:
    answer(url_event(role_arn('admin'), {'operation': 'read', 'args': {'target': TOKEN}}))
    assert [r.getMessage() for r in caplog.records] == ['broker call refused']
    assert TOKEN not in logged(caplog)


def lambda_context(account: str = ACCOUNT) -> MagicMock:
    return MagicMock(function_name='voc-engineering-broker', memory_limit_in_mb=256,
                     invoked_function_arn=f'arn:aws:lambda:us-east-1:{account}:function:voc-engineering-broker')


READ_A = {'operation': 'read', 'args': {'kind': 'file', 'target': 'a'}}


def test_the_lambda_refuses_every_operation_until_a_connection_exists(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(handler.ROLE_NAME_PATTERN_ENV, PATTERN)
    response = handler.lambda_handler(url_event(role_arn('mapper'), READ_A), lambda_context())
    assert (response['statusCode'], json.loads(response['body'])) == (503, {'error': NO_CONNECTION})


def test_with_the_parameter_prefix_the_broker_holds_the_github_client_and_still_answers_503(
        monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(handler.ROLE_NAME_PATTERN_ENV, PATTERN)
    monkeypatch.setenv(PARAMETER_PREFIX_ENV, '/voc/engineering/')
    handler.broker_for.cache_clear()
    try:
        response = handler.lambda_handler(url_event(role_arn('mapper'), READ_A), lambda_context())
        connected = handler.broker_for('/voc/engineering/')._connector
    finally:
        handler.broker_for.cache_clear()
    # Without the engineering table and the workspace bucket named, no run is read and nothing reaches GitHub (or SSM).
    assert (response['statusCode'], json.loads(response['body'])) == (503, {'error': NO_CONNECTION})
    assert connected is not None
    assert isinstance(connected.host, GitHubHost)
    assert (connected.runs, connected.ledger, connected.bundles, connected.dial) == (UNCONNECTED,) * 4
    assert handler.broker_for('')._connector is None


def test_with_its_stores_named_the_broker_reads_the_callers_run_from_its_record(
        monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in ((handler.ROLE_NAME_PATTERN_ENV, PATTERN), (PARAMETER_PREFIX_ENV, '/voc/engineering/'),
                        (handler.TABLE_ENV, 'voc-engineering'), (handler.BUCKET_ENV, 'voc-eng-workspace'),
                        (handler.AGGREGATES_ENV, 'voc-aggregates')):
        monkeypatch.setenv(name, value)
    handler.broker_for.cache_clear()
    with mock_aws():
        client = create_table()
        try:
            with patch('shared.aws.get_dynamodb_client', return_value=client), \
                    patch('shared.aws.get_s3_client', return_value=MagicMock()), \
                    patch('shared.aws.get_dynamodb_resource', return_value=MagicMock()):
                response = handler.lambda_handler(url_event(role_arn('mapper'), READ_A), lambda_context())
                connected = handler.broker_for('/voc/engineering/', 'voc-engineering', 'voc-eng-workspace',
                                               'voc-aggregates')._connector
        finally:
            handler.broker_for.cache_clear()
    # The run's META is read (none here), so the caller's run is unknown: refused before GitHub or SSM is reached.
    assert (response['statusCode'], json.loads(response['body'])) == (
        409, {'error': 'The run is not one the broker knows.'})
    assert connected is not None
    assert isinstance(connected.runs, RunRecords)
    assert connected.ledger is connected.runs
    assert (isinstance(connected.bundles, WorkspacePatches), isinstance(connected.dial, WaysOfWorking)) == (True, True)


@pytest.mark.parametrize('call', [lambda: UNCONNECTED.run(RUN), lambda: UNCONNECTED.has_go(RUN, TREE),
                                  lambda: UNCONNECTED.person_go(RUN), lambda: UNCONNECTED.mode('person-sub-1'),
                                  lambda: UNCONNECTED.contents(Submission(RUN, 'committer-1', record(), 'k', BRANCH,
                                                                          TREE, 'Fix'))])
def test_the_unbuilt_collaborators_have_no_connection(call: Callable[[], object]) -> None:
    with pytest.raises(NoConnection):
        call()


class FailingHost(FakeHost):
    def __init__(self, error: Exception) -> None:
        super().__init__()
        self.error = error

    def read(self, connection_id: str, kind: ReadKind, target: str,  # noqa: ARG002 - FakeHost's signature
             cursor: str | None) -> ReadPage:  # noqa: ARG002
        raise self.error


@pytest.mark.parametrize(('error', 'status'), [
    (InvalidTarget('The target is a path inside the repository.'), 400),
    (NotFound('The repository has no such file.'), 404),
    (Conflict('The branch has moved.'), 409),
    (HostError('The repository host answered 500 to the file read.'), 502),
])
def test_a_host_failure_is_answered_with_its_plain_reason(error: HostError | Conflict, status: int) -> None:
    broker = Broker(connector(host=FailingHost(error)))
    assert ask('mapper', 'read', {'kind': 'file', 'target': 'a'}, broker) == (status, {'error': error.reason})


def test_a_rate_limited_host_answers_503_with_retry_after() -> None:
    broker = Broker(connector(host=FailingHost(HostBusy('The repository host is rate limiting.', retry_after=42))))
    response = handler.handle(url_event(role_arn('mapper'), READ_A), PATTERN, ACCOUNT, broker)
    assert response['statusCode'] == 503
    assert response['headers'] == {'Content-Type': 'application/json', 'Retry-After': '42'}
    assert json.loads(response['body']) == {'error': 'The repository host is rate limiting.'}


def test_the_lambda_takes_its_own_account_from_the_function_arn(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(handler.ROLE_NAME_PATTERN_ENV, PATTERN)
    response = handler.lambda_handler(url_event(role_arn('mapper'), READ_A), lambda_context('222222222222'))
    assert response['statusCode'] == 403


def test_the_lambda_refuses_every_caller_without_its_role_pattern(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(handler.ROLE_NAME_PATTERN_ENV, raising=False)
    response = handler.lambda_handler(url_event(role_arn('mapper'), READ_A), lambda_context())
    assert response['statusCode'] == 403
