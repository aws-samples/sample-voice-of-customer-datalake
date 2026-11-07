"""``search_feature_requests`` on ``/mcp/global`` (docs/mcp.md): the feedback boards' search as the minter.

The tool calls ``GET /feature-requests/search`` on the engagement function. Board routes resolve the
caller through ``shared.engagement_identity.board_viewer``, which reads the pool from ``iss`` and needs a
verified email, so a board-route tool's delegated claims also carry THIS deployment's app-pool issuer
(from the MCP function's own ``USER_POOL_ID``) and a verified service address naming the credential.
Pinned here: the route and its query, the slim projection, that the claims resolve to a non-admin
APP-pool viewer, that no other tool gets them, and that the board pool can never be claimed.
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

import mcp_global_handler as h
from shared import engagement_identity
from shared.exceptions import AuthorizationError
from shared.mcp_delegate import DomainCall, DomainResult, build_proxy_event
from shared.mcp_global_tools import (
    TOOLS_BY_NAME,
    InvalidToolArgument,
    MinterIdentity,
    app_pool_issuer,
    board_route_claims,
)

SEARCH = TOOLS_BY_NAME['search_feature_requests']
APP_POOL = 'eu-west-1_AppPool1'
BOARD_POOL = 'eu-west-1_BoardPool1'
ROW = {'token_id': 'gmt_tok1', 'scope': 'read', 'created_by': 'alice-sub', 'created_by_username': 'alice'}
ALICE = MinterIdentity(email='alice@example.com', name='Alice Example')
SLIM = {'request_id': 'fr_1', 'board_id': 'brd_sales', 'title': 'Seat map', 'description': 'Pick a seat early',
        'status': 'open', 'supporters': 4, 'category': 'booking', 'sentiment': 'negative',
        'problem_summary': 'Cannot pick a seat', 'created_at': '2026-05-01T10:00:00Z'}


def _run(arguments: dict, answer: DomainResult, tool=SEARCH) -> tuple[dict, str, MagicMock]:
    call_domain = MagicMock(return_value=answer)
    with patch.object(h, 'call_domain', call_domain), patch.object(h, '_minter_identity', return_value=ALICE), \
            patch.dict('os.environ', {'USER_POOL_ID': APP_POOL}):
        content, outcome = h._run_tool(h.ToolCall(tool, arguments, None), ROW)
    return content, outcome, call_domain


class TestTheRoute:
    def test_defaults_to_a_page_of_25_over_all_time(self):
        request = SEARCH.build({}, None)
        assert (request.domain, request.method, request.path) == ('engagement', 'GET', '/feature-requests/search')
        assert request.query == {'q': None, 'limit': 25, 'board': None, 'category': None, 'status': None, 'days': None}

    def test_sends_every_filter_with_the_route_names(self):
        args = {'query': ' seat map ', 'board': 'brd_sales,ideas', 'category': 'booking', 'status': 'open',
                'days': 90, 'limit': 50}
        assert SEARCH.build(args, None).query == {'q': 'seat map', 'limit': 50, 'board': 'brd_sales,ideas',
                                                  'category': 'booking', 'status': 'open', 'days': 90}

    @pytest.mark.parametrize('args', [{'limit': 51}, {'limit': 0}, {'days': 3651}, {'days': -1}, {'days': True},
                                      {'board': 7}, {'status': 'x' * 501}, {'query': 'q' * 501}])
    def test_refuses_out_of_contract_arguments(self, args):
        with pytest.raises(InvalidToolArgument):
            SEARCH.build(args, None)

    def test_is_a_read_tool_on_a_board_route(self):
        assert (SEARCH.write, SEARCH.admin_only, SEARCH.project_scoped, SEARCH.board_route) == (False, False, False, True)
        assert [tool.name for tool in TOOLS_BY_NAME.values() if tool.board_route] == [
            'search_feature_requests', 'write_feature_request']


class TestTheResult:
    def test_only_the_slim_fields_reach_the_client(self):
        row = {**SLIM, 'email': 'someone@example.com', 'author_name': 'Someone', 'pk': 'FR#fr_1',
               'description': 'd' * 1200}
        content, outcome, _ = _run({}, DomainResult(200, {'success': True, 'items': [row, 'odd'], 'total': 80,
                                                          'truncated': True}))
        assert outcome == 'ok'
        assert content['structuredContent'] == {'count': 1, 'total': 80, 'truncated': True,
                                                'items': [{**SLIM, 'description': 'd' * 1000}]}
        assert 'example.com' not in content['content'][0]['text']

    def test_counts_the_items_without_a_total(self):
        content, _, _ = _run({}, DomainResult(200, {'items': [SLIM], 'total': True}))
        assert json.loads(content['content'][0]['text'])['total'] == 1

    def test_a_refusal_is_a_tool_error(self):
        content, outcome, _ = _run({}, DomainResult(403, {'success': False, 'error': 'This sign-in is not accepted here'}))
        assert (outcome, content['isError']) == ('denied', True)


class TestTheClaims:
    def test_carry_the_app_pool_issuer_and_the_minter_s_verified_email_and_name(self):
        _, _, call_domain = _run({}, DomainResult(200, {'items': []}))
        claims = call_domain.call_args.kwargs['claims']
        assert claims == {'sub': 'mcp:gmt_tok1', 'cognito:groups': '', 'voc:acting_subject': 'alice-sub',
                          'iss': f'https://cognito-idp.eu-west-1.amazonaws.com/{APP_POOL}',
                          'email': 'alice@example.com', 'name': 'Alice Example', 'email_verified': 'true'}

    def test_resolve_to_a_non_admin_app_pool_viewer(self):
        _, _, call_domain = _run({}, DomainResult(200, {'items': []}))
        call: DomainCall = call_domain.call_args.args[0]
        event = build_proxy_event(call, call_domain.call_args.kwargs['claims'])
        env = {'APP_USER_POOL_ID': APP_POOL, 'BOARD_USER_POOL_ID': BOARD_POOL}
        with patch.dict('os.environ', env):
            viewer = engagement_identity.board_viewer(event)
        assert (viewer.pool, viewer.is_admin, viewer.email, viewer.name) == ('app', False, 'alice@example.com', 'Alice Example')

    def test_no_other_tool_gets_them(self):
        _, _, call_domain = _run({}, DomainResult(200, {'projects': []}), tool=TOOLS_BY_NAME['list_projects'])
        assert {'iss', 'email_verified'} & set(call_domain.call_args.kwargs['claims']) == set()

    def test_the_issuer_is_never_taken_from_the_request(self):
        # The builder reads only its own arguments; the claims come from the row and the function's env.
        _, _, call_domain = _run({'iss': f'https://cognito-idp.eu-west-1.amazonaws.com/{BOARD_POOL}',
                                  'email_verified': 'false'}, DomainResult(200, {'items': []}))
        claims = call_domain.call_args.kwargs['claims']
        assert (claims['iss'].endswith(APP_POOL), claims['email_verified']) == (True, 'true')
        assert BOARD_POOL not in json.dumps(claims)

    @pytest.mark.parametrize(('minter', 'pool'), [(ALICE, ''), (ALICE, 'nopool'), (None, APP_POOL)])
    def test_without_a_pool_or_a_verified_minter_they_stay_unchanged_and_the_route_refuses(self, minter, pool):
        base = {'sub': 'mcp:x', 'cognito:groups': '', 'email': 'mcp:x'}
        claims = board_route_claims(base, minter, pool)
        assert claims == base
        with patch.dict('os.environ', {'APP_USER_POOL_ID': APP_POOL}), pytest.raises(AuthorizationError):
            engagement_identity.board_viewer({'requestContext': {'authorizer': {'claims': claims}}})


@pytest.mark.parametrize(('pool', 'issuer'), [
    ('us-east-1_Abc', 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Abc'),
    ('', None), ('us-east-1', None), ('_Abc', None), ('us-east-1_', None)])
def test_app_pool_issuer(pool, issuer):
    assert app_pool_issuer(pool) == issuer


def _cognito_user(attributes: dict[str, str]) -> MagicMock:
    cognito = MagicMock()
    cognito.admin_get_user.return_value = {'UserAttributes': [{'Name': k, 'Value': v} for k, v in attributes.items()]}
    return cognito


class TestTheMinterIdentity:
    """The board routes record a request or +1 under the person: their verified email, read now."""

    def test_is_the_minter_s_verified_email_lower_cased_and_their_name(self):
        cognito = _cognito_user({'sub': 'alice-sub', 'email': ' Alice@Example.com ', 'email_verified': 'true',
                                 'name': ' Alice Example '})
        with patch.object(h, '_cognito_client', return_value=cognito), patch.dict('os.environ', {'USER_POOL_ID': APP_POOL}):
            identity = h._minter_identity(ROW)
        assert identity == MinterIdentity(email='alice@example.com', name='Alice Example')
        cognito.admin_get_user.assert_called_once_with(UserPoolId=APP_POOL, Username='alice')

    @pytest.mark.parametrize('attributes', [
        {'sub': 'alice-sub', 'email': 'alice@example.com', 'email_verified': 'false'},
        {'sub': 'alice-sub', 'email_verified': 'true'},
        {'sub': 'someone-else', 'email': 'alice@example.com', 'email_verified': 'true'},
    ])
    def test_is_none_without_a_verified_email_of_the_same_person(self, attributes):
        with patch.object(h, '_cognito_client', return_value=_cognito_user(attributes)), \
                patch.dict('os.environ', {'USER_POOL_ID': APP_POOL}):
            assert h._minter_identity(ROW) is None

    def test_is_none_when_cognito_fails(self):
        cognito = MagicMock()
        cognito.admin_get_user.side_effect = h.BotoCoreError()
        with patch.object(h, '_cognito_client', return_value=cognito), patch.dict('os.environ', {'USER_POOL_ID': APP_POOL}):
            assert h._minter_identity(ROW) is None

    @pytest.mark.parametrize(('row', 'pool'), [({**ROW, 'created_by_username': ''}, APP_POOL), (ROW, '')])
    def test_is_none_without_a_username_or_a_pool(self, row, pool):
        with patch.object(h, '_cognito_client') as client, patch.dict('os.environ', {'USER_POOL_ID': pool}):
            assert h._minter_identity(row) is None
        client.assert_not_called()
