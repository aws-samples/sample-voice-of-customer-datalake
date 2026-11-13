"""``AgentRuntime`` on Amazon Bedrock AgentCore Runtime (platform version V2), through boto3.

One session per agent: each is its own microVM (2 vCPU and 8 GB by default; the roles that build and test run on
their language's build runtime, whose resource configuration bursts to 8 vCPU and 32 GB), billed per second for the
CPU it uses and its memory, at most 8 hours (the runtime's ``maxLifetime``; continuation past it is the
supervisor's), ended by the service after an hour with no work (``idleRuntimeSessionTimeout``; the runner says it is
busy while its agent works, so an agent waiting on the model is never ended for that).

- ``run``: ``InvokeAgentRuntime`` on the agent's language's runtime with a ``runtimeSessionId`` of its own (one per
  agent and continuation, never reused), whose payload is the runner's ``start``: the agent's ids and its egress
  allowlist. The session exists from that call on.
- ``hand_session``, ``status``, ``suspend``, ``resume``: the runner's other ops, invocations of the same session
  (``unit_runner.Runner.invoke``: its role session, its report, hold and wake).
- ``start_exec``, ``poll_exec``: ``InvokeAgentRuntimeCommand``, each call bounded (``COMMAND_SECONDS``, under the
  API's 3,600): the runner's own ``client`` starts the command as a job of the runner and later calls read it, so a
  checkout or a harness of any length up to the session's life is never held inside one call.
- ``terminate``: ``StopRuntimeSession`` (one already gone is not an error).

Not yet run against AWS: the operation and request field names are botocore's model of ``bedrock-agentcore`` (1.44)
and the developer guide; the answers' shapes (the runner's JSON in ``response``, the command's event stream of
``chunk`` events with ``contentDelta`` and ``contentStop``) are pinned by the tests' fake client only. Check them with
a real call before the first deployment with ``-c engineeringAgents=true``. A session has no AWS role of the run's
here: its runtime's execution role reads only its image and writes its logs, and the launcher (``launcher.py``) hands
its agent user a 15-minute session of the agent role through ``hand_session``. The runner's answers are scrubbed again
here: the session runs untrusted code.
"""
from __future__ import annotations

import base64
import json
import secrets
from collections.abc import Callable, Iterable, Mapping
from typing import Any, Final, Protocol

from botocore.exceptions import ClientError

from engineering.runtime import egress
from engineering.runtime.interface import (
    AgentSpec,
    AgentStatus,
    CacheMount,
    Command,
    ExecResult,
    HandedSession,
    RuntimeRefused,
    RuntimeSession,
    SessionsFull,
)
from engineering.runtime.unit_runner import TAIL_CHARACTERS, bounded_status, scrub_text
from shared.logging import logger

#: The runtime's endpoint every session is invoked on.
QUALIFIER: Final = 'DEFAULT'
#: One command call of the runner's ``client`` (InvokeAgentRuntimeCommand takes 1 to 3,600 seconds): it starts or
#: reads a job, in seconds.
COMMAND_SECONDS: Final = 60
#: The runner's client inside every image (root-owned /opt/voc), and the one shell string the command API runs: a fixed
#: argv and one base64 argument, so nothing anyone wrote is ever read by a shell.
RUNNER_CLIENT: Final = '/usr/bin/python3 -I /opt/voc/unit_runner.py client'
#: The most bytes read back from one invocation or command call.
MAX_ANSWER_BYTES: Final = 256 * 1024
#: The runtime sizes: every role's own, and the build size of the roles that build and test (``runtimes``' keys).
STANDARD: Final = 'standard'
BUILD: Final = 'build'
#: Gone already: ending it again is not an error.
_GONE: Final = frozenset({'ResourceNotFoundException'})
#: No room for a new session: the account's quota of active sessions, or the service's throttle.
_FULL: Final = frozenset({'ServiceQuotaExceededException', 'ThrottlingException'})


class AgentCoreClient(Protocol):
    """The ``bedrock-agentcore`` operations this runtime calls (boto3's client)."""

    def invoke_agent_runtime(self, **kwargs: Any) -> Mapping[str, Any]:
        ...

    def invoke_agent_runtime_command(self, **kwargs: Any) -> Mapping[str, Any]:
        ...

    def stop_runtime_session(self, **kwargs: Any) -> Mapping[str, Any]:
        ...


def _read(body: object) -> bytes:
    """An answer's body: a streaming body (read, bounded) or bytes."""
    read = getattr(body, 'read', None)
    data = read(MAX_ANSWER_BYTES + 1) if callable(read) else body
    if not isinstance(data, bytes | bytearray) or len(data) > MAX_ANSWER_BYTES:
        raise RuntimeRefused('the session answered something other than a short body')
    return bytes(data)


def _tail(answer: Mapping[str, Any], key: str) -> str:
    return scrub_text(str(answer.get(key, '')))[-TAIL_CHARACTERS:]


def session_id(spec: AgentSpec, nonce: str) -> str:
    """A new session's ``runtimeSessionId`` (33 to 256 characters): the run, the agent and a fresh nonce, so no two
    sessions (a continuation included) share one."""
    return f'voc-{spec.run_id}-{spec.agent_id}-{nonce}'


class AgentCoreRuntime:
    """AgentCore Runtime: one session per agent, on its language's runtime (``runtimes``:
    ``{language: {"standard": arn, "build": arn?}}``); the ``build_roles`` run on the build runtime when there is
    one."""

    def __init__(self, client: AgentCoreClient, runtimes: Mapping[str, Mapping[str, str]], *, region: str,
                 build_roles: Iterable[str] = (), nonce: Callable[[], str] = lambda: secrets.token_hex(8)) -> None:
        self._client = client
        self._runtimes = {language: dict(sizes) for language, sizes in runtimes.items()}
        self._region = region
        self._build_roles = frozenset(build_roles)
        self._nonce = nonce

    def runtime_arn(self, spec: AgentSpec) -> str:
        """The runtime ``spec``'s agent runs on: its language's, at its role's size."""
        sizes = self._runtimes.get(spec.language) or {}
        arn = sizes.get(BUILD) if spec.role in self._build_roles and BUILD in sizes else sizes.get(STANDARD)
        if not arn:
            raise RuntimeRefused(f'no agent runtime is configured for {spec.language!r}')
        return arn

    def _invoke(self, vm: RuntimeSession, payload: Mapping[str, Any]) -> dict[str, Any]:
        answer = self._client.invoke_agent_runtime(
            agentRuntimeArn=vm.endpoint, runtimeSessionId=vm.vm_id, qualifier=QUALIFIER,
            contentType='application/json', accept='application/json', payload=json.dumps(payload).encode())
        status = answer.get('statusCode', 200)
        if status != 200:
            raise RuntimeRefused(f'the session answered {status}')
        try:
            body = json.loads(_read(answer.get('response', b'')))
        except ValueError as error:
            raise RuntimeRefused('the session answered something other than JSON') from error
        if not isinstance(body, dict):
            raise RuntimeRefused('the session answered something other than a JSON object')
        return body

    def run(self, spec: AgentSpec) -> RuntimeSession:
        vm = RuntimeSession(vm_id=session_id(spec, self._nonce()), agent_id=spec.agent_id, endpoint=self.runtime_arn(spec))
        # The harness's region (its Bedrock and S3 clients): the runtime's own.
        # The agent's hosts and the dependency step's, each held by a proxy of its own in the session.
        agent_hosts, code_hosts = egress.split(spec.egress)
        start = {'op': 'start', 'environment': {**spec.environment(), 'AWS_REGION': self._region},
                 'egress': list(agent_hosts), 'code_egress': list(code_hosts)}
        try:
            started = self._invoke(vm, start).get('started') is True
        except ClientError as error:
            # The account's active sessions are at the service's quota, or it throttles new ones: nothing started.
            if error.response.get('Error', {}).get('Code') in _FULL:
                raise SessionsFull('AgentCore has no room for a new session now (the account\'s active sessions are '
                                   'at their quota, or the service throttles new ones): the agent starts once one '
                                   'ends') from error
            self._stop_unstarted(vm)
            raise
        except Exception:
            # Any other failure of the start (the runner's refusal, its firewall's included; a broken answer; a lost
            # connection): the session may exist without its agent. Ended now, never left to its idle timeout.
            self._stop_unstarted(vm)
            raise
        if not started:
            self._stop_unstarted(vm)
            raise RuntimeRefused('the agent\'s session did not start')
        return vm

    def _stop_unstarted(self, vm: RuntimeSession) -> None:
        """End a session whose start failed. A failed end is logged and the start's own failure still raised (the
        board answers it as a refusal)."""
        try:
            self.terminate(vm)
        except Exception:   # any failure of the end call: the start's failure is what the caller needs
            logger.exception('runtime: a session that did not start could not be ended', extra={'vm_id': vm.vm_id})

    def suspend(self, vm: RuntimeSession) -> None:
        self._invoke(vm, {'op': 'hold'})

    def resume(self, vm: RuntimeSession) -> None:
        self._invoke(vm, {'op': 'wake'})

    def terminate(self, vm: RuntimeSession) -> None:
        try:
            self._client.stop_runtime_session(agentRuntimeArn=vm.endpoint, runtimeSessionId=vm.vm_id,
                                              qualifier=QUALIFIER)
        except ClientError as error:
            if error.response.get('Error', {}).get('Code') not in _GONE:
                raise

    def _command(self, vm: RuntimeSession, verb: str, body: Mapping[str, Any]) -> dict[str, Any]:
        """One call of the runner's client through the command API: its JSON answer, or ``RuntimeRefused`` with its
        scrubbed reason."""
        encoded = base64.urlsafe_b64encode(json.dumps(body).encode()).decode('ascii')
        answer = self._client.invoke_agent_runtime_command(
            agentRuntimeArn=vm.endpoint, runtimeSessionId=vm.vm_id, qualifier=QUALIFIER,
            contentType='application/json', accept='application/vnd.amazon.eventstream',
            body={'command': f'{RUNNER_CLIENT} {verb} {encoded}', 'timeout': COMMAND_SECONDS})
        stdout, stderr, exit_code = '', '', None
        for event in answer.get('stream') or ():
            chunk = event.get('chunk') or {}
            delta = chunk.get('contentDelta') or {}
            stdout += str(delta.get('stdout') or '')
            stderr += str(delta.get('stderr') or '')
            if len(stdout) + len(stderr) > MAX_ANSWER_BYTES:
                raise RuntimeRefused('the session\'s command answered too much')
            stop = chunk.get('contentStop')
            if stop is not None:
                exit_code = stop.get('exitCode')
        if exit_code != 0:
            raise RuntimeRefused(f'the runner refused it: {scrub_text(stderr.strip())[-300:] or exit_code}')
        try:
            result = json.loads(stdout)
        except ValueError as error:
            raise RuntimeRefused('the runner answered something other than JSON') from error
        if not isinstance(result, dict):
            raise RuntimeRefused('the runner answered something other than a JSON object')
        return result

    def start_exec(self, vm: RuntimeSession, command: Command) -> str:
        exec_id = self._command(vm, 'start', command.to_body()).get('exec_id')
        if not isinstance(exec_id, str) or not exec_id.isalnum():
            raise RuntimeRefused('the runner answered no exec id')
        return exec_id

    def poll_exec(self, vm: RuntimeSession, exec_id: str) -> ExecResult | None:
        if not exec_id.isalnum():
            raise RuntimeRefused('an exec id is letters and digits only')
        answer = self._command(vm, 'poll', {'exec_id': exec_id})
        if answer.get('state') == 'running':
            return None
        return ExecResult(
            exit_code=int(answer.get('exit_code', 1)),
            stdout_tail=_tail(answer, 'stdout_tail'),
            stderr_tail=_tail(answer, 'stderr_tail'),
            duration_seconds=float(answer.get('duration_seconds', 0.0)),
            timed_out=bool(answer.get('timed_out', False)),
        )

    def hand_session(self, vm: RuntimeSession, session: HandedSession, mount: CacheMount | None) -> None:
        body: dict[str, Any] = session.process_credentials()
        if mount is not None:
            body['mount'] = {'bucket': mount.bucket, 'prefix': mount.prefix}
        if self._invoke(vm, {'op': 'session', 'session': body}).get('kept') is not True:
            raise RuntimeRefused('the runner did not keep the agent\'s session')

    def status(self, vm: RuntimeSession) -> AgentStatus:
        report = bounded_status(self._invoke(vm, {'op': 'status'}))
        return AgentStatus(step=report['step'], recent_tools=tuple(report['recent_tools']), tokens=report['tokens'])


def runtimes_from(raw: str | None) -> dict[str, dict[str, str]]:
    """``ENGINEERING_AGENT_RUNTIMES``: ``{language: {"standard": arn, "build"?: arn}}`` (the stack's; ``{}``: none,
    every launch refused)."""
    value = json.loads(raw or '{}')
    if not isinstance(value, dict) or not all(
            isinstance(sizes, dict) and STANDARD in sizes and set(sizes) <= {STANDARD, BUILD}
            and all(isinstance(arn, str) and arn for arn in sizes.values()) for sizes in value.values()):
        raise RuntimeRefused('ENGINEERING_AGENT_RUNTIMES maps each language to its standard (and build) runtime ARN')
    return {str(language): {str(size): str(arn) for size, arn in sizes.items()} for language, sizes in value.items()}
