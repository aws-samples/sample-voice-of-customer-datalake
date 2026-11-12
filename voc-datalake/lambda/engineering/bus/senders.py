"""Who may send what: the router's sender allowlist.

The router knows a sender only from the event's ``source``, so the bus's resource policy must pin each source to its
publisher's identity. Today it lets only the board API's role put events at all (lib/stacks/engineering-bus.ts), and
the board publishes only as ``voc.engineering/board``; the per-publisher pins (each agent role only with its own
source, the workspace, run and agent from the launcher's session name) come with the agent roles. A message must
also say, in its ``from``, the sender the source proves, and an agent or a run conductor may speak only in its own
workspace and run. Everything else is dropped and journalled, so no agent can
speak for another, for a person, for the board or for the supervisor.

Sources: ``voc.engineering/api`` (a signed-in person, through the API), ``voc.engineering/board`` (the board API,
which also relays a person's moves on the board), ``voc.engineering/supervisor``, ``voc.engineering/coach``,
``voc.engineering/webhook`` (repository outcomes), ``voc.engineering/conductor/<ws>/<run>`` and
``voc.engineering/agent/<role>/<ws>/<run>/<agent>``.
"""
from __future__ import annotations

from dataclasses import dataclass

from engineering.bus.schema import ROLES, Message

PREFIX = 'voc.engineering/'
SERVICES = frozenset({'api', 'board', 'supervisor', 'coach', 'webhook'})
#: The ``from.kind`` values each kind of source may claim.
FROM_KINDS = {'api': frozenset({'human'}), 'board': frozenset({'system', 'human'}),
              'supervisor': frozenset({'supervisor'}), 'coach': frozenset({'system'}),
              'webhook': frozenset({'system'}), 'conductor': frozenset({'conductor'}), 'agent': frozenset({'agent'})}
_TALK = frozenset({'agent', 'conductor'})
#: Per type family (or exact type), the kinds of source that may send it. A person (the API) talks only by
#: answering; the supervisor signals agents too (the pause before a MicroVM's time is up).
ALLOWED = {
    'task.': frozenset({'board'}),
    'signal.': frozenset({'api', 'supervisor'}),
    'gate.': frozenset({'agent'}),
    'run.': frozenset({'supervisor', 'board'}),
    'run.health': frozenset({'supervisor'}),
    'outcome.': frozenset({'webhook'}),
    'msg.': _TALK,
    'msg.answer': _TALK | {'api'},
    'review.': _TALK,
    'skill.proposed': frozenset({'coach'}),
    'skill.accepted': frozenset({'api'}),
    'skill.rolled_back': frozenset({'api'}),
}


@dataclass(frozen=True)
class Source:
    kind: str
    role: str = ''
    ws: str = ''
    run_id: str = ''
    agent_id: str = ''


@dataclass(frozen=True)
class Verdict:
    allowed: bool
    reason: str = ''


def parse_source(source: str) -> Source | None:
    """The sender an event's ``source`` proves, or None for a source this bus does not know."""
    if not source.startswith(PREFIX):
        return None
    parts = source.removeprefix(PREFIX).split('/')
    if len(parts) == 1 and parts[0] in SERVICES:
        return Source(kind=parts[0])
    if len(parts) == 3 and parts[0] == 'conductor' and all(parts[1:]):
        return Source(kind='conductor', ws=parts[1], run_id=parts[2])
    if len(parts) == 5 and parts[0] == 'agent' and parts[1] in ROLES and all(parts[2:]):
        return Source(kind='agent', role=parts[1], ws=parts[2], run_id=parts[3], agent_id=parts[4])
    return None


def _kinds_for(message_type: str) -> frozenset[str]:
    if message_type in ALLOWED:
        return ALLOWED[message_type]
    family = message_type.split('.', 1)[0] + '.'
    return ALLOWED.get(family, frozenset())


def judge(message: Message, source: str) -> Verdict:
    """Whether the router may deliver ``message``, put on the bus with ``source``, and why not."""
    sender = parse_source(source)
    if sender is None:
        return Verdict(False, 'unknown source')
    if sender.kind not in _kinds_for(message.type):
        return Verdict(False, f'{sender.kind} may not send {message.type}')
    if message.sender.kind not in FROM_KINDS[sender.kind]:
        return Verdict(False, f'from.kind {message.sender.kind} is not what the source {sender.kind} proves')
    if sender.run_id and (sender.ws, sender.run_id) != (message.ws, message.run_id):
        return Verdict(False, f'{sender.kind} of run {sender.ws}/{sender.run_id} may not speak in another run')
    run_prefix = f'ws/{message.ws}/runs/{message.run_id}/'
    if sender.run_id and not all(key.startswith(run_prefix) for key in message.refs.s3):
        return Verdict(False, f'{sender.kind} may refer only to its own run\'s objects')
    if sender.kind == 'agent' and message.sender.id != sender.agent_id:
        return Verdict(False, f'agent {sender.agent_id} may not speak as another agent')
    if message.type.startswith('gate.') and sender.role != 'final-go':
        return Verdict(False, f'only the final-go agent gives the verdict, not {sender.role}')
    return Verdict(True)
