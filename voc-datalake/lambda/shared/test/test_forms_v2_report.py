"""A form's report (7.63.00, shared/forms_v2_report.py; docs/feedback-forms.md "Report"): the deterministic themes (by
the processed items' category and subcategory, with real quotes linked by response id, never a contact answer), the
KPIs and heatmaps out of the results, and the stored AI summary as a reader may see it (quotes joined against their own
rows, unknown ids dropped, withheld when it read a response they cannot see, stale once a newer response exists)."""
from __future__ import annotations

from typing import Any

from shared.forms_v2_report import MAX_QUOTES, ai_view, report_sections, themes
from shared.forms_v2_results import ResultRow, tally_results

FORM: dict[str, Any] = {
    'language': 'en', 'languages': ['en'], 'welcome': {'enabled': False},
    'questions': [
        {'id': 'q_value', 'type': 'rating', 'headline': {'en': 'Value'}, 'required': True, 'range': 5},
        {'id': 'q_nps', 'type': 'nps', 'headline': {'en': 'Recommend {{event|it}}?'}, 'required': True},
        {'id': 'q_phases', 'type': 'matrix', 'headline': {'en': 'Each part'}, 'required': False,
         'rows': [{'code': 'labs', 'label': {'en': 'Labs'}}],
         'columns': [{'code': 'meh', 'label': {'en': 'Meh'}, 'score': 1},
                     {'code': 'great', 'label': {'en': 'Great'}, 'score': 4}]},
        {'id': 'q_takeaway', 'type': 'open_text', 'headline': {'en': 'Takeaway'}, 'required': False},
        {'id': 'q_email', 'type': 'open_text', 'headline': {'en': 'Email'}, 'required': False, 'input_type': 'email'},
    ],
    'hidden_fields': [{'id': 'event'}],
    'endings': [{'id': 'end_thanks', 'title': {'en': 'Thanks'}}],
}


def _row(n: int, text: str = '', *, category: str = 'content', sub: str = '', sentiment: str = 'positive',
         at: str = '') -> ResultRow:
    answers: dict[str, Any] = {'q_value': 4, 'q_nps': 9, 'q_email': f'person{n}@example.com'}
    if text:
        answers['q_takeaway'] = text
    return ResultRow(answers, list(answers), 'end_thanks', at or f'2026-11-{10 + n:02d}T10:00:00', response_id=f'r{n}',
                     sentiment=sentiment.upper(), category=category, subcategory=sub)


class TestTheThemes:
    def test_answers_group_by_category_and_subcategory_with_quotes_of_the_dominant_sentiment(self):
        rows = [_row(0, 'Loved the labs', sub='labs'), _row(1, 'Labs were great', sub='labs'),
                _row(2, 'Labs too short', sub='labs', sentiment='negative'), _row(3, 'More labs', sub='labs'),
                _row(4, 'Slides were dense', category='presenter', sentiment='negative'), _row(5)]
        [takeaway] = themes(FORM, rows)
        assert (takeaway['question_id'], takeaway['answered']) == ('q_takeaway', 5)
        labs, presenter = takeaway['themes']
        assert (labs['category'], labs['subcategory'], labs['count']) == ('content', 'labs', 4)
        assert labs['sentiment'] == {'positive': 3, 'negative': 1}
        # 2-3 real quotes, newest first, of the theme's dominant sentiment.
        assert [q['response_id'] for q in labs['quotes']] == ['r3', 'r1', 'r0'][:MAX_QUOTES]
        assert labs['quotes'][0]['text'] == 'More labs'
        assert (presenter['count'], presenter['quotes'][0]['sentiment']) == (1, 'negative')

    def test_an_email_or_phone_answer_is_never_a_theme_or_a_quote(self):
        out = themes(FORM, [_row(0, 'Good')])
        assert [entry['question_id'] for entry in out] == ['q_takeaway']
        assert 'example.com' not in str(out)

    def test_a_response_not_processed_yet_is_the_empty_category(self):
        row = ResultRow({'q_takeaway': 'Fine'}, ['q_takeaway'], None, '2026-11-01', response_id='t1', is_test=True)
        [entry] = themes(FORM, [row])
        assert (entry['themes'][0]['category'], entry['themes'][0]['quotes'][0]['sentiment']) == ('', 'unknown')


class TestTheKpisAndHeatmaps:
    def test_scale_questions_and_matrices_in_the_forms_order(self):
        rows = [ResultRow({'q_value': 5, 'q_nps': 10, 'q_phases': {'rows': {'labs': 'great'}}}, [], None, '',
                          response_id='r1')]
        sections = report_sections(FORM, tally_results(FORM, rows))
        assert [k['id'] for k in sections['kpis']] == ['q_value', 'q_nps']
        assert sections['kpis'][1]['nps']['score'] == 100.0
        assert sections['kpis'][1]['headline'] == 'Recommend [event]?'
        [matrix] = sections['matrices']
        assert (matrix['columns'], matrix['rows'][0]['counts'], matrix['rows'][0]['average']) == (
            ['meh', 'great'], {'meh': 0, 'great': 1}, 4.0)


STORED = {'report_id': 'rpt_20261115100000abcdef01', 'created_at': '2026-11-15T10:00:00+00:00',
          'created_by': {'sub': 'sub-ed', 'kind': 'user'}, 'responses_counted': 2,
          'last_response_at': '2026-11-11T10:00:00', 'filters': {'from': '2026-11-01'}, 'response_ids': ['r0', 'r1'],
          'themes': [{'label': 'Labs are the highlight', 'count': 2, 'sentiment': 'positive',
                      'quote_ids': ['r1', 'r0', 'r9']}],
          'ai': {'model': 'global.anthropic.claude-haiku-4-5', 'prompt_version': '1.0.0', 'summary': 'People liked it.'}}


class TestTheStoredAiSummary:
    def test_its_quotes_are_joined_against_the_readers_rows_and_unknown_ids_dropped(self):
        view = ai_view(STORED, FORM, [_row(0, 'Loved the labs'), _row(1, 'Labs were great')])
        assert view is not None
        assert (view['summary'], view['stale'], view['model']) == ('People liked it.', False,
                                                                   'global.anthropic.claude-haiku-4-5')
        [theme] = view['themes']
        assert theme['quotes'] == [{'response_id': 'r1', 'text': 'Labs were great'},
                                   {'response_id': 'r0', 'text': 'Loved the labs'}]

    def test_it_is_stale_once_a_newer_response_exists(self):
        view = ai_view(STORED, FORM, [_row(0, 'a'), _row(1, 'b'), _row(5, 'c')])
        assert view is not None
        assert view['stale'] is True

    def test_it_is_withheld_from_a_reader_who_cannot_see_a_response_it_read(self):
        assert ai_view(STORED, FORM, [_row(0, 'a')]) == {'report_id': STORED['report_id'],
                                                         'created_at': STORED['created_at'],
                                                         'created_by': STORED['created_by'], 'withheld': 'access'}

    def test_no_stored_report_is_none(self):
        assert ai_view(None, FORM, []) is None
