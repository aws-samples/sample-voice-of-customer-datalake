"""A run's flow record in ``voc-engineering``: its copy of the flow, and what the run recorded for the flow's steps.

- ``WS#<ws>#RUN#<run>`` / ``FLOW``: the stored flow's definition as the run's start copied it, in the start's own
  transaction and create-only (``runs.RunStore.start``): a later edit of the flow never changes a run under way, and
  the record shows what ran (D1, D4). ``{kind: flow_copy, workflow_id, revision, definition (the stored JSON text),
  copied_at}``. A run started without a flow has no such row, and runs as before: its coordinator plans from its goal.
- ``STEP#<step>#<kind>`` (``#<at>#<hex>`` for a decision): create-only rows, each with who wrote it and when (D4):
  ``fan_out`` (a map's shards, as the run coordinator listed them), ``done`` (a step the coordinator did itself, or a
  board it closed), ``not_yet_run`` (a step the runtime cannot do yet that the flow went on without, recorded by the
  board when the conductor first says so), ``decision`` (a person's Resume at the step's decision point,
  ``runs.RunStore.resume``) and ``verdict`` (``#<task>``: a quality gate's verdict as the board read it in the deciding
  final-go task's gate record, for the readers that read no gate record).

The tasks the board holds for each step (their ``step`` and ``shard``) and these rows are all the conductor reads
(``conductor.conduct``).
"""
from __future__ import annotations

import json
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from botocore.exceptions import ClientError

from engineering.board.model import Task
from engineering.board.store import BoardError, posts_sk
from engineering.flow.conductor import GO, NO_GO, UNREAD, BoardState, Flow, FlowError, Plan, StepTask, conduct
from engineering.flow.ledger import ReadRecord, newest_final_go, verdict
from engineering.rows import get_row, number_value, run_pk, run_rows, string_attr
from shared.aws import is_conditional_check_failure
from shared.ids import is_key_collision
from shared.logging import logger

FLOW_SK: Final = 'FLOW'
STEP_PREFIX: Final = 'STEP#'
FAN_OUT, DONE, NOT_YET_RUN, DECISION, VERDICT = 'fan_out', 'done', 'not_yet_run', 'decision', 'verdict'
KINDS: Final = frozenset({FAN_OUT, DONE, NOT_YET_RUN, DECISION, VERDICT})
#: The flows kept per warm container (a run's copy never changes once written, so a found one is kept).
CACHED_FLOWS: Final = 64


def flow_item(run_id_pk: str, *, workflow_id: str, revision: int, definition: str, at: str) -> dict[str, Any]:
    """The run's copy of its flow, as plain values for the start's transaction (a resource table's client)."""
    return {'pk': run_id_pk, 'sk': FLOW_SK, 'kind': 'flow_copy', 'workflow_id': workflow_id, 'revision': revision,
            'definition': definition, 'copied_at': at}


def step_sk(step: str, kind: str, suffix: str = '') -> str:
    if kind not in KINDS:
        raise ValueError(f'a step record is one of {sorted(KINDS)}')
    return f'{STEP_PREFIX}{step}#{kind}' + (f'#{suffix}' if suffix else '')


def decision_item(run_id_pk: str, step: str, *, actor: str, at: str, nonce: str) -> dict[str, Any]:
    """A person's decision on a step (their Resume at its decision point), as plain values for the resume's own
    transaction."""
    return {'pk': run_id_pk, 'sk': step_sk(step, DECISION, f'{at}#{nonce}'), 'kind': 'step_record', 'step': step,
            'record': DECISION, 'by': actor, 'at': at}


def verdict_item(run_id_pk: str, step: str, task_id: str, verdict: str, *, actor: str, at: str) -> dict[str, Any]:
    """A gate's verdict as read from its deciding final-go task's record, as plain values (a resource table's put):
    the same row ``FlowRecord.record_verdicts`` writes."""
    return {'pk': run_id_pk, 'sk': step_sk(step, VERDICT, task_id), 'kind': 'step_record', 'step': step,
            'record': VERDICT, 'by': actor, 'at': at, 'task_id': task_id, 'verdict': verdict}


def step_task(task: Task) -> StepTask:
    return StepTask(task_id=task.task_id, step=task.flow_step, role=task.role, state=task.state, shard=task.shard,
                    updated_at=task.updated_at)


def gate_verdicts(flow: Flow, tasks: Sequence[Task], ws: str, run_id: str, read: ReadRecord | None,
                  recorded: Mapping[tuple[str, str], str]) -> dict[str, str]:
    """Each quality gate step's verdict, by the GO ledger's own rule over that step's tasks (``ledger.verdict``):
    read from the deciding final-go task's gate record with ``read``; without a reader, the verdict the board
    recorded for that task (``STEP#<gate>#verdict#<task>``), else ``unread`` (never a GO)."""
    verdicts: dict[str, str] = {}
    for step in (step for step, item in flow.steps.items() if item.type == 'quality_gate'):
        mine = [task for task in tasks if task.flow_step == step]
        if read is not None:
            found = verdict(mine, ws, run_id, read)
            if found is not None:
                verdicts[step] = found[0]
            continue
        latest = newest_final_go(mine, ws, run_id)
        if latest is not None:
            verdicts[step] = recorded.get((step, latest[0].task_id), UNREAD)
    return verdicts


def recorded_verdicts(rows: Iterable[Mapping[str, Any]]) -> dict[tuple[str, str], str]:
    """The verdicts the board recorded, by gate step and deciding final-go task."""
    return {(string_attr(row, 'step'), string_attr(row, 'task_id')): string_attr(row, 'verdict')
            for row in rows if string_attr(row, 'record') == VERDICT}


def board_state(tasks: Iterable[Task], rows: Iterable[Mapping[str, Any]], *, cap_reached: bool,
                verdicts: Mapping[str, str] | None = None) -> BoardState:
    """The conductor's view of a run: its tasks (each with its step), its step rows and its gates' verdicts."""
    fanned: dict[str, tuple[str, ...]] = {}
    done: set[str] = set()
    decisions: Counter[str] = Counter()
    for row in rows:
        step, kind = string_attr(row, 'step'), string_attr(row, 'record')
        if kind == FAN_OUT:
            fanned[step] = tuple(value.get('S', '') for value in row.get('shards', {}).get('L', ()))
        elif kind == DONE:
            done.add(step)
        elif kind == DECISION:
            decisions[step] += 1
    return BoardState(tasks=tuple(step_task(task) for task in tasks if task.flow_step), fanned_out=fanned,
                      completed=frozenset(done), decisions=dict(decisions), cap_reached=cap_reached,
                      verdicts=dict(verdicts or {}))


def cap_reached(meta: Mapping[str, Any] | None) -> bool:
    """The run's ``task_count`` is at its ``max_tasks`` (a low-level META)."""
    if not meta or 'max_tasks' not in meta:
        return False
    return number_value(meta.get('task_count')) >= number_value(meta.get('max_tasks'))


def copied_definition(item: Mapping[str, Any]) -> dict[str, Any]:
    """A ``FLOW`` row's definition as stored (a JSON object); FlowError for one that is not."""
    try:
        definition = json.loads(string_attr(item, 'definition'))
    except ValueError as exc:
        raise FlowError("the run's copy of its flow cannot be read") from exc
    if not isinstance(definition, dict):
        raise FlowError("the run's copy of its flow is not a definition")
    return definition


def parse_flow(item: Mapping[str, Any]) -> Flow:
    """A ``FLOW`` row's definition as the conductor follows it; FlowError for one it cannot read."""
    return Flow.from_definition(copied_definition(item))


@dataclass(frozen=True)
class RunFlow:
    """A run's flow as its readers show it (the run monitor, the reports): the revision its start copied and when,
    the copy itself (as stored, and as the conductor follows it) and the conductor's plan now."""

    revision: int
    copied_at: str
    definition: dict[str, Any]
    flow: Flow
    plan: Plan


def run_flow(client: Any, table: str, ws: str, run_id: str, meta: Mapping[str, Any] | None,
             read: ReadRecord | None = None) -> RunFlow | None:
    """The run's flow and plan (its copy, its tasks and step rows read here; its gates' verdicts from their records
    with ``read``, else as the board recorded them), None for a run started without a flow; None too for a copy the
    conductor cannot follow (logged: the record is broken, the reader goes on without it)."""
    copy = get_row(client, table, {'pk': {'S': run_pk(ws, run_id)}, 'sk': {'S': FLOW_SK}})
    if copy is None:
        return None
    try:
        definition = copied_definition(copy)
        flow = Flow.from_definition(definition)
    except FlowError:
        logger.exception('engineering: a run\'s copy of its flow cannot be followed', extra={'run_id': run_id})
        return None
    tasks = [Task.from_item(item) for item in run_rows(client, table, ws, run_id, 'TASK#')]
    return RunFlow(revision=number_value(copy.get('revision')), copied_at=string_attr(copy, 'copied_at'),
                   definition=definition, flow=flow,
                   plan=FlowRecord(client, table).plan_of(flow, ws, run_id, tasks, meta, read=read))


class FlowRecord:
    """The run's flow and its step rows on a low-level DynamoDB client. A run's copy of its flow, once read, is kept
    by the instance (at most ``CACHED_FLOWS`` runs): it never changes."""

    def __init__(self, client: Any, table: str) -> None:
        self.client = client
        self.table = table
        self._flows: dict[tuple[str, str], Flow] = {}

    def flow(self, ws: str, run_id: str) -> Flow | None:
        """The run's copy of its flow, or None for a run started without one. One consistent read, then kept (the
        copy is create-only)."""
        key = (ws, run_id)
        if key in self._flows:
            return self._flows[key]
        item = get_row(self.client, self.table, {'pk': {'S': run_pk(ws, run_id)}, 'sk': {'S': FLOW_SK}})
        if item is None:
            return None
        flow = parse_flow(item)
        if len(self._flows) >= CACHED_FLOWS:
            self._flows.pop(next(iter(self._flows)))
        self._flows[key] = flow
        return flow

    def rows(self, ws: str, run_id: str) -> list[dict[str, Any]]:
        return run_rows(self.client, self.table, ws, run_id, STEP_PREFIX)

    def plan(self, ws: str, run_id: str, tasks: Sequence[Task], meta: Mapping[str, Any] | None,
             read: ReadRecord | None = None) -> Plan | None:
        """The conductor's plan for the run (None: no flow), from its tasks and META as the caller read them."""
        flow = self.flow(ws, run_id)
        return None if flow is None else self.plan_of(flow, ws, run_id, tasks, meta, read=read)

    def plan_of(self, flow: Flow, ws: str, run_id: str, tasks: Sequence[Task], meta: Mapping[str, Any] | None,
                read: ReadRecord | None = None) -> Plan:
        """The conductor's plan for the run's ``flow`` (its step rows read here; its gates' verdicts from their
        records with ``read``, else as recorded: ``gate_verdicts``)."""
        rows = self.rows(ws, run_id)
        verdicts = gate_verdicts(flow, tasks, ws, run_id, read, recorded_verdicts(rows))
        return conduct(flow, board_state(tasks, rows, cap_reached=cap_reached(meta), verdicts=verdicts))

    def record_verdicts(self, ws: str, run_id: str, plan: Plan, tasks: Sequence[Task], *, actor: str, at: str) -> None:
        """Record each gate's verdict the plan read from its record, for the deciding final-go task (create-only:
        ``STEP#<gate>#verdict#<task>``), so a reader without the gate records (the run monitor) shows it too."""
        for step, found in plan.verdicts.items():
            latest = newest_final_go([t for t in tasks if t.flow_step == step], ws, run_id) \
                if found in (GO, NO_GO) else None
            if latest is not None:
                self.record(ws, run_id, step, VERDICT, actor=actor, at=at, suffix=latest[0].task_id,
                            extra={'task_id': latest[0].task_id, 'verdict': found})

    def record(self, ws: str, run_id: str, step: str, kind: str, *, actor: str, at: str,
               shards: Sequence[str] = (), reason: str = '', suffix: str = '',
               extra: Mapping[str, str] | None = None) -> bool:
        """A create-only step row (``fan_out``, ``done``, ``not_yet_run``, ``verdict``); False when it was there
        already."""
        item: dict[str, Any] = {'pk': {'S': run_pk(ws, run_id)}, 'sk': {'S': step_sk(step, kind, suffix)},
                                'kind': {'S': 'step_record'}, 'step': {'S': step}, 'record': {'S': kind},
                                'by': {'S': actor}, 'at': {'S': at},
                                **{name: {'S': value} for name, value in (extra or {}).items()}}
        if shards:
            item['shards'] = {'L': [{'S': shard} for shard in shards]}
        if reason:
            item['reason'] = {'S': reason}
        try:
            self.client.put_item(TableName=self.table, Item=item, ConditionExpression='attribute_not_exists(sk)')
        except ClientError as exc:
            if not is_conditional_check_failure(exc):
                raise
            return False
        return True

    def close(self, ws: str, run_id: str, step: str, *, read: Sequence[Task], actor: str, at: str) -> bool:
        """A board's close (``STEP#<step>#done``, create-only), held in its own write to the tasks the closer read for
        the step (``read``), every one of them ended (``POSTS#<step>``, which each post for the step adds to in its
        transaction: ``board/store.py``): a post landing between the closer's read and this write refuses the close,
        ``BoardError`` conflict. A board the closer read empty closes only with no count (``attribute_not_exists``: a
        post since creates it); one with tasks only on its count equal to them (``posts = :read``). A board holding a
        task posted before the count existed (not ``counted``) never closes: its count cannot vouch for what was posted
        since. False when the board was closed already."""
        mine = [task for task in read if task.flow_step == step]
        if any(not task.counted for task in mine):
            raise BoardError('conflict', f'board {step} holds tasks posted before its count existed: it cannot be '
                                         'closed (a person decides: block or stop the run)')
        posts = len(mine)
        pk = {'S': run_pk(ws, run_id)}
        item = {'pk': pk, 'sk': {'S': step_sk(step, DONE)}, 'kind': {'S': 'step_record'}, 'step': {'S': step},
                'record': {'S': DONE}, 'by': {'S': actor}, 'at': {'S': at}}
        try:
            self.client.transact_write_items(TransactItems=[
                {'Put': {'TableName': self.table, 'Item': item, 'ConditionExpression': 'attribute_not_exists(sk)'}},
                {'ConditionCheck': {'TableName': self.table, 'Key': {'pk': pk, 'sk': {'S': posts_sk(step)}},
                                    **({'ConditionExpression': 'posts = :read',
                                        'ExpressionAttributeValues': {':read': {'N': str(posts)}}} if posts else
                                       {'ConditionExpression': 'attribute_not_exists(pk)'})}},
            ])
        except ClientError as exc:
            if is_key_collision(exc, put_index=0):
                return False
            if is_key_collision(exc, put_index=1):
                raise BoardError('conflict', f'a task was posted for board {step} meanwhile: read the flow again '
                                             'before you close it') from exc
            raise
        return True

    def mark_not_yet_run(self, ws: str, run_id: str, plan: Plan, *, actor: str, at: str) -> None:
        """Record each step the plan passed as not yet run (create-only: a step already recorded keeps its row)."""
        recorded = {string_attr(row, 'step') for row in self.rows(ws, run_id)
                    if string_attr(row, 'record') == NOT_YET_RUN}
        for state in plan.not_yet_run():
            if state.step not in recorded:
                self.record(ws, run_id, state.step, NOT_YET_RUN, actor=actor, at=at, reason=state.reason)
