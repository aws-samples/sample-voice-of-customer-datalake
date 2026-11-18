"""Where a message goes after the router has written it to the run's conversation: a posted task (for its role) and a
message for an agent or the run conductor to the delivery function, which records the notice in the run's partition
(``INBOX#`` rows) and wakes an addressed agent or conductor. A posted task wakes nobody (an agent is launched for its
task, so none of its role is idle): its row is there for the role's agents to read. A message to the run (a
signal's record, run health, an outcome) stays in the conversation, where the supervisor, the conductor and the run
view read it, but for the notices the conductor acts on (7.54.00, ``CONDUCTOR_NOTICES``): one of the run's tasks
ended (done, failed, needing a person: the board's), or its agent stopped answering or failed (the supervisor's,
before its task is re-posted). Those also go to the delivery function, into the conductor's inbox, and wake the
coordinator: one waiting for its agents (``wait_for_agents``) is told at once, never only when it next reads the
board, and one held without a session for its wait is continued to read them. Steering relayed to a role
(``msg.steer``, 7.51.00) goes to the delivery function like a posted task, which records it for the role's agents and
wakes the live ones.

There are no queues, per role or per agent: a suspended session runs no code and cannot poll, so every message is
pushed, per run; an agent reads its notices through the board API's ``inbox`` op.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from engineering.board.store import COORDINATE_TASK
from engineering.bus.schema import Message

DELIVERY = 'delivery'
#: The run's notices the conductor acts on (7.54.00): the board's for a task that ended, the supervisor's for an agent
#: that stopped answering or failed (its task is re-posted, or the run goes to a person).
CONDUCTOR_NOTICES: Final = frozenset({'task.done', 'task.failed', 'task.needs_human', 'run.agent_timed_out',
                                      'run.agent_failed'})


@dataclass(frozen=True)
class Destination:
    kind: str
    #: A posted task's role (its row is there for the role's agents to read; it wakes nobody).
    role: str = ''


def for_conductor(message: Message) -> bool:
    """A message to the run that the conductor's inbox takes too (``CONDUCTOR_NOTICES``, about another task than the
    coordinator's own, ``COORDINATE_TASK``: its notices are no news for the coordinator)."""
    return (message.to.kind == 'run' and message.type in CONDUCTOR_NOTICES and bool(message.task_id)
            and message.task_id != COORDINATE_TASK)


def route(message: Message) -> tuple[Destination, ...]:
    if message.to.kind == 'role':
        # A posted task, and steering relayed to a role's agents (7.51.00: its live agents are woken to read it).
        return (Destination(DELIVERY, role=message.to.id),)
    if message.to.kind in {'agent', 'conductor'} or for_conductor(message):
        return (Destination(DELIVERY),)
    return ()
