"""Mutation hardening for `api/projects_handler.py` lines 2234-3717 (the prioritization rows).

`test_projects_prioritization_ballots.py`, `test_project_permissions_prioritization.py`
and `test_projects_prioritization_row_lifecycle_moto.py` pin what each row route
does — which row is composed, which write is refused, which ballots go with a
deleted row — but a mutation run over these lines found what they cannot see:

* the WORDING of every refusal and every failure. A `ValidationError`,
  `ConflictError` or `ServiceError` reaches the page verbatim as the `error`
  body, and the earlier tests mostly matched a fragment (`'frozen' in error`), so
  every message is pinned here as a literal, together with the log line beside it.
* the fall-backs of the composition helpers: a document with no `created_at`
  sorts OLDEST (both for the newest scorable document and for the newest
  prototype), an empty `document_id` is skipped rather than chosen, a project
  holding only a PR/FAQ still composes one, and a project with no prototype
  carries `''`.
* the exact DynamoDB arguments the fakes accept wholesale: the recompose's
  attribute names and `updated_at` value, the minted row id's shape, and the
  `success: true` envelope of each route.
* the non-admin recompose of a row that does not exist answers the condition's
  409, never a gate lookup of a project nobody named.
* every route still wrapped by the tracer.
"""
import re
from datetime import UTC, datetime
from typing import ClassVar
from unittest.mock import MagicMock, call, patch

import pytest
from ballots_fixtures import cancelled_transaction
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from test_projects_prioritization_ballots import (
    PARTITION,
    TWO_SCORABLE,
    FakeAggregatesTable,
    FakeProjectsTable,
    _compose_row,
    _create_row,
    _delete_row,
    _get_scores,
    _project_with,
    _recompose_row,
    _rows_call_in_no_group,
    project_document,
)

import projects_handler
from projects_handler import (
    DEFAULT_ROW_ID_PREFIX,
    MAX_PRIORITIZATION_PAGES,
    MAX_PROJECT_DOCUMENT_PAGES,
    MAX_ROW_BALLOTS_PER_DELETE,
    MAX_ROW_DOCUMENT_IDS,
    MAX_ROWS_PER_PROJECT,
    PRIORITIZATION_PK,
    ROW_ID_BYTES,
    _ballot_sk,
    _ballot_transact_items,
    _cancelled_by_condition,
    _default_row_composition,
    _latest_prototype_id,
    _minted_row_id,
    _project_documents,
    _project_row_sort_keys,
    _reviewer_segment,
    _row_ballot_sort_keys,
    _row_holds_a_value_bearing_ballot,
    _scorable_documents,
    _sibling_row_sk,
    _split_prioritization_partition,
    _transact_delete_row,
    _validated_row_document_ids,
)
from shared.exceptions import (
    ConfigurationError,
    ConflictError,
    NotFoundError,
    ServiceError,
    ValidationError,
)
from shared.test.instrumentation_fixtures import assert_tracer_wrapped

FIXED_NOW = datetime(2026, 9, 1, 12, 0, tzinfo=UTC)
P1_PRD1 = {'project_id': 'p1', 'document_ids': ['prd-1']}
RECOMPOSE_MESSAGE = (
    'This row cannot be recomposed: it does not exist, it belongs to another '
    'project, or a ballot has already frozen its composition'
)


def _doc(sk, document_id, created_at=None):
    item = {'sk': sk, 'document_id': document_id}
    if created_at is not None:
        item['created_at'] = created_at
    return item


def _seeded_row1():
    return FakeAggregatesTable().seed_rows('row-1', project_id='p1')


def _compose_p1(aggregates, api_gateway_event, lambda_context, body=None):
    """POST the compose route for p1 (holding `TWO_SCORABLE`) with `body`, default p1 -> [prd-1]."""
    return _compose_row(aggregates, _project_with(*TWO_SCORABLE), api_gateway_event,
                        lambda_context, body=body or P1_PRD1)


def _recompose_row1(aggregates, api_gateway_event, lambda_context, logger=None):
    """PATCH row-1 of p1 onto prd-1 as the admin; `logger` replaces the module's."""
    with patch('projects_handler.logger', logger or MagicMock()):
        return _recompose_row(aggregates, _project_with(*TWO_SCORABLE), api_gateway_event,
                              lambda_context, 'row-1', body=P1_PRD1)


class TestEveryRouteIsTraced:
    @pytest.mark.parametrize('route', [
        'api_compose_prioritization_row',
        'api_recompose_prioritization_row',
        'api_delete_prioritization_row',
        'api_create_prioritization_row',
        'api_get_prioritization_scores',
    ])
    def test_route_is_the_tracer_wrapper(self, route):
        assert_tracer_wrapped(projects_handler, route)


class TestTheProjectRead:
    def test_an_unconfigured_projects_table_is_named(self):
        with (
            patch('projects_handler.get_projects_table', return_value=None),
            pytest.raises(ConfigurationError) as raised,
        ):
            _project_documents('p1')
        assert raised.value.message == 'Projects table not configured'

    def test_a_project_past_the_page_budget_is_refused_and_logged(self):
        table = MagicMock()
        table.query.side_effect = [
            {'Items': [], 'LastEvaluatedKey': {'sk': f'DOC#{n}'}}
            for n in range(MAX_PROJECT_DOCUMENT_PAGES)
        ]
        logger = MagicMock()
        with (
            patch('projects_handler.get_projects_table', return_value=table),
            patch('projects_handler.logger', logger),
            pytest.raises(ConflictError) as raised,
        ):
            _project_documents('p1')
        assert raised.value.message == (
            'This project holds more documents than a prioritization row can be '
            'composed from in one read'
        )
        logger.error.assert_called_once_with(
            'Project %s has more document pages than the %d this composition reads. '
            'A row composed from a short read is frozen and cannot be recomposed, so '
            'this refuses rather than composing from part of the project.',
            'p1',
            MAX_PROJECT_DOCUMENT_PAGES,
        )

    def test_a_missing_project_id_names_the_field(self, api_gateway_event, lambda_context):
        status, body = _compose_p1(FakeAggregatesTable(), api_gateway_event, lambda_context,
                                   body={'document_ids': ['prd-1']})
        assert (status, body['error']) == (400, 'project_id is required')

    def test_documents_without_a_meta_record_are_a_missing_project(
        self, api_gateway_event, lambda_context,
    ):
        projects = FakeProjectsTable([project_document('p1', 'PRD#', 'prd-1', '2026-01-01')])
        aggregates = FakeAggregatesTable()
        status, body = _compose_row(aggregates, projects, api_gateway_event, lambda_context,
                                    body=P1_PRD1)
        assert (status, body['error']) == (404, 'Project p1 not found')
        assert aggregates.put_item_calls == []


class TestTheCompositionHelpers:
    @pytest.mark.parametrize('document_id', ['', 7])
    def test_a_document_without_a_string_id_is_not_scorable(self, document_id):
        assert list(_scorable_documents([_doc('PRD#x', document_id)])) == []

    def test_an_undated_document_loses_to_a_dated_one(self):
        documents = [
            _doc('PRD#prd-dated', 'prd-dated', '2026-01-01T00:00:00+00:00'),
            _doc('PRD#prd-undated', 'prd-undated'),
        ]
        assert _default_row_composition(documents) == (['prd-dated'], '')

    def test_a_project_holding_only_a_prfaq_composes_it(self):
        documents = [_doc('PRFAQ#prfaq-1', 'prfaq-1', '2026-01-01T00:00:00+00:00')]
        assert _default_row_composition(documents) == (['prfaq-1'], '')

    def test_no_prototype_is_an_empty_id(self):
        assert _latest_prototype_id([]) == ''

    def test_an_undated_prototype_loses_to_a_dated_one(self):
        documents = [
            _doc('PROTOTYPE#proto-undated', 'proto-undated'),
            _doc('PROTOTYPE#proto-dated', 'proto-dated', '2026-01-01T00:00:00+00:00'),
        ]
        assert _latest_prototype_id(documents) == 'proto-dated'

    def test_a_newest_prototype_without_an_id_is_skipped(self):
        documents = [
            _doc('PROTOTYPE#blank', '', '2026-02-01T00:00:00+00:00'),
            _doc('PROTOTYPE#proto-1', 'proto-1', '2026-01-01T00:00:00+00:00'),
        ]
        assert _latest_prototype_id(documents) == 'proto-1'

    def test_a_minted_row_id_is_the_prefix_and_hex(self):
        assert re.fullmatch(
            f'{DEFAULT_ROW_ID_PREFIX}[0-9a-f]{{{2 * ROW_ID_BYTES}}}', _minted_row_id(),
        )


class TestEveryDocumentSetRefusalNamesItsRule:
    DOCUMENTS: ClassVar[list[dict]] = [_doc('PRD#prd-1', 'prd-1'), _doc('PROTOTYPE#proto-1', 'proto-1')]

    @pytest.mark.parametrize(('raw', 'error', 'message'), [
        ('prd-1', ValidationError, 'document_ids must be a list of document id strings'),
        ([], ValidationError,
         'document_ids must name at least one document, so the row has something to score'),
        (['prd-1'] * (MAX_ROW_DOCUMENT_IDS + 1), ValidationError,
         f'document_ids must name at most {MAX_ROW_DOCUMENT_IDS} documents'),
        ([' '], ValidationError, 'document_ids must be non-empty document id strings'),
        (['proto-1'], NotFoundError,
         'document_ids name a document this project does not hold, or one that is not '
         'a PRD or a PR/FAQ'),
        (['prd-1', ' prd-1 '], ValidationError, 'document_ids must name distinct documents'),
    ])
    def test_refusal(self, raw, error, message):
        with pytest.raises(error) as raised:
            _validated_row_document_ids(raw, self.DOCUMENTS)
        assert raised.value.message == message


class TestTheComposeRoute:
    def test_an_unconfigured_aggregates_table_is_named(self, api_gateway_event, lambda_context):
        status, body = _compose_p1(None, api_gateway_event, lambda_context)
        assert (status, body['error']) == (500, 'Aggregates table not configured')

    def test_the_row_bound_refusal_names_the_bound(self, api_gateway_event, lambda_context):
        aggregates = FakeAggregatesTable().seed_rows(
            *[f'row-{n}' for n in range(MAX_ROWS_PER_PROJECT)], project_id='p1',
        )
        status, body = _compose_p1(aggregates, api_gateway_event, lambda_context)
        assert (status, body['error']) == (
            409,
            f'This project already holds the {MAX_ROWS_PER_PROJECT} prioritization rows '
            'one project may have; delete a row before composing another',
        )

    def test_a_failed_put_is_logged_and_named(self, api_gateway_event, lambda_context):
        aggregates = FakeAggregatesTable()
        aggregates.put_item = MagicMock(side_effect=RuntimeError('boom'))
        logger = MagicMock()
        with patch('projects_handler.logger', logger):
            status, body = _compose_p1(aggregates, api_gateway_event, lambda_context)
        assert (status, body['error']) == (500, 'Failed to create the prioritization row')
        logger.exception.assert_called_once_with(
            'Failed to compose a prioritization row for p1: boom'
        )

    def test_a_composed_row_answers_success(self, api_gateway_event, lambda_context):
        status, body = _compose_p1(FakeAggregatesTable(), api_gateway_event, lambda_context)
        assert status == 200
        assert body == {'success': True, 'created': True, 'row': body['row']}
        assert body['row']['document_ids'] == ['prd-1']

    def test_the_put_is_conditioned_on_the_key_being_free(self, api_gateway_event, lambda_context):
        aggregates = FakeAggregatesTable()
        _compose_p1(aggregates, api_gateway_event, lambda_context)
        (put_kwargs,) = aggregates.put_item_calls
        assert put_kwargs['ConditionExpression'] == 'attribute_not_exists(sk)'


def _gate_refusing(refused_project_id: str) -> MagicMock:
    """A `_project_access_for` double that 404s `refused_project_id` and admits the rest."""
    def gate(project_id, _caller, _level):
        if project_id == refused_project_id:
            raise NotFoundError(f'gated: {project_id}')

    return MagicMock(side_effect=gate)


class TestTheRecomposeRoute:
    def test_an_unconfigured_aggregates_table_is_named(self, api_gateway_event, lambda_context):
        status, body = _recompose_row(None, _project_with(*TWO_SCORABLE), api_gateway_event,
                                      lambda_context, 'row-1', body=P1_PRD1)
        assert (status, body['error']) == (500, 'Aggregates table not configured')

    def test_a_non_admin_recomposing_a_missing_row_gets_the_conditions_409(
        self, api_gateway_event, lambda_context,
    ):
        status, body = _rows_call_in_no_group(
            FakeAggregatesTable(), api_gateway_event, lambda_context,
            method='PATCH', path='/projects/prioritization/rows/row-missing',
        )
        assert (status, body['error']) == (409, RECOMPOSE_MESSAGE)

    def test_a_non_admin_naming_another_projects_row_is_gated_on_that_project(
        self, api_gateway_event, lambda_context,
    ):
        aggregates = FakeAggregatesTable().seed_rows('row-1', project_id='p2')
        gate = _gate_refusing('p2')
        with patch('projects_handler._project_access_for', gate):
            status, body = _rows_call_in_no_group(
                aggregates, api_gateway_event, lambda_context,
                method='PATCH', path='/projects/prioritization/rows/row-1',
            )
        assert (status, body['error']) == (404, 'gated: p2')
        assert [c.args[0] for c in gate.call_args_list] == ['p1', 'p2']
        assert gate.call_args_list[-1].args[2] == projects_handler.project_access.LEVEL_EDIT
        assert aggregates.update_item_calls == []

    def test_a_non_admin_naming_its_own_projects_row_is_gated_once(
        self, api_gateway_event, lambda_context,
    ):
        gate = MagicMock(return_value=None)
        with patch('projects_handler._project_access_for', gate):
            status, _ = _rows_call_in_no_group(
                _seeded_row1(), api_gateway_event, lambda_context,
                method='PATCH', path='/projects/prioritization/rows/row-1',
            )
        assert status == 200
        assert [c.args[0] for c in gate.call_args_list] == ['p1']

    def test_a_legacy_ballot_refusal_names_the_freeze(self, api_gateway_event, lambda_context):
        aggregates = _seeded_row1()
        aggregates.items[(PARTITION, 'BALLOT#row-1#user:alice')] = {
            'pk': PARTITION, 'sk': 'BALLOT#row-1#user:alice', 'impact': 4,
        }
        status, body = _recompose_row1(aggregates, api_gateway_event, lambda_context)
        assert (status, body['error']) == (
            409, 'This row cannot be recomposed: a ballot has already frozen its composition',
        )
        assert aggregates.update_item_calls == []

    def test_the_write_names_and_stamps_every_attribute(self, api_gateway_event, lambda_context):
        aggregates = _seeded_row1()
        clock = MagicMock()
        clock.now.return_value = FIXED_NOW
        with patch('projects_handler.datetime', clock):
            status, body = _recompose_row1(aggregates, api_gateway_event, lambda_context)
        assert status == 200
        assert body == {'success': True, 'row': body['row']}
        assert body['row']['document_ids'] == ['prd-1']
        (call_kwargs,) = aggregates.update_item_calls
        assert call_kwargs['ExpressionAttributeNames'] == {
            '#document_ids': 'document_ids',
            '#updated_at': 'updated_at',
            '#project_id': 'project_id',
        }
        assert call_kwargs['ExpressionAttributeValues'] == {
            ':document_ids': ['prd-1'],
            ':updated_at': FIXED_NOW.isoformat(),
            ':project_id': 'p1',
        }
        assert aggregates.items[(PARTITION, 'ROW#row-1')]['updated_at'] == FIXED_NOW.isoformat()

    @pytest.mark.parametrize('error', [
        ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'UpdateItem'),
        RuntimeError('boom'),
    ])
    def test_a_failed_write_is_logged_and_named(self, error, api_gateway_event, lambda_context):
        aggregates = _seeded_row1()
        aggregates.update_item = MagicMock(side_effect=error)
        logger = MagicMock()
        status, body = _recompose_row1(aggregates, api_gateway_event, lambda_context, logger)
        assert (status, body['error']) == (500, 'Failed to change the row composition')
        logger.exception.assert_called_once_with(f'Failed to recompose prioritization row: {error}')

    def test_a_write_that_returns_no_item_is_a_failed_read_back(
        self, api_gateway_event, lambda_context,
    ):
        aggregates = _seeded_row1()
        aggregates.update_item = MagicMock(return_value={})
        status, body = _recompose_row1(aggregates, api_gateway_event, lambda_context)
        assert (status, body['error']) == (500, 'Failed to read the recomposed row back')


def _paged_table(*pages):
    """A table whose `query` answers `pages` in order, then raises StopIteration (no infinite loop)."""
    table = MagicMock()
    table.query.side_effect = list(pages)
    return table


def _endless_pages(items=()):
    """MAX_PRIORITIZATION_PAGES pages that each promise one more."""
    return [
        {'Items': list(items), 'LastEvaluatedKey': {'sk': f'K#{n}'}}
        for n in range(MAX_PRIORITIZATION_PAGES)
    ]


class TestTheFreezeReadOfARowsBallots:
    def test_the_query_is_consistent_and_projects_only_the_value_fields(self):
        table = _paged_table({'Items': []})
        assert _row_holds_a_value_bearing_ballot(table, 'row-1') is False
        table.query.assert_called_once_with(
            KeyConditionExpression=(
                Key('pk').eq(PRIORITIZATION_PK) & Key('sk').begins_with('BALLOT#row-1#')
            ),
            ProjectionExpression='#axis_0, #axis_1, #axis_2, #axis_3, #notes',
            ExpressionAttributeNames={
                '#axis_0': 'impact',
                '#axis_1': 'time_to_market',
                '#axis_2': 'confidence',
                '#axis_3': 'strategic_fit',
                '#notes': 'notes',
            },
            ConsistentRead=True,
        )

    def test_the_next_page_starts_after_the_last_key(self):
        table = _paged_table(
            {'Items': [{}], 'LastEvaluatedKey': {'sk': 'BALLOT#row-1#user:a'}},
            {'Items': [{'impact': 3}]},
        )
        assert _row_holds_a_value_bearing_ballot(table, 'row-1') is True
        assert table.query.call_count == 2
        assert table.query.call_args.kwargs['ExclusiveStartKey'] == {'sk': 'BALLOT#row-1#user:a'}

    def test_a_ballot_set_past_the_page_budget_is_refused_and_logged(self):
        table = _paged_table(*_endless_pages([{}]))
        logger = MagicMock()
        with (
            patch('projects_handler.logger', logger),
            pytest.raises(ServiceError) as raised,
        ):
            _row_holds_a_value_bearing_ballot(table, 'row-1')
        assert raised.value.message == (
            'Too many ballots on this row to tell whether its composition is frozen'
        )
        logger.error.assert_called_once_with(
            "A prioritization row's ballots exceed %d query pages, so the recompose "
            'cannot tell whether one of them holds a reviewer value. Proceeding would '
            'recompose a row that may hold real votes.',
            MAX_PRIORITIZATION_PAGES,
        )
        assert table.query.call_count == MAX_PRIORITIZATION_PAGES


def _row_item(sk, project_id='p1'):
    item = {'project_id': project_id}
    if sk is not None:
        item['sk'] = sk
    return item


class TestTheProjectRowCount:
    def test_the_query_is_consistent_and_projects_the_key_and_project(self):
        table = _paged_table({'Items': []})
        assert _project_row_sort_keys(table, 'p1') == []
        table.query.assert_called_once_with(
            KeyConditionExpression=(
                Key('pk').eq(PRIORITIZATION_PK) & Key('sk').begins_with('ROW#')
            ),
            ProjectionExpression='sk, project_id',
            ConsistentRead=True,
        )

    def test_other_projects_rows_and_keyless_rows_are_skipped_not_the_end(self):
        table = _paged_table({'Items': [
            'not-a-dict',
            _row_item('ROW#other', project_id='p2'),
            _row_item(None),
            _row_item('ROW#mine'),
        ]})
        assert _project_row_sort_keys(table, 'p1') == ['ROW#mine']

    def test_the_count_stops_at_exactly_the_limit(self):
        table = _paged_table({'Items': [_row_item('ROW#a'), _row_item('ROW#b'), _row_item('ROW#c')]})
        assert _project_row_sort_keys(table, 'p1', limit=2) == ['ROW#a', 'ROW#b']

    def test_without_a_limit_every_page_is_read(self):
        table = _paged_table(
            {'Items': [_row_item('ROW#a')], 'LastEvaluatedKey': {'sk': 'ROW#a'}},
            {'Items': [_row_item('ROW#b')]},
        )
        assert _project_row_sort_keys(table, 'p1') == ['ROW#a', 'ROW#b']
        assert table.query.call_args.kwargs['ExclusiveStartKey'] == {'sk': 'ROW#a'}

    def test_rows_past_the_page_budget_are_refused_and_logged(self):
        table = _paged_table(*_endless_pages())
        logger = MagicMock()
        with (
            patch('projects_handler.logger', logger),
            pytest.raises(ServiceError) as raised,
        ):
            _project_row_sort_keys(table, 'p1')
        assert raised.value.message == 'Too many prioritization rows to read in one request'
        logger.error.assert_called_once_with(
            "Prioritization rows exceed %d query pages while counting one project's rows.",
            MAX_PRIORITIZATION_PAGES,
        )


class TestTheSiblingRow:
    @pytest.mark.parametrize('project_id', ['', 7, None])
    def test_a_row_without_a_project_has_no_sibling_and_reads_nothing(self, project_id):
        table = MagicMock()
        assert _sibling_row_sk(table, {'project_id': project_id}, 'row-1') is None
        table.query.assert_not_called()

    def test_two_rows_are_enough_to_find_one_other(self):
        sort_keys = MagicMock(return_value=['ROW#row-1', 'ROW#row-2'])
        table = MagicMock()
        with patch('projects_handler._project_row_sort_keys', sort_keys):
            assert _sibling_row_sk(table, {'project_id': 'p1'}, 'row-1') == 'ROW#row-2'
        sort_keys.assert_called_once_with(table, 'p1', limit=2)


class TestTheDeletesBallotEnumeration:
    def test_the_query_is_consistent_and_projects_only_the_key(self):
        table = _paged_table({'Items': []})
        assert _row_ballot_sort_keys(table, 'row-1') == []
        table.query.assert_called_once_with(
            KeyConditionExpression=(
                Key('pk').eq(PRIORITIZATION_PK) & Key('sk').begins_with('BALLOT#row-1#')
            ),
            ProjectionExpression='sk',
            ConsistentRead=True,
        )

    def test_only_dict_items_with_a_key_are_listed_across_pages(self):
        table = _paged_table(
            {'Items': ['not-a-dict', {'sk': ''}, {}], 'LastEvaluatedKey': {'sk': 'K#1'}},
            {'Items': [{'sk': 'BALLOT#row-1#user:a'}]},
        )
        assert _row_ballot_sort_keys(table, 'row-1') == ['BALLOT#row-1#user:a']
        assert table.query.call_args.kwargs['ExclusiveStartKey'] == {'sk': 'K#1'}

    def test_more_ballots_than_one_transaction_holds_are_refused_and_logged(self):
        table = _paged_table({'Items': [
            {'sk': f'BALLOT#row-1#user:{n}'} for n in range(MAX_ROW_BALLOTS_PER_DELETE + 1)
        ]})
        logger = MagicMock()
        with (
            patch('projects_handler.logger', logger),
            pytest.raises(ConflictError) as raised,
        ):
            _row_ballot_sort_keys(table, 'row-1')
        assert raised.value.message == (
            f'This row holds more than the {MAX_ROW_BALLOTS_PER_DELETE} ballots that can be '
            'removed together with it in one atomic write'
        )
        logger.error.assert_called_once_with(
            'A prioritization row holds more than the %d ballots one atomic delete can '
            'remove. Deleting it in several writes would leave orphaned ballots between '
            'them, which is the fault this path exists to prevent.',
            MAX_ROW_BALLOTS_PER_DELETE,
        )

    def test_ballots_past_the_page_budget_are_refused_and_logged(self):
        table = _paged_table(*_endless_pages())
        logger = MagicMock()
        with (
            patch('projects_handler.logger', logger),
            pytest.raises(ServiceError) as raised,
        ):
            _row_ballot_sort_keys(table, 'row-1')
        assert raised.value.message == 'Too many ballots on this row to read in one request'
        logger.error.assert_called_once_with(
            "A prioritization row's ballots exceed %d query pages, so the delete cannot "
            'enumerate them all. Deleting the row on a short read would orphan the '
            'ballots it did not see.',
            MAX_PRIORITIZATION_PAGES,
        )


def _client_error(code):
    return ClientError({'Error': {'Code': code}}, 'TransactWriteItems')


CONDITION_FAILED = {'Code': 'ConditionalCheckFailed'}


class TestACancellationIsReadOffItsReasons:
    def test_no_reason_list_is_not_a_condition(self):
        assert _cancelled_by_condition(_client_error('TransactionCanceledException')) is False

    def test_an_index_past_the_reasons_is_not_a_condition(self):
        assert _cancelled_by_condition(cancelled_transaction([CONDITION_FAILED]), index=1) is False


def _delete_through(error):
    table = MagicMock()
    table.meta.client.transact_write_items.side_effect = error
    logger = MagicMock()
    with patch('projects_handler.logger', logger):
        try:
            _transact_delete_row(table, {}, 'row-1', [], None)
        except (ConflictError, ServiceError) as raised:
            return raised, logger
    raise AssertionError('the delete did not refuse')


class TestAFailedDeleteNamesItsCause:
    @pytest.mark.parametrize('error', [
        _client_error('ProvisionedThroughputExceededException'),
        RuntimeError('boom'),
    ])
    def test_an_infrastructure_failure_is_a_logged_service_error(self, error):
        raised, logger = _delete_through(error)
        assert isinstance(raised, ServiceError)
        assert raised.message == 'Failed to delete the prioritization row'
        logger.exception.assert_called_once_with(f'Failed to delete a prioritization row: {error}')

    def test_a_condition_cancel_is_a_logged_conflict(self):
        raised, logger = _delete_through(cancelled_transaction([CONDITION_FAILED]))
        assert isinstance(raised, ConflictError)
        assert raised.message == (
            'This row changed while it was being deleted; reload the page and try again'
        )
        logger.warning.assert_called_once_with(
            'A prioritization row delete was cancelled; the row changed between reading '
            'its ballots and removing them, or its last sibling row was deleted '
            'concurrently. Nothing was written.'
        )


DEFAULT_ONLY_ROW_MESSAGE = (
    "A project's default row cannot be deleted while it is the project's only row"
)


class TestTheDeleteRoute:
    def test_an_unconfigured_aggregates_table_is_named(self, api_gateway_event, lambda_context):
        status, body = _delete_row(None, api_gateway_event, lambda_context, 'row-1')
        assert (status, body['error']) == (500, 'Aggregates table not configured')

    def test_a_missing_row_is_named(self, api_gateway_event, lambda_context):
        status, body = _delete_row(FakeAggregatesTable(), api_gateway_event, lambda_context, 'row-1')
        assert (status, body['error']) == (404, 'That prioritization row does not exist')

    def test_the_rows_own_project_is_gated(self, api_gateway_event, lambda_context):
        gate = MagicMock(side_effect=NotFoundError('gated'))
        with patch('projects_handler._require_row_project_edit', gate):
            status, body = _delete_row(_seeded_row1(), api_gateway_event, lambda_context, 'row-1')
        assert (status, body['error']) == (404, 'gated')
        gate.assert_called_once_with('p1')

    def test_a_row_without_a_project_is_not_gated(self, api_gateway_event, lambda_context):
        aggregates = _seeded_row1()
        aggregates.items[(PARTITION, 'ROW#row-1')]['project_id'] = ''
        gate = MagicMock()
        with patch('projects_handler._require_row_project_edit', gate):
            status, body = _delete_row(aggregates, api_gateway_event, lambda_context, 'row-1')
        assert (status, body['error']) == (409, DEFAULT_ONLY_ROW_MESSAGE)
        gate.assert_not_called()


def _ballot(row_id, subject, **values):
    return {'pk': PARTITION, 'sk': _ballot_sk(row_id, subject), **values}


class TestASuccessfulDeleteReportsWhatItRemoved:
    def test_the_envelope_and_the_log_line(self, api_gateway_event, lambda_context):
        aggregates = FakeAggregatesTable().seed_rows('row-1', project_id='p1', is_default=False)
        ballot = _ballot('row-1', 'alice', impact=4)
        aggregates.items[(PARTITION, ballot['sk'])] = ballot
        logger = MagicMock()
        status, body = _delete_row(aggregates, api_gateway_event, lambda_context, 'row-1',
                                   logger=logger)
        assert (status, body) == (200, {'success': True, 'row_id': 'row-1', 'ballots_deleted': 1})
        assert logger.info.call_args_list[0] == call(
            'Deleted prioritization row %s (default: %s) with %d ballot(s)', 'row-1', False, 1,
        )


def _create_p1(aggregates, api_gateway_event, lambda_context, projects=None):
    return _create_row(aggregates, projects or _project_with(*TWO_SCORABLE), api_gateway_event,
                       lambda_context, body={'project_id': 'p1'})


class TestTheDefaultRowCreate:
    def test_a_project_with_nothing_scorable_is_named(self, api_gateway_event, lambda_context):
        status, body = _create_p1(FakeAggregatesTable(), api_gateway_event, lambda_context,
                                  projects=_project_with())
        assert (status, body['error']) == (
            400, 'This project has no PRD or PR/FAQ to score, so it has no prioritization row',
        )

    def test_an_unconfigured_aggregates_table_is_named(self, api_gateway_event, lambda_context):
        status, body = _create_p1(None, api_gateway_event, lambda_context)
        assert (status, body['error']) == (500, 'Aggregates table not configured')

    def test_a_new_and_an_existing_row_both_answer_success(self, api_gateway_event, lambda_context):
        aggregates = FakeAggregatesTable()
        first = _create_p1(aggregates, api_gateway_event, lambda_context)
        second = _create_p1(aggregates, api_gateway_event, lambda_context)
        assert [(status, body['success'], body['created']) for status, body in (first, second)] == [
            (200, True, True), (200, True, False),
        ]

    @pytest.mark.parametrize('error', [
        _client_error('ProvisionedThroughputExceededException'),
        RuntimeError('boom'),
    ])
    def test_a_failed_put_is_logged_and_named(self, error, api_gateway_event, lambda_context):
        aggregates = FakeAggregatesTable()
        aggregates.put_item = MagicMock(side_effect=error)
        logger = MagicMock()
        with patch('projects_handler.logger', logger):
            status, body = _create_p1(aggregates, api_gateway_event, lambda_context)
        assert (status, body['error']) == (500, 'Failed to create the prioritization row')
        logger.exception.assert_called_once_with(
            f'Failed to create prioritization row for p1: {error}'
        )

    def test_an_existing_row_that_cannot_be_read_back_is_named(
        self, api_gateway_event, lambda_context,
    ):
        aggregates = FakeAggregatesTable()
        aggregates.put_item = MagicMock(side_effect=_client_error('ConditionalCheckFailedException'))
        aggregates.get_item = MagicMock(return_value={})
        status, body = _create_p1(aggregates, api_gateway_event, lambda_context)
        assert (status, body['error']) == (500, 'Failed to read the prioritization row back')


class TestThePartitionSplit:
    def test_no_legacy_item_is_an_empty_map(self):
        assert _split_prioritization_partition([]) == ({}, {}, [])

    def test_the_legacy_item_and_an_unparsable_key_do_not_end_the_walk(self):
        row = {'sk': 'ROW#row-1'}
        ballot = {'sk': _ballot_sk('row-1', 'alice')}
        legacy_scores, rows_by_id, all_ballots = _split_prioritization_partition([
            {'sk': 'SCORES', 'scores': {'prd-1': {'impact': 2}}},
            {'sk': 'junk'},
            row,
            ballot,
        ])
        assert legacy_scores == {'prd-1': {'impact': 2}}
        assert rows_by_id == {'row-1': row}
        assert all_ballots == [('row-1', _reviewer_segment('alice'), ballot)]


class TestTheScoresRead:
    def test_a_failed_read_is_logged_and_named(self, api_gateway_event, lambda_context):
        logger = MagicMock()
        with patch('projects_handler._read_prioritization_partition',
                   MagicMock(side_effect=RuntimeError('boom'))):
            status, body = _get_scores(FakeAggregatesTable(), api_gateway_event, lambda_context,
                                       logger=logger)
        assert (status, body['error']) == (500, 'Failed to read prioritization scores')
        logger.exception.assert_called_once_with('Failed to read prioritization ballots: boom')

    def test_a_hidden_rows_ballot_does_not_end_the_walk(self, api_gateway_event, lambda_context):
        aggregates = FakeAggregatesTable().seed_rows('row-a', 'row-b')
        for row_id in ('row-a', 'row-b'):
            ballot = _ballot(row_id, 'reviewer-1', impact=4)
            aggregates.items[(PARTITION, ballot['sk'])] = ballot
        with patch('projects_handler._rows_hidden_from_caller', MagicMock(return_value={'row-a'})):
            status, body = _get_scores(aggregates, api_gateway_event, lambda_context)
        assert status == 200
        assert (list(body['rows']), list(body['scores'])) == (['row-b'], ['row-b'])

    def test_ballots_of_a_missing_row_are_counted_in_the_warning(
        self, api_gateway_event, lambda_context,
    ):
        aggregates = FakeAggregatesTable()
        for subject in ('alice', 'bob'):
            ballot = _ballot('row-gone', subject, impact=4)
            aggregates.items[(PARTITION, ballot['sk'])] = ballot
        logger = MagicMock()
        status, _body = _get_scores(aggregates, api_gateway_event, lambda_context, logger=logger)
        assert status == 200
        logger.warning.assert_called_once_with(
            'Discarded %d prioritization ballot(s) across %d row id(s) that no row record '
            'describes; repeats on every read until those items are removed. A stable count '
            'is the expected one-off from ballots written before rows existed. A RISING count '
            'means ballots are being written against rows that do not exist, which is a '
            'defect rather than history.',
            2,
            1,
        )


class TestALegacyScoreFillsEveryRowTheCallerHasNotBalloted:
    def test_a_balloted_row_does_not_end_the_legacy_walk(self, api_gateway_event, lambda_context):
        aggregates = (
            FakeAggregatesTable()
            .seed_rows('row-a', document_ids=['doc-a'])
            .seed_rows('row-b', document_ids=['doc-b'])
        )
        aggregates.items[(PARTITION, 'SCORES')] = {
            'pk': PARTITION, 'sk': 'SCORES',
            'scores': {'doc-a': {'impact': 2}, 'doc-b': {'impact': 3}},
        }
        ballot = _ballot('row-a', 'reviewer-1', impact=5)
        aggregates.items[(PARTITION, ballot['sk'])] = ballot
        status, body = _get_scores(aggregates, api_gateway_event, lambda_context)
        assert status == 200
        assert {row_id: score['impact'] for row_id, score in body['scores'].items()} == {
            'row-a': 5, 'row-b': 3,
        }


class TestTheBallotTransaction:
    def test_a_key_a_transaction_update_refuses_is_logged_and_named(self):
        logger = MagicMock()
        with (
            patch('projects_handler.logger', logger),
            pytest.raises(ServiceError) as raised,
        ):
            _ballot_transact_items(
                MagicMock(), {'ExpressionAttributeNames': {}, 'ReturnValues': 'ALL_NEW'},
                'row-1', 'NOW',
            )
        assert raised.value.message == 'Failed to save prioritization scores'
        logger.error.assert_called_once_with(
            '_ballot_update_kwargs returned %s, which a transaction Update does not accept. '
            'The ballot was not written: DynamoDB would reject the whole transaction for a '
            'key the ballot itself is not about.',
            ['ReturnValues'],
        )

    @pytest.mark.parametrize(('entry', 'names', 'values', 'expression'), [
        (
            {'impact': 5},
            {'#ballot_writes': 'ballot_writes', '#frozen_at': 'first_ballot_at'},
            {':one': 1, ':now': 'NOW'},
            'SET #frozen_at = if_not_exists(#frozen_at, :now) ADD #ballot_writes :one',
        ),
        ({}, {'#ballot_writes': 'ballot_writes'}, {':one': 1}, 'ADD #ballot_writes :one'),
    ])
    def test_the_rows_write_adds_exactly_one_ballot_write(self, entry, names, values, expression):
        table = MagicMock()
        table.name = 'T'
        update_kwargs = projects_handler._ballot_update_kwargs('row-1', 'user:alice', entry, 'NOW')
        _ballot, row_write = _ballot_transact_items(table, update_kwargs, 'row-1', 'NOW')
        assert row_write == {'Update': {
            'TableName': 'T',
            'Key': {'pk': PRIORITIZATION_PK, 'sk': 'ROW#row-1'},
            'ConditionExpression': 'attribute_exists(sk)',
            'ExpressionAttributeNames': names,
            'ExpressionAttributeValues': values,
            'UpdateExpression': expression,
        }}
