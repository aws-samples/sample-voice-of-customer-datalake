"""In-memory stand-ins for the broker's collaborators, recording every host call."""
from __future__ import annotations

import json
from dataclasses import dataclass, field, replace

from engineering.connectors.hosts import (
    BundleContents,
    CommentTarget,
    Commit,
    Connector,
    PullRequestRef,
    ReadKind,
    ReadPage,
    RunRecord,
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


def record(**overrides: object) -> RunRecord:
    """A live, attested run on connection ``conn-1`` for issue 42 and pull request 7 that cited ``REVIEW``, with
    ``overrides``."""
    base = RunRecord(connection_id='conn-1', default_branch='main', stopped=False, ci_attested=True,
                     cited_reviews=(REVIEW,), issue_number=42, pull_request_number=7, bot_addresses=(BOT,))
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
    open_pr: PullRequestRef | None = None
    tree_hash: str | None = TREE
    calls: list[tuple[object, ...]] = field(default_factory=list)

    def read(self, connection_id: str, kind: ReadKind, target: str, cursor: str | None) -> ReadPage:
        self.calls.append(('read', connection_id, kind, target, cursor))
        return ReadPage(content=f'{kind}:{target}', next_cursor=None if cursor else 'page-2')

    def post_comment(self, connection_id: str, on: CommentTarget, number: int, body: str) -> str:
        self.calls.append(('post_comment', connection_id, on, number, body))
        return f'https://code.example.com/{on}/{number}#comment-1'

    def open_pull_request(self, connection_id: str, branch: str) -> PullRequestRef | None:
        self.calls.append(('open_pull_request', connection_id, branch))
        return self.open_pr

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
    read: list[bytes] = field(default_factory=list)

    def contents(self, bundle: bytes) -> BundleContents:
        self.read.append(bundle)
        return self.contents_


@dataclass
class FakeRuns:
    runs: dict[str, RunRecord] = field(default_factory=lambda: {RUN: record()})

    def run(self, run_id: str) -> RunRecord | None:
        return self.runs.get(run_id)


@dataclass
class FakeLedger:
    goes: set[tuple[str, str]] = field(default_factory=set)

    def has_go(self, run_id: str, tree_hash: str) -> bool:
        return (run_id, tree_hash) in self.goes


def connector(host: FakeHost | None = None, bundles: FakeBundles | None = None, runs: FakeRuns | None = None,
              ledger: FakeLedger | None = None) -> Connector:
    return Connector(host=host or FakeHost(), bundles=bundles or FakeBundles(), runs=runs or FakeRuns(),
                     ledger=ledger or FakeLedger())
