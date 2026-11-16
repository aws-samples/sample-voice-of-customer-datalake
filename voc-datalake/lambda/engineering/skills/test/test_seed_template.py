"""The shared skill seeded from its bundled template (7.50.00), every version's provenance, and the history's view of
the template ("Template updated")."""
from __future__ import annotations

from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime

import pytest

from engineering.board.test.table import TABLE, engineering_table
from engineering.knowledge.store import Actor
from engineering.runtime.harness.skills import SKILLS
from engineering.skills.actions import SkillActions
from engineering.skills.model import Reason
from engineering.skills.store import SHARED, SkillForbidden, SkillStore
from engineering.skills.templates import TemplateSkill
from engineering.skills.test.fixtures import stricter
from engineering.skills.views import SkillViews, template_view

WS = 'default'
ADMIN = Actor('admin-sub-1', 'person', admin=True)
FIXER = TemplateSkill('fixer', SKILLS['fixer'].version, SKILLS['fixer'])


@pytest.fixture
def store() -> Iterator[SkillStore]:
    with engineering_table() as client:
        yield SkillStore(client, TABLE, now=lambda: datetime(2026, 11, 16, tzinfo=UTC))


def test_a_template_seeds_the_shared_skill_once_accepted_and_named_as_a_templates(store: SkillStore) -> None:
    seeded = store.seed_from_template(WS, 'fixer', FIXER, by=ADMIN)
    assert seeded is not None
    version = seeded.version
    assert (version.version, version.status, version.provenance, version.template_version) == (
        1, 'accepted', 'template', FIXER.version)
    assert version.skill.content.tool_policy == FIXER.skill.tool_policy
    assert version.reason.comment == f'Seeded from the template {FIXER.label}.'
    # Never over a history; never by anyone but an administrator; never another role's template.
    assert store.seed_from_template(WS, 'fixer', FIXER, by=ADMIN) is None
    with pytest.raises(SkillForbidden):
        store.seed_from_template(WS, 'hunter', TemplateSkill('hunter', 1, SKILLS['hunter']),
                                 by=Actor('member', 'person'))
    with pytest.raises(Exception, match='not a template of the hunter role'):
        store.seed_from_template(WS, 'hunter', FIXER, by=ADMIN)


def test_every_new_version_names_how_it_was_made(store: SkillStore) -> None:
    store.seed_from_template(WS, 'fixer', FIXER, by=ADMIN)
    person = store.propose_version(WS, SHARED, 'fixer', stricter(), proposer=ADMIN, reason=Reason(comment='x'),
                                   base=store.resolved(WS, SHARED, 'fixer'))
    assert (person.version.provenance, person.version.template_version) == ('person', 0)
    store.accept_version(WS, SHARED, 'fixer', person.version.version, ADMIN)
    back = store.roll_back_to(WS, SHARED, 'fixer', 1, ADMIN)
    assert (back.version.provenance, back.version.template_version) == ('rollback', FIXER.version)
    lines = store.lines(WS, SHARED, 'fixer').lines
    assert [(line.version, line.provenance) for line in lines] == [(3, 'rollback'), (2, 'person'), (1, 'template')]


def test_the_history_says_when_a_newer_template_than_the_scopes_is_bundled(store: SkillStore,
                                                                         monkeypatch: pytest.MonkeyPatch) -> None:
    from engineering.skills import views as views_module
    from engineering.skills.templates import BundleTemplates
    templates = BundleTemplates.shipped()
    monkeypatch.setattr(views_module, 'bundled', lambda: templates)
    assert template_view('fixer', ()) == {'version': FIXER.version, 'label': FIXER.label, 'newer': False}
    store.seed_from_template(WS, 'fixer', FIXER, by=ADMIN)
    history = SkillViews(store.client, TABLE).history('', 'fixer', '')
    assert history['template'] == {'version': FIXER.version, 'label': FIXER.label, 'newer': False}
    newer = BundleTemplates({'fixer': replace(FIXER, version=FIXER.version + 1)})
    monkeypatch.setattr(views_module, 'bundled', lambda: newer)
    assert SkillViews(store.client, TABLE).history('', 'fixer', '')['template']['newer'] is True
    assert template_view('coach', ()) is None


def test_an_administrators_skills_visit_seeds_a_role_with_no_history(store: SkillStore) -> None:
    actions = SkillActions(store, ADMIN)
    seeded = actions.seed_template('mapper')
    assert seeded is not None
    assert seeded['version'] == 1
    assert actions.seed_template('mapper') is None
    assert actions.seed_template('coach') is None
