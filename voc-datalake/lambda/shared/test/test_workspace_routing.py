"""shared/workspace_routing.py: a public entry point's workspace comes from a stored row, and only an active one; the
one payload writer takes a resolved membership or a stored row's workspace, nothing else."""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared.test.moto_tables import create_pk_sk_table
from shared.workspace import WorkspaceContext
from shared.workspace_routing import (
    META_ROUTING_ATTRIBUTES,
    RoutedWorkspace,
    Unroutable,
    claim_lookup,
    lookup_key,
    release_lookup,
    route_public_id,
    route_workspace_id,
    workspace_payload,
)
from shared.ws_repo import WorkspaceScope, scope_from_lookup

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
WS_GONE = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DA'


@pytest.fixture
def table() -> Iterator[Any]:
    with mock_aws():
        workspaces = create_pk_sk_table('workspaces', boto3.resource('dynamodb', region_name='us-east-1'))
        workspaces.put_item(Item={'pk': f'WS#{WS_A}', 'sk': 'META', 'status': 'active', 'secret_status': 'ready'})
        workspaces.put_item(Item={'pk': f'WS#{WS_B}', 'sk': 'META', 'status': 'active', 'secret_status': 'pending'})
        workspaces.put_item(Item={'pk': f'WS#{WS_GONE}', 'sk': 'META', 'status': 'deleting'})
        yield workspaces


class TestScopeFromLookup:
    def test_a_form_row_names_its_workspace(self):
        assert scope_from_lookup({'pk': 'FORM#ff_1', 'sk': 'META', 'workspace_id': WS_A}) == WorkspaceScope(WS_A)

    def test_a_workspace_meta_row_names_itself(self):
        assert scope_from_lookup({'pk': f'WS#{WS_A}', 'sk': 'META'}) == WorkspaceScope(WS_A)

    @pytest.mark.parametrize('row', [
        {'pk': 'FORM#ff_1', 'sk': 'META', 'workspace_id': 'ws_bad'},
        {'pk': 'FORM#ff_1', 'sk': 'META'},
        {'pk': 'FORM#', 'sk': 'META', 'workspace_id': WS_A},
        {'pk': 'FORM#ff_1', 'sk': 'OTHER', 'workspace_id': WS_A},
        {'pk': f'WS#{WS_A}#SOURCE#x', 'sk': 'META'},
        {'pk': f'WS#{WS_A}', 'sk': 'MEMBER#x'},
        {'pk': 'SLUG#acme', 'sk': 'META', 'workspace_id': WS_A},  # not a kind this slice routes by
        {'pk': 'X', 'sk': 'META', 'workspace_id': WS_A},
        'FORM#ff_1',
        None,
    ])
    def test_any_other_shape_is_refused(self, row):
        with pytest.raises(ValueError, match=r'lookup row|workspace'):
            scope_from_lookup(row)


class TestRoutePublicId:
    def test_no_row_is_the_deployments(self, table):
        assert route_public_id(table, 'ff_none') is None

    def test_a_row_of_an_active_workspace_routes_there(self, table):
        claim_lookup(table, 'ff_1', WorkspaceScope(WS_A), 'now')

        routed = route_public_id(table, 'ff_1')

        assert routed == RoutedWorkspace(WorkspaceScope(WS_A))
        assert routed is not None
        assert routed.ws == WS_A

    @pytest.mark.parametrize('ws', [WS_GONE, 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DB', 'ws_bad', ''])
    def test_a_row_of_a_deleting_unknown_or_malformed_workspace_is_unroutable(self, table, ws):
        table.put_item(Item={**lookup_key('ff_1'), 'workspace_id': ws})

        with pytest.raises(Unroutable):
            route_public_id(table, 'ff_1')

    def test_an_empty_id_has_no_lookup_key(self):
        with pytest.raises(ValueError, match='not a lookup key'):
            lookup_key('')


class TestRouteWorkspaceId:
    def test_an_active_workspace_routes_whatever_its_meta_says_of_a_secret(self, table):
        """Decision 19: a workspace's credentials need nothing made first, so an old ``secret_status`` is not read."""
        assert route_workspace_id(table, WS_B) == RoutedWorkspace(WorkspaceScope(WS_B))
        assert META_ROUTING_ATTRIBUTES == ('pk', 'sk', 'status')

    def test_the_meta_is_read_with_the_routing_attributes_only(self):
        """The webhook role's GetItem is limited to these attributes (lib/stacks/api-stack.ts): the read asks only for
        them, so it never reaches a MEMBER# row's email or name and IAM does not refuse it."""
        table = MagicMock()
        table.get_item.return_value = {'Item': {'pk': f'WS#{WS_A}', 'sk': 'META', 'status': 'active'}}

        route_workspace_id(table, WS_A)

        kwargs = table.get_item.call_args.kwargs
        assert sorted(kwargs['ExpressionAttributeNames'].values()) == sorted(META_ROUTING_ATTRIBUTES)
        assert set(kwargs['ProjectionExpression'].split(', ')) == set(kwargs['ExpressionAttributeNames'])
        assert kwargs['ConsistentRead'] is True

    @pytest.mark.parametrize('ws', [WS_GONE, 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DB', 'ws_bad', '', None, 7,
                                    f'{WS_A}#SOURCE'])
    def test_anything_else_is_unroutable(self, table, ws):
        with pytest.raises(Unroutable):
            route_workspace_id(table, ws)


class TestLookupRows:
    def test_an_id_already_routed_is_never_taken_over(self, table):
        claim_lookup(table, 'ff_1', WorkspaceScope(WS_A), 'now')

        with pytest.raises(ClientError):
            claim_lookup(table, 'ff_1', WorkspaceScope(WS_B), 'later')
        assert table.get_item(Key=lookup_key('ff_1'))['Item']['workspace_id'] == WS_A

    def test_a_workspace_releases_only_its_own_row(self, table):
        claim_lookup(table, 'ff_1', WorkspaceScope(WS_A), 'now')

        release_lookup(table, 'ff_1', WorkspaceScope(WS_B))  # silently nothing
        release_lookup(table, 'ff_missing', WorkspaceScope(WS_B))
        assert 'Item' in table.get_item(Key=lookup_key('ff_1'))

        release_lookup(table, 'ff_1', WorkspaceScope(WS_A))
        assert 'Item' not in table.get_item(Key=lookup_key('ff_1'))


class TestWorkspacePayload:
    def test_deployment_wide_drops_a_sent_workspace(self):
        assert workspace_payload({'text': 't', 'workspace_id': WS_B}, None) == {'text': 't'}

    @pytest.mark.parametrize('source', [
        RoutedWorkspace(WorkspaceScope(WS_A)),
        WorkspaceContext(ws=WS_A, role='admin', name='A', slug='a', platform_admin=False),
    ])
    @pytest.mark.usefixtures('ingestion_on')
    def test_a_server_side_workspace_is_set_last(self, source):
        payload = workspace_payload({'workspace_id': WS_B, 'text': 't'}, source)

        assert payload == {'text': 't', 'workspace_id': WS_A}
        assert list(payload)[-1] == 'workspace_id'

    @pytest.mark.parametrize('stand_in', [WS_A, WorkspaceScope(WS_A), {'ws': WS_A}])
    def test_a_stand_in_is_refused(self, stand_in):
        with pytest.raises(TypeError, match='resolved or a stored-row workspace'):
            workspace_payload({'text': 't'}, stand_in)
