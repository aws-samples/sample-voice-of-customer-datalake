"""The run monitor (plan v3, 4.10): what a person sees of a run under way, and the two things they may do to it.

``overview``: the run (its ``META`` in voc-engineering: goal, repository, flow, status, times, how many messages it
has numbered), and every agent as the supervisor last saw it: its session row in the run's partition
(``WS#<ws>#RUN#<run>`` / ``AGENT#<agent>``, ``engineering.runtime.sessions``): role, task, status, continuation, the inspection data
(step, recent tool calls, last progress, heartbeat age, MicroVM state and age, why it looks stuck) and the live cost
counters (MicroVM-seconds, tokens per model), with the totals per model and for the run. The run's cost and budget
are to come from the run control (``engineering.runtime.ports.RunControl.budget``) once it is wired.

The actions (the route lets only an admin acting for themselves take them, like a run's ``decision``):

- ``signal``: ``save``, ``pause``, ``resume``, ``shutdown`` or ``stop_now`` (4.5), to the agent on a task or to the
  whole run. A signal to an agent names the attempt the person saw (the task's lease epoch): if the task has moved on
  (another attempt, no holder, or it has ended), it is refused, so nobody signals an agent they did not see.
  ``stop_now`` (no checkpoint) asks for ``confirm``. The supervisor applies it (``voc-engineering-runtime``'s
  ``signal`` action, idempotent per agent: a paused agent paused again is unchanged; an agent another move holds
  answers ``busy``, which is refused here as unavailable, so the person sends it again). The request is recorded in
  the conversation first (4.5: "recorded in the conversation with who/when"; D4) as ``signal.<name>`` from the API's
  source, addressed to the run (the supervisor itself tells the agent): who asked what of whom, and the note; the
  answer carries each agent's status.
- ``message``: a person's answer (``msg.answer``, the one thing a person says on the bus) to an agent of the run or to
  its conductor, on the thread they reply to or a new one. The router writes it to the conversation, its record.

A run that has ended (``META.ended_at``) takes neither. Without the runtime or the bus configured the actions are
``unavailable``; so is a failed call (the caller retries: the supervisor's signal is idempotent, and the record is
sent again).
"""
from __future__ import annotations

import json
from collections import defaultdict
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, Protocol

from botocore.exceptions import BotoCoreError, ClientError

from engineering.board.model import FINAL, OPEN
from engineering.bus.publish import PublishError, new_event_id
from engineering.bus.schema import MAX_SUMMARY_BYTES, Message, MessageError, Party, fit_summary, summary_text
from engineering.connectors.identity import WORKSPACE
from engineering.rows import Refused, amount_attr, run_pk, string_attr
from engineering.runtime.sessions import AgentSession
from engineering.workspace.layout import ID
from shared.logging import logger

API_SOURCE = 'voc.engineering/api'
SIGNALS = ('save', 'pause', 'resume', 'shutdown', 'stop_now')
#: The supervisor's answer for an agent another move held (supervisor.py: nothing was done).
BUSY = 'busy'
#: The supervisor's answer for an agent on another attempt than the one the signal named (nothing done).
STALE = 'stale'
#: The longest text the overview passes on from a row the runtime wrote (a step, a reason, a tool call).
MAX_LINE = 280
MAX_NOTE_BYTES = 500


class MonitorError(Refused):
    """An action refused: ``kind`` is invalid | not_found | conflict | unavailable (the route's status)."""


class Publisher(Protocol):
    """What the actions publish through: bus.publish.EventBridgePublisher, with the API's source."""

    def publish(self, message: Message) -> None: ...


class Sessions(Protocol):
    """The supervisor's session rows (engineering.runtime.sessions.SessionStore)."""

    def of_run(self, run_id: str) -> list[AgentSession]: ...


@dataclass(frozen=True)
class Applied:
    """The supervisor's answer: each agent's status after the signal, and whether the signal did anything to it
    (false when it was busy, its move failed, there was nothing to do, or the attempt was stale)."""
    agents: dict[str, str]
    applied: dict[str, bool]


class Runtime(Protocol):
    """The supervisor's signal (``LambdaRuntime`` calls voc-engineering-runtime)."""

    def signal(self, run_id: str, agent_id: str | None, signal: str, attempt: int | None, *, actor: str) -> Applied: ...


def _line(value: Any) -> str | None:
    return str(value)[:MAX_LINE] if isinstance(value, str) and value else None


def _whole(value: Any) -> int | None:
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def _agent_view(session: AgentSession) -> dict[str, Any]:
    inspect = session.inspect
    tools = inspect.get('recent_tools')
    return {
        'agent': session.agent_id, 'role': session.role, 'task_id': session.task_id or None,
        'status': session.status, 'continuation': session.continuation, 'started_at': session.started_at,
        'step': _line(inspect.get('step')), 'microvm_state': _line(inspect.get('microvm_state')),
        'microvm_age': _whole(inspect.get('microvm_age')), 'heartbeat_age': _whole(inspect.get('heartbeat_age')),
        'last_progress_at': _whole(inspect.get('last_progress_at')), 'stuck_why': _line(inspect.get('stuck_why')),
        'recent_tools': [str(tool)[:MAX_LINE] for tool in tools] if isinstance(tools, list) else [],
        'microvm_seconds': session.microvm_seconds,
        'tokens': [{'model': model, 'input_tokens': int(counts.get('in', 0)), 'output_tokens': int(counts.get('out', 0))}
                   for model, counts in sorted(session.tokens.items())],
    }


def _by_model(agents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    totals: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for agent in agents:
        for used in agent['tokens']:
            sums = totals[used['model']]
            sums[0] += used['input_tokens']
            sums[1] += used['output_tokens']
    return [{'model': model, 'input_tokens': sums[0], 'output_tokens': sums[1]} for model, sums in sorted(totals.items())]


@dataclass(frozen=True)
class Actor:
    """The person acting: their subject (on the bus) and their name (in the record)."""
    subject: str
    name: str


@dataclass(frozen=True)
class Signal:
    name: str
    task_id: str
    attempt: int
    note: str


def parse_signal(body: Mapping[str, Any]) -> Signal:
    """``{signal, task_id?, attempt?, note?, confirm?}``: a task's agent at an attempt, or (no task) the whole run."""
    name, task_id, attempt, note = body.get('signal'), body.get('task_id'), body.get('attempt'), body.get('note', '')
    if name not in SIGNALS:
        raise MonitorError('invalid', f"signal is one of {', '.join(SIGNALS)}")
    if name == 'stop_now' and body.get('confirm') is not True:
        raise MonitorError('invalid', 'stop_now stops without a checkpoint: send confirm: true')
    if task_id is None:
        if attempt is not None:
            raise MonitorError('invalid', 'attempt goes with a task_id (a signal to the whole run has none)')
        return Signal(name, '', 0, _note(note))
    if not isinstance(task_id, str) or not ID.fullmatch(task_id):
        raise MonitorError('invalid', 'task_id is a task id')
    if not isinstance(attempt, int) or isinstance(attempt, bool) or not 1 <= attempt <= 1_000_000:
        raise MonitorError('invalid', 'attempt is the attempt you saw (the task\'s lease epoch)')
    return Signal(name, task_id, attempt, _note(note))


def _note(note: Any) -> str:
    """The note, checked as the conversation's record will check it, before anything is done."""
    if not isinstance(note, str) or len(note.encode('utf-8')) > MAX_NOTE_BYTES:
        raise MonitorError('invalid', f'note is a string of at most {MAX_NOTE_BYTES} bytes')
    try:
        return summary_text(note).strip()
    except MessageError as exc:
        raise MonitorError('invalid', 'This holds something shaped like a credential: take it out') from exc


@dataclass(frozen=True)
class Answer:
    to: Party
    text: str
    thread_id: str


def parse_message(body: Mapping[str, Any], run_id: str) -> Answer:
    """``{to: 'conductor' | 'agent', agent?, text, thread_id?}``: a person's answer, in a thread (new if left out)."""
    to, text, thread = body.get('to'), body.get('text'), body.get('thread_id')
    if to == 'conductor':
        party = Party('conductor', run_id)
    elif to == 'agent' and isinstance(body.get('agent'), str) and ID.fullmatch(body['agent']):
        party = Party('agent', body['agent'])
    else:
        raise MonitorError('invalid', "to is 'conductor', or 'agent' with the agent's id in agent")
    if not isinstance(text, str) or not text.strip() or len(text.strip().encode('utf-8')) > MAX_SUMMARY_BYTES:
        raise MonitorError('invalid', f'text is what you say, at most {MAX_SUMMARY_BYTES} bytes')
    if thread is not None and not (isinstance(thread, str) and ID.fullmatch(thread)):
        raise MonitorError('invalid', 'thread_id is the id of the thread you answer')
    return Answer(party, text.strip(), thread or f'human-{new_event_id()}')


def _at(now: datetime) -> str:
    return now.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%S.%fZ')


def _record(signal: Signal, actor: Actor, target: Party) -> str:
    """The request as the conversation keeps it: who asked what of whom, and their note."""
    whom = f'agent {target.id}' if target.kind == 'agent' else 'the whole run'
    note = f' Note: {signal.note}' if signal.note else ''
    return fit_summary(f"{signal.name.replace('_', ' ')} requested from the run monitor by {actor.name} for {whom}.{note}")


def _outcome_text(answer: Applied) -> str:
    """``applied: a working, b paused; not applied: c busy`` (or ``no agent yet``)."""
    def listed(applied: bool) -> str:
        return ', '.join(f'{agent} {status}' for agent, status in sorted(answer.agents.items())
                         if answer.applied.get(agent, False) is applied)

    done, not_done = listed(True), listed(False)
    parts = [f'applied: {done}'] * bool(done) + [f'not applied: {not_done}'] * bool(not_done)
    return '; '.join(parts) or 'no agent yet'


class LambdaRuntime:
    """The supervisor's signal through ``voc-engineering-runtime``: ``{action: signal, run_id, agent_id?, signal,
    attempt?}`` answers ``{agents: {agent: status}, applied: {agent: bool}}``. The attempt goes with one agent, so the
    supervisor itself refuses an agent that has moved on to another attempt (``stale``); a Stop now is never stale."""

    def __init__(self, client: Any, function_name: str) -> None:
        self.client = client
        self.function_name = function_name

    def signal(self, run_id: str, agent_id: str | None, signal: str, attempt: int | None, *, actor: str) -> Applied:
        """``actor``: the person who sent it (the signal record's sender), for the runtime to record who changed the
        run's status (a whole-run Resume: D4, voc-auto-b's next merge; the runtime in this tree ignores it)."""
        request: dict[str, Any] = {'action': 'signal', 'run_id': run_id, 'signal': signal, 'actor': actor}
        if agent_id is not None:
            request['agent_id'] = agent_id
            if attempt is not None:
                request['attempt'] = attempt
        answer = self.client.invoke(FunctionName=self.function_name, InvocationType='RequestResponse',
                                    Payload=json.dumps(request).encode())
        payload = json.loads(answer['Payload'].read() or b'{}')
        if answer.get('FunctionError'):
            if isinstance(payload, dict) and payload.get('errorType') == 'RuntimeRefused':
                raise MonitorError('conflict', str(payload.get('errorMessage', 'the supervisor refused it'))[:MAX_LINE])
            raise MonitorError('unavailable', 'the supervisor could not apply it: retry')
        answer_of = payload if isinstance(payload, dict) else {}
        agents, applied = answer_of.get('agents'), answer_of.get('applied')
        statuses = {str(agent): str(status) for agent, status in agents.items()} if isinstance(agents, dict) else {}
        if not isinstance(applied, dict):
            # The runtime from before ``applied`` (it ignores ``attempt`` too): what it answered busy did nothing.
            return Applied(statuses, {agent: status not in {BUSY, STALE} for agent, status in statuses.items()})
        # An agent the answer leaves out is taken as not applied (never claimed done on a guess).
        return Applied(statuses, {agent: applied.get(agent) is True for agent in statuses})


class RunMonitor:
    def __init__(self, client: Any, table: str, sessions: Sessions, *, runtime: Runtime | None,
                 publisher: Publisher | None, now: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        """``client`` is a low-level DynamoDB client on voc-engineering; ``sessions`` the supervisor's rows;
        ``runtime`` and ``publisher`` the actions' (None: the actions are unavailable)."""
        self.client, self.table = client, table
        self.sessions = sessions
        self.runtime = runtime
        self.publisher = publisher
        self.now = now

    def _get(self, run_id: str, sk: str) -> dict[str, Any] | None:
        return self.client.get_item(TableName=self.table, Key={'pk': {'S': run_pk(WORKSPACE, run_id)},
                                                               'sk': {'S': sk}}, ConsistentRead=True).get('Item')

    def overview(self, run_id: str) -> dict[str, Any] | None:
        """The run as the monitor shows it, or None for an unknown run."""
        meta = self._get(run_id, 'META')
        if meta is None:
            return None
        agents = sorted((_agent_view(session) for session in self.sessions.of_run(run_id)),
                        key=lambda agent: agent['agent'])
        return {
            'run': {'run_id': run_id, 'goal': string_attr(meta, 'goal'), 'repo': string_attr(meta, 'repo'),
                    'flow': string_attr(meta, 'flow'), 'status': string_attr(meta, 'status'),
                    'started_at': string_attr(meta, 'started_at') or None,
                    'ended_at': string_attr(meta, 'ended_at') or None},
            'agents': agents,
            # Whether the signals and answers can reach the run from here: the runtime and the bus both named (until
            # the stack wires them, every action answers 503, so the page offers none).
            'actions_available': self.actions_available,
            # The messages numbered so far (META's counter: a redelivery or a failed write uses a number too).
            'totals': {'messages': int(amount_attr(meta, 'msg_seq')),
                       'microvm_seconds': sum(agent['microvm_seconds'] for agent in agents),
                       'by_model': _by_model(agents)},
        }

    @property
    def actions_available(self) -> bool:
        """The runtime and the bus are both configured, so a signal or an answer can be sent."""
        return self.runtime is not None and self.publisher is not None

    def run_exists(self, run_id: str) -> bool:
        return self._get(run_id, 'META') is not None

    def open_run(self, run_id: str) -> None:
        meta = self._get(run_id, 'META')
        if meta is None:
            raise MonitorError('not_found', 'Engineering run not found')
        if string_attr(meta, 'ended_at'):
            raise MonitorError('conflict', 'This run has ended')

    def _target(self, run_id: str, signal: Signal) -> Party:
        if not signal.task_id:
            return Party('run', run_id)
        task = self._get(run_id, f'TASK#{signal.task_id}')
        if task is None:
            raise MonitorError('not_found', 'no such task in this run')
        holder, epoch = string_attr(task, 'lease_agent'), int(amount_attr(task, 'lease_epoch'))
        state = string_attr(task, 'state')
        if not holder or epoch != signal.attempt or state == OPEN or state in FINAL:
            raise MonitorError('conflict', 'This task has moved on since you looked: reload the run')
        return Party('agent', holder)

    def signal(self, run_id: str, signal: Signal, actor: Actor) -> dict[str, Any]:
        """The conversation records the request, then the supervisor applies it; answers each agent's status.

        Its record is published first (D4: who asked what, when and why, before anything moves): a request the bus
        refuses is never applied. The router then writes it to the conversation (a record it drops, a malformed one,
        is journalled by the router). After the supervisor answers, a second record says what came of it, naming the
        request's event id: each agent's status, or why it was not applied (unreachable, busy, refused). A request
        the supervisor could not apply is answered unavailable: sending it again publishes a new request and applies
        it once.
        """
        publisher = self.bus()
        if self.runtime is None:
            raise MonitorError('unavailable', 'the run cannot be reached from here: the runtime is not configured')
        self.open_run(run_id)
        target = self._target(run_id, signal)
        event_id, at = new_event_id(), _at(self.now())
        record = Message(
            event_id=event_id, ws=WORKSPACE, run_id=run_id, thread_id='signals', attempt=signal.attempt,
            sender=Party('human', actor.subject), to=Party('run', run_id), type=f'signal.{signal.name}',
            summary=_record(signal, actor, target), at=at, task_id=signal.task_id)
        _publish(publisher, record)
        one = target.kind == 'agent'
        try:
            answer = self.runtime.signal(run_id, target.id if one else None, signal.name,
                                         signal.attempt if one else None, actor=actor.subject)
        except (ClientError, BotoCoreError) as exc:
            self._outcome(publisher, record, 'not applied: the supervisor could not be reached')
            raise MonitorError('unavailable', 'The supervisor could not be reached: send the signal again') from exc
        except MonitorError as refused:
            self._outcome(publisher, record, f'not applied: {refused}')
            raise
        agents = answer.agents
        if one and agents.get(target.id) == STALE:
            # The agent moved on to another attempt between the check and the signal: nothing was done.
            self._outcome(publisher, record, 'not applied: the agent has moved on to another attempt')
            raise MonitorError('conflict', 'This task has moved on since you looked: reload the run')
        if one and agents.get(target.id) == BUSY:
            # Another move held the agent: nothing was done.
            self._outcome(publisher, record, 'not applied: the agent was busy with another move')
            raise MonitorError('unavailable', 'The agent is busy with another move: send the signal again')
        self._outcome(publisher, record, _outcome_text(answer))
        return {'event_id': event_id, 'signal': signal.name, 'target': {'kind': target.kind, 'id': target.id},
                'attempt': signal.attempt, 'agents': agents, 'applied': answer.applied, 'at': at}

    def _outcome(self, publisher: Publisher, request: Message, outcome: str) -> None:
        """What came of a recorded request, in the conversation (best effort: the request itself is recorded)."""
        try:
            _publish(publisher, replace(request, event_id=new_event_id(), at=_at(self.now()),
                                        summary=fit_summary(f'{request.type} request {request.event_id}: {outcome}')))
        except MonitorError:
            logger.warning('run monitor: a signal\'s outcome was not recorded',
                           extra={'run_id': request.run_id, 'request': request.event_id})

    def message(self, run_id: str, answer: Answer, actor: Actor) -> dict[str, Any]:
        """Publish a person's answer; answers its event and thread (the router writes it to the conversation)."""
        publisher = self.bus()
        self.open_run(run_id)
        if answer.to.kind == 'agent' and all(s.agent_id != answer.to.id for s in self.sessions.of_run(run_id)):
            raise MonitorError('not_found', 'no such agent in this run')
        event_id, at = new_event_id(), _at(self.now())
        _publish(publisher, Message(
            event_id=event_id, ws=WORKSPACE, run_id=run_id, thread_id=answer.thread_id, attempt=0,
            sender=Party('human', actor.subject), to=answer.to, type='msg.answer', summary=answer.text, at=at))
        return {'event_id': event_id, 'thread_id': answer.thread_id, 'at': at}

    def bus(self) -> Publisher:
        if self.publisher is None:
            raise MonitorError('unavailable', 'the run cannot be reached from here: the bus is not configured')
        return self.publisher


def _publish(publisher: Publisher, message: Message) -> None:
    try:
        publisher.publish(message)
    except MessageError as exc:   # (the one check a person's words can fail: a credential in them)
        raise MonitorError('invalid', 'This holds something shaped like a credential: take it out') from exc
    except (PublishError, ClientError, BotoCoreError) as exc:
        raise MonitorError('unavailable', 'the run could not be reached: retry') from exc
