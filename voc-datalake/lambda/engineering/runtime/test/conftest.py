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
from engineering.runtime.ports import Budget, Lease
from engineering.runtime.sessions import AgentSession, SessionStore
from engineering.runtime.supervisor import Supervisor
from engineering.runtime.test.local_runtime import LocalMicroVmRuntime

BUCKET = 'voc-raw-test'
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

    def lease(self, run_id: str, task_id: str) -> Lease | None:
        return self.leases.get(f'{run_id}/{task_id}')

    def repost(self, run_id: str, task_id: str, reason: str) -> None:
        self.reposted.append((f'{run_id}/{task_id}', reason))


@dataclass
class FakeBus:
    events: list[dict[str, Any]] = field(default_factory=list)
    depths: dict[str, int] = field(default_factory=dict)

    def emit(self, run_id: str, to: str, kind: str, summary: str, refs: Mapping[str, str] | None = None) -> None:
        self.events.append({'run_id': run_id, 'to': to, 'kind': kind, 'summary': summary, 'refs': dict(refs or {})})

    def inbox_depth(self, run_id: str, agent_id: str) -> int:
        return self.depths.get(f'{run_id}/{agent_id}', 0)

    def kinds(self) -> list[str]:
        return [event['kind'] for event in self.events if event['kind'] != 'run.health']


@dataclass
class FakeControl:
    spend: Budget = field(default_factory=lambda: Budget(tokens=0, cost_usd=0.0, max_tokens=None, max_cost_usd=None))
    stops: set[str] = field(default_factory=set)
    humans: list[tuple[str, str]] = field(default_factory=list)
    started: int = 0

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
        table = boto3.resource('dynamodb', region_name='us-east-1').create_table(
            TableName='voc-agents-test',
            KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': name, 'AttributeType': 'S'}
                                  for name in ('pk', 'sk', 'gsi1pk', 'gsi1sk')],
            GlobalSecondaryIndexes=[{
                'IndexName': 'gsi1-by-agents-listing',
                'KeySchema': [{'AttributeName': 'gsi1pk', 'KeyType': 'HASH'},
                              {'AttributeName': 'gsi1sk', 'KeyType': 'RANGE'}],
                'Projection': {'ProjectionType': 'KEYS_ONLY'},
            }],
            BillingMode='PAY_PER_REQUEST',
        )
        yield s3, table


@dataclass
class World:
    supervisor: Supervisor
    runtime: LocalMicroVmRuntime
    store: SessionStore
    board: FakeBoard
    bus: FakeBus
    control: FakeControl
    sts: FakeSts
    s3: Any

    def launch(self, agent_id: str = 'fixer-1', role: str = 'fixer', code: str = 'pass', now: int = 1000,
               task_id: str = 'task-1') -> AgentSession:
        session = AgentSession(
            run_id='01JD3R4NZXQ7Y2W8K4M6P9T0AB', agent_id=agent_id, role=role, task_id=task_id, language='python', egress=('pypi.org',),
            connection='conn-1', commit=COMMIT, paths=('src',), harness=harness(code), vm_id='', endpoint='',
            started_at=now, last_tick_at=now)
        vm = self.runtime.run(session.spec())
        self.board.leases[f'01JD3R4NZXQ7Y2W8K4M6P9T0AB/{task_id}'] = Lease(task_id=task_id, agent_id=agent_id, renewed_at=now,
                                                     last_progress_at=now)
        return self.store.create(replace(session, vm_id=vm.vm_id, endpoint=vm.endpoint))

    def session(self, agent_id: str = 'fixer-1') -> AgentSession:
        found = self.store.get('01JD3R4NZXQ7Y2W8K4M6P9T0AB', agent_id)
        assert found is not None
        return found

    def renew(self, now: int, progress: bool = True, task_id: str = 'task-1', agent_id: str = 'fixer-1') -> None:
        lease = self.board.leases[f'01JD3R4NZXQ7Y2W8K4M6P9T0AB/{task_id}']
        self.board.leases[f'01JD3R4NZXQ7Y2W8K4M6P9T0AB/{task_id}'] = Lease(
            task_id=task_id, agent_id=agent_id, renewed_at=now,
            last_progress_at=now if progress else lease.last_progress_at)


@pytest.fixture
def world(aws: tuple[Any, Any]) -> World:
    s3, table = aws
    runtime, store, sts = LocalMicroVmRuntime(), SessionStore(table), FakeSts()
    board, bus, control = FakeBoard(), FakeBus(), FakeControl()
    supervisor = Supervisor(runtime=runtime, sessions=store, board=board, bus=bus, control=control,
                            launcher=Launcher(sts, ROLE_ARNS), checkpoints=CheckpointReader(s3, BUCKET),
                            bucket=BUCKET, timings=Timings(), checkout=quick_checkout)
    return World(supervisor, runtime, store, board, bus, control, sts, s3)
