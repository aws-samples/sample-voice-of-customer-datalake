"""The local fake and the runner: commands in the agent's directory, scrubbed output, the sandbox argv."""
import base64
import json
import os
import socket
import stat
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from datetime import UTC, datetime

import pytest

from engineering.runtime import egress, unit_runner
from engineering.runtime.interface import AgentSpec, Command, ExecResult, RuntimeRefused, RuntimeSession
from engineering.runtime.test.local_runtime import LocalAgentRuntime
from engineering.runtime.unit_runner import (
    CODE_PROXY_ENV,
    MASK,
    PROXY_ENV,
    SESSION_LAPSE_GRACE,
    Api,
    CommandJob,
    EgressProxy,
    Runner,
    client,
    command_env,
    main,
    sandboxed_argv,
    scrub_text,
    serve,
)


def https_json(request: urllib.request.Request) -> dict:
    """One call of the runner's loopback API (never a proxy), its JSON answer."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=20) as answer:
        return json.loads(answer.read())

SPEC = AgentSpec(run_id='01JD3R4NZXQ7Y2W8K4M6P9T0AB', agent_id='fixer-1', role='fixer', task_id='task-1', language='python',
                 egress=('pypi.org',), connection='repo-1')


def _py(code: str, timeout: int = 30) -> Command:
    return Command(argv=(sys.executable, '-c', code), timeout_seconds=timeout)


def _wait(runtime: LocalAgentRuntime, vm: RuntimeSession, exec_id: str) -> ExecResult:
    for _ in range(200):
        result = runtime.poll_exec(vm, exec_id)
        if result is not None:
            return result
        time.sleep(0.05)
    raise AssertionError('the command did not finish')


def test_a_command_runs_in_the_agents_own_directory_and_reports_its_tails():
    runtime = LocalAgentRuntime()
    vm = runtime.run(SPEC)
    code = "import os, sys; open('made.txt', 'w').write('x'); print(os.getcwd()); sys.exit(3)"
    result = _wait(runtime, vm, runtime.start_exec(vm, _py(code)))
    assert (result.exit_code, result.ok) == (3, False)
    assert result.stdout_tail.strip() == os.path.realpath(vm.endpoint)
    assert os.path.exists(os.path.join(vm.endpoint, 'made.txt'))


def test_credentials_in_tool_output_are_masked():
    runtime = LocalAgentRuntime()
    vm = runtime.run(SPEC)
    leak = "print('key AKIA' + 'ABCDEFGHIJKLMNOP' + ' and GITHUB_TOKEN=ghp_' + 'a' * 36)"
    result = _wait(runtime, vm, runtime.start_exec(vm, _py(leak)))
    assert 'ABCDEFGHIJKLMNOP' not in result.stdout_tail
    assert 'ghp_' not in result.stdout_tail
    assert MASK in result.stdout_tail


def test_scrub_text_masks_the_credential_process_json():
    scrubbed = scrub_text('{"SecretAccessKey": "not-a-real-secret-value", "SessionToken": "not-a-real-session"}')
    assert 'not-a-real' not in scrubbed


@pytest.mark.parametrize(('text', 'kept'), [
    ('Authorization: Bearer abcdefghijklmnopqrstuvwxyz', 'Authorization:'),
    ('-----BEGIN RSA ' + 'PRIVATE KEY-----\nMIIE\n-----END RSA ' + 'PRIVATE KEY-----', ''),
    ('db_password = not-a-real-one', 'db_password='),
    ('token glpat-' + 'abcdefghijklmnopqrstuvwx here', 'here'),
], ids=['bearer', 'private-key', 'named-secret', 'gitlab'])
def test_scrub_text_masks_each_credential_shape(text, kept):
    scrubbed = scrub_text(text)
    assert MASK in scrubbed
    assert kept in scrubbed


def test_scrub_text_leaves_plain_output_alone():
    assert scrub_text('3 passed, 0 failed in 1.2s') == '3 passed, 0 failed in 1.2s'


def test_repository_code_runs_as_code_in_its_own_pid_and_network_namespaces_with_its_own_loopback():
    boxed = sandboxed_argv(['make'], repository_code=True, network=False)
    assert boxed[:7] == ['/usr/bin/unshare', '--pid', '--fork', '--kill-child', '--mount-proc', '--net', '--']
    # root brings the new namespace's loopback up, then drops to `code`; the command is only positional arguments.
    assert boxed[7:11] == ['/bin/sh', '-c', '/usr/sbin/ip link set lo up && exec "$@"', 'sh']
    assert (boxed[11], boxed[12]) == ('/usr/bin/setpriv', '--reuid=code')
    # setpriv's change of user clears unshare's parent-death signal: it is set again after it.
    assert boxed[-3:] == ['--pdeathsig=KILL', '--', 'make']


def test_the_dependency_step_keeps_the_network_but_not_the_view_of_the_agent():
    step = sandboxed_argv(['npm', 'ci'], repository_code=True, network=True)
    assert step[:6] == ['/usr/bin/unshare', '--pid', '--fork', '--kill-child', '--mount-proc', '--']
    assert '--net' not in step


def test_the_agents_own_commands_run_as_unit_never_as_root_and_root_runs_tools_by_absolute_path():
    own = sandboxed_argv(['git', 'status'], repository_code=False, network=True)
    assert (own[0], own[1], own[-2:]) == ('/usr/bin/setpriv', '--reuid=unit', ['git', 'status'])
    assert all(part.startswith('/') for part in (own[0], *sandboxed_argv(['x'], repository_code=True,
                                                                           network=False)[:1]))


@pytest.mark.parametrize('repository_code', [True, False], ids=['repository-code', 'agent'])
def test_no_command_gains_a_privilege_through_a_setuid_file_or_a_capability(repository_code: bool):
    argv = sandboxed_argv(['make'], repository_code=repository_code, network=False)
    drop = argv[argv.index('/usr/bin/setpriv'):]
    assert {'--no-new-privs', '--bounding-set=-all', '--inh-caps=-all', '--clear-groups'} <= set(drop)


def test_a_command_over_its_timeout_is_killed():
    runtime = LocalAgentRuntime()
    vm = runtime.run(SPEC)
    result = _wait(runtime, vm, runtime.start_exec(vm, _py('import time; time.sleep(30)', timeout=1)))
    assert result.timed_out
    assert not result.ok


def test_a_suspended_vm_runs_nothing_until_resumed():
    runtime = LocalAgentRuntime()
    vm = runtime.run(SPEC)
    runtime.suspend(vm)
    with pytest.raises(RuntimeRefused, match='suspended'):
        runtime.start_exec(vm, _py('pass'))
    runtime.resume(vm)
    assert _wait(runtime, vm, runtime.start_exec(vm, _py('pass'))).ok


def test_resume_refuses_a_running_vm():
    runtime = LocalAgentRuntime()
    with pytest.raises(RuntimeRefused, match='not suspended'):
        runtime.resume(runtime.run(SPEC))


def test_terminate_kills_its_commands_removes_the_directory_and_is_idempotent():
    runtime = LocalAgentRuntime()
    vm = runtime.run(SPEC)
    runtime.start_exec(vm, _py('import time; time.sleep(30)', timeout=60))
    runtime.terminate(vm)
    runtime.terminate(vm)
    assert not os.path.exists(vm.endpoint)
    assert runtime.state_of(vm) == 'terminated'


def test_unknown_vm_exec_and_a_missing_program_are_refused():
    runtime = LocalAgentRuntime()
    vm = runtime.run(SPEC)
    with pytest.raises(RuntimeRefused, match='unknown exec'):
        runtime.poll_exec(vm, 'nope')
    with pytest.raises(RuntimeRefused, match='could not start'):
        runtime.start_exec(vm, Command(argv=('/nonexistent/voc-tool',), timeout_seconds=5))
    with pytest.raises(RuntimeRefused, match='unknown session'):
        runtime.suspend(RuntimeSession(vm_id='other', agent_id='fixer-1', endpoint='nowhere'))


def test_a_session_starts_with_its_agents_ids_and_refuses_to_be_started_for_another(tmp_path):
    runner = _runner(tmp_path)
    assert runner.begin({'environment': SPEC.environment(), 'egress': ['pypi.org']}) == {'started': True}
    # A retried start is answered as before; one for another agent is refused.
    assert runner.begin({'environment': SPEC.environment(), 'egress': ['pypi.org']}) == {'started': True}
    with pytest.raises(ValueError, match='another agent'):
        runner.begin({'environment': {**SPEC.environment(), 'VOC_AGENT_ID': 'fixer-2'}, 'egress': []})
    # Nothing in the session (the agent's own call on loopback included) ever widens its egress.
    with pytest.raises(ValueError, match='another egress allowlist'):
        runner.begin({'environment': SPEC.environment(), 'egress': ['pypi.org', 'example.org']})
    show = [sys.executable, '-c', "import os; print(os.environ.get('VOC_AGENT_ID'))"]
    assert _wait_runner(runner, runner.start({'argv': show, 'timeout_seconds': 10, 'repository_code': False}))[
        'stdout_tail'].strip() == 'fixer-1'


@pytest.mark.parametrize('body', [
    {'environment': {'PATH': '/usr/bin'}, 'egress': []},
    {'environment': {'VOC_RUN_ID': 'x; rm -rf /'}, 'egress': []},
    {'environment': {}, 'egress': ['https://pypi.org/']},
    {'environment': {}, 'egress': 'pypi.org'},
], ids=['not-an-id', 'not-plain', 'not-a-host', 'not-a-list'])
def test_a_start_names_only_the_agents_ids_and_plain_hosts(tmp_path, body: dict):
    with pytest.raises(ValueError, match=r'start|egress'):
        _runner(tmp_path).begin(body)


#: A python agent's allowlist, both users together (egress.egress_allowlist's shape), and its two parts.
BOTH = ('bedrock-runtime.us-east-1.amazonaws.com', 'voc-raw-test.s3.us-east-1.amazonaws.com',
        'abc123def.lambda-url.us-east-1.on.aws', 'pypi.org', 'files.pythonhosted.org', 'mirror.example.org')


def _proxies() -> tuple[EgressProxy, EgressProxy]:
    return EgressProxy(port=0), EgressProxy(port=0)


def _close(*proxies: EgressProxy) -> None:
    for proxy in proxies:
        proxy.server.server_close()


def test_the_image_starts_no_agent_without_the_egress_firewall_and_both_proxies(tmp_path):
    agent_hosts, code_hosts = egress.split(BOTH)
    start = {'environment': SPEC.environment(), 'egress': list(agent_hosts), 'code_egress': list(code_hosts)}
    agent, code = _proxies()
    try:
        pairs: list[tuple[EgressProxy | None, EgressProxy | None]] = [(None, None), (agent, None), (None, code)]
        for own, step in pairs:
            with pytest.raises(ValueError, match='egress allowlist'):
                Runner(str(tmp_path), sandbox=True, secrets_dir=str(tmp_path), agent_home=str(tmp_path),
                       egress_firewall=True, proxy=own, code_proxy=step).begin(start)
        runner = Runner(str(tmp_path), sandbox=True, secrets_dir=str(tmp_path), agent_home=str(tmp_path),
                        egress_firewall=True, proxy=agent, code_proxy=code)
        assert runner.begin(start) == {'started': True}
    finally:
        _close(agent, code)


def _connect(proxy: EgressProxy, host: str) -> bool:
    return proxy.target(f'CONNECT {host}:443 HTTP/1.1\r\n\r\n'.encode()) is not None


def test_the_agent_never_reaches_a_registry_and_repository_code_never_bedrock_a_bucket_or_the_board(tmp_path):
    agent_hosts, code_hosts = egress.split(BOTH)
    assert (agent_hosts, code_hosts) == (
        ('abc123def.lambda-url.us-east-1.on.aws', 'bedrock-runtime.us-east-1.amazonaws.com',
         'voc-raw-test.s3.us-east-1.amazonaws.com'),
        ('files.pythonhosted.org', 'mirror.example.org', 'pypi.org'))
    agent, code = _proxies()
    try:
        runner = Runner(str(tmp_path), sandbox=False, secrets_dir=str(tmp_path), agent_home=str(tmp_path),
                        proxy=agent, code_proxy=code)
        runner.begin({'environment': SPEC.environment(), 'egress': list(agent_hosts), 'code_egress': list(code_hosts)})
        # The agent's proxy: its AWS hosts and the board, no registry; the dependency step's: the reverse.
        assert [_connect(agent, host) for host in BOTH] == [True, True, True, False, False, False]
        assert [_connect(code, host) for host in BOTH] == [False, False, False, True, True, True]
    finally:
        _close(agent, code)


def test_the_agent_and_the_dependency_step_are_each_pointed_at_their_own_proxy_and_other_code_at_none(tmp_path):
    agent, code = _proxies()
    try:
        runner = Runner(str(tmp_path), sandbox=False, secrets_dir=str(tmp_path / 's'), agent_home=str(tmp_path),
                        proxy=agent, code_proxy=code)
        (tmp_path / 's').mkdir()
        show = [sys.executable, '-c', "import os; print(os.environ.get('HTTPS_PROXY'))"]
        own = _wait_runner(runner, runner.start({'argv': show, 'timeout_seconds': 10, 'repository_code': False}))
        step = _wait_runner(runner, runner.start({'argv': show, 'timeout_seconds': 10, 'network': True}))
        other = _wait_runner(runner, runner.start({'argv': show, 'timeout_seconds': 10}))
        assert [own['stdout_tail'].strip(), step['stdout_tail'].strip(), other['stdout_tail'].strip()] == [
            PROXY_ENV['HTTPS_PROXY'], CODE_PROXY_ENV['HTTPS_PROXY'], 'None']
        assert PROXY_ENV['HTTPS_PROXY'] != CODE_PROXY_ENV['HTTPS_PROXY']
    finally:
        _close(agent, code)


@pytest.mark.parametrize(('address', 'reachable'), [
    ('169.254.169.254', False), ('169.254.170.2', False), ('fe80::1', False), ('fe80::1%eth0', False),
    ('127.0.0.1', False), ('::1', False), ('::', False),
    ('::ffff:169.254.169.254', False), ('::ffff:127.0.0.1', False), ('::ffff:0.0.0.0', False),
    ('64:ff9b::169.254.169.254', False), ('64:ff9b::127.0.0.1', False),
    ('fd00:ec2::254', False), ('fd00:ec2::23', False), ('0.1.2.3', False), ('0.255.255.255', False),
    ('::ffff:0.1.2.3', False), ('fd00:ec3::1', True),
    ('::169.254.169.254', False), ('::127.0.0.1', False), ('2002:a9fe:a9fe::1', False), ('2002:7f00:1::1', False),
    ('64:ff9b:1:a9fe:a9:fe00::', False), ('64:ff9b:1:7f00:0:100::', False),
    ('::52.94.1.1', True), ('2002:345e:101::1', True), ('64:ff9b:1:345e:1:100::', True),
    ('10.0.12.34', True), ('52.94.1.1', True), ('2600:1f18::1', True), ('::ffff:52.94.1.1', True),
    ('64:ff9b::52.94.1.1', True),
], ids=['metadata', 'container-credentials', 'link-local-v6', 'scoped-link-local-v6', 'loopback', 'loopback-v6',
        'unspecified', 'mapped-metadata', 'mapped-loopback', 'mapped-unspecified', 'nat64-metadata', 'nat64-loopback',
        'metadata-v6', 'dns-v6', 'this-network', 'this-network-top', 'mapped-this-network', 'near-metadata-v6',
        'compatible-metadata', 'compatible-loopback', '6to4-metadata', '6to4-loopback', 'local-nat64-metadata',
        'local-nat64-loopback', 'compatible-public', '6to4-public', 'local-nat64-public',
        'a-vpc-endpoint', 'public', 'public-v6', 'mapped-public', 'nat64-public'])
def test_a_tunnel_never_reaches_a_link_local_or_loopback_address_whatever_name_resolved_to_it(
        address: str, reachable: bool):
    assert unit_runner.outside(address) is reachable


def test_a_name_that_resolves_only_to_link_local_addresses_is_refused_before_any_connection():
    def resolve(_host: str, port: int, **_kwargs: object) -> list[tuple]:
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('169.254.169.254', port)),
                (socket.AF_INET6, socket.SOCK_STREAM, 6, '', ('fe80::1', port, 0, 2))]

    with pytest.raises(OSError, match='no address a tunnel may reach'):
        unit_runner._connect_outside(('pypi.org', 443), 1, resolve)


def test_a_hold_longer_than_the_role_session_kills_nothing_and_its_lapse_counts_from_the_wake(
        tmp_path, monkeypatch: pytest.MonkeyPatch):
    # In the image's mode (sandbox on), as its watchdog runs it: a 25-minute hold of a 15-minute session.
    monkeypatch.setattr(unit_runner, '_unit_ids', lambda: (os.getuid(), os.getgid()))
    runner = Runner(str(tmp_path), sandbox=True, secrets_dir=str(tmp_path), agent_home=str(tmp_path))
    expires = datetime(2026, 11, 12, 12, 15, tzinfo=UTC).timestamp()
    runner.keep_session({'Version': 1, 'AccessKeyId': 'ASIAFAKE', 'SecretAccessKey': 'fake', 'SessionToken': 'fake',
                         'Expiration': '2026-11-12T12:15:00+00:00'})
    # (from the agent's first session on: what the watchdog would end)
    killed: list[float] = []
    monkeypatch.setattr(runner, 'kill_all', lambda: killed.append(1.0))
    runner.hold()
    for minute in (5, 10, 20, 25):
        assert runner.end_if_lapsed(expires + minute * 60) is False
    woken = expires + 25 * 60
    runner.wake(now=woken)
    # The supervisor hands a fresh session right after the wake: until the grace is out, nothing is ended.
    assert runner.end_if_lapsed(woken + SESSION_LAPSE_GRACE - 1) is False
    assert killed == []
    # Never renewed after the wake: ended then.
    assert runner.end_if_lapsed(woken + SESSION_LAPSE_GRACE) is True


def test_every_command_ends_once_the_role_session_lapses_unrenewed(tmp_path):
    runner = _runner(tmp_path)
    assert runner.end_if_lapsed(10 ** 10) is False   # (no session yet: nothing to lapse)
    runner.keep_session({'Version': 1, 'AccessKeyId': 'ASIAFAKE', 'SecretAccessKey': 'fake', 'SessionToken': 'fake',
                         'Expiration': '2026-11-12T12:15:00+00:00'})
    exec_id = runner.start({'argv': [sys.executable, '-c', 'import time; time.sleep(30)'], 'timeout_seconds': 60,
                            'repository_code': False})
    expires = datetime(2026, 11, 12, 12, 15, tzinfo=UTC).timestamp()
    assert runner.end_if_lapsed(expires + SESSION_LAPSE_GRACE - 1) is False
    assert runner.poll(exec_id) is None
    assert runner.end_if_lapsed(expires + SESSION_LAPSE_GRACE) is True
    assert runner.poll(exec_id) is not None


@pytest.mark.parametrize(('request_line', 'allowed'), [
    (b'CONNECT pypi.org:443 HTTP/1.1', True), (b'CONNECT PyPI.org:443 HTTP/1.1', True),
    (b'CONNECT pypi.org:80 HTTP/1.1', False), (b'CONNECT example.org:443 HTTP/1.1', False),
    (b'GET http://pypi.org/ HTTP/1.1', False), (b'CONNECT 10.0.0.1:443 HTTP/1.1', False),
    (b'CONNECT evil.pypi.org:443 HTTP/1.1', False), (b'CONNECT pypi.org:443', False),
], ids=['allowed', 'any-case', 'other-port', 'other-host', 'not-connect', 'an-address', 'a-subdomain', 'no-version'])
def test_the_proxy_lets_a_tunnel_through_only_to_an_allowlisted_host_on_443(request_line: bytes, allowed: bool):
    proxy = EgressProxy(port=0)
    try:
        assert proxy.target(request_line + b'\r\n\r\n') is None
        proxy.allow(['pypi.org'])
        assert (proxy.target(request_line + b'\r\n\r\n') is not None) is allowed
    finally:
        proxy.server.server_close()


def _echo_server() -> tuple[socket.socket, int]:
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen()

    def echo() -> None:
        connection, _ = listener.accept()
        with connection:
            while data := connection.recv(1024):
                connection.sendall(data.upper())

    threading.Thread(target=echo, daemon=True).start()
    return listener, listener.getsockname()[1]


def _through(proxy: EgressProxy, request: bytes) -> bytes:
    with socket.create_connection(('127.0.0.1', proxy.server.server_address[1]), timeout=5) as connection:
        connection.sendall(request)
        answer = b''
        while b'\r\n\r\n' not in answer:
            chunk = connection.recv(1024)
            if not chunk:
                break
            answer += chunk
        if answer.startswith(b'HTTP/1.1 200'):
            connection.sendall(b'hello')
            answer += connection.recv(1024)
        return answer


def test_the_proxy_relays_an_allowed_tunnel_and_refuses_any_other():
    listener, port = _echo_server()
    reached: list[tuple[str, int]] = []

    def connect(address: tuple[str, int], timeout: float) -> socket.socket:
        reached.append(address)
        return socket.create_connection(('127.0.0.1', port), timeout)

    proxy = EgressProxy(port=0, connect=connect)
    proxy.allow(['registry.npmjs.org'])
    proxy.serve()
    try:
        refused = _through(proxy, b'CONNECT example.org:443 HTTP/1.1\r\nHost: example.org\r\n\r\n')
        assert (refused.startswith(b'HTTP/1.1 403'), reached) == (True, [])
        relayed = _through(proxy, b'CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n')
        assert relayed == b'HTTP/1.1 200 Connection Established\r\n\r\nHELLO'
        assert reached == [('registry.npmjs.org', 443)]
    finally:
        proxy.server.shutdown()
        proxy.server.server_close()
        listener.close()


def test_a_held_agent_uses_no_cpu_until_it_is_woken_and_the_session_says_so_on_ping(tmp_path):
    runner = _runner(tmp_path)
    assert runner.ping()['status'] == 'Healthy'
    counter = tmp_path / 'count'
    code = (f'import time\nn = 0\nwhile True:\n    n += 1\n    open({str(counter)!r}, "w").write(str(n))\n'
            '    time.sleep(0.02)')
    exec_id = runner.start({'argv': [sys.executable, '-c', code], 'timeout_seconds': 30, 'repository_code': False})
    for _ in range(100):
        if counter.exists() and counter.read_text():
            break
        time.sleep(0.05)
    assert runner.ping()['status'] == 'HealthyBusy'
    runner.hold()
    time.sleep(0.2)
    held = counter.read_text()
    time.sleep(0.3)
    assert (counter.read_text(), runner.ping()['status']) == (held, 'Healthy')
    runner.wake()
    for _ in range(100):
        if counter.read_text() != held:
            break
        time.sleep(0.05)
    assert (counter.read_text() != held, runner.ping()['status']) == (True, 'HealthyBusy')
    runner.kill_all()
    assert runner.poll(exec_id) is not None


def test_the_runner_answers_agentcores_ping_and_invocations(tmp_path):
    server, base = _serving(tmp_path, 'service')
    try:
        assert https_json(urllib.request.Request(f'{base}/ping'))['status'] == 'Healthy'

        def invoke(body: dict) -> dict:
            return https_json(urllib.request.Request(f'{base}/invocations', data=json.dumps(body).encode(),
                                                     method='POST', headers={'Content-Type': 'application/json'}))

        assert invoke({'op': 'start', 'environment': SPEC.environment(), 'egress': ['pypi.org']}) == {'started': True}
        assert invoke({'op': 'status'}) == {'step': '', 'recent_tools': [], 'tokens': {}}
        assert invoke({'op': 'hold'}) == {'held': True}
        assert invoke({'op': 'wake'}) == {'held': False}
        session = {'Version': 1, 'AccessKeyId': 'ASIAFAKE', 'SecretAccessKey': 'fake', 'SessionToken': 'fake',
                   'Expiration': '2026-11-12T12:15:00+00:00'}
        assert invoke({'op': 'session', 'session': session}) == {'kept': True}
        with pytest.raises(urllib.error.HTTPError) as refused:
            invoke({'op': 'reboot'})
        assert refused.value.code == 400
    finally:
        server.shutdown()
        server.server_close()


def test_the_command_apis_client_starts_a_command_and_reads_it_back_through_the_runner(tmp_path):
    server, _ = _serving(tmp_path)
    port = server.server_address[1]
    try:
        def encoded(body: dict) -> str:
            return base64.urlsafe_b64encode(json.dumps(body).encode()).decode()

        started = client('start', encoded(_py('print(42)').to_body()), port)
        answer: dict = {'state': 'running'}
        for _ in range(200):
            answer = client('poll', encoded({'exec_id': started['exec_id']}), port)
            if answer['state'] == 'done':
                break
            time.sleep(0.05)
        assert (answer['exit_code'], answer['stdout_tail'].strip()) == (0, '42')
        with pytest.raises(ValueError, match='argv'):
            client('start', encoded({'argv': 'echo'}), port)
        with pytest.raises(ValueError, match='client start'):
            client('poll', encoded({'exec_id': '../status'}), port)
    finally:
        server.shutdown()
        server.server_close()


def test_commands_see_only_the_passed_environment_and_only_repository_code_the_toolchain_homes():
    source = {'PATH': '/bin', 'AWS_SECRET_ACCESS_KEY': 'fake', 'AWS_SESSION_TOKEN': 'fake', 'HOME': '/h',
              'RUSTUP_HOME': '/opt/voc/cache/rustup'}
    assert command_env(source, repository_code=False) == {'PATH': '/bin', 'HOME': '/h'}
    assert command_env(source, repository_code=True) == {'PATH': '/bin', 'HOME': '/h',
                                                         'RUSTUP_HOME': '/opt/voc/cache/rustup'}


def test_the_agents_own_commands_get_its_ids_and_bucket_and_repository_code_none_of_them(
        tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv('VOC_RUN_ID', '01JD3R4NZXQ7Y2W8K4M6P9T0AB')
    monkeypatch.setenv('VOC_AGENT_ID', 'fixer-1')
    runner = _runner(tmp_path)
    runner.keep_session({'Version': 1, 'AccessKeyId': 'ASIAFAKE', 'SecretAccessKey': 'fake', 'SessionToken': 'fake',
                         'Expiration': '2026-11-12T12:15:00+00:00',
                         'mount': {'bucket': 'voc-raw-test', 'prefix': 'engineering/cache/repo-1/'}})
    show = [sys.executable, '-c', "import os; print(os.environ.get('VOC_RUN_ID'), os.environ.get('VOC_BUCKET'))"]
    agent = _wait_runner(runner, runner.start({'argv': show, 'timeout_seconds': 10, 'repository_code': False}))
    code = _wait_runner(runner, runner.start({'argv': show, 'timeout_seconds': 10}))
    assert agent['stdout_tail'].split() == ['01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'voc-raw-test']
    assert code['stdout_tail'].split() == ['None', 'None']


def test_the_agent_starts_with_its_first_session_whatever_ran_before_it(tmp_path):
    runner = _runner(tmp_path)
    probe = runner.start({'argv': [sys.executable, '-c', 'pass'], 'timeout_seconds': 10})
    _wait_runner(runner, probe)
    runner.keep_session({'Version': 1, 'AccessKeyId': 'ASIAFAKE', 'SecretAccessKey': 'fake', 'SessionToken': 'fake',
                         'Expiration': '2026-11-12T12:15:00+00:00'})
    step = {'argv': [sys.executable, '-c', 'pass'], 'timeout_seconds': 10, 'repository_code': True, 'network': True}
    assert _wait_runner(runner, runner.start(step))['exit_code'] == 0
    with pytest.raises(KeyError):
        runner.poll(probe)


def test_a_command_job_refuses_an_empty_argv_and_a_zero_timeout(tmp_path):
    with pytest.raises(ValueError, match='argv'):
        CommandJob([], str(tmp_path), 5)
    with pytest.raises(ValueError, match='timeout'):
        CommandJob(['true'], str(tmp_path), 0)


def _runner(tmp_path, *, sandbox: bool = False, hardlink_guard: bool = False) -> Runner:
    (tmp_path / 'home').mkdir(exist_ok=True)
    (tmp_path / 'secrets').mkdir(exist_ok=True)
    return Runner(str(tmp_path), sandbox=sandbox, secrets_dir=str(tmp_path / 'secrets'),
                  agent_home=str(tmp_path / 'home'), hardlink_guard=hardlink_guard)


def _serving(tmp_path, api: Api = 'agent'):
    server = serve('127.0.0.1', 0, _runner(tmp_path), api)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_address[1]}'


def _wait_runner(runner: Runner, exec_id: str) -> dict:
    for _ in range(200):
        result = runner.poll(exec_id)
        if result is not None:
            return result
        time.sleep(0.05)
    raise AssertionError('the command did not finish')


def test_the_images_runner_is_built_from_its_entry_points_arguments(tmp_path):
    server = main(['--host', '127.0.0.1', '--port', '0', '--workdir', str(tmp_path), '--agent-home', str(tmp_path),
                   '--secrets-dir', str(tmp_path)])
    try:
        assert server.server_address[0] == '127.0.0.1'
    finally:
        server.server_close()
    with pytest.raises(SystemExit):
        main(['--host', '127.0.0.1'])


def test_the_dependency_step_runs_before_any_repository_code_and_never_after(tmp_path):
    runner = _runner(tmp_path)
    step = {'argv': [sys.executable, '-c', 'pass'], 'timeout_seconds': 10, 'repository_code': True, 'network': True}
    assert _wait_runner(runner, runner.start(step))['exit_code'] == 0
    _wait_runner(runner, runner.start({**step, 'network': False}))
    with pytest.raises(ValueError, match='before any repository code'):
        runner.start(step)


def test_the_dependency_step_ends_every_repository_code_process_first(tmp_path):
    runner = _runner(tmp_path)
    first = {'argv': [sys.executable, '-c', 'import time; time.sleep(30)'], 'timeout_seconds': 60,
             'repository_code': True, 'network': True}
    sleeping = runner.start(first)
    runner.start(first)
    assert _wait_runner(runner, sleeping)['exit_code'] != 0


def test_the_session_is_kept_in_the_secrets_directory_and_only_the_agents_own_commands_are_pointed_at_it(tmp_path):
    runner = _runner(tmp_path)
    runner.keep_session({'Version': 1, 'AccessKeyId': 'ASIAFAKE', 'SecretAccessKey': 'fake', 'SessionToken': 'fake',
                         'Expiration': '2026-11-12T12:15:00+00:00'})
    session = tmp_path / 'secrets' / 'session.json'
    assert json.loads(session.read_text())['AccessKeyId'] == 'ASIAFAKE'
    assert stat.S_IMODE(session.stat().st_mode) == 0o400
    assert f'credential_process = /usr/bin/cat {session}' in (tmp_path / 'secrets' / 'aws-config').read_text()
    show = [sys.executable, '-c', "import os; print(os.environ.get('AWS_CONFIG_FILE', 'none'), os.environ['HOME'])"]
    agent = _wait_runner(runner, runner.start({'argv': show, 'timeout_seconds': 10, 'repository_code': False}))
    code = _wait_runner(runner, runner.start({'argv': show, 'timeout_seconds': 10}))
    assert agent['stdout_tail'].split() == [str(tmp_path / 'secrets' / 'aws-config'), str(tmp_path / 'home')]
    assert code['stdout_tail'].split()[0] == 'none'
    with pytest.raises(ValueError, match='a session needs'):
        runner.keep_session({'AccessKeyId': 'ASIAFAKE'})


def test_a_new_session_never_writes_through_a_link_planted_in_the_secrets_directory(tmp_path):
    runner = _runner(tmp_path)
    target = tmp_path / 'elsewhere'
    target.write_text('untouched')
    (tmp_path / 'secrets' / 'session.json').symlink_to(target)
    runner.keep_session({'Version': 1, 'AccessKeyId': 'ASIAFAKE', 'SecretAccessKey': 'fake', 'SessionToken': 'fake',
                         'Expiration': '2026-11-12T12:15:00+00:00'})
    assert target.read_text() == 'untouched'
    assert not (tmp_path / 'secrets' / 'session.json').is_symlink()


def test_the_dependency_step_is_refused_in_a_sandbox_without_the_code_firewall(tmp_path):
    runner = _runner(tmp_path, sandbox=True, hardlink_guard=True)
    with pytest.raises(ValueError, match='code firewall'):
        runner.start({'argv': ['npm', 'ci'], 'timeout_seconds': 10, 'repository_code': True, 'network': True})


def test_no_repository_code_runs_in_a_sandbox_without_the_hard_link_guard(tmp_path):
    runner = _runner(tmp_path, sandbox=True)
    with pytest.raises(ValueError, match='hard-link guard'):
        runner.start({'argv': ['make'], 'timeout_seconds': 10})


def test_a_status_directory_that_is_a_link_or_a_status_that_is_a_fifo_is_not_read(tmp_path):
    runner = _runner(tmp_path)
    elsewhere = tmp_path / 'elsewhere'
    elsewhere.mkdir()
    (elsewhere / 'status.json').write_text(json.dumps({'step': 'leaked'}))
    (tmp_path / 'home' / '.voc').symlink_to(elsewhere)
    assert runner.status()['step'] == ''
    (tmp_path / 'home' / '.voc').unlink()
    (tmp_path / 'home' / '.voc').mkdir()
    os.mkfifo(tmp_path / 'home' / '.voc' / 'status.json')
    assert runner.status()['step'] == ''


def test_other_repository_code_ends_a_dependency_step_still_running(tmp_path):
    runner = _runner(tmp_path)
    step = runner.start({'argv': [sys.executable, '-c', 'import time; time.sleep(30)'], 'timeout_seconds': 60,
                         'repository_code': True, 'network': True})
    runner.start({'argv': [sys.executable, '-c', 'pass'], 'timeout_seconds': 10})
    assert _wait_runner(runner, step)['exit_code'] != 0


def test_a_status_file_that_is_a_link_is_not_followed(tmp_path):
    runner = _runner(tmp_path)
    secret = tmp_path / 'root-only'
    secret.write_text(json.dumps({'step': 'leaked'}))
    (tmp_path / 'home' / '.voc').mkdir()
    (tmp_path / 'home' / '.voc' / 'status.json').symlink_to(secret)
    assert runner.status()['step'] == ''


def test_killing_a_job_ends_its_whole_process_group(tmp_path):
    runner = _runner(tmp_path)
    # The pid file appears whole (written beside it, then renamed), so it is never read half-written.
    spawn = ("import os, subprocess, sys, time; "
             "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)']); "
             "open('child.pid.tmp', 'w').write(str(child.pid)); os.rename('child.pid.tmp', 'child.pid'); "
             "time.sleep(120)")
    exec_id = runner.start({'argv': [sys.executable, '-c', spawn], 'timeout_seconds': 180})
    pid_file = tmp_path / 'child.pid'
    # Deadlines, not tick counts: a loaded machine (a load average in the hundreds) takes seconds to start Python.
    assert _within(60, pid_file.exists), 'the job never started its child'
    child = int(pid_file.read_text())
    runner.kill_all()
    assert runner.poll(exec_id) is not None
    assert _within(60, lambda: not _alive(child)), 'the child outlived its killed job'


def _within(seconds: float, done: Callable[[], bool]) -> bool:
    """Whether ``done`` holds before ``seconds`` have passed (checked every 20 ms)."""
    deadline = time.monotonic() + seconds
    while not done():
        if time.monotonic() > deadline:
            return False
        time.sleep(0.02)
    return True


def _alive(pid: int) -> bool:
    """The process exists and is not a zombie waiting to be reaped."""
    try:
        with open(f'/proc/{pid}/stat') as stat_file:
            state = stat_file.read().rsplit(')', 1)[1].split()[0]
    except (OSError, IndexError):
        return False
    return state != 'Z'


def test_the_status_is_the_harnesss_report_bounded_and_scrubbed(tmp_path):
    runner = _runner(tmp_path)
    assert runner.status() == {'step': '', 'recent_tools': [], 'tokens': {}}
    voc = tmp_path / 'home' / '.voc'
    voc.mkdir()
    (voc / 'status.json').write_text(json.dumps({'step': 'token=' + 'x' * 30, 'recent_tools': ['read'] * 30,
                                                 'tokens': {'m': {'in': 5, 'out': 6, 'other': 1}}}))
    report = runner.status()
    assert (report['step'], len(report['recent_tools']), report['tokens']) == (f'token={MASK}', 10,
                                                                               {'m': {'in': 5, 'out': 6}})


def test_the_runner_serves_exec_over_http(tmp_path):
    server, base = _serving(tmp_path)
    try:
        body = Command(argv=(sys.executable, '-c', 'print(42)'), timeout_seconds=10).to_body()
        started = https_json(urllib.request.Request(f'{base}/exec', data=json.dumps(body).encode(),
                                                    method='POST', headers={'Content-Type': 'application/json'}))
        answer: dict = {'state': 'running'}
        for _ in range(200):
            answer = dict(https_json(urllib.request.Request(f'{base}/exec/{started["exec_id"]}')))
            if answer['state'] == 'done':
                break
            time.sleep(0.05)
        assert (answer['exit_code'], answer['stdout_tail'].strip()) == (0, '42')
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize(('api', 'method', 'path', 'body', 'status'), [
    ('agent', 'GET', '/exec/unknown', None, 404), ('agent', 'GET', '/other', None, 404),
    ('agent', 'POST', '/exec', b'{"argv": "echo"}', 400), ('agent', 'POST', '/elsewhere', b'{}', 400),
    # The agent's port serves none of the service's: no session, start, hold or wake, no ping.
    ('agent', 'POST', '/invocations', b'{"op": "wake"}', 400), ('agent', 'POST', '/session', b'{}', 400),
    ('agent', 'GET', '/ping', None, 404),
    # The service's port runs no command and reads no status.
    ('service', 'POST', '/exec', b'{"argv": ["true"], "timeout_seconds": 5}', 400),
    ('service', 'GET', '/status', None, 404), ('service', 'GET', '/exec/abc', None, 404),
    ('service', 'POST', '/session', b'{}', 400),
], ids=['unknown-id', 'unknown-path', 'bad-body', 'bad-path', 'agent-no-invocations', 'agent-no-session',
        'agent-no-ping', 'service-no-exec', 'service-no-status', 'service-no-poll', 'service-no-session'])
def test_each_face_of_the_runner_refuses_what_it_does_not_serve(tmp_path, api, method, path, body, status):
    server, base = _serving(tmp_path, api)
    try:
        with pytest.raises(urllib.error.HTTPError) as refused:
            https_json(urllib.request.Request(f'{base}{path}', data=body, method=method))
        assert refused.value.code == status
    finally:
        server.shutdown()
        server.server_close()
