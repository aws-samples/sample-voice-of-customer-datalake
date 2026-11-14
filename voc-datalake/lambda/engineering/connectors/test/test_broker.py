"""The broker's operations per role and the rules every write goes through (docs/autonomous-engineering.md)."""
from __future__ import annotations

from collections.abc import Callable

import pytest

from engineering.connectors.broker import (
    OPEN_OR_UPDATE_DRAFT_PR,
    OTHER_REPOSITORY,
    POST_COMMENT,
    PUSH_BUNDLE,
    READ,
    Broker,
    NotNow,
    NotPermitted,
    permitted,
)
from engineering.connectors.hosts import (
    STORED_BRANCH_MISSING,
    BundleContents,
    CommentTarget,
    NoConnection,
    PullRequestRef,
    RunRecord,
    StoredBranchMissing,
    Submission,
)
from engineering.connectors.identity import AGENT_ROLES, Caller
from engineering.connectors.test.fakes import (
    BOT,
    BRANCH,
    OTHER_RUN,
    PERSON,
    REVIEW,
    RUN,
    STARTER,
    TREE,
    FakeBundles,
    FakeDial,
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
PATCH = f'ws/default/runs/{RUN}/committer-1/commits/{"a" * 40}/_patches/attempt-1/task-1-0a1b2c3d.diff'
MESSAGE = 'Fix the refund total (fb_0123abcd)'


def caller(role: str, run_id: str = RUN) -> Caller:
    return Caller(role=role, run_id=run_id, agent_index=1)


def push(broker: Broker, who: Caller, branch: str = BRANCH) -> str:
    """The committer's push of ``PATCH`` for ``TREE``."""
    return broker.push_bundle(who, branch, PATCH, TREE, MESSAGE)


def call(broker: Broker, who: Caller, operation: str) -> object:
    """Make ``operation`` with arguments the write rules allow."""
    calls: dict[str, Callable[[], object]] = {
        READ: lambda: broker.read(who, 'file', 'src/refund.py', None),
        POST_COMMENT: lambda: broker.post_comment(who, 'issue', 42, 'The refund total is rounded too early.'),
        PUSH_BUNDLE: lambda: push(broker, who, f'voc-agent/{who.run_id}/fix'),
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
        push(broker, caller('fixer'))
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
    (FakeRuns({RUN: record(status='stopped')}), 'The run is stopped; the broker refuses its operations.'),
    (FakeRuns({RUN: record(status='needs_human')}),
     "The run waits at a person's decision; the broker refuses its operations until it is resumed."),
    (FakeRuns({RUN: record(status='done')}), 'The run has ended; the broker refuses its operations.'),
    (FakeRuns({RUN: record(status='failed')}), 'The run has ended; the broker refuses its operations.'),
])
def test_refuses_an_unknown_or_inactive_run(runs: FakeRuns, reason: str) -> None:
    host = FakeHost()
    with pytest.raises(NotNow) as caught:
        Broker(connector(host=host, runs=runs)).read(caller('mapper'), 'file', 'README.md', None)
    assert caught.value.reason == reason
    assert host.calls == []


@pytest.mark.parametrize('operation', OPERATIONS)
@pytest.mark.parametrize('started_on', ['example-org/other', ''], ids=['another repository', 'none recorded'])
def test_a_run_is_refused_when_its_connection_names_another_repository_than_it_started_on(
        operation: str, started_on: str) -> None:
    role = next(r for r, op in WRITERS.items() if op == operation) if operation != READ else 'mapper'
    host = FakeHost()
    runs = FakeRuns({RUN: record(repository=started_on)})
    with pytest.raises(NotNow) as caught:
        call(Broker(connector(host=host, runs=runs, ledger=FakeLedger({(RUN, TREE)}))), caller(role), operation)
    assert caught.value.reason == OTHER_REPOSITORY
    # (the branch is worked out only after the repository check: a re-pointed credential is never used for it)
    assert (host.calls, host.branch_lookups) == ([], [])


@pytest.mark.parametrize('operation', OPERATIONS)
def test_a_run_is_held_to_its_stored_default_branch_and_refused_while_the_host_lacks_it(operation: str) -> None:
    role = next(r for r, op in WRITERS.items() if op == operation) if operation != READ else 'mapper'
    host = FakeHost(branches=('main',))
    runs = FakeRuns({RUN: record(stored_default_branch='release/gone')})
    with pytest.raises(StoredBranchMissing) as caught:
        call(Broker(connector(host=host, runs=runs, ledger=FakeLedger({(RUN, TREE)}))), caller(role), operation)
    # 409 at the handler, nothing read or written; the words never name the branch.
    assert caught.value.reason == STORED_BRANCH_MISSING
    assert (host.calls, host.branch_lookups) == ([], [('conn-1', 'release/gone')])


def test_a_push_names_the_stored_default_branch_to_the_host() -> None:
    host = FakeHost()
    runs = FakeRuns({RUN: record(stored_default_branch='develop')})
    push(Broker(connector(host=host, runs=runs, ledger=FakeLedger({(RUN, TREE)}))), caller('committer'))
    assert [c[-1] for c in host.calls if c[0] == 'push_bundle'] == ['develop']
    assert host.branch_lookups == [('conn-1', 'develop')]


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
    assert push(broker, caller('committer')) == TREE
    # The rules ran on what the caller's own patch holds: its run, its agent id, its record, the GO'd tree.
    assert bundles.read == [Submission(run_id=RUN, agent_id='committer-1', run=record(), key=PATCH, branch=BRANCH,
                                       tree_hash=TREE, message=MESSAGE)]
    # The host gets the tree the rules checked, and must push only that (with a lease).
    # The run's default branch, from its record: a new branch must start on it.
    assert host.calls[-1] == ('push_bundle', 'conn-1', BRANCH, bundles.contents_, TREE, 'main')


@pytest.mark.parametrize('heads', [(), (f'refs/heads/{BRANCH}', f'refs/heads/voc-agent/{RUN}/other')])
def test_a_bundle_without_exactly_one_head_is_refused(heads: tuple[str, ...]) -> None:
    host = FakeHost()
    broker = Broker(connector(host=host, bundles=FakeBundles(bundle_contents(heads=heads))))
    with pytest.raises(WriteRefused) as caught:
        push(broker, caller('committer'))
    assert caught.value.reason == f'A pushed bundle carries exactly one head ref; this one carries {len(heads)}.'
    assert host.writes() == []


@pytest.mark.parametrize('branch', ['main', f'voc-agent/{OTHER_RUN}/fix', 'voc-agent/fix', 'feature/x'])
def test_a_push_to_any_branch_but_the_runs_own_is_refused(branch: str) -> None:
    broker, host = go_broker()
    with pytest.raises(WriteRefused) as caught:
        push(broker, caller('committer'), branch)
    assert not isinstance(caught.value, NotNow | NotPermitted)
    assert host.writes() == []


def test_a_committer_of_another_run_cannot_push_to_this_runs_branch() -> None:
    runs = FakeRuns({RUN: record(), OTHER_RUN: record()})
    host = FakeHost()
    with pytest.raises(WriteRefused) as caught:
        push(Broker(connector(host=host, runs=runs, ledger=FakeLedger({(OTHER_RUN, TREE)}))),
             caller('committer', OTHER_RUN))
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
        push(broker, caller('committer'))
    assert expected in caught.value.reason
    assert host.writes() == []


@pytest.mark.parametrize('trailer', [f'Signed-off-by: VoC agents <{BOT}>', f'Co-authored-by: VoC agents <{BOT}>'])
def test_the_bots_own_sign_off_is_pushed(trailer: str) -> None:
    host = FakeHost()
    broker = Broker(connector(host=host, bundles=FakeBundles(bundle_contents(f'Fix the refund total\n\n{trailer}'))))
    assert push(broker, caller('committer')) == TREE
    assert host.writes() == ['push_bundle']


def test_every_push_needs_the_final_go_for_exactly_its_tree() -> None:
    host, bundles = FakeHost(), FakeBundles()
    broker = Broker(connector(host=host, bundles=bundles,
                              ledger=FakeLedger({(RUN, 'e' * 40), (OTHER_RUN, TREE)})))
    with pytest.raises(NotNow) as caught:
        push(broker, caller('committer'))
    assert caught.value.reason.startswith('The board holds no final-go GO for this tree')
    # Refused before the patch is read or the host asked anything: no GO, nothing of the workspace is touched.
    assert (host.calls, bundles.read) == ([], [])


def test_a_push_goes_through_with_the_go_for_its_tree() -> None:
    host = FakeHost()
    assert push(Broker(connector(host=host, ledger=FakeLedger({(RUN, TREE)}))), caller('committer')) == TREE
    assert host.writes() == ['push_bundle']


# --- the dial (TENETS.md tenet 3): the way of working of the person who started the run --------------------------

WRITES = [('committer', PUSH_BUNDLE), ('pr-author', OPEN_OR_UPDATE_DRAFT_PR)]


@pytest.mark.parametrize(('role', 'operation'), WRITES)
def test_human_driven_pushes_no_branch_and_opens_no_pull_request(role: str, operation: str) -> None:
    host, bundles, dial = FakeHost(), FakeBundles(), FakeDial({STARTER: 'human_driven'})
    broker = Broker(connector(host=host, bundles=bundles, dial=dial, ledger=FakeLedger({(RUN, TREE)}, {RUN})))
    with pytest.raises(NotNow) as caught:
        call(broker, caller(role), operation)
    assert caught.value.reason.startswith('This run works Human-driven')
    # Even with a person's go and a GO: nothing is read from the host or the workspace, nothing is written.
    assert (host.calls, bundles.read, dial.asked) == ([], [], [STARTER])


@pytest.mark.parametrize(('role', 'operation'), [('mapper', READ), ('understander', POST_COMMENT)])
def test_human_driven_still_reads_and_comments(role: str, operation: str) -> None:
    host, dial = FakeHost(), FakeDial({STARTER: 'human_driven'})
    broker = Broker(connector(host=host, dial=dial))
    assert call(broker, caller(role), operation) is not None
    assert ([c[0] for c in host.calls], dial.asked) == ([operation], [])   # (the dial is read for pushes only)


@pytest.mark.parametrize(('role', 'operation'), WRITES)
def test_ai_assisted_waits_for_a_persons_go_on_the_run(role: str, operation: str) -> None:
    host, dial = FakeHost(), FakeDial({STARTER: 'ai_assisted'})
    waiting = Broker(connector(host=host, dial=dial, ledger=FakeLedger({(RUN, TREE)}, {OTHER_RUN})))
    with pytest.raises(NotNow) as caught:
        call(waiting, caller(role), operation)
    assert caught.value.reason.startswith("This run works AI-assisted: a push or a pull request waits for a person's")
    assert host.writes() == []
    given = Broker(connector(host=host, dial=dial, ledger=FakeLedger({(RUN, TREE)}, {RUN})))
    assert call(given, caller(role), operation) is not None
    assert host.writes() == [operation]


@pytest.mark.parametrize(('role', 'operation'), WRITES)
def test_ai_driven_goes_on_without_a_persons_go(role: str, operation: str) -> None:
    host = FakeHost()
    broker = Broker(connector(host=host, dial=FakeDial({STARTER: 'ai_driven'}), ledger=FakeLedger({(RUN, TREE)})))
    assert call(broker, caller(role), operation) is not None
    assert host.writes() == [operation]


@pytest.mark.parametrize('mode', ['human_driven', 'ai_assisted', 'ai_driven'])
def test_a_pull_request_is_a_draft_in_every_mode_and_nothing_marks_it_ready_or_merges(mode: str) -> None:
    host = FakeHost()
    broker = Broker(connector(host=host, dial=FakeDial({STARTER: mode}), ledger=FakeLedger({(RUN, TREE)}, {RUN})))
    if mode == 'human_driven':
        with pytest.raises(NotNow):
            call(broker, caller('pr-author'), OPEN_OR_UPDATE_DRAFT_PR)
    else:
        call(broker, caller('pr-author'), OPEN_OR_UPDATE_DRAFT_PR)
    # The only pull request write is the host's open-or-update of a draft; no operation of any role marks one
    # ready, merges or approves it.
    assert {c[0] for c in host.calls} <= {'branch_tree_hash', 'open_or_update_draft_pr'}
    assert not [name for name in dir(Broker) if any(word in name for word in ('merge', 'ready', 'approve'))]


@pytest.mark.parametrize('starter', ['', 'agent:fixer-1', 'mcp:tok_1'])
def test_a_run_no_person_started_is_human_driven(starter: str) -> None:
    host = FakeHost()
    broker = Broker(connector(host=host, runs=FakeRuns({RUN: record(started_by=starter)}),
                              dial=FakeDial({starter: 'human_driven'})))
    with pytest.raises(NotNow) as caught:
        push(broker, caller('committer'))
    assert caught.value.reason.startswith('This run works Human-driven')


def test_a_mode_the_broker_does_not_know_is_refused_as_human_driven() -> None:
    broker = Broker(connector(dial=FakeDial({STARTER: 'ai_first'})))
    with pytest.raises(NotNow) as caught:
        push(broker, caller('committer'))
    assert caught.value.reason.startswith('This run works Human-driven')


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


def wrote(caplog: pytest.LogCaptureFixture) -> list[dict[str, object]]:
    """The log line of each write the host accepted."""
    keys = ('operation', 'role', 'run_id', 'agent', 'connection_id', 'on', 'number', 'branch', 'tree_hash', 'commits')
    return [{k: vars(r)[k] for k in keys if k in vars(r)} for r in caplog.records if r.getMessage() == 'broker wrote']


def test_each_write_is_logged_with_what_it_wrote_and_never_its_text(caplog: pytest.LogCaptureFixture) -> None:
    broker, _ = go_broker()
    body = 'The refund total is rounded too early.'
    broker.post_comment(caller('understander'), 'issue', 42, body)
    push(broker, caller('committer'))
    broker.open_or_update_draft_pr(caller('pr-author'), BRANCH, 'Fix the refund total', 'From fb_0123abcd.')
    who = {'run_id': RUN, 'agent': 1, 'connection_id': 'conn-1'}
    assert wrote(caplog) == [
        {'operation': POST_COMMENT, 'role': 'understander', **who, 'on': 'issue', 'number': 42},
        {'operation': PUSH_BUNDLE, 'role': 'committer', **who, 'branch': BRANCH, 'tree_hash': TREE, 'commits': 1},
        {'operation': OPEN_OR_UPDATE_DRAFT_PR, 'role': 'pr-author', **who, 'number': 7, 'branch': BRANCH,
         'tree_hash': TREE},
    ]
    logged = repr([vars(r) for r in caplog.records])
    assert body not in logged
    assert 'Fix the refund total' not in logged
    assert 'fb_0123abcd' not in logged


def test_a_refused_write_is_not_logged_as_written(caplog: pytest.LogCaptureFixture) -> None:
    broker, _ = go_broker()
    with pytest.raises(WriteRefused):
        broker.post_comment(caller('understander'), 'issue', 42, f'They said "{REVIEW}"')
    assert wrote(caplog) == []
