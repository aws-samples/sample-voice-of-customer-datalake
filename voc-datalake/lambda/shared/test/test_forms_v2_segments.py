"""Segments and comparisons of a form's results (7.63.00, shared/forms_v2_segments.py; docs/feedback-forms.md "Report"):
what a view may group by, the minimum segment size (no group under 5 is answered on its own, and a merged group under
5 keeps its figures to itself), the ask-why follow-ups and the compact score summary (shared/forms_v2_results.py), and
the comparison of forms matched by question id and answer shape."""
from __future__ import annotations

from typing import Any

import pytest

from shared.exceptions import ValidationError
from shared.forms_v2_results import ResultRow, ask_why_pairs, score_summary, tally_results
from shared.forms_v2_segments import MIN_SEGMENT, FormSide, compare, parse_group_by, segment_results

WORKSHOP: dict[str, Any] = {
    'language': 'en', 'languages': ['en'], 'welcome': {'enabled': False},
    'questions': [
        {'id': 'q_role', 'type': 'single_select', 'headline': {'en': 'Your role'}, 'required': True,
         'options': [{'code': 'product', 'label': {'en': 'Product'}}, {'code': 'engineering', 'label': {'en': 'Eng'}}],
         'other': {'enabled': True}},
        {'id': 'q_value', 'type': 'rating', 'headline': {'en': 'Value'}, 'required': True, 'range': 5,
         'logic': [{'when': {'op': 'gt', 'value': 2}, 'then': {'jump_to': 'q_nps'}}]},
        {'id': 'q_value_why', 'type': 'open_text', 'headline': {'en': 'Why {{q_value}}?'}, 'required': False},
        {'id': 'q_nps', 'type': 'nps', 'headline': {'en': 'Recommend?'}, 'required': True},
        {'id': 'q_phases', 'type': 'matrix', 'headline': {'en': 'Each part'}, 'required': False,
         'rows': [{'code': 'intro', 'label': {'en': 'Intro'}}, {'code': 'labs', 'label': {'en': 'Labs'}}],
         'columns': [{'code': 'meh', 'label': {'en': 'Meh'}, 'score': 1},
                     {'code': 'great', 'label': {'en': 'Great'}, 'score': 4}]},
    ],
    'hidden_fields': [{'id': 'customer'}, {'id': 'event_date'}],
    'endings': [{'id': 'end_thanks', 'title': {'en': 'Thanks'}}],
}


def _row(n: int, *, customer: str = '', role: str = 'product', value: int = 4, nps: int = 9, labs: str = 'great',
         date: str = '2026-11-01', at: str = '') -> ResultRow:
    answers = {'q_role': {'code': role}, 'q_value': value, 'q_nps': nps, 'q_phases': {'rows': {'labs': labs}}}
    hidden = {key: v for key, v in (('customer', customer), ('event_date', date)) if v}
    return ResultRow(answers, list(answers), 'end_thanks', at or f'2026-11-0{1 + n % 8}T10:00:00', hidden=hidden,
                     response_id=f'r{n}')


class TestWhatAViewGroupsBy:
    def test_a_hidden_field_a_single_choice_and_a_matrix_row(self):
        assert parse_group_by(WORKSHOP, 'hidden.customer').kind == 'hidden'
        assert parse_group_by(WORKSHOP, 'q_role').kind == 'choice'
        by = parse_group_by(WORKSHOP, 'q_phases.labs')
        assert (by.kind, by.id, by.row) == ('matrix_row', 'q_phases', 'labs')

    @pytest.mark.parametrize('raw', ['hidden.nope', 'q_value', 'q_phases', 'q_phases.nope', 'q_role.x', 'customer',
                                     'hidden.__proto__', ''])
    def test_anything_else_is_a_400_naming_it(self, raw):
        with pytest.raises(ValidationError) as refused:
            parse_group_by(WORKSHOP, raw)
        assert refused.value.code == 'group_by_invalid'

    def test_a_comparison_splits_by_a_hidden_field_only(self):
        with pytest.raises(ValidationError):
            parse_group_by(WORKSHOP, 'q_role', hidden_only=True)
        assert parse_group_by(WORKSHOP, 'hidden.event_date', hidden_only=True).id == 'event_date'

    def test_the_segment_of_each_answer(self):
        assert parse_group_by(WORKSHOP, 'q_role').value(_row(0, role='engineering')) == 'engineering'
        other = ResultRow({'q_role': {'other': 'Sales'}}, ['q_role'], None, '')
        assert parse_group_by(WORKSHOP, 'q_role').value(other) == 'other'
        assert parse_group_by(WORKSHOP, 'q_phases.labs').value(_row(0, labs='meh')) == 'meh'
        assert parse_group_by(WORKSHOP, 'q_phases.intro').value(_row(0)) == ''
        assert parse_group_by(WORKSHOP, 'hidden.customer').value(_row(0, customer=' Example Ltd ')) == 'Example Ltd'


class TestTheMinimumSegmentSize:
    def test_segments_under_five_merge_and_a_merged_group_under_five_keeps_its_figures(self):
        rows = [_row(n, customer='Example Ltd', value=5) for n in range(6)] + \
               [_row(10 + n, customer='Sample Co', value=1) for n in range(3)] + [_row(20, value=2)]
        segments = segment_results(WORKSHOP, rows, parse_group_by(WORKSHOP, 'hidden.customer'))
        assert segments['min_size'] == MIN_SEGMENT == 5
        [example] = segments['groups']
        assert (example['value'], example['responses'], example['scores']['q_value']['average']) == ('Example Ltd', 6,
                                                                                                      5.0)
        # Sample Co (3) and the responses with no customer (1) are not answered on their own, nor together (4 < 5).
        assert segments['merged'] == {'segments': 2, 'responses': 4, 'scores': None}

    def test_a_merged_group_of_five_or_more_is_scored(self):
        rows = [_row(n, customer=f'c{n % 3}') for n in range(6)]
        segments = segment_results(WORKSHOP, rows, parse_group_by(WORKSHOP, 'hidden.customer'))
        assert segments['groups'] == []
        assert segments['merged']['responses'] == 6
        assert segments['merged']['scores']['q_nps']['nps'] == 100.0

    def test_no_small_segment_no_merged_group(self):
        segments = segment_results(WORKSHOP, [_row(n) for n in range(5)], parse_group_by(WORKSHOP, 'q_role'))
        assert ([g['value'] for g in segments['groups']], segments['merged']) == (['product'], None)


class TestTheScoreSummaryAndFollowUps:
    def test_each_measured_question_is_scored_and_matrix_rows_averaged(self):
        rows = [_row(0, value=2, nps=3, labs='meh'), _row(1, value=4, nps=10)]
        scores = score_summary(WORKSHOP, rows)['scores']
        assert set(scores) == {'q_value', 'q_nps', 'q_phases'}
        assert (scores['q_value']['average'], scores['q_value']['scale_max']) == (3.0, 5)
        assert scores['q_nps']['nps'] == 0.0
        assert scores['q_phases']['rows'] == {'intro': None, 'labs': 2.5}
        assert score_summary(WORKSHOP, [])['scores']['q_nps']['nps'] is None

    def test_an_open_text_a_high_score_jumps_past_is_its_follow_up(self):
        assert ask_why_pairs(WORKSHOP['questions']) == {'q_value_why': 'q_value'}
        results = tally_results(WORKSHOP, [_row(0)])
        by_id = {q['id']: q for q in results['questions']}
        assert by_id['q_value_why']['follow_up_of'] == 'q_value'
        assert 'follow_up_of' not in by_id['q_nps']

    def test_a_rule_to_the_open_text_itself_is_no_follow_up(self):
        questions = [{**WORKSHOP['questions'][1], 'logic': [{'when': {'op': 'gt', 'value': 2},
                                                            'then': {'jump_to': 'q_value_why'}}]},
                     WORKSHOP['questions'][2]]
        assert ask_why_pairs(questions) == {}


def _side(form_id: str, rows: list[ResultRow], *, definition: dict | None = None,
          template: dict | None = None) -> FormSide:
    return FormSide(form_id, form_id.upper(), template, definition or WORKSHOP, rows)


class TestComparingForms:
    def test_questions_match_by_id_and_answer_shape_and_each_point_holds_five(self):
        reshaped = {**WORKSHOP, 'questions': [{**WORKSHOP['questions'][1], 'range': 10}, WORKSHOP['questions'][3]]}
        out = compare(_side('fa', [_row(n) for n in range(5)], template={'id': 'workshop', 'version': 1}),
                      [_side('fb', [_row(n, nps=0) for n in range(7)], definition=reshaped,
                             template={'id': 'workshop', 'version': 1}),
                       _side('fc', [_row(0)])], None)
        assert [q['id'] for q in out['questions']] == ['q_value', 'q_nps', 'q_phases']
        fa, fb, fc = out['forms']
        assert (fa['same_template'], fb['same_template'], fc['same_template']) == (True, True, False)
        assert (fb['matched'], fb['unmatched']) == (['q_nps'], {'q_value': 'different', 'q_phases': 'missing'})
        a_point, b_point, c_point = out['points']
        assert a_point['scores']['q_nps']['nps'] == 100.0
        assert set(b_point['scores']) == {'q_nps'}
        assert b_point['scores']['q_nps']['nps'] == -100.0
        assert (c_point['responses'], c_point['scores']) == (1, None)

    def test_by_a_hidden_field_gives_the_trend_within_a_form(self):
        rows = [_row(n, date='2026-10-01', nps=0) for n in range(5)] + \
               [_row(10 + n, date='2026-11-01') for n in range(5)] + [_row(30, date='2026-12-01')]
        out = compare(_side('fa', rows), [], parse_group_by(WORKSHOP, 'hidden.event_date', hidden_only=True))
        assert out['by'] == 'hidden.event_date'
        assert [(p['value'], p['responses'], p.get('merged', False)) for p in out['points']] == [
            ('2026-10-01', 5, False), ('2026-11-01', 5, False), (None, 1, True)]
        assert [p['scores'] and p['scores']['q_nps']['nps'] for p in out['points']] == [-100.0, 100.0, None]
