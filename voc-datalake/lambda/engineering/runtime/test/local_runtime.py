"""The local fake of ``MicroVmRuntime``, for tests: a MicroVM is a temporary directory and a ``unit_runner.Runner``.

It keeps the real runtime's rules so a flow proven here holds there: the same runner (the dependency step
first, output scrubbed, the session kept for the agent user only, the harness's status bounded), a suspended
MicroVM runs nothing, a terminated one is gone (its directory removed), tokens last at most 60 minutes. It
does NOT sandbox: commands run as the calling user, with network, and nothing is mounted, so it lives with the
tests and no deployed code can reach it.
"""
from __future__ import annotations

import os
import secrets
import shutil
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from engineering.runtime.interface import (
    AgentSpec,
    AgentStatus,
    CacheMount,
    Command,
    ExecResult,
    HandedSession,
    MicroVm,
    RuntimeRefused,
)
from engineering.runtime.tokens import MAX_TOKEN_SECONDS, AuthToken
from engineering.runtime.unit_runner import Runner


@dataclass
class _LocalVm:
    root: str
    runner: Runner
    state: Literal['running', 'suspended', 'terminated'] = 'running'


class LocalMicroVmRuntime:
    """``MicroVmRuntime`` on this machine."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._vms: dict[str, _LocalVm] = {}
        self._clock = clock

    def _vm(self, vm: MicroVm) -> _LocalVm:
        local = self._vms.get(vm.vm_id)
        if local is None:
            raise RuntimeRefused(f'unknown MicroVM {vm.vm_id}')
        return local

    def _running(self, vm: MicroVm) -> _LocalVm:
        local = self._vm(vm)
        if local.state != 'running':
            raise RuntimeRefused(f'MicroVM {vm.vm_id} is {local.state}')
        return local

    def run(self, spec: AgentSpec) -> MicroVm:
        root = tempfile.mkdtemp(prefix=f'voc-agent-{spec.agent_id}-')
        for part in ('work', 'logs', 'home', 'secrets'):
            os.mkdir(os.path.join(root, part))
        vm_id = f'local-{secrets.token_hex(8)}'
        runner = Runner(os.path.join(root, 'work'), sandbox=False, secrets_dir=os.path.join(root, 'secrets'),
                        agent_home=os.path.join(root, 'home'), logs_root=os.path.join(root, 'logs'))
        self._vms[vm_id] = _LocalVm(root=root, runner=runner)
        return MicroVm(vm_id=vm_id, agent_id=spec.agent_id, endpoint=runner.workdir)

    def suspend(self, vm: MicroVm) -> None:
        self._running(vm).state = 'suspended'

    def resume(self, vm: MicroVm) -> None:
        local = self._vm(vm)
        if local.state != 'suspended':
            raise RuntimeRefused(f'MicroVM {vm.vm_id} is {local.state}, not suspended')
        local.state = 'running'

    def terminate(self, vm: MicroVm) -> None:
        local = self._vm(vm)
        if local.state == 'terminated':
            return
        local.runner.kill_all()
        local.state = 'terminated'
        shutil.rmtree(local.root, ignore_errors=True)

    def start_exec(self, vm: MicroVm, command: Command) -> str:
        try:
            return self._running(vm).runner.start(command.to_body())
        except (ValueError, OSError) as error:
            raise RuntimeRefused(f'the command could not start: {error}') from error

    def poll_exec(self, vm: MicroVm, exec_id: str) -> ExecResult | None:
        try:
            result = self._running(vm).runner.poll(exec_id)
        except KeyError as error:
            raise RuntimeRefused(f'unknown exec {exec_id}') from error
        return None if result is None else ExecResult(**result)

    def mint_token(self, vm: MicroVm) -> AuthToken:
        self._running(vm)
        return AuthToken(value=secrets.token_urlsafe(32), expires_at=self._clock() + MAX_TOKEN_SECONDS)

    def hand_session(self, vm: MicroVm, session: HandedSession, mount: CacheMount | None) -> None:
        body = session.process_credentials()
        if mount is not None:
            body['mount'] = {'bucket': mount.bucket, 'prefix': mount.prefix}
        self._running(vm).runner.keep_session(body)

    def status(self, vm: MicroVm) -> AgentStatus:
        report = self._running(vm).runner.status()
        return AgentStatus(step=report['step'], recent_tools=tuple(report['recent_tools']), tokens=report['tokens'])
