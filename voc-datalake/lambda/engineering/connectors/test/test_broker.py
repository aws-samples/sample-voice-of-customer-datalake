"""The broker's operations per role and the rules every write goes through (docs/autonomous-engineering.md)."""
from __future__ import annotations

from collections.abc import Callable

import pytest

from engineering.connectors.broker import (
    OPEN_OR_UPDATE_DRAFT_PR,
    POST_COMMENT,
    PUSH_BUNDLE,
    READ,
    Broker,
    NotNow,
    NotPermitted,
    permitted,
)
from engineering.connectors.hosts import BundleContents, CommentTarget, NoConnection, PullRequestRef, RunRecord
from engineering.connectors.identity import AGENT_ROLES, Caller
from engineering.connectors.test.fakes import (
    BOT,
    BRANCH,
    OTHER_RUN,
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
from engineering.connectors.write_policy import WriteRefused

WRITERS = {'understander': POST_COMMENT, 'pr-reviewer': POST_COMMENT, 'committer': PUSH_BUNDLE,
           'pr-author': OPEN_OR_UPDATE_DRAFT_PR}
OPERATIONS = (READ, POST_COMMENT, PUSH_BUNDLE, OPEN_OR_UPDATE_DRAFT_PR)
OPEN_PR = PullRequestRef(number=7, url='https://code.example.com/pull/7')


def caller(role: str, run_id: str = RUN) -> Caller:
    return Caller(role=role, run_id=run_id, agent_index=1)


def call(broker: Broker, who: Caller, operation: str) -> object:
    """Make ``operation`` with arguments the write rules allow."""
    calls: dict[str, Callable[[], object]] = {
        READ: lambda: broker.read(who, 'file', 'src/refund.py', None),
        POST_COMMENT: lambda: broker.post_comment(who, 'issue', 42, 'The refund total is rounded too early.'),
        PUSH_BUNDLE: lambda: broker.push_bundle(who, f'voc-agent/{who.run_id}/fix', b'bundle'),
        OPEN_OR_UPDATE_DRAFT_PR: lambda: broker.open_or_update_draft_pr(
            who, f'voc-agent/{who.run_id}/fix', 'Fix the refund total', 'From feedback fb_0123abcd.'),
    }
    return calls[operation]()


def go_broker(host: FakeHost | None = None) -> tuple[Broker, FakeHost]:
    host = host or FakeHost()
    return Broker(connector(host=host, ledger=FakeLedger({(RUN, TREE)}))), host


@pytest.mark.parametrize('role', sorted(AGENT_ROLES))
@pytest.mark.parametrize('operation', OPERATIONS)
def test_each_role_makes_only_its_operations(role: str, operation: str) -> None:
    broker, host = go_broker()
    allowed = operation == READ or WRITERS.get(role) == operation
    assert permitted(role, operation) is allowed
    if allowed:
        assert call(broker, caller(role), operation) is not None
        assert [c[0] for c in host.calls][-1] == operation
    else:
        with pytest.raises(NotPermitted) as caught:
            call(broker, caller(role), operation)
        assert caught.value.reason == f'The {role} role may not {operation.replace("_", " ")}.'
        assert host.calls == []


def test_a_fixer_cannot_push() -> None:
    broker, host = go_broker()
    with pytest.raises(NotPermitted):
        broker.push_bundle(caller('fixer'), BRANCH, b'bundle')
    assert host.writes() == []


def test_an_unknown_role_reads_nothing() -> None:
    assert not permitted('admin', READ)


def test_reads_the_runs_own_connection() -> None:
    broker, host = go_broker()
    page = broker.read(caller('mapper'), 'history', 'src/', 'page-1')
    assert page.content == 'history:src/'
    assert host.calls == [('read', 'conn-1', 'history', 'src/', 'page-1')]


@pytest.mark.parametrize('operation', OPERATIONS)
def test_with_no_connection_every_operation_is_refused(operation: str) -> None:
    role = next(r for r, op in WRITERS.items() if op == operation) if operation != READ else 'mapper'
    with pytest.raises(NoConnection):
        call(Broker(None), caller(role), operation)


@pytest.mark.parametrize(('runs', 'reason'), [
    (FakeRuns({}), 'The run is not one the broker knows.'),
    (FakeRuns({RUN: record(stopped=True)}), 'The run is stopped; the broker refuses its operations.'),
])
def test_refuses_an_unknown_or_stopped_run(runs: FakeRuns, reason: str) -> None:
    host = FakeHost()
    with pytest.raises(NotNow) as caught:
        Broker(connector(host=host, runs=runs)).read(caller('mapper'), 'file', 'README.md', None)
    assert caught.value.reason == reason
    assert host.calls == []


def test_a_comment_quoting_a_review_is_refused() -> None:
    broker, host = go_broker()
    with pytest.raises(WriteRefused) as caught:
        broker.post_comment(caller('pr-reviewer'), 'pull_request', 7, f'A customer wrote: "{REVIEW}"')
    assert 'cite its feedback id' in caught.value.reason
    assert host.writes() == []


def test_a_comment_with_personal_data_is_refused() -> None:
    broker, host = go_broker()
    with pytest.raises(WriteRefused) as caught:
        broker.post_comment(caller('understander'), 'issue', 42, 'Ask casey@mail-host.net for the logs.')
    assert caught.value.reason == 'The text holds an email address.'
    assert host.writes() == []


def test_a_comment_is_posted_on_the_runs_connection() -> None:
    broker, host = go_broker()
    url = broker.post_comment(caller('understander'), 'issue', 42, 'Likely in src/refund.py:42.')
    assert url == 'https://code.example.com/issue/42#comment-1'
    assert host.calls == [('post_comment', 'conn-1', 'issue', 42, 'Likely in src/refund.py:42.')]


@pytest.mark.parametrize(('run', 'on', 'number'), [
    (record(), 'issue', 43),                          # another issue
    (record(), 'issue', 7),                           # the run's pull request's number, as an issue
    (record(), 'pull_request', 42),                   # the run's issue's number, as a pull request
    (record(), 'pull_request', 8),                    # another pull request
    (record(issue_number=None), 'issue', 42),         # a run with no issue
    (record(pull_request_number=None), 'pull_request', 7),
])
def test_an_agent_comments_only_on_its_runs_own_issue_or_pull_request(run: RunRecord, on: CommentTarget,
                                                                       number: int) -> None:
    host = FakeHost()
    broker = Broker(connector(host=host, runs=FakeRuns({RUN: run})))
    with pytest.raises(NotPermitted) as caught:
        broker.post_comment(caller('pr-reviewer'), on, number, 'Looks right.')
    assert caught.value.reason.startswith("An agent comments only on its own run's")
    assert host.writes() == []


def test_the_pr_reviewer_comments_on_the_runs_pull_request() -> None:
    broker, host = go_broker()
    url = broker.post_comment(caller('pr-reviewer'), 'pull_request', 7, 'Looks right.')
    assert url == 'https://code.example.com/pull_request/7#comment-1'
    assert host.writes() == ['post_comment']


def test_the_committer_pushes_to_its_runs_branch() -> None:
    host = FakeHost()
    bundles = FakeBundles()
    broker = Broker(connector(host=host, bundles=bundles, ledger=FakeLedger({(RUN, TREE)})))
    assert broker.push_bundle(caller('committer'), BRANCH, b'bundle') == TREE
    assert bundles.read == [b'bundle']   # the rules ran on the bundle's own contents
    # The host gets the tree the rules checked, and must push only that (with a lease).
    assert host.calls[-1] == ('push_bundle', 'conn-1', BRANCH, b'bundle', TREE)


@pytest.mark.parametrize('heads', [(), (f'refs/heads/{BRANCH}', f'refs/heads/voc-agent/{RUN}/other')])
def test_a_bundle_without_exactly_one_head_is_refused(heads: tuple[str, ...]) -> None:
    host = FakeHost()
    broker = Broker(connector(host=host, bundles=FakeBundles(bundle_contents(heads=heads))))
    with pytest.raises(WriteRefused) as caught:
        broker.push_bundle(caller('committer'), BRANCH, b'bundle')
    assert caught.value.reason == f'A pushed bundle carries exactly one head ref; this one carries {len(heads)}.'
    assert host.writes() == []


@pytest.mark.parametrize('branch', ['main', f'voc-agent/{OTHER_RUN}/fix', 'voc-agent/fix', 'feature/x'])
def test_a_push_to_any_branch_but_the_runs_own_is_refused(branch: str) -> None:
    broker, host = go_broker()
    with pytest.raises(WriteRefused) as caught:
        broker.push_bundle(caller('committer'), branch, b'bundle')
    assert not isinstance(caught.value, NotNow | NotPermitted)
    assert host.writes() == []


def test_a_committer_of_another_run_cannot_push_to_this_runs_branch() -> None:
    runs = FakeRuns({RUN: record(), OTHER_RUN: record()})
    host = FakeHost()
    with pytest.raises(WriteRefused) as caught:
        Broker(connector(host=host, runs=runs)).push_bundle(caller('committer', OTHER_RUN), BRANCH, b'bundle')
    assert OTHER_RUN in caught.value.reason
    assert host.writes() == []


@pytest.mark.parametrize(('contents', 'expected'), [
    (bundle_contents('Fix a', changed_paths=('src/a.py', '.github/workflows/ci.yml')), '.github/workflows/ci.yml'),
    (bundle_contents(f'Fix a\n\n{REVIEW}'), 'cite its feedback id'),
    (bundle_contents('Fix a, asked by casey@mail-host.net'), 'email address'),
    (bundle_contents('Add a test', added_lines=(f'    QUOTE = "{REVIEW}"',)), 'cite its feedback id'),
    # A steered committer that sets a person's address as the author, and signs off with it, is refused both ways.
    (bundle_contents('Fix a', author=PERSON), "author and committer are the connection's bot"),
    (bundle_contents('Fix a', committer=PERSON), "author and committer are the connection's bot"),
    (bundle_contents(f'Fix a\n\nSigned-off-by: Casey <{PERSON}>', author=PERSON), "author and committer"),
    (bundle_contents('Fix a', f'Fix b\n\nSigned-off-by: Casey <{PERSON}>'), "only the connection's bot address"),
])
def test_a_bundle_the_write_rules_refuse_is_not_pushed(contents: BundleContents, expected: str) -> None:
    host = FakeHost()
    broker = Broker(connector(host=host, bundles=FakeBundles(contents)))
    with pytest.raises(WriteRefused) as caught:
        broker.push_bundle(caller('committer'), BRANCH, b'bundle')
    assert expected in caught.value.reason
    assert host.writes() == []


@pytest.mark.parametrize('trailer', [f'Signed-off-by: VoC agents <{BOT}>', f'Co-authored-by: VoC agents <{BOT}>'])
def test_the_bots_own_sign_off_is_pushed(trailer: str) -> None:
    host = FakeHost()
    broker = Broker(connector(host=host, bundles=FakeBundles(bundle_contents(f'Fix the refund total\n\n{trailer}'))))
    assert broker.push_bundle(caller('committer'), BRANCH, b'bundle') == TREE
    assert host.writes() == ['push_bundle']


def test_a_push_to_a_branch_with_an_open_pr_needs_a_go_for_the_new_tree() -> None:
    host = FakeHost(open_pr=OPEN_PR)
    broker = Broker(connector(host=host, ledger=FakeLedger({(RUN, 'another-tree'), (OTHER_RUN, TREE)})))
    with pytest.raises(NotNow) as caught:
        broker.push_bundle(caller('committer'), BRANCH, b'bundle')
    assert 'no GO' in caught.value.reason
    assert host.writes() == []


def test_a_push_to_a_branch_with_an_open_pr_goes_through_with_its_go() -> None:
    host = FakeHost(open_pr=OPEN_PR)
    assert Broker(connector(host=host, ledger=FakeLedger({(RUN, TREE)}))).push_bundle(
        caller('committer'), BRANCH, b'bundle') == TREE
    assert host.writes() == ['push_bundle']


def test_a_push_to_a_branch_with_no_pr_needs_no_go() -> None:
    host = FakeHost()
    assert Broker(connector(host=host)).push_bundle(caller('committer'), BRANCH, b'bundle') == TREE
    assert host.writes() == ['push_bundle']


@pytest.mark.parametrize('operation', [PUSH_BUNDLE, OPEN_OR_UPDATE_DRAFT_PR])
def test_no_push_and_no_pull_request_before_the_ci_attestation(operation: str) -> None:
    host = FakeHost()
    broker = Broker(connector(host=host, runs=FakeRuns({RUN: record(ci_attested=False)}),
                              ledger=FakeLedger({(RUN, TREE)})))
    with pytest.raises(NotNow) as caught:
        call(broker, caller('committer' if operation == PUSH_BUNDLE else 'pr-author'), operation)
    assert 'CI settings' in caught.value.reason
    assert host.writes() == []


def test_the_pr_author_opens_a_draft_against_the_default_branch_with_a_go() -> None:
    broker, host = go_broker()
    ref = broker.open_or_update_draft_pr(caller('pr-author'), BRANCH, 'Fix the refund total', 'fb_0123abcd')
    assert ref == OPEN_PR
    # The host gets the GO'd tree, and must verify the branch's head has it before opening or updating.
    assert host.calls[-1] == ('open_or_update_draft_pr', 'conn-1', BRANCH, 'main', 'Fix the refund total',
                              'fb_0123abcd', TREE)


def test_no_pull_request_without_a_go_for_the_branchs_tree() -> None:
    host = FakeHost(tree_hash='another-tree')
    broker = Broker(connector(host=host, ledger=FakeLedger({(RUN, TREE)})))
    with pytest.raises(NotNow) as caught:
        broker.open_or_update_draft_pr(caller('pr-author'), BRANCH, 'Fix', 'Body')
    assert caught.value.reason == "The board holds no GO for the branch's tree."
    assert host.writes() == []


def test_no_pull_request_from_a_branch_not_on_the_host() -> None:
    host = FakeHost(tree_hash=None)
    with pytest.raises(NotNow):
        Broker(connector(host=host, ledger=FakeLedger({(RUN, TREE)}))).open_or_update_draft_pr(
            caller('pr-author'), BRANCH, 'Fix', 'Body')
    assert host.writes() == []


@pytest.mark.parametrize(('branch', 'title', 'body', 'expected'), [
    (f'voc-agent/{OTHER_RUN}/fix', 'Fix', 'Body', 'own run'),
    ('main', 'Fix', 'Body', 'default branch'),
    (BRANCH, 'Fix', f'Customers say "{REVIEW}"', 'cite its feedback id'),
    (BRANCH, 'Call +1 555 010 0199', 'Body', 'phone number'),
])
def test_a_pull_request_the_write_rules_refuse_is_not_opened(branch: str, title: str, body: str,
                                                             expected: str) -> None:
    broker, host = go_broker()
    with pytest.raises(WriteRefused) as caught:
        broker.open_or_update_draft_pr(caller('pr-author'), branch, title, body)
    assert expected in caught.value.reason
    assert host.writes() == []
