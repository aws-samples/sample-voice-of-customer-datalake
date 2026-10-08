"""Mutation hardening for `api/projects_handler.py` lines 1008-2233 (ballot keys, scores, rows).

`test_projects_prioritization_ballots.py` and the 2234-3717 mutation suite drive
these helpers through the prioritization routes and pin what each route does.
A mutation run over these lines found what they cannot see:

* the VALUES of the bounds. Every earlier test reads `MAX_ROWS_PER_PROJECT`,
  `MAX_PRIORITIZATION_PAGES`, `MAX_PROJECT_DOCUMENT_PAGES` and `ROW_ID_BYTES` back
  out of the module, so `50 -> 51` moved the test with the code. They are pinned
  here as the literals operators and the page rely on.
* the keys a transaction `Update` accepts: removing one from
  `TRANSACT_UPDATE_KEYS` would refuse every ballot save that writes it, and no
  earlier test sent `ConditionExpression` or `ReturnValuesOnConditionCheckFailure`.
* the WORDING of every refusal on a ballot entry and on a caller identity, which
  reaches the page verbatim; the earlier tests matched fragments.
* that a null axis skips only ITSELF (`continue`, never `break`), so a malformed
  axis after a null one is still refused.
* the shape of a new row record (both instants, the same ISO value) and that a
  ballot key with an EMPTY row half is not a ballot.
* `continue` vs `break` in the loops that SKIP an item: a non-default row, a
  legacy document no row holds, a row nobody voted on. Skipping must not end
  the search. The aggregate walks a set, so `_Slot` fixes its order.
* the rounding of means and spread to two places, the empty-string fall-backs
  of the row payload, an empty id in the legacy map or a row's documents, and
  the freeze mark's empty-string and non-record cases.
* the log lines and messages of the best-effort legacy path and of the
  strongly consistent row reads in front of a save or a delete.
"""
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest
from ballots_fixtures import conditional_check_failed
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from test_projects_prioritization_ballots import AXES, _save_as

import projects_handler
from projects_handler import (
    _aggregate_scores,
    _ballot_expressed_a_value,
    _ballot_transact_items,
    _drop_legacy_score,
    _expresses_something,
    _fetched_ballot_rows,
    _fetched_row,
    _is_frozen_row,
    _legacy_score_document_ids,
    _legacy_scores_by_row,
    _parse_ballot_sk,
    _read_prioritization_partition,
    _row_document_ids,
    _row_payload,
    _row_record,
    _score_payload,
    _validated_ballot_entry,
)
from shared.exceptions import ConfigurationError, ServiceError, ValidationError


class TestThePublishedBounds:
    @pytest.mark.parametrize(('name', 'value'), [
        ('PRIORITIZATION_PK', 'PRIORITIZATION'),
        ('ROW_ID_BYTES', 16),
        ('MAX_PRIORITIZATION_PAGES', 20),
        ('MAX_ROWS_PER_PROJECT', 50),
        ('MAX_PROJECT_DOCUMENT_PAGES', 20),
    ])
    def test_bound(self, name, value):
        assert getattr(projects_handler, name) == value


def _transact_table() -> MagicMock:
    table = MagicMock()
    table.name = 'aggregates'
    return table


# One of each key a `TransactItems[].Update` accepts.
TRANSACT_KWARGS = {
    'TableName': 'aggregates',
    'Key': {'pk': 'PRIORITIZATION', 'sk': 'BALLOT#row-1#user:a'},
    'UpdateExpression': 'SET #updated_at = :updated_at',
    'ConditionExpression': 'attribute_exists(pk) OR attribute_not_exists(pk)',
    'ExpressionAttributeNames': {'#updated_at': 'updated_at'},
    'ExpressionAttributeValues': {':updated_at': '2026-01-01'},
    'ReturnValuesOnConditionCheckFailure': 'NONE',
}


class TestATransactionUpdateAcceptsEveryKeyDynamoDBDoes:
    def test_every_documented_key_is_carried_into_the_ballot_update(self):
        items = _ballot_transact_items(_transact_table(), dict(TRANSACT_KWARGS), 'row-1', 'now')
        assert items[0] == {'Update': dict(TRANSACT_KWARGS)}

    def test_a_resource_only_key_is_refused(self):
        with pytest.raises(ServiceError) as raised:
            _ballot_transact_items(_transact_table(), {**TRANSACT_KWARGS, 'ReturnValues': 'ALL_NEW'},
                                   'row-1', 'now')
        assert raised.value.message == 'Failed to save prioritization scores'


class TestEveryRefusalNamesItsCause:
    def test_a_subject_carrying_the_delimiter(self, api_gateway_event, lambda_context):
        _, status, body = _save_as(api_gateway_event, lambda_context, 'a#b')
        assert (status, body['error']) == (
            403, "Caller identity must not contain '#', the ballot sort-key delimiter",
        )

    @pytest.mark.parametrize(('entry', 'message'), [
        (['impact'], 'scores values must be objects, got list'),
        ({'confidence': 'high'},
         'confidence must be a number between 0 and 5, or null to leave it unchanged'),
        ({'impact': None, 'time_to_market': 'x'},
         'time_to_market must be a number between 0 and 5, or null to leave it unchanged'),
        ({'notes': 3}, 'notes must be a string, or null to leave it unchanged'),
        ({'notes': 'n' * 2001}, 'notes must be at most 2000 characters'),
    ])
    def test_a_ballot_entry(self, entry, message):
        with pytest.raises(ValidationError) as raised:
            _validated_ballot_entry(entry)
        assert raised.value.message == message

    def test_a_note_at_the_bound_is_accepted(self):
        entry = {**AXES, 'notes': 'n' * 2000}
        assert _validated_ballot_entry(entry) is entry


class TestTheBallotKey:
    @pytest.mark.parametrize('sk', ['BALLOT##user:a', 'BALLOT#row-1#', 'BALLOT#', 'ROW#row-1'])
    def test_a_key_missing_either_half_is_not_a_ballot(self, sk):
        assert _parse_ballot_sk(sk) is None

    def test_a_ballot_key_splits_at_the_last_delimiter(self):
        assert _parse_ballot_sk('BALLOT#row-1#user:a') == ('row-1', 'user:a')


class TestANewRowRecord:
    def test_the_record_is_stamped_created_and_updated_at_the_same_instant(self):
        before = datetime.now(UTC)
        record = _row_record('row-1', 'p1', ['prd-1'], 'proto-1', is_default=True)
        stamped = datetime.fromisoformat(record['created_at'])
        assert before <= stamped <= datetime.now(UTC)
        assert record == {
            'pk': 'PRIORITIZATION', 'sk': 'ROW#row-1', 'row_id': 'row-1', 'project_id': 'p1',
            'document_ids': ['prd-1'], 'prototype_id': 'proto-1', 'is_default': True,
            'created_at': record['created_at'], 'updated_at': record['created_at'],
        }


class TestWhatAnEntryExpresses:
    def test_a_vote_without_a_note_expresses_something(self):
        assert _expresses_something({'impact': 3}) is True

    def test_each_axis_reads_from_its_own_field(self):
        entry = {'impact': 1, 'time_to_market': 2, 'confidence': 3, 'strategic_fit': 4, 'notes': 'n'}
        assert _score_payload('row-1', entry) == {
            'row_id': 'row-1', 'impact': 1.0, 'time_to_market': 2.0, 'confidence': 3.0,
            'strategic_fit': 4.0, 'notes': 'n',
        }


class TestThePartitionRead:
    def test_an_unconfigured_table_is_named(self):
        with (
            patch('projects_handler.get_aggregates_table', return_value=None),
            pytest.raises(ConfigurationError) as raised,
        ):
            _read_prioritization_partition()
        assert raised.value.message == 'Aggregates table not configured'

    def test_the_query_names_the_partition_key(self):
        table = MagicMock()
        table.query.side_effect = [{'Items': [{'sk': 'ROW#row-1'}]}]
        with patch('projects_handler.get_aggregates_table', return_value=table):
            assert _read_prioritization_partition() == [{'sk': 'ROW#row-1'}]
        table.query.assert_called_once_with(KeyConditionExpression=Key('pk').eq('PRIORITIZATION'))

    def test_a_partition_past_the_page_budget_is_refused_and_logged(self):
        table = MagicMock()
        table.query.side_effect = [
            {'Items': [], 'LastEvaluatedKey': {'sk': f'K#{n}'}} for n in range(20)
        ]
        logger = MagicMock()
        with (
            patch('projects_handler.get_aggregates_table', return_value=table),
            patch('projects_handler.logger', logger),
            pytest.raises(ServiceError) as raised,
        ):
            _read_prioritization_partition()
        assert raised.value.message == 'Too many prioritization ballots to read in one request'
        logger.error.assert_called_once_with(
            'Prioritization ballots exceed %d query pages. Ballots grow as rows '
            'x reviewers in one partition; past this size the partition needs '
            're-keying, not a bigger page budget.',
            20,
        )


class _Slot(str):
    """A row id hashing to `slot`, so a set of them iterates in slot order.

    `_aggregate_scores` walks `set(ballots) | set(legacy)`, whose order is the str
    hash's and changes per process; a row it must SKIP has to come first for a
    `continue -> break` mutant to drop the row after it, every run.
    """

    slot: int

    def __new__(cls, value: str, slot: int) -> '_Slot':
        made = super().__new__(cls, value)
        made.slot = slot
        return made

    def __hash__(self) -> int:
        return self.slot


DEFAULT_ROW = {'is_default': True, 'document_ids': ['prd-1']}


class TestTheLegacyMapLandsOnTheDefaultRow:
    def test_a_non_default_row_before_it_does_not_stop_the_search(self):
        rows = {'row-other': {'is_default': False, 'document_ids': ['prd-1']}, 'row-1': DEFAULT_ROW}
        assert _legacy_scores_by_row({'prd-1': AXES}, rows) == {'row-1': AXES}

    def test_a_document_no_row_holds_does_not_stop_the_later_ones(self):
        legacy = {'a-unheld': {'impact': 1}, 'prd-1': AXES}
        assert _legacy_scores_by_row(legacy, {'row-1': DEFAULT_ROW}) == {'row-1': AXES}


class TestTheAggregate:
    def test_a_row_without_a_vote_does_not_stop_the_rows_after_it(self):
        silent, voted = _Slot('row-silent', 0), _Slot('row-voted', 1)
        aggregates = _aggregate_scores({silent: [{'notes': 'x'}], voted: [{'impact': 4}]}, {})
        assert list(aggregates) == ['row-voted']

    def test_means_and_spread_are_rounded_to_two_places(self):
        fractional = {'impact': 1.111, 'time_to_market': 1.111, 'confidence': 1.111, 'strategic_fit': 1.111}
        zeros = dict.fromkeys(fractional, 0)
        assert _aggregate_scores({'row-1': [fractional, zeros]}, {}) == {'row-1': {
            'impact': 0.56, 'time_to_market': 0.56, 'confidence': 0.56, 'strategic_fit': 0.56,
            'reviewer_count': 2, 'score_spread': 1.11,
        }}


def _conditional_table(error: Exception) -> MagicMock:
    table = MagicMock()
    table.update_item.side_effect = error
    return table


class TestTheLegacyRemovalReportsOnlyTheUnexpected:
    def test_the_already_migrated_condition_is_silent(self):
        logger = MagicMock()
        with patch('projects_handler.logger', logger):
            _drop_legacy_score(_conditional_table(conditional_check_failed('UpdateItem')), 'prd-1')
        assert logger.mock_calls == []

    def test_any_other_client_error_is_a_warning(self):
        error = ClientError({'Error': {'Code': 'ThrottlingException', 'Message': 'slow'}}, 'UpdateItem')
        logger = MagicMock()
        with patch('projects_handler.logger', logger):
            _drop_legacy_score(_conditional_table(error), 'prd-1')
        logger.warning.assert_called_once_with(f'Legacy prioritization score removal failed: {error}')

    def test_anything_else_is_logged_with_its_trace(self):
        logger = MagicMock()
        with patch('projects_handler.logger', logger):
            _drop_legacy_score(_conditional_table(RuntimeError('boom')), 'prd-1')
        logger.exception.assert_called_once_with('Legacy prioritization score removal failed')


class TestTheLegacyMapRead:
    def test_a_failed_read_is_a_warning_and_nothing_held(self):
        table = MagicMock()
        error = RuntimeError('boom')
        table.get_item.side_effect = error
        logger = MagicMock()
        with patch('projects_handler.logger', logger):
            assert _legacy_score_document_ids(table) == set()
        logger.warning.assert_called_once_with(f'Legacy prioritization score read failed: {error}')

    def test_an_empty_document_id_is_not_held(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {'scores': {'': AXES, 'prd-1': AXES}}}
        assert _legacy_score_document_ids(table) == {'prd-1'}


def test_a_row_holds_only_non_empty_document_ids():
    assert _row_document_ids({'document_ids': ['', 'prd-1', 7]}) == ['prd-1']


def _failing_reads() -> tuple[MagicMock, RuntimeError]:
    table = MagicMock()
    error = RuntimeError('throttled')
    table.get_item.side_effect = error
    return table, error


class TestTheRowReadsBeforeAWrite:
    def test_the_read_is_strongly_consistent(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {'row_id': 'row-1'}}
        assert _fetched_row(table, 'row-1') == {'row_id': 'row-1'}
        table.get_item.assert_called_once_with(
            Key={'pk': 'PRIORITIZATION', 'sk': 'ROW#row-1'}, ConsistentRead=True,
        )

    @pytest.mark.parametrize(('read', 'log', 'message'), [
        (lambda table: _fetched_ballot_rows(table, ['row-1']),
         'Failed to read a prioritization row before a save', 'Failed to save prioritization scores'),
        (lambda table: _fetched_row(table, 'row-1'),
         'Failed to read a prioritization row before a delete', 'Failed to delete the prioritization row'),
    ])
    def test_a_failed_read_names_its_route(self, read, log, message):
        table, error = _failing_reads()
        logger = MagicMock()
        with patch('projects_handler.logger', logger), pytest.raises(ServiceError) as raised:
            read(table)
        assert raised.value.message == message
        logger.exception.assert_called_once_with(f'{log}: {error}')


class TestTheFreeze:
    def test_a_ballot_that_is_not_a_record_expressed_nothing(self):
        assert _ballot_expressed_a_value('impact') is False

    def test_a_row_that_is_not_a_record_is_not_frozen(self):
        assert _is_frozen_row('row-1', [{'impact': 3}]) is False

    @pytest.mark.parametrize(('frozen_at', 'frozen'), [('2026-01-01T00:00:00+00:00', True), ('', False)])
    def test_the_mark_alone_decides_a_row_without_ballots(self, frozen_at, frozen):
        assert _is_frozen_row({'first_ballot_at': frozen_at}) is frozen


class TestTheRowPayload:
    def test_a_bare_record_reads_as_empty_fields(self):
        assert _row_payload({}) == {
            'row_id': '', 'project_id': '', 'document_ids': [], 'prototype_id': '',
            'is_default': False, 'created_at': '', 'is_frozen': False,
        }

    def test_the_stored_instant_is_published(self):
        assert _row_payload({'created_at': '2026-01-01'})['created_at'] == '2026-01-01'
