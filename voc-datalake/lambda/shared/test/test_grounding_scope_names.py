"""Grounding (research, documents, personas, the morning brief) obeys the category-name rule.

A job started by a restricted user, and a restricted reader's personal brief, never gets a
company memory, a vision paragraph or a company objective that names a category outside
the starter's scope. Unrestricted grounding (``scope=None`` or every category) is unchanged.
"""
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest

from shared import memory_store as store
from shared.category_access import UNRESTRICTED, CategoryScope
from shared.category_gate import CATEGORIES_PK, CATEGORIES_SK
from shared.company_context import COMPANY_CONTEXT_PK
from shared.exceptions import ServiceError
from shared.grounding import POLICY_PRIVATE, POLICY_SHARED, build_grounding
from shared.test.memory_fixtures import candidate, memory_world

NOW = datetime(2026, 10, 21, 12, 0, tzinfo=UTC)
TS_ONLY = CategoryScope(all=False, categories=frozenset({'technical_support'}))
HIDDEN_MEMORY = 'Hardware Quality returns are the top support problem'
VISIBLE_MEMORY = 'Technical Support replies are the top support problem'


@pytest.fixture
def world(monkeypatch):
    with memory_world(monkeypatch) as w:
        w.aggregates.put_item(Item={'pk': CATEGORIES_PK, 'sk': CATEGORIES_SK, 'categories': [
            {'name': 'technical_support', 'description': 'Technical Support'},
            {'name': 'hardware_quality', 'description': 'Hardware Quality'},
        ]})
        w.aggregates.put_item(Item={
            'pk': COMPANY_CONTEXT_PK, 'sk': 'config',
            'vision': 'Customers trust us.\n\nHalve hardware_quality returns.',
            'objectives': [{'id': 'obj_000000000001', 'title': 'Reply within a day'},
                           {'id': 'obj_000000000002', 'title': 'Fewer Hardware Quality returns'}],
        })
        store.write_automated(w.memory, [candidate(HIDDEN_MEMORY), candidate(VISIBLE_MEMORY)],
                              now=NOW - timedelta(days=1))
        store.clear_pool_cache()
        yield w


def _ground(world, scope, policy=POLICY_SHARED):
    return build_grounding(query='top support problem', policy=policy, aggregates_table=world.aggregates,
                           memory_table=world.memory, caller_sub='sub-user', scope=scope)


@pytest.mark.parametrize('policy', [POLICY_SHARED, POLICY_PRIVATE])
def test_a_restricted_starter_never_gets_a_hidden_category_name(world, policy):
    text = _ground(world, TS_ONLY, policy).text
    assert [part in text for part in (VISIBLE_MEMORY, 'Reply within a day', 'Customers trust us.')] == [True] * 3
    assert 'hardware' not in text.lower()


@pytest.mark.parametrize('scope', [None, UNRESTRICTED])
def test_unrestricted_grounding_is_unchanged(world, scope):
    text = _ground(world, scope).text
    kept = (HIDDEN_MEMORY, 'Fewer Hardware Quality returns', 'hardware_quality returns')
    assert [part in text for part in kept] == [True] * 3


def test_an_unreadable_category_config_fails_closed(world):
    with patch('shared.scope_names.read_categories_config', side_effect=ServiceError('down')):
        grounding = _ground(world, TS_ONLY)
    assert (grounding.text, grounding.memory_ids) == ('', [])
