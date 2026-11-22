"""GET /metrics/adoption (shared/adoption_metrics_routes.py, on the metrics Lambda) and GET/PUT /settings/adoption
(shared/adoption_routes.py, on the settings Lambda), 7.70.00, on the deployment's path against moto: who may read and
save, the newest rollup item read, the estimate labelled with the saved baselines. Inside a workspace the same rules
hold for its own rows: the cross-workspace suite (cross_workspace_worlds.py) is that path's guard."""
from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal
from typing import Any
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route
from moto import mock_aws
from test_settings_app_feedback import ADMIN, USER

import metrics_handler
import settings_handler
from shared.project_access import ACTING_SUBJECT_CLAIM, MCP_AGENT_RUN_CLAIM
from shared.test.moto_tables import create_pk_sk_table

PLATFORM = {'sub': 'plat-sub', 'cognito:username': 'pat', 'cognito:groups': 'platform-admins'}
DELEGATED = {'sub': 'mcp:tok_1', ACTING_SUBJECT_CLAIM: 'admin-sub', 'cognito:groups': 'admins'}
CLEARED = {**DELEGATED, MCP_AGENT_RUN_CLAIM: 'true'}
ROLLUP = {'pk': 'ADOPTION#ROLLUP', 'sk': '2026-11-20', 'rolled_up_at': '2026-11-20T03:05:00+00:00',
          'complete': True, 'first_month': '2024-12', 'agent_runs_counted': True,
          'months': {'2026-11': {'projects_started': 2, 'with': {'prototype': 1},
                                 'artifacts': {'prd': {'ai': Decimal(3)}}}}}
OLDER = {**ROLLUP, 'sk': '2026-11-19', 'months': {'2026-11': {'projects_started': 9}}}
SETTINGS_KEY = {'pk': 'SETTINGS#adoption', 'sk': 'config'}


@pytest.fixture
def table() -> Iterator[Any]:
    with mock_aws():
        table = create_pk_sk_table('test-aggregates')
        table.put_item(Item=ROLLUP)
        table.put_item(Item=OLDER)
        with patch.object(metrics_handler, 'aggregates_table', table), \
                patch.object(settings_handler, 'aggregates_table', table):
            yield table


def _view(api_gateway_event, lambda_context, claims=ADMIN, **params: str) -> tuple[int, Any]:
    response, body = call_route(metrics_handler.lambda_handler, api_gateway_event, lambda_context, method='GET',
                                path='/metrics/adoption', query_params={'from': '2026-11', 'to': '2026-11', **params},
                                claims=claims)
    return response['statusCode'], body


def _settings(api_gateway_event, lambda_context, method, body=None, claims=ADMIN) -> tuple[int, Any]:
    response, answer = call_route(settings_handler.lambda_handler, api_gateway_event, lambda_context, method=method,
                                  path='/settings/adoption', body=body, claims=claims)
    return response['statusCode'], answer


@pytest.mark.usefixtures('table')
class TestTheView:
    def test_an_admin_reads_the_newest_rollup_with_the_estimate_labelled(self, api_gateway_event, lambda_context):
        status, body = _view(api_gateway_event, lambda_context)
        assert status == 200
        assert (body['scope'], body['as_of'], body['totals']['projects_started']) == (
            'deployment', '2026-11-20T03:05:00+00:00', 2)
        assert body['totals']['prototype_rate'] == 0.5
        assert body['totals']['time_saved_hours'] == 24.0
        assert body['time_saved']['estimate'] is True

    def test_a_member_who_is_no_admin_is_refused(self, api_gateway_event, lambda_context):
        assert _view(api_gateway_event, lambda_context, claims=USER)[0] == 403

    def test_a_platform_admin_reads_it_once_the_live_check_confirms_them(self, api_gateway_event, lambda_context):
        with patch('shared.adoption_metrics_routes.confirm_live_platform_admin', return_value=True) as live:
            assert _view(api_gateway_event, lambda_context, claims=PLATFORM)[0] == 200
        live.assert_called_once()
        with patch('shared.adoption_metrics_routes.confirm_live_platform_admin', return_value=False):
            assert _view(api_gateway_event, lambda_context, claims=PLATFORM)[0] == 403

    def test_a_credential_reads_it_only_once_the_mcp_lambda_cleared_it(self, api_gateway_event, lambda_context):
        assert _view(api_gateway_event, lambda_context, claims=DELEGATED)[0] == 403
        assert _view(api_gateway_event, lambda_context, claims=CLEARED)[0] == 200

    def test_a_bad_range_is_a_400(self, api_gateway_event, lambda_context):
        assert _view(api_gateway_event, lambda_context, grain='week')[0] == 400

    def test_before_any_rollup_it_answers_zeros(self, api_gateway_event, lambda_context, table):
        table.delete_item(Key={'pk': 'ADOPTION#ROLLUP', 'sk': '2026-11-20'})
        table.delete_item(Key={'pk': 'ADOPTION#ROLLUP', 'sk': '2026-11-19'})
        status, body = _view(api_gateway_event, lambda_context)
        assert (status, body['as_of'], body['totals']['projects_started']) == (200, None, 0)


@pytest.mark.usefixtures('table')
class TestTheBaselines:
    def test_defaults_until_an_admin_saves(self, api_gateway_event, lambda_context):
        status, body = _settings(api_gateway_event, lambda_context, 'GET')
        assert status == 200
        assert body['baselines']['prd'] == {'hours': 8.0, 'saved': False}

    def test_an_admin_saves_recording_who_when_and_why(self, api_gateway_event, lambda_context, table):
        status, body = _settings(api_gateway_event, lambda_context, 'PUT',
                                 {'baselines': {'prd': 12}, 'note': 'Our 2026 survey'})
        assert (status, body['baselines']['prd'], body['note']) == (200, {'hours': 12.0, 'saved': True},
                                                                   'Our 2026 survey')
        stored = table.get_item(Key=SETTINGS_KEY)['Item']
        assert (stored['updated_by'], stored['reason']) == ({'sub': 'admin-sub', 'kind': 'admin'}, 'adoption_baselines')
        # The view applies it at once (3 AI-made PRDs x 12 h), and names nobody.
        _, view = _view(api_gateway_event, lambda_context)
        assert view['totals']['time_saved_hours'] == 36.0
        assert 'admin-sub' not in str(view)

    @pytest.mark.parametrize('claims', [USER, DELEGATED, CLEARED])
    def test_only_an_admin_acting_for_themselves_reads_or_saves(self, api_gateway_event, lambda_context, claims):
        assert _settings(api_gateway_event, lambda_context, 'PUT', {'baselines': {'prd': 1}}, claims=claims)[0] == 403
        assert _settings(api_gateway_event, lambda_context, 'GET', claims=claims)[0] == 403

    def test_a_bad_baseline_is_a_400_and_nothing_is_stored(self, api_gateway_event, lambda_context, table):
        assert _settings(api_gateway_event, lambda_context, 'PUT', {'baselines': {'prd': -1}})[0] == 400
        assert 'Item' not in table.get_item(Key=SETTINGS_KEY)
