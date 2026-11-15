"""LocalRunner: real subprocesses, a scrubbed environment, a throwaway HOME, hard timeouts, bounded output."""
from __future__ import annotations

import json
import os
import signal
import sys
import time
from pathlib import Path

import pytest

from engineering.quality_gate.runner import OUTPUT_LIMIT, LocalRunner

PY = sys.executable


def test_a_command_runs_in_its_root_with_stdout_and_stderr_merged(tmp_path):
    (tmp_path / 'pkg').mkdir()
    result = LocalRunner(tmp_path).run(
        [PY, '-c', 'import os, sys; print(os.getcwd()); print("oops", file=sys.stderr, flush=True); sys.exit(3)'],
        cwd='pkg', timeout_s=30)
    assert result.exit_code == 3
    assert str(tmp_path.resolve() / 'pkg') in result.output
    assert 'oops' in result.output
    assert not result.timed_out
    assert not result.missing


def test_only_the_allowed_variables_reach_a_command_and_home_is_a_throwaway(tmp_path, monkeypatch):
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'secret-value')
    monkeypatch.setenv('GITHUB_TOKEN', 'token-value')
    monkeypatch.setenv('HOME', str(tmp_path))
    (tmp_path / '.cargo').mkdir()
    monkeypatch.delenv('CARGO_HOME', raising=False)
    runner = LocalRunner(tmp_path)
    result = runner.run([PY, '-c', 'import os, json; print(json.dumps(dict(os.environ)))'], timeout_s=30,
                        env={'GIT_INDEX_FILE': 'x'})
    env = json.loads(result.output.strip().splitlines()[-1])
    assert 'AWS_SECRET_ACCESS_KEY' not in env
    assert 'GITHUB_TOKEN' not in env
    assert {'PATH', 'CI', 'NO_COLOR', 'GIT_TERMINAL_PROMPT', 'GIT_INDEX_FILE'} <= set(env)
    assert env['HOME'] == runner.home != str(tmp_path)
    assert Path(runner.home).is_dir()
    assert env['CARGO_HOME'] == str(tmp_path / '.cargo')


def test_a_command_without_network_asks_the_package_managers_to_stay_offline(tmp_path):
    runner = LocalRunner(tmp_path)
    code = 'import os; print(os.environ.get("CARGO_NET_OFFLINE"), os.environ.get("PIP_NO_INDEX"))'
    assert runner.run([PY, '-c', code], timeout_s=30).output.split() == ['true', '1']
    assert runner.run([PY, '-c', code], timeout_s=30, network=True).output.split() == ['None', 'None']


def test_the_dependency_step_gets_a_fresh_home_each_time(tmp_path):
    runner = LocalRunner(tmp_path)
    plant = 'import os; open(os.path.join(os.environ["HOME"], ".npmrc"), "w").write("x"); print(os.environ["HOME"])'
    shared_home = runner.run([PY, '-c', plant], timeout_s=30).output.strip()
    assert shared_home == runner.home
    look = 'import os; print(os.environ["HOME"], os.path.exists(os.path.join(os.environ["HOME"], ".npmrc")))'
    home, planted = runner.run([PY, '-c', look], timeout_s=30, network=True).output.split()
    assert (home != runner.home, planted) == (True, 'False')
    assert not Path(home).exists()


def test_the_expected_output_is_watched_across_the_whole_stream(tmp_path):
    code = (f'import sys\nsys.stdout.write("test result: ok. 3 passed\\n" + "x" * {3 * OUTPUT_LIMIT})\n'
            'sys.stdout.flush()')
    runner = LocalRunner(tmp_path)
    result = runner.run([PY, '-c', code], timeout_s=30, expect=r'ok\. [1-9]')
    assert result.expect_seen
    assert 'test result' not in result.output
    assert not runner.run([PY, '-c', 'print("running 0 tests")'], timeout_s=30, expect=r'ok\. [1-9]').expect_seen


@pytest.mark.timing
def test_a_command_past_its_timeout_is_killed_with_its_children(tmp_path):
    started = time.monotonic()
    code = ('import subprocess, sys, time; subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"]);'
            'print("started", flush=True); time.sleep(30)')
    result = LocalRunner(tmp_path).run([PY, '-c', code], timeout_s=1)
    assert result.timed_out
    assert result.exit_code is None
    assert 'started' in result.output
    assert time.monotonic() - started < 15


@pytest.mark.timing
def test_a_detached_child_holding_the_output_open_does_not_hang_the_gate(tmp_path):
    code = ('import subprocess, sys; p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], '
            'start_new_session=True); print(p.pid, flush=True)')
    started = time.monotonic()
    result = LocalRunner(tmp_path).run([PY, '-c', code], timeout_s=30)
    elapsed = time.monotonic() - started
    os.kill(int(result.output.split()[0]), signal.SIGKILL)
    assert result.exit_code == 0
    assert elapsed < 20


def test_output_is_bounded_and_keeps_its_end(tmp_path):
    code = (f'import sys, time\nfor _ in range(10):\n    sys.stdout.write("a" * {OUTPUT_LIMIT // 2}); '
            'sys.stdout.flush(); time.sleep(0.02)\nsys.stdout.write("END")')
    result = LocalRunner(tmp_path).run([PY, '-c', code], timeout_s=30)
    assert result.output.endswith('END')
    assert result.output.startswith(f'[… {4 * OUTPUT_LIMIT + 3} characters cut]\n')
    assert len(result.output) < OUTPUT_LIMIT + 100


def test_short_output_is_kept_whole(tmp_path):
    assert LocalRunner(tmp_path).run([PY, '-c', 'print("hi")'], timeout_s=30).output == 'hi\n'


def test_a_missing_program_is_reported_not_raised(tmp_path):
    result = LocalRunner(tmp_path).run(['no-such-tool-xyz', '--version'], timeout_s=5)
    assert (result.missing, result.exit_code, result.output) == (True, None, 'no-such-tool-xyz: not found')


def test_a_relative_program_is_resolved_in_the_working_directory(tmp_path):
    script = tmp_path / 'tool'
    script.write_text(f'#!{PY}\nprint("wrapper ran")\n')
    script.chmod(0o755)
    (tmp_path / 'plain').write_text('not executable')
    runner = LocalRunner(tmp_path)
    assert runner.run(['./tool'], timeout_s=30).output.strip() == 'wrapper ran'
    assert runner.run(['./plain'], timeout_s=30).missing


@pytest.mark.parametrize('cwd', ['../x', '/etc'])
def test_a_working_directory_outside_the_checkout_is_refused(tmp_path, cwd):
    with pytest.raises(ValueError, match='cwd must be inside the checkout'):
        LocalRunner(tmp_path).run([PY, '-V'], cwd=cwd, timeout_s=5)


def test_an_empty_command_is_refused(tmp_path):
    with pytest.raises(ValueError, match='argv must name a program'):
        LocalRunner(tmp_path).run([], timeout_s=5)
