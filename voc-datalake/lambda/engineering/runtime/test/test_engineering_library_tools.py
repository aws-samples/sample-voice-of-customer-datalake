"""The skills library in a session (7.56.00, runtime/harness/library_tools.py): the role's library skills listed in
its system prompt, and ``read_skill``, which answers one of the role's own skills (its SKILL.md or one reference file)
as data, size-capped, through the harness's tool registry, so every adapter gets it."""
from __future__ import annotations

from dataclasses import replace
from typing import Any

from engineering.connectors.identity import AGENT_ROLES
from engineering.runtime.harness import library_tools, role_tools
from engineering.runtime.harness.converse_loop import system_prompt
from engineering.runtime.harness.library_tools import (
    LISTING_HEAD,
    MAX_CHARS,
    READ_SKILL,
    bundle_document,
    capped,
    listing,
    own,
)
from engineering.runtime.harness.skills import SKILLS, platform_rules
from engineering.runtime.harness.tools import ToolBox, ToolResult, role_specs
from engineering.runtime.test.harness_fakes import opened, world


def test_read_skill_is_in_the_tool_registry_for_every_launchable_role() -> None:
    assert role_tools.ROLE_TOOLS[READ_SKILL] == AGENT_ROLES - {'coach'}
    assert all(READ_SKILL in {spec.name for spec in role_specs(role)} for role in AGENT_ROLES - {'coach'})


def test_a_role_gets_read_skill_exactly_when_its_card_names_skills(tmp_path: Any) -> None:
    for role in ('fixer', 'builder', 'hunter', 'commit-reviewer', 'gate-runner', 'mapper', 'pr-author'):
        names = {spec.name for spec in world(tmp_path / role, role=role).session.tools.specs}
        assert READ_SKILL in names, role
        assert own(role), role
    for role in ('coordinator', 'committer'):
        assert READ_SKILL not in {spec.name for spec in world(tmp_path / role, role=role).session.tools.specs}
        assert own(role) == [], role


def test_the_fixer_reads_its_own_skill_as_data_with_its_references_named(tmp_path: Any) -> None:
    w = world(tmp_path)
    read = w.session.tools.call(READ_SKILL, {'name': 'tdd'})
    assert not read.error
    assert read.text.startswith(opened('skill:tdd', w.session.context.fence))
    assert 'name: tdd' in read.text
    skill = next(item for item in own('fixer') if item['name'] == 'tdd')
    for reference in skill['references']:
        assert reference['path'] in read.text.rsplit('>>>', 1)[-1]


def test_a_reference_file_is_read_by_its_path(tmp_path: Any) -> None:
    w = world(tmp_path)
    skill = next(item for item in own('fixer') if item['references'])
    path = skill['references'][0]['path']
    read = w.session.tools.call(READ_SKILL, {'name': skill['name'], 'reference': path})
    assert read.text.startswith(opened(f'skill:{skill["name"]}/{path}', w.session.context.fence))
    assert skill['references'][0]['text'].strip().splitlines()[0] in read.text


def test_another_roles_skill_an_unknown_skill_and_an_unknown_reference_are_refused(tmp_path: Any) -> None:
    tools = world(tmp_path).session.tools
    other = tools.call(READ_SKILL, {'name': 'code-review'})
    assert other.error
    assert 'no skill' in other.text
    assert 'tdd' in other.text
    assert tools.call(READ_SKILL, {'name': 'no-such-skill'}).error
    missing = tools.call(READ_SKILL, {'name': 'tdd', 'reference': 'references/none.md'})
    assert missing.error
    assert 'has no reference' in missing.text
    assert tools.call(READ_SKILL, {}).error


LONG = 'line\n' * 20_000
DOCUMENT = {'agents': [{'id': 'fixer', 'skills': ['big', 'gone']}, {'id': 'hunter', 'skills': ['other']}],
            'library': [{'name': 'big', 'description': 'A long one.', 'text': LONG,
                         'references': [{'path': 'references/r.md', 'text': 'x' * (MAX_CHARS + 10)}]},
                        {'name': 'other', 'description': 'The hunter\'s.', 'text': 'other', 'references': []}]}


def test_an_answer_is_capped_at_max_chars_saying_so(tmp_path: Any) -> None:
    context = world(tmp_path).session.context
    read = library_tools.handlers(context, ToolResult, DOCUMENT)[READ_SKILL]
    whole = read({'name': 'big'}).text
    assert '[cut: ' in whole
    assert f'of {len(LONG)} characters shown]' in whole
    assert len(whole) < MAX_CHARS + 1_000
    assert '[cut: ' in read({'name': 'big', 'reference': 'references/r.md'}).text
    assert capped('short') == 'short'
    assert own('fixer', DOCUMENT) == [DOCUMENT['library'][0]]   # (a name the library lacks is skipped)


def test_the_system_prompt_lists_the_roles_skills_only_with_read_skill(tmp_path: Any) -> None:
    w = world(tmp_path)
    fence, fixer = w.session.context.fence, SKILLS['fixer']
    prompt = system_prompt(w.session.context, fixer)
    assert prompt == f'{platform_rules(fence)}\n\n{fixer.system_prompt()}\n\n{listing(own("fixer"))}'
    assert LISTING_HEAD in prompt
    assert '\n- tdd: ' in prompt
    assert '\n- code-review: ' not in prompt
    older = replace(fixer, tool_policy=tuple(tool for tool in fixer.tool_policy if tool != READ_SKILL))
    assert LISTING_HEAD not in system_prompt(w.session.context, older)
    assert READ_SKILL not in {spec.name for spec in ToolBox(w.session.context, skill=older).specs}
    assert listing([]) == ''


def test_the_bundle_beside_the_harness_carries_the_library_and_every_card_names_skills_it_has() -> None:
    document = bundle_document()
    names = {item['name'] for item in document['library']}
    assert names
    assert all(set(agent['skills']) <= names for agent in document['agents'])
