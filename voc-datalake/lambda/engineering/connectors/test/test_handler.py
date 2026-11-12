"""The broker's function URL: status codes, strict bodies, nothing echoed (docs/autonomous-engineering.md)."""
from __future__ import annotations

import base64
import json
from collections.abc import Mapping
from typing import Any
from unittest.mock import MagicMock

import pytest

from engineering.connectors import handler
from engineering.connectors.broker import Broker
from engineering.connectors.hosts import NO_CONNECTION, PullRequestRef
from engineering.connectors.test.fakes import (
    ACCOUNT,
    BRANCH,
    OTHER_RUN,
    PATTERN,
    REVIEW,
    RUN,
    TREE,
    FakeHost,
    FakeLedger,
    FakeRuns,
    connector,
    record,
    role_arn,
    url_event,
)

TOKEN = 'ghs_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
BUNDLE = base64.b64encode(b'git bundle bytes').decode()


def answer(event: dict[str, object], broker: Broker | None = None) -> tuple[int, dict[str, Any]]:
    response = handler.handle(event, PATTERN, ACCOUNT,
                              broker or Broker(connector(ledger=FakeLedger({(RUN, TREE)}))))
    assert response['headers'] == {'Content-Type': 'application/json'}
    return response['statusCode'], json.loads(response['body'])


def ask(role: str, operation: str, args: Mapping[str, object], broker: Broker | None = None) -> tuple[int, dict]:
    return answer(url_event(role_arn(role), {'operation': operation, 'args': args}), broker)


def test_reads_for_any_agent() -> None:
    status, body = ask('mapper', 'read', {'kind': 'file', 'target': 'README.md'})
    assert (status, body) == (200, {'result': {'content': 'file:README.md', 'next_cursor': 'page-2'}})


def test_a_read_takes_a_cursor() -> None:
    status, body = ask('hunter', 'read', {'kind': 'issue', 'target': '42', 'cursor': 'page-2'})
    assert (status, body['result']['next_cursor']) == (200, None)


def test_posts_a_comment() -> None:
    status, body = ask('understander', 'post_comment', {'on': 'issue', 'number': 42, 'body': 'Bug: src/a.py:3.'})
    assert (status, body) == (200, {'result': {'url': 'https://code.example.com/issue/42#comment-1'}})


def test_pushes_a_bundle_decoded_from_base64() -> None:
    host = FakeHost()
    status, body = ask('committer', 'push_bundle', {'branch': BRANCH, 'bundle': BUNDLE}, Broker(connector(host=host)))
    assert (status, body) == (200, {'result': {'branch': BRANCH, 'tree_hash': TREE}})
    assert host.calls[-1] == ('push_bundle', 'conn-1', BRANCH, b'git bundle bytes', TREE)


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
    status, body = ask('fixer', 'push_bundle', {'branch': BRANCH, 'bundle': BUNDLE})
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
    ('committer', 'push_bundle', {'branch': BRANCH, 'bundle': 'not base64!'}),
    ('committer', 'push_bundle', {'branch': BRANCH}),
    ('committer', 'push_bundle', {'branch': BRANCH, 'bundle': BUNDLE, 'run_id': OTHER_RUN}),
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
    broker = Broker(connector(runs=FakeRuns({RUN: record(stopped=True)})))
    status, body = ask('mapper', 'read', {'kind': 'file', 'target': 'a'}, broker)
    assert (status, body) == (409, {'error': 'The run is stopped; the broker refuses its operations.'})


def test_409_for_a_push_to_an_open_pr_without_a_go() -> None:
    broker = Broker(connector(host=FakeHost(open_pr=PullRequestRef(7, 'u'))))
    status, body = ask('committer', 'push_bundle', {'branch': BRANCH, 'bundle': BUNDLE}, broker)
    assert status == 409
    assert 'no GO' in body['error']


def test_422_for_another_runs_branch() -> None:
    status, body = ask('committer', 'push_bundle', {'branch': f'voc-agent/{OTHER_RUN}/x', 'bundle': BUNDLE})
    assert status == 422
    assert "own run's branches" in body['error']


def test_422_for_a_comment_quoting_a_review_and_the_quote_is_not_echoed() -> None:
    status, body = ask('pr-reviewer', 'post_comment', {'on': 'pull_request', 'number': 7, 'body': REVIEW})
    assert status == 422
    assert REVIEW not in json.dumps(body)


def test_503_for_every_operation_with_no_connection() -> None:
    for role, operation, args in [('mapper', 'read', {'kind': 'file', 'target': 'a'}),
                                  ('committer', 'push_bundle', {'branch': BRANCH, 'bundle': BUNDLE})]:
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


def test_the_lambda_takes_its_own_account_from_the_function_arn(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(handler.ROLE_NAME_PATTERN_ENV, PATTERN)
    response = handler.lambda_handler(url_event(role_arn('mapper'), READ_A), lambda_context('222222222222'))
    assert response['statusCode'] == 403


def test_the_lambda_refuses_every_caller_without_its_role_pattern(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(handler.ROLE_NAME_PATTERN_ENV, raising=False)
    response = handler.lambda_handler(url_event(role_arn('mapper'), READ_A), lambda_context())
    assert response['statusCode'] == 403
