"""Fakes for the harness's tests: the runner, the board, the inbox, the broker, the store and Bedrock."""
from __future__ import annotations

import os
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from engineering.runtime.checkpoints import agent_prefix, artifact_prefix
from engineering.runtime.harness.interface import AgentSession
from engineering.runtime.harness.ports import Direction, InboxMessage, SkillAnswer, TaskBrief
from engineering.runtime.harness.status import StatusReport
from engineering.runtime.harness.tools import AgentContext, ToolBox
from engineering.runtime.harness.workspace import Workspace

RUN_ID = '01JD3R4NZXQ7Y2W8K4M6P9T0AB'
#: The task's commit: its checkpoints and patches go under it.
HARNESS_COMMIT = 'c' * 40
BRIEF = TaskBrief(task_id='task-1', title='Fix the failing parser test', instructions='Make tests/test_parse.py pass.',
                  knowledge=('Run the tests with: pytest -q',), memory=('The parser lives in src/parse.py.',))


@dataclass
class FakeRunner:
    """Answers each command with ``exit_code`` 0 (``apply_exit`` for ``git apply``); ``git diff --output=<file>``
    writes ``patch`` there; ``git write-tree`` prints ``tree``; ``on_wait`` is called ``waits`` times."""

    patch: bytes = b'diff --git a/src/parse.py b/src/parse.py\n'
    #: What ``git diff --name-only -z`` says the patch holds.
    names: bytes = b'src/parse.py\x00'
    apply_exit: int = 0
    #: What a repository command (``repository_code``) exits with.
    run_exit: int = 0
    waits: int = 0
    #: The tree id ``git write-tree`` prints.
    tree: str = 'e' * 40
    calls: list[dict[str, Any]] = field(default_factory=list)

    def run(self, argv: Sequence[str], *, timeout_seconds: int, repository_code: bool = True, network: bool = False,
            in_checkout: bool = True, on_wait: Callable[[], None] | None = None) -> dict[str, Any]:
        self.calls.append({'argv': list(argv), 'timeout_seconds': timeout_seconds, 'repository_code': repository_code,
                           'network': network, 'in_checkout': in_checkout})
        if on_wait is not None:
            for _ in range(self.waits):
                on_wait()
        for arg in argv:
            if arg.startswith('--output='):
                with open(arg.removeprefix('--output='), 'wb') as stream:
                    stream.write(self.names if '--name-only' in argv else self.patch)
        code = self.apply_exit if 'apply' in argv else (self.run_exit if repository_code else 0)
        return {'exit_code': code, 'stdout_tail': f'{self.tree}\n' if 'write-tree' in argv else '3 passed',
                'stderr_tail': '', 'duration_seconds': 1, 'timed_out': False}


@dataclass
class FakeBoard:
    progress_seen: list[tuple[str, str, str, str]] = field(default_factory=list)
    #: Each progress report's ``waiting`` (7.54.00: True opens a wait on the lease), beside ``progress_seen``.
    waiting_seen: list[bool] = field(default_factory=list)
    briefs_asked: list[tuple[str, str]] = field(default_factory=list)
    heartbeats: list[tuple[str, str, str]] = field(default_factory=list)
    moves: list[tuple[str, str, str]] = field(default_factory=list)
    #: The result keys each move recorded, in turn.
    results: list[tuple[str, ...]] = field(default_factory=list)

    def brief(self, *, run_id: str, task_id: str) -> TaskBrief:
        self.briefs_asked.append((run_id, task_id))
        return BRIEF

    def heartbeat(self, *, run_id: str, task_id: str, agent_id: str) -> None:
        self.heartbeats.append((run_id, task_id, agent_id))

    def progress(self, run_id: str, task_id: str, agent_id: str, step: str, *, waiting: bool = False) -> None:
        self.progress_seen.append((run_id, task_id, agent_id, step))
        self.waiting_seen.append(waiting)

    def move(self, run_id: str, task_id: str, *, to_state: str, result_keys: tuple[str, ...] = ()) -> None:
        self.moves.append((run_id, task_id, to_state))
        self.results.append(result_keys)

    #: What ``skill`` answers (None: the role's shipped skill as its template); ``refuse_skill``: the board refuses
    #: it (a crash); ``memories``: what ``memory`` answers.
    skill_answer: SkillAnswer | None = None
    refuse_skill: bool = False
    memories: tuple[str, ...] = ()
    skills_asked: list[tuple[str, str]] = field(default_factory=list)

    def skill(self, *, run_id: str, role: str) -> SkillAnswer:
        self.skills_asked.append((run_id, role))
        if self.refuse_skill:
            from engineering.runtime.harness.board_client import BoardRefused
            raise BoardRefused(409, 'no skill is recorded for this agent\'s session')
        if self.skill_answer is not None:
            return self.skill_answer
        from engineering.runtime.harness.skills import SKILLS
        shipped = SKILLS[role]
        return SkillAnswer(f'{role}@template-{shipped.version}', shipped.to_record())

    def memory(self, *, run_id: str, task_id: str) -> tuple[str, ...]:
        del run_id, task_id
        return self.memories

    #: The run's direction (7.51.00) ``direction`` answers, and how often it was read.
    run_direction: Direction = field(default_factory=Direction)
    directions_read: int = 0

    def direction(self, *, run_id: str) -> Direction:
        del run_id
        self.directions_read += 1
        return self.run_direction


@dataclass
class FakeInbox:
    #: One list of messages per call to ``take`` (then nothing).
    queued: list[list[InboxMessage]] = field(default_factory=list)
    takers: set[tuple[str, str]] = field(default_factory=set)

    #: The event ids it was told are done.
    finished: list[str] = field(default_factory=list)
    #: The cursor a restore handed it.
    resumed: object = None

    def take(self, *, run_id: str, agent_id: str) -> list[InboxMessage]:
        self.takers.add((run_id, agent_id))
        return self.queued.pop(0) if self.queued else []

    def done(self, event_ids: list[str]) -> None:
        self.finished.extend(event_ids)

    def cursor(self) -> dict[str, Any]:
        return {'after': 0, 'done': []}

    def resume(self, cursor: object) -> None:
        self.resumed = cursor

    #: The direction version each page names (7.51.00).
    version: int = 0

    def direction(self) -> int:
        return self.version


@dataclass
class FakeBroker:
    submitted: list[tuple[str, str, str, str, str]] = field(default_factory=list)
    #: Every write asked for: its operation, the caller (run, agent) and its arguments.
    writes: list[tuple[str, str, str, dict[str, Any]]] = field(default_factory=list)

    def submit(self, run_id: str, agent_id: str, task_id: str, patch_key: str, summary: str) -> str:
        self.submitted.append((run_id, agent_id, task_id, patch_key, summary))
        return 'broker-receipt-1'

    def push(self, run_id: str, agent_id: str, *, branch: str, patch_key: str, tree_hash: str,
             message: str) -> dict[str, Any]:
        self.writes.append(('push_bundle', run_id, agent_id, {'branch': branch, 'patch': patch_key,
                                                               'tree_hash': tree_hash, 'message': message}))
        return {'branch': branch, 'tree_hash': tree_hash}

    def open_draft_pr(self, run_id: str, agent_id: str, *, branch: str, title: str, body: str) -> dict[str, Any]:
        self.writes.append(('open_or_update_draft_pr', run_id, agent_id, {'branch': branch, 'title': title,
                                                                           'body': body}))
        return {'number': 7, 'url': 'https://git.example.org/example/app/pull/7'}

    def comment(self, run_id: str, agent_id: str, *, number: int, body: str,
                on: str = 'pull_request') -> dict[str, Any]:
        self.writes.append(('post_comment', run_id, agent_id, {'on': on, 'number': number, 'body': body}))
        return {'url': f'https://git.example.org/example/app/pull/{number}#issuecomment-1'}

    #: What ``read`` answers, by ``(kind, target)``; anything else is the broker's 404.
    pages: dict[tuple[str, str], str] = field(default_factory=dict)

    def read(self, *, kind: str, target: str, cursor: str | None = None) -> dict[str, Any]:
        from engineering.runtime.harness.ports import BrokerRefused
        del cursor   # (one page each)
        if (kind, target) not in self.pages:
            raise BrokerRefused(404, f'no {kind} {target}')
        return {'content': self.pages[(kind, target)], 'next_cursor': None}

    def label_issue(self, run_id: str, agent_id: str, *, number: int, labels: tuple[str, ...]) -> dict[str, Any]:
        self.writes.append(('label_issue', run_id, agent_id, {'number': number, 'labels': list(labels)}))
        return {'number': number, 'labels': list(labels)}


@dataclass
class FakeStore:
    objects: dict[str, bytes] = field(default_factory=dict)
    #: Each prefix listed (``list``), in turn.
    prefixes: list[str] = field(default_factory=list)

    def put(self, key: str, body: bytes) -> None:
        self.objects[key] = body

    def get(self, key: str, limit: int) -> bytes:
        return self.objects[key][:limit + 1]

    def list(self, prefix: str, token: str | None = None) -> dict[str, Any]:
        """The workspace bucket's run prefix as the agent's role lists it (one page, in key order)."""
        del token
        self.prefixes.append(prefix)
        return {'Contents': [{'Key': key, 'LastModified': f'2026-11-16T10:00:{n:02d}Z'}
                             for n, key in enumerate(sorted(self.objects)) if key.startswith(prefix)]}


class FakeBedrock:
    """Answers ``converse`` with the scripted messages in turn, and records every request."""

    def __init__(self, answers: list[list[dict[str, Any]]], tokens: tuple[int, int] = (100, 20)) -> None:
        self._answers = answers
        self._tokens = tokens
        self.requests: list[dict[str, Any]] = []

    def converse(self, **request: Any) -> dict[str, Any]:
        self.requests.append(request)
        content = self._answers.pop(0) if self._answers else [{'text': 'nothing more'}]
        return {'output': {'message': {'role': 'assistant', 'content': content}},
                'stopReason': 'tool_use' if any('toolUse' in block for block in content) else 'end_turn',
                'usage': {'inputTokens': self._tokens[0], 'outputTokens': self._tokens[1]}}


def opened(source: str, fence: str) -> str:
    """A DATA block's first line (``tools.as_data``), as a session with ``fence`` writes it."""
    return f'<<<DATA {source} {fence}>>>'


def use(name: str, ident: str = 't1', **arguments: Any) -> dict[str, Any]:
    return {'toolUse': {'toolUseId': ident, 'name': name, 'input': arguments}}


@dataclass
class World:
    session: AgentSession
    runner: FakeRunner
    board: FakeBoard
    inbox: FakeInbox
    broker: FakeBroker
    store: FakeStore
    checkout: str
    home: str


def world(tmp_path: Any, *, role: str = 'fixer') -> World:
    checkout, home = os.path.join(tmp_path, 'repo'), os.path.join(tmp_path, 'home')
    os.makedirs(os.path.join(checkout, 'src'))
    os.makedirs(home)
    with open(os.path.join(checkout, 'src', 'parse.py'), 'w') as stream:
        stream.write('def parse(text):\n    return text.split()\n')
    runner, board, inbox, broker, store = FakeRunner(), FakeBoard(), FakeInbox(), FakeBroker(), FakeStore()
    context = AgentContext(run_id='01JD3R4NZXQ7Y2W8K4M6P9T0AB', agent_id='fixer-1', task_id='task-1', role=role, brief=BRIEF,
                           workspace=Workspace(checkout), runner=runner, board=board, broker=broker,
                           store=store, status=StatusReport(home), patch_dir=os.path.join(home, '.voc', 'patches'),
                           own_prefix=agent_prefix(RUN_ID, 'fixer-1'),
                           checkpoints_prefix=artifact_prefix(RUN_ID, 'fixer-1', HARNESS_COMMIT, 1, 'checkpoints'),
                           patches_prefix=artifact_prefix(RUN_ID, 'fixer-1', HARNESS_COMMIT, 1, 'patches'),
                           commit=HARNESS_COMMIT)
    session = AgentSession(context=context, tools=ToolBox(context), inbox=inbox, store=store)
    return World(session, runner, board, inbox, broker, store, checkout, home)
