"""Memory retention sweeps each workspace's memories too (memory/retention/handler.py)."""
from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime

import pytest
from aws_lambda_powertools.metrics import MetricUnit

from api.test.moto_helpers import pk_sk_table
from memory.retention import handler as retention
from shared import memory_policy as policy
from shared import memory_store as store
from shared.test.memory_fixtures import candidate, fake_vector, memory_world
from shared.ws_repo import scope_from_message

A = scope_from_message({'workspace_id': 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'})
NOW = datetime(2026, 11, 13, tzinfo=UTC)


@pytest.fixture
def world(monkeypatch):
    with memory_world(monkeypatch) as built:
        yield built


def _dated(world, workspace) -> dict:
    found = replace(candidate('The spring sale ends in March'), workspace=workspace, retention=policy.RETENTION_DATED,
                    expires_at='2026-03-31')
    item = store.build_item(found, memory_id=store.new_memory_id(), status=policy.STATUS_ACTIVE,
                            vector=fake_vector(found.statement), aligned_ids=[], now=datetime(2026, 1, 1, tzinfo=UTC))
    world.memory.put_item(Item=item)
    return item


def test_an_expired_workspace_memory_is_archived_in_its_workspace(world):
    ours = _dated(world, A)
    theirs = _dated(world, None)
    result = retention.sweep(world.memory, NOW, lambda: 600_000, lambda: [A])
    assert result['expired'] == 2
    for item in (ours, theirs):
        stored = store.get_item(world.memory, store.item_key(item)) or {}
        assert stored.get('status') == policy.STATUS_ARCHIVED
    assert stored.get('gsi1pk') == 'MEMSTATUS#company#archived'
    archived = store.get_item(world.memory, store.item_key(ours)) or {}
    assert archived.get('gsi1pk') == f'WS#{A.ws}#MEMSTATUS#company#archived'
    events = {str(row['pk']) for row in world.memory.scan()['Items'] if 'MEMEVT#' in str(row['pk'])}
    assert f'WS#{A.ws}#MEMEVT#{ours["memory_id"]}' in events


def test_without_the_workspace_its_memories_are_left_alone(world):
    ours = _dated(world, A)
    assert retention.sweep(world.memory, NOW, lambda: 600_000)['expired'] == 0
    assert (store.get_item(world.memory, store.item_key(ours)) or {}).get('status') == policy.STATUS_ACTIVE


@pytest.mark.usefixtures('world')
def test_the_active_workspaces_come_from_the_platforms_listing():
    table = pk_sk_table('workspaces')
    for ws, status in (('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', 'active'), ('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9', 'deleting')):
        table.put_item(Item={'pk': 'WORKSPACES', 'sk': f'name#{ws}', 'workspace_id': ws, 'name': 'n', 'slug': 's',
                             'status': status})
    assert [scope.ws for scope in retention.active_workspaces(table)] == ['ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8']


def test_a_listing_that_fails_never_stops_the_deployments_sweep(world):
    from unittest.mock import patch

    theirs = _dated(world, None)

    def broken():
        raise RuntimeError('throttled')
    with patch.object(retention.metrics, 'add_metric') as add_metric:
        assert retention.sweep(world.memory, NOW, lambda: 600_000, broken)['expired'] == 1
    assert (store.get_item(world.memory, store.item_key(theirs)) or {}).get('status') == policy.STATUS_ARCHIVED
    add_metric.assert_called_once_with(name='MemoryRetentionListingFailures', unit=MetricUnit.Count, value=1)


def test_the_workspaces_order_rotates_by_day():
    scopes = [scope_from_message({'workspace_id': f'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D{n}'}) for n in range(3)]
    orders = {tuple(scope.ws for scope in retention._rotated(scopes, NOW.replace(day=day))) for day in (1, 2, 3)}
    assert len(orders) == 3
    assert all(sorted(order) == sorted(scope.ws for scope in scopes) for order in orders)
