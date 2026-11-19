"""The skills library's routes and the Registry's "Uses skills" (shared/agents_engineering_registry_routes.py,
7.56.00): ``GET /agents/engineering/skill-library`` lists the library from the bundle without its text,
``…/skill-library/<name>`` reads a SKILL.md or (``?reference=``) one reference file, and a Registry card carries the
library skills it uses (its template's, when the skill it runs has ``read_skill``). Administrators only, 404 while the
module is off."""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from agents_handler_fixtures import USER
from agents_handler_fixtures import call as _call
from engineering_skills_fixtures import DELEGATED_ADMIN, PERSON, WS, engineering_skills

from engineering.skills.model import Reason
from engineering.skills.store import SHARED, SkillStore
from engineering.skills.test.fixtures import content
from shared import engineering_templates

LIBRARY = '/agents/engineering/skill-library'
REGISTRY = '/agents/engineering/registry'


@pytest.fixture
def skills(monkeypatch: pytest.MonkeyPatch) -> Iterator[SkillStore]:
    """The tables on moto with the module on, and the shared Fixer skill's v1 (a version without read_skill)."""
    with engineering_skills(monkeypatch) as (_client, store):
        proposed = store.propose_version(WS, SHARED, 'fixer', content(), proposer=PERSON,
                                         reason=Reason(comment='The first Fixer skill.'), base=None)
        store.accept_version(WS, SHARED, 'fixer', proposed.version.version, PERSON)
        yield store


@pytest.mark.usefixtures('skills')
def test_the_library_is_listed_from_the_bundle_without_its_text(lambda_context: Any) -> None:
    status, body = _call(lambda_context, 'GET', LIBRARY)
    bundled = engineering_templates.bundle()['library']
    assert status == 200
    assert [item['name'] for item in body['skills']] == [item['name'] for item in bundled]
    tdd = next(item for item in body['skills'] if item['name'] == 'tdd')
    assert set(tdd) == {'name', 'description', 'source', 'license', 'adapted', 'path', 'digest', 'bytes', 'roles',
                        'references'}
    assert 'fixer' in tdd['roles']
    assert tdd['license'] == 'MIT'
    assert tdd['source'].startswith('ai-skill-factory 2.0.0')
    assert all(set(ref) == {'path', 'digest', 'bytes'} for item in body['skills'] for ref in item['references'])


@pytest.mark.usefixtures('skills')
def test_a_skill_and_one_of_its_references_are_read_with_their_text(lambda_context: Any) -> None:
    skill = next(item for item in engineering_templates.bundle()['library'] if item['references'])
    status, read = _call(lambda_context, 'GET', f'{LIBRARY}/{skill["name"]}')
    assert (status, read['reference'], read['path'], read['text']) == (200, None, skill['path'], skill['text'])
    reference = skill['references'][0]
    status, ref = _call(lambda_context, 'GET', f'{LIBRARY}/{skill["name"]}', query={'reference': reference['path']})
    assert (status, ref['reference'], ref['text'], ref['digest']) == (200, reference['path'], reference['text'],
                                                                      reference['digest'])
    assert ref['path'] == f'skills/{skill["name"]}/{reference["path"]}'


@pytest.mark.usefixtures('skills')
def test_no_such_skill_or_reference_is_404_and_a_malformed_one_400(lambda_context: Any) -> None:
    assert _call(lambda_context, 'GET', f'{LIBRARY}/no-such-skill')[0] == 404
    assert _call(lambda_context, 'GET', f'{LIBRARY}/tdd', query={'reference': 'references/none.md'})[0] == 404
    assert _call(lambda_context, 'GET', f'{LIBRARY}/Not_A_Skill')[0] == 400
    assert _call(lambda_context, 'GET', f'{LIBRARY}/tdd', query={'reference': '../../bundle.json'})[0] == 400


@pytest.mark.usefixtures('skills')
def test_a_registry_card_carries_the_skills_it_uses(lambda_context: Any) -> None:
    cards = {card['id']: card for card in _call(lambda_context, 'GET', REGISTRY)[1]['cards']}
    templates = {agent['id']: agent for agent in engineering_templates.bundle()['agents']}
    # (the hunter runs its template, which reads its skills; the fixer the shared v1, stored without read_skill)
    assert cards['hunter']['skills'] == templates['hunter']['skills'] != []
    assert cards['fixer']['skills'] == []
    assert cards['committer']['skills'] == []
    assert cards['coach']['skills'] == ['retrospective', 'skill-builder', 'skill-audit']   # (its prompt carries them)


@pytest.mark.usefixtures('skills')
@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN], ids=['plain user', 'MCP credential of an admin'])
def test_the_library_is_an_administrators_alone_and_404_while_the_module_is_off(
        lambda_context: Any, claims: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    for path in (LIBRARY, f'{LIBRARY}/tdd'):
        assert _call(lambda_context, 'GET', path, claims=claims)[0] == 403
    monkeypatch.delenv('ENGINEERING_AGENTS')
    assert {_call(lambda_context, 'GET', path)[0] for path in (LIBRARY, f'{LIBRARY}/tdd')} == {404}
