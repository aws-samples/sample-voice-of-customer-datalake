"""Ways of working with AI on the users API (docs/ways-of-working.md → Storage and routes):
``GET /users/me/ai-mode`` and the ``ai_mode`` / ``ai_writing_*`` fields of
``PUT /users/{username}/flags``, against a moto aggregates table.

conftest's autouse ``_ai_driven_by_default`` patches ``shared.ai_mode.get_ai_mode`` for
every API test; these tests are about that very read, so they put the real one back.
"""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import BotoCoreError, ClientError
from handler_events_fixtures import call_route
from users_table_fixtures import users_aggregates_table

import users_handler
from shared import ai_mode
from users_handler import lambda_handler

# Captured at import, before any autouse fixture patches it.
REAL_GET_AI_MODE = ai_mode.get_ai_mode
ADMIN = {'sub': 'admin-sub', 'cognito:groups': 'admins'}
ADA = {'sub': 'sub-ada', 'cognito:groups': 'users'}
SUBS = {'ada': 'sub-ada', 'bob': 'sub-bob'}
DEFAULT_ANSWER = {'mode': 'ai_driven', 'ai_writing_prfaq': False, 'ai_writing_prd': False}


@pytest.fixture(autouse=True)
def _real_mode_reads() -> Iterator[None]:
    with patch('shared.ai_mode.get_ai_mode', REAL_GET_AI_MODE):
        yield


@pytest.fixture
def table() -> Iterator[Any]:
    with users_aggregates_table() as table:
        yield table


@pytest.fixture
def cognito() -> Iterator[MagicMock]:
    mock = MagicMock()
    mock.exceptions.UserNotFoundException = type('UserNotFoundException', (Exception,), {})
    mock.admin_get_user.side_effect = lambda Username, **_kw: {
        'UserAttributes': [{'Name': 'sub', 'Value': SUBS[Username]}]}
    mock.admin_list_groups_for_user.return_value = {'Groups': [{'GroupName': 'admins'}]}
    with patch.object(users_handler, 'cognito', mock):
        yield mock


def _mode_row(table: Any, sub: str) -> dict:
    return table.get_item(Key={'pk': f'USERFLAGS#{sub}', 'sk': 'ai_mode'}).get('Item') or {}


def _flags_row(table: Any, sub: str) -> dict:
    return table.get_item(Key={'pk': f'USERFLAGS#{sub}', 'sk': 'config'}).get('Item') or {}


def _get_mine(api_gateway_event, lambda_context, claims: dict = ADA) -> tuple[dict, Any]:
    return call_route(lambda_handler, api_gateway_event, lambda_context, method='GET',
                      path='/users/me/ai-mode', claims=claims)


def _put_flags(api_gateway_event, lambda_context, body: dict, username: str = 'ada',
               claims: dict = ADMIN) -> tuple[dict, Any]:
    return call_route(lambda_handler, api_gateway_event, lambda_context, method='PUT',
                      path=f'/users/{username}/flags', body=body, claims=claims)


class TestMyOwnMode:
    @pytest.mark.usefixtures('table')
    def test_a_person_without_a_row_is_told_ai_driven(self, api_gateway_event, lambda_context):
        response, body = _get_mine(api_gateway_event, lambda_context)

        assert response['statusCode'] == 200
        assert body == {'success': True, 'ai_mode': DEFAULT_ANSWER}

    def test_any_signed_in_user_reads_their_own_mode_not_an_admin_only_route(
            self, table, api_gateway_event, lambda_context):
        table.put_item(Item={'pk': 'USERFLAGS#sub-ada', 'sk': 'ai_mode', 'mode': 'human_driven',
                             'ai_writing_prfaq': True, 'ai_writing_prd': False})

        response, body = _get_mine(api_gateway_event, lambda_context)

        assert response['statusCode'] == 200
        assert body['ai_mode'] == {'mode': 'human_driven', 'ai_writing_prfaq': True, 'ai_writing_prd': False}

    def test_the_caller_reads_only_their_own_row(self, table, api_gateway_event, lambda_context):
        table.put_item(Item={'pk': 'USERFLAGS#sub-bob', 'sk': 'ai_mode', 'mode': 'human_driven'})

        _, body = _get_mine(api_gateway_event, lambda_context)

        assert body['ai_mode'] == DEFAULT_ANSWER

    @pytest.mark.parametrize('failure', [
        ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'GetItem'), BotoCoreError()])
    def test_an_unreadable_row_is_a_500_not_a_default(self, failure, api_gateway_event, lambda_context):
        aggregates = MagicMock()
        aggregates.get_item.side_effect = failure
        with patch.object(users_handler, 'aggregates_table', aggregates):
            response, body = _get_mine(api_gateway_event, lambda_context)

        assert response['statusCode'] == 500
        assert body['error'] == 'Failed to read your way of working'
        assert 'ai_mode' not in body

    def test_without_a_table_the_route_is_a_500(self, api_gateway_event, lambda_context):
        with patch.object(users_handler, 'aggregates_table', None):
            response, body = _get_mine(api_gateway_event, lambda_context)

        assert (response['statusCode'], body['error']) == (500, 'Aggregates table not configured')

    @pytest.mark.usefixtures('table')
    def test_the_answer_is_never_cached(self, api_gateway_event, lambda_context):
        response, _ = _get_mine(api_gateway_event, lambda_context)

        headers = {k.lower(): v for k, v in (response.get('headers') or {}).items()}
        multi = {k.lower(): v for k, v in (response.get('multiValueHeaders') or {}).items()}
        cache_control = headers.get('cache-control') or ','.join(multi.get('cache-control', []))
        assert 'no-store' in cache_control


@pytest.mark.usefixtures('cognito')
class TestAnAdminSetsTheMode:
    def test_a_mode_only_body_saves_only_the_mode_row(self, table, api_gateway_event, lambda_context):
        response, body = _put_flags(api_gateway_event, lambda_context, {'ai_mode': 'human_driven'})

        assert response['statusCode'] == 200
        assert body == {'success': True, 'username': 'ada', 'ai_mode': {
            'mode': 'human_driven', 'ai_writing_prfaq': False, 'ai_writing_prd': False}}
        assert _mode_row(table, 'sub-ada')['updated_by'] == 'admin-sub'
        assert _flags_row(table, 'sub-ada') == {}

    @pytest.mark.usefixtures('table')
    def test_an_unlock_only_body_keeps_the_mode(self, api_gateway_event, lambda_context):
        _put_flags(api_gateway_event, lambda_context, {'ai_mode': 'human_driven'})

        _, body = _put_flags(api_gateway_event, lambda_context, {'ai_writing_prd': True})

        assert body['ai_mode'] == {'mode': 'human_driven', 'ai_writing_prfaq': False, 'ai_writing_prd': True}
        assert 'flags' not in body

    def test_a_mixed_body_saves_both_rows_and_answers_both(self, table, api_gateway_event, lambda_context):
        response, body = _put_flags(api_gateway_event, lambda_context,
                                    {'memory_reviewer': True, 'ai_mode': 'ai_assisted', 'ai_writing_prfaq': True})

        assert response['statusCode'] == 200
        assert body['flags'] == {'fallback_owner': False, 'memory_reviewer': True}
        assert body['ai_mode'] == {'mode': 'ai_assisted', 'ai_writing_prfaq': True, 'ai_writing_prd': False}
        assert _mode_row(table, 'sub-ada')['mode'] == 'ai_assisted'
        assert _flags_row(table, 'sub-ada') != {}

    def test_a_flags_only_body_answers_no_ai_mode_and_writes_no_mode_row(
            self, table, api_gateway_event, lambda_context):
        _, body = _put_flags(api_gateway_event, lambda_context, {'memory_reviewer': True})

        assert 'ai_mode' not in body
        assert _mode_row(table, 'sub-ada') == {}

    @pytest.mark.usefixtures('table')
    def test_what_the_admin_sets_is_what_the_person_then_reads(self, api_gateway_event, lambda_context):
        _put_flags(api_gateway_event, lambda_context, {'ai_mode': 'human_driven', 'ai_writing_prfaq': True})

        _, mine = _get_mine(api_gateway_event, lambda_context)

        assert mine['ai_mode'] == {'mode': 'human_driven', 'ai_writing_prfaq': True, 'ai_writing_prd': False}

    @pytest.mark.usefixtures('table')
    def test_the_unlocks_survive_a_trip_to_ai_assisted_and_back(self, api_gateway_event, lambda_context):
        _put_flags(api_gateway_event, lambda_context, {'ai_mode': 'human_driven', 'ai_writing_prd': True})
        _put_flags(api_gateway_event, lambda_context, {'ai_mode': 'ai_assisted'})

        _, body = _put_flags(api_gateway_event, lambda_context, {'ai_mode': 'human_driven'})

        assert body['ai_mode'] == {'mode': 'human_driven', 'ai_writing_prfaq': False, 'ai_writing_prd': True}

    def test_one_persons_mode_does_not_change_anothers(self, table, api_gateway_event, lambda_context):
        _put_flags(api_gateway_event, lambda_context, {'ai_mode': 'human_driven'}, username='bob')

        assert _mode_row(table, 'sub-ada') == {}
        assert _mode_row(table, 'sub-bob')['mode'] == 'human_driven'

    @pytest.mark.parametrize('mode', ['human_driven', 'ai_assisted', 'ai_driven'])
    @pytest.mark.usefixtures('table')
    def test_every_mode_can_be_set(self, mode, api_gateway_event, lambda_context):
        _, body = _put_flags(api_gateway_event, lambda_context, {'ai_mode': mode})

        assert body['ai_mode']['mode'] == mode

    def test_a_non_admin_cannot_set_anyones_mode_including_their_own(
            self, table, api_gateway_event, lambda_context):
        response, _ = _put_flags(api_gateway_event, lambda_context, {'ai_mode': 'ai_driven'}, claims=ADA)

        assert response['statusCode'] == 403
        assert _mode_row(table, 'sub-ada') == {}

    @pytest.mark.parametrize('body', [{'ai_mode': None}, {'ai_mode': 'AI_DRIVEN'}, {'ai_mode': ''}])
    def test_an_unknown_mode_is_refused_and_nothing_is_stored(self, body, table, api_gateway_event, lambda_context):
        response, decoded = _put_flags(api_gateway_event, lambda_context, body)

        assert response['statusCode'] == 400
        assert decoded['error'] == 'ai_mode must be one of: human_driven, ai_assisted, ai_driven'
        assert _mode_row(table, 'sub-ada') == {}

    def test_a_failed_mode_write_is_a_fixed_500(self, api_gateway_event, lambda_context):
        aggregates = MagicMock()
        aggregates.get_item.return_value = {}
        aggregates.put_item.side_effect = ClientError(
            {'Error': {'Code': 'InternalServerError', 'Message': 'arn:aws:dynamodb:secret'}}, 'PutItem')
        with patch.object(users_handler, 'aggregates_table', aggregates):
            response, body = _put_flags(api_gateway_event, lambda_context, {'ai_mode': 'human_driven'})

        assert (response['statusCode'], body['error']) == (500, 'Failed to save the way of working')
        assert 'arn:' not in response['body']
