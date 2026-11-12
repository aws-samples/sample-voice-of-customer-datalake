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
from typing import TYPE_CHECKING, Final, Protocol

from engineering.runtime.tokens import AuthToken

if TYPE_CHECKING:
    from engineering.runtime.launcher import RoleSession

MAX_ID_LENGTH: Final = 63
#: A run, agent, task or connection id: it becomes S3 keys, DynamoDB sort keys, session tags and queue names.
#: No "_": the queue names join ids with it (``voc-eng_<run>_<agent>``), so no two pairs of ids share a name.
_ID_RE: Final = re.compile(rf'^[A-Za-z0-9-]{{1,{MAX_ID_LENGTH}}}\Z')
#: IAM's limit on a session name, ``<run>.<agent>`` (launcher.session_name): never cut, so never shared.
MAX_SESSION_NAME: Final = 64

#: The agents of the catalog (docs/autonomous-engineering.md → The agent catalog). The first set runs
#: repository code; the writers (committer, pr_author, pr_reviewer) reach the host through the broker only.
CODE_ROLES: Final = frozenset({'hunter', 'fixer', 'builder', 'gate_runner'})
ROLES: Final = CODE_ROLES | frozenset({
    'committer', 'pr_author', 'pr_reviewer', 'understander', 'commit_reviewer', 'final_go', 'coordinator', 'coach'})


class RuntimeRefused(ValueError):
    """The runtime refused a request (a bad id, an empty command, a MicroVM in the wrong state)."""


def check_id(kind: str, value: str) -> str:
    """``value`` when it is a safe id (1-63 of ``[A-Za-z0-9-]``: no ``_``), else ``RuntimeRefused``."""
    if not _ID_RE.match(value):
        raise RuntimeRefused(f'{kind} must be 1-{MAX_ID_LENGTH} letters, digits or "-"')
    return value


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

    def __post_init__(self) -> None:
        check_id('run_id', self.run_id)
        check_id('agent_id', self.agent_id)
        check_id('task_id', self.task_id)
        check_id('connection', self.connection)
        if len(self.run_id) + 1 + len(self.agent_id) > MAX_SESSION_NAME:
            raise RuntimeRefused(f'run_id and agent_id together must fit a {MAX_SESSION_NAME}-character session name')
        if self.role not in ROLES:
            raise RuntimeRefused(f'unknown agent role {self.role!r}')

    def environment(self) -> dict[str, str]:
        """What the harness reads: ids and keys, never a credential (those come from the launcher)."""
        env = {'VOC_RUN_ID': self.run_id, 'VOC_AGENT_ID': self.agent_id, 'VOC_TASK_ID': self.task_id,
               'VOC_ROLE': self.role}
        if self.restore_key:
            env['VOC_RESTORE_KEY'] = self.restore_key
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

    def hand_session(self, vm: MicroVm, session: RoleSession, mount: CacheMount | None) -> None:
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
