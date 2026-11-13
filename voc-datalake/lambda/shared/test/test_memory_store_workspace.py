"""A workspace's memories (shared/memory_store.py): the same rows inside its partitions, reached only through it."""
from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime

import pytest

from shared import memory_policy as policy
from shared import memory_store as store
from shared.exceptions import ValidationError
from shared.test.memory_fixtures import candidate, memory_world
from shared.ws_repo import WorkspaceScope

A = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
B = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9')
NOW = datetime(2026, 11, 13, 12, 0, tzinfo=UTC)


@pytest.fixture
def world(monkeypatch):
    with memory_world(monkeypatch) as built:
        yield built


def _write(world, statement: str, workspace: WorkspaceScope | None, **options) -> dict:
    item, _ = store.write_explicit(world.memory, replace(candidate(statement, **options), workspace=workspace),
                                   status=policy.STATUS_ACTIVE, now=NOW)
    return item


def _pks(world) -> set[str]:
    return {str(row['pk']) for row in world.memory.scan(ConsistentRead=True)['Items']}


def test_a_workspaces_keys_are_the_deployments_inside_it():
    assert store.company_pk() == 'MEM#company'
    assert store.company_pk(A) == f'WS#{A.ws}#MEM#company'
    assert store.scope_pk(policy.SCOPE_PERSONAL, 'sub-a', A) == f'WS#{A.ws}#MEM#user#sub-a'
    assert store.status_partition('company', 'active', A) == f'WS#{A.ws}#MEMSTATUS#company#active'
    assert store.cursor_key('s1', A) == {'pk': f'WS#{A.ws}#MEMCURSOR', 'sk': 'SESSION#s1'}
    assert store.import_key('imp_1', A) == {'pk': f'WS#{A.ws}#MEMIMPORT', 'sk': 'imp_1'}


def test_a_memory_learned_in_a_workspace_is_stored_and_found_only_there(world):
    item = _write(world, 'Customers in the north want faster refunds', A)
    assert item['pk'] == f'WS#{A.ws}#MEM#company'
    assert item['gsi1pk'] == f'WS#{A.ws}#MEMSTATUS#company#active'
    assert f'WS#{A.ws}#MEMEVT#{item["memory_id"]}' in _pks(world)
    _write(world, 'The deployment learned something else', None)
    found = store.retrieve(world.memory, 'faster refunds', caller_sub=None, include_personal=False, k=5,
                           workspace=A)
    assert [row['memory_id'] for row in found] == [item['memory_id']]
    assert item['memory_id'] not in {row['memory_id'] for row in store.retrieve(
        world.memory, 'faster refunds', caller_sub=None, include_personal=False, k=5)}
    assert store.retrieve(world.memory, 'faster refunds', caller_sub=None, include_personal=False, k=5,
                          workspace=B) == []
    assert (store.locate(world.memory, item['memory_id'], None, A) or {}).get('statement') == item['statement']
    assert store.locate(world.memory, item['memory_id'], None) is None


def test_a_status_change_moves_the_memory_within_its_workspaces_status_partitions(world):
    item = _write(world, 'Shipping delays anger loyal buyers', A)
    store.set_fields(world.memory, item, {'status': policy.STATUS_ARCHIVED}, now=NOW)
    archived = store.query_status(world.memory, 'company', policy.STATUS_ARCHIVED, workspace=A)
    assert [row['memory_id'] for row in archived] == [item['memory_id']]
    assert archived[0]['gsi1pk'] == f'WS#{A.ws}#MEMSTATUS#company#archived'
    assert store.count_status(world.memory, 'company', policy.STATUS_ARCHIVED, workspace=A) == 1
    assert store.count_status(world.memory, 'company', policy.STATUS_ARCHIVED) == 0
    assert store.query_status(world.memory, 'company', policy.STATUS_ARCHIVED) == []


def test_the_lists_are_each_workspaces_own(world):
    company = _write(world, 'Bulk buyers ask for invoices', A)
    personal = _write(world, 'I prefer short summaries', A, scope=policy.SCOPE_PERSONAL, owner_sub='sub-a')
    _write(world, 'Deployment-wide statement', None)
    rows, _ = store.list_company(world.memory, policy.STATUS_ACTIVE, kind=None, q=None, limit=10, start_key=None,
                                 workspace=A)
    assert [row['memory_id'] for row in rows] == [company['memory_id']]
    mine = store.list_personal(world.memory, 'sub-a', policy.STATUS_ACTIVE, kind=None, q=None, workspace=A)
    assert [row['memory_id'] for row in mine] == [personal['memory_id']]
    assert store.list_personal(world.memory, 'sub-a', policy.STATUS_ACTIVE, kind=None, q=None) == []
    # A search (a filter beside the layer's own key condition) keeps only the matches, inside the workspace.
    rows, _ = store.list_company(world.memory, policy.STATUS_ACTIVE, kind=None, q='invoices', limit=10,
                                 start_key=None, workspace=A)
    assert [row['memory_id'] for row in rows] == [company['memory_id']]
    rows, _ = store.list_company(world.memory, policy.STATUS_ACTIVE, kind=None, q='nothing like it', limit=10,
                                 start_key=None, workspace=A)
    assert rows == []
    assert store.list_personal(world.memory, 'sub-a', policy.STATUS_ACTIVE, kind=None, q='summaries',
                               workspace=A)[0]['memory_id'] == personal['memory_id']


@pytest.mark.parametrize('foreign', [
    {'pk': 'MEM#company', 'sk': 'MEM#mem_1', 'gsi1pk': 'MEMSTATUS#company#active', 'gsi1sk': 'x'},
    {'pk': f'WS#{B.ws}#MEM#company', 'sk': 'MEM#mem_1', 'gsi1pk': f'WS#{B.ws}#MEMSTATUS#company#active', 'gsi1sk': 'x'},
    {'pk': f'WS#{A.ws}#MEM#company', 'sk': 'MEM#mem_1', 'gsi1pk': 'MEMSTATUS#company#active', 'gsi1sk': 'x'},
], ids=['deployment', 'other-workspace', 'mixed'])
def test_a_page_token_of_another_partition_is_a_bad_request(world, foreign):
    _write(world, 'Bulk buyers ask for invoices', A)
    with pytest.raises(ValidationError, match='cursor'):
        store.list_company(world.memory, policy.STATUS_ACTIVE, kind=None, q=None, limit=10, start_key=foreign,
                           workspace=A)


def test_a_reinforced_memory_stays_in_its_workspace(world):
    item = _write(world, 'Refunds take too long', A)
    store.set_fields(world.memory, item, {'status': policy.STATUS_ARCHIVED}, now=NOW)
    stored = store.get_item(world.memory, store.item_key(item)) or {}
    assert store.reinforce(world.memory, stored, 'h-other', None, now=NOW)
    revived = store.get_item(world.memory, store.item_key(item)) or {}
    assert revived['gsi1pk'] == f'WS#{A.ws}#MEMSTATUS#company#active'
    assert all(pk.startswith(f'WS#{A.ws}#') for pk in _pks(world))


def test_cursors_and_imports_are_each_workspaces_own(world):
    store.save_cursor(world.memory, 's1', {'enqueued_at': 'x'}, now=NOW, workspace=A)
    assert set(store.get_cursors(world.memory, ['s1'], A)) == {'s1'}
    assert store.get_cursors(world.memory, ['s1']) == {}
    world.memory.put_item(Item={**store.import_key('imp_1', A), 'import_id': 'imp_1', 'status': 'running'})
    store.add_import_counts(world.memory, 'imp_1', {'created': 2}, {'status': 'done'}, now=NOW, workspace=A)
    assert (store.get_import(world.memory, 'imp_1', A) or {}).get('created') == 2
    assert store.get_import(world.memory, 'imp_1') is None


def test_an_automated_write_in_a_workspace_lands_and_dedups_there(world):
    first = replace(candidate('Late deliveries frustrate the north region'), workspace=A)
    outcome = store.write_automated(world.memory, [first], now=NOW)
    assert outcome.created == 1
    [memory_id] = outcome.memory_ids
    assert (store.get_item(world.memory, store.memory_key(store.company_pk(A), memory_id)) or {}).get('memory_id') == memory_id
    again = store.write_automated(world.memory, [replace(first, supporter='h-other')], now=NOW)
    assert (again.created, again.reinforced) == (0, 1)
    assert store.write_automated(world.memory, [replace(first, workspace=None)], now=NOW).created == 1
    assert all(pk.startswith(f'WS#{A.ws}#') or not pk.startswith('WS#') for pk in _pks(world))


def test_a_merge_in_a_workspace_stays_in_it(world):
    one = _write(world, 'Refund delays upset buyers', A)
    two = _write(world, 'Buyers complain refunds are slow', A)
    merged = store.merge_memories(world.memory, [one, two], 'Slow refunds upset buyers', actor='h-admin', now=NOW)
    assert merged['pk'] == f'WS#{A.ws}#MEM#company'
    assert merged['gsi1pk'] == f'WS#{A.ws}#MEMSTATUS#company#active'
    archived = store.query_status(world.memory, 'company', policy.STATUS_ARCHIVED, workspace=A)
    assert {row['memory_id'] for row in archived} == {one['memory_id'], two['memory_id']}
    assert {pk for pk in _pks(world) if pk.startswith('MEM')} == set()


def test_the_best_effort_writes_land_on_the_workspaces_rows(world):
    """Use (its 90-day window) and the sources' cap: refused writes would only log, so each is read back."""
    item = _write(world, 'Customers ask for weekend delivery', A)
    store.retrieve(world.memory, 'weekend delivery', caller_sub=None, include_personal=False, k=5, workspace=A,
                   now=NOW)
    used = store.get_item(world.memory, store.item_key(item)) or {}
    assert (used.get('last_used_at'), used.get('gsi1sk')) == (NOW.isoformat(), NOW.isoformat())
    full = [{'kind': 'chat', 'ref': f'c{n}'} for n in range(policy.MAX_SOURCES_KEPT)]
    store.set_fields(world.memory, used, {'sources': full}, now=NOW)
    stored = store.get_item(world.memory, store.item_key(item)) or {}
    store.reinforce(world.memory, stored, 'h-new', {'kind': 'chat', 'ref': 'newest'}, now=NOW)
    assert len((store.get_item(world.memory, store.item_key(item)) or {}).get('sources') or []) == policy.MAX_SOURCES_KEPT


def test_a_conflict_in_a_workspace_links_both_rows_there(world):
    first = _write(world, 'Buyers want cheaper shipping', A)
    store.link_conflicts(world.memory, 'mem_new', [first['memory_id']], {first['memory_id']: first}, now=NOW)
    linked = store.get_item(world.memory, store.item_key(first)) or {}
    assert linked.get('conflicts_with') == ['mem_new']
    events = [row for row in world.memory.scan()['Items'] if str(row['pk']).startswith(f'WS#{A.ws}#MEMEVT#')]
    assert 'conflict_linked' in {row['action'] for row in events}
    second = _write(world, 'Buyers accept slower shipping for a lower price', A)
    store.set_fields(world.memory, second, {'conflicts_with': [first['memory_id']]}, now=NOW)
    holder = store.get_item(world.memory, store.item_key(second)) or {}
    assert [row['memory_id'] for row in store.linked_items(world.memory, holder)] == [first['memory_id']]
