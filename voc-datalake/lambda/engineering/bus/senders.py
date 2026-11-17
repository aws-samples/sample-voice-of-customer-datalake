"""Who may send what: the router's sender allowlist.

The router knows a sender only from the event's ``source``, so the bus's resource policy pins each source to its
publisher's identity (lib/stacks/engineering-bus.ts): it admits the board's role, the supervisor's and the delivery
function's roles and every agent role, and denies each every source but its own (the board's
``voc.engineering/board``, the runtime's two ``voc.engineering/supervisor``, an agent role's from its session's
workspace, run and agent, a run's coach its run's). A message must
also say, in its ``from``, the sender the source proves, and an agent or a run conductor may speak only in its own
workspace and run. Everything else is dropped and journalled, so no agent can
speak for another, for a person, for the board or for the supervisor.

Sources: ``voc.engineering/api`` (a signed-in person, through the API), ``voc.engineering/board`` (the board API,
as the board: a person's board actions go out from the API's source), ``voc.engineering/supervisor`` (the
supervisor, and the delivery function's continuations), ``voc.engineering/webhook`` (repository outcomes), ``voc.engineering/conductor/<ws>/<run>``,
``voc.engineering/coach/<ws>/<run>`` (a run's coach: run-scoped, so the run and refs checks apply to it, and it speaks
as ``coach``, never as ``system``) and ``voc.engineering/agent/<role>/<ws>/<run>/<agent>``, the role one of
``schema.ROLES``: the roles that claim tasks, the gate runner among them (it claims its quality gate step's tasks),
which sends only its gate results (``msg.finding``, ``review.result``), never a verdict (``gate.*`` is the final-go
agent's).

Steering (7.51.00, ``msg.steer``): a person's instruction goes from the API to the run's conductor only, and the
conductor (the run coordinator) relays it to one agent or every agent of one role only. The coordinator reaches the bus
through the board (its session's egress has no EventBridge endpoint): the board's ``steer`` op checks the caller is the
run's current coordinator, from its IAM identity, and publishes the relay from the board's own source as the conductor
(``RELAYED``), the one message the board sends as another kind than ``system``. No agent sends steering, and no one
steers the API or the conductor but a person. ``signal.restart`` (an agent restarted from its checkpoint or afresh) is
the API's alone.
"""
from __future__ import annotations

from dataclasses import dataclass

from engineering.bus.schema import ROLES, Message

PREFIX = 'voc.engineering/'
SERVICES = frozenset({'api', 'board', 'supervisor', 'webhook'})
#: What the gate runner may send: its gate results. (The agent roles that may speak on the bus are those that claim
#: tasks, ``schema.ROLES``, their queue-less inboxes: the gate runner is one.)
GATE_RUNNER_TYPES = frozenset({'msg.finding', 'review.result'})
#: The ``from.kind`` values each kind of source may claim.
FROM_KINDS = {'api': frozenset({'human'}), 'board': frozenset({'system'}),
              'supervisor': frozenset({'supervisor'}), 'coach': frozenset({'coach'}),
              'webhook': frozenset({'system'}), 'conductor': frozenset({'conductor'}), 'agent': frozenset({'agent'})}
_TALK = frozenset({'agent', 'conductor'})
#: The ``from.kind`` a source may claim for one type, beyond its own (``FROM_KINDS``): the board relays the run
#: coordinator's steering as the conductor, once its ``steer`` op checked the caller is the run's coordinator.
RELAYED: dict[tuple[str, str], frozenset[str]] = {('board', 'msg.steer'): frozenset({'conductor'})}
#: Who a steering message goes to, by its sender's kind: a person steers the conductor; the conductor steers an agent
#: or a role's agents.
STEERED: dict[str, frozenset[str]] = {'human': frozenset({'conductor'}), 'conductor': frozenset({'agent', 'role'})}
#: Per type family (or exact type), the kinds of source that may send it. A person (the API) talks only by
#: answering; the supervisor signals agents too (the pause before a session's time is up).
ALLOWED = {
    # The board's changes, and a person's board actions (board.api.PersonBoard), which the API publishes as the
    # signed-in person: its source proves from.kind human, never another kind (FROM_KINDS).
    'task.': frozenset({'board', 'api'}),
    # A task the supervisor re-posts (board.api.repost_task), published with the supervisor's own source.
    'task.posted': frozenset({'board', 'supervisor', 'api'}),
    'signal.': frozenset({'api', 'supervisor'}),
    # The supervisor asks a silent agent for its state; a person's check-in is a message.
    'signal.check_in': frozenset({'supervisor'}),
    # A person restarts an agent (7.51.00); the supervisor never does.
    'signal.restart': frozenset({'api'}),
    'gate.': frozenset({'agent'}),
    'run.': frozenset({'supervisor', 'board'}),
    'run.health': frozenset({'supervisor'}),
    'run.agent_continued': frozenset({'supervisor'}),
    'run.agent_timed_out': frozenset({'supervisor'}),
    'run.agent_failed': frozenset({'supervisor'}),
    'run.budget_alert': frozenset({'supervisor'}),
    'outcome.': frozenset({'webhook'}),
    'msg.': _TALK,
    'msg.answer': _TALK | {'api'},
    # A person's steering to the conductor (the API's), and the conductor's relay of it (its own source, or the
    # board's for the coordinator's ``steer`` op): ``_steer_refusal`` holds who steers whom.
    'msg.steer': frozenset({'api', 'conductor', 'board'}),
    'review.': _TALK,
    # The run's coach proposes; an administrator proposes, accepts, promotes and rolls back through the API.
    'skill.proposed': frozenset({'coach', 'api'}),
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
    if len(parts) == 3 and parts[0] in {'conductor', 'coach'} and all(parts[1:]):
        return Source(kind=parts[0], ws=parts[1], run_id=parts[2])
    if len(parts) == 5 and parts[0] == 'agent' and parts[1] in ROLES and all(parts[2:]):
        return Source(kind='agent', role=parts[1], ws=parts[2], run_id=parts[3], agent_id=parts[4])
    return None


def _kinds_for(message_type: str) -> frozenset[str]:
    if message_type in ALLOWED:
        return ALLOWED[message_type]
    family = message_type.split('.', 1)[0] + '.'
    return ALLOWED.get(family, frozenset())


def _source_refusal(message: Message, sender: Source) -> str:
    """Why the source may not send this message, as what it is and where it speaks ('' when it may)."""
    if sender.kind not in _kinds_for(message.type):
        return f'{sender.kind} may not send {message.type}'
    if message.sender.kind not in FROM_KINDS[sender.kind] | RELAYED.get((sender.kind, message.type), frozenset()):
        return f'from.kind {message.sender.kind} is not what the source {sender.kind} proves'
    if sender.run_id and (sender.ws, sender.run_id) != (message.ws, message.run_id):
        return f'{sender.kind} of run {sender.ws}/{sender.run_id} may not speak in another run'
    run_prefix = f'ws/{message.ws}/runs/{message.run_id}/'
    if sender.run_id and not all(key.startswith(run_prefix) for key in message.refs.s3):
        return f'{sender.kind} may refer only to its own run\'s objects'
    return ''


def _agent_refusal(message: Message, sender: Source) -> str:
    """Why this agent may not send it, as who it is and what its role may say ('' when it may)."""
    if sender.kind == 'agent' and message.sender.id != sender.agent_id:
        return f'agent {sender.agent_id} may not speak as another agent'
    if message.type.startswith('gate.') and sender.role != 'final-go':
        return f'only the final-go agent gives the verdict, not {sender.role}'
    if sender.role == 'gate-runner' and message.type not in GATE_RUNNER_TYPES:
        return f'the gate runner sends only its gate results, not {message.type}'
    return ''


def _steer_refusal(message: Message) -> str:
    """Why this steering may not go where it is addressed ('' when it may, or for any other type)."""
    if message.type != 'msg.steer':
        return ''
    if message.to.kind not in STEERED.get(message.sender.kind, frozenset()):
        return f'steering from {message.sender.kind} may not go to {message.to.kind}'
    return ''


def judge(message: Message, source: str) -> Verdict:
    """Whether the router may deliver ``message``, put on the bus with ``source``, and why not."""
    sender = parse_source(source)
    if sender is None:
        return Verdict(False, 'unknown source')
    reason = _source_refusal(message, sender) or _agent_refusal(message, sender) or _steer_refusal(message)
    return Verdict(not reason, reason)
