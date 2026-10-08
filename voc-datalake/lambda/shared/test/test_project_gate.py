"""shared.project_gate: request -> caller, META read, and the 404/403 decision.

The policy (who holds which role) is pinned in test_project_access.py; this
pins the gate's own contract: fail closed on a missing subject, never answer
"missing" or "allowed" on a failed read, and refuse with the HTTP contract's
404 (no view) / 403 (view but not the level).
"""
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

from shared import project_access, project_gate
from shared.exceptions import AuthorizationError, NotFoundError, ServiceError
from shared.project_access import Caller

OWNER = 'owner-sub'


def _event(claims):
    return {'requestContext': {'authorizer': {'claims': claims}}}


def _meta(**extra):
    return {
        'pk': 'PROJECT#p1', 'sk': 'META', 'status': 'active', 'visibility': 'private',
        'owner_sub': OWNER, 'members': {'viewer-sub': {'role': 'viewer'}}, **extra,
    }


class TestCallerFromEvent:
    def test_a_plain_user(self):
        caller = project_gate.caller_from_event(_event({'sub': 'u1'}))

        assert caller.subject == 'u1'
        assert not caller.is_admin
        assert not caller.delegated

    def test_admins_group(self):
        caller = project_gate.caller_from_event(_event({'sub': 'u1', 'cognito:groups': '[admins]'}))

        assert caller.is_admin

    def test_a_delegated_token_acts_as_its_minter_and_is_never_admin(self):
        caller = project_gate.caller_from_event(_event({
            'sub': 'mcp:tok', 'cognito:groups': 'admins',
            project_access.ACTING_SUBJECT_CLAIM: OWNER,
        }))

        assert caller.subject == OWNER
        assert caller.delegated
        assert not caller.is_admin

    @pytest.mark.parametrize('event', [
        {}, {'requestContext': None}, _event({}), _event({'sub': '   '}), _event('x'),
    ])
    def test_fails_closed_without_a_subject(self, event):
        with pytest.raises(AuthorizationError, match='Caller identity could not be determined'):
            project_gate.caller_from_event(event)


class TestReadGateMeta:
    def test_reads_the_shared_projection(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': _meta()}

        assert project_gate.read_gate_meta(table, 'p1') == _meta()
        kwargs = table.get_item.call_args.kwargs
        assert kwargs['Key'] == {'pk': 'PROJECT#p1', 'sk': 'META'}
        assert kwargs['ConsistentRead'] is True

    @pytest.mark.parametrize('response', [{}, {'Item': None}, {'Item': 'x'}, None])
    def test_absent_or_malformed_is_none(self, response):
        table = MagicMock()
        table.get_item.return_value = response

        assert project_gate.read_gate_meta(table, 'p1') is None

    @pytest.mark.parametrize('error', [
        ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException',
                               'Message': 'slow down'}}, 'GetItem'),
        EndpointConnectionError(endpoint_url='https://dynamodb.us-east-1.amazonaws.com'),
    ])
    def test_a_failed_read_is_a_service_error_not_a_decision(self, error):
        table = MagicMock()
        table.get_item.side_effect = error

        with pytest.raises(ServiceError, match='Could not verify project access') as raised:
            project_gate.read_gate_meta(table, 'p1')
        assert raised.value.__cause__ is error

    def test_other_exceptions_propagate_unchanged(self):
        table = MagicMock()
        table.get_item.side_effect = RuntimeError('bug')

        with pytest.raises(RuntimeError):
            project_gate.read_gate_meta(table, 'p1')


class TestRequireProjectLevel:
    def test_admins_skip_the_read(self):
        read = MagicMock()

        access = project_gate.require_project_level(
            read, Caller(subject='a', is_admin=True), project_access.LEVEL_MANAGE,
        )

        assert access.role == project_access.ROLE_ADMIN
        read.assert_not_called()

    def test_owner_may_manage(self):
        access = project_gate.require_project_level(
            _meta, Caller(subject=OWNER), project_access.LEVEL_MANAGE,
        )

        assert access.role == project_access.ROLE_OWNER

    @pytest.mark.parametrize('meta', [None, {}, _meta(status='deleted')])
    def test_missing_or_tombstoned_is_404(self, meta):
        with pytest.raises(NotFoundError, match='Project not found'):
            project_gate.require_project_level(
                lambda: meta, Caller(subject=OWNER), project_access.LEVEL_VIEW,
            )

    def test_the_missing_message_is_configurable(self):
        with pytest.raises(NotFoundError, match='Board not found'):
            project_gate.require_project_level(
                lambda: None, Caller(subject=OWNER), project_access.LEVEL_VIEW,
                missing_message='Board not found',
            )
