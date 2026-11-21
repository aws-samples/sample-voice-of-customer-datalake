"""shared/adoption_view.py and shared/adoption.py: the range, the periods, the medians and the labelled estimate."""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from shared import adoption
from shared.adoption_view import MAX_RANGE_MONTHS, adoption_view, parse_range
from shared.exceptions import ValidationError

TODAY = date(2026, 11, 21)

ITEM = {
    'rolled_up_at': '2026-11-21T03:05:00+00:00', 'first_month': '2024-12', 'complete': True,
    'agent_runs_counted': True,
    'months': {
        '2026-09': {'projects_started': 2, 'with': {'personas': 2, 'prototype': 1},
                    'artifacts': {'prd': {'ai': 2, 'human': 1}, 'personas': {'ai': 4}},
                    'cycle_days': {'evidence_to_prd': {'10': 1, '2': 1}}, 'decisions': {'pursue': Decimal(1)}},
        '2026-10': {'projects_started': 1, 'with': {'prototype': 1}, 'cycle_days': {'evidence_to_prd': {'4': 1}},
                    'validated_decisions': 1, 'decisions': {'park': 2}, 'validation_runs': {'synthetic': 3},
                    'assistant_conversations': 7, 'agent_runs': 2},
        '2026-11': {'artifacts': {'prototype': {'ai': 1}}},
    },
}


def test_the_default_range_is_the_last_six_months_by_month():
    chosen = parse_range({}, TODAY)
    assert (chosen.months[0], chosen.months[-1], chosen.grain) == ('2026-06', '2026-11', 'month')


def test_a_day_reads_as_its_month_and_a_quarter_widens_to_whole_quarters_up_to_now():
    chosen = parse_range({'from': '2026-08-14', 'to': '2026-11', 'grain': 'quarter'}, TODAY)
    assert chosen.months == ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11']
    assert [label for label, _ in chosen.periods()] == ['2026-Q3', '2026-Q4']


@pytest.mark.parametrize(('params', 'message'), [
    ({'grain': 'week'}, 'grain must be one of'), ({'from': '2026/01'}, 'from must be a month'),
    ({'to': '2026-12'}, 'not be after the current month'), ({'from': '2026-11', 'to': '2026-10'}, 'not be after to'),
    ({'from': '2023-01', 'to': '2026-11'}, f'at most {MAX_RANGE_MONTHS} months'),
])
def test_a_bad_range_is_refused(params, message):
    with pytest.raises(ValidationError, match=message):
        parse_range(params, TODAY)


def test_periods_carry_counts_rates_medians_and_the_estimate():
    view = adoption_view(ITEM, {}, parse_range({'from': '2026-09', 'to': '2026-11'}, TODAY), scope='workspace')
    september, october, november = view['periods']
    assert september['prototype_rate'] == 0.5
    assert september['cycle_days']['evidence_to_prd'] == {'median': 6.0, 'n': 2}
    assert september['decisions'] == {'pursue': 1, 'park': 0, 'reject': 0, 'total': 1}
    # 2 AI PRDs x 8 h + 4 AI personas x 1.5 h (the defaults); the hand-written PRD saves nothing.
    assert september['time_saved_hours'] == 22.0
    assert october['validation_runs'] == {'real': 0, 'synthetic': 3}
    assert november['prototype_rate'] is None


def test_totals_merge_the_months_exactly():
    totals = adoption_view(ITEM, {}, parse_range({'from': '2026-09', 'to': '2026-11'}, TODAY), scope='workspace')[
        'totals']
    assert totals['projects_started'] == 3
    assert totals['with']['prototype'] == 2
    assert totals['cycle_days']['evidence_to_prd'] == {'median': 4.0, 'n': 3}
    assert totals['time_saved_hours'] == 38.0


def test_the_estimate_is_labelled_with_its_baselines_and_assumptions():
    row = {'baselines': {'prd': Decimal('10')}, 'note': 'From our 2026 survey', 'updated_at': '2026-11-20T00:00:00Z'}
    view = adoption_view(ITEM, row, parse_range({'from': '2026-09', 'to': '2026-09'}, TODAY), scope='deployment')
    saved = view['time_saved']
    assert (saved['estimate'], saved['unit'], saved['note']) == (True, 'hours', 'From our 2026 survey')
    assert saved['baselines']['prd'] == {'hours': 10.0, 'saved': True}
    assert saved['baselines']['personas'] == {'hours': 1.5, 'saved': False}
    assert {each['code'] for each in saved['assumptions']} >= {'ai_made_only', 'review_not_subtracted'}
    assert view['periods'][0]['time_saved_hours'] == 26.0


def test_before_the_first_rollup_every_count_is_zero():
    view = adoption_view(None, {}, parse_range({}, TODAY), scope='deployment')
    assert view['as_of'] is None
    assert view['totals']['projects_started'] == 0
    assert view['agent_runs_counted'] is False


def test_the_answer_names_no_person():
    view = adoption_view(ITEM, {'updated_by': {'sub': 'sub-ada', 'kind': 'admin'}},
                         parse_range({}, TODAY), scope='deployment')
    assert 'sub-ada' not in repr(view)
    assert 'updated_by' not in repr(view)


@pytest.mark.parametrize(('body', 'message'), [
    ({}, 'Give at least one of'), ({'other': 1}, 'Unknown field'), ({'baselines': {}}, 'baselines must map'),
    ({'baselines': {'memo': 2}}, 'Unknown artifact type'), ({'baselines': {'prd': True}}, 'must be a number'),
    ({'baselines': {'prd': 201}}, 'between 0 and 200'), ({'baselines': {'prd': float('nan')}}, 'between 0 and 200'),
    ({'note': 3}, 'note must be text'), ({'note': 'x' * 501}, 'at most 500'),
])
def test_baseline_changes_are_validated(body, message):
    with pytest.raises(ValidationError, match=message):
        adoption.validate_changes(body)


def test_a_save_merges_and_a_null_puts_a_type_back_to_its_default():
    row = {'baselines': {'prd': Decimal('10'), 'prfaq': Decimal('3')}, 'note': 'old'}
    merged = adoption.merged_config(row, adoption.validate_changes(
        {'baselines': {'prd': None, 'prototype': 20.456}, 'note': '  '}))
    assert merged == {'baselines': {'prfaq': 3.0, 'prototype': 20.46}, 'note': None}
    assert adoption.stored_fields(merged)['baselines'] == {'prfaq': Decimal('3.0'), 'prototype': Decimal('20.46')}


def test_the_config_view_marks_defaults_and_ignores_a_bad_stored_value():
    view = adoption.config_view({'baselines': {'prd': 'eight', 'research': Decimal('5')}})
    assert view['baselines']['prd'] == {'hours': 8.0, 'saved': False}
    assert view['baselines']['research'] == {'hours': 5.0, 'saved': True}
    assert view['defaults'] == dict(adoption.DEFAULT_BASELINE_HOURS)


def test_the_rollup_partition_of_each_scope():
    from shared.ws_repo import WorkspaceScope
    ws = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
    assert adoption.rollup_partition(None) == 'ADOPTION#ROLLUP'
    assert adoption.rollup_partition(WorkspaceScope(ws)) == f'WS#{ws}#ADOPTION#ROLLUP'
