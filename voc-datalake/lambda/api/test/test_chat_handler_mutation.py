"""Mutation hardening for `api/chat_handler.py`.

`test_chat_assistant_sessions.py` and `test_chat_handler.py` pin that a save is
validated, scoped to the caller and round-trips, but a mutation run found what
they cannot see:

* the WORDING of every refusal. A `ValidationError` reaches the SPA as the 400
  body, and the 413 message is what the assistant's trim-and-retry path shows
  when a thread cannot be shortened enough; every message is pinned here as a
  literal.
* the ACCEPTED side of the item-size bound: an item estimated at exactly
  350 000 bytes saves and one byte more is refused, measured in UTF-8 (not in
  `\\uXXXX` escapes, which would refuse a thread of CJK text that fits).
* the exact DynamoDB arguments the fake table ignores: the projection of the
  list Query and of the `created_at` read, the key-condition attribute name,
  and the blobs' raw-UTF-8 compact encoding.
* the cold-start module state: `CONVERSATIONS_TABLE` read from the environment
  (the table is `None` when it is unset), and the lambda root placed FIRST on
  `sys.path` so `shared` resolves to the bundled package.
* every default a stored record can be missing (`title`, `message_count`,
  `created_at`/`updated_at`) and every non-list / non-number shape that must
  degrade to the documented zero, not to a 500.
"""
import importlib
import os
import sys
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from aws_lambda_powertools.event_handler.exceptions import NotFoundError
from boto3.dynamodb.conditions import ConditionExpressionBuilder
from test_chat_assistant_sessions import USER_A, FakeConversationsTable, _as, _body, _save

import chat_handler
from shared.exceptions import ConfigurationError, PayloadTooLargeError, ValidationError

FIXED_NOW = '2026-10-05T12:00:00.000001+00:00'
PK_A = f'USER#{USER_A}'


@pytest.fixture
def table():
    fake = FakeConversationsTable()
    original = chat_handler.conversations_table
    chat_handler.conversations_table = fake
    yield fake
    chat_handler.conversations_table = original


@pytest.fixture
def fixed_now():
    with patch.object(chat_handler, '_now_iso', return_value=FIXED_NOW):
        yield FIXED_NOW


def _legacy_item(**overrides) -> dict:
    item = {
        'pk': PK_A, 'sk': 'CONV#old', 'conversation_id': 'old', 'title': 'Old',
        'messages': [{'role': 'user', 'content': 'hi'}], 'filters': {'days': 7},
        'created_at': '2026-01-01T00:00:00+00:00', 'updated_at': '2026-01-02T00:00:00+00:00',
    }
    item.update(overrides)
    return item


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize(('overrides', 'message'), [
        ({'title': 5}, 'title must be a string'),
        ({'title': 'x' * 121}, 'title must be at most 120 characters'),
        ({'messages': ['not-an-object']}, 'messages must be a list of objects'),
        ({'messages': {'role': 'user'}}, 'messages must be a list of objects'),
        ({'pendingInterrupts': 'nope'}, 'pendingInterrupts must be a list of objects'),
        ({'pendingInterrupts': [{}] * 21}, 'pendingInterrupts must contain at most 20 entries'),
        ({'page': 'projects'}, 'page must be an object or null'),
        ({'createdAt': 'yesterday'}, 'createdAt must be an ISO-8601 timestamp'),
        ({'createdAt': 5}, 'createdAt must be an ISO-8601 timestamp'),
        ({'createdAt': ''}, 'createdAt must be an ISO-8601 timestamp'),
        ({'kind': 'chat'}, "kind must be 'assistant'"),
        ({'id': 'has space'}, 'id must match ^[A-Za-z0-9_-]{1,64}$'),
        ({'id': None}, 'id must match ^[A-Za-z0-9_-]{1,64}$'),
    ])
    def test_a_rejected_assistant_save_says_exactly_why(self, table, overrides, message):
        body = _body(**overrides)
        with pytest.raises(ValidationError) as raised:
            _save(USER_A, body, proxy=str(body['id']))
        assert raised.value.message == message
        assert table.put_calls == 0

    @pytest.mark.parametrize('proxy', ['conv_2', '', '  '])
    def test_an_id_that_differs_from_the_path_segment_is_refused(self, table, proxy):
        with pytest.raises(ValidationError) as raised:
            _save(USER_A, _body(conv_id='conv_1'), proxy=proxy)
        assert raised.value.message == 'id must equal the conversation id in the path'
        assert table.put_calls == 0

    def test_the_path_segment_is_compared_after_stripping(self, table):
        result = _save(USER_A, _body(conv_id='conv_1'), proxy=' conv_1 ')
        assert result['id'] == 'conv_1'
        assert table.put_calls == 1

    def test_too_many_messages_is_a_413_naming_the_bound(self, table):
        with pytest.raises(PayloadTooLargeError) as raised:
            _save(USER_A, _body(messages=[{'role': 'user'}] * 301))
        assert raised.value.message == 'messages must contain at most 300 entries'
        assert table.put_calls == 0

    def test_a_non_object_body_is_refused(self, table):
        with _as(USER_A, body=['not', 'an', 'object']), pytest.raises(ValidationError) as raised:
            chat_handler.save_conversation(conversation_id='conv_1')
        assert raised.value.message == 'Request body must be a JSON object'
        assert table.put_calls == 0

    @pytest.mark.usefixtures('table')
    def test_an_unknown_list_kind_names_both_accepted_values(self):
        with _as(USER_A, query={'kind': 'nope'}), pytest.raises(ValidationError) as raised:
            chat_handler.get_conversations(conversation_id='_list')
        assert raised.value.message == "kind must be 'assistant' or 'chat'"

    @pytest.mark.parametrize('bad_id', ['a/b', '', 'x' * 65])
    def test_a_malformed_or_empty_id_on_delete_is_the_fixed_not_found_text(self, table, bad_id):
        table.delete_item = MagicMock(side_effect=AssertionError('must not delete'))
        with _as(USER_A), pytest.raises(NotFoundError) as raised:
            chat_handler.delete_conversation(conversation_id=bad_id)
        assert raised.value.msg == 'Conversation not found'


class TestTheItemSizeBoundIsMeasuredInUtf8Bytes:
    """Exactly 350 000 estimated bytes saves; 350 001 is refused with the fixed
    message. The padding is CJK, so an estimate in `\\uXXXX` escapes (6 bytes a
    character instead of 3) would refuse the item that fits."""

    @staticmethod
    def _body_with_estimated_bytes(table, target: int) -> dict:
        """A save body whose stored item the module estimates at exactly `target` bytes:
        a probe save measures the fixed overhead, CJK padding (3 bytes each) and a
        few ASCII bytes make up the rest."""
        probe = _body(conv_id='big', createdAt=FIXED_NOW, messages=[{'role': 'user', 'content': ''}])
        _save(USER_A, probe)
        base = chat_handler._estimated_item_bytes(table.items[(PK_A, 'CONV#big')])
        table.items.clear()
        table.put_calls = 0
        padding, remainder = divmod(target - base, 3)
        content = '字' * padding + 'x' * remainder
        return _body(conv_id='big', createdAt=FIXED_NOW, messages=[{'role': 'user', 'content': content}])

    @pytest.mark.usefixtures('fixed_now')
    def test_an_item_of_exactly_350_000_bytes_saves(self, table):
        body = self._body_with_estimated_bytes(table, 350_000)
        result = _save(USER_A, body)
        assert result == {'success': True, 'id': 'big', 'updatedAt': FIXED_NOW, 'revision': 0}
        assert chat_handler._estimated_item_bytes(table.items[(PK_A, 'CONV#big')]) == 350_000

    @pytest.mark.usefixtures('fixed_now')
    def test_one_byte_more_is_refused_with_the_fixed_message(self, table):
        body = self._body_with_estimated_bytes(table, 350_001)
        with pytest.raises(PayloadTooLargeError) as raised:
            _save(USER_A, body)
        assert raised.value.message == (
            'Conversation is too large to save (limit about 350000 bytes); start a new conversation'
        )
        assert table.put_calls == 0

    def test_the_estimate_counts_utf8_bytes_of_the_compact_json(self):
        assert chat_handler._estimated_item_bytes({'k': '字'}) == 12


class TestTheStoredItemIsExactlyTheDocumentedShape:
    @pytest.mark.usefixtures('fixed_now')
    def test_blobs_are_compact_raw_utf8_json(self, table):
        body = _body(
            conv_id='c1', createdAt='2026-01-01T00:00:00Z',
            messages=[{'role': 'user', 'content': '字 1.5'}],
            page={'kind': 'project', 'name': 'é'},
            pendingInterrupts=[{'id': 'approval:1', 'note': 'ü'}],
        )
        _save(USER_A, body)
        assert table.items[(PK_A, 'CONV#c1')] == {
            'pk': PK_A,
            'sk': 'CONV#c1',
            'conversation_id': 'c1',
            'kind': 'assistant',
            'title': 'Churn deep-dive',
            'messages_json': '[{"role":"user","content":"字 1.5"}]',
            'page_json': '{"kind":"project","name":"é"}',
            'pending_json': '[{"id":"approval:1","note":"ü"}]',
            'message_count': 1,
            'created_at': '2026-01-01T00:00:00Z',
            'updated_at': FIXED_NOW,
        }

    @pytest.mark.usefixtures('fixed_now')
    def test_a_fresh_item_without_created_at_in_the_body_is_created_now(self, table):
        _save(USER_A, _body(conv_id='c1'))
        item = table.items[(PK_A, 'CONV#c1')]
        assert item['created_at'] == FIXED_NOW
        assert item['updated_at'] == FIXED_NOW

    @pytest.mark.usefixtures('fixed_now')
    def test_the_existing_state_read_projects_only_created_at_and_the_run_fields(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {'Item': {'created_at': '2025-12-31T00:00:00+00:00'}}
        with patch.object(chat_handler, 'conversations_table', mock_table):
            chat_handler._save_assistant_conversation(PK_A, 'c1', _body(conv_id='c1'))
        mock_table.get_item.assert_called_once_with(
            Key={'pk': PK_A, 'sk': 'CONV#c1'},
            ProjectionExpression='#created, #updated, #rid, #rs, #rev',
            ExpressionAttributeNames={
                '#created': 'created_at', '#updated': 'updated_at',
                '#rid': 'run_id', '#rs': 'run_status', '#rev': 'revision',
            },
        )
        assert mock_table.put_item.call_args.kwargs['Item']['created_at'] == '2025-12-31T00:00:00+00:00'

    @pytest.mark.parametrize('stored', [5, Decimal('5'), '', None])
    def test_a_stored_created_at_that_is_not_a_string_is_not_borrowed(self, table, stored):
        _save(USER_A, _body(conv_id='c1'))
        table.items[(PK_A, 'CONV#c1')]['created_at'] = stored
        _save(USER_A, _body(conv_id='c1', createdAt='2026-02-02T00:00:00Z'))
        assert table.items[(PK_A, 'CONV#c1')]['created_at'] == '2026-02-02T00:00:00Z'

    def test_a_timestamp_with_a_z_suffix_is_an_iso_timestamp(self):
        assert chat_handler._is_iso_timestamp('2026-01-01T00:00:00Z') is True
        assert chat_handler._is_iso_timestamp('2026-01-01T00:00:00.123+02:00') is True
        assert chat_handler._is_iso_timestamp('2026-01-01T00:00:00ZZ') is False


class TestTheLegacySaveIsByteForByte:
    def test_a_generated_id_is_conv_plus_a_20_digit_utc_stamp(self, table):
        with _as(USER_A, body={'title': 'T'}):
            result = chat_handler.save_conversation(conversation_id='new')
        generated = result['id']
        assert generated.startswith('conv-')
        assert len(generated) == len('conv-') + 20
        assert generated[len('conv-'):].isdigit()
        assert generated[len('conv-'):][:4] == '2026'
        assert table.items[(PK_A, f'CONV#{generated}')]['conversation_id'] == generated

    def test_every_default_of_the_old_shape(self, table):
        with _as(USER_A, body={'id': 'legacy-1'}):
            result = chat_handler.save_conversation(conversation_id='legacy-1')
        assert result == {'success': True, 'id': 'legacy-1'}
        item = table.items[(PK_A, 'CONV#legacy-1')]
        assert item['title'] == 'New Conversation'
        assert item['messages'] == []
        assert item['filters'] == {}
        assert chat_handler._is_iso_timestamp(item['created_at']) is True
        assert chat_handler._is_iso_timestamp(item['updated_at']) is True
        assert set(item) == {'pk', 'sk', 'conversation_id', 'title', 'messages', 'filters',
                             'created_at', 'updated_at'}

    def test_every_field_of_the_body_is_stored_under_its_own_name(self, table):
        body = {
            'id': 'legacy-1', 'title': 'Old chat', 'messages': [{'role': 'user', 'content': 'hi'}],
            'filters': {'days': 7, 'source': 'webscraper'}, 'createdAt': '2020-01-01T00:00:00Z',
        }
        with _as(USER_A, body=body), patch.object(chat_handler, 'datetime') as fake_datetime:
            fake_datetime.now.return_value.isoformat.return_value = FIXED_NOW
            chat_handler.save_conversation(conversation_id='legacy-1')
        assert table.items[(PK_A, 'CONV#legacy-1')] == {
            'pk': PK_A, 'sk': 'CONV#legacy-1', 'conversation_id': 'legacy-1', 'title': 'Old chat',
            'messages': [{'role': 'user', 'content': 'hi'}],
            'filters': {'days': 7, 'source': 'webscraper'},
            'created_at': '2020-01-01T00:00:00Z', 'updated_at': FIXED_NOW,
        }


class TestEveryReadShapeAndItsDefaults:
    def test_an_assistant_detail_is_exactly_the_documented_shape(self, table):
        table.items[(PK_A, 'CONV#a1')] = {
            'pk': PK_A, 'sk': 'CONV#a1', 'conversation_id': 'a1', 'kind': 'assistant',
            'title': 'T', 'messages_json': '[{"id":"m1"}]', 'page_json': '{"kind":"dashboard"}',
            'pending_json': '[{"id":"i1"}]', 'message_count': 1,
            'created_at': '2026-01-01T00:00:00+00:00', 'updated_at': '2026-01-02T00:00:00+00:00',
        }
        with _as(USER_A):
            result = chat_handler.get_conversations(conversation_id='a1')
        assert result == {
            'id': 'a1', 'title': 'T', 'kind': 'assistant', 'messages': [{'id': 'm1'}],
            'page': {'kind': 'dashboard'}, 'pendingInterrupts': [{'id': 'i1'}],
            'createdAt': '2026-01-01T00:00:00+00:00', 'updatedAt': '2026-01-02T00:00:00+00:00',
            'runStatus': None, 'runId': None, 'revision': 0,
        }

    def test_an_assistant_item_missing_every_optional_attribute_reads_with_defaults(self, table):
        table.items[(PK_A, 'CONV#a1')] = {
            'pk': PK_A, 'sk': 'CONV#a1', 'conversation_id': 'a1', 'kind': 'assistant',
        }
        with _as(USER_A):
            result = chat_handler.get_conversations(conversation_id='a1')
        assert result == {
            'id': 'a1', 'title': 'New conversation', 'kind': 'assistant', 'messages': [],
            'page': None, 'pendingInterrupts': [], 'createdAt': None, 'updatedAt': None,
            'runStatus': None, 'runId': None, 'revision': 0,
        }

    @pytest.mark.parametrize(('attribute', 'stored', 'key', 'expected'), [
        ('messages_json', '{"not":"a list"}', 'messages', []),
        ('page_json', '["not an object"]', 'page', None),
        ('pending_json', '"text"', 'pendingInterrupts', []),
        ('messages_json', 7, 'messages', []),
    ])
    def test_a_blob_of_the_wrong_json_type_degrades_to_the_default(
        self, table, attribute, stored, key, expected,
    ):
        _save(USER_A, _body(conv_id='c1'))
        table.items[(PK_A, 'CONV#c1')][attribute] = stored
        with _as(USER_A):
            result = chat_handler.get_conversations(conversation_id='c1')
        assert result[key] == expected

    def test_a_corrupt_blob_is_logged_once_with_the_fixed_text(self, table):
        _save(USER_A, _body(conv_id='c1'))
        table.items[(PK_A, 'CONV#c1')]['page_json'] = '{broken'
        with _as(USER_A), patch.object(chat_handler.logger, 'warning') as warning:
            result = chat_handler.get_conversations(conversation_id='c1')
        assert result['page'] is None
        warning.assert_called_once_with(
            'Stored conversation blob is not valid JSON; returning a fallback',
        )

    def test_a_legacy_detail_is_exactly_the_documented_shape(self, table):
        table.items[(PK_A, 'CONV#old')] = _legacy_item()
        with _as(USER_A):
            result = chat_handler.get_conversations(conversation_id='old')
        assert result == {
            'id': 'old', 'title': 'Old', 'kind': 'chat',
            'messages': [{'role': 'user', 'content': 'hi'}], 'filters': {'days': 7},
            'page': None, 'pendingInterrupts': [],
            'createdAt': '2026-01-01T00:00:00+00:00', 'updatedAt': '2026-01-02T00:00:00+00:00',
        }

    def test_a_legacy_item_missing_every_optional_attribute_reads_with_defaults(self, table):
        table.items[(PK_A, 'CONV#old')] = {'pk': PK_A, 'sk': 'CONV#old', 'conversation_id': 'old'}
        with _as(USER_A):
            result = chat_handler.get_conversations(conversation_id='old')
        assert result == {
            'id': 'old', 'title': 'New Conversation', 'kind': 'chat', 'messages': [],
            'filters': {}, 'page': None, 'pendingInterrupts': [],
            'createdAt': None, 'updatedAt': None,
        }

    def test_a_requested_id_is_stripped_before_the_lookup(self, table):
        table.items[(PK_A, 'CONV#old')] = _legacy_item()
        with _as(USER_A):
            assert chat_handler.get_conversations(conversation_id=' old ')['id'] == 'old'


class TestTheListSummaryAndItsQuery:
    def test_the_query_names_the_key_attribute_and_projects_exactly_the_summary_fields(self):
        mock_table = MagicMock()
        # One page and no LastEvaluatedKey: a second Query (StopIteration) is the
        # walk failing to stop, which must fail here rather than spin forever.
        mock_table.query.side_effect = [{'Items': []}]
        with _as(USER_A), patch.object(chat_handler, 'conversations_table', mock_table):
            assert chat_handler.get_conversations(conversation_id='_list') == {'conversations': []}
        kwargs = mock_table.query.call_args.kwargs
        built = ConditionExpressionBuilder().build_expression(kwargs['KeyConditionExpression'])
        assert built.condition_expression == '#n0 = :v0'
        assert built.attribute_name_placeholders == {'#n0': 'pk'}
        assert built.attribute_value_placeholders == {':v0': PK_A}
        assert kwargs['ProjectionExpression'] == '#cid, #title, #kind, #mc, #created, #updated, #msgs, #rs'
        assert kwargs['ExpressionAttributeNames'] == {
            '#cid': 'conversation_id', '#title': 'title', '#kind': 'kind', '#mc': 'message_count',
            '#created': 'created_at', '#updated': 'updated_at', '#msgs': 'messages', '#rs': 'run_status',
        }
        assert 'ExclusiveStartKey' not in kwargs
        mock_table.query.assert_called_once()

    def test_a_second_page_starts_exactly_at_the_last_evaluated_key(self):
        mock_table = MagicMock()
        mock_table.query.side_effect = [
            {'Items': [], 'LastEvaluatedKey': {'pk': PK_A, 'sk': 'CONV#m'}},
            {'Items': []},
        ]
        with _as(USER_A), patch.object(chat_handler, 'conversations_table', mock_table):
            chat_handler.get_conversations(conversation_id='_list')
        second = mock_table.query.call_args_list[1].kwargs
        assert second['ExclusiveStartKey'] == {'pk': PK_A, 'sk': 'CONV#m'}
        assert mock_table.query.call_count == 2

    @pytest.mark.parametrize(('item', 'expected'), [
        ({'kind': 'assistant', 'conversation_id': 'a'},
         {'id': 'a', 'title': 'New conversation', 'kind': 'assistant', 'messageCount': 0,
          'createdAt': None, 'updatedAt': None, 'runStatus': None}),
        ({'kind': 'assistant', 'conversation_id': 'a', 'message_count': 'three'},
         {'id': 'a', 'title': 'New conversation', 'kind': 'assistant', 'messageCount': 0,
          'createdAt': None, 'updatedAt': None, 'runStatus': None}),
        ({'kind': 'assistant', 'conversation_id': 'a', 'message_count': Decimal('3'),
          'title': 'T', 'created_at': 'c', 'updated_at': 'u'},
         {'id': 'a', 'title': 'T', 'kind': 'assistant', 'messageCount': 3,
          'createdAt': 'c', 'updatedAt': 'u', 'runStatus': None}),
        ({'conversation_id': 'l'},
         {'id': 'l', 'title': 'New Conversation', 'kind': 'chat', 'messageCount': 0,
          'createdAt': None, 'updatedAt': None, 'runStatus': None}),
        ({'conversation_id': 'l', 'messages': 'not a list'},
         {'id': 'l', 'title': 'New Conversation', 'kind': 'chat', 'messageCount': 0,
          'createdAt': None, 'updatedAt': None, 'runStatus': None}),
        ({'conversation_id': 'l', 'messages': [{}, {}], 'title': 'T', 'created_at': 'c',
          'updated_at': 'u'},
         {'id': 'l', 'title': 'T', 'kind': 'chat', 'messageCount': 2,
          'createdAt': 'c', 'updatedAt': 'u', 'runStatus': None}),
    ])
    def test_a_summary_is_exactly_the_documented_shape(self, item, expected):
        assert chat_handler._conversation_summary(item) == expected

    def test_a_summary_without_updated_at_sorts_last(self, table):
        table.items[(PK_A, 'CONV#undated')] = {'pk': PK_A, 'sk': 'CONV#undated', 'conversation_id': 'undated'}
        table.items[(PK_A, 'CONV#dated')] = _legacy_item(
            sk='CONV#dated', conversation_id='dated', updated_at='2000-01-01T00:00:00+00:00',
        )
        with _as(USER_A):
            result = chat_handler.get_conversations(conversation_id='_list')
        assert [c['id'] for c in result['conversations']] == ['dated', 'undated']

    def test_exactly_100_items_are_all_listed(self, table):
        for index in range(100):
            table.items[(PK_A, f'CONV#c{index:03d}')] = _legacy_item(
                sk=f'CONV#c{index:03d}', conversation_id=f'c{index:03d}',
                updated_at=f'2026-01-01T00:00:{index:03d}',
            )
        with _as(USER_A):
            result = chat_handler.get_conversations(conversation_id='_list')
        assert len(result['conversations']) == 100
        assert result['conversations'][-1]['id'] == 'c000'


class TestTheRoutesCheckIdentityThenConfiguration:
    def test_a_missing_table_on_save_is_a_configuration_error_with_the_fixed_text(self):
        with _as(USER_A, body={'title': 'T'}), \
                patch.object(chat_handler, 'conversations_table', None), \
                pytest.raises(ConfigurationError) as raised:
            chat_handler.save_conversation(conversation_id='new')
        assert raised.value.message == 'Conversations not configured'

    def test_a_missing_table_on_delete_is_a_configuration_error_with_the_fixed_text(self):
        with _as(USER_A), patch.object(chat_handler, 'conversations_table', None), \
                pytest.raises(ConfigurationError) as raised:
            chat_handler.delete_conversation(conversation_id='conv_1')
        assert raised.value.message == 'Conversations table not configured'

    def test_the_store_backstop_names_the_missing_table(self):
        with patch.object(chat_handler, 'conversations_table', None), \
                pytest.raises(ConfigurationError) as raised:
            chat_handler._conversations_store()
        assert raised.value.message == 'Conversations not configured'

    def test_the_store_backstop_returns_the_configured_table(self, table):
        assert chat_handler._conversations_store() is table

    def test_a_delete_targets_exactly_the_callers_key(self, table):
        table.delete_item = MagicMock(return_value={})
        with _as(USER_A):
            assert chat_handler.delete_conversation(conversation_id='conv_1') == {'success': True}
        table.delete_item.assert_called_once_with(Key={'pk': PK_A, 'sk': 'CONV#conv_1'})

    def test_a_get_by_id_targets_exactly_the_callers_key(self, table):
        table.get_item = MagicMock(return_value={'Item': _legacy_item()})
        with _as(USER_A):
            chat_handler.get_conversations(conversation_id='old')
        table.get_item.assert_called_once_with(Key={'pk': PK_A, 'sk': 'CONV#old'})


class TestTheRoutesAreInstrumented:
    @pytest.mark.parametrize('route', ['get_conversations', 'save_conversation', 'delete_conversation'])
    def test_every_route_is_the_tracer_wrapper_around_the_named_function(self, route):
        func = getattr(chat_handler, route)
        assert func.__code__.co_filename.endswith(os.path.join('tracing', 'tracer.py'))
        assert func.__wrapped__.__qualname__ == route

    @pytest.mark.parametrize('route', ['get_conversations', 'save_conversation'])
    def test_a_direct_call_without_a_segment_sees_an_empty_id(self, route):
        import inspect
        parameters = inspect.signature(getattr(chat_handler, route).__wrapped__).parameters
        assert parameters['conversation_id'].default == ''

    @pytest.mark.usefixtures('table')
    def test_the_handler_injects_the_invocation_context_into_the_logger(self, api_gateway_event):
        # A plain object, not a MagicMock: Powertools reads `context.lambda_context`
        # whenever that attribute exists, and a MagicMock has every attribute.
        context = SimpleNamespace(
            function_name='voc-chat-api-under-test',
            memory_limit_in_mb=256,
            invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:voc-chat-api-under-test',
            aws_request_id='req-chat-handler-mutation-0001',
            get_remaining_time_in_millis=lambda: 30_000,
        )
        event = api_gateway_event(
            method='GET', path='/chat/conversations/_list', resource='/chat/conversations/{proxy+}',
            path_params={'proxy': '_list'}, claims={'sub': USER_A},
        )
        response = chat_handler.lambda_handler(event, context)
        assert response['statusCode'] == 200
        keys = chat_handler.logger.get_current_keys()
        assert keys['function_name'] == 'voc-chat-api-under-test'
        assert keys['function_request_id'] == 'req-chat-handler-mutation-0001'
        # functools.wraps stores __wrapped__ in the function's __dict__ (unstubbed on FunctionType).
        assert vars(chat_handler.lambda_handler)['__wrapped__'].__qualname__ == 'lambda_handler'


class TestTheColdStartModuleState:
    """`chat_handler` as a fresh execution environment imports it."""

    @pytest.fixture
    def reload_with_env(self, monkeypatch):
        saved_path = list(sys.path)

        def _reload(table_name: str | None):
            if table_name is None:
                monkeypatch.delenv('CONVERSATIONS_TABLE', raising=False)
            else:
                monkeypatch.setenv('CONVERSATIONS_TABLE', table_name)
            return importlib.reload(chat_handler)

        yield _reload
        monkeypatch.undo()
        importlib.reload(chat_handler)
        sys.path[:] = saved_path

    def test_the_table_is_the_one_named_in_the_environment(self, reload_with_env):
        module = reload_with_env('named-conversations')
        assert module.CONVERSATIONS_TABLE == 'named-conversations'
        assert module.conversations_table.name == 'named-conversations'

    def test_no_table_in_the_environment_means_no_table(self, reload_with_env):
        module = reload_with_env(None)
        assert module.CONVERSATIONS_TABLE == ''
        assert module.conversations_table is None

    def test_the_lambda_root_is_put_ahead_of_whatever_was_first_on_sys_path(self, reload_with_env):
        lambda_root = os.path.dirname(os.path.dirname(os.path.abspath(chat_handler.__file__)))
        sentinel = os.path.join(os.sep, 'somewhere-else-with-its-own-shared')
        sys.path[:] = [sentinel] + [entry for entry in sys.path if entry != lambda_root]
        reload_with_env('named-conversations')
        assert sys.path[:2] == [lambda_root, sentinel]
        assert os.path.isdir(os.path.join(lambda_root, 'shared'))

    def test_the_module_constants_are_the_documented_bounds(self):
        assert (chat_handler.MAX_TITLE_CHARS, chat_handler.MAX_MESSAGES,
                chat_handler.MAX_PENDING_INTERRUPTS, chat_handler.MAX_ITEM_BYTES,
                chat_handler.LIST_LIMIT) == (120, 300, 20, 350_000, 100)
        assert chat_handler.CONVERSATION_ID_PATTERN.pattern == r'^[A-Za-z0-9_-]{1,64}$'
        assert chat_handler._LIST_PROJECTION_NAMES == {
            '#cid': 'conversation_id', '#title': 'title', '#kind': 'kind', '#mc': 'message_count',
            '#created': 'created_at', '#updated': 'updated_at', '#msgs': 'messages', '#rs': 'run_status',
        }
        assert chat_handler.STALE_RUN_SECONDS == 360
