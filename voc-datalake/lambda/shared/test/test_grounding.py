"""Tests for shared.grounding — SHARED vs PRIVATE company knowledge for prompts.

Runs against moto (memory + aggregates tables) with the embedder patched, so the
policy line is checked on real stored rows, not on mocks of the store.
"""
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from unittest.mock import patch

import pytest

from shared import grounding
from shared import memory_store as store
from shared.category_access import CategoryScope
from shared.company_context import COMPANY_CONTEXT_PK, user_context_pk
from shared.grounding import POLICY_PRIVATE, POLICY_SHARED, build_grounding, memory_block
from shared.test.memory_fixtures import candidate, memory_world

NOW = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)


@pytest.fixture
def world(monkeypatch):
    with memory_world(monkeypatch) as w:
        w.aggregates.put_item(Item={'pk': COMPANY_CONTEXT_PK, 'sk': 'config',
                                    'vision': 'Refunds in one day.', 'objectives': []})
        w.aggregates.put_item(Item={'pk': user_context_pk('sub-user'), 'sk': 'config',
                                    'objectives': [{'id': 'obj_000000000001', 'title': 'Cut refund tickets',
                                                    'kpis': []}]})
        store.write_automated(w.memory, [candidate('Customers want faster refunds')], now=NOW - timedelta(days=3))
        store.write_automated(w.memory, [candidate('I like refunds summaries short', scope='personal',
                                                   kind='working_style', owner_sub='sub-user')], now=NOW)
        store.clear_pool_cache()
        yield w


def _ground(world, policy, **kwargs):
    return build_grounding(query='how fast are refunds', policy=policy, aggregates_table=world.aggregates,
                           memory_table=world.memory, caller_sub='sub-user', **kwargs)


class TestSharedPolicy:
    def test_company_knowledge_only(self, world):
        result = _ground(world, POLICY_SHARED)
        assert 'Refunds in one day.' in result.text
        assert 'Customers want faster refunds' in result.text
        assert 'I like refunds summaries short' not in result.text
        assert 'Cut refund tickets' not in result.text

    def test_records_company_memory_ids_and_context(self, world):
        result = _ground(world, POLICY_SHARED)
        company = world.memories()[0]['memory_id']
        assert (result.memory_ids, result.company_context_included) == ([company], True)

    def test_kinds_filter_drops_other_kinds(self, world):
        result = _ground(world, POLICY_SHARED, kinds=('customer',))
        assert (result.memory_ids, '<memory>' in result.text) == ([], False)


class TestPrivatePolicy:
    def test_adds_personal_memories_and_own_objectives(self, world):
        result = _ground(world, POLICY_PRIVATE)
        assert '(personal, 1 supporter(s), working_style) I like refunds summaries short' in result.text
        assert 'Cut refund tickets' in result.text

    def test_never_reports_personal_ids(self, world):
        result = _ground(world, POLICY_PRIVATE)
        personal = {r['memory_id'] for r in world.memories(store.scope_pk('personal', 'sub-user'))}
        assert personal
        assert not personal & set(result.memory_ids)


class TestDegrades:
    def test_nothing_configured_is_empty(self):
        assert build_grounding(query='q', policy=POLICY_SHARED) == grounding.Grounding()

    def test_failed_recall_keeps_the_context(self, world):
        with patch.object(grounding.memory_store, 'retrieve', side_effect=RuntimeError('boom')):
            result = _ground(world, POLICY_SHARED)
        assert (result.memory_ids, result.company_context_included) == ([], True)

    def test_blank_query_skips_recall(self, world):
        with patch.object(grounding.memory_store, 'retrieve') as retrieve:
            build_grounding(query='  ', policy=POLICY_SHARED, memory_table=world.memory)
        retrieve.assert_not_called()

    def test_unknown_policy_raises(self):
        with pytest.raises(ValueError, match="Unknown grounding policy: 'public'"):
            build_grounding(query='q', policy='public')

    def test_scope_is_passed_to_retrieve(self, world):
        scope = CategoryScope(all=False, categories=frozenset({'billing'}))
        with patch.object(grounding.memory_store, 'retrieve', return_value=[]) as retrieve:
            _ground(world, POLICY_SHARED, scope=scope)
        assert retrieve.call_args.kwargs['scope'] is scope


class TestMemoryBlock:
    def test_line_format_and_decimal_supporters(self):
        block = memory_block([{'statement': ' Fast refunds ', 'scope': 'company', 'kind': 'product',
                               'supporters': Decimal(3)}, {'statement': ''}, 'junk'])
        assert block.endswith('\n- (company, 3 supporter(s), product) Fast refunds\n</memory>')

    def test_empty_is_empty(self):
        assert memory_block([]) == ''
