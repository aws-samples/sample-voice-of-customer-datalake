"""Private baseline fixture provider contract and exact lifecycle."""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws
from shared.exceptions import (
    ApiError,
    ConfigurationError,
    ConflictError,
    ServiceError,
    ValidationError,
)
from verification_fixture_provider import (
    CAPABILITY,
    REQUEST_SCHEMA,
    RESULT_SCHEMA,
    _transact,
    lambda_handler,
    parse_provider_request,
    probe_fixture,
    setup_fixture,
    teardown_fixture,
)


def _table(name):
    return boto3.resource('dynamodb', region_name='us-east-1').create_table(
        TableName=name,
        KeySchema=[
            {'AttributeName': 'pk', 'KeyType': 'HASH'},
            {'AttributeName': 'sk', 'KeyType': 'RANGE'},
        ],
        AttributeDefinitions=[
            {'AttributeName': 'pk', 'AttributeType': 'S'},
            {'AttributeName': 'sk', 'AttributeType': 'S'},
        ],
        BillingMode='PAY_PER_REQUEST',
    )


def _request(operation='setup', **overrides):
    return {
        'schema': REQUEST_SCHEMA,
        'operation': operation,
        'capability': CAPABILITY,
        'verification_job_id': 'job-123',
        'slot': 'b',
        'tested_sha': 'a' * 40,
        **overrides,
    }


def _items(table):
    return table.scan(ConsistentRead=True)['Items']


def _tables():
    projects, aggregates = _table('projects'), _table('aggregates')
    return projects, aggregates


class TestProviderRequest:
    def test_accepts_only_the_closed_subject_and_operation(self):
        assert parse_provider_request(_request()) == _request()
        for overrides in (
            {'schema': 'other'},
            {'operation': 'execute'},
            {'capability': 'seed.anything'},
            {'verification_job_id': 'contains spaces'},
            {'slot': 'B'},
            {'tested_sha': 'abc'},
            {'table_name': 'projects'},
            {'command': 'seed.sh'},
        ):
            with pytest.raises(ValidationError):
                parse_provider_request(_request(**overrides))

    def test_manifest_declares_shape_but_no_provider_authority(self):
        # ABCA reads this contract from the REPOSITORY root, not the app root: its
        # courier resolves `.abca/fixture-manifest.json` against the Git worktree
        # root. A manifest under `voc-datalake/` is invisible to it, and absence
        # fails closed silently, so keep this path anchored at the repo root.
        repository_root = Path(__file__).parents[4]
        manifest = json.loads(
            (repository_root / '.abca' / 'fixture-manifest.json').read_text()
        )
        assert manifest == {
            'schema': 'verification.fixture.v1',
            'capabilities': [CAPABILITY],
            'expectations': {
                CAPABILITY: {
                    'documentRoles': ['scorable_prd'],
                    'rowRoles': ['baseline_row'],
                    'counts': {'projects': 1, 'documents': 1, 'rows': 1},
                    'providerProtocol': REQUEST_SCHEMA,
                }
            },
        }
        assert 'provider' not in manifest
        assert 'table' not in json.dumps(manifest).lower()


class TestTransactions:
    @staticmethod
    def _cancel(reason=None):
        response = {'Error': {'Code': 'TransactionCanceledException'}}
        if reason:
            response['CancellationReasons'] = [{'Code': reason}]
        return ClientError(response, 'TransactWriteItems')

    @staticmethod
    def _direct(code):
        return ClientError({'Error': {'Code': code}}, 'TransactWriteItems')

    def test_retries_transient_then_succeeds(self):
        client = MagicMock()
        client.transact_write_items.side_effect = [self._cancel('TransactionConflict'), {}]
        with patch('verification_fixture_provider.time.sleep') as sleep:
            _transact(client, [], collision_message='collision', failure_message='failure')
        assert client.transact_write_items.call_count == 2
        sleep.assert_called_once()

    def test_exhaustion_is_service_failure(self):
        client = MagicMock()
        client.transact_write_items.side_effect = [self._direct('RequestLimitExceeded')] * 3
        with patch('verification_fixture_provider.time.sleep'), pytest.raises(ServiceError):
            _transact(client, [], collision_message='collision', failure_message='failure')

    def test_only_confirmed_condition_failure_is_conflict(self):
        client = MagicMock()
        client.transact_write_items.side_effect = self._cancel('ConditionalCheckFailed')
        with pytest.raises(ConflictError):
            _transact(client, [], collision_message='collision', failure_message='failure')
        client.transact_write_items.side_effect = self._cancel()
        with pytest.raises(ServiceError):
            _transact(client, [], collision_message='collision', failure_message='failure')


class TestProviderLifecycle:
    @mock_aws
    def test_setup_probe_reuse_teardown_and_zero_residue(self):
        projects, aggregates = _tables()
        now = datetime(2026, 9, 11, 10, 0, tzinfo=timezone.utc)
        with (
            patch('verification_fixture_provider.get_projects_table', return_value=projects),
            patch('verification_fixture_provider.get_aggregates_table', return_value=aggregates),
        ):
            created = setup_fixture(_request('setup'), now=now)
            reused = setup_fixture(_request('setup'), now=now + timedelta(hours=1))
            observed = probe_fixture(_request('probe'))
            removed = teardown_fixture(_request('teardown'))
            removed_again = teardown_fixture(_request('teardown'))

        assert created['schema'] == RESULT_SCHEMA
        assert created['state'] == 'created'
        assert reused['state'] == 'reused'
        assert reused['fixture_id'] == created['fixture_id']
        assert reused['expires_at'] == created['expires_at'], 'same-owner repair is byte-stable'
        assert created['counts'] == {'projects': 1, 'documents': 1, 'rows': 1}
        assert created['document_ids'].keys() == {'scorable_prd'}
        assert created['row_ids'].keys() == {'baseline_row'}
        assert observed['state'] == 'active'
        assert observed['observations'] == [
            'project_meta', 'scorable_prd', 'baseline_row', 'row_document_link',
        ]
        assert removed['state'] == 'removed'
        assert removed['verified_zero_remain'] is True
        assert removed_again['state'] == 'removed'
        assert _items(projects) == []
        assert _items(aggregates) == []

    @mock_aws
    def test_exact_three_records_are_owned_and_related(self):
        projects, aggregates = _tables()
        with (
            patch('verification_fixture_provider.get_projects_table', return_value=projects),
            patch('verification_fixture_provider.get_aggregates_table', return_value=aggregates),
        ):
            result = setup_fixture(_request('setup'))

        project_items, aggregate_items = _items(projects), _items(aggregates)
        assert len(project_items) == 2
        assert len(aggregate_items) == 1
        for item in [*project_items, *aggregate_items]:
            assert item['verification_fixture_id'] == result['fixture_id']
            assert item['verification_job_id'] == 'job-123'
            assert item['verification_slot'] == 'b'
            assert item['verification_tested_sha'] == 'a' * 40
            assert int(item['ttl']) > 0
        document = next(item for item in project_items if item['sk'].startswith('PRD#'))
        row = aggregate_items[0]
        assert document['document_type'] == 'prd'
        assert row['is_default'] is False
        assert row['project_id'] == result['project_id']
        assert row['document_ids'] == [result['document_ids']['scorable_prd']]

    @mock_aws
    def test_foreign_collision_is_atomic(self):
        projects, aggregates = _tables()
        projects.put_item(Item={
            'pk': 'PROJECT#proj_vf_foreign', 'sk': 'META',
            'verification_fixture_id': 'foreign',
        })
        # Derive the real key, then occupy it with a foreign owner.
        with (
            patch('verification_fixture_provider.get_projects_table', return_value=projects),
            patch('verification_fixture_provider.get_aggregates_table', return_value=aggregates),
        ):
            result = setup_fixture(_request('setup'))
            teardown_fixture(_request('teardown'))
            projects.put_item(Item={
                'pk': f"PROJECT#{result['project_id']}", 'sk': 'META',
                'verification_fixture_id': 'foreign',
                'verification_job_id': 'other',
                'verification_slot': 'b',
                'verification_tested_sha': 'a' * 40,
            })
            with pytest.raises(ConflictError):
                setup_fixture(_request('setup'))
        assert len(_items(projects)) == 2, 'unrelated + foreign item survive; no partial fixture write'
        assert _items(aggregates) == []

    @mock_aws
    def test_probe_rejects_relationship_drift(self):
        projects, aggregates = _tables()
        with (
            patch('verification_fixture_provider.get_projects_table', return_value=projects),
            patch('verification_fixture_provider.get_aggregates_table', return_value=aggregates),
        ):
            result = setup_fixture(_request('setup'))
            aggregates.update_item(
                Key={
                    'pk': 'PRIORITIZATION',
                    'sk': f"ROW#{result['row_ids']['baseline_row']}",
                },
                UpdateExpression='SET document_ids = :ids',
                ExpressionAttributeValues={':ids': ['wrong']},
            )
            with pytest.raises(ConflictError):
                probe_fixture(_request('probe'))


    @mock_aws
    def test_expired_meta_is_renewed_and_missing_siblings_are_repaired(self):
        projects, aggregates = _tables()
        now = datetime(2026, 9, 11, 10, 0, tzinfo=timezone.utc)
        with (
            patch('verification_fixture_provider.get_projects_table', return_value=projects),
            patch('verification_fixture_provider.get_aggregates_table', return_value=aggregates),
        ):
            first = setup_fixture(_request('setup'), now=now)
            projects.update_item(
                Key={'pk': f"PROJECT#{first['project_id']}", 'sk': 'META'},
                UpdateExpression='SET #ttl = :ttl',
                ExpressionAttributeNames={'#ttl': 'ttl'},
                ExpressionAttributeValues={':ttl': int(now.timestamp()) - 1},
            )
            projects.delete_item(Key={
                'pk': f"PROJECT#{first['project_id']}",
                'sk': f"PRD#{first['document_ids']['scorable_prd']}",
            })
            aggregates.delete_item(Key={
                'pk': 'PRIORITIZATION',
                'sk': f"ROW#{first['row_ids']['baseline_row']}",
            })
            renewed = setup_fixture(_request('setup'), now=now + timedelta(hours=7))
        assert renewed['state'] == 'created'
        assert renewed['expires_at'] > first['expires_at']
        assert len(_items(projects)) == 2
        assert len(_items(aggregates)) == 1


class TestLambdaHandler:
    """The Lambda boundary: every failure must leave as a closed result envelope.

    ABCA classifies outcomes from `error_code`, so a mapping regression here turns a
    permanent rejection into a retryable one (or the reverse) without any test failing
    further down.
    """

    @pytest.mark.parametrize(
        ('error', 'expected_code'),
        [
            (ValidationError('bad subject'), 'validation'),
            (ConfigurationError('missing table'), 'configuration'),
            (ConflictError('someone else owns it'), 'conflict'),
            (ServiceError('dynamo said no'), 'service'),
            # An ApiError subclass nobody mapped must degrade to 'service', never crash.
            (ApiError('unmapped'), 'service'),
        ],
    )
    def test_maps_each_api_error_to_its_closed_code(self, error, expected_code, lambda_context):
        with patch('verification_fixture_provider.parse_provider_request', side_effect=error):
            result = lambda_handler(_request(), lambda_context)
        assert result == {
            'schema': RESULT_SCHEMA,
            'operation': 'setup',
            'capability': CAPABILITY,
            'success': False,
            'error_code': expected_code,
        }

    def test_unexpected_exception_becomes_internal_not_a_raise(self, lambda_context):
        with patch(
            'verification_fixture_provider.parse_provider_request',
            side_effect=RuntimeError('boom'),
        ):
            result = lambda_handler(_request('probe'), lambda_context)
        assert result['success'] is False
        assert result['error_code'] == 'internal'
        assert result['operation'] == 'probe'

    def test_rejected_operation_is_reported_as_unknown_not_echoed(self, lambda_context):
        """The envelope must never reflect an unvalidated operation back to the caller."""
        result = lambda_handler(_request(operation='execute'), lambda_context)
        assert result['operation'] == 'unknown'
        assert result['error_code'] == 'validation'

    def test_non_dict_event_is_rejected_without_touching_operation(self, lambda_context):
        result = lambda_handler(['not', 'a', 'dict'], lambda_context)
        assert result['operation'] == 'unknown'
        assert result['success'] is False

    @pytest.mark.parametrize(
        ('operation', 'target'),
        [
            ('setup', 'setup_fixture'),
            ('probe', 'probe_fixture'),
            ('teardown', 'teardown_fixture'),
        ],
    )
    def test_dispatches_each_operation_to_its_own_function(
        self, operation, target, lambda_context,
    ):
        request = _request(operation)
        sentinel = {'schema': RESULT_SCHEMA, 'operation': operation, 'success': True}
        with patch(
            'verification_fixture_provider.parse_provider_request', return_value=request,
        ), patch(f'verification_fixture_provider.{target}', return_value=sentinel) as dispatched:
            assert lambda_handler(request, lambda_context) is sentinel
        dispatched.assert_called_once_with(request)
