"""The connector's broker: the typed operations each agent role may ask for (docs/autonomous-engineering.md).

Every operation checks, in order: the caller's role may make it; the deployment has a connection; the run (from
the caller's session, never the request) is one the broker knows and is active; for a push or a pull request, the
dial (the way of working of the person who started the run, ``shared/ai_mode.py``: Human-driven pushes nothing,
AI-assisted waits for a person's go on the run, AI-driven goes on; failing closed, ``dial.py``: only an explicitly
stored AI-assisted or AI-driven allows anything, so a person with no saved way of working, a stored mode outside
the modes, or a run that names no person pushes nothing), the CI attestation and the board's final-go GO
for exactly the tree it is about to write; then the write rules (``write_policy``); and only then calls the host. A
refusal raises ``WriteRefused`` (``NotPermitted`` for the role, ``NotNow`` for the run's, the dial's or the board's
state) with a plain reason for the run journal.

A pull request is always a draft: the host opens one as a draft, an update changes only its title and body, and
there is no operation that marks one ready or merges it, in any mode.

Every write the host accepts gets an operational log line: the operation, the caller, and what was written (the
issue or pull request number, the branch, the tree hash), never a body, a patch or a credential. It is not the
audit record: the durable row of who wrote what comes with the run records.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Final

from engineering.connectors.hosts import (
    ACTIVE,
    NO_CONNECTION,
    CommentTarget,
    Connector,
    NoConnection,
    PullRequestRef,
    ReadKind,
    ReadPage,
    RunRecord,
    Submission,
)
from engineering.connectors.identity import AGENT_ROLES, Caller, agent_id
from engineering.connectors.write_policy import (
    WriteRefused,
    branch_refusal,
    check_commit_identities,
    check_commit_message,
    check_heads,
    check_paths,
    check_text,
)
from shared.ai_mode import MODE_AI_ASSISTED, MODE_AI_DRIVEN
from shared.logging import logger

READ: Final = 'read'
POST_COMMENT: Final = 'post_comment'
PUSH_BUNDLE: Final = 'push_bundle'
OPEN_OR_UPDATE_DRAFT_PR: Final = 'open_or_update_draft_pr'
#: Beyond reading, which every agent may do: the one write each writing role needs, and no other.
_WRITES: Final[Mapping[str, str]] = {
    'understander': POST_COMMENT,
    'pr-reviewer': POST_COMMENT,
    'committer': PUSH_BUNDLE,
    'pr-author': OPEN_OR_UPDATE_DRAFT_PR,
}
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


class NotPermitted(WriteRefused):
    """The caller's role may not make this operation."""


class NotNow(WriteRefused):
    """The run, the dial or the board does not allow the operation now (an unknown or inactive run, Human-driven,
    no person's go, no GO, no attestation)."""


def permitted(role: str, operation: str) -> bool:
    """Whether an agent of ``role`` may make ``operation``."""
    return role in AGENT_ROLES and (operation == READ or _WRITES.get(role) == operation)


def _require_attestation(run: RunRecord) -> None:
    if not run.ci_attested:
        raise NotNow("An administrator has not yet confirmed the repository's CI settings for agent branches.")


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


def _require_branch(branch: str, run: RunRecord, run_id: str) -> None:
    refusal = branch_refusal(branch, run.default_branch, run_id)
    if refusal is not None:
        raise WriteRefused(refusal.message)


def _wrote(caller: Caller, operation: str, run: RunRecord, **written: object) -> None:
    """The log line of a write the host accepted: who, on which connection, and what (never the text)."""
    logger.info('broker wrote', extra={'operation': operation, 'role': caller.role, 'run_id': caller.run_id,
                                       'agent': caller.agent_index, 'connection_id': run.connection_id, **written})


class Broker:
    """The operations, over a configured ``Connector`` (``None``: no connection, every operation refused)."""

    def __init__(self, connector: Connector | None) -> None:
        self._connector = connector

    def _open(self, caller: Caller, operation: str) -> tuple[Connector, RunRecord]:
        if not permitted(caller.role, operation):
            raise NotPermitted(f'The {caller.role} role may not {operation.replace("_", " ")}.')
        if self._connector is None:
            raise NoConnection(NO_CONNECTION)
        run = self._connector.runs.run(caller.run_id)
        if run is None:
            raise NotNow('The run is not one the broker knows.')
        if run.status != ACTIVE:
            raise NotNow(_NOT_ACTIVE.get(run.status, _ENDED))
        return self._connector, run

    def _open_write(self, caller: Caller, operation: str, branch: str) -> tuple[Connector, RunRecord]:
        """A push's or a pull request's checks before its own: the run, the dial, the CI attestation, the branch."""
        connector, run = self._open(caller, operation)
        _require_dial(connector, run, caller.run_id)
        _require_attestation(run)
        _require_branch(branch, run, caller.run_id)
        return connector, run

    def read(self, caller: Caller, kind: ReadKind, target: str, cursor: str | None) -> ReadPage:
        connector, run = self._open(caller, READ)
        return connector.host.read(run.connection_id, kind, target, cursor)

    def post_comment(self, caller: Caller, on: CommentTarget, number: int, body: str) -> str:
        """Post ``body`` on the run's own issue or pull request; the comment's URL."""
        connector, run = self._open(caller, POST_COMMENT)
        own = run.issue_number if on == 'issue' else run.pull_request_number
        if own is None or number != own:
            raise NotPermitted(f"An agent comments only on its own run's {on.replace('_', ' ')}.")
        check_text(body, run.cited_reviews, prose=True)
        url = connector.host.post_comment(run.connection_id, on, number, body)
        _wrote(caller, POST_COMMENT, run, on=on, number=number)
        return url

    def push_bundle(self, caller: Caller, branch: str, patch: str, tree_hash: str, message: str) -> str:
        """Push the caller's submitted ``patch`` (its key in the workspace) as one commit with ``message`` to one of
        the run's branches, for the tree the board's GO names; the pushed tree's hash. The host moves the branch only
        when the tree it rebuilt from the patch is ``tree_hash``."""
        connector, run = self._open_write(caller, PUSH_BUNDLE, branch)
        if not connector.ledger.has_go(caller.run_id, tree_hash):
            raise NotNow("The board holds no final-go GO for this tree: the quality gate's final go passes on it "
                         'first.')
        contents = connector.bundles.contents(Submission(
            run_id=caller.run_id, agent_id=agent_id(caller), run=run, key=patch, branch=branch, tree_hash=tree_hash,
            message=message))
        check_heads(contents.heads)
        check_paths(contents.changed_paths)   # (the branch was judged in _open_write, before anything was read)
        for commit in contents.commits:
            check_commit_identities(commit.author, commit.committer, run.bot_addresses)
            check_commit_message(commit.message, run.cited_reviews, run.bot_addresses)
        check_text('\n'.join(contents.added_lines), run.cited_reviews, prose=False)
        connector.host.push_bundle(run.connection_id, branch, contents, tree_hash, run.default_branch)
        _wrote(caller, PUSH_BUNDLE, run, branch=branch, tree_hash=tree_hash, commits=len(contents.commits))
        return tree_hash

    def open_or_update_draft_pr(self, caller: Caller, branch: str, title: str, body: str) -> PullRequestRef:
        """Open the run's draft pull request from ``branch`` to the default branch, or update its text."""
        connector, run = self._open_write(caller, OPEN_OR_UPDATE_DRAFT_PR, branch)
        check_text(f'{title}\n\n{body}', run.cited_reviews, prose=True)
        tree_hash = connector.host.branch_tree_hash(run.connection_id, branch)
        if tree_hash is None:
            raise NotNow('The branch is not on the host yet; push it first.')
        if not connector.ledger.has_go(caller.run_id, tree_hash):
            raise NotNow("The board holds no GO for the branch's tree.")
        ref = connector.host.open_or_update_draft_pr(run.connection_id, branch, run.default_branch, title, body,
                                                     tree_hash)
        _wrote(caller, OPEN_OR_UPDATE_DRAFT_PR, run, branch=branch, tree_hash=tree_hash, number=ref.number)
        return ref
