"""shared/import_survey.py, shared/import_wizard.py and shared/forms_v2_import.py: a survey export as an imported
Feedback Form v2 and its rows as responses, a review export's rows through the CSV import's wizard mapping, and the
detect answer (the import wizard, 7.67.00, docs/import-wizard.md). Made-up people and companies only."""
from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import ClassVar

import pytest

from shared import forms_v2 as fv2
from shared import forms_v2_import as fimp
from shared.exceptions import ValidationError
from shared.import_detect import detect_columns, parse_sample
from shared.import_survey import ColumnChoice, check_mapping, infer_form, row_answers, slug
from shared.import_wizard import check_reviews_mapping, detect_view, five_point, reviews_fields
from shared.test.test_import_detect import SURVEY_EXPORT, _workbook

NOW = '2026-11-21T10:00:00+00:00'
OPS = json.loads((Path(__file__).resolve().parents[3] / 'schemas' / 'form-logic-ops.json').read_text())


def _survey() -> tuple:
    table = parse_sample('csv', SURVEY_EXPORT)
    columns = detect_columns(table)
    choices = [ColumnChoice(c.header, c.kind, [row[c.header] for row in table.rows]) for c in columns]
    return table, infer_form(choices, 'en')


class TestTheInferredForm:
    def test_it_is_a_valid_v2_form_with_one_question_per_answer_column(self):
        _table, form = _survey()
        definition = form.definition
        assert fv2.validate_definition(definition) == definition
        assert [(q['id'], q['type']) for q in definition['questions']] == [
            ('q_how_likely_are_you_to_recommend_us', 'nps'), ('q_which_plan', 'single_select'),
            ('q_features_used', 'multi_select'), ('q_rate_the_workshop', 'matrix'),
            ('q_what_could_we_improve', 'open_text')]
        assert all(q['required'] is False and 'logic' not in q for q in definition['questions'])
        # The logic ops of each type are the server's and the builder's (schemas/form-logic-ops.json): an imported
        # form carries no rule, and every type it uses has its ops listed there.
        assert {q['type'] for q in definition['questions']} <= set(OPS['ops_by_type'])
        assert definition['endings'] == [{'id': 'end_thanks', 'title': {'en': 'Thank you!'}}]

    def test_choices_become_options_and_matrix_cells_rows_and_columns(self):
        _table, form = _survey()
        questions = {q['id']: q for q in form.definition['questions']}
        assert [o['code'] for o in questions['q_which_plan']['options']] == ['pro', 'free', 'team']
        assert [o['label'] for o in questions['q_features_used']['options']] == [
            {'en': 'Reports'}, {'en': 'Alerts'}, {'en': 'Exports'}]
        matrix = questions['q_rate_the_workshop']
        assert [r['code'] for r in matrix['rows']] == ['content', 'pace']
        assert [c['code'] for c in matrix['columns']] == ['good', 'too_fast', 'excellent', 'right', 'poor', 'too_slow']

    def test_the_mapping_keys_responses_and_drops_personal_data(self):
        _table, form = _survey()
        assert form.mapping['Response ID'] == 'id'
        assert form.mapping['Submitted'] == 'date'
        assert form.mapping['Email'] == 'ignore'
        assert form.problems == []

    def test_a_channel_column_is_a_hidden_field(self):
        form = infer_form([ColumnChoice('Q', 'nps_0_10'), ColumnChoice('Channel', 'channel')], 'pl')
        assert form.definition['hidden_fields'] == [{'id': 'channel', 'label': 'Channel'}]
        assert form.mapping == {'Q': 'q_q', 'Channel': 'hidden:channel'}
        assert form.definition['endings'][0]['title'] == {'pl': 'Dziękujemy!'}

    def test_a_column_that_cannot_be_a_question_is_named(self):
        many = [f'value {n}' for n in range(60)]
        form = infer_form([ColumnChoice('Q', 'csat'), ColumnChoice('Pick', 'choice', many),
                           ColumnChoice('Grid', 'matrix_cell', ['a -- x'])], 'en')
        assert form.problems == [{'header': 'Pick', 'code': 'too_many_options'},
                                 {'header': 'Grid', 'code': 'no_values'}]
        assert form.mapping['Pick'] == 'ignore'

    def test_no_question_at_all_is_refused(self):
        with pytest.raises(ValidationError) as caught:
            infer_form([ColumnChoice('When', 'date'), ColumnChoice('Mail', 'email')], 'en')
        assert caught.value.code == 'no_questions'

    def test_at_most_thirty_questions(self):
        form = infer_form([ColumnChoice(f'Q{n}', 'nps_0_10') for n in range(32)], 'en')
        assert len(form.definition['questions']) == fv2.MAX_QUESTIONS
        assert [p['code'] for p in form.problems] == ['too_many_questions'] * 2

    def test_ids_and_codes_are_slugs_and_unique(self):
        assert slug('¿Qué plan usas?') == 'que_plan_usas'
        form = infer_form([ColumnChoice('Plan', 'choice', ['Pro', 'pro!', '日本']), ColumnChoice('Plan!', 'csat')], 'en')
        questions = form.definition['questions']
        assert [q['id'] for q in questions] == ['q_plan', 'q_plan_2']
        assert [o['code'] for o in questions[0]['options']] == ['pro', 'pro_2', 'option_3']


class TestRows:
    def test_a_row_is_a_response_with_its_own_date_and_id(self):
        table, form = _survey()
        row = row_answers(form.definition, form.mapping, table.rows[0], default_at=NOW, date_order='dmy')
        assert row.created_at == '2026-03-14T09:30:00+00:00'
        assert row.row_id == 'r1'
        assert row.response.answers == {
            'q_how_likely_are_you_to_recommend_us': 9, 'q_which_plan': {'code': 'pro'},
            'q_features_used': {'codes': ['reports', 'alerts']},
            'q_rate_the_workshop': {'rows': {'content': 'good', 'pace': 'too_fast'}},
            'q_what_could_we_improve': 'More hands-on time please'}
        assert row.response.ending_id == 'end_thanks'

    def test_a_zero_nps_is_an_answer_never_a_rating(self):
        table, form = _survey()
        row = row_answers(form.definition, form.mapping, table.rows[3], default_at=NOW)
        assert row.response.answers['q_how_likely_are_you_to_recommend_us'] == 0
        context = fimp.FormContext('ff_x', 'Workshop', form.definition, 1, 'Example', ('', ''), {}, 'run-1', NOW)
        message = fimp.response_message(context, 4, row)
        assert message['rating'] is None
        assert message['metadata']['form_answers']['q_how_likely_are_you_to_recommend_us'] == 0
        assert message['metadata']['form_revision'] == 1

    def test_no_logic_is_enforced_and_no_answer_is_required(self):
        definition = fv2.validate_definition({
            'language': 'en', 'endings': [{'id': 'end_a', 'title': {'en': 'A'}}, {'id': 'end_b', 'title': {'en': 'B'}}],
            'questions': [
                {'id': 'q_a', 'type': 'nps', 'headline': {'en': 'A'}, 'required': True,
                 'logic': [{'when': {'op': 'lt', 'value': 7}, 'then': {'jump_to': 'end_b'}}]},
                {'id': 'q_b', 'type': 'open_text', 'headline': {'en': 'B'}, 'required': True}]})
        # A widget with an NPS of 3 would end at end_b and never see q_b; an imported row answers both.
        row = row_answers(definition, {'A': 'q_a', 'B': 'q_b'}, {'A': '3', 'B': 'slow'}, default_at=NOW)
        assert row.response.path == ['q_a', 'q_b']
        assert row.response.ending_id == 'end_a'
        assert row_answers(definition, {'B': 'q_b'}, {'B': 'only this'}, default_at=NOW).response.answers == {
            'q_b': 'only this'}

    @pytest.mark.parametrize(('cells', 'code'), [
        ({'How likely are you to recommend us?': '11'}, 'answer_invalid'),
        ({'How likely are you to recommend us?': 'nine'}, 'answer_invalid'),
        ({'Which plan?': 'Enterprise'}, 'answer_invalid'),
        ({'Rate the workshop': 'Content: Good'}, 'answer_invalid'),
        ({'Submitted': 'yesterday', 'Which plan?': 'Pro'}, 'date_invalid'),
        ({'Email': 'x@example.com'}, 'empty_response'),
    ])
    def test_types_and_ranges_are_checked(self, cells, code):
        _table, form = _survey()
        with pytest.raises(ValidationError) as caught:
            row_answers(form.definition, form.mapping, cells, default_at=NOW)
        assert caught.value.code == code

    def test_the_text_falls_back_to_headline_and_answer_lines(self):
        _table, form = _survey()
        row = row_answers(form.definition, form.mapping, {'Which plan?': 'Team'}, default_at=NOW)
        context = fimp.FormContext('ff_x', 'Workshop', form.definition, 1, 'Example', ('', ''), {}, 'run-1', NOW)
        assert fimp.response_message(context, 1, row)['text'] == 'Which plan?: Team'

    def test_a_mapping_names_only_this_forms_questions(self):
        _table, form = _survey()
        assert check_mapping(form.definition, form.mapping) == form.mapping
        for bad in ({'A': 'q_other'}, {'A': 'date', 'B': 'date', 'C': 'q_which_plan'}, {'A': 'date'}, [], {}):
            with pytest.raises(ValidationError):
                check_mapping(form.definition, bad)


class TestTheImportRequest:
    def test_bounds(self):
        request = fimp.import_request({'rows': [{'a': 'x', 'n': 3}], 'mapping': {'a': 'q_a'}, 'offset': 10,
                                       'file': {'name': 'x.csv', 'format': 'csv', 'content': 'a\nx\n'}})
        assert request.file is not None
        assert (request.offset, request.file.content, request.file.content_type) == (
            10, b'a\nx\n', 'text/csv; charset=utf-8')
        workbook = base64.b64encode(b'PK..').decode()
        kept = fimp.import_request({'rows': [{}], 'file': {'format': 'xlsx', 'content': workbook}}).file
        assert kept is not None
        assert kept.fmt == 'xlsx'

    @pytest.mark.parametrize('body', [
        {'rows': []}, {'rows': [{}] * 5001}, {'rows': ['x']}, {'rows': [{'a': {'b': 1}}]},
        {'rows': [{}], 'date_order': 'ydm'}, {'rows': [{}], 'offset': -1}, {'rows': [{}], 'dry_run': 'yes'},
        {'rows': [{}], 'file': {'format': 'pdf', 'content': 'x'}},
        {'rows': [{}], 'file': {'format': 'xlsx', 'content': 'not base64!'}},
        {'rows': [{}], 'file': {'format': 'csv', 'content': 'a'}, 'file_key': 'raw/x'},
    ])
    def test_a_bad_body_is_a_400(self, body):
        with pytest.raises(ValidationError):
            fimp.import_request(body)

    def test_a_later_calls_file_key_must_be_this_forms(self):
        key = fimp.file_key_of('ws/ws_A/raw/', 'ff_1', '0b1f3c4e-7a2d-4f6b-9c8e-1d2a3b4c5d6e', 'csv')
        assert key == 'ws/ws_A/raw/feedback_form/import/ff_1/0b1f3c4e-7a2d-4f6b-9c8e-1d2a3b4c5d6e.csv'
        assert fimp.checked_file_key(key, 'ws/ws_A/raw/', 'ff_1') == key
        for root, form in (('ws/ws_B/raw/', 'ff_1'), ('raw/', 'ff_1'), ('ws/ws_A/raw/', 'ff_2')):
            with pytest.raises(ValidationError):
                fimp.checked_file_key(key, root, form)

    def test_rows_are_read_with_their_file_row_and_duplicates_refused(self):
        table, form = _survey()
        rows = [table.rows[0], table.rows[0], {'Which plan?': 'Gold'}]
        request = fimp.import_request({'rows': rows, 'offset': 100})
        read = fimp.read_rows(form.definition, form.mapping, request, default_at=NOW, form_id='ff_1')
        assert [number for number, _row in read.accepted] == [101]
        assert read.refused == [{'row': 102, 'code': 'duplicate_row'},
                                {'row': 103, 'code': 'answer_invalid', 'question_id': 'q_which_plan'}]
        assert fimp.refusal_lines(read.refused) == ['row 102: duplicate_row', 'row 103: answer_invalid (q_which_plan)']

    def test_the_same_row_is_the_same_item(self):
        table, form = _survey()
        first = row_answers(form.definition, form.mapping, table.rows[1], default_at=NOW)
        assert fimp.message_id('ff_1', first, 2) == fimp.message_id('ff_1', first, 9)  # it has an id
        assert fimp.message_id('ff_1', first, 2) != fimp.message_id('ff_2', first, 2)


class TestTheReviewsMapping:
    MAPPING: ClassVar[dict[str, str]] = {'review': 'open_text', 'title': 'open_text', 'rating': 'rating_1_10', 'nps': 'nps_0_10',
               'date': 'date', 'id': 'id', 'plan': 'dimension:product', 'country': 'choice', 'who': 'name',
               'mail': 'email', 'skip': 'ignore', 'link': 'url', 'from': 'channel'}

    def test_a_row_becomes_the_csv_imports_fields(self):
        row = {'review': 'Slow sync', 'title': 'Sync', 'rating': '9', 'nps': '0', 'date': '14/03/2026', 'id': 'r1',
               'plan': 'Pro', 'country': 'PL', 'who': 'Anna Kowalska', 'mail': 'a@example.com', 'skip': 'x',
               'link': 'https://example.com/r1', 'from': 'app_store'}
        fields = reviews_fields(row, check_reviews_mapping(self.MAPPING), 'dmy')
        assert fields.text == 'review\nSlow sync\n\ntitle\nSync'
        assert (fields.rating, fields.created_at, fields.source_id, fields.url, fields.channel) == (
            '5', '2026-03-14T00:00:00+00:00', 'r1', 'https://example.com/r1', 'app_store')
        assert fields.dimensions == {'product': 'Pro'}
        assert fields.metadata == {'rating': '9', 'nps': '0', 'country': 'PL'}
        assert 'Anna Kowalska' not in json.dumps(fields.__dict__)
        assert 'a@example.com' not in json.dumps(fields.__dict__)

    def test_one_text_column_is_the_text_itself(self):
        assert reviews_fields({'t': ' Fine '}, {'t': 'open_text'}, 'dmy').text == 'Fine'

    def test_a_bad_date_keeps_the_import_date_with_a_warning(self):
        fields = reviews_fields({'t': 'x', 'd': 'soon'}, {'t': 'open_text', 'd': 'date'}, 'dmy')
        assert (fields.created_at, fields.warnings) == ('', ['"d" is not a date — the import date is used'])

    @pytest.mark.parametrize(('kind', 'value', 'five'), [
        ('rating_1_5', '4', '4'), ('rating_1_5', '0', None), ('csat', '5', '5'), ('rating_1_10', '1', '1'),
        ('rating_1_10', '10', '5'), ('rating_1_10', '7', '4'), ('rating_1_10', '11', None), ('rating_1_5', 'x', None)])
    def test_ratings_are_on_five_points(self, kind, value, five):
        assert five_point(kind, value) == five

    @pytest.mark.parametrize('mapping', [{}, {'a': 'choice'}, {'a': 'open_text', 'b': 'stars'},
                                         {'a': 'open_text', 'b': 'dimension:Bad Key'}, None])
    def test_a_mapping_needs_text_and_known_kinds(self, mapping):
        with pytest.raises(ValidationError):
            check_reviews_mapping(mapping)


class TestTheDetectAnswer:
    def test_a_survey_sample(self):
        answer = detect_view({'format': 'csv', 'sample': SURVEY_EXPORT, 'language': 'es'})
        assert answer['suggested']['target'] == 'survey'
        assert answer['suggested']['date_order'] == 'dmy'
        form = answer['suggested']['form']
        assert form['definition']['language'] == 'es'
        assert form['mapping']['Email'] == 'ignore'
        assert 'table' not in answer
        assert [c['kind'] for c in answer['columns']][2] == 'nps_0_10'

    def test_a_person_s_choice_and_the_whole_files_values_win(self):
        answer = detect_view({'format': 'csv', 'sample': SURVEY_EXPORT, 'mapping': {'Which plan?': 'open_text'},
                              'values': {'Features used': ['Reports', 'Alerts', 'Exports; Billing']}})
        column = next(c for c in answer['columns'] if c['header'] == 'Which plan?')
        assert (column['kind'], column['confidence'], column['reasons']) == ('open_text', 1.0, [{'code': 'chosen', 'params': {}}])
        questions = {q['id']: q for q in answer['suggested']['form']['definition']['questions']}
        assert questions['q_which_plan']['type'] == 'open_text'
        assert [o['code'] for o in questions['q_features_used']['options']] == ['reports', 'alerts', 'exports', 'billing']

    def test_a_workbook_comes_back_as_rows(self):
        workbook = base64.b64encode(_workbook([('A1', 's', 0), ('B1', 's', 1), ('A2', 's', 2), ('B2', 'n', '9')],
                                              ['Comment', 'Recommend us?', 'Great'])).decode()
        answer = detect_view({'format': 'xlsx', 'sample': workbook})
        assert answer['table'] == {'headers': ['Comment', 'Recommend us?'], 'rows': [['Great', '9']], 'truncated': False}

    def test_a_reviews_file_names_no_form_problem_when_it_has_questions(self):
        answer = detect_view({'format': 'csv', 'sample': 'Comment\nGood\nBad\n', 'target': 'reviews'})
        assert answer['suggested']['target'] == 'reviews'
        assert answer['suggested']['form_problem'] is None

    @pytest.mark.parametrize(('body', 'code'), [
        ({'format': 'doc', 'sample': 'x'}, 'format_invalid'), ({'format': 'csv'}, 'sample_required'),
        ({'format': 'csv', 'sample': 'a' * (256 * 1024 + 1)}, 'sample_too_large'),
        ({'format': 'xlsx', 'sample': '%%%'}, 'sample_invalid'),
        ({'format': 'xlsx', 'sample': base64.b64encode(b'nope').decode()}, 'file_unreadable'),
        ({'format': 'csv', 'sample': 'a\n1\n', 'delimiter': '#'}, 'delimiter_invalid'),
        ({'format': 'csv', 'sample': 'a\n1\n', 'mapping': {'a': 'stars'}}, 'mapping_invalid'),
        ({'format': 'csv', 'sample': 'a\n1\n', 'values': {'a': 'x'}}, 'values_invalid'),
    ])
    def test_a_bad_request_is_a_coded_400(self, body, code):
        with pytest.raises(ValidationError) as caught:
            detect_view(body)
        assert caught.value.code == code
