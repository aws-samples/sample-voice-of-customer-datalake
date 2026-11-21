"""A feedback form's AI draft on the SETTINGS API (shared/forms_v2_draft_routes.py; docs/feedback-forms.md "AI drafts").

`POST /feedback-forms/draft` starts an assist job the settings twin runs and `GET /feedback-forms/draft/{job_id}` polls
the caller's own: both served by the settings Lambda, which owns the job rows and the twin, so the forms Lambda (it
also serves the public widget routes) holds no worker invoke and no jobs-table action (7.04.00's AI review, round 1).

Against moto tables (aggregates, jobs).
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import ExitStack
from typing import Any
from unittest.mock import patch

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from moto import mock_aws
from moto_helpers import pk_sk_table, rest_event

import settings_handler
from shared import forms_v2_draft, forms_v2_draft_routes

USER = {'sub': 'sub-us', 'cognito:groups': 'users', 'cognito:username': 'us'}
ADMIN = {'sub': 'sub-ad', 'cognito:groups': 'admins', 'cognito:username': 'ad'}
WORKER = 'voc-settings-assist-x'
DRAFT = {'description': 'Ask app users who switch back to the old UI why', 'language': 'pl', 'channel': 'in_app'}


@pytest.fixture
def world() -> Iterator[dict[str, Any]]:
    with mock_aws(), ExitStack() as stack:
        aggregates, jobs = pk_sk_table('aggregates'), pk_sk_table('jobs')
        stack.enter_context(patch.object(settings_handler, 'aggregates_table', aggregates))
        stack.enter_context(patch('shared.assist_jobs.get_jobs_table', return_value=jobs))
        invoke = stack.enter_context(patch('shared.assist_jobs.invoke_lambda_async'))
        stack.enter_context(patch.dict('os.environ', {'ASSIST_WORKER_FUNCTION': WORKER}))
        yield {'aggregates': aggregates, 'jobs': jobs, 'invoke': invoke}


def _call(lambda_context: Any, method: str, path: str, *, claims: dict | None = None,
          body: Any = None) -> tuple[int, Any]:
    parts = path.strip('/').split('/')
    params = {'job_id': parts[2]} if len(parts) > 2 else None
    event = rest_event(method, path, claims=claims if claims is not None else USER, body=body, path_params=params)
    response = settings_handler.lambda_handler(event, lambda_context)
    return response['statusCode'], json.loads(response['body'])


@pytest.mark.usefixtures('world')
class TestTheAiDraftRoutes:
    def test_a_draft_starts_a_job_on_this_lambdas_twin_and_only_its_starter_polls_it(self, world, lambda_context):
        status, started = _call(lambda_context, 'POST', '/feedback-forms/draft', body=DRAFT)
        assert status == 202, started
        world['invoke'].assert_called_once()
        assert world['invoke'].call_args.args[0] == WORKER
        [row] = world['jobs'].query(KeyConditionExpression=Key('pk').eq('ASSIST#sub-us'))['Items']
        assert (row['job_type'], row['config']['language'], row['initiated_by']) == (
            forms_v2_draft.DRAFT_JOB, 'pl', 'sub-us')
        status, polled = _call(lambda_context, 'GET', f"/feedback-forms/draft/{started['job_id']}")
        assert (status, polled['status']) == (200, 'pending')
        assert _call(lambda_context, 'GET', f"/feedback-forms/draft/{started['job_id']}", claims=ADMIN)[0] == 404

    def test_the_twin_runs_the_draft_it_was_handed(self):
        work = settings_handler.ASSIST_WORK[forms_v2_draft.DRAFT_JOB]
        assert (work.run, work.failure_message) == (forms_v2_draft.run_job, forms_v2_draft.DRAFT_FAILURE)

    def test_a_draft_saves_nothing_but_its_hourly_counter(self, world, lambda_context):
        assert _call(lambda_context, 'POST', '/feedback-forms/draft', body=DRAFT)[0] == 202
        [row] = world['aggregates'].scan()['Items']
        assert (row['pk'], row['sk'].startswith('FORMDRAFT#sub-us#'), row['drafts']) == ('FEEDBACK_FORM', True, 1)
        # Rate plumbing, gone two days later (an assist job's own row expires the same way).
        assert int(row['ttl']) > 0

    def test_the_hourly_limit_is_a_429_with_retry_after(self, lambda_context):
        for _ in range(forms_v2_draft_routes.MAX_DRAFTS_PER_HOUR):
            assert _call(lambda_context, 'POST', '/feedback-forms/draft', body=DRAFT)[0] == 202
        status, answer = _call(lambda_context, 'POST', '/feedback-forms/draft', body=DRAFT)
        assert (status, answer['code']) == (429, 'rate_limited')
        assert 0 < answer['retry_after'] <= 3600
        # Another person has their own hour.
        assert _call(lambda_context, 'POST', '/feedback-forms/draft', body=DRAFT, claims=ADMIN)[0] == 202

    def test_any_signed_in_user_may_draft_and_the_way_of_working_does_not_gate_it(self, lambda_context):
        """The owner's decision (as the form CRUD); a form is not a gated document type, so no AI-mode row is read."""
        with patch('shared.ai_mode.get_ai_mode', side_effect=AssertionError('read')):
            assert _call(lambda_context, 'POST', '/feedback-forms/draft', body=DRAFT)[0] == 202

    @pytest.mark.parametrize(('body', 'code'), [
        ({**DRAFT, 'description': ''}, 'description_required'), ({**DRAFT, 'language': 'it'}, None),
        ({**DRAFT, 'channel': 'email'}, None), ({**DRAFT, 'description': 'x' * 2001}, None),
        ({**DRAFT, 'instruction': 'Add English'}, None), ({**DRAFT, 'extra': 1}, None),
    ])
    def test_a_bad_request_is_refused_before_any_job_or_charge(self, world, lambda_context, body, code):
        status, answer = _call(lambda_context, 'POST', '/feedback-forms/draft', body=body)
        assert status == 400
        assert answer.get('code') == code
        world['invoke'].assert_not_called()
        assert world['aggregates'].scan()['Items'] == []

    def test_a_counter_that_cannot_be_written_is_a_500_and_starts_no_job(self, world, lambda_context):
        refused = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'x'}}, 'UpdateItem')
        with patch.object(settings_handler.aggregates_table, 'update_item', side_effect=refused):
            assert _call(lambda_context, 'POST', '/feedback-forms/draft', body=DRAFT)[0] == 500
        world['invoke'].assert_not_called()


def test_without_its_table_the_draft_is_a_configuration_error(lambda_context):
    with patch.object(settings_handler, 'aggregates_table', None):
        assert _call(lambda_context, 'POST', '/feedback-forms/draft', body=DRAFT)[0] == 500
