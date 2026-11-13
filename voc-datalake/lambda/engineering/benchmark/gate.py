"""The benchmark gate for a skill version: no regression, and a gain on the failure's case when one is named.

``decide(baseline, candidate, failure_case)`` compares two scorecards of the same cases (two that did not run the
same case ids are refused): the baseline (the version the new one was written on) and the candidate (the new
version). It passes only when

- no case that passed in the baseline fails in the candidate (no regression), and
- when ``failure_case`` is named (the case made from the failure the coach wrote the version for), the candidate
  passes it and the baseline did not (a gain on the failure's case).

Its reasons are plain sentences, each naming its case (past ``REGRESSIONS_QUOTED`` regressions, the rest are named
in one line, so a verdict always fits its record, whatever its checks printed). The verdict carries the failure's case it checked, and
``benchmark_run`` takes it from there when it turns the verdict into the record the skills store keeps on the
version's row (``SkillStore.record_benchmark``): a record never names a gain the gate did not check.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final

from engineering.benchmark.cases import BenchmarkError
from engineering.benchmark.runner import CaseResult, Scorecard, printable
from engineering.skills.model import CASE_ID, MAX_REASON, BenchmarkRun

#: How much of a case's why a reason quotes, and how many case ids one line names before it counts the rest.
WHY_IN_REASON: Final = 160
NAMED_IN_A_LINE: Final = 8
#: How long the ids a line names may run together, so the line stays within a reason's ``MAX_REASON``.
NAMED_CHARACTERS: Final = 300
#: Regressed cases with a reason (and their why) of their own; the rest are named in one line. Twelve lines of at
#: most about 300 characters (4 UTF-8 bytes each at worst), with the case ids, keep a record far under its 40 KB.
REGRESSIONS_QUOTED: Final = 12


@dataclass(frozen=True)
class Verdict:
    passed: bool
    reasons: tuple[str, ...]
    #: The failure's case the gate checked for a gain (``''``: none was named).
    failure_case: str = ''


def _short(why: str) -> str:
    """The first line of ``why``, printable (whoever built the result), within ``WHY_IN_REASON``."""
    clean = printable(why)
    line = clean.splitlines()[0] if clean.strip() else ''
    return line if len(line) <= WHY_IN_REASON else f'{line[:WHY_IN_REASON - 1]}…'


def _named(ids: Sequence[str]) -> str:
    """At most ``NAMED_IN_A_LINE`` of ``ids``, within ``NAMED_CHARACTERS`` (long ids name fewer), then how many more."""
    shown: list[str] = []
    for case_id in ids[:NAMED_IN_A_LINE]:
        if shown and len(', '.join([*shown, case_id])) > NAMED_CHARACTERS:
            break
        shown.append(case_id)
    more = len(ids) - len(shown)
    return ', '.join(shown) + (f' and {more} more' if more else '')


def _regressions(baseline: Scorecard, candidate: Scorecard) -> list[str]:
    """A line per regressed case, its why quoted, for the first ``REGRESSIONS_QUOTED``; one line naming the rest. So
    a verdict stays within the record's bound whatever the checks printed (``MAX_BENCHMARK_BYTES``)."""
    regressed: list[tuple[str, str]] = []
    for before in baseline.results:
        after = candidate.result(before.case_id)
        if before.passed and after is not None and not after.passed:
            regressed.append((before.case_id, after.why))
    reasons = [f'{case_id} regressed: it passed in the baseline and fails in the candidate ({_short(why)})'
               for case_id, why in regressed[:REGRESSIONS_QUOTED]]
    rest = [case_id for case_id, _ in regressed[REGRESSIONS_QUOTED:]]
    if rest:
        reasons.append(f'{len(rest)} more case(s) regressed: {_named(rest)}')
    return reasons


def _gain(failure_case: str, before: CaseResult, after: CaseResult) -> tuple[bool, str]:
    name = f"{failure_case}, the failure's case,"
    if before.passed:
        return False, f'{name} passed in the baseline already: the version shows no gain on it'
    if not after.passed:
        return False, f'{name} still fails in the candidate ({_short(after.why)})'
    return True, f'{name} gained: it failed in the baseline and passes in the candidate'


def _same_cases(baseline: Scorecard, candidate: Scorecard, failure_case: str | None) -> None:
    only_before = sorted(set(baseline.case_ids) - set(candidate.case_ids))
    only_after = sorted(set(candidate.case_ids) - set(baseline.case_ids))
    if only_before or only_after:
        raise BenchmarkError(f'the two scorecards ran different cases (only the baseline: {_named(only_before)}; '
                             f'only the candidate: {_named(only_after)}): run both on the same suite')
    if failure_case is not None and (not CASE_ID.match(failure_case) or failure_case not in baseline.case_ids):
        raise BenchmarkError("the failure's case is one of the cases both scorecards ran")


def decide(baseline: Scorecard, candidate: Scorecard, failure_case: str | None = None) -> Verdict:
    """The gate's verdict on ``candidate`` against ``baseline``, with a reason naming each case it turned on."""
    _same_cases(baseline, candidate, failure_case)
    reasons = _regressions(baseline, candidate)
    passed = not reasons
    if passed:
        kept = [result.case_id for result in baseline.results if result.passed]
        reasons.append(f'no regression: the {len(kept)} case(s) that passed in the baseline pass in the candidate'
                       + (f' ({_named(kept)})' if kept else ''))
    if failure_case is not None:
        before, after = baseline.result(failure_case), candidate.result(failure_case)
        if before is None or after is None:   # _same_cases checked both ran it
            raise BenchmarkError("the failure's case is one of the cases both scorecards ran")
        gained, line = _gain(failure_case, before, after)
        passed = passed and gained
        reasons.append(line)
    return Verdict(passed, tuple(reason[:MAX_REASON] for reason in reasons), failure_case or '')


def benchmark_run(baseline: Scorecard, candidate: Scorecard, verdict: Verdict) -> BenchmarkRun:
    """What the skills store records on the version: both pass rates, the cases, the verdict and the failure's case
    it checked."""
    return BenchmarkRun(before=baseline.pass_rate, after=candidate.pass_rate, cases=candidate.case_ids,
                        passed=verdict.passed, reasons=verdict.reasons, failure_case=verdict.failure_case)
