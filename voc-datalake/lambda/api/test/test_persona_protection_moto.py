"""Protected personas survive a replace regeneration (ported from #429 by @aws-bryan), against moto.

``PUT /projects/{id}/personas/{pid}/protection`` marks a persona; a replace run then deletes only the
unprotected ones, tells the model about the protected ones like an additive run does, drops a new
persona named like a protected one, and the project count is what remains.
"""
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws
from moto_helpers import projects_module_world
from persona_fakes import PERSONA_STEP, PLAN_STEP, FakePersonaModel, one_item_corpus

import projects
from shared import persona_replace
from shared.exceptions import NotFoundError, ValidationError

BUCKET = 'test-raw-data-bucket'
PROJECT = 'proj-protect'
NEW_NAMES = ['Ada Moreno', 'Grace Okafor']
KEPT_HEADING = '## PERSONAS THIS PROJECT KEEPS'


@dataclass
class World:
    projects: Any

    def seed(self, personas: dict[str, tuple[str, bool]]) -> None:
        """META plus one persona per ``{persona_id: (name, protected)}``."""
        self.projects.put_item(Item={'pk': f'PROJECT#{PROJECT}', 'sk': 'META', 'project_id': PROJECT})
        for persona_id, (name, protected) in personas.items():
            self.projects.put_item(Item={
                'pk': f'PROJECT#{PROJECT}', 'sk': f'PERSONA#{persona_id}', 'persona_id': persona_id,
                'name': name, 'tagline': f'The reviewed {name}', **({'protected': True} if protected else {}),
            })

    def personas(self) -> dict[str, dict]:
        rows = self.projects.query(
            KeyConditionExpression='pk = :pk AND begins_with(sk, :p)',
            ExpressionAttributeValues={':pk': f'PROJECT#{PROJECT}', ':p': 'PERSONA#'},
        )['Items']
        return {row['persona_id']: row for row in rows}

    def persona_count(self) -> int:
        return int(self.projects.get_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'META'})['Item']['persona_count'])


@pytest.fixture
def world() -> Iterator[World]:
    with mock_aws(), projects_module_world(BUCKET) as (projects_table, _jobs, _s3):
        yield World(projects=projects_table)


def _replace(names: list[str] = NEW_NAMES) -> tuple[dict, FakePersonaModel]:
    model = FakePersonaModel(names)
    with patch.object(projects, '_load_persona_corpus', return_value=one_item_corpus()), \
            patch.object(projects, 'converse_detailed', model), \
            patch.object(projects, '_avatar_for', return_value={'avatar_url': None, 'avatar_prompt': None}), \
            patch.object(projects, 'AVATAR_MAX_CONCURRENCY', 1):
        return projects.generate_personas(PROJECT, {'persona_count': len(names)}), model


class TestAReplaceRunKeepsTheProtectedPersonas:
    def test_only_the_unprotected_ones_are_deleted_and_the_count_is_what_remains(self, world):
        world.seed({'kept': ('Kept One', True), 'old': ('Old One', False)})

        _replace()

        stored = world.personas()
        assert 'kept' in stored
        assert 'old' not in stored
        assert sorted(row['name'] for row in stored.values()) == ['Ada Moreno', 'Grace Okafor', 'Kept One']
        assert world.persona_count() == 3

    def test_the_model_is_told_about_the_protected_ones_only(self, world):
        world.seed({'kept': ('Kept One', True), 'old': ('Old One', False)})

        _result, model = _replace()

        prompts = model.prompts(PLAN_STEP) + model.prompts(PERSONA_STEP)
        assert all(KEPT_HEADING in prompt and 'The reviewed Kept One' in prompt for prompt in prompts)
        assert not any('The reviewed Old One' in prompt for prompt in prompts)

    def test_without_protected_personas_the_model_is_told_about_none(self, world):
        world.seed({'old': ('Old One', False)})

        _result, model = _replace()

        assert not any(KEPT_HEADING in prompt for prompt in model.prompts(PLAN_STEP) + model.prompts(PERSONA_STEP))

    def test_a_new_persona_named_like_a_protected_one_is_dropped(self, world):
        world.seed({'kept': (' ada MORENO', True)})

        result, _model = _replace()

        assert [p['name'] for p in result['personas']] == ['Grace Okafor']
        assert result['metadata']['duplicate_names_dropped'] == 1


class TestTheClear:
    def test_a_persona_protected_after_the_read_is_kept_not_failed(self):
        table = MagicMock()
        table.query.return_value = {'Items': [{'pk': 'P', 'sk': 'PERSONA#a'}, {'pk': 'P', 'sk': 'PERSONA#b'}]}
        refused = ClientError({'Error': {'Code': 'ConditionalCheckFailedException'}}, 'DeleteItem')
        table.delete_item.side_effect = [refused, None]

        cleared = persona_replace.clear_personas(table, 'p1')

        assert (cleared.deleted, cleared.protected, cleared.failed) == (['PERSONA#b'], ['PERSONA#a'], [])
        assert table.delete_item.call_args_list[0].kwargs['ConditionExpression'] == (
            'attribute_not_exists(#protected) OR #protected <> :true')


class TestTheRoute:
    def test_protect_then_release(self, world):
        world.seed({'p1': ('Ada Moreno', False)})

        assert projects.set_persona_protection(PROJECT, 'p1', {'protected': True}) == {
            'success': True, 'persona_id': 'p1', 'protected': True}
        assert world.personas()['p1']['protected'] is True
        projects.set_persona_protection(PROJECT, 'p1', {'protected': False})
        assert world.personas()['p1']['protected'] is False

    @pytest.mark.parametrize('body', [{}, {'protected': 'false'}, {'protected': 1}, {'protected': None}])
    def test_anything_but_a_real_boolean_is_refused(self, world, body):
        world.seed({'p1': ('Ada Moreno', False)})
        with pytest.raises(ValidationError, match='protected must be true or false'):
            projects.set_persona_protection(PROJECT, 'p1', body)
        assert 'protected' not in world.personas()['p1']

    def test_a_persona_the_project_does_not_have_is_404_and_writes_nothing(self, world):
        world.seed({})
        with pytest.raises(NotFoundError):
            projects.set_persona_protection(PROJECT, 'missing', {'protected': True})
        assert world.personas() == {}

    def test_an_ordinary_persona_edit_cannot_change_protection(self, world):
        world.seed({'p1': ('Ada Moreno', True)})
        projects.update_persona(PROJECT, 'p1', {'name': 'Ada M.', 'protected': False})
        assert world.personas()['p1']['protected'] is True
