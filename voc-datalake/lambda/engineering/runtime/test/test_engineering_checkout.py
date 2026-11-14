"""The checkout: a sparse, blob-less clone from the cache, with hooks and the file-system monitor off."""
import os
import stat
import sys
import time

import pytest

from engineering.connectors.cache_layout import REPOSITORY_DIR, entry_prefix
from engineering.runtime.checkout import (
    CHECKOUT_DIR,
    GIT_DIR,
    cache_source,
    check_sparse_path,
    checkout_commands,
    repo_git,
)
from engineering.runtime.interface import AgentSpec, Command, ExecResult, RuntimeRefused, RuntimeSession
from engineering.runtime.test.local_runtime import LocalAgentRuntime
from engineering.runtime.unit_runner import MOUNT_POINT

COMMIT = 'b' * 40
SPEC = AgentSpec(run_id='01JD3R4NZXQ7Y2W8K4M6P9T0AB', agent_id='fixer-1', role='fixer', task_id='task-1', language='python', egress=(),
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


def _run(runtime: LocalAgentRuntime, vm: RuntimeSession, *argv: str) -> ExecResult:
    return _run_command(runtime, vm, Command(argv=argv, timeout_seconds=60))


def _run_command(runtime: LocalAgentRuntime, vm: RuntimeSession, command: Command) -> ExecResult:
    exec_id = runtime.start_exec(vm, command)
    for _ in range(400):
        result = runtime.poll_exec(vm, exec_id)
        if result is not None:
            assert result.ok, result.stderr_tail
            return result
        time.sleep(0.02)
    raise AssertionError('the command did not finish')


def _cached_repository(runtime: LocalAgentRuntime, vm: RuntimeSession) -> str:
    """A repository with one commit and its bare clone (the cache) in the session's directory; the commit."""
    git = ('git', '-c', 'user.name=Example', '-c', 'user.email=dev@example.org', '-c', 'init.defaultBranch=main')
    _run(runtime, vm, sys.executable, '-c', SETUP)
    _run(runtime, vm, *git, 'init', '--quiet', 'origin')
    _run(runtime, vm, *git, '-C', 'origin', 'add', '.')
    _run(runtime, vm, *git, '-C', 'origin', 'commit', '--quiet', '-m', 'first')
    _run(runtime, vm, *git, 'clone', '--quiet', '--bare', 'origin', 'cache.git')
    return _run(runtime, vm, 'git', '-C', 'origin', 'rev-parse', 'HEAD').stdout_tail.strip()


def test_only_the_tasks_paths_are_checked_out_at_the_commit():
    runtime = LocalAgentRuntime()
    vm = runtime.run(SPEC)
    commit = _cached_repository(runtime, vm)
    parent_mode = os.stat(vm.endpoint).st_mode
    for command in checkout_commands(commit, ['src'], 0, source=f'file://{vm.endpoint}/cache.git'):
        _run_command(runtime, vm, command)
    # The links were not followed: what they point at (the checkout's parent) is as it was.
    assert os.stat(vm.endpoint).st_mode == parent_mode
    checkout = os.path.join(vm.endpoint, CHECKOUT_DIR)
    assert os.path.exists(os.path.join(checkout, 'src', 'app.py'))
    assert not os.path.exists(os.path.join(checkout, 'docs'))
    assert _run(runtime, vm, *repo_git('rev-parse', 'HEAD')).stdout_tail.strip() == commit
    # The git directory is beside the working tree, closed to the group; the working tree is open to it.
    assert not os.stat(os.path.join(vm.endpoint, GIT_DIR, 'config')).st_mode & stat.S_IWGRP
    assert os.stat(os.path.join(checkout, 'src', 'app.py')).st_mode & stat.S_IWGRP


def test_a_repository_planted_in_the_working_tree_is_never_the_agents(tmp_path):
    runtime = LocalAgentRuntime()
    vm = runtime.run(SPEC)
    commit = _cached_repository(runtime, vm)
    for command in checkout_commands(commit, [], 0, source=f'file://{vm.endpoint}/cache.git'):
        _run_command(runtime, vm, command)
    # Repository code drops the git file and makes the working tree a bare repository whose config runs a command.
    checkout = os.path.join(vm.endpoint, CHECKOUT_DIR)
    os.remove(os.path.join(checkout, '.git'))
    _run(runtime, vm, 'git', 'init', '--quiet', '--bare', os.path.join(checkout, 'planted.git'))
    for name in ('HEAD', 'config', 'objects', 'refs'):
        os.rename(os.path.join(checkout, 'planted.git', name), os.path.join(checkout, name))
    marker = tmp_path / 'ran'
    with open(os.path.join(checkout, 'config'), 'a') as stream:
        stream.write(f'[filter "x"]\n\tclean = touch {marker}\n[core]\n\tfsmonitor = touch {marker}\n')
    with open(os.path.join(checkout, '.gitattributes'), 'w') as stream:
        stream.write('* filter=x\n')
    _run(runtime, vm, *repo_git('add', '--all'))
    _run(runtime, vm, *repo_git('diff', '--cached', '--no-ext-diff', '--no-textconv', '--stat'))
    assert not marker.exists()


def test_every_git_command_runs_as_the_agent_with_hooks_pagers_helpers_and_system_config_off():
    clone, *git_commands, share, lock = checkout_commands(COMMIT, ['src', 'lib/core'], 1)
    assert f'--separate-git-dir={GIT_DIR}' in clone.argv
    assert share.argv[:4] == ('/usr/bin/find', CHECKOUT_DIR, '!', '-type')
    assert not share.repository_code
    for command in [clone, *git_commands]:
        assert command.argv[0] == '/usr/bin/env'
        assert {'GIT_CONFIG_NOSYSTEM=1', 'GIT_TERMINAL_PROMPT=0', '/usr/bin/git'} <= set(command.argv[1:6])
        assert {'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.pager=cat', 'diff.external=',
                'credential.helper=', 'safe.bareRepository=explicit'} <= set(command.argv)
        assert not command.repository_code
    for command in git_commands:
        # From the working tree's root, naming the git directory beside it: nothing discovered, nothing outside.
        assert command.argv[:3] == ('/usr/bin/env', '-C', CHECKOUT_DIR)
        assert {f'--git-dir=../{GIT_DIR}', '--work-tree=.'} <= set(command.argv)
    assert lock.argv == ('/usr/bin/chmod', '-R', 'g-w', GIT_DIR)


def test_the_default_source_is_the_commits_entry_of_its_generation_in_the_mount_and_no_paths_means_the_whole_tree():
    commands = checkout_commands(COMMIT, [], 1453)
    assert cache_source(COMMIT, 1453) == f'file:///mnt/voc-cache/{COMMIT}/g1453/repo.git'
    assert cache_source(COMMIT, 1453) in commands[0].argv
    assert '--filter=blob:none' in commands[0].argv
    assert len(commands) == 4


@pytest.mark.parametrize('commit', ['main', 'b' * 39, COMMIT + '\n', '../' + 'b' * 37, 'B' * 40],
                         ids=['branch-name', 'short-sha', 'trailing-newline', 'climbs', 'upper-case'])
def test_the_caches_entry_is_named_only_by_a_full_commit_id(commit):
    with pytest.raises(RuntimeRefused, match='full hexadecimal'):
        cache_source(commit, 1)


@pytest.mark.parametrize('generation', [-1, 100_000, True, 1.0, '7', None],
                         ids=['negative', 'too-large', 'bool', 'float', 'text', 'none'])
def test_the_generation_is_a_small_whole_number(generation):
    with pytest.raises(RuntimeRefused, match='cache generation'):
        checkout_commands(COMMIT, [], generation)


def test_the_mounts_entry_is_the_one_the_cache_writer_lays_out():
    under_the_mount = entry_prefix('conn-1', COMMIT, 7).split('/', 3)[3]   # (the mount is the connection's prefix)
    assert cache_source(COMMIT, 7) == f'file://{MOUNT_POINT}/{under_the_mount}{REPOSITORY_DIR}'


@pytest.mark.parametrize('path', ['/etc', '-rf', '../up', 'a/../b', 'a//b', 'src/*', '', 'src\n'],
                         ids=['absolute', 'option', 'parent', 'inner-parent', 'double-slash', 'glob', 'empty',
                              'trailing-newline'])
def test_a_sparse_path_must_be_a_plain_repository_path(path):
    with pytest.raises(RuntimeRefused):
        check_sparse_path(path)


@pytest.mark.parametrize(('commit', 'source'), [('main', None), ('b' * 39, None),
                                                (COMMIT + '\n', None),
                                                (COMMIT, 'https://github.com/org/repo.git')],
                         ids=['branch-name', 'short-sha', 'trailing-newline', 'host-url'])
def test_a_checkout_needs_a_full_commit_id_and_comes_from_the_cache_only(commit, source):
    with pytest.raises(RuntimeRefused):
        checkout_commands(commit, [], 0, source=source)


def test_too_many_sparse_paths_are_refused():
    with pytest.raises(RuntimeRefused, match='at most'):
        checkout_commands(COMMIT, [f'p{i}' for i in range(201)], 1)
