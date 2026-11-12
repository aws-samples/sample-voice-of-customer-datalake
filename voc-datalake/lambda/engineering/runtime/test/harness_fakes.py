"""Fakes for the harness's tests: the runner, the board, the inbox, the broker, the store and Bedrock."""
from __future__ import annotations

import os
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from engineering.runtime.checkpoints import agent_prefix, artifact_prefix
from engineering.runtime.harness.interface import AgentSession
from engineering.runtime.harness.ports import InboxMessage, TaskBrief
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
    writes ``patch`` there; ``on_wait`` is called ``waits`` times."""

    patch: bytes = b'diff --git a/src/parse.py b/src/parse.py\n'
    #: What ``git diff --name-only -z`` says the patch holds.
    names: bytes = b'src/parse.py\x00'
    apply_exit: int = 0
    waits: int = 0
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
        code = self.apply_exit if 'apply' in argv else 0
        return {'exit_code': code, 'stdout_tail': '3 passed', 'stderr_tail': '', 'duration_seconds': 1,
                'timed_out': False}


@dataclass
class FakeBoard:
    progress_seen: list[tuple[str, str, str, str]] = field(default_factory=list)
    briefs_asked: list[tuple[str, str]] = field(default_factory=list)
    heartbeats: list[tuple[str, str, str]] = field(default_factory=list)

    def brief(self, *, run_id: str, task_id: str) -> TaskBrief:
        self.briefs_asked.append((run_id, task_id))
        return BRIEF

    def heartbeat(self, *, run_id: str, task_id: str, agent_id: str) -> None:
        self.heartbeats.append((run_id, task_id, agent_id))

    def progress(self, run_id: str, task_id: str, agent_id: str, step: str) -> None:
        self.progress_seen.append((run_id, task_id, agent_id, step))


@dataclass
class FakeInbox:
    #: One list of messages per call to ``take`` (then nothing).
    queued: list[list[InboxMessage]] = field(default_factory=list)
    takers: set[tuple[str, str]] = field(default_factory=set)

    def take(self, *, run_id: str, agent_id: str) -> list[InboxMessage]:
        self.takers.add((run_id, agent_id))
        return self.queued.pop(0) if self.queued else []


@dataclass
class FakeBroker:
    submitted: list[tuple[str, str, str, str, str]] = field(default_factory=list)

    def submit(self, run_id: str, agent_id: str, task_id: str, patch_key: str, summary: str) -> str:
        self.submitted.append((run_id, agent_id, task_id, patch_key, summary))
        return 'broker-receipt-1'


@dataclass
class FakeStore:
    objects: dict[str, bytes] = field(default_factory=dict)

    def put(self, key: str, body: bytes) -> None:
        self.objects[key] = body


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
                           patches_prefix=artifact_prefix(RUN_ID, 'fixer-1', HARNESS_COMMIT, 1, 'patches'))
    session = AgentSession(context=context, tools=ToolBox(context), inbox=inbox, store=store)
    return World(session, runner, board, inbox, broker, store, checkout, home)
