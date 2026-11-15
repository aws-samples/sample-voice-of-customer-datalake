"""The checkout cache's writer on real git: the entry it lays out is what an agent's sparse, blob-less clone reads."""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from engineering.connectors.cache import CacheFiller, SubprocessGit, remote_url
from engineering.connectors.cache_layout import BASE_REF, generation_at
from engineering.connectors.hosts import FetchAccess
from engineering.runtime.checkout import CHECKOUT_DIR, GIT_DIR, checkout_commands, repo_git

GIT = shutil.which('git') or '/usr/bin/git'
CONNECTION = 'conn-1'
REPOSITORY = 'example-org/example'
TOKEN = 'test-installation-token-of-the-real-git-fetch'
pytestmark = pytest.mark.skipif(not os.path.exists(GIT), reason='git is not installed')


def _git(*args: str, cwd: Path) -> str:
    argv = [GIT, '-c', 'user.name=Example', '-c', 'user.email=dev@example.org', '-c', 'init.defaultBranch=main', *args]
    # (fixed git argv on the test's own repositories)
    return subprocess.run(argv, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()  # noqa: S603


def _origin(root: Path) -> tuple[Path, str]:
    """A repository with two commits; the second one's id."""
    origin = root / 'origin'
    for path in ('src/app.py', 'docs/guide.md', 'README.md'):
        (origin / path).parent.mkdir(parents=True, exist_ok=True)
        (origin / path).write_text(f'{path} v1\n')
    _git('init', '--quiet', str(origin), cwd=root)
    _git('add', '.', cwd=origin)
    _git('commit', '--quiet', '-m', 'first', cwd=origin)
    (origin / 'src/app.py').write_text('src/app.py v2\n')
    _git('commit', '--quiet', '-am', 'second', cwd=origin)
    return origin, _git('rev-parse', 'HEAD', cwd=origin)


@dataclass(frozen=True)
class LocalOrigin:
    """Real git, the host's URL pointed at a local repository (the file protocol allowed for that fetch alone)."""

    origin: Path
    git: SubprocessGit = field(default_factory=lambda: SubprocessGit(GIT))

    def __call__(self, args: Sequence[str], *, env: Mapping[str, str], timeout: float) -> None:
        url = remote_url(REPOSITORY)
        if url in args:
            args = ['-c', 'protocol.file.allow=always', *[f'file://{self.origin}' if arg == url else arg for arg in args]]
        self.git(args, env={**env, 'PATH': os.path.dirname(GIT) + ':/usr/bin:/bin'}, timeout=timeout)


@dataclass
class DirectoryStore:
    """The bucket as a directory: a key is a path under it."""

    root: Path

    def exists(self, key: str) -> bool:
        return (self.root / key).exists()

    def upload(self, key: str, path: str, sha256: str) -> None:
        (self.root / key).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, self.root / key)
        assert hashlib.sha256((self.root / key).read_bytes()).hexdigest() == sha256   # (what S3 checks)

    def create(self, key: str, body: bytes) -> bool:
        if (self.root / key).exists():
            return False
        (self.root / key).parent.mkdir(parents=True, exist_ok=True)
        (self.root / key).write_bytes(body)
        return True


@dataclass
class NoClaims:
    """No other fill: every claim is taken; what was taken and released is recorded."""

    log: list[tuple[str, str, float]] = field(default_factory=list)

    def take(self, key: dict[str, dict[str, str]], holder: str, now: float) -> float | None:
        self.log.append(('take', key['sk']['S'] + holder, now))
        return None

    def release(self, key: dict[str, dict[str, str]], holder: str, until: float) -> None:
        self.log.append(('release', key['sk']['S'] + holder, until))


def _fill(tmp_path: Path) -> tuple[Path, str]:
    origin, commit = _origin(tmp_path)
    bucket = tmp_path / 'bucket'
    scratch = tmp_path / 'scratch'
    scratch.mkdir()
    generation = generation_at(time.time())
    filler = CacheFiller(git=LocalOrigin(origin), store=DirectoryStore(bucket), claims=NoClaims(),
                         tokens=lambda _connection: FetchAccess(REPOSITORY, TOKEN), scratch=str(scratch))
    assert filler.fill(CONNECTION, commit, generation) == 'filled'
    assert filler.fill(CONNECTION, commit, generation) == 'ready'
    return bucket / 'engineering/cache' / CONNECTION / commit / f'g{generation}', commit


def test_the_entry_is_a_bare_repository_of_the_one_commit_at_depth_one_under_one_ref(tmp_path: Path) -> None:
    entry, commit = _fill(tmp_path)
    repo = entry / 'repo.git'
    refs = _git(f'--git-dir={repo}', 'for-each-ref', '--format=%(refname) %(objectname)', cwd=tmp_path)
    assert refs == f'{BASE_REF} {commit}'
    assert _git(f'--git-dir={repo}', 'symbolic-ref', 'HEAD', cwd=tmp_path) == BASE_REF
    assert _git(f'--git-dir={repo}', 'config', 'uploadpack.allowFilter', cwd=tmp_path) == 'true'
    assert _git(f'--git-dir={repo}', 'rev-list', '--count', '--all', cwd=tmp_path) == '1'   # (depth 1)
    loose = [name for name in os.listdir(repo / 'objects') if name not in {'pack', 'info'}]
    assert (loose, (entry / 'READY').exists(), (repo / 'hooks').exists()) == ([], True, False)


def test_an_agents_sparse_blobless_clone_of_the_entry_checks_out_the_commit(tmp_path: Path) -> None:
    entry, commit = _fill(tmp_path)
    for path in [entry, *entry.rglob('*')]:   # (read-only, as the Mountpoint mount the clone reads in a session)
        path.chmod(0o555 if path.is_dir() else 0o444)
    work = tmp_path / 'work'
    work.mkdir()
    env = {'PATH': os.path.dirname(GIT) + ':/usr/bin:/bin', 'HOME': str(tmp_path)}
    for command in checkout_commands(commit, ['src'], 0, source=f'file://{entry}/repo.git'):
        # (the checkout's own argv, as an agent runs it)
        subprocess.run(command.argv, cwd=work, env=env, check=True, capture_output=True, timeout=60)  # noqa: S603
    assert (work / CHECKOUT_DIR / 'src/app.py').read_text() == 'src/app.py v2\n'
    assert not (work / CHECKOUT_DIR / 'docs').exists()
    head = subprocess.run(repo_git('rev-parse', 'HEAD'), cwd=work, env=env, check=True,  # noqa: S603 — the agent's argv
                          capture_output=True, text=True)
    assert (head.stdout.strip(), (work / GIT_DIR).is_dir()) == (commit, True)


def test_no_file_of_the_entry_holds_the_token(tmp_path: Path) -> None:
    entry, _commit = _fill(tmp_path)
    for path in entry.rglob('*'):
        if path.is_file():
            assert TOKEN.encode() not in path.read_bytes()
