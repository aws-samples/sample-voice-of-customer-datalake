"""What the broker reads of a run's own record (docs/autonomous-engineering.md, "Repository connectors").

Reads only, of rows and objects other code writes; the broker writes none of them:

* the run: ``WS#<ws>#RUN#<run>`` / ``META`` (``runtime/runs.py``), read strongly consistent for the caller's run
  alone (its session names it): its status, connection, commit and the person who started it. A run whose META
  names another run is no run; an active run without a connection is ``NoConnection``. The connection's default
  branch comes from the host.
* the board's GO ledger: the run's ``TASK#`` rows (one Query of its partition). The final-go task that ended last
  (done, failed or needing a person: blocked by a person too) is the run's verdict, whatever its state, and of it
  the gate record its holder recorded last (``_gate/attempt-<n>/record.json`` under the final-go agent's own keys).
  Only a GO of a task that ended done, with no stop, for exactly the tree asked about, is a GO; an older task's
  passing record never stands in for a newer one that did not pass. A record that cannot be read
  or is off ``voc-gate-record/1`` is no GO: only that one record is read.
* a person's go on the run: ``WS#<ws>#RUN#<run>`` / ``GO#person``, the create-only row an administrator's go writes
  (through the board function, ``board/store.py`` ``person_go``), what an AI-assisted run's push waits for.

Not recorded yet, so not read: the CI attestation (every run reads as not attested, so every push and pull request
is still refused), the run's issue and pull request (so no comment is accepted) and the reviews behind its feedback
ids (so the write rules have no review text to compare: their personal-data checks still run).
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from engineering.board.model import DONE, PERSON_PREFIX, Task
from engineering.board.store import PERSON_GO_SK
from engineering.connectors.hosts import ACTIVE, NO_CONNECTION, NoConnection, RunRecord, Unavailable
from engineering.connectors.identity import WORKSPACE
from engineering.connectors.patches import AUTHOR
from engineering.flow.ledger import is_go, newest_final_go, read_gate_record
from engineering.quality_gate.record import GateRecord
from engineering.rows import get_row, run_pk, run_rows, string_attr
from engineering.workspace.store import WorkspaceStore

_UNREADABLE: Final = "The run's record could not be read; retry."


class RunRecords:
    """The broker's ``RunDirectory`` and ``GateLedger`` over the run's rows (a low-level DynamoDB client) and the
    workspace bucket; ``default_branch`` is the host's (``RepositoryHost.default_branch``)."""

    def __init__(self, client: Any, table: str, workspace: WorkspaceStore,
                 default_branch: Callable[[str], str]) -> None:
        self._client = client
        self._table = table
        self._workspace = workspace
        self._default_branch = default_branch

    def _row(self, run_id: str, sk: str) -> dict[str, Any] | None:
        try:
            return get_row(self._client, self._table, {'pk': {'S': run_pk(WORKSPACE, run_id)}, 'sk': {'S': sk}})
        except (ClientError, BotoCoreError) as exc:
            raise Unavailable(_UNREADABLE) from exc

    def run(self, run_id: str) -> RunRecord | None:
        item = self._row(run_id, 'META')
        if item is None or string_attr(item, 'run_id') != run_id:
            return None
        status, connection = string_attr(item, 'status'), string_attr(item, 'connection')
        if status == ACTIVE and not connection:
            raise NoConnection(NO_CONNECTION)
        return RunRecord(
            connection_id=connection, default_branch=self._default_branch(connection) if status == ACTIVE else '',
            status=status, ci_attested=False, cited_reviews=(), bot_addresses=(AUTHOR,),
            commit=string_attr(item, 'commit'), started_by=string_attr(item, 'started_by'))

    def person_go(self, run_id: str) -> bool:
        item = self._row(run_id, PERSON_GO_SK)
        return item is not None and string_attr(item, 'by').startswith(PERSON_PREFIX)

    def _final_go(self, run_id: str) -> tuple[str, str] | None:
        """The run's latest final-go verdict: the newest ended final-go task's state and its gate record's key ('' for
        none), or None when no final-go task has ended (the GO ledger's own rule, ``flow/ledger.py``)."""
        try:
            rows = run_rows(self._client, self._table, WORKSPACE, run_id, 'TASK#')
        except (ClientError, BotoCoreError) as exc:
            raise Unavailable(_UNREADABLE) from exc
        latest = newest_final_go(map(Task.from_item, rows), WORKSPACE, run_id)
        return None if latest is None else (latest[0].state, latest[1])

    def _record(self, key: str) -> GateRecord | None:
        try:
            return read_gate_record(self._workspace, key)
        except (ClientError, BotoCoreError) as exc:
            raise Unavailable(_UNREADABLE) from exc

    def has_go(self, run_id: str, tree_hash: str) -> bool:
        latest = self._final_go(run_id)
        if latest is None or latest[0] != DONE or not latest[1]:
            return False
        record = self._record(latest[1])
        return is_go(record) and record is not None and bool(tree_hash) and record.tree_hash == tree_hash
