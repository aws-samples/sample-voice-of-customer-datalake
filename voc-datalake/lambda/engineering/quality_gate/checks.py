"""The deterministic gate: run a plan's checks, judge each one, and name the tree they judged.

What counts as a failure, per check: an exit code other than 0, a timeout, or a missing tool. A check that looked
at nothing fails too (an ``empty_exit_codes`` exit, or output without ``expect_output``): a gate that scanned
nothing must not pass. A failing setup step (the dependency step) stops the rest of the plan.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field

from engineering.quality_gate.packs import GatePlan, PlannedCheck, Tool
from engineering.quality_gate.runner import CommandResult, CommandRunner
from engineering.quality_gate.text import clip, redact

_HASH = re.compile(r'[0-9a-f]{40}(?:[0-9a-f]{24})?\Z')
VERSION_TIMEOUT_S = 60
VERSION_CHARS = 200
GIT_TIMEOUT_S = 600
#: Every git command the gate runs: no hooks, file-system monitor, pager, external diff or config but its own,
#: so nothing the repository's code planted runs through it.
GIT = ('git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat',
       '-c', 'diff.external=', '--no-pager')
GIT_ENV = {'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_OPTIONAL_LOCKS': '0'}


class GateError(RuntimeError):
    """The gate could not do its job (as opposed to a check that failed)."""


@dataclass(frozen=True)
class CheckResult:
    key: str
    name: str
    kind: str
    root: str
    status: str
    reason: str
    exit_code: int | None = None
    duration_s: float = 0.0
    output: str = ''

    @property
    def blocking(self) -> bool:
        return self.status != 'pass'

    def summary(self) -> dict[str, object]:
        """What the gate record keeps: never the output."""
        return {'key': self.key, 'name': self.name, 'kind': self.kind, 'root': self.root, 'status': self.status,
                'reason': self.reason, 'exit_code': self.exit_code, 'duration_s': round(self.duration_s, 1)}


@dataclass(frozen=True)
class GateRun:
    results: tuple[CheckResult, ...]
    tool_versions: Mapping[str, str] = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return all(not result.blocking for result in self.results)

    @property
    def failures(self) -> tuple[CheckResult, ...]:
        return tuple(result for result in self.results if result.blocking)


def judge(check: PlannedCheck, result: CommandResult) -> tuple[str, str]:
    """``(status, reason)`` of one command's result under its check's rules."""
    if result.missing:
        return 'missing_tool', f'{check.argv[0]} is not installed'
    if result.timed_out:
        return 'timeout', f'still running after {check.timeout_s} s'
    if result.exit_code in check.empty_exit_codes:
        return 'empty', f'exit {result.exit_code}: it found nothing to check'
    if result.exit_code != 0:
        return 'fail', f'exit {result.exit_code}'
    # The runner watched the whole stream for the pattern; the kept tail is the fallback for one that does not.
    if check.expect_output and not result.expect_seen and not re.search(check.expect_output, result.output):
        return 'empty', 'its output does not show that anything was checked'
    return 'pass', 'ok'


def run_plan(plan: GatePlan, runner: CommandRunner) -> GateRun:
    """Every check of ``plan`` in order; a failing setup step stops the rest."""
    results: list[CheckResult] = []
    setup_failed = ''
    for check in plan.checks:
        if setup_failed:
            results.append(CheckResult(key=check.key, name=check.name, kind=check.kind, root=check.root,
                                       status='fail', reason=f'not run: setup step "{setup_failed}" failed'))
            continue
        run = runner.run(check.argv, cwd=check.root, timeout_s=check.timeout_s, network=check.kind == 'setup',
                         expect=check.expect_output)
        status, reason = judge(check, run)
        results.append(CheckResult(key=check.key, name=check.name, kind=check.kind, root=check.root, status=status,
                                   reason=reason, exit_code=run.exit_code, duration_s=run.duration_s,
                                   output=redact(run.output)))
        if check.kind == 'setup' and status != 'pass':
            setup_failed = check.name
    return GateRun(results=tuple(results), tool_versions=tool_versions(plan.needs.tools, runner))


def tool_versions(tools: tuple[Tool, ...], runner: CommandRunner) -> dict[str, str]:
    """The first line of each tool's version output (redacted, clipped), or ``missing``."""
    versions = {}
    for tool in tools:
        run = runner.run(tool.version_argv, timeout_s=VERSION_TIMEOUT_S)
        first = run.output.strip().splitlines()[0] if run.output.strip() and run.exit_code == 0 else ''
        line = clip(redact(first), VERSION_CHARS)
        versions[tool.name] = line or 'missing'
    return versions


def reset_checkout(git_runner: CommandRunner) -> None:
    """Put the checkout back to HEAD exactly, removing every file the last round's checks wrote.

    Run as the agent before a round's dependency step, so nothing repository code left behind (a planted
    .npmrc, a changed lock file) reaches the one step that has network. The flows commit before the gate, so
    nothing of theirs is lost.
    """
    for args in (('reset', '--hard', '--quiet', 'HEAD'), ('clean', '-ffdxq')):
        result = git_runner.run([*GIT, *args], timeout_s=GIT_TIMEOUT_S, env=GIT_ENV)
        if result.exit_code != 0:
            raise GateError(f'git {args[0]} failed: {result.output.strip()[:200]}')


def tree_hash(git_runner: CommandRunner) -> str:
    """The tree id of the checkout's HEAD: the flows commit before the gate, so HEAD is the tree it judges.

    The same tree id on the pull request's head commit proves the PR is that tree. ``git_runner`` runs as the
    agent, not as the sandbox user that ran the repository's code.
    """
    result = git_runner.run([*GIT, 'rev-parse', '--verify', 'HEAD^{tree}'], timeout_s=VERSION_TIMEOUT_S,
                            env=GIT_ENV)
    tree = result.output.strip()
    if result.exit_code != 0 or not _HASH.match(tree):
        raise GateError(f'the checkout has no committed tree: {tree[:200]}')
    status = git_runner.run([*GIT, 'status', '--porcelain', '--untracked-files=no', '--ignore-submodules'],
                            timeout_s=VERSION_TIMEOUT_S, env=GIT_ENV)
    if status.exit_code != 0 or status.output.strip():
        raise GateError(f'the checkout has uncommitted changes, so HEAD is not the tree that was checked: '
                        f'{status.output.strip()[:200]}')
    return tree
