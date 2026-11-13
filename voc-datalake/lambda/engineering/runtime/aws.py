"""``MicroVmRuntime`` on Lambda MicroVMs, through boto3.

Not yet run against AWS: the operation and field names below follow the service's description in
docs/autonomous-engineering.md → Runtime (RunMicrovm with an idle policy, suspend / resume / terminate, CreateMicrovmAuthToken of at
most 60 minutes) and are pinned by the tests' fake client only. Check them against the service's API
reference before the first deployment with ``-c engineeringAgents=true``. A MicroVM gets no execution
role here: the launcher (``launcher.py``) hands its agent user a 15-minute session of the agent role
through ``hand_session``.

Commands reach the agent's runner (``unit_runner.py``, the images' entry point) on the MicroVM's HTTPS
endpoint, with a token from ``TokenSource``: minted when needed, refreshed before it lapses, never
written anywhere. The runner's answers are scrubbed again here: the MicroVM runs untrusted code.
"""
from __future__ import annotations

import json
import urllib.request
from collections.abc import Callable, Mapping
from typing import Any, Final, Protocol
from urllib.parse import urlsplit

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
from engineering.runtime.tokens import MAX_TOKEN_SECONDS, AuthToken, TokenSource, bounded_expiry
from engineering.runtime.unit_runner import TAIL_CHARACTERS, bounded_status, scrub_text
from shared.logging import logger

#: Idle policy: a MicroVM with no request for this long is suspended (an agent waiting for a message),
#: and one suspended this long is ended. The supervisor ends a finished agent's MicroVM at once anyway.
IDLE_SUSPEND_SECONDS: Final = 5 * 60
IDLE_TERMINATE_SECONDS: Final = 60 * 60
HTTP_TIMEOUT_SECONDS: Final = 20
#: vCPU and memory of an agent's MicroVM (the plan: up to 16 vCPU / 32 GB).
DEFAULT_VCPUS: Final = 4
DEFAULT_MEMORY_MB: Final = 8192


class MicroVmClient(Protocol):
    """The boto3 operations this runtime calls, and the client's region (``meta.region_name``)."""

    meta: Any

    def run_microvm(self, **kwargs: Any) -> Mapping[str, Any]:
        ...

    def suspend_microvm(self, **kwargs: Any) -> Mapping[str, Any]:
        ...

    def resume_microvm(self, **kwargs: Any) -> Mapping[str, Any]:
        ...

    def terminate_microvm(self, **kwargs: Any) -> Mapping[str, Any]:
        ...

    def create_microvm_auth_token(self, **kwargs: Any) -> Mapping[str, Any]:
        ...


Transport = Callable[[urllib.request.Request], Mapping[str, Any]]


def https_json(request: urllib.request.Request) -> Mapping[str, Any]:
    """Send ``request`` (HTTPS only: ``AwsMicroVmRuntime`` checks the endpoint) and read its JSON answer."""
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
        answer = json.loads(response.read())
    if not isinstance(answer, dict):
        raise RuntimeRefused('the runner answered something other than a JSON object')
    return answer


def _https_endpoint(endpoint: object) -> str:
    if not isinstance(endpoint, str):
        raise RuntimeRefused('the MicroVM answered no endpoint')
    parts = urlsplit(endpoint)
    if parts.scheme != 'https' or not parts.hostname or parts.query or parts.fragment:
        raise RuntimeRefused('the MicroVM endpoint is not a plain https:// URL')
    return endpoint.rstrip('/')


def _tail(answer: Mapping[str, Any], key: str) -> str:
    return scrub_text(str(answer.get(key, '')))[-TAIL_CHARACTERS:]


class AwsMicroVmRuntime:
    """Lambda MicroVMs: one per agent session, from the agent's language image."""

    def __init__(
        self, client: MicroVmClient, image_arns: Mapping[str, str], *, transport: Transport = https_json,
    ) -> None:
        self._client = client
        self._images = dict(image_arns)
        self._transport = transport
        self._tokens: dict[str, TokenSource] = {}

    def run(self, spec: AgentSpec) -> MicroVm:
        image = self._images.get(spec.language)
        if image is None:
            raise RuntimeRefused(f'no MicroVM image is configured for {spec.language!r}')
        answer = self._client.run_microvm(
            ImageArn=image,
            VCpus=DEFAULT_VCPUS,
            MemoryMb=DEFAULT_MEMORY_MB,
            IdlePolicy={'SuspendAfterSeconds': IDLE_SUSPEND_SECONDS,
                        'TerminateAfterSeconds': IDLE_TERMINATE_SECONDS},
            EgressAllowlist=list(spec.egress),
            # The harness's region (its Bedrock and S3 clients): the runtime's own.
            Environment={**spec.environment(), 'AWS_REGION': str(self._client.meta.region_name)},
            Tags={'voc:run_id': spec.run_id, 'voc:agent_id': spec.agent_id, 'voc:task_id': spec.task_id},
        )
        vm_id = answer.get('MicrovmId')
        if not isinstance(vm_id, str) or not vm_id:
            raise RuntimeRefused('the MicroVM service answered no MicrovmId')
        try:
            endpoint = _https_endpoint(answer.get('Endpoint'))
        except RuntimeRefused:
            # Started but unusable: ended now, never left to run until its idle policy with nothing supervising it.
            # A failed terminate is logged and the refusal still raised (the board answers it as a refusal).
            try:
                self._client.terminate_microvm(MicrovmId=vm_id)
            except Exception:   # any failure of the end call: the refusal is what the caller needs
                logger.exception('runtime: an unusable MicroVM could not be terminated', extra={'vm_id': vm_id})
            raise
        return MicroVm(vm_id=vm_id, agent_id=spec.agent_id, endpoint=endpoint)

    def suspend(self, vm: MicroVm) -> None:
        self._client.suspend_microvm(MicrovmId=vm.vm_id)

    def resume(self, vm: MicroVm) -> None:
        self._client.resume_microvm(MicrovmId=vm.vm_id)

    def terminate(self, vm: MicroVm) -> None:
        self._tokens.pop(vm.vm_id, None)
        self._client.terminate_microvm(MicrovmId=vm.vm_id)

    def mint_token(self, vm: MicroVm) -> AuthToken:
        answer = self._client.create_microvm_auth_token(MicrovmId=vm.vm_id, DurationSeconds=MAX_TOKEN_SECONDS)
        value, issued, expires = answer.get('Token'), answer.get('IssuedAt'), answer.get('ExpiresAt')
        if not isinstance(value, str) or not isinstance(issued, int | float) or not isinstance(expires, int | float):
            raise RuntimeRefused('the MicroVM service answered no usable auth token')
        return AuthToken(value=value, expires_at=bounded_expiry(float(issued), float(expires)))

    def _call(self, vm: MicroVm, method: str, path: str, body: Mapping[str, Any] | None = None) -> Mapping[str, Any]:
        source = self._tokens.setdefault(vm.vm_id, TokenSource(lambda: self.mint_token(vm)))
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(
            f'{_https_endpoint(vm.endpoint)}{path}', data=data, method=method,
            headers={'Authorization': f'Bearer {source.current().value}', 'Content-Type': 'application/json'})
        return self._transport(request)

    def start_exec(self, vm: MicroVm, command: Command) -> str:
        answer = self._call(vm, 'POST', '/exec', command.to_body())
        exec_id = answer.get('exec_id')
        if not isinstance(exec_id, str) or not exec_id.isalnum():
            raise RuntimeRefused('the runner answered no exec id')
        return exec_id

    def poll_exec(self, vm: MicroVm, exec_id: str) -> ExecResult | None:
        if not exec_id.isalnum():
            raise RuntimeRefused('an exec id is letters and digits only')
        answer = self._call(vm, 'GET', f'/exec/{exec_id}')
        if answer.get('state') == 'running':
            return None
        return ExecResult(
            exit_code=int(answer.get('exit_code', 1)),
            stdout_tail=_tail(answer, 'stdout_tail'),
            stderr_tail=_tail(answer, 'stderr_tail'),
            duration_seconds=float(answer.get('duration_seconds', 0.0)),
            timed_out=bool(answer.get('timed_out', False)),
        )

    def hand_session(self, vm: MicroVm, session: HandedSession, mount: CacheMount | None) -> None:
        body: dict[str, Any] = session.process_credentials()
        if mount is not None:
            body['mount'] = {'bucket': mount.bucket, 'prefix': mount.prefix}
        self._call(vm, 'POST', '/session', body)

    def status(self, vm: MicroVm) -> AgentStatus:
        report = bounded_status(dict(self._call(vm, 'GET', '/status')))
        return AgentStatus(step=report['step'], recent_tools=tuple(report['recent_tools']), tokens=report['tokens'])
