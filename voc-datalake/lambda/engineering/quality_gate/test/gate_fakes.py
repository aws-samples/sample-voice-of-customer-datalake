"""Test support for the quality gate: a scripted runner, a recorded model, a scripted reviser, small builders."""
from __future__ import annotations

import dataclasses
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from engineering.quality_gate.checks import GIT
from engineering.quality_gate.gate import Revision
from engineering.quality_gate.models import ModelRequest
from engineering.quality_gate.packs import GatePlan, PlannedCheck, RepoView
from engineering.quality_gate.review import Finding
from engineering.quality_gate.runner import CommandResult

PACKS_DIR = Path(__file__).resolve().parents[4] / 'engineering-gates'
FIXTURES = PACKS_DIR / 'test' / 'fixtures'
TREE = 'a' * 40
TREE_ARGV = (*GIT, 'rev-parse', '--verify', 'HEAD^{tree}')
STATUS_ARGV = (*GIT, 'status', '--porcelain', '--untracked-files=no', '--ignore-submodules')
OK = CommandResult(exit_code=0, output='ok', duration_s=0.1)


@dataclass
class Call:
    argv: tuple[str, ...]
    cwd: str
    timeout_s: float
    env: Mapping[str, str] | None
    network: bool
    expect: str


@dataclass
class ScriptedRunner:
    """Answers each argv from its script, in order (the last answer repeats); the checkout is clean at ``TREE``;
    every other command passes."""

    script: Mapping[tuple[str, ...], Sequence[CommandResult]] = field(default_factory=dict)
    calls: list[Call] = field(default_factory=list)

    def run(self, argv: Sequence[str], *, cwd: str = '', timeout_s: float, env: Mapping[str, str] | None = None,
            network: bool = False, expect: str = '') -> CommandResult:
        key = tuple(argv)
        self.calls.append(Call(key, cwd, timeout_s, env, network, expect))
        clean = {TREE_ARGV: [CommandResult(0, f'{TREE}\n', 0.0)], STATUS_ARGV: [CommandResult(0, '', 0.0)]}
        answers = {**clean, **self.script}.get(key)
        if not answers:
            return OK
        used = sum(1 for call in self.calls if call.argv == key) - 1
        return answers[min(used, len(answers) - 1)]

    def ran(self, argv: Sequence[str]) -> int:
        return sum(1 for call in self.calls if call.argv == tuple(argv))


@dataclass
class RecordedModel:
    """A fake model: answers each agent from its recorded replies, in order, and records every request.

    An agent with no reply left fails the test loudly instead of inventing an answer.
    """

    replies: Mapping[str, Sequence[str]]
    requests: list[ModelRequest] = field(default_factory=list)
    used: dict[str, int] = field(default_factory=dict)

    def complete(self, request: ModelRequest) -> str:
        self.requests.append(request)
        used = self.used.get(request.agent, 0)
        answers = self.replies.get(request.agent, ())
        if used >= len(answers):
            raise AssertionError(f'no recorded reply left for {request.agent!r} (call {used + 1})')
        self.used[request.agent] = used + 1
        return answers[used]


@dataclass
class ScriptedReviser:
    """Each revision in turn; every blocking finding it is given is marked with ``outcome``."""

    diffs: Sequence[str]
    outcome: str = 'fixed'
    given: list[list[Finding]] = field(default_factory=list)
    outputs: list[dict[str, str]] = field(default_factory=list)

    def revise(self, round_no: int, findings: Sequence[Finding], check_output: Mapping[str, str]) -> Revision:
        self.given.append(list(findings))
        self.outputs.append(dict(check_output))
        diff = self.diffs[min(round_no - 1, len(self.diffs) - 1)]
        return Revision(diff=diff, outcomes={f.id: (self.outcome, f'round {round_no}') for f in findings})


_CHECK = PlannedCheck(key='unit tests@.', pack_id='test', step_id='unit tests', name='unit tests', kind='test',
                      language='py', root='', argv=('make', 'test'), timeout_s=60)


def check(name: str = 'unit tests', argv: Sequence[str] = ('make', 'test'), **changes: Any) -> PlannedCheck:
    return dataclasses.replace(_CHECK, **{'key': f'{name}@.', 'step_id': name, 'name': name, 'argv': tuple(argv),
                                          **changes})


def repo_of(files: Mapping[str, str]) -> RepoView:
    """An in-memory repository: path -> text."""
    return RepoView(frozenset(files), files.get)


def one_check_plan(*checks: PlannedCheck) -> GatePlan:
    return GatePlan(checks=checks or (check(),), packs=('test',))


def review(*findings: object, score: int = 4) -> str:
    return json.dumps({'score': score, 'findings': list(findings)})


def blocking(quote: str, title: str = 'off-by-one in the page size', file: str = 'app/paging.py') -> dict[str, object]:
    return {'severity': 'blocking', 'file': file, 'line': 3, 'quote': quote, 'title': title,
            'trigger': 'a page of exactly 50 items -> the last item is dropped', 'fix': 'use <='}


GO = json.dumps({'verdict': 'GO', 'reasons': ['every blocking finding is fixed in the diff']})
NO_GO = json.dumps({'verdict': 'NO-GO', 'reasons': ['the fix drops the empty-page case']})
