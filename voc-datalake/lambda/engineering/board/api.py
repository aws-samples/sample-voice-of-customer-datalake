"""The board API: the only way an agent changes the board (agents never write it themselves).

Reached through a Lambda function URL with IAM authentication: the caller's role, run and agent come from its
assumed-role identity (``engineering.connectors.identity``), never from the body. Operations
(a JSON body with ``op``): ``post`` (a task for a role the caller may post for, within the run's caps), ``claim``
(an open task of the caller's own role), ``renew`` (the heartbeat: the lease's expiry moves on), ``progress`` (the
holder's progress report: ``{task_id, epoch, step, waiting?}``, published as ``task.progress``), ``move`` (the
lease holder moves its task on), ``inbox`` (the caller's notices after a seq, ``board/inbox.py``: its own, its
role's, and the conductor's for the coordinator; it reads, it changes nothing) and ``knowledge`` (``{task_id, package}``: the
approved knowledge pack of one of the caller's task's paths, or of '' the root, as data; ``{version: null}`` when none
is approved; the paths are the task spec's, the ones its agent was launched on, and the root). The run's coordinator
also has ``tasks`` (its run's tasks) and ``launch`` (``{task_id, role, language, paths}``: an agent for an open task,
through ``voc-engineering-runtime``'s ``launch`` action only, with the run's commit and connection from its META;
recorded on the task with its attempt and paths, so a retried launch launches the same agent and a repost's new
attempt a new one; the runtime's refusals answer 409, and a first launch's bad request or another task's session clears
the record with a ``launch_refused`` history row (``CLEARS_LAUNCH``) so the next launch numbers a new agent; a session
already there for the recorded agent answers 200). The board never chooses the agent's argv: the runtime derives it
from the role's skill, so a launch of a role with no skill yet, or in a language this deployment has no image for, is
refused (409) before an agent is numbered. The coordinator claims the run's ``coordinate`` task, which only the run's start writes
(``BoardStore.coordinate_items``, in the start's transaction with META, which records the run's ``commit`` and
``connection``; a run started without them answers 409 to ``launch`` and ``knowledge``, since no retry can succeed).
``knowledge`` takes the caller's ``task_id`` and reads that one task's row: the caller must hold its live lease.
The run's start launches the coordinator itself (``coordinator-1``, the runtime's ``start_run``); this op launches
the rest. A coordinator acts only while it is the run's: every op of the coordinator role first checks the caller is
the coordinate task's recorded coordinator at the task's attempt (403 "the run has another coordinator now" for one
the runtime replaced, ``BoardStore.launch_coordinator``). Each change is published on the bus as the board
(``task.*``), after the row is
written: the row is the record, the event a notification. A failed publish answers 503 and the agent retries; every
operation is idempotent, and the event's id comes from the change itself, so the retry publishes the same event again
(a redelivery its receivers dedupe), including a retried post the board answered from its ``spec_hash`` dedupe. A
retried progress report is a new report (its time is part of it).

The supervisor re-posts a task whose lease ran out with ``repost_task`` (through its ``Board.repost`` port,
engineering/runtime/board_bus.py): the store's ``repost``, then the task published again as
``task.posted`` to its role, so the delivery function records it for the role's agents to read (it wakes
nobody). Only at the attempt the supervisor judged, so it never takes a newer claim away, and published only while
its own re-post is the task's last change (a retry after a lost event publishes the same event again; a task open
at the next attempt by a person's release was published by that person). The coordinate task is written only: no role reads a ``task.posted`` for it.
"""
from __future__ import annotations

import base64
import json
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, Protocol

from botocore.exceptions import BotoCoreError, ClientError

from engineering.board.inbox import MAX_LIMIT, Inbox
from engineering.board.model import EVENT_OF, FINAL, NEEDS_HUMAN, OPEN, PERSON_PREFIX, Task
from engineering.board.store import COORDINATE_TASK, COORDINATOR, BoardError, BoardStore, Posted
from engineering.bus.publish import EventBridgePublisher, PublishError, change_event_id, new_event_id
from engineering.bus.schema import ID, ROLES, ULID, Message, MessageError, Party, Refs, fit_summary
from engineering.connectors.identity import WORKSPACE, Caller, UnknownCaller, caller_from_event, own_account
from engineering.knowledge.store import PackError
from engineering.knowledge.workspaces import ROOT
from engineering.quality_gate.text import redact
from engineering.rows import Refused
from engineering.runtime.checkout import check_sparse_path
from engineering.runtime.egress import REGISTRY_HOSTS
from engineering.runtime.harness.skills import skill_for
from engineering.runtime.interface import MAX_TASK_PATHS, RuntimeRefused
from engineering.workspace.layout import LayoutError
from shared.logging import logger, metrics

BOARD_SOURCE = 'voc.engineering/board'
MAX_TITLE = 200
#: Priorities and epochs are small numbers (DynamoDB's own limit is 38 digits).
MAX_INT = 1_000_000
STATUS = {'invalid': 400, 'forbidden': 403, 'not_found': 404, 'conflict': 409, 'cap': 429, 'unavailable': 503}
#: Who may post a task for whom (plan v3, 4.3 "Posting"): the coordinator plans the run, the hunter posts a fix task
#: per confirmed bug, the builder its own sub-tasks. A flow's definition is to narrow this further; a human's posts
#: (from the UI) are not agents' and do not come through this API.
POSTERS: Mapping[str, frozenset[str]] = {'coordinator': ROLES, 'hunter': frozenset({'fixer'}),
                                         'builder': frozenset({'builder'})}


def agent_id(caller: Caller) -> str:
    """The agent's id on the board and the bus: ``<role>-<index>`` (its run comes with it)."""
    return f'{caller.role}-{caller.agent_index}'


def _answer(status: int, body: Mapping[str, Any]) -> dict[str, Any]:
    return {'statusCode': status, 'headers': {'Content-Type': 'application/json'}, 'body': json.dumps(body)}


def _text(body: Mapping[str, Any], key: str, *, required: bool = True) -> str:
    value = body.get(key, '' if not required else None)
    if not isinstance(value, str) or (required and not value.strip()):
        raise BoardError('invalid', f'"{key}" is a string')
    return value.strip()


def _int(body: Mapping[str, Any], key: str, default: int) -> int:
    value = body.get(key, default)
    if type(value) is int and abs(value) <= MAX_INT:   # not a bool, which is an int too
        return value
    raise BoardError('invalid', f'"{key}" is a whole number of at most {MAX_INT} either way')


def _over(body: Mapping[str, Any]) -> bool:
    """``over``: a take or block may end another person's hold (false by default)."""
    over = body.get('over', False)
    if not isinstance(over, bool):
        raise BoardError('invalid', '"over" is true or false: end another person\'s hold only if you mean to')
    return over


def _object(raw_body: Any) -> dict[str, Any]:
    try:
        body = json.loads(raw_body) if isinstance(raw_body, str) else None
    except json.JSONDecodeError:
        body = None
    if not isinstance(body, dict):
        raise BoardError('invalid', 'the body is a JSON object')
    return body


def _event(task: Task, run_id: str) -> Message:
    """The task's last change as a board event; the same change always makes the same event."""
    at = datetime.fromisoformat(task.updated_at)
    kind = 'task.posted' if task.state == OPEN else EVENT_OF[task.state]
    to = Party('role', task.role) if task.state == OPEN else Party('run', run_id)
    return Message(event_id=change_event_id(at, run_id, task.task_id, task.state, str(task.attempt), task.updated_at),
                   ws=WORKSPACE, run_id=run_id, thread_id=task.task_id, task_id=task.task_id, attempt=task.attempt,
                   sender=Party('system', 'board'), to=to, type=kind,
                   summary=_summary(f'{task.title} ({task.state}, by {task.updated_by})'),
                   refs=Refs(s3=tuple(sorted(task.result_keys))),
                   at=at.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%S.%fZ'))


def _person_event(task: Task, run_id: str, subject: str, action: str) -> Message:
    """A person's change of a task (not a post) as a board event: to the run, never the role again (a re-prioritised
    open task is not a new post, and voc-msg/1 addresses a ``task.posted`` only to a role). Its type is the task's
    state, ``task.progress`` for an open one, and its summary names the action (``…: priority by a person``): a
    receiver tells it from an agent's report, whose summary starts ``progress:``, and from an agent's claim by its
    sender. Its id is the change itself (the action and the time written): a retry of it is the same event."""
    at = datetime.fromisoformat(task.updated_at)
    kind = 'task.progress' if task.state == OPEN else EVENT_OF[task.state]
    return Message(event_id=change_event_id(at, run_id, task.task_id, 'person', action, task.updated_at),
                   ws=WORKSPACE, run_id=run_id, thread_id=task.task_id, task_id=task.task_id, attempt=task.attempt,
                   sender=Party('human', subject), to=Party('run', run_id), type=kind,
                   summary=_summary(f'{task.title} ({task.state}): {action} by a person'),
                   at=at.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%S.%fZ'))


def _post_is_last(task: Task) -> bool:
    """The task is open and its post is still its last change (no later op, its poster the last to write it): an
    equal post now is a retry of that post, so its event again (the same id, from the post's own time)."""
    return task.state == OPEN and not task.updated_op and task.updated_by == task.posted_by


def _post_role(body: Mapping[str, Any]) -> str:
    """A post's role: one that claims tasks, never the coordinator's (its task is the run start's)."""
    role = _text(body, 'role')
    if role == COORDINATOR:
        raise BoardError('forbidden', 'the coordinate task is the run start\'s, never posted')
    if role not in ROLES:
        raise BoardError('invalid', 'unknown role')
    return role


def _post(store: BoardStore, run_id: str, body: Mapping[str, Any], *, role: str, actor: str) -> Posted:
    """A post's body read and written: ``{title, spec, priority?, parent_task?}`` (an agent's or a person's)."""
    title = _text(body, 'title')
    if len(title) > MAX_TITLE or redact(title) != title:
        raise BoardError('invalid', f'"title" is at most {MAX_TITLE} characters, with nothing secret in it')
    spec = body.get('spec', {})
    if not isinstance(spec, dict):
        raise BoardError('invalid', '"spec" is an object')
    return store.post(WORKSPACE, run_id, role=role, title=title, spec=spec,
                      parent_task=_text(body, 'parent_task', required=False), priority=_int(body, 'priority', 0),
                      actor=actor)


def _summary(text: str) -> str:
    """A board event's summary: cut to a summary's bytes on a character boundary and redacted as a whole (its parts
    each passed alone; joined, they could read as a credential's line), cut again (a marker can be longer than what
    it hides)."""
    return fit_summary(redact(fit_summary(text)))


def _progress_summary(task: Task) -> str:
    """``progress: <title>: <step>``."""
    return _summary(f'progress: {task.title}: {task.step}' + (' (waiting)' if task.waiting else ''))


def _progress_event(task: Task, run_id: str) -> Message:
    """The holder's progress report as a board event. Its id is the report's whole content (the epoch, the time, the
    step, waiting): a retry of the same report is the same event, and two reports in one second are two."""
    at = datetime.fromtimestamp(task.progress_at, UTC)
    return Message(event_id=change_event_id(at, task.task_id, 'progress', str(task.lease_epoch), str(task.progress_at),
                                            task.step, str(task.waiting)),
                   ws=WORKSPACE, run_id=run_id, thread_id=task.task_id, task_id=task.task_id, attempt=task.attempt,
                   sender=Party('system', 'board'), to=Party('run', run_id), type='task.progress',
                   summary=_progress_summary(task), at=at.strftime('%Y-%m-%dT%H:%M:%S.%fZ'))


def repost_task(store: BoardStore, publisher: EventBridgePublisher, ws: str, run_id: str, task_id: str,
                reason: str, attempt: int | None = None) -> Task:
    """The supervisor's re-post of the task at the ``attempt`` it judged: written, then published as ``task.posted``
    by the supervisor (``publisher`` carries its own source, ``voc.engineering/supervisor``, which may send
    ``task.posted``: bus/senders.py), so each service role publishes as one source.

    Published when this call wrote the re-post, or when the store finds it landed already and the task's last change
    is still the supervisor's own re-post at that attempt (``updated_by`` supervisor, ``updated_op`` repost): a retry
    after a lost event, which publishes the same event again (its id comes from the change: a redelivery). A task
    open at the next attempt by another's change (a person's release, which published its own ``task.posted`` as
    that person) publishes nothing, so the supervisor never sends another sender's change as its own. A task that
    moved on (a newer claim) is refused: ``BoardError``.

    The coordinate task is re-posted with no ``task.posted``: no role's agents read one for it (only the coordinator
    recorded on it claims it, ``BoardStore.launch_coordinator``), and the bus has no queue role ``coordinator``."""
    reposted = store.repost_change(ws, run_id, task_id, reason=reason, attempt=attempt)
    task = reposted.task
    if reposted.own and task.task_id != COORDINATE_TASK:
        publisher.publish(replace(_event(task, run_id), sender=Party('supervisor', 'supervisor')))
    return task


MAX_PATHS = MAX_TASK_PATHS
#: The runtime's refusals of a launch (each a ``RuntimeRefused``; a Lambda error names the class itself): a bad
#: request, a run not active, stopped or already there, a session busy, or the agent's session there for another
#: task or attempt (``StaleSession``: agents are numbered once per attempt, so never this launch's; the runtime
#: answers a repeat of the same launch with its session). The coordinator reads the message: 409.
REFUSALS = frozenset({'RuntimeRefused', 'RunNotActive', 'RunExists', 'RunStopped', 'SessionBusy', 'StaleSession'})
#: The refusals after which no session of this launch exists (the runtime answers a repeat with its session before
#: any check: runtime/handler.py ``_repeated``): a bad request (no image for the language, no skill for the role,
#: another attempt) or the agent's session there for another task. The recorded launch is cleared. A busy session
#: is the first launch still booting, and a run not active or stopped launches nothing again: those keep it.
CLEARS_LAUNCH = frozenset({'RuntimeRefused', 'StaleSession'})
#: A run whose start recorded no repository connection or commit: only a new run's start can, so never a retry.
NO_START_RECORD = ('this run was started without a repository connection or commit: start a new run with both to '
                   'launch agents or read knowledge')
#: How long the board waits for the runtime's launch (its MicroVM's start and the session row), below the board
#: function's own limit (engineering-bus.ts: 120 s), and never retried by the client: a retry is the coordinator's,
#: which the runtime answers with the session it has or refuses while the first launch is still under way.
LAUNCH_READ_TIMEOUT_SECONDS = 100


class Publisher(Protocol):
    """The bus (``EventBridgePublisher``, with its caller's own source)."""

    def publish(self, message: Message) -> object: ...


class Launcher(Protocol):
    """The runtime's launch (``LambdaLauncher`` invokes voc-engineering-runtime ``{action: launch, ...}``)."""

    def launch(self, request: Mapping[str, Any]) -> Mapping[str, Any]: ...


class Knowledge(Protocol):
    """The approved pack of a package (engineering/knowledge/store.py ``PackStore.for_agent``)."""

    def for_agent(self, ws: str, connection: str, package: str) -> Any:
        raise NotImplementedError


@dataclass(frozen=True)
class LambdaLauncher:
    """The runtime's ``launch`` action, and only it, invoked and waited for."""

    #: boto3's Lambda client (or a test's), and the runtime function's name.
    client: Any
    function_name: str

    def launch(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        try:
            answer = self.client.invoke(FunctionName=self.function_name, InvocationType='RequestResponse',
                                        Payload=json.dumps({**request, 'action': 'launch'}).encode())
        except (ClientError, BotoCoreError) as exc:
            # Lambda's refusal or a read timeout (the launch may still be under way): the runtime's, not the table's.
            raise LaunchFailed from exc
        read = json.loads(answer['Payload'].read() or b'{}')
        payload: dict[str, Any] = read if isinstance(read, dict) else {}
        if answer.get('FunctionError'):
            error = payload.get('errorType')
            if error in REFUSALS:
                logger.warning('board: the runtime refused a launch', extra={'error_type': error})
                raise LaunchRefused(str(error), str(payload.get('errorMessage', 'the runtime refused it'))[:MAX_TITLE])
            raise LaunchFailed
        return payload


class LaunchFailed(RuntimeError):
    """The runtime could not be asked, or failed: the coordinator retries (the task keeps its launched agent)."""


class LaunchRefused(BoardError):
    """The runtime refused the launch (one of ``REFUSALS``, named by ``error_type``): a 409 with its message."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__('conflict', message)
        self.error_type = error_type


def _paths(body: Mapping[str, Any]) -> list[str]:
    """The checkout's own path rule (``checkout.check_sparse_path``), so a path the runtime would refuse is refused
    before a task records it, or a launch numbers an agent on it."""
    paths = body.get('paths', [])
    if not (isinstance(paths, list) and len(paths) <= MAX_PATHS and all(isinstance(path, str) for path in paths)):
        raise BoardError('invalid', f'"paths" is a list of at most {MAX_PATHS} repository paths')
    try:
        return [check_sparse_path(path) for path in paths]
    except RuntimeRefused as exc:
        raise BoardError('invalid', str(exc)[:MAX_TITLE]) from exc


@dataclass(frozen=True)
class Outcome:
    """The task after an operation; whether its last change is published; whether a post found it already there."""

    task: Task
    publish: bool = True
    duplicate: bool = False
    #: The event that tells of it, when it is not the task's last change (a progress report).
    event: Message | None = None


class BoardApi:
    def __init__(self, store: BoardStore, publisher: EventBridgePublisher, inbox: Inbox, *,
                 launcher: Launcher | None = None, knowledge: Knowledge | None = None,
                 skill: Callable[[str], object | None] = skill_for,
                 images: frozenset[str] = frozenset(REGISTRY_HOSTS)) -> None:
        """``launcher`` and ``knowledge``: the coordinator's launch and the knowledge reads (None: refused);
        ``skill``: a role's skill (runtime/harness/skills.py), which the runtime launches it with; ``images``: the
        languages this deployment has a MicroVM image for (``ENGINEERING_IMAGE_LANGUAGES``)."""
        self.store = store
        self.publisher = publisher
        self.inbox = inbox
        self.launcher = launcher
        self.knowledge = knowledge
        self.skill = skill
        self.images = images

    def _meta(self, run_id: str) -> Mapping[str, Any]:
        meta = self.store.meta(WORKSPACE, run_id)
        if meta is None:
            raise BoardError('not_found', 'no such run')
        return meta

    def _tasks(self, caller: Caller) -> dict[str, Any]:
        if caller.role != COORDINATOR:
            raise BoardError('forbidden', 'only the run\'s coordinator lists its tasks')
        return {'tasks': [{'task_id': t.task_id, 'role': t.role, 'title': t.title, 'state': t.state,
                           'attempt': t.attempt, 'priority': t.priority, 'parent_task': t.parent_task or None}
                          for t in self.store.tasks(WORKSPACE, caller.run_id)]}

    def _launch(self, caller: Caller, body: Mapping[str, Any]) -> dict[str, Any]:
        if caller.role != COORDINATOR:
            raise BoardError('forbidden', 'only the run\'s coordinator launches agents')
        if self.launcher is None:
            raise LaunchFailed
        role, (language, paths, recorded) = _text(body, 'role'), self._launch_settings(caller, body)
        if role not in ROLES or language not in REGISTRY_HOSTS:
            # The runtime's own image languages: one it would refuse is refused before an agent is numbered on it,
            # since a retry at the attempt keeps the language it was launched with.
            raise BoardError('invalid', f'"role" is a role that claims tasks, "language" one of {sorted(REGISTRY_HOSTS)}')
        if not recorded:   # (a retry is never refused for a skill or an image a redeploy changed meanwhile)
            self._check_launchable(role, language)
        meta = self._meta(caller.run_id)
        commit, connection = meta.get('commit', {}).get('S', ''), meta.get('connection', {}).get('S', '')
        if not (commit and connection):
            # The run's start records them (RunStore.start), so a run without them never gets them: a conflict, not
            # a retry. Checked before an agent is numbered, so a launch the runtime must refuse records nothing.
            raise BoardError('conflict', NO_START_RECORD)
        task = self.store.launch(WORKSPACE, caller.run_id, _text(body, 'task_id'), role=role,
                                 actor=agent_id(caller), paths=paths, language=language)
        # A retry (the same agent at the same attempt) gets what the first launch's session answers.
        try:
            answer = self.launcher.launch({
                'run_id': caller.run_id, 'agent_id': task.launched_agent, 'role': role, 'task_id': task.task_id,
                'attempt': task.attempt, 'language': task.launched_language or language,
                'paths': list(task.launched_paths), 'commit': commit, 'connection': connection})
        except LaunchRefused as refused:
            # The runtime answers a repeat with its session, and one while the first still starts as busy, before any
            # other check: these refusals so mean no session and no launch of the agent exist, even on a retry.
            if refused.error_type in CLEARS_LAUNCH:
                self._clear_launch(caller, task, refused)
            raise
        return {'agent_id': task.launched_agent, 'status': str(answer.get('status', ''))}

    def _check_launchable(self, role: str, language: str) -> None:
        """What the runtime would refuse, refused before an agent is numbered, so a coordinator that keeps asking uses
        up none of the run's agent numbers: a role with no skill (the runtime launches a role only with its skill), a
        language this deployment has no MicroVM image for."""
        if self.skill(role) is None:
            raise BoardError('conflict', f'no {role} agent can be launched yet: the role has no skill')
        if language not in self.images:
            raise BoardError('conflict', f'no {language} image in this deployment: launch in one of '
                                         f'{sorted(self.images) or "none yet"}')

    def _launch_settings(self, caller: Caller, body: Mapping[str, Any]) -> tuple[str, list[str], bool]:
        """The language and paths the launch will send, which its checks test, and whether it is a retry of a launch
        recorded at the task's attempt (which sends the recorded ones, whatever this request names, so a launch that
        got through is never refused on a retry); else the request's."""
        current = self.store.task(WORKSPACE, caller.run_id, _text(body, 'task_id'))
        if current.launched_agent and current.launched_attempt == current.attempt:
            return current.launched_language or _text(body, 'language'), list(current.launched_paths), True
        return _text(body, 'language'), _paths(body), False

    def _clear_launch(self, caller: Caller, task: Task, refused: LaunchRefused) -> None:
        """Forget a launch the runtime refused, so the coordinator's next one, with other settings, can get through.
        A failure here is logged, never answered: the coordinator reads the runtime's refusal, which says what to
        change."""
        try:
            self.store.clear_launch(WORKSPACE, caller.run_id, task, actor=agent_id(caller), reason=str(refused))
        except (BoardError, ClientError, BotoCoreError):
            logger.exception('board: a refused launch could not be cleared', extra={'task_id': task.task_id})

    def _callers_task(self, caller: Caller, task_id: str) -> Task:
        """The task the caller names (one read of its row), when the caller holds its live lease: a task that has
        not ended, its lease the caller's and not run out (or held over an open wait)."""
        task = self.store.task(WORKSPACE, caller.run_id, task_id)
        now = int(self.store.now().timestamp())
        if task.lease_agent != agent_id(caller) or task.state in FINAL or not (task.lease_expires >= now
                                                                               or task.waiting):
            raise BoardError('forbidden', 'knowledge is read for the task whose lease one holds')
        return task

    def _knowledge(self, caller: Caller, body: Mapping[str, Any]) -> dict[str, Any]:
        if self.knowledge is None:
            raise BoardError('unavailable', 'the knowledge store is not configured here')
        package = body.get('package', '')
        if not isinstance(package, str):
            raise BoardError('invalid', '"package" is a repository path, or \'\' for the root')
        if package not in self._callers_task(caller, _text(body, 'task_id')).paths():
            raise BoardError('forbidden', 'knowledge is read only for the paths of one\'s own task, or the root')
        connection = self._meta(caller.run_id).get('connection', {}).get('S', '')
        try:   # the root's pack is the knowledge store's ROOT package ('.')
            if not connection:
                # The run's start records its connection (RunStore.start), so a run without one never gets one: a
                # conflict, never "none approved" nor a retry.
                raise BoardError('conflict', NO_START_RECORD)
            pack = self.knowledge.for_agent(WORKSPACE, connection, package or ROOT)
        except PackError as exc:
            if exc.kind != 'invalid':
                # An approved version whose object is missing, denied or unreadable, or whose row changed
                # (PackNotFound, PackUnavailable, PackConflict): the store's fault, so 503 (try again), never "none
                # approved" nor the caller's.
                raise BoardError('unavailable', 'the knowledge pack cannot be read right now') from exc
            raise BoardError('invalid', f'"package" is not a package with a knowledge pack: {exc}'[:MAX_TITLE]) from exc
        except LayoutError as exc:
            raise BoardError('invalid', f'"package" is not a package with a knowledge pack: {exc}'[:MAX_TITLE]) from exc
        return {'version': None} if pack is None else {'version': pack.version, 'text': pack.text}

    def _direct(self, caller: Caller, body: Mapping[str, Any]) -> dict[str, Any] | None:
        """The ops answered directly, with no board event (None: not one of them): the reads, and the launch, whose
        record is the task's history row and whose agent speaks for itself once it runs."""
        readers = {'inbox': self._inbox, 'knowledge': self._knowledge, 'launch': self._launch}
        op = body.get('op')
        if op == 'tasks':
            return self._tasks(caller)
        return readers[op](caller, body) if isinstance(op, str) and op in readers else None

    def _inbox(self, caller: Caller, body: Mapping[str, Any]) -> dict[str, Any]:
        after, limit = _int(body, 'after', 0), _int(body, 'limit', MAX_LIMIT)
        if after < 0 or not 1 <= limit <= MAX_LIMIT:
            raise BoardError('invalid', f'"after" is a seq (0 or more) and "limit" 1 to {MAX_LIMIT}')
        return self.inbox.read(WORKSPACE, caller.run_id, role=caller.role, agent=agent_id(caller), after=after,
                               limit=limit)

    def _post(self, caller: Caller, body: Mapping[str, Any]) -> Outcome:
        role = _post_role(body)
        if role not in POSTERS.get(caller.role, frozenset()):
            raise BoardError('forbidden', f'a {caller.role} does not post {role} tasks')
        actor = agent_id(caller)
        posted = _post(self.store, caller.run_id, body, role=role, actor=actor)
        # An equivalent task still open may be a retry whose first event was lost: publish it again (same id), while
        # the post is still its last change (after a person's priority, say, it would be a new event, not a retry)
        # and it was this caller's (another's post, a person's above all, is never published as this agent's).
        return Outcome(posted.task,
                       publish=posted.created or (posted.task.posted_by == actor and _post_is_last(posted.task)),
                       duplicate=not posted.created)

    def operate(self, caller: Caller, body: Mapping[str, Any]) -> Outcome:
        op = body.get('op')
        if op == 'post':
            return self._post(caller, body)
        task_id = _text(body, 'task_id')
        agent = agent_id(caller)
        if op == 'claim':
            return Outcome(self.store.claim(WORKSPACE, caller.run_id, task_id, role=caller.role, agent=agent))
        epoch = _int(body, 'epoch', 0)
        if op == 'renew':
            return Outcome(self.store.renew(WORKSPACE, caller.run_id, task_id, agent=agent, epoch=epoch),
                           publish=False)
        if op == 'progress':
            waiting = body.get('waiting', False)
            if not isinstance(waiting, bool):
                raise BoardError('invalid', '"waiting" is true or false')
            task = self.store.progress(WORKSPACE, caller.run_id, task_id, agent=agent, epoch=epoch,
                                       step=_text(body, 'step'), waiting=waiting)
            return Outcome(task, event=_progress_event(task, caller.run_id))
        if op == 'move':
            keys = body.get('result_keys', [])
            if not isinstance(keys, list):
                raise BoardError('invalid', '"result_keys" is a list')
            return Outcome(self.store.move(WORKSPACE, caller.run_id, task_id, agent=agent, epoch=epoch,
                                           to_state=_text(body, 'to'), result_keys=keys))
        raise BoardError('invalid', 'op is post, claim, renew, progress, move, inbox, knowledge, tasks or launch')

    def _current_coordinator(self, caller: Caller) -> None:
        """A coordinator acts only while it is the run's: the coordinate task's recorded coordinator at the task's
        attempt. Once the task is re-posted (and a new coordinator recorded on it, ``BoardStore.launch_coordinator``),
        the replaced one's session is refused every op, its claim included. A run whose start wrote no coordinate
        task (the runtime before its merge) has only its start's coordinator, so the role is all there is to check."""
        try:
            task = self.store.task(WORKSPACE, caller.run_id, COORDINATE_TASK)
        except BoardError as exc:
            if exc.kind != 'not_found':
                raise
            return
        # (A read before the op: an op racing a re-post can still go through once; the coordinate task's claim, the
        # one that would give it the run again, repeats the check in its own write, BoardStore.claim.)
        if (task.launched_agent, task.launched_attempt) != (agent_id(caller), task.attempt):
            raise BoardError('forbidden', 'the run has another coordinator now: this one stops')

    def handle_request(self, caller: Caller, raw_body: Any) -> dict[str, Any]:
        try:
            if caller.role == COORDINATOR:
                self._current_coordinator(caller)
            body = _object(raw_body)
            direct = self._direct(caller, body)
            if direct is not None:
                return _answer(200, direct)
            outcome = self.operate(caller, body)
        except BoardError as exc:
            return _answer(STATUS[exc.kind], {'error': str(exc)})
        except LaunchFailed:
            logger.exception('board: the runtime could not be reached')
            return _answer(503, {'error': 'the runtime could not be reached: retry'})
        except (ClientError, BotoCoreError):
            logger.exception('board: the table refused a call')
            return _answer(503, {'error': 'the board could not be reached: retry'})
        task = outcome.task
        if outcome.publish:
            try:
                self.publisher.publish(outcome.event or _event(task, caller.run_id))
            except MessageError:
                logger.exception('board: an event did not pass the schema', extra={'task_id': task.task_id})
                return _answer(400, {'error': 'the board changed but its event could not be built: shorten the text'})
            except PublishError:   # (refused, or the bus's call failed: EventBridgePublisher.publish)
                logger.exception('board: the bus refused an event', extra={'task_id': task.task_id})
                return _answer(503, {'error': 'the board changed but its event was not published: retry'})
        return _answer(200, {'task': task.view(), 'agent': agent_id(caller), 'duplicate': outcome.duplicate})


@dataclass(frozen=True)
class PersonBoard:
    """A person's board actions (plan v3 4.3): post, re-prioritise, block or take a task, and move a task they took or
    give it back (release).

    The Agents API's routes (``/agents/engineering/<run_id>/board/tasks…``) call it for an administrator acting for
    themselves, never a delegated credential, like the run monitor's signals. Each change is the board store's own
    conditional write, with a history row naming ``human:<subject>`` (D1, D4), then the board's ``task.*`` event,
    published from the API's own source (``voc.engineering/api``) with ``from.kind`` human: the only way the bus
    takes a ``task.*`` from the API (bus/senders.py). A failed publish raises after the row is written; a retry is
    the same change, so the same event (a redelivery). Never the coordinate task (signal the run instead)."""

    store: BoardStore
    publisher: Publisher

    def post(self, run_id: str, body: Mapping[str, Any], subject: str) -> dict[str, Any]:
        """``{role, title, spec, priority?, parent_task?}``: any role that claims tasks, within the run's caps (the
        same dedupe as an agent's post: an equal task still under way is answered, ``duplicate``). Published to its
        role like any post: when it is new, or their own post retried while it is still its last change (the same event again);
        never someone else's equal task, whose event is theirs."""
        actor = PERSON_PREFIX + subject
        posted = _post(self.store, run_id, body, role=_post_role(body), actor=actor)
        task = posted.task
        if posted.created or (task.posted_by == actor and _post_is_last(task)):
            self.publisher.publish(replace(_event(task, run_id), sender=Party('human', subject)))
        return {'task': task.view(), 'duplicate': not posted.created}

    def act(self, run_id: str, task_id: str, action: str, body: Mapping[str, Any], subject: str) -> dict[str, Any]:
        """``priority {priority}``, ``block {reason, over?}``, ``take {over?}`` (``over``: end another person's hold) or
        ``move {to}`` (only a task they took, at its attempt) or ``release`` (a task they took, open again at its
        next attempt: published to its role, as a re-post) on a task that has not ended. Published to the run
        (``_person_event``) when the task's last change is theirs and this action (``updated_op``): this one, or
        their own earlier try of it (the same event again); a change already there by someone else, or a no-op
        after another change of theirs (a priority it already has after their take), is answered and publishes
        nothing."""
        actor = PERSON_PREFIX + subject
        if action == 'priority':
            if 'priority' not in body:
                raise BoardError('invalid', '"priority" is a whole number')
            task = self.store.reprioritise(WORKSPACE, run_id, task_id, priority=_int(body, 'priority', 0), actor=actor)
        elif action == 'block':
            task = self.store.block(WORKSPACE, run_id, task_id, reason=_text(body, 'reason'), actor=actor,
                                    over=_over(body))
        elif action == 'take':
            task = self.store.take(WORKSPACE, run_id, task_id, actor=actor, over=_over(body))
        elif action == 'move':
            to_state = _text(body, 'to')
            if to_state == NEEDS_HUMAN:   # (a person's "needs a person" always says why: D4)
                raise BoardError('invalid', 'a task needs a person by block, with a reason: not by a move')
            held = self.store.task(WORKSPACE, run_id, task_id)
            if held.lease_agent != actor:
                raise BoardError('forbidden', 'only a task you took is moved by you: take it first')
            task = self.store.move(WORKSPACE, run_id, task_id, agent=actor, epoch=held.attempt,
                                   to_state=to_state, result_keys=())
        elif action == 'release':
            task = self.store.release(WORKSPACE, run_id, task_id, actor=actor)
        else:
            raise BoardError('invalid', 'the action is one of block, move, priority, release, take')
        # Only a change of theirs is published: this one, or their earlier try of it (the same op and time, so the
        # same event id). A no-op answered as it is (a priority it already has, say) writes nothing and says nothing.
        if (task.updated_by, task.updated_op) == (actor, action):
            # A release is open for its role again, as a re-post: the role is told (task.posted), as the person.
            event = (replace(_event(task, run_id), sender=Party('human', subject)) if action == 'release'
                     else _person_event(task, run_id, subject, action))
            self.publisher.publish(event)
        return {'task': task.view()}


_api: BoardApi | None = None


def launch_client_config() -> Any:
    """The board's Lambda client for the runtime's launch: it waits up to ``LAUNCH_READ_TIMEOUT_SECONDS`` and never
    retries by itself (botocore retries a read timeout, which would start the launch a second time)."""
    from botocore.config import Config
    return Config(read_timeout=LAUNCH_READ_TIMEOUT_SECONDS, connect_timeout=5, retries={'total_max_attempts': 1})


def _from_environment() -> BoardApi:
    import boto3

    from engineering.knowledge.store import PackStore
    from engineering.workspace.store import WorkspaceStore
    from shared.aws import get_dynamodb_client, get_eventbridge_client, get_s3_client

    client, table = get_dynamodb_client(), os.environ['ENGINEERING_TABLE']
    runtime, bucket = os.environ.get('ENGINEERING_RUNTIME_FUNCTION', ''), os.environ.get('ENGINEERING_WORKSPACE_BUCKET', '')
    # No ListBucket on its role: a pack object never written reads as denied, so as missing.
    knowledge = PackStore(client, table, WorkspaceStore(get_s3_client(), bucket, denied_is_missing=True)) if bucket \
        else None
    return BoardApi(BoardStore(client, table, new_id=new_event_id),
                    EventBridgePublisher(get_eventbridge_client(), os.environ['ENGINEERING_BUS_NAME'], BOARD_SOURCE),
                    Inbox(client, table),
                    launcher=LambdaLauncher(boto3.client('lambda', config=launch_client_config()), runtime) if runtime
                    else None,
                    knowledge=knowledge,
                    images=frozenset(filter(None, os.environ.get('ENGINEERING_IMAGE_LANGUAGES', '').split(','))))


class _Kept:
    """A person's events, kept to hand back: the Agents API publishes them as the person, from its own source (the
    bus takes a person's ``task.*`` only from there)."""

    def __init__(self) -> None:
        self.messages: list[Message] = []

    def publish(self, message: Message) -> object:
        self.messages.append(message)
        return None


def person_request(store: BoardStore, request: Mapping[str, Any]) -> dict[str, Any]:
    """A person's board action, as the Agents API asks it (``{op: post|act, run_id, subject, body, task_id?, action?}``)
    through a direct invoke of this function, never its URL: the agent roles may invoke it only through the URL, so a
    direct invoke is the API's role, which has checked the person is an administrator acting for themselves and the
    run is open. The board's own role writes the change (the API's role writes no board row), and the events it
    makes are handed back for the API to publish: ``{status: ok, answer, events}``, or ``{status: refused, kind,
    message}``."""
    op, run_id, subject, body = (request.get(key) for key in ('op', 'run_id', 'subject', 'body'))
    # (the subject by the bus's own id rule: one its event could not carry is refused before anything is written)
    if not (isinstance(run_id, str) and ULID.fullmatch(run_id) and isinstance(subject, str) and ID.fullmatch(subject)
            and isinstance(body, Mapping)):
        return {'status': 'refused', 'kind': 'invalid', 'message': 'a person request names a run, a subject and a body'}
    kept = _Kept()
    people = PersonBoard(store, kept)
    try:
        if op == 'post':
            answer = people.post(run_id, body, subject)
        elif op == 'act' and isinstance(task_id := request.get('task_id'), str) \
                and isinstance(action := request.get('action'), str):
            answer = people.act(run_id, task_id, action, body, subject)
        else:
            return {'status': 'refused', 'kind': 'invalid', 'message': 'op is post, or act with a task_id and an action'}
    except Refused as refused:
        return {'status': 'refused', 'kind': refused.kind, 'message': str(refused)}
    except (ClientError, BotoCoreError):
        logger.exception('board: the table refused a person\'s action')
        return {'status': 'refused', 'kind': 'unavailable', 'message': 'the board could not be reached: retry'}
    return {'status': 'ok', 'answer': answer, 'events': [message.to_dict() for message in kept.messages]}


def _built() -> BoardApi:
    """The warm container's clients, built once."""
    global _api
    if _api is None:
        _api = _from_environment()
    return _api


@metrics.log_metrics   # (the workspace store's count of denied reads taken as missing, from `knowledge`)
def handler(event: Mapping[str, Any], context: Any) -> dict[str, Any]:
    if 'requestContext' not in event and isinstance(person := event.get('person'), Mapping):
        # A direct invoke (no function URL's request context): only the Agents API's role may make one.
        return person_request(_built().store, person)
    try:
        caller = caller_from_event(event, os.environ['AGENT_ROLE_NAME_PATTERN'],
                                   own_account(getattr(context, 'invoked_function_arn', '')))
    except UnknownCaller:
        return _answer(403, {'error': 'only an agent of a run may use the board'})
    api = _built()
    return api.handle_request(caller, _raw_body(event))


def _raw_body(event: Mapping[str, Any]) -> Any:
    """The request's body as text: a function URL base64-encodes a body it does not take for text."""
    body = event.get('body')
    if event.get('isBase64Encoded') and isinstance(body, str):
        try:
            return base64.b64decode(body, validate=True).decode()
        except (ValueError, UnicodeDecodeError):
            return None
    return body
