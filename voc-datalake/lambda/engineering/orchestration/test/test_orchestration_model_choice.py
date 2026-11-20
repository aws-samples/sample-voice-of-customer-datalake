"""A card's model (7.58.00): its ``model.id`` alone, the role's default on both harnesses (Kiro's name for it in the
role's Kiro config); a card names no model choice (no ``model.choice`` or ``model.other``: a deployment's Registry and a
run choose), so the bundle carries none and a card that names one fails validation, saying so (on a copy of the
folder)."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from engineering.orchestration import validate
from engineering.orchestration.compile import compile_bundle, kiro_files, load, render, write, write_kiro_agents
from engineering.orchestration.schema import ROOT, errors
from engineering.runtime.harness.kiro_pin import kiro_model
from engineering.skills.templates import BundleTemplates

CARD = 'model: {id: global.anthropic.claude-sonnet-5-5}'


@pytest.fixture
def copy(tmp_path: Path) -> Path:
    root = tmp_path / 'orchestration'
    shutil.copytree(ROOT, root)
    return root


def _card(root: Path, role: str, model: str) -> None:
    path = root / 'agents' / role / 'agent.yaml'
    text = path.read_text(encoding='utf-8')
    assert CARD in text
    path.write_text(text.replace(CARD, model, 1), encoding='utf-8')


def _compiled(root: Path) -> dict:
    sources = load(root)
    write(render(compile_bundle(sources)), root)
    write_kiro_agents(kiro_files(sources), root)
    return json.loads((root / 'bundle.json').read_text(encoding='utf-8'))


def _agent(bundle: dict, role: str) -> dict:
    return next(agent for agent in bundle['agents'] if agent['id'] == role)


def test_the_shipped_cards_name_no_choice_and_their_kiro_configs_name_kiros_name_for_their_model():
    bundle = json.loads((ROOT / 'bundle.json').read_text(encoding='utf-8'))
    assert not [agent['id'] for agent in bundle['agents'] if 'model_choice' in agent]
    for agent in bundle['agents']:
        path = ROOT / 'kiro-agents' / f'{agent["id"]}.json'
        if path.is_file():
            assert json.loads(path.read_text(encoding='utf-8'))['model'] == kiro_model(agent['model'])
    assert json.loads((ROOT / 'kiro-agents' / 'builder.json').read_text(encoding='utf-8'))['model'] == \
        'claude-sonnet-5.5'
    assert not hasattr(BundleTemplates.from_bundle(bundle), 'choice')


@pytest.mark.parametrize(('model', 'problem'), [
    ('model: {id: global.anthropic.claude-sonnet-5-5, choice: opus}', "'choice' was unexpected"),
    ('model: {id: global.anthropic.claude-sonnet-5-5, other: claude-sonnet-4.5}', "'other' was unexpected"),
    ('model: {id: global.anthropic.claude-sonnet-5-5, kiro: claude-opus-5.5}', "'kiro' was unexpected"),
])
def test_a_card_that_names_a_model_choice_fails_validation_saying_so(copy: Path, model: str, problem: str):
    _card(copy, 'builder', model)
    found = validate.problems(copy, drift=False)
    assert any(problem in line and 'agents/builder/agent.yaml' in line for line in found), found


def test_a_kiro_config_whose_model_is_not_kiros_name_for_its_cards_is_a_problem(copy: Path):
    _card(copy, 'builder', 'model: {id: global.anthropic.claude-haiku-5-5}')
    _compiled(copy)
    path = copy / 'kiro-agents' / 'builder.json'
    config = json.loads(path.read_text(encoding='utf-8'))
    assert config['model'] == 'claude-haiku-5.5'
    path.write_text(json.dumps({**config, 'model': 'claude-opus-5.5'}), encoding='utf-8')
    assert any("kiro-agents/builder.json: its model is Kiro's name for its card's, claude-haiku-5.5" in line
               for line in validate.problems(copy))


def test_a_bundle_that_still_names_a_cards_choice_is_off_its_schema():
    bundle = json.loads((ROOT / 'bundle.json').read_text(encoding='utf-8'))
    assert list(errors('bundle', bundle)) == []
    _agent(bundle, 'builder')['model_choice'] = 'opus'
    assert any("'model_choice' was unexpected" in line for line in errors('bundle', bundle))
