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
NO_FIELD = ('Give at least one of: state, start_page, guide, subscribe_prompt, dismiss_decision_run, playbook, '
            'playbook_done')
# Agent run ids (time-first, so RUN_B is the newer one).
RUN_A = 'ar_019a0000000011112222'
RUN_B = 'ar_019a0000000133334444'


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
            'guide': 'open', 'subscribe_prompt': 'shown', 'dismissed_decision_runs': [], 'playbook': None,
            'playbook_done': [], 'signals': {'feedback_present': False, 'feedback_form_configured': False},
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
        ({'guide': 'closed'}, 'guide must be one of: open, skipped'),
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

    def test_the_guide_is_independent_of_the_buddy_and_the_start_page(self, api_gateway_event, lambda_context, table):
        _call(api_gateway_event, lambda_context, 'PUT', {'state': 'skipped', 'start_page': 'dashboard'})
        _, skipped = _call(api_gateway_event, lambda_context, 'PUT', {'guide': 'skipped'})
        assert (skipped['guide'], skipped['state'], skipped['start_page']) == ('skipped', 'skipped', 'dashboard')
        _, reopened = _call(api_gateway_event, lambda_context, 'PUT', {'guide': 'open'})
        assert (reopened['guide'], reopened['state']) == ('open', 'skipped')
        stored = table.get_item(Key={'pk': 'USERCTX#user-sub', 'sk': 'onboarding'})['Item']
        assert stored['guide'] == 'open'

    def test_the_guide_is_scoped_to_the_caller(self, api_gateway_event, lambda_context):
        _call(api_gateway_event, lambda_context, 'PUT', {'guide': 'skipped'})
        _, mine = _call(api_gateway_event, lambda_context, 'GET')
        _, theirs = _call(api_gateway_event, lambda_context, 'GET', claims=ADMIN)
        assert (mine['guide'], theirs['guide']) == ('skipped', 'open')

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

    def test_closing_home_cards_is_stored_and_leaves_the_other_fields(self, api_gateway_event, lambda_context, table):
        _call(api_gateway_event, lambda_context, 'PUT', {'state': 'skipped', 'guide': 'skipped'})
        _call(api_gateway_event, lambda_context, 'PUT', {'dismiss_decision_run': RUN_A})
        _call(api_gateway_event, lambda_context, 'PUT', {'dismiss_decision_run': RUN_B})
        # Closing the same run twice keeps one entry.
        _call(api_gateway_event, lambda_context, 'PUT', {'dismiss_decision_run': RUN_A})
        response, body = _call(api_gateway_event, lambda_context, 'PUT', {'subscribe_prompt': 'dismissed'})
        assert response['statusCode'] == 200
        assert {key: body[key] for key in ('state', 'guide', 'subscribe_prompt', 'dismissed_decision_runs')} == {
            'state': 'skipped', 'guide': 'skipped', 'subscribe_prompt': 'dismissed',
            'dismissed_decision_runs': [RUN_B, RUN_A],
        }
        stored = table.get_item(Key={'pk': 'USERCTX#user-sub', 'sk': 'onboarding'})['Item']
        assert stored['dismissed_decision_runs'] == [RUN_B, RUN_A]

    def test_closed_cards_are_scoped_to_the_caller(self, api_gateway_event, lambda_context):
        _call(api_gateway_event, lambda_context, 'PUT', {'subscribe_prompt': 'dismissed'})
        _call(api_gateway_event, lambda_context, 'PUT', {'dismiss_decision_run': RUN_A})
        _, theirs = _call(api_gateway_event, lambda_context, 'GET', claims=ADMIN)
        assert (theirs['subscribe_prompt'], theirs['dismissed_decision_runs']) == ('shown', [])

    @pytest.mark.parametrize('body', [{'subscribe_prompt': 'gone'}, {'dismiss_decision_run': 'ag_123456789abc'}])
    def test_a_bad_close_is_400_and_stores_nothing(self, api_gateway_event, lambda_context, table, body):
        response, _ = _call(api_gateway_event, lambda_context, 'PUT', body)
        assert response['statusCode'] == 400
        assert 'Item' not in table.get_item(Key={'pk': 'USERCTX#user-sub', 'sk': 'onboarding'})


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


@pytest.mark.usefixtures('table')
class TestPlaybook:
    """The role playbook (7.66.00, docs/playbooks.md): the person's choice and ticks on their own row, the chosen
    playbook's server signals read in the request's scope."""

    def test_choosing_a_role_ticking_steps_and_clearing_it(self, api_gateway_event, lambda_context, table):
        _, chose = _call(api_gateway_event, lambda_context, 'PUT', {'playbook': 'qa', 'playbook_done': ['test_form']})
        assert (chose['playbook'], chose['playbook_done']) == ('qa', ['test_form'])
        assert chose['signals'] == {'feedback_present': False, 'feedback_form_configured': False,
                                    'form_test_response': False}
        # Another role keeps the ticks of the steps it shares; clearing the role keeps them too.
        _, moved = _call(api_gateway_event, lambda_context, 'PUT', {'playbook': 'engineering'})
        assert (moved['playbook'], moved['playbook_done']) == ('engineering', ['test_form'])
        _, cleared = _call(api_gateway_event, lambda_context, 'PUT', {'playbook': None})
        assert (cleared['playbook'], cleared['playbook_done']) == (None, ['test_form'])
        stored = table.get_item(Key={'pk': 'USERCTX#user-sub', 'sk': 'onboarding'})['Item']
        assert 'playbook' not in stored
        _, unticked = _call(api_gateway_event, lambda_context, 'PUT', {'playbook_done': []})
        assert unticked['playbook_done'] == []

    def test_the_playbook_leaves_the_buddy_alone(self, api_gateway_event, lambda_context):
        _call(api_gateway_event, lambda_context, 'PUT', {'state': 'skipped', 'start_page': 'dashboard'})
        _, body = _call(api_gateway_event, lambda_context, 'PUT', {'playbook': 'product'})
        assert (body['state'], body['start_page'], body['playbook']) == ('skipped', 'dashboard', 'product')

    def test_the_playbook_is_the_callers_own(self, api_gateway_event, lambda_context):
        _call(api_gateway_event, lambda_context, 'PUT', {'playbook': 'qa', 'playbook_done': ['test_form']})
        _, theirs = _call(api_gateway_event, lambda_context, 'GET', claims=ADMIN)
        assert (theirs['playbook'], theirs['playbook_done']) == (None, [])

    @pytest.mark.parametrize(('body', 'message'), [
        ({'playbook': 'designer'}, 'playbook must be one of: product, scrum_master, qa, engineering, or null'),
        ({'playbook_done': ['fly']}, 'playbook_done names a step no playbook has'),
        ({'playbook_done': 'test_form'}, 'playbook_done must be a list of at most 40 step ids'),
    ])
    def test_a_bad_playbook_is_400_and_stores_nothing(self, api_gateway_event, lambda_context, table, body, message):
        response, payload = _call(api_gateway_event, lambda_context, 'PUT', body)
        assert (response['statusCode'], payload['error']) == (400, message)
        assert 'Item' not in table.get_item(Key={'pk': 'USERCTX#user-sub', 'sk': 'onboarding'})

    def test_the_product_signals_are_the_persons_own(self, api_gateway_event, lambda_context, table):
        _, before = _call(api_gateway_event, lambda_context, 'PUT', {'playbook': 'product'})
        assert (before['signals']['brief_subscribed'], before['signals']['objectives_set']) == (False, False)
        table.put_item(Item={'pk': 'USERCTX#user-sub', 'sk': 'briefing', 'enabled': True})
        table.put_item(Item={'pk': 'USERCTX#user-sub', 'sk': 'config', 'objectives': [{'id': 'o1', 'title': 'Ship'}]})
        _, mine = _call(api_gateway_event, lambda_context, 'GET')
        assert (mine['signals']['brief_subscribed'], mine['signals']['objectives_set']) == (True, True)
        _call(api_gateway_event, lambda_context, 'PUT', {'playbook': 'product'}, claims=ADMIN)
        _, theirs = _call(api_gateway_event, lambda_context, 'GET', claims=ADMIN)
        assert (theirs['signals']['brief_subscribed'], theirs['signals']['objectives_set']) == (False, False)

    def test_a_test_response_of_the_scope_ticks_the_qa_step(self, api_gateway_event, lambda_context, table):
        table.put_item(Item={'pk': 'FEEDBACK_FORM_TEST', 'sk': 'f1#2026-11-20T00:00:00+00:00#r1', 'is_test': True})
        _, body = _call(api_gateway_event, lambda_context, 'PUT', {'playbook': 'qa'})
        assert body['signals']['form_test_response'] is True

    def test_no_playbook_reads_only_the_first_run_signals(self, api_gateway_event, lambda_context):
        _, body = _call(api_gateway_event, lambda_context, 'GET')
        assert set(body['signals']) == {'feedback_present', 'feedback_form_configured'}


class TestScopedSignals:
    """Inside a workspace the signals are the workspace's own partitions, never the deployment's."""

    def test_a_workspaces_signals_read_its_own_rows(self, table):
        from shared.ws_repo import WorkspaceScope
        scope = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
        table.put_item(Item={'pk': 'METRIC#meta', 'sk': 'earliest_date', 'date': '2025-01-15'})
        table.put_item(Item={'pk': 'FEEDBACK_FORM', 'sk': 'FORM#f1'})
        table.put_item(Item={'pk': 'FEEDBACK_FORM_TEST', 'sk': 'f1#t#r1'})
        assert onboarding.signals(table, scope, sub='user-sub', playbook='qa') == {
            'feedback_present': False, 'feedback_form_configured': False, 'form_test_response': False}
        table.put_item(Item={'pk': f'{scope.prefix}METRIC#meta', 'sk': 'earliest_date', 'date': '2025-02-01'})
        table.put_item(Item={'pk': f'{scope.prefix}FEEDBACK_FORM', 'sk': 'FORM#f2'})
        table.put_item(Item={'pk': f'{scope.prefix}FEEDBACK_FORM_TEST', 'sk': 'f2#t#r2'})
        assert onboarding.signals(table, scope, sub='user-sub', playbook='qa') == {
            'feedback_present': True, 'feedback_form_configured': True, 'form_test_response': True}
