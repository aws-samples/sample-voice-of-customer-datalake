"""A role's skill version as a benchmark candidate: the harness's own Converse loop, prompt and tools, on a case's copy.

``SkillCandidate(skill, model_for)`` runs ``skill`` (a shipped record, or a version the coach proposed) as the harness
runs it in a session (``converse_loop.ConverseAdapter``, ``tools.ToolBox`` with exactly the skill's tools), on the
copy of the case's fixture the runner hands it (``CaseView.repository``, the checkout), with the case's task as its
brief. ``model_for`` gives the Converse model for a case: Bedrock in a measured run, a scripted fake in the tests.

What it answers (``Attempt``): for a bug or a feature, the change its tools made to the copy, as a git patch read
from the two trees; for a review, the ``voc-finding/1`` findings it wrote (``write_findings``). The case's own check
then judges it, in a fresh repository (``runner.run_case``). Its tokens are the loop's own count.

What it is not: a session. Its ports are the benchmark's own: no board (progress is kept, the finish is noted), no
inbox, no host (the broker's writes answer that nothing is written), and **no repository command**: ``run`` and
``install_dependencies`` answer that the benchmark runs none (a model's command would run on this machine, which is
not a sandbox), so the case's check is the only thing that runs the code, as the runner already does it. The
harness's own git (the snapshot ``submit_work`` and a checkpoint make) is answered from the two trees, so a
``submit_work`` hands its patch in as in a session.
"""
from __future__ import annotations

import difflib
import json
import os
import tempfile
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final

from engineering.benchmark.runner import Attempt, CandidateError, CaseView, ReportedFinding, patch_paths
from engineering.runtime.checkpoints import agent_prefix, artifact_prefix
from engineering.runtime.harness.converse_loop import MAX_TURNS, ConverseAdapter
from engineering.runtime.harness.interface import AgentSession
from engineering.runtime.harness.ports import InboxMessage, TaskBrief
from engineering.runtime.harness.skills import Skill, skill_label
from engineering.runtime.harness.status import StatusReport
from engineering.runtime.harness.tools import AgentContext, ToolBox
from engineering.runtime.harness.workspace import Workspace
from engineering.runtime.outputs import FINDING_SCHEMA

#: The benchmark's own run, agent and commit ids (its keys never reach a workspace bucket).
BENCH_RUN: Final = '01JBENCH0000000000000000AA'
BENCH_COMMIT: Final = '0' * 40
NO_COMMAND: Final = ('the benchmark runs no repository command: the case\'s own check runs the code once you '
                     'finish')
NO_HOST: Final = 'the benchmark writes nothing to a repository host'


@dataclass
class _Ports:
    """The benchmark's board, inbox, broker, store and runner in one: they keep what the session says and refuse
    every repository command."""

    #: The copy as it was handed over and the checkout the session changes (None: no git is answered).
    trees: tuple[Path, Path] | None = None
    objects: dict[str, bytes] = field(default_factory=dict)
    finished: list[str] = field(default_factory=list)
    #: What the session reported (its progress, its lease's renewals, the inbox calls), in turn.
    said: list[str] = field(default_factory=list)

    def brief(self, *, run_id: str, task_id: str) -> TaskBrief:
        """Never asked: the candidate gives the session its brief, the case's task."""
        raise CandidateError(f'no brief for {run_id}/{task_id}: the candidate gives it')

    def heartbeat(self, *, run_id: str, task_id: str, agent_id: str) -> None:
        self.said.append(f'heartbeat {run_id}/{task_id} {agent_id}')

    def progress(self, run_id: str, task_id: str, agent_id: str, step: str) -> None:
        self.said.append(f'{run_id}/{task_id} {agent_id}: {step}')

    def move(self, run_id: str, task_id: str, *, to_state: str, result_keys: tuple[str, ...] = ()) -> None:
        del run_id, task_id, result_keys
        self.finished.append(to_state)

    def take(self, *, run_id: str, agent_id: str) -> list[InboxMessage]:
        del run_id, agent_id
        return []

    def done(self, event_ids: list[str]) -> None:
        self.said.extend(f'done {event_id}' for event_id in event_ids)

    def cursor(self) -> dict[str, Any]:
        return {}

    def resume(self, cursor: object) -> None:
        self.said.append(f'resumed at {cursor!r:.40}')

    def submit(self, run_id: str, agent_id: str, task_id: str, patch_key: str, summary: str) -> str:
        del run_id, agent_id, task_id, patch_key, summary
        return NO_HOST

    def push(self, run_id: str, agent_id: str, *, branch: str, patch_key: str, tree_hash: str,
             message: str) -> dict[str, Any]:
        del run_id, agent_id, branch, patch_key, tree_hash, message
        return {'benchmark': NO_HOST}

    def open_draft_pr(self, run_id: str, agent_id: str, *, branch: str, title: str, body: str) -> dict[str, Any]:
        del run_id, agent_id, branch, title, body
        return {'benchmark': NO_HOST}

    def comment(self, run_id: str, agent_id: str, *, number: int, body: str) -> dict[str, Any]:
        del run_id, agent_id, number, body
        return {'benchmark': NO_HOST}

    def put(self, key: str, body: bytes) -> None:
        self.objects[key] = body

    def run(self, argv: Sequence[str], *, timeout_seconds: int, repository_code: bool = True, network: bool = False,
            in_checkout: bool = True, on_wait: Callable[[], None] | None = None) -> dict[str, Any]:
        """A repository command is refused (``NO_COMMAND``). The harness's own git (its snapshot, which
        ``submit_work`` and a checkpoint make) is answered from the two trees: what ``git diff`` would write."""
        del timeout_seconds, network, in_checkout, on_wait
        if repository_code or self.trees is None:
            return {'exit_code': 126, 'stdout_tail': '', 'stderr_tail': NO_COMMAND, 'timed_out': False}
        for arg in argv:
            if arg.startswith('--output='):
                diff = tree_diff(*self.trees)
                body = ''.join(f'{name}\0' for name in patch_paths(diff)) if '--name-only' in argv else diff
                Path(arg.removeprefix('--output=')).write_bytes(body.encode('utf-8'))
        return {'exit_code': 0, 'stdout_tail': '', 'stderr_tail': '', 'timed_out': False}


def _files(root: Path) -> dict[str, bytes]:
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in sorted(root.rglob('*')) if path.is_file()}


def _text(name: str, body: bytes | None) -> list[str]:
    if body is None:
        return []
    try:
        return body.decode('utf-8').splitlines(keepends=True)
    except UnicodeDecodeError as error:
        raise CandidateError(f'the candidate made {name} binary: a patch here is text') from error


def _ended(line: str) -> str:
    """A diff line as git writes it: one without its newline is marked so (``\\ No newline at end of file``)."""
    return line if line.endswith('\n') else f'{line}\n\\ No newline at end of file\n'


def tree_diff(before: Path, after: Path) -> str:
    """The change from ``before`` to ``after`` as a git patch (text files only): what ``git diff`` would write."""
    old, new = _files(before), _files(after)
    parts: list[str] = []
    for name in sorted(old.keys() | new.keys()):
        a, b = old.get(name), new.get(name)
        if a == b:
            continue
        header = [f'diff --git a/{name} b/{name}\n']
        if a is None:
            header.append('new file mode 100644\n')
        elif b is None:
            header.append('deleted file mode 100644\n')
        hunks = list(difflib.unified_diff(_text(name, a), _text(name, b), 'a', 'b', n=3))[2:]
        if hunks:
            header += [f'--- {"/dev/null" if a is None else f"a/{name}"}\n',
                       f'+++ {"/dev/null" if b is None else f"b/{name}"}\n']
        parts += [*header, *(_ended(line) for line in hunks)]
    return ''.join(parts)


def findings_of(objects: Mapping[str, bytes]) -> tuple[ReportedFinding, ...]:
    """The findings the session wrote (every shard), as a review reports them (a line from 1)."""
    found: list[ReportedFinding] = []
    for key in sorted(objects):
        if key.endswith('.jsonl'):
            for raw in objects[key].decode('utf-8').splitlines():
                line = json.loads(raw)
                if line.get('schema') == FINDING_SCHEMA and line.get('line', 0) >= 1:
                    found.append(ReportedFinding(line['file'], line['line'], line.get('rule') or 'other'))
    return tuple(found)


@dataclass(frozen=True)
class SkillCandidate:
    """``skill`` on the harness's loop; ``model_for``: the Converse model (a ``bedrock-runtime``-shaped client) for a
    case."""

    skill: Skill
    model_for: Callable[[CaseView], Any]
    max_turns: int = MAX_TURNS

    @property
    def name(self) -> str:
        return skill_label(self.skill.name, self.skill.version)

    def solve(self, case: CaseView) -> Attempt:
        started = time.monotonic()
        with tempfile.TemporaryDirectory(prefix='voc-bench-skill-') as scratch:
            work = Path(scratch)
            before = work / 'before'
            # (the copy as it was handed over, beside it: the patch is the difference)
            _copy(case.repository, before)
            ports, agent = _Ports(trees=(before, case.repository)), f'{self.skill.name}-1'
            context = AgentContext(
                run_id=BENCH_RUN, agent_id=agent, task_id=f'bench-{case.id}', role=self.skill.name,
                brief=TaskBrief(f'bench-{case.id}', case.title, case.task), workspace=Workspace(str(case.repository)),
                runner=ports, board=ports, broker=ports, store=ports, status=StatusReport(str(work / 'home')),
                patch_dir=str(work / 'home' / 'patches'), own_prefix=agent_prefix(BENCH_RUN, agent),
                checkpoints_prefix=artifact_prefix(BENCH_RUN, agent, BENCH_COMMIT, 1, 'checkpoints'),
                patches_prefix=artifact_prefix(BENCH_RUN, agent, BENCH_COMMIT, 1, 'patches'), commit=BENCH_COMMIT,
                model=self.skill.model)
            session = AgentSession(context=context, tools=ToolBox(context, self.skill), inbox=ports, store=ports)
            ConverseAdapter(self.model_for(case), self.skill.model, max_turns=self.max_turns).run(session)
            review = case.kind == 'review'
            diff = '' if review else tree_diff(before, case.repository)
            tokens = context.status.tokens.get(self.skill.model, {'in': 0, 'out': 0})
            return Attempt(diff=diff, findings=findings_of(ports.objects) if review else (),
                           input_tokens=tokens['in'], output_tokens=tokens['out'],
                           seconds=time.monotonic() - started)


def _copy(source: Path, target: Path) -> None:
    """``source``'s files (a fixture: no links, ``walk_fixture``) under ``target``."""
    for name, body in _files(source).items():
        path = target / name
        os.makedirs(path.parent, exist_ok=True)
        path.write_bytes(body)
