"""The board API: the only way an agent changes the board (agents never write it themselves).

Reached through a Lambda function URL with IAM authentication: the caller's role, run and agent come from its
assumed-role identity (``engineering.connectors.identity``), never from the body. Operations
(a JSON body with ``op``): ``post`` (a task for a role the caller may post for, within the run's caps), ``claim``
(an open task of the caller's own role), ``renew`` (the heartbeat: the lease's expiry moves on), ``progress`` (the
holder's progress report: ``{task_id, epoch, step, waiting?}``, published as ``task.progress``), ``move`` (the
lease holder moves its task on) and ``inbox`` (the caller's notices after a seq, ``board/inbox.py``: its own, its
role's, and the conductor's for the coordinator; it reads, it changes nothing). Each change is published on the bus as the board (``task.*``), after the row is
written: the row is the record, the event a notification. A failed publish answers 503 and the agent retries; every
operation is idempotent, and the event's id comes from the change itself, so the retry publishes the same event again
(a redelivery its receivers dedupe), including a retried post the board answered from its ``spec_hash`` dedupe. A
retried progress report is a new report (its time is part of it).

The supervisor re-posts a task whose lease ran out with ``repost_task`` (its ``Board.repost`` port,
engineering/runtime/ports.py, is to call it): the store's ``repost``, then the task published again as
``task.posted`` to its role, so the delivery function records it for the role's agents to read (it wakes
nobody). Only at the attempt the supervisor judged, so it never takes a newer claim away.
"""
from __future__ import annotations

import base64
import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from engineering.board.inbox import MAX_LIMIT, Inbox
from engineering.board.model import EVENT_OF, OPEN, Task
from engineering.board.store import BoardError, BoardStore
from engineering.bus.publish import EventBridgePublisher, PublishError, change_event_id, new_event_id
from engineering.bus.schema import ROLES, Message, MessageError, Party, Refs, fit_summary
from engineering.connectors.identity import WORKSPACE, Caller, UnknownCaller, caller_from_event, own_account
from engineering.quality_gate.text import redact
from shared.logging import logger

BOARD_SOURCE = 'voc.engineering/board'
MAX_TITLE = 200
#: Priorities and epochs are small numbers (DynamoDB's own limit is 38 digits).
MAX_INT = 1_000_000
STATUS = {'invalid': 400, 'forbidden': 403, 'not_found': 404, 'conflict': 409, 'cap': 429}
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

    A retry after a lost event finds the task already open at the next attempt, and publishes it again (the same
    change, so the same event: a redelivery). A task that moved on (a newer claim) is refused: ``BoardError``."""
    task = store.repost(ws, run_id, task_id, reason=reason, attempt=attempt)
    publisher.publish(replace(_event(task, run_id), sender=Party('supervisor', 'supervisor')))
    return task


@dataclass(frozen=True)
class Outcome:
    """The task after an operation; whether its last change is published; whether a post found it already there."""

    task: Task
    publish: bool = True
    duplicate: bool = False
    #: The event that tells of it, when it is not the task's last change (a progress report).
    event: Message | None = None


class BoardApi:
    def __init__(self, store: BoardStore, publisher: EventBridgePublisher, inbox: Inbox) -> None:
        self.store = store
        self.publisher = publisher
        self.inbox = inbox

    def _inbox(self, caller: Caller, body: Mapping[str, Any]) -> dict[str, Any]:
        after, limit = _int(body, 'after', 0), _int(body, 'limit', MAX_LIMIT)
        if after < 0 or not 1 <= limit <= MAX_LIMIT:
            raise BoardError('invalid', f'"after" is a seq (0 or more) and "limit" 1 to {MAX_LIMIT}')
        return self.inbox.read(WORKSPACE, caller.run_id, role=caller.role, agent=agent_id(caller), after=after,
                               limit=limit)

    def _post(self, caller: Caller, body: Mapping[str, Any]) -> Outcome:
        role = _text(body, 'role')
        if role not in ROLES:
            raise BoardError('invalid', 'unknown role')
        if role not in POSTERS.get(caller.role, frozenset()):
            raise BoardError('forbidden', f'a {caller.role} does not post {role} tasks')
        title = _text(body, 'title')
        if len(title) > MAX_TITLE or redact(title) != title:
            raise BoardError('invalid', f'"title" is at most {MAX_TITLE} characters, with nothing secret in it')
        spec = body.get('spec', {})
        if not isinstance(spec, dict):
            raise BoardError('invalid', '"spec" is an object')
        posted = self.store.post(WORKSPACE, caller.run_id, role=role, title=title, spec=spec,
                                 parent_task=_text(body, 'parent_task', required=False),
                                 priority=_int(body, 'priority', 0), actor=agent_id(caller))
        # An equivalent task still open may be a retry whose first event was lost: publish it again (same id).
        return Outcome(posted.task, publish=posted.created or posted.task.state == OPEN, duplicate=not posted.created)

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
        raise BoardError('invalid', 'op is post, claim, renew, progress, move or inbox')

    def handle_request(self, caller: Caller, raw_body: Any) -> dict[str, Any]:
        try:
            body = _object(raw_body)
            if body.get('op') == 'inbox':
                return _answer(200, self._inbox(caller, body))
            outcome = self.operate(caller, body)
        except BoardError as exc:
            return _answer(STATUS[exc.kind], {'error': str(exc)})
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
            except (PublishError, ClientError, BotoCoreError):
                logger.exception('board: the bus refused an event', extra={'task_id': task.task_id})
                return _answer(503, {'error': 'the board changed but its event was not published: retry'})
        return _answer(200, {'task': task.view(), 'agent': agent_id(caller), 'duplicate': outcome.duplicate})


_api: BoardApi | None = None


def _from_environment() -> BoardApi:
    from shared.aws import get_dynamodb_client, get_eventbridge_client

    client, table = get_dynamodb_client(), os.environ['ENGINEERING_TABLE']
    return BoardApi(BoardStore(client, table, new_id=new_event_id),
                    EventBridgePublisher(get_eventbridge_client(), os.environ['ENGINEERING_BUS_NAME'], BOARD_SOURCE),
                    Inbox(client, table))


def handler(event: Mapping[str, Any], context: Any) -> dict[str, Any]:
    global _api   # the warm container's clients, built once
    try:
        caller = caller_from_event(event, os.environ['AGENT_ROLE_NAME_PATTERN'],
                                   own_account(getattr(context, 'invoked_function_arn', '')))
    except UnknownCaller:
        return _answer(403, {'error': 'only an agent of a run may use the board'})
    if _api is None:
        _api = _from_environment()
    return _api.handle_request(caller, _raw_body(event))


def _raw_body(event: Mapping[str, Any]) -> Any:
    """The request's body as text: a function URL base64-encodes a body it does not take for text."""
    body = event.get('body')
    if event.get('isBase64Encoded') and isinstance(body, str):
        try:
            return base64.b64decode(body, validate=True).decode()
        except (ValueError, UnicodeDecodeError):
            return None
    return body
