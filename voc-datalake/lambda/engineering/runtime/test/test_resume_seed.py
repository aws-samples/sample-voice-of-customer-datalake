"""``voc-resume-seed/1`` (7.51.00): the record a child run's agent starts from, checked, bounded and kept in its run."""
from __future__ import annotations

import json

import pytest

from engineering.runtime.harness import seed

CHILD = '01JCHILD0000000000000000AA'
SHA = 'a' * 40


def record(**changes):
    base = {'schema': seed.SCHEMA,
            'parent': {'run_id': '01JPARENT00000000000000000', 'agent_id': 'fixer-2', 'task_id': 'T1', 'attempt': 2,
                       'commit': SHA},
            'task': {'role': 'fixer', 'title': 'Fix divide', 'instructions': 'Floor it.', 'flow_step': 'fix',
                     'shard': ''},
            'checkpoint': {'position': {'turn': 4}, 'plan': ['test', 'fix'], 'notes': 'The bug is in divide.'},
            'patch_key': seed.patch_key(CHILD, 'T1'), 'base': 'same',
            'history': {'kind': 'excerpts', 'lines': ['call read_file: {"path": "calc.py"}']},
            'steering': [{'at': '2026-11-17T10:00:00Z', 'by': 'human:user-1', 'text': 'Keep it small.'}],
            'memory_ids': ['MEM1']}
    base.update(changes)
    return base


def test_a_seed_is_kept_under_its_own_runs_seed_prefix():
    assert seed.seed_key(CHILD, 'T1') == f'ws/default/runs/{CHILD}/_seed/T1/seed.json'
    assert seed.patch_key(CHILD, 'T1') == f'ws/default/runs/{CHILD}/_seed/T1/patch.diff'
    assert seed.check_seed_key(seed.seed_key(CHILD, 'T1'), CHILD)


@pytest.mark.parametrize('key', [
    'ws/default/runs/01JOTHER00000000000000000A/_seed/T1/seed.json',   # another run's
    f'ws/default/runs/{CHILD}/fixer-2/_seed/T1/seed.json',             # an agent's own keys
    f'ws/default/runs/{CHILD}/_seed/../T1/seed.json',
    f'ws/default/runs/{CHILD}/_seed/T1/patch.diff',
    f'ws/default/runs/{CHILD}/_seed/T1/seed.json/x',
    7,
])
def test_a_seed_key_outside_the_agents_own_run_is_refused(key):
    with pytest.raises(seed.SeedError):
        seed.check_seed_key(key, CHILD)


def test_a_valid_seed_round_trips_bounded():
    body = seed.encode(record(), CHILD)
    parsed = seed.parse(body, CHILD)
    assert parsed is not None
    assert parsed['parent']['attempt'] == 2
    assert parsed['steering'][0]['text'] == 'Keep it small.'
    long = record(history={'kind': 'summary', 'text': 'x' * 50_000, 'model': 'm', 'tokens': 10})
    parsed_long = seed.parse(seed.encode(long, CHILD), CHILD)
    assert parsed_long is not None
    assert len(parsed_long['history']['text']) == seed.MAX_SUMMARY


@pytest.mark.parametrize('changes', [
    {'schema': 'voc-resume-seed/0'},
    {'patch_key': 'ws/default/runs/01JOTHER00000000000000000A/_seed/T1/patch.diff'},
    {'checkpoint': {'position': {'session_token': 'x'}, 'plan': [], 'notes': ''}},
    {'history': {'kind': 'everything'}},
    {'parent': {'run_id': 'p', 'agent_id': 'a', 'task_id': 't', 'attempt': 1, 'commit': 'nope'}},
    {'steering': [{'at': 1, 'by': 'x', 'text': 'y'}]},
    {'base': 'tip'},
])
def test_a_seed_off_its_shape_is_refused(changes):
    assert seed.parse(json.dumps(record(**changes)).encode(), CHILD) is None


def test_a_seed_over_its_bound_is_refused():
    assert seed.parse(b' ' * (seed.MAX_SEED_BYTES + 1), CHILD) is None
