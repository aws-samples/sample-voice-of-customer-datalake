"""voc-workspace-export end to end with the memory store (7.22.00): rows written through shared/memory_store.py's own
writers, in moto, are what the export's Queries find. A company memory, a personal memory, a session cursor, a
memory import and an event in one workspace, a company memory in another; the export run to completion; the zip
holds the company memory with only its allowlisted fields, the import and the events, counts the personal memory and
the cursor in the manifest only, and holds nothing of the other workspace. So the store's keys and the export's
queries agree, which the seeded tests (test_memory.py, rows written by hand) cannot show.

The memory itself is written by ``write_explicit`` (the memory API's write), its embedding a fixed vector instead of
a Bedrock call; the cursor by ``save_cursor``; the event by ``append_event``. The store has no function that creates
an import row (the memory API builds it), so the import is written as the API writes it: ``import_key`` and the
store's lowest-level writer, ``put_new``, then ``add_import_counts``.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any, Final
from unittest.mock import patch

import pytest

from jobs.workspace_export import memory
from jobs.workspace_export.test.conftest import OTHER, WS, World, seed
from jobs.workspace_export.test.test_handler import _jsonl, _unzip
from jobs.workspace_export.test.test_memory import _run
from shared import memory_policy as policy
from shared import memory_store as store
from shared.embeddings import EMBED_DIMENSIONS
from shared.ws_repo import WorkspaceScope

NOW: Final = datetime(2026, 11, 10, 9, 0, tzinfo=UTC)
#: Who wrote what (subs never leave the store; their hashes must not leave the export either).
ADMIN, MEMBER = 'sub-admin-a', 'sub-member-a'
SESSION: Final = 'sess-member-a-1'
IMPORT_ID: Final = 'imp_0000000000aa01'
#: What names or could confirm a person, in any stored memory row.
PERSON_FIELDS: Final = ('supporter_set', 'embedding', 'actor', 'created_by_hash', 'created_by_username', 'owner_sub')


def _vector(seed_value: int) -> list[float]:
    """A unit vector of its own per statement (no two are near-duplicates, so nothing deduplicates)."""
    vector = [0.0] * EMBED_DIMENSIONS
    vector[seed_value] = 1.0
    return vector


@pytest.fixture(autouse=True)
def _fresh_store_caches() -> Iterator[None]:
    store.clear_pool_cache()
    store.clear_objective_cache()
    yield
    store.clear_pool_cache()
    store.clear_objective_cache()


def _candidate(statement: str, workspace: WorkspaceScope, *, owner: str | None) -> store.Candidate:
    scope = policy.SCOPE_COMPANY if owner is None else policy.SCOPE_PERSONAL
    return store.Candidate(
        statement=statement, kind='product', scope=scope, confidence=0.9,
        source_kind=policy.SOURCE_USER_EXPLICIT, source={'type': 'session', 'ref': SESSION, 'at': NOW.isoformat()},
        supporter=store.supporter_hash(owner or ADMIN), owner_sub=owner, workspace=workspace)


def _write_through_the_store(world: World) -> dict[str, str]:
    """Workspace A's company memory (with a second event), personal memory, cursor and import; B's company memory."""
    a, b = WorkspaceScope(WS), WorkspaceScope(OTHER)
    statements = iter(range(EMBED_DIMENSIONS))
    with patch.object(store, 'embed_text', side_effect=lambda _text: _vector(next(statements))):
        company, _ = store.write_explicit(world.memory, _candidate('Checkout must work on a phone.', a, owner=None),
                                          status=policy.STATUS_ACTIVE, now=NOW)
        personal, _ = store.write_explicit(world.memory,
                                           _candidate('I prefer short summaries.', a, owner=MEMBER),
                                           status=policy.STATUS_ACTIVE, now=NOW)
        other, _ = store.write_explicit(world.memory, _candidate('Workspace B keeps its own memory.', b, owner=None),
                                        status=policy.STATUS_ACTIVE, now=NOW)
    store.append_event(world.memory, company['memory_id'], 'reinforced', actor=store.supporter_hash(MEMBER),
                       detail={'supporters': 2}, now=NOW, workspace=a)
    store.save_cursor(world.memory, SESSION, {'last_turn': 4}, now=NOW, workspace=a)
    store.put_new(world.memory, {
        **store.import_key(IMPORT_ID, a), 'import_id': IMPORT_ID, 'title': 'Release notes', 'status': 'queued',
        's3_key': store.import_object_key(IMPORT_ID, a), 'content_chars': 120, 'chunks_total': 1, 'chunks_done': 0,
        'created': 0, 'reinforced': 0, 'proposed': 0, 'conflicts': 0, 'dropped': 0,
        'created_by_hash': store.supporter_hash(ADMIN), 'created_by_username': 'admin-a',
        'created_at': NOW.isoformat(), 'updated_at': NOW.isoformat()})
    store.add_import_counts(world.memory, IMPORT_ID, {'chunks_done': 1, 'created': 1}, {'status': 'done'}, now=NOW,
                            workspace=a)
    return {'company': company['memory_id'], 'personal': personal['memory_id'], 'other': other['memory_id']}


def _every_byte(files: dict[str, bytes]) -> str:
    return json.dumps({name: body.decode() for name, body in files.items()})


def test_what_the_store_writes_is_what_the_export_reads_and_no_more(world):
    seed(world)
    ids = _write_through_the_store(world)
    _run(world)
    files = _unzip(world)

    [company] = _jsonl(files, 'memory_company')
    assert company['memory_id'] == ids['company']
    assert company['pk'] == f'WS#{WS}#MEM#company'
    assert set(company) <= set(memory.COMPANY_FIELDS)
    assert not [name for name in PERSON_FIELDS if name in company]
    # The chat source keeps its type and time, never the session id.
    assert company['sources'] == [{'type': 'session', 'at': NOW.isoformat()}]

    events = _jsonl(files, 'memory_events')
    assert sorted(event['action'] for event in events) == ['created', 'reinforced']
    assert {event['pk'] for event in events} == {f'WS#{WS}#MEMEVT#{ids["company"]}'}
    assert all(set(event) <= set(memory.EVENT_FIELDS) for event in events)

    [imported] = _jsonl(files, 'memory_imports')
    assert (imported['import_id'], imported['status'], imported['created']) == (IMPORT_ID, 'done', 1)
    assert set(imported) <= set(memory.IMPORT_FIELDS)
    assert 's3_key' not in imported

    counted = json.loads(files['manifest.json'])['memory']['not_exported']
    assert counted == {'personal_memories': {'count': 1, 'complete': True, 'approximate': True},
                       'cursors': {'count': 1, 'complete': True, 'approximate': True}}

    every = _every_byte(files)
    assert ids['personal'] not in every
    assert 'I prefer short summaries.' not in every
    assert SESSION not in every
    for subject in (ADMIN, MEMBER):
        assert subject not in every
        assert store.supporter_hash(subject) not in every
    # Nothing of workspace B.
    assert ids['other'] not in every
    assert OTHER not in every
    assert 'Workspace B keeps its own memory.' not in every


def _rows_in_memory_table(world: World) -> list[dict[str, Any]]:
    return world.memory.scan()['Items']


def test_the_store_wrote_every_row_the_export_left_out(world):
    """The test above proves something only if the rows it says are left out exist: the store wrote them, each
    under workspace A's or B's own keys."""
    seed(world)
    ids = _write_through_the_store(world)
    keys = {(row['pk'], row['sk']) for row in _rows_in_memory_table(world)}
    assert (f'WS#{WS}#MEM#user#{MEMBER}', f'MEM#{ids["personal"]}') in keys
    assert (f'WS#{WS}#MEMCURSOR', f'SESSION#{SESSION}') in keys
    assert (f'WS#{OTHER}#MEM#company', f'MEM#{ids["other"]}') in keys
    assert (f'WS#{WS}#MEMIMPORT', IMPORT_ID) in keys
