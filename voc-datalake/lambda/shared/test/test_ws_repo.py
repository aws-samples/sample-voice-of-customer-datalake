"""shared/ws_repo.py: the workspace-scoped repository layer (docs/multi-workspace.md, "Request flow", step 4)."""
import re
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from moto import mock_aws

from shared import feedback_partitions as partitions
from shared.batch_get import BATCH_GET_ATTEMPTS
from shared.test.moto_tables import create_pk_sk_table
from shared.workspace import WorkspaceContext
from shared.ws_repo import (
    MAX_TRANSACT_ITEMS,
    PARTITION_ATTRIBUTES,
    WATERMARK_PARTITION,
    OutOfScopeError,
    UnprocessedKeysError,
    WorkspaceScope,
    category_pk,
    channel_pk,
    date_pk,
    feedback_id_pk,
    feedback_key,
    is_workspace_key,
    message_scope,
    metric_pk,
    metric_type,
    partition_scope,
    plugin_config_history_key,
    plugin_config_history_pk,
    plugin_config_key,
    plugin_config_pk,
    s3_key,
    s3_prefix,
    scope_from_key,
    scope_from_message,
    scope_of,
    scraper_run_pk,
    source_run_pk,
    urgency_pk,
    watermark_key,
    ws_table,
)

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER_WS = 'ws_7ZZZZZZZZZZZZZZZZZZZZZZZZZ'
A = WorkspaceScope(WS)
B = WorkspaceScope(OTHER_WS)


class TestScope:
    @pytest.mark.parametrize('value', ['', 'ws_', 'WS_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', 'ws_81JC3Q8ZK6V7W9X2Y4A5B6C7D8',
                                       'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8#', 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DI'])
    def test_refuses_an_id_that_is_not_a_workspace_id(self, value):
        with pytest.raises(ValueError, match='not a workspace id'):
            WorkspaceScope(value)

    def test_of_a_resolved_request(self):
        context = WorkspaceContext(ws=WS, role='viewer', name='Acme', slug='acme', platform_admin=False)
        assert scope_of(context) == A

    def test_from_a_message(self):
        assert scope_from_message({'workspace_id': WS, 'id': 'r1'}) == A

    @pytest.mark.parametrize('body', [{}, {'workspace_id': None}, {'workspace_id': 7}, {'workspace_id': 'acme'}])
    def test_a_message_without_a_workspace_is_refused(self, body):
        with pytest.raises(ValueError, match=r'names no workspace|not a workspace id'):
            scope_from_message(body)

    def test_from_a_stored_key(self):
        assert scope_from_key(f'WS#{WS}#SOURCE#webscraper') == A
        assert scope_from_key(f'WS#{OTHER_WS}#METRIC#daily_total') == B

    @pytest.mark.parametrize('key', [None, 'SOURCE#webscraper', f'WS#{WS}', f'WS#{WS}#', 'WS#acme#SOURCE#x',
                                     f'AUDIT#WS#{WS}#x'])
    def test_a_key_outside_every_workspace_has_no_scope(self, key):
        with pytest.raises(ValueError, match='not a workspace'):
            scope_from_key(key)

    def test_the_partition_scope_of_either_kind_of_row(self):
        assert partition_scope(f'WS#{WS}#SOURCE#webscraper') == A
        assert partition_scope('SOURCE#webscraper') is None
        assert partition_scope(f'AUDIT#WS#{WS}') is None
        assert partition_scope(None) is None

    @pytest.mark.parametrize('key', [f'WS#{WS}', 'WS#acme#SOURCE#x', 'WS#'])
    def test_a_ws_key_that_names_no_workspace_is_never_read_as_deployment_wide(self, key):
        with pytest.raises(ValueError, match='not a workspace'):
            partition_scope(key)

    def test_owns_only_its_own_partitions(self):
        assert A.owns(f'WS#{WS}#SOURCE#x')
        assert not A.owns(f'WS#{OTHER_WS}#SOURCE#x')
        assert not A.owns(f'WS#{WS}#')
        assert not A.owns('SOURCE#x')
        assert not A.owns(None)

    def test_a_key_refuses_empty_parts(self):
        with pytest.raises(ValueError, match='non-empty parts'):
            A.key()
        with pytest.raises(ValueError, match='non-empty parts'):
            A.key('SOURCE', '')


class TestKeys:
    def test_feedback_item(self):
        assert feedback_key(A, 'webscraper', 'abc') == {'pk': f'WS#{WS}#SOURCE#webscraper', 'sk': 'FEEDBACK#abc'}
        with pytest.raises(ValueError, match='needs an id'):
            feedback_key(A, 'webscraper', '')

    def test_index_partitions(self):
        assert date_pk(A, '2026-01-15') == f'WS#{WS}#DATE#2026-01-15'
        assert category_pk(A, 'pricing') == f'WS#{WS}#CATEGORY#pricing'
        assert urgency_pk(A, 'high') == f'WS#{WS}#URGENCY#high'
        assert feedback_id_pk(A, 'abc') == f'WS#{WS}#FEEDBACK#abc'
        assert channel_pk(A, 'email') == f'WS#{WS}#CHANNEL#email'

    def test_aggregates_and_runs(self):
        assert metric_pk(A, 'daily_total') == f'WS#{WS}#METRIC#daily_total'
        assert metric_pk(A, 'daily_category', 'pricing') == f'WS#{WS}#METRIC#daily_category#pricing'
        assert metric_type(A, 'source') == f'WS#{WS}#source'
        assert source_run_pk(A, 'webscraper') == f'WS#{WS}#SOURCE_RUN#webscraper'
        assert scraper_run_pk(A, 'shop') == f'WS#{WS}#SCRAPER_RUN#shop'
        assert watermark_key(A, 'webscraper', 'last_id') == f'WS#{WS}#webscraper#last_id'

    def test_plugin_config_rows_and_their_history(self):
        assert plugin_config_key(A, 'webscraper') == {'pk': f'WS#{WS}#PLUGIN_CONFIG', 'sk': 'webscraper'}
        assert plugin_config_history_pk(A) == f'WS#{WS}#PLUGIN_CONFIG#HISTORY'
        assert plugin_config_history_key(A, 'webscraper', '2026-11-13T10:00:00+00:00', 'ab12') == {
            'pk': f'WS#{WS}#PLUGIN_CONFIG#HISTORY', 'sk': 'webscraper#2026-11-13T10:00:00+00:00#ab12'}
        # Its own partition: a read of the lists (one Query of WS#{ws}#PLUGIN_CONFIG) never sees the history.
        assert plugin_config_history_pk(A) != plugin_config_pk(A)
        assert plugin_config_history_pk(A) != plugin_config_history_pk(B)
        for parts in (('', 't', 'x'), ('webscraper', '', 'x'), ('webscraper', 't', '')):
            with pytest.raises(ValueError, match='history key needs'):
                plugin_config_history_key(A, *parts)

    def test_the_same_names_in_two_workspaces_never_meet(self):
        assert feedback_key(A, 's', 'x') != feedback_key(B, 's', 'x')
        assert metric_pk(A, 'daily_total') != metric_pk(B, 'daily_total')

    def test_object_keys(self):
        assert s3_key(A, 'raw', 'webscraper/2026/01/15/x/0123.json') == f'ws/{WS}/raw/webscraper/2026/01/15/x/0123.json'
        assert s3_key(A, 'silver/s/f/1.json').startswith(f'ws/{WS}/silver/')

    def test_the_object_prefix_starts_every_object_key_of_its_workspace_only(self):
        assert s3_prefix(A) == f'ws/{WS}/'
        assert s3_key(A, 'reviews/june.csv').startswith(s3_prefix(A))
        assert not s3_key(B, 'reviews/june.csv').startswith(s3_prefix(A))
        # A workspace id is fixed-length, so no other id is a prefix of it (the trailing '/' closes it anyway).
        assert not f'ws/{WS}0/x'.startswith(s3_prefix(A))

    @pytest.mark.parametrize('parts', [(), ('',), ('raw', '../ws_7ZZZZZZZZZZZZZZZZZZZZZZZZZ'), ('raw//x',), ('.',)])
    def test_an_object_key_cannot_leave_the_workspace(self, parts):
        with pytest.raises(ValueError, match='non-empty segments'):
            s3_key(A, *parts)


def _scan_every_page(repo, **kwargs) -> tuple[list[str], list[dict]]:
    """Every page of ``repo.scan(**kwargs)``: the sort keys answered, and each page's ``LastEvaluatedKey``."""
    found: list[str] = []
    cursors: list[dict] = []
    while True:
        page = repo.scan(**kwargs, **({'ExclusiveStartKey': cursors[-1]} if cursors else {}))
        found += [str(row['sk']) for row in page['Items']]
        cursor = page.get('LastEvaluatedKey')
        if not cursor:
            return found, cursors
        cursors.append(cursor)


@pytest.fixture
def table():
    with mock_aws():
        yield create_pk_sk_table('voc-feedback')


class TestWorkspaceTable:
    def test_reads_and_writes_inside_the_scope(self, table):
        repo = ws_table(A, table)
        item = {**feedback_key(A, 'web', 'f1'), 'gsi1pk': date_pk(A, '2026-01-15'), 'text': 'ok'}
        repo.put_item(item)
        assert repo.get_item(feedback_key(A, 'web', 'f1'))['Item']['text'] == 'ok'
        repo.update_item(feedback_key(A, 'web', 'f1'), UpdateExpression='SET #t = :t',
                         ExpressionAttributeNames={'#t': 'text'}, ExpressionAttributeValues={':t': 'new'})
        assert table.get_item(Key=feedback_key(A, 'web', 'f1'))['Item']['text'] == 'new'

    def test_queries_only_with_the_prefix(self, table):
        table.put_item(Item={**feedback_key(A, 'web', 'f1')})
        table.put_item(Item={**feedback_key(A, 'web', 'f2')})
        table.put_item(Item={**feedback_key(B, 'web', 'f3')})
        repo = ws_table(A, table)
        found = list(repo.iter_query('pk', f'WS#{WS}#SOURCE#web', sort_condition='begins_with(sk, :f)',
                                     ExpressionAttributeValues={':f': 'FEEDBACK#'}, Limit=1))
        assert [row['sk'] for row in found] == ['FEEDBACK#f1', 'FEEDBACK#f2']
        assert [row['sk'] for row in repo.iter_query('pk', f'WS#{WS}#SOURCE#web', max_items=1)] == ['FEEDBACK#f1']
        assert list(repo.iter_query('pk', f'WS#{WS}#SOURCE#web', max_items=0)) == []

    @pytest.mark.parametrize('call', [
        lambda repo: repo.get_item(feedback_key(B, 'web', 'f1')),
        lambda repo: repo.get_item({'pk': 'SOURCE#web', 'sk': 'FEEDBACK#f1'}),
        lambda repo: repo.get_item({'sk': 'FEEDBACK#f1'}),
        lambda repo: repo.put_item(feedback_key(B, 'web', 'f1')),
        lambda repo: repo.put_item({**feedback_key(A, 'web', 'f1'), 'gsi1pk': date_pk(B, '2026-01-15')}),
        lambda repo: repo.put_item({**feedback_key(A, 'web', 'f1'), 'gsi4pk': 'FEEDBACK#f1'}),
        lambda repo: repo.put_item({**feedback_key(A, 'web', 'f1'), 'gsi4pk': feedback_id_pk(B, 'f1')}),
        lambda repo: repo.put_item({**feedback_key(A, 'web', 'f1'), 'gsi5pk': 'CHANNEL#email'}),
        lambda repo: repo.update_item(feedback_key(A, 'web', 'f1'), UpdateExpression='SET gsi5pk = :c',
                                      ExpressionAttributeValues={':c': 'CHANNEL#email'}),
        lambda repo: repo.update_item(feedback_key(A, 'web', 'f1'), UpdateExpression='SET #f = :f',
                                      ExpressionAttributeNames={'#f': 'gsi4pk'},
                                      ExpressionAttributeValues={':f': feedback_id_pk(B, 'f1')}),
        lambda repo: repo.put_item({**feedback_key(A, 'web', 'f1'), 'metric_type': 'source'}),
        lambda repo: repo.update_item(feedback_key(B, 'web', 'f1'), UpdateExpression='SET a = :a',
                                      ExpressionAttributeValues={':a': 1}),
        lambda repo: repo.query('pk', f'WS#{OTHER_WS}#SOURCE#web'),
        lambda repo: repo.query('gsi1pk', 'DATE#2026-01-15'),
        lambda repo: repo.query('pk', f'WS#{WS}#SOURCE#web', KeyConditionExpression='pk = :x'),
        lambda repo: repo.query('pk', f'WS#{WS}#SOURCE#web',
                                ExclusiveStartKey={'pk': f'WS#{OTHER_WS}#SOURCE#web', 'sk': 'FEEDBACK#f'}),
        lambda repo: repo.query('gsi1pk', date_pk(A, '2026-01-15'), IndexName='gsi1-by-date',
                                ExclusiveStartKey={'pk': f'WS#{WS}#SOURCE#web', 'sk': 'FEEDBACK#f',
                                                   'gsi1pk': date_pk(B, '2026-01-15')}),
        lambda repo: repo.query('pk', f'WS#{WS}#SOURCE#web', ExclusiveStartKey='not a cursor'),
    ])
    def test_refuses_anything_outside_the_scope_before_dynamodb(self, call):
        backing = MagicMock()
        with pytest.raises(OutOfScopeError):
            call(ws_table(A, backing))
        assert backing.method_calls == []

    @pytest.mark.parametrize(('expression', 'names', 'values'), [
        ('SET gsi2pk = :g', None, {':g': 'CATEGORY#x'}),
        ('SET gsi2pk = :g', None, {':g': f'WS#{OTHER_WS}#CATEGORY#x'}),
        ('SET #g = :g', {'#g': 'gsi2pk'}, {':g': f'WS#{OTHER_WS}#CATEGORY#x'}),
        ('SET #cat_g = :cat_g, #t = :t', {'#cat_g': 'gsi2pk', '#t': 'text'}, {':cat_g': 'CATEGORY#x', ':t': 'a'}),
        ('SET a = :a, gsi1pk = :d', None, {':a': 1, ':d': 'DATE#2026-01-15'}),
        ('SET gsi2pk = :g', None, {}),
        ('SET gsi2pk = if_not_exists(gsi2pk, :g)', None, {':g': f'WS#{WS}#CATEGORY#x'}),
        ('SET gsi2pk = :g + :h', None, {':g': f'WS#{WS}#CATEGORY#x', ':h': 1}),
        ('REMOVE gsi3pk', None, None),
        ('SET a = :a REMOVE #u', {'#u': 'gsi3pk'}, {':a': 1}),
        ('SET metric_type = :m', None, {':m': 'source'}),
    ])
    def test_an_update_may_set_a_partition_only_inside_the_scope(self, expression, names, values):
        backing = MagicMock()
        kwargs = {'UpdateExpression': expression}
        if names:
            kwargs['ExpressionAttributeNames'] = names
        if values:
            kwargs['ExpressionAttributeValues'] = values
        with pytest.raises(OutOfScopeError, match='outside the workspace'):
            ws_table(A, backing).update_item(feedback_key(A, 'web', 'f1'), **kwargs)
        assert backing.method_calls == []

    @pytest.mark.parametrize(('expression', 'names', 'values'), [
        ('SET gsi2pk = :g', None, {':g': f'WS#{WS}#CATEGORY#x'}),
        ('SET #cat_g = :cat_g, #t = :t', {'#cat_g': 'gsi2pk', '#t': 'text'},
         {':cat_g': f'WS#{WS}#CATEGORY#x', ':t': 'a'}),
        ('SET gsi1pk = :d REMOVE stale', None, {':d': f'WS#{WS}#DATE#2026-01-15'}),
        ('SET text_pk = :t, pk_note = :n, #m.pk = :p', {'#m': 'metadata'}, {':t': 1, ':n': 2, ':p': 3}),
        ('ADD #c :one', {'#c': 'count'}, {':one': 1}),
        ('set gsi2pk = :g remove stale', None, {':g': f'WS#{WS}#CATEGORY#x'}),
    ])
    def test_an_update_inside_the_scope_is_passed_on(self, expression, names, values):
        backing = MagicMock()
        kwargs = {'UpdateExpression': expression, 'ExpressionAttributeValues': values}
        if names:
            kwargs['ExpressionAttributeNames'] = names
        ws_table(A, backing).update_item(feedback_key(A, 'web', 'f1'), **kwargs)
        assert backing.update_item.call_args.kwargs == {'Key': feedback_key(A, 'web', 'f1'), **kwargs}

    def test_an_update_without_an_expression_is_refused(self):
        backing = MagicMock()
        with pytest.raises(OutOfScopeError, match='needs an UpdateExpression'):
            ws_table(A, backing).update_item(feedback_key(A, 'web', 'f1'), ExpressionAttributeValues={':a': 1})
        assert backing.method_calls == []

    def test_a_cursor_inside_the_scope_is_passed_on(self):
        backing = MagicMock()
        backing.query.return_value = {'Items': []}
        start = {'pk': f'WS#{WS}#SOURCE#web', 'sk': 'FEEDBACK#f', 'gsi1pk': date_pk(A, '2026-01-15')}
        ws_table(A, backing).query('gsi1pk', date_pk(A, '2026-01-15'), IndexName='gsi1-by-date',
                                   ExclusiveStartKey=start)
        kwargs = backing.query.call_args.kwargs
        assert kwargs['ExclusiveStartKey'] == start
        assert kwargs['KeyConditionExpression'] == '#p = :p'
        assert kwargs['ExpressionAttributeNames'] == {'#p': 'gsi1pk'}
        assert kwargs['ExpressionAttributeValues'] == {':p': date_pk(A, '2026-01-15')}

    @pytest.mark.parametrize('call', [
        lambda repo: repo.put_item(feedback_key(A, 'web', 'f1'), TableName='voc-workspaces'),
        lambda repo: repo.get_item(feedback_key(A, 'web', 'f1'), TableName='voc-workspaces'),
        lambda repo: repo.delete_item(feedback_key(A, 'web', 'f1'), TableName='voc-workspaces'),
        lambda repo: repo.query('pk', f'WS#{WS}#SOURCE#web', TableName='voc-workspaces'),
        lambda repo: repo.update_item(feedback_key(A, 'web', 'f1'), UpdateExpression='SET a = :a',
                                      ExpressionAttributeValues={':a': 1}, TableName='voc-workspaces'),
        lambda repo: repo.update_item(feedback_key(A, 'web', 'f1'), UpdateExpression='SET a = :a',
                                      ExpressionAttributeValues={':a': 1},
                                      AttributeUpdates={'gsi1pk': {'Value': 'DATE#x', 'Action': 'PUT'}}),
        lambda repo: repo.put_item(feedback_key(A, 'web', 'f1'), Expected={'pk': {'Exists': False}}),
        lambda repo: repo.delete_item(feedback_key(A, 'web', 'f1'), Expected={'pk': {'Exists': True}}),
        lambda repo: repo.get_item(feedback_key(A, 'web', 'f1'), AttributesToGet=['text']),
        lambda repo: repo.query('pk', f'WS#{WS}#SOURCE#web',
                                KeyConditions={'pk': {'AttributeValueList': ['SOURCE#web'], 'ComparisonOperator': 'EQ'}}),
        lambda repo: repo.query('pk', f'WS#{WS}#SOURCE#web', QueryFilter={}, ConditionalOperator='OR'),
    ])
    def test_refuses_a_parameter_it_does_not_check(self, call):
        """Ported from 6.14.00's layer: each call takes only its listed parameters, so neither a ``TableName``
        (boto3 lets it override the table's own) nor a legacy parameter can reach DynamoDB unchecked."""
        backing = MagicMock()
        with pytest.raises(OutOfScopeError, match='does not take'):
            call(ws_table(A, backing))
        assert backing.method_calls == []

    def test_every_listed_parameter_is_passed_on(self):
        backing = MagicMock()
        backing.query.return_value = {'Items': []}
        repo = ws_table(A, backing)
        repo.get_item(feedback_key(A, 'web', 'f1'), ConsistentRead=True, ProjectionExpression='#t',
                      ExpressionAttributeNames={'#t': 'text'}, ReturnConsumedCapacity='TOTAL')
        repo.put_item(feedback_key(A, 'web', 'f1'), ConditionExpression='attribute_not_exists(pk)',
                      ReturnValuesOnConditionCheckFailure='ALL_OLD')
        repo.query('gsi1pk', date_pk(A, '2026-01-15'), IndexName='gsi1-by-date', Limit=5, ScanIndexForward=False,
                   FilterExpression='#t = :t', ExpressionAttributeNames={'#t': 'text'},
                   ExpressionAttributeValues={':t': 'x'}, Select='ALL_ATTRIBUTES')
        assert backing.get_item.call_args.kwargs['ConsistentRead'] is True
        assert backing.put_item.call_args.kwargs['ReturnValuesOnConditionCheckFailure'] == 'ALL_OLD'
        assert backing.query.call_args.kwargs['IndexName'] == 'gsi1-by-date'

    def test_a_tables_scope_key_and_handle_are_fixed(self):
        """Ported from 6.14.00's layer: no caller can swap the scope, the key or the handle of a table it holds."""
        repo = ws_table(A, MagicMock())
        for name, value in (('scope', B), ('key_attribute', 'source'), ('_scope', B), ('_unscoped_table', None),
                            ('anything', 1)):
            with pytest.raises(AttributeError):
                setattr(repo, name, value)
        with pytest.raises(AttributeError):
            del repo._scope
        assert not hasattr(repo, '__dict__')
        assert (repo.scope, repo.key_attribute) == (A, 'pk')

    def test_a_scan_answers_the_scopes_rows_only(self, table):
        """The category reprocess of a workspace (7.13.00): a Scan through the view answers only its rows, page by
        page, with the caller's own boto3 filter ANDed in."""
        from boto3.dynamodb.conditions import Attr

        for scope, fid in ((A, 'f1'), (A, 'f2'), (B, 'f3')):
            table.put_item(Item={**feedback_key(scope, 'web', fid), 'kind': 'review'})
        table.put_item(Item={'pk': 'SOURCE#web', 'sk': 'FEEDBACK#f4', 'kind': 'review'})
        table.put_item(Item={**feedback_key(A, 'web', 'f5'), 'kind': 'other'})
        repo = ws_table(A, table)

        found, _cursors = _scan_every_page(repo, Limit=2, FilterExpression=Attr('kind').eq('review'))
        unfiltered = repo.scan()

        assert sorted(found) == ['FEEDBACK#f1', 'FEEDBACK#f2']
        assert sorted(row['sk'] for row in unfiltered['Items']) == ['FEEDBACK#f1', 'FEEDBACK#f2', 'FEEDBACK#f5']

    def test_a_scan_resumes_from_a_cursor_on_another_scopes_row(self, table):
        """``Limit`` applies before the filter, so a page's ``LastEvaluatedKey`` is often another scope's row: it
        is a position in the table and is passed on, while the answer stays the scope's."""
        for scope, fid in ((B, 'f0'), (A, 'f1'), (B, 'f2'), (A, 'f3')):
            table.put_item(Item=feedback_key(scope, 'web', fid))
        table.put_item(Item={'pk': 'SOURCE#web', 'sk': 'FEEDBACK#f4'})
        repo = ws_table(A, table)

        found, cursors = _scan_every_page(repo, Limit=1)

        assert sorted(found) == ['FEEDBACK#f1', 'FEEDBACK#f3']
        assert any(not A.owns(cursor['pk']) for cursor in cursors)

    @pytest.mark.parametrize('kwargs', [
        {'FilterExpression': 'kind = :k'},
        {'ExclusiveStartKey': {**feedback_key(A, 'web', 'f1'), 'gsi2pk': f'WS#{WS}#CATEGORY#x'}},
        {'ExclusiveStartKey': {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#f1', 'text': 'x'}},
        {'ExclusiveStartKey': {'pk': 1, 'sk': 'FEEDBACK#f1'}},
        {'ExclusiveStartKey': {}},
        {'ExclusiveStartKey': 'not a cursor'},
        {'TableName': 'voc-workspaces'},
        {'ExpressionAttributeValues': {':k': 'x'}},
        {'IndexName': 'gsi1-by-date'},
    ], ids=['string-filter', 'cursor-index-attribute', 'cursor-other-attribute', 'cursor-not-a-string',
            'empty-cursor', 'malformed-cursor', 'table-name', 'values', 'index'])
    def test_a_scan_refuses_anything_it_cannot_hold_to_the_scope(self, kwargs):
        backing = MagicMock()
        with pytest.raises(OutOfScopeError):
            ws_table(A, backing).scan(**kwargs)
        assert backing.method_calls == []

    def test_a_scanned_row_outside_the_scope_never_reaches_the_caller(self):
        backing = MagicMock()
        backing.scan.return_value = {'Items': [{**feedback_key(A, 'web', 'f1')}, {**feedback_key(B, 'web', 'f2')}]}
        with pytest.raises(OutOfScopeError, match='scanned row'):
            ws_table(A, backing).scan(Limit=5)

    def test_watermark_keys_are_checked_by_source(self):
        backing = MagicMock()
        repo = ws_table(A, backing, key='source')
        repo.get_item({'source': watermark_key(A, 'web', 'last_id')})
        with pytest.raises(OutOfScopeError):
            repo.get_item({'source': 'web#last_id'})
        with pytest.raises(OutOfScopeError):
            repo.put_item({'source': watermark_key(B, 'web', 'last_id'), 'value': '1'})


CORE_STACK = Path(__file__).resolve().parents[3] / 'lib' / 'stacks' / 'core-stack.ts'


def _feedback_index_partitions() -> set[str]:
    source = CORE_STACK.read_text(encoding='utf-8')
    section = source[source.index("this.feedbackTable = "):source.index('// Aggregates Table')]
    named = set(re.findall(r"partitionKey: \{ name: '([a-z0-9_]+)'", section))
    paired = {f'{prefix}pk' for prefix in re.findall(r"keyPrefix: '(gsi[0-9])'", section)}
    return named | paired


def test_every_feedback_index_partition_is_scoped():
    """Lockstep with lib/stacks/core-stack.ts: each voc-feedback index partition is one the layer checks for the
    workspace prefix. gsi4 and gsi5 are keyed on ``gsi4pk`` / ``gsi5pk``, never again on a raw attribute
    (``feedback_id``, ``source_channel``) that holds the same value in every workspace."""
    partitions = _feedback_index_partitions()
    assert partitions == {'gsi1pk', 'gsi2pk', 'gsi3pk', 'gsi4pk', 'gsi5pk'}
    assert partitions <= set(PARTITION_ATTRIBUTES)


@pytest.mark.parametrize(('body', 'expected'), [
    ({'id': 'x'}, (False, None)),
    ({'workspace_id': WS}, (False, A)),
    ({'workspace_id': 'ws_nope'}, (True, None)),
    ({'workspace_id': None}, (True, None)),
    ({'workspace_id': ''}, (True, None)),
    ({'workspace_id': 7}, (True, None)),
    ('not a message', (False, None)),
])
def test_a_message_scope_is_its_workspace_none_or_refused(body, expected):
    """Two paths: a workspace's, the deployment's (no field); a field that is no workspace id is refused."""
    assert message_scope(body) == expected


@pytest.mark.parametrize(('key', 'expected'), [
    (f'WS#{WS}#SOURCE#web', True), ('WS#anything', True), ('SOURCE#web', False), ('ws#x', False), (None, False),
])
def test_a_workspace_key_is_any_key_that_starts_ws(key, expected):
    assert is_workspace_key(key) is expected


class TestTheFeedbackPartitionsOnEitherPath:
    """shared/feedback_partitions.py: the layer's builders in a workspace, the deployment's keys without one."""

    def test_deployment_wide(self):
        assert partitions.item_key(None, 'web', 'f1') == {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#f1'}
        assert [partitions.date_partition(None, '2026-01-15'), partitions.category_partition(None, 'c'),
                partitions.urgency_partition(None, 'high'), partitions.feedback_id_partition(None, 'f1'),
                partitions.channel_partition(None, 'email')] == [
            'DATE#2026-01-15', 'CATEGORY#c', 'URGENCY#high', 'FEEDBACK#f1', 'CHANNEL#email']

    def test_in_a_workspace(self):
        assert partitions.item_key(A, 'web', 'f1') == feedback_key(A, 'web', 'f1')
        assert [partitions.date_partition(A, '2026-01-15'), partitions.category_partition(A, 'c'),
                partitions.urgency_partition(A, 'high'), partitions.feedback_id_partition(A, 'f1'),
                partitions.channel_partition(A, 'email')] == [
            date_pk(A, '2026-01-15'), category_pk(A, 'c'), urgency_pk(A, 'high'), feedback_id_pk(A, 'f1'),
            channel_pk(A, 'email')]

    def test_two_workspaces_and_the_deployment_never_share_an_id_or_channel_partition(self):
        ids = {partitions.feedback_id_partition(scope, 'f1') for scope in (None, A, B)}
        channels = {partitions.channel_partition(scope, 'email') for scope in (None, A, B)}
        assert (len(ids), len(channels)) == (3, 3)
        assert (partitions.FEEDBACK_ID_INDEX_PARTITION, partitions.CHANNEL_INDEX_PARTITION) == ('gsi4pk', 'gsi5pk')


def test_an_item_carries_its_id_and_channel_as_plain_attributes():
    """``feedback_id`` and ``source_channel`` are plain attributes since the re-key: written and updated freely."""
    backing = MagicMock()
    repo = ws_table(A, backing)
    item = {**feedback_key(A, 'web', 'f1'), 'feedback_id': 'f1', 'source_channel': 'email',
            'gsi4pk': feedback_id_pk(A, 'f1'), 'gsi5pk': channel_pk(A, 'email')}
    repo.put_item(item)
    repo.update_item(feedback_key(A, 'web', 'f1'), UpdateExpression='SET source_channel = :c, gsi5pk = :g',
                     ExpressionAttributeValues={':c': 'chat', ':g': channel_pk(A, 'chat')})
    assert backing.put_item.call_args.kwargs['Item'] == item
    assert backing.update_item.call_count == 1


def _table_section(start: str, end: str) -> str:
    source = CORE_STACK.read_text(encoding='utf-8')
    begin = source.index(start)
    return source[begin:source.index(end, begin)]


def test_the_aggregates_and_watermarks_partitions_are_scoped():
    """Lockstep with lib/stacks/core-stack.ts: voc-aggregates' index (``metric_type``) and voc-watermarks' key
    (``source``) are partitions the layer checks for the workspace prefix."""
    aggregates = _table_section('// Aggregates Table', 'this.watermarksTable')
    watermarks = _table_section('this.watermarksTable', ';\n')
    assert set(re.findall(r"partitionKey: \{ name: '([a-z0-9_]+)'", aggregates)) <= set(PARTITION_ATTRIBUTES)
    assert set(re.findall(r"name: '([a-z0-9_]+)'", watermarks)) <= set(PARTITION_ATTRIBUTES)
    assert 'metric_type' in aggregates
    assert 'source' in set(re.findall(r"name: '([a-z0-9_]+)'", watermarks))


def test_source_is_only_the_watermarks_key_never_a_pk_tables_index():
    """Lockstep with lib/stacks/core-stack.ts: ``WATERMARK_PARTITION`` is voc-watermarks' key and no voc-feedback or
    voc-aggregates index partitions on it, which is why the layer lets a ``pk`` item carry it as a plain attribute."""
    aggregates = _table_section('// Aggregates Table', 'this.watermarksTable')
    watermarks = _table_section('this.watermarksTable', ';\n')
    assert WATERMARK_PARTITION == 'source'
    assert WATERMARK_PARTITION not in _feedback_index_partitions()
    assert WATERMARK_PARTITION not in set(re.findall(r"partitionKey: \{ name: '([a-z0-9_]+)'", aggregates))
    assert WATERMARK_PARTITION in set(re.findall(r"name: '([a-z0-9_]+)'", watermarks))


class TestTheLayerForTheIngestors:
    """What the plugin ingestors use: a delete, and ``source`` as a plain attribute."""

    def test_a_delete_reaches_only_a_key_of_the_scope(self, table):
        repo = ws_table(A, table)
        repo.put_item({'pk': A.key('CIRCUIT', 'web'), 'sk': 'TRIPPED'})

        repo.delete_item({'pk': A.key('CIRCUIT', 'web'), 'sk': 'TRIPPED'})

        assert 'Item' not in table.get_item(Key={'pk': A.key('CIRCUIT', 'web'), 'sk': 'TRIPPED'})
        with pytest.raises(OutOfScopeError):
            repo.delete_item({'pk': B.key('CIRCUIT', 'web'), 'sk': 'TRIPPED'})
        with pytest.raises(OutOfScopeError):
            repo.delete_item({'pk': 'CIRCUIT#web', 'sk': 'TRIPPED'})

    def test_a_pk_item_may_carry_source_as_a_plain_attribute(self, table):
        """An import run's ``source`` label (``S3 - folder``) on an aggregates row is no partition there."""
        repo = ws_table(A, table)

        repo.put_item({'pk': A.key('IMPORT_RUN'), 'sk': '2026#r1', 'source': 'S3 - reviews'})

        assert table.get_item(Key={'pk': A.key('IMPORT_RUN'), 'sk': '2026#r1'})['Item']['source'] == 'S3 - reviews'

    def test_a_watermark_item_still_needs_its_source_in_the_scope(self):
        underlying = MagicMock()
        repo = ws_table(A, underlying, key='source')

        with pytest.raises(OutOfScopeError):
            repo.put_item({'source': 'web#last_id', 'value': '1'})
        with pytest.raises(OutOfScopeError):
            repo.put_item({'source': watermark_key(B, 'web', 'last_id'), 'value': '1'})
        repo.put_item({'source': watermark_key(A, 'web', 'last_id'), 'value': '1'})
        assert underlying.put_item.call_count == 1

    def test_on_the_watermarks_table_an_in_scope_pk_cannot_carry_another_workspaces_source(self):
        """The mixed item: a ``pk`` of this workspace must not let a ``source`` (voc-watermarks' key) of another
        workspace through, which would overwrite that workspace's watermark."""
        underlying = MagicMock()
        repo = ws_table(A, underlying, key='source')

        with pytest.raises(OutOfScopeError):
            repo.put_item({'pk': A.key('SOURCE_RUN', 'web'), 'source': watermark_key(B, 'web', 'last_id'), 'value': '1'})
        with pytest.raises(OutOfScopeError):
            repo.put_item({'source': watermark_key(A, 'web', 'last_id'), 'pk': B.key('SOURCE_RUN', 'web')})
        underlying.put_item.assert_not_called()

    def test_the_key_check_uses_exactly_the_tables_key(self):
        underlying = MagicMock()
        watermarks, aggregates = ws_table(A, underlying, key='source'), ws_table(A, underlying)

        with pytest.raises(OutOfScopeError):
            watermarks.get_item({'pk': A.key('SOURCE_RUN', 'web'), 'source': watermark_key(B, 'web', 'k')})
        with pytest.raises(OutOfScopeError):
            aggregates.get_item({'source': watermark_key(A, 'web', 'k')})
        with pytest.raises(ValueError, match='keyed on pk or source'):
            ws_table(A, underlying, key='sk')
        underlying.get_item.assert_not_called()

    def test_the_other_partition_attributes_are_still_checked_on_a_pk_item(self):
        repo = ws_table(A, MagicMock())

        with pytest.raises(OutOfScopeError, match='gsi1pk'):
            repo.put_item({'pk': A.key('SOURCE', 'web'), 'sk': 'FEEDBACK#1', 'source': 'x', 'gsi1pk': 'DATE#2026'})


def _key(scope: WorkspaceScope, feedback_id: str) -> dict[str, str]:
    return feedback_key(scope, 'web', feedback_id)


def _put(scope: WorkspaceScope, feedback_id: str, **attributes: object) -> dict:
    return {'Put': {'Item': {**_key(scope, feedback_id), **attributes}}}


def _backing() -> MagicMock:
    """A table double whose name the view fills in as ``TableName``."""
    backing = MagicMock()
    backing.name = 'voc-feedback'
    return backing


def _calls_but_the_writers_creation(backing: MagicMock) -> list[str]:
    return [name for name, _args, _kwargs in backing.mock_calls if name != 'batch_writer']


#: Transactions with an entry outside the scope: each is refused whole, before anything is sent.
_TRANSACTIONS_OUT_OF_SCOPE = [
    [_put(B, 'f1')],
    [_put(A, 'f1', gsi1pk=date_pk(B, '2026-01-15'))],
    [_put(A, 'f1', gsi4pk='FEEDBACK#f1')],
    [_put(A, 'f1', gsi5pk=channel_pk(B, 'email'))],
    [{'Update': {'Key': _key(A, 'f1'), 'UpdateExpression': 'SET gsi4pk = :f',
                 'ExpressionAttributeValues': {':f': feedback_id_pk(B, 'f1')}}}],
    [{'Update': {'Key': _key(A, 'f1'), 'UpdateExpression': 'SET #c = :c', 'ExpressionAttributeNames': {'#c': 'gsi5pk'},
                 'ExpressionAttributeValues': {':c': 'CHANNEL#email'}}}],
    [{'Update': {'Key': _key(A, 'f1'), 'UpdateExpression': 'REMOVE gsi4pk'}}],
    [{'Update': {'Key': _key(B, 'f1'), 'UpdateExpression': 'SET a = :a', 'ExpressionAttributeValues': {':a': 1}}}],
    [{'Update': {'Key': _key(A, 'f1')}}],
    [{'Delete': {'Key': _key(B, 'f1')}}],
    [{'Delete': {'Key': {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#f1'}}}],
    [{'ConditionCheck': {'Key': _key(B, 'f1'), 'ConditionExpression': 'attribute_exists(pk)'}}],
    [{'Put': {'Item': _key(A, 'f1'), 'TableName': 'voc-aggregates'}}],
    # Mixed: two entries in the scope, one outside it.
    [_put(A, 'f1'), {'Delete': {'Key': _key(A, 'f2')}}, _put(B, 'f3')],
]


class TestTheMultiItemCalls:
    """``transact_write_items``, ``batch_get_item`` and ``batch_writer``: one table, every entry checked as the
    single-item calls check it, the table named by the view."""

    def test_a_transaction_writes_in_the_scope(self, table):
        repo = ws_table(A, table)
        for feedback_id, text in (('f1', 'old'), ('f3', 'gone'), ('f4', 'kept')):
            table.put_item(Item={**_key(A, feedback_id), 'text': text})

        repo.transact_write_items([
            _put(A, 'f2', text='new', gsi4pk=feedback_id_pk(A, 'f2'), gsi5pk=channel_pk(A, 'email')),
            {'Update': {'Key': _key(A, 'f1'), 'UpdateExpression': 'SET #t = :t, gsi2pk = :g',
                        'ExpressionAttributeNames': {'#t': 'text'},
                        'ExpressionAttributeValues': {':t': 'edited', ':g': category_pk(A, 'pricing')}}},
            {'Delete': {'Key': _key(A, 'f3')}},
            {'ConditionCheck': {'Key': _key(A, 'f4'), 'ConditionExpression': 'attribute_exists(pk)'}},
        ])

        edited = repo.get_item(_key(A, 'f1'))['Item']
        assert (edited['text'], edited['gsi2pk']) == ('edited', category_pk(A, 'pricing'))
        added = repo.get_item(_key(A, 'f2'))['Item']
        assert (added['text'], added['gsi4pk'], added['gsi5pk']) == (
            'new', feedback_id_pk(A, 'f2'), channel_pk(A, 'email'))
        assert 'Item' not in repo.get_item(_key(A, 'f3'))
        assert repo.get_item(_key(A, 'f4'))['Item']['text'] == 'kept'

    def test_the_batch_writer_and_batch_get_span_more_than_one_request(self, table):
        repo = ws_table(A, table)
        with repo.batch_writer() as writer:
            for number in range(130):
                writer.put_item(Item={**_key(A, f'f{number}'), 'n': number, 'text': 'x'})

        found = repo.batch_get_item([_key(A, f'f{number}') for number in range(130)] + [_key(A, 'missing')],
                                    ProjectionExpression='sk, #n', ExpressionAttributeNames={'#n': 'n'},
                                    ConsistentRead=True)

        assert sorted(row['n'] for row in found) == list(range(130))
        assert all(set(row) == {'sk', 'n'} for row in found)

    def test_a_mixed_transaction_writes_nothing(self, table):
        with pytest.raises(OutOfScopeError):
            ws_table(A, table).transact_write_items([_put(A, 'f1'), _put(B, 'f1')])
        assert table.scan()['Items'] == []

    @pytest.mark.parametrize('items', [
        [{'Put': {'Item': _key(A, 'f1'), 'Expected': {'pk': {'Exists': False}}}}],
        [{'Update': {'Key': _key(A, 'f1'), 'UpdateExpression': 'SET a = :a', 'ExpressionAttributeValues': {':a': 1},
                     'AttributeUpdates': {'gsi1pk': {'Value': 'DATE#x', 'Action': 'PUT'}}}}],
        [{'Delete': {'Key': _key(A, 'f1'), 'ReturnValues': 'ALL_OLD'}}],
        [{'ConditionCheck': {'Key': _key(A, 'f1'), 'ConditionExpression': 'attribute_exists(pk)',
                             'ConditionalOperator': 'OR'}}],
    ])
    def test_a_transaction_entry_takes_only_its_listed_fields(self, items):
        """The single-item calls' allow-lists hold per entry too: a legacy parameter, or any other the layer does not
        check, refuses the whole transaction before it is sent."""
        backing = _backing()
        with pytest.raises(OutOfScopeError, match='does not take'):
            ws_table(A, backing).transact_write_items(items)
        assert backing.mock_calls == []

    @pytest.mark.parametrize('items', _TRANSACTIONS_OUT_OF_SCOPE)
    def test_a_transaction_with_an_entry_outside_the_scope_is_refused_whole(self, items):
        backing = _backing()
        with pytest.raises(OutOfScopeError):
            ws_table(A, backing).transact_write_items(items)
        assert backing.mock_calls == []

    @pytest.mark.parametrize('call', [
        lambda repo: repo.transact_write_items([_put(A, 'f1')], TableName='voc-aggregates'),
        lambda repo: repo.batch_get_item([_key(A, 'f1'), _key(B, 'f1')]),
        lambda repo: repo.batch_get_item([{'pk': 'SOURCE#web', 'sk': 'FEEDBACK#f1'}]),
        lambda repo: repo.batch_get_item([{'sk': 'FEEDBACK#f1'}]),
        lambda repo: repo.batch_get_item([_key(A, 'f1')], TableName='voc-feedback'),
        lambda repo: repo.batch_get_item([_key(A, 'f1')], RequestItems={'voc-aggregates': {'Keys': [_key(A, 'f1')]}}),
        lambda repo: repo.batch_writer().put_item(Item=_key(B, 'f1')),
        lambda repo: repo.batch_writer().put_item(Item={**_key(A, 'f1'), 'gsi4pk': feedback_id_pk(B, 'f1')}),
        lambda repo: repo.batch_writer().put_item(Item={**_key(A, 'f1'), 'gsi5pk': 'CHANNEL#email'}),
        lambda repo: repo.batch_writer().delete_item(Key=_key(A, 'f1')),
    ])
    def test_every_call_refuses_anything_outside_the_scope_before_dynamodb(self, call):
        backing = _backing()
        with pytest.raises(OutOfScopeError):
            call(ws_table(A, backing))
        assert _calls_but_the_writers_creation(backing) == []

    @pytest.mark.parametrize('call', [
        lambda repo: repo.transact_write_items([_put(A, f'f{n}') for n in range(MAX_TRANSACT_ITEMS + 1)]),
        lambda repo: repo.transact_write_items([]),
        lambda repo: repo.transact_write_items([{'Put': {'Item': _key(A, 'f1')}, 'Delete': {'Key': _key(A, 'f2')}}]),
        lambda repo: repo.transact_write_items([{'Get': {'Key': _key(A, 'f1')}}]),
        lambda repo: repo.transact_write_items([{'Delete': {}}]),
        lambda repo: repo.transact_write_items([{'ConditionCheck': {'Key': _key(A, 'f1')}}]),
        lambda repo: repo.transact_write_items([_put(A, 'f1')], ReturnValues='ALL_OLD'),
        lambda repo: repo.batch_get_item([_key(A, 'f1')], Limit=1),
        # One item named twice: DynamoDB refuses it, the view first.
        lambda repo: repo.batch_get_item([_key(A, 'f1'), _key(A, 'f2'), _key(A, 'f1')]),
        lambda repo: repo.transact_write_items([_put(A, 'f1'), {'Delete': {'Key': _key(A, 'f1')}}]),
        lambda repo: repo.transact_write_items([
            {'ConditionCheck': {'Key': _key(A, 'f1'), 'ConditionExpression': 'attribute_exists(pk)'}},
            {'Update': {'Key': _key(A, 'f1'), 'UpdateExpression': 'SET a = :a', 'ExpressionAttributeValues': {':a': 1}}},
        ]),
    ])
    def test_a_malformed_call_is_refused_before_dynamodb(self, call):
        backing = _backing()
        with pytest.raises(ValueError, match=r'takes|entry|does not take|names one item twice') as refused:
            call(ws_table(A, backing))
        assert not isinstance(refused.value, OutOfScopeError)
        assert backing.mock_calls == []

    def test_a_transaction_names_the_views_table_and_passes_its_options_on(self):
        backing = _backing()
        item = {**_key(A, 'f1'), 'gsi4pk': feedback_id_pk(A, 'f1')}

        ws_table(A, backing).transact_write_items(
            [{'Put': {'Item': item, 'ConditionExpression': 'attribute_not_exists(pk)'}}],
            ClientRequestToken='request-1', ReturnConsumedCapacity='TOTAL')

        backing.meta.client.transact_write_items.assert_called_once_with(
            TransactItems=[{'Put': {'Item': item, 'ConditionExpression': 'attribute_not_exists(pk)',
                                    'TableName': 'voc-feedback'}}],
            ClientRequestToken='request-1', ReturnConsumedCapacity='TOTAL')

    def test_a_batch_get_sends_at_most_100_keys_a_request(self):
        backing = _backing()
        backing.meta.client.batch_get_item.return_value = {'Responses': {'voc-feedback': []}}

        ws_table(A, backing).batch_get_item([_key(A, f'f{n}') for n in range(250)], ConsistentRead=True)

        sent = [request.kwargs['RequestItems']['voc-feedback']
                for request in backing.meta.client.batch_get_item.call_args_list]
        assert [len(request['Keys']) for request in sent] == [100, 100, 50]
        assert all(request['ConsistentRead'] is True for request in sent)

    def test_unprocessed_keys_are_asked_for_again(self, monkeypatch):
        sleeps: list[float] = []
        monkeypatch.setattr('shared.batch_get.time.sleep', sleeps.append)
        monkeypatch.setattr('shared.batch_get.random.uniform', lambda _low, high: high)
        backing = _backing()
        # DynamoDB hands back the unprocessed keys with the request's own options.
        unprocessed = {'voc-feedback': {'ProjectionExpression': 'sk', 'ConsistentRead': True, 'Keys': [_key(A, 'f2')]}}
        backing.meta.client.batch_get_item.side_effect = [
            {'Responses': {'voc-feedback': [{'sk': 'FEEDBACK#f1'}]}, 'UnprocessedKeys': unprocessed},
            {'Responses': {'voc-feedback': [{'sk': 'FEEDBACK#f2'}]}, 'UnprocessedKeys': {}},
        ]

        found = ws_table(A, backing).batch_get_item([_key(A, 'f1'), _key(A, 'f2')], ProjectionExpression='sk')

        assert found == [{'sk': 'FEEDBACK#f1'}, {'sk': 'FEEDBACK#f2'}]
        assert backing.meta.client.batch_get_item.call_args.kwargs == {'RequestItems': unprocessed}
        assert sleeps == [0.1]

    def test_keys_still_unprocessed_after_the_bound_fail_the_read(self, monkeypatch):
        sleeps: list[float] = []
        monkeypatch.setattr('shared.batch_get.time.sleep', sleeps.append)
        backing = _backing()
        left = [_key(A, 'f2'), _key(A, 'f3')]
        backing.meta.client.batch_get_item.return_value = {
            'Responses': {}, 'UnprocessedKeys': {'voc-feedback': {'Keys': left}}}

        refusal = f'left keys unprocessed after {BATCH_GET_ATTEMPTS} calls'
        with pytest.raises(UnprocessedKeysError, match=refusal):
            ws_table(A, backing).batch_get_item([_key(A, 'f1'), *left])

        # Every call counts, the first (3 keys, 2 left) included.
        assert backing.meta.client.batch_get_item.call_count == BATCH_GET_ATTEMPTS
        assert len(sleeps) == BATCH_GET_ATTEMPTS - 1

    def test_a_batch_get_may_be_eventually_consistent(self):
        backing = _backing()
        backing.meta.client.batch_get_item.return_value = {'Responses': {'voc-feedback': []}}

        ws_table(A, backing).batch_get_item([_key(A, 'f1')], ConsistentRead=False)

        assert backing.meta.client.batch_get_item.call_args.kwargs['RequestItems']['voc-feedback'][
            'ConsistentRead'] is False

    def test_a_duplicate_is_named(self):
        backing = _backing()
        with pytest.raises(ValueError, match=r"names one item twice: pk 'WS#.*#SOURCE#web', sk 'FEEDBACK#f1'"):
            ws_table(A, backing).batch_get_item([_key(A, 'f1'), _key(A, 'f1')])
        assert backing.mock_calls == []

    def test_the_batch_writer_hands_checked_puts_to_the_tables_writer(self):
        backing = _backing()
        with ws_table(A, backing).batch_writer() as writer:
            writer.put_item(Item=_key(A, 'f1'))

        backing.batch_writer.assert_called_once_with()
        real = backing.batch_writer.return_value
        real.put_item.assert_called_once_with(Item=_key(A, 'f1'))
        real.__exit__.assert_called_once()

    def test_the_batch_writer_refuses_a_delete(self):
        backing = _backing()
        with (pytest.raises(OutOfScopeError, match='the batch writer only puts'),
              ws_table(A, backing).batch_writer() as writer):
            writer.delete_item(Key=_key(A, 'f1'))
        assert backing.batch_writer.return_value.delete_item.call_count == 0

    def test_a_refused_put_still_flushes_the_puts_before_it(self, table):
        """Documented on ``WorkspaceBatchWriter``: the refusal ends the block, boto3's ``__exit__`` flushes what was
        buffered before it, and the refused item is never sent."""
        repo = ws_table(A, table)

        def write() -> None:
            with repo.batch_writer() as writer:
                writer.put_item(Item={**_key(A, 'f1'), 'text': 'kept'})
                writer.put_item(Item=_key(B, 'f2'))

        with pytest.raises(OutOfScopeError):
            write()

        assert [row['sk'] for row in table.scan()['Items']] == ['FEEDBACK#f1']
