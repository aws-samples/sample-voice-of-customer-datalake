"""A prototype's validation questions on its own pin form (shared/prototype_validation.py, 7.68.00): the card's
definition in every locale, its save as the pin form's next revision with the FORMREV snapshot (through the forms'
own checks and locks), the public submit's hook (a v2 body only when the form asks questions, the card itself for an
empty one, tagged answers), and the real results under the reader's access."""
from __future__ import annotations

from decimal import Decimal

import pytest
from moto import mock_aws

from shared import forms_v2 as fv2
from shared import prototype_pins
from shared import prototype_validation as proto
from shared.category_access import UNRESTRICTED, CategoryScope
from shared.exceptions import ConflictError, NotFoundError, ValidationError
from shared.test.moto_tables import _create_pk_sk_table_with_index, create_pk_sk_table

DOC = 'prototype_abc123'
FORM = prototype_pins.pin_form_id(DOC)
TASKS = [{'id': 't00aa11', 'text': 'Find last month\'s invoice'}, {'id': 't00bb22', 'text': 'Pay it'}]
CRITERIA = [{'id': 'c00aa11', 'text': 'Finding an invoice is quick', 'target': Decimal('4')}]


@pytest.mark.parametrize('language', fv2.FORM_LOCALES)
def test_the_card_is_a_valid_form_in_every_locale(language):
    definition = fv2.validate_definition(proto.definition_for(TASKS, CRITERIA, language))
    assert [q['id'] for q in definition['questions']] == [
        'q_vt_t00aa11', 'q_vt_t00bb22', proto.CES_ID, 'q_vc_c00aa11', proto.MISSING_ID]
    assert [q['type'] for q in definition['questions']] == [fv2.SINGLE, fv2.SINGLE, fv2.CES, fv2.RATING,
                                                            fv2.OPEN_TEXT]
    assert definition['questions'][0]['headline'] == {language: "Find last month's invoice"}
    assert fv2.question_bounds(definition['questions'][3]) == (1, 5)
    assert not any(q['required'] for q in definition['questions'])


def test_an_unknown_language_is_a_400():
    with pytest.raises(ValidationError, match='language must be one of'):
        proto.definition_for(TASKS, CRITERIA, 'xx')


@pytest.fixture
def forms():
    with mock_aws():
        table = create_pk_sk_table('test-aggregates')
        prototype_pins.ensure_pin_form(table, 'p1', DOC, 'Checkout')
        yield table


def _row(table, sk):
    return table.get_item(Key={'pk': 'FEEDBACK_FORM', 'sk': sk}).get('Item')


class TestTheSave:
    def test_a_version_1_pin_form_becomes_version_2_with_its_revision_1_snapshot(self, forms):
        before = _row(forms, f'FORM#{FORM}')
        saved = proto.save_questions(forms, FORM, proto.definition_for(TASKS, CRITERIA, 'en'), open_card=True,
                                     actor_sub='user-1')
        snapshot = _row(forms, f'FORMREV#{FORM}#000001')
        assert snapshot['revision'] == 1
        assert snapshot['v1']['success_message'] == before['success_message']
        assert snapshot['questions'] == fv2.migrate_v1(before)['questions']
        assert (saved['schema_version'], saved['revision'], saved['write_count'], saved[proto.OPEN_FIELD]) == (
            2, 2, 1, True)
        assert not set(fv2.V1_FIELDS) & set(saved), 'the version 1 fields are removed'
        assert saved['form_type'] == prototype_pins.FORM_TYPE_PROTOTYPE_PIN
        assert saved['form_id'] == FORM
        assert proto.asks_questions(saved)

    def test_closing_the_card_keeps_the_definition_and_its_revision(self, forms):
        proto.save_questions(forms, FORM, proto.definition_for(TASKS, CRITERIA, 'en'), open_card=True,
                             actor_sub='user-1')
        saved = proto.save_questions(forms, FORM, proto.definition_for(TASKS, CRITERIA, 'en'), open_card=False,
                                     actor_sub='user-2')
        assert (saved['revision'], saved['write_count'], saved[proto.OPEN_FIELD], saved['updated_by']) == (
            2, 2, False, 'user-2')
        assert _row(forms, f'FORMREV#{FORM}#000002') is None
        assert not proto.asks_questions(saved)

    def test_a_removed_task_is_a_new_revision_and_its_id_retires(self, forms):
        proto.save_questions(forms, FORM, proto.definition_for(TASKS, CRITERIA, 'en'), open_card=True,
                             actor_sub='user-1')
        saved = proto.save_questions(forms, FORM, proto.definition_for(TASKS[:1], CRITERIA, 'en'), open_card=True,
                                     actor_sub='user-1')
        assert saved['revision'] == 3
        assert _row(forms, f'FORMREV#{FORM}#000002')['questions'][1]['id'] == 'q_vt_t00bb22'
        assert 'q_vt_t00bb22' in saved['retired_ids']

    def test_an_answered_question_keeps_its_type(self, forms):
        proto.save_questions(forms, FORM, proto.definition_for(TASKS, CRITERIA, 'en'), open_card=True,
                             actor_sub='user-1')
        forms.update_item(Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{FORM}'}, UpdateExpression='SET has_responses = :t',
                          ExpressionAttributeValues={':t': True})
        reshaped = proto.definition_for(TASKS, CRITERIA, 'en')
        reshaped['questions'][3]['range'] = 10
        with pytest.raises(ConflictError) as raised:
            proto.save_questions(forms, FORM, reshaped, open_card=True, actor_sub='user-1')
        assert raised.value.code == 'answers_locked'

    def test_a_save_in_between_is_a_409(self, forms, monkeypatch):
        real_read = proto.read_pin_form

        def stale(table, form_id):
            stored = real_read(table, form_id)  # what the save read, before another save moved the row
            forms.update_item(Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{FORM}'},
                              UpdateExpression='SET write_count = :n', ExpressionAttributeValues={':n': 7})
            return stored

        monkeypatch.setattr(proto, 'read_pin_form', stale)
        with pytest.raises(ConflictError) as raised:
            proto.save_questions(forms, FORM, proto.definition_for(TASKS, CRITERIA, 'en'), open_card=True,
                                 actor_sub='user-1')
        assert raised.value.code == 'revision_conflict'

    def test_only_a_prototypes_pin_form_is_saved(self, forms):
        forms.put_item(Item={'pk': 'FEEDBACK_FORM', 'sk': 'FORM#f1', 'form_id': 'f1', 'form_type': 'standard'})
        for form_id in ('f1', 'pf_0000000000000000'):
            with pytest.raises(NotFoundError):
                proto.save_questions(forms, form_id, proto.definition_for(TASKS, CRITERIA, 'en'), open_card=True,
                                     actor_sub='user-1')


class TestTheSubmitHook:
    def _open_form(self, forms):
        return proto.save_questions(forms, FORM, proto.definition_for(TASKS, CRITERIA, 'fr'), open_card=True,
                                    actor_sub='user-1')

    def test_a_pin_form_that_asks_nothing_takes_no_version_2_body(self, forms):
        with pytest.raises(ValidationError) as raised:
            proto.validation_form(_row(forms, f'FORM#{FORM}'))
        assert raised.value.code == proto.CLOSED_CODE

    def test_a_closed_card_takes_none_either(self, forms):
        self._open_form(forms)
        closed = proto.save_questions(forms, FORM, proto.definition_for(TASKS, CRITERIA, 'fr'), open_card=False,
                                      actor_sub='user-1')
        with pytest.raises(ValidationError):
            proto.validation_form(closed)

    def test_an_answer_is_taken_against_the_form_tagged(self, forms):
        form = proto.validation_form({**self._open_form(forms), 'tags': ['beta']})
        assert form['tags'] == ['beta', proto.VALIDATION_TAG]

    def test_an_empty_response_asks_for_the_card_in_the_forms_language(self, forms):
        form = proto.validation_form(self._open_form(forms))
        answer = proto.card_answer(form, {'answers': {}, 'language': 'fr'})
        assert answer is not None
        card = answer['card']
        assert (answer['success'], card['form_id'], card['revision'], card['language']) == (True, FORM, 2, 'fr')
        assert card['title'] == proto.COPY['fr']['title']
        assert card['labels']['send'] == 'Envoyer'
        assert card['questions'][0] == {
            'id': 'q_vt_t00aa11', 'type': fv2.SINGLE, 'headline': "Find last month's invoice",
            'subheader': proto.COPY['fr']['task'],
            'options': [{'code': 'yes', 'label': 'Oui'}, {'code': 'no', 'label': 'Non'}]}
        assert card['questions'][2]['range'] == [1, 7]
        assert card['questions'][3]['range'] == [1, 5]

    @pytest.mark.parametrize('body', [
        {'answers': {'q_v_ces': 6}}, {'answers': {}, 'form_revision': 2}, {'answers': {}, 'test': 'tok'}])
    def test_anything_else_is_an_answer_not_a_card_request(self, forms, body):
        assert proto.card_answer(proto.validation_form(self._open_form(forms)), body) is None


@pytest.fixture
def feedback():
    with mock_aws():
        yield _create_pk_sk_table_with_index('test-feedback', None, 'gsi5-by-channel', 'gsi5pk', 'gsi1sk')


def _item(feedback_id, answers, *, category='billing', at='2026-11-20T10:00:00Z', revision=2):
    return {'pk': 'SOURCE#feedback_form', 'sk': f'FEEDBACK#{feedback_id}', 'gsi5pk': f'CHANNEL#form_{FORM}',
            'gsi1sk': at, 'feedback_id': feedback_id, 'source_platform': 'feedback_form', 'category': category,
            'source_created_at': at, 'source_channel': f'form_{FORM}',
            'metadata': {'form_answers': answers, 'form_revision': revision, 'form_path': list(answers)}}


class TestTheResults:
    def test_real_answers_are_read_by_the_channel_under_the_readers_access(self, feedback):
        feedback.put_item(Item=_item('f1', {'q_vt_t00aa11': {'code': 'yes'}, 'q_vc_c00aa11': 5}))
        feedback.put_item(Item=_item('f2', {'q_vt_t00aa11': {'code': 'no'}, 'q_v_ces': 3}, category='secret',
                                     at='2026-11-20T11:00:00Z'))
        feedback.put_item(Item={**_item('f3', {'q_v_ces': 7}), 'gsi5pk': 'CHANNEL#form_other'})
        everyone = proto.real_rows(feedback, FORM, UNRESTRICTED)
        assert [row.response_id for row in everyone] == ['f2', 'f1']
        billing_only = CategoryScope(all=False, categories=frozenset({'billing'}))
        assert [row.response_id for row in proto.real_rows(feedback, FORM, billing_only)] == ['f1']

    def test_the_summary_per_task_criterion_ease_and_what_was_missing(self):
        definition = fv2.validate_definition(proto.definition_for(TASKS, CRITERIA, 'en'))
        rows = [proto.ResultRow(answers, list(answers), 'end_thanks', f'2026-11-20T1{i}:00:00Z', response_id=f'f{i}',
                                revision=2)
                for i, answers in enumerate([
                    {'q_vt_t00aa11': {'code': 'yes'}, 'q_vc_c00aa11': 5, 'q_v_ces': 6, 'q_v_missing': 'Export'},
                    {'q_vt_t00aa11': {'code': 'yes'}, 'q_vc_c00aa11': 3},
                    {'q_vt_t00aa11': {'code': 'no'}}])]
        summary = proto.real_summary(definition, rows, {}, TASKS, CRITERIA)
        assert summary['responses'] == 3
        assert summary['tasks']['t00aa11'] == {'n': 3, 'yes': 2, 'no': 1, 'rate': 0.6667}
        assert summary['tasks']['t00bb22'] == {'n': 0, 'yes': 0, 'no': 0, 'rate': None}
        assert summary['criteria']['c00aa11']['n'] == 2
        assert summary['criteria']['c00aa11']['average'] == 4.0
        assert summary['ces'] == {'n': 1, 'average': 6.0, 'score': 100.0}
        assert summary['missing'] == [{'text': 'Export', 'at': '2026-11-20T10:00:00Z', 'response_id': 'f0'}]
        assert summary['feedback_ids'] == ['f0', 'f1', 'f2']

    def test_earlier_revisions_are_read_from_their_snapshots(self, forms):
        proto.save_questions(forms, FORM, proto.definition_for(TASKS, CRITERIA, 'en'), open_card=True,
                             actor_sub='user-1')
        revisions = proto.revisions_of(forms, FORM)
        assert sorted(revisions) == [1]
        assert set(revisions[1]) == set(fv2.DEFINITION_FIELDS)
