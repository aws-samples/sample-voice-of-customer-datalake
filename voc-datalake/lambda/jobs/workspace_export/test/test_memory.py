"""voc-workspace-export, slice 4c (jobs/workspace_export/memory.py): a workspace's company memory in its export, every
read a Query of its own partitions of voc-memory through the workspace layer; personal memories and the extraction
cursors are their owners' only, counted and never exported (personal memories' events neither exported nor counted); no
row carries a person's hash."""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from jobs.workspace_export import entities, handler, memory
from jobs.workspace_export.test.conftest import (
    COMPANY_MEMORIES,
    EVENTS_PER_MEMORY,
    OTHER,
    PERSONAL_MEMORIES,
    WS,
    Budget,
    World,
    queue,
    seed,
    seed_memory,
)
from jobs.workspace_export.test.test_handler import _jsonl, _unzip
from shared.ws_repo import (
    WorkspaceScope,
    memory_company_pk,
    memory_cursor_pk,
    memory_event_pk,
    memory_import_pk,
    memory_status_pk,
)

PERSONAL_IDS = tuple(memory_id for _owner, memory_id, _status in PERSONAL_MEMORIES)
#: What names or could confirm a person, in any memory row.
PERSON_FIELDS = ('supporter_set', 'actor', 'created_by_hash', 'created_by_username', 'embedding')


def _run(world: World, checks: int | None = None) -> list[dict[str, Any]]:
    """Every invocation of one export; each hand-over's payload."""
    event, payloads = queue(world), []
    for _ in range(200):
        world.invoke.reset_mock()
        result = handler.handle_event(event, Budget(checks))
        if result['status'] != 'continued':
            assert result['status'] == 'completed', result
            return payloads
        [(_fn, event)] = [call.args for call in world.invoke.call_args_list]
        payloads.append(event)
    raise AssertionError('the export did not end')


def _memory_rows(files: dict[str, bytes]) -> list[dict[str, Any]]:
    return [row for entity in memory.ENTITIES for row in _jsonl(files, entity)]


def _queried_partitions(world: World) -> list[str]:
    """Every partition the export's Queries of voc-memory named (botocore's own parameters, before the call)."""
    seen: list[str] = []

    def record(params: dict[str, Any], **_kwargs: Any) -> None:
        if params.get('TableName') == world.memory.name:
            seen.append(str(params['ExpressionAttributeValues'][':p']))

    world.memory.meta.client.meta.events.register('provide-client-params.dynamodb.Query', record)
    return seen


def test_the_company_memory_is_exported_and_no_row_names_a_person(world):
    seed(world)
    seed_memory(world)
    _run(world)
    files = _unzip(world)
    assert sorted(row['memory_id'] for row in _jsonl(files, 'memory_company')) == sorted(COMPANY_MEMORIES)
    events = _jsonl(files, 'memory_events')
    assert sorted({row['pk'] for row in events}) == sorted(f'WS#{WS}#MEMEVT#{m}' for m in COMPANY_MEMORIES)
    assert len(events) == len(COMPANY_MEMORIES) * EVENTS_PER_MEMORY
    [imported] = _jsonl(files, 'memory_imports')
    assert (imported['import_id'], imported['title']) == ('imp_1', 'Release notes')
    leaked = {field for row in _memory_rows(files) for field in PERSON_FIELDS if field in row}
    assert leaked == set()
    assert 'h' * 64 not in json.dumps({name: body.decode() for name, body in files.items()})
    manifest = json.loads(files['manifest.json'])
    assert set(manifest['entities']) >= set(memory.ENTITIES)
    assert 'memory' not in manifest['not_per_workspace']
    assert 'conversations' in manifest['not_exported']
    assert {'memory_embeddings', 'memory_people', 'personal_memory'} <= set(manifest['excluded'])
    assert 'memory_check' not in manifest


def test_personal_memories_their_events_and_the_cursors_are_counted_never_exported(world):
    seed(world)
    seed_memory(world)
    queried = _queried_partitions(world)
    _run(world)
    files = _unzip(world)
    every = json.dumps({name: body.decode() for name, body in files.items()})
    assert not [memory_id for memory_id in PERSONAL_IDS if memory_id in every]
    assert 'SESSION#' not in every
    assert not [name for name in files if name.startswith(('memory_personal/', 'memory_cursors/'))]
    left_out = json.loads(files['manifest.json'])['memory']
    assert left_out['not_exported'] == {
        'personal_memories': {'count': len(PERSONAL_MEMORIES), 'complete': True, 'approximate': True},
        'cursors': {'count': 2, 'complete': True, 'approximate': True}}
    assert "owners' only" in left_out['note']
    # The personal memories' own events are never even queried.
    assert not [partition for partition in queried if any(m in partition for m in PERSONAL_IDS)]


def test_a_chat_sessions_id_never_leaves_with_a_company_memory(world):
    """A session id names one person's conversation (the memory API hides it too): a session source keeps its type
    and time, never its ref; an import's ref stays."""
    seed(world)
    seed_memory(world)
    _run(world)
    files = _unzip(world)
    assert 'sess-of-ada' not in json.dumps({name: body.decode() for name, body in files.items()})
    sources = [source for row in _jsonl(files, 'memory_company') for source in row['sources']]
    assert {(source['type'], source.get('ref')) for source in sources} == {('session', None), ('import', 'imp_1')}
    # The API's allowlist: type and time (and the ref of an import or agent run), nothing else of a source.
    assert all(set(source) <= {'type', 'at', 'ref'} and source['at'] for source in sources)
    assert 'what ada said' not in json.dumps({name: body.decode() for name, body in files.items()})


def test_a_count_stops_partway_and_skips_the_remaining_statuses():
    """``Select COUNT`` pages: with the time gone after the first page (more to count), the count stops at 1000, not
    done, and the other three status partitions are never queried."""
    view = MagicMock()
    view.query.return_value = {'Count': 1000, 'LastEvaluatedKey': {'pk': 'x', 'sk': 'y', 'gsi1pk': 'z', 'gsi1sk': 'w'}}
    state: dict[str, Any] = {}
    assert memory.MemorySource(WorkspaceScope(WS), view).count('personal_memories', state, lambda: False) is False
    assert (state['total'], state.get('done', False)) == (1000, False)
    [call] = view.query.call_args_list
    assert call.args == ('gsi1pk', f'WS#{WS}#MEMSTATUS#personal#active')
    assert call.kwargs['Select'] == 'COUNT'
    assert 'ProjectionExpression' not in call.kwargs


def test_a_count_resumes_across_a_hand_over_from_its_checkpoint():
    """A count stopped for time carries its partition, cursor and total in the run state (JSON, as the hand-over's
    event does): the next invocation goes on from that very page, and the total is every page's once."""
    lek = {'pk': 'x', 'sk': 'y', 'gsi1pk': 'z', 'gsi1sk': 'w'}
    pages = [{'Count': 1000, 'LastEvaluatedKey': lek}, {'Count': 7}, {'Count': 2}, {'Count': 0}, {'Count': 1}]
    view = MagicMock()
    view.query.side_effect = pages
    source = memory.MemorySource(WorkspaceScope(WS), view)
    state: dict[str, Any] = {}
    assert source.count('personal_memories', state, lambda: False) is False
    carried = json.loads(json.dumps(state))
    assert source.count('personal_memories', carried, lambda: True) is True
    assert (carried['total'], carried['done']) == (1010, True)
    resumed = view.query.call_args_list[1]
    assert resumed.args == ('gsi1pk', f'WS#{WS}#MEMSTATUS#personal#active')
    assert resumed.kwargs['ExclusiveStartKey'] == lek
    assert view.query.call_count == len(pages)


def test_the_counts_run_before_the_completions_reserve_and_never_after_it(world):
    """Every entity written with the time already at the reserve: the count stops after its first page and the
    invocation hands over without completing; the next one goes on with the count from its checkpoint and
    completes, the count complete."""
    seed(world)
    seed_memory(world)
    results = []
    write_entities = handler.ExportRun._write_entities

    def then_at_the_reserve(run: handler.ExportRun, writer: Any) -> None:
        write_entities(run, writer)
        if run.run.generation == 0:
            run.context = Budget(0)

    with patch.object(handler.ExportRun, '_write_entities', then_at_the_reserve):
        event = queue(world)
        for _ in range(5):
            world.invoke.reset_mock()
            results.append(handler.handle_event(event, Budget()))
            if results[-1]['status'] != 'continued':
                break
            [(_fn, event)] = [call.args for call in world.invoke.call_args_list]
    assert [result['status'] for result in results] == ['continued', 'completed']
    counted = json.loads(_unzip(world)['manifest.json'])['memory']['not_exported']
    assert counted['personal_memories'] == {'count': len(PERSONAL_MEMORIES), 'complete': True, 'approximate': True}


def test_another_workspaces_memory_is_never_queried(world):
    seed(world)
    seed_memory(world)
    queried = _queried_partitions(world)
    _run(world)
    assert queried
    assert all(partition.startswith(f'WS#{WS}#') for partition in queried)
    assert 'mem_other' not in json.dumps({name: body.decode() for name, body in _unzip(world).items()})
    assert not [partition for partition in queried if '#MEM#user#' in partition]


def test_hand_overs_inside_the_company_memory_and_its_events_resume_without_loss_or_repeat(world):
    """Company pages of one item and pages of two ids, a few clock checks an invocation: hand-overs fall inside
    memory_company and inside memory_events (between ids and between id pages); every row arrives once."""
    seed(world)
    seed_memory(world)
    real_query = memory.MemorySource._query

    def one_item_pages(source: memory.MemorySource, partition: str, cursor_start: object, **kwargs: Any) -> Any:
        return real_query(source, partition, cursor_start, **{'Limit': 1, **kwargs})

    company_phase, events_phase = 'memory_company', 'memory_events'
    with patch.object(memory, 'ID_PAGE', 2), patch.object(memory.MemorySource, '_query', one_item_pages):
        payloads = _run(world, checks=4)
    cursors = [(payload['run']['phase'], payload['run']['cursor']) for payload in payloads]
    assert any(phase == company_phase and cursor for phase, cursor in cursors)
    assert any(phase == events_phase and cursor and cursor.get('ids') for phase, cursor in cursors)
    assert all(len(cursor.get('ids') or []) <= 2 for phase, cursor in cursors if phase == events_phase and cursor)
    files = _unzip(world)
    company = [row['memory_id'] for row in _jsonl(files, 'memory_company')]
    assert sorted(company) == sorted(COMPANY_MEMORIES)
    events = [(row['pk'], row['sk']) for row in _jsonl(files, 'memory_events')]
    assert len(events) == len(set(events)) == len(COMPANY_MEMORIES) * EVENTS_PER_MEMORY


def test_a_workspace_without_memory_exports_empty_memory_entities(world):
    seed(world)
    _run(world)
    manifest = json.loads(_unzip(world)['manifest.json'])
    assert all(manifest['entities'][entity]['count'] == 0 for entity in memory.ENTITIES)
    assert {what['count'] for what in manifest['memory']['not_exported'].values()} == {0}


def test_the_memory_entities_follow_the_config_history():
    assert entities.ENTITIES[8] == 'plugin_config_history'
    assert entities.ENTITIES[9:] == memory.ENTITIES


@pytest.mark.parametrize(('build', 'expected'), [
    (memory_company_pk, f'WS#{WS}#MEM#company'),
    (lambda scope: memory_status_pk(scope, 'personal', 'active'), f'WS#{WS}#MEMSTATUS#personal#active'),
    (memory_cursor_pk, f'WS#{WS}#MEMCURSOR'),
    (memory_import_pk, f'WS#{WS}#MEMIMPORT'),
    (lambda scope: memory_event_pk(scope, 'mem_c1'), f'WS#{WS}#MEMEVT#mem_c1'),
])
def test_the_memory_partitions_are_built_by_the_layer(build, expected):
    scope = WorkspaceScope(WS)
    built = build(scope)
    assert built == expected
    assert scope.owns(built)
    assert not WorkspaceScope(OTHER).owns(built)
    with pytest.raises(ValueError, match='non-empty'):
        memory_event_pk(scope, '')
