"""A recorded benchmark's own rules: a gain needs a pass rate that rose, a new passed verdict whose rate fell is
refused where it is written (an old one still reads), and the optional reference to the run is bounded and read
back."""
from __future__ import annotations

import json

import pytest

from engineering.skills.model import MAX_RUN_REF, BenchmarkRun, Skill, SkillError
from engineering.skills.store import RecordedBenchmark, SkillVersion
from engineering.skills.test.fixtures import content

FIELDS = {'before': 0.5, 'after': 1.0, 'cases': ('slug-cut-bug',), 'passed': True, 'reasons': ('gained',),
          'failure_case': 'slug-cut-bug'}


def test_a_gain_needs_a_pass_rate_that_rose() -> None:
    assert BenchmarkRun(**FIELDS).gained
    assert not BenchmarkRun(**{**FIELDS, 'before': 0.8, 'after': 0.8}).gained   # (equal rates: no gain)


def test_a_new_passed_verdict_whose_rate_fell_is_refused_where_it_is_written() -> None:
    fell = BenchmarkRun(**{**FIELDS, 'before': 0.9, 'after': 0.5})   # (readable: a stored row is read as written)
    with pytest.raises(SkillError, match='record it as failed'):
        fell.check_recordable()
    assert not fell.gained
    BenchmarkRun(**{**FIELDS, 'before': 0.9, 'after': 0.5, 'passed': False}).check_recordable()


@pytest.mark.parametrize(('before', 'after'), [(0.9, 0.5), (0.8, 0.8)], ids=['fell but passed', 'equal rates'])
def test_an_old_record_is_read_as_recorded_and_never_lets_a_coachs_version_be_accepted(before: float,
                                                                                        after: float) -> None:
    """A row written before these rules (a passed verdict whose rate fell, or did not rise) still loads, so the
    scope's history does too, and it is never a gain: ``benchmark_passed`` (what acceptance reads) is False."""
    stored = json.dumps({**FIELDS, 'cases': list(FIELDS['cases']), 'reasons': list(FIELDS['reasons']),
                         'before': before, 'after': after, 'at': '2026-11-01T09:00:00+00:00', 'by': 'admin-sub-1',
                         'by_kind': 'person'})
    item = {'record': {'S': json.dumps(Skill('fixer', 2, content()).to_record())},
            'diff': {'S': json.dumps({'instructions': [], 'examples': [], 'tools_added': [], 'tools_removed': [],
                                      'tools_reordered': False, 'model': None, 'harness': None, 'first': False})},
            'version': {'N': '2'}, 'status': {'S': 'proposed'}, 'proposed_by_kind': {'S': 'agent'},
            'reason_run': {'S': '01JD0000000000000000000000'}, 'reason_failure': {'S': 'no_go'},
            'benchmark_run': {'S': stored}}
    version = SkillVersion.from_item(item)
    recorded = version.benchmark_run
    assert isinstance(recorded, RecordedBenchmark)
    assert ((recorded.run.before, recorded.run.after, recorded.run.passed), version.benchmark_passed) == (
        (before, after, True), False)


def test_the_reference_to_the_run_is_optional_bounded_and_read_back() -> None:
    run = BenchmarkRun(**FIELDS, run_ref='bench-run-0412')
    assert BenchmarkRun.from_json(run.to_json()) == run
    assert 'run_ref' not in BenchmarkRun(**FIELDS).to_json()   # (a record written before it reads as before)
    with pytest.raises(SkillError, match="the benchmark run's reference"):
        BenchmarkRun(**FIELDS, run_ref='x' * (MAX_RUN_REF + 1))
