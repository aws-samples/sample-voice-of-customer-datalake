"""The broker's refusals in its own words (an agent reads them, word for word), and what it hands on to the host and to
the write rules: the run's connection and branch, and code read as code, not prose."""
from __future__ import annotations

import pytest

from engineering.connectors.broker import (
    OPEN_OR_UPDATE_DRAFT_PR,
    POST_COMMENT,
    PUSH_BUNDLE,
    Broker,
    NotNow,
    NotPermitted,
)
from engineering.connectors.hosts import NO_CONNECTION, CommentTarget, NoConnection
from engineering.connectors.test.fakes import (
    BRANCH,
    PERSON,
    REVIEW,
    RUN,
    TREE,
    FakeBundles,
    FakeHost,
    FakeLedger,
    FakeRuns,
    bundle_contents,
    connector,
    record,
)
from engineering.connectors.test.test_broker import OPERATIONS, WRITERS, call, caller, push
from engineering.connectors.write_policy import WriteRefused


@pytest.mark.parametrize('operation', OPERATIONS)
def test_with_no_connection_the_refusal_says_none_is_configured(operation: str) -> None:
    role = next((r for r, op in WRITERS.items() if op == operation), 'mapper')
    with pytest.raises(NoConnection) as caught:
        call(Broker(None), caller(role), operation)
    assert caught.value.args == (NO_CONNECTION,)


@pytest.mark.parametrize(('role', 'operation'), [('committer', PUSH_BUNDLE), ('pr-author', OPEN_OR_UPDATE_DRAFT_PR)])
def test_no_attestation_says_an_administrator_has_not_confirmed_the_ci_settings(role: str, operation: str) -> None:
    host = FakeHost()
    broker = Broker(connector(host=host, runs=FakeRuns({RUN: record(ci_attested=False)})))
    with pytest.raises(NotNow) as caught:
        call(broker, caller(role), operation)
    assert caught.value.reason == ("An administrator has not yet confirmed the repository's CI settings for agent "
                                   'branches.')
    assert host.calls == []


@pytest.mark.parametrize(('on', 'number', 'words'), [('issue', 43, 'issue'), ('pull_request', 8, 'pull request')])
def test_a_comment_elsewhere_says_an_agent_comments_only_on_its_own_runs(on: CommentTarget, number: int,
                                                                         words: str) -> None:
    host = FakeHost()
    with pytest.raises(NotPermitted) as caught:
        Broker(connector(host=host)).post_comment(caller('pr-reviewer'), on, number, 'Looks right.')
    assert caught.value.reason == f"An agent comments only on its own run's {words}."
    assert host.calls == []


def test_a_push_without_a_go_says_the_final_go_passes_on_the_tree_first() -> None:
    host = FakeHost()
    with pytest.raises(NotNow) as caught:
        push(Broker(connector(host=host, ledger=FakeLedger())), caller('committer'))
    assert caught.value.reason == ("The board holds no final-go GO for this tree: the quality gate's final go passes "
                                   'on it first.')
    assert host.calls == []


def test_a_pushed_line_of_code_may_hold_an_address() -> None:
    # Added lines are code, not prose: an address in a test fixture is no personal data refusal.
    host = FakeHost()
    contents = bundle_contents(added_lines=(f'    SENDER = "{PERSON}"', '    PHONE = "+1 555 010 0199"'))
    assert push(Broker(connector(host=host, bundles=FakeBundles(contents))), caller('committer')) == TREE
    assert host.writes() == [PUSH_BUNDLE]


def test_a_review_sentence_split_over_two_pushed_lines_is_refused() -> None:
    # The added lines are read as one text, a line after another: a quote is found across a line break.
    host = FakeHost()
    head, tail = REVIEW.split(' and ')
    contents = bundle_contents(added_lines=(f'    QUOTE = ("{head} and', f'             {tail}")'))
    with pytest.raises(WriteRefused) as caught:
        push(Broker(connector(host=host, bundles=FakeBundles(contents))), caller('committer'))
    assert caught.value.reason == 'The text quotes a customer review; cite its feedback id instead.'
    assert host.writes() == []


def test_a_branch_not_on_the_host_says_push_it_first() -> None:
    host = FakeHost(tree_hash=None)
    with pytest.raises(NotNow) as caught:
        Broker(connector(host=host)).open_or_update_draft_pr(caller('pr-author'), BRANCH, 'Fix', 'Body')
    assert caught.value.reason == 'The branch is not on the host yet; push it first.'
    assert host.calls == [('branch_tree_hash', 'conn-1', BRANCH)]


def test_a_pull_request_asks_the_host_for_the_branchs_tree_on_the_runs_connection_then_opens_it() -> None:
    host = FakeHost()
    broker = Broker(connector(host=host, runs=FakeRuns({RUN: record(connection_id='conn-9')})))
    broker.open_or_update_draft_pr(caller('pr-author'), BRANCH, 'Fix the refund total', 'From fb_0123abcd.')
    assert host.calls == [('branch_tree_hash', 'conn-9', BRANCH),
                          ('open_or_update_draft_pr', 'conn-9', BRANCH, 'main', 'Fix the refund total',
                           'From fb_0123abcd.', TREE)]


@pytest.mark.parametrize(('title', 'body', 'reason'), [
    (f'Ask {PERSON}', 'Body', 'The text holds an email address.'),
    ('Fix', 'Call +1 555 010 0199', 'The text holds a phone number.'),
])
def test_a_pull_requests_title_and_body_are_prose(title: str, body: str, reason: str) -> None:
    host = FakeHost()
    with pytest.raises(WriteRefused) as caught:
        Broker(connector(host=host)).open_or_update_draft_pr(caller('pr-author'), BRANCH, title, body)
    assert caught.value.reason == reason
    assert host.calls == []


def test_a_comment_is_prose() -> None:
    host = FakeHost()
    with pytest.raises(WriteRefused) as caught:
        Broker(connector(host=host)).post_comment(caller('understander'), 'issue', 42, 'Call +1 555 010 0199 for it')
    assert caught.value.reason == 'The text holds a phone number.'
    assert host.calls == []


def test_a_comment_and_a_push_go_to_the_runs_own_connection() -> None:
    host = FakeHost()
    broker = Broker(connector(host=host, runs=FakeRuns({RUN: record(connection_id='conn-9', default_branch='trunk')})))
    broker.post_comment(caller('understander'), 'issue', 42, 'Likely in src/refund.py:42.')
    push(broker, caller('committer'))
    assert [c[:2] for c in host.calls] == [(POST_COMMENT, 'conn-9'), (PUSH_BUNDLE, 'conn-9')]
    assert host.calls[-1][-1] == 'trunk'
