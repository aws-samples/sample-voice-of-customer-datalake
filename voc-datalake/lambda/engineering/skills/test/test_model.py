"""The voc-skill/1 record: what a skill may hold, bounded, and the fields only a person changes."""
from __future__ import annotations

import json
from dataclasses import replace
from typing import Any

import pytest

from engineering.connectors.identity import AGENT_ROLES
from engineering.skills.model import (
    MAX_BENCHMARK_BYTES,
    MAX_EXAMPLES,
    MAX_INSTRUCTIONS,
    MAX_RECORD_BYTES,
    PERSON_ONLY_FIELDS,
    RECORD_SCHEMA,
    Benchmark,
    BenchmarkRun,
    Example,
    Reason,
    Skill,
    SkillError,
)
from engineering.skills.test.fixtures import FLAKY, HAIKU, RUN, SONNET, TOOLS, content


def record(**overrides: Any) -> dict[str, Any]:
    return {**Skill('fixer', 3, content()).to_record(), **overrides}


def test_a_record_round_trips_in_the_shape_the_harness_reads() -> None:
    skill = Skill('fixer', 3, content())
    stored = skill.to_record()
    # The runtime harness's Skill.from_record reads exactly these keys, with these types.
    assert stored == {'schema': RECORD_SCHEMA, 'name': 'fixer', 'version': 3, 'instructions': content().instructions,
                      'examples': [{'situation': FLAKY.situation, 'action': FLAKY.action}],
                      'tool_policy': list(TOOLS), 'model': SONNET, 'harness': 'converse'}
    assert Skill.from_record(stored) == skill
    assert skill.label == 'fixer@3'


@pytest.mark.parametrize(('change', 'message'), [
    ({'instructions': ''}, 'the instructions'),
    ({'instructions': '   \n'}, 'the instructions'),
    ({'instructions': 'x' * (MAX_INSTRUCTIONS + 1)}, 'the instructions'),
    ({'instructions': 'nul\x00byte'}, 'the instructions'),
    ({'instructions': 'line\n' * 501}, 'at most 500 lines'),
    ({'examples': (FLAKY,) * (MAX_EXAMPLES + 1)}, 'at most'),
    ({'tool_policy': ()}, 'tool policy'),
    ({'tool_policy': ('run', 'run')}, 'each once'),
    ({'tool_policy': ('Run Shell',)}, 'tool name'),
    ({'model': 'anthropic.claude-unlisted'}, 'allowed models'),
    ({'harness': 'shell'}, 'harness'),
])
def test_content_is_refused_outside_its_bounds(change: dict[str, Any], message: str) -> None:
    with pytest.raises(SkillError, match=message):
        replace(content(), **change)


@pytest.mark.parametrize(('situation', 'action'), [('', 'do it'), ('a case', 'y' * 2001)])
def test_an_example_is_bounded_text(situation: str, action: str) -> None:
    with pytest.raises(SkillError, match='example'):
        Example(situation, action)


@pytest.mark.parametrize(('name', 'version'), [('janitor', 1), ('fixer', 0), ('fixer', -2)])
def test_a_skill_is_for_an_agent_role_and_numbered_from_one(name: str, version: int) -> None:
    with pytest.raises(SkillError, match=r'agent role|version number'):
        Skill(name, version, content())


def test_every_catalog_role_can_have_a_skill() -> None:
    assert {Skill(role, 1, content()).name for role in AGENT_ROLES} == set(AGENT_ROLES)


def test_the_whole_record_is_bounded() -> None:
    big = Example('s' * 2000, 'é' * 2000)   # two bytes a character in UTF-8
    with pytest.raises(SkillError, match=f'at most {MAX_RECORD_BYTES} bytes'):
        Skill('fixer', 1, content(instructions='é' * MAX_INSTRUCTIONS, examples=(big,) * MAX_EXAMPLES))


@pytest.mark.parametrize('field', ['budget', 'dial', 'safety', 'stop_at_pull_request', 'caps', 'permissions'])
def test_what_is_never_in_a_skill_is_refused_in_a_record(field: str) -> None:
    with pytest.raises(SkillError, match='never in a skill'):
        Skill.from_record(record(**{field: 'anything'}))


@pytest.mark.parametrize(('bad', 'message'), [
    ({'schema': 'voc-skill/0'}, 'not a voc-skill/1'),
    ({'extra': 1}, r"unknown: \['extra'\]"),
    ({'examples': {}}, 'are lists'),
    ({'tool_policy': 'run'}, 'are lists'),
    ({'examples': [{'situation': 'a'}]}, 'situation, action'),
    ({'model': 7}, 'text as written'),
    ({'tool_policy': [1]}, 'text as written'),
    ({'version': '3'}, 'version number'),
    ({'version': True}, 'version number'),
    ({'version': 0}, 'version number'),
])
def test_a_malformed_record_is_refused(bad: dict[str, Any], message: str) -> None:
    with pytest.raises(SkillError, match=message):
        Skill.from_record(record(**bad))


def test_a_record_missing_a_field_is_refused() -> None:
    stored = record()
    del stored['harness']
    with pytest.raises(SkillError, match=r"missing: \['harness'\]"):
        Skill.from_record(stored)


def test_the_person_only_fields_are_the_tool_policy_the_model_and_the_harness() -> None:
    base = content()
    assert PERSON_ONLY_FIELDS == ('tool_policy', 'model', 'harness')
    assert base.person_fields_changed(None) == PERSON_ONLY_FIELDS
    assert replace(base, instructions='Other words.', examples=()).person_fields_changed(base) == ()
    assert replace(base, model=HAIKU).person_fields_changed(base) == ('model',)
    assert replace(base, tool_policy=TOOLS[::-1], harness='cli').person_fields_changed(base) == ('tool_policy',
                                                                                                   'harness')


def test_a_reason_says_why_and_is_checked() -> None:
    assert Reason(RUN, 'no_go').from_a_run
    assert not Reason(comment='Clearer wording.').from_a_run
    with pytest.raises(SkillError, match='says why'):
        Reason()
    with pytest.raises(SkillError, match='ULID'):
        Reason('run-1', 'no_go')
    with pytest.raises(SkillError, match='failure is one of'):
        Reason(RUN, 'bored')
    with pytest.raises(SkillError, match='a comment'):
        Reason(comment='c' * 2001)


def test_a_benchmark_is_two_optional_pass_rates() -> None:
    assert Benchmark(0.5, 1) == Benchmark(0.5, 1.0)
    assert Benchmark().before is None
    for bad in (1.5, -0.1, float('nan'), True):
        with pytest.raises(SkillError, match='pass rate'):
            Benchmark(after=bad)


RUN_FIELDS: dict[str, Any] = {'before': 0.5, 'after': 1, 'cases': ('slug-cut-bug', 'pagination-review'),
                              'passed': True, 'reasons': ('no regression',), 'failure_case': 'slug-cut-bug'}


def test_a_recorded_benchmark_round_trips() -> None:
    run = BenchmarkRun(**RUN_FIELDS)
    assert run.after == 1.0
    assert BenchmarkRun.from_json(run.to_json()) == run
    assert run.gained
    assert not BenchmarkRun(**{**RUN_FIELDS, 'failure_case': ''}).gained   # passed, but no gain was checked
    assert not BenchmarkRun(**{**RUN_FIELDS, 'passed': False}).gained


@pytest.mark.parametrize(('fields', 'message'), [
    ({'before': None}, 'has both pass rates'),
    ({'after': 2}, 'a pass rate from 0 to 1'),
    ({'cases': ()}, 'names 1-100 cases, each once'),
    ({'cases': ('a', 'a')}, 'each once'),
    ({'cases': tuple(f'c{n}' for n in range(101))}, 'names 1-100 cases'),
    ({'cases': ('Not An Id',)}, 'a case id is lower case'),
    ({'failure_case': 'monorepo-units-bug'}, "the failure's case is one of the benchmark's cases"),
    ({'reasons': ()}, 'says why in 1-102 reasons'),
    ({'reasons': ('',)}, "a benchmark's reason is text of 1-400"),
    ({'reasons': ('r' * 401,)}, "a benchmark's reason is text of 1-400"),
    ({'cases': tuple(f'{n:02d}' + 'c' * 61 for n in range(100)), 'reasons': ('r' * 400,) * 102, 'failure_case': ''},
     f'at most {MAX_BENCHMARK_BYTES} bytes'),
])
def test_a_recorded_benchmark_is_bounded(fields: dict[str, Any], message: str) -> None:
    with pytest.raises(SkillError, match=message):
        BenchmarkRun(**{**RUN_FIELDS, **fields})


def test_a_recorded_benchmark_is_measured_as_it_is_stored() -> None:
    """Non-ASCII text counts its UTF-8 bytes, as the row holds it (never six bytes an escape would take)."""
    run = BenchmarkRun(**{**RUN_FIELDS, 'reasons': ('é' * 400,) * 45})
    stored = run.stored_json()
    assert 'é' in stored
    assert 36_000 < len(stored.encode('utf-8')) <= MAX_BENCHMARK_BYTES < len(json.dumps(run.to_json()))
    assert BenchmarkRun.from_json(json.loads(stored)) == run


@pytest.mark.parametrize('change', [{'extra': 1}, {'cases': 'slug-cut-bug'}, {'reasons': [1]}, {'passed': 'yes'},
                                    {'failure_case': None}])
def test_a_stored_benchmark_is_read_strictly(change: dict[str, Any]) -> None:
    with pytest.raises(SkillError, match='a recorded benchmark'):
        BenchmarkRun.from_json({**BenchmarkRun(**RUN_FIELDS).to_json(), **change})
