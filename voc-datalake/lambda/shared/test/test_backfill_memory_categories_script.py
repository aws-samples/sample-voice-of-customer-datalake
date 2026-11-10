"""``scripts/memory/backfill_categories.py``: tag untagged memories, never overwrite a tag.

Against moto (``memory_world``): a dry run writes nothing, ``--apply`` writes ONLY ``categories``,
the condition protects a tag written meanwhile, a model failure falls back to the name match and
unknown ids are dropped (the real ``classify_statement``, its model patched). Lives under
``lambda/`` so the default ``testpaths`` runs it; the script is loaded by path.
"""
import json
import sys
from decimal import Decimal

import pytest

from shared import memory_store as store
from shared.category_gate import CATEGORIES_PK, CATEGORIES_SK
from shared.test.memory_fixtures import memory_world
from shared.test.repo_paths import load_module_from_path, repo_root

_SCRIPT = repo_root() / 'scripts' / 'memory' / 'backfill_categories.py'
CATEGORIES = [{'name': 'technical_support', 'description': 'Technical Support'},
              {'name': 'hardware_quality', 'description': 'Hardware Quality'},
              {'name': 'pricing', 'description': 'Pricing'}]
ABOUT_HARDWARE = 'Broken components are the most frequently reported problem in every region this year'


@pytest.fixture(scope='module')
def backfill():
    module = load_module_from_path('backfill_categories', _SCRIPT)
    try:
        yield module
    finally:
        sys.modules.pop(module.__name__, None)


@pytest.fixture
def world(monkeypatch):
    with memory_world(monkeypatch) as w:
        w.aggregates.put_item(Item={'pk': CATEGORIES_PK, 'sk': CATEGORIES_SK, 'categories': CATEGORIES})
        yield w


def _memory(world, memory_id, statement, *, pk=store.COMPANY_PK, **fields):
    item = {**store.memory_key(pk, memory_id), 'memory_id': memory_id, 'statement': statement,
            'scope': 'personal' if pk != store.COMPANY_PK else 'company', 'status': 'active',
            'supporters': Decimal(1), 'updated_at': '2026-01-01T00:00:00+00:00', **fields}
    world.memory.put_item(Item=item)
    return item


def _seed(world):
    _memory(world, 'mem_hw', ABOUT_HARDWARE, categories=[])
    _memory(world, 'mem_mine', 'I review pricing complaints on Mondays', pk='MEM#user#sub-1', status='proposed')
    _memory(world, 'mem_tagged', 'Support replies are slow', categories=['technical_support'])
    _memory(world, 'mem_general', 'The company values short weekly updates', status='archived')
    world.memory.put_item(Item={'pk': 'MEMEVT#mem_hw', 'sk': '2026#1', 'action': 'created'})


def _rows(world):
    return {r['memory_id']: r for r in world.memory.scan()['Items'] if str(r['sk']).startswith('MEM#')}


def _scripted(world, answers):
    """The classifier model answers per statement (by its first word)."""
    world.classifier.side_effect = lambda **kw: json.dumps(
        {'categories': answers.get(kw['prompt'].split('<statement>\n')[1].split()[0], [])})


def _run(backfill, world, *, apply):
    lines = []
    report = backfill.run(world.memory, backfill.read_categories(world.aggregates), apply=apply, out=lines.append)
    return report, lines


def test_a_dry_run_classifies_every_untagged_memory_and_writes_nothing(backfill, world):
    _seed(world)
    _scripted(world, {'Broken': ['hardware_quality', 'shipping']})
    before = _rows(world)
    report, lines = _run(backfill, world, apply=False)
    assert (report.scanned, report.tagged, report.untagged, report.model_failures) == (3, 2, 1, 0)
    assert _rows(world) == before
    assert f"mem_hw  company/active  '{ABOUT_HARDWARE[:80]}'  -> ['hardware_quality']" in lines


def test_apply_writes_only_the_categories_attribute(backfill, world):
    _seed(world)
    _scripted(world, {'Broken': ['hardware_quality', 'made_up']})
    before = _rows(world)
    report, _ = _run(backfill, world, apply=True)
    after = _rows(world)
    assert (report.tagged, report.untagged, report.raced) == (2, 1, 0)
    assert {k: after[k].get('categories') for k in after} == {
        'mem_hw': ['hardware_quality'], 'mem_mine': ['pricing'], 'mem_tagged': ['technical_support'],
        'mem_general': None}
    assert {k: {f: v for f, v in after[k].items() if f != 'categories'} for k in after} == {
        k: {f: v for f, v in before[k].items() if f != 'categories'} for k in before}


def test_a_rerun_is_idempotent(backfill, world):
    _seed(world)
    _scripted(world, {'Broken': ['hardware_quality']})
    _run(backfill, world, apply=True)
    report, _ = _run(backfill, world, apply=True)
    assert (report.scanned, report.tagged, report.untagged) == (1, 0, 1)


def test_the_condition_never_overwrites_a_tag_written_meanwhile(backfill, world):
    row = _memory(world, 'mem_hw', ABOUT_HARDWARE)
    world.memory.update_item(Key=store.item_key(row), UpdateExpression='SET categories = :c',
                             ExpressionAttributeValues={':c': ['pricing']})
    assert backfill.write_tags(world.memory, row, ['hardware_quality']) is False
    assert _rows(world)['mem_hw']['categories'] == ['pricing']


def test_the_condition_never_recreates_a_vanished_memory(backfill, world):
    row = {**store.memory_key(store.COMPANY_PK, 'mem_gone'), 'memory_id': 'mem_gone'}
    assert (backfill.write_tags(world.memory, row, ['pricing']), _rows(world)) == (False, {})


def test_a_model_failure_falls_back_to_the_name_match(backfill, world):
    _memory(world, 'mem_named', 'Pricing complaints signal churn')
    _memory(world, 'mem_hw', ABOUT_HARDWARE)
    world.classifier.side_effect = RuntimeError('throttled')
    report, _ = _run(backfill, world, apply=True)
    assert (report.model_failures, report.tagged, report.untagged) == (2, 1, 1)
    assert {k: r.get('categories') for k, r in _rows(world).items()} == {'mem_named': ['pricing'], 'mem_hw': None}


def test_without_a_categories_config_it_stops(backfill, world):
    world.aggregates.delete_item(Key={'pk': CATEGORIES_PK, 'sk': CATEGORIES_SK})
    with pytest.raises(SystemExit, match='No categories are configured'):
        backfill.read_categories(world.aggregates)


def test_dry_run_is_the_default_and_apply_is_explicit(backfill):
    assert (backfill.parse_args([]).apply, backfill.parse_args(['--apply']).apply,
            backfill.parse_args(['--dry-run']).apply) == (False, True, False)
