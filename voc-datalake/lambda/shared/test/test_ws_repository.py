"""shared/ws_repository.py: the workspace-scoped repository layer (docs/multi-workspace.md, Request flow step 4).

Moto for what DynamoDB does with a key inside the workspace; a stub table for every refusal, so each one is shown
to raise before any AWS call."""
import re
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import MagicMock, patch

import boto3
import pytest
from boto3.dynamodb.conditions import Key
from moto import mock_aws

from shared.exceptions import ConfigurationError
from shared.tables import cached_table
from shared.ws_repository import TABLES, WorkspaceScopeError, WorkspaceTable, ws_s3_key, ws_table

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER_WS = 'ws_7ZZZZZZZZZZZZZZZZZZZZZZZZZ'
MINE = f'WS#{WS}#SOURCE#webscraper'
THEIRS = f'WS#{OTHER_WS}#SOURCE#webscraper'
DAY = f'WS#{WS}#DATE#2026-01-15'
INDEX = 'gsi1-by-date'
FEEDBACK = TABLES['FEEDBACK_TABLE']
CORE_STACK = Path(__file__).resolve().parents[3] / 'lib' / 'stacks' / 'core-stack.ts'
LINE_SEPARATOR, PARAGRAPH_SEPARATOR = chr(0x2028), chr(0x2029)


@pytest.fixture
def table() -> Iterator:
    with mock_aws():
        yield boto3.resource('dynamodb', region_name='us-east-1').create_table(
            TableName='voc-feedback', BillingMode='PAY_PER_REQUEST',
            KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': a, 'AttributeType': 'S'} for a in ('pk', 'sk', 'gsi1pk', 'gsi1sk')],
            GlobalSecondaryIndexes=[{
                'IndexName': INDEX, 'Projection': {'ProjectionType': 'ALL'},
                'KeySchema': [{'AttributeName': 'gsi1pk', 'KeyType': 'HASH'},
                              {'AttributeName': 'gsi1sk', 'KeyType': 'RANGE'}]}])


@pytest.fixture
def scoped(table) -> WorkspaceTable:
    return WorkspaceTable(WS, table, FEEDBACK)


# ── Inside the workspace: boto3's forms and answers ──────────────────────────

def test_put_get_update_delete_take_and_answer_boto3s_forms(scoped, table):
    put = scoped.put_item(Item={'pk': MINE, 'sk': 'ITEM#1', 'gsi1pk': DAY, 'text': 'Great boots'})
    assert put['ResponseMetadata']['HTTPStatusCode'] == 200
    assert scoped.get_item(Key={'pk': MINE, 'sk': 'ITEM#1'})['Item']['text'] == 'Great boots'
    updated = scoped.update_item(Key={'pk': MINE, 'sk': 'ITEM#1'}, UpdateExpression='SET #t = :t',
                                 ExpressionAttributeNames={'#t': 'text'}, ExpressionAttributeValues={':t': 'Good boots'},
                                 ReturnValues='ALL_NEW')
    assert updated['Attributes']['text'] == 'Good boots'
    scoped.delete_item(Key={'pk': MINE, 'sk': 'ITEM#1'})
    assert 'Item' not in scoped.get_item(Key={'pk': MINE, 'sk': 'ITEM#1'})
    assert 'Item' not in table.get_item(Key={'pk': MINE, 'sk': 'ITEM#1'})


def test_query_reads_one_partition_of_the_workspace_with_a_sort_condition(scoped, table):
    for sk in ('ITEM#1', 'ITEM#2', 'RUN#1'):
        table.put_item(Item={'pk': MINE, 'sk': sk})
    table.put_item(Item={'pk': THEIRS, 'sk': 'ITEM#9'})
    assert [i['sk'] for i in scoped.query(MINE)['Items']] == ['ITEM#1', 'ITEM#2', 'RUN#1']
    assert [i['sk'] for i in scoped.query(MINE, sort=Key('sk').begins_with('ITEM#'))['Items']] == ['ITEM#1', 'ITEM#2']


def test_query_pages_with_a_start_key_inside_the_workspace(scoped, table):
    for sk in ('ITEM#1', 'ITEM#2'):
        table.put_item(Item={'pk': MINE, 'sk': sk})
    first = scoped.query(MINE, Limit=1)
    second = scoped.query(MINE, Limit=1, ExclusiveStartKey=first['LastEvaluatedKey'])
    assert [i['sk'] for i in first['Items'] + second['Items']] == ['ITEM#1', 'ITEM#2']


def test_query_of_an_index_takes_the_partition_attribute_from_the_registry(scoped):
    scoped.put_item(Item={'pk': MINE, 'sk': 'ITEM#1', 'gsi1pk': DAY, 'gsi1sk': '10:00'})
    assert [i['sk'] for i in scoped.query(DAY, index=INDEX)['Items']] == ['ITEM#1']


def test_an_update_of_other_attributes_passes_its_expression_through(stub):
    WorkspaceTable(WS, stub, FEEDBACK).update_item(
        Key={'pk': MINE, 'sk': 'ITEM#1'}, UpdateExpression='SET #s = :s, gsi1sk = :d',
        ConditionExpression='attribute_exists(gsi1pk)', ExpressionAttributeNames={'#s': 'status'},
        ExpressionAttributeValues={':s': 'done', ':d': '10:00'}, ReturnValues='ALL_NEW')
    stub.update_item.assert_called_once()


def test_an_update_whose_condition_names_a_key_attribute_passes(scoped, table):
    # The usual "only if it exists" update, as call sites write it: #pk is used by the condition only.
    table.put_item(Item={'pk': MINE, 'sk': 'ITEM#1', 'status': 'new'})
    scoped.update_item(Key={'pk': MINE, 'sk': 'ITEM#1'}, UpdateExpression='SET #s = :s',
                       ConditionExpression='attribute_exists(#pk)',
                       ExpressionAttributeNames={'#s': 'status', '#pk': 'pk'}, ExpressionAttributeValues={':s': 'done'})
    assert table.get_item(Key={'pk': MINE, 'sk': 'ITEM#1'})['Item']['status'] == 'done'


def test_a_workspace_table_cannot_be_changed_from_outside(stub):
    scoped = WorkspaceTable(WS, stub, FEEDBACK)
    for name, value in (('ws', OTHER_WS), ('_prefix', f'WS#{OTHER_WS}#'), ('_schema', TABLES['RADAR_TABLE']),
                        ('_unscoped_table', MagicMock()), ('anything', 1)):
        with pytest.raises(AttributeError):
            setattr(scoped, name, value)
    with pytest.raises(AttributeError):
        del scoped._prefix
    assert not hasattr(scoped, '__dict__')
    with pytest.raises(WorkspaceScopeError):
        scoped.get_item(Key={'pk': THEIRS, 'sk': 'ITEM#1'})
    assert scoped.ws == WS


@pytest.mark.parametrize(('method', 'kwargs'), [
    ('update_item', {'AttributeUpdates': {'gsi1pk': {'Value': THEIRS, 'Action': 'PUT'}}}),
    ('update_item', {'Expected': {'pk': {'Exists': True}}}),
    ('put_item', {'Expected': {'pk': {'Exists': False}}}),
    ('put_item', {'UpdateExpression': 'SET a = :a'}),
    ('delete_item', {'Expected': {'pk': {'Exists': True}}}),
    ('get_item', {'AttributesToGet': ['pk']}),
    ('query', {'KeyConditions': {'pk': {'AttributeValueList': [THEIRS], 'ComparisonOperator': 'EQ'}}}),
    ('query', {'QueryFilter': {}}),
    ('query', {'AttributesToGet': ['pk']}),
], ids=['update-attribute-updates', 'update-expected', 'put-expected', 'put-update-expression', 'delete-expected',
        'get-attributes-to-get', 'query-key-conditions', 'query-filter', 'query-attributes-to-get'])
def test_each_method_refuses_parameters_outside_its_list(stub, method, kwargs):
    scoped = WorkspaceTable(WS, stub, FEEDBACK)
    call = {'get_item': lambda: scoped.get_item(Key=_key(MINE), **kwargs),
            'put_item': lambda: scoped.put_item(Item=_key(MINE), **kwargs),
            'update_item': lambda: scoped.update_item(Key=_key(MINE), **kwargs),
            'delete_item': lambda: scoped.delete_item(Key=_key(MINE), **kwargs),
            'query': lambda: scoped.query(MINE, **kwargs)}[method]
    with pytest.raises(WorkspaceScopeError, match='does not take'):
        call()
    assert stub.mock_calls == []


# ── Outside the workspace: refused before any AWS call ────────────────────────

OUTSIDE = [
    pytest.param(THEIRS, id='another-workspace'),
    pytest.param(f'WS#{WS}', id='the-control-plane-partition'),
    pytest.param(f'WS#{WS}#', id='the-bare-prefix'),
    pytest.param(f'WS#{WS}X#SOURCE', id='a-longer-id'),
    pytest.param('SOURCE#webscraper', id='an-unscoped-key'),
    pytest.param(None, id='no-partition-key'),
    pytest.param(7, id='not-text'),
]


@pytest.fixture
def stub() -> MagicMock:
    return MagicMock(name='table')


def _key(pk):
    return {'sk': 'ITEM#1'} if pk is None else {'pk': pk, 'sk': 'ITEM#1'}


@pytest.mark.parametrize('pk', OUTSIDE)
def test_every_operation_refuses_a_key_outside_the_workspace(stub, pk):
    scoped = WorkspaceTable(WS, stub, FEEDBACK)
    calls = [lambda: scoped.get_item(Key=_key(pk)), lambda: scoped.put_item(Item=_key(pk)),
             lambda: scoped.update_item(Key=_key(pk)), lambda: scoped.delete_item(Key=_key(pk)),
             lambda: scoped.query(pk)]
    for call in calls:
        with pytest.raises(WorkspaceScopeError, match='key outside the workspace'):
            call()
    assert stub.mock_calls == []


@pytest.mark.parametrize(('attribute', 'value'), [
    ('gsi2pk', f'WS#{OTHER_WS}#CATEGORY#fit'), ('feedback_id', 'fb-1'), ('source_channel', f'WS#{OTHER_WS}#email'),
], ids=['key-pair-index', 'feedback-id-index', 'channel-index'])
def test_a_put_refuses_an_index_partition_outside_the_workspace(stub, attribute, value):
    with pytest.raises(WorkspaceScopeError):
        WorkspaceTable(WS, stub, FEEDBACK).put_item(Item={'pk': MINE, 'sk': 'ITEM#1', attribute: value})
    assert stub.mock_calls == []


def test_a_put_checks_the_registrys_attributes_only(stub):
    WorkspaceTable(WS, stub, FEEDBACK).put_item(Item={'pk': MINE, 'sk': 'ITEM#1', 'gsi1sk': 'any', 'source': 'x'})
    stub.put_item.assert_called_once_with(Item={'pk': MINE, 'sk': 'ITEM#1', 'gsi1sk': 'any', 'source': 'x'})


def test_checks_use_the_tables_own_partition_attributes(stub):
    aggregates = WorkspaceTable(WS, stub, TABLES['AGGREGATES_TABLE'])
    with pytest.raises(WorkspaceScopeError):
        aggregates.put_item(Item={'pk': MINE, 'sk': 'm', 'metric_type': 'daily_total'})
    aggregates.put_item(Item={'pk': MINE, 'sk': 'm', 'metric_type': f'WS#{WS}#daily_total', 'gsi1pk': 'free'})
    assert stub.put_item.call_count == 1


@pytest.mark.parametrize(('expression', 'names'), [
    ('SET gsi1pk = :p', None),
    ('SET #a = :p', {'#a': 'gsi3pk'}),
    ('SET #f = :p', {'#f': 'feedback_id'}),
    ('REMOVE source_channel', None),
    ('SET pk = :p', None),
    ('SET #0 = :p', {'#0': 'gsi1pk'}),
    ('SET #s = :p, #k = :p', {'#s': 'status', '#k': 'source_channel'}),
    ('SET a = if_not_exists(gsi2pk, :p)', None),
], ids=['direct', 'placeholder', 'non-gsi-index', 'remove', 'table-key', 'digit-placeholder',
        'second-placeholder', 'inside-a-function'])
def test_an_update_naming_an_index_partition_attribute_is_refused(stub, expression, names):
    extra = {} if names is None else {'ExpressionAttributeNames': names}
    with pytest.raises(WorkspaceScopeError, match='use put_item'):
        WorkspaceTable(WS, stub, FEEDBACK).update_item(
            Key={'pk': MINE, 'sk': 'ITEM#1'}, UpdateExpression=expression,
            ExpressionAttributeValues={':p': f'WS#{OTHER_WS}#DATE#2026-01-15'}, **extra)
    assert stub.mock_calls == []


@pytest.mark.parametrize('kwargs', [
    {'KeyConditionExpression': Key('pk').eq(THEIRS)}, {'IndexName': INDEX},
], ids=['key-condition', 'raw-index-name'])
def test_a_query_refuses_boto3s_raw_forms(stub, kwargs):
    with pytest.raises(WorkspaceScopeError, match='name the partition'):
        WorkspaceTable(WS, stub, FEEDBACK).query(MINE, **kwargs)
    assert stub.mock_calls == []


def test_a_query_refuses_an_index_the_table_does_not_have(stub):
    with pytest.raises(WorkspaceScopeError, match='not an index'):
        WorkspaceTable(WS, stub, FEEDBACK).query(DAY, index='gsi9-by-anything')
    assert stub.mock_calls == []


@pytest.mark.parametrize('start', [{'pk': THEIRS, 'sk': 'ITEM#1'}, {'pk': MINE, 'sk': 'ITEM#1', 'gsi1pk': THEIRS}],
                         ids=['table-key', 'index-key'])
def test_a_query_refuses_a_start_key_outside_the_workspace(stub, start):
    with pytest.raises(WorkspaceScopeError):
        WorkspaceTable(WS, stub, FEEDBACK).query(DAY, index=INDEX, ExclusiveStartKey=start)
    assert stub.mock_calls == []


def test_an_index_query_refuses_a_partition_outside_the_workspace(stub):
    with pytest.raises(WorkspaceScopeError):
        WorkspaceTable(WS, stub, FEEDBACK).query(f'WS#{OTHER_WS}#DATE#2026-01-15', index=INDEX)
    assert stub.mock_calls == []


@pytest.mark.parametrize('ws', ['ws_01jc3q8zk6v7w9x2y4a5b6c7d8', 'ws_8ZZZZZZZZZZZZZZZZZZZZZZZZZ', 'acme', ''])
def test_a_malformed_workspace_id_is_refused(stub, ws):
    with pytest.raises(WorkspaceScopeError, match='not a workspace id'):
        WorkspaceTable(ws, stub, FEEDBACK)
    with pytest.raises(WorkspaceScopeError, match='not a workspace id'):
        ws_table(ws, 'FEEDBACK_TABLE')
    with pytest.raises(WorkspaceScopeError, match='not a workspace id'):
        ws_s3_key(ws, 'raw')


# ── ws_table: the registry ───────────────────────────────────────────────────

@pytest.fixture
def resource() -> Iterator[MagicMock]:
    cached_table.cache_clear()
    fake = MagicMock(name='dynamodb')
    with patch('shared.ws_repository.get_dynamodb_resource', return_value=fake):
        yield fake
    cached_table.cache_clear()


def test_ws_table_reads_the_tables_environment_variable(resource, monkeypatch):
    monkeypatch.setenv('FEEDBACK_TABLE', 'voc-feedback-dev')
    scoped = ws_table(WS, 'FEEDBACK_TABLE')
    resource.Table.assert_called_once_with('voc-feedback-dev')
    scoped.get_item(Key={'pk': MINE, 'sk': 'ITEM#1'})
    resource.Table.return_value.get_item.assert_called_once_with(Key={'pk': MINE, 'sk': 'ITEM#1'})
    assert scoped.ws == WS


@pytest.mark.parametrize('name', ['WORKSPACES_TABLE', 'WATERMARKS_TABLE', 'IDEMPOTENCY_TABLE', 'voc-feedback'])
def test_ws_table_refuses_a_table_outside_the_registry(resource, monkeypatch, name):
    monkeypatch.setenv('WORKSPACES_TABLE', 'voc-workspaces')
    with pytest.raises(WorkspaceScopeError, match='not a workspace-keyed table'):
        ws_table(WS, name)
    resource.Table.assert_not_called()


@pytest.mark.parametrize('value', [None, ''], ids=['unset', 'empty'])
def test_ws_table_refuses_an_unconfigured_variable(resource, monkeypatch, value):
    if value is None:
        monkeypatch.delenv('FEEDBACK_TABLE', raising=False)
    else:
        monkeypatch.setenv('FEEDBACK_TABLE', value)
    with pytest.raises(ConfigurationError, match='FEEDBACK_TABLE not configured'):
        ws_table(WS, 'FEEDBACK_TABLE')
    resource.Table.assert_not_called()


def _stack_tables() -> dict[str, tuple[str, dict[str, str]]]:
    """lib/stacks/core-stack.ts, per table name (``voc-feedback``): its partition attribute and its indexes'
    partition attributes, each read from that table's own definition."""
    stack = CORE_STACK.read_text(encoding='utf-8')
    tables: dict[str, tuple[str, dict[str, str]]] = {}
    for match in re.finditer(r"this\.(\w+) = this\.createEncryptedTable\('\w+', '([\w-]+)'(.*?)\);", stack, re.DOTALL):
        variable, name, options = match.groups()
        own_key = re.search(r"partitionKey: \{ name: '(\w+)'", options)
        indexes = {index: f'{prefix}pk' for index, prefix in re.findall(
            rf"this\.addKeyPairIndex\(this\.{variable}, \{{ indexName: '([\w-]+)', keyPrefix: '(\w+)' \}}\)", stack)}
        indexes |= dict(re.findall(rf"this\.{variable}\.addGlobalSecondaryIndex\(\{{\s*indexName: '([\w-]+)',\s*"
                                   r"partitionKey: \{ name: '(\w+)'", stack))
        tables[name] = (own_key.group(1) if own_key else 'pk', indexes)
    return tables


#: The core stack's tables that are not keyed by workspace, so not in TABLES, each with its reason.
NOT_WORKSPACE_KEYED = {
    'voc-workspaces': 'the control plane itself: workspaces, members and their audit (docs/multi-workspace.md)',
    'voc-watermarks': 'keyed by `source`, not pk/sk: phase 2 re-keys the ingestion watermarks per workspace before it '
                      'joins TABLES',
    'voc-idempotency': "Powertools' idempotency records, keyed by a hash of the request: no workspace data",
}


def _registry_name(env_var: str) -> str:
    return 'voc-' + env_var.removesuffix('_TABLE').lower().replace('_', '-')


def test_the_registry_is_the_core_stacks_tables_and_indexes_both_ways():
    stack_tables = _stack_tables()
    plain = re.findall(r"new dynamodb\.Table\(this, '\w+', \{\s*tableName: this\.uniqueName\('([\w-]+)'\)",
                       CORE_STACK.read_text(encoding='utf-8'))
    # Every table of the stack is either in the registry or listed above with its reason, and nothing else.
    assert sorted({*stack_tables, *plain}) == sorted({*map(_registry_name, TABLES), *NOT_WORKSPACE_KEYED})
    for env_var, schema in TABLES.items():
        # Equal both ways: an index added to, renamed in or removed from the stack fails here.
        assert stack_tables[_registry_name(env_var)] == (schema.partition_key, dict(schema.indexes)), env_var


# ── ws_s3_key ────────────────────────────────────────────────────────────────

def test_ws_s3_key_builds_a_key_under_the_workspace_prefix():
    assert ws_s3_key(WS, 'raw', 'webscraper', '2026', '01', '15', 'review.json') == (
        f'ws/{WS}/raw/webscraper/2026/01/15/review.json')
    assert ws_s3_key(WS, 'avatars', 'persona.v2.png') == f'ws/{WS}/avatars/persona.v2.png'


@pytest.mark.parametrize('parts', [
    (), ('',), ('raw', ''), ('..', 'secrets'), ('.',), ('raw/../../other',), ('raw', 'a/b'), ('raw\\x',),
    ('raw\nx',), ('raw\x00',), ('raw\x7f',), ('raw\x85x',), ('raw\x9f',),
    (f'raw{LINE_SEPARATOR}x',), (f'raw{PARAGRAPH_SEPARATOR}x',),
], ids=['none', 'empty', 'empty-later', 'dot-dot', 'dot', 'traversal', 'slash', 'backslash', 'newline', 'nul', 'del',
        'c1-next-line', 'c1-last', 'line-separator', 'paragraph-separator'])
def test_ws_s3_key_refuses_traversal_empty_parts_and_control_characters(parts):
    with pytest.raises(WorkspaceScopeError):
        ws_s3_key(WS, *parts)
