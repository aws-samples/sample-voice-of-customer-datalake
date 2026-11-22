"""A form report's AI summary on the SETTINGS API (7.63.00, shared/forms_report_routes.py; docs/feedback-forms.md
"Report"): `POST /settings/form-reports` starts an assist job the settings twin runs, only for a form the request's own
scope holds, by whoever manages forms there (a viewer 403), 20 per person per hour; the twin's work writes the report
row in the job's own scope (labels and ids, never a respondent's text), and none for a form deleted meanwhile.

Against moto tables (aggregates, jobs, workspaces), with the fixtures of test_settings_form_drafts.py.
"""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

import pytest
from boto3.dynamodb.conditions import Key
from test_settings_form_drafts import EDITOR, USER, VIEWER, WS, _call, _job_rows
from test_settings_form_drafts import world as drafts_world

import settings_handler
from shared import assist_jobs, forms_report_routes, forms_v2_report_ai
from shared.custom_models import CUSTOM_MODELS_ENV
from shared.test.repo_paths import repo_root
from shared.ws_repo import WorkspaceScope

#: test_settings_form_drafts.py's moto tables and wired settings handler.
world = drafts_world

FORM_ID = 'fd_0000000000000000000000000000a1b2'
#: The CDK specs' registry, whose `mine` is an imported model (lib/test-support/custom-models-env.json).
REGISTRY = (repo_root() / 'lib' / 'test-support' / 'custom-models-env.json').read_text(encoding='utf-8')
IMPORTED_ARN = 'arn:aws:bedrock:us-west-2:111111111111:imported-model/abc123def456'
WS_FORM_ID = 'ff_0000000000000000000000000000c3d4'
ANSWERS = [{'response_id': 'fb_1', 'text': 'The labs ran long'}, {'response_id': 'fb_2', 'text': 'Great demo'}]
BODY = {'form_id': FORM_ID, 'answers': ANSWERS, 'filters': {'from': '2026-11-01'},
        'last_response_at': '2026-11-12T10:00:00'}
MODEL_ANSWER = json.dumps({'themes': [{'label': 'Labs ran long', 'sentiment': 'negative',
                                       'response_ids': ['fb_1', 'fb_unknown']}], 'summary': 'Shorten the labs.'})


@pytest.fixture
def forms(world) -> dict[str, Any]:
    world['aggregates'].put_item(Item={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{FORM_ID}', 'form_id': FORM_ID})
    world['aggregates'].put_item(Item={'pk': f'WS#{WS}#FEEDBACK_FORM', 'sk': f'FORM#{WS_FORM_ID}',
                                       'form_id': WS_FORM_ID})
    return world


def _reports(world: dict, pk: str = 'FEEDBACK_FORM') -> list[dict]:
    return world['aggregates'].query(KeyConditionExpression=Key('pk').eq(pk) & Key('sk').begins_with('FORMREPORT#'))[
        'Items']


@pytest.mark.usefixtures('forms')
class TestStartingASummary:
    def test_it_starts_a_job_with_the_answers_and_only_its_starter_polls_it(self, world, lambda_context):
        status, started = _call(lambda_context, 'POST', '/settings/form-reports', body=BODY)
        assert status == 202, started
        [row] = _job_rows(world, 'ASSIST#sub-us')
        config = row['config']
        assert (row['job_type'], config['form_id'], config['answers'], config['created_by']) == (
            forms_v2_report_ai.REPORT_JOB, FORM_ID, ANSWERS, {'sub': 'sub-us', 'kind': 'user'})
        assert forms_report_routes.REPORT_ID.fullmatch(config['report_id'])
        assert _call(lambda_context, 'GET', f"/settings/form-reports/{started['job_id']}")[1]['status'] == 'pending'
        assert _call(lambda_context, 'GET', f"/settings/form-reports/{started['job_id']}", claims=EDITOR)[0] == 404
        # Nothing but the job and its hourly counter: the report row is the worker's.
        assert _reports(world) == []

    def test_a_form_the_scope_does_not_hold_is_the_404_and_costs_nothing(self, world, lambda_context):
        for body, ws in (({**BODY, 'form_id': WS_FORM_ID}, None), (BODY, WS)):
            status, answer = _call(lambda_context, 'POST', '/settings/form-reports', body=body, ws=ws,
                                   claims=EDITOR if ws else USER)
            assert (status, answer['error']) == (404, 'Form not found')
        assert world['aggregates'].query(KeyConditionExpression=Key('pk').eq('FEEDBACK_FORM')
                                         & Key('sk').begins_with('FORMREPORTRATE#'))['Items'] == []
        world['invoke'].assert_not_called()

    def test_a_viewer_is_refused_and_an_editor_starts_one_in_the_workspace(self, world, lambda_context):
        body = {**BODY, 'form_id': WS_FORM_ID}
        assert _call(lambda_context, 'POST', '/settings/form-reports', body=body, ws=WS, claims=VIEWER)[0] == 403
        assert _call(lambda_context, 'POST', '/settings/form-reports', body=body, ws=WS, claims=EDITOR)[0] == 202
        assert _job_rows(world, f'WS#{WS}#ASSIST#sub-ed')

    def test_twenty_an_hour_then_a_429(self, lambda_context):
        for _ in range(forms_report_routes.MAX_REPORTS_PER_HOUR):
            assert _call(lambda_context, 'POST', '/settings/form-reports', body=BODY)[0] == 202
        status, answer = _call(lambda_context, 'POST', '/settings/form-reports', body=BODY)
        assert (status, answer['code']) == (429, 'rate_limited')
        assert 0 < answer['retry_after'] <= 3600

    def test_a_malformed_request_is_a_400(self, lambda_context):
        assert _call(lambda_context, 'POST', '/settings/form-reports', body={**BODY, 'answers': []})[0] == 400


def _config(world: dict, lambda_context: Any, **kwargs: Any) -> dict:
    assert _call(lambda_context, 'POST', '/settings/form-reports', **kwargs)[0] == 202
    return world['jobs'].scan()['Items'][-1]['config']


@pytest.mark.usefixtures('forms')
class TestTheWorkersJob:
    def test_it_is_registered_per_workspace_in_the_jobs_own_scope(self):
        work = settings_handler.ASSIST_WORK[forms_v2_report_ai.REPORT_JOB]
        assert (work.run, work.per_workspace, work.in_scope, work.forget_config) == (forms_report_routes.run_job, True,
                                                                                     True, True)

    def test_it_writes_labels_and_ids_in_the_deployments_forms_partition(self, world, lambda_context):
        config = _config(world, lambda_context, body=BODY)
        with patch('shared.forms_v2_report_ai._converse', return_value=(MODEL_ANSWER, 'model-x')):
            result = forms_report_routes.run_job(dict(config), None)
        assert result == {'success': True, 'form_id': FORM_ID, 'report_id': config['report_id']}
        [row] = _reports(world)
        assert row['sk'] == f"FORMREPORT#{FORM_ID}#{config['report_id']}"
        assert (row['themes'], row['response_ids'], row['ai']['summary'], row['ai']['model']) == (
            [{'label': 'Labs ran long', 'count': 1, 'sentiment': 'negative', 'quote_ids': ['fb_1']}],
            ['fb_1', 'fb_2'], 'Shorten the labs.', 'model-x')
        assert (row['created_by'], row['reason'], row['filters'], row['responses_counted'], 'ttl' in row) == (
            {'sub': 'sub-us', 'kind': 'user'}, 'ai_summary', {'from': '2026-11-01'}, 2, False)
        assert 'The labs ran long' not in json.dumps(row, default=str)

    def test_an_imported_models_arn_is_stored_as_its_key(self, world, lambda_context, monkeypatch):
        # (S2, 7.71.00: an imported model's id is an ARN naming the account, and every editor reads the report)
        monkeypatch.setenv(CUSTOM_MODELS_ENV, REGISTRY)
        config = _config(world, lambda_context, body=BODY)
        with patch('shared.forms_v2_report_ai._converse', return_value=(MODEL_ANSWER, IMPORTED_ARN)):
            assert forms_report_routes.run_job(dict(config), None)['success'] is True
        [row] = _reports(world)
        assert row['ai']['model'] == 'mine'
        assert '111111111111' not in json.dumps(row, default=str)

    @pytest.mark.parametrize(('model_answer', 'status'), [(MODEL_ANSWER, 'completed'), ('{}', 'completed'),
                                                          (None, 'failed')], ids=['summary', 'no-summary', 'failed'])
    def test_the_job_row_keeps_no_answer_once_the_job_ends(self, world, lambda_context, model_answer, status):
        # (F5: the answers ride the job's config to the worker, and are removed from its row when it ends)
        _status, started = _call(lambda_context, 'POST', '/settings/form-reports', body=BODY)
        [row] = _job_rows(world, 'ASSIST#sub-us')
        assert row['config']['answers'] == ANSWERS
        event = {'action': 'assist_job', 'pk': row['pk'], 'job_id': started['job_id']}
        effect = RuntimeError('model down') if model_answer is None else None
        with patch('shared.forms_v2_report_ai._converse', side_effect=effect, return_value=(model_answer, 'model-x')):
            assert assist_jobs.run(event, settings_handler.ASSIST_WORK)['status'] == status
        [ended] = _job_rows(world, 'ASSIST#sub-us')
        assert (ended['status'], 'config' in ended) == (status, False)
        assert 'The labs ran long' not in json.dumps(ended, default=str)

    def test_in_a_workspace_it_writes_the_workspaces_row_only(self, world, lambda_context):
        config = _config(world, lambda_context, body={**BODY, 'form_id': WS_FORM_ID}, ws=WS, claims=EDITOR)
        with patch('shared.forms_v2_report_ai._converse', return_value=(MODEL_ANSWER, 'model-x')):
            assert forms_report_routes.run_job(dict(config), WorkspaceScope(WS))['success'] is True
        assert len(_reports(world, f'WS#{WS}#FEEDBACK_FORM')) == 1
        assert _reports(world) == []

    def test_a_form_deleted_meanwhile_gets_no_row_and_no_theme_no_row(self, world, lambda_context):
        config = _config(world, lambda_context, body=BODY)
        world['aggregates'].delete_item(Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{FORM_ID}'})
        with patch('shared.forms_v2_report_ai._converse', return_value=(MODEL_ANSWER, 'model-x')):
            assert forms_report_routes.run_job(dict(config), None)['code'] == 'form_deleted'
        with patch('shared.forms_v2_report_ai._converse', return_value=('{}', 'model-x')):
            assert forms_report_routes.run_job(dict(config), None)['code'] == 'no_summary'
        assert _reports(world) == []

    def test_a_config_without_its_report_id_fails_the_job(self, world, lambda_context):
        config = _config(world, lambda_context, body=BODY)
        with pytest.raises(ValueError, match='report_id'):
            forms_report_routes.run_job({**config, 'report_id': 'x'}, None)
