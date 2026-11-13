"""The board's writes, each one conditional (plan v3, 4.3; I6: state is the record, events are notifications).

- ``post``: one transaction counts the task on the run's ``META`` row (which must exist and be under its
  ``max_tasks`` cap), writes a ``SPEC#<hash>`` marker (an equivalent task still under way is answered, not posted
  twice) and the ``TASK#`` row; the depth below its parent is capped. A marker whose task has ended (done, failed,
  needs a human) is moved to the new task, conditionally on the task it named, so the same work can be posted again
  once the first ended (nothing is deleted, D5).
- ``claim``: only an ``open`` task of the caller's role; the lease's epoch is the task's attempt. A claim by the
  agent that already holds the lease, on a task that has not ended, answers the task as it is (a continuation in a
  new MicroVM reads its brief by claiming again).
- ``coordinate_items``: the run's ``coordinate`` task (role ``coordinator``), which only the run's start writes,
  in its own transaction (trusted code, never an agent's post): the coordinator claims it, renews and reports
  progress on it like any agent, so the supervisor judges it by its lease too. It records the coordinator the start
  launches (``coordinator-1``), and only that coordinator claims it, in the claim's own condition.
- ``launch``: the coordinator's launch of an agent for an open task, recorded once on the task
  (``launched_agent``, its id ``<role>-<n>`` from the run's ``agent_count``) with a history row; a retried launch
  reuses the agent it recorded. Never for the coordinate task: ``launch_coordinator`` (the run's trusted code only)
  records a new coordinator on it after a re-post, at the attempt given.
- ``renew`` (the heartbeat), ``progress`` and ``move``: only the lease holder with the lease's epoch, before the
  lease runs out, on a task that has not ended, so an agent whose lease was lost cannot act on the task again.
  ``progress`` sets ``progress_at``, a short ``step`` and ``waiting`` (an open question, review or decision): the
  supervisor judges "no progress" from ``progress_at`` and leaves a waiting task alone. Like a renewal, it is not a
  move and writes no history row.
- ``repost`` (the supervisor's, for an expired lease): the task is ``open`` again at ``attempt + 1``, its lease
  cleared, with a history row naming the supervisor and its reason; on its own row, not through ``post``, so the
  ``SPEC#`` dedupe does not stand in its way, and the next claim's lease takes the new attempt as its epoch.
- A task keeps at most ``MAX_RESULT_KEYS`` result keys, which every board event about it carries. A repeated claim
  or move that already took effect answers the task as it is (callers retry after a lost answer).
- History (D1, D4): the ``TASK#`` row is the task now; each post, claim and move also writes, in the same
  transaction, a ``TASKLOG#<task>#<at>#<state>`` row (create-only) with who made it and how, so no past state is
  overwritten. A renewal or a progress report is not a move and writes none.
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from boto3.dynamodb.types import TypeDeserializer
from botocore.exceptions import ClientError

from engineering.board.model import CLAIMED, FINAL, MOVES, NEEDS_HUMAN, OPEN, PERSON_PREFIX, Move, Task, task_key
from engineering.quality_gate.text import redact
from engineering.rows import Refused, get_row, run_pk, run_rows
from engineering.workspace.layout import parse_agent_key
from shared.aws import is_conditional_check_failure
from shared.ids import is_key_collision

LEASE_S = 300
MAX_DEPTH = 3
MAX_SPEC_BYTES = 8 * 1024
#: A task's result keys ride on its board events: 16 keys of 512 characters stay well inside an event's 16 KB.
MAX_RESULT_KEYS = 16
MAX_KEY_LENGTH = 512
#: A progress step or a re-post's reason: a line, not a log.
MAX_LINE = 200
#: A task's priority, either way (an agent's post takes the same bound: board/api.py MAX_INT).
MAX_PRIORITY = 1_000_000
#: A person's lease never runs out: the largest epoch-seconds a lease takes (the year 9999).
PERSON_LEASE_EXPIRES = 253_402_300_799
#: The run's coordinate task (one per run, the coordinator's): its id and its role.
COORDINATE_TASK = 'coordinate'
COORDINATOR = 'coordinator'
#: An agent's index in its id (``<role>-<n>``): the runtime takes 0-999; a launch numbers them from 2, the run's start
#: having taken 1 for its coordinator.
MAX_AGENTS = 999


class BoardError(Refused):
    """A board operation refused: ``kind`` is not_found, conflict, forbidden, cap or invalid."""


@dataclass(frozen=True)
class Posted:
    task: Task
    created: bool


def spec_hash(role: str, parent_task: str, spec: Mapping[str, Any]) -> str:
    """Equal tasks (role, parent, spec) hash alike, whatever the spec's key order."""
    canonical = json.dumps([role, parent_task, spec], sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(canonical.encode()).hexdigest()[:32]


def _result_key(key: str, ws: str, run_id: str, agent: str, epoch: int) -> bool:
    """One of the agent's own workspace objects of the lease's attempt, short (it rides on every event)."""
    parsed = parse_agent_key(key) if len(key) <= MAX_KEY_LENGTH else None
    return parsed is not None and (parsed.ws, parsed.run_id, parsed.agent, parsed.attempt) == (ws, run_id, agent,
                                                                                                epoch)


@dataclass(frozen=True)
class Launched:
    """A launch's task, and whether its agent was recorded before (a retry, or a racing launch's)."""

    task: Task
    reused: bool


@dataclass(frozen=True)
class _Write:
    """One conditional update of a task row, and how to tell a retry that already took effect."""

    set_expr: str
    condition: str
    names: Mapping[str, str]
    values: Mapping[str, Any]
    already: Callable[[Task], bool]
    refusal: str


class BoardStore:
    def __init__(self, client: Any, table: str, *, new_id: Callable[[], str],
                 now: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        """``client`` is a low-level DynamoDB client; ``new_id`` mints task ids (ULIDs)."""
        self.client = client
        self.table = table
        self.now = now
        self.new_id = new_id

    def _get(self, key: Mapping[str, Any]) -> dict[str, Any] | None:
        return get_row(self.client, self.table, key)

    def run_exists(self, ws: str, run_id: str) -> bool:
        """The run's META row is there (the run's start writes it)."""
        return self._get({'pk': {'S': run_pk(ws, run_id)}, 'sk': {'S': 'META'}}) is not None

    def task(self, ws: str, run_id: str, task_id: str) -> Task:
        item = self._get(task_key(ws, run_id, task_id))
        if item is None:
            raise BoardError('not_found', 'no such task')
        return Task.from_item(item)

    def meta(self, ws: str, run_id: str) -> dict[str, Any] | None:
        """The run's META row (its caps, its commit and connection), or None for an unknown run."""
        return self._get({'pk': {'S': run_pk(ws, run_id)}, 'sk': {'S': 'META'}})

    def tasks(self, ws: str, run_id: str) -> list[Task]:
        """Every task of the run (at most its ``max_tasks``), in id order."""
        return [Task.from_item(item) for item in run_rows(self.client, self.table, ws, run_id, 'TASK#')]

    def post(self, ws: str, run_id: str, *, role: str, title: str, spec: Mapping[str, Any], parent_task: str,
             priority: int, actor: str) -> Posted:
        if role == COORDINATOR:
            raise BoardError('forbidden', "the coordinate task is the run start's, never posted")
        if not spec:
            raise BoardError('invalid', 'a task has a spec: what to do, which tells it apart from the run\'s others')
        if len(json.dumps(spec)) > MAX_SPEC_BYTES:
            raise BoardError('invalid', f'a task spec is at most {MAX_SPEC_BYTES} bytes: put the rest in S3')
        depth = 0
        if parent_task:
            depth = self.task(ws, run_id, parent_task).depth + 1
            if depth > MAX_DEPTH:
                raise BoardError('cap', f'tasks nest at most {MAX_DEPTH} deep')
        digest = spec_hash(role, parent_task, spec)
        task_id = self.new_id()
        pk = f'WS#{ws}#RUN#{run_id}'
        at = self.now().isoformat()
        item = {**task_key(ws, run_id, task_id), 'task_id': {'S': task_id}, 'role': {'S': role},
                'state': {'S': OPEN}, 'title': {'S': title}, 'spec': {'S': json.dumps(spec, sort_keys=True)},
                'spec_hash': {'S': digest}, 'depth': {'N': str(depth)}, 'priority': {'N': str(priority)},
                'attempt': {'N': '1'}, 'posted_by': {'S': actor}, 'updated_by': {'S': actor}, 'updated_at': {'S': at}}
        if parent_task:
            item['parent_task'] = {'S': parent_task}
        spec_key = {'pk': {'S': pk}, 'sk': {'S': f'SPEC#{digest}'}}
        marker: dict[str, Any] = {'ConditionExpression': 'attribute_not_exists(pk)'}
        for _ in range(2):   # (a second try only after the marker's task had ended)
            try:
                self.client.transact_write_items(TransactItems=[
                    {'Update': {'TableName': self.table, 'Key': {'pk': {'S': pk}, 'sk': {'S': 'META'}},
                                'UpdateExpression': 'ADD task_count :one',
                                'ConditionExpression': 'attribute_exists(max_tasks) AND (attribute_not_exists('
                                                       'task_count) OR task_count < max_tasks)',
                                'ExpressionAttributeValues': {':one': {'N': '1'}}}},
                    {'Put': {'TableName': self.table, **marker, 'Item': {**spec_key, 'task_id': {'S': task_id}}}},
                    {'Put': {'TableName': self.table, 'ConditionExpression': 'attribute_not_exists(pk)', 'Item': item}},
                    {'Put': {'TableName': self.table, 'ConditionExpression': 'attribute_not_exists(pk)',
                             'Item': Move(task_id, OPEN, actor, at, 1, 'post').item(ws, run_id)}},
                ])
            except ClientError as exc:
                if is_key_collision(exc, put_index=1):
                    named = (self._get(spec_key) or {}).get('task_id', {}).get('S', '')
                    existing = self.task(ws, run_id, named)
                    if existing.state not in FINAL:
                        return Posted(existing, created=False)
                    # The equal task has ended: this post is new work. The marker moves to it, only if it still
                    # names the ended task (a racing post that moved it first is answered on the next pass).
                    marker = {'ConditionExpression': 'task_id = :ended',
                              'ExpressionAttributeValues': {':ended': {'S': named}}}
                    continue
                self._refused_post(exc, pk)
                raise
            return Posted(Task.from_item(item), created=True)
        raise BoardError('conflict', 'an equal task was posted at the same time: read the board and retry')

    def _refused_post(self, exc: ClientError, pk: str) -> None:
        """Why the run refused a post, when it is its META row (index 0: the run exists, under its cap)."""
        if not is_key_collision(exc, put_index=0):
            return
        # is_key_collision only asks whether the reason at that index is ConditionalCheckFailed: index 0 is the
        # META row's update, not a put.
        meta = self._get({'pk': {'S': pk}, 'sk': {'S': 'META'}})
        if meta is None:
            raise BoardError('not_found', 'no such run') from exc
        if 'max_tasks' not in meta:
            raise BoardError('cap', 'the run has no task cap (its start sets one): nothing can be posted') from exc
        raise BoardError('cap', 'the run has reached its task cap') from exc

    def history(self, ws: str, run_id: str) -> dict[str, list[Move]]:
        """Every task's moves, oldest first (D1: the past is kept, never overwritten)."""
        moves: dict[str, list[Move]] = {}
        for item in run_rows(self.client, self.table, ws, run_id, 'TASKLOG#'):
            move = Move.from_item(item)
            moves.setdefault(move.task_id, []).append(move)
        return moves

    def _write(self, ws: str, run_id: str, task_id: str, write: _Write, log: Mapping[str, Any]) -> Task:
        """The task's conditional update and its history row, in one transaction; the task as it is after."""
        try:
            self.client.transact_write_items(TransactItems=[
                {'Update': {'TableName': self.table, 'Key': task_key(ws, run_id, task_id),
                            'UpdateExpression': write.set_expr,
                            'ConditionExpression': f'attribute_exists(pk) AND {write.condition}',
                            'ExpressionAttributeNames': dict(write.names),
                            'ExpressionAttributeValues': dict(write.values)}},
                {'Put': {'TableName': self.table, 'Item': dict(log), 'ConditionExpression': 'attribute_not_exists(pk)'}},
            ])
        except ClientError as exc:
            # The update's condition (index 0) or the same history row already there (index 1, the same move again).
            if not (is_key_collision(exc, put_index=0) or is_key_collision(exc, put_index=1)):
                raise
            current = self.task(ws, run_id, task_id)
            if write.already(current):
                return current
            raise BoardError('conflict', write.refusal) from exc
        return self.task(ws, run_id, task_id)

    def _update(self, ws: str, run_id: str, task_id: str, write: _Write) -> Task:
        """A renewal or a progress report: no history row (neither is a move), so a plain conditional
        update."""
        try:
            result = self.client.update_item(
                TableName=self.table, Key=task_key(ws, run_id, task_id), UpdateExpression=write.set_expr,
                ConditionExpression=f'attribute_exists(pk) AND {write.condition}',
                ExpressionAttributeNames=dict(write.names), ExpressionAttributeValues=dict(write.values),
                ReturnValues='ALL_NEW')
        except ClientError as exc:
            if not is_conditional_check_failure(exc):
                raise
            raise BoardError('conflict', write.refusal) from exc
        return Task.from_item(result['Attributes'])

    def claim(self, ws: str, run_id: str, task_id: str, *, role: str, agent: str) -> Task:
        current = self.task(ws, run_id, task_id)
        if current.role != role:
            raise BoardError('forbidden', f'a {current.role} task is not for a {role}')
        now = self.now()
        at = now.isoformat()
        # The coordinate task is claimed only by the coordinator recorded on it at its attempt, in the write's own
        # condition: a replaced coordinator never claims it, even when the re-post lands between its read and this.
        own = ' AND launched_agent = :agent AND launched_attempt = attempt' if role == COORDINATOR else ''
        return self._write(ws, run_id, task_id, _Write(
            set_expr='SET #state = :claimed, lease_agent = :agent, lease_epoch = attempt, lease_expires = :expires, '
                     'updated_by = :agent, updated_at = :at',
            condition=f'#state = :open AND #role = :role AND attempt = :attempt{own}',
            names={'#state': 'state', '#role': 'role'},
            values={':claimed': {'S': CLAIMED}, ':open': {'S': OPEN}, ':role': {'S': role}, ':agent': {'S': agent},
                    ':attempt': {'N': str(current.attempt)},
                    ':expires': {'N': str(int(now.timestamp()) + LEASE_S)}, ':at': {'S': at}},
            # The holder claiming again (a continuation with no saved brief): its lease, at the task's attempt.
            already=lambda t: (t.lease_agent == agent and t.lease_epoch == t.attempt and t.state not in FINAL
                               and t.state != OPEN),
            refusal='the task is not open'),
            Move(task_id, CLAIMED, agent, at, current.attempt, 'claim').item(ws, run_id))

    def coordinate_items(self, ws: str, run_id: str, *, at: str) -> list[dict[str, Any]]:
        """The run's coordinate task and its history row, as plain Python items (numbers as ``Decimal``) for the run's
        start transaction to put, each ``attribute_not_exists``: ``RunStore.start`` writes through the resource
        table's ``meta.client.transact_write_items``, which serializes them itself. Open, attempt 1, for the
        coordinator alone, and recorded as launched for ``coordinator-1`` at attempt 1, the run's first agent: the
        runtime's run start is to launch it and write META's ``agent_count`` 1 in the same transaction (voc-auto-b's
        next merge; in this tree the start writes neither), so a coordinator that dies before its claim is re-posted
        like any agent."""
        task: dict[str, Any] = {**task_key(ws, run_id, COORDINATE_TASK), 'task_id': {'S': COORDINATE_TASK},
                'role': {'S': COORDINATOR}, 'state': {'S': OPEN}, 'title': {'S': 'Coordinate the run'},
                'spec': {'S': json.dumps({'coordinate': True}, sort_keys=True)},
                'spec_hash': {'S': spec_hash(COORDINATOR, '', {'coordinate': True})}, 'depth': {'N': '0'},
                'priority': {'N': '0'}, 'attempt': {'N': '1'}, 'posted_by': {'S': 'run-start'},
                'updated_by': {'S': 'run-start'}, 'updated_at': {'S': at},
                'launched_agent': {'S': f'{COORDINATOR}-1'}, 'launched_attempt': {'N': '1'}, 'launched_paths': {'L': []},
                'launched_language': {'S': ''}}
        plain = TypeDeserializer()
        return [{name: plain.deserialize(value) for name, value in item.items()}
                for item in (task, Move(COORDINATE_TASK, OPEN, 'run-start', at, 1, 'start').item(ws, run_id))]

    def _next_agent(self, ws: str, run_id: str, role: str) -> str:
        """``<role>-<n>``: the run's next agent number (an atomic ``ADD`` on its META), 1 to ``MAX_AGENTS``."""
        try:
            answer = self.client.update_item(
                TableName=self.table, Key={'pk': {'S': run_pk(ws, run_id)}, 'sk': {'S': 'META'}},
                UpdateExpression='ADD agent_count :one',
                ConditionExpression='attribute_exists(pk) AND (attribute_not_exists(agent_count) OR agent_count < :max)',
                ExpressionAttributeValues={':one': {'N': '1'}, ':max': {'N': str(MAX_AGENTS)}},
                ReturnValues='UPDATED_NEW')
        except ClientError as exc:
            if not is_conditional_check_failure(exc):
                raise
            raise BoardError('cap', f'a run launches at most {MAX_AGENTS} agents') from exc
        return f'{role}-{int(answer["Attributes"]["agent_count"]["N"])}'

    def launch(self, ws: str, run_id: str, task_id: str, *, role: str, actor: str,
               paths: Sequence[str] = (), language: str = '') -> Launched:
        """Record the coordinator's launch of an agent for an open task of ``role``, at the task's attempt, with the
        ``paths`` and ``language`` it is launched with. A retry at the same attempt finds the agent recorded and
        reuses it (with its recorded paths and language); after a repost (a new attempt) the task gets a new ``<role>-<n>``."""
        current = self.task(ws, run_id, task_id)
        if current.role == COORDINATOR:
            raise BoardError('invalid', "the coordinate task's coordinator comes from the run, never from a launch")
        if current.role != role:
            raise BoardError('invalid', f'the task is a {current.role} task, not a {role} one to launch')
        return self._record_launch(ws, run_id, current, actor=actor, paths=paths, language=language)

    def launch_coordinator(self, ws: str, run_id: str, *, attempt: int, actor: str = 'runtime') -> Launched:
        """Record a new run coordinator for the run's coordinate task: the run's trusted code only (the runtime is to
        call it when a person's Resume takes a run whose coordinator is gone off its decision point, after re-posting
        the task at the attempt it judged), never a board op, so no agent can start a coordinator. Like ``launch``:
        the task open at ``attempt`` (the task's, the same fence as ``repost``), the next ``coordinator-<n>`` from
        META's ``agent_count``, and a retry at the same attempt reusing it. ``actor``: who the history row names
        (the person who resumed, when the caller knows). No paths and no language: the coordinator's are the run's."""
        current = self.task(ws, run_id, COORDINATE_TASK)
        if attempt != current.attempt:
            raise BoardError('conflict', f'the coordinate task is at attempt {current.attempt}, not {attempt}')
        return self._record_launch(ws, run_id, current, actor=actor, paths=(), language='')

    def _record_launch(self, ws: str, run_id: str, current: Task, *, actor: str, paths: Sequence[str],
                       language: str) -> Launched:
        task_id, role = current.task_id, current.role
        if current.state != OPEN:
            raise BoardError('conflict', 'only an open task gets an agent launched for it')
        if current.launched_agent and current.launched_attempt == current.attempt:
            return Launched(current, reused=True)   # (a retried launch: the same agent again)
        agent = self._next_agent(ws, run_id, role)
        at = self.now().isoformat()
        attempt = current.attempt
        task = self._write(ws, run_id, task_id, _Write(
            set_expr=('SET launched_agent = :agent, launched_attempt = :attempt, launched_paths = :paths, '
                      'launched_language = :language'),
            condition='#state = :open AND attempt = :attempt AND '
                      '(attribute_not_exists(launched_attempt) OR launched_attempt <> :attempt)',
            names={'#state': 'state'},
            values={':agent': {'S': agent}, ':open': {'S': OPEN}, ':attempt': {'N': str(attempt)},
                    ':paths': {'L': [{'S': path} for path in paths]}, ':language': {'S': language}},
            # A launch racing this one recorded its agent at this attempt first: that one is the task's.
            already=lambda t: t.state == OPEN and bool(t.launched_agent) and t.launched_attempt == attempt,
            refusal='the task is no longer open at this attempt'),
            Move(task_id, OPEN, actor, at, attempt, 'launch', reason=f'launched {agent}').item(ws, run_id))
        return Launched(task, reused=task.launched_agent != agent)

    def _holder(self, agent: str, epoch: int, now: datetime) -> tuple[str, dict[str, Any]]:
        """The lease holder, with the lease's epoch, before the lease runs out (the supervisor re-posts it then), or
        while it waits: an agent suspended on an open wait cannot renew, and keeps its lease while the wait is open
        (plan v3, 4.5), so it can renew, report (``waiting: false``) and move once it resumes."""
        return ('lease_agent = :agent AND lease_epoch = :epoch AND (lease_expires >= :now OR waiting = :waiting)',
                {':agent': {'S': agent}, ':epoch': {'N': str(epoch)}, ':now': {'N': str(int(now.timestamp()))},
                 ':waiting': {'BOOL': True}})

    def _live_holder(self, agent: str, epoch: int, now: datetime) -> tuple[str, dict[str, Any]]:
        """The lease holder (``_holder``) on a task that has not ended."""
        holder, values = self._holder(agent, epoch, now)
        final = {f':final{index}': {'S': state} for index, state in enumerate(sorted(FINAL))}
        return f'{holder} AND NOT #state IN ({", ".join(final)})', {**values, **final}

    def renew(self, ws: str, run_id: str, task_id: str, *, agent: str, epoch: int) -> Task:
        """The heartbeat: the lease runs ``LEASE_S`` more seconds."""
        now = self.now()
        condition, values = self._live_holder(agent, epoch, now)
        return self._update(ws, run_id, task_id, _Write(
            set_expr='SET lease_expires = :expires', condition=condition, names={'#state': 'state'},
            values={**values, ':expires': {'N': str(int(now.timestamp()) + LEASE_S)}},
            already=lambda _task: False, refusal='the lease is not yours, has run out, or the task has ended'))

    def refresh(self, ws: str, run_id: str, task_id: str, *, agent: str, epoch: int) -> Task:
        """The supervisor's renewal of a holder's lease before it continues the agent (a person's pause resumed, a
        slow continuation's boot): the lease runs ``LEASE_S`` more seconds even if it ran out meanwhile, for that
        agent at that epoch, on a task that is neither open nor ended. A heartbeat, so no history row; a task that
        moved on (re-posted, ended) refuses it, and the supervisor ends the session."""
        now = self.now()
        ended = {f':final{index}': {'S': state} for index, state in enumerate(sorted(FINAL))}
        return self._update(ws, run_id, task_id, _Write(
            set_expr='SET lease_expires = :expires',
            condition=f'lease_agent = :agent AND lease_epoch = :epoch AND NOT #state IN (:open, {", ".join(ended)})',
            names={'#state': 'state'},
            values={**ended, ':agent': {'S': agent}, ':epoch': {'N': str(epoch)}, ':open': {'S': OPEN},
                    ':expires': {'N': str(int(now.timestamp()) + LEASE_S)}},
            already=lambda _task: False, refusal='the task moved on: its lease is not this agent\'s at this epoch'))

    def progress(self, ws: str, run_id: str, task_id: str, *, agent: str, epoch: int, step: str,
                 waiting: bool) -> Task:
        """The holder's progress report: when, its step (a line, credential shapes redacted), whether it waits."""
        line = redact(step.strip())
        if not line or len(line) > MAX_LINE:
            raise BoardError('invalid', f'"step" is a line of 1 to {MAX_LINE} characters')
        now = self.now()
        condition, values = self._live_holder(agent, epoch, now)
        return self._update(ws, run_id, task_id, _Write(
            set_expr='SET progress_at = :at, step = :step, waiting = :waiting', condition=condition,
            names={'#state': 'state'},
            values={**values, ':at': {'N': str(int(now.timestamp()))}, ':step': {'S': line},
                    ':waiting': {'BOOL': waiting}},
            already=lambda _task: False, refusal='the lease is not yours, has run out, or the task has ended'))

    def repost(self, ws: str, run_id: str, task_id: str, *, reason: str, attempt: int | None = None) -> Task:
        """The supervisor's re-post of the task at the ``attempt`` it judged (crashed, stalled, its lease run out):
        ``open`` again at the next attempt, the lease cleared, its reason in the history row. Only at that attempt,
        so a retried re-post never revokes the claim a new agent made meanwhile (a later attempt), and two re-posts
        never both apply. Pass it: without it (a caller from before it, ``None``) the attempt read now is taken,
        which cannot tell a retry from a newer claim. An open task is re-posted only when an agent was launched for
        it at this attempt and never claimed it (it died or stalled first): the next attempt gets a new agent."""
        current = self.task(ws, run_id, task_id)
        unclaimed = current.state == OPEN and bool(current.launched_agent) and current.launched_attempt == current.attempt
        if attempt is None:
            if current.state == OPEN and current.attempt > 1 and not unclaimed:
                return current   # (a re-post landed already: its retry publishes the same event again)
            attempt = current.attempt
        if current.state == OPEN and current.attempt == attempt + 1:
            return current   # (this re-post landed already: a retry after a lost answer)
        if (current.state == OPEN and not unclaimed) or current.state in FINAL:
            raise BoardError('conflict', f'a {current.state} task is not re-posted')
        if current.attempt != attempt:
            raise BoardError('conflict', f'the task is at attempt {current.attempt}, not the {attempt} judged')
        if current.lease_agent.startswith(PERSON_PREFIX):
            raise BoardError('conflict', 'a person holds the task: it is theirs until they move it')
        at = self.now().isoformat()
        why = redact(reason.strip())[:MAX_LINE]
        ended = {f':final{index}': {'S': state} for index, state in enumerate(sorted(FINAL))}
        return self._write(ws, run_id, task_id, _Write(
            # The last attempt's progress goes with its lease: the next holder starts with none, never stalled.
            set_expr='SET #state = :open, attempt = attempt + :one, waiting = :no, updated_by = :actor, '
                     'updated_at = :at REMOVE lease_agent, lease_epoch, lease_expires, progress_at, step',
            # Never a task a person took (their lease, held in the write too: a take between the read and this).
            condition=(f'attempt = :attempt AND (NOT #state IN (:open, {", ".join(ended)}) '
                       'OR (#state = :open AND launched_attempt = :attempt)) '
                       'AND (attribute_not_exists(lease_agent) OR NOT begins_with(lease_agent, :person))'),
            names={'#state': 'state'},
            values={**ended, ':open': {'S': OPEN}, ':one': {'N': '1'}, ':no': {'BOOL': False}, ':person': {'S': PERSON_PREFIX},
                    ':actor': {'S': 'supervisor'}, ':at': {'S': at}, ':attempt': {'N': str(attempt)}},
            # Another re-post of the same attempt landed between the read and the write.
            already=lambda t: t.state == OPEN and t.attempt == attempt + 1,
            refusal='the task moved on since it was read'),
            Move(task_id, OPEN, 'supervisor', at, attempt + 1, 'repost', reason=why).item(ws, run_id))

    # ---- a person's board actions (the Agents API's, admins acting for themselves; plan v3 4.3) --------------------

    def _person_read(self, ws: str, run_id: str, task_id: str, actor: str) -> Task:
        """The task a person acts on: never the coordinate task (the run's own), never as an agent's id."""
        if not actor.startswith(PERSON_PREFIX):
            raise BoardError('invalid', f'a person acts as {PERSON_PREFIX}<their id>')
        current = self.task(ws, run_id, task_id)
        if current.task_id == COORDINATE_TASK:
            raise BoardError('forbidden', "the coordinate task is the run coordinator's: signal the run instead")
        return current

    def _person_write(self, ws: str, run_id: str, current: Task, *, op: str, actor: str, set_expr: str,
                      values: Mapping[str, Any], to_state: str | None, reason: str,
                      done: Callable[[Task], bool], remove: str = '', pin_holder: bool = False) -> Task:
        """A person's change of ``current`` (as read), with its history row naming them; ``to_state`` None keeps the
        state. ``done``: the change is already there (a retry), so it is answered as it is and writes nothing. Else
        the task must not have ended, and the write holds the state and attempt it read (a move in between, an agent's
        or a re-post, refuses it: never undone)."""
        if done(current):
            return current
        if current.state in FINAL:
            raise BoardError('conflict', 'the task has ended')
        at = self.now().isoformat()
        # ``pin_holder``: the lease holder read holds too (a take or block: one made since, by anyone, refuses it).
        holder = {':held_was': {'S': current.lease_agent}} if pin_holder and current.lease_agent else {}
        held = ('' if not pin_holder else
                ' AND lease_agent = :held_was' if current.lease_agent else ' AND attribute_not_exists(lease_agent)')
        return self._write(ws, run_id, current.task_id, _Write(
            set_expr=f'SET {set_expr}, updated_by = :actor, updated_at = :at' + (f' REMOVE {remove}' if remove else ''),
            condition=f'#state = :was AND attempt = :attempt{held}', names={'#state': 'state'},
            values={**values, **holder, ':was': {'S': current.state}, ':actor': {'S': actor}, ':at': {'S': at},
                    ':attempt': {'N': str(current.attempt)}},
            already=done, refusal='the task has ended or moved on since it was read: read the board again'),
            Move(current.task_id, to_state or current.state, actor, at, current.attempt, op,
                 reason=reason).item(ws, run_id))

    def reprioritise(self, ws: str, run_id: str, task_id: str, *, priority: int, actor: str) -> Task:
        """A person changes the priority of a task that has not ended (its state as it is)."""
        if isinstance(priority, bool) or abs(priority) > MAX_PRIORITY:
            raise BoardError('invalid', f'a priority is a whole number of at most {MAX_PRIORITY} either way')
        current = self._person_read(ws, run_id, task_id, actor)
        return self._person_write(ws, run_id, current, op='priority', actor=actor, set_expr='priority = :priority',
                                  values={':priority': {'N': str(priority)}}, to_state=None,
                                  reason=f'priority {priority}',
                                  done=lambda t: t.priority == priority and t.state not in FINAL)

    @staticmethod
    def _hold_check(current: Task, actor: str, over: bool) -> None:
        """Another person's hold is ended (taken or blocked) only when ``over`` asks for it."""
        held_by_another = current.lease_agent.startswith(PERSON_PREFIX) and current.lease_agent != actor
        if held_by_another and not over and current.state not in FINAL:
            raise BoardError('conflict', 'another person holds the task: take it over only if you mean to')

    def block(self, ws: str, run_id: str, task_id: str, *, reason: str, actor: str, over: bool = False) -> Task:
        """A person stops a task that has not ended: it needs a person (``needs_human``), with their reason; its
        holder's lease is cleared, so the agent on it can move it no more. Another person's hold is ended only when
        ``over`` asks for it (the write holds the holder read, as a take's does)."""
        why = redact(reason.strip())[:MAX_LINE]
        if not why:
            raise BoardError('invalid', 'a block says why (a line)')
        current = self._person_read(ws, run_id, task_id, actor)
        self._hold_check(current, actor, over)
        return self._person_write(
            ws, run_id, current, op='block', actor=actor, to_state=NEEDS_HUMAN, reason=why,
            # (the reason is the history row's: a block is a move, D1)
            set_expr='#state = :blocked', remove='lease_agent, lease_epoch, lease_expires, waiting',
            values={':blocked': {'S': NEEDS_HUMAN}},
            # Their own block, retried: one an agent's move or another person made is the task having ended (409).
            done=lambda t: t.state == NEEDS_HUMAN and t.updated_by == actor, pin_holder=True)

    def take(self, ws: str, run_id: str, task_id: str, *, actor: str, over: bool = False) -> Task:
        """A person takes a task that has not ended: they hold it from now, with no expiry (``lease_expires`` the
        largest a lease takes), at its attempt, so its agent can move it no more and the supervisor, which judges
        agents' sessions, leaves it alone; they move it on like any holder (``move`` with their id and the attempt).
        An open task is claimed by them; one under way keeps its state. Another person's hold is taken over only
        when ``over`` asks for it (the write holds the state read, so a hold made since is refused too)."""
        current = self._person_read(ws, run_id, task_id, actor)
        self._hold_check(current, actor, over)
        state = CLAIMED if current.state == OPEN else current.state
        return self._person_write(
            ws, run_id, current, op='take', actor=actor, to_state=state, reason='taken by a person',
            set_expr=('#state = :held, lease_agent = :actor, lease_epoch = attempt, lease_expires = :forever, '
                      'waiting = :no'),
            values={':held': {'S': state}, ':forever': {'N': str(PERSON_LEASE_EXPIRES)}, ':no': {'BOOL': False}},
            done=lambda t: t.lease_agent == actor and t.lease_epoch == t.attempt and t.state not in FINAL,
            pin_holder=True)

    def move(self, ws: str, run_id: str, task_id: str, *, agent: str, epoch: int, to_state: str,
             result_keys: Sequence[object]) -> Task:
        """The holder moves its task on; ``result_keys`` (S3 keys under its own prefix) are added to the task."""
        sources = sorted(state for state, targets in MOVES.items() if to_state in targets)
        if not sources:
            raise BoardError('invalid', f'a task cannot be moved to {to_state!r}')
        own = sorted({key for key in result_keys if isinstance(key, str)})
        if any(not isinstance(key, str) for key in result_keys) or not all(
                _result_key(key, ws, run_id, agent, epoch) for key in own):
            raise BoardError('invalid', f'result keys are your own workspace objects of attempt-{epoch} '
                                        f'(engineering/workspace/layout.py), at most {MAX_KEY_LENGTH} characters')
        room, keys = '', {}
        if own:
            # The read names the cap in the refusal; the write's own condition holds it against a racing move (the
            # keys new to the read must fit beside what is stored when the write lands).
            current = self.task(ws, run_id, task_id)
            new = set(own) - set(current.result_keys)
            held = current.lease_agent == agent and current.lease_epoch == epoch
            if held and len(current.result_keys) + len(new) > MAX_RESULT_KEYS:
                raise BoardError('cap', f'a task keeps at most {MAX_RESULT_KEYS} result keys: put a manifest in S3')
            room = ' AND (attribute_not_exists(result_keys) OR size(result_keys) <= :room)'
            keys = {':keys': {'SS': own}, ':room': {'N': str(MAX_RESULT_KEYS - len(new))}}
        now = self.now()
        at = now.isoformat()
        holder, values = self._holder(agent, epoch, now)
        from_names = {f':from{index}': {'S': state} for index, state in enumerate(sources)}
        add = ' ADD result_keys :keys' if own else ''
        return self._write(ws, run_id, task_id, _Write(
            set_expr='SET #state = :to, updated_by = :agent, updated_at = :at' + add,
            condition=f'{holder} AND #state IN ({", ".join(from_names)}){room}', names={'#state': 'state'},
            values={**values, **from_names, **keys, ':to': {'S': to_state}, ':at': {'S': at}},
            # A retry that took effect: the same move, its keys already kept (a move adding keys is not a retry).
            already=lambda t: (t.state == to_state and t.lease_agent == agent and t.lease_epoch == epoch
                               and set(own) <= set(t.result_keys)),
            refusal='the lease is not yours, has run out, or the task cannot move from its state'),
            Move(task_id, to_state, agent, at, epoch, 'move', tuple(own)).item(ws, run_id))
