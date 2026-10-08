"""Mutation-hardening pins for `verification_fixture_provider`.

The lifecycle suite drives the provider end to end against moto and checks the
states it reports, but a mutation run showed how much of the contract it left
unobserved: no refusal message was ever read (any reworded or swapped message
passed), the request-derived identity was only compared with itself, the exact
items, owner conditions and keys sent to `TransactWriteItems` were never
inspected, the retry schedule (which codes retry, how many attempts, the
back-off) was pinned by a single code, the renewal margin had no test AT its
boundary second, each probe shape check could be dropped as long as another one
still fired, and the handler's log lines and Powertools instrumentation could be
removed silently. These tests pin each of those literally, mostly against
in-memory fakes so every call argument is visible.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from decimal import Decimal
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, call, patch

import pytest
from botocore.exceptions import ClientError

import verification_fixture_provider as provider
from shared.exceptions import ConfigurationError, ConflictError, ServiceError, ValidationError
from shared.logging import logger
from shared.test.instrumentation_fixtures import assert_tracer_wrapped
from verification_fixture_provider import (
    lambda_handler,
    parse_provider_request,
    probe_fixture,
    setup_fixture,
    teardown_fixture,
)

_DIGEST = '004c1fcc8fc14385292a440c'
_FIXTURE_ID = f'vfb_{_DIGEST}'
_PROJECT_ID = f'proj_vf_{_DIGEST}'
_DOCUMENT_ID = f'prd_{_FIXTURE_ID}'
_ROW_ID = f'row_{_FIXTURE_ID}'
_NOW = datetime(2026, 9, 11, 10, 0, tzinfo=UTC)
_NOW_TS = 1789120800
_NEW_TTL = 1789142400  # _NOW + 6 h
_NEW_EXPIRES = '2026-09-11T16:00:00+00:00'
_CREATED = '2026-01-01T00:00:00+00:00'
_META_KEY = {'pk': f'PROJECT#{_PROJECT_ID}', 'sk': 'META'}
_DOC_KEY = {'pk': f'PROJECT#{_PROJECT_ID}', 'sk': f'PRD#{_DOCUMENT_ID}'}
_ROW_KEY = {'pk': 'PRIORITIZATION', 'sk': f'ROW#{_ROW_ID}'}
_OWNER = {
    'verification_fixture_id': _FIXTURE_ID,
    'verification_job_id': 'job-123',
    'verification_slot': 'b',
    'verification_tested_sha': 'a' * 40,
}
_CONDITION = (
    'attribute_not_exists(pk) OR '
    '(#fixture = :fixture AND #job = :job AND #slot = :slot AND #sha = :sha)'
)
_NAMES = {
    '#fixture': 'verification_fixture_id',
    '#job': 'verification_job_id',
    '#slot': 'verification_slot',
    '#sha': 'verification_tested_sha',
}
_VALUES = {':fixture': _FIXTURE_ID, ':job': 'job-123', ':slot': 'b', ':sha': 'a' * 40}


def _request(operation: str = 'setup', **overrides: Any) -> dict[str, Any]:
    return {
        'schema': 'verification.fixture.provider.request.v1',
        'operation': operation,
        'capability': 'seed.prioritization-baseline',
        'verification_job_id': 'job-123',
        'slot': 'b',
        'tested_sha': 'a' * 40,
        **overrides,
    }


class _FakeTable:
    """A table whose `get_item` answers from a dict and whose client is shared."""

    def __init__(self, name: Any, client: MagicMock, items: dict[tuple[str, str], Any] | None = None):
        self.name = name
        self.meta = MagicMock()
        self.meta.client = client
        self.items = items or {}
        self.get_item = MagicMock(side_effect=self._get)

    def _get(self, **kwargs: Any) -> dict[str, Any]:
        assert kwargs['ConsistentRead'] is True
        key = kwargs['Key']
        item = self.items.get((key['pk'], key['sk']))
        return {} if item is None else {'Item': item}


def _fakes(
    project_items: dict[tuple[str, str], Any] | None = None,
    aggregate_items: dict[tuple[str, str], Any] | None = None,
    *,
    projects_name: Any = 'voc-projects',
    aggregates_name: Any = 'voc-aggregates',
) -> tuple[_FakeTable, _FakeTable, MagicMock]:
    client = MagicMock()
    projects = _FakeTable(projects_name, client, project_items)
    aggregates = _FakeTable(aggregates_name, client, aggregate_items)
    return projects, aggregates, client


def _patch_tables(projects: Any, aggregates: Any) -> Any:
    return patch.multiple(
        provider,
        get_projects_table=MagicMock(return_value=projects),
        get_aggregates_table=MagicMock(return_value=aggregates),
    )


def _meta(**overrides: Any) -> dict[str, Any]:
    return {
        **_META_KEY, 'project_id': _PROJECT_ID, 'document_count': 1,
        'fixture_expires_at': 'kept', 'ttl': _NOW_TS + 4 * 3600, **_OWNER, **overrides,
    }


def _document(**overrides: Any) -> dict[str, Any]:
    return {**_DOC_KEY, 'document_id': _DOCUMENT_ID, 'document_type': 'prd', **_OWNER, **overrides}


def _row(**overrides: Any) -> dict[str, Any]:
    return {
        **_ROW_KEY, 'row_id': _ROW_ID, 'project_id': _PROJECT_ID,
        'document_ids': [_DOCUMENT_ID], 'is_default': False, **_OWNER, **overrides,
    }


def _baseline(**overrides: dict[str, Any]) -> tuple[_FakeTable, _FakeTable, MagicMock]:
    meta, document, row = (
        _meta(**overrides.get('meta', {})),
        _document(**overrides.get('document', {})),
        _row(**overrides.get('row', {})),
    )
    return _fakes(
        {(_META_KEY['pk'], 'META'): meta, (_DOC_KEY['pk'], _DOC_KEY['sk']): document},
        {(_ROW_KEY['pk'], _ROW_KEY['sk']): row},
    )


def _client_error(code: str | None = None, reasons: Any = None) -> ClientError:
    if code is None:
        return ClientError({'CancellationReasons': reasons}, 'TransactWriteItems')
    if reasons is None:
        return ClientError({'Error': {'Code': code}}, 'TransactWriteItems')
    return ClientError(
        {'Error': {'Code': code}, 'CancellationReasons': reasons}, 'TransactWriteItems',
    )


class TestEveryRequestRefusalNamesItsCause:
    @pytest.mark.parametrize(
        ('raw', 'message'),
        [
            (['not', 'a', 'dict'], 'request must be an object'),
            ({**_request(), 'zeta': 1, 'alpha': 1}, 'field is not allowed: alpha'),
            ({k: v for k, v in _request().items() if k not in ('slot', 'tested_sha')},
             'field is required: slot'),
            ({**{k: v for k, v in _request().items() if k != 'slot'}, 'extra': 1},
             'field is not allowed: extra'),
            (_request(schema='v2'), 'schema must equal verification.fixture.provider.request.v1'),
            (_request(operation='execute'), 'operation must be setup, probe, or teardown'),
            (_request(capability='seed.x'), 'capability must equal seed.prioritization-baseline'),
            (_request(verification_job_id=123), 'verification_job_id has an invalid format'),
            (_request(slot='ab'), 'slot has an invalid format'),
            (_request(tested_sha='A' * 40), 'tested_sha has an invalid format'),
        ],
    )
    def test_message(self, raw: Any, message: str) -> None:
        with pytest.raises(ValidationError) as caught:
            parse_provider_request(raw)
        assert caught.value.message == message

    @pytest.mark.parametrize(
        ('field', 'value', 'accepted'),
        [
            ('verification_job_id', 'A' * 128, True),
            ('verification_job_id', 'A' * 129, False),
            ('verification_job_id', '', False),
            ('verification_job_id', 'a_Z-9', True),
            ('verification_job_id', 'job\n', False),
            ('slot', 'a', True),
            ('slot', 'z', True),
            ('slot', '', False),
            ('tested_sha', 'f' * 64, True),
            ('tested_sha', '0' * 41, False),
            ('tested_sha', '0' * 63, False),
            ('tested_sha', 'g' * 40, False),
        ],
    )
    def test_field_boundaries(self, field: str, value: str, accepted: bool) -> None:
        if accepted:
            assert parse_provider_request(_request(**{field: value}))[field] == value
        else:
            with pytest.raises(ValidationError):
                parse_provider_request(_request(**{field: value}))

    @pytest.mark.parametrize('operation', ['setup', 'probe', 'teardown'])
    def test_every_operation_is_accepted(self, operation: str) -> None:
        assert parse_provider_request(_request(operation)) == _request(operation)


class TestIdentityIsDerivedFromTheRequest:
    def test_exact_ids(self) -> None:
        assert provider._ids(_request()) == {
            'fixture_id': _FIXTURE_ID,
            'project_id': _PROJECT_ID,
            'document_ids': {'scorable_prd': _DOCUMENT_ID},
            'row_ids': {'baseline_row': _ROW_ID},
        }


class TestSetupWritesExactlyTheBaseline:
    def _items(self, *, ttl: int, expires_at: str) -> list[dict[str, Any]]:
        def put(table: str, item: dict[str, Any]) -> dict[str, Any]:
            return {'Put': {
                'TableName': table, 'Item': item, 'ConditionExpression': _CONDITION,
                'ExpressionAttributeNames': _NAMES, 'ExpressionAttributeValues': _VALUES,
            }}
        return [
            put('voc-projects', {
                **_META_KEY, 'gsi1pk': 'TYPE#PROJECT', 'gsi1sk': _CREATED,
                'project_id': _PROJECT_ID, 'name': f'ABCA baseline fixture {_FIXTURE_ID}',
                'description': 'Target-owned ABCA baseline fixture; safe to remove.',
                'status': 'active', 'created_at': _CREATED, 'updated_at': _CREATED,
                'persona_count': 0, 'document_count': 1, 'filters': {},
                'fixture_expires_at': expires_at, 'ttl': ttl, **_OWNER,
            }),
            put('voc-projects', {
                **_DOC_KEY, 'gsi1pk': f'PROJECT#{_PROJECT_ID}#DOCUMENTS', 'gsi1sk': _CREATED,
                'document_id': _DOCUMENT_ID, 'document_type': 'prd',
                'title': 'ABCA prioritization baseline',
                'feature_idea': 'Verify one scorable document in one prioritization row.',
                'content': 'Deterministic target-owned document used only for ABCA verification.',
                'created_at': _CREATED, 'updated_at': _CREATED, 'ttl': ttl, **_OWNER,
            }),
            put('voc-aggregates', {
                **_ROW_KEY, 'row_id': _ROW_ID, 'project_id': _PROJECT_ID,
                'document_ids': [_DOCUMENT_ID], 'prototype_id': '', 'is_default': False,
                'created_at': _CREATED, 'updated_at': _CREATED, 'ttl': ttl, **_OWNER,
            }),
        ]

    def _result(self, state: str, expires_at: str) -> dict[str, Any]:
        return {
            'schema': 'verification.fixture.provider.result.v1', 'operation': 'setup',
            'capability': 'seed.prioritization-baseline', 'success': True, 'state': state,
            'fixture_id': _FIXTURE_ID, 'project_id': _PROJECT_ID,
            'document_ids': {'scorable_prd': _DOCUMENT_ID}, 'row_ids': {'baseline_row': _ROW_ID},
            'counts': {'projects': 1, 'documents': 1, 'rows': 1}, 'expires_at': expires_at,
            'observations': [], 'verified_zero_remain': False,
        }

    def test_fresh_setup_writes_three_owned_items_with_a_six_hour_ttl(self) -> None:
        projects, aggregates, client = _fakes()
        with _patch_tables(projects, aggregates):
            result = setup_fixture(_request(), now=_NOW)
        client.transact_write_items.assert_called_once_with(
            TransactItems=self._items(ttl=_NEW_TTL, expires_at=_NEW_EXPIRES),
        )
        projects.get_item.assert_called_once_with(Key=_META_KEY, ConsistentRead=True)
        assert result == self._result('created', _NEW_EXPIRES)

    @pytest.mark.parametrize(
        ('remaining', 'state'),
        [(3600, 'created'), (3601, 'reused'), (3599, 'created'), (0, 'created')],
    )
    def test_renewal_margin_boundary(self, remaining: int, state: str) -> None:
        projects, aggregates, client = _fakes({
            (_META_KEY['pk'], 'META'): _meta(ttl=Decimal(_NOW_TS + remaining)),
        })
        with _patch_tables(projects, aggregates):
            result = setup_fixture(_request(), now=_NOW)
        if state == 'reused':
            expected = self._items(ttl=_NOW_TS + remaining, expires_at='kept')
            assert result == self._result('reused', 'kept')
        else:
            expected = self._items(ttl=_NEW_TTL, expires_at=_NEW_EXPIRES)
            assert result == self._result('created', _NEW_EXPIRES)
        client.transact_write_items.assert_called_once_with(TransactItems=expected)

    @pytest.mark.parametrize('ttl', [_NOW_TS + 7200, float(_NOW_TS + 7200), Decimal(_NOW_TS + 7200)])
    def test_every_numeric_ttl_type_is_reused(self, ttl: Any) -> None:
        projects, aggregates, client = _fakes({(_META_KEY['pk'], 'META'): _meta(ttl=ttl)})
        with _patch_tables(projects, aggregates):
            result = setup_fixture(_request(), now=_NOW)
        assert result['state'] == 'reused'
        written = client.transact_write_items.call_args.kwargs['TransactItems']
        assert [entry['Put']['Item']['ttl'] for entry in written] == [_NOW_TS + 7200] * 3

    @pytest.mark.parametrize(
        'overrides', [{'fixture_expires_at': 5}, {'ttl': '1789142400'}, {'ttl': None}],
    )
    def test_incomplete_owned_metadata_is_a_conflict(self, overrides: dict[str, Any]) -> None:
        projects, aggregates, client = _fakes({(_META_KEY['pk'], 'META'): _meta(**overrides)})
        with _patch_tables(projects, aggregates), pytest.raises(ConflictError) as caught:
            setup_fixture(_request(), now=_NOW)
        assert caught.value.message == 'Owned fixture metadata is incomplete'
        client.transact_write_items.assert_not_called()

    @pytest.mark.parametrize('field', list(_OWNER))
    def test_any_foreign_owner_field_is_a_conflict(self, field: str) -> None:
        projects, aggregates, client = _fakes({(_META_KEY['pk'], 'META'): _meta(**{field: 'other'})})
        with _patch_tables(projects, aggregates), pytest.raises(ConflictError) as caught:
            setup_fixture(_request(), now=_NOW)
        assert caught.value.message == 'Fixture project key is owned by another subject'
        client.transact_write_items.assert_not_called()

    def test_without_now_the_wall_clock_sets_the_expiry(self) -> None:
        projects, aggregates, client = _fakes()
        before = int(time.time())
        with _patch_tables(projects, aggregates):
            setup_fixture(_request())
        ttl = client.transact_write_items.call_args.kwargs['TransactItems'][0]['Put']['Item']['ttl']
        assert before + 21600 <= ttl <= int(time.time()) + 21600


class TestTableConfiguration:
    @pytest.mark.parametrize('missing', ['projects', 'aggregates'])
    @pytest.mark.parametrize('operation', [setup_fixture, probe_fixture, teardown_fixture])
    def test_a_missing_table_is_a_configuration_error(self, missing: str, operation: Any) -> None:
        projects, aggregates, _ = _fakes()
        with _patch_tables(
            None if missing == 'projects' else projects,
            None if missing == 'aggregates' else aggregates,
        ), pytest.raises(ConfigurationError) as caught:
            operation(_request())
        assert caught.value.message == 'fixture provider tables are not configured'

    @pytest.mark.parametrize(
        ('projects_name', 'aggregates_name', 'message'),
        [
            ('', 'voc-aggregates', 'Projects table not configured'),
            (None, 'voc-aggregates', 'Projects table not configured'),
            ('voc-projects', 7, 'Aggregates table not configured'),
        ],
    )
    @pytest.mark.parametrize('operation', [setup_fixture, teardown_fixture])
    def test_an_unnamed_table_is_refused_before_any_write(
        self, projects_name: Any, aggregates_name: Any, message: str, operation: Any,
    ) -> None:
        projects, aggregates, client = _fakes(projects_name=projects_name, aggregates_name=aggregates_name)
        with _patch_tables(projects, aggregates), pytest.raises(ConfigurationError) as caught:
            operation(_request())
        assert caught.value.message == message
        client.transact_write_items.assert_not_called()


class TestTransactRetrySchedule:
    @pytest.mark.parametrize('code', [
        'TransactionConflict',
        'TransactionInProgressException',
        'ProvisionedThroughputExceeded',
        'ProvisionedThroughputExceededException',
        'RequestLimitExceeded',
        'ThrottlingError',
        'ThrottlingException',
    ])
    @pytest.mark.parametrize('as_reason', [False, True])
    def test_each_retryable_code_is_tried_three_times_with_backoff(self, code: str, as_reason: bool) -> None:
        error = (_client_error('TransactionCanceledException', [{'Code': code}])
                 if as_reason else _client_error(code))
        client = MagicMock()
        client.transact_write_items.side_effect = [error, error, error]
        with patch.object(provider.time, 'sleep') as sleep, pytest.raises(ServiceError) as caught:
            provider._transact(client, [{'x': 1}], collision_message='c', failure_message='f')
        assert client.transact_write_items.call_args_list == [call(TransactItems=[{'x': 1}])] * 3
        assert sleep.call_args_list == [call(0.05), call(0.1)]
        assert caught.value.message == 'f'
        assert caught.value.__cause__ is error

    def test_success_after_one_retry_returns_none(self) -> None:
        client = MagicMock()
        client.transact_write_items.side_effect = [_client_error('ThrottlingException'), {}]
        with patch.object(provider.time, 'sleep') as sleep:
            assert provider._transact(client, [], collision_message='c', failure_message='f') is None
        assert client.transact_write_items.call_count == 2
        sleep.assert_called_once_with(0.05)

    @pytest.mark.parametrize(
        'error',
        [
            _client_error('ValidationException'),
            _client_error(None),
            _client_error('TransactionCanceledException', 'not-a-list'),
            _client_error('TransactionCanceledException', ['TransactionConflict', {'Code': 'None'}]),
        ],
    )
    def test_non_retryable_fails_once_without_sleeping(self, error: ClientError) -> None:
        client = MagicMock()
        client.transact_write_items.side_effect = [error]
        with patch.object(provider.time, 'sleep') as sleep, pytest.raises(ServiceError) as caught:
            provider._transact(client, [], collision_message='c', failure_message='f')
        assert caught.value.message == 'f'
        assert caught.value.__cause__ is error
        sleep.assert_not_called()

    def test_reasons_without_an_error_block_still_retry(self) -> None:
        client = MagicMock()
        client.transact_write_items.side_effect = [
            _client_error(None, [{'Code': 'TransactionConflict'}]), {},
        ]
        with patch.object(provider.time, 'sleep'):
            provider._transact(client, [], collision_message='c', failure_message='f')
        assert client.transact_write_items.call_count == 2

    def test_condition_failure_wins_over_a_retryable_reason(self) -> None:
        error = _client_error('ThrottlingException', [{'Code': 'TransactionConflict'}, {'Code': 'ConditionalCheckFailed'}])
        client = MagicMock()
        client.transact_write_items.side_effect = [error]
        with pytest.raises(ConflictError) as caught:
            provider._transact(client, [], collision_message='c', failure_message='f')
        assert caught.value.message == 'c'
        assert caught.value.__cause__ is error


class TestProbeChecksEveryRelationship:
    def test_matching_baseline_is_active(self) -> None:
        projects, aggregates, _ = _baseline()
        with _patch_tables(projects, aggregates):
            result = probe_fixture(_request('probe'))
        assert result == {
            'schema': 'verification.fixture.provider.result.v1', 'operation': 'probe',
            'capability': 'seed.prioritization-baseline', 'success': True, 'state': 'active',
            'fixture_id': _FIXTURE_ID, 'project_id': _PROJECT_ID,
            'document_ids': {'scorable_prd': _DOCUMENT_ID}, 'row_ids': {'baseline_row': _ROW_ID},
            'counts': {'projects': 1, 'documents': 1, 'rows': 1}, 'expires_at': 'kept',
            'observations': ['project_meta', 'scorable_prd', 'baseline_row', 'row_document_link'],
            'verified_zero_remain': False,
        }

    @pytest.mark.parametrize(
        ('overrides', 'message'),
        [
            ({'meta': {'verification_slot': 'c'}}, 'project ownership does not match'),
            ({'document': {'verification_job_id': 'x'}}, 'document ownership does not match'),
            ({'row': {'verification_tested_sha': 'b' * 40}}, 'row ownership does not match'),
            ({'meta': {'project_id': 'proj_other'}}, 'project shape does not match baseline'),
            ({'meta': {'document_count': 2}}, 'project shape does not match baseline'),
            ({'document': {'document_id': 'prd_other'}}, 'document shape does not match baseline'),
            ({'document': {'document_type': 'prfaq'}}, 'document shape does not match baseline'),
            ({'row': {'row_id': 'row_other'}}, 'row relationship does not match baseline'),
            ({'row': {'project_id': 'proj_other'}}, 'row relationship does not match baseline'),
            ({'row': {'document_ids': []}}, 'row relationship does not match baseline'),
            ({'row': {'is_default': None}}, 'row relationship does not match baseline'),
            ({'row': {'is_default': True}}, 'row relationship does not match baseline'),
            ({'meta': {'fixture_expires_at': None}}, 'fixture expiry is missing'),
        ],
    )
    def test_each_drift_names_its_record(self, overrides: dict[str, dict[str, Any]], message: str) -> None:
        projects, aggregates, _ = _baseline(**overrides)
        with _patch_tables(projects, aggregates), pytest.raises(ConflictError) as caught:
            probe_fixture(_request('probe'))
        assert caught.value.message == message

    @pytest.mark.parametrize(
        ('table', 'key', 'message'),
        [
            ('projects', (_META_KEY['pk'], 'META'), 'project is missing'),
            ('projects', (_DOC_KEY['pk'], _DOC_KEY['sk']), 'document is missing'),
            ('aggregates', (_ROW_KEY['pk'], _ROW_KEY['sk']), 'row is missing'),
        ],
    )
    @pytest.mark.parametrize('replacement', [None, 'not-a-mapping'])
    def test_each_missing_record_is_named(
        self, table: str, key: tuple[str, str], message: str, replacement: Any,
    ) -> None:
        projects, aggregates, _ = _baseline()
        store = projects if table == 'projects' else aggregates
        if replacement is None:
            del store.items[key]
        else:
            store.items[key] = replacement
        with _patch_tables(projects, aggregates), pytest.raises(ConflictError) as caught:
            probe_fixture(_request('probe'))
        assert caught.value.message == message


class TestTeardownDeletesOnlyOwnedKeys:
    def _deletes(self) -> list[dict[str, Any]]:
        return [
            {'Delete': {
                'TableName': table, 'Key': key, 'ConditionExpression': _CONDITION,
                'ExpressionAttributeNames': _NAMES, 'ExpressionAttributeValues': _VALUES,
            }}
            for table, key in (
                ('voc-projects', _META_KEY), ('voc-projects', _DOC_KEY), ('voc-aggregates', _ROW_KEY),
            )
        ]

    def test_exact_conditional_deletes_and_verified_result(self) -> None:
        projects, aggregates, client = _fakes()
        with _patch_tables(projects, aggregates):
            result = teardown_fixture(_request('teardown'))
        client.transact_write_items.assert_called_once_with(TransactItems=self._deletes())
        assert projects.get_item.call_args_list == [
            call(Key=_META_KEY, ConsistentRead=True), call(Key=_DOC_KEY, ConsistentRead=True),
        ]
        aggregates.get_item.assert_called_once_with(Key=_ROW_KEY, ConsistentRead=True)
        assert result == {
            'schema': 'verification.fixture.provider.result.v1', 'operation': 'teardown',
            'capability': 'seed.prioritization-baseline', 'success': True, 'state': 'removed',
            'fixture_id': _FIXTURE_ID, 'project_id': _PROJECT_ID,
            'document_ids': {'scorable_prd': _DOCUMENT_ID}, 'row_ids': {'baseline_row': _ROW_ID},
            'counts': {'projects': 1, 'documents': 1, 'rows': 1}, 'expires_at': None,
            'observations': [], 'verified_zero_remain': True,
        }

    @pytest.mark.parametrize('survivor', ['meta', 'document', 'row'])
    def test_any_remaining_record_fails_the_proof(self, survivor: str) -> None:
        projects, aggregates, _ = _baseline()
        for name, store, key in (
            ('meta', projects, (_META_KEY['pk'], 'META')),
            ('document', projects, (_DOC_KEY['pk'], _DOC_KEY['sk'])),
            ('row', aggregates, (_ROW_KEY['pk'], _ROW_KEY['sk'])),
        ):
            if name != survivor:
                del store.items[key]
        with _patch_tables(projects, aggregates), pytest.raises(ServiceError) as caught:
            teardown_fixture(_request('teardown'))
        assert caught.value.message == 'Fixture cleanup could not prove zero remains'


_CONDITION_FAILED = _client_error('TransactionCanceledException', [{'Code': 'ConditionalCheckFailed'}])
_PERMANENT = _client_error('ValidationException')


class TestEachTransactionNamesItsOperation:
    @pytest.mark.parametrize(
        ('operation', 'error', 'raised', 'message'),
        [
            ('setup', _CONDITION_FAILED, ConflictError, 'Fixture keys collide with another owner'),
            ('setup', _PERMANENT, ServiceError, 'Failed to set up fixture'),
            ('teardown', _CONDITION_FAILED, ConflictError, 'Fixture cleanup encountered another owner'),
            ('teardown', _PERMANENT, ServiceError, 'Failed to tear down fixture'),
        ],
    )
    def test_message(self, operation: str, error: ClientError, raised: type[Exception], message: str) -> None:
        projects, aggregates, client = _fakes()
        client.transact_write_items.side_effect = error
        run = setup_fixture if operation == 'setup' else teardown_fixture
        with _patch_tables(projects, aggregates), pytest.raises(raised) as caught:
            run(_request(operation))
        assert str(caught.value) == message


class TestHandlerBoundary:
    def test_rejection_logs_the_operation_and_error_type(self, lambda_context: MagicMock) -> None:
        with patch.object(logger, 'warning') as warning:
            result = lambda_handler(_request(slot='B'), lambda_context)
        warning.assert_called_once_with('Fixture provider rejected %s: %s', 'setup', 'ValidationError')
        assert result['error_code'] == 'validation'

    def test_internal_failure_logs_and_returns_the_closed_envelope(self, lambda_context: MagicMock) -> None:
        with patch.object(provider, 'parse_provider_request', side_effect=RuntimeError('boom')), \
                patch.object(logger, 'exception') as exception:
            result = lambda_handler(_request('teardown'), lambda_context)
        exception.assert_called_once_with('Fixture provider failed internally for %s', 'teardown')
        assert result == {
            'schema': 'verification.fixture.provider.result.v1', 'operation': 'teardown',
            'capability': 'seed.prioritization-baseline', 'success': False, 'error_code': 'internal',
        }

    def test_each_invocation_starts_from_clean_log_keys(self) -> None:
        context = SimpleNamespace(
            function_name='voc-verification-fixture-provider', memory_limit_in_mb=256,
            invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:p',
            aws_request_id='request-for-this-invocation',
        )
        logger.append_keys(stale_key='from-a-previous-invocation')
        try:
            lambda_handler(['bad'], context)
            keys = logger.get_current_keys()
            assert 'stale_key' not in keys
            assert keys['function_request_id'] == 'request-for-this-invocation'
        finally:
            logger.remove_keys(['stale_key'])

    @pytest.mark.parametrize('name', ['setup_fixture', 'probe_fixture', 'teardown_fixture'])
    def test_operations_are_traced(self, name: str) -> None:
        assert_tracer_wrapped(provider, name)

    def test_handler_is_traced_inside_the_logger_wrapper(self) -> None:
        tracer_wrapper = vars(provider.lambda_handler)['__wrapped__']
        handler = vars(tracer_wrapper)['__wrapped__']
        assert handler.__qualname__ == 'lambda_handler'
        assert tracer_wrapper.__code__.co_filename.endswith('tracer.py')
