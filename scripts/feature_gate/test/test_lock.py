"""scripts/suite-lock.sh's lock: a private folder, one holder per name, the holder named to a waiter, the exit code."""
from __future__ import annotations

import fcntl
import io
import os
import stat
import subprocess
import sys
import threading
from pathlib import Path

import pytest
from feature_gate import lock


def private(tmp_path: Path) -> Path:
    folder = tmp_path / 'locks'
    folder.mkdir(mode=0o700)
    return folder


def test_the_default_folder_is_per_user(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.delenv('VOC_SUITE_LOCK_DIR', raising=False)
    monkeypatch.setenv('XDG_RUNTIME_DIR', str(tmp_path))
    assert lock.lock_dir() == tmp_path / 'voc-suite-locks'
    monkeypatch.delenv('XDG_RUNTIME_DIR')
    assert lock.lock_dir() == Path('/tmp') / f'voc-suite-locks-{os.getuid()}'  # noqa: S108 — the default it pins, never written
    monkeypatch.setenv('VOC_SUITE_LOCK_DIR', str(tmp_path / 'mine'))
    assert lock.lock_dir() == tmp_path / 'mine'


def test_a_new_folder_is_made_private(tmp_path: Path):
    folder = tmp_path / 'new'
    lock.ensure_dir(folder)
    assert stat.S_IMODE(folder.stat().st_mode) == 0o700


@pytest.mark.parametrize('mode', [0o770, 0o707, 0o777])
def test_a_folder_others_may_write_is_refused(tmp_path: Path, mode: int):
    folder = private(tmp_path)
    folder.chmod(mode)
    with pytest.raises(lock.LockError, match='group or others may write'):
        lock.ensure_dir(folder)


def test_a_symlinked_folder_is_refused(tmp_path: Path):
    link = tmp_path / 'link'
    link.symlink_to(private(tmp_path))
    with pytest.raises(lock.LockError, match='not a directory'):
        lock.ensure_dir(link)


def test_a_symlinked_lock_file_is_refused(tmp_path: Path):
    folder = private(tmp_path)
    (folder / 'pytest.lock').symlink_to(tmp_path / 'elsewhere')
    with pytest.raises(lock.LockError, match='cannot open'):
        lock.open_lock(folder / 'pytest.lock')
    assert not (tmp_path / 'elsewhere').exists()


def test_the_lock_file_is_a_private_regular_file(tmp_path: Path):
    path = private(tmp_path) / 'pytest.lock'
    fd = lock.open_lock(path)
    os.close(fd)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_a_free_lock_is_taken_and_names_its_holder_without_the_arguments(tmp_path: Path):
    folder = private(tmp_path)
    with lock.held(folder, 'pytest', ['pytest', '-q', 'secret-token=abc'], out=io.StringIO()) as path:
        line = path.read_text()
    assert line.startswith(f'pid={os.getpid()} since=')
    assert line.endswith(' name=pytest cmd=pytest (2 args)\n')
    assert 'secret' not in line


def test_a_waiter_is_told_who_holds_the_lock_and_takes_it_once_freed(tmp_path: Path):
    folder = private(tmp_path)
    path = folder / 'pytest.lock'
    path.write_text('pid=1 since=2026-11-27T00:00:00Z name=pytest cmd=pytest (3 args)\n')
    path.chmod(0o600)
    told = threading.Event()

    class Out(io.StringIO):
        def write(self, s: str) -> int:
            told.set()
            return super().write(s)

    out = Out()
    taken = threading.Event()
    with path.open('a') as other:
        fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)

        def wait() -> None:
            with lock.held(folder, 'pytest', ['true'], out=out):
                taken.set()

        waiter = threading.Thread(target=wait)
        waiter.start()
        assert told.wait(10)
        assert not taken.is_set()
    waiter.join(10)
    assert taken.is_set()
    assert out.getvalue() == ('suite-lock: pytest is held by pid=1 since=2026-11-27T00:00:00Z name=pytest '
                              'cmd=pytest (3 args); waiting\n')


@pytest.mark.parametrize('bad', ['', '../x', 'a b', 'a/b', 'x\n'])
def test_a_name_is_one_plain_word(tmp_path: Path, bad: str):
    with pytest.raises(ValueError, match='a lock name is one word'):
        lock.lock_path(tmp_path, bad)


PROBE = '''
import fcntl, os, sys
path = sys.argv[1]
fd = os.open(path, os.O_RDWR)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print("free")
except BlockingIOError:
    print("held")
print(open(path).read().split()[0] == f"pid={os.getpid()}")
raise SystemExit(7)
'''


def test_the_command_is_execd_holding_the_lock_and_its_code_is_returned(tmp_path: Path):
    folder = tmp_path / 'locks'
    env = dict(os.environ, VOC_SUITE_LOCK_DIR=str(folder))
    argv = [sys.executable, '-I', lock.__file__, 'pytest', '--', sys.executable, '-c', PROBE, str(folder / 'pytest.lock')]
    done = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=30, check=False)  # noqa: S603 — fixed argv: this interpreter, lock.py and a constant probe
    # The command runs in the lock's own process (exec, as flock(1)): it holds the lock and is its named holder.
    assert (done.returncode, done.stdout.split()) == (7, ['held', 'True'])
    with (folder / 'pytest.lock').open('a') as after:   # freed with the command
        fcntl.flock(after, fcntl.LOCK_EX | fcntl.LOCK_NB)


NEWER_THAN_38 = {('datetime', 'UTC'): '3.11', ('dt', 'UTC'): '3.11'}


def test_lock_py_runs_on_the_floor_python():
    """suite-lock.sh runs the system python3 (-I): lock.py, standard library only, keeps to Python 3.8."""
    import ast

    source = Path(lock.__file__).read_text(encoding='utf-8')
    tree = ast.parse(source, feature_version=(3, 8))   # 3.8's grammar: no match, no parenthesised context managers
    newer = [f'{node.value.id}.{node.attr} ({NEWER_THAN_38[(node.value.id, node.attr)]})' for node in ast.walk(tree)
             if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name)
             and (node.value.id, node.attr) in NEWER_THAN_38]
    imports = sorted({a.name.split('.')[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
                     | {n.module.split('.')[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module})
    relative = [n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.level > 0]
    assert newer == []
    assert 'feature_gate' not in imports
    assert relative == []   # standard library only: nothing of the package's own


def test_suite_lock_refuses_a_python_below_its_floor(tmp_path: Path):
    old = tmp_path / 'bin'
    old.mkdir()
    (old / 'python3').write_text('#!/bin/sh\nexit 1\n')   # answers "no" to the floor check, as a 3.7 would
    (old / 'python3').chmod(0o755)
    script = Path(lock.__file__).parents[1] / 'suite-lock.sh'
    done = subprocess.run(['/bin/bash', str(script), 'pytest', '--', 'true'],  # noqa: S603 — fixed argv: bash, the script
                          env=dict(os.environ, PATH=f'{old}:{os.environ["PATH"]}'), capture_output=True, text=True,
                          timeout=30, check=False)
    assert done.returncode == 2
    assert 'suite-lock: needs Python 3.8 or newer as python3' in done.stderr


def test_a_command_that_does_not_exist_is_127(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv('VOC_SUITE_LOCK_DIR', str(tmp_path / 'locks'))
    out = io.StringIO()
    assert lock.main(['pytest', '--', str(tmp_path / 'no-such-command')], out=out) == 127
    assert 'no command' in out.getvalue()


def test_main_refuses_an_unsafe_folder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    folder = private(tmp_path)
    folder.chmod(0o777)
    monkeypatch.setenv('VOC_SUITE_LOCK_DIR', str(folder))
    out = io.StringIO()
    assert lock.main(['pytest', '--', 'true'], out=out) == 2
    assert 'group or others may write' in out.getvalue()


def test_the_holder_is_read_through_the_locked_descriptor(tmp_path: Path):
    """A file put at the lock's path meanwhile is not what the waiter reports: it reads the file it has open."""
    path = tmp_path / 'pytest.lock'
    fd = lock.open_lock(path)
    try:
        os.pwrite(fd, b'pid=7 name=pytest\n', 0)
        path.unlink()
        path.write_text('pid=666 planted\n')
        assert lock.holder(fd) == 'pid=7 name=pytest'
    finally:
        os.close(fd)


@pytest.mark.parametrize('argv', [[], ['pytest'], ['pytest', '--'], ['pytest', 'x', '--', 'true']])
def test_main_refuses_a_malformed_command_line(argv: list[str]):
    assert lock.main(argv, out=io.StringIO()) == 2
