"""GET/PUT /settings/email-inbox and POST /settings/email-inbox/feedback-type-dimension
(admin only; shared/email_intake_settings.py), against a moto aggregates table."""
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route
from moto import mock_aws

import settings_handler
from settings_handler import lambda_handler
from shared import email_intake_settings as inbox
from shared.feedback_types import feedback_type_dimension
from shared.test.moto_tables import create_pk_sk_table

ADMIN = {'sub': 'admin-sub', 'cognito:username': 'admin', 'cognito:groups': 'admins'}
USER = {'sub': 'user-sub', 'cognito:username': 'user', 'cognito:groups': 'users'}
PATH = '/settings/email-inbox'
DIMENSION_PATH = '/settings/email-inbox/feedback-type-dimension'
CAPS = {'daily_cap': 50, 'sender_daily_cap': 5, 'daily_model_calls': 100}


@pytest.fixture
def table():
    with mock_aws():
        table = create_pk_sk_table('test-aggregates')
        with patch.object(settings_handler, 'aggregates_table', table), \
                patch.object(settings_handler, 'INBOUND_EMAIL_DOMAIN', 'voc.example.com'), \
                patch.object(settings_handler, 'INBOUND_EMAIL_RULE_SET', 'voc-email-intake'), \
                patch.object(settings_handler, 'INBOUND_EMAIL_RULE_SET_OWNED', True):
            yield table


def _call(api_gateway_event, lambda_context, method, path=PATH, body=None, claims=ADMIN):
    return call_route(lambda_handler, api_gateway_event, lambda_context,
                      method=method, path=path, body=body, claims=claims)


@pytest.mark.usefixtures('table')
class TestEmailInboxRoutes:
    def test_get_shows_the_deployed_inbox_with_defaults(self, api_gateway_event, lambda_context):
        response, body = _call(api_gateway_event, lambda_context, 'GET')
        assert response['statusCode'] == 200
        assert body['enabled'] is True
        assert body['addresses'][0] == 'feedback@voc.example.com'
        assert (body['rule_set'], body['rule_set_needs_activation']) == ('voc-email-intake', True)
        assert body['caps'] == inbox.DEFAULT_CAPS
        assert (body['pii'], body['profile_configured'], body['feedback_type_dimension']) == ('redact', False, True)

    def test_get_counts_today(self, api_gateway_event, lambda_context, table):
        table.put_item(Item={**inbox.stats_key(inbox.today()), 'accepted': 3, 'dropped_spam': 2,
                             'deduped_no_new_info': 1})
        _, body = _call(api_gateway_event, lambda_context, 'GET')
        assert (body['today']['accepted'], body['today']['dropped']['spam']) == (3, 2)
        assert body['today']['deduped']['no_new_info'] == 1

    def test_put_saves_the_caps(self, api_gateway_event, lambda_context, table):
        response, body = _call(api_gateway_event, lambda_context, 'PUT', body=CAPS)
        assert response['statusCode'] == 200
        assert body['caps'] == CAPS
        assert table.get_item(Key=inbox.CONFIG_KEY)['Item']['updated_by'] == 'admin'

    @pytest.mark.parametrize('bad', [{**CAPS, 'daily_cap': 0}, {**CAPS, 'sender_daily_cap': True},
                                     {'daily_cap': 10}])
    def test_put_refuses_out_of_bounds_caps(self, api_gateway_event, lambda_context, bad):
        response, _ = _call(api_gateway_event, lambda_context, 'PUT', body=bad)
        assert response['statusCode'] == 400

    @pytest.mark.parametrize(('method', 'path'), [('GET', PATH), ('PUT', PATH), ('POST', DIMENSION_PATH)])
    def test_every_route_is_admin_only(self, api_gateway_event, lambda_context, method, path):
        response, _ = _call(api_gateway_event, lambda_context, method, path=path, body=CAPS, claims=USER)
        assert response['statusCode'] == 403

    def test_the_old_create_route_creates_nothing_since_feedback_type_is_built_in(
            self, api_gateway_event, lambda_context, table):
        _, first = _call(api_gateway_event, lambda_context, 'POST', path=DIMENSION_PATH, body={})
        _, second = _call(api_gateway_event, lambda_context, 'POST', path=DIMENSION_PATH, body={})
        assert (first['created'], second['created']) == (False, False)
        assert [dimension['key'] for dimension in second['dimensions']] == ['feedback_type']
        assert 'Item' not in table.get_item(Key={'pk': 'SETTINGS#dimensions', 'sk': 'config'})

    def test_every_alias_forces_a_built_in_type_or_lets_the_model_decide(self):
        values = {value['name'] for value in feedback_type_dimension()['values']}
        assert inbox.ALIASES == {'feedback': None, 'ideas': 'feature_request', 'bugs': 'bug', 'reviews': None}
        assert {forced for forced in inbox.ALIASES.values() if forced} <= values


def test_caps_from_row_ignores_out_of_bounds_values():
    assert inbox.caps_from_row({'daily_cap': 10_000, 'sender_daily_cap': 3})['daily_cap'] == 200
    assert inbox.caps_from_row(None) == inbox.DEFAULT_CAPS
    with pytest.raises(ValueError, match='Body must be an object'):
        inbox.validate_caps([])


def test_the_inbox_is_off_without_a_domain():
    assert inbox.inbox_addresses('') == []
