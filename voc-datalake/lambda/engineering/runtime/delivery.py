"""voc-engineering-delivery: a message the inbox router addressed to an agent, the run's conductor or a role of the
run lands in that run's inbox, and its addressees are woken to read it.

The router (``bus/router.py``) is to invoke this function asynchronously with ``{"message": <voc-msg/1>, "seq": N}``
once the message is in the run's conversation (N: its place there; today it still sends the bare message). Each message is recorded ONCE, as
``WS#<ws>#RUN#<run>`` / ``INBOX#<addressee>#<seq:012d>#<event_id>`` in voc-engineering, with a conditional put, so
a redelivery (the bus is at-least-once; the router keeps the message's seq) writes nothing. The addressee is
``agent:<agent>``, ``conductor``, or ``role:<role>`` for a posted task (every agent of that role in the run reads it).
Nothing deletes an inbox row or marks it read: the board API's ``inbox`` op (not built yet) is to read them for
the caller's own run only, after a seq cursor, and the harness keeps each message once by its event id.

There is no queue: a suspended MicroVM runs no code, so delivery is a push (``Supervisor.wake``): a working agent's
MicroVM is resumed and kept awake to read it, an agent held without a MicroVM on a long wait is continued in a new
one, and a booting or pausing one reads its inbox once it runs. An addressee another move holds is ``busy``: the
invocation fails, and Lambda's own retry (twice) delivers again; the row is already there, so only the wake repeats.
It runs the supervisor's code (``handler.delivery_handler``) with a role of its own (lib/stacks/engineering-runtime.ts
createDelivery): only what a wake needs, the runs' rows, resuming and continuing MicroVMs and the launcher's
AssumeRole; never the supervisor's rule or the registry of active runs. A deployment has one workspace (``connectors/identity.py`` WORKSPACE): a message of another is refused.
"""
from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from typing import Any, Final

from botocore.exceptions import ClientError

from engineering.bus.schema import Message, MessageError, parse
from engineering.connectors.identity import WORKSPACE
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.runs import run_pk
from engineering.runtime.sessions import AgentSession
from engineering.runtime.supervisor import Supervisor
from shared.aws import is_conditional_check_failure

INBOX: Final = 'INBOX#'


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


def inbox_item(message: Message, seq: int, now: int) -> dict[str, Any]:
    """The inbox row (agreed with the board's ``inbox`` op: keep the two in step)."""
    item: dict[str, Any] = {
        'pk': run_pk(message.run_id),
        'sk': f'{INBOX}{addressee(message)}#{seq:012d}#{message.event_id}',
        'event_id': message.event_id, 'seq': seq, 'type': message.type,
        'from_kind': message.sender.kind, 'from_id': message.sender.id, 'summary': message.summary,
        'refs': json.dumps(message.to_dict()['refs'], separators=(',', ':'), sort_keys=True), 'at': now,
    }
    if message.task_id:
        item['task_id'] = message.task_id
    return item


def _seq(event: Mapping[str, Any]) -> int:
    """The message's place in the conversation, which the router always passes (a redelivery keeps it): without it
    a redelivery would land under another key, which the conditional put could not catch."""
    seq = event.get('seq')
    if isinstance(seq, bool) or not isinstance(seq, int) or seq < 0:
        raise RuntimeRefused('seq is the message\'s place in the conversation, a whole number')
    return seq


def record(table: Any, message: Message, seq: int, now: int) -> bool:
    """Write the message's inbox row once; whether it is new (False: a redelivery, nothing written)."""
    try:
        table.put_item(Item=inbox_item(message, seq, now), ConditionExpression='attribute_not_exists(sk)')
    except ClientError as error:
        if is_conditional_check_failure(error):
            return False
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

