"""Mutation hardening for ``shared/memory_store.py`` lines 1-522 (keys, encoding,
item building, reads, the row-level writes, company-context reads).

``test_memory_store.py`` drives the module end to end through moto, so it pins
*outcomes* (a row exists, a supporter count is 2). A mutation run found the
*mechanics* those outcomes do not fix:

* the exact DynamoDB requests: ``ConsistentRead=True`` on a point read, the
  ``attribute_not_exists(pk)`` / ``attribute_exists(pk)`` guards, ``ReturnValues``,
  the ``SET #f0 = :v0`` expression shape, the ``gsi1`` index name and partition
  key, the projection names, ``ExclusiveStartKey`` on the second page;
* every literal in a stored row (``search_text`` lowered, ``supporters`` starting
  at 1, ``tombstoned`` False, ``gsi1sk`` = created stamp, ``owner_sub`` only on a
  personal row, ``expires_at`` only when set) and the exact wire blob (zlib level 6
  over little-endian float32);
* the boundaries: a 40-character id is addressable and a 41-character one is not,
  a neighbour exactly at ``min_cosine`` is kept, a pool cached for 59 s is reused
  and one cached for 60 s is reloaded, sources are trimmed at exactly 20;
* the best-effort failure paths: which warning each swallowed error logs, that a
  non-conditional error in ``reinforce`` propagates while a conditional one falls
  back to the refresh write that drops the ``sources`` append;
* what the public view hides (``ref`` of a session source, supporter hashes,
  ``owner_sub``) and what ``_plain`` does to Decimals and sets.
"""
from __future__ import annotations

import hashlib
import zlib
from array import array
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, get_type_hints
from unittest.mock import MagicMock, call, patch

import pytest
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import Binary

from shared import memory_policy as policy
from shared import memory_store as store
from shared.embeddings import EMBED_DIMENSIONS
from shared.test.memory_fixtures import candidate, fake_vector, memory_world

NOW = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)
STAMP = '2026-10-04T12:00:00+00:00'


class ConditionalCheckFailedException(Exception):
    """The name is the signal ``is_conditional_check_failure`` accepts without a payload."""


@pytest.fixture(autouse=True)
def _clean_caches():
    """Every module-level cache starts and ends empty, whatever a test does to it."""
    store._table_cache.clear()
    store.clear_pool_cache()
    store.clear_objective_cache()
    yield
    store._table_cache.clear()
    store.clear_pool_cache()
    store.clear_objective_cache()


@pytest.fixture
def world(monkeypatch):
    with memory_world(monkeypatch) as w:
        yield w


def unit(index: int, length: int = EMBED_DIMENSIONS) -> list[float]:
    vector = [0.0] * length
    vector[index] = 1.0
    return vector


def row(**overrides: Any) -> dict[str, Any]:
    return {'pk': 'MEM#company', 'sk': 'MEM#mem_1', 'memory_id': 'mem_1', 'scope': 'company',
            'status': 'active', **overrides}


# ── Keys and ids ─────────────────────────────────────────────────────────────
class TestKeysAreTheStorageContract:
    def test_constants(self):
        assert store.GSI1_INDEX == 'gsi1-by-memory-status'
        assert store.COMPANY_PK == 'MEM#company'
        assert store.PERSONAL_PK_PREFIX == 'MEM#user#'
        assert store.MEMORY_SK_PREFIX == 'MEM#'
        assert store.EVENT_PK_PREFIX == 'MEMEVT#'
        assert store.CURSOR_PK == 'MEMCURSOR'
        assert store.CURSOR_SK_PREFIX == 'SESSION#'
        assert store.IMPORT_PK == 'MEMIMPORT'
        assert store.MEMORY_SURFACE == 'memory'
        assert store.SERVICE_TIER_FLEX == 'flex'
        assert store.POOL_CACHE_SECONDS == 60
        assert store.MAX_JUDGED_NEIGHBOURS == 3
        assert store.MAX_JUDGED_PAIRS == 60
        assert store.MEMORY_TABLE_ENV == 'MEMORY_TABLE'
        assert store.COMPANY_CONTEXT_KEY == {'pk': 'SETTINGS#company_context', 'sk': 'config'}

    def test_public_fields_are_exactly_the_response_contract(self):
        # Same 19 names as the module, written as one line each so a renamed or dropped field fails here.
        assert store._PUBLIC_FIELDS == ('memory_id', 'scope', 'status', 'kind', 'statement', 'categories',
                                        'confidence', 'source_kind', 'supporters', 'created_at',
                                        'last_reinforced_at', 'last_used_at', 'retention', 'expires_at',
                                        'conflicts_with', 'tombstoned', 'merged_into', 'aligned_objective_ids',
                                        'updated_at')

    def test_scope_pk(self):
        assert store.scope_pk('company', None) == 'MEM#company'
        assert store.scope_pk('company', 'sub-1') == 'MEM#company'
        assert store.scope_pk('personal', 'sub-1') == 'MEM#user#sub-1'
        with pytest.raises(ValueError, match=r'^a personal memory needs an owner$'):
            store.scope_pk('personal', None)
        with pytest.raises(ValueError, match=r'^a personal memory needs an owner$'):
            store.scope_pk('personal', '')

    def test_key_helpers(self):
        assert store.memory_key('MEM#company', 'mem_1') == {'pk': 'MEM#company', 'sk': 'MEM#mem_1'}
        assert store.item_key({'pk': 'P', 'sk': 'S', 'other': 1}) == {'pk': 'P', 'sk': 'S'}
        assert store.status_partition('personal', 'proposed') == 'MEMSTATUS#personal#proposed'

    def test_new_memory_id_is_mem_plus_16_hex(self):
        with patch.object(store.secrets, 'token_hex', return_value='0123456789abcdef') as token:
            assert store.new_memory_id() == 'mem_0123456789abcdef'
        token.assert_called_once_with(8)

    def test_new_import_id_is_millisecond_time_in_12_hex_plus_4_hex(self):
        with patch.object(store.time, 'time', return_value=1_790_000_000.123456), \
                patch.object(store.secrets, 'token_hex', return_value='beef') as token:
            assert store.new_import_id() == f'imp_{1_790_000_000_123:012x}beef'
        token.assert_called_once_with(2)

    def test_supporter_hash_is_the_namespaced_sha256_prefix(self):
        expected = hashlib.sha256(b'voc-memory-supporter/v1' + b'sub-1').hexdigest()[:32]
        assert store.supporter_hash('sub-1') == expected
        assert len(store.supporter_hash('sub-1')) == 32

    def test_now_iso(self):
        assert store.now_iso(NOW) == STAMP
        before = datetime.now(UTC)
        parsed = datetime.fromisoformat(store.now_iso())
        assert parsed.tzinfo is not None
        assert timedelta(0) <= parsed - before < timedelta(seconds=5)


class TestMemoryTableEnv:
    def test_unset_env_gives_none_and_a_set_env_caches_the_table(self, monkeypatch):
        monkeypatch.delenv('MEMORY_TABLE', raising=False)
        assert store.get_memory_table() is None
        monkeypatch.setenv('MEMORY_TABLE', 'voc-memory-x')
        resource = MagicMock()
        with patch.object(store, 'get_dynamodb_resource', return_value=resource):
            first = store.get_memory_table()
            second = store.get_memory_table()
        assert first is resource.Table.return_value
        assert second is first
        resource.Table.assert_called_once_with('voc-memory-x')


# ── Embeddings on the wire ───────────────────────────────────────────────────
class TestEmbeddingWireFormat:
    def test_blob_is_zlib_level_6_over_little_endian_float32(self):
        vector = fake_vector('checkout is slow on mobile')
        assert store.encode_embedding(vector) == zlib.compress(array('f', vector).tobytes(), 6)

    @pytest.mark.parametrize('length', [EMBED_DIMENSIONS - 1, EMBED_DIMENSIONS + 1])
    def test_only_the_exact_dimension_encodes(self, length):
        with pytest.raises(ValueError, match=r'^embedding has the wrong dimension$'):
            store.encode_embedding([0.0] * length)

    @pytest.mark.parametrize('length', [EMBED_DIMENSIONS - 1, EMBED_DIMENSIONS + 1])
    def test_a_blob_of_the_wrong_length_decodes_to_none(self, length):
        blob = zlib.compress(array('f', [0.0] * length).tobytes(), 6)
        assert store.decode_embedding(blob) is None
        assert store.decode_embedding(Binary(blob)) is None

    def test_bytes_bytearray_and_binary_all_decode(self):
        vector = unit(3)
        blob = store.encode_embedding(vector)
        assert store.decode_embedding(blob) == vector
        assert store.decode_embedding(bytearray(blob)) == vector
        assert store.decode_embedding(Binary(blob)) == vector

    def test_cosine_is_the_dot_product_bounded_by_the_shorter_vector(self):
        assert store.cosine([1.0, 0.0, 0.0], [1.0, 0.0]) == 1.0
        assert store.cosine([0.5, 0.5], [0.5, 0.5, 9.0]) == 0.5
        assert store.cosine([0.0, 1.0], [1.0, 0.0]) == 0.0

    def test_dec_rounds_to_four_places(self):
        assert store._dec(0.123456) == Decimal('0.1235')
        assert store._dec(0.9) == Decimal('0.9')


# ── Item building and views ──────────────────────────────────────────────────
class TestBuildItemWritesEveryFieldLiterally:
    def test_candidate_defaults(self):
        c = store.Candidate(statement='Customers want faster refunds', kind='product', scope='company',
                            confidence=0.9, source_kind='extracted', source={}, supporter='h-a')
        assert c.owner_sub is None
        assert (c.retention, c.expires_at, c.categories) == ('decay', None, [])

    def test_candidate_optional_fields_are_typed_as_optional_strings(self):
        # Annotations are strings under ``from __future__ import annotations``; resolving them is
        # what dataclass introspection (and this test) needs, so an invalid one must not sneak in.
        hints = get_type_hints(store.Candidate)
        assert hints['owner_sub'] == str | None
        assert hints['expires_at'] == str | None

    def test_company_row(self):
        vector = unit(0)
        c = candidate('Customers WANT faster refunds', supporter='h-a',
                      source={'type': 'session', 'ref': 's1', 'at': 'T0'})
        c.categories = ['Billing']
        item = store.build_item(c, memory_id='mem_1', status='proposed', vector=vector,
                                aligned_ids=['obj1'], conflicts_with=('mem_9',), now=NOW)
        assert item == {
            'pk': 'MEM#company', 'sk': 'MEM#mem_1', 'memory_id': 'mem_1', 'scope': 'company',
            'status': 'proposed', 'kind': 'product', 'statement': 'Customers WANT faster refunds',
            'search_text': 'customers want faster refunds', 'categories': ['Billing'],
            'confidence': Decimal('0.9'), 'source_kind': 'extracted', 'supporters': 1,
            'supporter_set': {'h-a'}, 'sources': [{'type': 'session', 'ref': 's1', 'at': 'T0'}],
            'embedding': Binary(store.encode_embedding(vector)), 'created_at': STAMP, 'updated_at': STAMP,
            'last_reinforced_at': STAMP, 'retention': 'decay', 'conflicts_with': ['mem_9'], 'tombstoned': False,
            'aligned_objective_ids': ['obj1'], 'gsi1pk': 'MEMSTATUS#company#proposed', 'gsi1sk': STAMP,
        }
        assert 'owner_sub' not in item
        assert 'expires_at' not in item

    def test_personal_row_carries_owner_and_expiry(self):
        c = candidate('Prefers short replies', scope='personal', kind='working_style', owner_sub='sub-u')
        c.expires_at = '2027-01-01'
        c.retention = 'dated'
        item = store.build_item(c, memory_id='mem_2', status='active', vector=unit(1), aligned_ids=[], now=NOW)
        assert item['pk'] == 'MEM#user#sub-u'
        assert item['owner_sub'] == 'sub-u'
        assert item['expires_at'] == '2027-01-01'
        assert item['retention'] == 'dated'
        assert item['gsi1pk'] == 'MEMSTATUS#personal#active'
        assert item['conflicts_with'] == []

    def test_a_company_candidate_with_an_owner_does_not_record_the_owner(self):
        c = candidate('Customers want faster refunds', owner_sub='sub-u')
        item = store.build_item(c, memory_id='mem_3', status='active', vector=unit(1), aligned_ids=[], now=NOW)
        assert item['pk'] == 'MEM#company'
        assert 'owner_sub' not in item


class TestPlainAndPublicView:
    @pytest.mark.parametrize(('value', 'expected'), [
        (Decimal('3'), 3), (Decimal('2.5'), 2.5), ({'b', 'a'}, ['a', 'b']), (frozenset({2, 1}), [1, 2]),
        ([Decimal('1'), {'x': Decimal('0.5')}], [1, {'x': 0.5}]), ('s', 's'), (None, None),
    ])
    def test_plain(self, value, expected):
        out = store._plain(value)
        assert out == expected
        assert type(out) is type(expected)

    @pytest.mark.parametrize(('sources', 'expected'), [
        ('nope', []),
        (None, []),
        (['x', {'type': 'session', 'ref': 's1', 'at': 'T0'}], [{'type': 'session', 'at': 'T0'}]),
        ([{'type': 'import', 'ref': 'imp_1', 'at': 'T0'}], [{'type': 'import', 'at': 'T0', 'ref': 'imp_1'}]),
        ([{'type': 'agent_run', 'ref': 'run_1', 'at': 'T0'}], [{'type': 'agent_run', 'at': 'T0', 'ref': 'run_1'}]),
        ([{'type': 'import', 'ref': '', 'at': 'T0'}], [{'type': 'import', 'at': 'T0'}]),
        ([{'type': 'agent', 'ref': 'run_1'}], [{'type': 'agent', 'at': None}]),
        ([{}], [{'type': None, 'at': None}]),
    ])
    def test_public_sources(self, sources, expected):
        assert store._public_sources(sources) == expected

    def test_public_view_is_exactly_the_public_fields(self):
        item = store.build_item(candidate('Customers want faster refunds', supporter='h-a',
                                          source={'type': 'session', 'ref': 's1', 'at': 'T0'}),
                                memory_id='mem_1', status='active', vector=unit(0), aligned_ids=[], now=NOW)
        item['owner_sub'] = 'sub-u'
        item['supporters'] = Decimal('2')
        assert store.public_view(item) == {
            'memory_id': 'mem_1', 'scope': 'company', 'status': 'active', 'kind': 'product',
            'statement': 'Customers want faster refunds', 'categories': [], 'confidence': 0.9,
            'source_kind': 'extracted', 'supporters': 2, 'created_at': STAMP, 'last_reinforced_at': STAMP,
            'retention': 'decay', 'conflicts_with': [], 'tombstoned': False, 'aligned_objective_ids': [],
            'updated_at': STAMP, 'sources': [{'type': 'session', 'at': 'T0'}],
        }

    def test_public_view_defaults_for_a_sparse_legacy_row(self):
        assert store.public_view({'memory_id': 'mem_1', 'tombstoned': 1}) == {
            'memory_id': 'mem_1', 'tombstoned': True, 'sources': [], 'conflicts_with': [], 'categories': []}
        assert store.public_view({'memory_id': 'mem_1'})['tombstoned'] is False

    def test_summary_view(self):
        assert store.summary_view({'memory_id': 'mem_1', 'scope': 'company', 'kind': 'product',
                                   'statement': 'S', 'supporters': Decimal('4'), 'embedding': b'x'}) == {
            'memory_id': 'mem_1', 'scope': 'company', 'kind': 'product', 'statement': 'S', 'supporters': 4}
        assert store.summary_view({}) == {'memory_id': None, 'scope': None, 'kind': None, 'statement': None,
                                          'supporters': 1}


# ── Reads: the exact DynamoDB requests ───────────────────────────────────────
class TestReadsIssueExactRequests:
    def test_projection(self):
        assert store._projection(['statement', 'kind']) == ('#p0, #p1', {'#p0': 'statement', '#p1': 'kind'})

    def test_paginate_follows_last_evaluated_key_then_stops(self):
        table = MagicMock()
        table.query.side_effect = [
            {'Items': [{'id': 1}], 'LastEvaluatedKey': {'pk': 'P', 'sk': 'S1'}},
            {'Items': [{'id': 2}]},
        ]
        assert store._paginate(table, {'KeyConditionExpression': 'kce'}) == [{'id': 1}, {'id': 2}]
        assert table.query.call_args_list == [
            call(KeyConditionExpression='kce'),
            call(KeyConditionExpression='kce', ExclusiveStartKey={'pk': 'P', 'sk': 'S1'}),
        ]

    def test_paginate_tolerates_a_page_without_items(self):
        table = MagicMock()
        table.query.return_value = {}
        assert store._paginate(table, {}) == []
        table.query.assert_called_once_with()

    def test_query_partition(self):
        table = MagicMock()
        table.query.return_value = {'Items': []}
        store.query_partition(table, 'MEM#company')
        table.query.assert_called_once_with(KeyConditionExpression=Key('pk').eq('MEM#company'))
        table.query.reset_mock()
        # The sk prefix is part of the KEY condition: DynamoDB refuses a FilterExpression on a key (F1).
        store.query_partition(table, 'MEM#company', sk_prefix='MEM#')
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq('MEM#company') & Key('sk').begins_with('MEM#'))

    def test_query_status_uses_gsi1_and_projects_only_when_asked(self):
        table = MagicMock()
        table.query.return_value = {'Items': []}
        store.query_status(table, 'personal', 'archived')
        table.query.assert_called_once_with(
            IndexName='gsi1-by-memory-status',
            KeyConditionExpression=Key('gsi1pk').eq('MEMSTATUS#personal#archived'))
        table.query.reset_mock()
        store.query_status(table, 'company', 'active', attributes=[])
        assert 'ProjectionExpression' not in table.query.call_args.kwargs
        table.query.reset_mock()
        store.query_status(table, 'company', 'active', attributes=['pk', 'sk'])
        table.query.assert_called_once_with(
            IndexName='gsi1-by-memory-status',
            KeyConditionExpression=Key('gsi1pk').eq('MEMSTATUS#company#active'),
            ProjectionExpression='#p0, #p1', ExpressionAttributeNames={'#p0': 'pk', '#p1': 'sk'})

    def test_get_item_reads_consistently_and_drops_non_dicts(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {'pk': 'P'}}
        assert store.get_item(table, {'pk': 'P', 'sk': 'S'}) == {'pk': 'P'}
        table.get_item.assert_called_once_with(Key={'pk': 'P', 'sk': 'S'}, ConsistentRead=True)
        table.get_item.return_value = {'Item': ['not a dict']}
        assert store.get_item(table, {'pk': 'P', 'sk': 'S'}) is None
        table.get_item.return_value = {}
        assert store.get_item(table, {'pk': 'P', 'sk': 'S'}) is None


class TestLocateAddressesCompanyThenOwnPersonal:
    @pytest.mark.parametrize('memory_id', [None, 7, 'MEM_abc', 'abc', 'mem_' + 'x' * 37])
    def test_rejected_ids_never_reach_the_table(self, memory_id):
        table = MagicMock()
        assert store.locate(table, memory_id, 'sub-u') is None
        table.get_item.assert_not_called()

    def test_a_40_character_id_is_looked_up(self):
        table = MagicMock()
        table.get_item.return_value = {}
        memory_id = 'mem_' + 'x' * 36
        assert len(memory_id) == 40
        store.locate(table, memory_id, None)
        table.get_item.assert_called_once_with(Key={'pk': 'MEM#company', 'sk': f'MEM#{memory_id}'},
                                               ConsistentRead=True)

    def test_company_hit_skips_the_personal_lookup(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {'pk': 'MEM#company'}}
        assert store.locate(table, 'mem_1', 'sub-u') == {'pk': 'MEM#company'}
        table.get_item.assert_called_once_with(Key={'pk': 'MEM#company', 'sk': 'MEM#mem_1'}, ConsistentRead=True)

    def test_company_miss_falls_back_to_the_callers_partition_only(self):
        table = MagicMock()
        table.get_item.side_effect = [{}, {'Item': {'pk': 'MEM#user#sub-u'}}]
        assert store.locate(table, 'mem_1', 'sub-u') == {'pk': 'MEM#user#sub-u'}
        assert table.get_item.call_args_list == [
            call(Key={'pk': 'MEM#company', 'sk': 'MEM#mem_1'}, ConsistentRead=True),
            call(Key={'pk': 'MEM#user#sub-u', 'sk': 'MEM#mem_1'}, ConsistentRead=True),
        ]
        table.get_item.reset_mock()
        table.get_item.side_effect = [{}]
        assert store.locate(table, 'mem_1', None) is None
        table.get_item.assert_called_once()


class TestPoolCacheBoundary:
    def _table(self, statements: list[str]) -> MagicMock:
        table = MagicMock()
        rows = [{'pk': 'MEM#company', 'sk': f'MEM#mem_{i}', 'embedding': Binary(store.encode_embedding(unit(i)))}
                for i, _ in enumerate(statements)]
        rows.append({'pk': 'MEM#company', 'sk': 'MEM#mem_bad', 'embedding': b'garbage'})
        rows.append({'pk': 'MEM#company', 'sk': 'MEM#mem_none'})
        table.query.return_value = {'Items': rows}
        return table

    def test_load_pool_decodes_vectors_and_drops_undecodable_rows(self):
        table = self._table(['a', 'b'])
        pool = store.load_pool(table, 'MEM#company')
        assert [r['sk'] for r in pool] == ['MEM#mem_0', 'MEM#mem_1']
        assert pool[0]['_vector'] == unit(0)
        assert pool[1]['_vector'] == unit(1)
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq('MEM#company') & Key('sk').begins_with('MEM#'))
        assert store._pool_cache == {}

    def test_uncached_loads_query_every_time(self):
        table = self._table(['a'])
        store.load_pool(table, 'MEM#company')
        store.load_pool(table, 'MEM#company')
        assert table.query.call_count == 2

    @pytest.mark.parametrize(('age', 'queries'), [(59.9, 1), (60.0, 2), (60.1, 2)])
    def test_a_cached_pool_is_reused_for_under_60_seconds(self, age, queries):
        table = self._table(['a'])
        with patch.object(store.time, 'monotonic', side_effect=[1000.0, 1000.0 + age, 1000.0 + age]):
            first = store.load_pool(table, 'MEM#company', cached=True)
            second = store.load_pool(table, 'MEM#company', cached=True)
        assert table.query.call_count == queries
        assert (second is first) == (queries == 1)
        assert store._pool_cache['MEM#company'][1] == second

    def test_invalidate_drops_only_that_partition(self):
        store._pool_cache['MEM#company'] = (0.0, [])
        store._pool_cache['MEM#user#u'] = (0.0, [])
        store._invalidate('MEM#company')
        assert store._pool_cache == {'MEM#user#u': (0.0, [])}
        store._invalidate('MEM#missing')
        store.clear_pool_cache()
        assert store._pool_cache == {}


class TestNearest:
    def test_threshold_is_inclusive_sorted_desc_and_limited(self):
        v = [1.0, 0.0]
        pool = [
            {'id': 'a', '_vector': [0.5, 0.5]},
            {'id': 'b', '_vector': [1.0, 0.0]},
            {'id': 'c', '_vector': [0.49, 0.5]},
            {'id': 'd'},
            {'id': 'e', '_vector': [0.75, 0.0]},
        ]
        assert store.nearest(pool, v, min_cosine=0.5, limit=10) == [
            (pool[1], 1.0), (pool[4], 0.75), (pool[0], 0.5)]
        assert store.nearest(pool, v, min_cosine=0.5, limit=2) == [(pool[1], 1.0), (pool[4], 0.75)]
        assert store.nearest(pool, v, min_cosine=0.5, limit=0) == []


# ── Row-level writes ─────────────────────────────────────────────────────────
class TestPutAndEvents:
    def test_strip_runtime_drops_underscore_keys_only(self):
        assert store.strip_runtime({'a': 1, '_vector': [1], 'b_': 2}) == {'a': 1, 'b_': 2}

    def test_put_new_is_a_guarded_insert_without_runtime_keys(self):
        table = MagicMock()
        store.put_new(table, {'pk': 'P', '_vector': [1.0]})
        table.put_item.assert_called_once_with(Item={'pk': 'P'}, ConditionExpression='attribute_not_exists(pk)')

    def test_append_event_row_shape(self):
        table = MagicMock()
        with patch.object(store.secrets, 'token_hex', return_value='abcdef') as token:
            store.append_event(table, 'mem_1', 'created', actor='h-a', detail={'status': 'active'}, now=NOW)
        token.assert_called_once_with(3)
        table.put_item.assert_called_once_with(Item={
            'pk': 'MEMEVT#mem_1', 'sk': f'{STAMP}#abcdef', 'action': 'created', 'at': STAMP,
            'actor': 'h-a', 'detail': {'status': 'active'}})

    def test_append_event_omits_empty_actor_and_detail(self):
        table = MagicMock()
        store.append_event(table, 'mem_1', 'used', actor='', detail={}, now=NOW)
        item = table.put_item.call_args.kwargs['Item']
        assert 'actor' not in item
        assert 'detail' not in item
        assert sorted(item) == ['action', 'at', 'pk', 'sk']

    def test_append_event_detail_is_a_copy(self):
        table = MagicMock()
        detail = {'with': 'mem_2'}
        store.append_event(table, 'mem_1', 'conflict_linked', detail=detail, now=NOW)
        assert table.put_item.call_args.kwargs['Item']['detail'] is not detail

    def test_append_event_swallows_and_logs_a_failed_write(self):
        table = MagicMock()
        table.put_item.side_effect = RuntimeError('boom')
        with patch.object(store.logger, 'exception') as log:
            store.append_event(table, 'mem_1', 'created', now=NOW)
        log.assert_called_once_with('Memory audit event write failed')


class TestSetFields:
    def test_request_shape_with_a_status_change(self):
        table = MagicMock()
        table.update_item.return_value = {'Attributes': {'pk': 'MEM#company', 'status': 'archived'}}
        store._pool_cache['MEM#company'] = (0.0, [])
        item = row()
        result = store.set_fields(table, item, {'status': 'archived', 'tombstoned': True}, now=NOW)
        table.update_item.assert_called_once_with(
            Key={'pk': 'MEM#company', 'sk': 'MEM#mem_1'},
            UpdateExpression='SET #f0 = :v0, #f1 = :v1, #f2 = :v2, #f3 = :v3',
            ExpressionAttributeNames={'#f0': 'status', '#f1': 'tombstoned', '#f2': 'updated_at', '#f3': 'gsi1pk'},
            ExpressionAttributeValues={':v0': 'archived', ':v1': True, ':v2': STAMP,
                                       ':v3': 'MEMSTATUS#company#archived'},
            ConditionExpression='attribute_exists(pk)',
            ReturnValues='ALL_NEW',
        )
        assert result == {'pk': 'MEM#company', 'status': 'archived'}
        assert 'MEM#company' not in store._pool_cache

    def test_without_a_status_change_no_gsi1pk_and_the_fallback_merges_values(self):
        table = MagicMock()
        table.update_item.return_value = {}
        item = row()
        result = store.set_fields(table, item, {'statement': 'New'}, now=NOW)
        kwargs = table.update_item.call_args.kwargs
        assert kwargs['UpdateExpression'] == 'SET #f0 = :v0, #f1 = :v1'
        assert kwargs['ExpressionAttributeNames'] == {'#f0': 'statement', '#f1': 'updated_at'}
        assert kwargs['ExpressionAttributeValues'] == {':v0': 'New', ':v1': STAMP}
        assert result == {**item, 'statement': 'New', 'updated_at': STAMP}


class TestReinforce:
    def test_new_supporter_on_an_active_item(self):
        table = MagicMock()
        with patch.object(store, 'append_event') as event, patch.object(store, '_trim_sources') as trim:
            added = store.reinforce(table, row(), 'h-b', {'type': 'session', 'ref': 's2', 'at': 'T1'},
                                    now=NOW)
        assert added is True
        table.update_item.assert_called_once_with(
            Key={'pk': 'MEM#company', 'sk': 'MEM#mem_1'},
            UpdateExpression='SET last_reinforced_at = :now, updated_at = :now, gsi1sk = :now, '
                             'sources = list_append(if_not_exists(sources, :empty), :src) '
                             'ADD supporters :one, supporter_set :who',
            ConditionExpression='attribute_exists(pk) AND NOT contains(supporter_set, :h)',
            ExpressionAttributeValues={':now': STAMP, ':empty': [], ':src': [{'type': 'session', 'ref': 's2',
                                                                               'at': 'T1'}],
                                       ':one': 1, ':who': {'h-b'}, ':h': 'h-b'},
        )
        trim.assert_called_once_with(table, row(), {'type': 'session', 'ref': 's2', 'at': 'T1'})
        event.assert_called_once_with(table, 'mem_1', 'reinforced', actor='h-b', now=NOW)

    def test_without_a_source_nothing_is_appended(self):
        table = MagicMock()
        with patch.object(store, 'append_event'):
            store.reinforce(table, row(), 'h-b', None, now=NOW)
        kwargs = table.update_item.call_args.kwargs
        assert kwargs['UpdateExpression'] == ('SET last_reinforced_at = :now, updated_at = :now, gsi1sk = :now '
                                              'ADD supporters :one, supporter_set :who')
        assert kwargs['ExpressionAttributeValues'] == {':now': STAMP, ':one': 1, ':who': {'h-b'}, ':h': 'h-b'}
        assert 'ExpressionAttributeNames' not in kwargs

    def test_an_archived_item_revives_but_a_tombstoned_one_does_not(self):
        table = MagicMock()
        with patch.object(store, 'append_event'):
            store.reinforce(table, row(status='archived', scope='personal'), 'h-b', None, now=NOW)
        kwargs = table.update_item.call_args.kwargs
        assert kwargs['UpdateExpression'] == ('SET last_reinforced_at = :now, updated_at = :now, gsi1sk = :now, '
                                              '#st = :active, gsi1pk = :gpk ADD supporters :one, supporter_set :who')
        assert kwargs['ExpressionAttributeNames'] == {'#st': 'status'}
        assert kwargs['ExpressionAttributeValues'][':active'] == 'active'
        assert kwargs['ExpressionAttributeValues'][':gpk'] == 'MEMSTATUS#personal#active'
        table.update_item.reset_mock()
        with patch.object(store, 'append_event'):
            store.reinforce(table, row(status='archived', tombstoned=True), 'h-b', None, now=NOW)
        assert ':active' not in table.update_item.call_args.kwargs['ExpressionAttributeValues']
        assert 'ExpressionAttributeNames' not in table.update_item.call_args.kwargs

    def test_a_repeat_supporter_refreshes_without_the_source_append(self):
        table = MagicMock()
        table.update_item.side_effect = [ConditionalCheckFailedException(), {}]
        with patch.object(store, 'append_event') as event, patch.object(store, '_trim_sources') as trim:
            added = store.reinforce(table, row(status='archived'), 'h-b', {'type': 'session'}, now=NOW)
        assert added is False
        assert table.update_item.call_count == 2
        assert table.update_item.call_args_list[1] == call(
            Key={'pk': 'MEM#company', 'sk': 'MEM#mem_1'},
            UpdateExpression='SET last_reinforced_at = :now, updated_at = :now, gsi1sk = :now, '
                             '#st = :active, gsi1pk = :gpk',
            ConditionExpression='attribute_exists(pk)',
            ExpressionAttributeValues={':now': STAMP, ':active': 'active', ':gpk': 'MEMSTATUS#company#active'},
            ExpressionAttributeNames={'#st': 'status'},
        )
        trim.assert_called_once_with(table, row(status='archived'), {'type': 'session'})
        event.assert_called_once_with(table, 'mem_1', 'refreshed', actor='h-b', now=NOW)

    def test_a_non_conditional_error_propagates_without_an_event(self):
        table = MagicMock()
        table.update_item.side_effect = RuntimeError('throttled')
        with patch.object(store, 'append_event') as event, pytest.raises(RuntimeError, match='throttled'):
            store.reinforce(table, row(), 'h-b', None, now=NOW)
        assert table.update_item.call_count == 1
        event.assert_not_called()


class TestTrimSources:
    @pytest.mark.parametrize(('existing', 'source'), [
        ([{}] * 20, None), ('twenty', {'type': 'session'}), ([{}] * 19, {'type': 'session'}), (None, {'type': 's'}),
    ])
    def test_nothing_to_trim(self, existing, source):
        table = MagicMock()
        store._trim_sources(table, row(sources=existing), source)
        table.update_item.assert_not_called()

    def test_twenty_sources_drop_the_oldest(self):
        table = MagicMock()
        store._trim_sources(table, row(sources=[{}] * policy.MAX_SOURCES_KEPT), {'type': 'session'})
        assert policy.MAX_SOURCES_KEPT == 20
        table.update_item.assert_called_once_with(Key={'pk': 'MEM#company', 'sk': 'MEM#mem_1'},
                                                  UpdateExpression='REMOVE sources[0]',
                                                  ConditionExpression='attribute_exists(pk)')

    def test_a_failed_trim_only_warns(self):
        table = MagicMock()
        table.update_item.side_effect = RuntimeError('boom')
        with patch.object(store.logger, 'warning') as log:
            store._trim_sources(table, row(sources=[{}] * 25), {'type': 'session'})
        log.assert_called_once_with('Could not trim memory sources')


class TestTouchUsed:
    def test_each_item_gets_the_same_stamp_and_a_failure_does_not_stop_the_rest(self):
        table = MagicMock()
        table.update_item.side_effect = [RuntimeError('boom'), {}]
        items = [row(), row(sk='MEM#mem_2', pk='MEM#user#u')]
        with patch.object(store.logger, 'warning') as log:
            store.touch_used(table, items, now=NOW)
        log.assert_called_once_with('Could not record memory use')
        assert table.update_item.call_args_list == [
            call(Key={'pk': 'MEM#company', 'sk': 'MEM#mem_1'},
                 UpdateExpression='SET last_used_at = :now, gsi1sk = :now',
                 ConditionExpression='attribute_exists(pk)', ExpressionAttributeValues={':now': STAMP}),
            call(Key={'pk': 'MEM#user#u', 'sk': 'MEM#mem_2'},
                 UpdateExpression='SET last_used_at = :now, gsi1sk = :now',
                 ConditionExpression='attribute_exists(pk)', ExpressionAttributeValues={':now': STAMP}),
        ]


class TestLinkConflicts:
    def test_skips_unknown_and_already_linked_others_then_links_the_rest(self):
        table = MagicMock()
        other = row(sk='MEM#mem_2', memory_id='mem_2', conflicts_with=['mem_7', 3])
        linked = row(sk='MEM#mem_3', memory_id='mem_3', conflicts_with=['mem_1'])
        pool = {'mem_2': other, 'mem_3': linked}
        with patch.object(store, 'set_fields') as set_fields, patch.object(store, 'append_event') as event:
            # The skipped ids come FIRST: a skip that stopped the loop would lose the real link.
            store.link_conflicts(table, 'mem_1', ['mem_missing', 'mem_3', 'mem_2'], pool, now=NOW)
        set_fields.assert_called_once_with(table, other, {'conflicts_with': ['mem_7', 'mem_1']}, now=NOW)
        event.assert_called_once_with(table, 'mem_2', 'conflict_linked', detail={'with': 'mem_1'}, now=NOW)

    def test_a_missing_conflicts_with_starts_a_fresh_list(self):
        table = MagicMock()
        other = row(sk='MEM#mem_2', memory_id='mem_2')
        with patch.object(store, 'set_fields') as set_fields, patch.object(store, 'append_event'):
            store.link_conflicts(table, 'mem_1', ['mem_2'], {'mem_2': other}, now=NOW)
        set_fields.assert_called_once_with(table, other, {'conflicts_with': ['mem_1']}, now=NOW)


# ── Company context ──────────────────────────────────────────────────────────
class TestCompanyContext:
    def test_no_table_reads_nothing(self):
        assert store.read_company_context(None) == {}

    def test_reads_the_settings_row(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {'objectives': []}}
        assert store.read_company_context(table) == {'objectives': []}
        table.get_item.assert_called_once_with(Key={'pk': 'SETTINGS#company_context', 'sk': 'config'})
        table.get_item.return_value = {'Item': 'junk'}
        assert store.read_company_context(table) == {}
        table.get_item.return_value = {}
        assert store.read_company_context(table) == {}

    def test_a_failed_read_warns_and_disables_alignment(self):
        table = MagicMock()
        table.get_item.side_effect = RuntimeError('boom')
        with patch.object(store.logger, 'warning') as log:
            assert store.read_company_context(table) == {}
        log.assert_called_once_with('Company context read failed; alignment disabled for this call')

    def test_objective_vectors_are_cached_per_updated_at_stamp(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {'updated_at': 'v1', 'objectives': [
            {'id': 'obj1', 'title': 'Faster', 'description': 'refunds'}]}}
        embed = MagicMock(side_effect=lambda text: [len(text)])
        first = store.objective_vectors(table, embed)
        assert first == [('obj1', [len('Faster refunds')])]
        embed.assert_called_once_with('Faster refunds')
        second = store.objective_vectors(table, embed)
        assert second is first
        assert embed.call_count == 1
        table.get_item.return_value = {'Item': {'updated_at': 'v2', 'objectives': 'not a list'}}
        assert store.objective_vectors(table, embed) == []
        assert store._objective_cache == {'stamp': 'v2', 'vectors': []}
        store.clear_objective_cache()
        assert store._objective_cache == {}

    def test_a_context_without_a_stamp_still_caches_under_the_empty_stamp(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {'objectives': []}}
        assert store.objective_vectors(table, MagicMock()) == []
        assert store._objective_cache['stamp'] == ''


# ── Through moto: what the row-level writes leave in the table ───────────────
class TestWritesAgainstMoto:
    def test_reinforce_revives_an_archived_row_in_the_active_partition(self, world):
        store.write_automated(world.memory, [candidate('Customers want faster refunds', supporter='h-a')], now=NOW)
        [item] = world.memories()
        archived = store.set_fields(world.memory, item, {'status': 'archived'}, now=NOW)
        later = NOW + timedelta(hours=1)
        assert store.reinforce(world.memory, archived, 'h-b', {'type': 'session', 'ref': 's2', 'at': 'T'},
                               now=later) is True
        [after] = world.memories()
        assert after['status'] == 'active'
        assert after['gsi1pk'] == 'MEMSTATUS#company#active'
        assert after['gsi1sk'] == later.isoformat()
        assert after['last_reinforced_at'] == later.isoformat()
        assert after['supporters'] == 2
        assert after['sources'][-1] == {'type': 'session', 'ref': 's2', 'at': 'T'}
        assert len(store.query_status(world.memory, 'company', 'active')) == 1
        assert store.query_status(world.memory, 'company', 'archived') == []

    def test_a_repeat_supporter_refreshes_the_stamp_and_adds_no_source(self, world):
        store.write_automated(world.memory, [candidate('Customers want faster refunds', supporter='h-a')], now=NOW)
        [item] = world.memories()
        later = NOW + timedelta(hours=1)
        assert store.reinforce(world.memory, item, 'h-a', {'type': 'session', 'ref': 's2', 'at': 'T'},
                               now=later) is False
        [after] = world.memories()
        assert after['supporters'] == 1
        assert len(after['sources']) == 1
        assert after['last_reinforced_at'] == later.isoformat()
        events = store.query_partition(world.memory, 'MEMEVT#' + item['memory_id'])
        assert sorted(e['action'] for e in events) == ['created', 'refreshed']
        assert all('statement' not in e for e in events)

    def test_touch_used_sets_last_used_and_the_rank_key(self, world):
        store.write_automated(world.memory, [candidate('Customers want faster refunds')], now=NOW)
        [item] = world.memories()
        later = NOW + timedelta(days=2)
        store.touch_used(world.memory, [item], now=later)
        [after] = world.memories()
        assert after['last_used_at'] == later.isoformat()
        assert after['gsi1sk'] == later.isoformat()
        assert after['updated_at'] == STAMP
