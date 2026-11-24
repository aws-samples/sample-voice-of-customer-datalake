"""The connector's broker: the typed operations each agent role may ask for (docs/autonomous-engineering.md).

Every operation checks, in order: the caller's role may make it; the deployment has a connection; the run (from
the caller's session, never the request) is one the broker knows and is active; for a push or a pull request, the
dial (the way of working of the person who started the run, ``shared/ai_mode.py``: Human-driven pushes nothing,
AI-assisted waits for a person's go on the run, AI-driven goes on; failing closed, ``dial.py``: only an explicitly
stored AI-assisted or AI-driven allows anything, so a person with no saved way of working, a stored mode outside
the modes, or a run that names no person pushes nothing), the CI attestation (7.04.00: an administrator's
confirmation for the run's connection and repository, read at each push and pull request, ``records.py``), the
branch, the host's own branch rules as the connection's read-only token reads them (the default branch protected
with the repository's required checks, the agent's branch unprotected: ``RepositoryHost.ci_protection``, a pass kept
five minutes) and the board's final-go GO for exactly the tree it is about to write; then the write rules
(``write_policy``); and only then calls the host. A write's claim row keeps the attestation's version and when the
branch rules were read (``_ci_record``). A file or history read is of the run's own default branch. A
refusal raises ``WriteRefused`` (``NotPermitted`` for the role, ``NotNow`` for the run's, the dial's or the board's
state) with a plain reason for the run journal.

Each write is made once per key, the caller's run, agent and attempt, the operation and a digest of what it writes
(``_once``, 7.02.00): a claim row (``records.WriteClaims``) is taken just before the host call and closed with its outcome, so a repeat of a write
its caller never heard back from answers the first outcome and is never made twice; a host error leaves the outcome
unknown (``OutcomeUnknown``, 502), and the write is not made again for that attempt. A comment on the run's issue and
its labels are made once per run and issue (7.71.02, ``issue_write_key``: no agent, attempt or digest), so a second
understander of the run gets the first one's answer back: the first live Bug fixer run's two understanders each
commented on and labelled its issue. Since 7.71.03 the labels' answer names who put them (``Labelled.set_by``), and an
issue write whose call never answered (a host error, or a crash between its claim and its outcome) blocks the run's
later ones only until that call is over (``STALE_CLAIM_SECONDS``): the labels, which the host adds idempotently, are
put again, and the comment, which carries the run's marker (``issue_marker``), is looked for on the host first and
posted only when the host has none.

A pull request opens ready for review (7.50.00, the owner's decision: a person approves it without a "Ready for
review" click), or as a draft when the run's flow says ``pr: draft`` (META's ``pull_request``, ``RunRecord.draft_pr``);
an update changes only its title and body, never whether it is a draft, and there is no operation that marks one
ready, approves it or merges it, in any mode: a person approves and merges on the host, and the body the broker sends
says so (``MERGE_IS_HUMAN``). Since 7.50.00 the understander also labels its run's issue (``label_issue``: the triage
labels of ``outputs.TRIAGE_LABELS`` only, at most one kind and one severity, once per run since 7.71.02; no dial, since
a label changes no code). Since 7.47.00 a run started from an issue (META's
``issue``) comments on that issue alone, and its pull request's body names it, ``Fixes #N`` (GitLab: ``Closes #N``)
added when the agent's body does not reference it (``closing_body``); and voc-engineering-start reads a connection's
default branch's head and an issue's state (``head``, its operation alone) for a start that resolves its commit. Since 7.09.00, a pull request the host answered
an open or an update with is kept on the run's record (``_keep_pull_request``, ``engineering/run_links.py``): its host,
number, URL and branches, only when it is the run's own repository's from the run's branch, keyed on that branch (a
new number on it, after a person closed the draft, replaces the old one, which is kept as superseded; another branch
never); a write whose outcome is unknown records nothing until a later open or update finds it by its branch, and a
record that could not be written is read back from the write's done claim.

Every write the host accepts gets an operational log line: the operation, the caller, and what was written (the
issue or pull request number, the branch, the tree hash), never a body, a patch or a credential. It is not the
audit record. The one operation that is no agent's, ``reactions`` (7.10.00), is voc-engineering-runtime's alone
(``identity.runtime_caller_from_event``): people's reactions to an ended run's recorded pull request, read only
(``Broker.reactions``). Each write's claim row keeps its outcome (claimed, done with its answer, refused or unknown), its
operation and when, under the agent's key; it is not the audit row of D4 (who asked, in the run's log), which is
still planned.

Since 7.52.00 voc-engineering-start also asks for ``push_approved_docs`` (``Broker.push_approved_docs``, its alone: no
agent role, nor the runtime): the knowledge docs (``docs/agents/**``) or the tenets (``TENETS.md``) an administrator
approved, rendered again from the stored records and held to the request's and the approval's digest, as one commit on
``voc-agent/docs/<kind>-v<n>`` and a pull request, under the requesting administrator's way of working, the CI
attestation and the branch rules, once per (connection, kind, version) (``records.DocsClaims``); and every agent reads
its run's connection's accepted tenets (``Broker.tenets``, the ``read`` of kind ``tenets``).

Since 7.57.00 a connection is of a kind (``connection_kind``: its credential's). On a public repository read only
(``public_read``) every write is refused, whatever the role, before any token is minted or the host asked
(``_require_kind``: ``READ_ONLY``; a kind it does not know too, failing closed); reads are served. On a fork (``fork``)
the run's issue is the upstream's, so it gets no comment and no label (``FORK_ISSUE``), the fork's pull request names no
issue, and the PR author's open of it goes on to the run's upstream pull request (``_upstream_after``, ``upstream_pr.py``;
``open_upstream_pr`` is that step on its own, the PR author's alone), whose outcome its answer carries and the run's
record keeps; a refusal there never fails the fork's pull request, which was made.

Since 7.60.00 a public repository connected with a fine-grained token limited to it (``fine_grained``): it takes no
comment, label, docs pull request or upstream pull request (``token_scope``: the token holds no Issues permission, and
the docs stay the App's), and its push and pull request follow this order: the role, the connection, the run active,
the dial (Human-driven pushes nothing; AI-assisted and AI-driven alike wait for a person's go, and it must be the token
owner's own: ``token_owner_go``, the go's subject's sha256 held to the owner the token's parameter names), the CI
attestation, the host's branch rules (read with the App's read-only token), the final-go GO for exactly the tree, the
token unexpired (``token_expired``, failing closed), the write rules, and only then the host, with the token
(``TokenWrites``: its requests pinned to the repository's Git Data and pull request paths). Its pull request's body says
whose token pushed it (``token_disclosure``), and each use is logged and kept on the write's claim (who, never the
token).
"""
from __future__ import annotations

import contextlib
import functools
import hashlib
import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import date
from typing import Any, Final

from engineering.connectors.fine_grained import WriteToken, expiry_state, utc_today
from engineering.connectors.hosts import (
    ACTIVE,
    FINE_GRAINED,
    FORK,
    NO_CONNECTION,
    PUBLIC_READ,
    REPOSITORY_KIND,
    WRITE_DONE,
    WRITE_REFUSED,
    WRITE_UNKNOWN,
    BundleContents,
    CiProtection,
    CommentTarget,
    Commit,
    Connector,
    FileChange,
    HostBusy,
    HostError,
    InvalidTarget,
    NoConnection,
    NotFound,
    NotNow,
    OutcomeUnknown,
    PullRequestRef,
    ReadKind,
    ReadPage,
    RunRecord,
    Submission,
    TokenWrites,
    Unavailable,
    WriteLedger,
    ci_refusal,
)
from engineering.connectors.identity import (
    AGENT_ROLES,
    LABEL_ISSUE,
    OPEN_OR_UPDATE_DRAFT_PR,
    OPEN_UPSTREAM_PR,
    POST_COMMENT,
    PUSH_APPROVED_DOCS,
    PUSH_BUNDLE,
    READ,
    RUNTIME_ROLE,
    START_ROLE,
    Caller,
    agent_id,
)
from engineering.connectors.patches import AUTHOR
from engineering.connectors.reactions import PullRequestReactions
from engineering.connectors.upstream_pr import NOT_A_FORK as UPSTREAM_NOT_A_FORK
from engineering.connectors.upstream_pr import UpstreamPullRequests
from engineering.connectors.write_policy import (
    WriteRefused,
    branch_refusal,
    check_ci_definitions,
    check_commit_identities,
    check_commit_message,
    check_heads,
    check_text,
    docs_branch,
    docs_paths,
)
from engineering.run_links import pull_request_link
from engineering.runtime.outputs import TRIAGE_LABELS
from engineering.runtime.runs import ENDED
from shared.ai_mode import MODE_AI_ASSISTED, MODE_AI_DRIVEN
from shared.digests import sha256_hex
from shared.logging import logger, metrics

#: Beyond reading, which every agent may do: the writes each writing role needs, and no other (the understander's
#: comment and its triage labels on the run's issue, 7.50.00; every other writer's one write; the PR author's upstream
#: pull request on a fork connection, 7.57.00, which its open of the fork's pull request also goes on to).
_WRITES: Final[Mapping[str, frozenset[str]]] = {
    'understander': frozenset({POST_COMMENT, LABEL_ISSUE}),
    'pr-reviewer': frozenset({POST_COMMENT}),
    'committer': frozenset({PUSH_BUNDLE}),
    'pr-author': frozenset({OPEN_OR_UPDATE_DRAFT_PR, OPEN_UPSTREAM_PR}),
}
#: A write asked on a public repository read only (7.57.00): refused before any token, whatever the role.
READ_ONLY: Final = ("The run's connection is a public repository read only: nothing is written to it (no comment, "
                    'label, branch or pull request). What the run finds stays in VoC; the connection\'s Contribute '
                    'card makes a fork the agents can push to.')
#: An issue write on a fork connection (7.57.00): the run's issue is the upstream's, which nothing writes to.
FORK_ISSUE: Final = ("The run's issue is the fork's upstream's: the agents comment on and label nothing there. What "
                     'the triage finds stays in VoC.')
class FineGrainedRefused(NotNow):
    """A fine-grained connection's refusal (7.60.00), ``code`` saying which (``token_scope``, ``token_owner_go``,
    ``token_expired``, ``token_not_set``): the broker's answer carries it beside the reason."""

    def __init__(self, reason: str, code: str) -> None:
        super().__init__(reason)
        self.code = code


#: (7.60.00) A write a fine-grained connection's token does not make (``token_scope``): its token holds Contents and Pull
#: requests alone.
SCOPE_REFUSAL: Final = ("The run's connection is a fine-grained token's: it makes the run's branch and pull request "
                      'alone, no comment, label, docs pull request or upstream pull request. What the run finds stays '
                      'in VoC.')
#: A fine-grained connection's push or pull request without its token owner's own go, whatever the way of working
#: (``token_owner_go``).
OWNER_GO_REFUSAL: Final = ("This run pushes with {login}'s fine-grained token: a push or a pull request waits for "
                         "{login}'s own go on the run (POST /agents/engineering/<run_id>/go), in every way of working.")
EXPIRED_REFUSAL: Final = ("The connection's fine-grained token has expired: its owner replaces it under Agents → "
                        'Connections (Replace token), then the step is tried again.')
NOT_SET_REFUSAL: Final = ("The connection's fine-grained token is not stored: an administrator replaces it under Agents → "
                        'Connections (Replace token).')
HUMAN_DRIVEN_REFUSAL: Final = ('This run works Human-driven: its agents find and propose, and push no branch and '
                               'open no pull request. A person makes the change, or an administrator changes the '
                               'way of working of the person who started the run.')
AI_ASSISTED_REFUSAL: Final = ("This run works AI-assisted: a push or a pull request waits for a person's go on the "
                              'run. An administrator gives it on the run (POST /agents/engineering/<run_id>/go).')
#: The run's statuses other than active, and why the broker refuses them (any other: the run has ended).
_NOT_ACTIVE: Final[Mapping[str, str]] = {
    'stopped': 'The run is stopped; the broker refuses its operations.',
    'needs_human': "The run waits at a person's decision; the broker refuses its operations until it is resumed.",
}
_ENDED: Final = 'The run has ended; the broker refuses its operations.'
OTHER_REPOSITORY: Final = ("The run's connection now names another repository than the one the run started on; "
                           'start a new run on it.')


class NotPermitted(WriteRefused):
    """The caller's role may not make this operation."""


def permitted(role: str, operation: str) -> bool:
    """Whether an agent of ``role`` may make ``operation``."""
    return role in AGENT_ROLES and (operation == READ or operation in _WRITES.get(role, frozenset()))


NOT_ATTESTED: Final = ("An administrator has not yet confirmed the repository's CI settings for agent branches "
                       '(Agents → Connections, the CI attestation).')


def _require_attestation(run: RunRecord) -> None:
    if not run.ci_attested:
        raise NotNow(NOT_ATTESTED)


def _require_ci(connector: Connector, run: RunRecord, branch: str) -> CiProtection:
    """The host's own branch rules, as far as the connection's read-only token reads them: the default branch protected
    with the repository's required checks, the agent's branch unprotected (``ci_refusal``)."""
    found = connector.host.ci_protection(run.connection_id, run.default_branch, branch)
    refusal = ci_refusal(found)
    if refusal is not None:
        raise NotNow(refusal)
    return found


def _ci_record(run: RunRecord, found: CiProtection) -> dict[str, object]:
    """What a write's claim row keeps of the CI checks it was made on: the attestation's version, and when the host's
    branch rules were read with the checks they require (the names a repository's own CI gives its jobs)."""
    return {'attestation': run.ci_attestation, 'checked_at': int(found.checked_at),
            'required_checks': list(found.required_checks)}


def _require_dial(connector: Connector, run: RunRecord, run_id: str) -> None:
    """The dial, before anything is pushed or opened: AI-driven goes on, AI-assisted only after a person's go on the
    run, and anything else (Human-driven, no person to read, a mode it does not know) is refused."""
    mode = connector.dial.mode(run.started_by)
    if mode == MODE_AI_DRIVEN:
        return
    if mode == MODE_AI_ASSISTED:
        if connector.ledger.person_go(run_id):
            return
        raise NotNow(AI_ASSISTED_REFUSAL)
    raise NotNow(HUMAN_DRIVEN_REFUSAL)


def _write_token(connector: Connector, connection_id: str) -> WriteToken:
    """A fine-grained connection's write token (7.60.00): ``NoConnection`` where the deployment wires no token reader or
    writes, ``token_not_set`` when none is stored."""
    if connector.write_tokens is None or connector.token_writes is None:
        raise NoConnection(NO_CONNECTION)
    try:
        token = connector.write_tokens.token(connection_id)
    except NoConnection:
        raise FineGrainedRefused(NOT_SET_REFUSAL, 'token_not_set') from None
    if not isinstance(token, WriteToken):
        raise FineGrainedRefused(NOT_SET_REFUSAL, 'token_not_set')
    return token


def _require_token_go(connector: Connector, run: RunRecord, run_id: str) -> WriteToken:
    """A fine-grained connection's dial (7.60.00): Human-driven (or nothing stored, a mode the broker does not know) is
    refused; AI-assisted and AI-driven alike wait for a person's go, and it must be the token owner's own (the go's
    subject's sha256 is the owner the token's parameter names). The token, once its go holds."""
    if connector.dial.mode(run.started_by) not in (MODE_AI_ASSISTED, MODE_AI_DRIVEN):
        raise NotNow(HUMAN_DRIVEN_REFUSAL)
    token = _write_token(connector, run.connection_id)
    if token.repository.lower() != run.repository.lower():
        raise NotNow(OTHER_REPOSITORY)
    by = connector.ledger.person_go_by(run_id)
    if not by or sha256_hex(by) != token.owner:
        raise FineGrainedRefused(OWNER_GO_REFUSAL.format(login=token.login), 'token_owner_go')
    return token


def _require_unexpired(token: WriteToken | None, today: date) -> None:
    """The token is not past its expiry on ``today`` (UTC), failing closed on an expiry it cannot read."""
    if token is not None and expiry_state(token.expires_at, today) in ('expired', 'unset'):
        raise FineGrainedRefused(EXPIRED_REFUSAL, 'token_expired')


def _token_used(caller: Caller, operation: str, run: RunRecord, token: WriteToken) -> dict[str, object]:
    """The use of a fine-grained connection's token (7.60.00), logged (never the token) and kept on the write's claim:
    the credential's kind, whose it is and when it expires."""
    used: dict[str, object] = {'credential': 'fine_grained_token', 'login': token.login,
                               'expires_at': token.expires_at}
    logger.info('broker used a fine-grained token', extra={'operation': operation, 'run_id': caller.run_id,
                                                           'connection_id': run.connection_id, 'login': token.login})
    return used


def token_disclosure(body: str, login: str) -> str:
    """A fine-grained connection's pull request body (7.60.00), naming whose token pushed it and whose go it waited
    for (the token owner's own): trusted text the broker adds after the write rules read what the agent wrote, once."""
    line = f"Pushed with {login}'s fine-grained token, after {login}'s own go on the run."
    kept = body.rstrip()
    return kept if line in kept else f'{kept}\n\n{line}'


def connection_kind(connector: Connector, connection_id: str) -> str:
    """The connection's kind (7.57.00: ``hosts.REPOSITORY_KIND``, ``PUBLIC_READ`` or ``FORK``), from its credential: ``repository`` where the
    deployment wires no upstream reader (every connection is then one's own)."""
    return REPOSITORY_KIND if connector.upstream is None else connector.upstream.kind(connection_id)


#: (7.60.00) What a fine-grained connection's token writes: the run's push and pull request, nothing else.
_TOKEN_WRITES: Final = frozenset({PUSH_BUNDLE, OPEN_OR_UPDATE_DRAFT_PR})


def _require_kind(kind: str, operation: str) -> None:
    """Every write refused on a public repository read only; an issue's label on a fork (its issue is the upstream's;
    an issue comment is refused in ``post_comment``, which knows the target); the upstream pull request only on a
    fork; on a fine-grained connection (7.60.00) every write but the push and the pull request. Any kind this broker
    does not know refuses every write, failing closed."""
    if operation == READ:
        return
    if kind == FINE_GRAINED:
        if operation not in _TOKEN_WRITES:
            raise FineGrainedRefused(SCOPE_REFUSAL, 'token_scope')
        return
    if kind == PUBLIC_READ or kind not in (REPOSITORY_KIND, FORK):
        raise NotNow(READ_ONLY)
    if kind == FORK and operation == LABEL_ISSUE:
        raise NotNow(FORK_ISSUE)
    if kind != FORK and operation == OPEN_UPSTREAM_PR:
        raise NotNow(UPSTREAM_NOT_A_FORK)


def _require_branch(branch: str, run: RunRecord, run_id: str) -> None:
    refusal = branch_refusal(branch, run.default_branch, run_id)
    if refusal is not None:
        raise WriteRefused(refusal.message)


def _wrote(caller: Caller, operation: str, run: RunRecord, **written: object) -> None:
    """The log line of a write the host accepted: who, on which connection, and what (never the text)."""
    logger.info('broker wrote', extra={'operation': operation, 'role': caller.role, 'run_id': caller.run_id,
                                       'agent': caller.agent_index, 'connection_id': run.connection_id, **written})


def _active_run(connector: Connector, caller: Caller) -> RunRecord:
    """The caller's run, refused unless the broker knows it and it is active."""
    run = connector.runs.run(caller.run_id)
    if run is None:
        raise NotNow('The run is not one the broker knows.')
    if run.status != ACTIVE:
        raise NotNow(_NOT_ACTIVE.get(run.status, _ENDED))
    return run


class Broker:
    """The operations, over a configured ``Connector`` (``None``: no connection, every operation refused)."""

    def __init__(self, connector: Connector | None, today: Callable[[], date] = utc_today) -> None:
        self._connector = connector
        #: Today (UTC): a fine-grained connection's token expiry is held to it (7.60.00).
        self._today = today

    def _open(self, caller: Caller, operation: str) -> tuple[Connector, RunRecord]:
        if not permitted(caller.role, operation):
            raise NotPermitted(f'The {caller.role} role may not {operation.replace("_", " ")}.')
        if self._connector is None:
            raise NoConnection(NO_CONNECTION)
        run = _active_run(self._connector, caller)
        # The connection's credential must still be for the repository the run started on (connections.py: a stored
        # connection's repository may change once its runs end, and a credential and its row could disagree after a
        # failed save): a run never reads or writes another repository than its own.
        if self._connector.host.repository(run.connection_id) != run.repository:
            raise NotNow(OTHER_REPOSITORY)
        # (7.57.00) A public repository read only takes no write of any kind, and a fork's issue is its upstream's:
        # refused here, before any token is minted or the host asked (fail closed: a kind not read is no pass).
        _require_kind(connection_kind(self._connector, run.connection_id), operation)
        # Only then the run's branch: the stored one once the host confirms it (StoredBranchMissing, 409, when not),
        # so a credential re-pointed at another repository is never used for a lookup.
        branch = self._connector.host.default_branch(run.connection_id, run.stored_default_branch)
        return self._connector, replace(run, default_branch=branch)

    def _open_write(self, caller: Caller, operation: str,
                    branch: str) -> tuple[Connector, RunRecord, dict[str, object], WriteToken | None]:
        """A push's or a pull request's checks before its own: the run, the dial (on a fine-grained connection, its
        token owner's own go: ``_require_token_go``), the CI attestation (read now, so a withdrawal or a void holds from
        the next write), the branch, then the host's branch rules; with what the write's claim keeps of the CI checks,
        and a fine-grained connection's token (None on any other)."""
        connector, run = self._open(caller, operation)
        token = None
        if connection_kind(connector, run.connection_id) == FINE_GRAINED:
            token = _require_token_go(connector, run, caller.run_id)
        else:
            _require_dial(connector, run, caller.run_id)
        run = connector.runs.attested(run)
        _require_attestation(run)
        _require_branch(branch, run, caller.run_id)
        return connector, run, _ci_record(run, _require_ci(connector, run, branch)), token

    def _first_outcome(self, caller: Caller, operation: str, key: str) -> dict[str, object] | None:
        """A repeat's first outcome (its write's ``key``: ``write_key``, ``issue_write_key``), before the run's, the
        dial's and the board's checks (as the runtime answers a repeated launch): a write made answers its answer even
        after the run moved on, and one whose outcome is not known is ``OutcomeUnknown``; None when there is none
        (never asked, or refused with nothing written). The role's permission and the connection still come first."""
        if not permitted(caller.role, operation):
            raise NotPermitted(f'The {caller.role} role may not {operation.replace("_", " ")}.')
        if self._connector is None:
            raise NoConnection(NO_CONNECTION)
        earlier = self._connector.writes.earlier(caller.run_id, key)
        # (7.71.03) An issue write whose earlier call has no outcome goes on to its claim, which takes it again only
        # once that call is long over (``STALE_CLAIM_SECONDS``) and answers ``OutcomeUnknown`` until then.
        if earlier is None or earlier.state == WRITE_REFUSED or (_issue_key(key) and earlier.state != WRITE_DONE):
            return None
        if earlier.state == WRITE_DONE and earlier.result is not None:
            _repeated(caller, operation, key)
            return earlier.result
        raise OutcomeUnknown(_unknown(key))

    def read(self, caller: Caller, kind: ReadKind, target: str, cursor: str | None) -> ReadPage:
        connector, run = self._open(caller, READ)
        # (a file and history on the run's own default branch: the stored one it started with, once the host has it)
        return connector.host.read(run.connection_id, kind, target, cursor, run.default_branch)

    def post_comment(self, caller: Caller, on: CommentTarget, number: int, body: str, attempt: int = 1) -> str:
        """Post ``body`` on the run's own issue or pull request; the comment's URL. Once per ``attempt`` (``_once``) on
        the pull request; once per run on its issue (7.71.02, ``issue_write_key``: a later caller, another
        understander, gets the first comment's URL back). A comment on the issue carries the run's marker
        (``issue_marker``, 7.71.03), so a later call whose earlier one has no outcome finds it on the host, and posts
        only when the host has none."""
        issue = on == 'issue'
        key = issue_write_key(number, POST_COMMENT) if issue else write_key(caller, attempt, POST_COMMENT, on, number,
                                                                            body)
        first = self._first_outcome(caller, POST_COMMENT, key)
        if first is not None:
            return str(first['url'])
        connector, run = self._open(caller, POST_COMMENT)
        if issue and connection_kind(connector, run.connection_id) == FORK:
            raise NotNow(FORK_ISSUE)
        own = run.issue_number if issue else run.pull_request_number
        if own is None or number != own:
            raise NotPermitted(f"An agent comments only on its own run's {on.replace('_', ' ')}.")
        check_text(body, run.cited_reviews, prose=True)
        marker = issue_marker(caller.run_id)

        def comment() -> dict[str, object]:
            url = connector.host.post_comment(run.connection_id, on, number, f'{body}\n\n{marker}' if issue else body)
            _wrote(caller, POST_COMMENT, run, on=on, number=number)
            return {'url': url}

        def made() -> dict[str, object] | None:
            url = connector.host.issue_comment(run.connection_id, number, marker)
            return None if url is None else {'url': url}

        return str(_once(connector, caller, POST_COMMENT, key, comment, made if issue else None)['url'])

    def label_issue(self, caller: Caller, number: int, labels: tuple[str, ...], attempt: int = 1) -> Labelled:
        """Put the triage ``labels`` on the run's own issue ``number`` (the understander's, 7.50.00): the labels
        added. Only ``TRIAGE_LABELS``, one or two, at most one kind (``voc-triage/*``) and one severity
        (``voc-severity/*``); the run active, as every operation; no dial (a label changes no code) and no CI check.
        Once per run and issue (7.71.02, ``issue_write_key``; before, once per ``attempt``): a later caller gets the
        labels the first one put, and (7.71.03) who put them (``Labelled.set_by``). A label is idempotent on the host,
        so one whose earlier call has no outcome is put again once that call is long over (``STALE_CLAIM_SECONDS``)."""
        del attempt   # (the run's, whoever asks: never once per attempt)
        if not permitted(caller.role, LABEL_ISSUE):   # (the role first, before what it asks is judged)
            raise NotPermitted(f'The {caller.role} role may not {LABEL_ISSUE.replace("_", " ")}.')
        asked = _triage_labels(labels)
        key = issue_write_key(number, LABEL_ISSUE)
        first = self._first_outcome(caller, LABEL_ISSUE, key)
        if first is not None:
            return _labelled(first, '')
        connector, run = self._open(caller, LABEL_ISSUE)
        if run.issue_number is None or number != run.issue_number:
            raise NotPermitted("An agent labels only its own run's issue.")
        own = agent_id(caller)

        def label() -> dict[str, object]:
            added = connector.host.label_issue(run.connection_id, number, asked)
            _wrote(caller, LABEL_ISSUE, run, on='issue', number=number, labels=list(added))
            return {'number': number, 'labels': list(added), 'by': own}

        return _labelled(_once(connector, caller, LABEL_ISSUE, key, label, lambda: None), own)

    def push_bundle(self, caller: Caller, branch: str, patch: str, tree_hash: str, message: str,
                    attempt: int = 1) -> str:
        """Push the caller's submitted ``patch`` (its key in the workspace) as one commit with ``message`` to one of
        the run's branches, for the tree the board's GO names; the pushed tree's hash. The host moves the branch only
        when the tree it rebuilt from the patch is ``tree_hash``. Once per ``attempt`` (``_once``)."""
        key = write_key(caller, attempt, PUSH_BUNDLE, branch, patch, tree_hash, message)
        first = self._first_outcome(caller, PUSH_BUNDLE, key)
        if first is not None:
            return str(first['tree_hash'])
        connector, run, ci, token = self._open_write(caller, PUSH_BUNDLE, branch)
        if not connector.ledger.has_go(caller.run_id, tree_hash):
            raise NotNow("The board holds no final-go GO for this tree: the quality gate's final go passes on it "
                         'first.')
        _require_unexpired(token, self._today())
        contents = connector.bundles.contents(Submission(
            run_id=caller.run_id, agent_id=agent_id(caller), run=run, key=patch, branch=branch, tree_hash=tree_hash,
            message=message))
        check_heads(contents.heads)
        # (the branch was judged in _open_write, before anything was read; a host's own named CI files are its client's)
        check_ci_definitions(contents.changed_paths, ())
        for commit in contents.commits:
            check_commit_identities(commit.author, commit.committer, run.bot_addresses)
            check_commit_message(commit.message, run.cited_reviews, run.bot_addresses)
        check_text('\n'.join(contents.added_lines), run.cited_reviews, prose=False)

        def push() -> dict[str, object]:
            used: dict[str, object] = {}
            if token is None:
                connector.host.push_bundle(run.connection_id, branch, contents, tree_hash, run.default_branch)
            else:   # (7.60.00: the token's write, its every request pinned to the repository's Git Data paths)
                _token_writes(connector).push_bundle_as(run.connection_id, branch, contents, tree_hash,
                                                        run.default_branch, token.token)
                used = {'with': _token_used(caller, PUSH_BUNDLE, run, token)}
            _wrote(caller, PUSH_BUNDLE, run, branch=branch, tree_hash=tree_hash, commits=len(contents.commits))
            return {'branch': branch, 'tree_hash': tree_hash, 'ci': ci, **used}

        return str(_once(connector, caller, PUSH_BUNDLE, key, push)['tree_hash'])

    def open_or_update_draft_pr(self, caller: Caller, branch: str, title: str, body: str,
                                attempt: int = 1) -> PullRequestRef:
        """Open the run's draft pull request from ``branch`` to the default branch, or update its text. Once per
        ``attempt`` (``_once``). On a fork connection (7.57.00) it goes on to the run's upstream pull request
        (``_upstream_after``): the answer's ``upstream`` says what came of it, and a refusal leaves the run with the
        fork's pull request."""
        key = write_key(caller, attempt, OPEN_OR_UPDATE_DRAFT_PR, branch, title, body)
        first = self._first_outcome(caller, OPEN_OR_UPDATE_DRAFT_PR, key)
        if first is not None:
            return self._upstream_after(caller, branch, _pull_request(first))
        connector, run, ci, token = self._open_write(caller, OPEN_OR_UPDATE_DRAFT_PR, branch)
        check_text(f'{title}\n\n{body}', run.cited_reviews, prose=True)
        tree_hash = connector.host.branch_tree_hash(run.connection_id, branch)
        if tree_hash is None:
            raise NotNow('The branch is not on the host yet; push it first.')
        if not connector.ledger.has_go(caller.run_id, tree_hash):
            raise NotNow("The board holds no GO for the branch's tree.")
        _require_unexpired(token, self._today())
        fork = connection_kind(connector, run.connection_id) == FORK
        # (a fork's pull request names no issue: its issue is the upstream's, which the upstream pull request fixes;
        # 7.60.00: a fine-grained token's says whose token pushed it, after whose go)
        own = body if fork else closing_body(body, run)
        sent = merge_is_human(own if token is None else token_disclosure(own, token.login))

        def opened_or_updated() -> tuple[PullRequestRef, dict[str, object]]:
            if token is None:
                return connector.host.open_or_update_draft_pr(run.connection_id, branch, run.default_branch, title,
                                                              sent, tree_hash, draft=run.draft_pr), {}
            ref = _token_writes(connector).open_or_update_pr_as(run.connection_id, branch, run.default_branch, title,
                                                                sent, tree_hash, token.token, draft=run.draft_pr)
            return ref, {'with': _token_used(caller, OPEN_OR_UPDATE_DRAFT_PR, run, token)}

        def open_draft() -> dict[str, object]:
            ref, used = opened_or_updated()
            _wrote(caller, OPEN_OR_UPDATE_DRAFT_PR, run, branch=branch, tree_hash=tree_hash, number=ref.number)
            # (the host answered with it, so it stands: kept on the run's record; an answer that never came, an
            # outcome unknown, records nothing, and the next open or update finds it by its branch)
            _keep_pull_request(connector, caller, run, branch, ref)
            # (the claim keeps what the record keeps, so a record that could not be written is read back from it:
            # run_links.py)
            return {'number': ref.number, 'url': ref.url, 'head': ref.head, 'base': ref.base, 'host': ref.host,
                    'ci': ci, **used}

        done = _pull_request(_once(connector, caller, OPEN_OR_UPDATE_DRAFT_PR, key, open_draft))
        return self._upstream_after(caller, branch, done) if fork else done

    def _upstream_after(self, caller: Caller, branch: str, ref: PullRequestRef) -> PullRequestRef:
        """The fork's pull request ``ref`` with the run's upstream pull request's outcome (7.57.00): its one-click link
        (``link``, the run's record keeping it), one already open from the branch (``opened``), or refused with its
        reason and no link (the run ends with the fork's pull request). Never raises: the fork's pull request was made,
        and is the answer whatever becomes of the upstream one. ``ref`` as it is on any other connection."""
        connector = self._connector
        if connector is None or connector.upstream is None:
            return ref
        run = connector.runs.run(caller.run_id)
        if (run is None or run.status != ACTIVE or connector.host.repository(run.connection_id) != run.repository
                or connection_kind(connector, run.connection_id) != FORK):
            return ref
        try:
            outcome = self._upstream_step(connector).open(caller.run_id, run, branch)
        except (WriteRefused, HostError, NoConnection) as failed:
            reason = failed.reason if isinstance(failed, (WriteRefused, HostError)) else NO_CONNECTION
            logger.info('broker upstream pull request not offered', extra={'run_id': caller.run_id,
                                                                           'kind': type(failed).__name__})
            outcome = {'state': 'refused', 'reason': reason}
        return replace(ref, upstream=outcome)

    @staticmethod
    def _upstream_step(connector: Connector) -> UpstreamPullRequests:
        return UpstreamPullRequests(connector)

    def open_upstream_pr(self, caller: Caller, branch: str) -> dict[str, object]:
        """The run's upstream pull request (7.57.00, the PR author's alone): what ``upstream_pr.py`` checks, then its
        one-click link to GitHub's compare page, ``<fork owner>:<branch>`` → the upstream's default branch, which the
        person opens (the app never opens it itself, 7.58.00); one already open from the branch is answered as it
        stands. A safety check's refusal is ``NotNow`` (409), no link, and is kept on the run's record."""
        connector, run = self._open(caller, OPEN_UPSTREAM_PR)
        _require_branch(branch, run, caller.run_id)
        return self._upstream_step(connector).open(caller.run_id, run, branch)

    def reactions(self, caller: Caller, run_id: str) -> PullRequestReactions | None:
        """People's reactions to an ended run's recorded pull request (7.10.00): the runtime's operation alone (an
        agent's session, whatever its role, is ``NotPermitted``). The run is the request's (the runtime acts for any
        run), and everything else is its record's: an ended run (``NotNow`` before), whose connection's credential
        still names the repository it started on, and the pull request its record keeps (``run_links``), read on the
        run's default branch. None when the run has no connection or no recorded pull request: nothing is asked of the
        host. Reads only (``RepositoryHost.reactions``)."""
        if caller.role != RUNTIME_ROLE:
            raise NotPermitted(f'The {caller.role} role may not read reactions.')
        if self._connector is None:
            raise NoConnection(NO_CONNECTION)
        connector = self._connector
        run = connector.runs.run(run_id)
        if run is None:
            raise NotNow('The run is not one the broker knows.')
        if run.status not in ENDED:   # (the runs' own statuses once ended: done, failed, stopped)
            raise NotNow(NOT_ENDED)
        if not run.connection_id:
            return None
        if connector.host.repository(run.connection_id) != run.repository:
            raise NotNow(OTHER_REPOSITORY)
        link = connector.writes.pull_request(run_id, run.repository)
        if link is None:
            return None
        branch = connector.host.default_branch(run.connection_id, run.stored_default_branch)
        found = connector.host.reactions(run.connection_id, link.number, link.url, branch)
        if found.host != link.host:   # (the connection moved to another host since: never read as the run's)
            raise NotNow(OTHER_REPOSITORY)
        logger.info('broker read reactions', extra={
            'run_id': run_id, 'connection_id': run.connection_id, 'number': link.number, 'state': found.state,
            'kept': len(found.items), 'outsiders': found.dropped.outsiders, 'bots': found.dropped.bots})
        return found

    def head(self, caller: Caller, connection_id: str, repository: str, branch: str,
             issue: int | None = None) -> dict[str, object]:
        """The head commit of a connection's stored default ``branch`` and, with an ``issue``, its state on the host
        (7.47.00): voc-engineering-start's operation alone (an agent's or the runtime's session is ``NotPermitted``),
        for a start that resolves its commit before its run is written. The connection's credential must name
        ``repository`` (its stored row's, which the start copies onto the run) and the repository must have the branch
        (``StoredBranchMissing`` otherwise). Reads only."""
        if caller.role != START_ROLE:
            raise NotPermitted(f'The {caller.role} role may not read a branch head.')
        if self._connector is None:
            raise NoConnection(NO_CONNECTION)
        host = self._connector.host
        if host.repository(connection_id) != repository:
            raise NotNow(START_OTHER_REPOSITORY)
        commit = host.head_commit(connection_id, host.default_branch(connection_id, branch))
        if commit is None:
            raise NotNow(NO_BRANCH)
        found = None if issue is None else {'number': issue, 'state': host.issue_state(connection_id, issue)}
        logger.info('broker read a head', extra={'connection_id': connection_id, 'issue': issue,
                                                 'issue_state': None if found is None else found['state']})
        return {'commit': commit, 'issue': found}


    def tenets(self, caller: Caller) -> ReadPage:
        """An agent's ``read`` of kind ``tenets`` (7.52.00): its run's connection's accepted tenets, as an
        administrator accepted them (never the repository's TENETS.md), as JSON ``{version, summary, tenets: [{id,
        title, statement, rationale, citations}]}``, ``{version: null, tenets: []}`` with none accepted. Every agent
        reads (``READ``), for an active run, on its own connection; no host is asked."""
        if not permitted(caller.role, READ):
            raise NotPermitted(f'The {caller.role} role may not read.')
        connector = self._connector
        if connector is None or connector.docs is None:
            raise NoConnection(NO_CONNECTION)
        run = _active_run(connector, caller)
        accepted = connector.docs.accepted_tenets(run.connection_id)
        return ReadPage(json.dumps(accepted or {'version': None, 'summary': '', 'tenets': []}, sort_keys=True), None)

    def push_approved_docs(self, caller: Caller, request: DocsRequest) -> dict[str, object]:
        """The approved docs of ``request.kind`` (7.52.00; the knowledge docs, ``docs/agents/**``, or the tenets,
        ``TENETS.md``) as one commit on their own branch (``voc-agent/docs/<kind>-v<n>``, on the default branch's head)
        and a pull request, ready for review or a draft as asked (the flow's ``pr``); voc-engineering-start's alone
        (its ``publish_docs``, an administrator's request: no agent role may ask for it, ``NotPermitted``).

        Before anything is written: the connection's credential names the stored connection's repository; the approved
        version is read again and rendered again from the stored records (``DocsReader.approved``), and the request's
        digest, the approval's and the rendering's must be one (``DocsRefused`` ``digest_mismatch`` otherwise); every
        path is the kind's own (``write_policy.docs_paths``); the requesting administrator's STORED way of working,
        failing closed (``DocsRefused`` ``human_driven`` for anything but AI-assisted or AI-driven: their request is
        the person's go AI-assisted waits for); the CI attestation and the host's branch rules, as for an agent's push.
        No final go: no code is written (D-6). Each write once per (connection, kind, version), the push and the pull
        request each its own claim (``DocsClaims``), so a pull request whose open failed is opened on a retry from the
        branch already pushed; a second publish of a version whose pull request is open answers it, ``repeated``."""
        if caller.role != START_ROLE:
            raise NotPermitted(f'The {caller.role} role may not push approved docs.')
        connector = self._connector
        if connector is None or connector.docs is None or connector.docs_writes is None:
            raise NoConnection(NO_CONNECTION)
        claims, connection = connector.docs_writes, request.connection
        recorded, rendering = _approved_docs(connector, request)
        branch = docs_branch(request.kind, recorded.version)
        key = functools.partial(docs_write_key, request.kind, recorded.version, digest=recorded.digest)
        opened = _earlier_done(claims, connection, key(OPEN_OR_UPDATE_DRAFT_PR))
        if opened is not None:
            _docs_repeated(connection, request.kind, recorded.version)
            return {**opened, 'repeated': True}
        default, run, ci = _docs_write_checks(connector, request, branch)
        commit = Commit(docs_commit_message(request.kind, recorded.version, recorded.digest), AUTHOR, AUTHOR,
                        tuple(FileChange(file.path, '100644', file.content) for file in rendering.files))
        check_commit_identities(commit.author, commit.committer, run.bot_addresses)
        check_commit_message(commit.message, (), run.bot_addresses)
        lines = tuple(line for file in rendering.files for line in file.content.decode().splitlines())
        check_text('\n'.join(lines), (), prose=request.kind == 'tenets')
        title, body = docs_pull_request(request.kind, recorded.version, recorded.digest, rendering.paths(),
                                        recorded.approved_at)
        check_text(f'{title}\n\n{body}', (), prose=True)
        pushed = _earlier_done(claims, connection, key(PUSH_BUNDLE)) or _docs_push(
            connector, request, recorded.version, key(PUSH_BUNDLE), BundleContents(
                heads=(f'refs/heads/{branch}',), tree_hash='', changed_paths=rendering.paths(), commits=(commit,),
                added_lines=lines, base=''), default, ci)
        tree_hash = str(pushed['tree_hash'])

        def open_pull_request() -> dict[str, object]:
            ref = connector.host.open_or_update_draft_pr(connection, branch, default, title, merge_is_human(body),
                                                         tree_hash, draft=request.draft)
            _docs_wrote(OPEN_OR_UPDATE_DRAFT_PR, connection, kind=request.kind, version=recorded.version,
                        branch=branch, tree_hash=tree_hash, number=ref.number)
            return {'pr': {'number': ref.number, 'url': ref.url, 'branch': branch}, 'kind': request.kind,
                    'version': recorded.version, 'digest': recorded.digest, 'tree_hash': tree_hash,
                    'draft': request.draft, 'ci': ci}

        done = _claimed(claims, connection, key(OPEN_OR_UPDATE_DRAFT_PR), OPEN_OR_UPDATE_DRAFT_PR, open_pull_request,
                        lambda: _docs_repeated(connection, request.kind, recorded.version))
        return {**done, 'repeated': False}


@dataclass(frozen=True)
class DocsRequest:
    """voc-engineering-start's ``push_approved_docs`` (7.52.00): the stored connection (its id, its repository and
    its default branch, as its row has them), the kind (``knowledge`` or ``tenets``), the digest of the docs the
    administrator saw, who asked (whose way of working the write follows), and whether the pull request opens as a
    draft (the flow's ``pr``)."""

    connection: str
    repository: str
    default_branch: str
    kind: str
    digest: str
    requested_by: str
    draft: bool = False


class DocsRefused(NotNow):
    """The docs write refused for its state, ``code`` saying which (``human_driven``, ``not_approved``,
    ``digest_mismatch``): the broker's answer carries it beside the reason."""

    def __init__(self, reason: str, code: str) -> None:
        super().__init__(reason)
        self.code = code


#: The largest docs one write puts on a branch, all its files together (one Git Data API tree).
MAX_DOCS_BYTES: Final = 4 * 1024 * 1024
DOCS_HUMAN_DRIVEN: Final = ('You work Human-driven: the platform pushes nothing and opens no pull request for you. Apply '
                            'the patch of GET /agents/engineering/docs/<connection>/preview yourself, or change your '
                            'way of working.')
DOCS_NOT_APPROVED: Final = 'Nothing of this kind is approved for the connection yet: approve it first.'
DOCS_DIGEST: Final = ("These are not the docs approved: the request's digest, the approval's and the stored records' "
                      'rendering differ. Read the preview again.')
DOCS_TITLES: Final[Mapping[str, str]] = {'knowledge': 'Agent docs: the approved knowledge pack (rendering {version})',
                                         'tenets': 'Tenets: the accepted version {version}'}


def _approved_docs(connector: Connector, request: DocsRequest) -> tuple[Any, Any]:
    """The approved docs' recorded rendering and its files as rendered again, once the connection's credential names
    the stored connection's repository, something of the kind is approved, the three digests are one, every path is
    the kind's own and the files fit one write."""
    if connector.host.repository(request.connection) != request.repository:
        raise NotNow(START_OTHER_REPOSITORY)
    # (7.57.00: a public repository read only gets no docs pull request; its approved docs stay in VoC)
    _require_kind(connection_kind(connector, request.connection), PUSH_APPROVED_DOCS)
    approved = None if connector.docs is None else connector.docs.approved(request.connection, request.kind)
    if approved is None:
        raise DocsRefused(DOCS_NOT_APPROVED, 'not_approved')
    recorded, rendering = approved.recorded, approved.rendering
    if not request.digest == recorded.digest == rendering.digest:
        raise DocsRefused(DOCS_DIGEST, 'digest_mismatch')
    docs_paths(rendering.paths(), request.kind)
    if sum(len(file.content) for file in rendering.files) > MAX_DOCS_BYTES:
        raise WriteRefused(f'The docs are larger than one write takes ({MAX_DOCS_BYTES} bytes).')
    return recorded, rendering


def _docs_write_checks(connector: Connector, request: DocsRequest,
                       branch: str) -> tuple[str, RunRecord, dict[str, object]]:
    """A docs write's checks before its own: the requesting administrator's way of working, the default branch (the
    stored one once the host confirms it), the CI attestation and the host's branch rules; the default branch, the
    record the checks read and what the claims keep of the CI checks."""
    _require_docs_dial(connector, request.requested_by)
    default = connector.host.default_branch(request.connection, request.default_branch)
    if branch == default:
        raise WriteRefused('The docs are never written to the default branch.')
    run = connector.runs.attested(RunRecord(
        connection_id=request.connection, default_branch=default, status=ACTIVE, ci_attested=False, cited_reviews=(),
        bot_addresses=(AUTHOR,), repository=request.repository, stored_default_branch=request.default_branch))
    _require_attestation(run)
    return default, run, _ci_record(run, _require_ci(connector, run, branch))


def _docs_push(connector: Connector, request: DocsRequest, version: int, key: str, contents: BundleContents,
               default: str, ci: dict[str, object]) -> dict[str, object]:
    """The docs' one commit pushed on its new branch, from the default branch's head (its tree worked out first:
    the tree the host must build), once (``DocsClaims``)."""
    host, connection, branch = connector.host, request.connection, contents.heads[0].removeprefix('refs/heads/')
    base = host.head_commit(connection, default)
    if base is None:
        raise NotNow(NO_BRANCH)
    tree = host.tree_with(connection, base, contents.commits[0].changes)
    bundle = replace(contents, tree_hash=tree, base=base)

    def push() -> dict[str, object]:
        host.push_bundle(connection, branch, bundle, tree, default)
        _docs_wrote(PUSH_BUNDLE, connection, kind=request.kind, version=version, branch=branch, tree_hash=tree,
                    files=len(bundle.changed_paths))
        return {'branch': branch, 'tree_hash': tree, 'base': base, 'ci': ci}

    claims = connector.docs_writes
    if claims is None:
        raise NoConnection(NO_CONNECTION)
    return _claimed(claims, connection, key, PUSH_BUNDLE, push, lambda: _docs_repeated(connection, request.kind, version))


def _require_docs_dial(connector: Connector, person: str) -> None:
    """The requesting administrator's stored way of working, failing closed (``dial.py``): AI-driven and AI-assisted
    go on (their request is the person's go), anything else is ``human_driven``."""
    if connector.dial.mode(person) not in (MODE_AI_DRIVEN, MODE_AI_ASSISTED):
        raise DocsRefused(DOCS_HUMAN_DRIVEN, 'human_driven')


def docs_write_key(kind: str, version: int, operation: str, *, digest: str) -> str:
    """The key a docs write is made once for, in the connection's docs partition (``records.DocsClaims``), in a run's
    write key's shape (``write_key``: ``<who>#<attempt>#<operation>#<digest>``): the kind and version, the write (its
    push, its pull request) and the rendering's digest, which a version never changes: once per (connection, kind,
    version)."""
    return f'docs-{kind}-v{version}#1#{operation}#{digest[:32]}'


def _earlier_done(claims: WriteLedger, partition: str, key: str) -> dict[str, object] | None:
    """A done claim's answer; None for none or a refused one (claimed again); ``OutcomeUnknown`` for one whose
    outcome is not known (never made again)."""
    earlier = claims.earlier(partition, key)
    if earlier is None or earlier.state == WRITE_REFUSED:
        return None
    if earlier.state == WRITE_DONE and earlier.result is not None:
        return dict(earlier.result)
    raise OutcomeUnknown(EARLIER_UNKNOWN)


def docs_commit_message(kind: str, version: int, digest: str) -> str:
    """The docs commit's message: trusted text, the kind, its version and its rendering's digest."""
    what = 'the approved knowledge pack' if kind == 'knowledge' else 'the accepted tenets'
    return (f'docs: {what}, version {version}\n\nRendered by the Voice of the Customer data lake from {what} '
            f'(rendering digest {digest}).')


def docs_pull_request(kind: str, version: int, digest: str, paths: tuple[str, ...],
                      approved_at: str) -> tuple[str, str]:
    """The docs pull request's title and body: trusted text (the files, the version, the digest, when it was approved);
    ``merge_is_human`` adds that a person reviews and merges it."""
    listed = '\n'.join(f'- `{path}`' for path in paths[:50])
    more = f'\n- and {len(paths) - 50} more' if len(paths) > 50 else ''
    what = ("the repository's approved knowledge pack, as `docs/agents/`" if kind == 'knowledge'
            else "the repository's accepted tenets, as `TENETS.md`")
    when = f' on {approved_at[:10]}' if approved_at else ''
    body = (f'This pull request writes {what} (version {version}, rendering digest `{digest[:16]}`), as an '
            f'administrator approved it{when}.\n\n{listed}{more}\n\nReview the diff here. To change these files, '
            'change the pack or the tenets in the app and approve them again: a new version opens a new pull request.')
    return DOCS_TITLES[kind].format(version=version), body


def _docs_wrote(operation: str, connection: str, **written: object) -> None:
    logger.info('broker wrote docs', extra={'operation': operation, 'role': START_ROLE, 'connection_id': connection,
                                            **written})


def _docs_repeated(connection: str, kind: str, version: int) -> None:
    logger.info('broker docs write repeated', extra={'connection_id': connection, 'kind': kind, 'version': version})


NOT_ENDED: Final = "The run has not ended; its pull request's reactions are read once it has."
#: How each host's pull (merge) request closes the issue it fixes once merged (7.47.00).
CLOSING_KEYWORDS: Final[Mapping[str, str]] = {'github': 'Fixes', 'gitlab': 'Closes'}
START_OTHER_REPOSITORY: Final = ("The connection's credential names another repository than its stored row; an "
                                 'administrator saves the connection again.')
NO_BRANCH: Final = "The connection's default branch has no head on the repository."


def closing_body(body: str, run: RunRecord) -> str:
    """A run's pull request body, naming the issue it starts from (7.47.00): ``Fixes #N`` (GitLab: ``Closes #N``)
    added on its own line when the body does not already reference ``#N``; the body as given for a run with no
    issue. Trusted text (a number), added after the write rules read what the agent wrote."""
    number = run.issue_number
    if number is None or re.search(rf'(?<![\w/#])#{number}(?!\d)', body):
        return body
    return f'{body.rstrip()}\n\n{CLOSING_KEYWORDS.get(run.issue_host, "Fixes")} #{number}'


#: The trusted line every pull request body the broker sends ends with (7.50.00): the merge is a person's.
MERGE_IS_HUMAN: Final = ('Opened by an autonomous engineering run of the Voice of the Customer data lake. Only a '
                         'person approves and merges it: the agents have no merge, approval or ready operation.')


def merge_is_human(body: str) -> str:
    """``body`` ending with ``MERGE_IS_HUMAN`` on its own line, once (a body that already ends with it, an update's
    say, is kept as it is): trusted text the broker adds after the write rules read what the agent wrote."""
    kept = body.rstrip()
    if kept.endswith(MERGE_IS_HUMAN):
        return kept
    return f'{kept}\n\n---\n{MERGE_IS_HUMAN}'


#: The two kinds of triage label (``outputs.TRIAGE_LABELS``): at most one of each on a call.
_LABEL_KINDS: Final = ('voc-triage/', 'voc-severity/')


def _triage_labels(labels: tuple[str, ...]) -> tuple[str, ...]:
    """``labels`` when they are one or two of ``TRIAGE_LABELS``, at most one of each kind (``WriteRefused``
    otherwise), in the order asked, each once."""
    asked = tuple(dict.fromkeys(labels))
    if not asked or len(asked) > len(_LABEL_KINDS) or any(label not in TRIAGE_LABELS for label in asked):
        raise WriteRefused('An agent puts only the triage labels on its issue: one voc-triage/<kind> and one '
                           'voc-severity/s<n> at most (' + ', '.join(sorted(TRIAGE_LABELS)) + ').')
    if any(sum(label.startswith(kind) for label in asked) > 1 for kind in _LABEL_KINDS):
        raise WriteRefused('An issue gets one triage kind and one severity: not two of either.')
    return asked


def _listed(value: object) -> list[object]:
    return value if isinstance(value, list) else []


#: Why a pull request the host answered with is not kept on the run's record (logged, never said to the agent: the
#: write was made).
_NOT_OURS: Final = 'not the run\'s own (another repository, host, address or branch)'
_ANOTHER: Final = 'the run\'s record names a pull request on another branch, which is never repointed'
_UNRECORDED: Final = 'the record could not be written; it is read back from the write claim until it is'
#: Counted (namespace ``VoC``, the broker's service) at each record the broker could not write.
PULL_REQUEST_UNRECORDED_METRIC: Final = 'EngineeringPullRequestUnrecorded'


def _keep_pull_request(connector: Connector, caller: Caller, run: RunRecord, branch: str,
                       ref: PullRequestRef) -> None:
    """Keep the pull request the host answered with on the run's record (``run_links.py``): only when it is the run's
    own (its repository on its host's own domain, from the run's ``branch``), keyed on that branch
    (``WriteClaims.record_pull_request``). Never raises: the write was made, and its answer is the agent's whatever
    becomes of the record; one that cannot be written is logged and counted (``PULL_REQUEST_UNRECORDED_METRIC``), and
    the readers take it from the write's done claim meanwhile."""
    link = pull_request_link(ref.host, run.repository, ref.number, ref.url, ref.head, ref.base)
    why = ''
    if link is None or link.head != branch:
        why = _NOT_OURS
    else:
        try:
            why = '' if connector.writes.record_pull_request(caller.run_id, link) else _ANOTHER
        except Unavailable:
            why = _UNRECORDED
            metrics.add_metric(name=PULL_REQUEST_UNRECORDED_METRIC, unit='Count', value=1)
    if why:
        logger.warning('broker pull request not recorded', extra={'run_id': caller.run_id, 'number': ref.number,
                                                                  'why': why})


def _token_writes(connector: Connector) -> TokenWrites:
    """The connector's writes with a fine-grained connection's token (``_write_token`` checked it is wired)."""
    if connector.token_writes is None:
        raise NoConnection(NO_CONNECTION)
    return connector.token_writes


def _pull_request(done: Mapping[str, object]) -> PullRequestRef:
    number = done['number']
    return PullRequestRef(number=number if isinstance(number, int) else 0, url=str(done['url']))


def _repeated(caller: Caller, operation: str, key: str) -> None:
    logger.info('broker write repeated', extra={'operation': operation, 'run_id': caller.run_id,
                                                 'agent': caller.agent_index, 'key': key})


@dataclass(frozen=True)
class Labelled:
    """``label_issue``'s answer: the labels on the run's issue, and (7.71.03) the agent whose call put them when it
    was an earlier one (another understander's, or this agent's before), '' when this call put them."""

    labels: tuple[str, ...]
    set_by: str = ''


def _labelled(done: Mapping[str, object], own: str) -> Labelled:
    """A label write's answer (``done``, its claim's result) for the call whose agent is ``own`` ('' for a repeat
    answered before its write): who put the labels when it was not this call (a result from before 7.71.03 names
    nobody)."""
    labels = tuple(str(label) for label in _listed(done.get('labels')))
    by = str(done.get('by') or '')
    return Labelled(labels, '' if own and by == own else by or 'another agent of the run')


#: A repeat of a write whose first outcome is not known: never made again.
EARLIER_UNKNOWN: Final = ('An earlier call of this write, by this agent at this attempt, has no known outcome, so it is '
                          'not made again: the outcome stays unknown until a person checks the host.')
#: The same for a write made once per run and issue (7.71.02, ``issue_write_key``), whoever made the earlier call,
#: until that call is long over (7.71.03, ``STALE_CLAIM_SECONDS``).
EARLIER_ISSUE_UNKNOWN: Final = ("An earlier call of this write on the run's issue, by an agent of this run, has no "
                                 'known outcome yet, so it is not made now: ask again in a few minutes.')
#: (7.71.03) How long after its claim an issue write whose call never answered (a host error, a crash between its
#: claim and its outcome) may be claimed again: over twice the broker function's 120 s timeout, so that call is over.
STALE_CLAIM_SECONDS: Final = 300
#: What the host refused or never reached: nothing written, so the key may be claimed again (a rate limit included:
#: the host answered it instead of the write, and the broker answers 503 with its Retry-After).
_NOTHING_WRITTEN: Final = (WriteRefused, NoConnection, NotFound, InvalidTarget, HostBusy)


def write_key(caller: Caller, attempt: int, operation: str, *arguments: object) -> str:
    """The key a write is made once for: the caller's agent (its run is the claim's partition), its ``attempt``, the
    operation, and a digest of what is written (``arguments``), so the same write asked again is one write and a
    different one (another comment, a new pull request text) is its own."""
    digest = hashlib.sha256(json.dumps(arguments, separators=(',', ':')).encode()).hexdigest()[:32]
    return f'{agent_id(caller)}#{attempt}#{operation}#{digest}'


def issue_write_key(number: int, operation: str) -> str:
    """The key a write on the run's issue is made once for (7.71.02): the issue and the operation alone (its run is
    the claim's partition), never the agent, its attempt or what it writes, so the run comments on and labels its issue
    once, whichever of its agents asks first."""
    return f'issue#{number}#{operation}'


def issue_marker(run_id: str) -> str:
    """The hidden line every comment of the run on its issue ends with (7.71.03): how a later call finds it on the
    host (``RepositoryHost.issue_comment``) when the call that posted it never heard back."""
    return f'<!-- voc-engineering-run:{run_id} -->'


def _issue_key(key: str) -> bool:
    return key.startswith('issue#')


def _unknown(key: str) -> str:
    """What a repeat of the write at ``key`` whose first outcome is not known is answered."""
    return EARLIER_ISSUE_UNKNOWN if _issue_key(key) else EARLIER_UNKNOWN


#: What an issue write retried after an earlier call with no outcome looks for first (7.71.03): that call's write on
#: the host (its answer, the claim then closed done), None when the host has none.
Made = Callable[[], dict[str, object] | None]


def _once(connector: Connector, caller: Caller, operation: str, key: str,
          write: Callable[[], dict[str, object]], made: Made | None = None) -> dict[str, object]:
    """``write`` (the host call, after every check) once per ``key`` (``write_key``: the caller's run, agent and
    attempt, the operation and what it writes; ``issue_write_key``: the run's issue and the operation). The claim is
    taken before the host call and closed with its outcome: a repeat of a done write answers its first answer, a repeat
    of one whose outcome is unknown is ``OutcomeUnknown`` (and is not made), and only a refusal that wrote nothing lets
    the key be claimed again. ``made`` (7.71.03, a write on the run's issue): an earlier claim with no outcome is taken
    again once ``STALE_CLAIM_SECONDS`` old, and ``made`` looks on the host for what its call wrote before anything is
    written again."""
    return _claimed(connector.writes, caller.run_id, key, operation, write,
                    lambda: _repeated(caller, operation, key), made)


def _claimed(ledger: WriteLedger, partition: str, key: str, operation: str, write: Callable[[], dict[str, object]],
             repeated: Callable[[], None], made: Made | None = None) -> dict[str, object]:
    """``write`` once for ``key`` in ``ledger``'s ``partition`` (a run's writes, ``_once``; a connection's docs,
    ``push_approved_docs``), as ``_once`` says."""
    before = ledger.earlier(partition, key) if made is not None else None
    earlier = ledger.claim(partition, key, operation, STALE_CLAIM_SECONDS if made is not None else None)
    if earlier is not None:
        if earlier.state == WRITE_DONE and earlier.result is not None:
            repeated()
            return earlier.result
        raise OutcomeUnknown(_unknown(key))
    if made is not None and before is not None and before.state != WRITE_REFUSED:
        # (taken again from a call that never answered: what it wrote, if the host has it, is the answer; a look that
        # fails leaves that call's outcome unknown, taken again once stale)
        try:
            found = made()
        except Exception:
            with contextlib.suppress(Unavailable):
                ledger.close(partition, key, WRITE_UNKNOWN)
            raise
        if found is not None:
            with contextlib.suppress(Unavailable):
                ledger.close(partition, key, WRITE_DONE, found)
            return found
    try:
        result = write()
    except _NOTHING_WRITTEN:
        # (unrecorded, the claim stays open: a repeat is answered as unknown, never made twice)
        with contextlib.suppress(Unavailable):
            ledger.close(partition, key, WRITE_REFUSED)
        raise
    except HostError as exc:   # (a host error or a wait the client gave up on: the write may have been made)
        with contextlib.suppress(Unavailable):
            ledger.close(partition, key, WRITE_UNKNOWN)
        raise OutcomeUnknown(f'{exc.reason} Whether the write was made is not known; it is not made again for '
                             'this attempt.') from exc
    try:
        ledger.close(partition, key, WRITE_DONE, result)
    except Unavailable:   # (made: answered as made; a repeat finds the claim open, and is not made again)
        logger.warning('broker write not recorded as done', extra={'operation': operation, 'partition': partition})
    return result
