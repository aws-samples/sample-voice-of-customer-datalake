"""The benchmark gate: no regression and a gain on the failure's case, on scorecards and end to end."""
from __future__ import annotations

import pytest

from engineering.benchmark.cases import BenchmarkError
from engineering.benchmark.gate import REGRESSIONS_QUOTED, Verdict, benchmark_run, decide
from engineering.benchmark.runner import CaseResult, Scorecard, Tools, run_suite
from engineering.benchmark.test.fixtures import (
    DURATION,
    MONOREPO,
    REVIEW,
    SLUG,
    SUITE,
    fixes,
    needs_node,
    regresses,
    replays_every_fix,
)
from engineering.skills.model import MAX_BENCHMARK_BYTES, MAX_BENCHMARK_CASES, BenchmarkRun


def card(name: str, **passed: bool) -> Scorecard:
    return Scorecard(name, tuple(CaseResult(case.replace('_', '-'), ok, 'ok' if ok else 'the check failed (exit 1)')
                                 for case, ok in passed.items()))


BASE = card('v1', alpha=True, beta=True, gamma=False)


def test_no_regression_passes_and_names_the_cases_it_kept() -> None:
    verdict = decide(BASE, card('v2', alpha=True, beta=True, gamma=False))
    kept = 'no regression: the 2 case(s) that passed in the baseline pass in the candidate (alpha, beta)'
    assert verdict == Verdict(True, (kept,))
    assert decide(card('v1', alpha=False), card('v2', alpha=False)).reasons == (
        'no regression: the 0 case(s) that passed in the baseline pass in the candidate',)


def test_a_regression_fails_and_names_its_case_and_why() -> None:
    verdict = decide(BASE, card('v2', alpha=True, beta=False, gamma=True))
    regressed = 'beta regressed: it passed in the baseline and fails in the candidate (the check failed (exit 1))'
    assert verdict == Verdict(False, (regressed,))


def test_two_scorecards_of_different_cases_are_refused() -> None:
    with pytest.raises(BenchmarkError, match=r'only the baseline: gamma; only the candidate: \)'):
        decide(BASE, card('v2', alpha=True, beta=True))
    with pytest.raises(BenchmarkError, match=r'only the baseline: ; only the candidate: delta\)'):
        decide(BASE, card('v2', alpha=True, beta=True, gamma=False, delta=False))


def test_a_gain_on_the_failure_case_is_needed_when_one_is_named() -> None:
    gained = decide(BASE, card('v2', alpha=True, beta=True, gamma=True), failure_case='gamma')
    assert (gained.passed, gained.failure_case) == (True, 'gamma')
    assert gained.reasons[-1] == "gamma, the failure's case, gained: it failed in the baseline and passes in the candidate"
    still = decide(BASE, card('v2', alpha=True, beta=True, gamma=False), failure_case='gamma')
    fails = "gamma, the failure's case, still fails in the candidate (the check failed (exit 1))"
    assert still == Verdict(False, (still.reasons[0], fails), 'gamma')
    already = decide(BASE, card('v2', alpha=True, beta=True, gamma=True), failure_case='alpha')
    assert not already.passed
    assert already.reasons[-1] == "alpha, the failure's case, passed in the baseline already: the version shows no gain on it"
    with pytest.raises(BenchmarkError, match="the failure's case is one of the cases both scorecards ran"):
        decide(BASE, BASE, failure_case='delta')


def test_a_gain_does_not_excuse_a_regression() -> None:
    verdict = decide(BASE, card('v2', alpha=False, beta=True, gamma=True), failure_case='gamma')
    assert not verdict.passed
    assert verdict.reasons[0].startswith('alpha regressed')
    assert verdict.reasons[1].startswith("gamma, the failure's case, gained")


def test_a_failure_case_is_a_case_id() -> None:
    with pytest.raises(BenchmarkError, match="the failure's case is one of the cases"):
        decide(BASE, BASE, failure_case='Not An Id')


def test_a_long_why_and_many_kept_cases_stay_short() -> None:
    names = {f'case_{n:02d}': True for n in range(12)}
    verdict = decide(card('v1', **names), card('v2', **names))
    assert verdict.reasons[0].endswith('case-00, case-01, case-02, case-03, case-04, case-05, case-06, case-07 and 4 '
                                       'more)')
    long_why = Scorecard('v2', (CaseResult('alpha', False, 'x' * 500 + '\nsecond line'),))
    reason = decide(card('v1', alpha=True), long_why).reasons[0]
    assert reason.endswith('x…)')
    assert len(reason) < 300


def test_many_regressions_with_non_ascii_output_give_a_failed_record_within_its_bound() -> None:
    ids = [f'{n:03d}-' + 'c' * 59 for n in range(MAX_BENCHMARK_CASES)]   # the longest ids, as many as a suite holds
    loud = 'Échec 😱 ' * 120 + '\nnext line'   # four-byte characters, past the quoted why's length
    baseline = Scorecard('v1', tuple(CaseResult(case_id, True, 'ok') for case_id in ids))
    candidate = Scorecard('v2', tuple(CaseResult(case_id, False, loud) for case_id in ids))
    verdict = decide(baseline, candidate, failure_case=ids[0])
    assert not verdict.passed
    assert len(verdict.reasons) == REGRESSIONS_QUOTED + 2   # the quoted ones, the rest in a line, the failure's
    assert verdict.reasons[REGRESSIONS_QUOTED] == (f'{MAX_BENCHMARK_CASES - REGRESSIONS_QUOTED} more case(s) '
                                                   f'regressed: {", ".join(ids[12:16])} and 84 more')   # long ids: 4
    run = benchmark_run(baseline, candidate, verdict)   # never a SkillError
    assert (run.passed, run.gained, run.after) == (False, False, 0.0)
    assert len(run.stored_json(at='2026-11-13T00:00:00+00:00', by='p' * 200, by_kind='person').encode()) < (
        MAX_BENCHMARK_BYTES // 2)


def test_a_why_with_control_characters_still_gives_a_record() -> None:
    candidate = Scorecard('v2', (CaseResult('alpha', False, 'nul\x00 here\x1b and \x85there\nsecond'),
                                 CaseResult('beta', True, 'ok'), CaseResult('gamma', False, '\x00')))
    verdict = decide(BASE, candidate)
    regressed = 'alpha regressed: it passed in the baseline and fails in the candidate (nul here and there)'
    assert verdict.reasons == (regressed,)
    run = benchmark_run(BASE, candidate, verdict)   # never a SkillError
    assert not run.passed
    assert '\x00' not in run.stored_json()


def test_a_verdict_becomes_the_record_the_store_keeps() -> None:
    candidate = card('v2', alpha=True, beta=True, gamma=True)
    verdict = decide(BASE, candidate, failure_case='gamma')
    run = benchmark_run(BASE, candidate, verdict)
    assert run == BenchmarkRun(before=2 / 3, after=1.0, cases=('alpha', 'beta', 'gamma'), passed=True,
                               reasons=verdict.reasons, failure_case='gamma')
    # The record names only the failure's case the gate checked: a verdict decided without one claims no gain.
    unchecked = decide(BASE, candidate)
    assert (unchecked.failure_case, benchmark_run(BASE, candidate, unchecked).failure_case) == ('', '')


@pytest.fixture(scope='module')
def baseline() -> Scorecard:
    return run_suite(SUITE, replays_every_fix(), Tools.installed())


@needs_node
def test_end_to_end_replaying_every_fix_against_itself_passes(baseline: Scorecard) -> None:
    again = run_suite(SUITE, replays_every_fix(), Tools.installed())
    verdict = decide(baseline, again)
    assert verdict.passed
    kept = f'{DURATION}, {MONOREPO}, {REVIEW}, {SLUG}'
    assert verdict.reasons == (f'no regression: the 4 case(s) that passed in the baseline pass in the candidate ({kept})',)


@needs_node
@pytest.mark.parametrize('case_id', [SLUG, DURATION, REVIEW, MONOREPO])
def test_end_to_end_a_regression_on_any_shipped_case_fails_the_gate(baseline: Scorecard, case_id: str) -> None:
    worse = run_suite(SUITE, regresses(case_id), Tools.installed())
    verdict = decide(baseline, worse)
    assert not verdict.passed
    assert len(verdict.reasons) == 1
    assert verdict.reasons[0].startswith(f'{case_id} regressed: it passed in the baseline and fails in the candidate')
    assert worse.pass_rate == 0.75


@needs_node
def test_end_to_end_a_version_that_fixes_the_failure_case_passes_and_is_recorded() -> None:
    before, after = fixes(SLUG)
    tools = Tools.installed()
    old, new = run_suite(SUITE, before, tools), run_suite(SUITE, after, tools)
    verdict = decide(old, new, failure_case=SLUG)
    assert verdict.passed
    assert verdict.reasons[-1] == (f"{SLUG}, the failure's case, gained: it failed in the baseline and passes in the "
                                   'candidate')
    run = benchmark_run(old, new, verdict)
    assert (run.before, run.after, run.passed, run.failure_case) == (0.75, 1.0, True, SLUG)
    # The same version with no gain on another failure's case: the baseline passed it already.
    assert not decide(old, new, failure_case=MONOREPO).passed
