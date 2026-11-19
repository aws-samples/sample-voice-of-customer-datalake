"""A version 2 response (shared/forms_v2_responses.py): every answer checked against the form's revision, the logic
path, hidden fields, the refusal codes, and what the feedback item becomes (its text, category, rating)."""
from __future__ import annotations

from typing import Any

import pytest

from shared import forms_v2 as fv2
from shared import forms_v2_responses as fr
from shared.exceptions import ValidationError

FORM = fv2.validate_definition({
    'language': 'pl', 'languages': ['pl', 'en'], 'welcome': {'enabled': False},
    'questions': [
        {'id': 'q_nps', 'type': 'nps', 'headline': {'pl': 'Czy polecisz nas?', 'en': 'Recommend us?'},
         'required': True,
         'logic': [{'when': {'op': 'lte', 'value': 6}, 'then': {'jump_to': 'q_why_low'}},
                   {'when': {'op': 'gte', 'value': 9}, 'then': {'jump_to': 'q_reason'}}]},
        {'id': 'q_why_low', 'type': 'open_text', 'headline': {'pl': 'Co nie działa?'}, 'required': True,
         'max_chars': 50, 'logic': [{'when': {'op': 'submitted'}, 'then': {'jump_to': 'end_sorry'}}]},
        {'id': 'q_reason', 'type': 'multi_select', 'headline': {'pl': 'Co lubisz?'}, 'required': False,
         'options': [{'code': 'speed', 'label': {'pl': 'Szybkość'},
                      'category': {'category': 'performance', 'subcategory': 'speed'}},
                     {'code': 'price', 'label': {'pl': 'Cena'}, 'category': {'category': 'pricing'}},
                     {'code': 'ui', 'label': {'pl': 'Wygląd'}}],
         'other': {'enabled': True}, 'none': {'enabled': True}, 'min': 1, 'max': 2},
        {'id': 'q_rate', 'type': 'rating', 'headline': {'pl': 'Ocena'}, 'required': False, 'range': 5},
        {'id': 'q_ok', 'type': 'consent', 'headline': {'pl': 'Kontakt?'}, 'label': {'pl': 'Zgadzam się'},
         'required': False},
        {'id': 'q_contact', 'type': 'contact_info', 'headline': {'pl': 'Dane'}, 'required': False,
         'fields': {'email': {'show': True, 'required': True}, 'name': {'show': True, 'required': False}}},
    ],
    'hidden_fields': [{'id': 'user_id'}, {'id': 'app_version'}],
    'endings': [{'id': 'end_thanks', 'title': {'pl': 'Dziękujemy'}}, {'id': 'end_sorry', 'title': {'pl': 'Przykro'}}],
})


def _ok(**body: Any) -> fr.Response:
    fr.check_envelope({'answers': {}, **body})
    return fr.validate_response(FORM, {'answers': {}, **body})


def _check(body: dict[str, Any]) -> fr.Response:
    fr.check_envelope(body)
    return fr.validate_response(FORM, body)


def _refused(body: dict[str, Any], code: str, question_id: str | None = None) -> str:
    with pytest.raises(ValidationError) as exc:
        _check(body)
    assert exc.value.code == code, exc.value.message
    assert exc.value.details.get('question_id') == question_id
    return exc.value.message


class TestTheLogicPath:
    def test_a_detractor_goes_to_its_follow_up_then_its_ending(self):
        response = _ok(answers={'q_nps': 3, 'q_why_low': 'Wolno'})
        assert (response.path, response.ending_id) == (['q_nps', 'q_why_low'], 'end_sorry')

    def test_a_promoter_skips_the_detractors_question(self):
        response = _ok(answers={'q_nps': 10, 'q_reason': {'codes': ['speed']}})
        assert response.path == ['q_nps', 'q_reason', 'q_rate', 'q_ok', 'q_contact']
        assert response.ending_id == 'end_thanks'

    def test_a_passive_runs_on_to_the_next_question(self):
        # q_why_low's one rule needs an answer, so without one the path runs on to the end.
        assert fr.logic_path(FORM, {'q_nps': 7}) == (
            ['q_nps', 'q_why_low', 'q_reason', 'q_rate', 'q_ok', 'q_contact'], 'end_thanks')
        assert fr.logic_path(FORM, {'q_nps': 7, 'q_why_low': 'x'}) == (['q_nps', 'q_why_low'], 'end_sorry')

    def test_an_answer_to_a_question_the_logic_skipped_is_refused(self):
        _refused({'answers': {'q_nps': 10, 'q_why_low': 'x'}}, fr.ANSWER_SKIPPED, 'q_why_low')

    def test_a_required_question_on_the_path_must_be_answered(self):
        _refused({'answers': {'q_nps': 2}}, fr.ANSWER_REQUIRED, 'q_why_low')
        _refused({'answers': {}}, fr.ANSWER_REQUIRED, 'q_nps')

    def test_a_skipped_optional_question_is_fine_and_a_statement_always_counts_as_submitted(self):
        definition = fv2.validate_definition({
            'language': 'en', 'questions': [
                {'id': 'q_s', 'type': 'statement', 'headline': {'en': 'Hi'}, 'required': False,
                 'logic': [{'when': {'op': 'submitted'}, 'then': {'jump_to': 'q_c'}}]},
                {'id': 'q_b', 'type': 'open_text', 'headline': {'en': 'B'}, 'required': True},
                {'id': 'q_c', 'type': 'open_text', 'headline': {'en': 'C'}, 'required': False,
                 'logic': [{'when': {'op': 'skipped'}, 'then': {'jump_to': 'end_b'}}]},
                {'id': 'q_d', 'type': 'open_text', 'headline': {'en': 'D'}, 'required': False}],
            'endings': [{'id': 'end_a', 'title': {'en': 'A'}}, {'id': 'end_b', 'title': {'en': 'B'}}]})
        assert fr.logic_path(definition, {}) == (['q_s', 'q_c'], 'end_b')
        assert fr.logic_path(definition, {'q_c': 'x'}) == (['q_s', 'q_c', 'q_d'], 'end_a')

    @pytest.mark.parametrize(('op', 'value', 'answer', 'matches'), [
        ('equals', 'price', {'code': 'price'}, True), ('equals', 'price', {'code': 'speed'}, False),
        ('equals', 'other', {'other': 'x'}, True), ('not_equals', 'price', {'code': 'speed'}, True),
        ('not_equals', 'price', None, False), ('includes_any', ['a', 'b'], {'codes': ['b', 'c']}, True),
        ('includes_any', ['a'], {'codes': ['c']}, False), ('includes_all', ['a', 'b'], {'codes': ['a', 'b', 'c']}, True),
        ('includes_all', ['a', 'other'], {'codes': ['a'], 'other': 'x'}, True),
        ('lt', 5, 4, True), ('lt', 5, 5, False), ('lte', 5, 5, True), ('gt', 5, 6, True), ('gte', 5, 4, False),
        ('submitted', None, 'x', True), ('skipped', None, None, True), ('skipped', None, 'x', False),
    ])
    def test_each_op(self, op, value, answer, matches):
        question = {'id': 'q_x', 'type': 'single_select' if isinstance(answer, dict) else 'nps'}
        when = {'op': op, **({} if value is None else {'value': value})}
        assert fr.rule_matches(question, when, answer) is matches

    def test_open_text_equals_ignores_case(self):
        assert fr.rule_matches({'type': 'open_text'}, {'op': 'equals', 'value': 'Price'}, 'price') is True

    @pytest.mark.parametrize(('value', 'answer', 'matches'), [
        ('École', 'ÉCOLE', True), ('Straße', 'STRASSE', False), ('İstanbul', 'i̇stanbul', True),
    ])
    def test_open_text_equals_folds_case_as_the_widget_does(self, value, answer, matches):
        """str.lower, as JavaScript's toLowerCase in the widget (feedbackWidget.flow.test.ts pins the same pairs):
        casefold would also take ß for ss, sending the server down another path than the respondent's."""
        assert fr.rule_matches({'type': 'open_text'}, {'op': 'equals', 'value': value}, answer) is matches


class TestEveryAnswerIsChecked:
    @pytest.mark.parametrize(('answers', 'code', 'qid'), [
        ({'q_nps': 11}, fr.ANSWER_INVALID, 'q_nps'),
        ({'q_nps': -1}, fr.ANSWER_INVALID, 'q_nps'),
        ({'q_nps': '9'}, fr.ANSWER_INVALID, 'q_nps'),
        ({'q_nps': True}, fr.ANSWER_INVALID, 'q_nps'),
        ({'q_nps': 9.5}, fr.ANSWER_INVALID, 'q_nps'),
        ({'q_nps': 3, 'q_why_low': 'x' * 51}, fr.ANSWER_INVALID, 'q_why_low'),
        ({'q_nps': 3, 'q_why_low': 7}, fr.ANSWER_INVALID, 'q_why_low'),
        ({'q_nps': 10, 'q_reason': {'codes': ['gold']}}, fr.ANSWER_INVALID, 'q_reason'),
        ({'q_nps': 10, 'q_reason': {'codes': ['speed', 'speed']}}, fr.ANSWER_INVALID, 'q_reason'),
        ({'q_nps': 10, 'q_reason': {'codes': ['speed', 'price', 'ui']}}, fr.SELECTION_COUNT, 'q_reason'),
        ({'q_nps': 10, 'q_reason': {'codes': ['speed', 'price'], 'other': 'x'}}, fr.SELECTION_COUNT, 'q_reason'),
        ({'q_nps': 10, 'q_reason': {'codes': ['none', 'speed']}}, fr.ANSWER_INVALID, 'q_reason'),
        ({'q_nps': 10, 'q_reason': {'code': 'speed'}}, fr.ANSWER_INVALID, 'q_reason'),
        ({'q_nps': 10, 'q_reason': {'codes': ['speed'], 'extra': 1}}, fr.ANSWER_INVALID, 'q_reason'),
        ({'q_nps': 10, 'q_rate': 6}, fr.ANSWER_INVALID, 'q_rate'),
        ({'q_nps': 10, 'q_ok': 'yes'}, fr.ANSWER_INVALID, 'q_ok'),
        ({'q_nps': 10, 'q_contact': {'name': 'Ann'}}, fr.ANSWER_REQUIRED, 'q_contact'),
        ({'q_nps': 10, 'q_contact': {'email': 'not-an-address'}}, fr.ANSWER_INVALID, 'q_contact'),
        ({'q_nps': 10, 'q_contact': {'email': 'a@b.pl', 'phone': '123'}}, fr.ANSWER_INVALID, 'q_contact'),
        ({'q_nps': 10, 'q_gone': 1}, fr.ANSWER_UNKNOWN, 'q_gone'),
    ])
    def test_a_bad_answer_is_refused_with_its_code_and_question(self, answers, code, qid):
        _refused({'answers': answers}, code, qid)

    def test_normalised_answers_and_dropped_blanks(self):
        response = _ok(answers={'q_nps': 10, 'q_reason': {'codes': ['ui', 'speed']}, 'q_rate': None, 'q_ok': False,
                                'q_contact': {'email': ' a@b.pl ', 'name': ''}})
        assert response.answers == {'q_nps': 10, 'q_reason': {'codes': ['speed', 'ui']},
                                    'q_contact': {'email': 'a@b.pl'}}

    def test_none_of_these_is_its_own_answer_and_other_text_counts_as_a_choice(self):
        assert _ok(answers={'q_nps': 9, 'q_reason': {'codes': ['none']}}).answers['q_reason'] == {'codes': ['none']}
        assert _ok(answers={'q_nps': 9, 'q_reason': {'codes': [], 'other': ' Support '}}).answers['q_reason'] == \
            {'codes': [], 'other': 'Support'}

    @pytest.mark.parametrize(('input_type', 'good', 'bad'), [
        ('email', 'a@b.pl', 'a@b'), ('number', '3.5', 'three'), ('phone', '+48 600 100 200', 'call me'),
        ('url', 'https://x.example/a', 'x.example'), ('text', 'anything', None),
    ])
    def test_open_text_input_types(self, input_type, good, bad):
        definition = fv2.validate_definition({'language': 'en', 'questions': [
            {'id': 'q_t', 'type': 'open_text', 'headline': {'en': 'T'}, 'required': True, 'input_type': input_type}],
            'endings': [{'id': 'end_a', 'title': {'en': 'A'}}]})
        assert fr.validate_response(definition, {'answers': {'q_t': good}}).answers == {'q_t': good}
        if bad is not None:
            with pytest.raises(ValidationError):
                fr.validate_response(definition, {'answers': {'q_t': bad}})

    def test_a_long_text_stored_with_another_input_type_takes_any_text(self):
        """A form saved before this check may hold one: the widget draws it as a text box, so any text is its answer."""
        definition = {'language': 'en', 'questions': [{'id': 'q_t', 'type': 'open_text', 'headline': {'en': 'T'},
                                                        'required': True, 'long': True, 'input_type': 'email'}],
                      'endings': [{'id': 'end_a', 'title': {'en': 'A'}}]}
        assert fr.validate_response(definition, {'answers': {'q_t': 'not an email'}}).answers == {'q_t': 'not an email'}

    def test_a_statement_takes_no_answer(self):
        definition = fv2.validate_definition({'language': 'en', 'questions': [
            {'id': 'q_s', 'type': 'statement', 'headline': {'en': 'Hi'}, 'required': False},
            {'id': 'q_t', 'type': 'open_text', 'headline': {'en': 'T'}, 'required': False}],
            'endings': [{'id': 'end_a', 'title': {'en': 'A'}}]})
        with pytest.raises(ValidationError) as exc:
            fr.validate_response(definition, {'answers': {'q_s': 'clicked', 'q_t': 'x'}})
        assert (exc.value.code, exc.value.details) == (fr.ANSWER_INVALID, {'question_id': 'q_s'})

    def test_an_empty_response_and_too_much_text_are_refused(self):
        definition = fv2.validate_definition({'language': 'en', 'questions': [
            {'id': f'q_{n}', 'type': 'open_text', 'headline': {'en': 'T'}, 'required': False} for n in range(5)],
            'endings': [{'id': 'end_a', 'title': {'en': 'A'}}]})
        _code = fr.EMPTY_RESPONSE
        with pytest.raises(ValidationError) as exc:
            fr.validate_response(definition, {'answers': {'q_0': '  '}})
        assert exc.value.code == _code
        with pytest.raises(ValidationError) as exc:
            fr.validate_response(definition, {'answers': {f'q_{n}': 'x' * 4500 for n in range(5)}})
        assert exc.value.code == fr.RESPONSE_TOO_LONG


class TestHiddenFieldsLanguageAndEnding:
    def test_declared_hidden_fields_are_kept_trimmed_and_blank_ones_dropped(self):
        response = _ok(answers={'q_nps': 9}, hidden={'user_id': ' u_1 ', 'app_version': ''})
        assert response.hidden == {'user_id': 'u_1'}

    @pytest.mark.parametrize(('hidden', 'code'), [
        ({'plan': 'pro'}, fr.HIDDEN_UNKNOWN), ({'user_id': 'x' * 201}, fr.HIDDEN_INVALID),
        ({'user_id': 5}, fr.HIDDEN_INVALID), ({f'h{n}': 'x' for n in range(21)}, fr.HIDDEN_INVALID),
    ])
    def test_undeclared_or_long_hidden_values_are_refused(self, hidden, code):
        _refused({'answers': {'q_nps': 9}, 'hidden': hidden}, code)

    def test_the_language_is_one_of_the_forms_and_defaults_to_the_primary(self):
        assert _ok(answers={'q_nps': 9}).language == 'pl'
        assert _ok(answers={'q_nps': 9}, language='en').language == 'en'
        _refused({'answers': {'q_nps': 9}, 'language': 'de'}, fr.LANGUAGE_INVALID)
        _refused({'answers': {'q_nps': 9}, 'language': 'it'}, fr.LANGUAGE_INVALID)

    def test_a_named_ending_must_be_the_one_the_logic_reaches(self):
        assert _ok(answers={'q_nps': 9}, ending_id='end_thanks').ending_id == 'end_thanks'
        _refused({'answers': {'q_nps': 9}, 'ending_id': 'end_sorry'}, fr.ENDING_MISMATCH)


class TestTheEnvelope:
    @pytest.mark.parametrize('body', [
        {'answers': [], 'x': 1}, {'answers': {'q': 1}, 'is_test': True}, {'answers': 'x'},
        {'answers': {f'q_{n}': 1 for n in range(31)}}, {'answers': {}, 'form_revision': 0},
        {'answers': {}, 'form_revision': True}, {'answers': {}, 'test': 'x' * 65}, {'answers': {}, 'ending_id': 3},
        {'answers': {}, 'session': 'short'}, {'answers': {}, 'session': 'with spaces in it'}, {'answers': {}, 'session': 5},
        {'answers': {}, 'channel': 'app'}, {'answers': {}, 'channel': 'Link'}, {'answers': {}, 'channel': 5},
    ])
    def test_unknown_keys_and_malformed_fields_are_refused_before_any_read(self, body):
        with pytest.raises(ValidationError):
            fr.check_envelope(body)

    def test_a_body_without_answers_is_the_version_1_widgets(self):
        assert fr.is_v2_response({'answers': {}}) is True
        assert fr.is_v2_response({'text': 'x'}) is False


class TestTheFeedbackItem:
    def test_the_text_is_each_free_text_answer_under_its_primary_headline(self):
        detractor = _ok(answers={'q_nps': 3, 'q_why_low': 'Wolno działa'}, language='en')
        assert fr.response_text(FORM, detractor) == 'Co nie działa?\nWolno działa'
        promoter = _ok(answers={'q_nps': 10, 'q_reason': {'codes': ['speed'], 'other': 'Wsparcie'}})
        assert fr.response_text(FORM, promoter) == 'Co lubisz?\nWsparcie'

    def test_a_response_without_free_text_reads_as_its_structured_answers(self):
        response = _ok(answers={'q_nps': 10, 'q_reason': {'codes': ['speed', 'price']}, 'q_rate': 4, 'q_ok': True,
                                'q_contact': {'email': 'a@b.pl'}})
        assert fr.response_text(FORM, response) == (
            'Czy polecisz nas?: 10/10\nCo lubisz?: Szybkość, Cena\nOcena: 4/5\nKontakt?: ✓\nDane: ✓')
        assert 'a@b.pl' not in fr.response_text(FORM, response)

    def test_the_category_is_the_first_answered_option_that_maps_one(self):
        both = _ok(answers={'q_nps': 10, 'q_reason': {'codes': ['price', 'speed']}})
        assert fr.answer_category(FORM, both) == {'category': 'performance', 'subcategory': 'speed'}
        price = _ok(answers={'q_nps': 10, 'q_reason': {'codes': ['price', 'ui']}})
        assert fr.answer_category(FORM, price) == {'category': 'pricing'}
        assert fr.answer_category(FORM, _ok(answers={'q_nps': 10, 'q_reason': {'codes': ['ui']}})) is None

    def test_the_items_rating_is_the_first_rating_question_never_the_nps(self):
        assert fr.item_rating(FORM, _ok(answers={'q_nps': 10, 'q_rate': 4})) == 4
        assert fr.item_rating(FORM, _ok(answers={'q_nps': 10})) is None

    def test_the_contact_answer(self):
        response = _ok(answers={'q_nps': 10, 'q_contact': {'email': 'a@b.pl', 'name': 'Ann'}})
        assert fr.contact_of(FORM, response) == {'email': 'a@b.pl', 'name': 'Ann'}
