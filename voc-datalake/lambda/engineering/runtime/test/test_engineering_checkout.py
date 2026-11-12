"""The checkout: a sparse, blob-less clone from the cache, with hooks and the file-system monitor off."""
import os
import stat
import sys
import time

import pytest

from engineering.runtime.checkout import CACHE_SOURCE, CHECKOUT_DIR, check_sparse_path, checkout_commands
from engineering.runtime.interface import AgentSpec, Command, ExecResult, MicroVm, RuntimeRefused
from engineering.runtime.test.local_runtime import LocalMicroVmRuntime

COMMIT = 'b' * 40
SPEC = AgentSpec(run_id='run-1', agent_id='fixer-1', role='fixer', task_id='task-1', language='python', egress=(),
                 connection='repo-1')
SETUP = '''
import os, pathlib
for path in ("src/app.py", "docs/guide.md", "README.md"):
    pathlib.Path("origin", path).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path("origin", path).write_text(path)
# A repository's links may point out of the checkout, or nowhere (a sparse checkout leaves many dangling).
os.symlink("../..", "origin/src/up")
os.symlink("../docs/guide.md", "origin/src/dangling")
'''


def _run(runtime: LocalMicroVmRuntime, vm: MicroVm, *argv: str) -> ExecResult:
    return _run_command(runtime, vm, Command(argv=argv, timeout_seconds=60))


def _run_command(runtime: LocalMicroVmRuntime, vm: MicroVm, command: Command) -> ExecResult:
    exec_id = runtime.start_exec(vm, command)
    for _ in range(400):
        result = runtime.poll_exec(vm, exec_id)
        if result is not None:
            assert result.ok, result.stderr_tail
            return result
        time.sleep(0.02)
    raise AssertionError('the command did not finish')


def test_only_the_tasks_paths_are_checked_out_at_the_commit():
    runtime = LocalMicroVmRuntime()
    vm = runtime.run(SPEC)
    git = ('git', '-c', 'user.name=Example', '-c', 'user.email=dev@example.org', '-c', 'init.defaultBranch=main')
    _run(runtime, vm, sys.executable, '-c', SETUP)
    _run(runtime, vm, *git, 'init', '--quiet', 'origin')
    _run(runtime, vm, *git, '-C', 'origin', 'add', '.')
    _run(runtime, vm, *git, '-C', 'origin', 'commit', '--quiet', '-m', 'first')
    _run(runtime, vm, *git, 'clone', '--quiet', '--bare', 'origin', 'cache.git')
    commit = _run(runtime, vm, 'git', '-C', 'origin', 'rev-parse', 'HEAD').stdout_tail.strip()
    parent_mode = os.stat(vm.endpoint).st_mode
    for command in checkout_commands(commit, ['src'], source=f'file://{vm.endpoint}/cache.git'):
        _run_command(runtime, vm, command)
    # The links were not followed: what they point at (the checkout's parent) is as it was.
    assert os.stat(vm.endpoint).st_mode == parent_mode
    checkout = os.path.join(vm.endpoint, CHECKOUT_DIR)
    assert os.path.exists(os.path.join(checkout, 'src', 'app.py'))
    assert not os.path.exists(os.path.join(checkout, 'docs'))
    assert _run(runtime, vm, 'git', '-C', CHECKOUT_DIR, 'rev-parse', 'HEAD').stdout_tail.strip() == commit
    assert not os.stat(os.path.join(checkout, '.git', 'config')).st_mode & stat.S_IWGRP
    assert os.stat(os.path.join(checkout, 'src', 'app.py')).st_mode & stat.S_IWGRP


def test_every_git_command_runs_as_the_agent_with_hooks_pagers_helpers_and_system_config_off():
    *git_commands, share, lock = checkout_commands(COMMIT, ['src', 'lib/core'])
    assert share.argv[:6] == ('/usr/bin/find', CHECKOUT_DIR, '-path', f'{CHECKOUT_DIR}/.git', '-prune', '-o')
    assert not share.repository_code
    for command in git_commands:
        assert command.argv[:4] == ('/usr/bin/env', 'GIT_CONFIG_NOSYSTEM=1', 'GIT_TERMINAL_PROMPT=0', '/usr/bin/git')
        assert {'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.pager=cat', 'diff.external=',
                'credential.helper='} <= set(command.argv)
        assert not command.repository_code
    assert lock.argv == ('/usr/bin/chmod', '-R', 'g-w', f'{CHECKOUT_DIR}/.git')


def test_the_default_source_is_the_read_only_cache_mount_and_no_paths_means_the_whole_tree():
    commands = checkout_commands(COMMIT, [])
    assert CACHE_SOURCE in commands[0].argv
    assert '--filter=blob:none' in commands[0].argv
    assert len(commands) == 4


@pytest.mark.parametrize('path', ['/etc', '-rf', '../up', 'a/../b', 'a//b', 'src/*', '', 'src\n'],
                         ids=['absolute', 'option', 'parent', 'inner-parent', 'double-slash', 'glob', 'empty',
                              'trailing-newline'])
def test_a_sparse_path_must_be_a_plain_repository_path(path):
    with pytest.raises(RuntimeRefused):
        check_sparse_path(path)


@pytest.mark.parametrize(('commit', 'source'), [('main', CACHE_SOURCE), ('b' * 39, CACHE_SOURCE),
                                                (COMMIT + '\n', CACHE_SOURCE),
                                                (COMMIT, 'https://github.com/org/repo.git')],
                         ids=['branch-name', 'short-sha', 'trailing-newline', 'host-url'])
def test_a_checkout_needs_a_full_commit_id_and_comes_from_the_cache_only(commit, source):
    with pytest.raises(RuntimeRefused):
        checkout_commands(commit, [], source=source)


def test_too_many_sparse_paths_are_refused():
    with pytest.raises(RuntimeRefused, match='at most'):
        checkout_commands(COMMIT, [f'p{i}' for i in range(201)])
