"""The bundled role templates (skills/templates.py): read from the templates' bundle (``voc-orchestration-bundle/1``,
the repository's own and a synthetic one), else the harness's shipped skills."""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from engineering.runtime.harness.skills import SKILLS, SkillError
from engineering.skills.templates import (
    BUNDLE_PATHS,
    BundleTemplates,
    bundled,
    load,
    parse_template_label,
    template_label,
)

REPOSITORY_BUNDLE = BUNDLE_PATHS[-1]


def repository_bundle() -> dict[str, Any]:
    return json.loads(REPOSITORY_BUNDLE.read_text())


def written(tmp_path: Path, bundle: dict[str, Any]) -> Path:
    path = tmp_path / 'orchestration_bundle.json'
    path.write_text(json.dumps(bundle))
    return path


def test_the_repositorys_bundle_gives_every_launchable_role_its_template() -> None:
    templates = load((REPOSITORY_BUNDLE,))
    assert set(templates.skills) == set(SKILLS)   # every launchable role; the coach's card has no skill
    fixer = templates.skill('fixer')
    assert fixer is not None
    entry = next(agent for agent in repository_bundle()['agents'] if agent['id'] == 'fixer')
    assert fixer.label == entry['label'] == template_label('fixer', entry['version'])
    assert fixer.record == entry['skill']
    assert templates.card_models()['fixer'] == entry['skill']['model']
    assert templates.platform_rules().startswith('# Platform rules')
    assert templates.skill('coach') is None


def test_the_shipped_understander_is_its_bundled_template() -> None:
    # (7.52.00: a deployment without a bundle, and the harness's fallback, give the understander read_tenets and
    # write_tenets too, the triage's tenets lock and the Tenets flow's draft)
    template = load((REPOSITORY_BUNDLE,)).skill('understander')
    assert template is not None
    assert (template.version, template.record) == (SKILLS['understander'].version, SKILLS['understander'].to_record())


def test_a_lambda_reads_its_own_copy_first_and_the_shipped_skills_without_any(tmp_path: Path) -> None:
    assert BUNDLE_PATHS[0].parent.name == 'shared'
    assert BUNDLE_PATHS[0].parent.parent.name == 'lambda'
    bundle = repository_bundle()
    entry = next(agent for agent in bundle['agents'] if agent['id'] == 'mapper')
    entry['version'] = entry['skill']['version'] = 9
    own = written(tmp_path, bundle)
    mapper = load((own, REPOSITORY_BUNDLE)).skill('mapper')
    assert mapper is not None
    assert mapper.label == 'mapper@template-9'
    shipped = load((tmp_path / 'missing.json',))
    assert set(shipped.skills) == set(SKILLS)
    coordinator = shipped.skill('coordinator')
    assert coordinator is not None
    assert coordinator.label == f'coordinator@template-{SKILLS["coordinator"].version}'
    assert coordinator.record == SKILLS['coordinator'].to_record()
    assert shipped.platform_rules() == ''
    assert bundled() is bundled()


@pytest.mark.parametrize(('change', 'reason'), [
    (lambda b: b.update(schema='voc-orchestration-bundle/0'), 'not a voc-orchestration-bundle/1'),
    (lambda b: b.update(agents={}), 'with its agents'),
    (lambda b: b['agents'].append(copy.deepcopy(b['agents'][0])), 'once'),
    (lambda b: b['agents'][0].update(id='janitor'), 'one agent role'),
    (lambda b: b['agents'][0].update(version=True), 'no version'),
    (lambda b: b['agents'][0].update(version=b['agents'][0]['version'] + 1), 'is the skill of'),
    (lambda b: b['agents'][0]['skill'].update(schema='voc-skill/0'), 'voc-skill/1'),
    (lambda b: b.pop('platform_rules'), 'no platform rules'),
])
def test_a_bundle_off_its_shape_is_refused_whole(tmp_path: Path, change: Any, reason: str) -> None:
    bundle = repository_bundle()
    change(bundle)
    with pytest.raises(SkillError, match=reason):
        load((written(tmp_path, bundle),))


def test_template_labels_round_trip_and_never_read_a_store_label() -> None:
    assert template_label('final-go', 3) == 'final-go@template-3'
    assert parse_template_label('final-go@template-3') == ('final-go', 3)
    for label in ('fixer@3', 'fixer@conn-1/3', 'fixer@template-0', 'fixer@template-x', 'Fixer@template-1'):
        assert parse_template_label(label) is None
    assert BundleTemplates.shipped().skill('coach') is None
