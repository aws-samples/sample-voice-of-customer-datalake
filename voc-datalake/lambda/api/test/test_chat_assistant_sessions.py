"""
Tests for the unified AI assistant's session persistence in chat_handler.py.

Contract (the SPA relies on it exactly):
- POST /chat/conversations/{id} with ``kind: 'assistant'`` validates and stores
  the session as JSON blobs; 400 on a bad/mismatched id, 413 when too large.
- GET /chat/conversations/_list[?kind=] lists the caller's sessions newest
  first with a blob-free projection, paginating the Query.
- GET /chat/conversations/{id} decodes the blobs (legacy items get defaults).
- Everything is scoped to USER#{sub}.
"""
import functools
import json
import re
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import ConditionBase, ConditionExpressionBuilder
from botocore.exceptions import ClientError

import chat_handler
from shared.exceptions import PayloadTooLargeError, ValidationError
from shared.test.repo_paths import repo_root

USER_A = 'user-aaaa'
USER_B = 'user-bbbb'


def _pk(expr) -> str:
    assert isinstance(expr, ConditionBase)
    built = ConditionExpressionBuilder().build_expression(expr)
    return next(iter(built.attribute_value_placeholders.values()))


class FakeConversationsTable:
    """Minimal in-memory stand-in for the conversations table (pk/sk)."""

    def __init__(self, page_size: int = 1000):
        self.items: dict[tuple[str, str], dict] = {}
        self.page_size = page_size
        self.query_calls: list[dict] = []
        self.put_calls = 0

    def get_item(self, Key, **_kwargs):
        item = self.items.get((Key['pk'], Key['sk']))
        return {'Item': dict(item)} if item else {}

    def put_item(self, Item, ConditionExpression=None, ExpressionAttributeValues=None, **_names):
        """Evaluates the two revision conditions chat_handler writes, like DynamoDB would."""
        stored = self.items.get((Item['pk'], Item['sk'])) or {}
        if ConditionExpression == 'attribute_not_exists(#rev)':
            ok = 'revision' not in stored
        elif ConditionExpression == '#rev = :rev':
            ok = stored.get('revision') == (ExpressionAttributeValues or {}).get(':rev')
        else:
            ok = ConditionExpression is None
        if not ok:
            raise ClientError({'Error': {'Code': 'ConditionalCheckFailedException'}}, 'PutItem')
        self.put_calls += 1
        self.items[(Item['pk'], Item['sk'])] = dict(Item)
        return {}

    def delete_item(self, Key):
        self.items.pop((Key['pk'], Key['sk']), None)
        return {}

    def query(self, KeyConditionExpression, **kwargs):
        self.query_calls.append(kwargs)
        pk = _pk(KeyConditionExpression)
        owned = sorted((key, item) for key, item in self.items.items() if key[0] == pk)
        start = kwargs.get('ExclusiveStartKey')
        if start:
            owned = [entry for entry in owned if entry[0][1] > start['sk']]
        page = owned[: self.page_size]
        response: dict[str, object] = {'Items': [dict(item) for _, item in page]}
        if len(owned) > self.page_size:
            response['LastEvaluatedKey'] = {'pk': pk, 'sk': page[-1][0][1]}
        return response


@pytest.fixture
def table():
    fake = FakeConversationsTable()
    original = chat_handler.conversations_table
    chat_handler.conversations_table = fake
    yield fake
    chat_handler.conversations_table = original


def _as(sub: str, body=None, query=None):
    event = MagicMock()
    event.raw_event = {'requestContext': {'authorizer': {'claims': {'sub': sub}}}}
    event.json_body = body
    event.query_string_parameters = query
    return patch.object(chat_handler.app, 'current_event', event, create=True)


def _body(conv_id='conv_1', **overrides):
    body = {
        'kind': 'assistant',
        'id': conv_id,
        'title': '  Churn deep-dive  ',
        'messages': [
            {'id': 'm1', 'role': 'user', 'content': 'Why do users churn?'},
            {'id': 'm2', 'role': 'assistant', 'content': 'Mostly pricing.', 'score': 0.75},
        ],
        'page': {'kind': 'project', 'path': '/projects/p1', 'projectId': 'p1'},
        'pendingInterrupts': [{'id': 'approval:tc1', 'reason': 'tool_approval'}],
    }
    body.update(overrides)
    return body


def _save(sub, body, proxy=None):
    with _as(sub, body=body):
        return chat_handler.save_conversation(conversation_id=body.get('id') if proxy is None else proxy)


class TestSaveAssistantSession:
    def test_stores_json_blobs_and_metadata(self, table):
        result = _save(USER_A, _body())
        assert result['success'] is True
        assert result['id'] == 'conv_1'
        assert result['updatedAt']
        item = table.items[(f'USER#{USER_A}', 'CONV#conv_1')]
        assert item['kind'] == 'assistant'
        assert item['title'] == 'Churn deep-dive'
        assert item['message_count'] == 2
        # Floats survive because the blob is a JSON string, not a boto3 number.
        assert json.loads(item['messages_json'])[1]['score'] == 0.75
        assert json.loads(item['page_json'])['projectId'] == 'p1'
        assert json.loads(item['pending_json'])[0]['id'] == 'approval:tc1'
        assert 'messages' not in item
        assert item['created_at']
        assert item['updated_at'] == result['updatedAt']

    def test_title_defaults_when_missing_or_blank(self, table):
        _save(USER_A, _body(conv_id='a', title=None))
        _save(USER_A, _body(conv_id='b', title='   '))
        assert table.items[(f'USER#{USER_A}', 'CONV#a')]['title'] == 'New conversation'
        assert table.items[(f'USER#{USER_A}', 'CONV#b')]['title'] == 'New conversation'

    def test_page_may_be_null_and_lists_may_be_omitted(self, table):
        body = {'kind': 'assistant', 'id': 'c', 'page': None}
        _save(USER_A, body)
        item = table.items[(f'USER#{USER_A}', 'CONV#c')]
        assert item['page_json'] == 'null'
        assert item['messages_json'] == '[]'
        assert item['pending_json'] == '[]'
        assert item['message_count'] == 0

    def test_preserves_created_at_of_existing_item(self, table):
        _save(USER_A, _body(createdAt='2026-01-01T00:00:00Z'))
        first = table.items[(f'USER#{USER_A}', 'CONV#conv_1')]['created_at']
        assert first == '2026-01-01T00:00:00Z'
        _save(USER_A, _body(createdAt='2026-06-01T00:00:00Z', title='Renamed'))
        item = table.items[(f'USER#{USER_A}', 'CONV#conv_1')]
        assert item['created_at'] == first
        assert item['title'] == 'Renamed'

    @pytest.mark.parametrize('bad_id', ['', 'has space', 'a/b', 'x' * 65, 'ünï', None, 7])
    def test_rejects_malformed_id(self, table, bad_id):
        with pytest.raises(ValidationError):
            _save(USER_A, _body(conv_id=bad_id), proxy=str(bad_id))
        assert table.put_calls == 0

    def test_accepts_boundary_sizes(self, table):
        _save(USER_A, _body(title='t' * 120, messages=[{'role': 'user'}] * 300,
                            pendingInterrupts=[{}] * 20))
        assert table.items[(f'USER#{USER_A}', 'CONV#conv_1')]['message_count'] == 300

    def test_legacy_body_without_kind_keeps_old_shape(self, table):
        body = {'id': 'legacy-1', 'title': 'Old chat', 'messages': [{'role': 'user', 'content': 'hi'}]}
        result = _save(USER_A, body)
        assert result == {'success': True, 'id': 'legacy-1'}
        item = table.items[(f'USER#{USER_A}', 'CONV#legacy-1')]
        assert 'kind' not in item
        assert 'messages_json' not in item
        assert item['messages'] == [{'role': 'user', 'content': 'hi'}]
        assert item['filters'] == {}

    def test_legacy_body_without_an_id_takes_the_path_id(self, table):
        result = _save(USER_A, {'title': 'Old chat'}, proxy='legacy-2')
        assert result == {'success': True, 'id': 'legacy-2'}
        assert (f'USER#{USER_A}', 'CONV#legacy-2') in table.items

    @pytest.mark.parametrize(('body_id', 'path_id', 'message'), [
        ('legacy-1', 'other', 'id must equal the conversation id in the path'),
        ('../x', '../x', r'id must match \^\[A-Za-z0-9_-\]\{1,64\}\$'),
        ('a' * 65, 'a' * 65, r'id must match'),
        (7, '7', r'id must match'),
        ('../x', 'new', r'id must match'),
    ])
    def test_legacy_save_refuses_an_id_get_and_delete_could_not_reach(self, table, body_id, path_id, message):
        with pytest.raises(ValidationError, match=message):
            _save(USER_A, {'id': body_id, 'title': 'x'}, proxy=path_id)
        assert table.items == {}

    def test_legacy_save_refuses_an_oversized_item(self, table):
        huge = [{'role': 'user', 'content': 'x' * 100_000}] * 4
        with pytest.raises(PayloadTooLargeError):
            _save(USER_A, {'id': 'legacy-big', 'messages': huge})
        assert table.items == {}


class TestGetAssistantSession:
    @pytest.mark.usefixtures('table')
    def test_round_trips_the_saved_session(self):
        saved = _save(USER_A, _body())
        with _as(USER_A):
            result = chat_handler.get_conversations(conversation_id='conv_1')
        assert result['id'] == 'conv_1'
        assert result['kind'] == 'assistant'
        assert result['title'] == 'Churn deep-dive'
        assert result['messages'] == _body()['messages']
        assert result['page'] == _body()['page']
        assert result['pendingInterrupts'] == _body()['pendingInterrupts']
        assert result['updatedAt'] == saved['updatedAt']
        assert result['createdAt']

    def test_legacy_item_gets_assistant_defaults(self, table):
        table.items[(f'USER#{USER_A}', 'CONV#old')] = {
            'pk': f'USER#{USER_A}', 'sk': 'CONV#old', 'conversation_id': 'old',
            'title': 'Old', 'messages': [{'role': 'user', 'content': 'hi'}],
            'filters': {'days': 7}, 'created_at': '2026-01-01', 'updated_at': '2026-01-02',
        }
        with _as(USER_A):
            result = chat_handler.get_conversations(conversation_id='old')
        assert result['kind'] == 'chat'
        assert result['messages'] == [{'role': 'user', 'content': 'hi'}]
        assert result['page'] is None
        assert result['pendingInterrupts'] == []
        assert result['filters'] == {'days': 7}

    @pytest.mark.usefixtures('table')
    def test_another_users_session_is_not_found(self):
        from aws_lambda_powertools.event_handler.exceptions import NotFoundError
        _save(USER_A, _body())
        with _as(USER_B), pytest.raises(NotFoundError):
            chat_handler.get_conversations(conversation_id='conv_1')


class TestConversationIdOnGetAndDelete:
    @pytest.mark.parametrize('bad_id', ['a/b', 'has space', 'x' * 65, '<script>', 'CONV#x'])
    def test_get_rejects_malformed_id_as_not_found_without_echoing_it(self, table, bad_id):
        from aws_lambda_powertools.event_handler.exceptions import NotFoundError
        table.get_item = MagicMock(side_effect=AssertionError('must not read'))
        with _as(USER_A), pytest.raises(NotFoundError) as raised:
            chat_handler.get_conversations(conversation_id=bad_id)
        assert str(raised.value.msg) == 'Conversation not found'

    @pytest.mark.usefixtures('table')
    def test_missing_conversation_message_does_not_echo_the_id(self):
        from aws_lambda_powertools.event_handler.exceptions import NotFoundError
        with _as(USER_A), pytest.raises(NotFoundError) as raised:
            chat_handler.get_conversations(conversation_id='conv_missing')
        assert 'conv_missing' not in str(raised.value.msg)

    @pytest.mark.parametrize('bad_id', ['a/b', 'has space', 'x' * 65])
    def test_delete_rejects_malformed_id_without_touching_the_table(self, table, bad_id):
        from aws_lambda_powertools.event_handler.exceptions import NotFoundError
        table.delete_item = MagicMock(side_effect=AssertionError('must not delete'))
        with _as(USER_A), pytest.raises(NotFoundError):
            chat_handler.delete_conversation(conversation_id=bad_id)

    def test_legacy_timestamp_ids_stay_readable_and_deletable(self, table):
        legacy_id = 'conv-20260101120000123456'
        table.items[(f'USER#{USER_A}', f'CONV#{legacy_id}')] = {
            'pk': f'USER#{USER_A}', 'sk': f'CONV#{legacy_id}', 'conversation_id': legacy_id,
            'title': 'Old', 'messages': [], 'created_at': '2026-01-01', 'updated_at': '2026-01-01',
        }
        with _as(USER_A):
            assert chat_handler.get_conversations(conversation_id=legacy_id)['id'] == legacy_id
            chat_handler.delete_conversation(conversation_id=legacy_id)
        assert (f'USER#{USER_A}', f'CONV#{legacy_id}') not in table.items


class TestListSessions:
    def _seed(self, table):
        _save(USER_A, _body(conv_id='older'))
        _save(USER_A, _body(conv_id='newer'))
        table.items[(f'USER#{USER_A}', 'CONV#older')]['updated_at'] = '2026-01-01T00:00:00+00:00'
        table.items[(f'USER#{USER_A}', 'CONV#newer')]['updated_at'] = '2026-03-01T00:00:00+00:00'
        table.items[(f'USER#{USER_A}', 'CONV#legacy')] = {
            'pk': f'USER#{USER_A}', 'sk': 'CONV#legacy', 'conversation_id': 'legacy',
            'title': 'Legacy', 'messages': [{'role': 'user'}, {'role': 'assistant'}, {'role': 'user'}],
            'created_at': '2026-02-01T00:00:00+00:00', 'updated_at': '2026-02-01T00:00:00+00:00',
        }
        _save(USER_B, _body(conv_id='b-only'))

    def test_lists_newest_first_with_kinds_and_counts(self, table):
        self._seed(table)
        with _as(USER_A, query=None):
            result = chat_handler.get_conversations(conversation_id='_list')
        ids = [c['id'] for c in result['conversations']]
        assert ids == ['newer', 'legacy', 'older']
        legacy = result['conversations'][1]
        assert legacy == {
            'id': 'legacy', 'title': 'Legacy', 'kind': 'chat', 'messageCount': 3,
            'createdAt': '2026-02-01T00:00:00+00:00', 'updatedAt': '2026-02-01T00:00:00+00:00',
            'runStatus': None,
        }
        assert result['conversations'][0]['kind'] == 'assistant'
        assert result['conversations'][0]['messageCount'] == 2
        assert set(result['conversations'][0]) == {
            'id', 'title', 'kind', 'messageCount', 'createdAt', 'updatedAt', 'runStatus'}

    def test_filters_by_kind(self, table):
        self._seed(table)
        with _as(USER_A, query={'kind': 'assistant'}):
            assistant = chat_handler.get_conversations(conversation_id='_list')
        with _as(USER_A, query={'kind': 'chat'}):
            legacy = chat_handler.get_conversations(conversation_id='_list')
        assert [c['id'] for c in assistant['conversations']] == ['newer', 'older']
        assert [c['id'] for c in legacy['conversations']] == ['legacy']

    def test_paginates_and_caps_at_100(self, table):
        table.page_size = 7
        for index in range(105):
            _save(USER_A, _body(conv_id=f'c{index:03d}'))
            table.items[(f'USER#{USER_A}', f'CONV#c{index:03d}')]['updated_at'] = f'2026-01-01T00:00:{index:03d}'
        with _as(USER_A):
            result = chat_handler.get_conversations(conversation_id='_list')
        assert len(table.query_calls) == 15  # ceil(105 / 7)
        assert len(result['conversations']) == 100
        assert result['conversations'][0]['id'] == 'c104'
        assert result['conversations'][-1]['id'] == 'c005'

    def test_never_lists_another_users_sessions(self, table):
        self._seed(table)
        with _as(USER_B):
            result = chat_handler.get_conversations(conversation_id='_list')
        assert [c['id'] for c in result['conversations']] == ['b-only']


class TestOwnershipOnWriteAndDelete:
    def test_same_id_from_two_users_are_separate_items(self, table):
        _save(USER_A, _body(title='A'))
        _save(USER_B, _body(title='B'))
        assert table.items[(f'USER#{USER_A}', 'CONV#conv_1')]['title'] == 'A'
        assert table.items[(f'USER#{USER_B}', 'CONV#conv_1')]['title'] == 'B'

    def test_created_at_is_not_borrowed_from_another_user(self, table):
        _save(USER_A, _body(createdAt='2020-01-01T00:00:00Z'))
        _save(USER_B, _body(createdAt='2026-05-05T00:00:00Z'))
        assert table.items[(f'USER#{USER_B}', 'CONV#conv_1')]['created_at'] == '2026-05-05T00:00:00Z'

    def test_delete_only_touches_the_callers_item(self, table):
        _save(USER_A, _body())
        with _as(USER_B):
            chat_handler.delete_conversation(conversation_id='conv_1')
        assert (f'USER#{USER_A}', 'CONV#conv_1') in table.items


class TestHttpStatusMapping:
    """The exceptions raised above must reach the wire as 413 / 400.

    Asserted on a resolver built the same way chat_handler's is, with a route
    that raises the same exception, so each status is pinned in isolation; the
    real routes are driven end to end in
    `TestTheRoutesMatchARealApiGatewayProxyEvent` below.
    """

    @staticmethod
    def _resolve(exc: Exception):
        from shared.api import create_api_resolver
        resolver = create_api_resolver()

        @resolver.post('/boom')
        def _boom():
            raise exc

        event = {
            'httpMethod': 'POST', 'path': '/boom', 'resource': '/boom',
            'headers': {'Content-Type': 'application/json'}, 'body': '{}',
            'requestContext': {'requestId': 'r', 'stage': 'v1'}, 'isBase64Encoded': False,
        }
        response = resolver.resolve(event, MagicMock())
        return response['statusCode'], json.loads(response['body'])

    def test_payload_too_large_is_413_with_error_and_message(self):
        status, body = self._resolve(PayloadTooLargeError('Conversation is too large to save'))
        assert status == 413
        assert body == {'success': False, 'error': 'Conversation is too large to save',
                        'message': 'Conversation is too large to save'}

    def test_validation_error_is_400(self):
        status, body = self._resolve(ValidationError('id must equal the conversation id in the path'))
        assert status == 400
        assert 'path' in body['error']


class TestTheRoutesMatchARealApiGatewayProxyEvent:
    """Every conversation route, driven through `lambda_handler` with the event API
    Gateway actually sends for the `{proxy+}` resource in api-stack.ts.

    The routes used to be declared `<proxy+>`, which Powertools does not read as a
    dynamic segment (it recognises `<\\w+>` only), so every one of them answered the
    router's own 404 and the direct-call tests above could not tell. These go through
    the resolver, so they fail if the route spelling ever stops matching. The handler's
    own 404 is told apart from the router's by its message.
    """

    @staticmethod
    def _call(api_gateway_event, lambda_context, method, segment, *, sub=USER_A,
              body=None, query=None):
        event = api_gateway_event(
            method=method,
            path=f'/chat/conversations/{segment}',
            resource='/chat/conversations/{proxy+}',
            path_params={'proxy': segment},
            query_params=query,
            body=body,
            claims={'sub': sub, 'email': 'someone@example.com'},
        )
        response = chat_handler.lambda_handler(event, lambda_context)
        return response['statusCode'], json.loads(response['body'])

    def test_an_assistant_session_round_trips_through_every_route(
        self, table, api_gateway_event, lambda_context,
    ):
        call = functools.partial(self._call, api_gateway_event, lambda_context)

        saved = call('POST', 'conv_1', body=_body())
        listed = call('GET', '_list', query={'kind': 'assistant'})
        fetched = call('GET', 'conv_1')
        deleted = call('DELETE', 'conv_1')
        gone = call('GET', 'conv_1')

        assert (saved[0], saved[1]['success'], saved[1]['id']) == (200, True, 'conv_1')
        assert listed[0] == 200
        assert [c['id'] for c in listed[1]['conversations']] == ['conv_1']
        assert fetched[0] == 200
        assert (fetched[1]['kind'], fetched[1]['title']) == ('assistant', 'Churn deep-dive')
        assert deleted == (200, {'success': True})
        assert gone[0] == 404
        assert gone[1]['message'] == chat_handler.CONVERSATION_NOT_FOUND
        assert table.items == {}

    def test_the_legacy_save_is_reached_through_the_router(
        self, table, api_gateway_event, lambda_context,
    ):
        status, body = self._call(
            api_gateway_event, lambda_context, 'POST', 'new',
            body={'id': 'conv-20260101', 'title': 'Old page', 'messages': []},
        )

        assert (status, body) == (200, {'success': True, 'id': 'conv-20260101'})
        assert (f'USER#{USER_A}', 'CONV#conv-20260101') in table.items

    def test_a_path_id_that_disagrees_with_the_body_is_refused_400(
        self, table, api_gateway_event, lambda_context,
    ):
        status, _body_out = self._call(
            api_gateway_event, lambda_context, 'POST', 'conv_2', body=_body(conv_id='conv_1'),
        )

        assert status == 400
        assert table.put_calls == 0

    def test_routes_are_scoped_to_the_callers_subject(
        self, table, api_gateway_event, lambda_context,
    ):
        self._call(api_gateway_event, lambda_context, 'POST', 'conv_1', body=_body())

        status, body = self._call(api_gateway_event, lambda_context, 'GET', 'conv_1', sub=USER_B)
        _, listed = self._call(api_gateway_event, lambda_context, 'GET', '_list', sub=USER_B)

        assert (status, body['message']) == (404, chat_handler.CONVERSATION_NOT_FOUND)
        assert listed == {'conversations': []}
        assert list(table.items) == [(f'USER#{USER_A}', 'CONV#conv_1')]


SERVER_REV = 1_800_000_000_100


class TestServerOwnsTheRunsAnswer:
    """The stream Lambda saves the answer while it streams (run_status/revision);
    an SPA save must never overwrite a newer server revision."""

    def _server_item(self, table, *, status='running', revision=SERVER_REV, updated_at=None):
        table.items[(f'USER#{USER_A}', 'CONV#conv_1')] = {
            'pk': f'USER#{USER_A}', 'sk': 'CONV#conv_1', 'conversation_id': 'conv_1', 'kind': 'assistant',
            'title': 'Q', 'messages_json': '[{"id":"m1","role":"user","content":"q"},'
                                           '{"id":"a1","role":"assistant","content":"partial"}]',
            'page_json': 'null', 'pending_json': '[]', 'message_count': 2,
            'created_at': '2026-01-01T00:00:00+00:00',
            'updated_at': updated_at or chat_handler._now_iso(),
            'run_id': 'run-1', 'run_status': status, 'revision': revision,
        }

    def _stored_messages(self, table):
        return json.loads(table.items[(f'USER#{USER_A}', 'CONV#conv_1')]['messages_json'])

    def test_refuses_a_save_while_the_server_run_is_live(self, table):
        self._server_item(table)
        with pytest.raises(chat_handler.ConflictError):
            _save(USER_A, _body(baseRevision=SERVER_REV))
        assert self._stored_messages(table)[1]['content'] == 'partial'

    def test_refuses_a_save_that_has_not_seen_the_newest_server_revision(self, table):
        self._server_item(table, status='finished')
        with pytest.raises(chat_handler.ConflictError):
            _save(USER_A, _body(baseRevision=SERVER_REV - 1))
        with pytest.raises(chat_handler.ConflictError):
            _save(USER_A, _body())  # no baseRevision = has seen none
        assert self._stored_messages(table)[1]['content'] == 'partial'

    def test_accepts_a_save_that_saw_the_final_revision_and_keeps_the_run_fields(self, table):
        self._server_item(table, status='finished')
        result = _save(USER_A, _body(baseRevision=SERVER_REV))
        item = table.items[(f'USER#{USER_A}', 'CONV#conv_1')]
        assert result['revision'] == SERVER_REV
        assert self._stored_messages(table)[1]['content'] == 'Mostly pricing.'
        assert (item['run_id'], item['run_status'], item['revision']) == ('run-1', 'finished', SERVER_REV)
        assert item['created_at'] == '2026-01-01T00:00:00+00:00'

    def test_a_dead_running_run_does_not_lock_the_conversation(self, table):
        self._server_item(table, updated_at='2020-01-01T00:00:00+00:00')
        _save(USER_A, _body(baseRevision=SERVER_REV))
        assert self._stored_messages(table)[1]['content'] == 'Mostly pricing.'

    def test_a_server_write_between_read_and_put_wins(self, table):
        """Read-check-write is atomic: the put is conditional on the revision read."""
        self._server_item(table, status='finished')
        original_get = table.get_item

        def get_then_server_writes(**kwargs):
            response = original_get(**kwargs)
            self._server_item(table, status='running', revision=SERVER_REV + 100)
            return response

        table.get_item = get_then_server_writes
        with pytest.raises(chat_handler.ConflictError):
            _save(USER_A, _body(baseRevision=SERVER_REV))
        assert self._stored_messages(table)[1]['content'] == 'partial'

    @pytest.mark.usefixtures('table')
    def test_rejects_a_malformed_base_revision(self):
        for bad in (-1, 'x', 1.5, True):
            with pytest.raises(ValidationError):
                _save(USER_A, _body(baseRevision=bad))

    def test_get_and_list_expose_the_run_state(self, table):
        self._server_item(table)
        with _as(USER_A):
            detail = chat_handler.get_conversations(conversation_id='conv_1')
            listed = chat_handler.get_conversations(conversation_id='_list')
        assert (detail['runStatus'], detail['runId'], detail['revision']) == ('running', 'run-1', SERVER_REV)
        assert listed['conversations'][0]['runStatus'] == 'running'

    @pytest.mark.usefixtures('table')
    def test_a_client_only_session_reads_as_never_streamed_server_side(self):
        _save(USER_A, _body())
        with _as(USER_A):
            detail = chat_handler.get_conversations(conversation_id='conv_1')
        assert (detail['runStatus'], detail['runId'], detail['revision']) == (None, None, 0)


def test_stale_run_window_is_in_lockstep_with_the_stream_contract():
    source = (repo_root() / 'lambda' / 'stream' / 'src' / 'assistant' / 'contract.ts').read_text()
    match = re.search(r'export const STALE_RUN_SECONDS = (\d+);', source)
    assert match is not None, 'STALE_RUN_SECONDS not found in the stream contract'
    assert int(match.group(1)) == chat_handler.STALE_RUN_SECONDS
