"""The project create threaded with a workspace (docs/multi-workspace.md, the project plan 3a; 7.26.00).

No route passes a workspace yet. Without one the create sends exactly the request it always sent (one conditional
put of the deployment's ``META``, pinned below). With one it writes the id's deployment-wide claim, the ``META`` and
the registry row in one scoped transaction; a claim already held is a collision like a same-second id (a fresh id,
once), and any other cancellation is not retried and writes nothing. Against moto, so the conditions and the
cancellations are DynamoDB's own.
"""
from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any
from unittest.mock import MagicMock, call, patch

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws
from moto_helpers import pk_sk_table

from shared.project_access import Caller
from shared.project_keys import project_pk, project_registry_key, project_registry_pk
from shared.project_tables import iter_registered_project_ids
from shared.ws_repo import WorkspaceScope, project_claim

OWNER = Caller(subject='owner-sub', username='olivia', email='olivia@example.com')
SAME_SECOND = datetime(2026, 11, 14, 9, 0, 0, tzinfo=UTC)
NOW = SAME_SECOND.isoformat()
A = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
B = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9')
FIRST = 'proj_20261114090000_aaaa0000'
SECOND = 'proj_20261114090000_bbbb1111'
THIRD = 'proj_20261114090000_cccc2222'


@pytest.fixture(autouse=True)
def _same_second() -> Iterator[None]:
    """Every create in this file reads the same second (the ids differ only by their random tail)."""
    frozen = MagicMock(wraps=datetime)
    frozen.now.return_value = SAME_SECOND
    with patch('projects.datetime', frozen):
        yield


@pytest.fixture
def table(monkeypatch) -> Iterator[Any]:
    monkeypatch.setenv('PROJECTS_TABLE', 'projects')
    with mock_aws():
        projects = pk_sk_table('projects')
        with patch('projects.projects_table', projects):
            yield projects


def _create(workspace: WorkspaceScope | None = None) -> dict:
    from projects import create_project

    return create_project({'name': 'Launch'}, OWNER, workspace=workspace)['project']


def _keys(table: Any) -> list[tuple[str, str]]:
    return sorted((row['pk'], row['sk']) for row in table.scan(ConsistentRead=True)['Items'])


def _held_claim(table: Any, project_id: str, workspace: WorkspaceScope) -> None:
    """``project_id`` already claimed for ``workspace`` (as that workspace's own create left it)."""
    table.put_item(Item={'pk': f'PROJECT_ID#{project_id}', 'sk': 'CLAIM', 'workspace_id': workspace.ws,
                         'claimed_at': NOW})


def test_a_workspace_create_writes_the_claim_the_meta_and_the_registry_row(table):
    with patch('shared.ids.secrets.token_hex', return_value='aaaa0000'):
        project = _create(A)

    assert project['project_id'] == FIRST
    assert _keys(table) == [(f'PROJECT_ID#{FIRST}', 'CLAIM'), (project_pk(FIRST, workspace=A), 'META'),
                            (project_registry_pk(A), FIRST)]
    meta = table.get_item(Key={'pk': project_pk(FIRST, workspace=A), 'sk': 'META'})['Item']
    assert meta['gsi1pk'] == f'WS#{A.ws}#TYPE#PROJECT'
    assert project_claim(table, FIRST) == A
    assert list(iter_registered_project_ids(table, workspace=A)) == [FIRST]
    assert list(iter_registered_project_ids(table, workspace=B)) == []


def test_a_held_claim_mints_a_fresh_id(table):
    # Another workspace holds the first draw's claim: the transaction is cancelled at the claim's index, nothing is
    # written, and the create retries once with the next draw.
    _held_claim(table, FIRST, B)
    with patch('shared.ids.secrets.token_hex', side_effect=['aaaa0000', 'bbbb1111']):
        project = _create(A)

    assert project['project_id'] == SECOND
    assert project_claim(table, FIRST) == B
    assert project_claim(table, SECOND) == A
    assert list(iter_registered_project_ids(table, workspace=A)) == [SECOND]
    assert (project_pk(FIRST, workspace=A), 'META') not in _keys(table)


def test_a_second_held_claim_is_not_retried_again(table):
    # Both of the first two draws are held; a third draw is there to take if the create wrongly retried again.
    _held_claim(table, FIRST, B)
    _held_claim(table, SECOND, B)
    with patch('shared.ids.secrets.token_hex', side_effect=['aaaa0000', 'bbbb1111', 'cccc2222']) as draws, \
            pytest.raises(ClientError, match='TransactionCanceled'):
        _create(A)

    assert draws.call_count == 2
    assert project_claim(table, THIRD) is None
    assert _keys(table) == [(f'PROJECT_ID#{FIRST}', 'CLAIM'), (f'PROJECT_ID#{SECOND}', 'CLAIM')]


def test_another_cancellation_is_not_retried_and_writes_no_claim(table):
    # The registry row is already there, so the transaction is cancelled at its Put, not the claim's: not a
    # collision, raised as it came, and nothing of it is written (no claim without its project).
    table.put_item(Item=project_registry_key(FIRST, workspace=A))
    with patch('shared.ids.secrets.token_hex', side_effect=['aaaa0000', 'bbbb1111']), \
            pytest.raises(ClientError, match='TransactionCanceled'):
        _create(A)

    assert _keys(table) == [(project_registry_pk(A), FIRST)]
    assert project_claim(table, FIRST) is None


def test_a_deployment_create_sends_exactly_the_request_it_always_sent():
    table = MagicMock()
    with patch('projects.projects_table', table), patch('shared.ids.secrets.token_hex', return_value='aaaa0000'):
        project = _create()

    item = {
        'pk': f'PROJECT#{FIRST}', 'sk': 'META', 'gsi1pk': 'TYPE#PROJECT', 'gsi1sk': NOW, 'project_id': FIRST,
        'name': 'Launch', 'description': '', 'purpose': '', 'status': 'active', 'created_at': NOW,
        'updated_at': NOW, 'persona_count': 0, 'document_count': 0, 'filters': {},
        'owner_sub': 'owner-sub', 'owner_username': 'olivia', 'owner_email': 'olivia@example.com', 'members': {},
        'visibility': 'private',
    }
    # Every call on the table, but the create's own "is a table configured" check.
    requests = [made for made in table.mock_calls if made != call.__bool__()]
    assert requests == [
        call.put_item(Item=item, ConditionExpression='attribute_not_exists(pk) AND attribute_not_exists(sk)')]
    assert project['project_id'] == FIRST


def test_a_deployment_create_writes_no_claim_and_no_registry_row(table):
    with patch('shared.ids.secrets.token_hex', return_value='aaaa0000'):
        _create()

    assert _keys(table) == [(f'PROJECT#{FIRST}', 'META')]
    assert project_claim(table, FIRST) is None
