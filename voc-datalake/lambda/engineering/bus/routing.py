"""Where a message goes after the router has written it to the run's conversation: a posted task to its role's queue
(competing consumers); a message for an agent or the run conductor to the delivery function, which wakes the
addressee. A message to the run (a signal, run health, an outcome) stays in the conversation, where the supervisor,
the conductor and the run view read it.

There are no per-agent queues: a suspended MicroVM runs no code and cannot poll, so delivery is a push.
"""
from __future__ import annotations

from dataclasses import dataclass

from engineering.bus.schema import Message

ROLE_QUEUE = 'role_queue'
DELIVERY = 'delivery'


@dataclass(frozen=True)
class Destination:
    kind: str
    role: str = ''


def route(message: Message) -> tuple[Destination, ...]:
    if message.type == 'task.posted':
        return (Destination(ROLE_QUEUE, role=message.to.id),)
    if message.to.kind in {'agent', 'conductor'}:
        return (Destination(DELIVERY),)
    return ()
