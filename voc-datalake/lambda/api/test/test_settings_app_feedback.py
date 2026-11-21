"""GET/PUT /settings/app-feedback (shared/app_feedback_routes.py, 7.66.00) on the deployment's path, against a moto
aggregates table: off by default, any signed-in user reads, the deployment's admins choose a fit form of the same
scope, never a delegated caller. Inside a workspace the same rules hold for its own row and forms: the cross-workspace
suite (cross_workspace_worlds.py) is that path's guard."""
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route
from moto import mock_aws

import settings_handler
from settings_handler import lambda_handler
from shared.test.moto_tables import create_pk_sk_table

ADMIN = {'sub': 'admin-sub', 'cognito:username': 'alice', 'cognito:groups': 'admins'}
USER = {'sub': 'user-sub', 'cognito:username': 'bob', 'cognito:groups': 'users'}
DELEGATED = {'sub': 'mcp:tok_1', 'voc:acting_subject': 'admin-sub', 'cognito:groups': 'admins'}
PATH = '/settings/app-feedback'
FORM_ID = 'fd_0000000000000000000000000000000a'
FIT_FORM = {
    'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{FORM_ID}', 'form_id': FORM_ID, 'name': 'VoC app feedback',
    'schema_version': 2, 'enabled': True, 'language': 'en', 'languages': ['en'], 'tags': ['voc_app'],
    'questions': [{'id': 'q_verdict', 'type': 'single_select', 'options': [{'code': 'up'}, {'code': 'down'}]},
                  {'id': 'q_missing', 'type': 'open_text'}],
    'hidden_fields': [{'id': name} for name in ('action', 'page', 'app_version', 'workspace_role')],
}
CONFIG_KEY = {'pk': 'SETTINGS#app_feedback', 'sk': 'config'}


@pytest.fixture
def table():
    with mock_aws():
        table = create_pk_sk_table('test-aggregates')
        table.put_item(Item=FIT_FORM)
        with patch.object(settings_handler, 'aggregates_table', table):
            yield table


def _call(api_gateway_event, lambda_context, method, body=None, claims=ADMIN):
    return call_route(lambda_handler, api_gateway_event, lambda_context, method=method, path=PATH, body=body,
                      claims=claims)


@pytest.mark.usefixtures('table')
class TestRead:
    def test_off_by_default_for_anyone(self, api_gateway_event, lambda_context):
        response, body = _call(api_gateway_event, lambda_context, 'GET', claims=USER)
        assert response['statusCode'] == 200
        assert body == {'enabled': False, 'form_id': None, 'actions': ['personas', 'research', 'prfaq', 'prd',
                        'prototype', 'form_draft', 'import', 'engineering_run'], 'updated_at': None, 'tag': 'voc_app',
                        'form': None, 'active': False}


@pytest.mark.usefixtures('table')
class TestSave:
    def test_an_admin_turns_it_on_with_a_fit_form(self, api_gateway_event, lambda_context, table):
        response, body = _call(api_gateway_event, lambda_context, 'PUT',
                               {'form_id': FORM_ID, 'enabled': True, 'actions': ['prd', 'personas']})
        assert response['statusCode'] == 200
        assert (body['active'], body['actions'], body['form']['name']) == (True, ['personas', 'prd'], 'VoC app feedback')
        stored = table.get_item(Key=CONFIG_KEY)['Item']
        assert (stored['form_id'], stored['enabled'], stored['reason']) == (FORM_ID, True, 'app_feedback_settings')
        assert stored['updated_by'] == {'sub': 'admin-sub', 'kind': 'admin'}
        assert stored['updated_at']
        # Every member reads the same view, never who saved it.
        _, read = _call(api_gateway_event, lambda_context, 'GET', claims=USER)
        assert read == body
        assert 'admin-sub' not in str(read)

    def test_a_put_changes_only_what_it_names(self, api_gateway_event, lambda_context):
        _call(api_gateway_event, lambda_context, 'PUT', {'form_id': FORM_ID, 'enabled': True, 'actions': ['import']})
        _, body = _call(api_gateway_event, lambda_context, 'PUT', {'enabled': False})
        assert (body['enabled'], body['form_id'], body['actions'], body['active']) == (False, FORM_ID, ['import'], False)

    def test_a_form_that_is_off_may_be_chosen_and_is_not_active(self, api_gateway_event, lambda_context, table):
        table.put_item(Item={**FIT_FORM, 'enabled': False})
        response, body = _call(api_gateway_event, lambda_context, 'PUT', {'form_id': FORM_ID, 'enabled': True})
        assert response['statusCode'] == 200
        assert (body['active'], body['form']['problems']) == (False, ['form_off'])

    def test_an_unfit_form_is_refused_with_its_problems(self, api_gateway_event, lambda_context, table):
        table.put_item(Item={**FIT_FORM, 'tags': [], 'hidden_fields': []})
        response, body = _call(api_gateway_event, lambda_context, 'PUT', {'form_id': FORM_ID})
        assert response['statusCode'] == 400
        assert (body['code'], body['problems']) == ('app_feedback_form_unfit', ['not_tagged', 'hidden_fields'])
        assert 'Item' not in table.get_item(Key=CONFIG_KEY)

    @pytest.mark.parametrize('form_id', ['fd_00000000000000000000000000000000', 'ff_000000000000000000000000000000a1'])
    def test_a_form_the_scope_does_not_hold_is_404(self, api_gateway_event, lambda_context, table, form_id):
        response, body = _call(api_gateway_event, lambda_context, 'PUT', {'form_id': form_id, 'enabled': True})
        assert (response['statusCode'], body['error']) == (404, 'Feedback form not found')
        assert 'Item' not in table.get_item(Key=CONFIG_KEY)

    def test_on_needs_a_form(self, api_gateway_event, lambda_context):
        response, body = _call(api_gateway_event, lambda_context, 'PUT', {'enabled': True})
        assert (response['statusCode'], body['code']) == (400, 'app_feedback_form_required')

    def test_turning_it_off_works_after_its_form_was_deleted(self, api_gateway_event, lambda_context, table):
        _call(api_gateway_event, lambda_context, 'PUT', {'form_id': FORM_ID, 'enabled': True})
        table.delete_item(Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{FORM_ID}'})
        _, read = _call(api_gateway_event, lambda_context, 'GET', claims=USER)
        assert (read['active'], read['form']['found']) == (False, False)
        response, body = _call(api_gateway_event, lambda_context, 'PUT', {'enabled': False})
        assert (response['statusCode'], body['enabled']) == (200, False)
        response, _ = _call(api_gateway_event, lambda_context, 'PUT', {'enabled': True})
        assert response['statusCode'] == 404

    @pytest.mark.parametrize('claims', [USER, DELEGATED])
    def test_only_an_admin_acting_as_themselves_saves(self, api_gateway_event, lambda_context, table, claims):
        response, _ = _call(api_gateway_event, lambda_context, 'PUT', {'form_id': FORM_ID, 'enabled': True},
                            claims=claims)
        assert response['statusCode'] == 403
        assert 'Item' not in table.get_item(Key=CONFIG_KEY)

    def test_a_bad_body_is_400(self, api_gateway_event, lambda_context):
        response, body = _call(api_gateway_event, lambda_context, 'PUT', {'actions': ['telemetry']})
        assert response['statusCode'] == 400
        assert 'actions must list at least one of' in body['error']
