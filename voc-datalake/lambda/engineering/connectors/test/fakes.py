"""In-memory stand-ins for the broker's collaborators, recording every host call."""
from __future__ import annotations

import json
from dataclasses import dataclass, field, replace

from engineering.connectors.hosts import (
    STORED_BRANCH_MISSING,
    WRITE_CLAIMED,
    WRITE_REFUSED,
    BundleContents,
    CiProtection,
    CommentTarget,
    Commit,
    Connector,
    Dial,
    PullRequestRef,
    ReadKind,
    ReadPage,
    RepositoryHost,
    RunRecord,
    StoredBranchMissing,
    Submission,
    WriteClaim,
    WriteLedger,
)

RUN = '01JC8Z3K4M5N6P7Q8R9S0T1V2W'
OTHER_RUN = '01JC8Z3K4M5N6P7Q8R9S0T1V2X'
ACCOUNT = '111111111111'
PATTERN = f'voc-eng-{{role}}-{ACCOUNT}-us-east-1'
REVIEW = 'The refund took three weeks and nobody answered my emails about it.'
TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
#: The commit a bundle builds on (``BundleContents.base``).
BASE = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'
BRANCH = f'voc-agent/{RUN}/fix-refund-total'
#: A person's address, which no pushed commit may carry.
PERSON = 'casey@mail-host.net'
#: The connection's bot address (``record().bot_addresses``).
BOT = 'voc-agents[bot]@users.noreply.code-host.net'
#: The repository the run started on, and the one ``FakeHost``'s credential is for.
REPOSITORY = 'example-org/refund-service'


def role_arn(role: str, session: str = f'{RUN}.3', account: str = ACCOUNT) -> str:
    return f'arn:aws:sts::{account}:assumed-role/voc-eng-{role}-{ACCOUNT}-us-east-1/{session}'


def url_event(user_arn: str | None, body: object = None) -> dict[str, object]:
    """A function-URL event as Lambda sends it with IAM auth; a non-string ``body`` is sent as JSON."""
    iam = {} if user_arn is None else {'userArn': user_arn}
    text = body if isinstance(body, str) or body is None else json.dumps(body)
    event: dict[str, object] = {'requestContext': {'authorizer': {'iam': iam}, 'http': {'method': 'POST'}},
                                'isBase64Encoded': False}
    if text is not None:
        event['body'] = text
    return event


#: The person who started the run (``record().started_by``), whose way of working the dial reads.
STARTER = 'person-sub-1'


def record(**overrides: object) -> RunRecord:
    """A live, attested run on connection ``conn-1`` for issue 42 and pull request 7 that cited ``REVIEW``, started by
    ``STARTER`` on ``BASE``, with ``overrides``."""
    base = RunRecord(connection_id='conn-1', default_branch='main', status='active', ci_attested=True,
                     cited_reviews=(REVIEW,), issue_number=42, pull_request_number=7, bot_addresses=(BOT,),
                     commit=BASE, started_by=STARTER, repository=REPOSITORY)
    return replace(base, **overrides)


def bundle_contents(*messages: str, heads: tuple[str, ...] = (f'refs/heads/{BRANCH}',),
                    changed_paths: tuple[str, ...] = ('src/refund.py',),
                    added_lines: tuple[str, ...] = ('    return round(total, 2)',),
                    author: str = BOT, committer: str = BOT) -> BundleContents:
    """A one-head bundle of commits with ``messages``, each by ``author`` and ``committer`` (the bot by default)."""
    commits = tuple(Commit(message=m, author=author, committer=committer)
                    for m in messages or ('Fix the refund total (fb_0123abcd)',))
    return BundleContents(heads=heads, tree_hash=TREE, changed_paths=changed_paths, commits=commits,
                          added_lines=added_lines, base=BASE)


@dataclass
class FakeHost:
    tree_hash: str | None = TREE
    calls: list[tuple[object, ...]] = field(default_factory=list)

    files: dict[str, bytes] = field(default_factory=dict)
    #: The repository the connection's credential is for (not recorded in ``calls``: it asks the host nothing).
    credential_repository: str = REPOSITORY

    def repository(self, connection_id: str) -> str:  # noqa: ARG002 - the protocol's signature
        return self.credential_repository

    #: The branch each read was made on (apart from ``calls``).
    read_branches: list[str] = field(default_factory=list)
    #: The branch rules the host answers (by default the guide's: protected, one required check, agents' unprotected).
    protection: CiProtection = field(default_factory=lambda: CiProtection(
        default_branch_protected=True, required_checks=('ci / test',), agent_branch_protected=False,
        checked_at=1_700_000_000.0))
    #: Every branch rules check (connection, default branch, agent's branch), apart from ``calls``.
    ci_checks: list[tuple[str, str, str]] = field(default_factory=list)

    def read(self, connection_id: str, kind: ReadKind, target: str, cursor: str | None, branch: str = '') -> ReadPage:
        self.calls.append(('read', connection_id, kind, target, cursor))
        self.read_branches.append(branch)
        return ReadPage(content=f'{kind}:{target}', next_cursor=None if cursor else 'page-2')

    def ci_protection(self, connection_id: str, default_branch: str, branch: str) -> CiProtection:
        self.ci_checks.append((connection_id, default_branch, branch))
        return self.protection

    def file_at(self, connection_id: str, commit: str, path: str) -> bytes | None:
        self.calls.append(('file_at', connection_id, commit, path))
        return self.files.get(path)

    #: The branches the repository has (a stored default branch is served only when it is one of them).
    branches: tuple[str, ...] = ('main', 'develop')
    #: Every default-branch lookup (connection, stored branch), apart from ``calls``.
    branch_lookups: list[tuple[str, str]] = field(default_factory=list)

    def default_branch(self, connection_id: str, stored: str = '') -> str:
        self.branch_lookups.append((connection_id, stored))
        if stored and stored not in self.branches:
            raise StoredBranchMissing(STORED_BRANCH_MISSING)
        return stored or 'main'

    def post_comment(self, connection_id: str, on: CommentTarget, number: int, body: str) -> str:
        self.calls.append(('post_comment', connection_id, on, number, body))
        return f'https://code.example.com/{on}/{number}#comment-1'

    def branch_tree_hash(self, connection_id: str, branch: str) -> str | None:
        self.calls.append(('branch_tree_hash', connection_id, branch))
        return self.tree_hash

    def push_bundle(self, connection_id: str, branch: str, contents: BundleContents, tree_hash: str,
                    default_branch: str) -> None:
        self.calls.append(('push_bundle', connection_id, branch, contents, tree_hash, default_branch))

    def open_or_update_draft_pr(self, connection_id: str, branch: str, base: str, title: str, body: str,
                                tree_hash: str) -> PullRequestRef:
        self.calls.append(('open_or_update_draft_pr', connection_id, branch, base, title, body, tree_hash))
        return PullRequestRef(number=7, url='https://code.example.com/pull/7')

    def writes(self) -> list[str]:
        """The names of the write calls the host saw."""
        return [str(c[0]) for c in self.calls if c[0] in {'post_comment', 'push_bundle', 'open_or_update_draft_pr'}]


@dataclass
class FakeBundles:
    contents_: BundleContents = field(default_factory=bundle_contents)
    read: list[Submission] = field(default_factory=list)

    def contents(self, submission: Submission) -> BundleContents:
        self.read.append(submission)
        return self.contents_


@dataclass
class FakeRuns:
    runs: dict[str, RunRecord] = field(default_factory=lambda: {RUN: record()})

    def run(self, run_id: str) -> RunRecord | None:
        return self.runs.get(run_id)

    def attested(self, run: RunRecord) -> RunRecord:
        """The record as given: its ``ci_attested`` stands for the attestation (version 1 when attested)."""
        return replace(run, ci_attestation=1 if run.ci_attested else 0)


@dataclass
class FakeLedger:
    goes: set[tuple[str, str]] = field(default_factory=set)
    #: The runs a person gave their go.
    people: set[str] = field(default_factory=set)

    def has_go(self, run_id: str, tree_hash: str) -> bool:
        return (run_id, tree_hash) in self.goes

    def person_go(self, run_id: str) -> bool:
        return run_id in self.people


@dataclass
class FakeDial:
    """Every person's way of working (AI-driven unless ``modes`` says otherwise); records whom it was asked about."""

    modes: dict[str, str] = field(default_factory=dict)
    asked: list[str] = field(default_factory=list)

    def mode(self, person: str) -> str:
        self.asked.append(person)
        return self.modes.get(person, 'ai_driven')


@dataclass
class FakeWrites:
    """The writes' claims in memory, by the rule ``records.WriteClaims`` keeps (create-only, again only after a
    refusal)."""

    claims: dict[tuple[str, str], WriteClaim] = field(default_factory=dict)

    def claim(self, run_id: str, key: str, operation: str) -> WriteClaim | None:
        if f'#{operation}#' not in key:
            raise ValueError(f'{key} is not a key of {operation}')
        earlier = self.claims.get((run_id, key))
        if earlier is not None and earlier.state != WRITE_REFUSED:
            return earlier
        self.claims[(run_id, key)] = WriteClaim(WRITE_CLAIMED)
        return None

    def earlier(self, run_id: str, key: str) -> WriteClaim | None:
        return self.claims.get((run_id, key))

    def close(self, run_id: str, key: str, state: str, result: dict[str, object] | None = None) -> None:
        if self.claims[(run_id, key)].state != WRITE_CLAIMED:
            raise ValueError(f'{key} is closed already')
        self.claims[(run_id, key)] = WriteClaim(state, result)


def connector(host: RepositoryHost | None = None, bundles: FakeBundles | None = None, runs: FakeRuns | None = None,
              ledger: FakeLedger | None = None, dial: Dial | None = None,
              writes: WriteLedger | None = None) -> Connector:
    """The collaborators, each a fake: by default the run's final go answered GO for ``TREE``, and its starter works
    AI-driven."""
    return Connector(host=host or FakeHost(), bundles=bundles or FakeBundles(), runs=runs or FakeRuns(),
                     ledger=ledger if ledger is not None else FakeLedger({(RUN, TREE)}), dial=dial or FakeDial(),
                     writes=writes if writes is not None else FakeWrites())
