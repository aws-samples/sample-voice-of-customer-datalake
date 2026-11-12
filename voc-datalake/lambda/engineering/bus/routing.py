"""Where a message goes after the router has written it to the run's conversation: a posted task (for its role) and a
message for an agent or the run conductor to the delivery function, which records the notice in the run's partition
(``INBOX#`` rows) and wakes the addressee (the run's live agents of that role, or the agent). A message to the run (a
signal's record, run health, an outcome) stays in the conversation, where the supervisor, the conductor and the run
view read it.

There are no queues, per role or per agent: a suspended MicroVM runs no code and cannot poll, so every message is
pushed, per run; an agent reads its notices through the board API's ``inbox`` op.
"""
from __future__ import annotations

from dataclasses import dataclass

from engineering.bus.schema import Message

DELIVERY = 'delivery'


@dataclass(frozen=True)
class Destination:
    kind: str
    #: A posted task's role (its notice goes to every live agent of the role in the run).
    role: str = ''


def route(message: Message) -> tuple[Destination, ...]:
    if message.type == 'task.posted':
        return (Destination(DELIVERY, role=message.to.id),)
    if message.to.kind in {'agent', 'conductor'}:
        return (Destination(DELIVERY),)
    return ()
