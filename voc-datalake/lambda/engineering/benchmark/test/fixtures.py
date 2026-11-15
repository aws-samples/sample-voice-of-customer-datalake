"""Test support: the shipped suite, scripted candidates that replay its known fixes, and a case writer."""
from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from engineering.benchmark.cases import ReviewCheck, load_suite
from engineering.benchmark.runner import Attempt, CandidateError, CaseView, ReportedFinding

SUITE_DIR = Path(__file__).resolve().parents[4] / 'engineering-benchmark' / 'cases'
SUITE = load_suite(SUITE_DIR)
CASES = {case.id: case for case in SUITE}
SLUG, DURATION, REVIEW, MONOREPO = 'slug-cut-bug', 'duration-hours-feature', 'pagination-review', 'monorepo-units-bug'
needs_node = pytest.mark.skipif(shutil.which('node') is None, reason='node is not installed')


def attempt(diff: str = '', findings: tuple[ReportedFinding, ...] = ()) -> Attempt:
    """An attempt at what each scripted one costs: 1,200 tokens in, 300 out, a cent and two seconds."""
    return Attempt(diff=diff, findings=findings, input_tokens=1200, output_tokens=300, cost_usd=0.01, seconds=2.0)


def known_fix(case_id: str) -> Attempt:
    """The shipped case's known answer: its known-fix.diff, or every finding its review expects."""
    case = CASES[case_id]
    if isinstance(case.check, ReviewCheck):
        return attempt(findings=tuple(ReportedFinding(f.file, f.first_line, f.rule) for f in case.check.findings))
    return attempt(diff=(case.directory / 'known-fix.diff').read_text(encoding='utf-8'))


@dataclass(frozen=True)
class Scripted:
    """A candidate that answers each case it ``solves`` with the known fix and gives every other one up (an empty
    patch, no findings), at the same cost."""

    name: str
    solves: frozenset[str]

    def solve(self, case: CaseView) -> Attempt:
        return known_fix(case.id) if case.id in self.solves else attempt()


def replays_every_fix() -> Scripted:
    return Scripted('known-fixes', frozenset(CASES))


def regresses(case_id: str) -> Scripted:
    """Every known fix but ``case_id``'s."""
    return Scripted(f'regresses-{case_id}', frozenset(CASES) - {case_id})


def fixes(failure_case: str) -> tuple[Scripted, Scripted]:
    """A baseline that fails ``failure_case`` (and passes the rest), and a candidate that fixes it too."""
    return Scripted('before-the-fix', frozenset(CASES) - {failure_case}), Scripted(f'fixes-{failure_case}',
                                                                                   frozenset(CASES))


@dataclass(frozen=True)
class Answers:
    """A candidate that gives every case the same attempt, or raises ``CandidateError`` when it has none."""

    name: str
    given: Attempt | None

    def solve(self, case: CaseView) -> Attempt:
        if self.given is None:
            raise CandidateError(f'the model timed out on {case.id}')
        return self.given


def write_case(root: Path, case_id: str = 'probe', *, kind: str = 'bug', check: dict[str, Any] | None = None,
               files: dict[str, str] | None = None, **fields: Any) -> Path:
    """A case directory under ``root`` (its record, and its fixture's ``files``); ``fields`` override the record's."""
    directory = root / case_id
    for name, text in (files or {'main.py': 'print("hello")\n'}).items():
        (directory / 'repo' / name).parent.mkdir(parents=True, exist_ok=True)
        (directory / 'repo' / name).write_text(text, encoding='utf-8')
    command = {'argv': ['python3', 'main.py'], 'cwd': '', 'timeout_seconds': 30, 'protected': []}
    record = {'schema': 'voc-bench/1', 'id': case_id, 'kind': kind, 'title': 'A probe', 'task': 'Look at it.',
              'fixture': 'repo', 'check': command if check is None else check, **fields}
    (directory / 'case.json').write_text(json.dumps(record), encoding='utf-8')
    return directory
