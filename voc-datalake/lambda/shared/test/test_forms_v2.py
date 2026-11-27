"""Feedback Forms schema version 2 (shared/forms_v2.py): the validation matrix and the version 1 migration.

Every rule of the contract is one case here: the types and their fields, the id and code patterns, the I18nText with
its primary locale, the limits, the logic (ops valid for the type, values for the question, forward-only jumps to
targets that exist), hidden fields, endings, https-only addresses, the test settings, and ids never reused. The
migration covers every version 1 field, ``text_question`` and ``language`` included.
"""
from __future__ import annotations

import copy
import json
from decimal import Decimal
from pathlib import Path
from typing import Any, ClassVar

import pytest

from shared import forms_v2 as fv2
from shared.exceptions import ValidationError
from shared.test.repo_paths import repo_root


def _q(qid: str = 'q_text', kind: str = 'open_text', **extra: Any) -> dict[str, Any]:
    return {'id': qid, 'type': kind, 'headline': {'en': f'Question {qid}'}, 'required': False, **extra}


def _form(*questions: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {'language': 'en', 'languages': ['en'], 'welcome': {'enabled': False},
            'questions': list(questions) or [_q()], 'hidden_fields': [],
            'endings': [{'id': 'end_thanks', 'title': {'en': 'Thanks'}}], **extra}


def _choice(qid: str = 'q_pick', kind: str = 'single_select', **extra: Any) -> dict[str, Any]:
    extra.setdefault('options', [{'code': 'a', 'label': {'en': 'A'}}, {'code': 'b', 'label': {'en': 'B'}}])
    return _q(qid, kind, **extra)


def _refused(definition: dict[str, Any], fragment: str, **kwargs: Any) -> None:
    with pytest.raises(ValidationError) as exc:
        fv2.validate_definition(definition, **kwargs)
    assert fragment in exc.value.message, exc.value.message


def test_the_nine_locales_are_the_apps():
    assert sorted(fv2.FORM_LOCALES) == sorted(p.name for p in (repo_root() / 'frontend/public/locales')
                                               .iterdir() if p.is_dir())


class TestEveryTypeValidates:
    @pytest.mark.parametrize('question', [
        _q('q_a', 'open_text', long=True, input_type='email', placeholder={'en': 'you@x'}, max_chars=200),
        _choice('q_b', other={'enabled': True, 'label': {'en': 'Something else'}}, shuffle='except_last',
                display='dropdown'),
        _choice('q_c', 'multi_select', none={'enabled': True}, min=1, max=2, display='chips'),
        _q('q_d', 'rating', scale='smiley', range=7, lower_label={'en': 'Bad'}, upper_label={'en': 'Great'}),
        _q('q_e', 'nps'), _q('q_f', 'csat'), _q('q_g', 'ces', upper_label={'en': 'Easy'}),
        _q('q_h', 'statement', cta={'label': {'en': 'Read more'}, 'url': 'https://example.com/docs'}),
        _q('q_i', 'consent', label={'en': 'I agree to be contacted'}, required=True),
        _q('q_j', 'contact_info', fields={'email': {'show': True, 'required': True}}),
    ])
    def test_a_valid_question_of_each_type_passes_with_its_defaults_filled(self, question):
        out = fv2.validate_definition(_form(question))['questions'][0]
        assert out['id'] == question['id']
        assert out['type'] == question['type']

    def test_defaults_are_filled_in(self):
        [text, pick, rating] = fv2.validate_definition(_form(_q(), _choice(), _q('q_r', 'rating')))['questions']
        assert (text['long'], text['input_type']) == (False, 'text')
        assert (pick['other'], pick['shuffle'], pick['display']) == ({'enabled': False}, 'none', 'auto')
        assert (rating['scale'], rating['range']) == ('star', 5)

    def test_a_long_text_is_always_text_whatever_input_type_it_was_sent_with(self):
        """A text box takes any text (the widget draws it so): an email check on it would refuse what it accepts."""
        [long, short] = fv2.validate_definition(_form(_q('q_a', 'open_text', long=True, input_type='email'),
                                                      _q('q_b', 'open_text', input_type='email')))['questions']
        assert (long['input_type'], short['input_type']) == ('text', 'email')

    def test_a_statement_is_never_required(self):
        assert fv2.validate_definition(_form(_q('q_s', 'statement', required=True)))['questions'][0]['required'] is False

    def test_contact_fields_absent_are_hidden(self):
        fields = fv2.validate_definition(_form(_q('q_c', 'contact_info', fields={'name': {'show': True, 'required':
                                                                                           False}})))
        assert fields['questions'][0]['fields']['phone'] == {'show': False, 'required': False}


class TestTheValidationMatrix:
    @pytest.mark.parametrize(('change', 'fragment'), [
        (lambda f: f.update(language='it'), 'language must be one of'),
        (lambda f: f.update(languages=['de']), 'must include the primary language'),
        (lambda f: f.update(languages=['en', 'en']), 'at most once'),
        (lambda f: f.update(questions=[]), 'questions must be a list of 1 to 30'),
        (lambda f: f.update(questions=[_q(f'q_{n}') for n in range(31)]), 'questions must be a list of 1 to 30'),
        (lambda f: f['questions'][0].update(id='Q1'), 'id must match'),
        (lambda f: f['questions'][0].update(id='q_' + 'a' * 41), 'id must match'),
        (lambda f: f.update(questions=[_q('q_a'), _q('q_a')]), 'is used twice'),
        (lambda f: f['questions'][0].update(type='slider'), 'type must be one of'),
        (lambda f: f['questions'][0].update(color='red'), 'unknown fields: color'),
        (lambda f: f['questions'][0].update(options=[]), 'unknown fields: options'),
        (lambda f: f['questions'][0].update(headline={}), 'headline.en (the primary language) is required'),
        (lambda f: f['questions'][0].update(headline={'en': '  '}), 'is required'),
        (lambda f: f['questions'][0].update(headline={'pl': 'x'}), "pl is not one of the form's languages"),
        (lambda f: f['questions'][0].update(headline={'en': 'x' * 501}), 'at most 500 characters'),
        (lambda f: f['questions'][0].update(subheader={'en': 7}), 'must be a string'),
        (lambda f: f['questions'][0].update(required='yes'), 'required must be true or false'),
        (lambda f: f['questions'][0].update(input_type='date'), 'input_type must be one of'),
        (lambda f: f['questions'][0].update(max_chars=5001), 'from 1 to 5000'),
        (lambda f: f['questions'][0].update(max_chars=True), 'from 1 to 5000'),
        (lambda f: f.update(hidden_fields=[{'id': '1abc'}]), 'hidden_fields[0].id must match'),
        (lambda f: f.update(hidden_fields=[{'id': 'a'}, {'id': 'a'}]), 'is used twice'),
        (lambda f: f.update(hidden_fields=[{'id': f'h{n}'} for n in range(21)]), 'at most 20 fields'),
        (lambda f: f.update(hidden_fields=[{'id': 'a', 'label': 'x' * 65}]), 'at most 64 characters'),
        (lambda f: f.update(endings=[]), 'endings must be a list of 1 to 5'),
        (lambda f: f.update(endings=[{'id': f'end_{n}', 'title': {'en': 'x'}} for n in range(6)]), '1 to 5'),
        (lambda f: f['endings'][0].update(id='thanks'), 'id must match end_'),
        (lambda f: f['endings'][0].update(button={'label': {'en': 'Go'}, 'url': 'http://example.com'}), 'https://'),
        (lambda f: f['endings'][0].update(button={'label': {'en': 'Go'}, 'url': 'https://u:p@example.com'}),
         'no user name or password'),
        (lambda f: f['endings'][0].update(button={'label': {'en': 'Go'}, 'url': 'https://exa mple.com'}), 'spaces'),
        (lambda f: f.update(welcome={'enabled': True}), 'welcome.title is required'),
        (lambda f: f.update(welcome={'enabled': False, 'logo': 'x'}), 'welcome has unknown fields'),
    ])
    def test_each_rule_refuses_by_name(self, change, fragment):
        form = _form()
        change(form)
        _refused(form, fragment)

    @pytest.mark.parametrize('reserved', ['__proto__', 'constructor', 'prototype'])
    def test_a_name_the_widget_never_fills_is_no_hidden_fields_id(self, reserved):
        """In the widget's script objects these are the prototype's, so the link and the page never fill one;
        no form declares one (``__proto__``, which the id's pattern refuses anyway, is named as reserved too)."""
        form = _form()
        form['hidden_fields'] = [{'id': 'user_id'}, {'id': reserved}]
        _refused(form, f'hidden_fields[1].id "{reserved}" is a reserved name; choose another')
        # (a name that only begins like one is any other id)
        form['hidden_fields'] = [{'id': f'{reserved.strip("_")}_id'}]
        assert fv2.validate_definition(form)['hidden_fields'] == [{'id': f'{reserved.strip("_")}_id'}]

    @pytest.mark.parametrize(('question', 'fragment'), [
        (_choice(options=[]), 'options must be a list of 1 to 50'),
        (_choice(options=[{'code': f'c{n}', 'label': {'en': 'x'}} for n in range(51)]), '1 to 50'),
        (_choice(options=[{'code': 'A', 'label': {'en': 'x'}}]), 'code must match'),
        (_choice(options=[{'code': 'a', 'label': {'en': 'x'}}, {'code': 'a', 'label': {'en': 'y'}}]), 'used twice'),
        (_choice(options=[{'code': 'a', 'label': {}}]), 'label.en (the primary language) is required'),
        (_choice(none={'enabled': True}), 'unknown fields: none'),
        (_choice(min=1), 'unknown fields: min'),
        (_choice('q_m', 'multi_select', min=3), 'min must be a whole number from 1 to 2'),
        (_choice('q_m', 'multi_select', min=2, max=1), 'must not be greater than'),
        (_choice(other={'enabled': True}, options=[{'code': 'other', 'label': {'en': 'x'}}]), 'reserved'),
        (_choice('q_m', 'multi_select', none={'enabled': True}, options=[{'code': 'none', 'label': {'en': 'x'}}]),
         'reserved'),
        (_choice(options=[{'code': 'a', 'label': {'en': 'x'}, 'category': {'category': ''}}]), 'category name'),
        (_choice(shuffle='random'), 'shuffle must be one of'),
        (_choice(display='grid'), 'display must be one of'),
        (_q('q_r', 'rating', range=6), 'range must be one of'),
        (_q('q_r', 'rating', scale='hearts'), 'scale must be one of'),
        (_q('q_n', 'nps', scale='star'), 'unknown fields: scale'),
        (_q('q_s', 'statement', cta={'label': {'en': 'Go'}, 'url': 'ftp://x'}), 'https://'),
        (_q('q_s', 'statement', cta={'url': 'https://x.example'}), 'cta.label is required'),
        (_q('q_c', 'consent'), 'label is required'),
        (_q('q_k', 'contact_info', fields={}), 'show at least one field'),
        (_q('q_k', 'contact_info', fields={'email': {'show': False, 'required': True}}), 'must be shown'),
        (_q('q_k', 'contact_info', fields={'fax': {'show': True, 'required': False}}), 'unknown fields: fax'),
    ])
    def test_each_type_rule_refuses_by_name(self, question, fragment):
        _refused(_form(question), fragment)

    def test_the_whole_definition_is_bounded(self):
        big = [_choice(f'q_{n}', options=[{'code': f'c{i}', 'label': {'en': 'x' * 200}} for i in range(50)])
               for n in range(30)]
        _refused(_form(*big), 'at most 300 KB')


class TestTheLogic:
    @staticmethod
    def _rule(op: str, target: str = 'q_next', value: Any = None) -> dict[str, Any]:
        when: dict[str, Any] = {'op': op}
        if value is not None:
            when['value'] = value
        return {'when': when, 'then': {'jump_to': target}}

    @pytest.mark.parametrize(('question', 'rule'), [
        (_q('q_a', 'nps'), _rule('lte', value=6)),
        (_q('q_a', 'rating', range=10), _rule('equals', value=10)),
        (_q('q_a', 'ces'), _rule('gt', 'end_thanks', 5)),
        (_choice('q_a'), _rule('equals', value='a')),
        (_choice('q_a', other={'enabled': True}), _rule('equals', value='other')),
        (_choice('q_a'), _rule('includes_any', value=['a', 'b'])),
        (_choice('q_a', 'multi_select', none={'enabled': True}), _rule('includes_all', value=['a', 'none'])),
        (_q('q_a'), _rule('equals', value='Price')),
        (_q('q_a'), _rule('skipped')),
        (_q('q_a', 'consent', label={'en': 'ok'}), _rule('submitted')),
        (_q('q_a', 'statement'), _rule('submitted', 'end_thanks')),
    ])
    def test_an_op_valid_for_the_type_with_its_value_passes(self, question, rule):
        out = fv2.validate_definition(_form({**question, 'logic': [rule]}, _q('q_next')))
        assert out['questions'][0]['logic'] == [rule]

    @pytest.mark.parametrize(('question', 'rule', 'fragment'), [
        (_q('q_a'), _rule('lt', value=3), 'op must be one of equals, not_equals, skipped, submitted for a open_text'),
        (_choice('q_a', 'multi_select'), _rule('equals', value='a'), 'for a multi_select'),
        (_q('q_a', 'consent', label={'en': 'ok'}), _rule('equals', value=True), 'for a consent'),
        (_q('q_a', 'statement'), _rule('skipped'), 'for a statement'),
        (_q('q_a', 'nps'), _rule('gte', value=11), 'from 0 to 10'),
        (_q('q_a', 'csat'), _rule('gte', value=0), 'from 1 to 5'),
        (_q('q_a', 'nps'), _rule('gte', value='9'), 'from 0 to 10'),
        (_choice('q_a'), _rule('equals', value='c'), "option codes"),
        (_choice('q_a'), _rule('equals', value='other'), "option codes"),
        (_choice('q_a'), _rule('includes_any', value=[]), 'each once'),
        (_choice('q_a'), _rule('includes_any', value=['a', 'a']), 'each once'),
        (_q('q_a'), _rule('equals', value=''), 'text of 1 to 200'),
        (_q('q_a'), _rule('submitted', value='x'), 'not used by "submitted"'),
        (_q('q_a'), _rule('submitted', 'q_nowhere'), 'must name a question or an ending'),
        (_q('q_a'), {'when': {'op': 'submitted'}, 'then': {'jump_to': 'q_next'}, 'else': 'x'}, 'unknown fields'),
    ])
    def test_a_rule_refuses_by_name(self, question, rule, fragment):
        _refused(_form({**question, 'logic': [rule]}, _q('q_next')), fragment)

    def test_jumps_go_forward_only_so_no_logic_can_loop(self):
        back = _q('q_two', logic=[self._rule('submitted', 'q_one')])
        _refused(_form(_q('q_one'), back), 'must jump forward')
        _refused(_form(_q('q_one', logic=[self._rule('submitted', 'q_one')])), 'must jump forward')

    def test_at_most_twenty_rules(self):
        _refused(_form(_q('q_a', logic=[self._rule('submitted')] * 21), _q('q_next')), 'at most 20 rules')

    def test_an_empty_logic_list_is_no_logic(self):
        assert 'logic' not in fv2.validate_definition(_form(_q('q_a', logic=[])))['questions'][0]


class TestIdsAreNeverReused:
    def test_a_removed_question_id_cannot_come_back(self):
        _refused(_form(_q('q_old')), 'belonged to a removed question', retired=['q_old'])

    def test_retired_ids_collect_what_a_save_removes(self):
        before = _form(_q('q_a'), _q('q_b'), _q('q_c'))
        after = _form(_q('q_a'))
        assert fv2.retired_ids(before, after, ['q_z']) == ['q_z', 'q_b', 'q_c']
        assert len(fv2.retired_ids({'questions': [_q(f'q_{n}') for n in range(30)]}, after,
                                   [f'q_old{n}' for n in range(fv2.MAX_RETIRED_IDS)])) == fv2.MAX_RETIRED_IDS


class TestI18nText:
    def test_translations_fall_back_and_blank_ones_are_dropped(self):
        form = _form(_q(headline={'en': ' Why? ', 'pl': ' '}), languages=['en', 'pl'])
        assert fv2.validate_definition(form)['questions'][0]['headline'] == {'en': 'Why?'}
        assert fv2.text_in({'en': 'Why?'}, 'pl', 'en') == 'Why?'
        assert fv2.text_in({'en': 'Why?', 'pl': 'Dlaczego?'}, 'pl', 'en') == 'Dlaczego?'

    def test_an_optional_text_with_only_a_translation_needs_the_primary(self):
        _refused(_form(_q(subheader={'pl': 'x'}), languages=['en', 'pl']), 'subheader.en (the primary language)')


class TestTheTestSettings:
    def test_link_and_record_are_saved_and_the_token_kept(self):
        current = {'link_enabled': False, 'record': 'tag', 'token': 'secret', 'token_issued_at': 't'}
        out = fv2.validate_test_settings({'test': {'link_enabled': True, 'record': 'drop', 'token_issued': True}},
                                         current)
        assert out == {'link_enabled': True, 'record': 'drop', 'token': 'secret', 'token_issued_at': 't'}

    @pytest.mark.parametrize(('settings', 'fragment'), [
        ({'test': {'record': 'keep'}}, 'record must be one of: tag, drop'),
        ({'test': {'link_enabled': 'yes'}}, 'must be true or false'),
        ({'test': {'token': 'mine'}}, 'unknown fields: token'),
        ({'theme': {}}, 'settings has unknown fields: theme'),
        ([], 'settings must be an object'),
    ])
    def test_a_token_is_never_saved_and_bad_settings_are_refused(self, settings, fragment):
        with pytest.raises(ValidationError) as exc:
            fv2.validate_test_settings(settings, fv2.test_settings_of({}))
        assert fragment in exc.value.message

    def test_settings_as_stored_with_their_defaults(self):
        assert fv2.test_settings_of({}) == {'link_enabled': False, 'record': 'tag'}
        assert fv2.test_settings_of({'settings': {'test': {'link_enabled': True, 'record': 'x', 'token': 't'}}}) == \
            {'link_enabled': True, 'record': 'tag', 'token': 't'}


class TestThePublicProjection:
    def test_routing_and_hidden_labels_are_never_published(self):
        definition = _form(_choice(options=[{'code': 'a', 'label': {'en': 'A'},
                                             'category': {'category': 'pricing'}}]),
                           hidden_fields=[{'id': 'user_id', 'label': 'Internal user'}])
        public = fv2.public_definition(fv2.validate_definition(definition))
        assert 'pricing' not in json.dumps(public)
        assert 'Internal user' not in json.dumps(public)
        assert public['hidden_fields'] == [{'id': 'user_id'}]


# ── Version 1 → 2 ──────────────────────────────────────────────────────────────────────────────────────────────

V1_FORM = {
    'title': 'Share Your Feedback', 'description': 'We value your opinion.', 'question': 'How was it?',
    'placeholder': 'Tell us…', 'rating_enabled': True, 'rating_type': 'stars', 'rating_max': Decimal('5'),
    'submit_button_text': 'Send', 'success_message': 'Thanks!', 'collect_email': True, 'collect_name': True,
    'text_question': 'What could be better?', 'language': 'pl',
}


class TestTheMigration:
    def test_every_v1_field_has_its_place(self):
        out = fv2.migrate_v1(V1_FORM)
        assert out == {
            'language': 'pl', 'languages': ['pl'],
            'welcome': {'enabled': True, 'title': {'pl': 'Share Your Feedback'},
                        'description': {'pl': 'We value your opinion.'}},
            'questions': [
                {'id': 'q_rating', 'type': 'rating', 'headline': {'pl': 'How was it?'}, 'required': True,
                 'scale': 'star', 'range': 5},
                {'id': 'q_text', 'type': 'open_text', 'headline': {'pl': 'What could be better?'}, 'required': True,
                 'long': True, 'input_type': 'text', 'placeholder': {'pl': 'Tell us…'}},
                {'id': 'q_contact', 'type': 'contact_info', 'headline': {'pl': 'Jak możemy się z Tobą skontaktować?'},
                 'required': True,
                 'fields': {'name': {'show': True, 'required': True}, 'email': {'show': True, 'required': True},
                            'phone': {'show': False, 'required': False},
                            'company': {'show': False, 'required': False}}},
            ],
            'hidden_fields': [],
            'endings': [{'id': 'end_thanks', 'title': {'pl': 'Thanks!'}}],
        }
        assert fv2.validate_definition(out) == out

    def test_the_text_step_is_headed_as_7_54_renders_it(self):
        """Rating on: text_question, else "Tell us more"; rating off: question (text_question ignored), else
        "Tell us more" (the pinned behaviour, which the widget's own migration of a v1 config follows too)."""
        def headline(**fields: Any) -> dict:
            return fv2.migrate_v1(fields)['questions'][-1]['headline']
        assert headline(rating_enabled=False, question='Q', text_question='T') == {'en': 'Q'}
        assert headline(rating_enabled=False, question='Q') == {'en': 'Q'}
        assert headline(rating_enabled=True, question='Q', text_question='T') == {'en': 'T'}
        assert headline(rating_enabled=True, question='Q') == {'en': 'Tell us more'}
        assert headline(rating_enabled=False, question='', language='pl') == {'pl': 'Powiedz nam więcej'}
        assert fv2.migrate_v1({'rating_enabled': False, 'question': 'Q'})['questions'][0]['id'] == 'q_text'

    @pytest.mark.parametrize(('locale', 'text'), sorted(fv2.TELL_US_MORE.items()))
    def test_tell_us_more_is_localized_in_every_locale(self, locale, text):
        assert fv2.migrate_v1({'language': locale})['questions'][-1]['headline'] == {locale: text}

    @pytest.mark.parametrize(('kind', 'rating_max', 'scale', 'size'), [
        ('stars', 5, 'star', 5), ('stars', 3, 'star', 3), ('stars', 6, 'star', 7), ('stars', 8, 'star', 10),
        ('emoji', 9, 'smiley', 5), ('numeric', 5, 'number', 10), ('stars', 'x', 'star', 5),
    ])
    def test_the_rating_type_and_max_map_to_a_scale_and_range(self, kind, rating_max, scale, size):
        rating = fv2.migrate_v1({'rating_type': kind, 'rating_max': rating_max})['questions'][0]
        assert (rating['scale'], rating['range']) == (scale, size)

    def test_the_submit_button_text_is_not_carried_over_but_kept_in_the_snapshot(self):
        """The version 1 widget never showed it, and its untouched English default would land on a Polish form."""
        out = fv2.migrate_v1({'submit_button_text': 'Submit Feedback', 'language': 'pl'})
        assert all('button_label' not in q for q in out['questions'])
        assert fv2.v1_source({'submit_button_text': 'Submit Feedback'}) == {'submit_button_text': 'Submit Feedback'}

    def test_contact_collects_only_what_was_collected(self):
        [*_, contact] = fv2.migrate_v1({'collect_email': True})['questions']
        assert contact['fields']['email'] == {'show': True, 'required': True}
        assert contact['fields']['name'] == {'show': False, 'required': False}
        assert [q['type'] for q in fv2.migrate_v1({})['questions']] == ['rating', 'open_text']

    def test_an_empty_language_takes_the_deployments_and_is_flagged(self):
        assert fv2.migrate_v1({'language': ''}, 'de')['language'] == 'de'
        assert fv2.migrate_v1({'language': 'xx'}, 'zz')['language'] == 'en'
        assert fv2.language_assumed({'language': ''}) is True
        assert fv2.language_assumed({'language': 'pl'}) is False
        assert fv2.language_assumed({'schema_version': 2, 'language': ''}) is False

    def test_a_blank_title_is_no_welcome_screen_and_a_blank_message_the_localized_thanks(self):
        out = fv2.migrate_v1({'title': '', 'success_message': '', 'language': 'de'})
        assert out['welcome'] == {'enabled': False}
        assert out['endings'][0]['title'] == {'de': 'Vielen Dank!'}

    def test_a_v2_form_is_read_as_stored_and_a_v1_one_migrated(self):
        stored = {'schema_version': Decimal('2'), 'revision': Decimal('3'), **_form()}
        assert fv2.definition_of(stored) == _form()
        assert fv2.revision_of(stored) == 3
        assert fv2.revision_of({}) == 1
        assert fv2.definition_of(V1_FORM) == fv2.migrate_v1(V1_FORM)

    def test_the_v1_source_is_kept_as_stored(self):
        assert fv2.v1_source({**V1_FORM, 'name': 'not v1'}) == {**V1_FORM, 'rating_max': 5}

    def test_plain_turns_decimals_back_at_any_depth(self):
        assert fv2.plain({'a': [Decimal('2'), Decimal('2.5'), {'b': Decimal('-3')}]}) == {'a': [2, 2.5, {'b': -3}]}

    def test_the_migration_never_changes_its_input(self):
        item = copy.deepcopy(V1_FORM)
        fv2.migrate_v1(item)
        assert item == V1_FORM


_ANSWERED = {'questions': [
    {'id': 'q_a', 'type': 'single_select', 'options': [{'code': 'x'}, {'code': 'y'}]},
    {'id': 'q_b', 'type': 'open_text'},
    {'id': 'q_c', 'type': 'multi_select', 'options': [{'code': 'z'}]},
]}


class TestTheLockOfAnAnsweredForm:
    """``unnamed_removals``: what a save drops from an answered form without naming it in ``removes``."""

    def test_a_dropped_question_and_a_dropped_or_renamed_code_are_named(self):
        proposed = {'questions': [{'id': 'q_a', 'type': 'single_select', 'options': [{'code': 'x'}, {'code': 'y2'}]},
                                  {'id': 'q_c', 'type': 'open_text'}, {'id': 'q_new', 'type': 'open_text'}]}
        nothing = fv2.validate_removes(None)
        assert fv2.unnamed_removals(_ANSWERED, proposed, nothing) == {
            'questions': ['q_b'], 'options': {'q_a': ['y'], 'q_c': ['z']}}
        named = fv2.validate_removes({'questions': ['q_b'], 'options': {'q_a': ['y'], 'q_c': ['z']}})
        assert fv2.unnamed_removals(_ANSWERED, proposed, named) == {}

    def test_keeping_every_id_and_code_needs_no_names(self):
        assert fv2.unnamed_removals(_ANSWERED, copy.deepcopy(_ANSWERED), fv2.validate_removes({})) == {}

    def test_removes_is_closed_and_bounded(self):
        assert fv2.validate_removes({'questions': ['q_a', 'q_a']}) == {'questions': {'q_a'}, 'options': {}, 'rows': {},
                                                                       'columns': {}}
        for bad in ([], {'questions': 'q_a'}, {'questions': [1]}, {'options': []}, {'options': {'q_a': 'x'}},
                    {'other': []}, {'questions': ['q_x'] * (fv2.MAX_QUESTIONS + 1)},
                    {'options': {f'q_{n}': [] for n in range(fv2.MAX_QUESTIONS + 1)}}):
            with pytest.raises(ValidationError):
                fv2.validate_removes(bad)

    def test_a_kept_question_with_another_type_or_range_is_reshaped(self):
        """``reshaped_questions``: never allowed on an answered form, named or not (its answers would be read anew)."""
        before = {'questions': [{'id': 'q_r', 'type': 'rating', 'range': 5}, {'id': 'q_c', 'type': 'csat'},
                                {'id': 'q_s', 'type': 'rating', 'range': 5, 'scale': 'star'},
                                {'id': 'q_p', 'type': 'single_select'}, {'id': 'q_gone', 'type': 'nps'}]}
        after = {'questions': [{'id': 'q_r', 'type': 'rating', 'range': 10}, {'id': 'q_c', 'type': 'nps'},
                               {'id': 'q_s', 'type': 'rating', 'range': 5, 'scale': 'number'},
                               {'id': 'q_p', 'type': 'multi_select'}, {'id': 'q_new', 'type': 'ces'}]}
        assert fv2.reshaped_questions(before, after) == ['q_r', 'q_c', 'q_p']
        assert fv2.reshaped_questions(before, copy.deepcopy(before)) == []
        assert fv2.answer_shape({'type': 'rating'}) == ('rating', (1, 5))

    def test_a_reused_question_id_is_refused_with_its_code(self):
        with pytest.raises(ValidationError) as refused:
            fv2.validate_definition(_form(), retired=[_form()['questions'][0]['id']])
        assert (refused.value.code, refused.value.details) == (
            'question_id_reused', {'question_id': _form()['questions'][0]['id']})


class TestPublishing:
    """Text respondents can read: under 3:1 on its background in a palette that can be shown refuses Publish and a
    colour change on a live form, and only warns on another save of a live form already on that theme
    (shared/form_theme.py, the editor's and the widget's rules)."""

    GREY: ClassVar[dict[str, str]] = {'text_color': '#9ca3af'}  # 2.54:1 on white

    @pytest.mark.parametrize('theme', [None, {}, {'mode': 'auto'}, {'text_color': '#767676'}, {'text_color': '#949494'},
                                       {'mode': 'dark', 'text_color': '#9ca3af'}],
                             ids=['absent', 'empty', 'auto-defaults', 'aa', 'warning-only', 'grey-light-not-shown'])
    def test_a_readable_theme_publishes(self, theme):
        assert fv2.theme_publish_problems(theme) == []
        fv2.validate_publishable(theme, live=True)

    def test_unreadable_text_refuses_a_live_form_with_its_code_and_palettes(self):
        with pytest.raises(ValidationError) as refused:
            fv2.validate_publishable(self.GREY, live=True)
        assert refused.value.code == fv2.THEME_UNREADABLE == 'theme_unreadable'
        assert refused.value.details == {'palettes': [{'palette': 'light', 'ratio': 2.54}], 'minimum': 3.0}
        assert refused.value.message.startswith('The text on the light background is 2.5:1, under 3:1')

    def test_every_palette_that_can_be_shown_is_checked(self):
        dark = {'mode': 'auto', 'dark': {'text_color': '#333333'}}  # #333 on #19161d: 1.4:1
        assert [p['palette'] for p in fv2.theme_publish_problems(dark)] == ['dark']
        assert [p['palette'] for p in fv2.theme_publish_problems({**dark, **self.GREY})] == ['light', 'dark']
        assert fv2.theme_publish_problems({**dark, 'mode': 'light'}) == []

    def test_a_form_that_stays_off_is_always_saved(self):
        # Nothing raises, and nothing is to be said: an Off form's theme is checked only when it goes live.
        assert fv2.validate_publishable(self.GREY, live=False) == []
        assert fv2.validate_publishable(self.GREY, live=False, was_live=True, theme_changed=True) == []

    def test_a_live_form_kept_on_its_unreadable_theme_is_a_warning_and_a_change_or_publish_a_refusal(self):
        assert fv2.validate_publishable(self.GREY, live=True, was_live=True, theme_changed=False) == ['theme_unreadable']
        assert fv2.validate_publishable({}, live=True, was_live=True, theme_changed=False) == []
        assert fv2.validate_publishable(self.GREY, live=False, was_live=True, theme_changed=True) == []
        for was_live, changed in ((True, True), (False, False), (False, True)):
            with pytest.raises(ValidationError) as exc:
                fv2.validate_publishable(self.GREY, live=True, was_live=was_live, theme_changed=changed)
            assert exc.value.code == 'theme_unreadable'

    def test_two_themes_are_the_same_when_they_draw_the_same_form(self):
        assert fv2.same_theme(self.GREY, {**self.GREY, 'mode': 'light', 'font': 'system'})
        assert fv2.same_theme(None, {})
        assert not fv2.same_theme(self.GREY, {**self.GREY, 'border_radius': '4px'})


def test_the_module_imports_nothing_but_the_standard_library_and_four_pure_shared_modules():
    """Pure (portable to main as is): no AWS client; of shared, only the exceptions, dynamo_values' ``plain`` and
    form_theme (the theme's contrast rules) and forms_recall (the recall grammar), all standard library only."""
    source = Path(fv2.__file__).read_text(encoding='utf-8')
    imports = [line.split('  #')[0] for line in source.splitlines() if line.startswith(('import ', 'from '))]
    assert [line for line in imports if 'shared' in line] == [
        'from shared import form_theme, forms_recall', 'from shared.dynamo_values import plain',
        'from shared.exceptions import ConflictError, ValidationError']
