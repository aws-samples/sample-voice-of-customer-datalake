"""Mutation hardening for `shared/user_flags.py`.

`test_user_flags.py` proves the fallback-owner invariant end to end on moto,
but it reads results back through the module itself, so a mutation run found
what it cannot see:

* the exact ROWS written: the key shapes (``USERFLAGS#{sub}`` / ``config``,
  ``SETTINGS#fallback_owner``), ``updated_at`` / ``updated_by``, and the
  pointer's condition expression — a mutant that renamed a key or dropped the
  condition still round-trips through `get_user_flags`.
* that every read is ``ConsistentRead=True`` (the transaction's condition is
  only as fresh as the read it guards).
* that a flag is set only by a literal ``True`` and the pointer row wins over a
  stale mirror, both in `set_flags` and in `flags_for_subs`.
* the BatchGetItem paging: 100 keys per page, exactly 5 rounds for a throttled
  table, retrying only the ``UnprocessedKeys``.
* that only a cancelled transaction becomes the 409 message; any other
  ``ClientError`` propagates unchanged.
"""
from typing import Any
from unittest.mock import MagicMock, call, patch

import pytest
from botocore.exceptions import ClientError

from shared import user_flags
from shared.exceptions import ConflictError

TABLE = 'aggregates'
NOW = '2026-01-02T03:04:05+00:00'
POINTER_KEY = {'pk': 'SETTINGS#fallback_owner', 'sk': 'config'}
ALL_FALSE = {'fallback_owner': False, 'memory_reviewer': False}


def _key(sub: str) -> dict[str, str]:
    return {'pk': f'USERFLAGS#{sub}', 'sk': 'config'}


def _fake_table(rows: dict[str, dict]) -> MagicMock:
    """A table whose ``get_item`` serves ``rows`` by pk (the sk is always ``config``)."""
    table = MagicMock(name='table')
    table.name = TABLE

    def get_item(**kwargs: Any) -> dict:
        pk = kwargs['Key']['pk']
        return {'Item': rows[pk]} if pk in rows else {}

    table.get_item.side_effect = get_item
    return table


def _pointer(sub: str) -> dict[str, dict]:
    return {'SETTINGS#fallback_owner': {**POINTER_KEY, 'sub': sub, 'username': f'user-{sub}'}}


def _row(sub: str, **flags: bool) -> dict:
    return {**_key(sub), **ALL_FALSE, **flags, 'updated_at': NOW, 'updated_by': 'admin'}


def _set(table: MagicMock, sub: str, **changes: bool) -> dict[str, bool]:
    with patch.object(user_flags, '_now', return_value=NOW):
        return user_flags.set_flags(table, sub=sub, username=f'user-{sub}', changes=changes, actor_sub='admin')


def _transact_items(table: MagicMock) -> list[dict]:
    transact: MagicMock = table.meta.client.transact_write_items
    transact.assert_called_once()
    return transact.call_args.kwargs['TransactItems']


def _client_error(code: str | None) -> ClientError:
    response: Any = {'Error': {'Code': code, 'Message': 'm'}} if code else {}
    return ClientError(response, 'TransactWriteItems')


class TestReadsAreConsistentAndExact:
    def test_flags_key_shape(self):
        assert user_flags.flags_key('s1') == {'pk': 'USERFLAGS#s1', 'sk': 'config'}

    def test_get_user_flags_reads_the_user_row_consistently(self):
        table = _fake_table({})
        assert user_flags.get_user_flags(table, 's1') == ALL_FALSE
        table.get_item.assert_called_once_with(Key=_key('s1'), ConsistentRead=True)

    @pytest.mark.parametrize(('row', 'expected'), [
        ({'fallback_owner': True, 'memory_reviewer': True}, {'fallback_owner': True, 'memory_reviewer': True}),
        ({'fallback_owner': 1, 'memory_reviewer': 'true'}, ALL_FALSE),
        ({'memory_reviewer': True}, {'fallback_owner': False, 'memory_reviewer': True}),
    ])
    def test_only_a_literal_true_sets_a_flag(self, row, expected):
        table = _fake_table({'USERFLAGS#s1': row})
        assert user_flags.get_user_flags(table, 's1') == expected
        assert user_flags.is_memory_reviewer(table, 's1') is expected['memory_reviewer']

    def test_get_fallback_owner_reads_the_pointer_consistently(self):
        table = _fake_table(_pointer('s1'))
        assert user_flags.get_fallback_owner(table) == {'sub': 's1', 'username': 'user-s1'}
        table.get_item.assert_called_once_with(Key=POINTER_KEY, ConsistentRead=True)

    @pytest.mark.parametrize('item', ['not-a-dict', {}, {'sub': 7}, {'sub': ''}, {'username': 'u'}])
    def test_a_pointer_without_a_sub_means_nobody(self, item):
        table = MagicMock()
        table.get_item.return_value = {'Item': item}
        assert user_flags.get_fallback_owner(table) is None

    @pytest.mark.parametrize('item', [{'sub': 's1'}, {'sub': 's1', 'username': None}, {'sub': 's1', 'username': ''}])
    def test_a_missing_username_reads_as_empty(self, item):
        table = MagicMock()
        table.get_item.return_value = {'Item': item}
        assert user_flags.get_fallback_owner(table) == {'sub': 's1', 'username': ''}


def _dynamodb(pages: list[dict], pointer_sub: str | None = None) -> MagicMock:
    dynamodb = MagicMock(name='dynamodb')
    dynamodb.batch_get_item.side_effect = pages
    dynamodb.Table.return_value = _fake_table(_pointer(pointer_sub) if pointer_sub else {})
    return dynamodb


def _page(*items: dict, unprocessed: dict | None = None) -> dict:
    page: dict[str, Any] = {'Responses': {TABLE: list(items)}}
    if unprocessed is not None:
        page['UnprocessedKeys'] = unprocessed
    return page


def _batch_requests(dynamodb: MagicMock) -> list[list[dict]]:
    return [c.kwargs['RequestItems'][TABLE]['Keys'] for c in dynamodb.batch_get_item.call_args_list]


class TestFlagsForSubsPagesAndBounds:
    def test_no_subs_makes_no_batch_call(self):
        dynamodb = _dynamodb([])
        assert user_flags.flags_for_subs(dynamodb, TABLE, ['', '']) == {}
        dynamodb.batch_get_item.assert_not_called()

    def test_dedupes_drops_empty_and_keeps_order(self):
        dynamodb = _dynamodb([_page({**_key('a'), 'memory_reviewer': True})])
        result = user_flags.flags_for_subs(dynamodb, TABLE, ['b', '', 'a', 'b'])
        dynamodb.batch_get_item.assert_called_once_with(RequestItems={TABLE: {'Keys': [_key('b'), _key('a')]}})
        assert list(result) == ['b', 'a']
        assert result == {'b': ALL_FALSE, 'a': {'fallback_owner': False, 'memory_reviewer': True}}
        dynamodb.Table.assert_called_once_with(TABLE)

    def test_one_hundred_keys_per_page(self):
        subs = [f's{i}' for i in range(201)]
        dynamodb = _dynamodb([_page(), _page(), _page()])
        user_flags.flags_for_subs(dynamodb, TABLE, subs)
        assert _batch_requests(dynamodb) == [
            [_key(s) for s in subs[:100]], [_key(s) for s in subs[100:200]], [_key('s200')],
        ]

    def test_exactly_one_hundred_keys_is_one_page(self):
        dynamodb = _dynamodb([_page()])
        user_flags.flags_for_subs(dynamodb, TABLE, [f's{i}' for i in range(100)])
        assert dynamodb.batch_get_item.call_count == 1

    def test_retries_only_the_unprocessed_keys(self):
        unprocessed = {TABLE: {'Keys': [_key('b')]}}
        dynamodb = _dynamodb([
            _page({**_key('a'), 'memory_reviewer': True}, unprocessed=unprocessed),
            _page({**_key('b'), 'memory_reviewer': True}, unprocessed={}),
        ])
        result = user_flags.flags_for_subs(dynamodb, TABLE, ['a', 'b'])
        assert dynamodb.batch_get_item.call_args_list == [
            call(RequestItems={TABLE: {'Keys': [_key('a'), _key('b')]}}),
            call(RequestItems=unprocessed),
        ]
        assert result['b'] == {'fallback_owner': False, 'memory_reviewer': True}

    def test_a_throttled_table_stops_after_five_rounds(self):
        unprocessed = {TABLE: {'Keys': [_key('a')]}}
        dynamodb = _dynamodb([{'UnprocessedKeys': unprocessed}] * 6)
        assert user_flags.flags_for_subs(dynamodb, TABLE, ['a']) == {'a': ALL_FALSE}
        assert dynamodb.batch_get_item.call_count == 5

    def test_a_row_without_pk_names_no_user(self):
        dynamodb = _dynamodb([_page({'sk': 'config', 'memory_reviewer': True})])
        assert user_flags.flags_for_subs(dynamodb, TABLE, ['XXXX', 'USERFLAGS#']) == {
            'XXXX': ALL_FALSE, 'USERFLAGS#': ALL_FALSE,
        }

    def test_the_pointer_not_the_mirror_names_the_owner(self):
        dynamodb = _dynamodb([_page({**_key('a'), 'fallback_owner': True})], pointer_sub='b')
        assert user_flags.flags_for_subs(dynamodb, TABLE, ['a', 'b']) == {
            'a': ALL_FALSE, 'b': {'fallback_owner': True, 'memory_reviewer': False},
        }

    def test_no_pointer_means_no_owner_even_with_a_stale_mirror(self):
        dynamodb = _dynamodb([_page({**_key('a'), 'fallback_owner': True})])
        assert user_flags.flags_for_subs(dynamodb, TABLE, ['a']) == {'a': ALL_FALSE}


class TestPlainChangesAreOnePut:
    def test_memory_reviewer_change_writes_the_full_row(self):
        table = _fake_table({})
        assert _set(table, 's1', memory_reviewer=True) == {'fallback_owner': False, 'memory_reviewer': True}
        table.put_item.assert_called_once_with(Item=_row('s1', memory_reviewer=True))
        table.meta.client.transact_write_items.assert_not_called()

    def test_unknown_flags_are_ignored(self):
        table = _fake_table({})
        changes: Any = {'admin': True, 'memory_reviewer': True}
        with patch.object(user_flags, '_now', return_value=NOW):
            user_flags.set_flags(table, sub='s1', username='u', changes=changes, actor_sub='admin')
        table.put_item.assert_called_once_with(Item=_row('s1', memory_reviewer=True))

    def test_the_pointer_holder_keeps_the_flag_despite_a_stale_mirror(self):
        table = _fake_table(_pointer('s1'))
        assert _set(table, 's1', fallback_owner=True) == {'fallback_owner': True, 'memory_reviewer': False}
        table.put_item.assert_called_once_with(Item=_row('s1', fallback_owner=True))
        table.meta.client.transact_write_items.assert_not_called()

    def test_a_stale_mirror_does_not_make_an_owner(self):
        table = _fake_table({**_pointer('other'), 'USERFLAGS#s1': {'fallback_owner': True}})
        assert _set(table, 's1') == ALL_FALSE
        table.put_item.assert_called_once_with(Item=_row('s1'))


class TestFallbackOwnerChangesAreOneTransaction:
    def test_first_owner_requires_an_empty_pointer(self):
        table = _fake_table({})
        assert _set(table, 's1', fallback_owner=True) == {'fallback_owner': True, 'memory_reviewer': False}
        assert _transact_items(table) == [
            {'Put': {
                'TableName': TABLE,
                'Item': {**POINTER_KEY, 'sub': 's1', 'username': 'user-s1', 'updated_at': NOW},
                'ConditionExpression': 'attribute_not_exists(pk) OR attribute_not_exists(#s)',
                'ExpressionAttributeNames': {'#s': 'sub'},
            }},
            {'Put': {'TableName': TABLE, 'Item': _row('s1', fallback_owner=True)}},
        ]
        table.put_item.assert_not_called()

    def test_moving_the_owner_clears_the_previous_mirror(self):
        table = _fake_table({**_pointer('p0'), 'USERFLAGS#p0': {'fallback_owner': True, 'memory_reviewer': True}})
        _set(table, 's1', fallback_owner=True)
        assert _transact_items(table) == [
            {'Put': {
                'TableName': TABLE,
                'Item': {**POINTER_KEY, 'sub': 's1', 'username': 'user-s1', 'updated_at': NOW},
                'ConditionExpression': '#s = :prev',
                'ExpressionAttributeNames': {'#s': 'sub'},
                'ExpressionAttributeValues': {':prev': 'p0'},
            }},
            {'Put': {'TableName': TABLE, 'Item': _row('s1', fallback_owner=True)}},
            {'Put': {'TableName': TABLE, 'Item': _row('p0', memory_reviewer=True)}},
        ]

    def test_clearing_keeps_a_pointer_row_without_a_sub(self):
        table = _fake_table(_pointer('s1'))
        assert _set(table, 's1', fallback_owner=False) == ALL_FALSE
        assert _transact_items(table) == [
            {'Put': {
                'TableName': TABLE,
                'Item': {**POINTER_KEY, 'updated_at': NOW},
                'ConditionExpression': '#s = :prev',
                'ExpressionAttributeNames': {'#s': 'sub'},
                'ExpressionAttributeValues': {':prev': 's1'},
            }},
            {'Put': {'TableName': TABLE, 'Item': _row('s1')}},
        ]

    def test_a_cancelled_transaction_is_a_conflict(self):
        table = _fake_table({})
        table.meta.client.transact_write_items.side_effect = _client_error('TransactionCanceledException')
        with pytest.raises(ConflictError) as exc:
            _set(table, 's1', fallback_owner=True)
        assert exc.value.message == 'The fallback owner changed at the same time; reload and try again'

    @pytest.mark.parametrize('code', ['ValidationException', None])
    def test_any_other_client_error_propagates_unchanged(self, code):
        table = _fake_table({})
        error = _client_error(code)
        table.meta.client.transact_write_items.side_effect = error
        with pytest.raises(ClientError) as exc:
            _set(table, 's1', fallback_owner=True)
        assert exc.value is error


class TestClearFallbackOwnerIf:
    @pytest.mark.parametrize('rows', [{}, _pointer('other')])
    def test_not_the_holder_writes_nothing(self, rows):
        table = _fake_table(rows)
        assert user_flags.clear_fallback_owner_if(table, sub='s1', actor_sub='admin') is False
        table.put_item.assert_not_called()
        table.meta.client.transact_write_items.assert_not_called()

    def test_the_holder_is_cleared_by_the_actor(self):
        table = _fake_table(_pointer('s1'))
        with patch.object(user_flags, '_now', return_value=NOW):
            assert user_flags.clear_fallback_owner_if(table, sub='s1', actor_sub='admin') is True
        items = _transact_items(table)
        assert items[0]['Put']['Item'] == {**POINTER_KEY, 'updated_at': NOW}
        assert items[1]['Put']['Item'] == _row('s1')
        assert len(items) == 2
