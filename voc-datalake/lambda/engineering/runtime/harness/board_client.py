"""The harness's board and inbox: its ``ports.Board`` and ``ports.Inbox`` on the board API's function URL.

Inside the session, as the agent's own session (the launcher's role session, ``credential_process``): every call is
an IAM-signed POST (SigV4, service ``lambda``) to the board's function URL, whose host the runtime adds to the
agent's egress by name (``VOC_BOARD_URL``). The board takes the caller's run, role and agent from that session, so
nothing the session sends can name another's. The brief is the task as the board answers its holder's claim (a
fresh start's; a continuation's is in its checkpoint); the lease's epoch, the task's attempt, goes with every
heartbeat, progress report and move. The inbox is read after a cursor (the run's
write-order numbers, ``board/inbox.py``) and each notice kept once by its event id: two deliveries may commit their
numbers out of order, so the board re-reads a window below the cursor on every page.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Final, Protocol
from urllib.parse import urlsplit

from engineering.runtime.harness.ports import PAUSE, SAVE, InboxMessage, TaskBrief, TaskSummary
from engineering.runtime.interface import FUNCTION_URL_RE

#: The board API's own limit on a page of the inbox.
PAGE: Final = 50
#: Pages read per ``take`` at most: the rest waits for the next one (a tool call, a turn).
MAX_PAGES: Final = 4
TIMEOUT_SECONDS: Final = 30
#: A launch's wait: above the board function's own limit (120 s, engineering-bus.ts; it waits up to 100 s for the
#: runtime), so the board's answer always arrives first. A retry after a lost answer is safe: the runtime answers the
#: session it has, or refuses (409) while the first launch still starts the session.
LAUNCH_TIMEOUT_SECONDS: Final = 125
MAX_ANSWER_BYTES: Final = 1024 * 1024
#: The inbox types the harness acts on itself; any other is shown to the model as data (its type is its kind).
ACTED_ON: Final = {'signal.save': SAVE, 'signal.pause': PAUSE}
#: The waits before each retry of a 503 or a lost connection (seconds).
RETRY_WAITS: Final = (1.0, 3.0)
#: The board's re-read window below the cursor, on every page (rows.TAIL_WINDOW): the done ids a checkpoint keeps
#: reach back that far.
TAIL_WINDOW: Final = 20
#: The done ids a checkpoint keeps at most (those its continuation can meet again): far more than a run's notices
#: between two saves of an agent's notes, within the checkpoint's size.
KEPT_SEEN: Final = 2000


class BoardRefused(RuntimeError):
    """The board answered with an error (its status and its message): a refusal, never retried here."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(f'the board answered {status}: {message}')
        self.status = status


class Transport(Protocol):
    def post(self, body: dict[str, Any]) -> dict[str, Any]:
        """One call of the board API: its answer, or ``BoardRefused``."""
        ...


@dataclass(frozen=True)
class SignedTransport:
    """POSTs to the board's function URL, signed with the agent's own credentials (botocore's chain)."""

    url: str
    region: str
    credentials: Any
    sleep: Callable[[float], None] = time.sleep

    def post(self, body: dict[str, Any]) -> dict[str, Any]:
        """One call, retried on the board's 503 ("retry") or a lost connection, twice, backing off: every op is
        idempotent (a renew, a progress report, a move or a claim done twice is done once)."""
        for wait in (*RETRY_WAITS, None):
            try:
                return self._post(body)
            except BoardRefused as refused:
                if refused.status != 503 or wait is None:
                    raise
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                if wait is None:
                    raise
            self.sleep(wait)
        raise AssertionError('unreachable')  # pragma: no cover

    def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest

        url = board_url(self.url)  # https and the function URL's host only: never file: or another scheme
        data = json.dumps(body, separators=(',', ':')).encode()
        request = AWSRequest(method='POST', url=url, data=data, headers={'Content-Type': 'application/json'})
        SigV4Auth(self.credentials.get_frozen_credentials(), 'lambda', self.region).add_auth(request)
        prepared = urllib.request.Request(url, data=data, method='POST',  # noqa: S310 - https, checked above
                                          headers=dict(request.headers.items()))
        timeout = LAUNCH_TIMEOUT_SECONDS if body.get('op') == 'launch' else TIMEOUT_SECONDS
        try:
            with _OPENER.open(prepared, timeout=timeout) as answer:
                return _json(answer.read(MAX_ANSWER_BYTES + 1))
        except urllib.error.HTTPError as error:
            answer = _json(error.read(MAX_ANSWER_BYTES + 1))
            raise BoardRefused(error.code, str(answer.get('error', 'refused'))[:300]) from error


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is an error: the signed request (its Authorization) never follows one to another host."""

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        del req, fp, msg, headers, newurl
        raise BoardRefused(code, 'the board answered with a redirect')


_OPENER: Final = urllib.request.build_opener(_NoRedirect)


def _json(raw: bytes) -> dict[str, Any]:
    if len(raw) > MAX_ANSWER_BYTES:
        raise BoardRefused(502, 'the answer is over its limit')
    try:
        answer = json.loads(raw or b'{}')
    except ValueError as error:
        raise BoardRefused(502, 'the answer is not JSON') from error
    if not isinstance(answer, dict):
        raise BoardRefused(502, 'the answer is not an object')
    return answer


def board_url(url: str) -> str:
    """The board's function URL, as the runtime hands it: https, a function URL's own host, nothing else."""
    parts = urlsplit(url)
    if (parts.scheme != 'https' or not FUNCTION_URL_RE.match(parts.hostname or '') or parts.port is not None
            or parts.username or parts.query or parts.fragment or parts.path not in ('', '/')):
        raise ValueError(f'{url!r} is not a function URL')
    return f'https://{parts.hostname}/'


@dataclass
class BoardHttp:
    """``ports.Board`` on the board API: the brief from the holder's claim, the epoch kept for the lease's calls."""

    transport: Transport
    run_id: str
    task_id: str
    #: The lease's epoch: the task's attempt (the board's claim sets it so).
    epoch: int

    def _own(self, run_id: str, task_id: str) -> None:
        if (run_id, task_id) != (self.run_id, self.task_id):
            raise ValueError('the harness reaches its own task only')

    def _claim(self) -> tuple[dict[str, Any], int]:
        """The holder's claim: the task, and the lease's epoch (kept for the lease's calls)."""
        task = self.transport.post({'op': 'claim', 'task_id': self.task_id}).get('task')
        lease = task.get('lease') if isinstance(task, dict) else None
        if not isinstance(task, dict) or not isinstance(lease, dict) or not isinstance(lease.get('epoch'), int):
            raise BoardRefused(502, 'the claim answered no lease')
        self.epoch = int(lease['epoch'])
        return task, self.epoch

    def brief(self, *, run_id: str, task_id: str) -> TaskBrief:
        self._own(run_id, task_id)
        task, _ = self._claim()
        if task.get('state') == 'claimed':
            # Briefed: the work starts (a continuation reads its brief in its checkpoint, and claims nothing).
            self.move(run_id, task_id, to_state='in_progress')
        spec = task.get('spec')
        instructions = spec.get('instructions') if isinstance(spec, dict) else None
        return TaskBrief(task_id=task_id, title=str(task.get('title', '')),
                         instructions=instructions if isinstance(instructions, str) else json.dumps(spec,
                                                                                                    sort_keys=True))

    def heartbeat(self, *, run_id: str, task_id: str, agent_id: str) -> None:
        del agent_id  # the board takes the agent from the caller's session
        self._own(run_id, task_id)
        self.transport.post({'op': 'renew', 'task_id': task_id, 'epoch': self.epoch})

    def progress(self, run_id: str, task_id: str, agent_id: str, step: str) -> None:
        """Report progress on the task; never a wait yet (no tool puts the agent on one: the supervisor's wait
        clocks come with it)."""
        del agent_id
        self._own(run_id, task_id)
        self.transport.post({'op': 'progress', 'task_id': task_id, 'epoch': self.epoch, 'step': step,
                             'waiting': False})

    def move(self, run_id: str, task_id: str, *, to_state: str) -> None:
        self._own(run_id, task_id)
        self.transport.post({'op': 'move', 'task_id': task_id, 'epoch': self.epoch, 'to': to_state,
                             'result_keys': []})


@dataclass
class InboxHttp:
    """``ports.Inbox`` on the board API's ``inbox`` op: read after a cursor, each notice taken once in a session;
    the cursor a checkpoint saves stops before the oldest notice taken and not yet done, so what never reached the
    model is read again from the board by a continuation (which skips the ids saved as done)."""

    transport: Transport
    run_id: str
    agent_id: str
    #: Where the next read starts.
    after: int = 0
    #: Every event id taken in this session (and those a checkpoint said were done).
    seen: dict[str, None] = field(default_factory=dict)
    #: Taken and not yet done: event id -> its number.
    open: dict[str, int] = field(default_factory=dict)
    #: Done: event id -> its number.
    finished: dict[str, int] = field(default_factory=dict)

    def done(self, event_ids: list[str]) -> None:
        for event_id in event_ids:
            seq = self.open.pop(event_id, None)
            if seq is not None:
                self.finished[event_id] = seq

    def cursor(self) -> dict[str, Any]:
        """Up to just before the oldest notice not yet done (or the read cursor), and every id done the
        continuation's read can meet again (those after it, and the board's window below the cursor): it reads from
        there and skips those, a pause or a save never acted on twice."""
        # Never past the read cursor: the board answers a window below it on every page, which a late delivery can
        # commit into.
        after = max(0, min(self.after, min(self.open.values()) - 1) if self.open else self.after)
        done = [event_id for event_id, seq in self.finished.items() if seq > after - TAIL_WINDOW]
        return {'after': after, 'done': [{'id': event_id, 'seq': self.finished[event_id]}
                                         for event_id in done[-KEPT_SEEN:]]}

    def resume(self, cursor: object) -> None:
        """Start from a checkpoint's cursor; one that is not a cursor is ignored (read from the start)."""
        if not isinstance(cursor, dict):
            return
        after, finished = cursor.get('after'), cursor.get('done')
        if (isinstance(after, int) and after >= 0 and isinstance(finished, list)
                and all(isinstance(item, dict) and isinstance(item.get('id'), str) and isinstance(item.get('seq'), int)
                        for item in finished)):
            self.after = after
            self.finished = {item['id']: item['seq'] for item in finished[-KEPT_SEEN:]}
            self.seen = dict.fromkeys(self.finished)

    def take(self, *, run_id: str, agent_id: str) -> list[InboxMessage]:
        if (run_id, agent_id) != (self.run_id, self.agent_id):
            raise ValueError('the harness reads its own inbox only')
        taken: list[InboxMessage] = []
        for _ in range(MAX_PAGES):
            page = self.transport.post({'op': 'inbox', 'after': self.after, 'limit': PAGE})
            messages, after = page.get('messages'), page.get('next')
            if not isinstance(messages, list) or not isinstance(after, int) or after < 0:
                raise BoardRefused(502, 'the inbox answered no page')
            for notice in messages:
                taken.extend(self._new(notice))
            moved, self.after = after != self.after, after
            if not moved or len(messages) < PAGE:
                break
        return taken

    def _new(self, notice: Any) -> list[InboxMessage]:
        if (not isinstance(notice, dict) or not isinstance(notice.get('event_id'), str)
                or not isinstance(notice.get('seq'), int) or notice['event_id'] in self.seen):
            return []
        event_id = notice['event_id']
        self.seen[event_id] = None
        self.open[event_id] = notice['seq']
        kind = str(notice.get('type', ''))
        return [InboxMessage(kind=ACTED_ON.get(kind, kind), summary=str(notice.get('summary', '')), event_id=event_id)]


@dataclass
class BoardPlanner:
    """``ports.Planner`` on the board API (the coordinator's ops: the board refuses anyone else): the run's tasks,
    posting one, launching its agent on the run's connection and commit (the board's, never the session's)."""

    transport: Transport
    run_id: str

    def _own(self, run_id: str) -> None:
        if run_id != self.run_id:
            raise ValueError('the harness plans its own run only')

    def tasks(self, *, run_id: str) -> list[TaskSummary]:
        self._own(run_id)
        listed = self.transport.post({'op': 'tasks'}).get('tasks')
        if not isinstance(listed, list):
            raise BoardRefused(502, 'the board answered no task list')
        return [TaskSummary(task_id=str(task.get('task_id', '')), role=str(task.get('role', '')),
                            title=str(task.get('title', '')), state=str(task.get('state', '')),
                            attempt=int(task.get('attempt', 1)), step=str(task.get('flow_step') or ''))
                for task in listed if isinstance(task, dict)]

    def post(self, *, run_id: str, role: str, title: str, instructions: str, paths: tuple[str, ...],
             step: str = '', shard: str = '') -> str:
        self._own(run_id)
        body: dict[str, Any] = {'op': 'post', 'role': role, 'title': title,
                                'spec': {'instructions': instructions, 'paths': list(paths)}}
        body.update({name: value for name, value in (('flow_step', step), ('shard', shard)) if value})
        task = self.transport.post(body).get('task')
        if not isinstance(task, dict) or not isinstance(task.get('task_id'), str):
            raise BoardRefused(502, 'the board answered no task')
        return task['task_id']

    def flow(self, *, run_id: str) -> dict[str, Any] | None:
        """The conductor's plan of the run's flow (the board's ``flow`` op), None for a run without a flow."""
        self._own(run_id)
        answer = self.transport.post({'op': 'flow'})
        if 'flow' not in answer or not (answer['flow'] is None or isinstance(answer['flow'], dict)):
            raise BoardRefused(502, 'the board answered no flow')
        return answer['flow']

    def record_step(self, *, run_id: str, step: str, action: str, shards: tuple[str, ...] = ()) -> dict[str, Any]:
        """A step the coordinator did itself (``complete``) or a map's shards (``fan_out``): the board's ``step`` op."""
        self._own(run_id)
        body: dict[str, Any] = {'op': 'step', 'step': step, 'action': action}
        if action == 'fan_out':
            body['shards'] = list(shards)
        answer = self.transport.post(body)
        if not isinstance(answer.get('step'), str):
            raise BoardRefused(502, 'the board answered no step')
        return answer

    def launch(self, *, run_id: str, task_id: str, role: str, language: str, paths: tuple[str, ...]) -> str:
        self._own(run_id)
        answer = self.transport.post({'op': 'launch', 'task_id': task_id, 'role': role, 'language': language,
                                      'paths': list(paths)})
        if not isinstance(answer.get('agent_id'), str):
            raise BoardRefused(502, 'the board answered no agent')
        return answer['agent_id']


@dataclass
class BoardKnowledge:
    """``ports.KnowledgeReader`` on the board API's ``knowledge`` op: a package's latest approved pack, fenced as data
    by the store (none when no version is approved). It names the agent's own task, whose lease the board checks it
    holds (one read of that task's row)."""

    transport: Transport
    run_id: str
    task_id: str

    def read(self, *, run_id: str, task_id: str, package: str) -> list[str]:
        if (run_id, task_id) != (self.run_id, self.task_id):
            raise ValueError('the harness reads the knowledge of its own task only')
        answer = self.transport.post({'op': 'knowledge', 'task_id': task_id, 'package': package})
        text = answer.get('text')
        return [text] if answer.get('version') is not None and isinstance(text, str) else []
