"""The role playbooks' catalogue (shared/playbooks.py, 7.66.00): pinned to schemas/playbooks.json (the SPA's copy),
four roles of five to eight steps, every step's evidence a known one, and the PUT's checks."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from shared import playbooks
from shared.exceptions import ValidationError

SCHEMA = Path(__file__).resolve().parents[3] / 'schemas' / 'playbooks.json'


def test_the_catalogue_is_the_schema_the_spa_reads():
    schema = json.loads(SCHEMA.read_text(encoding='utf-8'))
    assert tuple(schema['roles']) == playbooks.ROLES
    assert {role: [{'id': step.id, 'path': step.path, 'evidence': step.evidence} for step in steps]
            for role, steps in playbooks.PLAYBOOKS.items()} == schema['steps']


@pytest.mark.parametrize('role', playbooks.ROLES)
def test_each_role_has_five_to_eight_steps_each_once(role):
    ids = [step.id for step in playbooks.PLAYBOOKS[role]]
    assert 5 <= len(ids) <= 8
    assert len(set(ids)) == len(ids)


def test_every_step_reads_a_known_evidence_and_links_to_a_screen():
    known = {*playbooks.SERVER_SIGNALS, *playbooks.BROWSER_EVIDENCE, None}
    for steps in playbooks.PLAYBOOKS.values():
        for step in steps:
            assert step.evidence in known, step.id
            assert step.path.startswith('/')
            assert all((step.title, step.why, step.how))


def test_a_step_shared_by_two_roles_links_to_the_same_screen_and_evidence():
    seen: dict[str, tuple[str, str | None]] = {}
    for steps in playbooks.PLAYBOOKS.values():
        for step in steps:
            assert seen.setdefault(step.id, (step.path, step.evidence)) == (step.path, step.evidence), step.id


def test_every_known_evidence_is_read_by_some_step():
    used = {step.evidence for steps in playbooks.PLAYBOOKS.values() for step in steps}
    assert set(playbooks.SERVER_SIGNALS) | set(playbooks.BROWSER_EVIDENCE) <= used


@pytest.mark.parametrize(('role', 'signals'), [
    ('product', ('brief_subscribed', 'objectives_set')),
    ('scrum_master', ('brief_subscribed', 'feedback_form_configured')),
    ('qa', ('feedback_form_configured', 'form_test_response')),
    ('engineering', ()),
    (None, ()),
    ('designer', ()),
    (7, ()),
])
def test_the_server_signals_a_playbook_reads(role, signals):
    assert playbooks.server_signals_of(role) == signals


@pytest.mark.parametrize('value', [*playbooks.ROLES, None])
def test_a_known_role_or_none_is_a_choice(value):
    assert playbooks.validate_role(value) == value


@pytest.mark.parametrize('value', ['designer', '', 'QA', 3, ['qa']])
def test_any_other_role_is_refused(value):
    with pytest.raises(ValidationError, match='playbook must be one of: product, scrum_master, qa, engineering, or null'):
        playbooks.validate_role(value)


def test_ticks_are_known_step_ids_sorted_once():
    assert playbooks.validate_done(['test_form', 'ask_assistant', 'test_form']) == ['ask_assistant', 'test_form']
    assert playbooks.validate_done([]) == []


@pytest.mark.parametrize(('value', 'message'), [
    ('test_form', 'playbook_done must be a list of at most 40 step ids'),
    (['ask_assistant'] * 41, 'playbook_done must be a list of at most 40 step ids'),
    (['fly_to_the_moon'], 'playbook_done names a step no playbook has'),
    ([7], 'playbook_done names a step no playbook has'),
])
def test_bad_ticks_are_refused(value, message):
    with pytest.raises(ValidationError, match=message):
        playbooks.validate_done(value)
