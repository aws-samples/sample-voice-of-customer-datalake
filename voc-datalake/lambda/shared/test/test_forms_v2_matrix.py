"""The matrix question (7.61.00, docs/feedback-forms.md "Matrix") across the schema (shared/forms_v2.py: its fields,
codes, the lock of an answered form), the response (shared/forms_v2_responses.py: the answer and the item's text) and
the results (shared/forms_v2_results.py: per row and column, and the link checks).
"""
from __future__ import annotations

from typing import Any

import pytest

from shared import forms_v2 as fv2
from shared import forms_v2_responses as fresp
from shared.exceptions import ValidationError
from shared.forms_v2_results import ResultRow, link_health, tally_results

PHASES = [{'code': 'intro', 'label': {'en': 'Introduction'}}, {'code': 'lab', 'label': {'en': 'Hands-on lab'}},
          {'code': 'qa', 'label': {'en': 'Q&A'}}]
SCALE = [{'code': 'needs', 'label': {'en': 'Needs improvement'}, 'score': 1},
         {'code': 'ok', 'label': {'en': 'Satisfactory'}, 'score': 2},
         {'code': 'very', 'label': {'en': 'Very effective'}, 'score': 3},
         {'code': 'top', 'label': {'en': 'Exceptional'}, 'score': 4}]


def _matrix(**extra: Any) -> dict[str, Any]:
    return {'id': 'q_phases', 'type': 'matrix', 'headline': {'en': 'How was each part of {{event|the workshop}}?'},
            'required': False, 'rows': PHASES, 'columns': SCALE, **extra}


def _form(*questions: dict[str, Any]) -> dict[str, Any]:
    return {'language': 'en', 'languages': ['en'], 'welcome': {'enabled': False},
            'questions': list(questions) or [_matrix()], 'hidden_fields': [{'id': 'event', 'label': 'Event'}],
            'endings': [{'id': 'end_a', 'title': {'en': 'Thanks'}}]}


def _refusal(definition: dict[str, Any]) -> str:
    with pytest.raises(ValidationError) as refused:
        fv2.validate_definition(definition)
    return refused.value.message


class TestTheSchema:
    def test_a_matrix_is_normalized_with_its_defaults(self):
        question = fv2.validate_definition(_form())['questions'][0]
        assert (question['shuffle_rows'], question['display'], 'min_rows' in question) == (False, 'auto', False)
        assert [column.get('score') for column in question['columns']] == [1, 2, 3, 4]
        assert question['rows'][2] == {'code': 'qa', 'label': {'en': 'Q&A'}}

    @pytest.mark.parametrize(('change', 'words'), [
        ({'rows': []}, 'rows must be a list of 1 to 20'),
        ({'rows': [{'code': f'r{n}', 'label': {'en': 'R'}} for n in range(21)]}, 'rows must be a list of 1 to 20'),
        ({'columns': SCALE[:1]}, 'columns must be a list of 2 to 10'),
        ({'columns': SCALE * 3}, 'columns must be a list of 2 to 10'),
        ({'rows': [PHASES[0], PHASES[0]]}, 'is used twice'),
        ({'rows': [{'code': 'Intro', 'label': {'en': 'R'}}]}, 'must match'),
        ({'rows': [{'code': '__proto__', 'label': {'en': 'R'}}]}, 'is a reserved name'),
        ({'columns': [*SCALE[:1], {'code': 'constructor', 'label': {'en': 'C'}}]}, 'is a reserved name'),
        ({'rows': [{'code': 'r', 'label': {'en': ''}}]}, 'rows[0].label.en (the primary language) is required'),
        ({'rows': [{'code': 'r', 'label': {'en': 'R'}, 'score': 1}]}, 'has unknown fields: score'),
        ({'columns': [*SCALE[:1], {**SCALE[1], 'score': 101}]}, 'score must be a whole number from -100 to 100'),
        ({'columns': [*SCALE[:1], {**SCALE[1], 'score': 1.5}]}, 'score must be a whole number'),
        ({'columns': [*SCALE[:1], {**SCALE[1], 'score': True}]}, 'score must be a whole number'),
        ({'display': 'list'}, 'display must be one of: auto, grid, stacked'),
        ({'shuffle_rows': 'yes'}, 'shuffle_rows must be true or false'),
        ({'min_rows': 4}, 'min_rows must be a whole number from 1 to 3'),
        ({'min_rows': 2, 'required': True}, 'min_rows is for an optional matrix'),
        ({'options': []}, 'has unknown fields: options'),
    ], ids=['no-rows', 'many-rows', 'one-column', 'many-columns', 'twice', 'pattern', 'proto', 'constructor',
            'label', 'row-score', 'score-range', 'score-float', 'score-bool', 'display', 'shuffle', 'min-rows',
            'min-required', 'stray'])
    def test_a_malformed_matrix_is_refused_by_name(self, change, words):
        assert words in _refusal(_form(_matrix(**change)))

    def test_its_logic_is_submitted_and_skipped_only(self):
        fv2.validate_definition(_form(_matrix(logic=[{'when': {'op': 'skipped'}, 'then': {'jump_to': 'end_a'}}])))
        assert 'must be one of skipped, submitted for a matrix question' in _refusal(
            _form(_matrix(logic=[{'when': {'op': 'equals', 'value': 'x'}, 'then': {'jump_to': 'end_a'}}])))

    def test_the_public_config_serves_its_rows_and_columns(self):
        public = fv2.public_definition(fv2.validate_definition(_form()))['questions'][0]
        assert ([row['code'] for row in public['rows']], public['columns'][3]['score']) == (['intro', 'lab', 'qa'], 4)


class TestTheLock:
    def test_a_dropped_row_or_column_must_be_named(self):
        before = fv2.validate_definition(_form())
        after = fv2.validate_definition(_form(_matrix(rows=PHASES[:2], columns=SCALE[1:])))
        nothing = fv2.validate_removes(None)
        assert fv2.unnamed_removals(before, after, nothing) == {'rows': {'q_phases': ['qa']},
                                                                'columns': {'q_phases': ['needs']}}
        named = fv2.validate_removes({'rows': {'q_phases': ['qa']}, 'columns': {'q_phases': ['needs']}})
        assert fv2.unnamed_removals(before, after, named) == {}

    def test_a_matrix_made_another_type_is_reshaped(self):
        before = fv2.validate_definition(_form())
        after = {'questions': [{'id': 'q_phases', 'type': 'nps'}]}
        assert fv2.reshaped_questions(before, after) == ['q_phases']

    @pytest.mark.parametrize('bad', [{'rows': []}, {'rows': {'q_a': 'x'}}, {'columns': {'q_a': [1]}},
                                     {'rows': {'q_a': ['r'] * (fv2.MAX_MATRIX_ROWS + 1)}},
                                     {'columns': {f'q_{n}': [] for n in range(fv2.MAX_QUESTIONS + 1)}}])
    def test_removes_rows_and_columns_are_bounded(self, bad):
        with pytest.raises(ValidationError):
            fv2.validate_removes(bad)


class TestTheResponse:
    def _answer(self, value: Any, **question: Any) -> Any:
        """The matrix's answer as stored (beside an answered open text, so an empty matrix is not an empty response)."""
        note = {'id': 'q_note', 'type': 'open_text', 'headline': {'en': 'Anything else?'}, 'required': False}
        definition = fv2.validate_definition(_form(_matrix(**question), note))
        body = {'answers': {'q_phases': value, 'q_note': 'Fine'}}
        return fresp.validate_response(definition, body).answers.get('q_phases')

    def test_an_answer_keeps_the_rows_in_the_questions_order_and_leaves_a_null_row_out(self):
        assert self._answer({'rows': {'qa': 'top', 'intro': 'ok', 'lab': None}}) == {'rows': {'intro': 'ok',
                                                                                          'qa': 'top'}}

    @pytest.mark.parametrize(('value', 'code'), [
        ({'rows': {'intro': 'ok'}, 'extra': 1}, 'answer_invalid'), ([], 'answer_invalid'),
        ({'rows': ['intro']}, 'answer_invalid'), ({'rows': {'nope': 'ok'}}, 'answer_invalid'),
        ({'rows': {'intro': 'best'}}, 'answer_invalid'), ({'rows': {'intro': 3}}, 'answer_invalid'),
        # (a list or an object is no column: a 400, never the TypeError of hashing it against the columns)
        ({'rows': {'intro': ['ok']}}, 'answer_invalid'), ({'rows': {'intro': {'code': 'ok'}}}, 'answer_invalid'),
    ], ids=['extra', 'list', 'rows-list', 'row', 'column', 'number', 'column-list', 'column-object'])
    def test_an_answer_naming_what_the_matrix_has_not_is_refused(self, value, code):
        with pytest.raises(ValidationError) as refused:
            self._answer(value)
        assert (refused.value.code, refused.value.details) == (code, {'question_id': 'q_phases'})

    def test_a_required_matrix_needs_every_row_and_min_rows_counts_once_answered(self):
        with pytest.raises(ValidationError) as missing:
            self._answer({'rows': {'intro': 'ok'}}, required=True)
        assert missing.value.code == 'answer_required'
        with pytest.raises(ValidationError) as few:
            self._answer({'rows': {'intro': 'ok'}}, min_rows=2)
        assert few.value.code == 'selection_count'

    def test_an_optional_matrix_left_empty_is_no_answer_and_a_required_one_is_refused(self):
        assert self._answer({'rows': {}}, min_rows=2) is None
        with pytest.raises(ValidationError) as refused:
            self._answer({'rows': {}}, required=True)
        assert refused.value.code == 'answer_required'

    def test_the_items_text_has_one_line_per_row_under_the_headline_with_its_placeholder_as_an_id(self):
        definition = fv2.validate_definition(_form(_matrix()))
        response = fresp.validate_response(definition, {'answers': {'q_phases': {'rows': {'lab': 'top',
                                                                                          'intro': 'needs'}}}})
        assert fresp.response_text(definition, response) == (
            'How was each part of [event]? — Introduction: Needs improvement\n'
            'How was each part of [event]? — Hands-on lab: Exceptional')


def _row(answers: dict[str, Any], **extra: Any) -> ResultRow:
    return ResultRow(answers, list(answers) or ['q_phases'], 'end_a', extra.pop('at', '2026-11-20T09:00:00Z'), **extra)


class TestTheResults:
    def test_each_row_counts_its_columns_and_averages_their_scores(self):
        definition = fv2.validate_definition(_form())
        rows = [_row({'q_phases': {'rows': {'intro': 'top', 'lab': 'ok'}}}),
                _row({'q_phases': {'rows': {'intro': 'very'}}}), _row({})]
        result = tally_results(definition, rows)['questions'][0]
        assert (result['answered'], result['skipped'], result['scored']) == (2, 1, True)
        assert result['rows'][0] == {'code': 'intro', 'answered': 2, 'average': 3.5,
                                     'counts': {'needs': 0, 'ok': 0, 'very': 1, 'top': 1}}
        assert (result['rows'][2]['answered'], result['rows'][2]['average']) == (0, None)
        assert result['headline'] == 'How was each part of [event]?'

    def test_without_scores_no_row_has_an_average(self):
        unscored = [{key: value for key, value in column.items() if key != 'score'} for column in SCALE]
        definition = fv2.validate_definition(_form(_matrix(columns=unscored)))
        result = tally_results(definition, [_row({'q_phases': {'rows': {'intro': 'top'}}})])['questions'][0]
        assert (result['scored'], result['rows'][0]['average']) == (False, None)

    def test_answers_to_a_removed_row_or_column_are_counted_apart(self):
        definition = fv2.validate_definition(_form(_matrix(rows=PHASES[:2], columns=SCALE[1:])))
        result = tally_results(definition, [_row({'q_phases': {'rows': {'qa': 'ok', 'intro': 'needs',
                                                                        'lab': 'top'}}})])['questions'][0]
        assert (result['removed_rows'], result['removed_columns']) == ({'qa': 1}, {'needs': 1})
        assert result['rows'][0]['counts'] == {'ok': 0, 'very': 0, 'top': 0}

    def test_an_answer_to_a_revision_where_it_was_no_matrix_is_left_to_earlier_version(self):
        definition = fv2.validate_definition(_form())
        revisions = {1: {'questions': [{'id': 'q_phases', 'type': 'nps'}]}}
        result = tally_results(definition, [_row({'q_phases': 9}, revision=1)], revisions=revisions)['questions'][0]
        assert (result['answered'], result['earlier_version'], result['rows'][0]['answered']) == (0, 1, 0)


class TestTheLinkChecks:
    @staticmethod
    def _health(filled: int, total: int, **extra: Any) -> dict[str, Any]:
        rows = [_row({}, hidden={'event': 'Lisbon'} if n < filled else {'event': ' '}, **extra) for n in range(total)]
        return link_health(_form(), rows)

    def test_a_field_never_filled_is_a_warning_from_five_responses(self):
        assert self._health(0, 4)['warnings'] == []
        assert self._health(0, 5)['warnings'] == [{'id': 'event', 'kind': 'never_filled', 'filled': 0, 'total': 5}]

    def test_a_field_mostly_missing_is_a_warning_from_ten_responses_and_80_percent(self):
        assert self._health(1, 9)['warnings'] == []
        assert self._health(2, 10)['warnings'] == [{'id': 'event', 'kind': 'mostly_missing', 'filled': 2,
                                                    'total': 10}]
        assert self._health(3, 10)['warnings'] == []

    def test_it_counts_per_channel_and_names_responses_without_one_unknown(self):
        rows = [_row({}, hidden={'event': 'x'}, channel='link'), _row({}, channel='script'), _row({}, channel='bad'),
                _row({})]
        health = link_health(_form(), rows)
        assert (health['responses'], health['hidden']) == (4, {'event': {'filled': 1, 'missing': 3}})
        assert health['by_channel'] == {
            'link': {'responses': 1, 'hidden': {'event': {'filled': 1, 'missing': 0}}},
            'script': {'responses': 1, 'hidden': {'event': {'filled': 0, 'missing': 1}}},
            'unknown': {'responses': 2, 'hidden': {'event': {'filled': 0, 'missing': 2}}}}

    def test_a_row_counts_towards_a_field_only_when_its_revision_declared_it(self):
        # (revision 1 had no hidden field: its 9 responses are never "missing" event, which revision 2 added)
        before = {**_form(), 'hidden_fields': []}
        rows = [_row({}, revision=1) for _n in range(9)] + [_row({}, hidden={'event': 'Lisbon'}, revision=2),
                                                             _row({}, revision=2)]
        health = link_health(_form(), rows, revisions={1: before})
        assert (health['responses'], health['hidden'], health['warnings']) == (
            11, {'event': {'filled': 1, 'missing': 1}}, [])
        assert health['by_channel']['unknown']['hidden'] == {'event': {'filled': 1, 'missing': 1}}
        # (without the snapshot every row is read on the current revision, which declares it)
        assert link_health(_form(), rows)['warnings'] == [{'id': 'event', 'kind': 'mostly_missing', 'filled': 1,
                                                           'total': 11}]
        assert tally_results(_form(), rows, revisions={1: before})['link_health'] == health

    def test_the_results_answer_carries_it(self):
        assert tally_results(_form(), [])['link_health'] == {'responses': 0, 'hidden': {'event': {'filled': 0,
                                                                                                    'missing': 0}},
                                                             'by_channel': {}, 'warnings': []}
