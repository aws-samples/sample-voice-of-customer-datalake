"""A feedback form's AI draft on the SETTINGS API (shared/forms_v2_draft_routes.py; docs/feedback-forms.md "AI drafts").

`POST /settings/form-drafts` starts an assist job the settings twin runs and `GET /settings/form-drafts/{job_id}` polls
the caller's own: both served by the settings Lambda, which owns the job rows and the twin, so the forms Lambda (it
also serves the public widget routes) holds no worker invoke and no jobs-table action (7.55.00's AI review, round 1;
the 7.55.00 paths `/feedback-forms/draft…` are gone).
Deployment-wide any signed-in user drafts; with `X-Workspace-Id` only the workspace's editors and admins, the job and
its hourly counter the workspace's.

Against moto tables (aggregates, jobs, workspaces).
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
from shared import forms_v2_draft, forms_v2_draft_routes, forms_v2_report_ai, request_workspace
from shared.workspace import MembershipCache

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
USER = {'sub': 'sub-us', 'cognito:groups': 'users', 'cognito:username': 'us'}
ADMIN = {'sub': 'sub-ad', 'cognito:groups': 'admins', 'cognito:username': 'ad'}
EDITOR = {'sub': 'sub-ed', 'cognito:groups': 'users', 'cognito:username': 'ed'}
VIEWER = {'sub': 'sub-vi', 'cognito:groups': 'users', 'cognito:username': 'vi'}
WS_ADMIN = {'sub': 'sub-wa', 'cognito:groups': 'users', 'cognito:username': 'wa'}
WORKER = 'voc-settings-assist-x'
DRAFT = {'description': 'Ask app users who switch back to the old UI why', 'language': 'pl', 'channel': 'in_app'}


@pytest.fixture
def world() -> Iterator[dict[str, Any]]:
    with mock_aws(), ExitStack() as stack:
        aggregates, jobs, workspaces = pk_sk_table('aggregates'), pk_sk_table('jobs'), pk_sk_table('workspaces')
        workspaces.put_item(Item={'pk': f'WS#{WS}', 'sk': 'META', 'status': 'active', 'name': 'A', 'slug': 'a'})
        for member, role in ((EDITOR, 'editor'), (VIEWER, 'viewer'), (WS_ADMIN, 'admin')):
            workspaces.put_item(Item={'pk': f'WS#{WS}', 'sk': f"MEMBER#{member['sub']}", 'role': role})
        stack.enter_context(patch.object(settings_handler, 'aggregates_table', aggregates))
        stack.enter_context(patch('shared.assist_jobs.get_jobs_table', return_value=jobs))
        invoke = stack.enter_context(patch('shared.assist_jobs.invoke_lambda_async'))
        stack.enter_context(patch.dict('os.environ', {'ASSIST_WORKER_FUNCTION': WORKER,
                                                      'WORKSPACES_TABLE': 'workspaces'}))
        stack.enter_context(patch.object(request_workspace, 'cached_table', return_value=workspaces))
        stack.enter_context(patch.object(request_workspace, '_MEMBERSHIPS', MembershipCache()))
        yield {'aggregates': aggregates, 'jobs': jobs, 'invoke': invoke}


def _call(lambda_context: Any, method: str, path: str, *, claims: dict | None = None, ws: str | None = None,
          body: Any = None) -> tuple[int, Any]:
    parts = path.strip('/').split('/')
    params = {'job_id': parts[2]} if len(parts) > 2 else None
    event = rest_event(method, path, claims=claims if claims is not None else USER, body=body, path_params=params)
    if ws is not None:
        event['headers']['X-Workspace-Id'] = ws
    response = settings_handler.lambda_handler(event, lambda_context)
    return response['statusCode'], json.loads(response['body'])


def _job_rows(world: dict, pk: str) -> list[dict]:
    return world['jobs'].query(KeyConditionExpression=Key('pk').eq(pk))['Items']


@pytest.mark.usefixtures('world')
class TestTheAiDraftRoutes:
    def test_a_draft_starts_a_job_on_this_lambdas_twin_and_only_its_starter_polls_it(self, world, lambda_context):
        status, started = _call(lambda_context, 'POST', '/settings/form-drafts', body=DRAFT)
        assert status == 202, started
        world['invoke'].assert_called_once()
        assert world['invoke'].call_args.args[0] == WORKER
        [row] = _job_rows(world, 'ASSIST#sub-us')
        assert (row['job_type'], row['config']['language'], row['initiated_by'], row['job_id']) == (
            forms_v2_draft.DRAFT_JOB, 'pl', 'sub-us', started['job_id'])
        status, polled = _call(lambda_context, 'GET', f"/settings/form-drafts/{started['job_id']}")
        assert (status, polled['status']) == (200, 'pending')
        assert _call(lambda_context, 'GET', f"/settings/form-drafts/{started['job_id']}", claims=ADMIN)[0] == 404

    def test_the_twin_runs_the_draft_it_was_handed_in_a_workspace_too(self):
        work = settings_handler.ASSIST_WORK[forms_v2_draft.DRAFT_JOB]
        assert (work.run, work.failure_message, work.per_workspace) == (
            forms_v2_draft.run_job, forms_v2_draft.DRAFT_FAILURE, True)
        # (and the form report's summary, 7.63.00, test_settings_form_reports.py): no other kind runs in a workspace
        assert all(not w.per_workspace for job, w in settings_handler.ASSIST_WORK.items()
                   if job not in {forms_v2_draft.DRAFT_JOB, forms_v2_report_ai.REPORT_JOB})

    def test_a_draft_saves_nothing_but_its_hourly_counter(self, world, lambda_context):
        assert _call(lambda_context, 'POST', '/settings/form-drafts', body=DRAFT)[0] == 202
        [row] = world['aggregates'].scan()['Items']
        assert (row['pk'], row['sk'].startswith('FORMDRAFT#sub-us#'), row['drafts']) == ('FEEDBACK_FORM', True, 1)
        # Rate plumbing, gone two days later (an assist job's own row expires the same way).
        assert int(row['ttl']) > 0

    def test_the_hourly_limit_is_a_429_with_retry_after(self, lambda_context):
        for _ in range(forms_v2_draft_routes.MAX_DRAFTS_PER_HOUR):
            assert _call(lambda_context, 'POST', '/settings/form-drafts', body=DRAFT)[0] == 202
        status, answer = _call(lambda_context, 'POST', '/settings/form-drafts', body=DRAFT)
        assert (status, answer['code']) == (429, 'rate_limited')
        assert 0 < answer['retry_after'] <= 3600
        # Another person has their own hour.
        assert _call(lambda_context, 'POST', '/settings/form-drafts', body=DRAFT, claims=ADMIN)[0] == 202

    def test_any_signed_in_user_may_draft_and_the_way_of_working_does_not_gate_it(self, lambda_context):
        """The owner's decision (as the form CRUD); a form is not a gated document type, so no AI-mode row is read."""
        with patch('shared.ai_mode.get_ai_mode', side_effect=AssertionError('read')):
            assert _call(lambda_context, 'POST', '/settings/form-drafts', body=DRAFT)[0] == 202

    @pytest.mark.parametrize(('body', 'code'), [
        ({**DRAFT, 'description': ''}, 'description_required'), ({**DRAFT, 'language': 'it'}, None),
        ({**DRAFT, 'channel': 'email'}, None), ({**DRAFT, 'description': 'x' * 2001}, None),
        ({**DRAFT, 'instruction': 'Add English'}, None), ({**DRAFT, 'extra': 1}, None),
    ])
    def test_a_bad_request_is_refused_before_any_job_or_charge(self, world, lambda_context, body, code):
        status, answer = _call(lambda_context, 'POST', '/settings/form-drafts', body=body)
        assert status == 400
        assert answer.get('code') == code
        world['invoke'].assert_not_called()
        assert world['aggregates'].scan()['Items'] == []

    def test_a_counter_that_cannot_be_written_is_a_500_and_starts_no_job(self, world, lambda_context):
        refused = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'x'}}, 'UpdateItem')
        with patch.object(settings_handler.aggregates_table, 'update_item', side_effect=refused):
            status, answer = _call(lambda_context, 'POST', '/settings/form-drafts', body=DRAFT)
        assert (status, answer['error']) == (500, forms_v2_draft_routes.FAILED_DRAFT_START)
        world['invoke'].assert_not_called()


@pytest.mark.usefixtures('world')
class TestADraftInAWorkspace:
    """With X-Workspace-Id the draft is the workspace's: its editors and admins start and poll it (a viewer 403, as
    for a form's create), the job row and the hourly counter are in its partitions, and the twin's event names it."""

    def test_an_editor_drafts_in_the_workspace_and_polls_it_there_only(self, world, lambda_context):
        status, started = _call(lambda_context, 'POST', '/settings/form-drafts', body=DRAFT, claims=EDITOR, ws=WS)
        assert status == 202, started
        [row] = _job_rows(world, f'WS#{WS}#ASSIST#sub-ed')
        assert (row['job_id'], row['initiated_by']) == (started['job_id'], 'sub-ed')
        assert _job_rows(world, 'ASSIST#sub-ed') == []
        assert world['invoke'].call_args.args[1]['workspace_id'] == WS
        [counter] = world['aggregates'].scan()['Items']
        assert (counter['pk'], counter['sk'].startswith('FORMDRAFT#sub-ed#')) == (f'WS#{WS}#FEEDBACK_FORM', True)
        job = f"/settings/form-drafts/{started['job_id']}"
        status, polled = _call(lambda_context, 'GET', job, claims=EDITOR, ws=WS)
        assert (status, polled['status']) == (200, 'pending')
        # Not from outside the workspace, nor by another of its members.
        assert _call(lambda_context, 'GET', job, claims=EDITOR)[0] == 404
        assert _call(lambda_context, 'GET', job, claims=WS_ADMIN, ws=WS)[0] == 404

    def test_a_viewer_may_neither_draft_nor_poll_and_nothing_is_written(self, world, lambda_context):
        status, answer = _call(lambda_context, 'POST', '/settings/form-drafts', body=DRAFT, claims=VIEWER, ws=WS)
        assert (status, answer['error']) == (403, forms_v2_draft_routes.DRAFTS_NEED_AN_EDITOR)
        assert _call(lambda_context, 'GET', '/settings/form-drafts/job_0123456789abcdef', claims=VIEWER, ws=WS)[0] == 403
        world['invoke'].assert_not_called()
        assert world['aggregates'].scan()['Items'] == []

    def test_an_admin_of_the_workspace_drafts_and_a_non_member_gets_the_one_404(self, world, lambda_context):
        assert _call(lambda_context, 'POST', '/settings/form-drafts', body=DRAFT, claims=WS_ADMIN, ws=WS)[0] == 202
        assert _call(lambda_context, 'POST', '/settings/form-drafts', body=DRAFT, claims=USER, ws=WS)[0] == 404
        assert len(world['aggregates'].scan()['Items']) == 1

    def test_the_hourly_limit_is_counted_per_workspace(self, lambda_context):
        for _ in range(forms_v2_draft_routes.MAX_DRAFTS_PER_HOUR):
            assert _call(lambda_context, 'POST', '/settings/form-drafts', body=DRAFT, claims=EDITOR, ws=WS)[0] == 202
        assert _call(lambda_context, 'POST', '/settings/form-drafts', body=DRAFT, claims=EDITOR, ws=WS)[0] == 429
        assert _call(lambda_context, 'POST', '/settings/form-drafts', body=DRAFT, claims=EDITOR)[0] == 202


def test_without_its_table_the_draft_is_a_configuration_error(lambda_context):
    with patch.object(settings_handler, 'aggregates_table', None):
        assert _call(lambda_context, 'POST', '/settings/form-drafts', body=DRAFT)[0] == 500
