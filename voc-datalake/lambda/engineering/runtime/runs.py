"""A run's start and end in the ``voc-engineering`` table, and the registry of the runs the supervisor watches.

``WS#<ws>#RUN#<run>`` / ``META`` is the run's own row: the board counts its tasks on it (``task_count``, under
the run's ``max_tasks``), the inbox router numbers its conversation on it (``msg_seq``), the delivery function
numbers its inbox on it (``inbox_seq``, ``delivery.py``), the reports read its
goal, repository, flow, status and times, the supervisor its caps and its start, and the connector's broker its
status, connection, commit and ``started_by`` (the person who started it, whose way of working its dial reads:
``connectors/records.py``). The run's start writes it,
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
every session of an ended run, even when the end's caller died halfway. Whether any run is listed is what
switches the supervisor's schedule.
"""
from __future__ import annotations

import math
import secrets
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Final

from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import BotoCoreError, ClientError

from engineering.board.model import Task
from engineering.board.store import BoardStore
from engineering.connectors.identity import WORKSPACE
from engineering.flow.conductor import DECISION_PREFIX, GO, NO_GO, Flow, FlowError, Plan, conduct
from engineering.flow.ledger import ReadRecord, newest_final_go
from engineering.flow.record import (
    CACHED_FLOWS,
    FLOW_SK,
    STEP_PREFIX,
    board_state,
    cap_reached,
    decision_item,
    flow_item,
    gate_verdicts,
    parse_flow,
    recorded_verdicts,
    verdict_item,
)
from engineering.runtime.checkout import COMMIT_RE
from engineering.runtime.egress import REGISTRY_HOSTS
from engineering.runtime.interface import RuntimeRefused, check_id, check_run_id
from engineering.runtime.ports import Budget, BudgetAlert, FlowStop
from engineering.spend import (
    ALERT_CLAIM_SECONDS,
    alert_levels,
    alert_sent,
    claim_alert,
    flow_month_usd,
    keyable,
    month_of,
    release_alert,
)
from shared import workflow_schema
from shared.aws import consistent_item, is_conditional_check_failure
from shared.dynamo_paging import iter_query
from shared.ids import is_key_collision
from shared.logging import logger
from shared.workflow_engineering import BUDGET_RULE, budget_of

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
    #: The repository's toolchain (an ``egress.REGISTRY_HOSTS`` language): the coordinator's session image.
    language: str = ''
    #: The run's workflow and repository, as its start recorded them (the spend ledger's grouping).
    flow: str = ''
    repo: str = ''
    #: Its flow's monthly budget as the start gave it (copied from the flow: a change applies to the next run), and the
    #: highest alert level the flow passed in ``budget_alert_month`` (the run's flag; 0 for none).
    budget_usd: float | None = None
    budget_alert: int = 0
    budget_alert_month: str = ''
    #: When a person last resumed the whole run (epoch seconds; 0 for never).
    resumed_at: int = 0
    #: The decision point the run waits at ('' when it waits at none): ``budget``, ``coordinator``, ``flow:<step>``…
    waiting_at: str = ''


class StartReadFailed(RuntimeRefused):
    """A read a budgeted first start needs (the hard cap's setting, the flow's month total) failed: nothing was
    written, and the start can be asked again. Its own type, so a caller answers it as a passing fault (503), never
    as a refusal a person must act on."""


def hard_capped(caps: RunCaps, *, budget_usd: float, flow: str, table: Any, now: int) -> RunCaps:
    """The administrators' hard cap on a start (settings.py): the run's cost cap is what is left of its flow's month
    (its budget less the flow's month total), or the cap it was given if smaller; ``RuntimeRefused`` with nothing left,
    before anything is written. Set once, for this run: runs of the flow at once may together pass its budget.
    session time only until tokens are priced."""
    # (the start's own checks first: a budget off its rule, or a flow that cannot key one, is refused for that)
    if budget_of({'monthly_usd': budget_usd})[1]:
        raise RuntimeRefused(BUDGET_RULE)
    if not keyable(flow):
        raise RuntimeRefused('a budget is a flow\'s: the run names its workflow id')
    month = month_of(datetime.fromtimestamp(now, UTC))
    budget = Decimal(str(budget_usd))
    try:
        spent = flow_month_usd(table, month, flow)
    except (ClientError, BotoCoreError) as error:   # (as an unreadable setting: the start is refused, saying so)
        raise StartReadFailed(f'the flow {flow}\'s spend this month could not be read: start the run again') from error
    left = budget - spent
    if left <= 0:
        raise RuntimeRefused(f'the flow {flow} has spent its monthly budget for {month} (${spent:,.2f} of '
                             f'${budget:,.2f}): raise its budget, or turn the hard cap off, to start a run of it')
    cap = float(left) if caps.max_cost_usd is None else min(caps.max_cost_usd, float(left))
    return replace(caps, max_cost_usd=cap)


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


def transaction_conflict(error: ClientError) -> bool:
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


def _flow_copy(run_id: str, flow: str, definition: str, revision: object, now: int) -> list[dict[str, Any]]:
    """The run's ``FLOW`` row: the flow's definition, checked again here (the server's own rules, an engineering
    flow, one the conductor can follow) and written as the stored form of what passed; ``RuntimeRefused`` before
    anything is written otherwise."""
    if not keyable(flow):
        raise RuntimeRefused('a flow\'s copy is a flow\'s: the run names its workflow id')
    if type(revision) is not int or revision < 1:   # (never a bool, which is an int too)
        raise RuntimeRefused('the flow\'s revision is a whole number from 1')
    checked = workflow_schema.validate_definition(workflow_schema.decode_definition(definition))
    if checked.definition is None or checked.definition.get('schema') != workflow_schema.SCHEMA_V2:
        raise RuntimeRefused('the run\'s flow is not an engineering flow the server\'s rules pass: save it again')
    try:
        Flow.from_definition(checked.definition)
    except FlowError as error:
        raise RuntimeRefused(str(error)) from error
    return [flow_item(run_pk(run_id), workflow_id=flow, revision=revision,
                      definition=workflow_schema.encode_definition(checked.definition), at=_iso(now))]


_SERIALIZER: Final = TypeSerializer()


def _typed(item: Mapping[str, Any]) -> dict[str, Any]:
    """A resource table's item in the low-level shape (``{'S': ...}``), as the board's and the flow's readers take it."""
    return {name: _SERIALIZER.serialize(value) for name, value in item.items()}


def flow_step(reason: str) -> str:
    """The flow's step a decision point names (``flow:<step>``), '' for any other decision point."""
    return reason.removeprefix(DECISION_PREFIX) if reason.startswith(DECISION_PREFIX) else ''


class RunStore:
    def __init__(self, table: Any, gate_records: ReadRecord | None = None) -> None:
        """``gate_records``: a gate record by its key, the GO ledger's read of a flow's quality gate verdict (None:
        the verdicts the board recorded, else none taken for a GO)."""
        self._table = table
        self._gate_records = gate_records
        #: The runs' copies of their flows, once read (create-only: never changed), at most ``CACHED_FLOWS``.
        self._flow_copies: dict[str, Flow] = {}
        #: The gate verdicts a plan read at a decision point, to keep once the run is there (``keep_verdicts``).
        self._unkept: dict[str, tuple[Plan, list[Task], Mapping[tuple[str, str], str]]] = {}

    def start(self, run_id: str, *, caps: RunCaps, now: int, goal: str = '', repo: str = '', flow: str = '',
              connection: str = '', commit: str = '', language: str = '', actor: str = '',
              budget_usd: float | None = None, flow_definition: str = '', flow_revision: int = 0,
              default_branch: str = '') -> None:
        """Write the run's ``META`` and list it for the supervisor; ``RunExists`` when it was started already.

        ``connection`` and ``commit`` (a full object id), when given, are what the board's ``launch`` op starts the
        run's agents on: read from here, never from the agent asking; ``language``, the repository's toolchain,
        is the image its coordinator runs in. ``budget_usd``, the flow's monthly budget (its ``budget.monthly_usd``,
        under the flow's own rule), is what the alerts measure the flow's month against. ``flow_definition``, the
        stored flow's definition as its JSON text (at ``flow_revision``), is copied into the run's own ``FLOW`` row in
        the same transaction, create-only (``engineering/flow/record.py``): the run follows that copy, whatever the
        flow becomes; refused before anything is written when it is not an engineering flow the conductor can
        follow."""
        if connection:
            check_id('connection', connection)
        if commit and not COMMIT_RE.match(commit):
            raise RuntimeRefused('a commit is a full hexadecimal object id')
        if language and language not in REGISTRY_HOSTS:
            raise RuntimeRefused(f'no toolchain image for language {language!r}')
        if budget_usd is not None and budget_of({'monthly_usd': budget_usd})[1]:
            raise RuntimeRefused(BUDGET_RULE)
        if budget_usd is not None and not keyable(flow):
            # (its alerts and its cap are keyed by the flow: one that cannot be a key would measure nothing)
            raise RuntimeRefused('a budget is a flow\'s: the run names its workflow id')
        copy = _flow_copy(run_id, flow, flow_definition, flow_revision, now) if flow_definition else []
        name = self._table.name
        meta: dict[str, Any] = {**meta_key(run_id), 'run_id': run_id, 'status': 'active', 'started_at': _iso(now),
                                'started_epoch': now, 'max_tasks': caps.max_tasks, 'goal': _text(goal),
                                # The connection's stored default branch at the start: the broker's, once the host
                                # confirms it has it (connectors/records.py); '' for the host's own.
                                'repo': _text(repo), 'default_branch': _text(default_branch), 'flow': _text(flow), 'connection': connection, 'commit': commit,
                                'language': language, 'agent_count': 1,
                                # Whose way of working the broker's dial reads (connectors/dial.py): the person
                                # who started the run, '' for none (then nothing is pushed: Human-driven).
                                'started_by': _actor(actor) if actor else ''}
        if caps.max_tokens is not None:
            meta['max_tokens'] = caps.max_tokens
        if caps.max_cost_usd is not None:
            meta['max_cost_usd'] = str(caps.max_cost_usd)
        if budget_usd is not None:
            meta['budget_usd'] = str(budget_usd)
        # The run coordinator's task, open for it alone (the board's: it claims it like any agent, so the supervisor
        # watches it by its lease).
        coordinate = BoardStore(self._table.meta.client, name, new_id=lambda: '').coordinate_items(
            WORKSPACE, run_id, at=_iso(now))
        try:
            self._table.meta.client.transact_write_items(TransactItems=[
                {'Put': {'TableName': name, 'Item': meta, 'ConditionExpression': 'attribute_not_exists(pk)'}},
                {'Put': {'TableName': name, 'Item': {**_registry_key(run_id), 'run_id': run_id}}},
                *({'Put': {'TableName': name, 'Item': item, 'ConditionExpression': 'attribute_not_exists(sk)'}}
                  for item in (*coordinate, *copy)),
                {'Put': {'TableName': name, 'Item': _history(run_id, status='active', actor=actor, now=now),
                         'ConditionExpression': 'attribute_not_exists(sk)'}},   # (D1: create-only)
            ])
        except ClientError as error:
            if is_key_collision(error, put_index=0):
                raise RunExists(f'run {run_id} was started already') from error
            raise

    def _update_status(self, run_id: str, history: dict[str, Any], expression: str, condition: str,
                       values: dict[str, Any], also: tuple[dict[str, Any], ...] = ()) -> None:
        """META's status change and its ``history`` row (and the create-only rows ``also``), together:
        ``RunNotActive`` when META's condition fails, tried again (``STATUS_TRIES`` in all) when another write of META
        raced it."""
        name = self._table.name
        update = {'TableName': name, 'Key': meta_key(run_id), 'ConditionExpression': condition,
                  'UpdateExpression': expression, 'ExpressionAttributeNames': {'#status': 'status'},
                  'ExpressionAttributeValues': {**values, ':human': 'needs_human'}}
        for tries in range(1, STATUS_TRIES + 1):
            try:
                self._table.meta.client.transact_write_items(TransactItems=[
                    {'Update': update},
                    *({'Put': {'TableName': name, 'Item': item, 'ConditionExpression': 'attribute_not_exists(sk)'}}
                      for item in (history, *also))])   # (D1)
            except ClientError as error:
                if is_key_collision(error, put_index=0):
                    raise RunNotActive(f'run {run_id} is not active') from error
                if not transaction_conflict(error) or tries == STATUS_TRIES:
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
        """A person resumed the run from its decision point: active again; ``RunNotActive`` when it was not waiting.
        ``resumed_epoch`` records when (the supervisor gives a Resume's new coordinator its own launch window). At a
        flow step's decision point (``flow:<step>``) it is also that person's decision on the step, a create-only
        ``STEP#<step>#decision#…`` row in the same transaction, held to the decision point read (D4: who and when;
        the conductor passes the step, or gives a blocked one another try)."""
        waiting = self.get(run_id)
        step = flow_step(waiting.waiting_at) if waiting is not None else ''
        condition, values = '#status = :human AND needs_human <> :thirty', {':active': 'active',
                                                                             ':thirty': 'thirty_days', ':now': now}
        also: tuple[dict[str, Any], ...] = ()
        if step:
            condition += ' AND needs_human = :point'
            values[':point'] = f'{DECISION_PREFIX}{step}'
            also = (decision_item(run_pk(run_id), step, actor=_actor(actor), at=_iso(now),
                                  nonce=secrets.token_hex(4)),)
        # Never off the 30-day decision point, which offers only "stop".
        self._update_status(run_id, _history(run_id, status='active', actor=actor, now=now, reason='resumed'),
                            'SET #status = :active, resumed_epoch = :now REMOVE needs_human', condition, values, also)

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
        budget = item.get('budget_usd')
        return Run(run_id=run_id, status=str(item['status']), started_at=int(item['started_epoch']), caps=caps,
                   connection=str(item.get('connection', '')), commit=str(item.get('commit', '')),
                   language=str(item.get('language', '')), flow=str(item.get('flow', '')),
                   repo=str(item.get('repo', '')), budget_usd=float(budget) if budget is not None else None,
                   budget_alert=int(item.get('budget_alert', 0)),
                   budget_alert_month=str(item.get('budget_alert_month', '')),
                   resumed_at=int(item.get('resumed_epoch', 0)),
                   waiting_at=str(item.get('needs_human', '')) if item.get('status') == 'needs_human' else '')

    def flag_budget(self, run_id: str, month: str, level: int) -> None:
        """Flag the run with the highest alert level its flow passed in ``month`` (for the run monitor and its
        reports): only ever upward within a month, never on a run that is gone."""
        try:
            self._table.update_item(
                Key=meta_key(run_id),
                UpdateExpression='SET budget_alert = :level, budget_alert_month = :month',
                ConditionExpression=('attribute_exists(pk) AND (attribute_not_exists(budget_alert) '
                                     'OR budget_alert_month < :month '
                                     'OR (budget_alert_month = :month AND budget_alert < :level))'),
                ExpressionAttributeValues={':level': level, ':month': month})
        except ClientError as error:
            if not is_conditional_check_failure(error):
                raise

    def _typed_rows(self, run_id: str, prefix: str) -> list[dict[str, Any]]:
        """The run's rows of a kind, in the low-level shape the board's and the flow's readers take."""
        query = {'KeyConditionExpression': 'pk = :run AND begins_with(sk, :p)', 'ConsistentRead': True,
                 'ExpressionAttributeValues': {':run': run_pk(run_id), ':p': prefix}}
        return [_typed(item) for item in iter_query(self._table, query)]

    def flow_plan(self, run_id: str, *, keep_verdicts: bool = False) -> Plan | None:
        """The conductor's plan for the run (None: it was started without a flow): its copy of its flow, kept once
        read (it never changes), then its tasks, its step rows and META read now (engineering/flow/record.py).
        ``keep_verdicts``: at a decision point, each gate verdict read from its record is kept, create-only, as the
        board keeps it (``STEP#<gate>#verdict#<task>``), so the run monitor, which reads no gate record, shows the
        run at the gate's decision point rather than the gate still running."""
        flow = self._flow_copies.get(run_id)
        if flow is None:
            item = consistent_item(self._table, {'pk': run_pk(run_id), 'sk': FLOW_SK})
            if item is None:
                return None
            flow = parse_flow(_typed(item))
            if len(self._flow_copies) >= CACHED_FLOWS:
                self._flow_copies.pop(next(iter(self._flow_copies)))
            self._flow_copies[run_id] = flow
        meta = consistent_item(self._table, meta_key(run_id))
        tasks = [Task.from_item(item) for item in self._typed_rows(run_id, 'TASK#')]
        rows = self._typed_rows(run_id, STEP_PREFIX)
        recorded = recorded_verdicts(rows)
        verdicts = gate_verdicts(flow, tasks, WORKSPACE, run_id, self._gate_records, recorded)
        plan = conduct(flow, board_state(tasks, rows, cap_reached=cap_reached(_typed(meta) if meta else None),
                                         verdicts=verdicts))
        if keep_verdicts and plan.decision_point and self._gate_records is not None:
            # (kept once the run is at its decision point: ``keep_verdicts``, best effort, never before it)
            self._unkept[run_id] = (plan, tasks, recorded)
        return plan

    def keep_verdicts(self, run_id: str) -> None:
        """Keep the gate verdicts the last ``flow_plan(keep_verdicts=True)`` of the run read at its decision point
        (nothing when it read none)."""
        unkept = self._unkept.pop(run_id, None)
        if unkept is not None:
            self._keep_verdicts(run_id, *unkept)

    def _keep_verdicts(self, run_id: str, plan: Plan, tasks: list[Task],
                       recorded: Mapping[tuple[str, str], str]) -> None:
        """Each gate verdict the plan read from its record, for its deciding final-go task, create-only (a verdict
        already kept is never written over), as the supervisor."""
        at = _iso(int(time.time()))
        for step, verdict in plan.verdicts.items():
            latest = newest_final_go([task for task in tasks if task.flow_step == step], WORKSPACE, run_id)
            if verdict not in (GO, NO_GO) or latest is None or (step, latest[0].task_id) in recorded:
                continue
            item = verdict_item(run_pk(run_id), step, latest[0].task_id, verdict, actor=SUPERVISOR, at=at)
            try:
                self._table.put_item(Item=item, ConditionExpression='attribute_not_exists(sk)')
            except ClientError as error:
                if not is_conditional_check_failure(error):
                    raise

    @property
    def table(self) -> Any:
        """The engineering table (the spend ledger's month partitions are in it too)."""
        return self._table

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


#: How far into a month the month before is still checked, past an alert claim's time: two ticks more, so a claim
#: left in its last minute is taken over.
LOOK_BACK_TICKS_SECONDS: Final = 120


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
        """The run ended (done, failed, or a person's stop): every session of it is ended, none gets a new session."""
        return self._run(run_id).status in ENDED

    def needs_human(self, run_id: str, reason: str) -> None:
        """The run at its decision point; at a flow step's, the gate verdicts the supervisor read are then kept for
        the run monitor, best effort: a write that fails is logged and never delays or fails the decision point."""
        self._runs.needs_human(run_id, reason, now=int(self._clock()))
        if not flow_step(reason):
            return
        try:
            self._runs.keep_verdicts(run_id)
        except Exception:
            logger.exception('engineering runtime: a gate verdict for the run monitor was not kept',
                             extra={'run_id': run_id, 'decision_point': reason})

    def is_active(self, run_id: str) -> bool:
        run = self._runs.get(run_id)
        return run is not None and run.status == 'active'

    def flow_stop(self, run_id: str) -> FlowStop | None:
        """The decision point the run's flow waits at (``flow:<step>``: a human decision point reached, a step blocked
        or one the runtime cannot do and the flow cannot go on without), else None. A run waiting at one already
        answers it as ``waiting`` (its agents stay held, and nothing is asked again); a run without a flow, at another
        decision point or ended, None."""
        run = self._runs.get(run_id)
        if run is None or run.status != 'active':
            waiting = run is not None and bool(flow_step(run.waiting_at))
            return FlowStop(run.waiting_at, waiting=True) if run is not None and waiting else None
        plan = self._runs.flow_plan(run_id, keep_verdicts=True)
        return FlowStop(plan.decision_point) if plan is not None and plan.decision_point else None

    def coordinator_awaited(self, run_id: str) -> int | None:
        run = self._runs.get(run_id)
        if run is None or run.status != 'active' or not (run.connection and run.commit and run.language):
            return None
        return max(run.started_at, run.resumed_at)   # (a Resume's new coordinator gets its own window)

    def budget_alert(self, run_id: str, now: int) -> BudgetAlert | None:
        """One GetItem of the flow's month total; each level passed above the run's flag is claimed for this run
        (spend.claim_alert). Claims to say: the alert, flagged once said (``alert_sent``); none: the run is flagged now.
        Nothing without a budget (only a run with a flow has one)."""
        run = self._run(run_id)
        if run.budget_usd is None:
            return None
        at = datetime.fromtimestamp(now, UTC)
        # In a month's first minutes, the month before too: a level it passed, or a claim it left unsaid, in its last
        # minute is said then, never lost to the turn of the month.
        before = datetime.fromtimestamp(now - ALERT_CLAIM_SECONDS - LOOK_BACK_TICKS_SECONDS, UTC)
        # (the month before only while the run's flag does not name a later one yet: once it does, it was looked at)
        months = [month for month in dict.fromkeys((month_of(before), month_of(at)))
                  if month == month_of(at) or run.budget_alert_month <= month]
        for month in months:
            alert = self._month_alert(run, run_id, month, at, Decimal(str(run.budget_usd)))
            if alert is not None:
                return alert
        return None

    def _month_alert(self, run: Run, run_id: str, month: str, at: datetime, budget: Decimal) -> BudgetAlert | None:
        seen = run.budget_alert if run.budget_alert_month == month else 0
        spent = flow_month_usd(self._runs.table, month, run.flow)
        levels = [level for level in alert_levels(spent, budget) if level > seen]
        if not levels:
            return None
        found = {level: claim_alert(self._runs.table, month, run.flow, level, run_id=run_id, spent=spent,
                                    budget=budget, at=at) for level in levels}
        # The run's flag rises only past levels said (or said by this tick): one another run holds unsaid stays
        # above it, so this run's later ticks try it again and may take it over.
        held = [level for level, claim in found.items() if claim == 'held']
        flag = max((level for level in levels if not held or level < held[0]), default=seen)
        claimed = tuple(level for level, claim in found.items() if claim == 'claimed')
        if not claimed:
            if flag > seen:
                self._runs.flag_budget(run_id, month, flag)
            return None
        return BudgetAlert(flow=run.flow, month=month, levels=claimed, flag=flag, spent_usd=float(spent),
                           budget_usd=float(budget))

    def alert_not_sent(self, run_id: str, alert: BudgetAlert) -> None:
        budget = Decimal(str(alert.budget_usd))
        for level in alert.levels:
            release_alert(self._runs.table, alert.month, alert.flow, level, run_id=run_id, budget=budget)

    def alert_sent(self, run_id: str, alert: BudgetAlert, now: int) -> None:
        at = datetime.fromtimestamp(now, UTC)
        budget = Decimal(str(alert.budget_usd))
        for level in alert.levels:
            alert_sent(self._runs.table, alert.month, alert.flow, level, run_id=run_id, budget=budget, at=at)
        self._runs.flag_budget(run_id, alert.month, alert.flag)
