"""Mutation hardening for `shared/agents_store.py`, lines 581-1195 (agents, workflows, runs, events, SFN).

`test_agents_store.py` drives the store through moto and proves the run lock, the daily cap and the
revision conflict hold, but a mutation run over the data-access half found what it cannot see:

* the exact WRITE each call sends. moto accepts an `UpdateExpression`, a condition or a key that a
  mutant reworded as long as it still parses, so every update, put and transaction is pinned here as
  the literal call a DynamoDB table receives (keys, expressions, names, values, ReturnValues).
* the WORDING of each failure: every `ServiceError` names the step that failed (`Could not <what>.
  Please retry.` is the API's 503 body), and each NotFound/Conflict message is what an admin reads.
* the swallowed outcomes: a conditional miss on bookkeeping, on the lock release or on a month
  roll-over is not an error, and the log lines they write (ids only) are pinned.
* the client shapes (`agent_view`, `agent_stats`, `workflow_view`, `run_view`, `list_events`) key by key,
  including the defaults a legacy row falls back to.
* the Step Functions plumbing (cached client, derived execution ARNs, the start/stop calls) and the
  day walk `iter_days`, whose bounds no moto test reached.
"""
import importlib.util
import sys
from collections.abc import Mapping
from dataclasses import FrozenInstanceError
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Final, get_type_hints
from unittest.mock import MagicMock, call, patch

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError, EndpointConnectionError

from shared import agents_store as store
from shared import workflow_schema
from shared.exceptions import ConflictError, NotFoundError, ServiceError

NOW: Final = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)
STAMP: Final = '2026-10-04T12:00:00+00:00'
AGENT_ID: Final = 'ag_0123456789ab'
WF_ID: Final = 'wf_0123456789ab'
RUN_ID: Final = 'ar_01a106c90600deadbeef'
TABLE_NAME: Final = 'voc-agents-mutation'
MACHINE: Final = 'arn:aws:states:eu-west-1:111:stateMachine:voc-agent-run'
AGENT_KEY: Final = {'pk': f'AGENT#{AGENT_ID}', 'sk': 'META'}
RUN_KEY: Final = {'pk': f'AGENT#{AGENT_ID}', 'sk': f'RUN#{RUN_ID}'}
CURRENT_KEY: Final = {'pk': f'WORKFLOW#{WF_ID}', 'sk': 'CURRENT'}


def _table() -> MagicMock:
    table = MagicMock()
    table.name = TABLE_NAME
    return table


def _failure(code: str) -> ClientError:
    return ClientError({'Error': {'Code': code, 'Message': 'boom'}}, 'DynamoOperation')


def _condition_failed() -> ClientError:
    return _failure('ConditionalCheckFailedException')


def _cancelled() -> ClientError:
    error = _failure('TransactionCanceledException')
    error.response['CancellationReasons'] = [{'Code': 'ConditionalCheckFailed'}, {'Code': 'None'}]
    return error


def _clause(count: int) -> str:
    return ', '.join(f'#f{i} = :v{i}' for i in range(count))


def _transact(table: MagicMock) -> MagicMock:
    transact: MagicMock = table.meta.client.transact_write_items
    return transact


def _template(name: str = 'My Flow') -> dict[str, Any]:
    definition = workflow_schema.default_template()
    definition['name'] = name
    return definition


def _request(**overrides: Any) -> store.RunStart:
    fields: dict[str, Any] = {'trigger': 'manual', 'requested_by': 'admin-sub', 'workflow_revision': 3,
                              'review_since': '2026-10-01T00:00:00+00:00', **overrides}
    return store.RunStart(**fields)


# Each store call, the table operation it goes through, and the step its ServiceError names.
FAILING_CALLS: Final = [
    (lambda t: store.get_agent(t, AGENT_ID), 'get_item', 'read the agent'),
    (lambda t: store.create_agent(t, {'name': 'n'}, created_by='u', now=NOW), 'put_item', 'create the agent'),
    (lambda t: store.update_agent(t, AGENT_ID, {'enabled': True}, updated_by='u', now=NOW), 'update_item',
     'update the agent'),
    (lambda t: store.set_agent_attributes(t, AGENT_ID, {'x': 1}), 'update_item', 'update agent bookkeeping'),
    (lambda t: store.clear_lock(t, AGENT_ID, RUN_ID), 'update_item', 'release the agent run lock'),
    (lambda t: store.get_workflow(t, WF_ID), 'get_item', 'read the workflow'),
    (store.list_workflows, 'query', 'list workflows'),
    (lambda t: store.list_revisions(t, WF_ID), 'query', 'list workflow revisions'),
    (lambda t: store.create_workflow(t, _template(), created_by='u', username='al', now=NOW),
     'meta.client.transact_write_items', 'create the workflow'),
    (lambda t: store.save_revision(t, WF_ID, _template(), expected_revision=1, saved_by='u', username='al',
                                   now=NOW), 'meta.client.transact_write_items', 'save the workflow'),
    (lambda t: store.archive_workflow(t, WF_ID, archived_by='u', username='al', now=NOW), 'update_item',
     'archive the workflow'),
    (lambda t: store.start_run(t, {'agent_id': AGENT_ID}, _request(), now=NOW),
     'meta.client.transact_write_items', 'start the agent run'),
    (lambda t: store.get_run(t, AGENT_ID, RUN_ID), 'get_item', 'read the run'),
    (lambda t: store.list_runs(t, AGENT_ID, limit=5), 'query', 'list runs'),
    (lambda t: store.attach_execution(t, AGENT_ID, RUN_ID, 'arn'), 'update_item', 'update the run'),
    (lambda t: store.release_lock(t, AGENT_ID, RUN_ID, 'failed'), 'update_item', 'release the agent run lock'),
    (lambda t: store.count_month_calls(t, {'agent_id': AGENT_ID}, 1, now=NOW), 'update_item',
     'count model calls'),
    (lambda t: store.append_event(t, AGENT_ID, RUN_ID, 'message', 's', now=NOW), 'put_item',
     'record the run event'),
    (lambda t: store.list_events(t, RUN_ID, after=0, limit=5), 'query', 'list run events'),
]


class TestEveryFailureNamesItsStep:
    @pytest.mark.parametrize('error', [_failure('ThrottlingException'),
                                       EndpointConnectionError(endpoint_url='https://dynamodb')])
    @pytest.mark.parametrize(('invoke', 'operation', 'what'), FAILING_CALLS)
    def test_a_failed_operation_is_a_retryable_service_error(self, invoke: Any, operation: str, what: str,
                                                              error: Exception) -> None:
        table = _table()
        table.update_item.return_value = {'Attributes': {'event_seq': 1}}
        target = table
        *parents, method = operation.split('.')
        for parent in parents:
            target = getattr(target, parent)
        getattr(target, method).side_effect = error
        logger = MagicMock()
        with patch.object(store, 'logger', logger), \
                pytest.raises(ServiceError, match=f'^Could not {what}\\. Please retry\\.$'):
            invoke(table)
        logger.exception.assert_called_once_with(f'Agents store: {what} failed',
                                                 extra={'error_type': type(error).__name__})


class TestAgentRows:
    def test_get_agent_reads_the_meta_row_consistently(self) -> None:
        table = _table()
        table.get_item.return_value = {'Item': {'agent_id': AGENT_ID}}
        assert store.get_agent(table, AGENT_ID) == {'agent_id': AGENT_ID}
        table.get_item.assert_called_once_with(Key=AGENT_KEY, ConsistentRead=True)

    @pytest.mark.parametrize('response', [{}, {'Item': 'not-a-row'}])
    def test_get_agent_without_a_row_is_none(self, response: dict[str, Any]) -> None:
        table = _table()
        table.get_item.return_value = response
        assert store.get_agent(table, AGENT_ID) is None

    def test_create_agent_writes_the_full_row_once(self) -> None:
        table = _table()
        with patch.object(store, 'new_agent_id', return_value=AGENT_ID):
            item = store.create_agent(table, {'name': 'Crew', 'enabled': True, 'owner_sub': None},
                                      created_by='admin-sub', now=NOW)
        expected = {
            **AGENT_KEY, 'gsi1pk': 'AGENTS', 'gsi1sk': 'Crew', 'agent_id': AGENT_ID, 'name': 'Crew', 'enabled': True,
            'owner_sub': 'admin-sub', 'status': 'active', 'created_by': 'admin-sub', 'created_at': STAMP,
            'updated_by': 'admin-sub', 'updated_at': STAMP, 'last_run_cursor': STAMP, 'runs_total': 0,
        }
        assert item == expected
        table.put_item.assert_called_once_with(Item=expected, ConditionExpression='attribute_not_exists(pk)')

    def test_create_agent_keeps_a_named_owner(self) -> None:
        item = store.create_agent(_table(), {'name': 'n', 'owner_sub': 'owner-1'}, created_by='admin-sub', now=NOW)
        assert item['owner_sub'] == 'owner-1'
        assert item['created_by'] == 'admin-sub'

    def test_set_clause_numbers_names_and_values_in_order(self) -> None:
        assert store._set_clause({'a': 1, 'b': 'x'}) == (
            '#f0 = :v0, #f1 = :v1', {'#f0': 'a', '#f1': 'b'}, {':v0': 1, ':v1': 'x'})

    def test_update_agent_refuses_an_archived_row_and_moves_the_name_index(self) -> None:
        table = _table()
        table.update_item.return_value = {'Attributes': {'agent_id': AGENT_ID}}
        result = store.update_agent(table, AGENT_ID, {'name': 'New', 'enabled': False}, updated_by='u', now=NOW)
        assert result == {'agent_id': AGENT_ID}
        table.update_item.assert_called_once_with(
            Key=AGENT_KEY, UpdateExpression=f'SET {_clause(5)}',
            ConditionExpression='attribute_exists(pk) AND #status <> :archived',
            ExpressionAttributeNames={'#f0': 'name', '#f1': 'enabled', '#f2': 'updated_by', '#f3': 'updated_at',
                                      '#f4': 'gsi1sk', '#status': 'status'},
            ExpressionAttributeValues={':v0': 'New', ':v1': False, ':v2': 'u', ':v3': STAMP, ':v4': 'New',
                                       ':archived': 'archived'},
            ReturnValues='ALL_NEW',
        )

    def test_update_agent_may_touch_an_archived_row(self) -> None:
        table = _table()
        table.update_item.return_value = {'Attributes': {}}
        store.update_agent(table, AGENT_ID, {'status': 'active'}, updated_by='u', now=NOW, allow_archived=True)
        table.update_item.assert_called_once_with(
            Key=AGENT_KEY, UpdateExpression=f'SET {_clause(3)}', ConditionExpression='attribute_exists(pk)',
            ExpressionAttributeNames={'#f0': 'status', '#f1': 'updated_by', '#f2': 'updated_at'},
            ExpressionAttributeValues={':v0': 'active', ':v1': 'u', ':v2': STAMP}, ReturnValues='ALL_NEW',
        )

    def test_update_agent_on_a_missing_row_is_not_found(self) -> None:
        table = _table()
        table.update_item.side_effect = _condition_failed()
        with pytest.raises(NotFoundError, match=r'^Agent not found$'):
            store.update_agent(table, AGENT_ID, {'enabled': True}, updated_by='u', now=NOW)

    def test_bookkeeping_sets_only_the_given_fields(self) -> None:
        table = _table()
        store.set_agent_attributes(table, AGENT_ID, {'last_skip_reason': 'cap', 'trigger_state': {}})
        table.update_item.assert_called_once_with(
            Key=AGENT_KEY, UpdateExpression=f'SET {_clause(2)}', ConditionExpression='attribute_exists(pk)',
            ExpressionAttributeNames={'#f0': 'last_skip_reason', '#f1': 'trigger_state'},
            ExpressionAttributeValues={':v0': 'cap', ':v1': {}})

    def test_clear_lock_removes_only_the_named_run(self) -> None:
        table = _table()
        store.clear_lock(table, AGENT_ID, RUN_ID)
        table.update_item.assert_called_once_with(
            Key=AGENT_KEY, UpdateExpression='REMOVE active_run_id', ConditionExpression='active_run_id = :run',
            ExpressionAttributeValues={':run': RUN_ID})

    @pytest.mark.parametrize('invoke', [
        lambda t: store.set_agent_attributes(t, AGENT_ID, {'x': 1}),
        lambda t: store.clear_lock(t, AGENT_ID, RUN_ID),
    ])
    def test_a_conditional_miss_is_not_an_error(self, invoke: Any) -> None:
        table = _table()
        table.update_item.side_effect = _condition_failed()
        logger = MagicMock()
        with patch.object(store, 'logger', logger):
            assert invoke(table) is None
        logger.exception.assert_not_called()


FULL_STATS_ROW: Final = {
    'runs_total': Decimal('5'), 'runs_completed': 4, 'runs_failed': 3, 'runs_cancelled': 2,
    'runs_needs_human': 1, 'last_run_at': 'at', 'last_run_id': 'rid', 'last_run_status': 'completed',
    'active_run_id': 'act', 'scheduled_day': '2026-10-04', 'scheduled_count': 2, 'month_key': '2026-10',
    'month_calls': Decimal('7'), 'last_skip_reason': 'cap',
}
EMPTY_STATS: Final = {
    'runs_total': 0, 'runs_completed': 0, 'runs_failed': 0, 'runs_cancelled': 0, 'runs_needs_human': 0,
    'last_run_at': None, 'last_run_id': None, 'last_run_status': None, 'active_run_id': None,
    'scheduled_runs_today': 0, 'model_calls_this_month': 0, 'last_skip_reason': None,
}


class TestAgentShapes:
    def test_stats_read_every_counter(self) -> None:
        assert store.agent_stats(FULL_STATS_ROW, NOW) == {
            'runs_total': 5, 'runs_completed': 4, 'runs_failed': 3, 'runs_cancelled': 2, 'runs_needs_human': 1,
            'last_run_at': 'at', 'last_run_id': 'rid', 'last_run_status': 'completed', 'active_run_id': 'act',
            'scheduled_runs_today': 2, 'model_calls_this_month': 7, 'last_skip_reason': 'cap',
        }

    def test_yesterdays_runs_and_last_months_calls_count_zero(self) -> None:
        stats = store.agent_stats({**FULL_STATS_ROW, 'scheduled_day': '2026-10-03', 'month_key': '2026-09'}, NOW)
        assert (stats['scheduled_runs_today'], stats['model_calls_this_month']) == (0, 0)

    def test_the_view_lists_every_editable_field_and_the_stats(self) -> None:
        row = {'agent_id': AGENT_ID, 'name': 'n', 'budget': {'monthly_call_cap': Decimal('3')}, 'created_by': 'c',
               'created_at': 'ca', 'updated_at': 'ua', 'updated_by': 'hidden', 'gsi1pk': 'AGENTS'}
        assert store.agent_view(row, NOW) == {
            'agent_id': AGENT_ID, 'name': 'n', 'description': None, 'enabled': None, 'owner_sub': None,
            'scope': None, 'instructions': None, 'personas': None, 'triggers': None, 'models': None,
            'output': None, 'workflow_id': None, 'budget': {'monthly_call_cap': 3}, 'status': 'active',
            'created_by': 'c', 'created_at': 'ca', 'updated_at': 'ua', 'stats': EMPTY_STATS,
        }

    def test_the_view_keeps_a_stored_status_and_defaults_the_clock(self) -> None:
        row = {'status': 'archived', 'scheduled_day': '2026-10-04', 'scheduled_count': 1}
        with patch.object(store, 'utc_now', return_value=NOW):
            view = store.agent_view(row)
        assert view['status'] == 'archived'
        assert view['stats']['scheduled_runs_today'] == 1


class TestWorkflowRows:
    def test_the_builtin_row(self) -> None:
        template = workflow_schema.default_template()
        assert store.BUILTIN_REVISION == 1
        assert store.builtin_workflow() == {
            'workflow_id': 'wf_default', 'slug': 'reviews-to-prototype', 'name': template['name'],
            'description': template['description'], 'revision': 1,
            'definition': workflow_schema.encode_definition(template), 'builtin': True, 'derived_from': None,
        }

    def test_the_builtin_is_never_read_from_the_table(self) -> None:
        table = _table()
        assert store.get_workflow(table, 'wf_default') == store.builtin_workflow()
        assert store.list_revisions(table, 'wf_default') == [
            {'revision': 1, 'saved_at': None, 'saved_by_username': None}]
        table.get_item.assert_not_called()
        table.query.assert_not_called()

    def test_get_workflow_reads_the_current_row_consistently(self) -> None:
        table = _table()
        table.get_item.return_value = {'Item': {'workflow_id': WF_ID}}
        assert store.get_workflow(table, WF_ID) == {'workflow_id': WF_ID}
        table.get_item.assert_called_once_with(Key=CURRENT_KEY, ConsistentRead=True)

    @pytest.mark.parametrize('response', [{}, {'Item': ['x']}])
    def test_get_workflow_without_a_row_is_none(self, response: dict[str, Any]) -> None:
        table = _table()
        table.get_item.return_value = response
        assert store.get_workflow(table, WF_ID) is None

    def test_the_library_lists_the_builtin_first(self) -> None:
        table = _table()
        table.query.side_effect = [{'Items': [{'workflow_id': WF_ID}]}]
        assert store.list_workflows(table) == [store.builtin_workflow(), {'workflow_id': WF_ID}]
        table.query.assert_called_once_with(IndexName='gsi1-by-agents-listing',
                                            KeyConditionExpression=Key('gsi1pk').eq('WORKFLOWS'))

    def test_revisions_are_newest_first_summaries(self) -> None:
        table = _table()
        table.query.return_value = {'Items': [{'revision': Decimal('2'), 'saved_at': 's', 'saved_by_username': 'a'}]}
        assert store.list_revisions(table, WF_ID) == [{'revision': 2, 'saved_at': 's', 'saved_by_username': 'a'}]
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq(f'WORKFLOW#{WF_ID}') & Key('sk').begins_with('REV#'),
            ScanIndexForward=False, Limit=50, ProjectionExpression='revision, saved_at, saved_by_username')

    def test_no_revisions_is_an_empty_list(self) -> None:
        table = _table()
        table.query.return_value = {}
        assert store.list_revisions(table, WF_ID, limit=3) == []
        assert table.query.call_args.kwargs['Limit'] == 3

    def test_revision_attributes(self) -> None:
        definition = _template()
        assert store._revision_attrs(definition, 4, saved_by='sub', username='al', stamp=STAMP) == {
            'revision': 4, 'definition': workflow_schema.encode_definition(definition), 'name': 'My Flow',
            'saved_at': STAMP, 'saved_by': 'sub', 'saved_by_username': 'al'}

    def test_create_writes_current_and_revision_one_in_one_transaction(self) -> None:
        table = _table()
        definition = {k: v for k, v in _template().items() if k != 'description'}
        revision = {'revision': 1, 'definition': workflow_schema.encode_definition(definition), 'name': 'My Flow',
                    'saved_at': STAMP, 'saved_by': 'sub', 'saved_by_username': 'al'}
        with patch.object(store, 'new_workflow_id', return_value=WF_ID):
            current = store.create_workflow(table, definition, created_by='sub', username='al', now=NOW)
        expected = {
            **CURRENT_KEY, 'gsi1pk': 'WORKFLOWS', 'gsi1sk': f'my flow#{WF_ID}', 'workflow_id': WF_ID,
            'slug': 'my-flow', 'description': '', 'derived_from': None, 'created_at': STAMP, 'created_by': 'sub',
            'updated_at': STAMP, 'updated_by_username': 'al', **revision,
        }
        assert current == expected
        _transact(table).assert_called_once_with(TransactItems=[
            {'Put': {'TableName': TABLE_NAME, 'Item': expected, 'ConditionExpression': 'attribute_not_exists(pk)'}},
            {'Put': {'TableName': TABLE_NAME, 'Item': {'pk': f'WORKFLOW#{WF_ID}', 'sk': 'REV#000001',
                                                       'workflow_id': WF_ID, **revision},
                     'ConditionExpression': 'attribute_not_exists(pk)'}},
        ])

    def test_create_keeps_the_description_and_the_origin(self) -> None:
        current = store.create_workflow(_table(), {**_template(), 'description': 'd'}, created_by='sub',
                                        username='al', now=NOW, derived_from='wf_default')
        assert (current['description'], current['derived_from']) == ('d', 'wf_default')


class TestSaveRevision:
    def test_the_builtin_is_read_only(self) -> None:
        with pytest.raises(ConflictError, match=r'^The built-in workflow is read-only; duplicate it to edit$'):
            store.save_revision(_table(), 'wf_default', _template(), expected_revision=1, saved_by='u',
                                username='al', now=NOW)

    def test_a_save_moves_current_and_appends_the_next_revision(self) -> None:
        table = _table()
        table.get_item.return_value = {'Item': {'workflow_id': WF_ID, 'revision': 3}}
        definition = {**_template('Next One'), 'description': 'd'}
        encoded = workflow_schema.encode_definition(definition)
        saved = store.save_revision(table, WF_ID, definition, expected_revision=2, saved_by='sub', username='al',
                                    now=NOW)
        assert saved == {'workflow_id': WF_ID, 'revision': 3}
        table.get_item.assert_called_once_with(Key=CURRENT_KEY, ConsistentRead=True)
        names = ['revision', 'definition', 'name', 'saved_at', 'saved_by', 'saved_by_username', 'description',
                 'updated_at', 'updated_by_username', 'slug', 'gsi1sk']
        values = [3, encoded, 'Next One', STAMP, 'sub', 'al', 'd', STAMP, 'al', 'next-one', f'next one#{WF_ID}']
        _transact(table).assert_called_once_with(TransactItems=[
            {'Update': {
                'TableName': TABLE_NAME, 'Key': CURRENT_KEY, 'UpdateExpression': f'SET {_clause(11)}',
                'ConditionExpression': ('attribute_exists(pk) AND #rev = :expected '
                                        'AND (attribute_not_exists(#status) OR #status <> :archived)'),
                'ExpressionAttributeNames': {**{f'#f{i}': n for i, n in enumerate(names)}, '#rev': 'revision',
                                             '#status': 'status'},
                'ExpressionAttributeValues': {**{f':v{i}': v for i, v in enumerate(values)}, ':expected': 2,
                                              ':archived': 'archived'},
            }},
            {'Put': {'TableName': TABLE_NAME,
                     'Item': {'pk': f'WORKFLOW#{WF_ID}', 'sk': 'REV#000003', 'workflow_id': WF_ID,
                              'revision': 3, 'definition': encoded, 'name': 'Next One', 'saved_at': STAMP,
                              'saved_by': 'sub', 'saved_by_username': 'al'},
                     'ConditionExpression': 'attribute_not_exists(pk)'}},
        ])

    def test_a_missing_description_saves_empty(self) -> None:
        table = _table()
        table.get_item.return_value = {'Item': {}}
        definition = {k: v for k, v in _template().items() if k != 'description'}
        store.save_revision(table, WF_ID, definition, expected_revision=1, saved_by='u', username='al', now=NOW)
        update = _transact(table).call_args.kwargs['TransactItems'][0]['Update']
        assert update['ExpressionAttributeValues'][':v6'] == ''

    @pytest.mark.parametrize(('current', 'error', 'message'), [
        ({}, NotFoundError, 'Workflow not found'),
        ({'Item': {'workflow_id': WF_ID}}, ConflictError,
         'The workflow was changed by someone else; reload and retry'),
    ])
    def test_a_refused_transaction_is_missing_or_stale(self, current: dict[str, Any], error: type[Exception],
                                                       message: str) -> None:
        table = _table()
        _transact(table).side_effect = _cancelled()
        table.get_item.return_value = current
        with pytest.raises(error, match=f'^{message}$'):
            store.save_revision(table, WF_ID, _template(), expected_revision=1, saved_by='u', username='al',
                                now=NOW)

    def test_a_row_gone_after_the_save_is_not_found(self) -> None:
        table = _table()
        table.get_item.return_value = {}
        with pytest.raises(NotFoundError, match=r'^Workflow not found$'):
            store.save_revision(table, WF_ID, _template(), expected_revision=1, saved_by='u', username='al',
                                now=NOW)


class TestArchiveAndViewWorkflows:
    @pytest.mark.parametrize(('item', 'archived'), [({'status': 'archived'}, True), ({'status': 'active'}, False),
                                                    ({}, False)])
    def test_is_archived(self, item: dict[str, Any], archived: bool) -> None:
        assert store.is_archived_workflow(item) is archived

    def test_the_builtin_cannot_be_archived(self) -> None:
        with pytest.raises(ConflictError, match=r'^The built-in workflow cannot be archived$'):
            store.archive_workflow(_table(), 'wf_default', archived_by='u', username='al', now=NOW)

    def test_archiving_keeps_the_first_archive_stamp(self) -> None:
        table = _table()
        table.update_item.return_value = {'Attributes': {'status': 'archived'}}
        assert store.archive_workflow(table, WF_ID, archived_by='sub', username='al', now=NOW) == {
            'status': 'archived'}
        table.update_item.assert_called_once_with(
            Key=CURRENT_KEY,
            UpdateExpression=('SET #status = :archived, archived_at = if_not_exists(archived_at, :now), '
                              'archived_by = if_not_exists(archived_by, :by), updated_at = :now, '
                              'updated_by_username = :username'),
            ConditionExpression='attribute_exists(pk)', ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':archived': 'archived', ':now': STAMP, ':by': 'sub', ':username': 'al'},
            ReturnValues='ALL_NEW')

    def test_archiving_a_missing_workflow_is_not_found(self) -> None:
        table = _table()
        table.update_item.side_effect = _condition_failed()
        with pytest.raises(NotFoundError, match=r'^Workflow not found$'):
            store.archive_workflow(table, WF_ID, archived_by='u', username='al', now=NOW)

    def test_the_view_of_a_stored_row(self) -> None:
        definition = _template()
        row = {'workflow_id': WF_ID, 'slug': 's', 'name': 'n', 'revision': Decimal('2'), 'derived_from': 'wf_default',
               'created_at': 'ca', 'updated_at': 'ua', 'updated_by_username': 'al', 'status': 'archived',
               'definition': workflow_schema.encode_definition(definition), 'gsi1pk': 'WORKFLOWS'}
        assert store.workflow_view(row) == {
            'workflow_id': WF_ID, 'slug': 's', 'name': 'n', 'description': '', 'revision': 2,
            'derived_from': 'wf_default', 'builtin': False, 'created_at': 'ca', 'updated_at': 'ua',
            'updated_by_username': 'al', 'status': 'archived', 'definition': definition,
        }

    def test_the_summary_view_of_the_builtin(self) -> None:
        view = store.workflow_view(store.builtin_workflow(), include_definition=False)
        assert 'definition' not in view
        assert (view['builtin'], view['status'], view['description']) == (
            True, 'active', workflow_schema.default_template()['description'])


class TestStartRun:
    def test_the_request_defaults_and_is_frozen(self) -> None:
        request = _request()
        assert (request.trigger_detail, request.counts_against_daily_cap, request.daily_cap,
                request.extra_agent_sets) == (None, False, 2, None)
        field = 'trigger'
        with pytest.raises(FrozenInstanceError):
            setattr(request, field, 'x')

    def test_the_request_annotations_resolve(self) -> None:
        hints = get_type_hints(store.RunStart)
        assert hints['trigger_detail'] == Mapping[str, Any] | None
        assert hints['extra_agent_sets'] == Mapping[str, Any] | None

    def test_the_daily_cap_clause_on_the_same_day_and_a_new_day(self) -> None:
        assert store._daily_cap_clause({'scheduled_day': '2026-10-04'}, '2026-10-04', 2) == (
            'scheduled_count = scheduled_count + :one', 'scheduled_day = :today AND scheduled_count < :cap',
            {':today': '2026-10-04', ':cap': 2, ':one': 1})
        assert store._daily_cap_clause({'scheduled_day': '2026-10-03'}, '2026-10-04', 2) == (
            'scheduled_day = :today, scheduled_count = :one',
            '(attribute_not_exists(scheduled_day) OR scheduled_day <> :today)', {':today': '2026-10-04', ':one': 1})

    def test_a_manual_run_takes_the_lock_and_writes_the_run(self) -> None:
        table = _table()
        agent = {'agent_id': AGENT_ID, 'workflow_id': WF_ID}
        request = _request(trigger_detail={'k': 'v'}, extra_agent_sets={'trigger_state': 'x'})
        with patch.object(store, 'new_run_id', return_value=RUN_ID):
            run = store.start_run(table, agent, request, now=NOW)
        expected_run = {
            **RUN_KEY, 'gsi1pk': 'RUNS_ACTIVE', 'gsi1sk': f'{STAMP}#{RUN_ID}', 'run_id': RUN_ID, 'agent_id': AGENT_ID,
            'status': 'queued', 'trigger': 'manual', 'trigger_detail': {'k': 'v'}, 'requested_by': 'admin-sub',
            'started_at': STAMP, 'workflow_id': WF_ID, 'workflow_revision': 3,
            'review_window': {'since': '2026-10-01T00:00:00+00:00', 'until': STAMP}, 'model_calls': 0,
            'event_seq': 0,
        }
        assert run == expected_run
        _transact(table).assert_called_once_with(TransactItems=[
            {'Update': {'TableName': TABLE_NAME, 'Key': AGENT_KEY,
                        'UpdateExpression': f'SET {_clause(6)}, runs_total = if_not_exists(runs_total, :zero) + :inc',
                        'ConditionExpression': ('attribute_exists(pk) AND #status <> :archived '
                                                'AND attribute_not_exists(active_run_id)'),
                        'ExpressionAttributeNames': {
                            '#f0': 'active_run_id', '#f1': 'last_run_at', '#f2': 'last_run_id',
                            '#f3': 'last_run_status', '#f4': 'last_run_cursor', '#f5': 'trigger_state',
                            '#status': 'status'},
                        'ExpressionAttributeValues': {
                            ':v0': RUN_ID, ':v1': STAMP, ':v2': RUN_ID, ':v3': 'queued', ':v4': STAMP, ':v5': 'x',
                            ':archived': 'archived', ':zero': 0, ':inc': 1}}},
            {'Put': {'TableName': TABLE_NAME, 'Item': expected_run, 'ConditionExpression': 'attribute_not_exists(pk)'}},
        ])

    def test_a_scheduled_run_also_counts_against_today(self) -> None:
        table = _table()
        agent = {'agent_id': AGENT_ID, 'scheduled_day': '2026-10-04'}
        with patch.object(store, 'new_run_id', return_value=RUN_ID):
            run = store.start_run(table, agent, _request(counts_against_daily_cap=True), now=NOW)
        assert run is not None
        assert (run['workflow_id'], run['trigger_detail']) == ('wf_default', {})
        update = _transact(table).call_args.kwargs['TransactItems'][0]['Update']
        assert update['UpdateExpression'] == (f'SET {_clause(5)}, runs_total = if_not_exists(runs_total, :zero) + '
                                              ':inc, scheduled_count = scheduled_count + :one')
        assert update['ConditionExpression'] == (
            'attribute_exists(pk) AND #status <> :archived AND attribute_not_exists(active_run_id) '
            'AND scheduled_day = :today AND scheduled_count < :cap')
        assert update['ExpressionAttributeValues'] == {
            ':v0': RUN_ID, ':v1': STAMP, ':v2': RUN_ID, ':v3': 'queued', ':v4': STAMP, ':archived': 'archived',
            ':zero': 0, ':inc': 1, ':today': '2026-10-04', ':cap': 2, ':one': 1}

    @pytest.mark.parametrize(('counts', 'cap', 'starts'), [(True, 0, False), (True, 1, True), (False, 0, True)])
    def test_a_zero_daily_cap_stops_only_scheduled_runs(self, counts: bool, cap: int, starts: bool) -> None:
        table = _table()
        run = store.start_run(table, {'agent_id': AGENT_ID},
                              _request(counts_against_daily_cap=counts, daily_cap=cap), now=NOW)
        assert (run is not None) is starts
        assert _transact(table).call_count == int(starts)

    def test_a_refused_start_is_none_and_logs_the_reasons(self) -> None:
        table = _table()
        _transact(table).side_effect = _cancelled()
        logger = MagicMock()
        with patch.object(store, 'logger', logger):
            assert store.start_run(table, {'agent_id': AGENT_ID}, _request(), now=NOW) is None
        logger.info.assert_called_once_with('Agent run not started', extra={
            'agent_id': AGENT_ID, 'reasons': ['ConditionalCheckFailed', 'None']})
        logger.exception.assert_not_called()


class TestRunRows:
    def test_get_run_reads_consistently(self) -> None:
        table = _table()
        table.get_item.return_value = {'Item': {'run_id': RUN_ID}}
        assert store.get_run(table, AGENT_ID, RUN_ID) == {'run_id': RUN_ID}
        table.get_item.assert_called_once_with(Key=RUN_KEY, ConsistentRead=True)

    @pytest.mark.parametrize('response', [{}, {'Item': 3}])
    def test_get_run_without_a_row_is_none(self, response: dict[str, Any]) -> None:
        table = _table()
        table.get_item.return_value = response
        assert store.get_run(table, AGENT_ID, RUN_ID) is None

    def test_list_runs_newest_first_with_the_next_cursor(self) -> None:
        table = _table()
        last = {'pk': f'AGENT#{AGENT_ID}', 'sk': f'RUN#{RUN_ID}'}
        table.query.return_value = {'Items': [{'run_id': RUN_ID}], 'LastEvaluatedKey': last}
        assert store.list_runs(table, AGENT_ID, limit=5) == ([{'run_id': RUN_ID}], store.encode_cursor(last))
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq(f'AGENT#{AGENT_ID}') & Key('sk').begins_with('RUN#'),
            ScanIndexForward=False, Limit=5)

    def test_list_runs_resumes_from_a_cursor(self) -> None:
        table = _table()
        start = {'pk': f'AGENT#{AGENT_ID}', 'sk': 'RUN#ar_1'}
        table.query.return_value = {}
        assert store.list_runs(table, AGENT_ID, limit=2, cursor=store.encode_cursor(start)) == ([], None)
        assert table.query.call_args.kwargs['ExclusiveStartKey'] == start

    def test_the_run_view(self) -> None:
        row = {'run_id': RUN_ID, 'model_calls': Decimal('4'), 'execution_arn': 'hidden', 'pk': 'p'}
        assert store.run_view(row) == {
            'run_id': RUN_ID, 'agent_id': None, 'status': None, 'trigger': None, 'trigger_detail': None,
            'started_at': None, 'finished_at': None, 'project_id': None, 'current_node_id': None,
            'model_calls': 4, 'error': None, 'workflow_id': None, 'workflow_revision': None, 'review_window': None,
        }

    def test_a_run_update_sends_names_only_when_there_are_some(self) -> None:
        table = _table()
        table.update_item.return_value = {'Attributes': {'run_id': RUN_ID}}
        assert store._run_update(table, AGENT_ID, RUN_ID, 'SET #a = :b', {'#a': 'a'}, {':b': 1}, 'c') == {
            'run_id': RUN_ID}
        table.update_item.assert_called_once_with(
            Key=RUN_KEY, UpdateExpression='SET #a = :b', ConditionExpression='c', ExpressionAttributeValues={':b': 1},
            ReturnValues='ALL_NEW', ExpressionAttributeNames={'#a': 'a'})

    def test_attach_execution(self) -> None:
        table = _table()
        store.attach_execution(table, AGENT_ID, RUN_ID, 'arn:x')
        table.update_item.assert_called_once_with(
            Key=RUN_KEY, UpdateExpression='SET execution_arn = :arn', ConditionExpression='attribute_exists(pk)',
            ExpressionAttributeValues={':arn': 'arn:x'}, ReturnValues='ALL_NEW')

    def test_a_refused_run_update_is_none(self) -> None:
        table = _table()
        table.update_item.side_effect = _condition_failed()
        assert store._run_update(table, AGENT_ID, RUN_ID, 'u', {}, {}, 'c') is None


def _finish_call(values: dict[str, Any]) -> Any:
    clause = _clause(len(values))
    names = dict(zip([f'#f{i}' for i in range(len(values))], ['status', 'finished_at', 'error'], strict=False))
    return call(Key=RUN_KEY, UpdateExpression=f'SET {clause} REMOVE gsi1pk, gsi1sk',
                ConditionExpression='attribute_exists(pk) AND #st IN (:queued, :running)',
                ExpressionAttributeValues={**values, ':queued': 'queued', ':running': 'running'},
                ReturnValues='ALL_NEW', ExpressionAttributeNames={**names, '#st': 'status'})


class TestFinishRun:
    @pytest.mark.parametrize('status', ['queued', 'running', 'done'])
    def test_only_a_terminal_status_finishes(self, status: str) -> None:
        with pytest.raises(ValueError, match=f'^not a terminal run status: {status}$'):
            store.finish_run(_table(), AGENT_ID, RUN_ID, status, now=NOW)

    @pytest.mark.parametrize('status', ['needs_human', 'completed', 'failed', 'cancelled'])
    def test_finishing_ends_the_run_then_frees_the_lock(self, status: str) -> None:
        table = _table()
        table.update_item.return_value = {'Attributes': {'run_id': RUN_ID}}
        assert store.finish_run(table, AGENT_ID, RUN_ID, status, now=NOW) == {'run_id': RUN_ID}
        assert table.update_item.call_args_list == [
            _finish_call({':v0': status, ':v1': STAMP}),
            call(Key=AGENT_KEY,
                 UpdateExpression='REMOVE active_run_id SET last_run_status = :s, #c = if_not_exists(#c, :zero) + :one',
                 ConditionExpression='active_run_id = :run', ExpressionAttributeNames={'#c': f'runs_{status}'},
                 ExpressionAttributeValues={':s': status, ':run': RUN_ID, ':zero': 0, ':one': 1}),
        ]

    def test_the_error_is_kept_to_500_characters(self) -> None:
        table = _table()
        table.update_item.return_value = {'Attributes': {}}
        store.finish_run(table, AGENT_ID, RUN_ID, 'failed', now=NOW, error='e' * 501)
        assert table.update_item.call_args_list[0] == _finish_call({':v0': 'failed', ':v1': STAMP, ':v2': 'e' * 500})

    def test_an_empty_error_is_not_written(self) -> None:
        table = _table()
        table.update_item.return_value = {'Attributes': {}}
        store.finish_run(table, AGENT_ID, RUN_ID, 'failed', now=NOW, error='')
        assert table.update_item.call_args_list[0] == _finish_call({':v0': 'failed', ':v1': STAMP})

    def test_an_already_terminal_run_keeps_the_lock_alone(self) -> None:
        table = _table()
        table.update_item.side_effect = [_condition_failed()]
        assert store.finish_run(table, AGENT_ID, RUN_ID, 'completed', now=NOW) is None
        assert table.update_item.call_count == 1

    def test_a_lock_held_by_another_run_is_logged_not_raised(self) -> None:
        table = _table()
        table.update_item.side_effect = _condition_failed()
        logger = MagicMock()
        with patch.object(store, 'logger', logger):
            store.release_lock(table, AGENT_ID, RUN_ID, 'failed')
        logger.info.assert_called_once_with('Agent lock already held by another run',
                                            extra={'agent_id': AGENT_ID, 'run_id': RUN_ID})
        logger.exception.assert_not_called()


class TestMonthCalls:
    def test_the_same_month_adds(self) -> None:
        table = _table()
        store.count_month_calls(table, {'agent_id': AGENT_ID, 'month_key': '2026-10'}, 3, now=NOW)
        table.update_item.assert_called_once_with(Key=AGENT_KEY, UpdateExpression='ADD month_calls :n',
                                                  ConditionExpression='month_key = :m',
                                                  ExpressionAttributeValues={':n': 3, ':m': '2026-10'})

    def test_a_new_month_resets(self) -> None:
        table = _table()
        store.count_month_calls(table, {'agent_id': AGENT_ID, 'month_key': '2026-09'}, 3, now=NOW)
        table.update_item.assert_called_once_with(
            Key=AGENT_KEY, UpdateExpression='SET month_key = :m, month_calls = :n',
            ConditionExpression='(attribute_not_exists(month_key) OR month_key <> :m)',
            ExpressionAttributeValues={':n': 3, ':m': '2026-10'})

    def test_a_month_rolled_by_another_writer_adds(self) -> None:
        table = _table()
        table.update_item.side_effect = [_condition_failed(), {}]
        logger = MagicMock()
        with patch.object(store, 'logger', logger):
            store.count_month_calls(table, {'agent_id': AGENT_ID}, 2, now=NOW)
        assert table.update_item.call_args_list[1] == call(
            Key=AGENT_KEY, UpdateExpression='ADD month_calls :n', ConditionExpression='month_key = :m',
            ExpressionAttributeValues={':n': 2, ':m': '2026-10'})
        logger.warning.assert_not_called()
        logger.exception.assert_not_called()

    @pytest.mark.parametrize('retry_error', [_condition_failed(), EndpointConnectionError(endpoint_url='https://d')])
    def test_a_failed_retry_is_only_logged(self, retry_error: Exception) -> None:
        table = _table()
        table.update_item.side_effect = [_condition_failed(), retry_error]
        logger = MagicMock()
        with patch.object(store, 'logger', logger):
            store.count_month_calls(table, {'agent_id': AGENT_ID}, 2, now=NOW)
        logger.warning.assert_called_once_with('Model calls not counted against the month',
                                               extra={'agent_id': AGENT_ID})


class TestRunEvents:
    def test_an_event_takes_the_next_sequence_number(self) -> None:
        table = _table()
        table.update_item.return_value = {'Attributes': {'event_seq': Decimal('7')}}
        item = store.append_event(table, AGENT_ID, RUN_ID, 'message', 'hello', now=NOW, node_id='n1',
                                  role='worker', ref={'project_id': 'p1'})
        expected = {'pk': f'RUN#{RUN_ID}', 'sk': 'EVT#00000007', 'run_id': RUN_ID, 'seq': 7, 'at': STAMP,
                    'kind': 'message', 'summary': 'hello', 'node_id': 'n1', 'role': 'worker',
                    'ref': {'project_id': 'p1'}}
        assert item == expected
        table.update_item.assert_called_once_with(
            Key=RUN_KEY, UpdateExpression='ADD event_seq :one', ConditionExpression='attribute_exists(pk)',
            ExpressionAttributeValues={':one': 1}, ReturnValues='ALL_NEW')
        table.put_item.assert_called_once_with(Item=expected)

    def test_an_event_on_a_missing_run_is_not_found(self) -> None:
        table = _table()
        table.update_item.side_effect = _condition_failed()
        with pytest.raises(NotFoundError, match=r'^Run not found$'):
            store.append_event(table, AGENT_ID, RUN_ID, 'message', 's', now=NOW)
        table.put_item.assert_not_called()

    @pytest.mark.parametrize(('kind', 'role', 'message'), [
        ('gossip', None, 'unknown run event kind: gossip'),
        ('message', 'janitor', 'unknown run event role: janitor'),
    ])
    def test_an_unknown_kind_or_role_is_refused_before_any_write(self, kind: str, role: str | None,
                                                                  message: str) -> None:
        table = _table()
        with pytest.raises(ValueError, match=f'^{message}$'):
            store.append_event(table, AGENT_ID, RUN_ID, kind, 's', now=NOW, role=role)
        table.update_item.assert_not_called()

    def test_the_fields_drop_what_is_empty_and_cap_the_summary(self) -> None:
        assert store._event_fields('verdict', 'x' * 2001, '', None, None) == {'kind': 'verdict', 'summary': 'x' * 2000}
        assert store._event_fields('verdict', 's', None, None, {'bogus': 'x', 'job_id': ''}) == {
            'kind': 'verdict', 'summary': 's'}

    def test_the_ref_keeps_known_non_empty_strings(self) -> None:
        ref = {'project_id': 'p', 'document_id': '', 'persona_id': 5, 'job_id': 'j', 'bogus': 'x'}
        assert store._event_fields('artifact', 's', 'n', 'system', ref) == {
            'kind': 'artifact', 'summary': 's', 'node_id': 'n', 'role': 'system',
            'ref': {'project_id': 'p', 'job_id': 'j'}}

    def test_list_events_after_a_sequence_number(self) -> None:
        table = _table()
        table.query.return_value = {'Items': [{
            'pk': 'p', 'sk': 's', 'run_id': RUN_ID, 'seq': Decimal('4'), 'at': 'at', 'kind': 'k', 'node_id': 'n',
            'role': 'r', 'summary': 'sum', 'ref': {'job_id': 'j'}}]}
        assert store.list_events(table, RUN_ID, after=3, limit=10) == [
            {'seq': 4, 'at': 'at', 'kind': 'k', 'node_id': 'n', 'role': 'r', 'summary': 'sum', 'ref': {'job_id': 'j'}}]
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq(f'RUN#{RUN_ID}') & Key('sk').between('EVT#00000004', 'EVT#99999999'),
            Limit=10)

    def test_no_events_is_an_empty_list(self) -> None:
        table = _table()
        table.query.return_value = {}
        assert store.list_events(table, RUN_ID, after=0, limit=1) == []


class TestStepFunctions:
    def test_the_client_is_built_once(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(store, '_sfn_client', None)
        client = MagicMock()
        with patch.object(store.boto3, 'client', client):
            first = store._stepfunctions()
            assert store._stepfunctions() is first
        client.assert_called_once_with('stepfunctions')
        assert first is client.return_value

    def test_a_fresh_module_builds_its_client_on_first_use(self, monkeypatch: pytest.MonkeyPatch) -> None:
        spec = importlib.util.spec_from_file_location('agents_store_fresh', store.__file__)
        assert spec is not None
        assert spec.loader is not None
        fresh = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, spec.name, fresh)  # @dataclass resolves its module there
        spec.loader.exec_module(fresh)
        client = MagicMock()
        with patch.object(fresh.boto3, 'client', client):
            assert fresh._stepfunctions() is client.return_value

    def test_the_state_machine_comes_from_the_environment(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv('AGENT_RUN_STATE_MACHINE_ARN', MACHINE)
        assert store.state_machine_arn() == MACHINE
        monkeypatch.delenv('AGENT_RUN_STATE_MACHINE_ARN')
        assert store.state_machine_arn() == ''

    @pytest.mark.parametrize(('run', 'machine', 'arn'), [
        ({'run_id': RUN_ID, 'execution_arn': ''}, MACHINE, f'arn:aws:states:eu-west-1:111:execution:voc-agent-run:{RUN_ID}'),
        ({'run_id': RUN_ID, 'execution_arn': 5}, MACHINE, f'arn:aws:states:eu-west-1:111:execution:voc-agent-run:{RUN_ID}'),
        ({'run_id': RUN_ID}, 'arn:x:stateMachine:a:stateMachine:b', f'arn:x:execution:a:stateMachine:b:{RUN_ID}'),
        ({'run_id': RUN_ID}, 'arn:aws:states:eu-west-1:111:activity:x', ''),
        ({'run_id': 'ar_short'}, MACHINE, ''),
    ])
    def test_a_missing_execution_arn_is_derived(self, run: dict[str, Any], machine: str, arn: str,
                                                monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv('AGENT_RUN_STATE_MACHINE_ARN', machine)
        assert store.execution_arn_for(run) == arn

    def test_start_execution_is_named_after_the_run(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv('AGENT_RUN_STATE_MACHINE_ARN', MACHINE)
        sfn = MagicMock()
        sfn.start_execution.return_value = {'executionArn': 'arn:exec'}
        with patch.object(store, '_stepfunctions', return_value=sfn):
            assert store.start_execution({'run_id': RUN_ID, 'agent_id': AGENT_ID, 'x': 1}) == 'arn:exec'
        sfn.start_execution.assert_called_once_with(
            stateMachineArn=MACHINE, name=RUN_ID, input=f'{{"run_id": "{RUN_ID}", "agent_id": "{AGENT_ID}"}}')

    def test_stop_execution_names_the_cause(self) -> None:
        sfn = MagicMock()
        with patch.object(store, '_stepfunctions', return_value=sfn):
            store.stop_execution('arn:exec')
        sfn.stop_execution.assert_called_once_with(executionArn='arn:exec', cause='Cancelled by an admin')

    def test_a_failed_stop_is_only_logged(self) -> None:
        sfn = MagicMock()
        sfn.stop_execution.side_effect = _failure('ExecutionDoesNotExist')
        logger = MagicMock()
        with patch.object(store, '_stepfunctions', return_value=sfn), patch.object(store, 'logger', logger):
            store.stop_execution('arn:exec')
        logger.warning.assert_called_once_with('Could not stop the agent run execution')


LAUNCHED: Final = {'run_id': RUN_ID, 'agent_id': AGENT_ID, 'trigger': 'schedule'}


class TestLaunchRun:
    def test_a_launch_attaches_the_arn_and_journals_the_queueing(self) -> None:
        table = _table()
        table.update_item.return_value = {'Attributes': {'event_seq': 1}}
        sfn = MagicMock()
        sfn.start_execution.return_value = {'executionArn': 'arn:exec'}
        with patch.object(store, '_stepfunctions', return_value=sfn):
            assert store.launch_run(table, LAUNCHED, now=NOW) == {**LAUNCHED, 'execution_arn': 'arn:exec'}
        assert table.update_item.call_args_list[0].kwargs['ExpressionAttributeValues'] == {':arn': 'arn:exec'}
        table.put_item.assert_called_once_with(Item={
            'pk': f'RUN#{RUN_ID}', 'sk': 'EVT#00000001', 'run_id': RUN_ID, 'seq': 1, 'at': STAMP, 'kind': 'decision',
            'summary': 'Run queued (schedule)', 'role': 'system'})

    @pytest.mark.parametrize('error', [_failure('ExecutionLimitExceeded'), EndpointConnectionError(endpoint_url='x')])
    def test_a_failed_start_fails_the_run(self, error: Exception) -> None:
        table = _table()
        table.update_item.return_value = {'Attributes': {}}
        sfn = MagicMock()
        sfn.start_execution.side_effect = error
        logger = MagicMock()
        with patch.object(store, '_stepfunctions', return_value=sfn), patch.object(store, 'logger', logger), \
                pytest.raises(ServiceError, match=r'^Could not start the agent run\. Please retry\.$'):
            store.launch_run(table, LAUNCHED, now=NOW)
        logger.exception.assert_called_once_with('Agent run execution failed to start', extra={'run_id': RUN_ID})
        assert table.update_item.call_args_list[0] == _finish_call(
            {':v0': 'failed', ':v1': STAMP, ':v2': 'The run could not be started'})
        table.put_item.assert_not_called()


class TestIterDays:
    @pytest.mark.parametrize(('first', 'last', 'days'), [
        ('2026-10-30', '2026-11-02', ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']),
        ('2026-10-04', '2026-10-04', ['2026-10-04']),
        ('2026-10-05', '2026-10-04', []),
    ])
    def test_every_day_inclusive(self, first: str, last: str, days: list[str]) -> None:
        assert list(store.iter_days(first, last)) == days
