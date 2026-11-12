"""A run's start and end in the ``voc-engineering`` table, and the registry of the runs the supervisor watches.

``WS#<ws>#RUN#<run>`` / ``META`` is the run's own row: the board counts its tasks on it (``task_count``, under
the run's ``max_tasks``), the inbox router numbers its conversation on it (``msg_seq``), the delivery function
numbers its inbox on it (``inbox_seq``, ``delivery.py``), the reports read its
goal, repository, flow, status and times, and the supervisor its caps and its start. The run's start writes it,
once; its end sets its status and end time. Nothing else here ever writes over the board's, the router's or the
inbox's counters: after the first write every change is an update of this module's own attributes.

``WS#<ws>#RUNS`` holds one row per run the supervisor still watches (``RUN#<run>``), written in the same
transaction as the run's ``META`` (the table has no index, so this is how the supervisor lists them). A run's end
does not remove it: the run stays listed until none of its agents is live (``release``), so the supervisor ends
every MicroVM of an ended run, even when the end's caller died halfway. Whether any run is listed is what
switches the supervisor's schedule.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final

from botocore.exceptions import ClientError

from engineering.connectors.identity import WORKSPACE
from engineering.runtime.checkout import COMMIT_RE
from engineering.runtime.interface import RuntimeRefused, check_id, check_run_id
from engineering.runtime.ports import Budget
from shared.aws import consistent_item, is_conditional_check_failure
from shared.dynamo_paging import iter_query
from shared.ids import is_key_collision

#: How a run ends (``active`` and ``needs_human`` are its live statuses).
ENDED: Final = frozenset({'done', 'failed', 'stopped'})
MAX_TEXT: Final = 500
MAX_TASKS_LIMIT: Final = 10_000


def run_pk(run_id: str) -> str:
    """The run's partition, as the board and the router key it (``WS#<ws>#RUN#<run>``)."""
    return f'WS#{WORKSPACE}#RUN#{check_run_id(run_id)}'


def meta_key(run_id: str) -> dict[str, str]:
    return {'pk': run_pk(run_id), 'sk': 'META'}


def _registry_key(run_id: str) -> dict[str, str]:
    return {'pk': f'WS#{WORKSPACE}#RUNS', 'sk': f'RUN#{check_run_id(run_id)}'}


@dataclass(frozen=True)
class RunCaps:
    """What a person set for the run: its task cap (the board's), and its hard caps on model use."""

    max_tasks: int
    max_tokens: int | None = None
    max_cost_usd: float | None = None

    def __post_init__(self) -> None:
        if not 0 < self.max_tasks <= MAX_TASKS_LIMIT:
            raise RuntimeRefused(f'max_tasks is 1-{MAX_TASKS_LIMIT}')
        if self.max_tokens is not None and self.max_tokens <= 0:
            raise RuntimeRefused('max_tokens is a positive whole number')
        # NaN compares false with everything: a cap of NaN would never trip.
        if self.max_cost_usd is not None and not (math.isfinite(self.max_cost_usd) and self.max_cost_usd > 0):
            raise RuntimeRefused('max_cost_usd is a positive amount')


@dataclass(frozen=True)
class Run:
    run_id: str
    status: str
    started_at: int
    caps: RunCaps
    #: The run's repository connection and its base commit (the board launches the run's agents on them).
    connection: str = ''
    commit: str = ''


class RunExists(RuntimeRefused):
    """The run was started already."""


class RunNotActive(RuntimeRefused):
    """The run is not active (never started, or ended)."""


def _iso(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, UTC).isoformat().replace('+00:00', 'Z')


def _text(value: str) -> str:
    return value[:MAX_TEXT]


class RunStore:
    def __init__(self, table: Any) -> None:
        self._table = table

    def start(self, run_id: str, *, caps: RunCaps, now: int, goal: str = '', repo: str = '', flow: str = '',
              connection: str = '', commit: str = '') -> None:
        """Write the run's ``META`` and list it for the supervisor; ``RunExists`` when it was started already.

        ``connection`` and ``commit`` (a full object id), when given, are what the board's ``launch`` op starts the
        run's agents on: read from here, never from the agent asking."""
        if connection:
            check_id('connection', connection)
        if commit and not COMMIT_RE.match(commit):
            raise RuntimeRefused('a commit is a full hexadecimal object id')
        name = self._table.name
        meta: dict[str, Any] = {**meta_key(run_id), 'run_id': run_id, 'status': 'active', 'started_at': _iso(now),
                                'started_epoch': now, 'max_tasks': caps.max_tasks, 'goal': _text(goal),
                                'repo': _text(repo), 'flow': _text(flow), 'connection': connection, 'commit': commit}
        if caps.max_tokens is not None:
            meta['max_tokens'] = caps.max_tokens
        if caps.max_cost_usd is not None:
            meta['max_cost_usd'] = str(caps.max_cost_usd)
        try:
            self._table.meta.client.transact_write_items(TransactItems=[
                {'Put': {'TableName': name, 'Item': meta, 'ConditionExpression': 'attribute_not_exists(pk)'}},
                {'Put': {'TableName': name, 'Item': {**_registry_key(run_id), 'run_id': run_id}}},
            ])
        except ClientError as error:
            if is_key_collision(error, put_index=0):
                raise RunExists(f'run {run_id} was started already') from error
            raise

    def _update_status(self, run_id: str, expression: str, condition: str, values: dict[str, Any]) -> None:
        try:
            self._table.update_item(Key=meta_key(run_id), UpdateExpression=expression, ConditionExpression=condition,
                                    ExpressionAttributeNames={'#status': 'status'},
                                    ExpressionAttributeValues={**values, ':human': 'needs_human'})
        except ClientError as error:
            if is_conditional_check_failure(error):
                raise RunNotActive(f'run {run_id} is not active') from error
            raise

    def end(self, run_id: str, status: str, *, now: int) -> None:
        """End a live run with ``status`` (it stays listed until ``release``); ``RunNotActive`` when it is not live."""
        if status not in ENDED:
            raise RuntimeRefused(f'a run ends as one of {sorted(ENDED)}')
        self._update_status(run_id, 'SET #status = :status, ended_at = :ended', '#status IN (:active, :human)',
                            {':status': status, ':ended': _iso(now), ':active': 'active'})

    def needs_human(self, run_id: str, reason: str) -> None:
        """The run waits at a human decision point (its agents are held, and none is launched, meanwhile)."""
        self._update_status(run_id, 'SET #status = :human, needs_human = :reason', '#status IN (:active, :human)',
                            {':reason': _text(reason), ':active': 'active'})

    def resume(self, run_id: str) -> None:
        """A person resumed the run from its decision point: active again; ``RunNotActive`` when it was not waiting."""
        # Never off the 30-day decision point, which offers only "stop".
        self._update_status(run_id, 'SET #status = :active REMOVE needs_human',
                            '#status = :human AND needs_human <> :thirty', {':active': 'active', ':thirty': 'thirty_days'})

    def release(self, run_id: str) -> None:
        """No agent of the ended run is live: the supervisor stops watching it (idempotent)."""
        self._table.delete_item(Key=_registry_key(run_id))

    def get(self, run_id: str) -> Run | None:
        item = consistent_item(self._table, meta_key(run_id))
        if item is None:
            return None
        cost = item.get('max_cost_usd')
        caps = RunCaps(max_tasks=int(item['max_tasks']),
                       max_tokens=int(item['max_tokens']) if item.get('max_tokens') is not None else None,
                       max_cost_usd=float(cost) if cost is not None else None)
        return Run(run_id=run_id, status=str(item['status']), started_at=int(item['started_epoch']), caps=caps,
                   connection=str(item.get('connection', '')), commit=str(item.get('commit', '')))

    def listed(self) -> list[str]:
        """The runs the supervisor watches (live, or ended with a live agent), oldest first (a ULID sorts by time)."""
        query = {'KeyConditionExpression': 'pk = :runs AND begins_with(sk, :run)', 'ConsistentRead': True,
                 'ExpressionAttributeValues': {':runs': f'WS#{WORKSPACE}#RUNS', ':run': 'RUN#'}}
        return [str(item['run_id']) for item in iter_query(self._table, query)]

    def spend(self, run_id: str) -> tuple[int, float]:
        """The run's tokens (its agents' totals) and cost (what the brokers and the runtime priced on its agents)."""
        query = {'KeyConditionExpression': 'pk = :run AND begins_with(sk, :agent)', 'ConsistentRead': True,
                 'ExpressionAttributeValues': {':run': run_pk(run_id), ':agent': 'AGENT#'}}
        tokens, cost = 0, 0.0
        for item in iter_query(self._table, query):
            tokens += int(item.get('input_tokens', 0)) + int(item.get('output_tokens', 0))
            cost += float(item.get('cost_usd', 0))
        return tokens, cost


class TableRunControl:
    """The supervisor's ``RunControl`` on the run's own rows: its caps, its start, its stop, its decision point."""

    def __init__(self, runs: RunStore) -> None:
        self._runs = runs

    def _run(self, run_id: str) -> Run:
        run = self._runs.get(run_id)
        if run is None:
            raise RunNotActive(f'no run {run_id}')
        return run

    def budget(self, run_id: str) -> Budget:
        caps = self._run(run_id).caps
        tokens, cost = self._runs.spend(run_id)
        return Budget(tokens=tokens, cost_usd=cost, max_tokens=caps.max_tokens, max_cost_usd=caps.max_cost_usd)

    def started_at(self, run_id: str) -> int:
        return self._run(run_id).started_at

    def stop_requested(self, run_id: str) -> bool:
        """The run ended (done, failed, or a person's stop): every MicroVM of it is ended, none gets a new session."""
        return self._run(run_id).status in ENDED

    def needs_human(self, run_id: str, reason: str) -> None:
        self._runs.needs_human(run_id, reason)
