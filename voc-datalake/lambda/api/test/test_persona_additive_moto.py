"""Replace vs add persona generation (#353), end to end against moto with a fake model.

``keep_existing_personas`` false (the default) replaces the project's personas; true adds
new ones next to them, tells the model about the kept ones, and drops a new persona whose
name repeats a kept one. Each test fails if one mode behaves like the other.
"""
from collections.abc import Iterator
from dataclasses import dataclass, field
from unittest.mock import patch

import pytest
from moto_helpers import PersonaWorld, mocked_projects_table, seed_project_personas
from persona_fakes import PERSONA_STEP, PLAN_STEP, FakePersonaModel, one_item_corpus

import projects

BUCKET = 'test-raw-data-bucket'
PROJECT = 'proj-add'
NEW_NAMES = ['Ada Moreno', 'Grace Okafor', 'Mary Lindqvist']
KEPT_HEADING = '## PERSONAS THIS PROJECT KEEPS'


@dataclass
class World(PersonaWorld):
    avatar_for: list[str] = field(default_factory=list)

    def seed(self, kept: dict[str, str]) -> None:
        """META plus one reviewed persona per ``{persona_id: name}``."""
        seed_project_personas(self.projects, PROJECT, {
            persona_id: {'name': name, 'research_notes': 'edited by a person'} for persona_id, name in kept.items()})


@pytest.fixture
def world() -> Iterator[World]:
    with mocked_projects_table(BUCKET) as table:
        yield World(projects=table, project_id=PROJECT)


def _generate(world: World, filters: dict, model: FakePersonaModel | None = None) -> tuple[dict, FakePersonaModel]:
    model = model or FakePersonaModel(NEW_NAMES)

    def avatar(_project_id: str, _persona_id: str, persona: dict) -> dict:
        world.avatar_for.append(persona['name'])
        return {'avatar_url': None, 'avatar_prompt': None}

    with patch.object(projects, '_load_persona_corpus', return_value=one_item_corpus()), \
            patch.object(projects, 'converse_detailed', model), \
            patch.object(projects, '_avatar_for', avatar), \
            patch.object(projects, 'AVATAR_MAX_CONCURRENCY', 1):
        return projects.generate_personas(PROJECT, {'persona_count': 3, **filters}), model


class TestReplaceMode:
    def test_replace_never_appends_the_old_personas_are_gone(self, world):
        world.seed({'old-1': 'Kept One', 'old-2': 'Kept Two'})

        result, _model = _generate(world, {})

        stored = world.personas()
        assert 'old-1' not in stored
        assert 'old-2' not in stored
        assert sorted(row['name'] for row in stored.values()) == sorted(NEW_NAMES)
        assert result['metadata']['duplicate_names_dropped'] == 0

    def test_replace_does_not_describe_the_old_personas_to_the_model(self, world):
        world.seed({'old-1': 'Kept One'})

        _result, model = _generate(world, {'keep_existing_personas': False})

        assert not any(KEPT_HEADING in prompt for prompt in model.prompts(PLAN_STEP) + model.prompts(PERSONA_STEP))

    def test_replace_never_saves_a_name_twice_the_plan_drops_the_repeat(self, world):
        world.seed({'old-1': 'Kept One'})
        model = FakePersonaModel(['Ada Moreno', ' ADA  moreno', 'Grace Okafor'])

        result, _model = _generate(world, {}, model)

        assert sorted(row['name'] for row in world.personas().values()) == ['Ada Moreno', 'Grace Okafor']
        assert world.avatar_for == ['Ada Moreno', 'Grace Okafor']
        assert result['metadata']['duplicate_names_dropped'] == 0


class TestAddMode:
    def test_add_never_deletes_the_kept_personas_stay_unchanged(self, world):
        world.seed({'old-1': 'Kept One', 'old-2': 'Kept Two'})
        before = world.personas()

        result, _model = _generate(world, {'keep_existing_personas': True})

        stored = world.personas()
        assert stored['old-1'] == before['old-1']
        assert stored['old-2'] == before['old-2']
        assert len(stored) == 5
        assert len(result['personas']) == 3

    def test_the_plan_and_every_persona_call_see_the_kept_personas(self, world):
        world.seed({'old-1': 'Kept One'})

        _result, model = _generate(world, {'keep_existing_personas': True})

        prompts = model.prompts(PLAN_STEP) + model.prompts(PERSONA_STEP)
        assert len(prompts) == 4
        assert all(KEPT_HEADING in prompt and 'The reviewed Kept One' in prompt for prompt in prompts)

    def test_add_reads_the_kept_personas_once_and_avoids_their_names(self, world):
        world.seed({'old-1': 'Kept One'})

        with patch.object(projects, '_existing_persona_names') as second_read:
            _result, model = _generate(world, {'keep_existing_personas': True})

        second_read.assert_not_called()
        avoid_section = projects._avoid_names_section(['Kept One'])
        assert avoid_section
        assert all(avoid_section in prompt for prompt in model.prompts(PLAN_STEP))

    def test_a_new_persona_named_like_a_kept_one_is_dropped_before_its_avatar(self, world):
        world.seed({'old-1': '  ada   MORENO '})

        result, _model = _generate(world, {'keep_existing_personas': True})

        assert sorted(p['name'] for p in result['personas']) == ['Grace Okafor', 'Mary Lindqvist']
        assert result['metadata']['duplicate_names_dropped'] == 1
        assert 'Ada Moreno' not in world.avatar_for
        assert len(world.personas()) == 3

    def test_a_failed_read_of_the_kept_personas_still_adds_without_deleting(self, world):
        world.seed({'old-1': 'Kept One'})

        with patch.object(projects.persona_overlap, 'read_existing_personas', side_effect=RuntimeError('throttled')), \
                patch.object(projects, 'logger') as log:
            result, model = _generate(world, {'keep_existing_personas': True})

        assert 'old-1' in world.personas()
        assert len(result['personas']) == 3
        assert not any(KEPT_HEADING in prompt for prompt in model.prompts(PLAN_STEP))
        log.exception.assert_any_call('[PERSONA] Could not read the kept personas (continuing)')
