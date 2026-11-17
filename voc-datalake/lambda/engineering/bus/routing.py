"""Where a message goes after the router has written it to the run's conversation: a posted task (for its role) and a
message for an agent or the run conductor to the delivery function, which records the notice in the run's partition
(``INBOX#`` rows) and wakes an addressed agent or conductor. A posted task wakes nobody (an agent is launched for its
task, so none of its role is idle): its row is there for the role's agents to read. A message to the run (a
signal's record, run health, an outcome) stays in the conversation, where the supervisor, the conductor and the run
view read it. Steering relayed to a role (``msg.steer``, 7.51.00) goes to the delivery function like a posted task,
which records it for the role's agents and wakes the live ones.

There are no queues, per role or per agent: a suspended session runs no code and cannot poll, so every message is
pushed, per run; an agent reads its notices through the board API's ``inbox`` op.
"""
from __future__ import annotations

from dataclasses import dataclass

from engineering.bus.schema import Message

DELIVERY = 'delivery'


@dataclass(frozen=True)
class Destination:
    kind: str
    #: A posted task's role (its row is there for the role's agents to read; it wakes nobody).
    role: str = ''


def route(message: Message) -> tuple[Destination, ...]:
    if message.to.kind == 'role':
        # A posted task, and steering relayed to a role's agents (7.51.00: its live agents are woken to read it).
        return (Destination(DELIVERY, role=message.to.id),)
    if message.to.kind in {'agent', 'conductor'}:
        return (Destination(DELIVERY),)
    return ()
