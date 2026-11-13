"""A run's start and end in the ``voc-engineering`` table, and the registry of the runs the supervisor watches.

``WS#<ws>#RUN#<run>`` / ``META`` is the run's own row: the board counts its tasks on it (``task_count``, under
the run's ``max_tasks``), the inbox router numbers its conversation on it (``msg_seq``), the delivery function
numbers its inbox on it (``inbox_seq``, ``delivery.py``), the reports read its
goal, repository, flow, status and times, and the supervisor its caps and its start. The run's start writes it,
once; its end sets its status and end time. Nothing else here ever writes over the board's, the router's or the
inbox's counters: after the first write every change is an update of this module's own attributes. The start
takes the run's first agent number (``agent_count`` 1, the board's counter of ``<role>-<n>`` ids) for its
coordinator, ``coordinator-1`` (the one ``BoardStore.coordinate_items`` records), so the board numbers the agents it
launches from 2.

Every change of a run's status (its start, its end, a decision point, a person's resume) records who made it and
when (D4): a row of its own, ``RUNLOG#<at>#<status>#<hex>`` (the status, the actor, the reason, the time), written in
the same transaction as META's change, so the run's history is never only its last state. A decision point the run
already waits at, for the same reason, changes nothing and writes no row (the supervisor asks for it on every tick
while a budget stays spent). A change that loses a race with another write of META is tried again.

``WS#<ws>#RUNS`` holds one row per run the supervisor still watches (``RUN#<run>``), written in the same
transaction as the run's ``META`` (the table has no index, so this is how the supervisor lists them). A run's end
does not remove it: the run stays listed until none of its agents is live (``release``), so the supervisor ends
every MicroVM of an ended run, even when the end's caller died halfway. Whether any run is listed is what
switches the supervisor's schedule.
"""
from __future__ import annotations

import math
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final

from botocore.exceptions import ClientError

from engineering.board.store import BoardStore
from engineering.connectors.identity import WORKSPACE
from engineering.runtime.checkout import COMMIT_RE
from engineering.runtime.egress import REGISTRY_HOSTS
from engineering.runtime.interface import RuntimeRefused, check_id, check_run_id
from engineering.runtime.ports import Budget
from shared.aws import consistent_item
from shared.dynamo_paging import iter_query
from shared.ids import is_key_collision

#: How a run ends (``active`` and ``needs_human`` are its live statuses).
ENDED: Final = frozenset({'done', 'failed', 'stopped'})
MAX_TEXT: Final = 500
MAX_TASKS_LIMIT: Final = 10_000
#: Who changed a run's status when its caller named nobody (D4 keeps the gap visible rather than guessing).
UNATTRIBUTED: Final = 'unattributed'
#: The supervisor, as the actor of the decision points it sets.
SUPERVISOR: Final = 'supervisor'
MAX_ACTOR: Final = 200
#: How often a status change is tried when another write of META races it (a transaction conflict).
STATUS_TRIES: Final = 3
STATUS_PAUSE_S: Final = 0.05


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
    #: The repository's toolchain (an ``egress.REGISTRY_HOSTS`` language): the coordinator's MicroVM image.
    language: str = ''


class RunExists(RuntimeRefused):
    """The run was started already."""


class RunNotActive(RuntimeRefused):
    """The run is not active (never started, or ended)."""


def _iso(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, UTC).isoformat().replace('+00:00', 'Z')


def _text(value: str) -> str:
    return value[:MAX_TEXT]


def _actor(actor: str) -> str:
    """Who made a change, as recorded: its printable characters, at most ``MAX_ACTOR``; ``UNATTRIBUTED`` for none. Never
    refused: a stop never fails over its audit label."""
    return ''.join(char for char in actor if char.isprintable())[:MAX_ACTOR] or UNATTRIBUTED


def _conflict(error: ClientError) -> bool:
    """The transaction lost a race with another write of one of its items (worth one more try)."""
    reasons = error.response.get('CancellationReasons') or []
    return any(reason.get('Code') == 'TransactionConflict' for reason in reasons)


def _history(run_id: str, *, status: str, actor: str, now: int, reason: str = '') -> dict[str, Any]:
    """The change's own row (D4): a random suffix keeps two changes in one second apart, so a history write never
    fails the change it records."""
    at = _iso(now)
    item = {'pk': run_pk(run_id), 'sk': f'RUNLOG#{at}#{status}#{secrets.token_hex(4)}', 'kind': 'run_status',
            'status': status, 'actor': _actor(actor), 'at': at}
    if reason:
        item['reason'] = reason
    return item


class RunStore:
    def __init__(self, table: Any) -> None:
        self._table = table

    def start(self, run_id: str, *, caps: RunCaps, now: int, goal: str = '', repo: str = '', flow: str = '',
              connection: str = '', commit: str = '', language: str = '', actor: str = '') -> None:
        """Write the run's ``META`` and list it for the supervisor; ``RunExists`` when it was started already.

        ``connection`` and ``commit`` (a full object id), when given, are what the board's ``launch`` op starts the
        run's agents on: read from here, never from the agent asking; ``language``, the repository's toolchain,
        is the image its coordinator runs in."""
        if connection:
            check_id('connection', connection)
        if commit and not COMMIT_RE.match(commit):
            raise RuntimeRefused('a commit is a full hexadecimal object id')
        if language and language not in REGISTRY_HOSTS:
            raise RuntimeRefused(f'no toolchain image for language {language!r}')
        name = self._table.name
        meta: dict[str, Any] = {**meta_key(run_id), 'run_id': run_id, 'status': 'active', 'started_at': _iso(now),
                                'started_epoch': now, 'max_tasks': caps.max_tasks, 'goal': _text(goal),
                                'repo': _text(repo), 'flow': _text(flow), 'connection': connection, 'commit': commit,
                                'language': language, 'agent_count': 1}
        if caps.max_tokens is not None:
            meta['max_tokens'] = caps.max_tokens
        if caps.max_cost_usd is not None:
            meta['max_cost_usd'] = str(caps.max_cost_usd)
        # The run coordinator's task, open for it alone (the board's: it claims it like any agent, so the supervisor
        # watches it by its lease).
        coordinate = BoardStore(self._table.meta.client, name, new_id=lambda: '').coordinate_items(
            WORKSPACE, run_id, at=_iso(now))
        try:
            self._table.meta.client.transact_write_items(TransactItems=[
                {'Put': {'TableName': name, 'Item': meta, 'ConditionExpression': 'attribute_not_exists(pk)'}},
                {'Put': {'TableName': name, 'Item': {**_registry_key(run_id), 'run_id': run_id}}},
                *({'Put': {'TableName': name, 'Item': item, 'ConditionExpression': 'attribute_not_exists(sk)'}}
                  for item in coordinate),
                {'Put': {'TableName': name, 'Item': _history(run_id, status='active', actor=actor, now=now),
                         'ConditionExpression': 'attribute_not_exists(sk)'}},   # (D1: create-only)
            ])
        except ClientError as error:
            if is_key_collision(error, put_index=0):
                raise RunExists(f'run {run_id} was started already') from error
            raise

    def _update_status(self, run_id: str, history: dict[str, Any], expression: str, condition: str,
                       values: dict[str, Any]) -> None:
        """META's status change and its ``history`` row, together: ``RunNotActive`` when META's condition fails, tried
        again (``STATUS_TRIES`` in all) when another write of META raced it."""
        name = self._table.name
        update = {'TableName': name, 'Key': meta_key(run_id), 'ConditionExpression': condition,
                  'UpdateExpression': expression, 'ExpressionAttributeNames': {'#status': 'status'},
                  'ExpressionAttributeValues': {**values, ':human': 'needs_human'}}
        for tries in range(1, STATUS_TRIES + 1):
            try:
                self._table.meta.client.transact_write_items(TransactItems=[
                    {'Update': update}, {'Put': {'TableName': name, 'Item': history,
                                                 'ConditionExpression': 'attribute_not_exists(sk)'}}])   # (D1)
            except ClientError as error:
                if is_key_collision(error, put_index=0):
                    raise RunNotActive(f'run {run_id} is not active') from error
                if not _conflict(error) or tries == STATUS_TRIES:
                    raise
            else:
                return
            time.sleep(STATUS_PAUSE_S * tries)   # the racing write is in flight: give it time to land

    def end(self, run_id: str, status: str, *, now: int, actor: str = '') -> None:
        """End a live run with ``status`` (it stays listed until ``release``); ``RunNotActive`` when it is not live."""
        if status not in ENDED:
            raise RuntimeRefused(f'a run ends as one of {sorted(ENDED)}')
        self._update_status(run_id, _history(run_id, status=status, actor=actor, now=now),
                            'SET #status = :status, ended_at = :ended', '#status IN (:active, :human)',
                            {':status': status, ':ended': _iso(now), ':active': 'active'})

    def needs_human(self, run_id: str, reason: str, *, now: int, actor: str = SUPERVISOR) -> None:
        """The run waits at a human decision point (its agents are held, and none is launched, meanwhile). One it
        already waits at for the same reason changes nothing; the 30-day one is never replaced by another. ``actor``
        is the history's: the supervisor's own, or the start's or Resume's whose coordinator did not launch."""
        reason = _text(reason)
        try:
            self._update_status(run_id, _history(run_id, status='needs_human', actor=actor, now=now,
                                                 reason=reason),
                                'SET #status = :human, needs_human = :reason',
                                '#status = :active OR (#status = :human AND needs_human <> :reason '
                                'AND needs_human <> :thirty)',
                                {':reason': reason, ':active': 'active', ':thirty': 'thirty_days'})
        except RunNotActive:
            run = consistent_item(self._table, meta_key(run_id))
            if run is not None and run.get('status') == 'needs_human':
                return   # at a decision point already: this one's reason, or the 30-day one, which only a stop ends
            raise

    def resume(self, run_id: str, *, now: int, actor: str = '') -> None:
        """A person resumed the run from its decision point: active again; ``RunNotActive`` when it was not waiting."""
        # Never off the 30-day decision point, which offers only "stop".
        self._update_status(run_id, _history(run_id, status='active', actor=actor, now=now, reason='resumed'),
                            'SET #status = :active REMOVE needs_human', '#status = :human AND needs_human <> :thirty',
                            {':active': 'active', ':thirty': 'thirty_days'})

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
                   connection=str(item.get('connection', '')), commit=str(item.get('commit', '')),
                   language=str(item.get('language', '')))

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

    def __init__(self, runs: RunStore, clock: Callable[[], float] = time.time) -> None:
        self._runs = runs
        self._clock = clock

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
        self._runs.needs_human(run_id, reason, now=int(self._clock()))

    def is_active(self, run_id: str) -> bool:
        run = self._runs.get(run_id)
        return run is not None and run.status == 'active'
