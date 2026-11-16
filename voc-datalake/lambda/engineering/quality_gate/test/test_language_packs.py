"""The per-language packs (7.50.00): a repository gets exactly the packs of its languages, the sandbox's layout is
Python, a root of test files alone is Python with pytest installed, and the two-language ids a stored flow names are
aliases of their two packs."""
from __future__ import annotations

import pytest

from engineering.quality_gate.packs import ALIASES, PackError, detect, expand, load_packs, parse_pack, plan
from engineering.quality_gate.test.gate_fakes import PACKS_DIR, repo_of
from shared.workflow_engineering import GATE_PACK_ALIASES

PACKS = load_packs(PACKS_DIR)

#: The owner's sandbox (voc-agents-sandbox) at its seeded bug: a calculator package, its tests, pytest's pythonpath in
#: pyproject.toml and the test dependency in requirements-dev.txt.
SANDBOX = {
    'pyproject.toml': '[tool.pytest.ini_options]\npythonpath = ["."]\ntestpaths = ["tests"]\n',
    'requirements-dev.txt': 'pytest==8.3.3\n', 'calculator/__init__.py': 'from .ops import divide\n',
    'calculator/ops.py': 'def divide(a, b):\n    return a // b\n', 'tests/test_ops.py': 'def test_add(): ...\n',
    'README.md': '# voc-agents-sandbox\n', '.github/workflows/test.yml': 'on: push\n',
}


def _packs(files: dict[str, str]) -> list[str]:
    return [detection.pack.id for detection in detect(PACKS, repo_of(files))]


def test_a_typescript_only_repository_gets_the_typescript_pack_alone() -> None:
    files = {'package.json': '{"scripts": {"test": "vitest run", "lint": "eslint ."}}', 'package-lock.json': '{}',
             'tsconfig.json': '{}', 'src/index.ts': 'export const a = 1\n', 'src/index.test.ts': ''}
    assert _packs(files) == ['typescript']
    repo = repo_of(files)
    gate = plan(detect(PACKS, repo), repo)
    assert [check.key for check in gate.checks] == ['ts.install@.', 'ts.lint@.', 'ts.typecheck@.', 'ts.test@.']
    assert (dict(gate.needs.image), gate.needs.network) == ({'node': '24'}, ('registry.npmjs.org',))


def test_a_rust_only_repository_gets_the_rust_pack_alone_and_no_node() -> None:
    files = {'Cargo.toml': '[package]\nname = "a"\n', 'Cargo.lock': '', 'src/lib.rs': 'pub fn a() {}\n'}
    assert _packs(files) == ['rust']
    repo = repo_of(files)
    gate = plan(detect(PACKS, repo), repo)
    assert dict(gate.needs.image) == {'rust': '1.99.1'}
    assert 'registry.npmjs.org' not in gate.needs.network
    assert 'static.rust-lang.org' in gate.needs.network


def test_the_sandbox_layout_is_python_installed_from_requirements_dev_and_tested_with_pytest() -> None:
    assert _packs(SANDBOX) == ['python']
    repo = repo_of(SANDBOX)
    gate = plan(detect(PACKS, repo), repo, python='/sandbox/python3')
    assert [(check.key, check.argv[-2:]) for check in gate.checks] == [
        ('py.install@.', ('-r', 'requirements-dev.txt')), ('py.test@.', ('-p', 'no:cacheprovider'))]
    assert gate.checks[1].argv[:3] == ('/sandbox/python3', '-m', 'pytest')


def test_requirements_dev_alone_marks_a_python_root() -> None:
    assert _packs({'requirements-dev.txt': 'pytest==8.3.3\n', 'calc.py': '', 'test_calc.py': ''}) == ['python']


def test_a_root_of_test_files_without_a_marker_is_python_and_installs_pytest_at_the_briefs_pin() -> None:
    files = {'calc.py': 'def add(a, b): return a + b\n', 'test_calc.py': 'def test_add(): ...\n'}
    assert _packs(files) == ['python']
    repo = repo_of(files)
    install = plan(detect(PACKS, repo), repo).checks[0]
    assert (install.key, install.argv[-1]) == ('py.install@.', 'pytest==8.4.2')
    # A pyproject.toml alone still installs nothing (installing the project would build it), and a Python file with
    # no test and no marker is no root at all.
    with_pyproject = repo_of({**files, 'pyproject.toml': '[project]\nname = "calc"\n'})
    assert [c.key for c in plan(detect(PACKS, with_pyproject), with_pyproject).checks] == ['py.test@.']
    assert _packs({'calc.py': ''}) == []


def test_a_mixed_repository_gets_each_of_its_languages_packs() -> None:
    files = {**SANDBOX, 'web/package.json': '{"scripts": {"test": "vitest run"}}', 'web/src/a.ts': ''}
    assert _packs(files) == ['python', 'typescript']


def test_the_two_language_ids_are_aliases_of_their_two_packs() -> None:
    assert dict(GATE_PACK_ALIASES) == ALIASES
    assert expand(['python-ts']) == ('python', 'typescript')
    assert expand(['rust-ts', 'python-ts', 'java']) == ('rust', 'typescript', 'python', 'java')
    assert expand(['rust']) == ('rust',)


@pytest.mark.parametrize(('condition', 'message'), [
    ({'absent': 'a', 'file': 'b'}, 'exactly one of "file", "glob" and "absent"'),
    ({'absent': 'a', 'contains': 'x'}, 'an "absent" condition takes no "contains"'),
    ({'absent': '../a'}, 'must be a path inside the repository'),
])
def test_an_absent_condition_names_one_file_and_nothing_else(condition: dict, message: str) -> None:
    manifest = {'schema': 'voc-gate-pack/1', 'id': 'x', 'name': 'X', 'languages': {'py': {
        'markers': ['setup.py'], 'extensions': ['.py']}}, 'steps': [{
            'id': 'py.test', 'language': 'py', 'name': 'pytest', 'kind': 'test', 'argv': ['pytest'],
            'when_any': [condition]}]}
    with pytest.raises(PackError, match=message):
        parse_pack(manifest, 'x')


def test_a_language_takes_only_its_known_keys() -> None:
    manifest = {'schema': 'voc-gate-pack/1', 'id': 'x', 'name': 'X', 'languages': {'py': {
        'markers': ['setup.py'], 'extensions': ['.py'], 'roots': ['x']}}, 'steps': [{
            'id': 'py.test', 'language': 'py', 'name': 'pytest', 'kind': 'test', 'argv': ['pytest']}]}
    with pytest.raises(PackError, match=r"languages.py: unknown keys \['roots'\]"):
        parse_pack(manifest, 'x')
