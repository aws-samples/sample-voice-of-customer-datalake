"""Stop cancels the server run: ``POST /chat/conversations/{id}/cancel`` against moto (5.35).

E2E 5.34: Stop in /chat aborted only the browser's request; the stream Lambda ran on (Bedrock
still spent) and a reload showed the full answer. Stop now writes a cancel marker the stream
Lambda polls (``lambda/stream/src/assistant/session/cancel.ts``). Run against moto so the keys,
the TTL and the list's key condition are DynamoDB's own.
"""
import json
import time
from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table, rest_event

import chat_handler

USER = 'user-a'
OTHER = 'user-b'


@pytest.fixture
def table() -> Iterator[Any]:
    with mock_aws():
        conversations = pk_sk_table('conversations')
        with patch.object(chat_handler, 'conversations_table', conversations):
            yield conversations


_CONTEXT = MagicMock(function_name='voc-chat-api', aws_request_id='test-request')


def _call(method: str, path: str, sub: str = USER, body: object = None) -> tuple[int, Any]:
    """Through ``lambda_handler``, so the route's path matching is the real one."""
    response = chat_handler.lambda_handler(rest_event(method, path, claims={'sub': sub}, body=body), _CONTEXT)
    return response['statusCode'], json.loads(response['body'])


def _cancel(sub: str, conversation_id: str, body: object) -> tuple[int, Any]:
    return _call('POST', f'/chat/conversations/{conversation_id}/cancel', sub, body)


def test_stop_writes_a_cancel_marker_for_that_run_in_the_callers_partition(table):
    before = int(time.time())
    assert _cancel(USER, 'conv_1', {'runId': 'run-1'}) == (200, {'success': True, 'id': 'conv_1', 'runId': 'run-1'})

    item = table.get_item(Key={'pk': f'USER#{USER}', 'sk': 'RUNCANCEL#conv_1'})['Item']
    assert item['run_id'] == 'run-1'
    assert before + chat_handler.CANCEL_TTL_SECONDS <= int(item['ttl']) <= int(time.time()) + chat_handler.CANCEL_TTL_SECONDS
    assert 'Item' not in table.get_item(Key={'pk': f'USER#{OTHER}', 'sk': 'RUNCANCEL#conv_1'})


def test_a_second_stop_names_the_newer_run(table):
    _cancel(USER, 'conv_1', {'runId': 'run-1'})
    _cancel(USER, 'conv_1', {'runId': 'run-2'})
    assert table.get_item(Key={'pk': f'USER#{USER}', 'sk': 'RUNCANCEL#conv_1'})['Item']['run_id'] == 'run-2'


@pytest.mark.parametrize('body', [{}, {'runId': ''}, {'runId': 'a/b'}, {'runId': 7}, {'runId': 'x' * 129}, None])
def test_refuses_a_missing_or_malformed_run_id(table, body):
    assert _cancel(USER, 'conv_1', body)[0] == 400
    assert table.scan()['Count'] == 0


def test_refuses_a_malformed_conversation_id_as_not_found(table):
    assert _cancel(USER, 'bad.id', {'runId': 'run-1'})[0] == 404
    assert table.scan()['Count'] == 0


def test_the_marker_never_lists_as_a_conversation(table):
    table.put_item(Item={
        'pk': f'USER#{USER}', 'sk': 'CONV#conv_1', 'conversation_id': 'conv_1', 'kind': 'assistant',
        'title': 'Hello', 'message_count': 1, 'updated_at': '2026-10-25T00:00:00+00:00',
    })
    _cancel(USER, 'conv_1', {'runId': 'run-1'})
    status, listed = _call('GET', '/chat/conversations/_list')
    assert status == 200
    assert [c['id'] for c in listed['conversations']] == ['conv_1']


def test_a_stopped_run_reads_back_as_stopped(table):
    table.put_item(Item={
        'pk': f'USER#{USER}', 'sk': 'CONV#conv_1', 'conversation_id': 'conv_1', 'kind': 'assistant',
        'messages_json': '[]', 'run_status': 'stopped', 'run_id': 'run-1', 'revision': 5,
    })
    detail = _call('GET', '/chat/conversations/conv_1')[1]
    listed = _call('GET', '/chat/conversations/_list')[1]
    assert (detail['runStatus'], detail['runId']) == ('stopped', 'run-1')
    assert listed['conversations'][0]['runStatus'] == 'stopped'
