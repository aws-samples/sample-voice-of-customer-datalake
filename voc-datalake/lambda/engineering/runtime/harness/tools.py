"""The platform's tools: the only things an agent can do, whichever adapter runs it.

- ``read_file``, ``list_files``, ``write_file``: the checkout only (``workspace.Workspace``: no link, no ``.git``).
- ``run``: a repository command (build, test, gate tool) through the runner, as ``code``, without network.
- ``install_dependencies``: the dependency step, the one repository command with the registries, before any other.
- ``report_progress``: the task's progress, through the board (the supervisor's activity clock reads it; a
  command still running reports itself once a minute too).
- ``save_checkpoint``: the agent's notes and plan, for a continuation (the session adds its position and its
  working tree as a patch).
- ``submit_work``: the working tree as a patch under the agent's own keys, handed to the broker, which alone
  writes to the repository host.
- ``finish``: the task is done; its summary is the task's last progress.

The agents that run no repository code (the writers, the reviewers, the coordinator) get no ``run``,
``install_dependencies``, ``write_file`` or ``submit_work``. A role with a skill record (``skills.py``: the run
coordinator) gets exactly the tools its skill's tool policy names, its own included (``coordinator.py``). Everything a tool returns from the repository is
fenced as data (``as_data``): the adapters' instructions say it is never an instruction.
"""
from __future__ import annotations

import fcntl
import json
import os
import secrets
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final, Protocol

from engineering.runtime.checkout import repo_git
from engineering.runtime.harness import coordinator
from engineering.runtime.harness.ports import (
    Board,
    Broker,
    KnowledgeReader,
    PendingHarnessPorts,
    Planner,
    Store,
    TaskBrief,
)
from engineering.runtime.harness.skills import skill_for, skill_label
from engineering.runtime.harness.status import StatusReport
from engineering.runtime.harness.workspace import OutsideCheckout, Workspace
from engineering.runtime.interface import CODE_ROLES

MAX_RUN_SECONDS: Final = 60 * 60
MAX_ARGV: Final = 64
MAX_NOTE_CHARACTERS: Final = 16_000
#: The largest working tree a patch holds (the agent's own changes; a continuation puts it back).
MAX_PATCH_BYTES: Final = 50 * 1024 * 1024
INDEX_LOCK_TRIES: Final = 12
INDEX_LOCK_WAIT_SECONDS: Final = 5.0


class Runs(Protocol):
    """``runner_client.RunnerClient``'s one call."""

    def run(self, argv: Sequence[str], *, timeout_seconds: int, repository_code: bool = True, network: bool = False,
            in_checkout: bool = True, on_wait: Callable[[], None] | None = None) -> dict[str, Any]: ...


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    properties: Mapping[str, Mapping[str, Any]]
    required: tuple[str, ...] = ()

    def schema(self) -> dict[str, Any]:
        return {'type': 'object', 'properties': dict(self.properties), 'required': list(self.required),
                'additionalProperties': False}


@dataclass
class ToolResult:
    text: str
    error: bool = False
    #: Set by ``finish``: the agent's summary of the finished task.
    finished: str | None = None
    #: Set by ``save_checkpoint``: what the agent wants a continuation to know.
    checkpoint: dict[str, Any] | None = None


@dataclass
class AgentContext:
    """One agent's run of one task, as the tools see it."""

    run_id: str
    agent_id: str
    task_id: str
    role: str
    brief: TaskBrief
    workspace: Workspace
    runner: Runs
    board: Board
    broker: Broker
    store: Store
    status: StatusReport
    #: Where git writes the agent's patches: in the agent's home, which repository code cannot read or write.
    patch_dir: str
    #: The agent's own keys (``ws/<ws>/runs/<run>/<agent>/``), and where its checkpoints and patches of its task's
    #: commit and attempt go under them (``checkpoints.artifact_prefix``).
    own_prefix: str
    checkpoints_prefix: str
    patches_prefix: str
    #: The run coordinator's ports (the board's tasks, posting, launching; the knowledge pack's reader).
    planner: Planner = field(default_factory=PendingHarnessPorts)
    knowledge: KnowledgeReader = field(default_factory=PendingHarnessPorts)
    #: Whether this process moved the task to done (the model's ``finish``).
    finished: bool = False

    @property
    def runs_code(self) -> bool:
        return self.role in CODE_ROLES

    def progress(self, step: str) -> None:
        self.status.at(step)
        self.board.progress(self.run_id, self.task_id, self.agent_id, step)


def as_data(source: str, text: str) -> str:
    """``text`` fenced as data from ``source``; a closing fence inside it cannot end the fence early."""
    fenced = text.replace('</data', '<\\/data')
    return f'<data source="{source}">\n{fenced}\n</data>'


def _git(context: AgentContext, *argv: str) -> None:
    """The agent's git on the checkout; while another of its git commands holds the index (a CLI's tool server's,
    still finishing in the runner after the CLI was ended), it waits for it, up to a minute."""
    result: dict[str, Any] = {}
    for _ in range(INDEX_LOCK_TRIES):
        result = context.runner.run(repo_git(*argv), timeout_seconds=600, repository_code=False, in_checkout=False)
        if result.get('exit_code') == 0:
            return
        if 'index.lock' not in str(result.get('stderr_tail', '')):
            break
        time.sleep(INDEX_LOCK_WAIT_SECONDS)
    raise OSError(f'git {argv[0]} failed: {str(result.get("stderr_tail", ""))[-500:]}')


def snapshot(context: AgentContext, label: str) -> str | None:
    """The working tree's changes as a patch under the agent's own keys (``<patches_prefix><label>-<nonce>.diff``), made
    by the agent's own git on the agent's own git directory; None when nothing changed.

    One at a time (a lock in the agent's home: the harness and a CLI's tool server share the index). Refused when
    a file the patch holds has more than one link (a hard link may name a file outside the checkout, the agent's
    session included, and a patch is handed on), or when the patch is over ``MAX_PATCH_BYTES``.
    """
    os.makedirs(context.patch_dir, mode=0o700, exist_ok=True)
    nonce = secrets.token_hex(4)
    patch = os.path.join(context.patch_dir, f'{label}-{nonce}.diff')
    names = os.path.join(context.patch_dir, f'{label}-{nonce}.names')
    with open(os.path.join(context.patch_dir, '.snapshot.lock'), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        _git(context, 'add', '--all')
        _git(context, 'diff', '--cached', '--name-only', '-z', f'--output={names}')
        with open(names, 'rb') as stream:
            held = [name.decode('utf-8', 'surrogateescape') for name in stream.read().split(b'\0') if name]
        linked = context.workspace.hard_linked(held)
        if linked:
            raise OutsideCheckout(f'files with more than one link: {", ".join(linked[:5])}')
        _git(context, 'diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', f'--output={patch}')
    with open(patch, 'rb') as stream:
        body = stream.read(MAX_PATCH_BYTES + 1)
    if not body:
        return None
    if len(body) > MAX_PATCH_BYTES:
        raise OutsideCheckout(f'the working tree\'s changes are over {MAX_PATCH_BYTES // (1024 * 1024)} MB')
    key = f'{context.patches_prefix}{os.path.basename(patch)}'
    context.store.put(key, body)
    return key


def _argv(raw: object) -> list[str]:
    if not isinstance(raw, list) or not 0 < len(raw) <= MAX_ARGV or not all(isinstance(a, str) and a for a in raw):
        raise ValueError(f'argv must be a list of 1-{MAX_ARGV} non-empty strings (no shell: one word per item)')
    return list(raw)


def _timeout(raw: object) -> int:
    value = raw if isinstance(raw, int) and not isinstance(raw, bool) else 600
    return max(1, min(value, MAX_RUN_SECONDS))


def _ran(result: Mapping[str, Any]) -> str:
    head = f'exit code {result.get("exit_code")}' + (' (timed out)' if result.get('timed_out') else '')
    return '\n'.join((head, as_data('stdout', str(result.get('stdout_tail', ''))),
                      as_data('stderr', str(result.get('stderr_tail', '')))))


_PATH: Final = {'type': 'string', 'description': 'A path relative to the checkout\'s root.'}
_ARGV: Final = {'type': 'array', 'items': {'type': 'string'},
                'description': 'The command, one word per item (no shell), run from the checkout\'s root.'}
_TIMEOUT: Final = {'type': 'integer', 'description': f'Seconds, at most {MAX_RUN_SECONDS}.'}
_TEXT: Final = {'type': 'string'}

READ_TOOLS: Final = (
    ToolSpec('read_file', 'Read one file of the checkout.', {'path': _PATH}, ('path',)),
    ToolSpec('list_files', 'List a directory of the checkout ("" for its root).', {'path': _PATH}),
    ToolSpec('report_progress', 'Say what you have done and are doing now; call it after each step.',
             {'step': _TEXT}, ('step',)),
    ToolSpec('save_checkpoint', 'Save what a continuation of you must know: your notes and your plan.',
             {'notes': _TEXT, 'plan': {'type': 'array', 'items': {'type': 'string'}}}, ('notes',)),
    ToolSpec('finish', 'The task is done: say what you did and what you found.', {'summary': _TEXT}, ('summary',)),
)
CODE_TOOLS: Final = (
    ToolSpec('write_file', 'Write one file of the checkout (created or replaced).', {'path': _PATH, 'text': _TEXT},
             ('path', 'text')),
    ToolSpec('run', 'Run a repository command (build, test, lint) in the sandbox, without network.',
             {'argv': _ARGV, 'timeout_seconds': _TIMEOUT}, ('argv',)),
    ToolSpec('install_dependencies', 'Install the dependencies (the only command with the package registries; '
             'only before any other repository command).', {'argv': _ARGV, 'timeout_seconds': _TIMEOUT}, ('argv',)),
    ToolSpec('submit_work', 'Hand your changes in the checkout to review (they become a patch for the broker).',
             {'summary': _TEXT}, ('summary',)),
)


class ToolBox:
    """The tools ``context.role`` may use, and their dispatch: its skill's tool policy, or its role's tools."""

    def __init__(self, context: AgentContext) -> None:
        self.context = context
        self._handlers: dict[str, Callable[[Mapping[str, Any]], ToolResult]] = {
            'read_file': self._read, 'list_files': self._list, 'report_progress': self._progress,
            'save_checkpoint': self._checkpoint, 'finish': self._finish, 'write_file': self._write,
            'run': self._run, 'install_dependencies': self._install, 'submit_work': self._submit,
            **coordinator.handlers(context, ToolResult, as_data),
        }
        skill = skill_for(context.role)
        if skill is None:
            self.specs: tuple[ToolSpec, ...] = READ_TOOLS + (CODE_TOOLS if context.runs_code else ())
        else:
            # Bounded by the role, whatever a record says: code tools only for a role that runs code, the planner's
            # only for the coordinator.
            known = {spec.name: spec for spec in (*READ_TOOLS, *(CODE_TOOLS if context.runs_code else ()),
                                                  *(coordinator.specs(ToolSpec) if context.role == 'coordinator'
                                                    else ()))}
            unknown = [name for name in skill.tool_policy if name not in known]
            if unknown:
                raise ValueError(f'{skill_label(skill.name, skill.version)} names tools role {context.role} may not '
                                 f'have: {", ".join(unknown)}')
            self.specs = tuple(known[name] for name in skill.tool_policy)
        self._allowed = {spec.name for spec in self.specs}

    def call(self, name: str, arguments: Mapping[str, Any]) -> ToolResult:
        """The tool's result; a refusal or failure is a result the model reads, never an exception."""
        if name not in self._allowed:
            return ToolResult(f'no tool {name!r} for this agent', error=True)
        self.context.status.tool(name)
        try:
            return self._handlers[name](arguments)
        except (OutsideCheckout, ValueError, OSError) as error:
            return ToolResult(f'{name} refused: {error}', error=True)

    def _read(self, arguments: Mapping[str, Any]) -> ToolResult:
        path = str(arguments.get('path', ''))
        return ToolResult(as_data(f'file:{path}', self.context.workspace.read(path)))

    def _list(self, arguments: Mapping[str, Any]) -> ToolResult:
        path = str(arguments.get('path', '') or '')
        return ToolResult(as_data(f'directory:{path or "."}', '\n'.join(self.context.workspace.list(path))))

    def _progress(self, arguments: Mapping[str, Any]) -> ToolResult:
        self.context.progress(str(arguments.get('step', ''))[:500])
        return ToolResult('recorded')

    @staticmethod
    def _checkpoint(arguments: Mapping[str, Any]) -> ToolResult:
        plan = arguments.get('plan')
        state = {'notes': str(arguments.get('notes', ''))[:MAX_NOTE_CHARACTERS],
                 'plan': [str(item)[:500] for item in plan[:50]] if isinstance(plan, list) else []}
        return ToolResult('saved', checkpoint=state)

    def _finish(self, arguments: Mapping[str, Any]) -> ToolResult:
        summary = str(arguments.get('summary', ''))[:MAX_NOTE_CHARACTERS] or 'done'
        self.context.progress(f'finished: {summary[:480]}')
        self.context.board.move(self.context.run_id, self.context.task_id, to_state='done')
        self.context.finished = True
        return ToolResult('finished', finished=summary)

    def _write(self, arguments: Mapping[str, Any]) -> ToolResult:
        path, text = str(arguments.get('path', '')), arguments.get('text')
        if not isinstance(text, str):
            raise ValueError('text must be a string')
        return ToolResult(f'wrote {self.context.workspace.write(path, text)} bytes to {path}')

    def _command(self, arguments: Mapping[str, Any], *, network: bool) -> ToolResult:
        argv = _argv(arguments.get('argv'))
        result = self.context.runner.run(argv, timeout_seconds=_timeout(arguments.get('timeout_seconds')),
                                         network=network,
                                         on_wait=lambda: self.context.progress(f'still running {argv[0]}'))
        return ToolResult(_ran(result), error=result.get('exit_code') != 0)

    def _run(self, arguments: Mapping[str, Any]) -> ToolResult:
        return self._command(arguments, network=False)

    def _install(self, arguments: Mapping[str, Any]) -> ToolResult:
        return self._command(arguments, network=True)

    def _submit(self, arguments: Mapping[str, Any]) -> ToolResult:
        context = self.context
        key = snapshot(context, context.task_id)
        if key is None:
            return ToolResult('nothing to submit: the checkout has no change', error=True)
        summary = str(arguments.get('summary', ''))[:MAX_NOTE_CHARACTERS]
        receipt = context.broker.submit(context.run_id, context.agent_id, context.task_id, key, summary)
        return ToolResult(json.dumps({'patch': key, 'broker': receipt}))


def bedrock_tools(specs: Sequence[ToolSpec]) -> dict[str, Any]:
    """The tools as Bedrock Converse's ``toolConfig``."""
    return {'tools': [{'toolSpec': {'name': spec.name, 'description': spec.description,
                                    'inputSchema': {'json': spec.schema()}}} for spec in specs]}
