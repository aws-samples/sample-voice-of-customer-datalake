"""voc-engineering-delivery: a message the inbox router addressed to an agent, the run's conductor or a role of the
run lands in that run's inbox, and its addressees are woken to read it.

The router (``bus/router.py``) is to invoke this function asynchronously with ``{"message": <voc-msg/1>, "seq": N}``
once the message is in the run's conversation (N: its place there; today it still sends the bare message). Each
message is recorded ONCE, as ``WS#<ws>#RUN#<run>`` / ``INBOX#<addressee>#<inbox_seq:012d>#<event_id>`` in
voc-engineering. ``inbox_seq`` is the run's write-order counter (``inbox_seq`` on its META, taken just before the
write), not the conversation's seq, which the row keeps as ``seq``: a delivery retried a minute later gets a number
above every notice already read. The number is taken, then the row written: two deliveries at once can commit out
of order by a moment, and a number can go unused (a redelivery's race, a crash between the two steps), so a reader
takes the numbers as a near order, not a log: it re-reads a window behind its cursor at the tail (the board's
``inbox`` op: 20 numbers) and keeps each message once by its event id. A marker, ``INBOXEVT#<event_id>``, written in
the same transaction as the row, makes it once: a redelivery (the bus is at-least-once) writes nothing. The addressee is
``agent:<agent>``, ``conductor``, or ``role:<role>`` for a posted task (every agent of that role in the run reads it).
Nothing deletes an inbox row or marks it read: the board API's ``inbox`` op reads them for the caller's own run
only, after an ``inbox_seq`` cursor, and the harness keeps each message once by its event id.

There is no queue: a suspended MicroVM runs no code, so delivery is a push (``Supervisor.wake``): a working agent's
MicroVM is resumed and kept awake to read it, an agent held without a MicroVM on a long wait is continued in a new
one, and a booting or pausing one reads its inbox once it runs. An addressee another move holds is ``busy``: the
invocation fails, and Lambda's own retry (twice) delivers again; the row is already there, so only the wake repeats.
It runs as the supervisor (its role and its code, ``handler.delivery_handler``), which alone resumes and continues
MicroVMs. A deployment has one workspace (``connectors/identity.py`` WORKSPACE): a message of another is refused.
"""
from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from typing import Any, Final

from botocore.exceptions import ClientError

from engineering.bus.schema import Message, MessageError, parse
from engineering.connectors.identity import WORKSPACE
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.runs import meta_key, run_pk
from engineering.runtime.sessions import AgentSession
from engineering.runtime.supervisor import Supervisor
from shared.aws import consistent_item, is_conditional_check_failure
from shared.ids import is_key_collision

INBOX: Final = 'INBOX#'
#: The once-per-event marker beside a run's inbox rows.
MARKER: Final = 'INBOXEVT#'


class AddresseeBusy(RuntimeError):
    """Another move holds an addressee: the invocation fails so Lambda delivers again (the row is kept)."""


def addressee(message: Message) -> str:
    """Whose inbox the message is for: one agent, the run's conductor, or the agents of a role (a posted task)."""
    kind = message.to.kind
    if kind == 'agent':
        return f'agent:{message.to.id}'
    if kind == 'conductor':
        return 'conductor'
    if kind == 'role' and message.type == 'task.posted':
        return f'role:{message.to.id}'
    raise RuntimeRefused(f'a message to {kind} has no inbox')


def inbox_item(message: Message, seq: int, inbox_seq: int, now: int) -> dict[str, Any]:
    """The inbox row (agreed with the board's ``inbox`` op: keep the two in step): under its write-order number,
    with the conversation's seq beside it."""
    item: dict[str, Any] = {
        'pk': run_pk(message.run_id),
        'sk': f'{INBOX}{addressee(message)}#{inbox_seq:012d}#{message.event_id}',
        'event_id': message.event_id, 'inbox_seq': inbox_seq, 'seq': seq, 'type': message.type,
        'from_kind': message.sender.kind, 'from_id': message.sender.id, 'summary': message.summary,
        'refs': json.dumps(message.to_dict()['refs'], separators=(',', ':'), sort_keys=True), 'at': now,
    }
    if message.task_id:
        item['task_id'] = message.task_id
    return item


def _seq(event: Mapping[str, Any]) -> int:
    """The message's place in the conversation, which the router always passes (a redelivery keeps it): the row
    keeps it beside its write-order number, so a reader can show the conversation's order."""
    seq = event.get('seq')
    if isinstance(seq, bool) or not isinstance(seq, int) or seq < 0:
        raise RuntimeRefused('seq is the message\'s place in the conversation, a whole number')
    return seq


def record(table: Any, message: Message, seq: int, now: int) -> bool:
    """Write the message's inbox row once; whether it is new (False: a redelivery, nothing written)."""
    pk = run_pk(message.run_id)
    marker = {'pk': pk, 'sk': f'{MARKER}{message.event_id}'}
    if consistent_item(table, marker) is not None:
        return False  # a redelivery: no counter taken
    try:
        inbox_seq = int(table.update_item(
            Key=meta_key(message.run_id), UpdateExpression='ADD inbox_seq :one',
            ConditionExpression='attribute_exists(pk)', ExpressionAttributeValues={':one': 1},
            ReturnValues='UPDATED_NEW')['Attributes']['inbox_seq'])
    except ClientError as error:
        if is_conditional_check_failure(error):
            raise RuntimeRefused(f'run {message.run_id} has no META: no inbox') from error
        raise
    item = inbox_item(message, seq, inbox_seq, now)
    try:
        table.meta.client.transact_write_items(TransactItems=[
            {'Put': {'TableName': table.name, 'ConditionExpression': 'attribute_not_exists(sk)',
                     'Item': {**marker, 'inbox_seq': inbox_seq, 'addressee': addressee(message)}}},
            {'Put': {'TableName': table.name, 'Item': item, 'ConditionExpression': 'attribute_not_exists(sk)'}},
        ])
    except ClientError as error:
        if is_key_collision(error, put_index=0):
            return False  # a redelivery raced this one: its counter is a gap
        raise
    return True


def is_addressee(message: Message) -> Callable[[AgentSession], bool]:
    """Whether a session of the run is one the message wakes: the agent, or the coordinator (the conductor). A
    posted task (to a role) wakes nobody: an agent is launched for its task, so none of the role is idle, and one
    held on its wait must keep its one continuation for the message it waits for; the row is there to read."""
    if message.to.kind == 'agent':
        return lambda session: session.agent_id == message.to.id
    if message.to.kind == 'conductor':
        return lambda session: session.role == 'coordinator'
    return lambda _session: False


def deliver(event: Mapping[str, Any], *, table: Any, supervisor: Supervisor, now: int) -> dict[str, Any]:
    """Record the message in its run's inbox, then wake its addressees; ``AddresseeBusy`` asks for a retry."""
    try:
        message = parse(event.get('message'))
    except MessageError as error:
        # Never the message itself: the router wrote it to the conversation; a malformed one is the caller's bug.
        raise RuntimeRefused(f'not a voc-msg/1 message: {error}') from error
    if message.ws != WORKSPACE:
        raise RuntimeRefused('a message of another workspace')
    seq = _seq(event)
    new = record(table, message, seq, now)
    woken = supervisor.wake(message.run_id, is_addressee(message), now)
    busy = sorted(agent for agent, status in woken.items() if status == 'busy')
    if busy:
        raise AddresseeBusy(f'{len(busy)} addressee(s) busy: delivered again')
    return {'event_id': message.event_id, 'recorded': new, 'woken': woken}

