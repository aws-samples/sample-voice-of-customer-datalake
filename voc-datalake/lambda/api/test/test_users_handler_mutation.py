"""Mutation hardening for `users_handler.py` (Cognito user administration, admin only).

The earlier suites pin the happy path of each route, that a Cognito failure is a
fixed 500 that leaks nothing, and that an unknown user is a 404. A mutation run
found what they could not see:

* the admin gate on EVERY route: only two routes were driven by a non-admin, and
  none asserted that the refusal happens before any Cognito or table call, or the
  refusal's wording;
* the exact Cognito calls — pool id, `Limit=60`, the attribute list `POST /users`
  writes (order, the `name` fallback, stripping), the groups removed on a group
  change (only `admins`/`users`), `DesiredDeliveryMediums`;
* every refusal's wording (the Users admin UI shows the 400 body) and every
  `logger.exception` message an operator searches for;
* pagination edges: a non-string or empty token ends the walk, `NextToken` wins
  over `PaginationToken`, a page without the items key is empty;
* the category-access and flags routes' exact reads and writes (consistent read,
  the stored row, `updated_by`, the `set_flags` arguments), the fallback-owner
  drop that happens only on a demotion and only with a table, and the order of
  checks (a bad body or a missing table refuses before Cognito is called).
"""
import os
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from types import ModuleType
from typing import Any
from unittest.mock import MagicMock, call, patch

import pytest
from botocore.exceptions import BotoCoreError, ClientError
from category_access_fixtures import aggregates_with
from handler_events_fixtures import call_route
from module_reload_fixtures import reload_cycle

import users_handler
from shared.category_access import access_key
from shared.concurrency import ordered_map
from shared.exceptions import ConflictError
from shared.test.instrumentation_fixtures import assert_handler_wrapped, assert_tracer_wrapped

POOL = os.environ['USER_POOL_ID']
CALLER_SUB = 'test-user-id'  # the conftest event's default (admin) caller
NON_ADMIN = {'sub': 'viewer-sub', 'cognito:groups': 'users'}
CONFIG_ROW = {'pk': 'SETTINGS#categories', 'sk': 'config'}


class _UserNotFound(Exception):
    pass


class _UsernameExists(Exception):
    pass


@pytest.fixture
def cognito() -> Iterator[MagicMock]:
    mock = MagicMock()
    mock.exceptions.UserNotFoundException = _UserNotFound
    mock.exceptions.UsernameExistsException = _UsernameExists
    mock.admin_get_user.return_value = {'UserAttributes': [{'Name': 'sub', 'Value': 'sub-alice'}]}
    with patch.object(users_handler, 'cognito', mock):
        yield mock


@pytest.fixture
def aggregates() -> Iterator[MagicMock]:
    table = aggregates_with({**CONFIG_ROW, 'categories': [{'name': 'delivery'}, {'name': 'billing'}]})
    with patch.object(users_handler, 'aggregates_table', table):
        yield table


@pytest.fixture
def no_table() -> Iterator[None]:
    with patch.object(users_handler, 'aggregates_table', None):
        yield


@pytest.fixture
def log() -> Iterator[MagicMock]:
    mock = MagicMock()
    with patch.object(users_handler, 'logger', mock):
        yield mock


def _call(api_gateway_event, lambda_context, method: str, path: str, body: Any = None,
          claims: dict | None = None) -> tuple[int, Any]:
    response, decoded = call_route(users_handler.lambda_handler, api_gateway_event, lambda_context,
                                   method=method, path=path, body=body, claims=claims)
    return response['statusCode'], decoded


def _client_error() -> ClientError:
    return ClientError({'Error': {'Code': 'InternalErrorException', 'Message': 'boom'}}, 'Op')


_EVERY_ROUTE = [
    pytest.param('GET', '/users', None, id='list'),
    pytest.param('POST', '/users', {'email': 'a@example.com'}, id='create'),
    pytest.param('PUT', '/users/alice', {'given_name': 'A'}, id='update'),
    pytest.param('PUT', '/users/alice/group', {'group': 'admins'}, id='group'),
    pytest.param('POST', '/users/alice/reset-password', None, id='reset-password'),
    pytest.param('PUT', '/users/alice/enable', None, id='enable'),
    pytest.param('PUT', '/users/alice/disable', None, id='disable'),
    pytest.param('DELETE', '/users/alice', None, id='delete'),
    pytest.param('GET', '/users/alice/category-access', None, id='get-category-access'),
    pytest.param('PUT', '/users/alice/category-access', {'categories': ['*']}, id='put-category-access'),
    pytest.param('PUT', '/users/alice/flags', {'memory_reviewer': True}, id='flags'),
]


class TestColdStart:
    @pytest.fixture
    def reload_with_env(self, monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[..., ModuleType]]:
        yield from reload_cycle(monkeypatch, users_handler)

    def test_unset_environment_reads_as_empty_and_no_table(self, reload_with_env):
        module = reload_with_env(USER_POOL_ID=None, AGGREGATES_TABLE=None)

        assert (module.USER_POOL_ID, module.AGGREGATES_TABLE, module.aggregates_table) == ('', '', None)

    def test_the_named_pool_table_and_a_cognito_client(self, reload_with_env):
        module = reload_with_env(USER_POOL_ID='pool-named', AGGREGATES_TABLE='named-aggregates')

        assert module.USER_POOL_ID == 'pool-named'
        assert module.aggregates_table.name == 'named-aggregates'
        assert module.cognito.meta.service_model.service_name == 'cognito-idp'


class TestEveryEntryPointIsInstrumented:
    @pytest.mark.parametrize('route', [
        'list_users', 'create_user', 'update_user', 'update_user_group', 'reset_user_password',
        'enable_user', 'disable_user', 'delete_user', 'get_user_category_access',
        'put_user_category_access', 'put_user_flags'])
    def test_every_route_is_the_tracer_wrapper(self, route):
        assert_tracer_wrapped(users_handler, route)

    def test_the_handler_keeps_its_decorator(self):
        assert_handler_wrapped(users_handler)


class TestEveryRouteRefusesANonAdminFirst:
    @pytest.mark.parametrize(('method', 'path', 'body'), _EVERY_ROUTE)
    def test_403_before_any_cognito_or_table_call(
            self, method, path, body, cognito, aggregates, api_gateway_event, lambda_context):
        status, decoded = _call(api_gateway_event, lambda_context, method, path, body, claims=NON_ADMIN)

        assert status == 403
        assert decoded['error'] == 'Admin access required'
        assert cognito.mock_calls == []
        assert aggregates.mock_calls == []


class TestPaged:
    def test_follows_next_token_then_pagination_token_and_keeps_params(self):
        operation = MagicMock(side_effect=[
            {'Users': [1], 'NextToken': 'n1'},
            {'Users': [2], 'PaginationToken': 'p1'},
            {'Users': [3]},
        ])

        assert users_handler._paged(operation, 'Users', UserPoolId='pool', Limit=60) == [1, 2, 3]
        assert operation.call_args_list == [
            call(UserPoolId='pool', Limit=60),
            call(UserPoolId='pool', Limit=60, NextToken='n1'),
            call(UserPoolId='pool', Limit=60, PaginationToken='p1'),
        ]

    def test_next_token_wins_when_both_are_present(self):
        operation = MagicMock(side_effect=[{'Users': [1], 'NextToken': 'n', 'PaginationToken': 'p'}, {'Users': [2]}])

        assert users_handler._paged(operation, 'Users') == [1, 2]
        assert operation.call_args_list[1] == call(NextToken='n')

    @pytest.mark.parametrize('token', ['', 5, None])
    @pytest.mark.parametrize('key', ['NextToken', 'PaginationToken'])
    def test_an_empty_or_non_string_token_ends_the_walk(self, key, token):
        operation = MagicMock(side_effect=[{'Users': [1], key: token}])

        assert users_handler._paged(operation, 'Users') == [1]
        assert operation.call_count == 1

    def test_a_page_without_the_items_key_is_empty(self):
        operation = MagicMock(side_effect=[{'NextToken': 'n'}, {'Groups': [7]}])

        assert users_handler._paged(operation, 'Groups') == [7]


def _listed_user(name: str, **extra: Any) -> dict:
    return {'Username': name, 'Attributes': [{'Name': 'sub', 'Value': f'sub-{name}'}],
            'UserStatus': 'CONFIRMED', 'Enabled': True, **extra}


class TestListUsers:
    @pytest.mark.usefixtures('no_table')
    def test_every_cognito_call_is_pool_scoped_and_paged_by_60(
            self, cognito, api_gateway_event, lambda_context):
        cognito.list_users.side_effect = [{'Users': [_listed_user('a')]}]
        cognito.list_groups.side_effect = [{'Groups': [{'GroupName': 'admins'}]}]
        cognito.list_users_in_group.side_effect = [{'Users': [{'Username': 'a'}]}]

        status, _ = _call(api_gateway_event, lambda_context, 'GET', '/users')

        assert status == 200
        cognito.list_users.assert_called_once_with(UserPoolId=POOL, Limit=60)
        cognito.list_groups.assert_called_once_with(UserPoolId=POOL, Limit=60)
        cognito.list_users_in_group.assert_called_once_with(UserPoolId=POOL, GroupName='admins', Limit=60)

    @pytest.mark.usefixtures('no_table')
    def test_full_row_shape_with_and_without_optional_fields(
            self, cognito, api_gateway_event, lambda_context):
        full = {
            'Username': 'full', 'UserStatus': 'CONFIRMED', 'Enabled': True,
            'Attributes': [{'Name': n, 'Value': f'v-{n}'} for n in
                           ('sub', 'email', 'name', 'given_name', 'family_name')],
            'UserCreateDate': datetime(2025, 1, 1, tzinfo=UTC),
            'UserLastModifiedDate': datetime(2025, 1, 2, tzinfo=UTC),
        }
        bare = {'Username': 'bare', 'UserStatus': 'FORCE_CHANGE_PASSWORD', 'Enabled': False}
        cognito.list_users.side_effect = [{'Users': [full, bare]}]
        cognito.list_groups.side_effect = [{'Groups': [{'GroupName': 'admins'}, {'GroupName': 'users'}]}]
        cognito.list_users_in_group.side_effect = lambda **_kw: {'Users': [{'Username': 'full'}]}

        status, body = _call(api_gateway_event, lambda_context, 'GET', '/users')

        assert status == 200
        no_flags = {'fallback_owner': False, 'memory_reviewer': False}
        assert body == {'success': True, 'users': [
            {'username': 'full', 'sub': 'v-sub', 'email': 'v-email', 'name': 'v-name',
             'given_name': 'v-given_name', 'family_name': 'v-family_name', 'status': 'CONFIRMED',
             'enabled': True, 'groups': ['admins', 'users'], 'created_at': '2025-01-01T00:00:00+00:00',
             'last_modified': '2025-01-02T00:00:00+00:00', 'flags': no_flags},
            {'username': 'bare', 'sub': '', 'email': '', 'name': '', 'given_name': '', 'family_name': '',
             'status': 'FORCE_CHANGE_PASSWORD', 'enabled': False, 'groups': [], 'created_at': None,
             'last_modified': None, 'flags': no_flags},
        ]}

    @pytest.mark.usefixtures('no_table')
    def test_group_listings_run_at_most_four_at_once(self, cognito, api_gateway_event, lambda_context):
        cognito.list_users.side_effect = [{'Users': []}]
        cognito.list_groups.side_effect = [{'Groups': [{'GroupName': 'admins'}]}]
        cognito.list_users_in_group.side_effect = [{'Users': []}]
        with patch.object(users_handler, 'ordered_map', wraps=ordered_map) as spy:
            _call(api_gateway_event, lambda_context, 'GET', '/users')

        assert spy.call_args.kwargs == {'max_workers': 4}

    @pytest.mark.usefixtures('no_table')
    def test_a_short_membership_listing_is_a_500_not_a_silent_drop(
            self, cognito, log, api_gateway_event, lambda_context):
        cognito.list_users.side_effect = [{'Users': [_listed_user('a')]}]
        cognito.list_groups.side_effect = [{'Groups': [{'GroupName': 'admins'}, {'GroupName': 'users'}]}]
        with patch.object(users_handler, 'ordered_map', return_value=[[{'Username': 'a'}]]):
            status, body = _call(api_gateway_event, lambda_context, 'GET', '/users')

        assert (status, body['error']) == (500, 'Failed to list users')
        log.exception.assert_called_once_with('Error listing users')

    @pytest.mark.usefixtures('aggregates')
    def test_flags_are_read_for_every_listed_sub(self, cognito, api_gateway_event, lambda_context):
        cognito.list_users.side_effect = [{'Users': [_listed_user('a'), {**_listed_user('b'), 'Attributes': []}]}]
        cognito.list_groups.side_effect = [{'Groups': []}]
        resource = MagicMock()
        flags = {'sub-a': {'fallback_owner': True, 'memory_reviewer': False}}
        with patch.object(users_handler, 'get_dynamodb_resource', return_value=resource), \
                patch.object(users_handler.user_flags, 'flags_for_subs', return_value=flags) as read:
            _, body = _call(api_gateway_event, lambda_context, 'GET', '/users')

        read.assert_called_once_with(resource, 'test-aggregates', ['sub-a', ''])
        assert [u['flags'] for u in body['users']] == [
            {'fallback_owner': True, 'memory_reviewer': False},
            {'fallback_owner': False, 'memory_reviewer': False}]

    @pytest.mark.parametrize('error', [_client_error(), BotoCoreError()])
    @pytest.mark.usefixtures('aggregates')
    def test_unreadable_flags_degrade_with_a_warning(
            self, cognito, log, error, api_gateway_event, lambda_context):
        cognito.list_users.side_effect = [{'Users': [_listed_user('a')]}]
        cognito.list_groups.side_effect = [{'Groups': []}]
        with patch.object(users_handler.user_flags, 'flags_for_subs', side_effect=error):
            status, body = _call(api_gateway_event, lambda_context, 'GET', '/users')

        assert status == 200
        assert body['users'][0]['flags'] == {'fallback_owner': False, 'memory_reviewer': False}
        log.warning.assert_called_once_with('User flags unavailable; listing users without them')

    @pytest.mark.usefixtures('no_table')
    def test_no_table_reads_no_flags(self, cognito, api_gateway_event, lambda_context):
        cognito.list_users.side_effect = [{'Users': [_listed_user('a')]}]
        cognito.list_groups.side_effect = [{'Groups': []}]
        with patch.object(users_handler.user_flags, 'flags_for_subs') as read:
            status, _ = _call(api_gateway_event, lambda_context, 'GET', '/users')

        assert status == 200
        read.assert_not_called()


class TestCreateUser:
    @pytest.fixture
    def created(self, cognito: MagicMock) -> Iterator[MagicMock]:
        cognito.admin_create_user.return_value = {'User': {'Username': 'uuid-1'}}
        with patch.object(users_handler.uuid, 'uuid4', return_value='uuid-1'):
            yield cognito

    @pytest.mark.parametrize(('body', 'attrs', 'name'), [
        pytest.param({'email': ' a@example.com ', 'given_name': ' Ann ', 'family_name': ' Lee ', 'name': 'X'},
                     [{'Name': 'given_name', 'Value': 'Ann'}, {'Name': 'family_name', 'Value': 'Lee'},
                      {'Name': 'name', 'Value': 'Ann Lee'}], 'Ann Lee', id='given-and-family'),
        pytest.param({'email': 'a@example.com', 'given_name': 'Ann'},
                     [{'Name': 'given_name', 'Value': 'Ann'}, {'Name': 'name', 'Value': 'Ann'}], 'Ann',
                     id='given-only'),
        pytest.param({'email': 'a@example.com', 'family_name': 'Lee'},
                     [{'Name': 'family_name', 'Value': 'Lee'}, {'Name': 'name', 'Value': 'Lee'}], 'Lee',
                     id='family-only'),
        pytest.param({'email': 'a@example.com', 'name': ' Display '},
                     [{'Name': 'name', 'Value': 'Display'}], 'Display', id='name-fallback'),
        pytest.param({'email': 'a@example.com'}, [], '', id='no-name'),
    ])
    def test_writes_exactly_these_attributes(self, created, body, attrs, name, api_gateway_event, lambda_context):
        status, decoded = _call(api_gateway_event, lambda_context, 'POST', '/users', body)

        assert status == 200
        created.admin_create_user.assert_called_once_with(
            UserPoolId=POOL, Username='uuid-1',
            UserAttributes=[{'Name': 'email', 'Value': 'a@example.com'},
                            {'Name': 'email_verified', 'Value': 'true'}, *attrs],
            DesiredDeliveryMediums=['EMAIL'])
        created.admin_add_user_to_group.assert_called_once_with(UserPoolId=POOL, Username='uuid-1', GroupName='users')
        assert decoded == {
            'success': True,
            'message': 'User created. Temporary password sent to a@example.com',
            'user': {'username': 'uuid-1', 'email': 'a@example.com', 'name': name,
                     'given_name': body.get('given_name', '').strip(),
                     'family_name': body.get('family_name', '').strip(),
                     'groups': ['users'], 'status': 'FORCE_CHANGE_PASSWORD'},
        }

    def test_admins_group_is_accepted(self, created, api_gateway_event, lambda_context):
        _, decoded = _call(api_gateway_event, lambda_context, 'POST', '/users',
                           {'email': 'a@example.com', 'group': 'admins'})

        created.admin_add_user_to_group.assert_called_once_with(
            UserPoolId=POOL, Username='uuid-1', GroupName='admins')
        assert decoded['user']['groups'] == ['admins']

    @pytest.mark.parametrize(('body', 'message'), [
        ({'name': 'No Email'}, 'Email is required'),
        ({'email': '   '}, 'Email is required'),
        ({'email': 'a@example.com', 'group': 'root'}, 'Group must be "admins" or "users"'),
    ])
    def test_refusals_name_their_cause(self, cognito, body, message, api_gateway_event, lambda_context):
        status, decoded = _call(api_gateway_event, lambda_context, 'POST', '/users', body)

        assert (status, decoded['error']) == (400, message)
        assert cognito.admin_create_user.call_count == 0

    def test_existing_email_is_409(self, cognito, api_gateway_event, lambda_context):
        cognito.admin_create_user.side_effect = _UsernameExists()

        status, decoded = _call(api_gateway_event, lambda_context, 'POST', '/users', {'email': 'a@example.com'})

        assert (status, decoded['error']) == (409, 'A user with this email already exists')


class TestTypedErrorsRaisedInsideKeepTheirStatus:
    @pytest.mark.parametrize(('method', 'path', 'body', 'operation'), [
        ('GET', '/users', None, 'list_users'),
        ('POST', '/users', {'email': 'a@example.com'}, 'admin_create_user'),
        ('PUT', '/users/alice', {'given_name': 'A'}, 'admin_get_user'),
        ('PUT', '/users/alice/group', {'group': 'admins'}, 'admin_list_groups_for_user'),
        ('DELETE', '/users/alice', None, 'admin_delete_user'),
    ])
    @pytest.mark.usefixtures('no_table')
    def test_a_conflict_stays_409(
            self, cognito, method, path, body, operation, api_gateway_event, lambda_context):
        cognito.list_groups.return_value = {'Groups': []}
        getattr(cognito, operation).side_effect = ConflictError('raced')

        status, decoded = _call(api_gateway_event, lambda_context, method, path, body)

        assert (status, decoded['error']) == (409, 'raced')


class TestEachFaultIsLoggedUnderItsOwnName:
    @pytest.mark.parametrize(('method', 'path', 'body', 'operation', 'logged', 'public'), [
        ('GET', '/users', None, 'list_users', 'Error listing users', 'Failed to list users'),
        ('POST', '/users', {'email': 'a@example.com'}, 'admin_create_user',
         'Error creating user', 'Failed to create user'),
        ('PUT', '/users/alice', {'given_name': 'A'}, 'admin_get_user', 'Error updating user', 'Failed to update user'),
        ('PUT', '/users/alice/group', {'group': 'admins'}, 'admin_list_groups_for_user',
         'Error updating user group', 'Failed to update user group'),
        ('POST', '/users/alice/reset-password', None, 'admin_reset_user_password',
         'Error resetting password', 'Failed to reset password'),
        ('PUT', '/users/alice/enable', None, 'admin_enable_user', 'Error enabling user', 'Failed to enable user'),
        ('PUT', '/users/alice/disable', None, 'admin_disable_user', 'Error disabling user', 'Failed to disable user'),
        ('DELETE', '/users/alice', None, 'admin_delete_user', 'Error deleting user', 'Failed to delete user'),
    ])
    @pytest.mark.usefixtures('no_table')
    def test_fault(self, cognito, log, method, path, body, operation, logged, public,
                   api_gateway_event, lambda_context):
        cognito.list_groups.return_value = {'Groups': []}
        getattr(cognito, operation).side_effect = RuntimeError('cognito detail')

        status, decoded = _call(api_gateway_event, lambda_context, method, path, body)

        assert (status, decoded['error']) == (500, public)
        log.exception.assert_called_once_with(logged)


class TestUpdateUser:
    @pytest.mark.parametrize(('body', 'message'), [
        ({'name': 'x'}, 'At least one of given_name or family_name is required'),
        ({'given_name': 1}, 'given_name must be a string'),
        ({'given_name': 'A', 'family_name': ['B']}, 'family_name must be a string'),
    ])
    def test_body_refusals_come_before_cognito(self, cognito, body, message, api_gateway_event, lambda_context):
        status, decoded = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice', body)

        assert (status, decoded['error']) == (400, message)
        assert cognito.mock_calls == []

    @pytest.mark.parametrize('body', [{'given_name': ' '}, {'given_name': '', 'family_name': '  '}])
    def test_names_blank_after_merge_are_refused(self, cognito, body, api_gateway_event, lambda_context):
        cognito.admin_get_user.return_value = {'UserAttributes': [{'Name': 'family_name', 'Value': ''}]}

        status, decoded = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice', body)

        assert (status, decoded['error']) == (400, 'At least one of given_name or family_name must be non-empty')
        cognito.admin_update_user_attributes.assert_not_called()

    @pytest.mark.parametrize(('body', 'stored', 'attrs', 'names'), [
        pytest.param({'given_name': ' Ann '}, {}, [{'Name': 'given_name', 'Value': 'Ann'},
                                                  {'Name': 'name', 'Value': 'Ann'}],
                     ('Ann', '', 'Ann'), id='given-only-nothing-stored'),
        pytest.param({'family_name': ' Lee '}, {'given_name': 'Ann'},
                     [{'Name': 'family_name', 'Value': 'Lee'}, {'Name': 'name', 'Value': 'Ann Lee'}],
                     ('Ann', 'Lee', 'Ann Lee'), id='family-merged-with-stored-given'),
        pytest.param({'given_name': 'Bo'}, {'family_name': 'Lee'},
                     [{'Name': 'given_name', 'Value': 'Bo'}, {'Name': 'name', 'Value': 'Bo Lee'}],
                     ('Bo', 'Lee', 'Bo Lee'), id='given-merged-with-stored-family'),
        pytest.param({'given_name': 'Bo', 'family_name': 'Ng'}, {'given_name': 'Ann', 'family_name': 'Lee'},
                     [{'Name': 'given_name', 'Value': 'Bo'}, {'Name': 'family_name', 'Value': 'Ng'},
                      {'Name': 'name', 'Value': 'Bo Ng'}], ('Bo', 'Ng', 'Bo Ng'), id='both'),
    ])
    def test_writes_exactly_the_merged_attributes(
            self, cognito, body, stored, attrs, names, api_gateway_event, lambda_context):
        cognito.admin_get_user.return_value = {
            'UserAttributes': [{'Name': k, 'Value': v} for k, v in stored.items()]}

        status, decoded = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice', body)

        assert status == 200
        cognito.admin_get_user.assert_called_once_with(UserPoolId=POOL, Username='alice')
        cognito.admin_update_user_attributes.assert_called_once_with(
            UserPoolId=POOL, Username='alice', UserAttributes=attrs)
        assert decoded == {'success': True, 'message': 'User updated', 'username': 'alice',
                           'given_name': names[0], 'family_name': names[1], 'name': names[2]}

    def test_a_stored_record_without_attributes_reads_as_empty(self, cognito, api_gateway_event, lambda_context):
        cognito.admin_get_user.return_value = {}

        status, decoded = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice', {'family_name': 'Lee'})

        assert (status, decoded['name']) == (200, 'Lee')

    def test_unknown_user_is_404(self, cognito, api_gateway_event, lambda_context):
        cognito.admin_get_user.side_effect = _UserNotFound()

        status, decoded = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice', {'given_name': 'A'})

        assert (status, decoded['error']) == (404, 'User not found')


class TestUpdateUserGroup:
    @pytest.mark.parametrize('body', [{}, {'group': 'root'}, {'group': ''}])
    def test_only_admins_or_users(self, cognito, body, api_gateway_event, lambda_context):
        status, decoded = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice/group', body)

        assert (status, decoded['error']) == (400, 'Group must be "admins" or "users"')
        assert cognito.mock_calls == []

    @pytest.mark.usefixtures('aggregates')
    def test_moves_out_of_the_managed_groups_only(self, cognito, api_gateway_event, lambda_context):
        cognito.admin_list_groups_for_user.return_value = {
            'Groups': [{'GroupName': 'users'}, {'GroupName': 'beta'}, {'GroupName': 'admins'}]}

        status, decoded = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice/group', {'group': ' admins '})

        assert status == 200
        cognito.admin_list_groups_for_user.assert_called_once_with(Username='alice', UserPoolId=POOL)
        assert cognito.admin_remove_user_from_group.call_args_list == [
            call(UserPoolId=POOL, Username='alice', GroupName='users'),
            call(UserPoolId=POOL, Username='alice', GroupName='admins')]
        cognito.admin_add_user_to_group.assert_called_once_with(UserPoolId=POOL, Username='alice', GroupName='admins')
        assert decoded == {'success': True, 'message': 'User group updated to admins',
                           'username': 'alice', 'group': 'admins'}

    def test_unknown_user_is_404(self, cognito, api_gateway_event, lambda_context):
        cognito.admin_list_groups_for_user.side_effect = _UserNotFound()

        status, decoded = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice/group', {'group': 'users'})

        assert (status, decoded['error']) == (404, 'User not found')

    @pytest.mark.usefixtures('no_table')
    def test_a_user_in_no_group_is_only_added(self, cognito, api_gateway_event, lambda_context):
        cognito.admin_list_groups_for_user.return_value = {}

        status, _ = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice/group', {'group': 'users'})

        assert status == 200
        cognito.admin_remove_user_from_group.assert_not_called()

    def test_a_demotion_drops_the_fallback_owner_as_the_caller(
            self, cognito, aggregates, api_gateway_event, lambda_context):
        cognito.admin_list_groups_for_user.return_value = {'Groups': []}
        with patch.object(users_handler.user_flags, 'clear_fallback_owner_if') as clear:
            _call(api_gateway_event, lambda_context, 'PUT', '/users/alice/group', {'group': 'users'})

        clear.assert_called_once_with(aggregates, sub='sub-alice', actor_sub=CALLER_SUB)

    @pytest.mark.usefixtures('aggregates')
    def test_a_promotion_keeps_the_fallback_owner(self, cognito, api_gateway_event, lambda_context):
        cognito.admin_list_groups_for_user.return_value = {'Groups': []}
        with patch.object(users_handler.user_flags, 'clear_fallback_owner_if') as clear:
            _call(api_gateway_event, lambda_context, 'PUT', '/users/alice/group', {'group': 'admins'})

        clear.assert_not_called()

    @pytest.mark.usefixtures('no_table')
    def test_without_a_table_a_demotion_touches_no_flags(self, cognito, api_gateway_event, lambda_context):
        cognito.admin_list_groups_for_user.return_value = {'Groups': []}
        with patch.object(users_handler.user_flags, 'clear_fallback_owner_if') as clear:
            status, _ = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice/group', {'group': 'users'})

        assert status == 200
        clear.assert_not_called()

    @pytest.mark.usefixtures('aggregates')
    def test_a_failed_flag_drop_is_logged_and_the_demotion_stands(
            self, cognito, log, api_gateway_event, lambda_context):
        cognito.admin_list_groups_for_user.return_value = {'Groups': []}
        with patch.object(users_handler.user_flags, 'clear_fallback_owner_if', side_effect=RuntimeError('x')):
            status, _ = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice/group', {'group': 'users'})

        assert status == 200
        log.exception.assert_called_once_with('Could not clear the fallback owner after a demotion')


class TestSingleCallActions:
    @pytest.mark.parametrize(('method', 'path', 'operation', 'message'), [
        ('POST', '/users/alice/reset-password', 'admin_reset_user_password', 'Password reset email sent to user'),
        ('PUT', '/users/alice/enable', 'admin_enable_user', 'User enabled'),
        ('PUT', '/users/alice/disable', 'admin_disable_user', 'User disabled'),
        ('DELETE', '/users/alice', 'admin_delete_user', 'User deleted'),
    ])
    def test_one_pool_scoped_call_and_its_message(
            self, cognito, method, path, operation, message, api_gateway_event, lambda_context):
        status, decoded = _call(api_gateway_event, lambda_context, method, path)

        assert status == 200
        getattr(cognito, operation).assert_called_once_with(UserPoolId=POOL, Username='alice')
        assert decoded == {'success': True, 'message': message, 'username': 'alice'}

    def test_unknown_user_is_404(self, cognito, api_gateway_event, lambda_context):
        cognito.admin_enable_user.side_effect = _UserNotFound()

        status, decoded = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice/enable')

        assert (status, decoded['error']) == (404, 'User not found')


class TestCategoryAccess:
    def test_no_row_is_every_category(self, cognito, aggregates, api_gateway_event, lambda_context):
        status, decoded = _call(api_gateway_event, lambda_context, 'GET', '/users/alice/category-access')

        assert status == 200
        assert decoded == {'success': True, 'username': 'alice', 'all': True, 'categories': ['*'],
                           'sources': None, 'owned_categories': [], 'updated_at': None}
        cognito.admin_get_user.assert_called_once_with(UserPoolId=POOL, Username='alice')
        assert aggregates.get_item.call_args_list[0] == call(Key=access_key('sub-alice'), ConsistentRead=True)

    @pytest.mark.parametrize(('categories', 'all_'), [(['billing'], False), (['*'], True)])
    @pytest.mark.usefixtures('cognito')
    def test_a_stored_row_and_owned_categories_sorted(
            self, categories, all_, api_gateway_event, lambda_context):
        owner = [{'sub': 'sub-alice'}]
        table = aggregates_with(
            {**access_key('sub-alice'), 'categories': categories, 'updated_at': '2026-01-02T00:00:00+00:00'},
            {**CONFIG_ROW, 'categories': [{'name': 'zed', 'owners': owner}, {'name': 'app', 'owners': owner},
                                          {'name': 'other'}]})
        with patch.object(users_handler, 'aggregates_table', table):
            _, decoded = _call(api_gateway_event, lambda_context, 'GET', '/users/alice/category-access')

        assert decoded == {'success': True, 'username': 'alice', 'all': all_, 'categories': categories,
                           'sources': None,
                           'owned_categories': ['app', 'zed'], 'updated_at': '2026-01-02T00:00:00+00:00'}

    @pytest.mark.parametrize('error', [_client_error(), BotoCoreError()])
    @pytest.mark.usefixtures('cognito')
    def test_an_unreadable_row_is_a_fixed_500(self, aggregates, log, error, api_gateway_event, lambda_context):
        aggregates.get_item.side_effect = error

        status, decoded = _call(api_gateway_event, lambda_context, 'GET', '/users/alice/category-access')

        assert (status, decoded['error']) == (500, 'Failed to read category access')
        log.exception.assert_called_once_with('Error reading category access')

    @pytest.mark.usefixtures('cognito', 'no_table')
    def test_no_table_is_a_configuration_500(self, api_gateway_event, lambda_context):
        status, decoded = _call(api_gateway_event, lambda_context, 'GET', '/users/alice/category-access')

        assert (status, decoded['error']) == (500, 'Aggregates table not configured')

    @pytest.mark.usefixtures('cognito')
    def test_put_stores_the_row_as_the_caller(self, aggregates, api_gateway_event, lambda_context):
        clock = MagicMock()
        clock.now.return_value = datetime(2026, 3, 4, tzinfo=UTC)
        with patch.object(users_handler, 'datetime', clock):
            status, decoded = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice/category-access',
                                    {'categories': ['billing']})

        row = {**access_key('sub-alice'), 'categories': ['billing'], 'updated_by': CALLER_SUB,
               'updated_at': '2026-03-04T00:00:00+00:00'}
        assert status == 200
        clock.now.assert_called_once_with(UTC)
        aggregates.put_item.assert_called_once_with(Item=row)
        assert decoded == {'success': True, 'username': 'alice', 'all': False, 'categories': ['billing'],
                           'sources': None,
                           'owned_categories': [], 'updated_at': '2026-03-04T00:00:00+00:00'}

    @pytest.mark.parametrize(('body', 'message'), [
        (['billing'], 'Request body must be a JSON object'),
        ({'categories': 'billing'}, "categories must be a list of category names or ['*']"),
        ({'categories': ['pricing']}, '1 categories are not configured'),
    ])
    def test_put_refuses_before_cognito(self, cognito, aggregates, body, message, api_gateway_event, lambda_context):
        status, decoded = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice/category-access', body)

        assert (status, decoded['error']) == (400, message)
        assert cognito.mock_calls == []
        aggregates.put_item.assert_not_called()

    @pytest.mark.usefixtures('cognito')
    def test_with_nothing_configured_the_defaults_are_grantable(self, api_gateway_event, lambda_context):
        table = aggregates_with()
        with patch.object(users_handler, 'aggregates_table', table):
            status, decoded = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice/category-access',
                                    {'categories': ['pricing']})

        assert (status, decoded['categories']) == (200, ['pricing'])

    @pytest.mark.parametrize('error', [_client_error(), BotoCoreError()])
    @pytest.mark.usefixtures('cognito')
    def test_an_unsaved_row_is_a_fixed_500(self, aggregates, log, error, api_gateway_event, lambda_context):
        aggregates.put_item.side_effect = error

        status, decoded = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice/category-access',
                                {'categories': ['*']})

        assert (status, decoded['error']) == (500, 'Failed to save category access')
        log.exception.assert_called_once_with('Error saving category access')


class TestUserSubject:
    @pytest.mark.usefixtures('aggregates')
    def test_unknown_user_is_404(self, cognito, api_gateway_event, lambda_context):
        cognito.admin_get_user.side_effect = _UserNotFound()

        status, decoded = _call(api_gateway_event, lambda_context, 'GET', '/users/alice/category-access')

        assert (status, decoded['error']) == (404, 'User not found')

    @pytest.mark.parametrize('error', [_client_error(), BotoCoreError()])
    @pytest.mark.usefixtures('aggregates')
    def test_a_lookup_fault_is_a_fixed_500(self, cognito, log, error, api_gateway_event, lambda_context):
        cognito.admin_get_user.side_effect = error

        status, decoded = _call(api_gateway_event, lambda_context, 'GET', '/users/alice/category-access')

        assert (status, decoded['error']) == (500, 'Failed to look up user')
        log.exception.assert_called_once_with('Error resolving user')

    @pytest.mark.parametrize('attributes', [
        [], [{'Name': 'sub', 'Value': ''}], [{'Name': 'email', 'Value': 'e'}], [{'Value': 'v'}]])
    @pytest.mark.usefixtures('aggregates')
    def test_no_usable_sub_is_a_500(self, cognito, attributes, api_gateway_event, lambda_context):
        cognito.admin_get_user.return_value = {'UserAttributes': attributes}

        status, decoded = _call(api_gateway_event, lambda_context, 'GET', '/users/alice/category-access')

        assert (status, decoded['error']) == (500, 'User has no subject')

    @pytest.mark.usefixtures('aggregates')
    def test_a_record_without_attributes_has_no_subject(self, cognito, api_gateway_event, lambda_context):
        cognito.admin_get_user.return_value = {}

        status, decoded = _call(api_gateway_event, lambda_context, 'GET', '/users/alice/category-access')

        assert (status, decoded['error']) == (500, 'User has no subject')

    def test_the_sub_is_found_after_other_attributes(self, cognito, aggregates, api_gateway_event, lambda_context):
        cognito.admin_get_user.return_value = {'UserAttributes': [
            {'Name': 'email', 'Value': 'e'}, {'Name': 'sub', 'Value': ''}, {'Name': 'sub', 'Value': 'sub-2'}]}

        _call(api_gateway_event, lambda_context, 'GET', '/users/alice/category-access')

        assert aggregates.get_item.call_args_list[0] == call(Key=access_key('sub-2'), ConsistentRead=True)


class TestFlags:
    @pytest.fixture
    def set_flags(self) -> Iterator[MagicMock]:
        with patch.object(users_handler.user_flags, 'set_flags', return_value={'stored': True}) as mock:
            yield mock

    @pytest.mark.parametrize(('body', 'message'), [
        ({'zeta': 1, 'alpha': 2, 'memory_reviewer': True}, 'Unknown flag(s): alpha, zeta'),
        ({'memory_reviewer': 'yes'}, 'memory_reviewer must be true or false, got str'),
        (None, 'Provide fallback_owner and/or memory_reviewer'),
    ])
    @pytest.mark.usefixtures('aggregates')
    def test_refusals_come_before_cognito(
            self, cognito, set_flags, body, message, api_gateway_event, lambda_context):
        status, decoded = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice/flags', body)

        assert (status, decoded['error']) == (400, message)
        assert cognito.mock_calls == []
        set_flags.assert_not_called()

    @pytest.mark.usefixtures('no_table')
    def test_no_table_refuses_before_cognito(self, cognito, api_gateway_event, lambda_context):
        status, decoded = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice/flags',
                                {'memory_reviewer': True})

        assert (status, decoded['error']) == (500, 'Aggregates table not configured')
        assert cognito.mock_calls == []

    @pytest.mark.parametrize(('body', 'changes'), [
        ({'memory_reviewer': True}, {'memory_reviewer': True}),
        ({'memory_reviewer': None}, {'memory_reviewer': False}),
        ({'fallback_owner': False, 'memory_reviewer': False}, {'fallback_owner': False, 'memory_reviewer': False}),
    ])
    def test_without_fallback_owner_true_no_group_check(
            self, cognito, aggregates, set_flags, body, changes, api_gateway_event, lambda_context):
        status, decoded = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice/flags', body)

        assert status == 200
        cognito.admin_list_groups_for_user.assert_not_called()
        set_flags.assert_called_once_with(
            aggregates, sub='sub-alice', username='alice', changes=changes, actor_sub=CALLER_SUB)
        assert decoded == {'success': True, 'username': 'alice', 'flags': {'stored': True}}

    def test_an_admin_can_be_the_fallback_owner(self, cognito, aggregates, set_flags, api_gateway_event, lambda_context):
        cognito.admin_list_groups_for_user.return_value = {'Groups': [{'GroupName': 'beta'}, {'GroupName': 'admins'}]}

        status, _ = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice/flags', {'fallback_owner': True})

        assert status == 200
        cognito.admin_list_groups_for_user.assert_called_once_with(Username='alice', UserPoolId=POOL)
        set_flags.assert_called_once_with(
            aggregates, sub='sub-alice', username='alice', changes={'fallback_owner': True}, actor_sub=CALLER_SUB)

    @pytest.mark.parametrize('groups', [{}, {'Groups': [{'GroupName': 'users'}]}])
    @pytest.mark.usefixtures('aggregates')
    def test_a_non_admin_cannot_be_the_fallback_owner(
            self, cognito, set_flags, groups, api_gateway_event, lambda_context):
        cognito.admin_list_groups_for_user.return_value = groups

        status, decoded = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice/flags',
                                {'fallback_owner': True})

        assert (status, decoded['error']) == (400, 'Only an admin can be the fallback owner')
        set_flags.assert_not_called()

    @pytest.mark.parametrize('error', [_client_error(), BotoCoreError()])
    @pytest.mark.usefixtures('aggregates')
    def test_unreadable_groups_are_a_fixed_500(
            self, cognito, set_flags, log, error, api_gateway_event, lambda_context):
        cognito.admin_list_groups_for_user.side_effect = error

        status, decoded = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice/flags',
                                {'fallback_owner': True})

        assert (status, decoded['error']) == (500, 'Failed to look up user')
        log.exception.assert_called_once_with('Error reading user groups')
        set_flags.assert_not_called()

    @pytest.mark.parametrize('error', [_client_error(), BotoCoreError()])
    @pytest.mark.usefixtures('cognito', 'aggregates')
    def test_an_unsaved_flag_is_a_fixed_500(self, log, error, api_gateway_event, lambda_context):
        with patch.object(users_handler.user_flags, 'set_flags', side_effect=error):
            status, decoded = _call(api_gateway_event, lambda_context, 'PUT', '/users/alice/flags',
                                    {'memory_reviewer': True})

        assert (status, decoded['error']) == (500, 'Failed to save user flags')
        log.exception.assert_called_once_with('Error saving user flags')
