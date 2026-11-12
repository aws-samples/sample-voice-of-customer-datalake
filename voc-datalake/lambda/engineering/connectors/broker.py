"""The connector's broker: the typed operations each agent role may ask for (docs/autonomous-engineering.md).

Every operation checks, in order: the caller's role may make it; the deployment has a connection; the run (from
the caller's session, never the request) is one the broker knows and is not stopped; then the write rules
(``write_policy``); and only then calls the host. A refusal raises ``WriteRefused`` (``NotPermitted`` for the
role, ``NotNow`` for the run's or the board's state) with a plain reason for the run journal.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Final

from engineering.connectors.hosts import (
    NO_CONNECTION,
    CommentTarget,
    Connector,
    NoConnection,
    PullRequestRef,
    ReadKind,
    ReadPage,
    RunRecord,
)
from engineering.connectors.identity import AGENT_ROLES, Caller
from engineering.connectors.write_policy import (
    WriteRefused,
    branch_refusal,
    check_commit_identities,
    check_commit_message,
    check_heads,
    check_push,
    check_text,
)

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


class NotPermitted(WriteRefused):
    """The caller's role may not make this operation."""


class NotNow(WriteRefused):
    """The run or the board does not allow the operation now (an unknown or stopped run, no GO, no attestation)."""


def permitted(role: str, operation: str) -> bool:
    """Whether an agent of ``role`` may make ``operation``."""
    return role in AGENT_ROLES and (operation == READ or _WRITES.get(role) == operation)


def _require_attestation(run: RunRecord) -> None:
    if not run.ci_attested:
        raise NotNow("An administrator has not yet confirmed the repository's CI settings for agent branches.")


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
        if run.stopped:
            raise NotNow('The run is stopped; the broker refuses its operations.')
        return self._connector, run

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
        return connector.host.post_comment(run.connection_id, on, number, body)

    def push_bundle(self, caller: Caller, branch: str, bundle: bytes) -> str:
        """Push a git bundle to one of the run's branches; the pushed tree's hash."""
        connector, run = self._open(caller, PUSH_BUNDLE)
        _require_attestation(run)
        contents = connector.bundles.contents(bundle)
        check_heads(contents.heads)
        check_push(branch, run.default_branch, caller.run_id, contents.changed_paths)
        for commit in contents.commits:
            check_commit_identities(commit.author, commit.committer, run.bot_addresses)
            check_commit_message(commit.message, run.cited_reviews, run.bot_addresses)
        check_text('\n'.join(contents.added_lines), run.cited_reviews, prose=False)
        if connector.host.open_pull_request(run.connection_id, branch) is not None \
                and not connector.ledger.has_go(caller.run_id, contents.tree_hash):
            raise NotNow('The branch has an open pull request, and the board holds no GO for this tree.')
        connector.host.push_bundle(run.connection_id, branch, bundle, contents.tree_hash)
        return contents.tree_hash

    def open_or_update_draft_pr(self, caller: Caller, branch: str, title: str, body: str) -> PullRequestRef:
        """Open the run's draft pull request from ``branch`` to the default branch, or update its text."""
        connector, run = self._open(caller, OPEN_OR_UPDATE_DRAFT_PR)
        _require_attestation(run)
        refusal = branch_refusal(branch, run.default_branch, caller.run_id)
        if refusal is not None:
            raise WriteRefused(refusal.message)
        check_text(f'{title}\n\n{body}', run.cited_reviews, prose=True)
        tree_hash = connector.host.branch_tree_hash(run.connection_id, branch)
        if tree_hash is None:
            raise NotNow('The branch is not on the host yet; push it first.')
        if not connector.ledger.has_go(caller.run_id, tree_hash):
            raise NotNow("The board holds no GO for the branch's tree.")
        return connector.host.open_or_update_draft_pr(run.connection_id, branch, run.default_branch, title, body,
                                                      tree_hash)
