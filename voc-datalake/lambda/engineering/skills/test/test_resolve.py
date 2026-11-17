"""Which skill a launch runs, and the record a session's label names (skills/resolve.py), on the skills store (moto)."""
from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import pytest

from engineering.board.test.table import TABLE, engineering_table
from engineering.knowledge.store import Actor
from engineering.runtime.harness.skills import SKILLS
from engineering.skills.model import Reason, SkillError
from engineering.skills.resolve import (
    Resolved,
    pinned_version,
    record_for_label,
    resolve_launch,
    step_pin,
)
from engineering.skills.store import SHARED, SkillConflict, SkillForbidden, SkillNotFound, SkillStore
from engineering.skills.templates import BundleTemplates
from engineering.skills.test.fixtures import content, stricter

WS, CONN, OTHER = 'default', 'conn-harbor', 'conn-lantern'
ADMIN = Actor('admin-sub-1', 'person', admin=True)
WHY = Reason(comment='A person wrote it.')
TEMPLATES = BundleTemplates.shipped()


@pytest.fixture
def store() -> Iterator[SkillStore]:
    with engineering_table() as client:
        yield SkillStore(client, TABLE, now=lambda: datetime(2026, 11, 16, tzinfo=UTC))


def accepted(store: SkillStore, connection: str, text: str = '') -> int:
    base = store.resolved(WS, connection, 'fixer')
    body = stricter() if text else content()
    proposed = store.propose_version(WS, connection, 'fixer', body, proposer=ADMIN, reason=WHY, base=base)
    return store.accept_version(WS, connection, 'fixer', proposed.version.version, ADMIN).version.version


def launch(store: SkillStore, pin: object = None, connection: str = CONN) -> Resolved | None:
    return resolve_launch('fixer', connection=connection, pin=pin, rows=store, templates=TEMPLATES)


def test_with_no_version_in_the_store_a_launch_runs_the_roles_template(store: SkillStore) -> None:
    resolved = launch(store)
    assert resolved is not None
    assert resolved.label == f'fixer@template-{SKILLS["fixer"].version}'
    assert resolved.skill == SKILLS['fixer']
    # A role with no template and no version: nothing to run.
    assert resolve_launch('coach', connection=CONN, pin=None, rows=store, templates=TEMPLATES) is None


def test_the_shared_version_comes_before_the_template_and_the_connections_before_the_shared(
        store: SkillStore) -> None:
    accepted(store, SHARED)
    shared = launch(store)
    assert shared is not None
    assert shared.label == 'fixer@1'
    accepted(store, CONN, 'stricter')
    own = launch(store)
    assert own is not None
    assert own.label == f'fixer@{CONN}/1'
    assert 'whole test suite' in own.skill.instructions
    # Another connection still runs the shared one.
    other = launch(store, connection=OTHER)
    assert other is not None
    assert other.label == 'fixer@1'


def test_a_steps_pin_runs_that_accepted_version_of_the_connection_else_the_shared_skill(store: SkillStore) -> None:
    accepted(store, SHARED)
    accepted(store, SHARED, 'stricter')
    pinned = launch(store, 'v1')
    assert pinned is not None
    assert pinned.label == 'fixer@1'
    accepted(store, CONN)
    assert (launch(store, 'v1') or pinned).label == f'fixer@{CONN}/1'
    with pytest.raises(SkillNotFound, match='pins fixer v9'):
        launch(store, 'v9')
    # A proposed version is never run, pinned or not.
    store.propose_version(WS, CONN, 'fixer', stricter(), proposer=ADMIN, reason=WHY,
                          base=store.resolved(WS, CONN, 'fixer'))
    with pytest.raises(SkillConflict, match='not accepted'):
        launch(store, 'v2')
    assert pinned_version('latest') is None
    assert pinned_version(None) is None
    with pytest.raises(SkillError):
        pinned_version('3')


def test_a_label_names_exactly_one_record_and_only_for_its_role_and_connection(store: SkillStore) -> None:
    accepted(store, SHARED)
    accepted(store, CONN, 'stricter')

    def served(label: str, role: str = 'fixer', connection: str = CONN) -> Resolved:
        return record_for_label(label, role=role, connection=connection, rows=store, templates=TEMPLATES)

    assert served('fixer@1').skill.instructions == content().instructions
    assert 'whole test suite' in served(f'fixer@{CONN}/1').skill.instructions
    template = served(f'fixer@template-{SKILLS["fixer"].version}')
    assert template.answer() == {'label': f'fixer@template-{SKILLS["fixer"].version}',
                                 'record': SKILLS['fixer'].to_record()}
    with pytest.raises(SkillForbidden):
        served(f'fixer@{CONN}/1', connection=OTHER)
    with pytest.raises(SkillForbidden):
        served('fixer@1', role='hunter')
    with pytest.raises(SkillForbidden):
        served(f'hunter@template-{SKILLS["hunter"].version}')
    with pytest.raises(SkillConflict, match='no longer'):
        served('fixer@template-99')
    with pytest.raises(SkillNotFound):
        served('fixer@7')
    with pytest.raises(SkillNotFound):
        served('')


def test_a_steps_pin_is_read_from_its_agent_node_only() -> None:
    definition = {'nodes': [
        {'id': 'hunt', 'type': 'agent', 'data': {'params': {'role': 'hunter', 'skill_version': 'v3'}}},
        {'id': 'board', 'type': 'board', 'data': {'params': {'claimers': ['fixer'], 'skill_version': 'v9'}}},
    ]}
    assert step_pin(definition, 'hunt', 'hunter') == 'v3'
    assert step_pin(definition, 'hunt', 'fixer') is None
    assert step_pin(definition, 'board', 'fixer') is None
    assert step_pin(None, 'hunt', 'hunter') is None
    assert step_pin(definition, '', 'hunter') is None


def test_a_gates_runner_and_final_go_pin_their_roles_version_and_a_card_step_is_recorded() -> None:
    """7.52.00: a quality gate's ``runner`` / ``final_go`` naming its role at a version pins it (a card of it, or
    ``latest``, pins none here); an agent step from a Registry card names it on the session row (``step_card``)."""
    from engineering.skills.resolve import step_card

    definition = {'nodes': [
        {'id': 'gate', 'type': 'quality_gate', 'data': {'params': {'runner': 'gate-runner@v4',
                                                                    'final_go': 'final-go-strict@v2'}}},
        {'id': 'fix', 'type': 'agent', 'data': {'params': {'role': 'fixer', 'skill_version': 'v3',
                                                           'card': 'fixer-python@v2'}}},
    ]}
    assert step_pin(definition, 'gate', 'gate-runner') == 'v4'
    assert step_pin(definition, 'gate', 'final-go') is None
    assert step_pin(definition, 'gate', 'fixer') is None
    assert step_pin({'nodes': [{'id': 'gate', 'type': 'quality_gate', 'data': {'params': {}}}]}, 'gate',
                    'gate-runner') is None
    assert step_card(definition, 'fix', 'fixer') == {'card': 'fixer-python', 'card_version': '2'}
    assert step_card(definition, 'fix', 'hunter') == {}
    assert step_card(definition, 'gate', 'gate-runner') == {}
