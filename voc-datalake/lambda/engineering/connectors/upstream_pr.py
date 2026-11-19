"""The run's upstream pull request (7.57.00; docs/autonomous-engineering.md, "Any public repository": the fork
workflow). The broker's ``open_upstream_pr``, the PR author's alone, and the step its open of the fork's pull request
goes on to. The upstream is the organization's; the fork and the pull request are the person's: the run's outcome is a
pull request ``<fork owner>:voc-agent/<run>/… → <upstream>:<default branch>``, ready for review, which merging stays
the upstream maintainers'.

**Always one click away.** Once the safety checks pass, the run gets the one-click link to GitHub's compare page
(``upstream.compare_link``: title and body prefilled), stored on its record: the person clicks Create on GitHub, so the
pull request is theirs; it needs no token, no App on the upstream and no permission beyond their own, so it works for
anyone. **Opening it automatically is the optional extra**: with the connection owner's GitHub user authorization
("Authorize as me", ``user_auth.OwnerTokens``), the broker opens it as them; when it cannot (no authorization, a way of
working that holds it, the daily cap, GitHub refusing the App, which is not installed on the upstream: 403), the run
keeps the link (``link``, its reason a plain note: never an error).

The safety checks, in this order; a refusal (``NotNow``, 409) offers no link, its reason on the run's record:

1. the connection is a fork (``UpstreamHost.fork``); an upstream pull request already opened for the run is answered
   as it stands;
2. the run's pull request on the fork is recorded, from the asked branch;
3. the board's final-go GO (after the gate runner's GO on the same tree) is for the branch's tree now;
4. the upstream as GitHub answers it now: not archived, not opted out of bot pull requests, public, its licence the one
   the owner acknowledged (``upstream.contribution_refusal``); a CONTRIBUTING file that asks for a DCO sign-off is
   refused (the agents' commits cannot sign off for a person), one that asks for an issue first needs the run's issue;
5. an open upstream pull request from the branch (opened meanwhile by the person's click, or by an earlier attempt) is
   recorded as the run's, without a new write;
6. the fork's pull request is open, and its words pass the write rules again (``write_policy.check_text``); the body is
   built (``upstream.upstream_body``: the template filled, ``Fixes #N``, the CONTRIBUTING file named, the AI-assistance
   disclosure) and the link with it.

Then the automatic open, each of these a ``link`` when it does not hold: the starter's way of working (AI-driven, or
AI-assisted with a person's go and the owner's explicit setting, as the dial reads it, failing closed); the owner's
authorization; the day's caps (``UpstreamLedger.take_slot``, the deployment's and the upstream's: only automatic opens
count); the write, once per run (a claim in the run's writes, ``broker._claimed``): a refusal GitHub answers wrote
nothing and keeps the link, a lost answer is an unknown outcome (never made again; the next attempt's lookup, step 5,
finds it), the link kept. Its outcome closes the day's slots (their audit: the login, the upstream, the number).
"""
from __future__ import annotations

import hashlib
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Final

from engineering.connectors.hosts import (
    NO_CONNECTION,
    UPSTREAM_LINK,
    UPSTREAM_OPENED,
    UPSTREAM_REFUSED,
    UPSTREAM_UNKNOWN,
    Connector,
    ForkFacts,
    HostBusy,
    HostError,
    NoConnection,
    NotNow,
    OutcomeUnknown,
    OwnerToken,
    OwnerTokens,
    OwnerUnauthorized,
    PullRequestRef,
    RunRecord,
    UpstreamFacts,
    UpstreamHost,
    UpstreamLedger,
    UpstreamRecord,
)
from engineering.connectors.identity import OPEN_UPSTREAM_PR
from engineering.connectors.upstream import (
    UpstreamRefused,
    compare_link,
    contribution_refusal,
    upstream_body,
    upstream_title,
    without_broker_line,
)
from engineering.connectors.write_policy import WriteRefused, check_text
from shared.ai_mode import MODE_AI_ASSISTED, MODE_AI_DRIVEN
from shared.logging import logger

#: The broker's operation (identity.py names it for the harness's client).
OPERATION: Final = OPEN_UPSTREAM_PR
NOT_A_FORK: Final = 'The run\'s connection is not a fork: its pull request goes to its own repository.'
NO_FORK_PR: Final = ('The run has no open pull request on the fork from this branch yet: the fork\'s pull request '
                     'comes first.')
NO_GO: Final = "The board holds no final-go GO for the branch's tree: the upstream pull request waits for it."
DCO: Final = ('{upstream} asks for a DCO sign-off on every commit, which the agents\' commits cannot give for a '
              'person: the run ends with the fork\'s pull request; sign off and open it yourself.')
ISSUE_FIRST: Final = ('{upstream} asks for an issue before a pull request, and the run started from none: start it '
                      'from the upstream\'s issue.')
CLOSED: Final = 'The fork\'s pull request is closed: no upstream pull request is opened from it.'
#: Why the app did not open it itself (the run keeps the one-click link: none is an error).
ONE_CLICK: Final = 'Open it with one click: you create it on GitHub, from your fork.'
ASSISTED: Final = ("This run works AI-assisted, and the connection's owner has not allowed the app to open upstream "
                   f'pull requests for AI-assisted runs. {ONE_CLICK}')
ASSISTED_NO_GO: Final = f"This run works AI-assisted and has no person's go, so the app did not open it. {ONE_CLICK}"
HUMAN: Final = f"The run's way of working lets the app open no upstream pull request. {ONE_CLICK}"
NOT_AUTHORIZED: Final = f'The app opens it for you once you authorize it (Authorize as me). {ONE_CLICK}'
GITHUB_REFUSED: Final = "GitHub didn't let the app open it for you: open it with one click."
GITHUB_BUSY: Final = f'GitHub was busy, so the app did not open it. {ONE_CLICK}'


def _day(now: float) -> str:
    return datetime.fromtimestamp(now, UTC).date().isoformat()


def write_key(run_id: str, branch: str) -> str:
    """The upstream pull request's claim key in the run's writes: once per run and branch, whoever asks."""
    return f'upstream#1#{OPERATION}#{hashlib.sha256(f"{run_id}:{branch}".encode()).hexdigest()[:32]}'


class UpstreamNotNow(NotNow):
    """A refusal for the run's or the upstream's state (the broker's ``NotNow``, 409): nothing written, no link."""


def _dial_note(connector: Connector, run: RunRecord, run_id: str, fork: ForkFacts) -> str | None:
    """Why the starter's way of working keeps the app from opening it (None: it may), as the dial reads it, failing
    closed: AI-driven; or AI-assisted with a person's go and the owner's explicit setting."""
    mode = connector.dial.mode(run.started_by)
    if mode == MODE_AI_DRIVEN:
        return None
    if mode != MODE_AI_ASSISTED:
        return HUMAN
    if not fork.assisted:
        return ASSISTED
    return None if connector.ledger.person_go(run_id) else ASSISTED_NO_GO


def _upstream_refusal(found: UpstreamFacts, fork: ForkFacts, run: RunRecord) -> str | None:
    """Why the upstream takes no pull request from this run now (None: it does), one sentence."""
    refusal = contribution_refusal(found.facts, found.opt_out, fork.licence)
    if refusal is not None:
        return f'{refusal}.'
    if found.contributing.dco:
        return DCO.format(upstream=fork.upstream)
    if found.contributing.issue_first and run.issue_number is None:
        return ISSUE_FIRST.format(upstream=fork.upstream)
    return None


def _record(connector: Connector, run_id: str, record: UpstreamRecord) -> None:
    ledger = connector.upstream_ledger
    if ledger is None:
        return
    try:
        ledger.record(run_id, record)
    except HostError:
        logger.warning('broker upstream pull request not recorded', extra={'run_id': run_id, 'state': record.state})


def _close_slot(ledger: UpstreamLedger, day: str, upstream: str, run_id: str, outcome: dict[str, object]) -> None:
    """The day's slots closed with ``outcome`` (best effort: the write's outcome stands whatever becomes of its
    audit, which is logged when it cannot be written)."""
    try:
        ledger.close_slot(day, upstream, run_id, outcome)
    except HostError:
        logger.warning('broker upstream pull request audit not recorded', extra={'run_id': run_id,
                                                                                 'state': outcome.get('state')})


@dataclass(frozen=True)
class Prepared:
    """What the checks leave for the open: the fork, its branch, the title and body, and the record of the one-click
    link (state ``link``), which every outcome but an open keeps."""

    fork: ForkFacts
    branch: str
    title: str
    body: str
    link: UpstreamRecord


class UpstreamPullRequests:
    """The step over a configured ``Connector`` (its ``upstream``, ``owner_tokens`` and ``upstream_ledger``), the
    broker's claims (``claimed``: ``broker._claimed``) and ``clock``."""

    def __init__(self, connector: Connector, claimed: Callable[..., dict[str, object]],
                 clock: Callable[[], float] = time.time) -> None:
        self._connector = connector
        self._claimed = claimed
        self._clock = clock

    def open(self, run_id: str, run: RunRecord, branch: str) -> dict[str, object]:
        """The run's upstream pull request (``UpstreamRecord.view``): opened, or its one-click link (``link``); a
        safety check's refusal is recorded on the run and raised (``WriteRefused``), an unknown outcome recorded, with
        the link, and raised (``OutcomeUnknown``)."""
        try:
            return self._open(run_id, run, branch)
        except (WriteRefused, NoConnection) as refused:
            fork = self._fork(run) if not isinstance(refused, NoConnection) else None
            reason = getattr(refused, 'reason', NO_CONNECTION)
            _record(self._connector, run_id, UpstreamRecord(UPSTREAM_REFUSED, fork.upstream if fork else '',
                                                            reason=reason))
            raise

    def _fork(self, run: RunRecord) -> ForkFacts | None:
        upstream = self._connector.upstream
        try:
            return None if upstream is None else upstream.fork(run.connection_id)
        except (NoConnection, HostError):
            return None

    def _ports(self) -> tuple[UpstreamHost, OwnerTokens, UpstreamLedger]:
        connector = self._connector
        upstream, tokens, ledger = connector.upstream, connector.owner_tokens, connector.upstream_ledger
        if upstream is None or tokens is None or ledger is None:
            raise NoConnection(NO_CONNECTION)
        return upstream, tokens, ledger

    def _checked(self, run_id: str, run: RunRecord, branch: str) -> tuple[ForkFacts, UpstreamFacts, int] | \
            dict[str, object]:
        """Steps 1 to 4: the fork, the upstream's facts and the fork's pull request's number; or the run's upstream
        pull request already opened."""
        connector = self._connector
        upstream, _, ledger = self._ports()
        fork = upstream.fork(run.connection_id)
        if fork is None:
            raise UpstreamNotNow(NOT_A_FORK)
        earlier = ledger.recorded(run_id)
        if earlier is not None and earlier.state == UPSTREAM_OPENED:
            return {**earlier.view(), 'repeated': True}
        link = connector.writes.pull_request(run_id, run.repository)
        if link is None or link.head != branch:
            raise UpstreamNotNow(NO_FORK_PR)
        tree = connector.host.branch_tree_hash(run.connection_id, branch)
        if tree is None or not connector.ledger.has_go(run_id, tree):
            raise UpstreamNotNow(NO_GO)
        found = upstream.facts(run.connection_id)
        refusal = _upstream_refusal(found, fork, run)
        if refusal is not None:
            raise UpstreamNotNow(refusal)
        return fork, found, link.number

    def _prepared(self, run: RunRecord, branch: str, fork: ForkFacts, found: UpstreamFacts,
                  number: int) -> Prepared:
        """Step 6: the fork's pull request open and its words checked, the body built, and its one-click link."""
        upstream, _, _ = self._ports()
        fork_pr = upstream.fork_pull_request(run.connection_id, number)
        if not fork_pr.open:
            raise UpstreamNotNow(CLOSED)
        from engineering.connectors.broker import MERGE_IS_HUMAN  # (broker.py imports this module)

        description, title = without_broker_line(fork_pr.body, MERGE_IS_HUMAN), upstream_title(fork_pr.title)
        # (the agents' words are held to the write rules again; the upstream's template is its own text)
        check_text(f'{title}\n\n{description}', run.cited_reviews, prose=True)
        login = fork.repository.split('/', 1)[0]
        try:
            body = upstream_body(template=found.template, description=description, issue=run.issue_number,
                                 contributing=found.contributing.path, login=login)
            link = compare_link(upstream=fork.upstream, base=fork.upstream_default_branch, fork=fork.repository,
                                branch=branch, title=title, body=body, issue=run.issue_number, login=login)
        except UpstreamRefused as refused:
            raise UpstreamNotNow(str(refused)) from None
        record = UpstreamRecord(UPSTREAM_LINK, fork.upstream, compare_url=link.url, title=title,
                                description=body if link.shortened else None)
        return Prepared(fork=fork, branch=branch, title=title, body=body, link=record)

    def _open(self, run_id: str, run: RunRecord, branch: str) -> dict[str, object]:
        checked = self._checked(run_id, run, branch)
        if isinstance(checked, dict):
            return checked
        fork, found, number = checked
        upstream, tokens, ledger = self._ports()
        existing = upstream.existing(run.connection_id, branch)
        if existing is not None:
            return self._opened(run_id, fork, existing, '', repeated=True)
        prepared = self._prepared(run, branch, fork, found, number)
        note = _dial_note(self._connector, run, run_id, fork)
        if note is not None:
            return self._linked(run_id, prepared, note)
        try:
            owner = tokens.token(fork.app_id, fork.owner)
        except OwnerUnauthorized:
            return self._linked(run_id, prepared, NOT_AUTHORIZED)
        day = _day(self._clock())
        full = ledger.take_slot(day, fork.upstream, run_id, run.connection_id)
        if full is not None:
            return self._linked(run_id, prepared, f'{full} {ONE_CLICK}')
        return self._write(run_id, run, prepared, owner, day)

    def _linked(self, run_id: str, prepared: Prepared, reason: str) -> dict[str, object]:
        """The run keeps the one-click link, with why the app did not open it (a plain note, never an error)."""
        record = replace(prepared.link, reason=reason)
        _record(self._connector, run_id, record)
        logger.info('broker upstream pull request left to one click', extra={'run_id': run_id,
                                                                             'upstream': record.upstream})
        return {**record.view(), 'repeated': False}

    def _write(self, run_id: str, run: RunRecord, prepared: Prepared, owner: OwnerToken,
               day: str) -> dict[str, object]:
        """The automatic open, once per run and branch, its outcome on the day's slots; a refusal GitHub answers keeps
        the link, a lost answer records an unknown outcome with the link, and raises."""
        upstream, _, ledger = self._ports()
        fork, branch = prepared.fork, prepared.branch

        def write() -> dict[str, object]:
            ref = upstream.open(run.connection_id, owner, branch, prepared.title, prepared.body)
            return {'number': ref.number, 'url': ref.url, 'head': ref.head, 'base': ref.base}

        try:
            done = self._claimed(self._connector.writes, run_id, write_key(run_id, branch), OPERATION, write,
                                 lambda: logger.info('broker upstream pull request repeated', extra={'run_id': run_id}))
        except (WriteRefused, HostBusy) as refused:
            _close_slot(ledger, day, fork.upstream, run_id, {'state': 'refused', 'as': owner.login})
            note = GITHUB_BUSY if isinstance(refused, HostBusy) else f'{GITHUB_REFUSED} ({refused.reason})'
            return self._linked(run_id, prepared, note)
        except OutcomeUnknown as unknown:
            _close_slot(ledger, day, fork.upstream, run_id, {'state': 'unknown', 'as': owner.login})
            _record(self._connector, run_id, replace(prepared.link, state=UPSTREAM_UNKNOWN, reason=unknown.reason))
            raise
        number = done.get('number')
        ref = PullRequestRef(number=number if isinstance(number, int) else 0, url=str(done.get('url') or ''))
        _close_slot(ledger, day, fork.upstream, run_id, {'state': 'done', 'number': ref.number, 'url': ref.url,
                                                         'as': owner.login})
        return self._opened(run_id, fork, ref, owner.login)

    def _opened(self, run_id: str, fork: ForkFacts, ref: PullRequestRef, login: str, *,
                repeated: bool = False) -> dict[str, object]:
        record = UpstreamRecord(UPSTREAM_OPENED, fork.upstream, number=ref.number, url=ref.url, login=login or None)
        _record(self._connector, run_id, record)
        logger.info('broker wrote', extra={'operation': OPERATION, 'run_id': run_id, 'upstream': fork.upstream,
                                           'number': ref.number, 'repeated': repeated})
        return {**record.view(), 'repeated': repeated}
