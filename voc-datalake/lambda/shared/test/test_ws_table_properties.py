"""Properties of the workspace table guard (shared/ws_repo.py ``WorkspaceTable``).

The guard is the last check between a request and another team's rows: a key, item, update, query, scan or
transaction entry outside the scope must be refused before any call reaches DynamoDB, and one inside it must go
through unchanged. The backing table is a recording double, so "nothing reached DynamoDB" is checked directly.
Each refusal is checked by its exact message: it is what the 500's log says, and what tells two refusals apart.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from boto3.dynamodb.conditions import Attr
from hypothesis import given
from hypothesis import strategies as st

from shared.test.ws_properties import KEY_PARTS, PROPERTY, exactly, two_workspace_ids, workspace_ids
from shared.ws_repo import (
    ALLOWED_OPTIONS,
    MAX_TRANSACT_ITEMS,
    PARTITION_ATTRIBUTES,
    OutOfScopeError,
    WorkspaceScope,
    WorkspaceTable,
    ws_table,
)

#: The index partitions an item may carry on a ``pk`` table (``source`` is a plain attribute there).
INDEX_PARTITIONS = tuple(attribute for attribute in PARTITION_ATTRIBUTES if attribute not in ('pk', 'source'))
#: Options no call of the layer takes (each one could widen or redirect the call), and a few made-up ones.
FOREIGN_OPTIONS = ('AttributeUpdates', 'AttributesToGet', 'Bogus', 'ConditionalOperator', 'Expected', 'Item', 'Key',
                   'KeyConditions', 'QueryFilter', 'RequestItems', 'ScanFilter', 'Segment', 'TableName',
                   'TotalSegments')
SINGLE_CALLS = ('get_item', 'put_item', 'delete_item', 'update_item')
ACTIONS = 'Put, Update, Delete, ConditionCheck'
KEY_OUTSIDE = 'a key outside the workspace'


def _backing() -> MagicMock:
    backing = MagicMock()
    backing.name = 'voc-feedback'
    backing.query.return_value = {'Items': []}
    backing.scan.return_value = {'Items': []}
    backing.meta.client.batch_get_item.return_value = {'Responses': {'voc-feedback': []}}
    return backing


def _nothing_sent(backing: MagicMock) -> bool:
    """No call reached the table or its client (building a batch writer is not a call to DynamoDB)."""
    return all(name in ('', 'name', 'batch_writer') or name.startswith('batch_writer().__')
               for name, _args, _kwargs in backing.mock_calls)


@st.composite
def scoped_items(draw: st.DrawFn, scope: WorkspaceScope) -> dict:
    """An item of the scope: its ``pk`` and any of the index partitions inside it, plus plain attributes."""
    item: dict[str, object] = {'pk': scope.key('SOURCE', draw(KEY_PARTS)), 'sk': f'FEEDBACK#{draw(KEY_PARTS)}'}
    for attribute in draw(st.lists(st.sampled_from(INDEX_PARTITIONS), unique=True)):
        item[attribute] = scope.key(attribute.upper(), draw(KEY_PARTS))
    item.update(draw(st.dictionaries(st.sampled_from(['text', 'rating', 'source', 'ttl', 'gsi1sk']),
                                     st.one_of(st.text(max_size=10), st.integers()), max_size=3)))
    return item


@st.composite
def foreign_values(draw: st.DrawFn, mine: WorkspaceScope, theirs: WorkspaceScope) -> object:
    """A partition value outside ``mine``: another workspace's key, a deployment-wide one, ``mine``'s bare prefix,
    its control-plane partition, or not a string at all."""
    return draw(st.sampled_from([
        theirs.key('SOURCE', 'webscraper'), 'SOURCE#webscraper', mine.prefix, f'WS#{mine.ws}', f'AUDIT#WS#{mine.ws}',
        f'X{mine.prefix}SOURCE', None, 7, '', theirs.prefix + mine.prefix,
    ]))


# An item inside the scope is written as given, every partition attribute it carries checked; one partition
# attribute outside it (pk or any index's) refuses the put, the transaction or the batch put before anything is sent.
@PROPERTY
@given(st.data(), two_workspace_ids(), st.sampled_from(('pk', *INDEX_PARTITIONS)))
def test_a_put_is_refused_when_any_partition_is_outside(data, pair, attribute):
    mine, theirs = WorkspaceScope(pair[0]), WorkspaceScope(pair[1])
    item = data.draw(scoped_items(mine))
    backing = _backing()
    ws_table(mine, backing).put_item(item, ConditionExpression='attribute_not_exists(pk)')
    backing.put_item.assert_called_once_with(Item=item, ConditionExpression='attribute_not_exists(pk)')
    with ws_table(mine, backing).batch_writer() as writer:
        writer.put_item(Item=item)
    backing.batch_writer.return_value.put_item.assert_called_once_with(Item=item)

    bad = {**item, attribute: data.draw(foreign_values(mine, theirs))}
    backing = _backing()
    message = KEY_OUTSIDE if attribute == 'pk' else f'{attribute} outside the workspace'
    with pytest.raises(OutOfScopeError, match=exactly(message)):
        ws_table(mine, backing).put_item(bad)
    with pytest.raises(OutOfScopeError, match=exactly(message)):
        ws_table(mine, backing).transact_write_items([{'Put': {'Item': item}}, {'Put': {'Item': bad}}])
    with pytest.raises(OutOfScopeError, match=exactly(message)), ws_table(mine, backing).batch_writer() as writer:
        writer.put_item(Item=bad)
    assert not backing.put_item.called
    assert not backing.meta.client.transact_write_items.called
    assert not backing.batch_writer.return_value.put_item.called


# On voc-watermarks the table is keyed on ``source``: there the ``source`` of every item must be in the scope too,
# while on a ``pk`` table ``source`` is a plain label (an import run's source name) and passes whatever it is.
@PROPERTY
@given(st.data(), two_workspace_ids())
def test_source_is_a_partition_only_on_the_watermarks_table(data, pair):
    mine, theirs = WorkspaceScope(pair[0]), WorkspaceScope(pair[1])
    foreign = data.draw(foreign_values(mine, theirs))
    backing = _backing()
    ws_table(mine, backing).put_item({'pk': mine.key('SOURCE', 'x'), 'sk': 'FEEDBACK#1', 'source': foreign})
    assert backing.put_item.called
    watermark = {'source': mine.key('webscraper', data.draw(KEY_PARTS)), 'value': 1}
    backing = _backing()
    watermarks = ws_table(mine, backing, key='source')
    assert watermarks.key_attribute == 'source'
    watermarks.put_item(watermark)
    watermarks.get_item({'source': watermark['source']})
    with pytest.raises(OutOfScopeError, match=exactly(KEY_OUTSIDE)):
        watermarks.put_item({**watermark, 'source': foreign})
    with pytest.raises(OutOfScopeError, match=exactly('gsi1pk outside the workspace')):
        watermarks.put_item({'source': watermark['source'], 'gsi1pk': foreign})
    with pytest.raises(OutOfScopeError, match=exactly(KEY_OUTSIDE)):
        watermarks.get_item({'pk': watermark['source']})
    assert backing.put_item.call_count == 1
    # voc-watermarks has no sort key: two keys of one ``source`` name one item, whatever else they carry.
    with pytest.raises(ValueError, match=exactly(f"a BatchGetItem names one item twice: source {watermark['source']!r}"
                                                 ', sk None')):
        watermarks.batch_get_item([{'source': watermark['source'], 'sk': 'a'}, {'source': watermark['source'],
                                                                                 'sk': 'b'}])


# A table is keyed on ``pk`` unless it says ``source``; any other key attribute builds no table.
@PROPERTY
@given(workspace_ids(), st.text(max_size=8).filter(lambda key: key not in ('pk', 'source')))
def test_a_table_is_keyed_on_pk_or_source(ws, other):
    scope = WorkspaceScope(ws)
    assert WorkspaceTable(scope, _backing()).key_attribute == 'pk'
    with pytest.raises(ValueError, match=exactly('a data-path table is keyed on pk or source')):
        WorkspaceTable(scope, _backing(), other)


# A key read, deleted or updated is in the scope or the call never happens; a key the scope owns goes through, with
# the options the call takes.
@PROPERTY
@given(st.data(), two_workspace_ids(), st.sampled_from(SINGLE_CALLS))
def test_a_single_key_call_is_refused_outside_the_scope(data, pair, method):
    mine, theirs = WorkspaceScope(pair[0]), WorkspaceScope(pair[1])
    kwargs = {'update_item': {'UpdateExpression': 'SET #t = :t', 'ExpressionAttributeNames': {'#t': 'text'},
                              'ExpressionAttributeValues': {':t': 'x'}},
              'get_item': {'ConsistentRead': True},
              'delete_item': {'ConditionExpression': 'attribute_exists(pk)'},
              'put_item': {'ReturnValues': 'NONE'}}[method]
    key = {'pk': mine.key('SOURCE', data.draw(KEY_PARTS)), 'sk': 'FEEDBACK#1'}
    backing = _backing()
    getattr(ws_table(mine, backing), method)(key, **kwargs)
    getattr(backing, method).assert_called_once_with(**({'Item': key} if method == 'put_item' else {'Key': key}),
                                                     **kwargs)
    backing = _backing()
    with pytest.raises(OutOfScopeError, match=exactly(KEY_OUTSIDE)):
        getattr(ws_table(mine, backing), method)({**key, 'pk': data.draw(foreign_values(mine, theirs))}, **kwargs)
    assert _nothing_sent(backing)


# A call carries only the options listed for it: any more (a ``TableName`` that boto3 would let override the table,
# a legacy condition the layer cannot read, a second key) refuses the call before anything is sent, naming them all.
@PROPERTY
@given(st.data(), workspace_ids(), st.sampled_from(sorted(ALLOWED_OPTIONS)))
def test_an_option_the_call_does_not_take_is_refused(data, ws, method):
    scope = WorkspaceScope(ws)
    foreign = data.draw(st.lists(st.sampled_from([option for option in FOREIGN_OPTIONS
                                                  if option not in ALLOWED_OPTIONS[method]]),
                                 min_size=1, max_size=3, unique=True))
    options = dict.fromkeys(foreign, 'x')
    key = {'pk': scope.key('SOURCE', data.draw(KEY_PARTS)), 'sk': 'FEEDBACK#1'}
    backing = _backing()
    table = ws_table(scope, backing)
    calls = {'query': lambda: table.query('pk', key['pk'], **options),
             'scan': lambda: table.scan(**options),
             'update_item': lambda: table.update_item(key, UpdateExpression='SET a = :a', **options)}
    call = calls.get(method, lambda: getattr(table, method)(key, **options))
    with pytest.raises(OutOfScopeError, match=exactly(f'{method} does not take {", ".join(sorted(foreign))}')):
        call()
    assert _nothing_sent(backing)


#: How an UpdateExpression can touch a partition attribute without a checked ``= :placeholder`` value.
UNCHECKED_UPDATES = ('REMOVE {a}', 'SET {a} = if_not_exists({a}, :v)', 'SET {a} = :v + :w', 'SET {a} = {a}',
                     'SET {a} = list_append({a}, :v)', 'ADD {a} :v', 'DELETE {a} :v', 'SET {a} = :v(x)')


# An update that SETs a partition attribute from one placeholder goes through only when that value is in the scope,
# under the attribute's own name or any alias of it; any other way of touching a partition (REMOVE, if_not_exists,
# arithmetic, a list append, ADD, DELETE) is refused, as its value cannot be checked. Plain attributes are free.
@PROPERTY
@given(st.data(), two_workspace_ids(), st.sampled_from(PARTITION_ATTRIBUTES), st.booleans(),
       st.sampled_from(UNCHECKED_UPDATES), st.sampled_from(['SET #x = :x', 'REMOVE #x', '', 'ADD #x :x']))
def test_an_update_sets_a_partition_only_to_a_value_in_scope(data, pair, attribute, alias, unchecked, plain):
    mine, theirs = WorkspaceScope(pair[0]), WorkspaceScope(pair[1])
    own_value = mine.key(attribute.upper(), data.draw(KEY_PARTS))
    foreign = data.draw(foreign_values(mine, theirs))
    spelling = '#p' if alias else attribute
    names = {'#p': attribute, '#x': 'text'} if alias else {'#x': 'text'}
    key = {'pk': mine.key('SOURCE', 'web'), 'sk': 'FEEDBACK#1'}
    rest = f' {plain}' if plain and not plain.startswith('SET') else (f', {plain[4:]}' if plain else '')

    def update(expression: str, value: object) -> MagicMock:
        backing = _backing()
        ws_table(mine, backing).update_item(key, UpdateExpression=expression, ExpressionAttributeNames=names,
                                            ExpressionAttributeValues={':v': value, ':w': 1, ':x': 'plain'})
        return backing

    assert update(f'SET {spelling} = :v{rest}', own_value).update_item.called
    for expression, value in ((f'SET {spelling} = :v{rest}', foreign), (unchecked.format(a=spelling), own_value)):
        with pytest.raises(OutOfScopeError, match=exactly(f'{attribute} outside the workspace')):
            update(expression, value)
    plain_only = _backing()
    ws_table(mine, plain_only).update_item(key, UpdateExpression=plain or 'SET #x = :x',
                                           ExpressionAttributeNames={'#x': 'text'},
                                           ExpressionAttributeValues={':x': foreign})
    assert plain_only.update_item.called


# An update without an UpdateExpression string is refused: there is nothing the guard could check.
@PROPERTY
@given(workspace_ids(), st.one_of(st.none(), st.integers(), st.lists(st.text(max_size=3), max_size=2)))
def test_an_update_needs_its_expression(ws, expression):
    scope = WorkspaceScope(ws)
    backing = _backing()
    kwargs = {} if expression is None else {'UpdateExpression': expression}
    with pytest.raises(OutOfScopeError, match=exactly('an update needs an UpdateExpression')):
        ws_table(scope, backing).update_item({'pk': scope.key('A'), 'sk': 'B'}, **kwargs)
    assert _nothing_sent(backing)


# A query reads one partition of the scope, under a key condition the layer builds; a partition outside it, a key
# condition of the caller's, or a cursor naming any partition outside the scope is refused before any call. Paged
# (``iter_query``), every page is the same query, its sort condition included.
@PROPERTY
@given(st.data(), two_workspace_ids(), st.sampled_from(PARTITION_ATTRIBUTES), st.sampled_from(PARTITION_ATTRIBUTES))
def test_a_query_reads_one_partition_of_the_scope(data, pair, attribute, cursor_attribute):
    mine, theirs = WorkspaceScope(pair[0]), WorkspaceScope(pair[1])
    partition = mine.key(attribute.upper(), data.draw(KEY_PARTS))
    cursor = {'pk': mine.key('SOURCE', 'x'), 'sk': 'FEEDBACK#1', cursor_attribute: mine.key('C', 'y')}
    backing = _backing()
    ws_table(mine, backing).query(attribute, partition, sort_condition='begins_with(sk, :s)',
                                  ExpressionAttributeValues={':s': 'FEEDBACK#'}, ExclusiveStartKey=cursor)
    expected = {'KeyConditionExpression': '#p = :p AND begins_with(sk, :s)',
                'ExpressionAttributeNames': {'#p': attribute},
                'ExpressionAttributeValues': {':s': 'FEEDBACK#', ':p': partition}}
    assert backing.query.call_args.kwargs == {**expected, 'ExclusiveStartKey': cursor}

    backing = _backing()
    backing.query.side_effect = [{'Items': [{'n': 1}], 'LastEvaluatedKey': cursor}, {'Items': [{'n': 2}]}]
    rows = list(ws_table(mine, backing).iter_query(attribute, partition, sort_condition='begins_with(sk, :s)',
                                                   ExpressionAttributeValues={':s': 'FEEDBACK#'}))
    assert rows == [{'n': 1}, {'n': 2}]
    assert [call.kwargs for call in backing.query.call_args_list] == [expected, {**expected, 'ExclusiveStartKey': cursor}]

    foreign = data.draw(foreign_values(mine, theirs))
    backing = _backing()
    table = ws_table(mine, backing)
    for call, message in ((lambda: table.query(attribute, foreign), 'a query outside the workspace'),
                          (lambda: table.query(attribute, partition, KeyConditionExpression='#p = :p'),
                           'the key condition is built by the layer'),
                          (lambda: table.query(attribute, partition,
                                               ExclusiveStartKey={**cursor, cursor_attribute: foreign}),
                           'a cursor outside the workspace'),
                          (lambda: table.query(attribute, partition, ExclusiveStartKey=[('pk', partition)]),
                           'a cursor outside the workspace')):
        with pytest.raises(OutOfScopeError, match=exactly(message)):
            call()
    assert _nothing_sent(backing)


# A scan answers the scope's rows only: its filter is the scope's prefix ANDed with the caller's condition; a cursor
# names only the table's own key with string values; a string filter, or a returned row outside the scope (which
# the filter rules out), is refused rather than handed to the caller.
@PROPERTY
@given(st.data(), two_workspace_ids(), st.sampled_from(['pk', 'source']), st.booleans())
def test_a_scan_answers_the_scope_rows_only(data, pair, key, with_filter):
    mine, theirs = WorkspaceScope(pair[0]), WorkspaceScope(pair[1])
    rows = [{key: mine.key('SOURCE', part)} for part in data.draw(st.lists(KEY_PARTS, max_size=3))]
    backing = _backing()
    backing.scan.return_value = {'Items': rows}
    caller_filter = Attr('rating').gt(2)
    cursor = {key: theirs.key('SOURCE', 'z'), **({'sk': 'FEEDBACK#9'} if key == 'pk' else {})}
    table = ws_table(mine, backing, key=key)
    answer = table.scan(ExclusiveStartKey=cursor, **({'FilterExpression': caller_filter} if with_filter else {}))
    assert answer['Items'] == rows
    scoped = Attr(key).begins_with(mine.prefix)
    assert backing.scan.call_args.kwargs == {
        'FilterExpression': scoped & caller_filter if with_filter else scoped, 'ExclusiveStartKey': cursor}

    backing.scan.return_value = {'Items': [*rows, {key: data.draw(foreign_values(mine, theirs))}]}
    with pytest.raises(OutOfScopeError, match=exactly('a scanned row outside the workspace')):
        table.scan()
    calls = backing.scan.call_count
    with pytest.raises(OutOfScopeError, match=exactly('a scan filter through the workspace layer is a boto3 condition')):
        table.scan(FilterExpression='begins_with(pk, :p)')
    other = 'source' if key == 'pk' else 'pk'
    for bad in ({**cursor, 'gsi1pk': 'x'}, {}, {key: 7}, {other: 'x'}, [(key, 'x')]):
        with pytest.raises(OutOfScopeError, match=exactly('a scan cursor names the table key only')):
            table.scan(ExclusiveStartKey=bad)
    assert backing.scan.call_count == calls


@st.composite
def transact_entries(draw: st.DrawFn, scope: WorkspaceScope) -> list[dict]:
    """1 to 6 transaction entries of the scope, each naming its own item."""
    count = draw(st.integers(min_value=1, max_value=6))
    entries = []
    for index in range(count):
        key = {'pk': scope.key('SOURCE', draw(KEY_PARTS)), 'sk': f'FEEDBACK#{index}'}
        action = draw(st.sampled_from(['Put', 'Update', 'Delete', 'ConditionCheck']))
        if action == 'Put':
            entries.append({'Put': {'Item': {**key, 'text': 'x'}}})
        elif action == 'Update':
            entries.append({'Update': {'Key': key, 'UpdateExpression': 'SET #t = :t',
                                       'ExpressionAttributeNames': {'#t': 'text'},
                                       'ExpressionAttributeValues': {':t': 'x'}}})
        elif action == 'Delete':
            entries.append({'Delete': {'Key': key}})
        else:
            entries.append({'ConditionCheck': {'Key': key, 'ConditionExpression': 'attribute_exists(pk)'}})
    return entries


def _poison(entry: dict, foreign: object) -> dict:
    [(action, body)] = entry.items()
    if action == 'Put':
        return {action: {**body, 'Item': {**body['Item'], 'pk': foreign}}}
    return {action: {**body, 'Key': {**body['Key'], 'pk': foreign}}}


# A transaction is all in the scope or not sent: each entry is checked as its single call is, the view names its
# own table in each, and one entry outside the scope, one naming a table, one with an option it does not take, or
# one item named twice refuses the whole transaction before anything is written.
@PROPERTY
@given(st.data(), two_workspace_ids())
def test_a_transaction_is_all_in_scope_or_not_sent(data, pair):
    mine, theirs = WorkspaceScope(pair[0]), WorkspaceScope(pair[1])
    entries = data.draw(transact_entries(mine))
    backing = _backing()
    table = ws_table(mine, backing)
    table.transact_write_items(entries, ClientRequestToken='t')
    sent = backing.meta.client.transact_write_items.call_args.kwargs
    assert sent == {'TransactItems': [{action: {**body, 'TableName': 'voc-feedback'}}
                                      for entry in entries for action, body in entry.items()],
                    'ClientRequestToken': 't'}

    backing = _backing()
    table = ws_table(mine, backing)
    position = data.draw(st.integers(min_value=0, max_value=len(entries) - 1))
    [(action, body)] = entries[position].items()
    first = entries[0]['Put']['Item'] if 'Put' in entries[0] else next(iter(entries[0].values()))['Key']
    refusals = [
        ([*entries[:position], _poison(entries[position], data.draw(foreign_values(mine, theirs))),
          *entries[position + 1:]], {}, OutOfScopeError, KEY_OUTSIDE),
        ([*entries[:position], {action: {**body, 'TableName': 'voc-other'}}, *entries[position + 1:]], {},
         OutOfScopeError, 'a transaction entry never names its table: the view sends it to its own'),
        ([*entries[:position], {action: {**body, 'Expected': {}, 'AttributeUpdates': {}}}, *entries[position + 1:]],
         {}, OutOfScopeError, f'a {action} entry does not take AttributeUpdates, Expected'),
        ([*entries, entries[0]], {}, ValueError,
         f"a TransactWriteItems names one item twice: pk {first['pk']!r}, sk {first['sk']!r}"),
        ([], {}, ValueError, 'a TransactWriteItems takes 1 to 100 entries, not 0'),
        (entries, {'TableName': 'voc-other'}, OutOfScopeError,
         'a TransactWriteItems never names its table: the view sends it to its own'),
        (entries, {'ReturnValues': 'ALL_OLD', 'Bogus': 1}, ValueError,
         'a TransactWriteItems through the workspace layer does not take Bogus, ReturnValues'),
        ([{'Put': body, 'Delete': body}], {}, ValueError, f'a transaction entry is one of {ACTIONS}'),
        ([{'Get': body}], {}, ValueError, f'a transaction entry is one of {ACTIONS}'),
        ([{action: 'not a mapping'}], {}, ValueError, f'a transaction entry is one of {ACTIONS}'),
        (['Put'], {}, ValueError, f'a transaction entry is one of {ACTIONS}'),
        ([{'Put': {}}], {}, ValueError, 'a Put entry needs its Item'),
        ([{'Delete': {'Key': 'x'}}], {}, ValueError, 'a Delete entry needs its Key'),
        ([{'ConditionCheck': {'Key': {'pk': mine.key('A'), 'sk': 'b'}}}], {}, ValueError,
         'a ConditionCheck entry needs its ConditionExpression'),
    ]
    for items, options, error, message in refusals:
        with pytest.raises(error, match=exactly(message)):
            table.transact_write_items(items, **options)
    assert not backing.meta.client.transact_write_items.called


# A transaction takes up to DynamoDB's 100 entries, and not one more (the edge itself: three sizes, no generator).
@pytest.mark.parametrize('size', [MAX_TRANSACT_ITEMS - 1, MAX_TRANSACT_ITEMS, MAX_TRANSACT_ITEMS + 1])
def test_a_transaction_takes_up_to_a_hundred_entries(size):
    ws = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
    scope = WorkspaceScope(ws)
    backing = _backing()
    entries = [{'Delete': {'Key': {'pk': scope.key('SOURCE', 'x'), 'sk': f'FEEDBACK#{n}'}}} for n in range(size)]
    if size <= MAX_TRANSACT_ITEMS:
        ws_table(scope, backing).transact_write_items(entries)
        assert len(backing.meta.client.transact_write_items.call_args.kwargs['TransactItems']) == size
    else:
        with pytest.raises(ValueError, match=exactly(f'a TransactWriteItems takes 1 to 100 entries, not {size}')):
            ws_table(scope, backing).transact_write_items(entries)
        assert not backing.meta.client.transact_write_items.called


# A batch read names only keys of the scope, none twice: one key outside it or one key twice refuses the read
# before any BatchGetItem is sent.
@PROPERTY
@given(st.data(), two_workspace_ids(), st.lists(KEY_PARTS, min_size=1, max_size=5, unique=True))
def test_a_batch_read_names_keys_of_the_scope_once(data, pair, parts):
    mine, theirs = WorkspaceScope(pair[0]), WorkspaceScope(pair[1])
    keys = [{'pk': mine.key('SOURCE', part), 'sk': 'FEEDBACK#1'} for part in parts]
    backing = _backing()
    table = ws_table(mine, backing)
    assert table.batch_get_item(keys, ProjectionExpression='pk') == []
    sent = backing.meta.client.batch_get_item.call_args.kwargs['RequestItems']['voc-feedback']
    assert sent == {'ConsistentRead': True, 'ProjectionExpression': 'pk', 'Keys': keys}
    backing = _backing()
    table = ws_table(mine, backing)
    position = data.draw(st.integers(min_value=0, max_value=len(keys) - 1))
    with pytest.raises(OutOfScopeError, match=exactly(KEY_OUTSIDE)):
        table.batch_get_item([*keys, {**keys[position], 'pk': data.draw(foreign_values(mine, theirs))}])
    twice = keys[position]
    with pytest.raises(ValueError, match=exactly(f"a BatchGetItem names one item twice: pk {twice['pk']!r}, "
                                                 f"sk {twice['sk']!r}")):
        table.batch_get_item([*keys, dict(twice)])
    with pytest.raises(OutOfScopeError, match=exactly('a BatchGetItem never names its table: the view sends it to '
                                                      'its own')):
        table.batch_get_item(keys, TableName='voc-other')
    with pytest.raises(ValueError, match=exactly('a BatchGetItem through the workspace layer does not take Bogus, '
                                                 'Limit')):
        table.batch_get_item(keys, Limit=1, Bogus=2)
    assert not backing.meta.client.batch_get_item.called


# A batch writer only puts: a delete through it is refused (one key at a time goes through ``delete_item``).
@PROPERTY
@given(workspace_ids(), KEY_PARTS)
def test_a_batch_writer_refuses_a_delete(ws, part):
    scope = WorkspaceScope(ws)
    backing = _backing()
    with pytest.raises(OutOfScopeError, match=exactly('a batch delete is not part of the workspace layer yet: delete '
                                                      'one key at a time with WorkspaceTable.delete_item')), \
            ws_table(scope, backing).batch_writer() as writer:
        writer.delete_item(Key={'pk': scope.key('SOURCE', part), 'sk': 'FEEDBACK#1'})
    assert not backing.batch_writer.return_value.delete_item.called


# A table's scope, key and handle are fixed once built: nothing can be set or deleted on it.
@PROPERTY
@given(two_workspace_ids(), st.sampled_from(['_scope', '_key_attribute', '_unscoped_table', 'scope', 'other']))
def test_a_table_cannot_be_changed(pair, name):
    mine, theirs = WorkspaceScope(pair[0]), WorkspaceScope(pair[1])
    table = ws_table(mine, _backing())
    with pytest.raises(AttributeError, match=exactly('a WorkspaceTable cannot be changed')):
        setattr(table, name, theirs)
    with pytest.raises(AttributeError, match=exactly('a WorkspaceTable cannot be changed')):
        delattr(table, name)
    assert table.scope == mine
    assert table.key_attribute == 'pk'
