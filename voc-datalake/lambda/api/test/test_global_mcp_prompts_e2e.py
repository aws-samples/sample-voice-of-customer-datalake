"""MCP prompts and resources end to end (api/mcp_global_handler.py + shared/mcp_global_prompts.py).

Driven like test_global_mcp_e2e.py: tokens minted through the real token API, JSON-RPC frames over the
REST proxy event, the real audit log. The settings Lambda is a recording stand-in behind the same
in-process invoke, so the test sees the delegated event a resource read sends: the minter's subject
acting through ``mcp:{token_id}``, never admin. Both protocol eras: a legacy client after
``initialize`` and a 2026-07-28 client with per-request ``_meta`` and the mirrored headers.
"""
from __future__ import annotations

import json
from typing import Any

import pytest
from global_mcp_world import McpReply, global_mcp_world

import mcp_global_handler as handler

MODERN = '2026-07-28'
CATEGORIES = {'categories': [{'name': 'Baggage', 'description': 'Lost and late bags'}]}


class RecordingSettings:
    """A settings function answering GET /settings/categories and recording each event."""

    def __init__(self) -> None:
        self.events: list[dict] = []

    def lambda_handler(self, event: dict, _context: Any) -> dict:
        self.events.append(event)
        if event['path'] == '/settings/categories':
            return {'statusCode': 200, 'headers': {}, 'body': json.dumps(CATEGORIES)}
        return {'statusCode': 403, 'headers': {}, 'body': json.dumps({'error': 'Forbidden'})}


@pytest.fixture
def world(lambda_context):
    with global_mcp_world(lambda_context) as built:
        yield built


@pytest.fixture
def settings(world) -> RecordingSettings:
    recording = RecordingSettings()
    world.lambdas.handlers['settings-fn'] = recording
    return recording


def _result(reply: McpReply) -> dict:
    assert reply.status == 200, reply.body
    assert reply.body is not None
    assert 'result' in reply.body, reply.body
    return reply.body['result']


def _prompt_text(reply: McpReply) -> str:
    return _result(reply)['messages'][0]['content']['text']


def _modern(world, minted: dict, method: str, params: dict, *, name: str | None = None) -> McpReply:
    headers = {'Content-Type': 'application/json', 'Authorization': f"Bearer {minted['token']}",
               'MCP-Protocol-Version': MODERN, 'Mcp-Method': method}
    if name is not None:
        headers['Mcp-Name'] = name
    message = {'jsonrpc': '2.0', 'id': 1, 'method': method,
               'params': {**params, '_meta': {'io.modelcontextprotocol/protocolVersion': MODERN}}}
    event = {'httpMethod': 'POST', 'path': '/mcp/global', 'headers': headers, 'body': json.dumps(message)}
    raw = handler.lambda_handler(event, world.context)
    return McpReply(raw['statusCode'], json.loads(raw['body']) if raw['body'] else None, raw['headers'])


class TestLegacyClient:
    def test_initialize_advertises_prompts_and_resources(self, world):
        client = world.client(world.mint('alice', scope='read'))
        capabilities = _result(client.connect())['capabilities']
        assert set(capabilities) == {'tools', 'prompts', 'resources'}

    def test_lists_name_the_catalogue(self, world):
        client = world.client(world.mint('alice', scope='read'))
        client.connect()
        prompts = [p['name'] for p in _result(client.request('prompts/list'))['prompts']]
        resources = [r['uri'] for r in _result(client.request('resources/list'))['resources']]
        assert prompts == ['weekly_summary', 'triage_urgent', 'prfaq_from_feedback']
        assert resources == ['voc://categories', 'voc://company-context']

    def test_the_prfaq_prompt_depends_on_the_token_scope(self, world):
        params = {'name': 'prfaq_from_feedback', 'arguments': {'topic': 'Lost bags'}}
        read_text = _prompt_text(world.client(world.mint('alice', scope='read')).request('prompts/get', params))
        write_text = _prompt_text(world.client(world.mint('alice', scope='write')).request('prompts/get', params))
        assert 'create_document' not in read_text
        assert 'Only when the user confirms, save it with create_document' in write_text

    def test_a_prompt_get_is_audited_without_its_arguments(self, world):
        minted = world.mint('alice', scope='read')
        # A free-text value no timestamp or id can contain, so its absence proves the arguments were not stored.
        secret_value = 'zz-argument-value-not-audited'
        world.client(minted).request('prompts/get', {'name': 'prfaq_from_feedback', 'arguments': {'topic': secret_value}})
        (event,) = world.audit('alice', minted['token_id'])
        assert (event['tool'], event['outcome']) == ('prompt:prfaq_from_feedback', 'ok')
        audited = json.dumps(event)
        assert secret_value not in audited
        assert 'topic' not in audited

    def test_a_resource_is_read_through_the_settings_route_as_the_minter(self, world, settings):
        minted = world.mint('alice', scope='read')
        result = _result(world.client(minted).request('resources/read', {'uri': 'voc://categories'}))
        (content,) = result['contents']
        assert (content['mimeType'], json.loads(content['text'])) == ('application/json', CATEGORIES)
        (event,) = settings.events
        claims = event['requestContext']['authorizer']['claims']
        assert claims['sub'] == f"mcp:{minted['token_id']}"
        assert claims['cognito:groups'] == ''
        assert world.audit('alice', minted['token_id'])[0]['tool'] == 'resource:voc://categories'

    @pytest.mark.usefixtures('settings')
    def test_a_refused_resource_is_invalid_params_audited_as_denied(self, world):
        minted = world.mint('alice', scope='read')
        reply = world.client(minted).request('resources/read', {'uri': 'voc://company-context'})
        assert reply.body is not None
        assert reply.body['error'] == {'code': -32602, 'message': 'The request was refused (HTTP 403)'}
        assert world.audit('alice', minted['token_id'])[0]['outcome'] == 'denied'

    @pytest.mark.parametrize(('method', 'params', 'audited'), [
        ('prompts/get', {'name': 'drop_tables'}, 'prompt:unknown'),
        ('resources/read', {'uri': 'voc://skill'}, 'resource:unknown'),
    ])
    def test_an_unknown_name_is_invalid_params(self, world, settings, method, params, audited):
        minted = world.mint('alice', scope='read')
        reply = world.client(minted).request(method, params)
        assert reply.body is not None
        assert reply.body['error']['code'] == -32602
        assert settings.events == []
        assert world.audit('alice', minted['token_id'])[0]['tool'] == audited

    def test_no_credential_is_401(self, world):
        assert world.client(None).request('prompts/list').status == 401


class TestModernClient:
    def test_discover_advertises_prompts_and_resources(self, world):
        reply = _modern(world, world.mint('alice', scope='read'), 'server/discover', {})
        assert set(_result(reply)['capabilities']) == {'tools', 'prompts', 'resources'}

    def test_prompts_get_carries_result_type_and_identity(self, world):
        reply = _modern(world, world.mint('alice', scope='read'), 'prompts/get',
                        {'name': 'triage_urgent', 'arguments': {}}, name='triage_urgent')
        result = _result(reply)
        assert result['resultType'] == 'complete'
        assert result['_meta']['io.modelcontextprotocol/serverInfo']['name'] == handler.SERVER_NAME
        assert 'urgent=true' in result['messages'][0]['content']['text']

    @pytest.mark.usefixtures('settings')
    def test_resources_read_without_a_name_header_is_served(self, world):
        reply = _modern(world, world.mint('alice', scope='read'), 'resources/read', {'uri': 'voc://categories'})
        assert _result(reply)['contents'][0]['uri'] == 'voc://categories'

    def test_a_disagreeing_name_header_is_a_header_mismatch(self, world, settings):
        reply = _modern(world, world.mint('alice', scope='read'), 'resources/read', {'uri': 'voc://categories'},
                        name='voc://company-context')
        assert reply.status == 400
        assert reply.body is not None
        assert reply.body['error']['code'] == -32020
        assert settings.events == []

    def test_lists_are_served(self, world):
        minted = world.mint('alice', scope='read')
        assert len(_result(_modern(world, minted, 'prompts/list', {}))['prompts']) == 3
        assert len(_result(_modern(world, minted, 'resources/list', {}))['resources']) == 2
