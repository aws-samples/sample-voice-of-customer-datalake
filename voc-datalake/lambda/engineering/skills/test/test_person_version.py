"""A person's own skill version on moto (7.52.00, ``SkillActions.propose``): proposed on the version the scope runs,
with that version's tools, model and harness, never applied; refused when the scope runs another version, or when it
changes nothing. The record is the store's version row: the person, when, its provenance, its base and why."""
from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import pytest

from engineering.board.test.table import TABLE, engineering_table
from engineering.knowledge.store import Actor
from engineering.skills.actions import SkillActions
from engineering.skills.model import Reason, SkillError
from engineering.skills.store import PROPOSED, SHARED, SkillConflict, SkillStore
from engineering.skills.test.fixtures import content
from engineering.skills.views import bundled_content

WS = 'default'
AT = datetime(2026, 11, 17, 9, 30, tzinfo=UTC)
ADMIN = Actor('admin-sub-1', 'person', admin=True)
BODY = {'base_version': 1, 'instructions': 'Fix the named bug with a test that fails without the fix.',
        'examples': [{'situation': 'A boundary fails.', 'action': 'Fix it and test the boundary.'}],
        'summary': 'A failing test first'}


@pytest.fixture
def skills() -> Iterator[SkillStore]:
    with engineering_table() as client:
        store = SkillStore(client, TABLE, now=lambda: AT)
        first = store.propose_version(WS, SHARED, 'fixer', content(), proposer=ADMIN, base=None,
                                      reason=Reason(comment='The first Fixer skill.'))
        store.accept_version(WS, SHARED, 'fixer', first.version.version, ADMIN)
        yield store


def test_the_version_is_the_persons_text_on_the_bases_tools_proposed_and_recorded(skills: SkillStore) -> None:
    answer = SkillActions(skills, ADMIN).propose('', 'fixer', {**BODY, 'reason': 'Fixes missed their tests.'})
    assert (answer['version']['version'], answer['version']['status']) == (2, PROPOSED)
    stored = skills.version(WS, SHARED, 'fixer', 2)
    assert (stored.provenance, stored.proposed_by, stored.created_at, stored.reason.comment) == (
        'person', ADMIN.id, AT.isoformat(), 'A failing test first\n\nFixes missed their tests.')
    assert (stored.skill.content.tool_policy, stored.skill.content.model) == (content().tool_policy, content().model)
    assert skills.head(WS, SHARED, 'fixer').current_version == 1


def test_a_scope_with_no_version_writes_on_the_roles_template(skills: SkillStore) -> None:
    answer = SkillActions(skills, ADMIN).propose('', 'builder', {**BODY, 'base_version': 0})
    stored = skills.version(WS, SHARED, 'builder', answer['version']['version'])
    assert stored.skill.content.tool_policy == bundled_content('builder').tool_policy


def test_a_moved_base_is_a_conflict_and_an_unchanged_text_is_refused(skills: SkillStore) -> None:
    actions = SkillActions(skills, ADMIN)
    with pytest.raises(SkillConflict, match='read it again'):
        actions.propose('', 'fixer', {**BODY, 'base_version': 2})
    same = {**BODY, 'instructions': content().instructions,
            'examples': [{'situation': e.situation, 'action': e.action} for e in content().examples]}
    with pytest.raises(SkillError, match='changes nothing'):
        actions.propose('', 'fixer', same)
    assert skills.head(WS, SHARED, 'fixer').versions == 1
