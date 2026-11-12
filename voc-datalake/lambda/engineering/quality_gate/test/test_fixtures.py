"""Each pack's test step (after its setup steps), run for real on its passing and failing fixture.

Skipped where the toolchain is absent. The fixtures are copied to a temporary directory first: a build writes
target/ and caches.
"""
from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path

import pytest

from engineering.quality_gate.checks import run_plan
from engineering.quality_gate.packs import GatePlan, RepoView, detect, load_packs, plan
from engineering.quality_gate.runner import LocalRunner
from engineering.quality_gate.test.gate_fakes import FIXTURES, PACKS_DIR

PACKS = load_packs(PACKS_DIR)


def _run(tmp_path: Path, fixture: str, step_id: str) -> list[tuple[str, str]]:
    work = tmp_path / 'repo'
    shutil.copytree(FIXTURES / fixture, work)
    repo = RepoView.from_dir(work)
    # The test interpreter (with pytest) plays the sandbox's python3 here.
    full = plan(detect(PACKS, repo), repo, python=sys.executable)
    step = next(c for c in full.checks if c.step_id == step_id)
    setup = tuple(c for c in full.checks if c.kind == 'setup' and c.language == step.language)
    run = run_plan(GatePlan(checks=(*setup, step), packs=full.packs), LocalRunner(work))
    return [(r.status, r.reason) for r in run.results]


@pytest.mark.skipif(importlib.util.find_spec('_pytest') is None, reason='pytest is not installed')
@pytest.mark.parametrize(('variant', 'expected'), [('passing', 'pass'), ('failing', 'fail')])
def test_python_ts_pytest(tmp_path, variant, expected):
    assert _run(tmp_path, f'python-ts/{variant}', 'py.test')[-1][0] == expected


@pytest.mark.slow
@pytest.mark.skipif(shutil.which('cargo') is None, reason='cargo is not installed')
@pytest.mark.parametrize(('variant', 'expected'), [('passing', 'pass'), ('failing', 'fail')])
def test_rust_ts_cargo_test(tmp_path, variant, expected):
    fetch, test = _run(tmp_path, f'rust-ts/{variant}', 'rust.test')
    assert fetch == ('pass', 'ok')
    assert test[0] == expected


@pytest.mark.skipif(shutil.which('node') is None or shutil.which('npm') is None, reason='node is not installed')
def test_rust_ts_npm_test(tmp_path):
    assert _run(tmp_path, 'rust-ts/passing', 'ts.test') == [('pass', 'ok')]


@pytest.mark.slow
@pytest.mark.skipif(shutil.which('mvn') is None, reason='maven is not installed')
@pytest.mark.parametrize(('variant', 'expected'), [('passing', 'pass'), ('failing', 'fail')])
def test_java_mvn_verify(tmp_path, variant, expected):
    fetch, verify = _run(tmp_path, f'java/{variant}', 'java.maven')
    assert fetch == ('pass', 'ok')
    assert verify[0] == expected
    assert verify[1].startswith('exit ') or verify == ('pass', 'ok')
