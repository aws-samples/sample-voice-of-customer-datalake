"""Recovering a tripped plugin: the circuit half of /sources (pending §8).

The breaker (plugins/_shared/circuit_breaker.py) writes `CIRCUIT#<plugin>` /
`TRIPPED` in the aggregates table and every run is skipped while it exists.
Re-enabling a source used to turn only the schedule back on, so the source stayed
dead until someone deleted that row by hand. These run against a moto table in
the aggregates key shape, so a key that does not match the schema fails here.
"""
import re
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from handler_events_fixtures import call_route
from integrations_fixtures import CLOSED_CIRCUIT, stub_rule_lookup
from moto import mock_aws

import integrations_handler as h
from shared import plugin_circuit
from shared.test.moto_tables import create_pk_sk_table

TRIPPED_KEY = {'pk': 'CIRCUIT#webscraper', 'sk': 'TRIPPED'}
TRIPPED_ROW = {
    **TRIPPED_KEY,
    'tripped_at': '2026-10-08T09:15:00+00:00',
    'failure_count': 5,
    'last_error': 'HTTPError: 503 from https://example.com/reviews?page=2',
}
PLUGINS_SHARED = Path(__file__).resolve().parents[2].parent / 'plugins' / '_shared' / 'circuit_breaker.py'


@pytest.fixture
def aggregates() -> Iterator:
    with mock_aws():
        table = create_pk_sk_table('test-aggregates')
        with patch('shared.plugin_circuit.get_aggregates_table', return_value=table):
            yield table


@pytest.fixture
def tripped(aggregates):
    aggregates.put_item(Item=TRIPPED_ROW)
    return aggregates


@pytest.fixture
def events() -> Iterator[MagicMock]:
    with patch.object(h, 'events_client') as client:
        stub_rule_lookup(client)
        yield client


def _call(api_gateway_event, lambda_context, method, path, *, groups='admins', **kwargs):
    parts = path.strip('/').split('/')
    path_params = {'source': parts[1]} if len(parts) == 3 else {}
    event_kwargs = dict(method=method, path=path, path_params=path_params, **kwargs)
    if groups != 'admins':
        event_kwargs['claims'] = {'sub': 'test-user-id', 'cognito:groups': groups}
    response, body = call_route(h.lambda_handler, api_gateway_event, lambda_context, **event_kwargs)
    return response['statusCode'], body


def _row(table):
    return table.get_item(Key=TRIPPED_KEY).get('Item')


@pytest.mark.usefixtures('plugin_secret_defaults', 'events')
class TestEnablingASourceAlsoClosesItsBreaker:
    def test_enable_deletes_the_tripped_row_and_turns_the_schedule_on(
        self, tripped, events, api_gateway_event, lambda_context
    ):
        status, body = _call(api_gateway_event, lambda_context, 'PUT', '/sources/webscraper/enable')

        assert status == 200
        assert body == {'success': True, 'source': 'webscraper', 'enabled': True, 'circuit': CLOSED_CIRCUIT}
        assert _row(tripped) is None
        events.enable_rule.assert_called_once()

    def test_enable_on_a_closed_breaker_still_succeeds(self, aggregates, api_gateway_event, lambda_context):
        status, _ = _call(api_gateway_event, lambda_context, 'PUT', '/sources/webscraper/enable')

        assert status == 200
        assert _row(aggregates) is None

    def test_a_failed_clear_is_a_500_and_leaves_the_schedule_alone(
        self, events, api_gateway_event, lambda_context
    ):
        broken = MagicMock()
        broken.delete_item.side_effect = RuntimeError('throttled')
        with patch('shared.plugin_circuit.get_aggregates_table', return_value=broken):
            status, body = _call(api_gateway_event, lambda_context, 'PUT', '/sources/webscraper/enable')

        assert (status, body) == (500, {'success': False, 'error': 'Failed to reset the data source circuit breaker'})
        events.enable_rule.assert_not_called()

    def test_disable_leaves_the_tripped_row_in_place(self, tripped, api_gateway_event, lambda_context):
        status, _ = _call(api_gateway_event, lambda_context, 'PUT', '/sources/webscraper/disable')

        assert status == 200
        assert _row(tripped) is not None


@pytest.mark.usefixtures('plugin_secret_defaults', 'events')
class TestResettingABreaker:
    def test_reset_deletes_the_row_without_enabling_the_schedule(
        self, tripped, events, api_gateway_event, lambda_context
    ):
        status, body = _call(api_gateway_event, lambda_context, 'POST', '/sources/webscraper/reset')

        assert status == 200
        assert body == {
            'success': True, 'source': 'webscraper', 'enabled': True, 'schedule': 'rate(1 day)',
            'rule_name': h._build_rule_name('webscraper'), 'exists': True, 'circuit': CLOSED_CIRCUIT,
        }
        assert _row(tripped) is None
        events.enable_rule.assert_not_called()
        events.disable_rule.assert_not_called()

    def test_reset_is_admin_only(self, tripped, api_gateway_event, lambda_context):
        status, _ = _call(api_gateway_event, lambda_context, 'POST', '/sources/webscraper/reset', groups='users')

        assert status == 403
        assert _row(tripped) is not None

    @pytest.mark.usefixtures('aggregates')
    def test_reset_refuses_a_source_that_is_not_a_plugin(self, api_gateway_event, lambda_context):
        status, _ = _call(api_gateway_event, lambda_context, 'POST', '/sources/not_a_plugin/reset')

        assert status == 400


@pytest.mark.usefixtures('plugin_secret_defaults', 'events')
class TestTheStatusReportsEachBreaker:
    @pytest.mark.usefixtures('tripped')
    def test_a_tripped_source_reports_when_how_often_and_why_to_an_admin(self, api_gateway_event, lambda_context):
        status, body = _call(api_gateway_event, lambda_context, 'GET', '/sources/status',
                             query_params={'sources': 'webscraper,app_reviews_ios'})

        assert status == 200
        assert body['sources']['webscraper']['circuit'] == {
            'tripped': True, 'tripped_at': '2026-10-08T09:15:00+00:00', 'failure_count': 5,
            'last_error': TRIPPED_ROW['last_error'],
        }
        assert body['sources']['app_reviews_ios']['circuit'] == CLOSED_CIRCUIT

    @pytest.mark.usefixtures('tripped')
    def test_a_non_admin_sees_the_trip_but_not_the_error_text(self, api_gateway_event, lambda_context):
        # The error is the plugin exception's free text (an upstream URL here);
        # run-status rows give non-admins the exception type only (#263).
        _, body = _call(api_gateway_event, lambda_context, 'GET', '/sources/status',
                        query_params={'sources': 'webscraper'}, groups='users')

        circuit = body['sources']['webscraper']['circuit']
        assert circuit['tripped'] is True
        assert circuit['failure_count'] == 5
        assert circuit['last_error'] is None

    def test_a_failed_circuit_read_degrades_only_the_circuit_entries(self, api_gateway_event, lambda_context):
        broken = MagicMock()
        with (
            patch('shared.plugin_circuit.get_aggregates_table', return_value=broken),
            patch('shared.plugin_circuit.batch_get_all', side_effect=RuntimeError('throttled')),
        ):
            status, body = _call(api_gateway_event, lambda_context, 'GET', '/sources/status',
                                 query_params={'sources': 'webscraper'})

        assert status == 200
        assert body['sources']['webscraper']['enabled'] is True
        assert body['sources']['webscraper']['circuit'] == {
            **CLOSED_CIRCUIT, 'error': 'Failed to retrieve circuit state',
        }

    def test_a_source_that_is_not_a_plugin_becomes_no_dynamodb_key(self, api_gateway_event, lambda_context):
        with patch.object(h, 'read_circuits', wraps=plugin_circuit.read_circuits) as read:
            _call(api_gateway_event, lambda_context, 'GET', '/sources/status',
                  query_params={'sources': 'not_a_plugin,webscraper'})

        assert read.call_args.args[0] == ['webscraper']

    @pytest.mark.usefixtures('tripped')
    def test_the_whole_batch_is_one_strongly_consistent_read(self, api_gateway_event, lambda_context):
        with patch('shared.plugin_circuit.batch_get_all', wraps=plugin_circuit.batch_get_all) as batch:
            _call(api_gateway_event, lambda_context, 'GET', '/sources/status',
                  query_params={'sources': 'webscraper,app_reviews_ios,synthetic_reviews'})

        batch.assert_called_once()
        assert [k['pk'] for k in batch.call_args.args[1]] == [
            'CIRCUIT#webscraper', 'CIRCUIT#app_reviews_ios', 'CIRCUIT#synthetic_reviews',
        ]


class TestTheRowShape:
    def test_a_legacy_row_is_bounded_and_coerced(self):
        circuit = plugin_circuit.circuit_from_row(
            {'tripped_at': 7, 'failure_count': 'many', 'last_error': 'e' * 900}, include_error=True,
        )

        assert circuit == {'tripped': True, 'tripped_at': None, 'failure_count': 0, 'last_error': 'e' * 500}

    def test_a_boolean_failure_count_is_not_a_count(self):
        assert plugin_circuit.circuit_from_row({'failure_count': True}, include_error=True)['failure_count'] == 0

    def test_the_key_matches_the_one_the_breaker_writes(self):
        """Lockstep with plugins/_shared/circuit_breaker.py (a different bundle, so
        the key is written twice): read its source rather than import it."""
        breaker = PLUGINS_SHARED.read_text()

        assert re.search(r'return f"CIRCUIT#\{plugin_id\}"', breaker)
        assert 'TRIPPED_SK = "TRIPPED"' in breaker
        assert plugin_circuit.tripped_key('x') == {'pk': 'CIRCUIT#x', 'sk': 'TRIPPED'}

    def test_the_breaker_and_this_api_use_the_same_table(self):
        breaker = PLUGINS_SHARED.read_text()
        api_side = Path(plugin_circuit.__file__).read_text()

        assert 'AGGREGATES_TABLE = os.environ.get("AGGREGATES_TABLE", "")' in breaker
        assert 'from shared.tables import get_aggregates_table' in api_side
