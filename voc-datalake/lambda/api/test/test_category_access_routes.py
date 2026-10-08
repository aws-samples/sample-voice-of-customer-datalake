"""Category access on chat, feedback forms, users, settings and project jobs."""
import json
from datetime import UTC, datetime
from typing import Any, ClassVar
from unittest.mock import MagicMock, patch

import pytest
from category_access_fixtures import (
    CATEGORIES_CONFIG,
    RESTRICTED_CLAIMS,
    RESTRICTED_SUB,
    aggregates_with,
)
from handler_events_fixtures import call_route
from moto import mock_aws
from moto_helpers import pk_sk_table

from shared.api import clear_categories_cache
from shared.category_access import CategoryScope, access_key

TODAY = datetime.now(UTC).strftime('%Y-%m-%d')


@pytest.fixture(autouse=True)
def _fresh_categories_cache():
    clear_categories_cache()
    yield
    clear_categories_cache()


class TestFeedbackFormSubmissions:
    FORM: ClassVar[dict[str, str]] = {'pk': 'FEEDBACK_FORM', 'sk': 'FORM#f1', 'brand_name': 'acme'}
    ROWS: ClassVar[list[dict[str, Any]]] = [
        {'feedback_id': 'a', 'category': 'delivery', 'rating': 5},
        {'feedback_id': 'b', 'category': 'billing', 'rating': 1},
    ]

    def _call(self, api_gateway_event, lambda_context, path, aggregates):
        from feedback_form_handler import lambda_handler
        feedback = MagicMock()
        feedback.query.return_value = {'Items': self.ROWS}
        with patch('feedback_form_handler.aggregates_table', aggregates), \
                patch('feedback_form_handler.feedback_table', feedback):
            return call_route(lambda_handler, api_gateway_event, lambda_context, method='GET',
                              path=path, claims=RESTRICTED_CLAIMS)

    def test_submissions_and_stats_cover_only_visible_categories(self, api_gateway_event, lambda_context):
        aggregates = aggregates_with(
            self.FORM, CATEGORIES_CONFIG, {**access_key(RESTRICTED_SUB), 'categories': ['delivery']})
        _, body = self._call(api_gateway_event, lambda_context, '/feedback-forms/f1/submissions', aggregates)
        assert [s['feedback_id'] for s in body['submissions']] == ['a']
        assert body['stats'] == {'total_submissions': 1, 'avg_rating': 5.0, 'rating_count': 1}
        _, body = self._call(api_gateway_event, lambda_context, '/feedback-forms/f1/stats', aggregates)
        assert body['stats']['total_submissions'] == 1

    def test_unrestricted_caller_sees_every_submission(self, api_gateway_event, lambda_context):
        _, body = self._call(api_gateway_event, lambda_context, '/feedback-forms/f1/stats',
                             aggregates_with(self.FORM))
        assert body['stats']['total_submissions'] == 2


class TestUserCategoryAccess:
    @pytest.fixture
    def aggregates(self):
        with mock_aws():
            table = pk_sk_table('aggregates')
            table.put_item(Item=CATEGORIES_CONFIG)
            yield table

    def _call(self, api_gateway_event, lambda_context, aggregates, method, body=None, claims=None):
        from users_handler import lambda_handler
        cognito = MagicMock()
        cognito.admin_get_user.return_value = {'UserAttributes': [{'Name': 'sub', 'Value': RESTRICTED_SUB}]}
        with patch('users_handler.cognito', cognito), patch('users_handler.aggregates_table', aggregates):
            response = lambda_handler(api_gateway_event(
                method=method, path='/users/rita/category-access', body=body, claims=claims,
            ), lambda_context)
        return response['statusCode'], json.loads(response['body'])

    def test_no_row_reads_as_all(self, api_gateway_event, lambda_context, aggregates):
        status, body = self._call(api_gateway_event, lambda_context, aggregates, 'GET')
        assert status == 200
        assert body['all'] is True
        assert body['categories'] == ['*']

    def test_put_then_get_round_trips(self, api_gateway_event, lambda_context, aggregates):
        status, body = self._call(api_gateway_event, lambda_context, aggregates, 'PUT',
                                  body={'categories': ['delivery']})
        assert status == 200
        assert body['categories'] == ['delivery']
        assert body['all'] is False
        stored = aggregates.get_item(Key=access_key(RESTRICTED_SUB))['Item']
        assert stored['categories'] == ['delivery']
        assert stored['updated_by'] == 'test-user-id'
        _, body = self._call(api_gateway_event, lambda_context, aggregates, 'GET')
        assert body['categories'] == ['delivery']

    def test_reports_owned_categories(self, api_gateway_event, lambda_context, aggregates):
        aggregates.put_item(Item={**CATEGORIES_CONFIG, 'categories': [
            {'name': 'delivery', 'owners': [{'sub': RESTRICTED_SUB}]}]})
        _, body = self._call(api_gateway_event, lambda_context, aggregates, 'GET')
        assert body['owned_categories'] == ['delivery']

    @pytest.mark.parametrize('body', [{'categories': ['unknown']}, {'categories': 'delivery'},
                                      {'categories': ['*', 'delivery']}, {}])
    def test_invalid_is_400(self, api_gateway_event, lambda_context, aggregates, body):
        status, _ = self._call(api_gateway_event, lambda_context, aggregates, 'PUT', body=body)
        assert status == 400

    def test_default_categories_are_grantable_when_none_are_configured(
            self, api_gateway_event, lambda_context, aggregates):
        aggregates.delete_item(Key={'pk': CATEGORIES_CONFIG['pk'], 'sk': CATEGORIES_CONFIG['sk']})
        status, body = self._call(api_gateway_event, lambda_context, aggregates, 'PUT',
                                  body={'categories': ['pricing', 'other']})
        assert status == 200
        assert body['categories'] == ['pricing', 'other']
        status, _ = self._call(api_gateway_event, lambda_context, aggregates, 'PUT',
                               body={'categories': ['made_up']})
        assert status == 400

    def test_configured_categories_replace_the_defaults(self, api_gateway_event, lambda_context, aggregates):
        status, _ = self._call(api_gateway_event, lambda_context, aggregates, 'PUT',
                               body={'categories': ['pricing']})
        assert status == 400

    @pytest.mark.parametrize('method', ['GET', 'PUT'])
    def test_admin_only(self, api_gateway_event, lambda_context, aggregates, method):
        status, _ = self._call(api_gateway_event, lambda_context, aggregates, method,
                               body={'categories': ['*']}, claims=RESTRICTED_CLAIMS)
        assert status == 403


class TestGetCategoriesConfig:
    OWNER: ClassVar[dict[str, str]] = {'sub': 'owner-sub', 'username': 'olga', 'email': 'olga@example.com'}
    CONFIG: ClassVar[dict[str, Any]] = {**CATEGORIES_CONFIG, 'updated_at': 'then', 'categories': [
        {'name': 'delivery', 'product': 'Shop', 'owners': [OWNER]},
        {'name': 'billing', 'owners': [OWNER]},
    ]}

    def _get(self, api_gateway_event, lambda_context, aggregates, claims=None):
        from settings_handler import lambda_handler
        with patch('settings_handler.aggregates_table', aggregates):
            response, body = call_route(lambda_handler, api_gateway_event, lambda_context, method='GET',
                                        path='/settings/categories', claims=claims)
        assert response['statusCode'] == 200
        return body

    def test_admin_gets_full_config(self, api_gateway_event, lambda_context):
        body = self._get(api_gateway_event, lambda_context, aggregates_with(self.CONFIG))
        assert body == {'categories': self.CONFIG['categories'], 'updated_at': 'then'}

    def test_restricted_caller_gets_scoped_categories_without_owner_identity(
            self, api_gateway_event, lambda_context):
        aggregates = aggregates_with(self.CONFIG, {**access_key(RESTRICTED_SUB), 'categories': ['delivery']})
        body = self._get(api_gateway_event, lambda_context, aggregates, claims=RESTRICTED_CLAIMS)
        assert body == {'categories': [{'name': 'delivery', 'product': 'Shop', 'owners': [{'username': 'olga'}]}],
                        'updated_at': 'then'}

    def test_unrestricted_non_admin_sees_all_but_owners_redacted(self, api_gateway_event, lambda_context):
        body = self._get(api_gateway_event, lambda_context, aggregates_with(self.CONFIG), claims=RESTRICTED_CLAIMS)
        assert [c['name'] for c in body['categories']] == ['delivery', 'billing']
        assert all(c['owners'] == [{'username': 'olga'}] for c in body['categories'])
        assert 'olga@example.com' not in json.dumps(body)
        assert 'owner-sub' not in json.dumps(body)


class TestSaveCategoriesConfig:
    def _put(self, api_gateway_event, lambda_context, body, claims=None):
        from settings_handler import lambda_handler
        table = MagicMock()
        with patch('settings_handler.aggregates_table', table):
            response, payload = call_route(lambda_handler, api_gateway_event, lambda_context, method='PUT',
                                           path='/settings/categories', body=body, claims=claims)
        return response['statusCode'], payload, table

    def test_admin_saves_normalised_categories(self, api_gateway_event, lambda_context):
        status, _, table = self._put(api_gateway_event, lambda_context, {'categories': [
            {'name': 'delivery', 'product': 'Shop', 'owners': [{'sub': 's1'}], 'junk': 1}]})
        assert status == 200
        saved = table.put_item.call_args.kwargs['Item']['categories']
        assert saved == [{'name': 'delivery', 'description': '', 'product': 'Shop',
                          'owners': [{'sub': 's1', 'username': '', 'email': ''}], 'subcategories': []}]

    def test_invalid_is_400(self, api_gateway_event, lambda_context):
        status, _, table = self._put(api_gateway_event, lambda_context,
                                     {'categories': [{'name': 'a'}, {'name': 'a'}]})
        assert status == 400
        table.put_item.assert_not_called()


class TestProjectJobsCaptureScope:
    SCOPE = CategoryScope(all=False, categories=frozenset({'delivery'}))
    EXPECTED: ClassVar[dict[str, Any]] = {'all': False, 'categories': ['delivery']}

    def _start(self, api_gateway_event, lambda_context, path, body):
        from projects_handler import lambda_handler
        event = api_gateway_event(method='POST', path=path, path_params={'project_id': 'p1'}, body=body)
        # The project-exists read before every job row is covered by test_project_jobs_access.py
        # against moto; here it is doubled so only the scope capture is under test.
        with patch('projects_handler.category_gate.scope_for_event', return_value=self.SCOPE), \
                patch('projects_handler._require_project_exists'), \
                patch('projects_handler.create_job', return_value=('job-1', {})) as create_job, \
                patch('projects_handler.invoke_lambda_async') as invoke_async, \
                patch.dict('os.environ', {'RESEARCH_STATE_MACHINE_ARN': '', 'DOCUMENT_STATE_MACHINE_ARN': ''}), \
                patch('projects_handler.run_research', return_value={'success': True}):
            response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 200, response['body']
        return create_job.call_args.args[3], invoke_async

    def test_persona_generation(self, api_gateway_event, lambda_context):
        with patch('projects_handler.ensure_persona_feedback') as precheck:
            config, invoke_async = self._start(api_gateway_event, lambda_context,
                                               '/projects/p1/personas/generate', {'persona_count': 2})
        assert config['category_scope'] == self.EXPECTED
        assert invoke_async.call_args.args[1]['filters']['category_scope'] == self.EXPECTED
        # The no-feedback pre-check (F1) reads under the caller's scope too.
        assert precheck.call_args.args[0]['category_scope'] == self.EXPECTED

    def test_research(self, api_gateway_event, lambda_context):
        config, _ = self._start(api_gateway_event, lambda_context, '/projects/p1/research', {})
        assert config['category_scope'] == self.EXPECTED

    def test_document_and_merge_cannot_be_forged_by_the_body(self, api_gateway_event, lambda_context):
        forged = {'category_scope': {'all': True, 'categories': []}}
        config, _ = self._start(api_gateway_event, lambda_context, '/projects/p1/document', forged)
        assert config['category_scope'] == self.EXPECTED
        config, _ = self._start(api_gateway_event, lambda_context, '/projects/p1/documents/merge',
                                {**forged, 'output_type': 'prd', 'document_ids': []})
        assert config['category_scope'] == self.EXPECTED

    def test_research_fallback_reads_under_the_callers_scope(self, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/projects/p1/research',
                                  path_params={'project_id': 'p1'}, body={})
        with patch('projects_handler.category_gate.scope_for_event', return_value=self.SCOPE), \
                patch('projects_handler._require_project_exists'), \
                patch('projects_handler.create_job', return_value=('job-1', {})), \
                patch.dict('os.environ', {'RESEARCH_STATE_MACHINE_ARN': ''}), \
                patch('projects_handler.run_research', return_value={'success': True}) as run:
            assert lambda_handler(event, lambda_context)['statusCode'] == 200
        assert run.call_args.kwargs['category_scope'] == self.EXPECTED

    @pytest.mark.parametrize(('path', 'target'), [
        ('/projects/p1/prfaq-autofill', 'autofill_prfaq_questions'),
        ('/projects/p1/research/suggest-questions', 'suggest_research_questions'),
        ('/projects/p1/documents/suggest-brief', 'suggest_document_brief'),
    ])
    def test_sync_assists_read_under_the_callers_scope(self, api_gateway_event, lambda_context, path, target):
        from projects_handler import lambda_handler
        event = api_gateway_event(method='POST', path=path, path_params={'project_id': 'p1'}, body={})
        with patch('projects_handler.category_gate.scope_for_event', return_value=self.SCOPE), \
                patch(f'projects_handler.{target}', return_value={}) as assist:
            assert lambda_handler(event, lambda_context)['statusCode'] == 200
        assert assist.call_args.kwargs['category_scope'] == self.EXPECTED


class TestSyncProjectReadsIgnoreAForgedScope:
    def test_the_body_cannot_widen_the_callers_scope(self):
        import projects
        caller_scope = {'all': False, 'categories': ['delivery']}
        forged = {'days': 7, 'category_scope': {'all': True, 'categories': []}}
        with patch('projects.get_feedback_context', return_value=[]) as fetch:
            projects.get_scoped_feedback_context(forged, 10, caller_scope)
        assert fetch.call_args.args[0] == {'days': 7, 'date_basis': 'imported', 'category_scope': caller_scope}

    def test_unscoped_reads_drop_a_forged_scope_too(self):
        import projects
        with patch('projects.get_feedback_context', return_value=[]) as fetch:
            projects.get_scoped_feedback_context({'category_scope': {'all': True}}, 10, None)
        assert fetch.call_args.args[0] == {'date_basis': 'imported'}
