"""moto's S3 and voc-agents, fakes of the ports the runtime does not own, and a supervisor on the local fake."""
import sys
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any

import boto3
import pytest
from moto import mock_aws

from engineering.runtime.caps import Timings
from engineering.runtime.checkpoints import CheckpointReader
from engineering.runtime.interface import ROLES, Command
from engineering.runtime.launcher import Launcher
from engineering.runtime.ports import Budget, BudgetAlert, Lease
from engineering.runtime.runs import RunCaps, RunStore
from engineering.runtime.sessions import AgentSession, SessionStore
from engineering.runtime.supervisor import Supervisor
from engineering.runtime.test.local_runtime import LocalAgentRuntime

BUCKET = 'voc-raw-test'
#: voc-eng-workspace's stand-in, where the handler's wiring writes and reads the agents' keys.
WORKSPACE_BUCKET = 'voc-eng-workspace-test'
TABLE = 'voc-engineering-test'
RUN = '01JD3R4NZXQ7Y2W8K4M6P9T0AB'
COMMIT = 'a' * 40
ROLE_ARNS = {role: f'arn:aws:iam::111111111111:role/voc-engineering-{role}' for role in ROLES}


@dataclass
class FakeSts:
    calls: list[dict[str, Any]] = field(default_factory=list)
    clock: list[float] = field(default_factory=lambda: [1000.0])

    def assume_role(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return {'Credentials': {'AccessKeyId': 'ASIAFAKEFAKEFAKE', 'SecretAccessKey': 'fake-secret',
                                'SessionToken': f'fake-session-{len(self.calls)}',
                                'Expiration': self.clock[0] + kwargs['DurationSeconds']}}


@dataclass
class FakeBoard:
    leases: dict[str, Lease] = field(default_factory=dict)
    reposted: list[tuple[str, str]] = field(default_factory=list)
    attempts: list[int] = field(default_factory=list)
    refreshed: list[tuple[str, str, int]] = field(default_factory=list)
    #: What a refresh answers (False: the task is not the holder's any more).
    refreshes: bool = True

    def lease(self, run_id: str, task_id: str) -> Lease | None:
        return self.leases.get(f'{run_id}/{task_id}')

    def refresh(self, run_id: str, task_id: str, *, agent_id: str, attempt: int) -> bool:
        self.refreshed.append((f'{run_id}/{task_id}', agent_id, attempt))
        return self.refreshes

    def repost(self, run_id: str, task_id: str, reason: str, *, attempt: int) -> None:
        self.reposted.append((f'{run_id}/{task_id}', reason))
        self.attempts.append(attempt)


@dataclass
class FakeBus:
    events: list[dict[str, Any]] = field(default_factory=list)

    def emit(self, run_id: str, to: str, kind: str, summary: str, refs: Mapping[str, str] | None = None, *,
             task_id: str = '', attempt: int = 1) -> None:
        self.events.append({'run_id': run_id, 'to': to, 'kind': kind, 'summary': summary, 'refs': dict(refs or {}),
                            'task_id': task_id, 'attempt': attempt})

    def kinds(self) -> list[str]:
        return [event['kind'] for event in self.events if event['kind'] != 'run.health']


@dataclass
class FakeControl:
    spend: Budget = field(default_factory=lambda: Budget(tokens=0, cost_usd=0.0, max_tokens=None, max_cost_usd=None))
    stops: set[str] = field(default_factory=set)
    humans: list[tuple[str, str]] = field(default_factory=list)
    started: int = 0
    #: The alert the next tick's check gives (None: no alert); ``sent``, each one the supervisor closed.
    alert: BudgetAlert | None = None
    sent: list[BudgetAlert] = field(default_factory=list)
    released: list[BudgetAlert] = field(default_factory=list)
    #: The runs started with a coordinator to launch, and when (``coordinator_awaited``).
    awaited: dict[str, int] = field(default_factory=dict)

    def budget(self, run_id: str) -> Budget:
        assert run_id
        return self.spend

    def started_at(self, run_id: str) -> int:
        assert run_id
        return self.started

    def stop_requested(self, run_id: str) -> bool:
        return run_id in self.stops

    def needs_human(self, run_id: str, reason: str) -> None:
        self.humans.append((run_id, reason))

    def is_active(self, run_id: str) -> bool:
        """Active until stopped or sent to a person (a Resume is the test's to model)."""
        return run_id not in self.stops and all(run != run_id for run, _reason in self.humans)

    def coordinator_awaited(self, run_id: str) -> int | None:
        """Only for a run the test started with a coordinator to launch (``awaited``), while it is active."""
        return self.awaited.get(run_id) if self.is_active(run_id) else None

    def budget_alert(self, run_id: str, now: int) -> BudgetAlert | None:
        assert run_id
        assert now >= 0
        return self.alert

    def alert_not_sent(self, run_id: str, alert: BudgetAlert) -> None:
        assert run_id
        self.released.append(alert)

    def alert_sent(self, run_id: str, alert: BudgetAlert, now: int) -> None:
        assert run_id
        assert now >= 0
        self.sent.append(alert)
        self.alert = None


def quick_checkout(_commit: str, _paths: Sequence[str]) -> list[Command]:
    """A checkout that needs no cache: one command that writes the file a harness can look for."""
    return [Command(argv=(sys.executable, '-c', "open('checked-out', 'w')"), timeout_seconds=30, repository_code=False)]


def harness(code: str) -> tuple[str, ...]:
    return (sys.executable, '-c', code)


@pytest.fixture
def aws() -> Iterator[tuple[Any, Any]]:
    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        s3.create_bucket(Bucket=WORKSPACE_BUCKET)
        # voc-engineering's shape (lib/stacks/core-stack.ts): pk/sk strings, no index.
        table = boto3.resource('dynamodb', region_name='us-east-1').create_table(
            TableName=TABLE,
            KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': name, 'AttributeType': 'S'} for name in ('pk', 'sk')],
            BillingMode='PAY_PER_REQUEST',
        )
        yield s3, table


@dataclass
class World:
    supervisor: Supervisor
    runtime: LocalAgentRuntime
    store: SessionStore
    board: FakeBoard
    bus: FakeBus
    control: FakeControl
    sts: FakeSts
    s3: Any
    runs: RunStore

    def launch(self, agent_id: str = 'fixer-1', role: str = 'fixer', code: str = 'pass', now: int = 1000,
               task_id: str = 'task-1', attempt: int = 1) -> AgentSession:
        session = AgentSession(
            run_id='01JD3R4NZXQ7Y2W8K4M6P9T0AB', agent_id=agent_id, role=role, task_id=task_id, language='python', egress=('pypi.org',),
            connection='conn-1', commit=COMMIT, paths=('src',), harness=harness(code), vm_id='', endpoint='',
            started_at=now, last_tick_at=now, task_attempt=attempt)
        vm = self.runtime.run(session.spec())
        self.board.leases[f'01JD3R4NZXQ7Y2W8K4M6P9T0AB/{task_id}'] = Lease(task_id=task_id, agent_id=agent_id, renewed_at=now,
                                                     last_progress_at=now, attempt=attempt)
        return self.store.create(replace(session, vm_id=vm.vm_id, endpoint=vm.endpoint))

    def session(self, agent_id: str = 'fixer-1') -> AgentSession:
        found = self.store.get('01JD3R4NZXQ7Y2W8K4M6P9T0AB', agent_id)
        assert found is not None
        return found

    def renew(self, now: int, progress: bool = True, task_id: str = 'task-1', agent_id: str = 'fixer-1') -> None:
        lease = self.board.leases[f'01JD3R4NZXQ7Y2W8K4M6P9T0AB/{task_id}']
        self.board.leases[f'01JD3R4NZXQ7Y2W8K4M6P9T0AB/{task_id}'] = Lease(
            task_id=task_id, agent_id=agent_id, renewed_at=now,
            last_progress_at=now if progress else lease.last_progress_at, attempt=lease.attempt)


@pytest.fixture
def world(aws: tuple[Any, Any]) -> World:
    s3, table = aws
    runs = RunStore(table)
    runs.start(RUN, caps=RunCaps(max_tasks=50), now=0)
    runtime, store, sts = LocalAgentRuntime(), SessionStore(table, runs), FakeSts()
    board, bus, control = FakeBoard(), FakeBus(), FakeControl()
    supervisor = Supervisor(runtime=runtime, sessions=store, board=board, bus=bus, control=control,
                            launcher=Launcher(sts, ROLE_ARNS), checkpoints=CheckpointReader(s3, BUCKET),
                            bucket=BUCKET, workspace_bucket=BUCKET, timings=Timings(), checkout=quick_checkout)
    return World(supervisor, runtime, store, board, bus, control, sts, s3, runs)
