"""Mutation hardening for `api/mcp_tokens_handler.py` (``/connect/tokens/*``).

`test_global_mcp_tokens_api.py` and the e2e suite pin the statuses of the token
API — 400 on a bad mint, 404 on a foreign token, 409 at the cap — but a mutation
run found behaviour they cannot see:

* the WORDING of every refusal (the Connect page shows `error` verbatim), the
  list route's `limits`/`endpoint_path`/`can_mint_agent_runner` literals, and
  every attribute the mint writes to the row (`created_by_username`,
  `minted_by_admin`, the absent `project_id` for a workspace token);
* the DynamoDB CALLS themselves: the strongly consistent owner read, that a
  malformed id costs no read at all, the paginated minted-by query following
  `LastEvaluatedKey`, the conditional soft revoke and how its lost race is
  handled (re-read, never re-written; any other fault propagates);
* ordering and paging: tokens newest-first (a row with no `created_at` sorts
  last), audit events newest-first, the page size, and every way a cursor can
  be malformed (bad base64, bad UTF-8, non-JSON, non-object, foreign partition,
  non-string `sk`, extra keys) while an empty cursor means "first page";
* the 500s when a table is not configured, each naming its table;
* the instrumentation: every route is the tracer's wrapper and the handler
  is wrapped by `api_handler` (a dropped decorator changed no HTTP answer).
"""
from __future__ import annotations

import base64
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from global_mcp_world import ALPHA, BETA, GAMMA, World, global_mcp_world
from handler_log import handler_info
from moto_helpers import rest_event

import mcp_tokens_handler as h
from shared import mcp_global_tokens as gt
from shared.project_access import Caller
from shared.test.instrumentation_fixtures import assert_handler_wrapped, assert_tracer_wrapped

T0 = datetime(2026, 3, 1, 12, 0, 0, tzinfo=UTC)
TOKEN_NOT_FOUND = 'Token not found'
TOKEN_ID = 'tok_0123456789abcdef'
TOKEN_PATH = f'/connect/tokens/{TOKEN_ID}'
AUDIT_PK = f'MCPAUDIT#{TOKEN_ID}'
ALICE_SUB = 'alice-sub'
ALICE_CLAIMS = {'sub': ALICE_SUB, 'cognito:username': 'alice'}


@pytest.fixture
def world(lambda_context) -> Any:
    with global_mcp_world(lambda_context) as built:
        yield built


def _stored_row(**extra: Any) -> dict:
    """An active token row of alice's, as the projects table holds it."""
    return {'pk': 'MCPGTOKEN', 'sk': f'TOKEN#{TOKEN_ID}', 'token_id': TOKEN_ID, 'created_by': ALICE_SUB,
            'scope': 'read', 'expires_at': '2099-01-01T00:00:00+00:00', **extra}


def _cursor(payload: object) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()


def _decode(cursor: str) -> object:
    return json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())


def _row(world: World, token_id: str) -> dict:
    return world.projects.get_item(Key={'pk': gt.GLOBAL_TOKEN_PK, 'sk': gt.token_sk(token_id)})['Item']


def _audit(world: World, token_id: str, at: datetime, tool: str = 'list_projects') -> dict:
    item = gt.audit_item(token_id, tool=tool, project_id=None, outcome=gt.OUTCOME_OK, now=at)
    world.jobs.put_item(Item=item)
    return item


def _mock_table_call(method: str, path: str, table: MagicMock, context: Any, *,
                     jobs: MagicMock | None = None, body: object = None,
                     query: dict | None = None) -> tuple[int, dict]:
    """Drive ``method path`` as alice against MagicMock tables (call-argument pins)."""
    event = rest_event(method, path, claims=ALICE_CLAIMS, body=body)
    event['queryStringParameters'] = query
    with patch.object(h, 'get_projects_table', return_value=table), \
            patch.object(h, 'get_jobs_table', return_value=jobs or MagicMock()):
        response = h.lambda_handler(event, context)
    return response['statusCode'], json.loads(response['body'])


# ── Instrumentation ─────────────────────────────────────────────────────────
class TestTheRoutesAreInstrumented:
    @pytest.mark.parametrize('route', ['list_tokens', 'mint_token', 'revoke_token', 'token_detail'])
    def test_every_route_is_the_tracer_wrapper_around_the_named_function(self, route):
        assert_tracer_wrapped(h, route)

    def test_the_handler_injects_the_invocation_context_into_the_logger(self, world):
        context = SimpleNamespace(
            function_name='voc-mcp-tokens-api-under-test',
            memory_limit_in_mb=256,
            invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:voc-mcp-tokens-api-under-test',
            aws_request_id='req-mcp-tokens-handler-mutation-0001',
            get_remaining_time_in_millis=lambda: 30_000,
        )
        response = h.lambda_handler(rest_event('GET', '/connect/tokens', claims=world.claims('alice')), context)
        assert response['statusCode'] == 200
        keys = h.logger.get_current_keys()
        assert keys['function_name'] == 'voc-mcp-tokens-api-under-test'
        assert keys['function_request_id'] == 'req-mcp-tokens-handler-mutation-0001'
        assert_handler_wrapped(h)


# ── Who may manage tokens ───────────────────────────────────────────────────
class TestOnlyAPersonManagesTokens:
    @pytest.mark.parametrize(('method', 'path'), [
        ('GET', '/connect/tokens'),
        ('POST', '/connect/tokens'),
        ('DELETE', TOKEN_PATH),
        ('GET', TOKEN_PATH),
    ])
    def test_a_credential_is_refused_by_name_on_every_route(self, world, method, path):
        event = rest_event(method, path, claims={'sub': 'mcp:tok_1', 'voc:acting_subject': world.subs['alice']},
                           body={'name': 'x', 'scope': 'read'})
        response = h.lambda_handler(event, world.context)
        assert response['statusCode'] == 403
        assert json.loads(response['body']) == {'success': False,
                                                'error': 'Only a signed-in user can manage MCP tokens'}

    def test_an_agent_principal_is_refused_too(self, world):
        event = rest_event('GET', '/connect/tokens',
                           claims={'sub': 'agent:a1', 'voc:acting_subject': world.subs['alice']})
        response = h.lambda_handler(event, world.context)
        assert response['statusCode'] == 403
        assert json.loads(response['body'])['error'] == 'Only a signed-in user can manage MCP tokens'

    def test_a_delegated_caller_with_a_blank_subject_is_refused(self):
        caller = Caller(subject='', delegated=True)
        with patch.object(h.project_gate, 'caller_from_event', return_value=caller), \
                patch.object(h.app, 'current_event'), \
                pytest.raises(h.AuthorizationError, match=r'^Only a signed-in user can manage MCP tokens$'):
            h._caller()

    def test_a_person_is_returned_as_is(self):
        caller = Caller(subject='person', username='p')
        with patch.object(h.project_gate, 'caller_from_event', return_value=caller), \
                patch.object(h.app, 'current_event'):
            assert h._caller() is caller


class TestAnUnconfiguredTableIsA500NamingIt:
    def test_projects_table(self, world):
        with patch.object(h, 'get_projects_table', return_value=None):
            status, body = world.tokens_api('alice', 'GET', '/connect/tokens')
        assert status == 500
        assert body == {'success': False, 'error': 'Projects table not configured'}

    def test_jobs_table(self, world):
        minted = world.mint('alice', scope='read')
        with patch.object(h, 'get_jobs_table', return_value=None):
            status, body = world.tokens_api('alice', 'GET', f"/connect/tokens/{minted['token_id']}")
        assert status == 500
        assert body == {'success': False, 'error': 'Jobs table not configured'}


# ── Reading my rows ─────────────────────────────────────────────────────────
class TestRowsMintedBy:
    """The indexed read: pointer Query (creator prefix) → consistent BatchGetItem."""

    @staticmethod
    def _table(pointer_pages: list[dict], rows: list[dict], *, marker: bool = True) -> MagicMock:
        table = MagicMock()
        table.name = 'projects'
        table.query.side_effect = pointer_pages
        table.meta.client.batch_get_item.return_value = {'Responses': {'projects': rows}}
        table.get_item.return_value = {'Item': {'pk': 'MCPGTOKEN'}} if marker else {}
        return table

    def test_queries_only_the_callers_creator_prefix_consistently(self):
        table = self._table([{'Items': [{'token_id': 'tok_a'}]}], [{'token_id': 'tok_a', 'created_by': 'me'}])
        with patch.object(h, 'get_projects_table', return_value=table), \
                patch.dict(h._index_state, {'complete': False}):
            assert h._rows_minted_by('me') == [{'token_id': 'tok_a', 'created_by': 'me'}]
        kwargs = table.query.call_args_list[0].kwargs
        assert set(kwargs) == {'KeyConditionExpression', 'ProjectionExpression', 'ConsistentRead'}
        assert kwargs['ConsistentRead'] is True
        pk_condition, sk_condition = kwargs['KeyConditionExpression']._values
        assert (pk_condition._values[0].name, pk_condition._values[1]) == ('pk', 'MCPGTOKEN')
        assert sk_condition.expression_operator == 'begins_with'
        assert (sk_condition._values[0].name, sk_condition._values[1]) == ('sk', 'CREATOR#me#')
        table.query.assert_called_once()  # marker present: no legacy partition read
        assert 'FilterExpression' not in kwargs

    def test_follows_last_evaluated_key_across_pointer_pages(self):
        pages = [
            {'Items': [{'token_id': 'tok_a'}], 'LastEvaluatedKey': {'pk': 'MCPGTOKEN', 'sk': 'x'}},
            {'Items': [{'token_id': 'tok_b'}], 'LastEvaluatedKey': {'pk': 'MCPGTOKEN', 'sk': 'y'}},
            {'Items': [{'token_id': 'tok_c'}]},
        ]
        table = self._table(pages, [])
        with patch.object(h, 'get_projects_table', return_value=table), \
                patch.dict(h._index_state, {'complete': False}):
            h._rows_minted_by('me')
        starts = [call.kwargs.get('ExclusiveStartKey') for call in table.query.call_args_list]
        assert starts == [None, {'pk': 'MCPGTOKEN', 'sk': 'x'}, {'pk': 'MCPGTOKEN', 'sk': 'y'}]
        request = table.meta.client.batch_get_item.call_args.kwargs['RequestItems']['projects']
        assert request['ConsistentRead'] is True
        assert request['Keys'] == [{'pk': 'MCPGTOKEN', 'sk': f'TOKEN#tok_{c}'} for c in 'abc']

    def test_no_pointers_costs_no_batch_read(self):
        table = self._table([{}], [])
        with patch.object(h, 'get_projects_table', return_value=table), \
                patch.dict(h._index_state, {'complete': True}):
            assert h._rows_minted_by('me') == []
        table.meta.client.batch_get_item.assert_not_called()
        table.get_item.assert_not_called()  # a warm container remembers the marker

    def test_a_row_whose_minter_is_not_the_caller_is_dropped(self):
        table = self._table([{'Items': [{'token_id': 'tok_a'}, {'token_id': 'bad/id'}]}],
                            [{'token_id': 'tok_a', 'created_by': 'someone-else'}])
        with patch.object(h, 'get_projects_table', return_value=table), \
                patch.dict(h._index_state, {'complete': True}):
            assert h._rows_minted_by('me') == []
        keys = table.meta.client.batch_get_item.call_args.kwargs['RequestItems']['projects']['Keys']
        assert keys == [{'pk': 'MCPGTOKEN', 'sk': 'TOKEN#tok_a'}]  # a malformed pointer id is never read

    def test_without_the_marker_the_legacy_token_rows_are_merged_once(self):
        legacy = {'token_id': 'tok_old', 'created_by': 'me'}
        indexed = {'token_id': 'tok_a', 'created_by': 'me'}
        table = self._table([{'Items': [{'token_id': 'tok_a'}]}, {'Items': [legacy, indexed]}], [indexed],
                            marker=False)
        with patch.object(h, 'get_projects_table', return_value=table), \
                patch.dict(h._index_state, {'complete': False}):
            assert h._rows_minted_by('me') == [indexed, legacy]
            assert h._index_state['complete'] is False
        table.get_item.assert_called_once_with(Key={'pk': 'MCPGTOKEN', 'sk': 'MIGRATION#creator-index'},
                                               ConsistentRead=True)
        legacy_kwargs = table.query.call_args_list[1].kwargs
        _, sk_condition = legacy_kwargs['KeyConditionExpression']._values
        assert (sk_condition.expression_operator, sk_condition._values[1]) == ('begins_with', 'TOKEN#')
        filter_name, filter_value = legacy_kwargs['FilterExpression']._values
        assert (filter_name.name, filter_value) == ('created_by', 'me')

    @pytest.mark.parametrize('subject', ['', 'a#b'])
    def test_a_subject_that_could_address_another_prefix_is_refused(self, subject):
        with pytest.raises(ValueError, match='creator index'):
            gt.creator_index_prefix(subject)


class TestOwnedRow:
    @pytest.mark.parametrize('token_id', ['not-a-token', 'tok_a!b', 'proj_alpha', 'tok_a.b'])
    def test_a_malformed_id_is_404_without_a_read(self, token_id, lambda_context):
        table = MagicMock()
        status, body = _mock_table_call('DELETE', f'/connect/tokens/{token_id}', table, lambda_context)
        assert status == 404
        assert body == {'success': False, 'error': TOKEN_NOT_FOUND}
        table.get_item.assert_not_called()

    def test_the_read_is_strongly_consistent_on_the_global_partition(self, lambda_context):
        table = MagicMock()
        table.get_item.return_value = {}
        status, body = _mock_table_call('GET', TOKEN_PATH, table, lambda_context)
        assert status == 404
        assert body['error'] == TOKEN_NOT_FOUND
        table.get_item.assert_called_once_with(
            Key={'pk': 'MCPGTOKEN', 'sk': f'TOKEN#{TOKEN_ID}'}, ConsistentRead=True,
        )

    def test_a_non_dict_item_is_404(self, lambda_context):
        table = MagicMock()
        table.get_item.return_value = {'Item': 'garbage'}
        status, body = _mock_table_call('GET', TOKEN_PATH, table, lambda_context)
        assert status == 404
        assert body['error'] == TOKEN_NOT_FOUND

    def test_someone_elses_row_is_404_with_the_same_message(self, world):
        bobs = world.mint('bob', scope='read')
        for method in ('GET', 'DELETE'):
            status, body = world.tokens_api('alice', method, f"/connect/tokens/{bobs['token_id']}")
            assert status == 404
            assert body == {'success': False, 'error': TOKEN_NOT_FOUND}


# ── Mint ────────────────────────────────────────────────────────────────────
class TestEveryMintRefusalNamesItsCause:
    @pytest.mark.parametrize(('body', 'message'), [
        ({'scope': 'read'}, 'name is required'),
        ({'name': None, 'scope': 'read'}, 'name is required'),
        ({'name': 7, 'scope': 'read'}, 'name is required'),
        ({'name': '   ', 'scope': 'read'}, 'name is required'),
        ({'name': 'x' * 81, 'scope': 'read'}, 'name must be at most 80 characters'),
        ({'name': ' ' + 'x' * 81 + ' ', 'scope': 'read'}, 'name must be at most 80 characters'),
        ({'name': 'x'}, 'scope is required and must be one of: read, write'),
        ({'name': 'x', 'scope': 'READ'}, 'scope is required and must be one of: read, write'),
        ({'name': 'x', 'scope': ['read']}, 'scope is required and must be one of: read, write'),
        ({'name': 'x', 'scope': 'read', 'expires_in_days': 0},
         'expires_in_days must be an integer between 1 and 90'),
        ({'name': 'x', 'scope': 'read', 'expires_in_days': 91},
         'expires_in_days must be an integer between 1 and 90'),
        ({'name': 'x', 'scope': 'read', 'expires_in_days': True},
         'expires_in_days must be an integer between 1 and 90'),
        ({'name': 'x', 'scope': 'read', 'expires_in_days': '7'},
         'expires_in_days must be an integer between 1 and 90'),
        ({'name': 'x', 'scope': 'read', 'project_id': '../p'}, 'project_id is not a valid project id'),
        ({'name': 'x', 'scope': 'read', 'project_id': 7}, 'project_id is not a valid project id'),
        ({'name': 'x', 'scope': 'read', 'project_id': 'a b'}, 'project_id is not a valid project id'),
    ])
    def test_400_with_the_exact_message(self, world, body, message):
        status, answer = world.tokens_api('alice', 'POST', '/connect/tokens', body)
        assert status == 400
        assert answer == {'success': False, 'error': message}

    def test_a_non_object_body_is_400(self, world):
        event = rest_event('POST', '/connect/tokens', claims=world.claims('alice'), body=['x'])
        response = h.lambda_handler(event, world.context)
        assert response['statusCode'] == 400
        assert json.loads(response['body'])['error'] == 'the request body must be a JSON object'

    def test_validation_runs_name_then_scope_then_expiry_then_pin(self, world):
        def refusal(body: dict) -> str:
            return world.tokens_api('alice', 'POST', '/connect/tokens', body)[1]['error']

        # Every field is wrong; the first in order wins.
        bad = {'name': '', 'scope': 'x', 'expires_in_days': 0, 'project_id': '../p'}
        assert refusal(bad) == 'name is required'
        assert refusal({**bad, 'name': 'ok'}) == 'scope is required and must be one of: read, write'
        assert refusal({**bad, 'name': 'ok', 'scope': 'read'}) == \
            'expires_in_days must be an integer between 1 and 90'
        assert refusal({**bad, 'name': 'ok', 'scope': 'read', 'expires_in_days': 1}) == \
            'project_id is not a valid project id'


class TestMintAcceptsTheBoundaries:
    def test_an_80_character_name_is_kept_and_a_padded_name_is_trimmed(self, world):
        long_name = 'x' * 80
        assert world.mint('alice', name=long_name, scope='read')['name'] == long_name
        padded = world.mint('alice', name='  padded  ', scope='read')
        assert padded['name'] == 'padded'
        assert _row(world, padded['token_id'])['name'] == 'padded'

    @pytest.mark.parametrize('days', [1, 90])
    def test_expiry_boundaries_are_minted_relative_to_now(self, world, days):
        with patch.object(h, '_now', return_value=T0):
            minted = world.mint('alice', scope='read', expires_in_days=days)
        assert minted['created_at'] == T0.isoformat()
        assert minted['expires_at'] == (T0 + timedelta(days=days)).isoformat()

    def test_the_default_lifetime_is_30_days(self, world):
        with patch.object(h, '_now', return_value=T0):
            minted = world.mint('alice', scope='read')
        assert minted['expires_at'] == (T0 + timedelta(days=30)).isoformat()

    @pytest.mark.parametrize('body', [{'scope': 'read'}, {'scope': 'read', 'project_id': ''}])
    def test_no_pin_and_an_empty_pin_both_mint_a_workspace_token(self, world, body):
        minted = world.mint('alice', **body)
        assert minted['project_id'] is None
        assert 'project_id' not in _row(world, minted['token_id'])


class TestThePinMustNameAProjectTheMinterCanView:
    def test_a_viewable_public_project_pins(self, world):
        minted = world.mint('alice', scope='read', project_id=GAMMA)
        assert minted['project_id'] == GAMMA
        assert _row(world, minted['token_id'])['project_id'] == GAMMA

    @pytest.mark.parametrize(('username', 'project_id'), [
        ('alice', BETA),          # someone else's private project
        ('alice', 'proj_nope'),   # unknown, for a user
        ('root', 'proj_nope'),    # unknown, for an admin (who skips the access gate)
    ])
    def test_a_project_the_minter_cannot_see_is_404_project_not_found(self, world, username, project_id):
        status, body = world.tokens_api(username, 'POST', '/connect/tokens',
                                        {'name': 'x', 'scope': 'read', 'project_id': project_id})
        assert status == 404
        assert body == {'success': False, 'error': 'Project not found'}

    def test_an_admin_may_pin_any_existing_project(self, world):
        assert world.mint('root', scope='read', project_id=BETA)['project_id'] == BETA

    def test_the_pin_is_checked_at_view_level_for_the_caller(self):
        caller = Caller(subject='s')
        table = MagicMock()
        with patch.object(h, 'get_projects_table', return_value=table), \
                patch.object(h.project_gate, 'require_project_level') as require, \
                patch.object(h.project_gate, 'read_gate_meta', return_value={'pk': 'x'}) as read_meta:
            assert h._token_project({'project_id': ALPHA}, caller) == ALPHA
            require.assert_called_once()
            read_gate, passed_caller, level = require.call_args.args
            assert passed_caller is caller
            assert level == 'view'
            # The gate's reader is lazy: only the gate decides whether to spend the read.
            read_meta.assert_not_called()
            assert read_gate() == {'pk': 'x'}
            read_meta.assert_called_once_with(table, ALPHA)


class TestTheActiveTokenCap:
    def test_the_409_names_the_cap(self, world):
        with patch.object(gt, 'MAX_ACTIVE_TOKENS_PER_USER', 2):
            world.mint('alice', scope='read')
            world.mint('alice', scope='read')
            status, body = world.tokens_api('alice', 'POST', '/connect/tokens', {'name': 'x', 'scope': 'read'})
        assert status == 409
        assert body == {'success': False, 'error': 'You already have 2 active MCP tokens; revoke one first'}

    def test_exactly_one_below_the_cap_still_mints(self, world):
        with patch.object(gt, 'MAX_ACTIVE_TOKENS_PER_USER', 2):
            world.mint('alice', scope='read')
            status, _ = world.tokens_api('alice', 'POST', '/connect/tokens', {'name': 'x', 'scope': 'read'})
        assert status == 200

    def test_revoked_and_expired_tokens_do_not_count(self, world):
        with patch.object(gt, 'MAX_ACTIVE_TOKENS_PER_USER', 2):
            revoked = world.mint('alice', scope='read')
            world.tokens_api('alice', 'DELETE', f"/connect/tokens/{revoked['token_id']}")
            expired = world.mint('alice', scope='read', expires_in_days=1)
            world.projects.update_item(
                Key={'pk': gt.GLOBAL_TOKEN_PK, 'sk': gt.token_sk(expired['token_id'])},
                UpdateExpression='SET expires_at = :past',
                ExpressionAttributeValues={':past': (datetime.now(UTC) - timedelta(seconds=1)).isoformat()},
            )
            world.mint('alice', scope='read')
            status, _ = world.tokens_api('alice', 'POST', '/connect/tokens', {'name': 'x', 'scope': 'read'})
        assert status == 200

    def test_the_cap_is_per_minter(self, world):
        with patch.object(gt, 'MAX_ACTIVE_TOKENS_PER_USER', 1):
            world.mint('bob', scope='read')
            status, _ = world.tokens_api('alice', 'POST', '/connect/tokens', {'name': 'x', 'scope': 'read'})
        assert status == 200


class TestWhatAMintWrites:
    def test_the_row_and_the_answer(self, world):
        with patch.object(h, '_now', return_value=T0), handler_info(h.logger) as info:
            minted = world.mint('alice', name='laptop', scope='write', project_id=GAMMA, expires_in_days=7)
        expires_at = (T0 + timedelta(days=7)).isoformat()
        row = _row(world, minted['token_id'])
        assert row == {
            'pk': 'MCPGTOKEN',
            'sk': f"TOKEN#{minted['token_id']}",
            'token_id': minted['token_id'],
            'name': 'laptop',
            'secret_hash': row['secret_hash'],
            'scope': 'write',
            'created_by': world.subs['alice'],
            'created_by_username': 'alice',
            'minted_by_admin': False,
            'created_at': T0.isoformat(),
            'expires_at': expires_at,
            'project_id': GAMMA,
        }
        assert minted == {
            'token': minted['token'],
            'token_id': minted['token_id'],
            'name': 'laptop',
            'scope': 'write',
            'project_id': GAMMA,
            'created_at': T0.isoformat(),
            'expires_at': expires_at,
            'last_used_at': None,
            'revoked_at': None,
            'status': 'active',
            'can_run_agents': False,
        }
        info.assert_called_once_with('Minted global MCP token',
                                     extra={'token_id': minted['token_id'], 'scope': 'write', 'pinned': True})

    def test_an_admin_row_records_it_and_an_unpinned_mint_logs_pinned_false(self, world):
        with handler_info(h.logger) as info:
            minted = world.mint('root', name='r', scope='read')
        row = _row(world, minted['token_id'])
        assert row['minted_by_admin'] is True
        assert row['created_by_username'] == 'root'
        info.assert_called_once_with('Minted global MCP token',
                                     extra={'token_id': minted['token_id'], 'scope': 'read', 'pinned': False})

    def test_the_token_and_its_pointer_are_one_transaction_of_fresh_keys(self, lambda_context):
        table = MagicMock()
        table.name = 'projects'
        table.query.return_value = {'Items': []}
        with patch.object(h, '_now', return_value=T0):
            status, _ = _mock_table_call('POST', '/connect/tokens', table, lambda_context,
                                         body={'name': 'x', 'scope': 'read'})
        assert status == 200
        table.put_item.assert_not_called()
        token_put, pointer_put = (entry['Put'] for entry in
                                  table.meta.client.transact_write_items.call_args.kwargs['TransactItems'])
        assert token_put['TableName'] == pointer_put['TableName'] == 'projects'
        assert token_put['ConditionExpression'] == pointer_put['ConditionExpression'] == 'attribute_not_exists(sk)'
        token_id = token_put['Item']['token_id']
        assert token_put['Item']['created_by'] == ALICE_SUB
        assert pointer_put['Item'] == {'pk': 'MCPGTOKEN', 'sk': f'CREATOR#{ALICE_SUB}#TOKEN#{token_id}',
                                       'token_id': token_id, 'created_by': ALICE_SUB,
                                       'created_at': T0.isoformat()}


# ── List ────────────────────────────────────────────────────────────────────
class TestList:
    def test_the_envelope_literals_for_a_user_and_an_admin(self, world):
        _, alice = world.tokens_api('alice', 'GET', '/connect/tokens')
        _, root = world.tokens_api('root', 'GET', '/connect/tokens')
        assert alice == {
            'tokens': [],
            'endpoint_path': '/mcp/global',
            'can_mint_agent_runner': False,
            'limits': {'default_expiry_days': 30, 'max_expiry_days': 90, 'max_active_tokens': 20},
        }
        assert root['can_mint_agent_runner'] is True
        assert h.GLOBAL_ENDPOINT_PATH == '/mcp/global'

    def test_newest_first_and_a_row_without_created_at_sorts_last(self, world):
        # Stored in sort-key order aaaa < mmmm < zzzz, deliberately the REVERSE of recency,
        # so a sort that silently falls back to query order is visible.
        def stored(token_id: str, **extra: Any) -> None:
            world.projects.put_item(Item={
                'pk': gt.GLOBAL_TOKEN_PK, 'sk': gt.token_sk(token_id), 'token_id': token_id,
                'created_by': world.subs['alice'], 'scope': 'read', 'expires_at': '2099-01-01T00:00:00+00:00',
                **extra,
            })

        stored('tok_aaaa', created_at=T0.isoformat())
        stored('tok_mmmm')
        stored('tok_zzzz', created_at=(T0 + timedelta(minutes=1)).isoformat())
        _, listed = world.tokens_api('alice', 'GET', '/connect/tokens')
        assert [t['token_id'] for t in listed['tokens']] == ['tok_zzzz', 'tok_aaaa', 'tok_mmmm']
        assert listed['tokens'][0]['created_at'] == (T0 + timedelta(minutes=1)).isoformat()

    def test_statuses_are_evaluated_at_list_time(self, world):
        minted = world.mint('alice', scope='read', expires_in_days=1)
        with patch.object(h, '_now', return_value=datetime.now(UTC) + timedelta(days=2)):
            _, listed = world.tokens_api('alice', 'GET', '/connect/tokens')
        assert [t['status'] for t in listed['tokens']] == ['expired']
        assert listed['tokens'][0]['token_id'] == minted['token_id']


# ── Revoke ──────────────────────────────────────────────────────────────────
class TestRevoke:
    def test_the_first_revoke_stamps_now_and_logs(self, world):
        minted = world.mint('alice', scope='read')
        with patch.object(h, '_now', return_value=T0), handler_info(h.logger) as info:
            status, body = world.tokens_api('alice', 'DELETE', f"/connect/tokens/{minted['token_id']}")
        assert status == 200
        assert set(body) == {'token'}
        assert body['token']['revoked_at'] == T0.isoformat()
        assert body['token']['status'] == 'revoked'
        assert body['token']['token_id'] == minted['token_id']
        assert _row(world, minted['token_id'])['revoked_at'] == T0.isoformat()
        info.assert_called_once_with('Revoked global MCP token', extra={'token_id': minted['token_id']})

    def test_a_second_revoke_neither_writes_nor_logs(self, world):
        minted = world.mint('alice', scope='read')
        with patch.object(h, '_now', return_value=T0):
            world.tokens_api('alice', 'DELETE', f"/connect/tokens/{minted['token_id']}")
        with patch.object(h, '_now', return_value=T0 + timedelta(hours=1)), \
                handler_info(h.logger) as info, \
                patch.object(world.projects, 'update_item') as update:
            status, body = world.tokens_api('alice', 'DELETE', f"/connect/tokens/{minted['token_id']}")
        assert status == 200
        assert body['token']['revoked_at'] == T0.isoformat()
        update.assert_not_called()
        info.assert_not_called()

    def test_the_update_is_conditional_and_returns_the_stored_row(self, lambda_context):
        table = MagicMock()
        table.get_item.return_value = {'Item': _stored_row()}
        # The stored row gained a last_used_at between the read and the update: the answer must show it.
        table.update_item.return_value = {
            'Attributes': _stored_row(revoked_at=T0.isoformat(), last_used_at='2026-02-02T00:00:00+00:00'),
        }
        with patch.object(h, '_now', return_value=T0):
            status, body = _mock_table_call('DELETE', TOKEN_PATH, table, lambda_context)
        assert status == 200
        assert body['token']['last_used_at'] == '2026-02-02T00:00:00+00:00'
        assert body['token']['revoked_at'] == T0.isoformat()
        table.update_item.assert_called_once_with(
            Key={'pk': 'MCPGTOKEN', 'sk': f'TOKEN#{TOKEN_ID}'},
            UpdateExpression='SET revoked_at = :now',
            ConditionExpression='attribute_exists(sk) AND attribute_not_exists(revoked_at)',
            ExpressionAttributeValues={':now': T0.isoformat()},
            ReturnValues='ALL_NEW',
        )
        table.get_item.assert_called_once()

    def test_without_attributes_in_the_reply_the_answer_is_the_row_stamped_now(self, lambda_context):
        table = MagicMock()
        table.get_item.return_value = {'Item': _stored_row()}
        table.update_item.return_value = {}
        with patch.object(h, '_now', return_value=T0):
            status, body = _mock_table_call('DELETE', TOKEN_PATH, table, lambda_context)
        assert status == 200
        assert body['token']['revoked_at'] == T0.isoformat()
        assert body['token']['status'] == 'revoked'

    def test_a_lost_race_re_reads_the_row_instead_of_writing(self, lambda_context):
        table = MagicMock()
        table.get_item.side_effect = [{'Item': _stored_row()},
                                      {'Item': _stored_row(revoked_at='2026-01-01T00:00:00+00:00')}]
        table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'lost'}}, 'UpdateItem')
        with patch.object(h, '_now', return_value=T0), handler_info(h.logger) as info:
            status, body = _mock_table_call('DELETE', TOKEN_PATH, table, lambda_context)
        assert status == 200
        assert body['token']['revoked_at'] == '2026-01-01T00:00:00+00:00'
        assert table.get_item.call_count == 2
        table.update_item.assert_called_once()
        info.assert_not_called()

    def test_any_other_dynamodb_fault_propagates(self, lambda_context):
        table = MagicMock()
        table.get_item.return_value = {'Item': _stored_row()}
        table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow'}}, 'UpdateItem')
        with patch.object(h, '_now', return_value=T0), \
                pytest.raises(ClientError, match='ProvisionedThroughputExceededException'):
            _mock_table_call('DELETE', TOKEN_PATH, table, lambda_context)
        table.get_item.assert_called_once()


# ── Detail + audit paging ───────────────────────────────────────────────────
class TestCursorDecoding:
    @pytest.mark.parametrize('raw', [None, ''])
    def test_absent_or_empty_means_first_page(self, raw):
        assert h._decoded_cursor(raw, TOKEN_ID) is None

    def test_a_cursor_for_this_tokens_partition_is_returned_as_is(self):
        cursor = {'pk': AUDIT_PK, 'sk': '2026-01-01T00:00:00+00:00#abcd'}
        assert h._decoded_cursor(_cursor(cursor), TOKEN_ID) == cursor

    @pytest.mark.parametrize('raw', [
        '!!!not-base64',                                                  # binascii.Error
        base64.urlsafe_b64encode(b'\xff\xfe').decode(),                   # UnicodeDecodeError
        base64.urlsafe_b64encode(b'{not json').decode(),                  # JSONDecodeError
        _cursor('a string'),                                              # not an object
        _cursor(['pk', 'sk']),
        _cursor({'pk': 'MCPAUDIT#tok_other', 'sk': 'x'}),                 # another token's partition
        _cursor({'pk': 'PROJECT#x', 'sk': 'META'}),
        _cursor({'pk': AUDIT_PK, 'sk': 7}),                               # sk not a string
        _cursor({'pk': AUDIT_PK}),                                        # no sk
        _cursor({'pk': AUDIT_PK, 'sk': 'x', 'extra': 1}),
    ])
    def test_every_malformed_cursor_is_refused_with_one_message(self, raw):
        with pytest.raises(h.ValidationError, match=r'^cursor is invalid$'):
            h._decoded_cursor(raw, TOKEN_ID)

    def test_over_http_the_refusal_is_400(self, world):
        minted = world.mint('alice', scope='read')
        status, body = world.tokens_api('alice', 'GET', f"/connect/tokens/{minted['token_id']}",
                                        query={'cursor': '!!!'})
        assert status == 400
        assert body == {'success': False, 'error': 'cursor is invalid'}


class TestCursorEncoding:
    @pytest.mark.parametrize('last_key', [None, 'x', 7, ['pk']])
    def test_anything_but_a_key_dict_ends_paging(self, last_key):
        assert h._encoded_cursor(last_key) is None

    def test_a_key_round_trips(self):
        key = {'pk': AUDIT_PK, 'sk': '2026-01-01T00:00:00+00:00#ab'}
        encoded = h._encoded_cursor(key)
        assert encoded is not None
        assert _decode(encoded) == key
        assert h._decoded_cursor(encoded, TOKEN_ID) == key


class TestTokenDetail:
    def test_events_newest_first_paged_by_audit_page_size_with_a_cursor_for_the_rest(self, world):
        minted = world.mint('alice', scope='read')
        token_id = minted['token_id']
        rows = [_audit(world, token_id, T0 + timedelta(minutes=i), tool=f'tool_{i}') for i in range(3)]
        with patch.object(gt, 'AUDIT_PAGE_SIZE', 2), patch.object(h, '_now', return_value=T0):
            status, first = world.tokens_api('alice', 'GET', f'/connect/tokens/{token_id}')
            assert status == 200
            assert first['next_cursor'] is not None
            status, rest = world.tokens_api('alice', 'GET', f'/connect/tokens/{token_id}',
                                            query={'cursor': first['next_cursor']})
        assert set(first) == {'token', 'events', 'next_cursor'}
        assert first['token'] == {key: value for key, value in minted.items() if key != 'token'}
        assert first['events'] == [
            {'tool': 'tool_2', 'at': rows[2]['at'], 'project_id': None, 'outcome': 'ok'},
            {'tool': 'tool_1', 'at': rows[1]['at'], 'project_id': None, 'outcome': 'ok'},
        ]
        assert _decode(first['next_cursor']) == {'pk': f'MCPAUDIT#{token_id}', 'sk': rows[1]['sk']}
        assert status == 200
        assert rest['events'] == [{'tool': 'tool_0', 'at': rows[0]['at'], 'project_id': None, 'outcome': 'ok'}]
        assert rest['next_cursor'] is None

    def test_an_empty_cursor_parameter_is_the_first_page(self, world):
        minted = world.mint('alice', scope='read')
        _audit(world, minted['token_id'], T0)
        status, body = world.tokens_api('alice', 'GET', f"/connect/tokens/{minted['token_id']}",
                                        query={'cursor': ''})
        assert status == 200
        assert len(body['events']) == 1

    def test_the_audit_query_as_sent(self, lambda_context):
        table = MagicMock()
        table.get_item.return_value = {'Item': _stored_row()}
        jobs = MagicMock()
        jobs.query.return_value = {'Items': [{'tool': 't', 'at': 'a', 'outcome': 'ok'}],
                                   'LastEvaluatedKey': {'pk': AUDIT_PK, 'sk': 'a#1'}}
        status, body = _mock_table_call('GET', TOKEN_PATH, table, lambda_context, jobs=jobs)
        assert status == 200
        kwargs = jobs.query.call_args.kwargs
        assert set(kwargs) == {'KeyConditionExpression', 'ScanIndexForward', 'Limit'}
        assert kwargs['ScanIndexForward'] is False
        assert kwargs['Limit'] == 50
        key_name, key_value = kwargs['KeyConditionExpression']._values
        assert (key_name.name, key_value) == ('pk', AUDIT_PK)
        assert body['events'] == [{'tool': 't', 'at': 'a', 'project_id': None, 'outcome': 'ok'}]
        assert _decode(body['next_cursor']) == {'pk': AUDIT_PK, 'sk': 'a#1'}

    def test_a_cursor_becomes_the_exclusive_start_key(self, lambda_context):
        table = MagicMock()
        table.get_item.return_value = {'Item': _stored_row()}
        jobs = MagicMock()
        jobs.query.return_value = {}
        cursor = {'pk': AUDIT_PK, 'sk': 'a#1'}
        with patch.object(h, '_now', return_value=T0):
            status, body = _mock_table_call('GET', TOKEN_PATH, table, lambda_context, jobs=jobs,
                                            query={'cursor': _cursor(cursor)})
        assert status == 200
        assert jobs.query.call_args.kwargs['ExclusiveStartKey'] == cursor
        assert body == {'token': gt.token_view(_stored_row(), T0), 'events': [], 'next_cursor': None}
