"""The benchmark's runner: a candidate attempts each case, and the case's own check decides, in a fresh repository.

For every case the runner copies the fixture to a new temporary directory (the copy the candidate reads,
``CaseView.repository``) and asks the candidate to ``solve`` it. The ``Attempt`` it returns is a unified diff for a
bug or a feature, findings for a review, and what it cost (tokens, dollars, seconds).

A bug's or a feature's patch is read before git sees it: one over ``MAX_PATCH_BYTES``, or naming a path that is
not a plain one inside the repository (absolute, ``..``, ``.git``), a protected path (the check's own tests) or,
when the case names the paths it allows, any other path, or making a link, a submodule or a binary, is refused.
The rest goes to a second, fresh copy, made a git repository (its git directory beside the working tree, never in
it), checked with ``git apply --check`` and then applied; the tree is walked again (no link, no ``.git``, within
the fixture's bounds), and the case's check runs there: its ``argv`` without a shell, its tool by absolute path
(``python3`` isolated, ``-I -P``: no repository directory on ``sys.path`` at its start, so a patch's
``unittest.py`` shadows nothing), with a timeout and an environment built from nothing (``check_environment``: no
cloud or host credentials and no proxy in its environment, only the tools' directories on PATH). It passes when
it exits 0.

This is not a sandbox: the check's network and file system are open, and at the timeout its process group is
killed, which a child that left the group (``setsid``) escapes. The benchmark assumes an honest candidate: the
code under test can still patch the framework that tests it. The sample's own cases run here; a connection's
cases will run in the runtime's sessions.

A review passes when every expected finding is reported (its file, a line in its range, its rule) and the
findings that match none stay within the case's ``max_false_positives``.

Each case gives a ``CaseResult`` (passed, why, tokens, cost, seconds), and a candidate's run of a suite a
``Scorecard``.
"""
from __future__ import annotations

import contextlib
import math
import os
import re
import shutil
import signal
import subprocess
import tempfile
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Protocol

from engineering.benchmark.cases import (
    MAX_RULE,
    BenchmarkError,
    Case,
    CommandCheck,
    ReviewCheck,
    plain_path,
    walk_fixture,
)
from engineering.runtime.unit_runner import scrub_text
from engineering.skills.model import MAX_BENCHMARK_CASES

#: A patch's size, as UTF-8.
MAX_PATCH_BYTES: Final = 256 * 1024
MAX_REPORTED: Final = 100
MAX_LINE: Final = 1_000_000
MAX_TOKENS: Final = 10**9
#: How much of a check's output a result keeps (its end, where test runners say what failed).
MAX_WHY: Final = 1_000
WHY_HEAD: Final = 100
GIT_TIMEOUT_SECONDS: Final = 60
#: A Python check's interpreter flags (``-P`` is in ``-I`` from Python 3.11; named so an older one refuses to run).
PYTHON_ISOLATION: Final = ('-I', '-P')
#: Control characters but the newline and the tab (C0, DEL and C1).
_CONTROL: Final = re.compile(r'[\x00-\x08\x0b-\x1f\x7f-\x9f]')
_HUNK: Final = re.compile(r'@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@')
#: The line separators ``str.splitlines`` knows and git does not (git splits on ``\n`` alone; ``\r\n`` is folded first).
_OTHER_SEPARATORS: Final = re.compile('[\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]')
#: A patch line that gives a link's or a submodule's mode (git's 120000 and 160000).
_SPECIAL_MODE: Final = re.compile(r'(?:new file mode|deleted file mode|new mode|old mode) 1[26]0000\b|index \S+ 1[26]0000\b')
#: Every git command: no system or global config, no hooks, no prompt, no pager, no credential helper, no
#: protocol at all (nothing is fetched), and a fixed author.
_GIT_CONFIG: Final = ('-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat',
                      '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', 'commit.gpgSign=false',
                      '-c', 'user.name=voc-bench', '-c', 'user.email=voc-bench@example.invalid',
                      '-c', 'init.defaultBranch=main')


@dataclass(frozen=True)
class CaseView:
    """What a candidate is given: the case without its check, and its own copy of the fixture."""

    id: str
    kind: str
    title: str
    task: str
    repository: Path


@dataclass(frozen=True)
class ReportedFinding:
    """A finding a review reports: a repository path, a line and a rule id."""

    file: str
    line: int
    rule: str

    def __post_init__(self) -> None:
        if not self.file or len(self.file) > 512 or not self.rule or len(self.rule) > MAX_RULE:
            raise BenchmarkError(f"a finding names a file (at most 512 characters) and a rule (at most {MAX_RULE})")
        if not 1 <= self.line <= MAX_LINE:
            raise BenchmarkError(f"a finding's line is from 1 to {MAX_LINE}")


def _amount(value: float, what: str) -> None:
    if not math.isfinite(value) or value < 0:
        raise BenchmarkError(f'{what} is a finite amount from 0')


@dataclass(frozen=True)
class Attempt:
    """A candidate's answer to a case: ``diff`` for a bug or a feature, ``findings`` for a review, and its cost."""

    diff: str = ''
    findings: tuple[ReportedFinding, ...] = ()
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    seconds: float = 0.0

    def __post_init__(self) -> None:
        if len(self.findings) > MAX_REPORTED:
            raise BenchmarkError(f'an attempt reports at most {MAX_REPORTED} findings')
        if not (0 <= self.input_tokens <= MAX_TOKENS and 0 <= self.output_tokens <= MAX_TOKENS):
            raise BenchmarkError(f'tokens are whole numbers from 0 to {MAX_TOKENS}')
        _amount(self.cost_usd, 'the cost')
        _amount(self.seconds, 'the time')


class CandidateError(Exception):
    """A candidate could not attempt a case (its model failed, it ran out of time): the case fails, saying so."""


class Candidate(Protocol):
    """What the benchmark measures: an agent (a role's skill version on a model) or a scripted stand-in."""

    @property
    def name(self) -> str: ...

    def solve(self, case: CaseView) -> Attempt: ...


@dataclass(frozen=True)
class CaseResult:
    case_id: str
    passed: bool
    why: str
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    seconds: float = 0.0


@dataclass(frozen=True)
class Scorecard:
    """A candidate's results on a suite: one per case, in the suite's order."""

    candidate: str
    results: tuple[CaseResult, ...]

    def __post_init__(self) -> None:
        ids = [result.case_id for result in self.results]
        if not 0 < len(ids) <= MAX_BENCHMARK_CASES or len(set(ids)) != len(ids):
            raise BenchmarkError(f'a scorecard holds 1-{MAX_BENCHMARK_CASES} results, one per case')

    @property
    def pass_rate(self) -> float:
        return sum(result.passed for result in self.results) / len(self.results)

    @property
    def case_ids(self) -> tuple[str, ...]:
        return tuple(result.case_id for result in self.results)

    @property
    def total_cost_usd(self) -> float:
        return sum(result.cost_usd for result in self.results)

    @property
    def total_seconds(self) -> float:
        return sum(result.seconds for result in self.results)

    def result(self, case_id: str) -> CaseResult | None:
        return next((result for result in self.results if result.case_id == case_id), None)


@dataclass(frozen=True)
class Tools:
    """The absolute paths of the programs the runner uses (``''``: not installed here)."""

    python3: str
    node: str
    git: str

    @classmethod
    def installed(cls) -> Tools:
        """The tools as this machine has them (looked up once; a check's environment never inherits this PATH)."""
        return cls(python3=shutil.which('python3') or '', node=shutil.which('node') or '', git=shutil.which('git') or '')

    def path(self, tool: str) -> str:
        return {'python3': self.python3, 'node': self.node}.get(tool, '')


def check_environment(tools: Tools, home: Path) -> dict[str, str]:
    """A check's whole environment, built from nothing: its tools' directories on PATH, a throwaway HOME and TMPDIR,
    a fixed locale and time zone. No variable of the runner's own reaches it (no credential, no proxy)."""
    directories = dict.fromkeys(str(Path(tool).parent) for tool in (tools.python3, tools.node) if tool)
    return {'PATH': os.pathsep.join(directories), 'HOME': str(home), 'TMPDIR': str(home), 'LANG': 'C.UTF-8',
            'LC_ALL': 'C.UTF-8', 'TZ': 'UTC', 'CI': 'true', 'NO_COLOR': '1',
            # For the Python processes a check starts itself (a Node test spawning python3): the check's own
            # interpreter runs with -I, which ignores every PYTHON* variable.
            'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1'}


def _git_environment(git: str, home: Path) -> dict[str, str]:
    return {'PATH': str(Path(git).parent), 'HOME': str(home), 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
            'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_TERMINAL_PROMPT': '0'}


@dataclass(frozen=True)
class Outcome:
    exit_code: int | None
    output: str

    @property
    def timed_out(self) -> bool:
        return self.exit_code is None


def run_command(argv: Sequence[str], *, cwd: Path, env: Mapping[str, str], timeout_seconds: float) -> Outcome:
    """``argv`` without a shell, in ``cwd``, with exactly ``env``; its process group killed at the timeout and once
    it ends (a child that called ``setsid`` has left the group and escapes it). The output goes to a file (memory
    stays bounded) and its scrubbed end is kept."""
    with tempfile.TemporaryFile() as output:
        process = subprocess.Popen(  # noqa: S603 — a case's checked argv or the runner's own git, never a shell string
            list(argv), cwd=cwd, env=dict(env), stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
            start_new_session=True)
        timed_out = False
        try:
            process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            timed_out = True
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        size = output.seek(0, os.SEEK_END)
        output.seek(max(size - MAX_WHY * 4, 0))
        text = scrub_text(printable(output.read().decode('utf-8', errors='replace')))[-MAX_WHY:]
    return Outcome(None if timed_out else process.returncode, text.strip())


def _diff_git_paths(rest: str) -> list[str]:
    names = rest.split(' ')
    if len(names) != 2 or not names[0].startswith('a/') or not names[1].startswith('b/'):
        raise BenchmarkError(f'the patch names a path git would quote or split: diff --git {rest[:80]}')
    return [names[0][2:], names[1][2:]]


def _header_paths(line: str) -> list[str]:
    """The repository paths a header line of a patch names (none for any other line)."""
    if line.startswith('diff --git '):
        return _diff_git_paths(line[len('diff --git '):])
    if line.startswith(('--- ', '+++ ')):
        name = line[4:].split('\t', 1)[0]
        if name.startswith('"'):
            raise BenchmarkError(f'the patch names a quoted path git would unquote: {name[:80]}')
        if name == '/dev/null':
            return []
        first, _, path = name.partition('/')
        if not first or not path:
            raise BenchmarkError(f'the patch names {name[:80]!r} without the a/ or b/ git strips')
        return [path]
    for prefix in ('rename from ', 'rename to ', 'copy from ', 'copy to '):
        if line.startswith(prefix):
            return [line[len(prefix):]]
    if _SPECIAL_MODE.match(line):
        raise BenchmarkError('the patch makes a link or a submodule')
    if line.startswith(('GIT binary patch', 'Binary files ')):
        raise BenchmarkError('the patch changes a binary file')
    return []


def patch_paths(diff: str) -> tuple[str, ...]:
    """Every path ``diff`` names, read outside its hunks (a hunk's own lines are counted off by its header). Lines
    are split as git splits them, on ``\\n`` only; a patch holding any other line separator Python knows (a lone
    ``\\r``, ``\\f``, ``\\v``, ``\\x1c``-``\\x1e``, ``\\x85``, ``\\u2028``, ``\\u2029``) is refused, so no line can
    read as a hunk header here and as text to git."""
    if _OTHER_SEPARATORS.search(diff.replace('\r\n', '\n')):
        raise BenchmarkError('the patch holds a line separator other than a newline')
    paths: list[str] = []
    old = new = 0
    for line in diff.replace('\r\n', '\n').split('\n'):
        if old > 0 or new > 0:
            mark = line[:1]
            if mark not in {' ', '-', '+', '\\', ''}:
                raise BenchmarkError('a hunk of the patch ends before its header says')
            old -= mark in {' ', '-', ''}
            new -= mark in {' ', '+', ''}
            continue
        hunk = _HUNK.match(line)
        if hunk:
            old, new = int(hunk.group(1) or 1), int(hunk.group(2) or 1)
            continue
        paths.extend(_header_paths(line))
    return tuple(dict.fromkeys(paths))


def refuse_patch(diff: str, check: CommandCheck) -> None:
    """Refuse ``diff`` when it is too large, or names a path outside the repository, in ``.git``, protected, or
    outside the paths the case allows."""
    if len(diff.encode('utf-8')) > MAX_PATCH_BYTES:
        raise BenchmarkError(f'the patch is over its {MAX_PATCH_BYTES} bytes')
    for path in patch_paths(diff):
        plain = plain_path(path, 'a path of the patch')
        if check.protects(plain):
            raise BenchmarkError(f"the patch changes {plain}, which the case's check protects")
        if not check.permits(plain):
            raise BenchmarkError(f'the patch changes {plain}, outside the paths the case allows '
                                 f'({", ".join(check.allows)})')


def check_argv(tool: str, check: CommandCheck) -> tuple[str, ...]:
    """The check's argv as it runs: its tool by absolute path, and Python isolated (``-I``: no user site, no
    ``PYTHON*`` variable; ``-P``: no script or working directory prepended to ``sys.path``)."""
    isolation = PYTHON_ISOLATION if check.argv[0] == 'python3' else ()
    return (tool, *isolation, *check.argv[1:])


@dataclass(frozen=True)
class _Repository:
    """A fixture copy made a git repository, its git directory beside the working tree (never inside it)."""

    git: str
    tree: Path
    git_dir: Path
    home: Path

    def run(self, *args: str) -> Outcome:
        argv = (self.git, *_GIT_CONFIG, f'--git-dir={self.git_dir}', f'--work-tree={self.tree}', *args)
        return run_command(argv, cwd=self.tree, env=_git_environment(self.git, self.home),
                           timeout_seconds=GIT_TIMEOUT_SECONDS)

    def must(self, *args: str) -> None:
        outcome = self.run(*args)
        if outcome.exit_code != 0:
            raise BenchmarkError(f'git {args[0]} failed: {outcome.output}')


def _apply(repository: _Repository, diff: str, patch_file: Path) -> None:
    repository.must('init', '-q')
    repository.must('add', '-A')
    repository.must('commit', '-q', '--no-verify', '-m', 'the fixture')
    if not diff.strip():
        return
    patch_file.write_text(diff, encoding='utf-8')
    checked = repository.run('apply', '--check', str(patch_file))
    if checked.exit_code != 0:
        raise BenchmarkError(f'git apply --check refused the patch: {checked.output}')
    repository.must('apply', str(patch_file))
    walk_fixture(repository.tree)


def _command_case(case: Case, check: CommandCheck, diff: str, tools: Tools, work: Path) -> tuple[bool, str]:
    refuse_patch(diff, check)
    tool = tools.path(check.argv[0])
    if not tools.git or not tool:
        return False, f'{check.argv[0] if tools.git else "git"} is not installed here'
    tree, home = work / 'repo', work / 'home'
    shutil.copytree(case.fixture, tree, symlinks=True)
    home.mkdir()
    _apply(_Repository(tools.git, tree, work / 'repo.git', home), diff, work / 'attempt.diff')
    outcome = run_command(check_argv(tool, check), cwd=tree / check.cwd, env=check_environment(tools, home),
                          timeout_seconds=check.timeout_seconds)
    if outcome.timed_out:
        return False, f'the check timed out after {check.timeout_seconds} s: {outcome.output}'
    if outcome.exit_code != 0:
        return False, f'the check failed (exit {outcome.exit_code}): {outcome.output}'
    return True, 'the check passed'


def score_review(check: ReviewCheck, findings: Iterable[ReportedFinding]) -> tuple[bool, str]:
    """Every expected finding matched, and at most ``max_false_positives`` reported findings matching none."""
    reported = tuple(findings)
    missed = [e.label for e in check.findings if not any(e.matches(f.file, f.line, f.rule) for f in reported)]
    extra = [f for f in reported if not any(e.matches(f.file, f.line, f.rule) for e in check.findings)]
    if missed:
        return False, f'{len(missed)} expected finding(s) missed: {"; ".join(missed)}'
    if len(extra) > check.max_false_positives:
        return False, (f'{len(extra)} finding(s) match none expected, over the case\'s {check.max_false_positives}: '
                       + '; '.join(f'{f.rule} in {f.file}:{f.line}' for f in extra[:5]))
    return True, f'every expected finding reported ({len(check.findings)}), {len(extra)} other(s)'


def _judge(case: Case, attempt: Attempt, tools: Tools, work: Path) -> tuple[bool, str]:
    check = case.check
    if isinstance(check, ReviewCheck):
        if attempt.diff:
            return False, 'a review answers with findings, not a patch'
        return score_review(check, attempt.findings)
    if attempt.findings:
        return False, f'a {case.kind} answers with a patch, not findings'
    return _command_case(case, check, attempt.diff, tools, work)


def printable(text: str) -> str:
    """``text`` without NUL and the other control characters (newlines and tabs kept), so a check's output can
    always become a reason the skills store records."""
    return _CONTROL.sub('', text)


def _bounded_why(why: str) -> str:
    """``why`` within ``MAX_WHY``, printable: its start (what failed) and its end (the check's last output)."""
    why = printable(why)
    if len(why) <= MAX_WHY:
        return why
    return f'{why[:WHY_HEAD]}…{why[-(MAX_WHY - WHY_HEAD - 1):]}'


def _untrusted(value: object) -> object:
    """``value`` as what a candidate's code may really return (whatever its annotation says): checked, never trusted."""
    return value


def run_case(case: Case, candidate: Candidate, tools: Tools) -> CaseResult:
    """``candidate``'s attempt at ``case``, checked in a fresh temporary repository. Whatever the candidate's
    ``solve`` raises fails this case alone, with a bounded, scrubbed reason."""
    with tempfile.TemporaryDirectory(prefix='voc-bench-') as scratch:
        work = Path(scratch)
        view = work / 'view'
        shutil.copytree(case.fixture, view, symlinks=True)
        try:
            attempt = _untrusted(candidate.solve(CaseView(case.id, case.kind, case.title, case.task, view)))
        except (CandidateError, BenchmarkError) as exc:
            return CaseResult(case.id, False, _bounded_why(scrub_text(f'the candidate gave no attempt: {exc}')))
        except (Exception, SystemExit) as exc:  # noqa: BLE001 — a candidate's own bug (a sys.exit too) fails its case
            why = f'the candidate failed: {type(exc).__name__}: {exc}'
            return CaseResult(case.id, False, _bounded_why(scrub_text(why)))
        if not isinstance(attempt, Attempt):   # (a candidate's own bug: None, a dict) its case fails, alone
            return CaseResult(case.id, False, f'the candidate gave no attempt: {type(attempt).__name__}')
        try:
            passed, why = _judge(case, attempt, tools, work / 'check')
        except BenchmarkError as exc:
            passed, why = False, f'refused: {exc}'
        except (UnicodeError, TypeError, ValueError, AttributeError) as exc:
            # A malformed attempt (a diff that is not text, or holds a lone surrogate): its case fails, alone.
            passed, why = False, scrub_text(f'refused: a malformed attempt ({type(exc).__name__})')
        except OSError as exc:
            # The machine's own failure while checking it (a full disk, a missing tool): this case fails, alone.
            passed, why = False, scrub_text(f'the check could not run: {type(exc).__name__}: {exc}')
    return CaseResult(case.id, passed, _bounded_why(why), input_tokens=attempt.input_tokens,
                      output_tokens=attempt.output_tokens, cost_usd=attempt.cost_usd, seconds=attempt.seconds)


def run_suite(cases: Sequence[Case], candidate: Candidate, tools: Tools | None = None) -> Scorecard:
    """``candidate``'s scorecard on ``cases``, one case after another."""
    found = tools or Tools.installed()
    return Scorecard(candidate.name, tuple(run_case(case, candidate, found) for case in cases))
