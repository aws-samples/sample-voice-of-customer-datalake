"""The run's upstream pull request (7.57.00; docs/autonomous-engineering.md, "Any public repository": the fork
workflow). The broker's ``open_upstream_pr``, the PR author's alone, and the step its open of the fork's pull request
goes on to. The upstream is the organization's; the fork and the pull request are the person's: the run's outcome is a
pull request ``<fork owner>:voc-agent/<run>/… → <upstream>:<default branch>``, which the person opens and merging stays
the upstream maintainers'.

**One click away.** Once the safety checks pass, the run gets the one-click link to GitHub's compare page
(``upstream.compare_link``: title and body prefilled), stored on its record (``link``): the person clicks Create on
GitHub, so the pull request is theirs; it needs no token, no App on the upstream and no permission beyond their own.
The app never opens it itself (7.58.00): a GitHub App's user token cannot open a pull request on a repository the App
is not installed on (GitHub answers 403 "Resource not accessible by integration", tested live), so 7.57.00's open as
the connection's owner is gone with its user authorization and its daily caps.

The safety checks, in this order; a refusal (``NotNow``, 409) offers no link, its reason on the run's record:

1. the connection is a fork (``UpstreamHost.fork``); an upstream pull request already recorded open for the run is
   answered as it stands;
2. the run's pull request on the fork is recorded, from the asked branch;
3. the board's final-go GO (after the gate runner's GO on the same tree) is for the branch's tree now;
4. the upstream as GitHub answers it now: not archived, not opted out of bot pull requests, public, its licence the one
   the owner acknowledged (``upstream.contribution_refusal``); a CONTRIBUTING file that asks for a DCO sign-off is
   refused (the agents' commits cannot sign off for a person), one that asks for an issue first needs the run's issue;
5. an open upstream pull request from the branch (opened meanwhile by the person's click) is recorded as the run's;
6. the fork's pull request is open, and its words pass the write rules again (``write_policy.check_text``); the body is
   built (``upstream.upstream_body``: the template filled, ``Fixes #N``, the CONTRIBUTING file named, the AI-assistance
   disclosure) and the link with it.

The link's base is the upstream's default branch as GitHub answers it now (step 4's facts; 7.58.00), not the one
stored when the fork was connected, which the owner's next licence acknowledgement refreshes.
"""
from __future__ import annotations

from typing import Final

from engineering.connectors.hosts import (
    NO_CONNECTION,
    UPSTREAM_LINK,
    UPSTREAM_OPENED,
    UPSTREAM_REFUSED,
    Connector,
    ForkFacts,
    HostError,
    NoConnection,
    NotNow,
    PullRequestRef,
    RunRecord,
    UpstreamFacts,
    UpstreamHost,
    UpstreamLedger,
    UpstreamRecord,
)
from engineering.connectors.upstream import (
    UpstreamRefused,
    compare_link,
    contribution_refusal,
    upstream_body,
    upstream_title,
    without_broker_line,
)
from engineering.connectors.write_policy import WriteRefused, check_text
from shared.logging import logger

NOT_A_FORK: Final = 'The run\'s connection is not a fork: its pull request goes to its own repository.'
NO_FORK_PR: Final = ('The run has no open pull request on the fork from this branch yet: the fork\'s pull request '
                     'comes first.')
NO_GO: Final = "The board holds no final-go GO for the branch's tree: the upstream pull request waits for it."
DCO: Final = ('{upstream} asks for a DCO sign-off on every commit, which the agents\' commits cannot give for a '
              'person: the run ends with the fork\'s pull request; sign off and open it yourself.')
ISSUE_FIRST: Final = ('{upstream} asks for an issue before a pull request, and the run started from none: start it '
                      'from the upstream\'s issue.')
CLOSED: Final = 'The fork\'s pull request is closed: no upstream pull request is opened from it.'


class UpstreamNotNow(NotNow):
    """A refusal for the run's or the upstream's state (the broker's ``NotNow``, 409): nothing written, no link."""


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


class UpstreamPullRequests:
    """The step over a configured ``Connector`` (its ``upstream`` and ``upstream_ledger``)."""

    def __init__(self, connector: Connector) -> None:
        self._connector = connector

    def open(self, run_id: str, run: RunRecord, branch: str) -> dict[str, object]:
        """The run's upstream pull request (``UpstreamRecord.view``): its one-click link (``link``), or one already
        open from the branch (``opened``); a safety check's refusal is recorded on the run and raised
        (``WriteRefused``)."""
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

    def _ports(self) -> tuple[UpstreamHost, UpstreamLedger]:
        upstream, ledger = self._connector.upstream, self._connector.upstream_ledger
        if upstream is None or ledger is None:
            raise NoConnection(NO_CONNECTION)
        return upstream, ledger

    def _checked(self, run_id: str, run: RunRecord, branch: str) -> tuple[ForkFacts, UpstreamFacts, int] | \
            dict[str, object]:
        """Steps 1 to 4: the fork, the upstream's facts and the fork's pull request's number; or the run's upstream
        pull request already recorded open."""
        connector = self._connector
        upstream, ledger = self._ports()
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

    def _link(self, run: RunRecord, branch: str, fork: ForkFacts, found: UpstreamFacts, number: int) -> UpstreamRecord:
        """Step 6: the fork's pull request open and its words checked, the body built, and its one-click link, based
        on the upstream's default branch as GitHub answers it now."""
        upstream, _ = self._ports()
        fork_pr = upstream.fork_pull_request(run.connection_id, number)
        if not fork_pr.open:
            raise UpstreamNotNow(CLOSED)
        from engineering.connectors.broker import MERGE_IS_HUMAN  # (broker.py imports this module)

        description, title = without_broker_line(fork_pr.body, MERGE_IS_HUMAN), upstream_title(fork_pr.title)
        # (the agents' words are held to the write rules again; the upstream's template is its own text)
        check_text(f'{title}\n\n{description}', run.cited_reviews, prose=True)
        login = fork.repository.split('/', 1)[0]
        base = found.facts.default_branch or fork.upstream_default_branch
        try:
            body = upstream_body(template=found.template, description=description, issue=run.issue_number,
                                 contributing=found.contributing.path, login=login)
            link = compare_link(upstream=fork.upstream, base=base, fork=fork.repository,
                                branch=branch, title=title, body=body, issue=run.issue_number, login=login)
        except UpstreamRefused as refused:
            raise UpstreamNotNow(str(refused)) from None
        return UpstreamRecord(UPSTREAM_LINK, fork.upstream, compare_url=link.url, title=title,
                              description=body if link.shortened else None)

    def _open(self, run_id: str, run: RunRecord, branch: str) -> dict[str, object]:
        checked = self._checked(run_id, run, branch)
        if isinstance(checked, dict):
            return checked
        fork, found, number = checked
        upstream, _ = self._ports()
        existing = upstream.existing(run.connection_id, branch)
        if existing is not None:
            return self._opened(run_id, fork, existing)
        record = self._link(run, branch, fork, found, number)
        _record(self._connector, run_id, record)
        logger.info('broker upstream pull request one click away', extra={'run_id': run_id, 'upstream': fork.upstream})
        return {**record.view(), 'repeated': False}

    def _opened(self, run_id: str, fork: ForkFacts, ref: PullRequestRef) -> dict[str, object]:
        """An upstream pull request already open from the branch (the person's click): recorded as the run's."""
        record = UpstreamRecord(UPSTREAM_OPENED, fork.upstream, number=ref.number, url=ref.url)
        _record(self._connector, run_id, record)
        logger.info('broker upstream pull request found open', extra={'run_id': run_id, 'upstream': fork.upstream,
                                                                      'number': ref.number})
        return {**record.view(), 'repeated': True}
