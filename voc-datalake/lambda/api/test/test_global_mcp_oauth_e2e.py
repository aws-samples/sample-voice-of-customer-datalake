"""End to end: an MCP client signs in with OAuth, then uses /mcp/global exactly like a token would.

The flow (``global_mcp_oauth_world``) runs through the REAL facade, consent API, relay and token facade,
with Cognito and its JWKS stubbed. Then the access token goes to ``mcp_global_handler`` — as a request
and as the API Gateway TOKEN authorizer.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from global_mcp_oauth_world import anonymous, oauth_world
from global_mcp_world import ALPHA, BETA, McpClient, tool_payload
from test_global_mcp_e2e import READ_TOOLS, WRITE_TOOLS

import mcp_global_handler
from shared import mcp_global_tokens as gt
from shared import mcp_oauth_grants as grants


@pytest.fixture
def oauth(lambda_context):
    with oauth_world(lambda_context) as built:
        yield built


def _client(oauth, signed_in) -> McpClient:
    client = McpClient(token=signed_in.access_token, context=oauth.world.context)
    reply = client.connect()
    assert reply.status == 200, reply.body
    return client


def _authorizer(oauth, token: str) -> str:
    answer = mcp_global_handler.lambda_handler({
        'type': 'TOKEN', 'methodArn': 'arn:aws:execute-api:us-east-1:1:abc/v1/POST/mcp/global',
        'authorizationToken': f'Bearer {token}'}, oauth.world.context)
    return answer['policyDocument']['Statement'][0]['Effect']


def _grant_key(subject: str, client_id: str) -> dict:
    return {'pk': gt.GLOBAL_TOKEN_PK, 'sk': gt.token_sk(grants.grant_id(subject, client_id))}


def _grant_row(oauth, username: str, client_id: str) -> dict:
    return oauth.world.projects.get_item(Key=_grant_key(oauth.world.subs[username], client_id))['Item']


class TestSignedInClient:
    def test_acts_as_the_signed_in_person_with_the_consented_write_scope(self, oauth):
        signed_in = oauth.sign_in('alice')
        client = _client(oauth, signed_in)

        assert set(client.tool_names()) == READ_TOOLS | WRITE_TOOLS
        is_error, listed = tool_payload(client.call('list_projects'))
        assert not is_error
        assert ALPHA in [p['project_id'] for p in listed['projects']]
        assert BETA not in [p['project_id'] for p in listed['projects']]

        _, event = oauth.world.lambdas.calls[-1]
        claims = event['requestContext']['authorizer']['claims']
        assert claims['sub'].startswith('mcp:oag_')
        assert claims['voc:acting_subject'] == oauth.world.subs['alice']
        assert claims['cognito:groups'] == ''
        assert _authorizer(oauth, signed_in.access_token) == 'Allow'

    def test_every_tool_call_is_audited_on_the_grant(self, oauth):
        signed_in = oauth.sign_in('alice')
        _client(oauth, signed_in).call('list_projects')
        grant_id = grants.grant_id(oauth.world.subs['alice'], signed_in.client_id)
        events = oauth.world.jobs.query(KeyConditionExpression='pk = :pk',
                                        ExpressionAttributeValues={':pk': gt.audit_pk(grant_id)})['Items']
        assert [(e['tool'], e['outcome']) for e in events] == [('list_projects', 'ok')]

    def test_a_read_consent_offers_read_tools_only_and_refuses_a_write(self, oauth):
        client = _client(oauth, oauth.sign_in('alice', scope='read'))
        assert set(client.tool_names()) == READ_TOOLS
        is_error, message = tool_payload(client.call('create_document', {'project_id': ALPHA, 'title': 'x',
                                                                          'content': 'y'}))
        assert is_error
        assert 'read-only' in message

    def test_a_project_pin_confines_project_tools(self, oauth):
        client = _client(oauth, oauth.sign_in('alice', project_id=ALPHA))
        is_error, message = tool_payload(client.call('get_project', {'project_id': 'proj_gamma'}))
        assert is_error
        assert 'scoped to project' in message

    def test_run_agent_is_never_offered_to_a_non_admin(self, oauth):
        assert 'run_agent' not in _client(oauth, oauth.sign_in('alice')).tool_names()
        assert 'run_agent' in _client(oauth, oauth.sign_in('root')).tool_names()

    def test_a_demoted_admin_loses_run_agent_at_the_next_call(self, oauth):
        client = _client(oauth, oauth.sign_in('root'))
        oauth.world.cognito.demote('root')
        is_error, message = tool_payload(client.call('run_agent', {'agent_id': oauth.world.agent_id}))
        assert is_error
        assert 'administrator' in message


class TestRevocation:
    def test_revoking_the_grant_refuses_the_next_request_and_the_authorizer(self, oauth):
        signed_in = oauth.sign_in('alice')
        client = _client(oauth, signed_in)
        grant_id = grants.grant_id(oauth.world.subs['alice'], signed_in.client_id)

        status, body = oauth.consent_api('alice', 'DELETE', f'/connect/oauth/grants/{grant_id}')
        assert status == 200, body
        assert body['grant']['status'] == 'revoked'

        assert client.request('tools/list').status == 401
        assert _authorizer(oauth, signed_in.access_token) == 'Deny'

    def test_a_refresh_after_revocation_is_invalid_grant_and_revokes_at_cognito(self, oauth):
        signed_in = oauth.sign_in('alice')
        grant_id = grants.grant_id(oauth.world.subs['alice'], signed_in.client_id)
        oauth.consent_api('alice', 'DELETE', f'/connect/oauth/grants/{grant_id}')

        refreshed = oauth.refresh(signed_in)
        assert refreshed.status == 400
        assert refreshed.body['error'] == 'invalid_grant'
        assert signed_in.refresh_token in oauth.cognito.revoked

    def test_a_refresh_of_an_active_grant_keeps_its_chain(self, oauth):
        signed_in = oauth.sign_in('alice')
        refreshed = oauth.refresh(signed_in)
        assert refreshed.status == 200, refreshed.body
        assert refreshed.body['access_token'] != signed_in.access_token
        assert McpClient(token=refreshed.body['access_token'], context=oauth.world.context).connect().status == 200

    def test_a_new_consent_kills_the_earlier_sign_in(self, oauth):
        first = oauth.sign_in('alice', port=50001)
        second = oauth.sign_in('alice', port=50002)
        assert McpClient(token=first.access_token, context=oauth.world.context).request('tools/list').status == 401
        assert _client(oauth, second).request('tools/list').status == 200

    def test_a_disabled_user_is_refused(self, oauth):
        client = _client(oauth, oauth.sign_in('alice'))
        oauth.world.cognito.disable('alice')
        assert client.request('tools/list').status == 401

    def test_someone_else_cannot_revoke_my_grant(self, oauth):
        signed_in = oauth.sign_in('alice')
        grant_id = grants.grant_id(oauth.world.subs['alice'], signed_in.client_id)
        status, _ = oauth.consent_api('bob', 'DELETE', f'/connect/oauth/grants/{grant_id}')
        assert status == 404
        assert _client(oauth, signed_in).request('tools/list').status == 200


class TestChainIsBoundToConsent:
    def test_another_person_signing_in_at_cognito_gets_nothing(self, oauth):
        with pytest.raises(AssertionError, match='invalid_grant'):
            oauth.sign_in('alice', cognito_user='bob')

    def test_a_code_after_the_consent_window_is_refused(self, oauth):
        registered = oauth.register('kiro')
        client_id, redirect_uri = registered.body['client_id'], registered.body['redirect_uris'][0]
        query = oauth.authorize_query(client_id, redirect_uri)
        _, approved = oauth.consent('alice', query)
        oauth.world.projects.update_item(
            Key=_grant_key(oauth.world.subs['alice'], client_id), UpdateExpression='SET chain_open_until = :t',
            ExpressionAttributeValues={':t': (datetime.now(UTC) - timedelta(seconds=1)).isoformat()})
        delivered = oauth.cognito.sign_in(approved['redirect_to'], 'alice')
        relayed = oauth.call(anonymous('GET', '/oauth/callback', query=delivered))
        code = relayed.headers['Location'].split('code=')[1].split('&')[0]
        answer = oauth.exchange({'grant_type': 'authorization_code', 'client_id': client_id, 'code': code,
                                 'redirect_uri': redirect_uri, 'code_verifier': 'v' * 43})
        assert answer.status == 400
        assert answer.body['error'] == 'invalid_grant'

    def test_the_chain_is_recorded_once_per_consent(self, oauth):
        signed_in = oauth.sign_in('alice')
        row = _grant_row(oauth, 'alice', signed_in.client_id)
        assert len(row['origin_jtis']) == 1
        assert 'chain_open_until' not in row
        assert 'refresh_token' not in str(row)

    def test_a_token_from_an_unrecorded_chain_is_refused(self, oauth):
        signed_in = oauth.sign_in('alice')
        grant = next(iter(oauth.cognito.refresh.values()))
        forged_chain = oauth.cognito.access_token(grant, origin_jti='never-recorded')
        assert McpClient(token=forged_chain, context=oauth.world.context).request('tools/list').status == 401
        assert signed_in.access_token != forged_chain

    def test_a_static_token_still_works_beside_oauth(self, oauth):
        minted = oauth.world.mint('alice', scope='read')
        assert oauth.world.client(minted).connect().status == 200
