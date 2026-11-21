"""shared/adoption_rollup.py: a scope's project rows folded into months (pure, no table)."""
from __future__ import annotations

from typing import Any

import pytest

from shared import adoption_rollup as ar
from shared.adoption_rollup import MonthBuckets, month_of, months_between, project_projection
from shared.adoption_validation import REPORT_OUTCOME_KEY, REPORT_RESULTS_FIELD

P = 'PROJECT#p1'


def meta(created_at: str, **extra: Any) -> dict[str, Any]:
    return {'pk': P, 'sk': 'META', 'created_at': created_at, **extra}


def doc(sk: str, document_type: str | None, created_at: str, **extra: Any) -> dict[str, Any]:
    row = {'pk': P, 'sk': sk, 'created_at': created_at, 'document_id': sk.split('#', 1)[1], **extra}
    if document_type is not None:
        row['document_type'] = document_type
    return row


def decision(doc_id: str, verdict: str, decided_at: str, cited: list[str] | None = None) -> dict[str, Any]:
    return doc(f'DOC#{doc_id}', 'decision', decided_at,
               decision={'verdict': verdict, 'decided_at': decided_at, 'evidence': {'document_ids': cited or []}})


def report(doc_id: str, created_at: str, outcomes: list[str], **extra: Any) -> dict[str, Any]:
    return doc(f'DOC#{doc_id}', 'validation_report', created_at,
               **{REPORT_RESULTS_FIELD: [{REPORT_OUTCOME_KEY: outcome} for outcome in outcomes]}, **extra)


def folded(*projects: list[dict[str, Any]], first: str = '2026-09', last: str = '2026-11') -> dict[str, Any]:
    buckets = MonthBuckets(first, last)
    for rows in projects:
        buckets.add_project(rows)
    return buckets.stored()


def test_months_between_crosses_a_year():
    assert months_between('2025-11', '2026-02') == ['2025-11', '2025-12', '2026-01', '2026-02']


@pytest.mark.parametrize(('value', 'month'), [
    ('2026-11-03T10:00:00+00:00', '2026-11'), ('2026-11-30T23:30:00-02:00', '2026-12'), ('2026-11-03', '2026-11'),
    ('2026-11-03T10:00:00Z', '2026-11'), ('not a date', None), (None, None), ('', None),
])
def test_month_of_is_the_utc_month(value, month):
    assert month_of(value) == month


def test_the_cohort_counts_each_step_a_project_reached_in_its_start_month():
    months = folded([
        meta('2026-10-02T09:00:00+00:00'),
        doc('PERSONA#a', None, '2026-10-03T09:00:00+00:00'),
        doc('PRFAQ#b', 'prfaq', '2026-10-05T09:00:00+00:00'),
        doc('PRD#c', 'prd', '2026-11-01T09:00:00+00:00'),
        doc('PROTOTYPE#d', 'prototype', '2026-11-04T09:00:00+00:00'),
    ], [meta('2026-10-20T09:00:00+00:00')])
    assert months['2026-10']['projects_started'] == 2
    assert months['2026-10']['with'] == {'personas': 1, 'prfaq': 1, 'prd': 1, 'prototype': 1}
    assert 'projects_started' not in months['2026-11']


def test_artifacts_tell_ai_made_from_hand_written_and_skip_edits_and_copies():
    months = folded([
        meta('2026-11-01T00:00:00+00:00'),
        doc('PRD#a', 'prd', '2026-11-02T00:00:00+00:00', job_id='j1'),
        doc('PRD#b', 'prd', '2026-11-03T00:00:00+00:00', origin='human'),
        doc('PRD#c', 'prd', '2026-11-04T00:00:00+00:00', origin='human', edit_kind='edit'),
        doc('PRD#d', 'prd', '2026-11-05T00:00:00+00:00', origin='human', edit_kind='revise'),
        doc('PRD#e', 'prd', '2026-11-06T00:00:00+00:00', edit_kind='restore'),
        doc('PERSONA#f', None, '2026-11-02T00:00:00+00:00', imported_from={'source': 'csv'}),
        doc('PERSONA#g', None, '2026-11-02T00:00:00+00:00', copied_from={'project_id': 'p0'}),
        doc('PERSONA#h', None, '2026-11-02T00:00:00+00:00'),
        doc('RESEARCH#i', 'research', '2026-11-02T00:00:00+00:00'),
        doc('DOC#j', 'custom', '2026-11-02T00:00:00+00:00'),
    ])
    assert months['2026-11']['artifacts'] == {'prd': {'ai': 2, 'human': 1}, 'personas': {'ai': 1, 'human': 1},
                                              'research': {'ai': 1}}


def test_decisions_by_verdict_and_validated_only_with_a_met_real_criterion():
    months = folded([
        meta('2026-10-01T00:00:00+00:00'),
        report('rep_met', '2026-10-10T00:00:00+00:00', ['not_met', 'met']),
        report('rep_none', '2026-10-11T00:00:00+00:00', ['not_met', 'not_enough_data']),
        report('rep_syn', '2026-10-12T00:00:00+00:00', ['met'], synthetic=True),
        decision('d1', 'pursue', '2026-11-01T00:00:00+00:00', ['rep_met']),
        decision('d2', 'park', '2026-11-02T00:00:00+00:00', ['rep_none']),
        decision('d3', 'reject', '2026-11-03T00:00:00+00:00', ['rep_syn']),
        decision('d4', 'pursue', '2026-11-04T00:00:00+00:00'),
        doc('DOC#d5', 'decision', '2026-11-05T00:00:00+00:00', decision={'verdict': 'maybe'}),
    ])
    assert months['2026-11']['decisions'] == {'pursue': 2, 'park': 1, 'reject': 1}
    assert months['2026-11']['validated_decisions'] == 1
    assert months['2026-10']['validation_reports'] == 3


def test_synthetic_runs_are_counted_apart():
    months = folded([
        meta('2026-11-01T00:00:00+00:00'),
        doc('DOC#r1', 'validation_run', '2026-11-02T00:00:00+00:00', synthetic=True),
        doc('DOC#r2', 'validation_run', '2026-11-03T00:00:00+00:00'),
        doc('DOC#r3', 'validation_run', '2026-11-04T00:00:00+00:00', synthetic=False),
    ])
    assert months['2026-11']['validation_runs'] == {'synthetic': 2, 'real': 1}


def test_a_project_without_any_validation_data_is_not_validated():
    months = folded([meta('2026-11-01T00:00:00+00:00'), decision('d1', 'pursue', '2026-11-02T00:00:00+00:00',
                                                                 ['rep_missing'])])
    assert 'validated_decisions' not in months['2026-11']
    assert 'with' not in months['2026-11']


def test_a_meta_naming_its_report_counts_the_project_with_a_validation():
    months = folded([meta('2026-11-01T00:00:00+00:00', validation={'report_document_id': 'rep_1', 'status': 'done'})])
    assert months['2026-11']['with'] == {'validation': 1}


def test_cycle_times_end_in_their_months_as_whole_days_and_skip_steps_out_of_order():
    months = folded([
        meta('2026-09-01T00:00:00+00:00'),
        doc('RESEARCH#r', 'research', '2026-09-05T00:00:00+00:00'),
        doc('PRD#a', 'prd', '2026-09-15T13:00:00+00:00'),
        doc('PROTOTYPE#b', 'prototype', '2026-10-01T00:00:00+00:00'),
        decision('d0', 'park', '2026-09-20T00:00:00+00:00'),
        decision('d1', 'pursue', '2026-10-04T00:00:00+00:00'),
    ], [
        meta('2026-10-01T00:00:00+00:00'),
        doc('PROTOTYPE#x', 'prototype', '2026-10-02T00:00:00+00:00'),
        doc('PRD#y', 'prd', '2026-10-09T00:00:00+00:00'),
    ])
    assert months['2026-09']['cycle_days'] == {'evidence_to_prd': {'11': 1}}
    assert months['2026-10']['cycle_days'] == {'prd_to_prototype': {'15': 1}, 'prototype_to_decision': {'3': 1},
                                               'evidence_to_prd': {'8': 1}}


def test_a_start_outside_the_months_is_left_out_but_a_cycle_ending_inside_counts():
    months = folded([meta('2025-01-01T00:00:00+00:00'), doc('PRD#a', 'prd', '2026-11-02T00:00:00+00:00')])
    assert list(months) == ['2026-09', '2026-10', '2026-11']
    assert months['2026-11'] == {'artifacts': {'prd': {'ai': 1}}, 'cycle_days': {'evidence_to_prd': {'670': 1}}}


def test_counts_and_agent_runs_land_in_their_month_only():
    buckets = MonthBuckets('2026-10', '2026-11')
    buckets.add_count('2026-10', 'assistant_conversations', 4)
    buckets.add_count('2026-08', 'assistant_conversations', 9)
    buckets.add_agent_run('2026-11-02T00:00:00+00:00')
    buckets.add_agent_run('garbage')
    assert buckets.stored() == {'2026-10': {'assistant_conversations': 4}, '2026-11': {'agent_runs': 1}}


def test_the_projection_reads_no_text_of_a_decision_or_a_report():
    projection, names = project_projection()
    assert '#dec.#verdict' in projection
    assert 'results[0].#outcome' in projection
    assert set(names.values()) - set(ar.PROJECT_ATTRIBUTES) == {
        'verdict', 'decided_at', 'evidence', 'document_ids', 'report_document_id', 'status', 'outcome'}
    assert not {'rationale', 'content', 'title', 'quotes', 'text'} & set(names.values())
