"""The workspaces API on moto for its route suites (the export's, the delete's): voc-workspaces and voc-aggregates,
a fresh membership cache, the live platform-admin check's Cognito, and Acme Outfitters with its three members (the
members routes' ADA the admin, EDI an editor, VIC a viewer). Call inside an active ``moto.mock_aws()``."""
from collections.abc import Generator, Mapping
from contextlib import ExitStack, contextmanager
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto_helpers import pk_sk_table
from test_workspaces_members_routes import ADA, EDI, VIC, WS

import workspaces_handler
from shared import platform_admin_gate
from shared.test.cognito_doubles import live_cognito
from shared.workspace import MembershipCache


def handler_doubles(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """The handler's fresh membership cache and user pool, and one live Cognito for it and the platform-admin gate,
    through ``monkeypatch`` (for a suite that seeds its own tables). Returns that Cognito."""
    monkeypatch.setattr(workspaces_handler, 'memberships', MembershipCache())
    monkeypatch.setattr(workspaces_handler, 'USER_POOL_ID', 'us-east-1_pool')
    monkeypatch.setenv('USER_POOL_ID', 'us-east-1_pool')
    cognito = live_cognito()
    monkeypatch.setattr(workspaces_handler, 'get_cognito_idp_client', lambda: cognito)
    monkeypatch.setattr(platform_admin_gate, 'get_cognito_idp_client', lambda: cognito)
    return cognito


@contextmanager
def workspaces_api(values: Mapping[str, Any],
                   returns: Mapping[str, Any] | None = None) -> Generator[tuple[Any, Any]]:
    """``(workspaces, aggregates)`` with the handler's module ``values`` and getter ``returns`` patched beside the
    common ones."""
    resource = boto3.resource('dynamodb', region_name='us-east-1')
    with ExitStack() as stack:
        for name, value in {'memberships': MembershipCache(), 'USER_POOL_ID': 'us-east-1_pool',
                            'AGGREGATES_TABLE': 'aggregates', **values}.items():
            stack.enter_context(patch.object(workspaces_handler, name, value))
        for name, value in {'get_cognito_idp_client': live_cognito(), 'get_dynamodb_resource': resource,
                            **(returns or {})}.items():
            stack.enter_context(patch.object(workspaces_handler, name, return_value=value))
        # The live platform-admin gate (shared/platform_admin_gate.py) reads the pool from its own client and the
        # environment.
        stack.enter_context(patch.object(platform_admin_gate, 'get_cognito_idp_client', return_value=live_cognito()))
        stack.enter_context(patch.dict('os.environ', {'USER_POOL_ID': 'us-east-1_pool'}))
        workspaces, aggregates = pk_sk_table('workspaces'), pk_sk_table('aggregates')
        workspaces.put_item(Item={'pk': f'WS#{WS}', 'sk': 'META', 'name': 'Acme Outfitters', 'slug': 'acme',
                                  'status': 'active'})
        for claims, role in ((ADA, 'admin'), (EDI, 'editor'), (VIC, 'viewer')):
            workspaces.put_item(Item={'pk': f'WS#{WS}', 'sk': f'MEMBER#{claims["sub"]}', 'role': role})
        yield workspaces, aggregates
