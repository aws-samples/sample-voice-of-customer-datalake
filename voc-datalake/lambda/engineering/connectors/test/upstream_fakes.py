"""In-memory stand-ins for the upstream pull request's collaborators (7.57.00: ``hosts.UpstreamHost``, ``OwnerTokens``,
``UpstreamLedger``), recording what each was asked, and a connector wired with them."""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

from engineering.connectors.hosts import (
    FORK,
    Connector,
    Dial,
    ForkFacts,
    ForkPullRequest,
    OwnerToken,
    OwnerUnauthorized,
    PullRequestRef,
    UpstreamFacts,
    UpstreamRecord,
)
from engineering.connectors.test.fakes import BRANCH, REPOSITORY, RUN, FakeHost, FakeLedger, FakeRuns, connector
from engineering.connectors.upstream import ContributingAsks, RepositoryFacts
from engineering.run_links import PullRequestLink

UPSTREAM = 'upstream-org/refund-service'
#: The connection owner's subject's sha256, and their user token (a fake: never a real token's shape outside tests).
OWNER = 'a' * 64
OWNER_CREDENTIAL = 'ghu_owner0token0for0tests0only00'
LOGIN = 'casey-dev'
FORK_PR = 7


def upstream_facts(**change: Any) -> RepositoryFacts:
    facts = RepositoryFacts(repository=UPSTREAM, description='', stars=1200, licence_spdx='MIT', licence_name='MIT',
                            archived=False, private=False, fork=False, parent='', pushed_at='2026-11-01T00:00:00Z',
                            default_branch='main', html_url=f'https://github.com/{UPSTREAM}')
    return replace(facts, **change)


@dataclass
class FakeUpstream:
    """A connection's kind (``kinds``, else ``kind``) and a fork's upstream; ``opened`` the pull requests it opened, with
    the token each was opened with."""

    kind_: str = FORK
    kinds: dict[str, str] = field(default_factory=dict)
    fork_: ForkFacts = field(default_factory=lambda: ForkFacts(upstream=UPSTREAM, upstream_default_branch='main',
                                                               owner=OWNER, licence='MIT', app_id='4242',
                                                               repository=REPOSITORY))
    facts_: UpstreamFacts = field(default_factory=lambda: UpstreamFacts(
        facts=upstream_facts(), opt_out=None, template='## Description\n\n<!-- what and why -->\n\n## Checklist\n'
        '- [ ] tests', contributing=ContributingAsks(path='CONTRIBUTING.md')))
    existing_: PullRequestRef | None = None
    fork_pr: ForkPullRequest = field(default_factory=lambda: ForkPullRequest(
        title='Fix the refund total', body='Rounds the total to cents.', open=True))
    refuse: Exception | None = None
    opened: list[tuple[str, str, str, str]] = field(default_factory=list)
    asked: list[str] = field(default_factory=list)

    def kind(self, connection_id: str) -> str:
        return self.kinds.get(connection_id, self.kind_)

    def fork(self, connection_id: str) -> ForkFacts | None:
        return self.fork_ if self.kind(connection_id) == FORK else None

    def facts(self, connection_id: str) -> UpstreamFacts:  # noqa: ARG002 - the protocol's signature
        self.asked.append('facts')
        return self.facts_

    def existing(self, connection_id: str, branch: str) -> PullRequestRef | None:  # noqa: ARG002 - the protocol's
        self.asked.append('existing')
        return self.existing_

    def fork_pull_request(self, connection_id: str, number: int) -> ForkPullRequest:  # noqa: ARG002 - the protocol's
        self.asked.append(f'fork_pull_request {number}')
        return self.fork_pr

    def open(self, connection_id: str, owner: OwnerToken, branch: str, title: str,  # noqa: ARG002 - the protocol's
             body: str) -> PullRequestRef:
        if self.refuse is not None:
            raise self.refuse
        self.opened.append((owner.token, branch, title, body))
        return PullRequestRef(number=314, url=f'https://github.com/{UPSTREAM}/pull/314', head=branch, base='main',
                              host='github')


@dataclass
class FakeOwnerTokens:
    """The owners' tokens: ``OWNER``'s of App 4242 unless ``missing``; records each read."""

    missing: bool = False
    read: list[tuple[str, str]] = field(default_factory=list)

    def token(self, app_id: str, owner: str) -> OwnerToken:
        self.read.append((app_id, owner))
        if self.missing or (app_id, owner) != ('4242', OWNER):
            raise OwnerUnauthorized('The connection owner has not authorized the GitHub App.')
        return OwnerToken(token=OWNER_CREDENTIAL, login=LOGIN)


@dataclass
class FakeUpstreamLedger:
    """The run's records and the day's slots (``full``: the cap reached)."""

    records: dict[str, UpstreamRecord] = field(default_factory=dict)
    slots: list[tuple[str, str, str]] = field(default_factory=list)
    closed: list[dict[str, object]] = field(default_factory=list)
    full: str | None = None

    def recorded(self, run_id: str) -> UpstreamRecord | None:
        return self.records.get(run_id)

    def record(self, run_id: str, record: UpstreamRecord) -> None:
        held = self.records.get(run_id)
        if held is None or held.state != 'opened':
            self.records[run_id] = record

    def take_slot(self, day: str, upstream: str, run_id: str, connection_id: str) -> str | None:  # noqa: ARG002
        if self.full is not None:
            return self.full
        self.slots.append((day, upstream, run_id))
        return None

    def close_slot(self, day: str, upstream: str, run_id: str, outcome: dict[str, object]) -> None:  # noqa: ARG002
        self.closed.append(outcome)


def fork_connector(upstream: FakeUpstream | None = None, tokens: FakeOwnerTokens | None = None,
                   ledger: FakeUpstreamLedger | None = None, *, host: FakeHost | None = None,
                   runs: FakeRuns | None = None, gate: FakeLedger | None = None, dial: Dial | None = None) -> Connector:
    """``fakes.connector`` with the fork's collaborators, and the run's fork pull request recorded on ``BRANCH``."""
    base = connector(host=host, runs=runs, ledger=gate, dial=dial)
    writes = base.writes
    writes.record_pull_request(RUN, PullRequestLink(host='github', number=FORK_PR,
                                                    url=f'https://github.com/{REPOSITORY}/pull/{FORK_PR}',
                                                    head=BRANCH, base='main'))
    return replace(base, upstream=upstream or FakeUpstream(), owner_tokens=tokens or FakeOwnerTokens(),
                   upstream_ledger=ledger or FakeUpstreamLedger())

