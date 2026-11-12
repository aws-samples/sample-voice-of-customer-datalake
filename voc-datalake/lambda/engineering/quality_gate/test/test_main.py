"""``python -m engineering.quality_gate``: plan, check and the review-only gate, in a real checkout."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from engineering.quality_gate.__main__ import main
from engineering.quality_gate.test.gate_fakes import FIXTURES, GO, RecordedModel, review

PACK = """\
schema = "voc-gate-pack/1"
id = "demo"
name = "Demo"
[languages.py]
markers = ["pyproject.toml"]
extensions = [".py"]
[[steps]]
id = "py.check"
language = "py"
name = "demo check"
kind = "test"
argv = ["{python}", "-c", "import pathlib, sys; sys.exit(0 if pathlib.Path('ok.py').exists() else 1)"]
"""
GIT = shutil.which('git')


def _packs(tmp_path: Path) -> Path:
    (tmp_path / 'packs' / 'demo').mkdir(parents=True)
    (tmp_path / 'packs' / 'demo' / 'manifest.toml').write_text(PACK)
    return tmp_path / 'packs'


def _repo(tmp_path: Path, *files: str) -> Path:
    repo = tmp_path / 'repo'
    repo.mkdir()
    (repo / 'pyproject.toml').write_text('')
    for name in files:
        (repo / name).write_text('x = 1\n')
    if GIT:
        # Fixed argvs, in a temporary directory: the change is committed before the gate, as the flows do.
        for args in (['init', '-q'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@example.com',
                                                    'commit', '-qm', 'change']):
            subprocess.run([GIT, *args], cwd=repo, check=True)  # noqa: S603 — fixed git argv
    return repo


def _out(capsys: pytest.CaptureFixture[str]) -> dict:
    return json.loads(capsys.readouterr().out)


def test_plan_prints_the_detected_checks_with_the_sandboxs_python(capsys):
    assert main(['plan', '--repo', str(FIXTURES / 'python-ts' / 'passing')]) == 0
    printed = _out(capsys)
    assert printed['packs'] == ['python-ts']
    assert [(c['key'], c['argv'][0], c['kind']) for c in printed['checks']] == [
        ('py.ruff@.', 'python3', 'lint'), ('py.test@.', 'python3', 'test')]
    assert main(['plan', '--repo', str(FIXTURES / 'python-ts' / 'passing'), '--python', '/sandbox/py']) == 0
    assert _out(capsys)['checks'][0]['argv'][0] == '/sandbox/py'
    assert printed['image'] == {'python': '3.12', 'node': '24'}
    assert 'pypi.org' in printed['network']


def test_plan_limits_the_checks_to_the_changed_roots(tmp_path, capsys):
    changed = tmp_path / 'changed.txt'
    changed.write_text('svc/a.py\n\n')
    repo = tmp_path / 'mono'
    for name in ('svc', 'web'):
        (repo / name).mkdir(parents=True)
        (repo / name / 'pyproject.toml').write_text('[tool.ruff]\n')
        (repo / name / 'a.py').write_text('')
    assert main(['plan', '--repo', str(repo), '--changed', str(changed)]) == 0
    assert [c['key'] for c in _out(capsys)['checks']] == ['py.ruff@svc']


@pytest.mark.parametrize(('files', 'code', 'passed'), [(('ok.py',), 0, True), ((), 1, False)])
def test_check_runs_the_deterministic_gate(tmp_path, capsys, files, code, passed):
    repo = _repo(tmp_path, *files) if files else _repo(tmp_path, 'other.py')
    assert main(['check', '--repo', str(repo), '--packs', str(_packs(tmp_path)), '--python', sys.executable]) == code
    printed = _out(capsys)
    assert printed['passed'] is passed
    assert [r['key'] for r in printed['results']] == ['py.check@.']


def test_check_with_no_check_to_run_does_not_pass(tmp_path, capsys):
    (tmp_path / 'notes.txt').write_text('no code here')
    assert main(['check', '--repo', str(tmp_path), '--packs', str(_packs(tmp_path))]) == 1
    assert _out(capsys) == {'passed': False, 'tool_versions': {}, 'results': []}


def test_check_with_only_a_dependency_install_does_not_pass(tmp_path, capsys):
    packs = _packs(tmp_path)
    manifest = packs / 'demo' / 'manifest.toml'
    manifest.write_text(manifest.read_text().replace('kind = "test"', 'kind = "setup"'))
    repo = _repo(tmp_path, 'ok.py')
    assert main(['check', '--repo', str(repo), '--packs', str(packs), '--python', sys.executable]) == 1
    printed = _out(capsys)
    assert (printed['passed'], [r['status'] for r in printed['results']]) == (False, ['pass'])


@pytest.mark.skipif(GIT is None, reason='git is not installed')
def test_gate_reviews_the_change_and_writes_the_pr_section(tmp_path, capsys):
    repo = _repo(tmp_path, 'ok.py')
    gate_input = tmp_path / 'input.json'
    gate_input.write_text(json.dumps({
        'task': 'add ok.py', 'diff': '+x = 1\n', 'authors': ['fixer'], 'changed_paths': ['ok.py'],
        'params': {'max_rounds': 1, 'reviewers': [{'name': 'quality'}]}}))
    markdown = tmp_path / 'gate.md'
    model = RecordedModel({'reviewer:quality': [review()], 'final-go': [GO]})
    code = main(['gate', '--repo', str(repo), '--packs', str(_packs(tmp_path)), '--input', str(gate_input),
                 '--markdown', str(markdown), '--python', sys.executable], model=model)
    printed = _out(capsys)
    assert code == 0
    assert printed['record']['verdict'] == 'GO'
    assert printed['needs_human'] is None
    assert markdown.read_text().startswith('## Quality gate\n\n**Verdict: GO**')


def test_gate_needs_an_input(tmp_path, capsys):
    with pytest.raises(SystemExit):
        main(['gate', '--repo', str(tmp_path)])
    assert 'gate needs --input' in capsys.readouterr().err
