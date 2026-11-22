"""The Validate step's routes (shared/project_validation_routes.py, 7.68.00) through the projects API's handler, on moto
tables: the criteria (extracted once by a job, edited by hand), the plan (a job, or a hand-written one now), the
synthetic run (labelled, stored synthetic, never "met"), the testers' card on the prototype's own pin form (its next
revision, the CSP untouched) and the report with its decision prefill; every route an edit, the GET too."""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from moto import mock_aws
from prototype_pins_fixtures import call_projects_api

from shared import forms_v2 as fv2
from shared import project_validation as pv
from shared import project_validation_routes as routes
from shared import prototype_pins, validation_ai
from shared import prototype_validation as proto
from shared.prompt_safety import DATA_NOTICE
from shared.prototype_pins import PIN_SUBMIT_URL_METADATA_KEY, inject_pin_widget, pin_form_id, pin_submit_url
from shared.prototypes import prototype_s3_key
from shared.test.moto_tables import _create_pk_sk_table_with_index, create_pk_sk_table

PROJECT = 'proj_1'
DOC = 'prototype_abc123'
FORM = pin_form_id(DOC)
EDITOR = {'sub': 'editor-sub', 'cognito:username': 'eddie', 'email': 'eddie@example.com'}
VIEWER = {'sub': 'viewer-sub', 'cognito:username': 'vic', 'email': 'vic@example.com'}
BUCKET = 'test-raw'
API_BASE = 'https://abcde12345.execute-api.us-east-1.amazonaws.com/v1'
HTML = ('<!doctype html><html><body><section data-screen="invoices"><h1>Invoices</h1><p>March invoice</p>'
        '<button>Pay</button></section></body></html>')
BASE = f'/projects/{PROJECT}/validation'


class Tables:
    def __init__(self) -> None:
        self.projects = create_pk_sk_table('test-projects')
        self.aggregates = create_pk_sk_table('test-aggregates')
        self.feedback = _create_pk_sk_table_with_index('test-feedback', None, 'gsi5-by-channel', 'gsi5pk', 'gsi1sk')
        self.s3 = boto3.client('s3', region_name='us-east-1')
        self.s3.create_bucket(Bucket=BUCKET)
        self.projects.put_item(Item={
            'pk': f'PROJECT#{PROJECT}', 'sk': 'META', 'project_id': PROJECT, 'name': 'Billing', 'status': 'active',
            'owner_sub': 'owner-sub', 'visibility': 'private',
            'members': {EDITOR['sub']: {'role': 'editor', 'username': 'eddie'},
                        VIEWER['sub']: {'role': 'viewer', 'username': 'vic'}}})

    def add_prototype(self, doc_suffix: str = '') -> None:
        doc_id = f'{DOC}{doc_suffix}'
        form_id = pin_form_id(doc_id)
        prototype_pins.ensure_pin_form(self.aggregates, PROJECT, doc_id, 'Checkout')
        page = inject_pin_widget(HTML, form_id, pin_submit_url(form_id, API_BASE))
        self.s3.put_object(Bucket=BUCKET, Key=prototype_s3_key(PROJECT, doc_id), Body=page.encode(),
                           Metadata=prototype_pins.prototype_object_metadata(doc_id, page, API_BASE))
        self.projects.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': f'PROTOTYPE#{doc_id}', 'document_id': doc_id,
                                     'document_type': 'prototype', 'prototype_format': 'html', 'version': 1,
                                     'created_at': f'2026-11-20T10:00:0{len(doc_suffix)}Z'})

    def add_prd(self, content: str = '## Success Metrics\n- Finding an invoice takes under a minute') -> None:
        self.projects.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'PRD#prd_1', 'document_id': 'prd_1',
                                     'document_type': 'prd', 'content': content, 'created_at': '2026-11-19T10:00:00Z'})

    def add_persona(self, persona_id: str, name: str) -> None:
        self.projects.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': f'PERSONA#{persona_id}',
                                     'persona_id': persona_id, 'name': name, 'tagline': 'Pays invoices monthly'})

    def block(self) -> dict[str, Any]:
        return pv.block_of(self.projects.get_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'META'}).get('Item'))

    def document(self, document_id: str) -> dict[str, Any]:
        item = self.projects.get_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': f'DOC#{document_id}'}).get('Item')
        assert item is not None, document_id
        return dict(item)


@pytest.fixture
def tables(monkeypatch):
    monkeypatch.setenv('RAW_DATA_BUCKET', BUCKET)
    with mock_aws(), \
            patch.object(routes, 'get_projects_table', side_effect=lambda: world.projects), \
            patch.object(routes, 'get_aggregates_table', side_effect=lambda: world.aggregates), \
            patch.object(routes, 'get_feedback_table', side_effect=lambda: world.feedback), \
            patch.object(routes, 'get_s3_client', side_effect=lambda: world.s3), \
            patch('shared.validation_documents.create_counted_project_child', side_effect=_put_document):
        world = Tables()
        yield world


def _put_document(table, _project_id, _prefix, build, **_kwargs):
    item = build(f'doc_{len(list(table.scan()["Items"]))}')
    table.put_item(Item=item)
    return item


class Caller:
    """One call of the projects API on the tables; ``started`` is the last assist start's call (the job is patched)."""

    def __init__(self, tables: Tables, event_factory: Any, lambda_context: Any) -> None:
        self.tables, self.event_factory, self.lambda_context = tables, event_factory, lambda_context
        self.started: Any = None

    def __call__(self, claims: dict, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        event = self.event_factory(method=method, path=path, body=body, claims=claims)
        with patch.object(routes.assist_jobs, 'start', return_value={'success': True, 'job_id': 'job_1',
                                                                     'status': 'pending'}) as start:
            status, answer = call_projects_api(self.tables.projects, self.tables.aggregates, event, self.lambda_context)
        self.started = start.call_args
        return status, answer


@pytest.fixture
def call(tables, api_gateway_event, lambda_context):
    return Caller(tables, api_gateway_event, lambda_context)


def _criteria(tables, *texts: str) -> list[dict]:
    criteria = pv.validated_criteria([{'text': text} for text in texts])
    pv.update_block(tables.projects, PROJECT, lambda _s: {'criteria': criteria}, actor={'sub': 's', 'kind': 'user'},
                    reason='seed')
    return criteria


class TestEveryRouteIsAnEdit:
    @pytest.mark.parametrize(('method', 'path'), [('GET', BASE), ('PUT', f'{BASE}/criteria'),
                                                  ('PUT', f'{BASE}/form'), ('POST', f'{BASE}/report')])
    def test_a_viewer_is_refused_before_any_read(self, call, method, path):
        status, body = call(VIEWER, method, path, {})
        assert (status, body['error']) == (403, 'You do not have permission to edit this project')


class TestCriteria:
    def test_the_view_before_anything(self, call):
        status, body = call(EDITOR, 'GET', BASE)
        assert status == 200, body
        assert (body['validation'], body['criteria'], body['real'], body['form']) == ({}, [], None, None)
        assert [s['step'] for s in body['methodology']['skipped']] == ['prototype', 'prd']

    def test_an_editor_saves_criteria_by_hand_and_a_stale_one_is_a_409(self, call, tables):
        status, body = call(EDITOR, 'PUT', f'{BASE}/criteria', {'criteria': [{'text': 'Quick', 'target': 4.5}]})
        assert status == 200, body
        assert body['validation']['criteria'][0]['target'] == 4.5
        assert tables.block()['updated_by'] == {'sub': EDITOR['sub'], 'kind': 'user'}
        status, body = call(EDITOR, 'PUT', f'{BASE}/criteria', {'criteria': [{'text': 'Other'}], 'expected_revision': 0})
        assert (status, body.get('code')) == (409, pv.CHANGED_CODE)

    def test_extraction_needs_a_prd_and_runs_once(self, call, tables):
        assert call(EDITOR, 'POST', f'{BASE}/criteria', {})[0] == 400
        tables.add_prd()
        status, body = call(EDITOR, 'POST', f'{BASE}/criteria', {'response_language': 'de'})
        assert (status, body['job_id']) == (202, 'job_1')
        config = call.started.args[2]
        assert (config['prd_document_id'], config['response_language'], config['actor']['sub']) == (
            'prd_1', 'de', EDITOR['sub'])
        _criteria(tables, 'Quick')
        assert call(EDITOR, 'POST', f'{BASE}/criteria', {})[1]['code'] == 'criteria_exist'
        assert call(EDITOR, 'POST', f'{BASE}/criteria', {'replace': True})[0] == 202

    def test_the_extraction_job_saves_what_the_model_found(self, tables):
        tables.add_prd()
        reply = json.dumps({'criteria': [{'text': 'Finding an invoice takes under a minute'}, {'text': ''}]})
        with patch('shared.validation_ai.converse', return_value=reply) as model:
            result = routes._criteria_work({'project_id': PROJECT, 'prd_document_id': 'prd_1',
                                            'actor': {'sub': 'editor-sub', 'kind': 'user'}})
        assert '<document>' in model.call_args.kwargs['prompt']
        assert [c['text'] for c in result['validation']['criteria']] == ['Finding an invoice takes under a minute']
        assert (tables.block()['reason'], tables.block()['prd_document_id']) == (pv.REASON_CRITERIA_EXTRACTED, 'prd_1')


class TestThePlan:
    def test_criteria_come_first(self, call):
        status, body = call(EDITOR, 'POST', f'{BASE}/plan', {})
        assert (status, body['error']) == (400, routes.NEEDS_CRITERIA)

    def test_a_hand_written_plan_is_made_now_and_says_what_it_skipped(self, call, tables):
        _criteria(tables, 'Quick')
        status, body = call(EDITOR, 'POST', f'{BASE}/plan', {'mode': 'blank'})
        assert status == 201, body
        document = tables.document(body['document']['document_id'])
        assert (document['document_type'], document['origin'], document['created_by_sub']) == (
            'validation_plan', 'human', EDITOR['sub'])
        assert '### Quick' in document['content']
        assert document['methodology']['evidence'] == 0
        assert [s['step'] for s in body['methodology']['skipped']] == ['prototype', 'prd']
        assert tables.block()['plan_document_id'] == document['document_id']

    def test_the_ai_plan_is_a_job_reading_the_newest_prototype_and_personas(self, call, tables):
        _criteria(tables, 'Quick')
        tables.add_prototype()
        tables.add_persona('persona_1', 'Ana')
        status, body = call(EDITOR, 'POST', f'{BASE}/plan', {})
        assert (status, body['methodology']['skipped']) == (202, [{'step': 'prd', 'reason': 'missing'}])
        config = call.started.args[2]
        assert (config['prototype_document_id'], config['persona_ids']) == (DOC, ['persona_1'])

    def test_the_plan_job_writes_the_document_and_the_tasks(self, tables):
        [criterion] = _criteria(tables, 'Quick')
        tables.add_prototype()
        tables.add_persona('persona_1', 'Ana')
        reply = json.dumps({'guide': [{'criterion_id': criterion['id'], 'questions': ['How did you look?'] * 5,
                                       'probes': [{'persona_id': 'persona_1', 'probe': 'And monthly?'}]}],
                            'tasks': [{'text': 'Find the March invoice', 'success': 'It opens'}]})
        with patch('shared.validation_ai.converse', return_value=reply) as model:
            result = routes._plan_work({'project_id': PROJECT, 'prototype_document_id': DOC,
                                        'persona_ids': ['persona_1'], 'actor': {'sub': 'editor-sub', 'kind': 'user'},
                                        'methodology': {'step': 'validation'}})
        assert 'March invoice' in model.call_args.kwargs['prompt'], 'the outline reaches the model'
        document = tables.document(result['document_id'])
        assert document['plan']['tasks'] == [{'text': 'Find the March invoice', 'success': 'It opens'}]
        assert 'Ana: And monthly?' in document['content']
        block = tables.block()
        assert [t['text'] for t in block['tasks']] == ['Find the March invoice']
        assert (block['prototype_document_id'], 'status' in block) == (DOC, False)


class TestTheCard:
    def test_saving_it_writes_the_pin_forms_next_revision_and_never_the_prototype(self, call, tables):
        _criteria(tables, 'Quick')
        tables.add_prototype()
        before = tables.s3.head_object(Bucket=BUCKET, Key=prototype_s3_key(PROJECT, DOC))
        status, body = call(EDITOR, 'PUT', f'{BASE}/form', {'tasks': [{'text': 'Pay'}], 'open': True,
                                                            'language': 'es'})
        assert status == 200, body
        assert body['form'] == {'form_id': FORM, 'revision': 2, 'open': True, 'questions': 4, 'has_responses': False,
                                'stale': False, 'newer_version': None}
        form = proto.read_pin_form(tables.aggregates, FORM)
        assert form['language'] == 'es'
        assert proto.asks_questions(form)
        assert tables.aggregates.get_item(Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORMREV#{FORM}#000001'}).get('Item')
        after = tables.s3.head_object(Bucket=BUCKET, Key=prototype_s3_key(PROJECT, DOC))
        assert after['ETag'] == before['ETag']
        assert after['Metadata'][PIN_SUBMIT_URL_METADATA_KEY] == pin_submit_url(FORM, API_BASE), (
            'the CSP keeps its one connect-src: the same form, the same submit URL')
        block = tables.block()
        assert (block['form_id'], block['form_open'], block['card_in_prototype']) == (FORM, True, True)

    def test_a_version_made_before_the_card_is_said_to_need_a_new_one(self, call, tables):
        _criteria(tables, 'Quick')
        tables.add_prototype()
        old_widget = prototype_pins.widget_source().replace(routes.CARD_WIDGET_MARKER, 'gone')
        with patch.object(prototype_pins, 'widget_source', return_value=old_widget):
            tables.add_prototype(doc_suffix='_v2')
        call(EDITOR, 'PUT', f'{BASE}/form', {'tasks': [{'text': 'Pay'}], 'open': True})
        assert (tables.block()['prototype_document_id'], tables.block()['card_in_prototype']) == (f'{DOC}_v2', False)

    def test_a_pin_form_deleted_since_leaves_the_view_without_a_card(self, call, tables):
        _criteria(tables, 'Quick')
        tables.add_prototype()
        call(EDITOR, 'PUT', f'{BASE}/form', {'tasks': [{'text': 'Pay'}], 'open': True})
        tables.aggregates.delete_item(Key=proto.form_key(FORM))
        status, view = call(EDITOR, 'GET', BASE)
        assert (status, view['form'], view['real']) == (200, None, None)

    def test_criteria_edited_since_make_the_card_stale(self, call, tables):
        _criteria(tables, 'Quick')
        tables.add_prototype()
        call(EDITOR, 'PUT', f'{BASE}/form', {'tasks': [{'text': 'Pay'}], 'open': True})
        call(EDITOR, 'PUT', f'{BASE}/criteria', {'criteria': [{'text': 'Clear'}]})
        assert call(EDITOR, 'GET', BASE)[1]['form']['stale'] is True

    def test_a_block_write_in_between_is_a_409_and_the_card_still_matches_the_block(self, call, tables):
        _criteria(tables, 'Quick')
        tables.add_prototype()
        call(EDITOR, 'PUT', f'{BASE}/form', {'tasks': [{'text': 'Pay'}], 'open': True})
        revision = tables.block()['revision']
        real_read, reads = pv.read_meta, []

        def read_then_a_job_finishes(table: Any, project_id: str) -> dict:
            meta = real_read(table, project_id)
            reads.append(project_id)
            if len(reads) == 1:  # the save's own read: a job finishing writes the block just after it
                pv.update_block(tables.projects, PROJECT, lambda _s: {'run_document_id': 'doc_run'},
                                actor={'sub': 'job', 'kind': 'user'}, reason='seed')
            return meta

        with patch.object(pv, 'read_meta', side_effect=read_then_a_job_finishes):
            status, body = call(EDITOR, 'PUT', f'{BASE}/form', {'tasks': [{'text': 'Refund'}], 'open': True,
                                                                'expected_revision': revision})
        assert (status, body.get('code')) == (409, pv.CHANGED_CODE)
        asked = [q['headline'] for q in fv2.definition_of(proto.read_pin_form(tables.aggregates, FORM))['questions']
                 if q['id'].startswith(proto.TASK_PREFIX)]
        assert asked == [{'en': task['text']} for task in tables.block()['tasks']] == [{'en': 'Pay'}]

    def test_a_newer_version_is_flagged_and_moving_the_card_there_closes_the_old_one(self, call, tables):
        _criteria(tables, 'Quick')
        tables.add_prototype()
        call(EDITOR, 'PUT', f'{BASE}/form', {'tasks': [{'text': 'Pay'}], 'open': True})
        tables.add_prototype(doc_suffix='_v2')
        view = call(EDITOR, 'GET', BASE)[1]
        assert (view['form']['form_id'], view['form']['newer_version']) == (FORM, f'{DOC}_v2')
        status, body = call(EDITOR, 'PUT', f'{BASE}/form', {'tasks': [{'text': 'Pay'}], 'open': True})
        assert (status, body['form']['form_id'], body['form']['newer_version']) == (200, pin_form_id(f'{DOC}_v2'), None)
        old = proto.read_pin_form(tables.aggregates, FORM)
        assert (old['validation_open'], proto.asks_questions(old)) == (False, False)
        assert proto.asks_questions(proto.read_pin_form(tables.aggregates, pin_form_id(f'{DOC}_v2')))

    @pytest.mark.parametrize(('body', 'status'), [
        ({'tasks': [{'text': 'Pay'}]}, 400), ({'tasks': [], 'open': True}, 400),
        ({'tasks': [{'text': 'Pay'}], 'open': True, 'language': 'xx'}, 400),
        ({'tasks': [{'text': 'Pay'}], 'open': True, 'prototype_document_id': 'nope'}, 404),
    ])
    def test_a_bad_card_is_refused(self, call, tables, body, status):
        _criteria(tables, 'Quick')
        tables.add_prototype()
        assert call(EDITOR, 'PUT', f'{BASE}/form', body)[0] == status

    def test_no_prototype_is_a_400(self, call, tables):
        _criteria(tables, 'Quick')
        assert call(EDITOR, 'PUT', f'{BASE}/form', {'tasks': [{'text': 'Pay'}], 'open': True}) == (
            400, {'success': False, 'error': routes.NO_PROTOTYPE})


def _answer(tables, feedback_id: str, answers: dict, at: str) -> None:
    tables.feedback.put_item(Item={
        'pk': 'SOURCE#feedback_form', 'sk': f'FEEDBACK#{feedback_id}', 'gsi5pk': f'CHANNEL#form_{FORM}', 'gsi1sk': at,
        'feedback_id': feedback_id, 'source_platform': 'feedback_form', 'category': 'billing',
        'source_created_at': at, 'metadata': {'form_answers': answers, 'form_revision': 2, 'form_path': list(answers)}})


def _restating_model(**kwargs: Any) -> str:
    """A model that restates every line of the data it was given (what one told to restate the data would do)."""
    return str(kwargs['prompt']).split(DATA_NOTICE, 1)[1].split('</validation_results>', 1)[0].strip()


class TestSyntheticAndReal:
    def _ready(self, call, tables) -> tuple[dict, dict]:
        [criterion] = _criteria(tables, 'Quick')
        tables.add_prototype()
        tables.add_persona('persona_1', 'Ana')
        tables.add_persona('persona_2', 'Ben')
        call(EDITOR, 'PUT', f'{BASE}/form', {'tasks': [{'text': 'Pay'}], 'open': True})
        return criterion, tables.block()['tasks'][0]

    def test_a_run_needs_tasks_a_prototype_and_personas(self, call, tables):
        _criteria(tables, 'Quick')
        assert call(EDITOR, 'POST', f'{BASE}/synthetic', {})[1]['error'] == routes.NEEDS_TASKS

    def test_the_run_is_synthetic_and_never_met_even_when_every_persona_says_five(self, call, tables):
        criterion, task = self._ready(call, tables)
        status, _ = call(EDITOR, 'POST', f'{BASE}/synthetic', {})
        assert status == 202
        config = call.started.args[2]
        assert (config['prototype_document_id'], config['persona_ids']) == (DOC, ['persona_1', 'persona_2'])
        reply = json.dumps({'tasks': [{'id': task['id'], 'outcome': 'completed', 'note': 'Easy'}],
                            'criteria': [{'id': criterion['id'], 'rating': 5, 'note': 'Yes'}], 'summary': 'Fine'})
        with patch('shared.validation_ai.converse', side_effect=[reply, 'not json']):
            result = routes._synthetic_work({**config, 'actor': {'sub': 'editor-sub', 'kind': 'user'}})
        document = tables.document(result['document_id'])
        assert (document['document_type'], document['synthetic'], result['personas']) == ('validation_run', True, 1)
        assert document['content'].startswith('# Synthetic validation run\n\n> Synthetic:')
        status, view = call(EDITOR, 'GET', BASE)
        [result] = view['criteria']
        assert (result['outcome'], result['synthetic']['reading'], result['synthetic']['synthetic']) == (
            pv.NOT_ENOUGH_DATA, pv.LIKELY_MET, True)
        assert view['tasks'][0]['synthetic']['completed'] == 1

    def test_real_answers_are_judged_and_the_report_quotes_no_tester(self, call, tables):
        criterion, task = self._ready(call, tables)
        for index in range(5):
            _answer(tables, f'f{index}', {f'q_vt_{task["id"]}': {'code': 'yes'}, f'q_vc_{criterion["id"]}': 5,
                                          'q_v_missing': 'An export button'}, f'2026-11-20T1{index}:00:00Z')
        status, view = call(EDITOR, 'GET', BASE)
        assert view['criteria'][0]['outcome'] == pv.MET
        assert view['real']['missing'][0]['text'] == 'An export button'
        assert 'feedback_ids' not in view['real']
        assert view['decision_prefill']['verdict'] == 'pursue'
        status, body = call(EDITOR, 'POST', f'{BASE}/report', {})
        assert status == 202
        assert body['methodology']['step'] == 'validation'
        config = call.started.args[2]
        with patch('shared.validation_ai.converse', side_effect=_restating_model) as model:
            result = routes._report_work({**config, 'actor': {'sub': 'editor-sub', 'kind': 'user'}})
        assert 'An export button' not in model.call_args.kwargs['prompt']
        assert 'missing' not in validation_ai._SUMMARY_SYSTEM
        document = tables.document(result['document_id'])
        assert document['document_type'] == 'validation_report'
        assert 'Testers who said what was missing: 5' in document['content'], 'the summary restates what it was given'
        assert 'An export button' not in document['content'], 'a tester is quoted live, never in the document'
        assert sorted(document['input_feedback_ids']) == [f'f{i}' for i in range(5)]
        assert document['results'][0]['outcome'] == pv.MET
        assert result['decision_prefill']['evidence']['document_ids'] == [result['document_id']]
        assert tables.block()['report_document_id'] == result['document_id']

    def test_the_report_reads_as_its_starter(self, call, tables):
        criterion, _task = self._ready(call, tables)
        _answer(tables, 'f1', {f'q_vc_{criterion["id"]}': 5}, '2026-11-20T10:00:00Z')
        with patch('shared.validation_ai.converse', return_value=''):
            result = routes._report_work({'project_id': PROJECT, 'actor': {'sub': 'x', 'kind': 'user'},
                                          'category_scope': {'all': False, 'categories': ['other']}})
        assert tables.document(result['document_id'])['report']['responses'] == 0


def test_a_synthetic_run_is_never_edited_through_the_generic_document_routes():
    import projects
    from shared.exceptions import ValidationError

    with pytest.raises(ValidationError, match='synthetic validation run is not edited'):
        projects._refuse_decision_edit({'document_type': pv.RUN_TYPE})
    projects._refuse_decision_edit({'document_type': pv.PLAN_TYPE})  # a plan and a report are a person's to edit
