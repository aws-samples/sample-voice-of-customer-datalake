"""A workspace's settings save bumps its own config_version, never the deployment's or another workspace's
(shared/data_version.py ``config_version_key``; docs/caching.md): a save in one workspace refreshes only that
workspace's cached reads, and a reprocess job there records its own workspace's counter.

In the cross-workspace suite's settings world (cross_workspace_worlds.py ``settings_world``: workspaces A and B).
"""
from __future__ import annotations

from typing import Any

import boto3
import pytest
from cross_workspace_worlds import ADA, ADA_MEMBER_ONLY, BEA, WORLDS, WS_A, WS_B

from shared.data_version import config_version_key
from shared.ws_repo import WorkspaceScope


@pytest.fixture
def world(lambda_context):
    with WORLDS['settings_handler.py'](lambda_context) as built:
        yield built


def _aggregates() -> Any:
    return boto3.resource('dynamodb', region_name='us-east-1').Table('aggregates')


def _counter(ws: str | None) -> int:
    key = config_version_key(None if ws is None else WorkspaceScope(ws))
    return int((_aggregates().get_item(Key=key, ConsistentRead=True).get('Item') or {}).get('v', 0))


@pytest.mark.parametrize(('path', 'body'), [
    ('/settings/brand', {'brand_name': 'Acme Outfitters'}),
    ('/settings/categories', {'categories': [{'name': 'delivery', 'description': 'Parcels'}]}),
    ('/settings/dimensions', {'dimensions': []}),
    ('/settings/sources', {'sources': []}),
])
def test_a_workspaces_save_bumps_its_own_counter_only(world, path, body):
    status, answer = world.call('PUT', path, ws=WS_A, body=body, caller=ADA_MEMBER_ONLY)

    assert status == 200, answer
    assert (_counter(WS_A), _counter(None), _counter(WS_B)) == (1, 0, 0)


def test_the_deployments_save_bumps_the_deployments_counter_as_before(world):
    status, answer = world.call('PUT', '/settings/categories', ws=None, caller=ADA,
                                body={'categories': [{'name': 'delivery', 'description': 'Parcels'}]})

    assert status == 200, answer
    assert (_counter(None), _counter(WS_A), _counter(WS_B)) == (1, 0, 0)


def test_two_workspaces_count_apart(world):
    body = {'categories': [{'name': 'delivery', 'description': 'Parcels'}]}
    assert world.call('PUT', '/settings/categories', ws=WS_A, body=body, caller=ADA_MEMBER_ONLY)[0] == 200
    assert world.call('PUT', '/settings/categories', ws=WS_B, body=body, caller=BEA)[0] == 200
    assert world.call('PUT', '/settings/categories', ws=WS_B, body=body, caller=BEA)[0] == 200

    assert (_counter(WS_A), _counter(WS_B), _counter(None)) == (1, 2, 0)


@pytest.mark.usefixtures('world')
def test_a_reprocess_job_records_its_own_workspaces_counter():
    from shared.reprocess_lineage import job_config

    _aggregates().put_item(Item={**config_version_key(), 'v': 7})
    _aggregates().put_item(Item={**config_version_key(WorkspaceScope(WS_A)), 'v': 3})

    assert job_config(_aggregates(), {'categories': []}, WorkspaceScope(WS_A))['config_version'] == 3
    assert job_config(_aggregates(), {'categories': []}, WorkspaceScope(WS_B))['config_version'] == 0
    assert job_config(_aggregates(), {'categories': []})['config_version'] == 7
