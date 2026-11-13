"""How the gate runs a command: the ``CommandRunner`` interface and a local subprocess runner.

Repository code runs in the runtime's sandbox (a separate OS user with no credential and no network, in the gate
runner's session), which hands the gate a runner of its own. ``LocalRunner`` runs commands as local subprocesses:
the tests use it on temporary checkouts, and so does a local run on a trusted repository. The gate only sees this
interface.
"""
from __future__ import annotations

import contextlib
import io
import os
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import weakref
from collections import deque
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Protocol

#: Kept from a command's output: the end, where compilers and test runners print what failed.
OUTPUT_LIMIT = 20_000
#: After the command ends, how long its output is still read (a detached child may hold the pipe open).
READ_GRACE_S = 5.0
#: How much of the stream an ``expect`` match may span across two reads.
MATCH_WINDOW = 4096
#: The only variables a command inherits. Nothing else (no cloud credentials, no host tokens) reaches it.
INHERITED_ENV = ('PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'CARGO_HOME', 'RUSTUP_HOME', 'JAVA_HOME', 'GRADLE_USER_HOME',
                 'MAVEN_USER_HOME', 'npm_config_cache', 'PIP_CACHE_DIR', 'UV_CACHE_DIR')
FIXED_ENV = {'CI': 'true', 'NO_COLOR': '1', 'GIT_TERMINAL_PROMPT': '0', 'PYTHONDONTWRITEBYTECODE': '1'}
#: A command without network, asked of the package managers (a local run cannot cut the network itself).
OFFLINE_ENV = {'CARGO_NET_OFFLINE': 'true', 'npm_config_offline': 'true', 'PIP_NO_INDEX': '1', 'UV_OFFLINE': '1'}
#: Toolchains found through HOME: kept at their real place when HOME is replaced.
TOOLCHAIN_HOMES = {'CARGO_HOME': '.cargo', 'RUSTUP_HOME': '.rustup'}


@dataclass(frozen=True)
class CommandResult:
    exit_code: int | None
    output: str
    duration_s: float
    timed_out: bool = False
    missing: bool = False
    #: The ``expect`` pattern appeared somewhere in the whole output (not only in the kept tail).
    expect_seen: bool = False


class CommandRunner(Protocol):
    """Runs one command in a checkout. ``cwd`` is relative to the checkout's root.

    ``network`` is True for the dependency step alone: the runtime's sandbox gives that command the registries'
    egress and every other command none. ``expect`` is a pattern to watch the whole output for
    (``CommandResult.expect_seen``), since only the output's tail is kept.
    """

    def run(self, argv: Sequence[str], *, cwd: str = '', timeout_s: float, env: Mapping[str, str] | None = None,
            network: bool = False, expect: str = '') -> CommandResult: ...


class _Tail:
    """The last ``OUTPUT_LIMIT`` characters of a stream, read on a thread (memory stays bounded), watched for a
    pattern across the whole stream (a match may span two reads)."""

    def __init__(self, expect: str) -> None:
        self.chunks: deque[str] = deque()
        self.size = 0
        self.dropped = 0
        self.lock = threading.Lock()
        self.pattern = re.compile(expect) if expect else None
        self.seen = False
        self.carry = ''

    def _watch(self, chunk: str) -> None:
        if self.pattern is None or self.seen:
            return
        window = self.carry + chunk
        self.seen = self.pattern.search(window) is not None
        self.carry = window[-MATCH_WINDOW:]

    def drain(self, stream: io.BufferedReader) -> None:
        with contextlib.suppress(OSError, ValueError):
            for raw in iter(lambda: stream.read1(65536), b''):
                chunk = raw.decode('utf-8', 'replace')
                with self.lock:
                    self._watch(chunk)
                    self.chunks.append(chunk)
                    self.size += len(chunk)
                    while self.size - len(self.chunks[0]) >= OUTPUT_LIMIT:
                        self.size -= len(self.chunks[0])
                        self.dropped += len(self.chunks.popleft())

    def text(self) -> str:
        with self.lock:
            joined = ''.join(self.chunks)
        cut = self.dropped + max(len(joined) - OUTPUT_LIMIT, 0)
        return joined[-OUTPUT_LIMIT:] if not cut else f'[… {cut} characters cut]\n{joined[-OUTPUT_LIMIT:]}'


class LocalRunner:
    """Runs commands as local subprocesses under ``root``: a scrubbed environment, a throwaway HOME, a timeout.

    A timed-out command is killed with its whole process group, so a test runner's workers die with it.
    """

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.home = tempfile.mkdtemp(prefix='voc-gate-home-')
        weakref.finalize(self, shutil.rmtree, self.home, ignore_errors=True)
        real_home = Path(os.environ.get('HOME', '/nonexistent'))
        env = {key: os.environ[key] for key in INHERITED_ENV if key in os.environ}
        for key, name in TOOLCHAIN_HOMES.items():
            if key not in env and (real_home / name).is_dir():
                env[key] = str(real_home / name)
        self._env = env | FIXED_ENV | {'HOME': self.home}

    def _cwd(self, cwd: str) -> Path:
        pure = PurePosixPath(cwd)
        if pure.is_absolute() or '..' in pure.parts:
            raise ValueError(f'cwd must be inside the checkout: {cwd!r}')
        return self.root / cwd

    @staticmethod
    def _executable(program: str, cwd: Path, path: str) -> str | None:
        if '/' in program:
            # Not resolved: a virtualenv's python is a symlink, and only its own path finds the virtualenv.
            candidate = cwd / program
            return str(candidate) if candidate.is_file() and os.access(candidate, os.X_OK) else None
        return shutil.which(program, path=path)

    def run(self, argv: Sequence[str], *, cwd: str = '', timeout_s: float, env: Mapping[str, str] | None = None,
            network: bool = False, expect: str = '') -> CommandResult:
        if not argv:
            raise ValueError('argv must name a program')
        workdir = self._cwd(cwd)
        if not network:
            return self._run(argv, workdir, timeout_s, self._env | OFFLINE_ENV | dict(env or {}), expect)
        # The dependency step gets a HOME of its own: nothing an earlier command left there (an .npmrc, a cargo
        # config) is read by the one command that has network.
        home = tempfile.mkdtemp(prefix='voc-gate-setup-home-')
        try:
            return self._run(argv, workdir, timeout_s, self._env | {'HOME': home} | dict(env or {}), expect)
        finally:
            shutil.rmtree(home, ignore_errors=True)

    def _run(self, argv: Sequence[str], workdir: Path, timeout_s: float, full_env: dict[str, str],
             expect: str) -> CommandResult:
        executable = self._executable(argv[0], workdir, full_env.get('PATH', ''))
        if executable is None:
            return CommandResult(exit_code=None, output=f'{argv[0]}: not found', duration_s=0.0, missing=True)
        started = time.monotonic()
        # Fixed argv from a pack manifest (never a shell string), in the checkout, with the scrubbed environment.
        process = subprocess.Popen(  # noqa: S603 — a fixed argv from a pack manifest, never a shell string
            [executable, *argv[1:]], cwd=workdir, env=full_env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        output = _Tail(expect)
        stdout = process.stdout
        if not isinstance(stdout, io.BufferedReader):   # stdout=PIPE gives one; anything else is a broken Popen
            process.kill()
            raise TypeError(f'the command has no output pipe: {type(stdout).__name__}')
        reader = threading.Thread(target=output.drain, args=(stdout,), daemon=True)
        reader.start()
        timed_out = False
        try:
            process.wait(timeout=max(timeout_s, 0.001))
        except subprocess.TimeoutExpired:
            timed_out = True
        # The whole group goes, whether the command ended or not: no worker it left behind keeps running.
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        reader.join(timeout=READ_GRACE_S)
        if not reader.is_alive():   # else a detached child still holds the pipe: leave it to the daemon thread
            stdout.close()
        return CommandResult(exit_code=None if timed_out else process.returncode, output=output.text(),
                             duration_s=time.monotonic() - started, timed_out=timed_out, expect_seen=output.seen)
