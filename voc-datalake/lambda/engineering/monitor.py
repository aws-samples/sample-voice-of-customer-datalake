"""The run monitor (plan v3, 4.10): what a person sees of a run under way, and the two things they may do to it.

``overview``: the run (its ``META`` in voc-engineering: goal, repository, flow, status, times, how many messages it
has numbered), and every agent as the supervisor last saw it: its session row in the run's partition
(``WS#<ws>#RUN#<run>`` / ``AGENT#<agent>``, ``engineering.runtime.sessions``): role, task, status, continuation, the inspection data
(step, recent tool calls, last progress, heartbeat age, session state and age, why it looks stuck) and the live cost
counters (session-seconds, tokens per model), with the totals per model and for the run, and the run's flow budget
with its alert flag from META (``rows.budget_view``), and the flow it follows: the revision its start copied, each
step's status as the conductor reads it and where the flow stands (``engineering/flow/``; none for a run started
without a flow), and (7.09.00) the issue it was started from and its pull request, each its host, number and checked
address (``engineering/run_links.py``; None for none), and (7.10.00) the latest read of people's reactions on the
host to that pull request (``engineering/learning/reactions.py``; None for none). The run's cost is to come from the
run control
(``engineering.runtime.ports.RunControl.budget``) once it is wired.

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
- ``stop`` (7.50.03): a person's Stop of the whole run, ``stop`` (each agent saves a checkpoint, then the run ends) or
  ``stop_now`` (at once, asking ``confirm``), through voc-engineering-start's ``stop_run`` (``LambdaStopper``: the
  API's role invokes that function and never the runtime's), so it needs neither the runtime nor the bus here and
  ends the run whatever its agents are doing, a run with no session at all included (``runtime/stop.py``). Its
  record is the run's ``RUNLOG#`` row (who, how, when: D4); where the bus is configured the conversation records the
  request and its outcome too, best effort. A whole-run Shut down or Stop now sent as a ``signal`` is this Stop.

A run that has ended (``META.ended_at``) takes none of them. Without the runtime or the bus configured the signals and
answers are ``unavailable`` (``actions_available``); without the start function, the Stop (``stop_available``); so is a
failed call (the caller retries: the supervisor's signal and the Stop are idempotent, and the record is sent again).
"""
from __future__ import annotations

import json
from collections import defaultdict
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, Protocol

from botocore.exceptions import BotoCoreError, ClientError

from engineering import run_overview
from engineering.board.model import FINAL, OPEN, PERSON_PREFIX, Task
from engineering.bus.publish import PublishError, new_event_id
from engineering.bus.schema import MAX_SUMMARY_BYTES, Message, MessageError, Party, fit_summary, summary_text
from engineering.connectors.identity import WORKSPACE
from engineering.flow.record import run_flow
from engineering.learning.reactions import ReactionsStore
from engineering.learning.reactions import view as reactions_view
from engineering.rows import Refused, amount_attr, budget_view, run_pk, run_rows, string_attr
from engineering.run_links import run_links
from engineering.run_objects import RunObjects
from engineering.runtime.runs import ENDED
from engineering.runtime.sessions import AgentSession
from engineering.workspace.layout import ID
from shared.dynamo_paging import iter_query
from shared.logging import logger

API_SOURCE = 'voc.engineering/api'
SIGNALS = ('save', 'pause', 'resume', 'shutdown', 'stop_now', 'restart')
#: Where a restarted agent starts again (7.51.00): its newest checkpoint, or its task afresh (its attempt re-posted).
RESTART_FROM = ('checkpoint', 'fresh')
#: A person's Stop of the whole run (runtime/runs.py STOP, STOP_NOW), and the whole-run signal each one is.
STOP, STOP_NOW = 'stop', 'stop_now'
WHOLE_RUN_STOPS = {'shutdown': STOP, 'stop_now': STOP_NOW}
SIGNAL_OF_STOP = {STOP: 'shutdown', STOP_NOW: 'stop_now'}
#: What voc-engineering-start answers a Stop with (stop.Stopped): the run's status after it.
STOP_STATUSES = frozenset({'stopped', 'stopping', 'done', 'failed'})
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

    def signal(self, run_id: str, agent_id: str | None, signal: str, attempt: int | None, *, actor: str,
               restart_from: str = '') -> Applied: ...


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
    #: A restart's start (``RESTART_FROM``; '' for every other signal).
    restart_from: str = ''


def parse_signal(body: Mapping[str, Any]) -> Signal:
    """``{signal, task_id?, attempt?, note?, confirm?}``: a task's agent at an attempt, or (no task) the whole run.
    ``restart`` (7.51.00) is an agent's only, ``{signal: restart, from: checkpoint | fresh, task_id, attempt, confirm:
    true}``: the agent's session ends and its task starts again from its newest checkpoint, or afresh as its next
    attempt."""
    name, task_id, attempt, note = body.get('signal'), body.get('task_id'), body.get('attempt'), body.get('note', '')
    if name not in SIGNALS:
        raise MonitorError('invalid', f"signal is one of {', '.join(SIGNALS)}")
    if name == 'stop_now' and body.get('confirm') is not True:
        raise MonitorError('invalid', 'stop_now stops without a checkpoint: send confirm: true')
    if 'from' in body and name != 'restart':
        raise MonitorError('invalid', 'from goes with a restart')
    restart_from = _restart_from(body) if name == 'restart' else ''
    if task_id is None:
        if attempt is not None:
            raise MonitorError('invalid', 'attempt goes with a task_id (a signal to the whole run has none)')
        return Signal(name, '', 0, _note(note))
    if not isinstance(task_id, str) or not ID.fullmatch(task_id):
        raise MonitorError('invalid', 'task_id is a task id')
    if not isinstance(attempt, int) or isinstance(attempt, bool) or not 1 <= attempt <= 1_000_000:
        raise MonitorError('invalid', 'attempt is the attempt you saw (the task\'s lease epoch)')
    return Signal(name, task_id, attempt, _note(note), restart_from)


def _restart_from(body: Mapping[str, Any]) -> str:
    """A restart's ``from``, after its ``confirm`` and its task (a restart is an agent's, never the whole run's)."""
    if body.get('from') not in RESTART_FROM:
        raise MonitorError('invalid', f"a restart's from is {' or '.join(RESTART_FROM)}")
    if body.get('confirm') is not True:
        raise MonitorError('invalid', "a restart ends the agent's session (afresh: its work since its last checkpoint "
                                      'too): send confirm: true')
    if body.get('task_id') is None:
        raise MonitorError('invalid', "a restart is an agent's: name its task_id and the attempt you saw")
    return str(body['from'])


def _note(note: Any) -> str:
    """The note, checked as the conversation's record will check it, before anything is done."""
    if not isinstance(note, str) or len(note.encode('utf-8')) > MAX_NOTE_BYTES:
        raise MonitorError('invalid', f'note is a string of at most {MAX_NOTE_BYTES} bytes')
    try:
        return summary_text(note).strip()
    except MessageError as exc:
        raise MonitorError('invalid', 'This holds something shaped like a credential: take it out') from exc


@dataclass(frozen=True)
class StopRequest:
    """A person's Stop of the whole run: ``stop`` (save, then stop) or ``stop_now``, and their note."""
    mode: str
    note: str


def parse_stop(body: Mapping[str, Any]) -> StopRequest:
    """``{now?, confirm?, note?}``: a Stop (the agents save first), or with ``now: true`` a Stop now, which stops
    without a checkpoint and so asks ``confirm: true``."""
    now, note = body.get('now', False), body.get('note', '')
    if not isinstance(now, bool):
        raise MonitorError('invalid', 'now is true (Stop now, without saving) or false (Stop: save, then stop)')
    if now and body.get('confirm') is not True:
        raise MonitorError('invalid', 'Stop now stops without a checkpoint: send confirm: true')
    return StopRequest(STOP_NOW if now else STOP, _note(note))


@dataclass(frozen=True)
class Answer:
    to: Party
    text: str
    thread_id: str


def parse_message(body: Mapping[str, Any], run_id: str) -> Answer:
    """``{to: 'conductor' | 'agent', agent?, text, thread_id?}``: a person's answer, in a thread (new if left out).
    Since 7.51.00 an answer to an agent replies on the thread its own question opened (``msg.question``: D51-4), so it
    names that ``thread_id``; anything else a person tells an agent goes as steering, through the orchestrator."""
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
    if party.kind == 'agent' and thread is None:
        raise MonitorError('invalid', "an answer to an agent names the thread_id of its question (to steer it, steer "
                                      'the run)')
    return Answer(party, text.strip(), thread or f'human-{new_event_id()}')


#: The most conversation messages an answer's check reads, newest first, for the question it answers.
MAX_QUESTION_READ = 5_000


@dataclass(frozen=True)
class Steer:
    text: str
    about: str
    thread_id: str


STEER_FIELDS = frozenset({'text', 'about', 'thread_id'})


def parse_steer(body: Mapping[str, Any]) -> Steer:
    """``{text, about?, thread_id?}`` (7.51.00): a person's instruction to the run's orchestrator, optionally about
    one agent of the run, on a thread (new if left out)."""
    text, about, thread = body.get('text'), body.get('about'), body.get('thread_id')
    if not set(body) <= STEER_FIELDS:
        raise MonitorError('invalid', 'the body is {text, about?, thread_id?}')
    if about is not None and not (isinstance(about, str) and ID.fullmatch(about)):
        raise MonitorError('invalid', "about is the id of an agent of the run")
    if thread is not None and not (isinstance(thread, str) and ID.fullmatch(thread)):
        raise MonitorError('invalid', 'thread_id is the id of the thread you steer on')
    said = text.strip() if isinstance(text, str) else ''
    if not said or len(_steering(said, about or '').encode('utf-8')) > MAX_SUMMARY_BYTES:
        raise MonitorError('invalid', f'text is what the orchestrator should do, at most {MAX_SUMMARY_BYTES} bytes '
                                      'with the agent it is about')
    return Steer(said, about or '', thread or f'steer-{new_event_id()}')


def _steering(text: str, about: str) -> str:
    """The steering as the conversation keeps it (and the orchestrator reads it): the agent it is about first."""
    return f'About {about}: {text}' if about else text


def _at(now: datetime) -> str:
    return now.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%S.%fZ')


def _record(signal: Signal, actor: Actor, target: Party) -> str:
    """The request as the conversation keeps it: who asked what of whom, and their note."""
    whom = f'agent {target.id}' if target.kind == 'agent' else 'the whole run'
    note = f' Note: {signal.note}' if signal.note else ''
    start = {'checkpoint': ' from its checkpoint', 'fresh': ' afresh'}.get(signal.restart_from, '')
    return fit_summary(f"{signal.name.replace('_', ' ')}{start} requested from the run monitor by {actor.name} for "
                       f'{whom}.{note}')


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

    def signal(self, run_id: str, agent_id: str | None, signal: str, attempt: int | None, *, actor: str,
               restart_from: str = '') -> Applied:
        """``actor``: the person who sent it (the signal record's sender), for the runtime to record who changed the
        run's status (a whole-run Resume: D4, ``runtime/runs.py``) and name on a new coordinator's launch;
        ``restart_from``: a restart's start (``checkpoint`` or ``fresh``)."""
        request: dict[str, Any] = {'action': 'signal', 'run_id': run_id, 'signal': signal, 'actor': actor}
        if restart_from:
            request['restart_from'] = restart_from
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


class Stopper(Protocol):
    """A person's Stop of the whole run (``LambdaStopper`` calls voc-engineering-start's ``stop_run``)."""

    def stop(self, run_id: str, mode: str, *, actor: str) -> dict[str, Any]: ...


class LambdaStopper:
    """The Stop through ``voc-engineering-start``: ``{action: stop_run, run_id, mode, actor}`` answers
    ``runtime/stop.Stopped.view()`` (the run's status after it: ``stopped``, ``stopping``, or the end it had already).
    Its refusal (an unknown run, a bad request) is a conflict in its words; any other failure is unavailable (sending
    the Stop again is safe: every step of it is idempotent)."""

    def __init__(self, client: Any, function_name: str) -> None:
        self.client = client
        self.function_name = function_name

    def stop(self, run_id: str, mode: str, *, actor: str) -> dict[str, Any]:
        request = {'action': 'stop_run', 'run_id': run_id, 'mode': mode, 'actor': actor}
        try:
            answer = self.client.invoke(FunctionName=self.function_name, InvocationType='RequestResponse',
                                        Payload=json.dumps(request).encode())
            payload = json.loads(answer['Payload'].read() or b'{}')
        except (ClientError, BotoCoreError, ValueError, KeyError, OSError) as exc:
            raise MonitorError('unavailable', 'The run could not be reached: send the Stop again') from exc
        if answer.get('FunctionError'):
            if isinstance(payload, dict) and payload.get('errorType') in ('RuntimeRefused', 'RunNotActive'):
                raise MonitorError('conflict', str(payload.get('errorMessage', 'the runtime refused it'))[:MAX_LINE])
            raise MonitorError('unavailable', 'The Stop could not be applied: send it again')
        if not isinstance(payload, dict) or payload.get('status') not in STOP_STATUSES:
            raise MonitorError('unavailable', 'The Stop could not be applied: send it again')
        return payload


def _stop_view(meta: Mapping[str, Any]) -> dict[str, Any] | None:
    """A person's Stop under way or done (META's ``stop_requested_at``, 7.50.03): how and when; None for none."""
    at = int(amount_attr(meta, 'stop_requested_at'))
    if not at:
        return None
    mode = string_attr(meta, 'stop_mode')
    return {'mode': mode if mode in (STOP, STOP_NOW) else STOP,
            'requested_at': datetime.fromtimestamp(at, UTC).strftime('%Y-%m-%dT%H:%M:%SZ')}


class RunMonitor:
    def __init__(self, client: Any, table: str, sessions: Sessions, *, runtime: Runtime | None,
                 publisher: Publisher | None, now: Callable[[], datetime] = lambda: datetime.now(UTC),
                 stopper: Stopper | None = None, objects: RunObjects | None = None) -> None:
        """``client`` is a low-level DynamoDB client on voc-engineering; ``sessions`` the supervisor's rows;
        ``runtime`` and ``publisher`` the signals' and answers' (None: they are unavailable); ``stopper`` the Stop's
        (None: it is unavailable); ``objects`` the workspace bucket's run objects (an ended run's manifest; None: not
        read)."""
        self.client, self.table = client, table
        self.objects = objects
        self.sessions = sessions
        self.runtime = runtime
        self.publisher = publisher
        self.stopper = stopper
        self.now = now

    def _get(self, run_id: str, sk: str) -> dict[str, Any] | None:
        return self.client.get_item(TableName=self.table, Key={'pk': {'S': run_pk(WORKSPACE, run_id)},
                                                               'sk': {'S': sk}}, ConsistentRead=True).get('Item')

    def overview(self, run_id: str) -> dict[str, Any] | None:
        """The run as the monitor shows it, or None for an unknown run."""
        meta = self._get(run_id, 'META')
        if meta is None:
            return None
        rows = {string_attr(row, 'sk').removeprefix('AGENT#'): row
                for row in run_rows(self.client, self.table, WORKSPACE, run_id, 'AGENT#')}
        agents = sorted(({**_agent_view(session), **run_overview.agent_extras(run_id, session, rows.get(session.agent_id))}
                         for session in self.sessions.of_run(run_id)), key=lambda agent: agent['agent'])
        tasks = [Task.from_item(item) for item in run_rows(self.client, self.table, WORKSPACE, run_id, 'TASK#')]
        flow, gates = self._flow_view(run_id, meta, tasks)
        ended = string_attr(meta, 'status') in ENDED
        return {
            'run': {'run_id': run_id, 'goal': string_attr(meta, 'goal'), 'repo': string_attr(meta, 'repo'),
                    'flow': string_attr(meta, 'flow'), 'status': string_attr(meta, 'status'),
                    'started_at': string_attr(meta, 'started_at') or None,
                    'ended_at': string_attr(meta, 'ended_at') or None,
                    # The decision point a run waiting at a person waits at ('' for none), and a person's Stop of it
                    # (7.50.03: None for none; stopping while it has not ended).
                    'waiting_at': string_attr(meta, 'needs_human') if string_attr(meta, 'status') == 'needs_human'
                    else '',
                    'stop': _stop_view(meta),
                    # Its flow's monthly budget and the highest level its flow's month passed (None: no budget).
                    'budget': budget_view(meta), **flow,
                    # The issue it was started from and its pull request (each None for none: run_links.py).
                    **run_links(self.client, self.table, WORKSPACE, run_id, meta),
                    # (7.51.00) Its cost against its cap, the run it was restarted from, an ended run's manifest.
                    **run_overview.run_cost(meta, agents, self._get(run_id, 'LEARN#spend')),
                    'parent': run_overview.parent(meta),
                    'manifest': run_overview.manifest(self.objects, run_id) if ended else None},
            'agents': agents,
            # (7.51.00) Each flow step's tasks and their agents (the canvas's lanes), each gate's verdict as the board
            # recorded it, and the runs restarted from this one.
            'lanes': run_overview.lanes(tasks, agents), 'gates': gates,
            'children': run_overview.children(run_rows(self.client, self.table, WORKSPACE, run_id, 'CHILD#')),
            # Whether the signals and answers can reach the run from here: the runtime and the bus both named (until
            # the stack wires them, every action answers 503, so the page offers none).
            'actions_available': self.actions_available,
            # Whether a person's Stop can reach the run (the start function named: 7.50.03), signals or not.
            'stop_available': self.stopper is not None,
            # The messages numbered so far (META's counter: a redelivery or a failed write uses a number too).
            'totals': {'messages': int(amount_attr(meta, 'msg_seq')),
                       'microvm_seconds': sum(agent['microvm_seconds'] for agent in agents),
                       'by_model': _by_model(agents)},
            # People's reactions on the host to its pull request, the latest read (7.10.00; None for none: one Query
            # of one row, learning/reactions.py).
            'reactions': reactions_view(ReactionsStore(self.client, self.table).latest(WORKSPACE, run_id)),
        }

    def ended(self, run_id: str) -> bool:
        """The run has ended (done, failed or stopped): its reactions may be read (``MonitorError`` not_found for no
        run)."""
        meta = self._get(run_id, 'META')
        if meta is None:
            raise MonitorError('not_found', 'Engineering run not found')
        return string_attr(meta, 'status') in ENDED

    def _flow_view(self, run_id: str, meta: Mapping[str, Any],
                   tasks: list[Task]) -> tuple[dict[str, Any], dict[str, str]]:
        """The run's flow as it runs: the revision its start copied and when, each step's status from the conductor
        (the canvas's steps lit) and where the flow stands; all None for a run started without a flow, or whose copy
        cannot be followed (logged). And each quality gate's verdict (``{step: GO | NO-GO | unread}``, 7.51.00)."""
        # (no gate records read here: a gate's verdict as the board recorded it, else not yet read)
        found = run_flow(self.client, self.table, WORKSPACE, run_id, meta, tasks=tasks)
        if found is None:
            return {'flow_revision': None, 'flow_copied_at': None, 'flow_definition': None, 'flow_steps': None,
                    'flow_outcome': None}, {}
        plan = found.plan
        return {'flow_revision': found.revision or None, 'flow_copied_at': found.copied_at or None,
                # The run's own copy, as its start wrote it: what the monitor draws (never the flow as saved since).
                'flow_definition': found.definition, 'flow_steps': plan.lit(),
                'flow_outcome': {'outcome': plan.outcome, 'at': plan.at or None, 'reason': _line(plan.reason)}}, \
            dict(plan.verdicts)

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
        if holder.startswith(PERSON_PREFIX):
            # A person took it (board/store.py take): no agent holds it, so none is signalled through it.
            raise MonitorError('conflict', 'A person holds this task: no agent works on it to signal')
        return Party('agent', holder)

    def stop(self, run_id: str, request: StopRequest, actor: Actor) -> dict[str, Any]:
        """A person's Stop of the whole run (module doc): voc-engineering-start ends it, or (a Stop whose agents have
        sessions) records it and has them save first; answers the run's status after it (``stopped`` or
        ``stopping``), the tasks it closed, the agents asked to save, and whether it fell back to stopping at once.
        Where the bus is configured the conversation records the request first and its outcome after (best effort:
        the run's ``RUNLOG#`` row is its record either way)."""
        if self.stopper is None:
            raise MonitorError('unavailable', 'the run cannot be stopped from here: the deployment names no start '
                                              'function')
        self.open_run(run_id)
        target = Party('run', run_id)
        name = SIGNAL_OF_STOP[request.mode]
        record = self._record_stop(run_id, Signal(name, '', 0, request.note), actor, target)
        try:
            answer = self.stopper.stop(run_id, request.mode, actor=actor.subject)
        except MonitorError as refused:
            if record is not None and self.publisher is not None:
                self._outcome(self.publisher, record, f'not applied: {refused}')
            raise
        if record is not None and self.publisher is not None:
            self._outcome(self.publisher, record, _stop_outcome(answer))
        agents = answer.get('agents')
        return {'run_id': run_id, 'mode': request.mode, 'status': str(answer.get('status')),
                'already': answer.get('already') is True, 'fell_back': answer.get('fell_back') is True,
                'tasks_closed': [str(task) for task in answer.get('tasks_closed') or []],
                'saving': [str(agent) for agent in answer.get('saving') or []],
                'agents': {str(k): str(v) for k, v in agents.items()} if isinstance(agents, dict) else {},
                'recorded': record is not None, 'at': _at(self.now())}

    def _record_stop(self, run_id: str, signal: Signal, actor: Actor, target: Party) -> Message | None:
        """The Stop's request in the conversation, where the bus is configured; None where it is not, or the bus
        refused it (logged: the Stop still goes ahead, its ``RUNLOG#`` row is its record)."""
        if self.publisher is None:
            return None
        record = Message(
            event_id=new_event_id(), ws=WORKSPACE, run_id=run_id, thread_id='signals', attempt=0,
            sender=Party('human', actor.subject), to=target, type=f'signal.{signal.name}',
            summary=_record(signal, actor, target), at=_at(self.now()))
        try:
            _publish(self.publisher, record)
        except MonitorError as refused:
            if refused.kind == 'invalid':
                raise   # (a credential in the note: never sent, never applied)
            logger.warning('run monitor: a Stop was not recorded in the conversation', extra={'run_id': run_id})
            return None
        return record

    def origin(self, run_id: str) -> Mapping[str, str] | None:
        """The engineering agent's run the run was started for (its first ``RUNLOG#`` row's ``via``: the agent and
        its run, 7.47.00), None for a run an administrator started by hand."""
        found = self.client.query(
            TableName=self.table, KeyConditionExpression='pk = :pk AND begins_with(sk, :log)', Limit=5,
            ExpressionAttributeValues={':pk': {'S': run_pk(WORKSPACE, run_id)}, ':log': {'S': 'RUNLOG#'}},
            ConsistentRead=True).get('Items', [])
        for item in found:
            via = item.get('via', {}).get('M')
            if isinstance(via, dict):
                agent, run = via.get('agent_id', {}).get('S'), via.get('agent_run_id', {}).get('S')
                if isinstance(agent, str) and isinstance(run, str) and agent and run:
                    return {'agent_id': agent, 'agent_run_id': run}
        return None

    def signal(self, run_id: str, signal: Signal, actor: Actor) -> dict[str, Any]:
        """The conversation records the request, then the supervisor applies it; answers each agent's status.

        Its record is published first (D4: who asked what, when and why, before anything moves): a request the bus
        refuses is never applied. The router then writes it to the conversation (a record it drops, a malformed one,
        is journalled by the router). After the supervisor answers, a second record says what came of it, naming the
        request's event id: each agent's status, or why it was not applied (unreachable, busy, refused). A request
        the supervisor could not apply is answered unavailable: sending it again publishes a new request and applies
        it once.
        """
        if not signal.task_id and signal.name in WHOLE_RUN_STOPS and self.stopper is not None:
            # A whole run's Shut down or Stop now is its Stop (7.50.03): it ends the run, signals reach it or not.
            stopped = self.stop(run_id, StopRequest(WHOLE_RUN_STOPS[signal.name], signal.note), actor)
            return {'event_id': None, 'signal': signal.name, 'target': {'kind': 'run', 'id': run_id}, 'attempt': 0,
                    'agents': stopped['agents'], 'applied': dict.fromkeys(stopped['agents'], True),
                    'at': stopped['at'], 'run': stopped}
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
                                         signal.attempt if one else None, actor=actor.subject,
                                         restart_from=signal.restart_from)
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
        if answer.to.kind == 'agent' and not self._asked(run_id, answer.to.id, answer.thread_id):
            raise MonitorError('not_found', f'agent {answer.to.id} asked no question on this thread: an answer to an '
                                            'agent replies on the thread its own question opened')
        event_id, at = new_event_id(), _at(self.now())
        _publish(publisher, Message(
            event_id=event_id, ws=WORKSPACE, run_id=run_id, thread_id=answer.thread_id, attempt=0,
            sender=Party('human', actor.subject), to=answer.to, type='msg.answer', summary=answer.text, at=at))
        return {'event_id': event_id, 'thread_id': answer.thread_id, 'at': at}

    def _asked(self, run_id: str, agent: str, thread: str) -> bool:
        """Whether ``agent`` opened ``thread`` with its own question (``msg.question`` from it on that thread): the
        conversation's questions read newest first, stopping at the first that is (``iter_query`` reads no further
        page), at most ``MAX_QUESTION_READ`` of them."""
        request: dict[str, Any] = {
            'TableName': self.table, 'ConsistentRead': True, 'ScanIndexForward': False, 'Limit': 500,
            'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :msg)', 'FilterExpression': '#type = :question',
            'ExpressionAttributeNames': {'#type': 'type'},
            'ExpressionAttributeValues': {':pk': {'S': run_pk(WORKSPACE, run_id)}, ':msg': {'S': 'MSG#'},
                                          ':question': {'S': 'msg.question'}}}
        for item in iter_query(self.client, request, max_items=MAX_QUESTION_READ):
            try:
                message = json.loads(string_attr(item, 'message'))
            except ValueError:
                continue
            sender = message.get('from') if isinstance(message, dict) else None
            if isinstance(sender, dict) and (sender.get('kind'), sender.get('id')) == ('agent', agent) \
                    and message.get('thread_id') == thread:
                return True
        return False

    def steer(self, run_id: str, steer: Steer, actor: Actor) -> dict[str, Any]:
        """Publish a person's steering to the run's orchestrator (``msg.steer`` from the API to the conductor: the
        router records it in the conversation, who and when, D4; the delivery wakes the coordinator, which relays it);
        answers its event and thread."""
        publisher = self.bus()
        self.open_run(run_id)
        if steer.about and all(s.agent_id != steer.about for s in self.sessions.of_run(run_id)):
            raise MonitorError('not_found', 'no such agent in this run')
        event_id, at = new_event_id(), _at(self.now())
        _publish(publisher, Message(
            event_id=event_id, ws=WORKSPACE, run_id=run_id, thread_id=steer.thread_id, attempt=0,
            sender=Party('human', actor.subject), to=Party('conductor', run_id), type='msg.steer',
            summary=_steering(steer.text, steer.about), at=at))
        logger.info('engineering: a person steered the run', extra={
            'run_id': run_id, 'by': actor.subject, 'about': steer.about or None, 'event_id': event_id})
        return {'event_id': event_id, 'thread_id': steer.thread_id, 'at': at}

    def bus(self) -> Publisher:
        if self.publisher is None:
            raise MonitorError('unavailable', 'the run cannot be reached from here: the bus is not configured')
        return self.publisher


def _stop_outcome(answer: Mapping[str, Any]) -> str:
    """``stopped: 2 task(s) closed`` or ``stopping: fixer-2 saving`` (what the conversation says came of a Stop)."""
    if answer.get('status') == 'stopping':
        saving = ', '.join(str(agent) for agent in answer.get('saving') or []) or 'its agents'
        return f'stopping: {saving} saving a checkpoint, then the run ends'
    closed = len(answer.get('tasks_closed') or [])
    fell_back = ' (the agents could not be asked to save: stopped at once)' if answer.get('fell_back') else ''
    return f"{answer.get('status')}: {closed} task(s) closed{fell_back}"


def _publish(publisher: Publisher, message: Message) -> None:
    try:
        publisher.publish(message)
    except MessageError as exc:   # (the one check a person's words can fail: a credential in them)
        raise MonitorError('invalid', 'This holds something shaped like a credential: take it out') from exc
    except (PublishError, ClientError, BotoCoreError) as exc:
        raise MonitorError('unavailable', 'the run could not be reached: retry') from exc
