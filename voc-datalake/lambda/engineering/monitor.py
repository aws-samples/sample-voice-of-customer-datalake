"""The run monitor (plan v3, 4.10): what a person sees of a run under way, and the things they may do to it.

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
(``engineering.runtime.ports.RunControl.budget``) once it is wired. And (7.51.02) what of it can be reached from here,
each by its own flag: ``steer_available`` (the bus is named: steering and answers), ``signals_available`` and
``stop_available`` (the start function is: the signals and the Stop).

The actions (the route lets only an admin acting for themselves take them, like a run's ``decision``):

- ``signal``: ``save``, ``pause``, ``resume``, ``shutdown``, ``stop_now`` (4.5) or (7.51.00) ``restart``, to the agent
  on a task or (Save, Pause, Resume) to the whole run. A signal to an agent names the attempt the person saw (the
  task's lease epoch): if the task has moved on (another attempt, no holder, or it has ended), it is refused, so
  nobody signals an agent they did not see. ``stop_now`` (no checkpoint) asks for ``confirm``. Since 7.51.02 it goes
  through voc-engineering-start's ``signal_run`` (``LambdaSignaller``: the API's role invokes that function and never
  the runtime's, whose actions IAM cannot tell apart), which checks the run, the agent and the state again (no signal
  while a Stop is under way), records who asked what of whom on the run's ``RUNLOG#`` rows (D4, with the note) and
  hands it on to the supervisor (``voc-engineering-runtime``'s ``signal``, idempotent per agent: a paused agent
  paused again is unchanged; one another move holds is left as it is, and the person sends it again). The answer
  says it was sent; the overview shows what came of it.
- ``message``: a person's answer (``msg.answer``) to an agent of the run or to its conductor, on the thread they
  reply to or a new one, and ``steer`` (7.51.00, ``msg.steer``): a person's instruction to the run's orchestrator.
  The two things a person says on the bus, published from the API's own source (``API_SOURCE``), which since 7.51.02
  may say those two types and nothing else (``bus/senders.py`` ``API_TYPES``; its role's grant on the bus is held to
  them too). The router writes each to the conversation, its record.
- ``stop`` (7.50.03): a person's Stop of the whole run, ``stop`` (each agent saves a checkpoint, then the run ends) or
  ``stop_now`` (at once, asking ``confirm``), through voc-engineering-start's ``stop_run`` (``LambdaStopper``), so it
  needs neither the runtime nor the bus here and ends the run whatever its agents are doing, a run with no session at
  all included (``runtime/stop.py``). Its record is the run's ``RUNLOG#`` row (who, how, when: D4). A whole-run Shut
  down or Stop now sent as a ``signal`` is this Stop.

A run that has ended (``META.ended_at``) takes none of them. Without the start function the signals and the Stop are
``unavailable``; without the bus, steering and answers; so is a failed call (the caller retries: the supervisor's
signal and the Stop are idempotent). A person acts on no task of the board from here (7.58.00): their actions would
publish the board's ``task.*`` events as the person from the API's source, which the bus does not take from it
(7.51.02), so the routes that always refused them, and their ``board_available`` flag, are gone; a person's go on the
run (``POST …/go``) stays, its row the record.
"""
from __future__ import annotations

import json
import os
from collections import defaultdict
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Protocol

from botocore.exceptions import BotoCoreError, ClientError

from engineering import run_overview
from engineering.board.model import FINAL, NEEDS_HUMAN, OPEN, PERSON_PREFIX, Task
from engineering.bus.publish import PublishError, new_event_id
from engineering.bus.schema import MAX_SUMMARY_BYTES, Message, MessageError, Party, summary_text
from engineering.connectors.identity import WORKSPACE
from engineering.flow.record import run_flow
from engineering.learning.reactions import ReactionsStore
from engineering.learning.reactions import view as reactions_view
from engineering.rows import Refused, amount_attr, budget_view, run_pk, run_rows, string_attr
from engineering.run_links import run_links
from engineering.run_objects import RunObjects
from engineering.runtime.caps import DEFAULT_KIRO_CREDIT_PRICE, KIRO_CREDIT_PRICE_ENV, credit_usd, kiro_credit_price
from engineering.runtime.interface import MICRO_CREDITS, MICRO_PER_CREDIT, RuntimeRefused
from engineering.runtime.run_signals import ENDED_AT_A_PERSON
from engineering.runtime.runs import ENDED
from engineering.runtime.sessions import AgentSession
from engineering.workspace.layout import ID
from shared.dynamo_paging import iter_query
from shared.flow_expand import recorded_expansion
from shared.logging import logger

API_SOURCE = 'voc.engineering/api'
SIGNALS = ('save', 'pause', 'resume', 'shutdown', 'stop_now', 'restart')
#: Where a restarted agent starts again (7.51.00): its newest checkpoint, or its task afresh (its attempt re-posted).
RESTART_FROM = ('checkpoint', 'fresh')
#: A person's Stop of the whole run (runtime/runs.py STOP, STOP_NOW), and the whole-run signal that is each one.
STOP, STOP_NOW = 'stop', 'stop_now'
WHOLE_RUN_STOPS = {'shutdown': STOP, 'stop_now': STOP_NOW}
#: What voc-engineering-start answers a Stop with (stop.Stopped): the run's status after it.
STOP_STATUSES = frozenset({'stopped', 'stopping', 'done', 'failed'})
#: What it answers a signal it recorded and handed on with (runtime/run_signals.py).
SENT = 'sent'
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
        'tokens': [_token_row(model, int(counts.get('in', 0)), int(counts.get('out', 0)), counts.get(MICRO_CREDITS))
                   for model, counts in sorted(session.tokens.items())],
    }


def _token_row(model: str, tokens_in: int, tokens_out: int, micro_credits: object) -> dict[str, Any]:
    """A model's use: its tokens; (7.58.00) a Kiro session's model (``kiro:<model>``) its credits too, and what they
    cost at the deployment's price per credit now (``credits_usd``; the ledger priced each at the price of its day)."""
    row: dict[str, Any] = {'model': model, 'input_tokens': tokens_in, 'output_tokens': tokens_out}
    if isinstance(micro_credits, int | float) and not isinstance(micro_credits, bool):
        micro = max(int(micro_credits), 0)
        row.update(credits=micro / MICRO_PER_CREDIT, credits_usd=float(credit_usd(_credit_price(), micro)))
    return row


def _credit_price() -> Decimal:
    """The deployment's price per Kiro credit (``ENGINEERING_KIRO_CREDIT_PRICE``; off its shape: the default, which
    the stack refuses at synth anyway)."""
    try:
        return kiro_credit_price(os.environ.get(KIRO_CREDIT_PRICE_ENV))
    except RuntimeRefused:
        return DEFAULT_KIRO_CREDIT_PRICE


def _by_model(agents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    totals: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    credited: dict[str, int] = {}
    for agent in agents:
        for used in agent['tokens']:
            sums = totals[used['model']]
            sums[0] += used['input_tokens']
            sums[1] += used['output_tokens']
            if 'credits' in used:
                credited[used['model']] = credited.get(used['model'], 0) + round(used['credits'] * MICRO_PER_CREDIT)
    return [_token_row(model, sums[0], sums[1], credited.get(model)) for model, sums in sorted(totals.items())]


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
    """A signal's note (why), checked before anything is done: its ``RUNLOG#`` record keeps it (7.51.02), never a
    credential-shaped string."""
    if not isinstance(note, str) or len(note.encode('utf-8')) > MAX_NOTE_BYTES:
        raise MonitorError('invalid', f'note is a string of at most {MAX_NOTE_BYTES} bytes')
    try:
        return summary_text(note).strip()
    except MessageError as exc:
        raise MonitorError('invalid', 'This holds something shaped like a credential: take it out') from exc


@dataclass(frozen=True)
class StopRequest:
    """A person's Stop of the whole run: ``stop`` (save, then stop) or ``stop_now``."""
    mode: str


def parse_stop(body: Mapping[str, Any]) -> StopRequest:
    """``{now?, confirm?}``: a Stop (the agents save first), or with ``now: true`` a Stop now, which stops without a
    checkpoint and so asks ``confirm: true``. Its record is the run's ``RUNLOG#`` row, which says how it was stopped."""
    now = body.get('now', False)
    if not isinstance(now, bool):
        raise MonitorError('invalid', 'now is true (Stop now, without saving) or false (Stop: save, then stop)')
    if now and body.get('confirm') is not True:
        raise MonitorError('invalid', 'Stop now stops without a checkpoint: send confirm: true')
    return StopRequest(STOP_NOW if now else STOP)


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


#: The start function's refusals, answered as a conflict in its words (runtime/interface.py, runtime/runs.py).
START_REFUSALS = ('RuntimeRefused', 'RunNotActive')


def _invoke_start(client: Any, function_name: str, request: Mapping[str, Any], *, unreachable: str,
                  failed: str) -> Any:
    """``request`` to voc-engineering-start, waited for: its answer's payload. Its refusal is a conflict in its words;
    a call that failed is unavailable (``unreachable``), and so is any other function error (``failed``)."""
    try:
        answer = client.invoke(FunctionName=function_name, InvocationType='RequestResponse',
                               Payload=json.dumps(request).encode())
        payload = json.loads(answer['Payload'].read() or b'{}')
    except (ClientError, BotoCoreError, ValueError, KeyError, OSError) as exc:
        raise MonitorError('unavailable', unreachable) from exc
    if answer.get('FunctionError'):
        if isinstance(payload, dict) and payload.get('errorType') in START_REFUSALS:
            raise MonitorError('conflict', str(payload.get('errorMessage', 'the runtime refused it'))[:MAX_LINE])
        raise MonitorError('unavailable', failed)
    return payload


class Signaller(Protocol):
    """A person's signal to the run or one of its agents (``LambdaSignaller`` calls voc-engineering-start's
    ``signal_run``)."""

    def signal(self, run_id: str, signal: Signal, *, actor: str, agent_id: str = '') -> dict[str, Any]: ...


class LambdaSignaller:
    """A person's signal through ``voc-engineering-start`` (7.51.02): ``{action: signal_run, run_id, signal, actor,
    note?, agent_id?, task_id?, attempt?, restart_from?}``, which checks the run, the agent and the state, records it
    on the run's ``RUNLOG#`` rows and hands it on to the supervisor (runtime/run_signals.py), answering ``{status:
    sent, at}``. The API's role invokes that function and never voc-engineering-runtime. Its refusal (an ended run, a
    Stop under way, a task that moved on) is a conflict in its words; any other failure is unavailable (sending it
    again records it again, and the supervisor's signal is idempotent per agent)."""

    def __init__(self, client: Any, function_name: str) -> None:
        self.client = client
        self.function_name = function_name

    def signal(self, run_id: str, signal: Signal, *, actor: str, agent_id: str = '') -> dict[str, Any]:
        """``actor``: the person who sent it (its record's, and the runtime's for who changed the run's status, a
        whole-run Resume: D4); ``agent_id``: the agent holding ``signal.task_id`` at ``signal.attempt`` ('' for the
        whole run)."""
        request: dict[str, Any] = {'action': 'signal_run', 'run_id': run_id, 'signal': signal.name, 'actor': actor}
        if signal.note:
            request['note'] = signal.note
        if agent_id:
            request |= {'agent_id': agent_id, 'task_id': signal.task_id, 'attempt': signal.attempt}
        if signal.restart_from:
            request['restart_from'] = signal.restart_from
        payload = _invoke_start(self.client, self.function_name, request,
                                unreachable='The run could not be reached: send the signal again',
                                failed='The signal could not be sent: send it again')
        if not isinstance(payload, dict) or payload.get('status') != SENT:
            raise MonitorError('unavailable', 'The signal could not be sent: send it again')
        return payload


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
        payload = _invoke_start(self.client, self.function_name, request,
                                unreachable='The run could not be reached: send the Stop again',
                                failed='The Stop could not be applied: send it again')
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
    def __init__(self, client: Any, table: str, sessions: Sessions, *, signaller: Signaller | None,
                 publisher: Publisher | None, now: Callable[[], datetime] = lambda: datetime.now(UTC),
                 stopper: Stopper | None = None, objects: RunObjects | None = None) -> None:
        """``client`` is a low-level DynamoDB client on voc-engineering; ``sessions`` the supervisor's rows;
        ``signaller`` the signals' (voc-engineering-start's ``signal_run``; None: they are unavailable), ``publisher``
        the steering's and the answers' (the bus, from the API's source; None: they are unavailable), ``stopper`` the
        Stop's (None: it is unavailable); ``objects`` the workspace bucket's run objects (an ended run's manifest;
        None: not read)."""
        self.client, self.table = client, table
        self.objects = objects
        self.sessions = sessions
        self.signaller = signaller
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
                    # (7.60.00: the connection it started on, which says whose go a token connection's push waits for)
                    'connection': string_attr(meta, 'connection') or None,
                    'flow': string_attr(meta, 'flow'), 'status': string_attr(meta, 'status'),
                    'started_at': string_attr(meta, 'started_at') or None,
                    'ended_at': string_attr(meta, 'ended_at') or None,
                    # The decision point a run waiting at a person waits at ('' for none), and a person's Stop of it
                    # (7.50.03: None for none; stopping while it has not ended).
                    'waiting_at': string_attr(meta, 'needs_human') if string_attr(meta, 'status') == 'needs_human'
                    else '',
                    # (7.51.04) And why, in the plain words its supervisor gave (7.51.03; None for none).
                    'waiting_detail': run_overview.waiting_detail(meta),
                    'stop': _stop_view(meta),
                    # Its flow's monthly budget and the highest level its flow's month passed (None: no budget).
                    'budget': budget_view(meta), **flow,
                    # The issue it was started from and its pull request (each None for none: run_links.py).
                    **run_links(self.client, self.table, WORKSPACE, run_id, meta),
                    # (7.51.00) Its cost against its cap, the run it was restarted from, an ended run's manifest.
                    **run_overview.run_cost(meta, agents, self._get(run_id, 'LEARN#spend')),
                    'parent': run_overview.parent(meta),
                    # (7.58.00) The models its start chose: one for every role, and the roles' own.
                    'models': run_overview.models(meta),
                    'manifest': run_overview.manifest(self.objects, run_id) if ended else None},
            'agents': agents,
            # (7.51.00) Each flow step's tasks and their agents (the canvas's lanes), each gate's verdict as the board
            # recorded it, and the runs restarted from this one.
            'lanes': run_overview.lanes(tasks, agents), 'gates': gates,
            'children': run_overview.children(run_rows(self.client, self.table, WORKSPACE, run_id, 'CHILD#')),
            # What of it can be reached from here (7.51.02), each by its own flag: steering and answers (the bus
            # named), the signals and the Stop (the start function named: 7.50.03 for the Stop).
            'steer_available': self.publisher is not None,
            'signals_available': self.signaller is not None,
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
                    'flow_outcome': None, 'expansion': []}, {}
        plan = found.plan
        return {'flow_revision': found.revision or None, 'flow_copied_at': found.copied_at or None,
                # The run's own copy, as its start wrote it: what the monitor draws (never the flow as saved since).
                'flow_definition': found.definition, 'flow_steps': plan.lit(),
                'flow_outcome': {'outcome': plan.outcome, 'at': plan.at or None, 'reason': _line(plan.reason)},
                # (7.52.00) The calls it expanded, as the copy records them: [{step, flow, revision, inputs?}].
                'expansion': recorded_expansion(found.definition)}, dict(plan.verdicts)

    def run_exists(self, run_id: str) -> bool:
        return self._get(run_id, 'META') is not None

    def connection_of(self, run_id: str) -> str:
        """The connection the run started on (META's ``connection``; '' for none, or no such run): a go on a run of a
        fine-grained connection is its token owner's alone (7.60.00, the Agents API's go route)."""
        return string_attr(self._get(run_id, 'META') or {}, 'connection')

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
        if holder and epoch == signal.attempt and state == NEEDS_HUMAN:
            # (7.71.04) Its agent's session ended with it: the run's own Resume tries its step again (the live
            # Bug fixer run's restart and resume of its committer's task answered "moved on").
            raise MonitorError('conflict', ENDED_AT_A_PERSON)
        if not holder or epoch != signal.attempt or state == OPEN or state in FINAL:
            raise MonitorError('conflict', 'This task has moved on since you looked: reload the run')
        if holder.startswith(PERSON_PREFIX):
            # A person took it (board/store.py take): no agent holds it, so none is signalled through it.
            raise MonitorError('conflict', 'A person holds this task: no agent works on it to signal')
        return Party('agent', holder)

    def stop(self, run_id: str, request: StopRequest, actor: Actor) -> dict[str, Any]:
        """A person's Stop of the whole run (module doc): voc-engineering-start ends it, or (a Stop whose agents have
        sessions) records it and has them save first; answers the run's status after it (``stopped`` or
        ``stopping``), the tasks it closed, the agents asked to save, and whether it fell back to stopping at once. Its
        record is the run's ``RUNLOG#`` row (who, how, when: D4); nothing is said on the bus from here (7.51.02)."""
        if self.stopper is None:
            raise MonitorError('unavailable', 'the run cannot be stopped from here: the deployment names no start '
                                              'function')
        self.open_run(run_id)
        answer = self.stopper.stop(run_id, request.mode, actor=actor.subject)
        agents = answer.get('agents')
        return {'run_id': run_id, 'mode': request.mode, 'status': str(answer.get('status')),
                'already': answer.get('already') is True, 'fell_back': answer.get('fell_back') is True,
                'tasks_closed': [str(task) for task in answer.get('tasks_closed') or []],
                'saving': [str(agent) for agent in answer.get('saving') or []],
                'agents': {str(k): str(v) for k, v in agents.items()} if isinstance(agents, dict) else {},
                'at': _at(self.now())}

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
        """A person's signal to the run or to the agent on a task (module doc), through voc-engineering-start, which
        checks the run, the agent and the state again, records it on the run's ``RUNLOG#`` rows (D4: who asked what of
        whom, when, and their note) before anything moves, and hands it on to the supervisor. Answers that it was sent
        (``status: sent``): the overview shows what came of it. A whole run's Shut down or Stop now is its Stop."""
        if not signal.task_id and signal.name in WHOLE_RUN_STOPS and self.stopper is not None:
            # A whole run's Shut down or Stop now is its Stop (7.50.03): it ends the run, whatever its agents do.
            stopped = self.stop(run_id, StopRequest(WHOLE_RUN_STOPS[signal.name]), actor)
            return {'signal': signal.name, 'target': {'kind': 'run', 'id': run_id}, 'attempt': 0,
                    'agents': stopped['agents'], 'applied': dict.fromkeys(stopped['agents'], True),
                    'at': stopped['at'], 'run': stopped}
        if self.signaller is None:
            raise MonitorError('unavailable', 'the run cannot be signalled from here: the deployment names no start '
                                              'function')
        self.open_run(run_id)
        target = self._target(run_id, signal)
        sent = self.signaller.signal(run_id, signal, actor=actor.subject,
                                     agent_id=target.id if target.kind == 'agent' else '')
        logger.info('engineering: a person signalled the run', extra={
            'run_id': run_id, 'by': actor.subject, 'signal': signal.name, 'agent': sent.get('agent_id')})
        # (what the supervisor did is the overview's to show: the signal was handed on, not waited for)
        return {'signal': signal.name, 'target': {'kind': target.kind, 'id': target.id}, 'attempt': signal.attempt,
                'status': SENT, 'agents': {}, 'applied': {}, 'at': str(sent.get('at') or _at(self.now()))}

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


def _publish(publisher: Publisher, message: Message) -> None:
    try:
        publisher.publish(message)
    except MessageError as exc:   # (the one check a person's words can fail: a credential in them)
        raise MonitorError('invalid', 'This holds something shaped like a credential: take it out') from exc
    except (PublishError, ClientError, BotoCoreError) as exc:
        raise MonitorError('unavailable', 'the run could not be reached: retry') from exc
