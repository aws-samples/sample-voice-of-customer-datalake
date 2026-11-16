"""What the broker reads of a run's own record, and its one write there (docs/autonomous-engineering.md, "Repository
connectors").

The broker's writes are a write's claim row, in a partition of the run's writes alone (``WriteClaims``, 7.02.00), and,
in that partition with a claim row's attributes, the run's pull request once the host answered with it (7.09.00,
``WriteClaims.record_pull_request``, ``engineering/run_links.py``). Otherwise reads only, of rows and objects other
code writes; the broker writes none of them:

* the run: ``WS#<ws>#RUN#<run>`` / ``META`` (``runtime/runs.py``), read strongly consistent for the caller's run
  alone (its session names it): its status, connection, commit, the person who started it and its ``repo`` (the
  stored connection's repository at the start, which the broker holds the connection's credential to). A run whose META
  names another run is no run; an active run without a connection is ``NoConnection``. META's ``default_branch``,
  the stored connection's at the start (``connections.py``), is handed on as ``stored_default_branch``; this reads
  nothing of the host: the broker works the run's branch out only after its repository check (``broker.py``).
* the board's GO ledger: the run's ``TASK#`` rows (one Query of its partition). The final-go task that ended last
  (done, failed or needing a person: blocked by a person too) is the run's verdict, whatever its state, and of it
  the gate record its holder recorded last (``_gate/attempt-<n>/record.json`` under the final-go agent's own keys).
  Only a GO of a task that ended done, with no stop, for exactly the tree asked about, is a GO, and only when the
  gate runner task that ended last ended done with a GO record on that same tree (``flow/ledger.py`` ``go_tree``,
  the rule the board and the flow keep too); an older task's passing record never stands in for a newer one that did
  not pass. A record that cannot be read or is off ``voc-gate-record/1`` is no GO: only those two records are read.
* a person's go on the run: ``WS#<ws>#RUN#<run>`` / ``GO#person``, the create-only row an administrator's go writes
  (through the board function, ``board/store.py`` ``person_go``), what an AI-assisted run's push waits for.

* the CI attestation (7.04.00, ``attestations.py``): in voc-agents, the newest version of the run's connection's
  attestation (one Query of one row, projected), read at each push and pull request (``attested``), never for a
  read. It holds only while it is ``attested`` for the repository the run started on (META's ``repo``); a withdrawn
  or voided one, none, or a deployment that names no agents table, is not attested, so the push or pull request is
  refused.

* the run's pull request (7.10.00, ``WriteClaims.pull_request``): for the runtime's reactions read only (its row and
  its author's done claims, ``run_links.run_pull_request``: a GetItem and one bounded Query of the run's writes).

* the run's issue (META's ``issue``, since 7.47.00: ``run_links.issue_of``, its own repository's only): the one issue
  its agents comment on (``issue_number``), and its host, which says how its pull request names it.

Not read: its pull request as the one an agent may comment on (7.09.00: recorded for the run monitor, the reports and
the learning loop, not yet taken as that, so no comment on it is accepted), and the reviews behind its feedback ids
(not recorded yet, so the write rules have no review text to compare: their personal-data checks still run).
"""
from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import replace
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from engineering.board.model import PERSON_PREFIX, Task
from engineering.board.store import PERSON_GO_SK
from engineering.connectors.attestations import attested_version
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
from engineering.run_links import (
    PULL_REQUEST_OP,
    PULL_REQUEST_SK,
    PullRequestLink,
    issue_of,
    merged,
    run_pull_request,
    stored_link,
    writes_pk,
)
from engineering.runtime.runs import PULL_REQUEST_DRAFT
from engineering.workspace.store import WorkspaceStore

_UNREADABLE: Final = "The run's record could not be read; retry."


class RunRecords:
    """The broker's ``RunDirectory`` and ``GateLedger`` over the run's rows (a low-level DynamoDB client), the
    workspace bucket and, for the CI attestation, voc-agents (``agents_table``; '' for none: never attested)."""

    def __init__(self, client: Any, table: str, workspace: WorkspaceStore, agents_table: str = '') -> None:
        self._client = client
        self._table = table
        self._workspace = workspace
        self._agents_table = agents_table

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
        # (7.47.00: the issue the run starts from, its own repository's only: the one issue its agents comment on)
        issue = issue_of(item)
        return RunRecord(
            connection_id=connection, default_branch='', stored_default_branch=string_attr(item, 'default_branch'),
            status=status, ci_attested=False, cited_reviews=(), bot_addresses=(AUTHOR,),
            commit=string_attr(item, 'commit'), started_by=string_attr(item, 'started_by'),
            repository=string_attr(item, 'repo'), issue_number=None if issue is None else issue.number,
            issue_host='' if issue is None else issue.host,
            # (7.50.00: the flow's ``pr``; a run started before it, with no such attribute, opens it ready too)
            draft_pr=string_attr(item, 'pull_request') == PULL_REQUEST_DRAFT)

    def attested(self, run: RunRecord) -> RunRecord:
        if not (self._agents_table and run.connection_id and run.repository):
            return replace(run, ci_attested=False, ci_attestation=0)
        try:
            version = attested_version(self._client, self._agents_table, run.connection_id, run.repository)
        except (ClientError, BotoCoreError) as exc:
            raise Unavailable("The connection's CI attestation could not be read; retry.") from exc
        return replace(run, ci_attested=version > 0, ci_attestation=version)

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
#: The partition (``run_links.writes_pk``) holds the run's pull request too (``record_pull_request``).
WRITE_PREFIX: Final = 'WRITE#'


class WriteClaims:
    """The broker's ``WriteLedger``: one create-only claim row per write key in the run's writes' partition, the
    broker's only write, taken before the host call and closed with its outcome. A row's attributes are ``pk``,
    ``sk``, ``state``, ``op``, ``at``, ``result`` and ``closed_at``, and the broker's IAM grant allows those alone
    (engineering-broker.ts ``BROKER_CLAIM_ATTRIBUTES``). A claim is taken again only after a refusal (nothing
    was written); a done write's row keeps its answer (a number, a URL, a branch and tree: never a body), so a repeat
    is answered with it. The run's pull request row (``record_pull_request``) has the same attributes."""

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

    def record_pull_request(self, run_id: str, link: PullRequestLink) -> bool:
        """Keep ``link`` as the run's pull request, keyed on its head (``run_links.merged``): none recorded, or one on
        the same head (the same number: its base and URL updated; a new one: it replaces it, the earlier kept in
        ``superseded``), True; one on another head, False, the row unchanged. Read, then written on the condition
        that the row is still what was read (none, or its exact ``result``), tried again when it moved meanwhile
        (``PULL_REQUEST_TRIES``). ``at`` is when it was first recorded, ``closed_at`` when last written. A claim row's
        attributes only (``op``, ``at``, ``closed_at``, ``result``)."""
        key = {'pk': {'S': writes_pk(WORKSPACE, run_id)}, 'sk': {'S': PULL_REQUEST_SK}}
        for _ in range(PULL_REQUEST_TRIES):
            item = self._pull_request_row(key)
            earlier = '' if item is None else string_attr(item, 'result')
            current = stored_link(earlier) if item is not None else None
            becomes = merged(current, link)
            if becomes is None:
                return False
            if becomes.result() == earlier:
                return True
            if self._write_pull_request(key, becomes, None if item is None else earlier):
                return True
        raise Unavailable(_NOT_RECORDED)

    def pull_request(self, run_id: str, repository: str) -> PullRequestLink | None:
        """The run's recorded pull request (``run_links.run_pull_request``), for the reactions read (7.10.00): its row,
        else its newest done write claim, only when it is ``repository``'s own; ``Unavailable`` when it cannot be
        read."""
        try:
            return run_pull_request(self._client, self._table, WORKSPACE, run_id, repository)
        except (ClientError, BotoCoreError) as exc:
            raise Unavailable(_UNREADABLE) from exc

    def _pull_request_row(self, key: dict[str, Any]) -> dict[str, Any] | None:
        try:
            return get_row(self._client, self._table, key)
        except (ClientError, BotoCoreError) as exc:
            raise Unavailable(_NOT_RECORDED) from exc

    def _write_pull_request(self, key: dict[str, Any], link: PullRequestLink, earlier: str | None) -> bool:
        """Write ``link`` while the row is still ``earlier`` (None: no row); False when it moved meanwhile."""
        values: dict[str, Any] = {':result': {'S': link.result()}, ':op': {'S': PULL_REQUEST_OP},
                                  ':now': {'N': str(int(self._clock()))}}
        if earlier is not None:
            values[':earlier'] = {'S': earlier}
        try:
            self._client.update_item(
                TableName=self._table, Key=key,
                UpdateExpression='SET #result = :result, #op = :op, #at = if_not_exists(#at, :now), closed_at = :now',
                ConditionExpression='attribute_not_exists(pk)' if earlier is None else '#result = :earlier',
                ExpressionAttributeNames={'#result': 'result', '#op': 'op', '#at': 'at'},
                ExpressionAttributeValues=values)
        except ClientError as exc:
            if exc.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
                return False
            raise Unavailable(_NOT_RECORDED) from exc
        except BotoCoreError as exc:
            raise Unavailable(_NOT_RECORDED) from exc
        return True


_NOT_RECORDED: Final = "The run's pull request could not be recorded."
#: How many times a record of the run's pull request is read and written when another write moved it meanwhile.
PULL_REQUEST_TRIES: Final = 3
