"""A restricted reader never receives a memory that NAMES a category outside their scope.

Owner rule 2026-10-21 (wave 9, k2): provenance (a memory's ``categories`` tags) first; a
statement that names a hidden category by id or display label is withheld as the fallback.
Every read the assistant, MCP (``/mcp/global`` delegates to these routes as the minter) and
plan runs (as the approver) use is covered: list, retrieve, conflict-check and the review queue.
"""
import json

import pytest
from moto_helpers import invoke, rest_event

import memory_handler
from shared import memory_store as store
from shared.category_access import access_key
from shared.category_gate import CATEGORIES_PK, CATEGORIES_SK
from shared.test.memory_fixtures import (
    ADMIN_CLAIMS,
    MCP_CLAIMS,
    OTHER_CLAIMS,
    REVIEWER_CLAIMS,
    USER_CLAIMS,
    memory_world,
    relations_reply,
)

CATEGORIES = [
    {'name': 'technical_support', 'description': 'Technical Support'},
    {'name': 'hardware_quality', 'description': 'Hardware Quality'},
    {'name': 'software_firmware', 'description': 'Software & Firmware'},
]
NAMES_HIDDEN = 'Hardware Quality complaints outnumber support replies'
NAMES_HIDDEN_ID = 'software_firmware is the second biggest support problem'
NAMES_VISIBLE = 'Technical Support replies take nine days'


@pytest.fixture
def world(monkeypatch):
    with memory_world(monkeypatch) as w:
        w.flag_reviewer(REVIEWER_CLAIMS['sub'])
        w.aggregates.put_item(Item={'pk': CATEGORIES_PK, 'sk': CATEGORIES_SK, 'categories': CATEGORIES})
        yield w


@pytest.fixture
def call(world, lambda_context):
    tables = {'memory': world.memory, 'aggregates': world.aggregates}

    def _call(method, path, *, claims=USER_CLAIMS, body=None, params=None):
        event = {**rest_event(method, path, claims=claims, body=body), 'queryStringParameters': params}
        return invoke(memory_handler, event, lambda_context, **tables)
    return _call


def _add(call, statement, *, scope='company', claims=ADMIN_CLAIMS, kind='product'):
    """Add a memory through the API (the pool cache is cleared so the next read sees it)."""
    answer = call('POST', '/memory', claims=claims, body={'scope': scope, 'statement': statement, 'kind': kind})
    store.clear_pool_cache()
    assert answer[0] == 200, answer[1]


def _restrict(world, sub, categories=('technical_support',)):
    world.aggregates.put_item(Item={**access_key(sub), 'categories': list(categories)})


def _statements(body, key='items'):
    return sorted(entry['statement'] if 'statement' in entry else entry['memory']['statement'] for entry in body[key])


@pytest.fixture
def seeded(call, world):
    for statement in (NAMES_HIDDEN, NAMES_HIDDEN_ID, NAMES_VISIBLE):
        _add(call, statement)
    _restrict(world, USER_CLAIMS['sub'])
    return call


def test_company_list_drops_statements_naming_a_hidden_category(seeded):
    _, body = seeded('GET', '/memory', params={'scope': 'company'})
    assert _statements(body) == [NAMES_VISIBLE]


def test_retrieve_drops_them_for_the_caller_and_for_an_mcp_minter(seeded):
    for claims in (USER_CLAIMS, MCP_CLAIMS):
        _, body = seeded('POST', '/memory/retrieve', claims=claims, body={'query': 'support replies problem days'})
        assert _statements(body) == [NAMES_VISIBLE]


def test_admins_and_unrestricted_readers_are_unaffected(seeded):
    for claims in (ADMIN_CLAIMS, OTHER_CLAIMS):
        _, body = seeded('GET', '/memory', claims=claims, params={'scope': 'company'})
        assert _statements(body) == sorted([NAMES_HIDDEN, NAMES_HIDDEN_ID, NAMES_VISIBLE])


def test_the_callers_own_personal_memories_follow_the_same_rule(call, world):
    _add(call, 'I own Hardware Quality escalations', scope='personal', claims=USER_CLAIMS, kind='working_style')
    _add(call, 'I like short Technical Support summaries', scope='personal', claims=USER_CLAIMS, kind='working_style')
    _restrict(world, USER_CLAIMS['sub'])
    _, body = call('GET', '/memory', params={'scope': 'personal'})
    assert _statements(body) == ['I like short Technical Support summaries']


def test_conflict_check_never_returns_a_hidden_statement(seeded, world):
    world.converse.return_value = relations_reply(['contradicts', 'contradicts', 'contradicts'])
    _, body = seeded('GET', '/memory/conflict-check',
                     params={'statement': 'Hardware Quality complaints outnumber support replies a lot'})
    assert all('Hardware' not in c['statement'] for c in body['conflicts'])


def test_a_restricted_memory_reviewer_sees_only_in_scope_proposals(call, world):
    for statement in (NAMES_HIDDEN, NAMES_VISIBLE):
        _add(call, statement, claims=USER_CLAIMS)  # a non-curator's company add is proposed
    _restrict(world, REVIEWER_CLAIMS['sub'])
    _, body = call('GET', '/memory/review', claims=REVIEWER_CLAIMS)
    assert _statements(body) == [NAMES_VISIBLE]


# ── Category tags set on write (wave 10, m1): a memory ABOUT a hidden category, in other words ──
ABOUT_HARDWARE = 'Broken components are the most frequently reported problem'


def _classify_as(world, *ids):
    world.classifier.return_value = json.dumps({'categories': list(ids)})


def _company_tags(world):
    return {row['statement']: row.get('categories') for row in world.memories()}


def test_a_hand_added_memory_is_tagged_by_the_classifier_and_hidden_out_of_scope(call, world):
    _classify_as(world, 'hardware_quality', 'not_configured')
    _add(call, ABOUT_HARDWARE)
    _classify_as(world)
    _add(call, NAMES_VISIBLE)
    _restrict(world, USER_CLAIMS['sub'])
    assert _company_tags(world) == {ABOUT_HARDWARE: ['hardware_quality'], NAMES_VISIBLE: ['technical_support']}
    _, restricted = call('GET', '/memory', params={'scope': 'company'})
    _, recalled = call('POST', '/memory/retrieve', body={'query': 'Technical Support replies take nine days, the most frequently reported problem'})
    _, admin = call('GET', '/memory', claims=ADMIN_CLAIMS, params={'scope': 'company'})
    assert (_statements(restricted), _statements(recalled), _statements(admin)) == (
        [NAMES_VISIBLE], [NAMES_VISIBLE], sorted([ABOUT_HARDWARE, NAMES_VISIBLE]))


def test_a_model_failure_never_blocks_the_write_and_keeps_the_name_match(call, world):
    world.classifier.side_effect = RuntimeError('throttled')
    _add(call, NAMES_HIDDEN)
    assert _company_tags(world) == {NAMES_HIDDEN: ['hardware_quality']}


def test_an_edited_statement_gains_its_new_tags_and_keeps_the_old(call, world):
    _classify_as(world, 'technical_support')
    _add(call, NAMES_VISIBLE)
    [row] = world.memories()
    _classify_as(world, 'hardware_quality')
    status, _ = call('PUT', f"/memory/{row['memory_id']}", claims=ADMIN_CLAIMS, body={'statement': ABOUT_HARDWARE})
    assert (status, _company_tags(world)) == (200, {ABOUT_HARDWARE: ['technical_support', 'hardware_quality']})


def test_a_merge_tags_the_merged_statement(call, world):
    for statement in ('Support replies take nine days', 'Support answers arrive after a week'):
        _add(call, statement)
    ids = [row['memory_id'] for row in world.memories()]
    _classify_as(world, 'hardware_quality')
    status, body = call('POST', '/memory/merge', claims=ADMIN_CLAIMS,
                        body={'ids': ids, 'statement': ABOUT_HARDWARE})
    assert (status, body['memory']['categories']) == (200, ['hardware_quality'])
