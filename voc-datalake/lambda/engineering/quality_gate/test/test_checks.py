"""The deterministic gate: what counts as a failure, the setup stop, tool versions, and the judged tree."""
from __future__ import annotations

import shutil
import subprocess

import pytest

from engineering.quality_gate.checks import (
    GIT,
    GIT_ENV,
    GateError,
    judge,
    reset_checkout,
    run_plan,
    tool_versions,
    tree_hash,
)
from engineering.quality_gate.packs import GatePlan, Needs, Tool
from engineering.quality_gate.runner import CommandResult, LocalRunner
from engineering.quality_gate.test.gate_fakes import TREE, TREE_ARGV, ScriptedRunner, check, one_check_plan


def _result(exit_code: int | None = 0, output: str = '', **flags: bool) -> CommandResult:
    return CommandResult(exit_code=exit_code, output=output, duration_s=0.5, **flags)


class TestJudge:
    @pytest.mark.parametrize(('result', 'rules', 'expected'), [
        (_result(0), {}, ('pass', 'ok')),
        (_result(2), {}, ('fail', 'exit 2')),
        (_result(5), {'empty_exit_codes': frozenset({5})}, ('empty', 'exit 5: it found nothing to check')),
        (_result(0, 'running 0 tests'), {'expect_output': r'ok\. [1-9]'},
         ('empty', 'its output does not show that anything was checked')),
        (_result(0, 'test result: ok. 4 passed'), {'expect_output': r'ok\. [1-9]'}, ('pass', 'ok')),
        # The runner saw the pattern earlier in the stream than the tail it kept.
        (_result(0, 'running 0 tests', expect_seen=True), {'expect_output': r'ok\. [1-9]'}, ('pass', 'ok')),
        (_result(None, timed_out=True), {}, ('timeout', 'still running after 60 s')),
        (_result(None, missing=True), {}, ('missing_tool', 'make is not installed')),
    ])
    def test_each_rule(self, result, rules, expected):
        assert judge(check(**rules), result) == expected


class TestRunPlan:
    def test_a_green_plan_passes_and_records_each_check_without_its_output(self):
        runner = ScriptedRunner({('make', 'test'): [_result(0, 'all good')]})
        run = run_plan(one_check_plan(), runner)
        assert run.passed
        assert [r.summary() for r in run.results] == [{
            'key': 'unit tests@.', 'name': 'unit tests', 'kind': 'test', 'root': '', 'status': 'pass',
            'reason': 'ok', 'exit_code': 0, 'duration_s': 0.5}]
        assert run.results[0].output == 'all good'
        assert runner.calls[0].timeout_s == 60

    def test_a_failure_blocks_and_its_output_is_redacted(self):
        runner = ScriptedRunner({('make', 'test'): [_result(1, 'FAILED with token ghp_' + 'x' * 36)]})
        run = run_plan(one_check_plan(), runner)
        assert not run.passed
        assert run.failures[0].output == 'FAILED with token <redacted>'

    def test_only_the_setup_step_asks_for_the_network(self):
        runner = ScriptedRunner()
        run_plan(one_check_plan(check('npm ci', ('npm', 'ci'), kind='setup'), check(expect_output='passed')), runner)
        assert [(c.argv, c.network, c.expect) for c in runner.calls] == [
            (('npm', 'ci'), True, ''), (('make', 'test'), False, 'passed')]

    def test_a_failed_setup_stops_every_later_check(self):
        setup = check('npm ci', ('npm', 'ci'), kind='setup')
        runner = ScriptedRunner({('npm', 'ci'): [_result(1)]})
        run = run_plan(one_check_plan(setup, check()), runner)
        assert [(r.status, r.reason) for r in run.results] == [
            ('fail', 'exit 1'), ('fail', 'not run: setup step "npm ci" failed')]
        assert runner.ran(['make', 'test']) == 0


class TestToolVersions:
    def test_versions_missing_tools_and_a_pin_that_differs(self):
        runner = ScriptedRunner({
            ('node', '--version'): [_result(0, 'v22.1.0\n')],
            ('cargo', '--version'): [_result(0, 'cargo 1.99.1 (abc)\nextra')],
            ('java', '--version'): [_result(None, missing=True)],
            ('npm', '--version'): [_result(1, 'broken')],
        })
        tools = (Tool('node', ('node', '--version')), Tool('cargo', ('cargo', '--version')),
                 Tool('java', ('java', '--version')), Tool('npm', ('npm', '--version')))
        assert tool_versions(tools, runner) == {
            'node': 'v22.1.0', 'cargo': 'cargo 1.99.1 (abc)', 'java': 'missing', 'npm': 'missing'}

    def test_a_version_line_is_redacted_and_clipped(self):
        line = 'tool 1.0 ghp_' + 'x' * 36 + ' ' + 'y' * 300
        version = tool_versions((Tool('tool', ('tool', '-V')),), ScriptedRunner({('tool', '-V'): [_result(0, line)]}))
        assert version['tool'].startswith('tool 1.0 <redacted> yyy')
        assert len(version['tool']) < 260

    def test_run_plan_records_the_plans_tools(self):
        gate_plan = GatePlan(checks=(), packs=(), needs=Needs(tools=(Tool('make', ('make', '--version')),)))
        runner = ScriptedRunner({('make', '--version'): [_result(0, 'GNU Make 4.3')]})
        assert run_plan(gate_plan, runner).tool_versions == {'make': 'GNU Make 4.3'}


class TestTreeHash:
    def test_it_is_heads_tree_read_by_hardened_git(self):
        runner = ScriptedRunner()
        assert tree_hash(runner) == TREE
        assert runner.calls[0].argv == TREE_ARGV
        assert {'core.hooksPath=/dev/null', 'core.fsmonitor=false', '--no-pager'} <= set(TREE_ARGV)
        assert runner.calls[0].env == GIT_ENV

    @pytest.mark.parametrize('result', [_result(128, 'fatal: needed a single revision'), _result(0, 'nonsense')])
    def test_no_committed_tree_is_a_gate_error(self, result):
        with pytest.raises(GateError, match='the checkout has no committed tree'):
            tree_hash(ScriptedRunner({TREE_ARGV: [result]}))

    def test_uncommitted_changes_are_a_gate_error(self):
        status = (*GIT, 'status', '--porcelain', '--untracked-files=no', '--ignore-submodules')
        with pytest.raises(GateError, match=r'uncommitted changes, so HEAD is not the tree that was checked: M a\.py'):
            tree_hash(ScriptedRunner({status: [_result(0, ' M a.py\n')]}))

    def test_reset_puts_the_checkout_back_to_head_as_the_agent(self):
        runner = ScriptedRunner()
        reset_checkout(runner)
        assert [c.argv[len(GIT):] for c in runner.calls] == [('reset', '--hard', '--quiet', 'HEAD'), ('clean', '-ffdxq')]
        assert all(c.env == GIT_ENV for c in runner.calls)
        with pytest.raises(GateError, match='git clean failed: busy'):
            reset_checkout(ScriptedRunner({(*GIT, 'clean', '-ffdxq'): [_result(1, 'busy')]}))

    @pytest.mark.skipif(shutil.which('git') is None, reason='git is not installed')
    def test_a_real_checkout_answers_its_commits_tree_ignored_files_included(self, tmp_path):
        def git(*args: str) -> str:
            argv = ['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', *args]
            return subprocess.run(argv, cwd=tmp_path, check=True, capture_output=True,  # noqa: S603 — fixed git argv
                                  text=True).stdout.strip()

        git('init', '-q')
        with pytest.raises(GateError):
            tree_hash(LocalRunner(tmp_path))
        (tmp_path / '.gitignore').write_text('build/\n')
        (tmp_path / 'build').mkdir()
        (tmp_path / 'build' / '.gitkeep').write_text('')
        (tmp_path / 'a.txt').write_text('one\n')
        git('add', '.gitignore', 'a.txt')
        git('add', '-f', 'build/.gitkeep')
        git('commit', '-qm', 'first')
        runner = LocalRunner(tmp_path)
        assert tree_hash(runner) == git('rev-parse', 'HEAD^{tree}')
        (tmp_path / 'a.txt').write_text('changed by a test\n')
        (tmp_path / 'planted.npmrc').write_text('registry=https://registry.example.com/\n')
        with pytest.raises(GateError, match='uncommitted changes'):
            tree_hash(runner)
        reset_checkout(runner)
        assert (tmp_path / 'a.txt').read_text() == 'one\n'
        assert not (tmp_path / 'planted.npmrc').exists()
        assert tree_hash(runner) == git('rev-parse', 'HEAD^{tree}')
