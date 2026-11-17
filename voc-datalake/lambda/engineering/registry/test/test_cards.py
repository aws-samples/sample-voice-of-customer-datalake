"""Registry cards made from a skill (engineering/registry/cards.py, 7.52.00).

A card is checked when it is made: its id is ``<role>-<slug>``, its skill version accepted, its model an allowed one
(the skill version's), its tools ones the role may have, its caps at most the template's. Its rows are written in one
transaction (HEAD, a create-only version and log row, the listing's), and a next version names the one it follows.
"""
from __future__ import annotations

from collections.abc import Iterator
from dataclasses import replace
from typing import Any

import pytest
from moto import mock_aws

from engineering.board.test.table import TABLE, create_table
from engineering.knowledge.store import Actor
from engineering.registry.cards import (
    CARD_ID,
    CHANGED,
    EXISTS,
    AgentCardStore,
    CardError,
    CardRequest,
    card_id,
    check_request,
    compose,
    node_of,
)
from engineering.runtime.harness.tools import role_specs
from engineering.skills.model import Reason
from engineering.skills.store import SHARED, SkillStore, SkillVersion
from engineering.skills.test.fixtures import SONNET, content
from shared import engineering_templates
from shared.model_config import ALLOWED_MODEL_IDS

WS = 'default'
PERSON = Actor('admin-sub', 'person', admin=True)
AT = '2026-11-17T09:00:00+00:00'
FIXER = next(template for template in engineering_templates.bundle()['agents'] if template['id'] == 'fixer')
ROLES = ['fixer', 'hunter']
FIXER_TOOLS = frozenset(spec.name for spec in role_specs('fixer'))
BODY: dict[str, Any] = {'from_skill': {'role': 'fixer', 'connection': '', 'version': 1}, 'slug': 'python',
                        'purpose': 'Fixes Python bugs with a failing test first.'}


@pytest.fixture
def skills() -> Iterator[SkillStore]:
    with mock_aws():
        yield SkillStore(create_table(), TABLE)


def accepted(skills: SkillStore, **changes: Any) -> SkillVersion:
    """The shared Fixer skill's first version (``content`` with ``changes``), accepted by an administrator."""
    proposed = skills.propose_version(WS, SHARED, 'fixer', replace(content(), **changes), proposer=PERSON,
                                      reason=Reason(comment='The first Fixer skill.'), base=None)
    skills.accept_version(WS, SHARED, 'fixer', proposed.version.version, PERSON)
    return skills.version(WS, SHARED, 'fixer', 1)


def make(request: CardRequest, skill: SkillVersion, version: int = 1) -> dict[str, Any]:
    return compose(request, skill, FIXER, allowed_models=frozenset(ALLOWED_MODEL_IDS), role_tools=FIXER_TOOLS,
                   version=version, by='alice', at=AT)


def test_a_card_is_its_skill_versions_model_tools_and_harness_with_the_templates_contracts(skills: SkillStore) -> None:
    record = make(check_request(BODY, ROLES), accepted(skills))
    assert record['id'] == 'fixer-python'
    assert (record['base_role'], record['version'], record['title']) == ('fixer', 1, 'fixer-python')
    assert record['skill'] == {'connection': '', 'version': 1, 'label': 'fixer@1', 'provenance': 'person',
                               'template_version': 0}
    assert (record['model'], record['tools'], record['harness']) == (SONNET, list(content().tool_policy), 'converse')
    assert (record['caps'], record['inputs'], record['outputs']) == (FIXER['caps'], FIXER['inputs'], FIXER['outputs'])
    assert record['template'] == {'version': FIXER['version'], 'label': FIXER['label'], 'digest': FIXER['digest']}
    # (the agent step a flow gets from it: the role, the pinned skill version, the model and the card)
    assert node_of(record) == {'type': 'agent', 'data': {'title': 'fixer-python', 'params': {
        'role': 'fixer', 'skill_version': 'v1', 'model': SONNET, 'card': 'fixer-python@v1'}}}


def test_only_an_accepted_version_makes_a_card(skills: SkillStore) -> None:
    skills.propose_version(WS, SHARED, 'fixer', content(), proposer=PERSON, reason=Reason(comment='x'), base=None)
    with pytest.raises(CardError, match='only an accepted skill version') as refused:
        make(check_request(BODY, ROLES), skills.version(WS, SHARED, 'fixer', 1))
    assert refused.value.kind == 'conflict'


def test_a_card_runs_an_allowed_model_its_skill_versions(skills: SkillStore) -> None:
    skill = accepted(skills)
    with pytest.raises(CardError, match="its skill version's model"):
        make(check_request({**BODY, 'model': 'global.anthropic.claude-haiku-5-5'}, ROLES), skill)
    assert make(check_request({**BODY, 'model': SONNET}, ROLES), skill)['model'] == SONNET
    with pytest.raises(CardError, match='not an allowed model'):
        compose(check_request(BODY, ROLES), skill, FIXER, allowed_models=frozenset({'another-model'}),
                role_tools=FIXER_TOOLS, version=1, by='alice', at=AT)


def test_a_cards_tools_are_ones_its_role_may_have(skills: SkillStore) -> None:
    skill = accepted(skills)
    with pytest.raises(CardError, match='may not have: run, write_file') as refused:
        compose(check_request(BODY, ROLES), skill, FIXER, allowed_models=frozenset(ALLOWED_MODEL_IDS),
                role_tools=FIXER_TOOLS - {'run', 'write_file'}, version=1, by='alice', at=AT)
    assert refused.value.kind == 'conflict'


def test_a_cards_caps_are_at_most_the_templates(skills: SkillStore) -> None:
    skill = accepted(skills)
    lower = make(check_request({**BODY, 'caps': {'max_turns': 40}}, ROLES), skill)
    assert lower['caps'] == {**FIXER['caps'], 'max_turns': 40}
    for caps, said in (({'max_turns': FIXER['caps']['max_turns'] + 1}, 'at most the template'),
                       ({'max_turns': 0}, 'above 0'), ({'max_turns': True}, 'above 0'),
                       ({'gpu_hours': 1}, 'not gpu_hours')):
        with pytest.raises(CardError, match=said):
            make(check_request({**BODY, 'caps': caps}, ROLES), skill)


@pytest.mark.parametrize(('body', 'said'), [
    ({**BODY, 'extra': 1}, 'the body is'),
    ({**BODY, 'from_skill': {'role': 'coach', 'version': 1}}, 'one of the roles'),
    ({**BODY, 'from_skill': {'role': 'fixer', 'version': 0}}, 'from 1 to'),
    ({**BODY, 'from_skill': {'role': 'fixer', 'version': 1, 'connection': 'Not A Connection'}}, 'connection id'),
    ({**BODY, 'slug': '-python'}, 'slug is'),
    ({**BODY, 'slug': 'x' * 41}, 'slug is'),
    ({**BODY, 'purpose': ''}, 'purpose is'),
    ({**BODY, 'purpose': 'x' * 301}, 'purpose is'),
    ({**BODY, 'title': 'line\nbreak'}, 'title is'),
    ({**BODY, 'expected_version': 0}, 'expected_version'),
    ({**BODY, 'caps': []}, 'caps is'),
], ids=['extra key', 'a role no card is made of', 'version 0', 'bad connection', 'slug dash', 'slug long',
        'no purpose', 'purpose long', 'title not plain', 'expected 0', 'caps list'])
def test_a_request_is_refused_for_anything_off_its_shape(body: dict[str, Any], said: str) -> None:
    with pytest.raises(CardError, match=said):
        check_request(body, ROLES)


def test_a_card_id_is_the_role_and_a_slug_within_64_characters() -> None:
    assert card_id('commit-reviewer', 'strict-2') == 'commit-reviewer-strict-2'
    longest = card_id('commit-reviewer', 'a' * 40)
    assert CARD_ID.fullmatch(longest)
    assert len(longest) == 56


def test_a_card_is_written_once_and_its_next_version_names_the_one_it_follows(skills: SkillStore) -> None:
    skill = accepted(skills)
    cards = AgentCardStore(skills.client, TABLE)
    first = make(check_request(BODY, ROLES), skill)
    cards.save(first, expected_version=0, by='admin-sub', username='alice')
    assert (cards.current_version('fixer-python'), cards.version('fixer-python', 1)) == (1, first)
    with pytest.raises(CardError, match='a card with that id exists') as exists:
        cards.save(first, expected_version=0, by='admin-sub', username='alice')
    assert str(exists.value) == EXISTS
    second = make(check_request({**BODY, 'purpose': 'Fixes Python bugs.', 'expected_version': 1}, ROLES), skill, 2)
    cards.save(second, expected_version=1, by='admin-sub', username='bob')
    with pytest.raises(CardError) as stale:   # (made from v1 again, after v2: refused, never over it)
        cards.save({**second, 'version': 2}, expected_version=1, by='admin-sub', username='carol')
    assert str(stale.value) == CHANGED
    assert [record['version'] for record in cards.versions('fixer-python')] == [2, 1]
    assert [(event['version'], event['event'], event['by']) for event in cards.events('fixer-python')] == [
        (2, 'created', 'bob'), (1, 'created', 'alice')]
    assert cards.listing() == [second]
    with pytest.raises(CardError) as missing:
        cards.version('fixer-python', 3)
    assert missing.value.kind == 'not_found'
