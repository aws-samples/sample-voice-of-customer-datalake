"""The runner on the shipped suite and on probe cases: patches, checks, environments, reviews and scorecards."""
from __future__ import annotations

import math
import shutil
from collections.abc import Callable
from pathlib import Path

import pytest

from engineering.benchmark.cases import BenchmarkError, CommandCheck, ExpectedFinding, ReviewCheck, load_case
from engineering.benchmark.runner import (
    MAX_PATCH_BYTES,
    Attempt,
    CaseResult,
    CaseView,
    ReportedFinding,
    Scorecard,
    Tools,
    check_argv,
    check_environment,
    patch_paths,
    run_case,
    run_suite,
    score_review,
)
from engineering.benchmark.test.fixtures import (
    CASES,
    DURATION,
    MONOREPO,
    REVIEW,
    SLUG,
    SUITE,
    Answers,
    Scripted,
    attempt,
    known_fix,
    needs_node,
    replays_every_fix,
    write_case,
)

TOOLS = Tools.installed()
SLUG_FIX = known_fix(SLUG).diff


def probe(tmp_path: Path, code: str, timeout_seconds: int = 30) -> CaseResult:
    """A probe case whose check is ``python3 -c code``, run with an empty patch."""
    case = load_case(write_case(tmp_path, check={'argv': ['python3', '-c', code], 'cwd': '',
                                                 'timeout_seconds': timeout_seconds, 'protected': []}))
    return run_case(case, Answers('empty', attempt()), TOOLS)


@needs_node
def test_the_known_fixes_pass_every_shipped_case() -> None:
    card = run_suite(SUITE, replays_every_fix(), TOOLS)
    assert card.candidate == 'known-fixes'
    assert [(r.case_id, r.passed) for r in card.results] == [(case.id, True) for case in SUITE]
    assert card.pass_rate == 1.0
    assert math.isclose(card.total_cost_usd, 0.04)
    assert math.isclose(card.total_seconds, 8.0)
    assert {(r.input_tokens, r.output_tokens) for r in card.results} == {(1200, 300)}
    assert card.result(REVIEW) == CaseResult(REVIEW, True, 'every expected finding reported (3), 0 other(s)',
                                             1200, 300, 0.01, 2.0)
    assert card.result('no-such-case') is None


@needs_node
def test_a_candidate_that_gives_up_fails_every_case_and_says_why() -> None:
    card = run_suite(SUITE, Scripted('gives-up', frozenset()), TOOLS)
    assert card.pass_rate == 0.0
    whys = {r.case_id: r.why for r in card.results}
    assert whys[SLUG].startswith('the check failed (exit 1)')
    assert 'test_a_slug_may_be_exactly_max_length' in whys[SLUG]
    assert "'1h 2m 5s'" in whys[DURATION]
    assert '-104 !== -40' in whys[MONOREPO]
    assert whys[REVIEW].startswith('3 expected finding(s) missed: off-by-one in export_pages.py:10-10')


def test_the_candidate_gets_its_own_copy_of_the_fixture_and_nothing_else() -> None:
    seen: list[CaseView] = []

    class Vandal:
        name = 'vandal'

        def solve(self, case: CaseView) -> Attempt:
            seen.append(case)
            files = sorted(p.relative_to(case.repository).as_posix() for p in case.repository.rglob('*'))
            assert files == ['README.md', 'slugs.py', 'test_slugs.py']
            (case.repository / 'slugs.py').write_text('broken = True\n')   # its copy only
            return attempt(diff=SLUG_FIX)

    result = run_case(CASES[SLUG], Vandal(), TOOLS)
    assert (result.passed, result.why) == (True, 'the check passed')
    assert (seen[0].id, seen[0].kind, seen[0].title) == (SLUG, 'bug', CASES[SLUG].title)
    assert 'def slugify' in (CASES[SLUG].fixture / 'slugs.py').read_text()
    assert not seen[0].repository.exists()   # the temporary directory is gone


def patch(path: str, body: str = '@@ -0,0 +1 @@\n+x = 1\n') -> str:
    return f'diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n{body}'


@pytest.mark.parametrize(('diff', 'why'), [
    (patch('../outside.py'), "refused: a path of the patch '../outside.py' is not a plain relative path"),
    (patch('.git/hooks/pre-commit'), "refused: a path of the patch '.git/hooks/pre-commit' names a .git directory"),
    ('--- a/slugs.py\n+++ b//etc/passwd\n@@ -1 +1 @@\n-x\n+y\n', "refused: a path of the patch '/etc/passwd'"),
    ('--- a/slugs.py\n+++ /etc/passwd\n@@ -1 +1 @@\n-x\n+y\n', 'without the a/ or b/ git strips'),
    ('--- slugs.py\n+++ slugs.py\n@@ -1 +1 @@\n-x\n+y\n', 'without the a/ or b/ git strips'),
    ('diff --git "a/sp ace.py" "b/sp ace.py"\n', 'a path git would quote or split'),
    (patch('test_slugs.py'), "refused: the patch changes test_slugs.py, which the case's check protects"),
    (patch('Test_Slugs.py'), 'which the case\'s check protects'),
    (patch('test_aa.py', '@@ -0,0 +1 @@\n+import os; os._exit(0)\n'),
     'refused: the patch changes test_aa.py, outside the paths the case allows (slugs.py)'),
    (patch('unittest.py'), 'outside the paths the case allows'),
    ('diff --git a/link b/link\nnew file mode 120000\n', 'refused: the patch makes a link or a submodule'),
    ('diff --git a/sub b/sub\nindex 0000000..1234567 160000\n', 'makes a link or a submodule'),
    ('diff --git a/x.bin b/x.bin\nGIT binary patch\nliteral 1\n', 'refused: the patch changes a binary file'),
    ('diff --git a/slugs.py b/slugs.py\nrename from slugs.py\nrename to ../slugs.py\n', "'../slugs.py'"),
    ('--- a/slugs.py\n+++ b/slugs.py\n@@ -1,3 +1,3 @@\n x\nnot a hunk line\n', 'a hunk of the patch ends before'),
    (patch('big.py', '@@ -0,0 +1 @@\n+' + 'x' * MAX_PATCH_BYTES + '\n'), f'over its {MAX_PATCH_BYTES} bytes'),
    ('--- a/slugs.py\n+++ b/slugs.py\n@@ -1 +1 @@\n-no such line\n+x\n', 'git apply --check refused the patch'),
])
def test_a_patch_is_refused_before_it_reaches_the_check(diff: str, why: str) -> None:
    result = run_case(CASES[SLUG], Answers('cheat', attempt(diff=diff)), TOOLS)
    assert not result.passed
    assert why in result.why
    assert result.input_tokens == 1200   # what it cost is kept, refused or not


def test_a_patch_unittest_module_shadows_nothing(tmp_path: Path) -> None:
    """A case with no ``allows`` takes a new, unprotected ``unittest.py``; the isolated interpreter never imports
    it in place of the standard library's, so the failing test still fails."""
    test = ('import unittest\nfrom calc import add\n\n\nclass AddTest(unittest.TestCase):\n'
            '    def test_add(self):\n        self.assertEqual(add(2, 2), 4)\n')
    case = load_case(write_case(tmp_path, files={'calc.py': 'def add(a, b):\n    return a - b\n',
                                                 'test_calc.py': test},
                                check={'argv': ['python3', '-m', 'unittest'], 'cwd': '', 'timeout_seconds': 30,
                                       'protected': ['test_calc.py']}))
    shadow = patch('unittest.py', '@@ -0,0 +1 @@\n+raise SystemExit(0)\n')
    result = run_case(case, Answers('shadow', attempt(diff=shadow)), TOOLS)
    assert result.why.startswith('the check failed (exit 1)')
    assert 'test_add' in result.why
    slug, units = CASES[SLUG].check, CASES[MONOREPO].check
    assert isinstance(slug, CommandCheck)
    assert isinstance(units, CommandCheck)
    assert check_argv('/usr/bin/python3', slug) == ('/usr/bin/python3', '-I', '-P', '-m', 'unittest')
    assert check_argv('/usr/bin/node', units) == ('/usr/bin/node', '--test')


@pytest.mark.parametrize('separator', ['\x0c', '\x0b', '\r', '\x1c', '\x85', '\u2028', '\u2029'])
def test_a_line_separator_git_does_not_split_on_is_refused(tmp_path: Path, separator: str) -> None:
    """A line git reads as text and splitlines as two lines, one a hunk header that swallows the protected file's
    own header: refused before git reads the patch, so the protected test is never changed."""
    case = load_case(write_case(tmp_path, files={'main.py': 'x = 1\n', 'tests/test_x.py': 'y = 1\n'}, check={
        'argv': ['python3', 'main.py'], 'cwd': '', 'timeout_seconds': 30, 'protected': ['tests']}))
    diff = '\n'.join(['--- a/main.py', '+++ b/main.py', '@@ -1 +1 @@', '-x = 1', '+x = 2',
                      f'note{separator}@@ -1,2 +1,2 @@', '--- a/tests/test_x.py', '+++ b/tests/test_x.py',
                      '@@ -1 +1 @@', '-y = 1', '+y = 2', ''])
    result = run_case(case, Answers('splitter', attempt(diff=diff)), TOOLS)
    assert result.why.startswith('refused: the patch holds a line separator other than a newline')
    assert patch_paths('--- a/main.py\r\n+++ b/main.py\r\n@@ -1 +1 @@\r\n-x\r\n+y\r\n') == ('main.py',)   # (CRLF)


@pytest.mark.parametrize('header', ['+++ "b/tests/\\164est_x.py"', '--- "a/tests/\\164est_x.py"'])
def test_a_quoted_header_path_is_refused_where_git_would_unquote_it(tmp_path: Path, header: str) -> None:
    """``"b/tests/\\164est_x.py"`` is git's quoting of ``tests/test_x.py``: refused on a case with no ``allows``,
    where only ``protected`` stands between it and the check's own test."""
    case = load_case(write_case(tmp_path, files={'main.py': 'x = 1\n', 'tests/test_x.py': 'y = 1\n'}, check={
        'argv': ['python3', 'main.py'], 'cwd': '', 'timeout_seconds': 30, 'protected': ['tests']}))
    other = '--- a/main.py' if header.startswith('+++') else '+++ b/main.py'
    lines = [header, other] if header.startswith('---') else [other, header]
    diff = '\n'.join([*lines, '@@ -1 +1 @@', '-y = 1', '+y = 2', ''])
    result = run_case(case, Answers('quoter', attempt(diff=diff)), TOOLS)
    assert result.why.startswith('refused: the patch names a quoted path git would unquote')


def test_control_characters_never_reach_a_reason(tmp_path: Path) -> None:
    result = probe(tmp_path, 'import sys; print("bad\\x00byte\\x1b[31m red\\x7f\\tend"); sys.exit(1)')
    assert result.why == 'the check failed (exit 1): badbyte[31m red\tend'


def test_a_hunk_line_that_looks_like_a_header_is_not_read_as_one() -> None:
    diff = ('diff --git a/q.sql b/q.sql\n--- a/q.sql\n+++ b/q.sql\n@@ -1 +1 @@\n'
            '--- a/elsewhere\n+++ b/elsewhere\n\\ No newline at end of file\n'
            'diff --git a/q.sql b/r.sql\nrename from q.sql\nrename to r.sql\n')
    assert patch_paths(diff) == ('q.sql', 'r.sql')
    assert patch_paths('--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+b\n') == ('x.py',)
    assert patch_paths('--- /dev/null\n+++ b/new.py\n@@ -0,0 +1 @@\n+a\n') == ('new.py',)


def test_an_answer_of_the_wrong_kind_fails() -> None:
    finding = ReportedFinding('slugs.py', 1, 'off-by-one')
    assert run_case(CASES[SLUG], Answers('reviewer', attempt(findings=(finding,))), TOOLS).why == (
        'a bug answers with a patch, not findings')
    assert run_case(CASES[REVIEW], Answers('patcher', attempt(diff=SLUG_FIX)), TOOLS).why == (
        'a review answers with findings, not a patch')


def test_a_candidate_that_fails_gives_a_failed_case() -> None:
    result = run_case(CASES[SLUG], Answers('silent', None), TOOLS)
    assert result == CaseResult(SLUG, False, 'the candidate gave no attempt: the model timed out on slug-cut-bug')


@pytest.mark.parametrize('diff', ['--- a/slugs.py\n+++ b/slugs.py\n@@ -1 +1 @@\n-x\n+\ud800\n', 42],
                         ids=['lone-surrogate', 'not-text'])
def test_a_malformed_attempt_fails_its_case_alone(diff: object) -> None:
    result = run_case(CASES[SLUG], Answers('malformed', Attempt(diff=diff)), TOOLS)  # pyright: ignore[reportArgumentType]
    assert (result.passed, result.why.startswith('refused: a malformed attempt')) == (False, True)


class _Returns:
    name = 'returns'

    def __init__(self, given: object) -> None:
        self.given = given

    def solve(self, case: CaseView) -> Attempt:
        del case   # (every case gets the same answer)
        if self.given == 'exit':
            raise SystemExit(0)
        return self.given  # pyright: ignore[reportReturnType]


@pytest.mark.parametrize(('given', 'why'), [(None, 'the candidate gave no attempt: NoneType'),
                                            ({}, 'the candidate gave no attempt: dict'),
                                            ('exit', 'the candidate failed: SystemExit: 0')])
def test_a_candidate_that_returns_no_attempt_or_exits_fails_its_case_alone(given: object, why: str) -> None:
    card = run_suite(SUITE, _Returns(given), TOOLS)
    assert [(r.case_id, r.passed, r.why) for r in card.results] == [(case.id, False, why) for case in SUITE]


def test_an_os_error_while_checking_fails_its_case_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    import engineering.benchmark.runner as runner_module

    def full_disk(*_: object, **__: object) -> tuple[bool, str]:
        raise OSError(28, 'No space left on device')

    monkeypatch.setattr(runner_module, '_judge', full_disk)
    result = run_case(CASES[SLUG], replays_every_fix(), TOOLS)
    assert (result.passed, result.why) == (False, 'the check could not run: OSError: [Errno 28] No space left on device')


def test_a_candidate_that_crashes_fails_its_case_and_the_suite_goes_on() -> None:
    class Crashes:
        name = 'crashes'

        def solve(self, case: CaseView) -> Attempt:
            if case.id == SLUG:
                secret = 'password=' + 'hunter2'   # put together here: no secret-shaped literal in this file
                raise KeyError(f'{secret} ' + 'x' * 5_000)
            return known_fix(case.id)

    card = run_suite(SUITE, Crashes(), TOOLS)
    crashed = card.result(SLUG)
    assert crashed is not None
    assert not crashed.passed
    assert crashed.why.startswith("the candidate failed: KeyError: 'password=[masked]")
    assert 'hunter2' not in crashed.why
    assert len(crashed.why) <= 1_000
    assert [r.case_id for r in card.results] == [case.id for case in SUITE]   # every other case still ran
    assert card.result(REVIEW) == CaseResult(REVIEW, True, 'every expected finding reported (3), 0 other(s)',
                                             1200, 300, 0.01, 2.0)


def test_a_missing_tool_fails_the_case_and_says_which() -> None:
    no_node = Tools(python3=TOOLS.python3, node='', git=TOOLS.git)
    assert run_case(CASES[MONOREPO], Answers('a', attempt()), no_node).why == 'node is not installed here'
    no_git = Tools(python3=TOOLS.python3, node=TOOLS.node, git='')
    assert run_case(CASES[SLUG], Answers('a', attempt()), no_git).why == 'git is not installed here'
    broken_git = Tools(python3=TOOLS.python3, node=TOOLS.node, git=shutil.which('false') or '/bin/false')
    assert run_case(CASES[SLUG], Answers('a', attempt()), broken_git).why.startswith('refused: git init failed')


def test_the_check_gets_an_environment_built_from_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE', 'GITHUB_TOKEN', 'HTTPS_PROXY',
                 'http_proxy', 'NO_PROXY', 'PYTHONPATH'):
        monkeypatch.setenv(name, 'from-the-runner')
    tools = Tools(python3='/opt/py/bin/python3', node='/opt/node/bin/node', git='/usr/bin/git')
    env = check_environment(tools, tmp_path)
    assert env == {'PATH': '/opt/py/bin:/opt/node/bin', 'HOME': str(tmp_path), 'TMPDIR': str(tmp_path),
                   'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'TZ': 'UTC', 'CI': 'true', 'NO_COLOR': '1',
                   'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1'}
    assert check_environment(Tools('/usr/bin/python3', '/usr/bin/node', ''), tmp_path)['PATH'] == '/usr/bin'
    code = ('import os, sys; leaked = [k for k in os.environ if k.upper().startswith(("AWS", "GITHUB")) '
            'or "PROXY" in k.upper() or k == "PYTHONPATH"]; print("leaked", leaked); sys.exit(3 if leaked else 0)')
    assert probe(tmp_path, code) == CaseResult('probe', True, 'the check passed', 1200, 300, 0.01, 2.0)


def test_a_check_that_fails_or_hangs_says_so(tmp_path: Path) -> None:
    failed = probe(tmp_path / 'a', 'import sys; print("one test failed"); sys.exit(2)')
    assert failed.why == 'the check failed (exit 2): one test failed'
    hung = probe(tmp_path / 'b', 'import time; print("waiting", flush=True); time.sleep(60)', timeout_seconds=1)
    assert hung.why == 'the check timed out after 1 s: waiting'


def test_a_check_output_is_scrubbed_and_bounded(tmp_path: Path) -> None:
    # The key-shaped text is put together by the check, so no key-shaped literal sits in this file.
    result = probe(tmp_path, 'import sys; print("x" * 50_000); print("AKIA" + "ABCDEFGHIJKLMNOP"); '
                             'print("password=hunter2"); sys.exit(1)')
    assert result.why.startswith('the check failed (exit 1): ')
    assert 'AKIA' not in result.why
    assert result.why.endswith('[masked]\npassword=[masked]')
    assert len(result.why) <= 1_000


def test_the_check_runs_in_its_cwd_with_its_tool_by_absolute_path(tmp_path: Path) -> None:
    code = 'import os, sys; sys.exit(0 if os.path.isfile("main.py") and sys.executable.startswith("/") else 4)'
    case = load_case(write_case(tmp_path, files={'pkg/main.py': 'x = 1\n'}, check={
        'argv': ['python3', '-c', code], 'cwd': 'pkg', 'timeout_seconds': 30, 'protected': []}))
    assert run_case(case, Answers('empty', attempt()), TOOLS).passed


def test_a_patch_applies_to_a_repository_with_its_git_directory_beside_it(tmp_path: Path) -> None:
    code = 'import os, sys; sys.exit(0 if open("main.py").read() == "x = 2\\n" and not os.path.exists(".git") else 5)'
    case = load_case(write_case(tmp_path, files={'main.py': 'x = 1\n'}, check={
        'argv': ['python3', '-c', code], 'cwd': '', 'timeout_seconds': 30, 'protected': []}))
    diff = 'diff --git a/main.py b/main.py\n--- a/main.py\n+++ b/main.py\n@@ -1 +1 @@\n-x = 1\n+x = 2\n'
    assert run_case(case, Answers('fixer', attempt(diff=diff)), TOOLS).why == 'the check passed'


EXPECTED = ReviewCheck(findings=(ExpectedFinding('a.py', 3, 5, 'off-by-one'),
                                 ExpectedFinding('b.py', 9, 9, 'unit-mismatch')), max_false_positives=1)


@pytest.mark.parametrize(('reported', 'passed', 'why'), [
    ([('a.py', 4, 'off-by-one'), ('b.py', 9, 'unit-mismatch')], True, 'every expected finding reported (2), 0 other'),
    ([('a.py', 3, 'off-by-one'), ('a.py', 5, 'off-by-one'), ('b.py', 9, 'unit-mismatch'), ('c.py', 1, 'other')],
     True, '1 other(s)'),
    ([('a.py', 4, 'off-by-one'), ('b.py', 9, 'unit-mismatch'), ('c.py', 1, 'other'), ('a.py', 9, 'other')],
     False, "2 finding(s) match none expected, over the case's 1: other in c.py:1; other in a.py:9"),
    ([('a.py', 6, 'off-by-one'), ('b.py', 9, 'unit-mismatch')], False, '1 expected finding(s) missed: off-by-one'),
    ([('a.py', 4, 'unit-mismatch'), ('b.py', 9, 'unit-mismatch')], False, 'missed: off-by-one in a.py:3-5'),
    ([], False, '2 expected finding(s) missed'),
])
def test_a_review_is_scored_on_every_expected_finding_and_its_false_positives(
        reported: list[tuple[str, int, str]], passed: bool, why: str) -> None:
    verdict, reason = score_review(EXPECTED, [ReportedFinding(*finding) for finding in reported])
    assert verdict is passed
    assert why in reason


@pytest.mark.parametrize(('make', 'message'), [
    (lambda: Attempt(input_tokens=-1), 'tokens are whole numbers'),
    (lambda: Attempt(output_tokens=10**10), 'tokens are whole numbers'),
    (lambda: Attempt(cost_usd=math.nan), 'the cost is a finite amount'),
    (lambda: Attempt(cost_usd=-0.5), 'the cost is a finite amount'),
    (lambda: Attempt(seconds=math.inf), 'the time is a finite amount'),
    (lambda: Attempt(findings=(ReportedFinding('a.py', 1, 'r'),) * 101), 'at most 100 findings'),
])
def test_an_attempt_is_bounded(make: Callable[[], Attempt], message: str) -> None:
    with pytest.raises(BenchmarkError, match=message):
        make()


@pytest.mark.parametrize(('file', 'line', 'rule', 'message'), [
    ('', 1, 'r', 'a finding names a file'), ('a.py', 1, '', 'a rule'), ('a.py', 1, 'r' * 41, 'a rule'),
    ('a' * 513, 1, 'r', 'a file'), ('a.py', 0, 'r', "a finding's line is from 1"),
])
def test_a_reported_finding_is_bounded(file: str, line: int, rule: str, message: str) -> None:
    with pytest.raises(BenchmarkError, match=message):
        ReportedFinding(file, line, rule)


def test_a_reported_finding_that_breaks_its_bounds_fails_the_case() -> None:
    class Sloppy:
        name = 'sloppy'

        def solve(self, case: CaseView) -> Attempt:
            return attempt(findings=(ReportedFinding(case.id, 0, 'off-by-one'),))

    assert run_case(CASES[REVIEW], Sloppy(), TOOLS).why.startswith("the candidate gave no attempt: a finding's line")


def test_a_scorecard_holds_one_result_per_case() -> None:
    one = CaseResult('a', True, 'ok')
    with pytest.raises(BenchmarkError, match='one per case'):
        Scorecard('c', (one, one))
    with pytest.raises(BenchmarkError, match='1-100 results'):
        Scorecard('c', ())
    card = Scorecard('c', (one, CaseResult('b', False, 'no')))
    assert (card.pass_rate, card.case_ids) == (0.5, ('a', 'b'))


def test_the_tools_are_found_on_this_machine() -> None:
    assert TOOLS.python3.startswith('/')
    assert TOOLS.git.startswith('/')
    assert TOOLS.path('python3') == TOOLS.python3
    assert TOOLS.path('bash') == ''   # a check's argv names python3 or node, nothing else
