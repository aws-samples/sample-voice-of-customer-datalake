"""Runs an agent's commands: in the local fake, and as the runner inside each toolchain image.

Standard library only, so the images copy this one file (engineering-images/*/Dockerfile) and run it as
their entry point: the container of an AgentCore Runtime session (each session its own microVM). On port 8080 it
answers what the service calls, behind the service's own IAM authentication:

- ``GET /ping``: ``Healthy``, or ``HealthyBusy`` while a command of the agent runs and is not held, so the service
  never ends a session for idleness while its agent works (waits on the model, a build, a tool).
- ``POST /invocations`` (InvokeAgentRuntime): ``{"op": ...}``: ``start`` (the agent's ids and its egress allowlist,
  once, before anything else: refused in the image without the egress firewall), ``session`` (below), ``status``,
  ``hold`` and ``wake`` (the agent's commands stopped where they are and continued: an open wait uses no CPU).

and, on the session's own loopback, to the agent's harness and to the ``client`` command the supervisor runs through
the runtime's command API (InvokeAgentRuntimeCommand, ``client start|poll <base64 JSON>``: a call of seconds, so a
build or a test run of any length up to the session's life is started by one call and read by later ones, never
held inside one call's 3,600 seconds):

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

Egress: the agent (user ``unit``) and the dependency step (``code`` with network) reach nothing but the runner and its
egress proxy on loopback (the entry point's firewall, ``--egress-firewall``); the proxy (``EgressProxy``, root's) lets
an HTTPS ``CONNECT`` through only to a host of the session's allowlist, on port 443. The session's network (a VPC with
egress on 443 only) is the second wall.

Only the last 4,000 characters of each stream are kept, and anything shaped like a credential is masked
before anything leaves the runner. The tests' local fake (``test/local_runtime.py``) uses ``Runner`` directly, unsandboxed.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import http.client
import ipaddress
import json
import os
import re
import select
import signal
import socket
import socketserver
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections.abc import Callable, Iterable
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Final, Literal, TypeVar

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
#: The port AgentCore Runtime calls the container on (/ping, /invocations), and the runner's loopback API.
#: (The AgentCore service's port is 8080: the entry point's ``--port``.)
#: The agent's own API (/exec, /status), on loopback only: the one port of the runner `unit` may reach.
AGENT_PORT: Final = 8081
#: The two egress proxies, on the session's loopback only: the agent's (Bedrock, its buckets, the board) and the
#: dependency step's (its language's registries and the deployment's extra hosts). The entry point's firewall sends
#: each user to its own: `unit` to PROXY_PORT, `code` to CODE_PROXY_PORT.
PROXY_PORT: Final = 3128
CODE_PROXY_PORT: Final = 3129


def proxy_env(port: int) -> dict[str, str]:
    """What a command is pointed at the proxy on ``port`` with (the JVM reads its own settings)."""
    url = f'http://127.0.0.1:{port}'
    # NODE_USE_ENV_PROXY: Node's own fetch reads the variables only when asked to (npm reads them anyway); Maven reads
    # none (the Java image's ~/.m2/settings.xml for `code`).
    return {'HTTPS_PROXY': url, 'https_proxy': url, 'NO_PROXY': '127.0.0.1,localhost', 'no_proxy': '127.0.0.1,localhost',
            'NODE_USE_ENV_PROXY': '1', 'JAVA_TOOL_OPTIONS': f'-Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort={port}'}


PROXY_ENV: Final = proxy_env(PROXY_PORT)
CODE_PROXY_ENV: Final = proxy_env(CODE_PROXY_PORT)
#: The one port the proxy lets a ``CONNECT`` through to.
HTTPS_PORT: Final = 443
#: A proxied connection with no byte either way for this long is closed (a model's longest answer is far shorter).
PROXY_IDLE_SECONDS: Final = 15 * 60
MAX_PROXY_HEADER_BYTES: Final = 8 * 1024
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
#: The agent's ids (``interface.AgentSpec.environment``, handed with the session's ``start``) and its region: the
#: agent's own commands' only (the harness reads them); repository code never needs them.
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
#: A plain DNS name: an egress allowlist's host (egress.check_host; the proxy compares exactly).
HOST_RE: Final = re.compile(r'^(?=.{1,253}\Z)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z')
_ENV_VALUE_RE: Final = re.compile(r'^[A-Za-z0-9._:/@+=,-]{0,512}\Z')
MAX_EGRESS_HOSTS: Final = 64
#: How long past its role session's expiry an agent's commands may run before the runner ends them all.
SESSION_LAPSE_GRACE: Final = 60
#: How often the image's runner checks for that.
LAPSE_CHECK_SECONDS: Final = 30
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

    The runner runs as root inside the session so that it can do this; no command ever runs as root, and root runs
    its own tools by absolute path only (a directory ``code`` can write may be on a command's ``PATH``). Repository
    code gets its own PID namespace and ``/proc`` (no view of the agent's processes or their environment) and,
    unless it is the dependency step, its own network namespace, with only its own loopback (builds and tests that
    bind 127.0.0.1 work): neither the runner nor a link-local credential endpoint is in it. Both users share the
    group ``work``, which owns only ``/work`` (the checkout); ``unit``'s own files (notes, anything derived from
    customer feedback) stay in its home, which ``code`` cannot read.
    """
    user = 'code' if repository_code else 'unit'
    # No new privileges (a setuid file or a file capability grants nothing), and no capability left in the bounding
    # set to regain: the image strips every setuid and setgid bit too (install-base.sh).
    drop = [SETPRIV, f'--reuid={user}', '--regid=work', '--clear-groups', '--inh-caps=-all', '--bounding-set=-all',
            '--no-new-privs']
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
                os.killpg(self._process.pid, signal.SIGCONT)   # (a held group wakes to die)
                os.killpg(self._process.pid, signal.SIGKILL)
            self._process.wait()

    @property
    def running(self) -> bool:
        return self._process.poll() is None

    def send(self, sent: signal.Signals) -> None:
        """``sent`` to the command's whole process group while it runs (``SIGSTOP`` holds it, ``SIGCONT`` wakes it)."""
        if self.running:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(self._process.pid, sent)


class Runner:
    """The commands, the session and the status of one session.

    ``secrets_dir`` holds the agent's role session: a directory only root can write (``/run/voc`` in the
    image), so nothing the agent or repository code planted there can redirect root's writes, and the
    session file inside it is readable by ``unit`` only. ``code_firewall`` says the image's entry point
    has stopped ``code`` from reaching the runner's port and link-local addresses: without it, the
    dependency step (repository code with network) is refused. ``hardlink_guard`` says the session cannot be
    hard-linked into the checkout (the secrets directory on a file system of its own, or the kernel's protected
    hard links on): without it, no repository code runs at all. ``egress_firewall`` says the entry point has kept the
    agent to the runner and ``proxy`` and repository code to ``code_proxy``, on loopback: without it (or either proxy),
    the image starts no agent.
    """

    def __init__(self, workdir: str, *, sandbox: bool, secrets_dir: str, agent_home: str,
                 code_firewall: bool = False, hardlink_guard: bool = False, logs_root: str | None = None,
                 egress_firewall: bool = False, proxy: EgressProxy | None = None,
                 code_proxy: EgressProxy | None = None) -> None:
        self.workdir = workdir
        self.sandbox = sandbox
        self.secrets_dir = secrets_dir
        self.agent_home = agent_home
        self.code_firewall = code_firewall
        self.hardlink_guard = hardlink_guard
        self.egress_firewall = egress_firewall
        self.proxy = proxy
        self.code_proxy = code_proxy
        self._logs_root = logs_root
        #: exec id -> (job, kind): ``agent`` (the agent's own), ``dependency`` (repository code with network), ``code``.
        self._jobs: dict[str, tuple[CommandJob, str]] = {}
        self._code_ran = False
        self._mounted = False
        self._has_session = False
        self._bucket = ''
        #: The agent's ids, from the session's ``start`` (``begin``); None before it.
        self._ids: dict[str, str] | None = None
        self._egress: tuple[list[str], list[str]] = ([], [])
        self._held = False
        #: When the agent's role session lapses (epoch seconds; None before its first), and its last wake.
        self._session_expires: float | None = None
        self._woken_at = 0.0
        self._lock = threading.Lock()

    def _agent_env(self) -> dict[str, str]:
        """What the agent's own commands (never repository code) get: its home, where its session is, its ids,
        the bucket its session was handed with, and the egress proxy (in the image)."""
        ids = {name: os.environ[name] for name in AGENT_ENV if name in os.environ}
        ids.update(self._ids or {})
        bucket = {'VOC_BUCKET': self._bucket} if self._bucket else {}
        proxy = PROXY_ENV if self.proxy is not None else {}
        return {**ids, **bucket, **proxy, 'HOME': self.agent_home,
                'AWS_CONFIG_FILE': os.path.join(self.secrets_dir, 'aws-config'), 'AWS_SDK_LOAD_CONFIG': '1'}

    def _code_env(self, *, network: bool = False) -> dict[str, str]:
        """What repository code gets beyond PASSED_ENV: its own home in the image (never root's or the agent's), and
        for the dependency step its own egress proxy (its only way to the registries; never the agent's)."""
        home = {'HOME': CODE_HOME} if self.sandbox else {}
        return {**home, **(CODE_PROXY_ENV if network and self.code_proxy is not None else {})}

    def begin(self, body: dict[str, Any]) -> dict[str, Any]:
        """The session's ``start``: the agent's ids (``AGENT_ENV`` only, plain values), its own egress allowlist
        (``egress``) and the dependency step's (``code_egress``), once; the same start again is answered as before (a
        retried invocation), another one refused."""
        environment = body.get('environment')
        if not isinstance(environment, dict):
            raise ValueError('start needs environment (an object)')
        ids = {str(name): str(value) for name, value in environment.items()}
        if set(ids) - set(AGENT_ENV) or not all(_ENV_VALUE_RE.match(value) for value in ids.values()):
            raise ValueError('start names only the agent\'s ids, as plain values')
        egress = (_hosts(body.get('egress')), _hosts(body.get('code_egress', [])))
        if self.sandbox and (not self.egress_firewall or self.proxy is None or self.code_proxy is None):
            raise ValueError('this session could not keep its agent to its egress allowlist: no agent starts')
        with self._lock:
            # Once: the same start again (a retried invocation) changes nothing; any other, the agent's own call on
            # loopback included, is refused, so nothing in the session ever widens its egress.
            if self._ids is not None and (self._ids, self._egress) != (ids, egress):
                raise ValueError('this session was started for another agent or another egress allowlist')
            self._ids, self._egress = ids, egress
        if self.proxy is not None:
            self.proxy.allow(egress[0])
        if self.code_proxy is not None:
            self.code_proxy.allow(egress[1])
        return {'started': True}

    def hold(self) -> None:
        """Stop every command where it is (an agent on an open wait): it uses no CPU until ``wake``."""
        with self._lock:
            for job, _ in self._jobs.values():
                job.send(signal.SIGSTOP)
            self._held = True

    def wake(self, now: float | None = None) -> None:
        """Continue every held command where it stopped. The role session's lapse counts from here: the supervisor
        hands a fresh one right after a wake, and a hold (up to 45 minutes) outlives a 15-minute session."""
        with self._lock:
            for job, _ in self._jobs.values():
                job.send(signal.SIGCONT)
            self._held = False
            self._woken_at = time.time() if now is None else now

    @property
    def busy(self) -> bool:
        """A command runs and is not held: the service must not take the session for idle."""
        with self._lock:
            return not self._held and any(job.running for job, _ in self._jobs.values())

    def ping(self) -> dict[str, Any]:
        """AgentCore's health answer: busy while the agent works, so its session is never ended for idleness then."""
        return {'status': 'HealthyBusy' if self.busy else 'Healthy', 'time_of_last_update': int(time.time())}

    def invoke(self, body: dict[str, Any]) -> dict[str, Any]:
        """One ``/invocations`` call: ``start``, ``session``, ``status``, ``hold`` or ``wake``."""
        op = body.get('op')
        if op == 'start':
            return self.begin(body)
        if op == 'session':
            session = body.get('session')
            if not isinstance(session, dict):
                raise ValueError('session needs the role session (an object)')
            self.keep_session(session)
            return {'kept': True}
        if op == 'status':
            return self.status()
        if op == 'hold':
            self.hold()
            return {'held': True}
        if op == 'wake':
            self.wake()
            return {'held': False}
        raise ValueError('op is one of start, session, status, hold, wake')

    def start(self, body: dict[str, Any]) -> str:
        argv, timeout = body.get('argv'), body.get('timeout_seconds')
        if not isinstance(argv, list) or not isinstance(timeout, int) or isinstance(timeout, bool):
            raise ValueError('the body needs argv (a list of strings) and timeout_seconds (a whole number)')
        repository_code, network = body.get('repository_code') is not False, body.get('network') is True
        if repository_code and self.sandbox and not self.hardlink_guard:
            raise ValueError('repository code needs the hard-link guard, which this session could not set up')
        if repository_code and network and self.sandbox and not self.code_firewall:
            raise ValueError('the dependency step needs the code firewall, which this session could not set up')
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
                             extra_env=self._code_env(network=network) if repository_code else self._agent_env(),
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
        self._session_expires = _expiry(credentials['Expiration'])
        session_path = self._write_secret('session.json', json.dumps(credentials), 0o400)
        config = self._write_secret('aws-config', f'[default]\ncredential_process = {CAT} {session_path}\n', 0o444)
        mount = body.get('mount')
        if isinstance(mount, dict) and _BUCKET_RE.match(str(mount.get('bucket', ''))):
            self._bucket = str(mount['bucket'])
        if self.sandbox and isinstance(mount, dict) and not self._mounted:
            self._mount(str(mount.get('bucket', '')), str(mount.get('prefix', '')), config)

    def end_if_lapsed(self, now: float) -> bool:
        """End every command once the agent's role session has lapsed unrenewed (``SESSION_LAPSE_GRACE`` past its
        expiry): a session whose supervisor lost it (a stop that failed, a stopped run, which the launcher renews no
        more) runs nothing more, and with nothing busy its runtime's idle timeout ends it."""
        expires = self._session_expires
        # Held, nothing runs and nothing renews: the lapse counts from the wake, which a fresh session follows.
        if expires is None or self._held or now < max(expires, self._woken_at) + SESSION_LAPSE_GRACE:
            return False
        self.kill_all()
        return True

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


def _got(runner: Runner, path: str, api: Api) -> tuple[int, dict[str, Any]]:
    """What a GET of ``path`` answers: AgentCore's ping (the service's port), or the harness's status and an exec's
    state (the agent's)."""
    if api == 'service':
        return (200, runner.ping()) if path == '/ping' else (404, {'error': 'GET /ping'})
    if path == '/status':
        return 200, runner.status()
    exec_id = path.removeprefix('/exec/')
    if exec_id == path:
        return 404, {'error': 'GET /exec/<id> or /status'}
    try:
        result = runner.poll(exec_id)
    except KeyError:
        return 404, {'error': 'unknown exec id'}
    return 200, {'state': 'running'} if result is None else {'state': 'done', **result}


def _expiry(raw: object) -> float:
    """A role session's ``Expiration`` (ISO 8601, as the launcher writes it, or epoch seconds) as epoch seconds."""
    if isinstance(raw, int | float):
        return float(raw)
    try:
        return datetime.fromisoformat(str(raw)).timestamp()
    except ValueError as error:
        raise ValueError('a session\'s Expiration is an ISO 8601 time') from error


def _watch_lapse(runner: Runner) -> None:
    """The image's watchdog: every ``LAPSE_CHECK_SECONDS``, ``Runner.end_if_lapsed``."""
    while True:
        time.sleep(LAPSE_CHECK_SECONDS)
        runner.end_if_lapsed(time.time())


def _hosts(raw: object) -> list[str]:
    """An egress allowlist from a start: at most ``MAX_EGRESS_HOSTS`` plain host names, lower case, sorted."""
    hosts = sorted(str(host).lower() for host in raw) if isinstance(raw, list) else []
    if not isinstance(raw, list) or len(hosts) > MAX_EGRESS_HOSTS or not all(map(HOST_RE.match, hosts)):
        raise ValueError(f'start needs egress and code_egress as lists of at most {MAX_EGRESS_HOSTS} plain host '
                         'names')
    return hosts


#: The runner's two HTTP faces: ``service`` (port 8080, the AgentCore service's: /ping, /invocations, which carry the
#: role session, hold and wake) and ``agent`` (the agent's own, on loopback: /exec, /exec/<id>, /status). The entry
#: point's firewall lets ``unit`` reach the agent's port only, so the agent can never hand itself a session, start
#: itself again or wake itself.
Api = Literal['service', 'agent']
_POSTED: Final[dict[str, str]] = {'service': '/invocations', 'agent': '/exec'}


def _handler_for(runner: Runner, api: Api) -> type[BaseHTTPRequestHandler]:
    posted = _POSTED[api]

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
            if self.path != posted or not 0 < length <= MAX_BODY_BYTES:
                self._answer(400, {'error': f'POST {posted} with a JSON body'})
                return
            try:
                body = json.loads(self.rfile.read(length))
            except ValueError:
                body = None
            if not isinstance(body, dict):
                self._answer(400, {'error': 'the body is a JSON object'})
                return
            try:
                if api == 'service':
                    self._answer(200, runner.invoke(body))
                    return
                exec_id = runner.start(body)
            except (ValueError, OSError, subprocess.CalledProcessError) as error:
                self._answer(400, {'error': scrub_text(str(error))[:300]})
                return
            self._answer(202, {'exec_id': exec_id})

        def do_GET(self) -> None:
            self._answer(*_got(runner, self.path, api))

        @override
        def log_message(self, format: str, *args: Any) -> None:
            """Requests are not logged: a path or body may name the repository's files, or hold a session."""

    return ExecHandler


def serve(host: str, port: int, runner: Runner, api: Api = 'service') -> ThreadingHTTPServer:
    """A server of ``runner``'s ``api`` face, not yet serving (call ``serve_forever``)."""
    return ThreadingHTTPServer((host, port), _handler_for(runner, api))


Connect = Callable[[tuple[str, int], float], socket.socket]


def outside(address: str) -> bool:
    """``address`` is one a proxied tunnel may reach: never link-local (169.254.0.0/16, fe80::/10, a credential or
    metadata endpoint), loopback or unspecified, whatever name resolved to it. (Private addresses stay: an interface
    endpoint in the VPC has one.)"""
    ip = ipaddress.ip_address(address.split('%', 1)[0])
    return not (ip.is_link_local or ip.is_loopback or ip.is_unspecified)


def _connect_outside(target: tuple[str, int], timeout: float,
                     resolve: Callable[..., list[Any]] = socket.getaddrinfo) -> socket.socket:
    """Resolve ``target`` and connect to its first address ``outside`` allows; ``OSError`` when none."""
    host, port = target
    for family, kind, proto, _, sockaddr in resolve(host, port, type=socket.SOCK_STREAM):
        if not outside(str(sockaddr[0])):
            continue
        connection = socket.socket(family, kind, proto)
        connection.settimeout(timeout)
        try:
            connection.connect(sockaddr)
        except OSError:
            connection.close()
            continue
        return connection
    raise OSError(f'{host} resolves to no address a tunnel may reach')


class EgressProxy:
    """The session's way out for the agent and the dependency step: an HTTPS ``CONNECT`` proxy on loopback that lets
    a tunnel through only to a host of the session's allowlist (exactly, lower case), on port 443, and refuses
    everything else (any other method, port or host; anything before ``allow``). It never reads what goes through a
    tunnel. Root runs it; the entry point's firewall keeps ``unit`` and ``code`` to it and to the runner."""

    def __init__(self, host: str = '127.0.0.1', port: int = PROXY_PORT, *, connect: Connect | None = None,
                 ports: Iterable[int] = (HTTPS_PORT,)) -> None:
        self._allowed: frozenset[str] = frozenset()
        self._ports = frozenset(ports)
        self._connect: Connect = connect or _connect_outside
        proxy = self

        class Tunnel(socketserver.BaseRequestHandler):
            def handle(self) -> None:
                proxy.tunnel(self.request)

        self.server = socketserver.ThreadingTCPServer((host, port), Tunnel)

    def allow(self, hosts: Iterable[str]) -> None:
        self._allowed = frozenset(host.lower() for host in hosts)

    def target(self, request: bytes) -> tuple[str, int] | None:
        """The ``CONNECT host:port`` of ``request``'s first line when it is allowed, else None."""
        line = request.split(b'\r\n', 1)[0].decode('ascii', errors='replace')
        parts = line.split(' ')
        if len(parts) != 3 or parts[0] != 'CONNECT' or not parts[2].startswith('HTTP/1.'):
            return None
        host, _, port = parts[1].rpartition(':')
        host = host.lower()
        if not port.isdigit() or int(port) not in self._ports or host not in self._allowed or not HOST_RE.match(host):
            return None
        return host, int(port)

    def tunnel(self, client: socket.socket) -> None:
        client.settimeout(30)
        request = b''
        with contextlib.suppress(OSError):
            while b'\r\n\r\n' not in request and len(request) < MAX_PROXY_HEADER_BYTES:
                chunk = client.recv(1024)
                if not chunk:
                    break
                request += chunk
        target = self.target(request) if b'\r\n\r\n' in request else None
        if target is None:
            with contextlib.suppress(OSError):
                client.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            return
        try:
            upstream = self._connect(target, 20)
        except OSError:
            with contextlib.suppress(OSError):
                client.sendall(b'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            return
        with upstream:
            client.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            # Whatever the client sent after the request's head is the tunnel's first bytes.
            rest = request.split(b'\r\n\r\n', 1)[1]
            if rest:
                upstream.sendall(rest)
            _relay(client, upstream)

    def serve(self) -> threading.Thread:
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        return thread


def _relay(one: socket.socket, other: socket.socket) -> None:
    """Copy bytes both ways until either side closes or nothing moves for ``PROXY_IDLE_SECONDS``."""
    pair = {one: other, other: one}
    while True:
        ready, _, _ = select.select(list(pair), [], [], PROXY_IDLE_SECONDS)
        if not ready:
            return
        for source in ready:
            try:
                data = source.recv(64 * 1024)
            except OSError:
                return
            if not data:
                return
            try:
                pair[source].sendall(data)
            except OSError:
                return


def client(verb: str, encoded: str, port: int = AGENT_PORT) -> dict[str, Any]:
    """``unit_runner.py client start|poll <base64 JSON>``: what the supervisor runs through the runtime's command API.

    ``start`` hands the runner a command (``interface.Command.to_body``) and answers its exec id at once; ``poll``
    answers its state (``running``, or ``done`` with its scrubbed result). The argument is base64 (the command API
    takes one shell string; base64 has no character a shell reads), and the runner is on the session's own loopback
    (a constant address, never a proxy).
    """
    body = json.loads(base64.urlsafe_b64decode(encoded.encode('ascii')))
    if not isinstance(body, dict):
        raise ValueError('the body is a JSON object')
    if verb == 'start':
        method, path, sent = 'POST', '/exec', json.dumps(body)
    elif verb == 'poll' and str(body.get('exec_id', '')).isalnum():
        method, path, sent = 'GET', f'/exec/{body["exec_id"]}', None
    else:
        raise ValueError('client start <command> or client poll <exec id>')
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=30)
    try:
        connection.request(method, path, body=sent, headers={'Content-Type': 'application/json'})
        answer = connection.getresponse()
        status, data = answer.status, answer.read(MAX_BODY_BYTES)
    finally:
        connection.close()
    result = json.loads(data)
    if not isinstance(result, dict):
        raise ValueError('the runner answered something other than a JSON object')
    if status >= 400:
        reason = result.get('error')
        raise ValueError(reason if isinstance(reason, str) else f'the runner refused it ({status})')
    return result


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
    parser.add_argument('--egress-firewall', action='store_true')
    #: The egress proxies' loopback ports, the agent's and the dependency step's (0: none, as in a test).
    parser.add_argument('--proxy-port', type=int, default=0)
    parser.add_argument('--code-proxy-port', type=int, default=0)
    #: The agent's own API on loopback (0: none, as in a test).
    parser.add_argument('--agent-port', type=int, default=0)
    args = parser.parse_args(argv)
    proxy = EgressProxy(port=args.proxy_port) if args.proxy_port else None
    code_proxy = EgressProxy(port=args.code_proxy_port) if args.code_proxy_port else None
    for each in (proxy, code_proxy):
        if each is not None:
            each.serve()
    runner = Runner(args.workdir, sandbox=args.sandbox, secrets_dir=args.secrets_dir, agent_home=args.agent_home,
                    code_firewall=args.code_firewall, hardlink_guard=args.hardlink_guard,
                    egress_firewall=args.egress_firewall, proxy=proxy, code_proxy=code_proxy)
    if args.sandbox:
        threading.Thread(target=_watch_lapse, args=(runner,), daemon=True).start()
    if args.agent_port:
        agent = serve('127.0.0.1', args.agent_port, runner, 'agent')
        threading.Thread(target=agent.serve_forever, daemon=True).start()
    return serve(args.host, args.port, runner, 'service')


def _client_main(argv: list[str]) -> int:
    """``client <verb> <base64>``: the answer as one JSON line on stdout; a refusal on stderr, exit 1."""
    if len(argv) != 2:
        sys.stderr.write('usage: unit_runner.py client start|poll <base64 JSON>\n')
        return 2
    try:
        answer = client(argv[0], argv[1])
    except (ValueError, OSError) as error:
        sys.stderr.write(scrub_text(str(error))[:300] + '\n')
        return 1
    sys.stdout.write(json.dumps(answer) + '\n')
    return 0


if __name__ == '__main__':
    if sys.argv[1:2] == ['client']:
        sys.exit(_client_main(sys.argv[2:]))
    main(sys.argv[1:]).serve_forever()
