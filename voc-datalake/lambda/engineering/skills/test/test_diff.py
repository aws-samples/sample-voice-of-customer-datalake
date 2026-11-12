"""Diffs of two skill versions, stable and readable, and the summary line made from them by rule."""
from __future__ import annotations

from dataclasses import replace

import pytest

from engineering.bus.schema import MAX_SUMMARY_BYTES
from engineering.connectors.identity import AGENT_ROLES
from engineering.skills.diff import ROLE_NAMES, SkillDiff, diff, from_json, render, summary, to_json
from engineering.skills.model import Example, SkillError
from engineering.skills.test.fixtures import FLAKY, HAIKU, LINT, SONNET, TOOLS, content, stricter


def test_instruction_lines_are_listed_in_order_without_blank_lines() -> None:
    base = content(instructions='One.\n\nTwo.\nThree.')
    new = content(instructions='One.\nTwo, reworded.\nThree.\n\n\nFour.')
    change = diff(base, new)
    assert change.instructions == (('-', 'Two.'), ('+', 'Two, reworded.'), ('+', 'Four.'))
    assert (change.count('instructions', '+'), change.count('instructions', '-')) == (2, 1)
    assert diff(base, new) == change   # stable
    assert not change.first
    assert not change.empty


def test_examples_tools_model_and_harness_changes() -> None:
    base = content(examples=(FLAKY,))
    new = content(examples=(LINT,), tools=(*TOOLS[1:], 'install_dependencies'), model=HAIKU, harness='cli')
    change = diff(base, new)
    assert change.examples == (('-', FLAKY), ('+', LINT))
    assert (change.tools_added, change.tools_removed, change.tools_reordered) == (('install_dependencies',),
                                                                                   ('read_file',), False)
    assert (change.model, change.harness) == ((SONNET, HAIKU), ('converse', 'cli'))
    assert diff(base, content(tools=TOOLS[::-1])).tools_reordered


def test_a_first_version_adds_everything_and_the_same_content_is_empty() -> None:
    first = diff(None, content())
    assert first.first
    assert first.model == ('', SONNET)
    assert first.harness == ('', 'converse')
    assert first.tools_added == TOOLS
    assert first.examples == (('+', FLAKY),)
    assert diff(content(), content()).empty
    assert render(diff(content(), content())) == 'No change.'


def test_render_reads_as_a_person_reads_a_diff() -> None:
    new = replace(stricter(), tool_policy=TOOLS[:-1], model=HAIKU)
    assert render(diff(content(), new)) == '\n'.join([
        'Instructions:', "+ Run the package's whole test suite before you submit.",
        'Examples:', f'+ When: {LINT.situation} | Do: {LINT.action}',
        'Tool policy: - finish',
        f'Model: {SONNET} → {HAIKU}'])
    assert render(diff(content(), content(tools=TOOLS[::-1]))) == 'Tool policy: the same tools, reordered'
    assert render(diff(None, content(harness='cli'))).endswith('Harness: (none) → cli')


def test_a_diff_round_trips_through_its_stored_form() -> None:
    change = diff(content(), replace(stricter(), model=HAIKU, tool_policy=TOOLS[::-1]))
    assert from_json(to_json(change)) == change
    assert from_json(to_json(diff(None, content()))) == diff(None, content())


@pytest.mark.parametrize('stored', [{}, {**to_json(SkillDiff()), 'instructions': [['*', 'x']]},
                                    {**to_json(SkillDiff()), 'model': ['only-one']},
                                    {**to_json(SkillDiff()), 'examples': [['+', {'situation': 'x'}]]}])
def test_an_unreadable_stored_diff_is_refused(stored: dict[str, object]) -> None:
    with pytest.raises(SkillError, match='not readable'):
        from_json(stored)


def test_the_summary_is_made_from_the_diff() -> None:
    two_more = replace(stricter(), examples=(FLAKY, LINT, Example('A test needs network.', 'Mark it and skip.')))
    assert summary('fixer', 'accepted', 'v7', 'v8', diff(content(), two_more)) == (
        'Fixer rewrote its skill: v7 → v8, two more examples, one more instruction line')
    fewer = content(instructions='Plan the smallest fix.', examples=())
    assert summary('pr-reviewer', 'proposed', 'v2', 'v3', diff(content(), fewer), scope='conn-harbor') == (
        'PR reviewer skill for conn-harbor proposed: v2 → v3, one example fewer, '
        'one instruction line added and three removed')
    moved = content(tools=(*TOOLS[:-1], 'submit_work'), model=HAIKU, harness='cli')
    assert summary('fixer', 'rolled_back', 'v9', 'v10', diff(content(), moved), restores=5) == (
        f'Fixer rolled its skill back to v5: v9 → v10, the tool policy adds submit_work and drops finish, '
        f'the model {SONNET} → {HAIKU}, the harness converse → cli')
    assert summary('coach', 'accepted', '', 'v1', diff(None, content())) == 'Coach rewrote its skill: v1, its first version'
    assert summary('fixer', 'accepted', 'v1', 'v2', diff(content(), content())).endswith('v1 → v2, the same skill')
    assert summary('fixer', 'accepted', 'v1', 'v2', diff(content(), content(tools=TOOLS[::-1]))).endswith(
        'the tool policy reordered')
    many = content(examples=tuple(Example(f'Case {n}.', 'Do it.') for n in range(12)))
    assert 'twelve' not in summary('fixer', 'accepted', 'v1', 'v2', diff(content(examples=()), many))
    assert '12 more examples' in summary('fixer', 'accepted', 'v1', 'v2', diff(content(examples=()), many))


def test_the_summary_fits_a_bus_message() -> None:
    tools = tuple(f'tool_{n:02d}_' + 'x' * 50 for n in range(32))
    line = summary('fixer', 'accepted', 'v1', 'v2', diff(content(), content(tools=tools)))
    assert len(line.encode('utf-8')) <= MAX_SUMMARY_BYTES
    assert line.endswith(', and more')
    assert line.startswith('Fixer rewrote its skill: v1 → v2')


def test_every_role_has_its_catalog_name_and_nothing_else_has_one() -> None:
    assert set(ROLE_NAMES) == set(AGENT_ROLES)
    with pytest.raises(SkillError, match='not an agent role'):
        summary('janitor', 'accepted', 'v1', 'v2', SkillDiff())
