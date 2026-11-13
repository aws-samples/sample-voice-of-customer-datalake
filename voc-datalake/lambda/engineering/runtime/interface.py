"""The ``AgentRuntime`` interface: one session (its own microVM) per agent of a run, and nothing more.

Two implementations: ``agentcore.AgentCoreRuntime`` (Amazon Bedrock AgentCore Runtime, platform version V2, through
boto3; not yet run against AWS) and the tests' ``test.local_runtime.LocalAgentRuntime`` (a temporary directory and
subprocesses). The supervisor (``supervisor.py``) only ever talks to this interface, so every flow is proven on the
local fake without an AWS account.

A command is an argv tuple, never a shell string: nothing a repository holds is ever handed to a
shell by the runtime.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Final, Protocol

# The agents of the catalog, as the broker's and the board's identity spells them (one list, shipped in the images).
from engineering.connectors.identity import AGENT_ROLES as ROLES

MAX_ID_LENGTH: Final = 63
#: An AgentCore session lives at most 8 hours (its runtime's ``maxLifetime``): no agent and no command outlives it
#: without a continuation (the supervisor's, at 7 h 30 by default: ``caps.Timings.pause_after``).
SESSION_LIFE_SECONDS: Final = 8 * 60 * 60
#: A task or connection id: it becomes S3 keys, DynamoDB sort keys and session tags.
_ID_RE: Final = re.compile(rf'^[A-Za-z0-9-]{{1,{MAX_ID_LENGTH}}}\Z')
#: A run id is a ULID (Crockford base32, upper case), as the broker and the board read it from the session name.
_RUN_RE: Final = re.compile(r'^[0-9A-HJKMNP-TV-Z]{26}\Z')
#: An agent is ``<role>-<index>`` (``fixer-1``), as the board and the bus name it; the index is 0-999.
_AGENT_RE: Final = re.compile(r'^(?P<role>[a-z]+(?:-[a-z]+)*)-(?P<index>0|[1-9][0-9]{0,2})\Z')
#: IAM's limit on a session name, ``<run>.<agent index>`` (launcher.session_name): never cut, so never shared.
MAX_SESSION_NAME: Final = 64
#: A Lambda function URL's own host, ``<url-id>.lambda-url.<region>.on.aws``: the board's, as the runtime puts it on
#: an agent's egress (egress.py) and the harness signs its calls to it (harness/board_client.py).
FUNCTION_URL_RE: Final = re.compile(r'^[a-z0-9]{1,64}\.lambda-url\.[a-z0-9-]+\.on\.aws\Z')
#: The most repository paths a board task, and so its agent's launch, names (board/api.py checks it; the
#: coordinator's tools offer no more): below the checkout's own limit (checkout.MAX_SPARSE_PATHS).
MAX_TASK_PATHS: Final = 50

#: The roles that run repository code; the writers (committer, pr-author, pr-reviewer) reach the host through
#: the broker only.
CODE_ROLES: Final = frozenset({'hunter', 'fixer', 'builder', 'gate-runner'})


class RuntimeRefused(ValueError):
    """The runtime refused a request (a bad id, an empty command, a session in the wrong state)."""


class SessionsFull(RuntimeRefused):
    """No room for a new session now (the service's quota of active sessions, or its throttle): nothing started;
    try again once one ends."""


def check_id(kind: str, value: str) -> str:
    """``value`` when it is a safe id (1-63 of ``[A-Za-z0-9-]``), else ``RuntimeRefused``."""
    if not _ID_RE.match(value):
        raise RuntimeRefused(f'{kind} must be 1-{MAX_ID_LENGTH} letters, digits or "-"')
    return value


def check_run_id(run_id: str) -> str:
    """``run_id`` when it is a ULID, else ``RuntimeRefused``."""
    if not _RUN_RE.match(run_id):
        raise RuntimeRefused('run_id must be a ULID (26 characters of Crockford base32, upper case)')
    return run_id


def agent_index(agent_id: str, role: str) -> int:
    """The index of ``agent_id`` (``<role>-<index>``) when it is an agent of ``role``, else ``RuntimeRefused``."""
    match = _AGENT_RE.match(agent_id)
    if match is None or match.group('role') != role:
        raise RuntimeRefused(f'agent_id must be "{role}-<index>" (an index of 0-999)')
    return int(match.group('index'))


#: The workspace's attempts (workspace/layout.py: ``attempt-<n>``, 1-9999).
MAX_ATTEMPT: Final = 9999


@dataclass(frozen=True)
class AgentSpec:
    """What one session is started for: one agent of one run, on one task."""

    run_id: str
    agent_id: str
    role: str
    task_id: str
    #: The language toolchain image (one of ``egress.REGISTRY_HOSTS``).
    language: str
    #: Hosts the session may reach (``egress.egress_allowlist``; its runner's egress proxy holds it to them).
    egress: tuple[str, ...]
    #: The repository connection: its cache is ``engineering/cache/<connection>/``, mounted read-only.
    connection: str
    #: The checkpoint a continuation restores from (``checkpoints.CheckpointReader.latest``), if any.
    restore_key: str | None = None
    #: The task's commit and attempt (the board's): the agent's workspace keys go under them.
    commit: str = ''
    attempt: int = 1
    #: The workspace bucket (voc-eng-workspace): the agent's checkpoints, patches and findings.
    workspace_bucket: str = ''
    #: The board API's function URL: the harness's board and inbox (its host is on the agent's egress).
    board_url: str = ''

    def __post_init__(self) -> None:
        if self.role not in ROLES:
            raise RuntimeRefused(f'unknown agent role {self.role!r}')
        check_run_id(self.run_id)
        agent_index(self.agent_id, self.role)
        check_id('task_id', self.task_id)
        check_id('connection', self.connection)
        if isinstance(self.attempt, bool) or not 0 < self.attempt <= MAX_ATTEMPT:
            raise RuntimeRefused(f'attempt is the task\'s attempt, 1-{MAX_ATTEMPT}')

    def environment(self) -> dict[str, str]:
        """What the harness reads: ids and keys, never a credential (those come from the launcher)."""
        env = {'VOC_RUN_ID': self.run_id, 'VOC_AGENT_ID': self.agent_id, 'VOC_TASK_ID': self.task_id,
               'VOC_ROLE': self.role, 'VOC_ATTEMPT': str(self.attempt)}
        if self.commit:
            env['VOC_COMMIT'] = self.commit
        if self.workspace_bucket:
            env['VOC_WORKSPACE_BUCKET'] = self.workspace_bucket
        if self.restore_key:
            env['VOC_RESTORE_KEY'] = self.restore_key
        if self.board_url:
            env['VOC_BOARD_URL'] = self.board_url
        return env


@dataclass(frozen=True)
class CacheMount:
    """The connection's cache prefix, mounted read-only at ``/mnt/voc-cache`` once the agent has its role session."""

    bucket: str
    connection: str

    @property
    def prefix(self) -> str:
        return f'engineering/cache/{check_id("connection", self.connection)}/'


@dataclass(frozen=True)
class AgentStatus:
    """What the harness says it is doing, for the run monitor (scrubbed and bounded by the runner)."""

    step: str = ''
    recent_tools: tuple[str, ...] = ()
    #: Tokens per model: ``{model_id: {'in': n, 'out': n}}``.
    tokens: dict[str, dict[str, int]] = field(default_factory=dict)


@dataclass(frozen=True)
class RuntimeSession:
    """A started agent session (an AgentCore Runtime session, its own microVM): its id, the agent it serves and the
    runtime it runs on."""

    #: The runtime session id (``runtimeSessionId``), or the local fake's own id.
    vm_id: str
    agent_id: str
    #: The ARN of the AgentCore runtime the session runs on (AWS), or the working directory (the local fake).
    endpoint: str


@dataclass(frozen=True)
class ExecResult:
    """A finished command: its exit code and the scrubbed tails of its output (never the whole log)."""

    exit_code: int
    stdout_tail: str = ''
    stderr_tail: str = ''
    duration_seconds: float = 0.0
    timed_out: bool = False

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.timed_out


class HandedSession(Protocol):
    """What the runtime hands a session's runner: the launcher's role session. Declared, not imported, so the two
    modules don't import each other."""

    def process_credentials(self) -> dict[str, Any]: ...


class AgentRuntime(Protocol):
    """Start, hold, wake and end an agent's session; run commands in it; hand it its role session; read its status."""

    def run(self, spec: AgentSpec) -> RuntimeSession:
        """Start a session for ``spec`` (its language's runtime, its egress allowlist, its ids)."""
        ...

    def suspend(self, vm: RuntimeSession) -> None:
        """Hold ``vm``'s agent where it is, using no CPU, until it is resumed (an agent waiting for a message)."""
        ...

    def resume(self, vm: RuntimeSession) -> None:
        """Resume a held ``vm`` where it stopped."""
        ...

    def terminate(self, vm: RuntimeSession) -> None:
        """End ``vm`` for good. Ending an already ended session is not an error."""
        ...

    def start_exec(self, vm: RuntimeSession, command: Command) -> str:
        """Start ``command`` in the agent's checkout and return its exec id (the command runs on)."""
        ...

    def poll_exec(self, vm: RuntimeSession, exec_id: str) -> ExecResult | None:
        """The result of exec ``exec_id``, or None while it still runs."""
        ...

    def hand_session(self, vm: RuntimeSession, session: HandedSession, mount: CacheMount | None) -> None:
        """Give the session's agent user the launcher's role session (and mount the cache, the first time)."""
        ...

    def status(self, vm: RuntimeSession) -> AgentStatus:
        """The harness's own report: its step, its recent tool calls, its tokens per model."""
        ...


@dataclass(frozen=True)
class Command:
    """One command for an agent's session.

    ``repository_code`` commands (a build, a test, a gate tool) run as the image's ``code`` user, with no
    credential in their environment, and without network unless ``network`` is set (the dependency step,
    which reaches only the registries of the egress allowlist). No command outlives its session: one whose timeout
    is past the session's 8 hours is refused (split it, or let the agent continue in a new session).
    """

    argv: tuple[str, ...]
    timeout_seconds: int
    repository_code: bool = True
    network: bool = False

    def __post_init__(self) -> None:
        if not self.argv or not all(self.argv):
            raise RuntimeRefused('a command is a non-empty argv of non-empty strings')
        if self.timeout_seconds < 1:
            raise RuntimeRefused('a command needs a timeout of at least one second')
        if self.timeout_seconds > SESSION_LIFE_SECONDS:
            raise RuntimeRefused(f'a command cannot run longer than a session lives ({SESSION_LIFE_SECONDS // 3600} '
                                 'hours): split it into shorter steps, or let the agent continue in a new session')

    def to_body(self) -> dict[str, object]:
        """The runner's ``exec`` body."""
        return {'argv': list(self.argv), 'timeout_seconds': self.timeout_seconds,
                'repository_code': self.repository_code, 'network': self.network}
