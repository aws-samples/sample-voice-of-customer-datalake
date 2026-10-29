"""/settings/dimensions, /settings/sources and /settings/erasure (settings_handler), against moto."""
import hashlib
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import boto3
import pytest
from handler_events_fixtures import call_route
from moto import mock_aws

import settings_handler
from settings_handler import lambda_handler
from shared.feedback_types import feedback_type_dimension

USER_CLAIMS = {'sub': 'user-1', 'cognito:username': 'casey', 'cognito:groups': 'users'}
DIMENSIONS = [{'key': 'product', 'label': 'Product', 'values': [{'name': 'App'}, {'name': 'Web'}]}]
PROFILE = {'id': 'support_tickets', 'label': 'Support', 'pii': 'redact', 'retention_days': 365,
           'restricted': True, 'dimension_defaults': {'product': 'App'}, 'tags': ['support']}


def _aggregates_table():
    """pk/sk plus the `gsi1-by-metric-type` index (metric_type, pk), as in core-stack.ts."""
    return boto3.resource('dynamodb', region_name='us-east-1').create_table(
        TableName='test-aggregates-settings-classification', BillingMode='PAY_PER_REQUEST',
        KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        AttributeDefinitions=[{'AttributeName': a, 'AttributeType': 'S'} for a in ('metric_type', 'pk', 'sk')],
        GlobalSecondaryIndexes=[{
            'IndexName': 'gsi1-by-metric-type', 'Projection': {'ProjectionType': 'ALL'},
            'KeySchema': [{'AttributeName': 'metric_type', 'KeyType': 'HASH'},
                          {'AttributeName': 'pk', 'KeyType': 'RANGE'}]}],
    )


@pytest.fixture
def table():
    with mock_aws():
        moto_table = _aggregates_table()
        with patch.object(settings_handler, 'aggregates_table', moto_table), \
             patch.object(settings_handler, 'RETENTION_FUNCTION', 'voc-retention'):
            yield moto_table


@pytest.fixture
def invoke():
    """The async invoke of the retention worker, recorded."""
    with patch.object(settings_handler, 'invoke_lambda_async', MagicMock()) as recorded:
        yield recorded


@pytest.fixture
def route(api_gateway_event, lambda_context):
    """``route(method, path, body=None, claims=None)`` -> ``(response, decoded body)``."""
    return lambda method, path, **event: call_route(
        lambda_handler, api_gateway_event, lambda_context, method=method, path=path, **event)


@pytest.mark.usefixtures('table')
class TestDimensions:
    def test_round_trip(self, route):
        response, body = route('PUT', '/settings/dimensions', body={'dimensions': DIMENSIONS})
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['dimensions'][0]['infer'] is True
        _, body = route('GET', '/settings/dimensions', claims=USER_CLAIMS)
        assert [d['key'] for d in body['dimensions']] == ['feedback_type', 'product']
        assert body['updated_at']

    def test_nothing_configured_answers_only_the_built_in_feedback_type(self, route):
        _, body = route('GET', '/settings/dimensions')
        assert body == {'dimensions': [feedback_type_dimension()], 'updated_at': None}

    def test_invalid_is_400(self, route):
        response, body = route('PUT', '/settings/dimensions', body={'dimensions': [{'key': 'category'}]})
        assert response['statusCode'] == 400
        assert 'reserved' in body['error']

    def test_admin_only(self, route):
        response, _ = route('PUT', '/settings/dimensions', body={'dimensions': []}, claims=USER_CLAIMS)
        assert response['statusCode'] == 403

    def test_a_corrupt_row_reads_as_only_the_built_in_ones(self, route, table):
        table.put_item(Item={'pk': 'SETTINGS#dimensions', 'sk': 'config', 'dimensions': 'x'})
        _, body = route('GET', '/settings/dimensions')
        assert [d['key'] for d in body['dimensions']] == ['feedback_type']


@pytest.mark.usefixtures('table')
class TestSources:
    def test_admin_sees_full_profiles_and_others_the_public_view(self, route):
        route('PUT', '/settings/dimensions', body={'dimensions': DIMENSIONS})
        response, body = route('PUT', '/settings/sources', body={'sources': [PROFILE]})
        assert response['statusCode'] == 200
        assert body['sources'] == [PROFILE]
        _, body = route('GET', '/settings/sources')
        assert body['sources'] == [PROFILE]
        _, body = route('GET', '/settings/sources', claims=USER_CLAIMS)
        assert body['sources'] == [{'id': 'support_tickets', 'label': 'Support', 'restricted': True}]

    def test_defaults_must_name_configured_dimensions(self, route):
        response, body = route('PUT', '/settings/sources', body={'sources': [PROFILE]})
        assert response['statusCode'] == 400
        assert 'unknown dimension' in body['error']

    def test_a_corrupt_dimensions_row_is_500_on_save(self, route, table):
        table.put_item(Item={'pk': 'SETTINGS#dimensions', 'sk': 'config', 'dimensions': 'x'})
        response, _ = route('PUT', '/settings/sources', body={'sources': []})
        assert response['statusCode'] == 500

    def test_admin_only(self, route):
        response, _ = route('PUT', '/settings/sources', body={'sources': []}, claims=USER_CLAIMS)
        assert response['statusCode'] == 403


@pytest.mark.usefixtures('table')
class TestErasure:
    def test_start_stores_only_the_hash_and_invokes_the_worker(self, route, invoke, table):
        response, body = route('POST', '/settings/erasure',
                               body={'field': 'email', 'value': ' ana@example.com ', 'source': 'support_tickets'})
        assert response['statusCode'] == 202
        job = body['job']
        assert job['job_id'].startswith('er_')
        assert job['status'] == 'queued'
        assert job['value_hash'] == hashlib.sha256(b'ana@example.com').hexdigest()
        assert (job['deleted_items'], job['deleted_objects'], job['source']) == (0, 0, 'support_tickets')
        invoke.assert_called_once_with(
            'voc-retention', {'mode': 'erase', 'job_id': job['job_id'], 'value': 'ana@example.com'})
        stored = table.get_item(Key={'pk': 'JOB#erasure', 'sk': job['job_id']})['Item']
        assert 'ana@example.com' not in str(stored)

    @pytest.mark.usefixtures('invoke')
    @pytest.mark.parametrize('body', [
        {'field': 'name', 'value': 'x'},
        {'field': 'author', 'value': '  '},
        {'field': 'author', 'value': 'x' * 1001},
        {'field': 'author', 'value': 'x', 'source': 'Bad Id'},
        {'field': 'source_id', 'value': 'x1'},
        {'field': 'csv_row_id', 'value': 'row-7', 'source': ''},
    ])
    def test_invalid_requests_are_400(self, route, body):
        response, _ = route('POST', '/settings/erasure', body=body)
        assert response['statusCode'] == 400

    @pytest.mark.usefixtures('invoke')
    @pytest.mark.parametrize('field', ['source_id', 'csv_row_id'])
    def test_an_id_erasure_names_its_source(self, route, field):
        response, body = route('POST', '/settings/erasure', body={'field': field, 'value': 'x1'})
        assert (response['statusCode'], body['error']) == (400, f'source is required when field is {field}')
        response, body = route('POST', '/settings/erasure', body={'field': field, 'value': 'x1', 'source': 'tickets'})
        assert (response['statusCode'], body['job']['source']) == (202, 'tickets')

    @pytest.mark.usefixtures('invoke')
    def test_admin_only(self, route):
        response, _ = route('POST', '/settings/erasure', body={'field': 'author', 'value': 'x'}, claims=USER_CLAIMS)
        assert response['statusCode'] == 403
        response, _ = route('GET', '/settings/erasure', claims=USER_CLAIMS)
        assert response['statusCode'] == 403

    def test_a_failed_invoke_fails_the_job(self, route, invoke):
        invoke.side_effect = RuntimeError('down')
        response, _ = route('POST', '/settings/erasure', body={'field': 'author', 'value': 'x'})
        assert response['statusCode'] == 500
        _, body = route('GET', '/settings/erasure')
        assert [job['status'] for job in body['jobs']] == ['failed']
        assert body['jobs'][0]['error'] == 'Could not start the erasure worker'

    @pytest.mark.usefixtures('invoke')
    def test_the_list_is_newest_first(self, route, table):
        for n in range(3):
            table.put_item(Item={'pk': 'JOB#erasure', 'sk': f'er_00000000000{n}', 'job_id': f'er_00000000000{n}',
                                 'status': 'completed', 'deleted_items': n})
        _, body = route('GET', '/settings/erasure')
        assert [job['deleted_items'] for job in body['jobs']] == [2, 1, 0]

    def test_without_the_worker_configured(self, route):
        with patch.object(settings_handler, 'RETENTION_FUNCTION', ''):
            response, _ = route('POST', '/settings/erasure', body={'field': 'author', 'value': 'x'})
        assert response['statusCode'] == 500


def _counted(table, source: str) -> None:
    """A source the aggregator has counted (one METRIC#daily_source# row)."""
    table.put_item(Item={'pk': f'METRIC#daily_source#{source}', 'sk': '2026-01-01', 'metric_type': 'source',
                         'count': 3})


def _whole(source_id: str, **extra) -> dict:
    return {'field': 'source', 'value': source_id, 'confirm': source_id, **extra}


@pytest.mark.usefixtures('table')
class TestWholeSourceErasure:
    def test_a_confirmed_known_source_starts_a_source_job(self, route, invoke, table):
        _counted(table, 'web_trustpilot_example_air')
        response, body = route('POST', '/settings/erasure', body=_whole('web_trustpilot_example_air'))
        assert response['statusCode'] == 202
        job = body['job']
        assert (job['field'], job['source']) == ('source', 'web_trustpilot_example_air')
        assert job['value_hash'] == hashlib.sha256(b'web_trustpilot_example_air').hexdigest()
        invoke.assert_called_once_with('voc-retention', {
            'mode': 'erase', 'job_id': job['job_id'], 'value': 'web_trustpilot_example_air'})

    @pytest.mark.usefixtures('invoke')
    def test_a_configured_profile_is_known_without_counted_data(self, route, table):
        table.put_item(Item={'pk': 'SETTINGS#sources', 'sk': 'config', 'sources': [{'id': 'support_tickets'}]})
        response, _ = route('POST', '/settings/erasure', body=_whole('support_tickets'))
        assert response['statusCode'] == 202

    @pytest.mark.usefixtures('invoke')
    @pytest.mark.parametrize(('body', 'error'), [
        ({'field': 'source', 'value': 'tickets'}, 'confirm must repeat the source id'),
        (_whole('tickets', confirm='ticket'), 'confirm must repeat the source id'),
        (_whole('tickets', confirm='TICKETS'), 'confirm must repeat the source id'),
        (_whole('tickets', source='web'), 'source must equal value when field is source'),
        (_whole('Bad Id'), 'value must be a source id when field is source'),
        (_whole('nobody'), 'Unknown source'),
    ])
    def test_an_unconfirmed_or_unknown_source_is_400(self, route, invoke, table, body, error):
        _counted(table, 'tickets')
        response, answer = route('POST', '/settings/erasure', body=body)
        assert (response['statusCode'], answer['error']) == (400, error)
        invoke.assert_not_called()

    @pytest.mark.usefixtures('invoke')
    @pytest.mark.parametrize('status', ['queued', 'running'])
    def test_a_live_erasure_of_the_source_is_409(self, route, table, status):
        _counted(table, 'tickets')
        table.put_item(Item={'pk': 'JOB#erasure', 'sk': 'er_000000000001', 'job_id': 'er_000000000001',
                             'status': status, 'field': 'author', 'source': 'tickets',
                             'created_at': datetime.now(UTC).isoformat()})
        response, _ = route('POST', '/settings/erasure', body=_whole('tickets'))
        assert response['statusCode'] == 409

    @pytest.mark.usefixtures('invoke')
    def test_a_finished_other_source_or_stalled_job_does_not_block(self, route, table):
        _counted(table, 'tickets')
        stalled = (datetime.now(UTC) - timedelta(hours=2)).isoformat()
        for n, (status, source, moved) in enumerate([
            ('completed', 'tickets', datetime.now(UTC).isoformat()),
            ('running', 'web', datetime.now(UTC).isoformat()),
            ('running', 'tickets', stalled),
        ]):
            table.put_item(Item={'pk': 'JOB#erasure', 'sk': f'er_00000000000{n}', 'job_id': f'er_00000000000{n}',
                                 'status': status, 'field': 'source', 'source': source,
                                 'created_at': stalled, 'progress_at': moved})
        response, _ = route('POST', '/settings/erasure', body=_whole('tickets'))
        assert response['statusCode'] == 202

    @pytest.mark.usefixtures('invoke')
    def test_the_list_names_the_erasable_sources(self, route, table):
        _counted(table, 'web_trustpilot_example_air')
        table.put_item(Item={'pk': 'SETTINGS#sources', 'sk': 'config', 'sources': [{'id': 'support_tickets'}]})
        _, body = route('GET', '/settings/erasure')
        assert body['sources'] == ['support_tickets', 'web_trustpilot_example_air']

    @pytest.mark.usefixtures('invoke')
    def test_a_whole_source_erasure_is_admin_only(self, route, table):
        _counted(table, 'tickets')
        response, _ = route('POST', '/settings/erasure', body=_whole('tickets'), claims=USER_CLAIMS)
        assert response['statusCode'] == 403
