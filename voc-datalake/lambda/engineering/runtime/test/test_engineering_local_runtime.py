"""The local fake and the runner: commands in the agent's directory, scrubbed output, the sandbox argv."""
import json
import os
import stat
import sys
import threading
import time
import urllib.error
import urllib.request

import pytest

from engineering.runtime.aws import https_json
from engineering.runtime.interface import AgentSpec, Command, ExecResult, MicroVm, RuntimeRefused
from engineering.runtime.test.local_runtime import LocalMicroVmRuntime
from engineering.runtime.tokens import MAX_TOKEN_SECONDS
from engineering.runtime.unit_runner import (
    MASK,
    CommandJob,
    Runner,
    command_env,
    main,
    sandboxed_argv,
    scrub_text,
    serve,
)

SPEC = AgentSpec(run_id='run-1', agent_id='fixer-1', role='fixer', task_id='task-1', language='python',
                 egress=('pypi.org',), connection='repo-1')


def _py(code: str, timeout: int = 30) -> Command:
    return Command(argv=(sys.executable, '-c', code), timeout_seconds=timeout)


def _wait(runtime: LocalMicroVmRuntime, vm: MicroVm, exec_id: str) -> ExecResult:
    for _ in range(200):
        result = runtime.poll_exec(vm, exec_id)
        if result is not None:
            return result
        time.sleep(0.05)
    raise AssertionError('the command did not finish')


def test_a_command_runs_in_the_agents_own_directory_and_reports_its_tails():
    runtime = LocalMicroVmRuntime()
    vm = runtime.run(SPEC)
    code = "import os, sys; open('made.txt', 'w').write('x'); print(os.getcwd()); sys.exit(3)"
    result = _wait(runtime, vm, runtime.start_exec(vm, _py(code)))
    assert (result.exit_code, result.ok) == (3, False)
    assert result.stdout_tail.strip() == os.path.realpath(vm.endpoint)
    assert os.path.exists(os.path.join(vm.endpoint, 'made.txt'))


def test_credentials_in_tool_output_are_masked():
    runtime = LocalMicroVmRuntime()
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


def test_a_command_over_its_timeout_is_killed():
    runtime = LocalMicroVmRuntime()
    vm = runtime.run(SPEC)
    result = _wait(runtime, vm, runtime.start_exec(vm, _py('import time; time.sleep(30)', timeout=1)))
    assert result.timed_out
    assert not result.ok


def test_a_suspended_vm_runs_nothing_until_resumed():
    runtime = LocalMicroVmRuntime()
    vm = runtime.run(SPEC)
    runtime.suspend(vm)
    with pytest.raises(RuntimeRefused, match='suspended'):
        runtime.start_exec(vm, _py('pass'))
    runtime.resume(vm)
    assert _wait(runtime, vm, runtime.start_exec(vm, _py('pass'))).ok


def test_resume_refuses_a_running_vm():
    runtime = LocalMicroVmRuntime()
    with pytest.raises(RuntimeRefused, match='not suspended'):
        runtime.resume(runtime.run(SPEC))


def test_terminate_kills_its_commands_removes_the_directory_and_is_idempotent():
    runtime = LocalMicroVmRuntime()
    vm = runtime.run(SPEC)
    runtime.start_exec(vm, _py('import time; time.sleep(30)', timeout=60))
    runtime.terminate(vm)
    runtime.terminate(vm)
    assert not os.path.exists(vm.endpoint)
    with pytest.raises(RuntimeRefused, match='terminated'):
        runtime.mint_token(vm)


def test_unknown_vm_exec_and_a_missing_program_are_refused():
    runtime = LocalMicroVmRuntime()
    vm = runtime.run(SPEC)
    with pytest.raises(RuntimeRefused, match='unknown exec'):
        runtime.poll_exec(vm, 'nope')
    with pytest.raises(RuntimeRefused, match='could not start'):
        runtime.start_exec(vm, Command(argv=('/nonexistent/voc-tool',), timeout_seconds=5))
    with pytest.raises(RuntimeRefused, match='unknown MicroVM'):
        runtime.suspend(MicroVm(vm_id='other', agent_id='fixer-1', endpoint='nowhere'))


def test_a_minted_token_lasts_sixty_minutes():
    runtime = LocalMicroVmRuntime(clock=lambda: 1000.0)
    assert runtime.mint_token(runtime.run(SPEC)).expires_at == 1000.0 + MAX_TOKEN_SECONDS


def test_commands_see_only_the_passed_environment_and_only_repository_code_the_toolchain_homes():
    source = {'PATH': '/bin', 'AWS_SECRET_ACCESS_KEY': 'fake', 'AWS_SESSION_TOKEN': 'fake', 'HOME': '/h',
              'RUSTUP_HOME': '/opt/voc/cache/rustup'}
    assert command_env(source, repository_code=False) == {'PATH': '/bin', 'HOME': '/h'}
    assert command_env(source, repository_code=True) == {'PATH': '/bin', 'HOME': '/h',
                                                         'RUSTUP_HOME': '/opt/voc/cache/rustup'}


def test_the_agents_own_commands_get_its_ids_and_bucket_and_repository_code_none_of_them(
        tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv('VOC_RUN_ID', 'run-1')
    monkeypatch.setenv('VOC_AGENT_ID', 'fixer-1')
    runner = _runner(tmp_path)
    runner.keep_session({'Version': 1, 'AccessKeyId': 'ASIAFAKE', 'SecretAccessKey': 'fake', 'SessionToken': 'fake',
                         'Expiration': '2026-11-12T12:15:00+00:00',
                         'mount': {'bucket': 'voc-raw-test', 'prefix': 'engineering/cache/repo-1/'}})
    show = [sys.executable, '-c', "import os; print(os.environ.get('VOC_RUN_ID'), os.environ.get('VOC_BUCKET'))"]
    agent = _wait_runner(runner, runner.start({'argv': show, 'timeout_seconds': 10, 'repository_code': False}))
    code = _wait_runner(runner, runner.start({'argv': show, 'timeout_seconds': 10}))
    assert agent['stdout_tail'].split() == ['run-1', 'voc-raw-test']
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


def _serving(tmp_path):
    server = serve('127.0.0.1', 0, _runner(tmp_path))
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
    spawn = ("import os, subprocess, sys, time; "
             "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)']); "
             "open('child.pid', 'w').write(str(child.pid)); time.sleep(30)")
    exec_id = runner.start({'argv': [sys.executable, '-c', spawn], 'timeout_seconds': 60})
    pid_file = tmp_path / 'child.pid'
    for _ in range(200):
        if pid_file.exists() and pid_file.read_text():
            break
        time.sleep(0.02)
    child = int(pid_file.read_text())
    runner.kill_all()
    assert runner.poll(exec_id) is not None
    for _ in range(100):
        if not _alive(child):
            break
        time.sleep(0.02)
    assert not _alive(child)


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


@pytest.mark.parametrize(('method', 'path', 'body', 'status'), [
    ('GET', '/exec/unknown', None, 404), ('GET', '/other', None, 404),
    ('POST', '/exec', b'{"argv": "echo"}', 400), ('POST', '/elsewhere', b'{}', 400),
], ids=['unknown-id', 'unknown-path', 'bad-body', 'bad-path'])
def test_the_runner_refuses_what_it_does_not_serve(tmp_path, method, path, body, status):
    server, base = _serving(tmp_path)
    try:
        with pytest.raises(urllib.error.HTTPError) as refused:
            https_json(urllib.request.Request(f'{base}{path}', data=body, method=method))
        assert refused.value.code == status
    finally:
        server.shutdown()
        server.server_close()
