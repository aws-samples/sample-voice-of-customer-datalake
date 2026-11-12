"""The board's writes, each one conditional (plan v3, 4.3; I6: state is the record, events are notifications).

- ``post``: one transaction counts the task on the run's ``META`` row (which must exist and be under its
  ``max_tasks`` cap), writes a ``SPEC#<hash>`` marker (an equivalent task still under way is answered, not posted
  twice) and the ``TASK#`` row; the depth below its parent is capped. A marker whose task has ended (done, failed,
  needs a human) is moved to the new task, conditionally on the task it named, so the same work can be posted again
  once the first ended (nothing is deleted, D5).
- ``claim``: only an ``open`` task of the caller's role; the lease's epoch is the task's attempt.
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

from botocore.exceptions import ClientError

from engineering.board.model import CLAIMED, FINAL, MOVES, OPEN, Move, Task, task_key
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

    def tasks(self, ws: str, run_id: str) -> list[Task]:
        """Every task of the run (at most its ``max_tasks``), in id order."""
        return [Task.from_item(item) for item in run_rows(self.client, self.table, ws, run_id, 'TASK#')]

    def post(self, ws: str, run_id: str, *, role: str, title: str, spec: Mapping[str, Any], parent_task: str,
             priority: int, actor: str) -> Posted:
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
        return self._write(ws, run_id, task_id, _Write(
            set_expr='SET #state = :claimed, lease_agent = :agent, lease_epoch = attempt, lease_expires = :expires, '
                     'updated_by = :agent, updated_at = :at',
            condition='#state = :open AND #role = :role AND attempt = :attempt',
            names={'#state': 'state', '#role': 'role'},
            values={':claimed': {'S': CLAIMED}, ':open': {'S': OPEN}, ':role': {'S': role}, ':agent': {'S': agent},
                    ':attempt': {'N': str(current.attempt)},
                    ':expires': {'N': str(int(now.timestamp()) + LEASE_S)}, ':at': {'S': at}},
            already=lambda t: t.state == CLAIMED and t.lease_agent == agent, refusal='the task is not open'),
            Move(task_id, CLAIMED, agent, at, current.attempt, 'claim').item(ws, run_id))

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

    def repost(self, ws: str, run_id: str, task_id: str, *, reason: str) -> Task:
        """The supervisor's re-post of a task whose lease ran out: ``open`` again at the next attempt, the lease
        cleared, its reason in the history row. Only from the attempt read, so two re-posts never both apply."""
        current = self.task(ws, run_id, task_id)
        if current.state == OPEN or current.state in FINAL:
            raise BoardError('conflict', f'a {current.state} task is not re-posted')
        at = self.now().isoformat()
        why = redact(reason.strip())[:MAX_LINE]
        ended = {f':final{index}': {'S': state} for index, state in enumerate(sorted(FINAL))}
        return self._write(ws, run_id, task_id, _Write(
            # The last attempt's progress goes with its lease: the next holder starts with none, never stalled.
            set_expr='SET #state = :open, attempt = attempt + :one, waiting = :no, updated_by = :actor, '
                     'updated_at = :at REMOVE lease_agent, lease_epoch, lease_expires, progress_at, step',
            condition=f'attempt = :attempt AND NOT #state IN (:open, {", ".join(ended)})',
            names={'#state': 'state'},
            values={**ended, ':open': {'S': OPEN}, ':one': {'N': '1'}, ':no': {'BOOL': False},
                    ':actor': {'S': 'supervisor'}, ':at': {'S': at}, ':attempt': {'N': str(current.attempt)}},
            # Another re-post of the same attempt landed between the read and the write.
            already=lambda t: t.state == OPEN and t.attempt == current.attempt + 1,
            refusal='the task moved on since it was read'),
            Move(task_id, OPEN, 'supervisor', at, current.attempt + 1, 'repost', reason=why).item(ws, run_id))

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
