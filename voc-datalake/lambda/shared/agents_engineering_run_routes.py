"""The run workspace's routes (7.51.00; included by ``api/agents_handler.py``).

    GET  /agents/engineering/runs?month=&flow=&status=&cursor=&limit=     -> {runs, next}
    GET  /agents/engineering/<run>/agents/<agent>/thread?after=&limit=    -> {items, next, done}
    GET  /agents/engineering/<run>/agents/<agent>/thread/<ref>            -> the item's whole event
    GET  /agents/engineering/<run>/agents/<agent>/changes?source=&attempt=&key=
                                                                          -> {source, key, commit, attempt, files,
                                                                              truncated, patches, commit_url, pr_url}
    GET  /agents/engineering/<run>/agents/<agent>/changes/file?key=&path= -> {path, key, patch, truncated}
    GET  /agents/engineering/<run>/agents/<agent>/files                   -> {files, truncated}
    GET  /agents/engineering/<run>/agents/<agent>/gate                    -> {key, record, checks, passed, packs, ran_at}
    GET  /agents/engineering/<run>/agents/<agent>/memory                  -> {recalled, learned}
    GET  /agents/engineering/<run>/assertions                             -> [{step, check, args, on_fail, status,
                                                                              detail, attempt, at}]
    GET  /agents/engineering/<run>/retrospective                         -> {run_id, status, ended, failure_count,
                                                                              failures, scorecards, coached, learned,
                                                                              cross_run}
    POST /agents/engineering/<run>/steer {text, about?, thread_id?}       -> 202 {message: {event_id, thread_id, at}}
    POST /agents/engineering/<run>/restart {mode, agents?, base, confirm} -> 202 {run: {run_id, parent_run_id, status}}

What each reads: engineering/views.py (the runs list, the assertions), views_thread.py (the thread), views_inspector.py
(the inspector's tabs); the run monitor (engineering/monitor.py) for the steering. The run overview, the signals (a
restart among them) and a person's answers stay in agents_handler.py, extended in monitor.py.

Administrators only, acting for themselves (403 for anyone else, a delegated credential included), as every
``/agents/engineering/*`` route; 404 while the engineering agents are off, for an unknown run or an agent not in it;
503 when the table or the bucket cannot be read. Engineering data is the deployment's (``WS#default#…``,
``ws/default/…``), like the agents (phase 3 of docs/multi-workspace.md).

**MCP for runs (7.53.00).** Three of these routes also admit the global MCP server's engineering tools
(shared/mcp_global_tools_engineering.py), each for its one operation (``_engineering_caller``, through
``project_access.delegated_engineering_allowed``): the runs list (``runs_list``), the retrospective (``run_analysis``)
and the steering (``run_steer``). The principal is never an admin (a write token whose minter is still an
administrator, re-checked by the MCP Lambda on every call); its steering is logged with ``via: mcp:<token>`` and the
minter, and the conversation records it as the minter's, marked as sent over MCP (``MCP_STEER_MARK``). Every other
route here, the restart included, refuses it.

- **Steering** is a person's instruction to the run's orchestrator (D51-4): ``msg.steer`` from the API's source to the
  run's conductor, recorded in the conversation by the router (who and when, D4) and logged with the person; the
  coordinator relays it to an agent or a role (bus/senders.py). Optionally ``about`` one agent of the run. 409 for an
  ended run, 503 without the bus.
- **Restart** of an ended run (D51-3: done, failed or stopped, at its 30 days or out of budget) is a child run: the
  start function's ``restart_run`` (``voc-engineering-start``, the one function this role invokes for it) writes the
  child with its parent and the parent's ``CHILD#`` row, copies its caps, connection and flow, and seeds the agents
  named (every unfinished task's when none is) from their checkpoints and patches: ``resume`` with them, ``restart``
  afresh, on the ``same`` commit or the repository's ``head``. 409 while the run is live (restart an agent there with
  the ``restart`` signal); ``confirm: true`` is required. The child's id is minted here: an answer that could not be
  read is a 503 naming it, so the person opens it rather than restarting twice.

Kept in ``shared/`` because an API bundle ships ``api/<handler>.py`` and ``shared/`` only
(api/test/test_api_bundle_imports.py); the engineering package ships beside it only with the module on, so it is
imported inside each route.
"""
from __future__ import annotations

import os
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import cache
from typing import Any, Final

from aws_lambda_powertools.event_handler.api_gateway import Router
from botocore.exceptions import BotoCoreError, ClientError

from shared import engineering_agent_runs as eng_runs
from shared.agents_store import get_agents_table
from shared.api import validate_int
from shared.engineering_agents import RUN_STATUSES, engineering_agents_on
from shared.exceptions import (
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationError,
)
from shared.logging import logger, tracer
from shared.project_access import Caller, claims_from_event, delegated_engineering_allowed, mcp_via
from shared.project_gate import caller_from_event, require_admin_caller
from shared.request_body import json_object_body
from shared.route_answers import json_response as _json

__all__ = ['app']

RUN_NOT_FOUND: Final = 'Engineering run not found'
AGENT_NOT_FOUND: Final = 'No such agent in this run'
UNREADABLE: Final = 'the run could not be read: retry'
#: A month of the runs list, ``yyyy-mm``.
_MONTH: Final = re.compile(r'20[0-9]{2}-(?:0[1-9]|1[0-2])\Z')
RESTART_MODES: Final = ('resume', 'restart')
RESTART_BASES: Final = ('same', 'head')
RESTART_FIELDS: Final = frozenset({'mode', 'agents', 'base', 'confirm'})
MAX_RESTART_AGENTS: Final = 50
MAX_QUERY_TEXT: Final = 1_000
#: What the conversation records before steering a local assistant sent over MCP (7.53.00): it is the minter's, and
#: said to be relayed, so the run's own record shows how it came.
MCP_STEER_MARK: Final = '(sent from a local assistant over MCP) '
#: A retrospective's failures, at most (its count covers all of them), and each reason or note, at most.
MAX_LISTED_FAILURES: Final = 50
MAX_REASON_CHARS: Final = 400
#: The cross-run summary of a run that follows no flow (7.53.00, the scheduled cross-run Learn pass: its newest weekly
#: record of the run's flow otherwise, ``agents_engineering_learn_routes.latest_summary``).
CROSS_RUN_UNAVAILABLE: Final = {'available': False, 'reason': 'the run follows no flow'}

app = Router()


def _caller() -> Caller:
    return caller_from_event(app.current_event.raw_event)


def _engineering_caller(op: str | None = None) -> Caller:
    """An administrator acting for themselves, or, for ``op``, the global MCP server's engineering tool of that one
    operation (never an admin: see the module's header); 403 for anyone else."""
    caller = _caller()
    if op is not None and caller.delegated and not caller.agent_id and delegated_engineering_allowed(
            claims_from_event(app.current_event.raw_event), op):
        return caller
    require_admin_caller(caller)
    return caller



def _query(name: str) -> str | None:
    params = app.current_event.query_string_parameters or {}
    value = params.get(name)
    if value is not None and len(value) > MAX_QUERY_TEXT:
        raise ValidationError(f'{name} is at most {MAX_QUERY_TEXT} characters')
    return value


def _tables(op: str | None = None) -> tuple[str, str]:
    """The engineering table and bucket, for an administrator (or ``op``'s MCP tool): 404 while the module is off,
    then 403 for anyone else."""
    table, bucket = os.environ.get('ENGINEERING_TABLE', ''), os.environ.get('ENGINEERING_WORKSPACE_BUCKET', '')
    if not (engineering_agents_on() and table and bucket):
        raise NotFoundError(RUN_NOT_FOUND)
    _engineering_caller(op)
    return table, bucket


def _id(value: str, missing: str) -> str:
    from engineering.workspace.layout import ID  # (the package ships only with the module)

    if not ID.fullmatch(value):
        raise NotFoundError(missing)
    return value


def _read[T](read: Callable[[], T]) -> T:
    """``read()``, a failed read of the table or the bucket answered 503."""
    try:
        return read()
    except (ClientError, BotoCoreError) as exc:
        logger.exception('engineering: a run workspace read failed')
        raise ServiceUnavailableError(UNREADABLE) from exc


@dataclass(frozen=True)
class _Reads:
    client: Any
    table: str
    thread: Any
    tabs: Any


def _reads(run_id: str) -> _Reads:
    """The run's readers, for an administrator (404 for a bad or unknown run id)."""
    table, bucket = _tables()
    _id(run_id, RUN_NOT_FOUND)
    from engineering.run_objects import RunObjects
    from engineering.views_inspector import AgentTabs
    from engineering.views_thread import ThreadView
    from shared.aws import get_dynamodb_client, get_s3_client

    client = get_dynamodb_client()
    objects = RunObjects(get_s3_client(), bucket)
    thread = ThreadView(client, table, objects)
    return _Reads(client, table, thread, AgentTabs(client, table, objects, thread))


def _subject(reads: _Reads, run_id: str, agent_id: str) -> Any:
    """The run's agent (404 for an unknown run or an agent not in it)."""
    from engineering.rows import get_row, run_pk

    _id(agent_id, AGENT_NOT_FOUND)
    if _read(lambda: get_row(reads.client, reads.table, {'pk': {'S': run_pk('default', run_id)}, 'sk': {'S': 'META'}})) \
            is None:
        raise NotFoundError(RUN_NOT_FOUND)
    subject = _read(lambda: reads.thread.subject(run_id, agent_id))
    if subject is None:
        raise NotFoundError(AGENT_NOT_FOUND)
    return subject


def _found[T](value: T | None, missing: str = RUN_NOT_FOUND) -> T:
    if value is None:
        raise NotFoundError(missing)
    return value


@app.get('/agents/engineering/runs')
@tracer.capture_method
def list_engineering_runs():
    """The deployment's runs by the month they started (``?month=yyyy-mm``, this month by default), newest first, of
    one flow (``flow=<workflow id>``) or in one status (``status=``) when named, a page at a time (``cursor=`` the
    ``next`` a page gave; ``limit`` at most 100). Also the MCP tool ``engineering_runs_list``'s."""
    table, _ = _tables('runs_list')
    from engineering.views import MAX_RUNS_PAGE, EngineeringViews, ListCursorError
    from engineering.workspace.layout import ID
    from engineering.workspace.store import WorkspaceStore
    from shared.aws import get_dynamodb_client, get_s3_client

    month = _query('month') or datetime.now(UTC).strftime('%Y-%m')
    if not _MONTH.fullmatch(month):
        raise ValidationError('month is yyyy-mm')
    flow, status = _query('flow'), _query('status')
    if flow is not None and not ID.fullmatch(flow):
        raise ValidationError('flow is a workflow id')
    if status is not None and status not in RUN_STATUSES:
        raise ValidationError(f'status is one of {", ".join(RUN_STATUSES)}')
    limit = validate_int(_query('limit'), default=50, min_val=1, max_val=MAX_RUNS_PAGE)
    views = EngineeringViews(get_dynamodb_client(), table, WorkspaceStore(get_s3_client(), os.environ.get(
        'ENGINEERING_WORKSPACE_BUCKET', ''), denied_is_missing=True))
    try:
        return _read(lambda: views.runs(month, flow=flow, status=status, cursor=_query('cursor'), limit=limit))
    except ListCursorError as exc:
        raise ValidationError(str(exc)) from exc


@app.get('/agents/engineering/<run_id>/agents/<agent_id>/thread')
@tracer.capture_method
def get_engineering_thread(run_id: str, agent_id: str):
    """A page of the agent's thread (engineering/views_thread.py): ``after`` the ``next`` a page gave (or the overview's
    ``transcript_cursor``: its tail), at most ``limit`` (200) new items."""
    reads = _reads(run_id)
    subject = _subject(reads, run_id, agent_id)
    from engineering.views_thread import MAX_PAGE, CursorError, decode_cursor

    try:
        cursor = decode_cursor(_query('after'))
    except CursorError as exc:
        raise ValidationError(str(exc)) from exc
    limit = validate_int(_query('limit'), default=MAX_PAGE, min_val=1, max_val=MAX_PAGE)
    return _read(lambda: reads.thread.page(run_id, subject, cursor, limit))


@app.get('/agents/engineering/<run_id>/agents/<agent_id>/thread/<ref>')
@tracer.capture_method
def get_engineering_thread_item(run_id: str, agent_id: str, ref: str):
    """One item's whole event (a tool call with its result); 404 for a ref the agent's thread does not hold."""
    reads = _reads(run_id)
    subject = _subject(reads, run_id, agent_id)
    return _found(_read(lambda: reads.thread.event(run_id, subject, ref)), 'No such item in this thread')


def _attempt() -> int | None:
    raw = _query('attempt')
    if raw is None:
        return None
    if not raw.isdigit() or not 1 <= int(raw) <= 9999:
        raise ValidationError('attempt is a whole number from 1 to 9999')
    return int(raw)


def _host_of(connection: str) -> str:
    """A connection's host kind (``github`` for one that is not stored any more: its link reads as GitHub's)."""
    table = get_agents_table()
    row = eng_runs.connection_row(table, connection) if table is not None and connection else None
    return eng_runs.connection_host(row or {})


@app.get('/agents/engineering/<run_id>/agents/<agent_id>/changes')
@tracer.capture_method
def get_engineering_changes(run_id: str, agent_id: str):
    """The agent's patches and one parsed into its files (``source=submitted|checkpoint``, ``attempt=``, ``key=`` one
    of its patches), with the run's pull request's and pushed change's addresses (engineering/views_inspector.py)."""
    reads = _reads(run_id)
    subject = _subject(reads, run_id, agent_id)
    from engineering.views_inspector import SOURCES

    source = _query('source')
    if source is not None and source not in SOURCES:
        raise ValidationError(f'source is {" or ".join(SOURCES)}')
    attempt = _attempt()
    return _read(lambda: reads.tabs.changes(subject, source=source, attempt=attempt, key=_query('key'),
                                            host=_host_of))


@app.get('/agents/engineering/<run_id>/agents/<agent_id>/changes/file')
@tracer.capture_method
def get_engineering_change_file(run_id: str, agent_id: str):
    """One file's part of one of the agent's patches (``key=`` the patch, ``path=`` the file), at most 1 MB."""
    reads = _reads(run_id)
    subject = _subject(reads, run_id, agent_id)
    key, path = _query('key'), _query('path')
    if not key or not path:
        raise ValidationError('key is one of the agent\'s patches, and path a file of it')
    return _found(_read(lambda: reads.tabs.file_patch(subject, key, path)), 'No such file in this patch')


@app.get('/agents/engineering/<run_id>/agents/<agent_id>/files')
@tracer.capture_method
def get_engineering_agent_files(run_id: str, agent_id: str):
    """The files the agent's tool calls read, listed or wrote (its transcript)."""
    reads = _reads(run_id)
    subject = _subject(reads, run_id, agent_id)
    return _read(lambda: reads.tabs.files(subject))


@app.get('/agents/engineering/<run_id>/agents/<agent_id>/gate')
@tracer.capture_method
def get_engineering_agent_gate(run_id: str, agent_id: str):
    """The agent's gate record (voc-gate-record/1) and its latest gate run's checks with their output tails."""
    reads = _reads(run_id)
    subject = _subject(reads, run_id, agent_id)
    return _read(lambda: reads.tabs.gate(subject))


@app.get('/agents/engineering/<run_id>/agents/<agent_id>/memory')
@tracer.capture_method
def get_engineering_agent_memory(run_id: str, agent_id: str):
    """The lessons the agent's brief recalled and what Learn made of its task's failures."""
    reads = _reads(run_id)
    subject = _subject(reads, run_id, agent_id)
    return _read(lambda: reads.tabs.memory(subject))


@app.get('/agents/engineering/<run_id>/assertions')
@tracer.capture_method
def get_engineering_assertions(run_id: str):
    """Every step's assertions, as the run's flow declares them, with what the board recorded of each."""
    reads = _reads(run_id)
    from engineering.views import EngineeringViews
    from engineering.workspace.store import WorkspaceStore
    from shared.aws import get_s3_client

    views = EngineeringViews(reads.client, reads.table, WorkspaceStore(get_s3_client(), os.environ.get(
        'ENGINEERING_WORKSPACE_BUCKET', ''), denied_is_missing=True))
    return _json(200, _found(_read(lambda: views.assertions(run_id))))


def _failure_view(failure: Any, display: Callable[[str], str]) -> dict[str, Any]:
    attempt = failure.attempt
    return {'key': failure.key, 'task_id': attempt.task.task_id, 'attempt': attempt.attempt, 'role': attempt.role,
            'agent': attempt.agent or None, 'version': attempt.version, 'how': failure.how,
            'reason': display(attempt.reason)[:MAX_REASON_CHARS] or None}


def _score_view(line: Any) -> dict[str, Any]:
    return {'role': line.role, 'version': line.version, 'tasks_done': line.tasks_done,
            'tasks_failed': line.tasks_failed, 'needs_human': line.needs_human, 'reposts': line.reposts,
            'review_rounds': line.review_rounds, 'attempts': line.attempts, 'cost_usd': float(line.cost_usd),
            'seconds': line.seconds}


def _learned_view(row: Mapping[str, Any], display: Callable[[str], str]) -> dict[str, Any]:
    from engineering.rows import string_attr

    version = row.get('proposed_version', {}).get('N', '0') if isinstance(row.get('proposed_version'), Mapping) else '0'
    return {'key': string_attr(row, 'sk').removeprefix('LEARNED#'),
            'lesson': display(string_attr(row, 'lesson'))[:MAX_REASON_CHARS] or None,
            'coach': display(string_attr(row, 'coach'))[:MAX_REASON_CHARS] or None,
            'proposed_version': int(version) if str(version).isdigit() and int(version) > 0 else None,
            'memory_id': string_attr(row, 'memory_id') or None, 'at': string_attr(row, 'at') or None}


@app.get('/agents/engineering/<run_id>/retrospective')
@tracer.capture_method
def get_engineering_retrospective(run_id: str):
    """The run's retrospective, as Learn builds it from the run's own record (engineering/learning/retrospective.py, by
    rule, no model call): its failures (most severe first, at most 50), a scorecard line per skill version, the failures
    Learn took to the coach and what came of each (the lesson it drafted, the coach's words: model text), and the
    cross-run summary's seam. A live run's is its record so far (``ended`` false). Also the MCP tool
    ``engineering_run_analysis``'s (7.53.00)."""
    table, bucket = _tables('run_analysis')
    _id(run_id, RUN_NOT_FOUND)
    from engineering.learning.loop import CHOSEN_SK
    from engineering.learning.records import RunRecordReader
    from engineering.learning.retrospective import build_retrospective
    from engineering.rows import get_row, run_pk, run_rows
    from engineering.runtime.runs import ENDED
    from engineering.views_thread import display
    from engineering.workspace.store import WorkspaceStore
    from shared.aws import get_dynamodb_client, get_s3_client

    client = get_dynamodb_client()
    reader = RunRecordReader(client, table, WorkspaceStore(get_s3_client(), bucket, denied_is_missing=True))
    record = _found(_read(lambda: reader.read('default', run_id)))
    retro = build_retrospective(record)
    chosen = _read(lambda: get_row(client, table, {'pk': {'S': run_pk('default', run_id)},
                                                   'sk': {'S': CHOSEN_SK}}))
    learned = _read(lambda: run_rows(client, table, 'default', run_id, 'LEARNED#'))
    keys = (chosen or {}).get('keys', {}).get('L') if chosen is not None else None
    meta = _read(lambda: get_row(client, table, {'pk': {'S': run_pk('default', run_id)}, 'sk': {'S': 'META'}}))
    flow = str((meta or {}).get('flow', {}).get('S', '')) if meta is not None else ''
    if flow:
        from shared.agents_engineering_learn_routes import latest_summary
        cross_run = latest_summary(get_s3_client(), bucket, flow)
    else:
        cross_run = dict(CROSS_RUN_UNAVAILABLE)
    return {'run_id': run_id, 'status': record.status, 'ended': record.status in ENDED,
            'failure_count': retro.failure_count,
            'failures': [_failure_view(failure, display) for failure in retro.failures[:MAX_LISTED_FAILURES]],
            'scorecards': [_score_view(line) for line in retro.scorecards],
            'coached': None if keys is None else [str(key.get('S', '')) for key in keys if isinstance(key, Mapping)],
            'learned': [_learned_view(row, display) for row in learned],
            # (the scheduled cross-run Learn pass's newest weekly record of the run's flow, labelled as model text)
            'cross_run': cross_run}


# ── The actions ──────────────────────────────────────────────────────────────

_MONITOR_ERRORS: Final = {'invalid': ValidationError, 'not_found': NotFoundError, 'conflict': ConflictError,
                          'unavailable': ServiceUnavailableError}


def _acting_monitor(run_id: str, op: str | None = None) -> tuple[Any, Caller]:
    """The run monitor and its caller for an action, checked before the body is read: while the module is off every
    caller gets 404, then anyone but an administrator (or ``op``'s MCP tool) 403, then a bad or unknown run id 404.
    Its bus is the API's source on the engineering bus (none: the steering answers 503)."""
    table, _ = _tables(op)
    _id(run_id, RUN_NOT_FOUND)
    from engineering.bus.publish import EventBridgePublisher
    from engineering.monitor import API_SOURCE, RunMonitor
    from engineering.runtime.runs import RunStore
    from engineering.runtime.sessions import SessionStore
    from shared.aws import get_dynamodb_client, get_dynamodb_resource, get_eventbridge_client

    bus = os.environ.get('ENGINEERING_BUS_NAME', '')
    engineering = get_dynamodb_resource().Table(table)
    monitor = RunMonitor(get_dynamodb_client(), table, SessionStore(engineering, RunStore(engineering)),
                         signaller=None,
                         publisher=EventBridgePublisher(get_eventbridge_client(), bus, API_SOURCE) if bus else None)
    caller = _caller()
    if not _read(lambda: monitor.run_exists(run_id)):
        raise NotFoundError(RUN_NOT_FOUND)
    return monitor, caller


def _refused(act: Callable[[], Any]) -> Any:
    """``act()``, the monitor's refusal answered with its status, a failed read 503."""
    from engineering.monitor import MonitorError

    try:
        return _read(act)
    except MonitorError as refused:
        raise _MONITOR_ERRORS[refused.kind](str(refused)) from refused


@app.post('/agents/engineering/<run_id>/steer')
@tracer.capture_method
def steer_engineering_run(run_id: str):
    """``{text, about?, thread_id?}`` → 202 ``{message: {event_id, thread_id, at}}``: a person's instruction to the run's
    orchestrator (``msg.steer`` to the conductor; recorded in the conversation, logged with who sent it)."""
    monitor, caller = _acting_monitor(run_id, 'run_steer')
    from engineering.monitor import Actor, parse_steer

    body = json_object_body(app)
    via = mcp_via(caller, claims_from_event(app.current_event.raw_event))
    if via is not None and isinstance(body.get('text'), str):
        # (MCP for runs: the minter's steering, marked as relayed by a local assistant; the 1 KB holds with the mark)
        body = {**body, 'text': f'{MCP_STEER_MARK}{body["text"].strip()}'}
    sent = _refused(lambda: monitor.steer(run_id, parse_steer(body), Actor(caller.subject,
                                                                            caller.username or caller.subject)))
    if via is not None:
        logger.info('engineering: steering sent over MCP', extra={'run_id': run_id, 'via': via, 'by': caller.subject,
                                                                  'event_id': sent.get('event_id')})
    return _json(202, {'message': sent})


@dataclass(frozen=True)
class Restart:
    mode: str
    agents: tuple[str, ...]
    base: str


def parse_restart(body: Mapping[str, Any]) -> Restart:
    """``{mode: resume | restart, agents?: [agent ids], base: same | head, confirm: true}``."""
    from engineering.workspace.layout import ID

    if not set(body) <= RESTART_FIELDS:
        raise ValidationError('the body is {mode, agents?, base, confirm}')
    mode, base, agents = body.get('mode'), body.get('base', 'same'), body.get('agents')
    if mode not in RESTART_MODES:
        raise ValidationError('mode is resume (from the agents\' checkpoints) or restart (their tasks afresh)')
    if base not in RESTART_BASES:
        raise ValidationError('base is same (the run\'s commit) or head (the repository\'s head now)')
    if agents is not None and not (isinstance(agents, list) and 0 < len(agents) <= MAX_RESTART_AGENTS
                                   and all(isinstance(agent, str) and ID.fullmatch(agent) for agent in agents)):
        raise ValidationError(f'agents is a list of 1 to {MAX_RESTART_AGENTS} agent ids of the run (none: every '
                              'unfinished task)')
    if body.get('confirm') is not True:
        raise ValidationError('a restart starts a new run of this one: send confirm: true')
    return Restart(str(mode), tuple(dict.fromkeys(agents or ())), str(base))


@cache
def _start_client() -> Any:
    """The Lambda client for the start function (built once per container): it waits
    ``START_READ_TIMEOUT_SECONDS`` and never retries by itself."""
    import boto3
    from botocore.config import Config

    return boto3.client('lambda', config=Config(read_timeout=eng_runs.START_READ_TIMEOUT_SECONDS, connect_timeout=5,
                                                retries={'total_max_attempts': 1}))


@app.post('/agents/engineering/<run_id>/restart')
@tracer.capture_method
def restart_engineering_run(run_id: str):
    """``{mode, agents?, base, confirm: true}`` → 202 ``{run: {run_id, parent_run_id, status}}``: an ended run resumed
    or restarted as a child run, through the start function's ``restart_run``; 409 while the run is live."""
    monitor, caller = _acting_monitor(run_id)
    restart = parse_restart(json_object_body(app))
    if not _refused(lambda: monitor.ended(run_id)):
        raise ConflictError('The run is live: restart one of its agents with the restart signal (from its checkpoint '
                            'or afresh), or stop the run first.')
    known = {session.agent_id for session in _read(lambda: monitor.sessions.of_run(run_id))}
    unknown = [agent for agent in restart.agents if agent not in known]
    if unknown:
        raise ValidationError(f'agents not in this run: {", ".join(unknown[:5])}')
    function = os.environ.get(eng_runs.START_FUNCTION_ENV, '')
    if not function:
        raise ServiceUnavailableError('runs cannot be restarted from here: the deployment names no start function')
    child = eng_runs.new_run_id()
    request: dict[str, Any] = {'action': 'restart_run', 'run_id': run_id, 'child_run_id': child, 'mode': restart.mode,
                               'base': restart.base, 'actor': caller.subject}
    if restart.agents:
        request['agents'] = list(restart.agents)
    answer = eng_runs.invoke_start(_start_client(), function, request, run_id=child)
    if answer.outcome == 'uncertain':
        return _json(503, {'error': f'run {child} may have been started: open it before you restart this run again',
                           'run_id': child})
    if answer.outcome == 'refused':
        raise ConflictError(answer.message or 'the runtime refused the restart')
    if answer.outcome != 'started' or answer.payload is None:
        raise ServiceUnavailableError(answer.message or 'the engineering runtime could not be reached: restart again')
    logger.info('Engineering run restarted', extra={'run_id': run_id, 'child_run_id': child, 'mode': restart.mode,
                                                    'base': restart.base, 'by': caller.subject})
    return _json(202, {'run': {'run_id': child, 'parent_run_id': run_id,
                               'status': str(answer.payload.get('status', 'active'))}})
