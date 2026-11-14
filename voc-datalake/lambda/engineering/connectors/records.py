"""What the broker reads of a run's own record, and its one write there (docs/autonomous-engineering.md, "Repository
connectors").

The broker's one write is a write's claim row, in a partition of the run's writes alone (``WriteClaims``, 6.30.00). Otherwise reads only, of rows and objects
other code writes; the broker writes none of them:

* the run: ``WS#<ws>#RUN#<run>`` / ``META`` (``runtime/runs.py``), read strongly consistent for the caller's run
  alone (its session names it): its status, connection, commit and the person who started it. A run whose META
  names another run is no run; an active run without a connection is ``NoConnection``. The connection's default
  branch comes from the host.
* the board's GO ledger: the run's ``TASK#`` rows (one Query of its partition). The final-go task that ended last
  (done, failed or needing a person: blocked by a person too) is the run's verdict, whatever its state, and of it
  the gate record its holder recorded last (``_gate/attempt-<n>/record.json`` under the final-go agent's own keys).
  Only a GO of a task that ended done, with no stop, for exactly the tree asked about, is a GO, and only when the
  gate runner task that ended last ended done with a GO record on that same tree (``flow/ledger.py`` ``go_tree``,
  the rule the board and the flow keep too); an older task's passing record never stands in for a newer one that did
  not pass. A record that cannot be read or is off ``voc-gate-record/1`` is no GO: only those two records are read.
* a person's go on the run: ``WS#<ws>#RUN#<run>`` / ``GO#person``, the create-only row an administrator's go writes
  (through the board function, ``board/store.py`` ``person_go``), what an AI-assisted run's push waits for.

Not recorded yet, so not read: the CI attestation (every run reads as not attested, so every push and pull request
is still refused), the run's issue and pull request (so no comment is accepted) and the reviews behind its feedback
ids (so the write rules have no review text to compare: their personal-data checks still run).
"""
from __future__ import annotations

import json
import time
from collections.abc import Callable
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from engineering.board.model import PERSON_PREFIX, Task
from engineering.board.store import PERSON_GO_SK
from engineering.connectors.hosts import (
    ACTIVE,
    NO_CONNECTION,
    WRITE_CLAIMED,
    WRITE_REFUSED,
    NoConnection,
    RunRecord,
    Unavailable,
    WriteClaim,
)
from engineering.connectors.identity import WORKSPACE
from engineering.connectors.patches import AUTHOR
from engineering.flow.ledger import go_tree, read_gate_record
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

    def _go_tree(self, run_id: str) -> str:
        """The tree the run's GO stands for ('' for none): the GO ledger's own rule (``flow/ledger.py`` ``go_tree``:
        the newest ended final go's GO, after the newest ended gate runner's GO on the same tree)."""
        try:
            rows = run_rows(self._client, self._table, WORKSPACE, run_id, 'TASK#')
        except (ClientError, BotoCoreError) as exc:
            raise Unavailable(_UNREADABLE) from exc
        decided = go_tree(map(Task.from_item, rows), WORKSPACE, run_id, self._record)
        return '' if decided is None else decided[1]

    def _record(self, key: str) -> GateRecord | None:
        try:
            return read_gate_record(self._workspace, key)
        except (ClientError, BotoCoreError) as exc:
            raise Unavailable(_UNREADABLE) from exc

    def has_go(self, run_id: str, tree_hash: str) -> bool:
        return bool(tree_hash) and self._go_tree(run_id) == tree_hash


#: A write's claim row, in a partition of the run's writes alone (``writes_pk``), so the broker's write grant reaches no
#: other row of the run: ``WS#<ws>#WRITES#<run>`` / ``WRITE#<agent>#<attempt>#<operation>#<digest>``.
WRITE_PREFIX: Final = 'WRITE#'


def writes_pk(ws: str, run_id: str) -> str:
    """The partition of a run's write claims (beside, never inside, the run's own ``WS#<ws>#RUN#<run>``)."""
    return f'WS#{ws}#WRITES#{run_id}'


class WriteClaims:
    """The broker's ``WriteLedger``: one create-only claim row per write key in the run's writes' partition, the
    broker's only write, taken before the host call and closed with its outcome. A row's attributes are ``pk``,
    ``sk``, ``state``, ``op``, ``at``, ``result`` and ``closed_at``, and the broker's IAM grant allows those alone
    (engineering-broker.ts ``BROKER_CLAIM_ATTRIBUTES``). A claim is taken again only after a refusal (nothing
    was written); a done write's row keeps its answer (a number, a URL, a branch and tree: never a body), so a repeat
    is answered with it."""

    def __init__(self, client: Any, table: str, clock: Callable[[], float] = time.time) -> None:
        self._client = client
        self._table = table
        self._clock = clock

    def _key(self, run_id: str, key: str) -> dict[str, Any]:
        return {'pk': {'S': writes_pk(WORKSPACE, run_id)}, 'sk': {'S': f'{WRITE_PREFIX}{key}'}}

    def claim(self, run_id: str, key: str, operation: str) -> WriteClaim | None:
        try:
            self._client.put_item(
                TableName=self._table,
                Item={**self._key(run_id, key), 'state': {'S': WRITE_CLAIMED}, 'op': {'S': operation},
                      'at': {'N': str(int(self._clock()))}},
                ConditionExpression='attribute_not_exists(pk) OR #state = :refused',
                ExpressionAttributeNames={'#state': 'state'},
                ExpressionAttributeValues={':refused': {'S': WRITE_REFUSED}})
        except ClientError as exc:
            if exc.response.get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
                raise Unavailable(_UNREADABLE) from exc
        except BotoCoreError as exc:
            raise Unavailable(_UNREADABLE) from exc
        else:
            return None
        found = self.earlier(run_id, key)
        if found is None:
            raise Unavailable(_UNREADABLE)
        return found

    def earlier(self, run_id: str, key: str) -> WriteClaim | None:
        item = self._row(run_id, key)
        if item is None:
            return None
        raw = string_attr(item, 'result')
        result = json.loads(raw) if raw else None
        return WriteClaim(state=string_attr(item, 'state'), result=result if isinstance(result, dict) else None)

    def _row(self, run_id: str, key: str) -> dict[str, Any] | None:
        try:
            return get_row(self._client, self._table, self._key(run_id, key))
        except (ClientError, BotoCoreError) as exc:
            raise Unavailable(_UNREADABLE) from exc

    def close(self, run_id: str, key: str, state: str, result: dict[str, object] | None = None) -> None:
        values: dict[str, Any] = {':state': {'S': state}, ':claimed': {'S': WRITE_CLAIMED},
                                  ':at': {'N': str(int(self._clock()))}}
        expression = 'SET #state = :state, closed_at = :at'
        if result is not None:
            values[':result'] = {'S': json.dumps(result, sort_keys=True)}
            expression += ', #result = :result'
        try:
            self._client.update_item(
                TableName=self._table, Key=self._key(run_id, key), UpdateExpression=expression,
                ConditionExpression='#state = :claimed', ExpressionAttributeValues=values,
                ExpressionAttributeNames={'#state': 'state', **({'#result': 'result'} if result is not None else {})})
        except (ClientError, BotoCoreError) as exc:
            raise Unavailable("The write's outcome could not be recorded.") from exc
