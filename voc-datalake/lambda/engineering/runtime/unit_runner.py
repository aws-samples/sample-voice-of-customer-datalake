"""Runs an agent's commands: in the local fake, and as the runner inside each toolchain image.

Standard library only, so the images copy this one file (engineering-images/*/Dockerfile) and run it as
their entry point. It serves, on the MicroVM's endpoint behind the service's auth token:

- ``POST /exec`` and ``GET /exec/<id>``: start a command, read its result. A command is an argv list, run
  without a shell, in ``/work``, with a timeout after which it is killed. In the image (``--sandbox``)
  every command is dropped to an unprivileged user (``sandboxed_argv``). The dependency step (repository
  code with network) runs only with the entry point's code firewall in place (``--code-firewall``) and
  before any other repository code: every repository-code process still running is ended before it
  starts, other repository code ends it, and after repository code has run it is refused.
- ``POST /session``: the launcher's role session for the agent user, kept as a ``credential_process``
  answer in the secrets directory (root-owned ``/run/voc``, readable by the agent user only), and, the
  first time, the connection's cache mounted read-only with it.
- ``GET /status``: the harness's own report (its step, recent tool calls, tokens per model), bounded and
  scrubbed.

Only the last 4,000 characters of each stream are kept, and anything shaped like a credential is masked
before anything leaves the runner. The tests' local fake (``test/local_runtime.py``) uses ``Runner`` directly, unsandboxed.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Final, TypeVar

# The images run this with their system python3, which is 3.11 on the Debian 12 based ones (node, rust):
# nothing newer than 3.11 is used here (test_engineering_images.py checks every module the images ship).
_Method = TypeVar('_Method')
if sys.version_info >= (3, 12):
    from typing import override
else:  # pragma: no cover - the images' Python 3.11
    def override(method: _Method) -> _Method:
        return method

TAIL_CHARACTERS: Final = 4000
MAX_BODY_BYTES: Final = 256 * 1024
MASK: Final = '[masked]'
MOUNT_POINT: Final = '/mnt/voc-cache'
#: The tools root runs, by absolute path (engineering-images/common/install-base.sh installs them): never looked up
#: on a PATH, which may hold a directory the `code` user can write (a toolchain's bin directory).
MOUNT_S3: Final = '/usr/bin/mount-s3'
SETPRIV: Final = '/usr/bin/setpriv'
UNSHARE: Final = '/usr/bin/unshare'
SH: Final = '/bin/sh'
IP: Final = '/usr/sbin/ip'
CAT: Final = '/usr/bin/cat'
#: The `code` user's home (engineering-images/common/install-base.sh).
CODE_HOME: Final = '/home/code'
#: Repository code shares the checkout's working tree with the group `work`; nothing the agent writes is ever
#: writable by `code` (the checkout opens only the working tree to the group, checkout.py).
CODE_UMASK: Final = 0o002
AGENT_UMASK: Final = 0o022
#: The environment a command gets: no credential of the runner's own (AWS_*, tokens) reaches a build.
PASSED_ENV: Final = ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'JAVA_HOME')
#: The toolchain homes, in the code-owned /opt/voc/cache: repository code's only. An agent's own command never
#: loads a toolchain, a plugin or a config from a place repository code can write.
#: With the toolchains' settings each image sets beside them (``ENV``): Cargo's no incremental build, Gradle's no
#: daemon (its client talks to it over loopback, which the code firewall rejects in the dependency step).
TOOLCHAIN_ENV: Final = ('CARGO_HOME', 'RUSTUP_HOME', 'CARGO_INCREMENTAL', 'GRADLE_USER_HOME', 'GRADLE_OPTS',
                        'MAVEN_OPTS', 'NPM_CONFIG_CACHE', 'PIP_CACHE_DIR')
#: The agent's ids (``interface.AgentSpec.environment``, set on the MicroVM) and its region: the agent's own
#: commands' only (the harness reads them); repository code never needs them.
AGENT_ENV: Final = ('VOC_RUN_ID', 'VOC_AGENT_ID', 'VOC_TASK_ID', 'VOC_ROLE', 'VOC_RESTORE_KEY', 'VOC_COMMIT',
                    'VOC_ATTEMPT', 'VOC_WORKSPACE_BUCKET', 'VOC_BOARD_URL', 'AWS_REGION')
#: Credential shapes masked in tool output: AWS access keys and secrets, host tokens (GitHub, GitLab),
#: bearer headers, private keys, and `name=value` pairs whose name says secret.
_CREDENTIAL_RES: Final = (
    re.compile(r'\b(?:AKIA|ASIA)[0-9A-Z]{16}\b'),
    re.compile(r'\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b'),
    re.compile(r'\bgithub_pat_[A-Za-z0-9_]{40,}\b'),
    re.compile(r'\bglpat-[A-Za-z0-9_-]{20,}\b'),
    re.compile(r'(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{16,}'),
    re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|\Z)'),
    # `name=value`, `name: value` and JSON's `"name": "value"` (the closing quote of the name may come first).
    re.compile(r'(?i)\b([A-Za-z0-9_]*(?:secret|password|token|api_key|apikey)[A-Za-z0-9_]*)["\']?\s*[=:]\s*["\']?'
               r'[^\s"\',}]+'),
)
_BUCKET_RE: Final = re.compile(r'^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\Z')
_PREFIX_RE: Final = re.compile(r'^engineering/cache/[A-Za-z0-9_-]{1,80}/\Z')
_SESSION_KEYS: Final = ('Version', 'AccessKeyId', 'SecretAccessKey', 'SessionToken', 'Expiration')
MAX_STATUS_BYTES: Final = 64 * 1024
MAX_STEP_CHARACTERS: Final = 200
MAX_RECENT_TOOLS: Final = 10
MAX_MODELS: Final = 20


def scrub_text(text: str) -> str:
    """``text`` with every credential-shaped string replaced by ``[masked]`` (a ``name=`` keeps its name)."""
    for pattern in _CREDENTIAL_RES:
        text = pattern.sub(lambda match: f'{match.group(1)}={MASK}' if match.groups() else MASK, text)
    return text


def _tail(path: str) -> str:
    with open(path, 'rb') as stream:
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        stream.seek(max(size - TAIL_CHARACTERS * 4, 0))
        text = stream.read().decode('utf-8', errors='replace')
    return scrub_text(text)[-TAIL_CHARACTERS:]


def command_env(source: dict[str, str], *, repository_code: bool) -> dict[str, str]:
    """The variables of ``source`` a command may see (``PASSED_ENV``, and ``TOOLCHAIN_ENV`` for repository code)."""
    names = (*PASSED_ENV, *TOOLCHAIN_ENV) if repository_code else PASSED_ENV
    return {name: source[name] for name in names if name in source}


def sandboxed_argv(argv: list[str], *, repository_code: bool, network: bool) -> list[str]:
    """``argv`` dropped to its user (``code`` or ``unit``); repository code also boxed in namespaces of its own.

    The runner runs as root inside the MicroVM so that it can do this; no command ever runs as root, and root runs
    its own tools by absolute path only (a directory ``code`` can write may be on a command's ``PATH``). Repository
    code gets its own PID namespace and ``/proc`` (no view of the agent's processes or their environment) and,
    unless it is the dependency step, its own network namespace, with only its own loopback (builds and tests that
    bind 127.0.0.1 work): neither the runner nor a link-local credential endpoint is in it. Both users share the
    group ``work``, which owns only ``/work`` (the checkout); ``unit``'s own files (notes, anything derived from
    customer feedback) stay in its home, which ``code`` cannot read.
    """
    user = 'code' if repository_code else 'unit'
    drop = [SETPRIV, f'--reuid={user}', '--regid=work', '--clear-groups', '--inh-caps=-all']
    if not repository_code:
        return [*drop, '--', *argv]
    # --kill-child: the boxed command dies with the job (a killed or timed-out job leaves nothing running). The change
    # of user clears that parent-death signal, so setpriv sets it again (--pdeathsig) after it: the namespace's PID 1
    # dies with unshare even when it left unshare's process group, and every process of the namespace with it.
    boxed = [*drop, '--pdeathsig=KILL', '--', *argv]
    if network:
        return [UNSHARE, '--pid', '--fork', '--kill-child', '--mount-proc', '--', *boxed]
    # A new network namespace starts with its loopback down: root brings it up inside, then drops to `code`. The
    # script is a constant; the command reaches it only as positional arguments, never as text to parse.
    return [UNSHARE, '--pid', '--fork', '--kill-child', '--mount-proc', '--net', '--',
            SH, '-c', f'{IP} link set lo up && exec "$@"', 'sh', *boxed]


def bounded_status(raw: object) -> dict[str, Any]:
    """The harness's report, cut to what the run monitor shows: a step, ten tool names, token counts."""
    report: dict[str, Any] = raw if isinstance(raw, dict) else {}
    listed, counted = report.get('recent_tools'), report.get('tokens')
    tools: list[Any] = listed if isinstance(listed, list) else []
    raw_tokens: dict[Any, Any] = counted if isinstance(counted, dict) else {}
    tokens: dict[str, dict[str, int]] = {}
    for model, counts in list(raw_tokens.items())[:MAX_MODELS]:
        if isinstance(counts, dict):
            tokens[str(model)[:100]] = {kind: int(counts.get(kind, 0) or 0) for kind in ('in', 'out')}
    return {'step': scrub_text(str(report.get('step', '')))[:MAX_STEP_CHARACTERS],
            'recent_tools': [str(tool)[:64] for tool in tools[-MAX_RECENT_TOOLS:]],
            'tokens': tokens}


class CommandJob:
    """One command running in ``cwd``; ``result()`` is None until it ends (or is killed at its timeout)."""

    def __init__(self, argv: list[str], cwd: str, timeout_seconds: int, logs_root: str | None = None,
                 extra_env: dict[str, str] | None = None, *, repository_code: bool = True) -> None:
        if not argv or not all(argv):
            raise ValueError('argv must be a non-empty list of non-empty strings')
        if timeout_seconds < 1:
            raise ValueError('timeout_seconds must be at least 1')
        self._logs = tempfile.mkdtemp(prefix='voc-agent-logs-', dir=logs_root)
        self._out_path = os.path.join(self._logs, 'stdout')
        self._err_path = os.path.join(self._logs, 'stderr')
        self._started = time.monotonic()
        self._deadline = self._started + timeout_seconds
        self._timed_out = False
        with open(self._out_path, 'wb') as out, open(self._err_path, 'wb') as err:
            # The argv is the agent's own command, run without a shell (never a string to parse);
            # S603 is allowed for this file only (ruff.toml). Its own session: a kill reaches its whole group.
            self._process = subprocess.Popen(
                argv, cwd=cwd, stdout=out, stderr=err, stdin=subprocess.DEVNULL,
                env={**command_env(dict(os.environ), repository_code=repository_code), **(extra_env or {})},
                start_new_session=True, umask=CODE_UMASK if repository_code else AGENT_UMASK)

    def result(self) -> dict[str, Any] | None:
        """``{exit_code, stdout_tail, stderr_tail, duration_seconds, timed_out}``, or None while it runs."""
        code = self._process.poll()
        if code is None and time.monotonic() >= self._deadline:
            self.kill()
            code = self._process.wait()
            self._timed_out = True
        if code is None:
            return None
        return {
            'exit_code': code,
            'stdout_tail': _tail(self._out_path),
            'stderr_tail': _tail(self._err_path),
            'duration_seconds': round(time.monotonic() - self._started, 3),
            'timed_out': self._timed_out,
        }

    def kill(self) -> None:
        """End the command and every process of its group (a boxed command's children included)."""
        if self._process.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(self._process.pid, signal.SIGKILL)
            self._process.wait()


class Runner:
    """The commands, the session and the status of one MicroVM.

    ``secrets_dir`` holds the agent's role session: a directory only root can write (``/run/voc`` in the
    image), so nothing the agent or repository code planted there can redirect root's writes, and the
    session file inside it is readable by ``unit`` only. ``code_firewall`` says the image's entry point
    has stopped ``code`` from reaching the runner's port and link-local addresses: without it, the
    dependency step (repository code with network) is refused. ``hardlink_guard`` says the session cannot be
    hard-linked into the checkout (the secrets directory on a file system of its own, or the kernel's protected
    hard links on): without it, no repository code runs at all.
    """

    def __init__(self, workdir: str, *, sandbox: bool, secrets_dir: str, agent_home: str,
                 code_firewall: bool = False, hardlink_guard: bool = False, logs_root: str | None = None) -> None:
        self.workdir = workdir
        self.sandbox = sandbox
        self.secrets_dir = secrets_dir
        self.agent_home = agent_home
        self.code_firewall = code_firewall
        self.hardlink_guard = hardlink_guard
        self._logs_root = logs_root
        #: exec id -> (job, kind): ``agent`` (the agent's own), ``dependency`` (repository code with network), ``code``.
        self._jobs: dict[str, tuple[CommandJob, str]] = {}
        self._code_ran = False
        self._mounted = False
        self._has_session = False
        self._bucket = ''
        self._lock = threading.Lock()

    def _agent_env(self) -> dict[str, str]:
        """What the agent's own commands (never repository code) get: its home, where its session is, its ids,
        and the bucket its session was handed with."""
        ids = {name: os.environ[name] for name in AGENT_ENV if name in os.environ}
        bucket = {'VOC_BUCKET': self._bucket} if self._bucket else {}
        return {**ids, **bucket, 'HOME': self.agent_home,
                'AWS_CONFIG_FILE': os.path.join(self.secrets_dir, 'aws-config'), 'AWS_SDK_LOAD_CONFIG': '1'}

    def _code_env(self) -> dict[str, str]:
        """What repository code gets beyond PASSED_ENV: its own home in the image (never root's or the agent's)."""
        return {'HOME': CODE_HOME} if self.sandbox else {}

    def start(self, body: dict[str, Any]) -> str:
        argv, timeout = body.get('argv'), body.get('timeout_seconds')
        if not isinstance(argv, list) or not isinstance(timeout, int) or isinstance(timeout, bool):
            raise ValueError('the body needs argv (a list of strings) and timeout_seconds (a whole number)')
        repository_code, network = body.get('repository_code') is not False, body.get('network') is True
        if repository_code and self.sandbox and not self.hardlink_guard:
            raise ValueError('repository code needs the hard-link guard, which this MicroVM could not set up')
        if repository_code and network and self.sandbox and not self.code_firewall:
            raise ValueError('the dependency step needs the code firewall, which this MicroVM could not set up')
        command = [str(arg) for arg in argv]
        if self.sandbox:
            command = sandboxed_argv(command, repository_code=repository_code, network=network)
        with self._lock:
            if repository_code and network:
                if self._code_ran:
                    raise ValueError('the dependency step runs before any repository code, not after it')
                self._kill(lambda kind: kind != 'agent')
            elif repository_code:
                # The dependency step is over the moment other repository code starts: none keeps its network.
                self._kill(lambda kind: kind == 'dependency')
                self._code_ran = True
            job = CommandJob(command, self.workdir, timeout, logs_root=self._logs_root,
                             extra_env=self._code_env() if repository_code else self._agent_env(),
                             repository_code=repository_code)
            exec_id = uuid.uuid4().hex
            kind = 'agent' if not repository_code else 'dependency' if network else 'code'
            self._jobs[exec_id] = (job, kind)
        return exec_id

    def _kill(self, which: Callable[[str], bool]) -> None:
        for job, kind in self._jobs.values():
            if which(kind):
                job.kill()

    def poll(self, exec_id: str) -> dict[str, Any] | None:
        """The job's result, None while it runs; ``KeyError`` for an unknown id."""
        with self._lock:
            job, _ = self._jobs[exec_id]
        return job.result()

    def kill_all(self) -> None:
        """End every command this runner started (and each one's process group)."""
        with self._lock:
            for job, _ in self._jobs.values():
                job.kill()

    def _write_secret(self, name: str, text: str, mode: int) -> str:
        """Write ``name`` in the secrets directory: a fresh file (never through a link), moved into place."""
        path = os.path.join(self.secrets_dir, name)
        staged = f'{path}.{uuid.uuid4().hex}'
        fd = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(text)
            if self.sandbox:
                os.fchown(stream.fileno(), *_unit_ids())
            os.fchmod(stream.fileno(), mode)
        os.replace(staged, path)
        return path

    def keep_session(self, body: dict[str, Any]) -> None:
        """Keep the role session as the agent user's ``credential_process`` answer; mount the cache the first time."""
        credentials = {key: body.get(key) for key in _SESSION_KEYS}
        if not all(isinstance(value, str | int) and value for value in credentials.values()):
            raise ValueError('a session needs Version, AccessKeyId, SecretAccessKey, SessionToken and Expiration')
        if not self._has_session:
            # The agent starts with its first session: whatever ran before it (the image's validate hook) is
            # ended and forgotten, so its dependency step is still the first repository code.
            self.kill_all()
            with self._lock:
                self._jobs.clear()
                self._code_ran = False
                self._has_session = True
        session_path = self._write_secret('session.json', json.dumps(credentials), 0o400)
        config = self._write_secret('aws-config', f'[default]\ncredential_process = {CAT} {session_path}\n', 0o444)
        mount = body.get('mount')
        if isinstance(mount, dict) and _BUCKET_RE.match(str(mount.get('bucket', ''))):
            self._bucket = str(mount['bucket'])
        if self.sandbox and isinstance(mount, dict) and not self._mounted:
            self._mount(str(mount.get('bucket', '')), str(mount.get('prefix', '')), config)

    def _mount(self, bucket: str, prefix: str, config: str) -> None:
        if not _BUCKET_RE.match(bucket) or not _PREFIX_RE.match(prefix):
            raise ValueError('the cache mount needs a bucket name and an engineering/cache/<connection>/ prefix')
        subprocess.run(
            [MOUNT_S3, '--read-only', '--allow-other', '--prefix', prefix, bucket, MOUNT_POINT],
            check=True, capture_output=True, env={'PATH': os.environ.get('PATH', ''), 'AWS_CONFIG_FILE': config})
        self._mounted = True

    def status(self) -> dict[str, Any]:
        """The harness's report from the agent's home: a regular file in a real directory, never through a link,
        never blocking on a FIFO, at most 64 KB."""
        try:
            raw = json.loads(_read_plain_file(os.path.join(self.agent_home, '.voc'), 'status.json', MAX_STATUS_BYTES))
        except (OSError, ValueError):
            raw = {}
        return bounded_status(raw)


def _read_plain_file(directory: str, name: str, limit: int) -> bytes:
    """``directory/name`` when both are what they say (a directory, then a regular file), neither a link."""
    dir_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    finally:
        os.close(dir_fd)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise OSError(f'{name} is not a regular file')
        return stream.read(limit)


def _unit_ids() -> tuple[int, int]:
    import pwd
    entry = pwd.getpwnam('unit')
    return entry.pw_uid, entry.pw_gid


def _handler_for(runner: Runner) -> type[BaseHTTPRequestHandler]:
    class ExecHandler(BaseHTTPRequestHandler):
        def _answer(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:
            length = int(self.headers.get('Content-Length') or 0)
            if self.path not in ('/exec', '/session') or not 0 < length <= MAX_BODY_BYTES:
                self._answer(400, {'error': 'POST /exec or /session with a JSON body'})
                return
            try:
                body = json.loads(self.rfile.read(length))
                if self.path == '/session':
                    runner.keep_session(body)
                    self._answer(200, {'kept': True})
                    return
                exec_id = runner.start(body)
            except (ValueError, OSError, subprocess.CalledProcessError) as error:
                self._answer(400, {'error': scrub_text(str(error))[:300]})
                return
            self._answer(202, {'exec_id': exec_id})

        def do_GET(self) -> None:
            if self.path == '/status':
                self._answer(200, runner.status())
                return
            exec_id = self.path.removeprefix('/exec/')
            if exec_id == self.path:
                self._answer(404, {'error': 'GET /exec/<id> or /status'})
                return
            try:
                result = runner.poll(exec_id)
            except KeyError:
                self._answer(404, {'error': 'unknown exec id'})
                return
            self._answer(200, {'state': 'running'} if result is None else {'state': 'done', **result})

        @override
        def log_message(self, format: str, *args: Any) -> None:
            """Requests are not logged: a path or body may name the repository's files, or hold a session."""

    return ExecHandler


def serve(host: str, port: int, runner: Runner) -> ThreadingHTTPServer:
    """A server for ``runner``, not yet serving (call ``serve_forever``)."""
    return ThreadingHTTPServer((host, port), _handler_for(runner))


def main(argv: list[str]) -> ThreadingHTTPServer:
    """The image's runner, from its entry point's arguments (engineering-images/common/entrypoint.sh)."""
    parser = argparse.ArgumentParser(prog='unit_runner')
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--workdir', required=True)
    parser.add_argument('--agent-home', required=True)
    parser.add_argument('--secrets-dir', required=True)
    parser.add_argument('--sandbox', action='store_true')
    parser.add_argument('--code-firewall', action='store_true')
    parser.add_argument('--hardlink-guard', action='store_true')
    args = parser.parse_args(argv)
    return serve(args.host, args.port, Runner(args.workdir, sandbox=args.sandbox, secrets_dir=args.secrets_dir,
                                               agent_home=args.agent_home, code_firewall=args.code_firewall,
                                               hardlink_guard=args.hardlink_guard))


if __name__ == '__main__':
    main(sys.argv[1:]).serve_forever()
