"""A form's results (shared/forms_v2_results.py): per question of the current revision, counts per option code, the
histograms and NPS / CSAT / CES scores, open-text counts with the latest answers, reach and drop-off, removed questions
and options, the endings, the hidden fields, the filters, the funnel and the card's headline figure."""
from __future__ import annotations

from shared import forms_v2 as fv2
from shared.forms_v2_results import ResultRow, filter_rows, funnel_counts, headline, legacy_row, tally_results

FORM = fv2.validate_definition({
    'language': 'en', 'questions': [
        {'id': 'q_nps', 'type': 'nps', 'headline': {'en': 'Recommend?'}, 'required': True,
         'logic': [{'when': {'op': 'gte', 'value': 9}, 'then': {'jump_to': 'q_pick'}}]},
        {'id': 'q_low', 'type': 'open_text', 'headline': {'en': 'Why not?'}, 'required': False},
        {'id': 'q_pick', 'type': 'multi_select', 'headline': {'en': 'Pick'}, 'required': False,
         'options': [{'code': 'a', 'label': {'en': 'A'}}, {'code': 'b', 'label': {'en': 'B'}}],
         'other': {'enabled': True}, 'none': {'enabled': True}},
        {'id': 'q_csat', 'type': 'csat', 'headline': {'en': 'Happy?'}, 'required': False},
        {'id': 'q_ces', 'type': 'ces', 'headline': {'en': 'Easy?'}, 'required': False},
        {'id': 'q_ok', 'type': 'consent', 'headline': {'en': 'OK?'}, 'label': {'en': 'Yes'}, 'required': False},
        {'id': 'q_who', 'type': 'contact_info', 'headline': {'en': 'Who?'}, 'required': False,
         'fields': {'email': {'show': True, 'required': False}}},
    ],
    'hidden_fields': [{'id': 'plan'}],
    'endings': [{'id': 'end_a', 'title': {'en': 'A'}}, {'id': 'end_b', 'title': {'en': 'B'}}],
})
PROMOTER_PATH = ['q_nps', 'q_pick', 'q_csat', 'q_ces', 'q_ok', 'q_who']
DETRACTOR_PATH = ['q_nps', 'q_low', 'q_pick', 'q_csat', 'q_ces', 'q_ok', 'q_who']


def _row(answers: dict, path: list[str], at: str, **extra) -> ResultRow:
    return ResultRow(answers, path, extra.pop('ending', 'end_a'), at, **extra)


ROWS = [
    _row({'q_nps': 10, 'q_pick': {'codes': ['a', 'b']}, 'q_csat': 5, 'q_ces': 6, 'q_ok': True,
          'q_who': {'email': 'a@b.example'}}, PROMOTER_PATH, '2026-11-01T10:00:00', hidden={'plan': 'pro'},
         response_id='f1', language='en', sentiment='POSITIVE'),
    _row({'q_nps': 9, 'q_pick': {'codes': [], 'other': 'Support'}, 'q_csat': 4}, PROMOTER_PATH, '2026-11-02T10:00:00',
         response_id='f2', language='en'),
    _row({'q_nps': 2, 'q_low': 'Slow', 'q_pick': {'codes': ['none']}, 'q_csat': 1, 'q_ces': 2},
         DETRACTOR_PATH, '2026-11-03T10:00:00', ending='end_b', response_id='f3', language='pl'),
    _row({'q_nps': 7, 'q_low': 'Meh', 'q_gone': 'old question', 'q_pick': {'codes': ['c']}}, DETRACTOR_PATH,
         '2026-11-04T10:00:00', response_id='f4', is_test=True),
]


def _question(results: dict, qid: str) -> dict:
    return next(q for q in results['questions'] if q['id'] == qid)


def test_the_totals_endings_hidden_and_removed_questions():
    results = tally_results(FORM, ROWS)
    assert (results['responses'], results['test_responses']) == (4, 1)
    assert results['last_response_at'] == '2026-11-04T10:00:00'
    assert results['endings'] == {'end_a': 3, 'end_b': 1}
    assert results['hidden'] == {'plan': 1}
    assert results['removed_questions'] == [{'id': 'q_gone', 'answered': 1}]
    assert results['funnel'] is None


def test_nps_is_promoters_minus_detractors_with_its_histogram():
    nps = _question(tally_results(FORM, ROWS), 'q_nps')
    assert nps['nps'] == {'score': 25.0, 'promoters': 2, 'passives': 1, 'detractors': 1}  # 50 % - 25 %
    assert nps['histogram']['10'] == 1
    assert sum(nps['histogram'].values()) == 4
    assert list(nps['histogram']) == [str(v) for v in range(11)]
    assert nps['average'] == 7.0


def test_csat_and_ces_scores():
    results = tally_results(FORM, ROWS)
    assert _question(results, 'q_csat')['csat'] == {'score': 66.7, 'satisfied': 2}
    assert _question(results, 'q_ces')['ces'] == {'score': 50.0, 'easy': 1}
    assert _question(results, 'q_ces')['scale_max'] == 7


def test_choices_count_per_code_with_other_none_and_removed_options():
    pick = _question(tally_results(FORM, ROWS), 'q_pick')
    assert pick['options'] == {'a': 1, 'b': 1}
    assert (pick['other'], pick['none']) == (1, 1)
    assert pick['other_latest'] == [{'value': 'Support', 'response_id': 'f2', 'created_at': '2026-11-02T10:00:00',
                                     'is_test': False}]
    assert pick['removed_options'] == {'c': 1}


def test_open_text_counts_and_the_latest_answers_newest_first_with_their_ids():
    low = _question(tally_results(FORM, ROWS), 'q_low')
    assert low['count'] == 2
    assert [a['value'] for a in low['latest']] == ['Meh', 'Slow']
    assert low['latest'][1]['response_id'] == 'f3'


def test_reach_and_drop_off_follow_each_responses_path():
    results = tally_results(FORM, ROWS)
    low = _question(results, 'q_low')
    assert (low['shown'], low['answered'], low['skipped'], low['not_shown']) == (2, 2, 0, 2)
    ces = _question(results, 'q_ces')
    assert (ces['shown'], ces['answered'], ces['skipped'], ces['drop_off_rate']) == (4, 2, 2, 0.5)


def test_consent_and_contact_are_counted_never_returned():
    results = tally_results(FORM, ROWS)
    assert _question(results, 'q_ok')['accepted'] == 1
    assert _question(results, 'q_who')['contacts'] == 1
    assert 'a@b.example' not in str(results)


def test_a_value_of_another_shape_from_an_older_revision_is_left_out():
    rows = [_row({'q_csat': 7, 'q_nps': 'ten', 'q_ok': 'yes'}, ['q_nps', 'q_csat', 'q_ok'], 't')]
    results = tally_results(FORM, rows)
    assert _question(results, 'q_csat')['answered'] == 0
    assert _question(results, 'q_nps')['answered'] == 0


def test_filters_by_dates_language_ending_and_hidden_value():
    assert [r.response_id for r in filter_rows(ROWS, date_from='2026-11-02', date_to='2026-11-03')] == ['f2', 'f3']
    assert [r.response_id for r in filter_rows(ROWS, language='pl')] == ['f3']
    assert [r.response_id for r in filter_rows(ROWS, ending='end_b')] == ['f3']
    assert [r.response_id for r in filter_rows(ROWS, hidden={'plan': 'pro'})] == ['f1']


def test_the_funnel_sums_the_daily_counters():
    """One row per form per day (the handler moves and takes back a visit's ``left``): the results only add them up."""
    daily = [{'opened': 5, 'day': '2026-11-01', 'left:q_nps': 2, 'left:q_low': 1},
             {'opened': 2, 'day': '2026-11-02', 'left:q_nps': -1, 'left:q_low': 0},
             {'opened': 3, 'is_test': True, 'left:q_low': 1}, {'left:': 4, 'leftover': 9, 'opened': True}]
    assert funnel_counts(daily, include_test=False) == {'opened': 7, 'left': {'q_nps': 1, 'q_low': 1}}
    assert funnel_counts(daily, include_test=True) == {'opened': 10, 'left': {'q_nps': 1, 'q_low': 2}}
    # A question whose total is not above 0 is left out (a count taken back by a response the next day).
    assert funnel_counts([{'left:q_a': 1}, {'left:q_a': -1}], include_test=False) == {'opened': 0, 'left': {}}
    funnel = tally_results(FORM, ROWS[:2], funnel_counts(daily, include_test=False))['funnel']
    assert funnel == {'opened': 7, 'left': {'q_nps': 1, 'q_low': 1}, 'completed': 2}


def test_a_version_1_submission_counts_towards_its_migrated_questions():
    migrated = fv2.migrate_v1({'question': 'Rate', 'collect_email': False})
    row = legacy_row(migrated, 4.0, ' Good ', 't', response_id='f9')
    assert row is not None
    assert (row.answers, row.path, row.response_id) == ({'q_rating': 4, 'q_text': 'Good'}, ['q_rating', 'q_text'], 'f9')
    assert legacy_row(migrated, None, '  ', 't') is None


def test_a_version_1_submission_stays_counted_once_its_questions_are_removed_or_changed():
    """Always q_rating and q_text, whatever the form holds now: a removed one counts under removed_questions, never
    vanishing from Results, Responses or the CSV; one now of another type leaves the value out of it."""
    row = legacy_row(FORM, 4, ' Slow ', 't', response_id='f9')
    assert row is not None
    assert (row.answers, row.path) == ({'q_rating': 4, 'q_text': 'Slow'}, ['q_rating', 'q_text'])
    assert tally_results(FORM, [row])['removed_questions'] == [{'id': 'q_rating', 'answered': 1},
                                                                 {'id': 'q_text', 'answered': 1}]
    as_text = fv2.validate_definition({'language': 'en', 'questions': [
        {'id': 'q_rating', 'type': 'open_text', 'headline': {'en': 'Rate'}, 'required': False}],
        'endings': [{'id': 'end_a', 'title': {'en': 'A'}}]})
    legacy = legacy_row(as_text, 4, '', 't')
    assert legacy is not None
    counted = _question(tally_results(as_text, [legacy]), 'q_rating')
    assert (counted['shown'], counted['answered'], counted['skipped']) == (1, 0, 1)


RATED = fv2.validate_definition({'language': 'en', 'questions': [
    {'id': 'q_score', 'type': 'rating', 'headline': {'en': 'Rate'}, 'required': False, 'range': 5}],
    'endings': [{'id': 'end_a', 'title': {'en': 'A'}}]})


def _converted(**question: object) -> dict:
    """RATED with its question changed (a field set to None is dropped: an NPS has no scale or range)."""
    changed = {key: value for key, value in {**RATED['questions'][0], **question}.items() if value is not None}
    return fv2.validate_definition({**RATED, 'questions': [changed]})


def test_a_row_is_scored_against_its_own_revisions_question():
    """Converted from a 5-star rating (revision 1) to NPS (revision 2): the old 5 is no NPS 5. It counts as an answer
    to an earlier version, never towards the NPS, its histogram or its reach."""
    nps = _converted(type='nps', range=None, scale=None)
    rows = [_row({'q_score': 5}, ['q_score'], '2026-11-01', revision=1),
            _row({'q_score': 9}, ['q_score'], '2026-11-02', revision=2),
            _row({'q_score': 10}, ['q_score'], '2026-11-03', revision=2)]
    score = _question(tally_results(nps, rows, revisions={1: RATED}), 'q_score')
    assert (score['answered'], score['histogram']['5'], score['earlier_version'], score['not_shown']) == (2, 0, 1, 0)
    assert score['nps'] == {'score': 100.0, 'promoters': 2, 'passives': 0, 'detractors': 0}
    # Without its snapshot the row is read on the current question.
    assert _question(tally_results(nps, rows), 'q_score')['histogram']['5'] == 1


def test_a_changed_range_keeps_the_old_answers_out_of_the_new_scale_never_skipped():
    """A 1-10 rating shrunk to 1-5: an old 8 is neither a 1-5 answer nor a skip."""
    ten = _converted(range=10)
    rows = [_row({'q_score': 8}, ['q_score'], '2026-11-01', revision=1),
            _row({'q_score': 4}, ['q_score'], '2026-11-02', revision=2)]
    score = _question(tally_results(RATED, rows, revisions={1: ten}), 'q_score')
    assert (score['shown'], score['answered'], score['skipped'], score['earlier_version']) == (1, 1, 0, 1)
    assert score['average'] == 4.0
    # The same type and range in both revisions: counted as one question across them.
    same = _question(tally_results(RATED, rows, revisions={1: _converted(scale='number')}), 'q_score')
    assert (same['answered'], 'earlier_version' in same) == (1, False)


def test_a_version_1_row_answered_revision_1():
    """No revision named (a version 1 widget's submission): revision 1, its migrated form."""
    nps = _converted(type='nps', range=None, scale=None)
    row = _row({'q_score': 5}, ['q_score'], 't')
    assert _question(tally_results(nps, [row], revisions={1: RATED}), 'q_score')['earlier_version'] == 1


def test_test_responses_are_counted_whether_or_not_the_view_includes_them():
    assert tally_results(FORM, ROWS[:3], test_responses=4)['test_responses'] == 4
    assert tally_results(FORM, ROWS)['test_responses'] == 1


def test_the_cards_headline_is_the_first_measuring_question():
    assert headline(FORM)(ROWS) == {'question_id': 'q_nps', 'type': 'nps', 'value': 25.0, 'count': 4, 'scale_max': 10}
    assert headline(FORM)([]) is None
    rating_form = fv2.migrate_v1({})
    legacy = legacy_row(rating_form, 3, '', 't')
    assert legacy is not None
    assert headline(rating_form)([legacy]) == {
        'question_id': 'q_rating', 'type': 'rating', 'value': 3.0, 'count': 1, 'scale_max': 5}
    text_only = fv2.migrate_v1({'rating_enabled': False})
    assert headline(text_only)(ROWS) is None
