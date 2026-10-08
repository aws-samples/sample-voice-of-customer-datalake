"""Memory store against moto: encode/decode, the automated write path, retrieval, merge."""
import io
import json
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.types import Binary

from shared import embeddings
from shared import memory_policy as policy
from shared import memory_store as store
from shared.exceptions import ServiceError
from shared.test.memory_fixtures import candidate, memory_world, relations_reply

NOW = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)


@pytest.fixture
def world(monkeypatch):
    with memory_world(monkeypatch) as w:
        yield w


# ── Encoding ─────────────────────────────────────────────────────────────────
@pytest.mark.parametrize('blob', [None, b'not zlib', Binary(b'\x78\x9c\x03\x00\x00\x00\x00\x01'), 'text'])
def test_corrupt_embeddings_decode_to_none(blob):
    assert store.decode_embedding(blob) is None


# ── Embeddings module ────────────────────────────────────────────────────────
def test_embed_text_calls_titan_v2_normalised(monkeypatch):
    monkeypatch.delenv(embeddings.EMBED_MODEL_ENV, raising=False)
    client = MagicMock()
    client.invoke_model.return_value = {'body': io.BytesIO(json.dumps({'embedding': [0.0] * 1024}).encode())}
    with patch.object(embeddings, 'get_bedrock_client', return_value=client):
        assert len(embeddings.embed_text('hello')) == 1024
    call = client.invoke_model.call_args.kwargs
    assert call['modelId'] == embeddings.DEFAULT_EMBED_MODEL_ID
    assert json.loads(call['body']) == {'inputText': 'hello', 'dimensions': 1024, 'normalize': True}


def test_embed_model_comes_from_env(monkeypatch):
    monkeypatch.setenv(embeddings.EMBED_MODEL_ENV, 'amazon.titan-embed-text-v9:0')
    assert embeddings.embed_model_id() == 'amazon.titan-embed-text-v9:0'


def test_embed_rejects_bad_shapes_and_blank_text():
    client = MagicMock()
    client.invoke_model.return_value = {'body': io.BytesIO(b'{"embedding": [1, 2]}')}
    with patch.object(embeddings, 'get_bedrock_client', return_value=client), pytest.raises(ServiceError):
        embeddings.embed_text('hello')
    with pytest.raises(ValueError, match='cannot embed blank text'):
        embeddings.embed_text('   ')


# ── Automated write path ─────────────────────────────────────────────────────
def test_new_candidates_insert_and_low_confidence_drops(world):
    outcome = store.write_automated(world.memory, [
        candidate('Customers want faster refunds on returns'),
        candidate('Maybe the logo is blue', confidence=0.3),
    ], now=NOW)
    assert outcome.to_dict() == {'created': 1, 'reinforced': 0, 'proposed': 0, 'conflicts': 0, 'dropped': 1}
    [row] = world.memories()
    assert row['status'] == 'active'
    assert row['gsi1pk'] == 'MEMSTATUS#company#active'
    assert row['supporters'] == 1
    assert isinstance(row['embedding'], Binary)


def test_mid_confidence_company_candidate_is_proposed(world):
    outcome = store.write_automated(world.memory, [candidate('Customers like dark mode', confidence=0.6)], now=NOW)
    assert outcome.proposed == 1
    assert world.memories()[0]['status'] == 'proposed'


def test_duplicate_adds_one_supporter_once_per_person(world):
    store.write_automated(world.memory, [candidate('Customers want faster refunds', supporter='h-a')], now=NOW)
    store.write_automated(world.memory, [candidate('Customers want faster refunds', supporter='h-b')], now=NOW)
    store.write_automated(world.memory, [candidate('Customers want faster refunds', supporter='h-b')], now=NOW)
    [row] = world.memories()
    assert row['supporters'] == 2
    assert row['supporter_set'] == {'h-a', 'h-b'}


def test_a_batch_dedups_itself(world):
    outcome = store.write_automated(world.memory, [
        candidate('Customers want faster refunds', supporter='h-a'),
        candidate('Customers want faster refunds', supporter='h-b'),
    ], now=NOW)
    assert (outcome.created, outcome.reinforced) == (1, 1)


def test_contradiction_becomes_a_linked_conflict(world):
    store.write_automated(world.memory, [candidate('Customers prefer monthly billing plans')], now=NOW)
    world.converse.return_value = relations_reply(['contradicts'])
    outcome = store.write_automated(
        world.memory, [candidate('Customers now prefer yearly billing plans', supporter='h-b')], now=NOW)
    assert outcome.conflicts == 1
    rows = {r['statement']: r for r in world.memories()}
    new, old = rows['Customers now prefer yearly billing plans'], rows['Customers prefer monthly billing plans']
    assert new['status'] == 'conflict'
    assert new['conflicts_with'] == [old['memory_id']]
    assert old['conflicts_with'] == [new['memory_id']]
    assert old['status'] == 'active'
    # The relation judge sees the pair as DATA in the user message, never in the system prompt.
    call = world.converse.call_args.kwargs
    assert '<pairs>' in call['prompt']
    assert 'monthly' not in call['system_prompt']


def test_forgotten_memory_returns_only_as_proposed(world):
    store.write_automated(world.memory, [candidate('Customers want faster refunds')], now=NOW)
    [row] = world.memories()
    store.set_fields(world.memory, row, {'status': 'archived', 'tombstoned': True}, now=NOW)
    outcome = store.write_automated(world.memory, [candidate('Customers want faster refunds', supporter='h-b')],
                                    now=NOW)
    assert outcome.proposed == 1
    statuses = sorted(r['status'] for r in world.memories())
    assert statuses == ['archived', 'proposed']


def test_personal_candidates_land_in_the_owner_partition(world):
    store.write_automated(world.memory, [candidate('Prefers short replies', scope='personal', kind='working_style',
                                                   owner_sub='sub-user')], now=NOW)
    assert world.memories() == []
    [row] = world.memories(store.scope_pk('personal', 'sub-user'))
    assert row['owner_sub'] == 'sub-user'
    assert row['gsi1pk'] == 'MEMSTATUS#personal#active'
    assert 'owner_sub' not in store.public_view(row)


def test_objective_alignment_is_recorded(world):
    world.aggregates.put_item(Item={**store.COMPANY_CONTEXT_KEY, 'updated_at': 'v1', 'objectives': [
        {'id': 'obj1', 'title': 'Faster refunds', 'description': 'Customers want faster refunds'}]})
    store.write_automated(world.memory, [candidate('Customers want faster refunds')],
                          aggregates_table=world.aggregates, now=NOW)
    assert world.memories()[0]['aligned_objective_ids'] == ['obj1']


# ── Explicit writes, retrieval, merge, cursors ───────────────────────────────
def test_explicit_duplicate_upgrades_an_automated_memory(world):
    store.write_automated(world.memory, [candidate('Customers want faster refunds')], now=NOW)
    item, deduplicated = store.write_explicit(
        world.memory, candidate('Customers want faster refunds', supporter='h-b', source_kind='user_explicit'),
        status='active', now=NOW)
    assert deduplicated is True
    assert item['source_kind'] == 'user_explicit'
    assert item['supporters'] == 2


def test_retrieve_ranks_relevant_active_memories_and_marks_them_used(world):
    store.write_automated(world.memory, [
        candidate('Customers want faster refunds'),
        candidate('Mobile checkout crashes on Android'),
    ], now=NOW - timedelta(days=30))
    store.write_automated(world.memory, [candidate('Prefers refunds summaries short', scope='personal',
                                                   kind='working_style', owner_sub='sub-user')], now=NOW)
    later = NOW + timedelta(days=1)
    rows = store.retrieve(world.memory, 'how fast are refunds', caller_sub='sub-user', include_personal=True,
                          k=8, now=later)
    statements = [r['statement'] for r in rows]
    assert 'Customers want faster refunds' in statements
    assert 'Mobile checkout crashes on Android' not in statements
    used = next(r for r in world.memories() if r['statement'] == 'Customers want faster refunds')
    assert used['last_used_at'] == later.isoformat()
    store.clear_pool_cache()
    company_only = store.retrieve(world.memory, 'refunds summaries', caller_sub='sub-user', include_personal=False,
                                  k=8, now=later)
    assert all(r['scope'] == 'company' for r in company_only)


def test_merge_unions_supporters_and_archives_originals(world):
    store.write_automated(world.memory, [candidate('Refunds take too long', supporter='h-a'),
                                         candidate('Delivery tracking is unclear', supporter='h-b')], now=NOW)
    rows = world.memories()
    merged = store.merge_memories(world.memory, rows, 'Refunds and tracking are slow', actor='h-c', now=NOW)
    assert merged['supporters'] == 3
    after = {r['memory_id']: r for r in world.memories()}
    for row in rows:
        assert after[row['memory_id']]['status'] == 'archived'
        assert after[row['memory_id']]['merged_into'] == merged['memory_id']
        assert after[row['memory_id']]['tombstoned'] is False
    assert after[merged['memory_id']]['source_kind'] == 'user_explicit'


def test_cursors_and_import_counters(world):
    store.save_cursor(world.memory, 's1', {'owner_sub': 'u', 'extracted_count': 3}, now=NOW)
    assert store.get_cursors(world.memory, ['s1', 's2'])['s1']['extracted_count'] == 3
    world.memory.put_item(Item={**store.import_key('imp_1'), 'import_id': 'imp_1', 'created': 0, 'status': 'queued'})
    store.add_import_counts(world.memory, 'imp_1', {'created': 2}, {'status': 'processing'}, now=NOW)
    store.add_import_counts(world.memory, 'imp_1', {'created': 1}, {}, now=NOW)
    record = store.get_import(world.memory, 'imp_1')
    assert record is not None
    assert (record['created'], record['status']) == (3, 'processing')
    assert store.get_import(world.memory, 'nope') is None


def test_retention_policy_constants_are_the_brief():
    assert (policy.AUTO_CONFIDENCE_MIN, policy.DEDUP_COSINE, policy.DECAY_RETENTION_DAYS) == (0.8, 0.86, 90)
    assert policy.DEFAULT_TOP_K == 8
