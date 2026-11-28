"""A verdict file: its front matter, its evidence and the product paths its break must touch."""
from __future__ import annotations

from typing import Any

import planted
import pytest
from feature_gate import verdict

DIGEST = 'a' * 64
COMMAND = 'bash scripts/pinned.sh x'


def text(**change: Any) -> str:
    args: dict[str, Any] = {'item_id': '7.76.00', 'test': planted.PYTEST_ID, 'digest': DIGEST, 'command': COMMAND}
    return planted.verdict_text(**(args | change))


def problems(**change: Any) -> list[str]:
    return verdict.evidence_problems(verdict.parse(text(**change)), COMMAND, planted.PYTEST_ID)


def green_with(first: str) -> str:
    """Three green runs, the first showing ``first``."""
    return '\n'.join(f'```\n{run}\n```' for run in (first, '1 passed in 0.2s', '1 passed in 0.2s'))


def test_the_front_matter_and_sections_are_read():
    parsed = verdict.parse(text())
    assert parsed.front == {'item': '7.76.00', 'test': planted.PYTEST_ID, 'digest': DIGEST, 'verdict': 'ACCEPT',
                            'evaluator': 'eval-1/a', 'author': 'h2/a', 'sha': planted.SHA, 'tree': planted.TREE}
    assert parsed.checks == dict.fromkeys(planted.CHECKS, True)
    assert list(parsed.sections) == ['Item', 'Command', 'Break', 'Red', 'Green', 'Reasons']
    assert parsed.sections['Reasons'] == 'It asserts the count the user sees.'


@pytest.mark.parametrize(('bad', 'message'), [
    ('## Item\n\nx\n', 'front matter'),
    ('---\nitem: x\n  tests_item: true\n---\n', 'only under checks:'),
    ('---\nitem x\n---\n', 'without a colon'),
    ('---\nitem: x\n---\n' + 'y' * 300_000, 'over'),
])
def test_a_malformed_file_is_refused(bad: str, message: str):
    with pytest.raises(ValueError, match=message):
        verdict.parse(bad)


def test_a_heading_inside_a_fence_is_no_section():
    parsed = verdict.parse(text(sections={'Red': planted.red_block(planted.PYTEST_ID) + '\n```\n## Green\n```'}))
    assert list(parsed.sections) == ['Item', 'Command', 'Break', 'Red', 'Green', 'Reasons']
    assert '## Green' in parsed.sections['Red']


def test_a_full_accept_has_no_evidence_problem():
    assert problems() == []


@pytest.mark.parametrize(('change', 'message'), [
    ({'checks': {'fails_on_break': False}}, 'checks: fails_on_break is not true (an ACCEPT needs every check)'),
    ({'sections': {'Break': '```diff\n```'}}, 'Break: no ```diff block (the break the evaluator applied)'),
    ({'sections': {'Break': 'I commented the line out.'}}, 'Break: no ```diff block (the break the evaluator applied)'),
    ({'sections': {'Red': ''}}, 'Red: no output of the test failing on the break'),
    ({'sections': {'Red': '```\n1 failed\n```'}}, f'Red: the output does not name the test ({planted.PYTEST_ID})'),
    ({'sections': {'Red': f'```\n{planted.PYTEST_ID} ok\n```'}}, 'Red: the output shows no failure'),
    ({'sections': {'Green': '```\n1 passed\n```'}}, 'Green: fewer than 3 passing runs'),
    ({'sections': {'Green': green_with('1 passed, 2 skipped')}}, 'Green: run 1 does not show 1 passed and 0 skipped'),
    ({'sections': {'Green': green_with('2 passed')}}, 'Green: run 1 does not show 1 passed and 0 skipped'),
    ({'sections': {'Green': green_with('11 passed')}}, 'Green: run 1 does not show 1 passed and 0 skipped'),
    ({'sections': {'Reasons': ''}}, 'Reasons: empty'),
    ({'sections': {'Command': '```bash\nbash other\n```'}}, f'Command: does not hold the pinned command ({COMMAND})'),
    ({'sha': 'HEAD'}, "sha: 'HEAD' is not a commit sha (7 to 40 hex digits)"),
])
def test_an_accept_without_its_evidence_is_refused(change: dict, message: str):
    assert problems(**change) == [message]


VITEST_GOOD = ' \N{CHECK MARK} src/widget.test.ts > Widget > counts 3ms\n Tests  1 passed | 12 skipped (13)'


def vitest_problems(first: str) -> list[str]:
    """A vitest verdict whose first Green run shows ``first`` (the other two are good)."""
    runs = '\n'.join(f'```\n{run}\n```' for run in (first, VITEST_GOOD, VITEST_GOOD))
    red = '```\n\N{MULTIPLICATION SIGN} src/widget.test.ts > Widget > counts\n Tests  1 failed | 12 skipped\n```'
    parsed = verdict.parse(text(test=planted.VITEST_ID, sections={'Green': runs, 'Red': red}))
    return verdict.evidence_problems(parsed, COMMAND, 'counts', 'vitest')


def test_a_vitest_green_may_show_the_files_other_tests_skipped():
    assert vitest_problems(VITEST_GOOD) == []


@pytest.mark.parametrize('first', [
    ' \N{CHECK MARK} src/widget.test.ts > Widget > counts\n Tests  2 passed | 11 skipped (13)',
    ' \N{CHECK MARK} src/widget.test.ts > Widget > counts\n Tests  1 failed | 1 passed | 11 skipped (13)',
    ' \N{CHECK MARK} src/widget.test.ts > Widget > adds 1\n Tests  1 passed | 12 skipped (13)',
    ' Tests  1 passed | 12 skipped (13)',
    ' \N{MULTIPLICATION SIGN} src/widget.test.ts > Widget > counts\n Tests  1 passed | 12 skipped (13)',
])
def test_a_vitest_green_needs_exactly_one_pass_no_failure_and_its_own_passing_line(first: str):
    assert vitest_problems(first) == [
        "Green: run 1 does not show exactly 1 passed, 0 failed and 'counts' on a passing line"]


@pytest.mark.parametrize('runner', ['pytest', 'playwright'])
def test_pytest_and_playwright_keep_no_skip(runner: str):
    parsed = verdict.parse(text(sections={'Green': green_with(f'{planted.PYTEST_ID} PASSED\n1 passed, 3 skipped')}))
    assert verdict.evidence_problems(parsed, COMMAND, planted.PYTEST_ID, runner) == [
        'Green: run 1 does not show 1 passed and 0 skipped']


def diff_of(path: str, minus: str, plus: str) -> str:
    return (f'diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1,1 +1,1 @@\n'
            f'-{minus}\n+{plus}\n')


def break_problems(diff: str) -> list[str]:
    return problems(sections={'Break': f'```diff\n{diff}```'})


def test_every_file_of_the_break_must_be_product_code():
    mixed = planted.BREAK + diff_of('voc-datalake/lambda/api/test/test_widget.py', '    assert x', '    assert y')
    assert break_problems(mixed) == [(
        'Break: voc-datalake/lambda/api/test/test_widget.py is not product code '
        '(voc-datalake/lambda, frontend/src, lib; tests, test support and fixtures excluded)')]


@pytest.mark.parametrize('path', ['voc-datalake/lambda/api/fixtures/rows.py', 'voc-datalake/lib/stack_fixtures.ts',
                                  'voc-datalake/frontend/src/test/setup.ts'])
def test_fixtures_and_test_support_are_no_product_code(path: str):
    assert break_problems(diff_of(path, 'a = 1', 'a = 2'))[0].startswith(f'Break: {path} is not product code')


@pytest.mark.parametrize(('minus', 'plus'), [('# old', '# new'), ('// old', '// new'), ('', '   '),
                                             (' * a doc line', ' * another')])
def test_a_break_that_changes_only_comments_is_refused(minus: str, plus: str):
    diff = diff_of('voc-datalake/lambda/api/widget.py', minus, plus)
    assert break_problems(diff) == ['Break: voc-datalake/lambda/api/widget.py changes no code line (comments only)']


def test_a_new_product_file_counts_by_its_new_path():
    diff = ('diff --git a/voc-datalake/lambda/api/new.py b/voc-datalake/lambda/api/new.py\n--- /dev/null\n'
            '+++ b/voc-datalake/lambda/api/new.py\n@@ -0,0 +1 @@\n+x = 1\n')
    assert break_problems(diff) == []


def test_the_diff_is_read_per_file():
    two = planted.BREAK + diff_of('voc-datalake/lib/stack.ts', 'a', 'b')
    assert [f.path for f in verdict.diff_files(two)] == ['voc-datalake/lambda/api/widget.py', 'voc-datalake/lib/stack.ts']
    assert verdict.diff_files(two)[0].changed == ['    return len(items)', '    return 0']


def test_a_plain_diff_u_of_two_files_is_two_files():
    plain = ('--- a/voc-datalake/lambda/api/widget.py\n+++ b/voc-datalake/lambda/api/widget.py\n@@ -1,2 +1,2 @@\n'
             ' def count(items):\n-    return len(items)\n+    return 0\n'
             '--- a/voc-datalake/lambda/api/test/test_widget.py\n+++ b/voc-datalake/lambda/api/test/test_widget.py\n'
             '@@ -1 +1 @@\n-x = 1\n+x = 2\n')
    assert [f.path for f in verdict.diff_files(plain)] == ['voc-datalake/lambda/api/widget.py',
                                                           'voc-datalake/lambda/api/test/test_widget.py']
    assert break_problems(plain)[0].startswith('Break: voc-datalake/lambda/api/test/test_widget.py is not product code')


def test_a_removed_line_that_looks_like_a_header_stays_in_its_hunk():
    diff = ('--- a/voc-datalake/lambda/api/widget.py\n+++ b/voc-datalake/lambda/api/widget.py\n@@ -1 +1 @@\n'
            '--- a/elsewhere.py\n+++ b/elsewhere.py\n')   # the hunk removes "-- a/elsewhere.py", adds "++ b/elsewhere.py"
    got = verdict.diff_files(diff)
    assert [f.path for f in got] == ['voc-datalake/lambda/api/widget.py']
    assert got[0].changed == ['-- a/elsewhere.py', '++ b/elsewhere.py']


@pytest.mark.parametrize('runner', ['pytest', 'vitest', 'playwright'])
@pytest.mark.parametrize('bad', ['1 failed', '1 error', '2 errors', '1 flaky', '1 rerun', '3 reruns'])
def test_a_green_with_a_failure_error_flake_or_rerun_is_refused(runner: str, bad: str):
    run = f' \N{CHECK MARK} src/widget.test.ts > Widget > counts\n{planted.PYTEST_ID} PASSED\n1 passed, {bad}'
    good = VITEST_GOOD if runner == 'vitest' else '1 passed in 0.2s'
    parsed = verdict.parse(text(sections={'Green': '\n'.join(f'```\n{r}\n```' for r in (run, good, good))}))
    problems = verdict.evidence_problems(parsed, COMMAND, planted.PYTEST_ID if runner != 'vitest' else 'counts', runner)
    assert len(problems) == 1
    assert problems[0].startswith('Green: run 1 does not show')


def test_an_unprefixed_diff_u_header_is_read_without_its_date():
    plain = ('--- voc-datalake/lambda/api/widget.py\t2026-11-27 10:00:00.000000000 +0000\n'
             '+++ voc-datalake/lambda/api/widget.py\t2026-11-27 10:05:00.000000000 +0000\n'
             '@@ -1,2 +1,2 @@\n def count(items):\n-    return len(items)\n+    return 0\n')
    assert [f.path for f in verdict.diff_files(plain)] == ['voc-datalake/lambda/api/widget.py']
    assert break_problems(plain) == []


@pytest.mark.parametrize('path', ['voc-datalake/lambda/api/../../../etc/x.py', 'voc-datalake/lambda/./api/x.py',
                                  '/voc-datalake/lambda/api/x.py', 'voc-datalake//lambda/api/x.py'])
def test_a_break_path_that_is_not_normal_is_refused(path: str):
    assert break_problems(diff_of(path, 'a = 1', 'a = 2'))[0] == (
        f'Break: {path} is not a normal repository path (no .., ./, // or leading /)')


def test_a_reject_has_its_own_numbered_path():
    accept = verdict.verdict_path('7.76.00', 'pytest', planted.PYTEST_ID)
    assert verdict.reject_path('7.76.00', 'pytest', planted.PYTEST_ID, 2) == accept.removesuffix('.md') + '.reject-2.md'


def test_a_reject_with_a_break_has_its_paths_checked_too():
    diff = diff_of('voc-datalake/lambda/../../etc/passwd', 'a', 'b')
    assert problems(outcome='REJECT', sections={'Break': f'```diff\n{diff}```'}) == [
        'Break: voc-datalake/lambda/../../etc/passwd is not a normal repository path (no .., ./, // or leading /)']


def test_a_reject_needs_its_reasons_and_command_only():
    assert problems(outcome='REJECT', checks={'fails_on_break': False}, sections={'Break': '', 'Red': ''}) == []
    assert problems(outcome='REJECT', sections={'Reasons': ''}) == ['Reasons: empty']


@pytest.mark.parametrize(('path', 'product'), [
    ('voc-datalake/lambda/api/widget.py', True),
    ('voc-datalake/lambda/shared/x/y.py', True),
    ('voc-datalake/lambda/api/test/test_widget.py', False),
    ('voc-datalake/lambda/api/test_widget.py', False),
    ('voc-datalake/lambda/conftest.py', False),
    ('voc-datalake/lambda/stream/src/plan.ts', True),
    ('voc-datalake/lambda/stream/src/plan.test.ts', False),
    ('voc-datalake/frontend/src/pages/Home.tsx', True),
    ('voc-datalake/frontend/src/pages/Home.test.tsx', False),
    ('voc-datalake/frontend/src/test/setup.ts', False),
    ('voc-datalake/lib/stacks/api.ts', True),
    ('voc-datalake/lib/stacks/api.test.ts', False),
    ('voc-datalake/lib/test-support/baseline.json', False),
    ('voc-datalake/lambda/api/fixtures/a.json', False),
    ('voc-datalake/lambda/api/review_fixtures.py', False),
    ('voc-datalake/frontend/src/__mocks__/api.ts', False),
    ('voc-datalake/lambda/shared/mocks/bedrock.py', False),
    ('voc-datalake/frontend/e2e/tests/a.spec.ts', False),
    ('scripts/validate.sh', False),
])
def test_product_paths(path: str, product: bool):
    assert verdict.is_product_path(path) is product


def test_the_verdict_path_follows_the_convention():
    path = verdict.verdict_path('7.76.00/erasure', 'pytest', planted.PYTEST_ID)
    assert path.startswith('docs/test-verdicts/7.76.00/erasure/pytest-')
    assert len(path.rsplit('-', 1)[1]) == len('0123456789ab.md')
    assert path != verdict.verdict_path('7.76.00/erasure', 'pytest', planted.PYTEST_ID + 'x')
    with pytest.raises(ValueError, match='under docs/test-verdicts'):
        verdict.verdict_path('../../etc', 'pytest', planted.PYTEST_ID)
    assert verdict.record_path('7.76.00', 'decision.md') == 'docs/test-verdicts/7.76.00/decision.md'
