"""Forms data quality through the form API (lambda/api/feedback_form_handler.py; docs/feedback-forms.md
"Matrix", "Recall", "Link checks" and the CSV's layouts): the publish guard (409 ``unresolved_placeholder``, and a form
saved before 7.06.00 still served), a matrix submitted, counted and locked, the link checks over the view, and the
responses CSV in the familiar and detailed layouts.

Against moto tables, with the fixtures and helpers of test_feedback_form_v2.py.
"""
from __future__ import annotations

import csv
import io
from typing import Any

import pytest
from test_feedback_form_v2 import V2_FORM, _call, _create, _item, _queued, _submit
from test_feedback_form_v2 import world as v2_world

from shared.ingest_schemas import validate_message
from shared.test.source_profile_fixtures import no_source_profiles

_no_profiles = pytest.fixture(autouse=True)(no_source_profiles)
#: test_feedback_form_v2.py's moto tables and wired handler.
world = v2_world

#: A live form of two questions: a single choice (its rules dropped) and a rating.
LIVE = {**V2_FORM, 'questions': [{key: value for key, value in V2_FORM['questions'][0].items() if key != 'logic'},
                                 V2_FORM['questions'][2]]}
MATRIX = {'id': 'q_phases', 'type': 'matrix', 'headline': {'pl': 'Jak oceniasz {{app_version|warsztat}}?'},
          'required': False,
          'rows': [{'code': 'intro', 'label': {'pl': 'Wstęp'}}, {'code': 'lab', 'label': {'pl': 'Laboratorium'}}],
          'columns': [{'code': 'ok', 'label': {'pl': 'Dobrze'}, 'score': 1},
                      {'code': 'top', 'label': {'pl': 'Świetnie'}, 'score': 2}]}
MATRIX_FORM = {**V2_FORM, 'name': 'Warsztat: Łódź', 'tags': ['pilot'], 'questions': [MATRIX],
               'endings': V2_FORM['endings']}


def _with_label(label: str) -> dict[str, Any]:
    """LIVE with its first option labelled ``label``."""
    first = {**LIVE['questions'][0], 'options': [{**LIVE['questions'][0]['options'][0], 'label': {'pl': label}},
                                                  LIVE['questions'][0]['options'][1]]}
    return {**LIVE, 'questions': [first, LIVE['questions'][1]]}


def _stored(world: dict, form_id: str) -> dict[str, Any]:
    return world['aggregates'].get_item(Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'})['Item']


@pytest.mark.usefixtures('world')
class TestThePublishGuard:
    def test_a_form_created_live_with_a_placeholder_shown_as_written_is_a_409_naming_it(self, lambda_context):
        status, answer = _call(lambda_context, 'POST', '/feedback-forms', body=_with_label('Cena {{app_version}}'))
        assert (status, answer['code']) == (409, 'unresolved_placeholder')
        assert answer['texts'] == [{'where': 'questions[0].options[0].label.pl', 'placeholder': '{{app_version}}'}]

    def test_a_draft_saves_but_cannot_be_published_until_it_is_fixed(self, lambda_context):
        fid = _create(lambda_context, {**_with_label('Cena {{app_version}}'), 'enabled': False})['form_id']
        status, answer = _call(lambda_context, 'PUT', f'/feedback-forms/{fid}', body={'enabled': True})
        assert (status, answer['code']) == (409, 'unresolved_placeholder')
        assert _call(lambda_context, 'PUT', f'/feedback-forms/{fid}', body={**_with_label('Cena'), 'enabled': True})[0] \
            == 200

    def test_a_save_of_a_live_form_is_refused_and_turning_it_off_always_works(self, world, lambda_context):
        fid = _create(lambda_context, LIVE)['form_id']
        status, _answer = _call(lambda_context, 'PUT', f'/feedback-forms/{fid}', body=_with_label('A {{screen}}'))
        assert (status, _stored(world, fid)['revision']) == (409, 1)
        assert _call(lambda_context, 'PUT', f'/feedback-forms/{fid}', body={**_with_label('A {{screen}}'),
                                                                            'enabled': False})[0] == 200

    def test_recall_that_can_be_filled_is_published(self, lambda_context):
        recalled = {**LIVE['questions'][1], 'headline': {'pl': 'Ocena {{ q_reason | tego }} w {{screen}}'}}
        form = _create(lambda_context, {**LIVE, 'questions': [LIVE['questions'][0], recalled]})
        assert (form['enabled'], form['questions'][1]['headline']) == (True, {'pl': 'Ocena {{ q_reason | tego }} w '
                                                                                    '{{screen}}'})

    def test_a_definition_save_refuses_a_recall_it_cannot_fill(self, lambda_context):
        fid = _create(lambda_context, {**LIVE, 'enabled': False})['form_id']
        later = {**LIVE['questions'][0], 'headline': {'pl': 'Po {{q_rate}}'}}
        status, answer = _call(lambda_context, 'PUT', f'/feedback-forms/{fid}',
                               body={'questions': [later, LIVE['questions'][1]]})
        assert (status, answer['code'], answer['where'], answer['id']) == (400, 'recall_not_before',
                                                                           'questions[0].headline.pl', 'q_rate')

    def test_a_form_saved_before_7_61_keeps_serving_but_is_not_published_again_until_fixed(self, world,
                                                                                         lambda_context):
        fid = _create(lambda_context, LIVE)['form_id']
        legacy = {**LIVE['questions'][1], 'headline': {'pl': 'Jak było, {{customer}}?'}}
        world['aggregates'].update_item(Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{fid}'},
                                        UpdateExpression='SET questions = :q',
                                        ExpressionAttributeValues={':q': [LIVE['questions'][0], legacy]})
        _status, config = _call(lambda_context, 'GET', f'/feedback-forms/{fid}/config', claims={})
        assert (config['config']['enabled'], config['config']['questions'][1]['headline']) == \
            (True, {'pl': 'Jak było, {{customer}}?'})
        assert _call(lambda_context, 'PUT', f'/feedback-forms/{fid}', body={'name': 'Renamed'})[1]['code'] == \
            'unresolved_placeholder'
        assert _call(lambda_context, 'PUT', f'/feedback-forms/{fid}', body={'enabled': False})[0] == 200


@pytest.mark.usefixtures('world')
class TestTheMatrix:
    @pytest.fixture
    def tested(self, lambda_context) -> tuple[str, str]:
        fid = _create(lambda_context, MATRIX_FORM)['form_id']
        token = _call(lambda_context, 'POST', f'/feedback-forms/{fid}/test-link', body={})[1]['test']['token']
        return fid, token

    def test_a_matrix_answer_is_queued_with_one_line_per_row(self, world, lambda_context, tested):
        fid, _token = tested
        status, _answer = _submit(lambda_context, fid, {'answers': {'q_phases': {'rows': {'lab': 'top'}}},
                                                        'channel': 'link'})
        assert status == 200
        queued = _queued(world)
        assert queued['text'] == 'Jak oceniasz [app_version]? — Laboratorium: Świetnie'
        # (the processor's ingest schema takes it: a matrix answer is a mapping of row codes to column codes)
        metadata = validate_message(queued).metadata
        assert metadata is not None
        assert metadata.form_answers == {'q_phases': {'rows': {'lab': 'top'}}}

    def test_results_count_each_row_and_the_link_checks_follow_the_channel(self, lambda_context, tested):
        fid, token = tested
        for rows, channel in (({'intro': 'ok', 'lab': 'top'}, 'iframe'), ({'intro': 'top'}, None)):
            body = {'answers': {'q_phases': {'rows': rows}}, 'test': token, 'hidden': {'screen': 'home'},
                    **({'channel': channel} if channel else {})}
            assert _submit(lambda_context, fid, body)[0] == 200
        _status, results = _call(lambda_context, 'GET', f'/feedback-forms/{fid}/results',
                                 query={'include_test': 'true'})
        assert results['questions'][0]['rows'][0] == {'code': 'intro', 'answered': 2, 'average': 1.5,
                                                      'counts': {'ok': 1, 'top': 1}}
        health = results['link_health']
        assert (health['hidden']['app_version'], health['by_channel']['iframe']['responses']) == \
            ({'filled': 0, 'missing': 2}, 1)
        assert sorted(health['by_channel']) == ['iframe', 'unknown']

    def test_a_dropped_row_of_an_answered_matrix_must_be_named(self, lambda_context, tested):
        fid, _token = tested
        assert _submit(lambda_context, fid, {'answers': {'q_phases': {'rows': {'lab': 'top'}}}})[0] == 200
        fewer = {**MATRIX, 'rows': MATRIX['rows'][:1]}
        status, answer = _call(lambda_context, 'PUT', f'/feedback-forms/{fid}', body={'questions': [fewer]})
        assert (status, answer['code'], answer['rows'], 'columns' in answer) == \
            (409, 'answers_locked', {'q_phases': ['lab']}, False)
        assert _call(lambda_context, 'PUT', f'/feedback-forms/{fid}',
                     body={'questions': [fewer], 'removes': {'rows': {'q_phases': ['lab']}}})[0] == 200


def _csv(lambda_context: Any, form_id: str, **query: str) -> tuple[int, dict[str, Any]]:
    return _call(lambda_context, 'GET', f'/feedback-forms/{form_id}/responses', query={'format': 'csv', **query},
                 raw=True)


@pytest.mark.usefixtures('world')
class TestTheCsv:
    @pytest.fixture
    def answered(self, world, lambda_context) -> str:
        fid = _create(lambda_context, MATRIX_FORM)['form_id']
        world['feedback'].put_item(Item=_item(fid, 'f1', '2026-11-20T10:30:00+01:00',
                                              {'q_phases': {'rows': {'intro': 'ok'}}}, ['q_phases'],
                                              form_hidden={'app_version': '=1+1'}))
        return fid

    def test_the_familiar_layout_is_the_default_named_after_the_form(self, lambda_context, answered):
        status, response = _csv(lambda_context, answered)
        assert (status, response['body'][0]) == (200, '﻿')
        disposition = response['multiValueHeaders']['Content-Disposition'][0]
        assert disposition.startswith('attachment; filename="warsztat-lodz-responses-20')
        rows = list(csv.reader(io.StringIO(response['body'][1:])))
        assert rows == [['Submission ID', 'Submitted On', 'Locale', 'Tags', 'App version', 'screen',
                         'Jak oceniasz [app_version]? - Wstęp', 'Jak oceniasz [app_version]? - Laboratorium'],
                        ['f1', '2026-11-20T09:30:00Z', 'pl', 'pilot', "'=1+1", '', 'Dobrze', '']]

    def test_ids_adds_the_row_of_ids_and_detailed_keeps_7_55s_file(self, lambda_context, answered):
        rows = list(csv.reader(io.StringIO(_csv(lambda_context, answered, ids='true')[1]['body'][1:])))
        assert rows[1][-2:] == ['q_phases.intro', 'q_phases.lab']
        _status, detailed = _csv(lambda_context, answered, layout='detailed')
        assert detailed['multiValueHeaders']['Content-Disposition'] == [
            f'attachment; filename="{answered}-responses.csv"']
        assert list(csv.reader(io.StringIO(detailed['body'])))[2][6] == 'Wstęp: Dobrze'

    @pytest.mark.parametrize('query', [{'layout': 'wide'}, {'ids': 'maybe'}], ids=['layout', 'ids'])
    def test_an_unknown_layout_or_ids_is_a_400(self, lambda_context, answered, query):
        assert _csv(lambda_context, answered, **query)[0] == 400
