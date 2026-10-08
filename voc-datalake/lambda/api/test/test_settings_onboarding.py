"""Route + data-layer tests for the onboarding-buddy preference
(GET/PUT /settings/my-onboarding, shared/onboarding.py), against a moto aggregates table."""
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route
from moto import mock_aws

import settings_handler
from settings_handler import lambda_handler
from shared import onboarding
from shared.test.moto_tables import create_pk_sk_table

ADMIN = {'sub': 'admin-sub', 'cognito:username': 'alice', 'cognito:groups': 'admins'}
USER = {'sub': 'user-sub', 'cognito:username': 'bob', 'cognito:groups': 'users'}
PATH = '/settings/my-onboarding'
NOW = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)
BAD_STATE = 'state must be one of: active, hidden, dismissed, skipped'
NO_FIELD = 'Give state, start_page or both'


@pytest.fixture
def table():
    with mock_aws():
        table = create_pk_sk_table('test-aggregates')
        with patch.object(settings_handler, 'aggregates_table', table):
            yield table


def _call(api_gateway_event, lambda_context, method, body=None, claims=USER):
    return call_route(lambda_handler, api_gateway_event, lambda_context,
                      method=method, path=PATH, body=body, claims=claims)


@pytest.mark.usefixtures('table')
class TestRoutes:
    def test_default_is_active_and_visible(self, api_gateway_event, lambda_context):
        response, body = _call(api_gateway_event, lambda_context, 'GET')
        assert response['statusCode'] == 200
        assert body == {
            'state': 'active', 'hidden_until': None, 'updated_at': None, 'visible': True, 'start_page': 'home',
            'signals': {'feedback_present': False, 'feedback_form_configured': False},
        }

    def test_scoped_to_the_caller(self, api_gateway_event, lambda_context, table):
        response, saved = _call(api_gateway_event, lambda_context, 'PUT', {'state': 'dismissed'})
        assert response['statusCode'] == 200
        assert (saved['state'], saved['visible']) == ('dismissed', False)
        _, mine = _call(api_gateway_event, lambda_context, 'GET')
        assert mine['state'] == 'dismissed'
        # Another user's view is untouched: the row is keyed by the caller's sub only.
        _, theirs = _call(api_gateway_event, lambda_context, 'GET', claims=ADMIN)
        assert (theirs['state'], theirs['visible']) == ('active', True)
        stored = table.get_item(Key={'pk': 'USERCTX#user-sub', 'sk': 'onboarding'})['Item']
        assert stored['state'] == 'dismissed'
        assert 'Item' not in table.get_item(Key={'pk': 'USERCTX#admin-sub', 'sk': 'onboarding'})

    def test_body_cannot_target_another_user(self, api_gateway_event, lambda_context, table):
        response, _ = _call(api_gateway_event, lambda_context, 'PUT', {'state': 'skipped', 'sub': 'admin-sub'})
        assert response['statusCode'] == 400
        assert 'Item' not in table.get_item(Key={'pk': 'USERCTX#admin-sub', 'sk': 'onboarding'})

    def test_does_not_touch_the_objectives_row(self, api_gateway_event, lambda_context, table):
        table.put_item(Item={'pk': 'USERCTX#user-sub', 'sk': 'config', 'objectives': [{'id': 'o1', 'title': 'Ship'}]})
        _call(api_gateway_event, lambda_context, 'PUT', {'state': 'skipped'})
        assert table.get_item(Key={'pk': 'USERCTX#user-sub', 'sk': 'config'})['Item']['objectives'][0]['title'] == 'Ship'

    @pytest.mark.parametrize(('body', 'message'), [
        ({}, NO_FIELD),
        ({'state': 'gone'}, BAD_STATE),
        ({'state': 3}, BAD_STATE),
        ({'state': 'active', 'extra': 1}, 'Unknown field(s): extra'),
        ({'start_page': 'projects'}, 'start_page must be one of: home, dashboard'),
    ])
    def test_invalid_body_is_400(self, api_gateway_event, lambda_context, body, message):
        response, payload = _call(api_gateway_event, lambda_context, 'PUT', body)
        assert response['statusCode'] == 400
        assert payload['error'] == message

    def test_the_start_page_and_the_buddy_are_independent(self, api_gateway_event, lambda_context, table):
        _call(api_gateway_event, lambda_context, 'PUT', {'state': 'hidden'})
        _, chose = _call(api_gateway_event, lambda_context, 'PUT', {'start_page': 'dashboard'})
        assert (chose['start_page'], chose['state'], chose['hidden_until'] is not None) == ('dashboard', 'hidden', True)

        _, skipped = _call(api_gateway_event, lambda_context, 'PUT', {'state': 'skipped'})
        assert (skipped['start_page'], skipped['state'], skipped['hidden_until']) == ('dashboard', 'skipped', None)
        stored = table.get_item(Key={'pk': 'USERCTX#user-sub', 'sk': 'onboarding'})['Item']
        assert 'hidden_until' not in stored

    def test_the_start_page_is_scoped_to_the_caller(self, api_gateway_event, lambda_context):
        _call(api_gateway_event, lambda_context, 'PUT', {'start_page': 'dashboard'})
        _, mine = _call(api_gateway_event, lambda_context, 'GET')
        _, theirs = _call(api_gateway_event, lambda_context, 'GET', claims=ADMIN)
        assert (mine['start_page'], theirs['start_page']) == ('dashboard', 'home')

    def test_reopen_after_dismiss(self, api_gateway_event, lambda_context):
        _call(api_gateway_event, lambda_context, 'PUT', {'state': 'dismissed'})
        _, body = _call(api_gateway_event, lambda_context, 'PUT', {'state': 'active'})
        assert (body['state'], body['visible'], body['hidden_until']) == ('active', True, None)

    def test_hide_is_a_server_clock_snooze(self, api_gateway_event, lambda_context):
        _, body = _call(api_gateway_event, lambda_context, 'PUT', {'state': 'hidden'})
        assert (body['state'], body['visible']) == ('hidden', False)
        until = datetime.fromisoformat(body['hidden_until'])
        assert timedelta(hours=23) < until - datetime.now(UTC) <= onboarding.HIDE_FOR

    def test_signals_read_the_aggregates_table(self, api_gateway_event, lambda_context, table):
        table.put_item(Item={'pk': 'METRIC#meta', 'sk': 'earliest_date', 'date': '2025-01-15'})
        table.put_item(Item={'pk': 'FEEDBACK_FORM', 'sk': 'FORM#f1', 'name': 'NPS'})
        _, body = _call(api_gateway_event, lambda_context, 'GET')
        assert body['signals'] == {'feedback_present': True, 'feedback_form_configured': True}


class TestPreferenceView:
    def test_only_hidden_rows_carry_hidden_until(self):
        assert ':until' not in onboarding.preference_update({'state': 'dismissed'}, NOW)['ExpressionAttributeValues']
        view = onboarding.preference_view({'state': 'skipped', 'hidden_until': NOW.isoformat()}, NOW)
        assert (view['hidden_until'], view['visible']) == (None, False)

    @pytest.mark.parametrize('item', [None, {}, {'state': 'weird'}, {'state': 7}])
    def test_drifted_row_reads_as_active(self, item):
        assert onboarding.preference_view(item, NOW)['state'] == 'active'
        assert onboarding.preference_view(item, NOW)['visible'] is True

    def test_malformed_watermark_is_not_feedback(self):
        with mock_aws():
            table = create_pk_sk_table('t')
            table.put_item(Item={'pk': 'METRIC#meta', 'sk': 'earliest_date', 'date': 'yesterday'})
            assert onboarding.signals(table)['feedback_present'] is False
