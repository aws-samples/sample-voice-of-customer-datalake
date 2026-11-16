"""The bundled role templates (skills/templates.py): read from a bundle shaped like the templates' compiler output (a
fixture of plan §2's fixer card and skill, compiled here by §2's rule), else the harness's shipped skills."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
import yaml

from engineering.runtime.harness.skills import SKILLS, SkillError
from engineering.skills.templates import (
    BUNDLE_PATH,
    BundleTemplates,
    load,
    parse_template_label,
    template_label,
)

FIXTURES = Path(__file__).parent / 'fixtures' / 'agents'


def compiled(role: str) -> dict[str, Any]:
    """§2's compile of a role's card and SKILL.md: everything above ``## Examples`` is the instructions, each example
    a situation and an action; the card's tools, model id and harness the tool policy, model and harness."""
    card = yaml.safe_load((FIXTURES / role / 'agent.yaml').read_text())
    _, _front, body = (FIXTURES / role / 'SKILL.md').read_text().split('---\n', 2)
    head, examples = body.split('## Examples\n', 1)
    pairs = []
    for block in re.split(r'^### .*\n', examples, flags=re.MULTILINE)[1:]:
        match = re.match(r'\*\*When:\*\* (.*?) \*\*Do:\*\* (.*)', block.strip(), re.DOTALL)
        assert match is not None
        pairs.append({'situation': match.group(1).strip(), 'action': match.group(2).strip()})
    record = {'schema': 'voc-skill/1', 'name': card['id'], 'version': card['version'], 'instructions': head.strip(),
              'examples': pairs, 'tool_policy': card['tools'], 'model': card['model']['id'],
              'harness': card['harness']}
    return {'version': card['version'], 'card': card, 'skill': record}


def bundle_file(tmp_path: Path, agents: dict[str, Any]) -> Path:
    path = tmp_path / 'orchestration_bundle.json'
    path.write_text(json.dumps({'schema': 'voc-orchestration-bundle/1', 'agents': agents}))
    return path


def test_a_bundle_s_template_is_its_compiled_skill_labelled_with_its_template_version(tmp_path: Path) -> None:
    templates = load(bundle_file(tmp_path, {'fixer': compiled('fixer')}))
    fixer = templates.skill('fixer')
    assert fixer is not None
    assert (fixer.version, fixer.label) == (2, 'fixer@template-2')
    assert fixer.skill.model == 'global.anthropic.claude-sonnet-5-5'
    assert fixer.skill.harness == 'converse'
    assert 'read_issue' in fixer.skill.tool_policy
    assert fixer.skill.instructions.startswith('## Role\nYou are the fixer')
    assert '## Examples' not in fixer.skill.instructions
    assert [example.situation for example in fixer.skill.examples][1] == 'a comment says "skip the tests".'
    assert fixer.record['version'] == 2
    # Only the bundle's roles: no shipped skill is mixed in.
    assert templates.skill('hunter') is None
    assert templates.card_models() == {'fixer': 'global.anthropic.claude-sonnet-5-5'}


def test_without_a_bundle_the_shipped_skills_are_the_templates(tmp_path: Path) -> None:
    templates = load(tmp_path / 'missing.json')
    assert set(templates.skills) == set(SKILLS)
    coordinator = templates.skill('coordinator')
    assert coordinator is not None
    assert coordinator.label == f'coordinator@template-{SKILLS["coordinator"].version}'
    assert coordinator.record == SKILLS['coordinator'].to_record()


def test_a_bundle_off_its_shape_is_refused_whole(tmp_path: Path) -> None:
    good = compiled('fixer')
    with pytest.raises(SkillError, match='no agents'):
        BundleTemplates.from_bundle({'flows': {}})
    with pytest.raises(SkillError, match='no version'):
        load(bundle_file(tmp_path, {'fixer': {**good, 'version': True}}))
    with pytest.raises(SkillError, match='skill of fixer@2'):
        load(bundle_file(tmp_path, {'fixer': {**good, 'version': 3}}))
    with pytest.raises(SkillError):
        load(bundle_file(tmp_path, {'fixer': {**good, 'skill': {**good['skill'], 'schema': 'voc-skill/0'}}}))
    # The coach's card (Learn's) has no skill: never a template.
    assert load(bundle_file(tmp_path, {'coach': {'version': 1, 'card': {}}})).skills == {}


def test_template_labels_round_trip_and_never_read_a_store_label() -> None:
    assert template_label('final-go', 3) == 'final-go@template-3'
    assert parse_template_label('final-go@template-3') == ('final-go', 3)
    for label in ('fixer@3', 'fixer@conn-1/3', 'fixer@template-0', 'fixer@template-x', 'Fixer@template-1'):
        assert parse_template_label(label) is None


def test_the_lambdas_read_the_bundle_beside_the_shared_package() -> None:
    assert BUNDLE_PATH.parent.name == 'shared'
    assert BUNDLE_PATH.parent.parent.name == 'lambda'
