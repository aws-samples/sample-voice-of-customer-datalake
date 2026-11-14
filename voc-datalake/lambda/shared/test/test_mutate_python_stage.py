"""scripts/mutate-python.sh's stage: mutants land in a copy outside the repository, never in the tree.

The script runs mutmut in a stage ($TMPDIR/mutate-python-<checksum>) whose `mutants` points at the copy of the
module's import root. A directory the stage only links (every one but lambda/, plugins/ and the module's own top
directory) would send mutmut's writes back into the real tree, so the script copies the module's top directory
and refuses (exit 3, before mutmut starts) when `mutants` or the module's mutant directory still resolves inside
the repository.

These run the real script in a throwaway repository with a stub in place of `python scripts/mutmut_run.py`: the
stub answers the baseline with the import name it is given and, for `run`, writes a mutant to
`mutants/<source path>` the way mutmut does. Each run must leave the repository byte for byte as it was.
"""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / 'scripts' / 'mutate-python.sh'
ORIGINAL = 'def f():\n    return 1\n'
MUTANT = 'MUTATED\n'

STUB = r"""#!/usr/bin/env bash
# A stand-in for `python scripts/mutmut_run.py <command> ...` (the first argument is the driver's path).
set -euo pipefail
shift
echo "$1" >> "$FAKE_LOG"
case "$1" in
  baseline) printf '%s\n' "$FAKE_NAME" > "$2" ;;
  run)
    src="$(sed -nE "s/^source_paths = \['(.*)'\]$/\1/p" pyproject.toml)"
    printf 'MUTATED\n' > "mutants/$src"
    printf '{}' > mutants/mutmut-stats.json ;;
  results) echo "    $FAKE_NAME.x_f__mutmut_1: killed" ;;
esac
"""

GIT = shutil.which('git') or 'git'
BASH = shutil.which('bash') or 'bash'
pytestmark = pytest.mark.skipif(
    shutil.which('git') is None or shutil.which('bash') is None or shutil.which('tar') is None,
    reason='the stage test needs git, bash and tar',
)


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(  # noqa: S603 (git, located, on a repository this test made)
        [GIT, '-c', 'core.hooksPath=/dev/null', *args], cwd=repo, check=True, capture_output=True, text=True,
    ).stdout


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A repository laid out like this one: voc-datalake/ with lambda/, scripts/, an ignored directory."""
    root = tmp_path / 'repo'
    datalake = root / 'voc-datalake'
    for module in ('lambda/shared/mod.py', 'scripts/pkg/mod.py', 'ignored/pkg/mod.py', 'plugins/p/mod.py'):
        (datalake / module).parent.mkdir(parents=True, exist_ok=True)
        (datalake / module).write_text(ORIGINAL, encoding='utf-8')
    (datalake / 'lambda/shared/test').mkdir()
    (datalake / 'lambda/shared/test/test_mod.py').write_text('def test_f():\n    pass\n', encoding='utf-8')
    (datalake / '.gitignore').write_text('ignored/\n', encoding='utf-8')
    (datalake / 'scripts/mutate-python.sh').write_bytes(SCRIPT.read_bytes())
    _git(root, 'init', '-q')
    return root


def _snapshot(root: Path) -> dict[str, bytes]:
    """Every file and link under the repository but .git, with its bytes (a link: its target)."""
    seen: dict[str, bytes] = {}
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root).as_posix()
        if relative == '.git' or relative.startswith('.git/'):
            continue
        if path.is_symlink():
            seen[relative] = b'link:' + os.readlink(path).encode()
        elif path.is_file():
            seen[relative] = path.read_bytes()
    return seen


def _run(repo: Path, tmp_path: Path, module: str, name: str) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    stub = tmp_path / 'fake-python'
    stub.write_text(STUB, encoding='utf-8')
    stub.chmod(stub.stat().st_mode | stat.S_IXUSR)
    log = tmp_path / 'calls.log'
    log.write_text('', encoding='utf-8')
    stage_base = tmp_path / 'stages'
    stage_base.mkdir(exist_ok=True)
    env = {
        **os.environ,
        'PYTHON_BIN': str(stub),
        'TMPDIR': str(stage_base),
        'FAKE_LOG': str(log),
        'FAKE_NAME': name,
    }
    result = subprocess.run(  # noqa: S603 (bash, located, running the repository's own script)
        [BASH, str(repo / 'voc-datalake/scripts/mutate-python.sh'), module, 'lambda/shared/test/test_mod.py'],
        cwd=repo, env=env, capture_output=True, text=True, timeout=60, check=False,
    )
    return result, log.read_text(encoding='utf-8').split()


def _stage(tmp_path: Path) -> Path:
    stages = list((tmp_path / 'stages').glob('mutate-python-*'))
    assert len(stages) == 1
    return stages[0]


@pytest.mark.parametrize(('module', 'name', 'copied'), [
    ('scripts/pkg/mod.py', 'pkg.mod', 'scripts/pkg/mod.py'),     # the project export's case: scripts/ on sys.path
    ('lambda/shared/mod.py', 'shared.mod', 'lambda/shared/mod.py'),
    ('plugins/p/mod.py', 'p.mod', 'plugins/p/mod.py'),
])
def test_the_mutants_land_in_the_stage_and_the_tree_is_unchanged(repo, tmp_path, module, name, copied):
    before = _snapshot(repo)
    git_before = _git(repo, 'status', '--porcelain', '--ignored')

    result, calls = _run(repo, tmp_path, module, name)

    assert result.returncode == 0, result.stderr
    assert calls == ['baseline', 'run', 'results']
    stage = _stage(tmp_path)
    assert (stage / 'repo/voc-datalake' / copied).read_text(encoding='utf-8') == MUTANT
    assert not (stage / 'repo/voc-datalake' / copied).is_symlink()
    assert _snapshot(repo) == before
    assert _git(repo, 'status', '--porcelain', '--ignored') == git_before


def test_a_module_the_stage_cannot_copy_is_refused_before_mutmut_runs(repo, tmp_path):
    """An ignored directory: git lists none of its files, so the stage only links it and `mutants` is the tree."""
    before = _snapshot(repo)

    result, calls = _run(repo, tmp_path, 'ignored/pkg/mod.py', 'pkg.mod')

    assert result.returncode == 3
    assert 'Refusing to mutate ignored/pkg/mod.py' in result.stderr
    assert 'inside the repository' in result.stderr
    assert str((repo / 'voc-datalake/ignored').resolve()) in result.stderr
    assert calls == ['baseline']                      # mutmut never started
    assert (repo / 'voc-datalake/ignored/pkg/mod.py').read_text(encoding='utf-8') == ORIGINAL
    assert _snapshot(repo) == before


def test_a_module_whose_mutant_directory_is_a_link_is_refused(repo, tmp_path):
    """The import root is copied but the module's own directory below it is a link into the tree."""
    real = repo / 'voc-datalake/ignored/pkg'
    link = repo / 'voc-datalake/scripts/linked'
    link.symlink_to(real, target_is_directory=True)
    before = _snapshot(repo)

    result, calls = _run(repo, tmp_path, 'scripts/linked/mod.py', 'linked.mod')

    assert result.returncode == 3
    assert 'Refusing to mutate scripts/linked/mod.py' in result.stderr
    assert calls == ['baseline']
    assert _snapshot(repo) == before
