"""One holder per suite on the machine: ``bash scripts/suite-lock.sh <name> -- <command…>``.

The lock is an ``fcntl.flock`` on ``<folder>/<name>.lock``. As flock(1) does, this process takes it, then execs the
command, which inherits the locked descriptor: the lock lives exactly as long as the command (and any child it leaves
holding the descriptor), and the kernel frees it when the last of them ends, however it ends. The folder is the user's own: ``$VOC_SUITE_LOCK_DIR``, else
``$XDG_RUNTIME_DIR/voc-suite-locks``, else ``/tmp/voc-suite-locks-<uid>``; made with mode 0700, and refused unless it
is a real directory (not a link) this user owns that neither group nor others may write. The lock file is opened
with ``O_NOFOLLOW`` (a planted link is refused, never followed), mode 0600, and must be a regular file this user owns.
The holder writes its pid, start time, the lock's name and the command's program (not its arguments, which may hold
a secret) into the file, so a waiter prints who it waits for (once) before it blocks. The command's exit code is this
one's (it is this process); 2 is a malformed command line or an unsafe folder, 127 a command that does not exist. Standard library only: scripts/suite-lock.sh runs it with
``python3 -I``.

    bash scripts/suite-lock.sh pytest -- bash scripts/pinned.sh python -m pytest -q <files>
"""
from __future__ import annotations

import contextlib
import datetime as dt
import fcntl
import os
import re
import stat
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import TextIO

NAME_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]*')
USAGE = 'usage: bash scripts/suite-lock.sh <name> -- <command…>'
OPEN_FLAGS = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC


class LockError(Exception):
    """An unsafe lock folder or file."""


def lock_dir() -> Path:
    if os.environ.get('VOC_SUITE_LOCK_DIR'):
        return Path(os.environ['VOC_SUITE_LOCK_DIR'])
    if os.environ.get('XDG_RUNTIME_DIR'):
        return Path(os.environ['XDG_RUNTIME_DIR']) / 'voc-suite-locks'
    return Path(f'/tmp/voc-suite-locks-{os.getuid()}')  # noqa: S108 — the user's own folder, made 0700 and checked by ensure_dir


def ensure_dir(folder: Path) -> Path:
    with contextlib.suppress(FileExistsError):
        folder.mkdir(mode=0o700, parents=True)
    st = folder.lstat()
    if not stat.S_ISDIR(st.st_mode):
        raise LockError(f'{folder} is not a directory (a link or a file): refusing it as the lock folder')
    if st.st_uid != os.getuid():
        raise LockError(f'{folder} is not owned by this user: refusing it as the lock folder')
    if st.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise LockError(f'{folder}: group or others may write it: refusing it as the lock folder (chmod 700)')
    return folder


def lock_path(folder: Path, name: str) -> Path:
    if not NAME_RE.fullmatch(name):
        raise ValueError(f'a lock name is one word of letters, digits, ".", "_" or "-" (got {name!r})')
    return folder / f'{name}.lock'


def open_lock(path: Path) -> int:
    """The lock file's descriptor: never through a link, a regular file this user owns."""
    try:
        fd = os.open(path, OPEN_FLAGS, 0o600)
    except OSError as err:
        raise LockError(f'cannot open {path} ({err.strerror}): is it a link?') from err
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
        os.close(fd)
        raise LockError(f'{path} is not a regular file this user owns')
    return fd


def holder(fd: int) -> str:
    """Who holds the lock, read through the descriptor this process opened (never the path again: a file put there
    meanwhile is not the lock)."""
    try:
        text = os.pread(fd, 4096, 0).decode('utf-8', errors='replace')
    except OSError:
        return 'an unnamed holder'
    return text.strip() or 'an unnamed holder'


def waiting_line(name: str, fd: int) -> str:
    return f'suite-lock: {name} is held by {holder(fd)}; waiting'


def holder_line(name: str, argv: list[str]) -> str:
    since = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')   # noqa: UP017 — dt.UTC is 3.11+: this file keeps to 3.8
    program = Path(argv[0]).name if argv else '?'
    return f'pid={os.getpid()} since={since} name={name} cmd={program} ({len(argv) - 1} args)\n'


def take(folder: Path, name: str, argv: list[str], out: TextIO) -> tuple[int, Path]:
    """Takes the lock (saying who holds it while it waits) and names this process as its holder: the descriptor."""
    path = lock_path(ensure_dir(folder), name)
    fd = open_lock(path)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            out.write(waiting_line(name, fd) + '\n')
            out.flush()
            fcntl.flock(fd, fcntl.LOCK_EX)
        os.ftruncate(fd, 0)
        os.pwrite(fd, holder_line(name, argv).encode('utf-8'), 0)
    except BaseException:
        os.close(fd)
        raise
    return fd, path


@contextlib.contextmanager
def held(folder: Path, name: str, argv: list[str], out: TextIO) -> Iterator[Path]:
    """The lock for the length of a block (the tests' way in); main execs the command instead."""
    fd, path = take(folder, name, argv, out)
    try:
        yield path
    finally:
        os.close(fd)


def main(argv: list[str], out: TextIO = sys.stderr) -> int:
    if len(argv) < 3 or argv[1] != '--':
        out.write(USAGE + '\n')
        return 2
    name, command = argv[0], argv[2:]
    try:
        fd, _ = take(lock_dir(), name, command, out)
    except (ValueError, LockError) as err:
        out.write(f'suite-lock: {err}\n')
        return 2
    # As flock(1): the command replaces this process and inherits the locked descriptor, so the lock lives exactly as
    # long as the command (and whatever it leaves running with the descriptor), however it ends; the holder's pid is
    # the command's own.
    os.set_inheritable(fd, True)
    try:
        os.execvp(command[0], command)  # noqa: S606 — the caller's own command line, as given (flock(1)'s contract)
    except FileNotFoundError:
        out.write(f'suite-lock: no command {command[0]!r}\n')
        return 127
    except PermissionError:
        out.write(f'suite-lock: {command[0]!r} cannot be run\n')
        return 126
    return 0   # not reached: execvp returns only by raising


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
