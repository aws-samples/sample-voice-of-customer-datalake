"""Mutation hardening for `shared/project_gate.py`.

`test_project_gate.py` pins the gate's decisions (404 vs 403 vs 500, the admin
shortcut, the consistent META read) but a mutation run found that it checked
every refusal with ``match=`` — a regex *search* — or against the module's own
``DENIED_MESSAGES`` table, so a message that drifted to ``XXProject not foundXX``
still passed. These messages are the HTTP bodies the handlers return
(`projects_handler` and `mcp_tokens_handler` raise ``PROJECT_NOT_FOUND`` directly),
and the log line is what an operator greps for when a read is throttled, so each
is pinned here as an exact literal.

The run also showed that ``DENIED_MESSAGES[LEVEL_VIEW]`` could never be raised:
a caller who cannot view is answered 404 before the level check, and
``can_view`` *is* ``allows(LEVEL_VIEW)``. That entry was removed; the test below
pins that a viewer asking for view level is admitted, never refused.
"""
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from shared import project_access, project_gate
from shared.exceptions import AuthorizationError, NotFoundError, ServiceError
from shared.project_access import Caller

OWNER = 'owner-sub'
VIEWER = 'viewer-sub'


def _event(claims):
    return {'requestContext': {'authorizer': {'claims': claims}}}


def _meta():
    return {
        'pk': 'PROJECT#p1', 'sk': 'META', 'status': 'active', 'visibility': 'private',
        'owner_sub': OWNER, 'members': {VIEWER: {'role': 'viewer'}},
    }


class TestEveryRefusalIsTheExactContractMessage:
    def test_the_shared_404_constant_is_the_handlers_body(self):
        assert project_gate.PROJECT_NOT_FOUND == 'Project not found'

    @pytest.mark.parametrize(('meta', 'caller'), [
        (None, Caller(subject=OWNER)),          # no META: the owner is told nothing exists
        (_meta(), Caller(subject='stranger')),  # META exists: a stranger is told the same
    ])
    def test_missing_and_invisible_projects_share_the_literal_404(self, meta, caller):
        with pytest.raises(NotFoundError) as raised:
            project_gate.require_project_level(lambda: meta, caller, project_access.LEVEL_VIEW)

        assert raised.value.message == 'Project not found'
        assert raised.value.status_code == 404

    @pytest.mark.parametrize(('level', 'message'), [
        (project_access.LEVEL_EDIT, 'You do not have permission to edit this project'),
        (project_access.LEVEL_MANAGE, 'You do not have permission to manage this project'),
    ])
    def test_a_viewer_is_refused_with_the_level_named(self, level, message):
        with pytest.raises(AuthorizationError) as raised:
            project_gate.require_project_level(_meta, Caller(subject=VIEWER), level)

        assert raised.value.message == message
        assert raised.value.status_code == 403

    def test_the_denied_table_covers_exactly_the_levels_that_can_be_refused(self):
        assert project_gate.DENIED_MESSAGES == {
            'edit': 'You do not have permission to edit this project',
            'manage': 'You do not have permission to manage this project',
        }

    def test_a_viewer_asking_for_view_is_admitted_not_refused(self):
        access = project_gate.require_project_level(
            _meta, Caller(subject=VIEWER), project_access.LEVEL_VIEW,
        )

        assert access.role == project_access.ROLE_VIEWER
        assert access.can_view is True

    def test_a_missing_subject_is_the_literal_403(self):
        with pytest.raises(AuthorizationError) as raised:
            project_gate.caller_from_event(_event({}))

        assert raised.value.message == 'Caller identity could not be determined'
        assert raised.value.status_code == 403


class TestAFailedReadLogsAndAnswers500Verbatim:
    def test_the_operator_log_line_and_the_client_message(self):
        table = MagicMock()
        error = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException',
                                      'Message': 'slow down'}}, 'GetItem')
        table.get_item.side_effect = error

        with patch.object(project_gate, 'logger') as logger, pytest.raises(ServiceError) as raised:
            project_gate.read_gate_meta(table, 'p1')

        logger.exception.assert_called_once_with('Project access read failed')
        assert raised.value.message == 'Could not verify project access. Please retry.'
        assert raised.value.status_code == 500
        assert raised.value.__cause__ is error
