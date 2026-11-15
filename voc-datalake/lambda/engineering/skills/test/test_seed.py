"""The shared skill of each role starts from its shipped record (runtime/harness/skills.py): an administrator's seed."""
from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import pytest

from engineering.board.test.table import TABLE, engineering_table
from engineering.connectors.identity import AGENT_ROLES
from engineering.knowledge.store import Actor
from engineering.runtime.harness.skills import SKILLS
from engineering.skills.model import Reason, Skill, SkillContent, SkillError
from engineering.skills.store import ACCEPTED, SHARED, SkillConflict, SkillForbidden, SkillStore, VersionPage

WS = 'default'
ADMIN = Actor('admin-sub-1', 'person', admin=True)
AT = datetime(2026, 11, 14, 9, 0, tzinfo=UTC)


@pytest.fixture
def store() -> Iterator[SkillStore]:
    with engineering_table() as client:
        yield SkillStore(client, TABLE, now=lambda: AT)


@pytest.mark.parametrize('role', sorted(SKILLS))
def test_each_roles_shared_skill_starts_from_its_shipped_record(store: SkillStore, role: str) -> None:
    shipped = SKILLS[role]
    seeded = store.seed_shared(WS, role, by=ADMIN)
    assert seeded is not None
    version = seeded.version
    assert (version.label, version.status, version.accepted_by, version.base) == (f'{role}@1', ACCEPTED, ADMIN.id,
                                                                                  None)
    assert version.reason.comment == f'Seeded from the shipped skill {role}@{shipped.version}.'
    assert version.skill.to_record() == {**shipped.to_record(), 'version': 1}
    # Every connection reads it until it has a version of its own; a second seed writes nothing.
    current = store.current(WS, 'conn-harbor', role)
    assert current is not None
    assert (current.connection, current.version) == (SHARED, 1)
    assert store.seed_shared(WS, role, by=ADMIN) is None
    assert [found.version for found in store.versions(WS, SHARED, role).versions] == [1]


def test_a_seed_is_an_administrators_and_only_for_a_role_that_ships_a_skill(store: SkillStore) -> None:
    for actor in (Actor('member-sub-2', 'person'), Actor('coach-0', 'agent', connection='conn-harbor')):
        with pytest.raises(SkillForbidden):
            store.seed_shared(WS, 'fixer', by=actor)
    assert sorted(AGENT_ROLES - set(SKILLS)) == ['coach']
    with pytest.raises(SkillError, match='ships no skill'):
        store.seed_shared(WS, 'coach', by=ADMIN)


def test_a_shared_skill_with_any_version_is_never_seeded_over(store: SkillStore) -> None:
    content = store_content('fixer')
    store.propose_version(WS, SHARED, 'fixer', content, proposer=ADMIN, reason=Reason(comment='Mine.'), base=None)
    assert store.seed_shared(WS, 'fixer', by=ADMIN) is None
    assert store.current(WS, SHARED, 'fixer') is None   # (the proposal is not accepted: nothing is current)


def test_a_seed_racing_another_is_refused_by_the_acceptance(store: SkillStore, monkeypatch: pytest.MonkeyPatch) -> None:
    store.seed_shared(WS, 'hunter', by=ADMIN)
    # A second seed that read the history empty before the first landed: its acceptance finds a current version.
    monkeypatch.setattr(SkillStore, 'versions', lambda *_args, **_kwargs: VersionPage((), None))
    with pytest.raises(SkillConflict):
        store.seed_shared(WS, 'hunter', by=ADMIN)
    current = store.current(WS, SHARED, 'hunter')
    assert current is not None
    assert current.version == 1
    # The losing seed's proposal stays, proposed and never accepted (D1).
    monkeypatch.undo()
    assert [(found.version, found.status) for found in store.versions(WS, SHARED, 'hunter').versions] == [
        (1, 'accepted'), (2, 'proposed')]


def store_content(role: str) -> SkillContent:
    return Skill.from_record(SKILLS[role].to_record()).content
