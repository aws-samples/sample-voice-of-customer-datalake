"""The ``MicroVmRuntime`` interface: one MicroVM per agent of a run, and nothing more.

Two implementations: ``aws.AwsMicroVmRuntime`` (Lambda MicroVMs, through boto3; not yet run against
AWS) and the tests' ``test.local_runtime.LocalMicroVmRuntime`` (a temporary directory and subprocesses). The supervisor (``supervisor.py``) only ever talks to this interface, so every flow is proven
on the local fake without an AWS account.

A command is an argv tuple, never a shell string: nothing a repository holds is ever handed to a
shell by the runtime.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Final, Protocol

# The agents of the catalog, as the broker's and the board's identity spells them (one list, shipped in the images).
from engineering.connectors.identity import AGENT_ROLES as ROLES
from engineering.runtime.tokens import AuthToken

MAX_ID_LENGTH: Final = 63
#: A task or connection id: it becomes S3 keys, DynamoDB sort keys and session tags.
_ID_RE: Final = re.compile(rf'^[A-Za-z0-9-]{{1,{MAX_ID_LENGTH}}}\Z')
#: A run id is a ULID (Crockford base32, upper case), as the broker and the board read it from the session name.
_RUN_RE: Final = re.compile(r'^[0-9A-HJKMNP-TV-Z]{26}\Z')
#: An agent is ``<role>-<index>`` (``fixer-1``), as the board and the bus name it; the index is 0-999.
_AGENT_RE: Final = re.compile(r'^(?P<role>[a-z]+(?:-[a-z]+)*)-(?P<index>0|[1-9][0-9]{0,2})\Z')
#: IAM's limit on a session name, ``<run>.<agent index>`` (launcher.session_name): never cut, so never shared.
MAX_SESSION_NAME: Final = 64

#: The roles that run repository code; the writers (committer, pr-author, pr-reviewer) reach the host through
#: the broker only.
CODE_ROLES: Final = frozenset({'hunter', 'fixer', 'builder', 'gate-runner'})


class RuntimeRefused(ValueError):
    """The runtime refused a request (a bad id, an empty command, a MicroVM in the wrong state)."""


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
    """What one MicroVM is started for: one agent of one run, on one task."""

    run_id: str
    agent_id: str
    role: str
    task_id: str
    #: The language toolchain image (one of ``egress.REGISTRY_HOSTS``).
    language: str
    #: Hosts the MicroVM may reach (``egress.egress_allowlist``).
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
    """The connection's cache prefix, mounted read-only at ``/mnt/voc-cache`` once the MicroVM has a session."""

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
class MicroVm:
    """A started MicroVM: its id, the agent it serves and where its runner answers."""

    vm_id: str
    agent_id: str
    #: The runner's HTTPS base URL (AWS), or the working directory (the local fake).
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
    """What the runtime hands a MicroVM's runner: the launcher's role session. Declared, not imported, so the two
    modules don't import each other."""

    def process_credentials(self) -> dict[str, Any]: ...


class MicroVmRuntime(Protocol):
    """Run, suspend, resume, terminate a MicroVM; run commands in it; mint its auth token."""

    def run(self, spec: AgentSpec) -> MicroVm:
        """Start a MicroVM for ``spec`` (its image, egress allowlist and idle policy)."""
        ...

    def suspend(self, vm: MicroVm) -> None:
        """Suspend ``vm`` with its state, until it is resumed (an agent waiting for a message)."""
        ...

    def resume(self, vm: MicroVm) -> None:
        """Resume a suspended ``vm`` where it stopped."""
        ...

    def terminate(self, vm: MicroVm) -> None:
        """End ``vm`` for good. Terminating an already terminated MicroVM is not an error."""
        ...

    def start_exec(self, vm: MicroVm, command: Command) -> str:
        """Start ``command`` in the agent's checkout and return its exec id (the command runs on)."""
        ...

    def poll_exec(self, vm: MicroVm, exec_id: str) -> ExecResult | None:
        """The result of exec ``exec_id``, or None while it still runs."""
        ...

    def mint_token(self, vm: MicroVm) -> AuthToken:
        """A fresh auth token for ``vm``'s endpoint (at most 60 minutes; held in memory only)."""
        ...

    def hand_session(self, vm: MicroVm, session: HandedSession, mount: CacheMount | None) -> None:
        """Give the MicroVM's agent user the launcher's role session (and mount the cache, the first time)."""
        ...

    def status(self, vm: MicroVm) -> AgentStatus:
        """The harness's own report: its step, its recent tool calls, its tokens per model."""
        ...


@dataclass(frozen=True)
class Command:
    """One command for an agent's MicroVM.

    ``repository_code`` commands (a build, a test, a gate tool) run as the image's ``code`` user, with no
    credential in their environment, and without network unless ``network`` is set (the dependency step,
    which reaches only the registries of the egress allowlist).
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

    def to_body(self) -> dict[str, object]:
        """The runner's ``POST /exec`` body."""
        return {'argv': list(self.argv), 'timeout_seconds': self.timeout_seconds,
                'repository_code': self.repository_code, 'network': self.network}
