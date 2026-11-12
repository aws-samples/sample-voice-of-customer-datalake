"""The board's writes, each one conditional (plan v3, 4.3; I6: state is the record, events are notifications).

- ``post``: one transaction counts the task on the run's ``META`` row (which must exist and be under its
  ``max_tasks`` cap), writes a ``SPEC#<hash>`` marker (an equivalent task already posted is answered, not posted
  twice) and the ``TASK#`` row; the depth below its parent is capped.
- ``claim``: only an ``open`` task of the caller's role; the lease's epoch is the task's attempt.
- ``renew`` (the heartbeat) and ``move``: only the lease holder with the lease's epoch, before the lease runs out, so
  an agent whose lease was lost cannot act on the task again. The supervisor re-posts an expired task on its own row
  (``open`` again, ``attempt + 1``, a later item), not through ``post``, so the ``SPEC#`` dedupe does not stand in
  its way, and the next claim's lease takes the new attempt as its epoch.
- A task keeps at most ``MAX_RESULT_KEYS`` result keys, which every board event about it carries. A repeated claim
  or move that already took effect answers the task as it is (callers retry after a lost answer).
- History (D1, D4): the ``TASK#`` row is the task now; each post, claim and move also writes, in the same
  transaction, a ``TASKLOG#<task>#<at>#<state>`` row (create-only) with who made it and how, so no past state is
  overwritten. A renewal is not a move and writes none.
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
from engineering.rows import get_row, run_pk, run_rows
from engineering.workspace.layout import parse_agent_key
from shared.aws import is_conditional_check_failure
from shared.ids import is_key_collision

LEASE_S = 300
MAX_DEPTH = 3
MAX_SPEC_BYTES = 8 * 1024
#: A task's result keys ride on its board events: 16 keys of 512 characters stay well inside an event's 16 KB.
MAX_RESULT_KEYS = 16
MAX_KEY_LENGTH = 512


class BoardError(Exception):
    """A board operation refused: ``kind`` is not_found, conflict, forbidden, cap or invalid."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


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
        try:
            self.client.transact_write_items(TransactItems=[
                {'Update': {'TableName': self.table, 'Key': {'pk': {'S': pk}, 'sk': {'S': 'META'}},
                            'UpdateExpression': 'ADD task_count :one',
                            'ConditionExpression': 'attribute_exists(max_tasks) AND (attribute_not_exists(task_count) '
                                                   'OR task_count < max_tasks)',
                            'ExpressionAttributeValues': {':one': {'N': '1'}}}},
                {'Put': {'TableName': self.table, 'ConditionExpression': 'attribute_not_exists(pk)',
                         'Item': {**spec_key, 'task_id': {'S': task_id}}}},
                {'Put': {'TableName': self.table, 'ConditionExpression': 'attribute_not_exists(pk)', 'Item': item}},
                {'Put': {'TableName': self.table, 'ConditionExpression': 'attribute_not_exists(pk)',
                         'Item': Move(task_id, OPEN, actor, at, 1, 'post').item(ws, run_id)}},
            ])
        except ClientError as exc:
            if is_key_collision(exc, put_index=1):
                marker = self._get(spec_key) or {}
                return Posted(self.task(ws, run_id, marker.get('task_id', {}).get('S', '')), created=False)
            # is_key_collision only asks whether the reason at that index is ConditionalCheckFailed: index 0 is the
            # META row's update (the run exists, under its cap), not a put.
            if is_key_collision(exc, put_index=0):
                meta = self._get({'pk': {'S': pk}, 'sk': {'S': 'META'}})
                if meta is None:
                    raise BoardError('not_found', 'no such run') from exc
                if 'max_tasks' not in meta:
                    raise BoardError('cap', 'the run has no task cap (its start sets one): nothing can be posted') \
                        from exc
                raise BoardError('cap', 'the run has reached its task cap') from exc
            raise
        return Posted(Task.from_item(item), created=True)

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

    def _renew(self, ws: str, run_id: str, task_id: str, write: _Write) -> Task:
        """The lease renewal: no history row (a heartbeat is not a move), so a plain conditional update."""
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
        """The lease holder, with the lease's epoch, before the lease runs out (the supervisor re-posts it then)."""
        return ('lease_agent = :agent AND lease_epoch = :epoch AND lease_expires >= :now',
                {':agent': {'S': agent}, ':epoch': {'N': str(epoch)}, ':now': {'N': str(int(now.timestamp()))}})

    def renew(self, ws: str, run_id: str, task_id: str, *, agent: str, epoch: int) -> Task:
        """The heartbeat: the lease runs ``LEASE_S`` more seconds."""
        now = self.now()
        holder, values = self._holder(agent, epoch, now)
        final = {f':final{index}': {'S': state} for index, state in enumerate(sorted(FINAL))}
        return self._renew(ws, run_id, task_id, _Write(
            set_expr='SET lease_expires = :expires', condition=f'{holder} AND NOT #state IN ({", ".join(final)})',
            names={'#state': 'state'},
            values={**values, **final, ':expires': {'N': str(int(now.timestamp()) + LEASE_S)}},
            already=lambda _task: False, refusal='the lease is not yours, has run out, or the task has ended'))

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
