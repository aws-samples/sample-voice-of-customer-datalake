"""A role's bundled template against a skills scope, and its adoption (7.50.00, Skills → "Template updated"):
``GET /agents/engineering/skills/<role>/template`` and ``POST …/skills/<role>/template/adopt``
(engineering/skills/views.py ``SkillViews.template``, engineering/skills/actions.py ``SkillActions.adopt_template``).

Administrators acting for themselves only (a plain user and a delegated MCP credential get 403), 404 while the module
is off. The read answers the template, the scope's current version, the template's record and its diff from the version
the scope runs. An adoption is a person's PROPOSAL (provenance ``template``), never applied: the scope's current version
stays until an administrator accepts it as any other; 409 when what the screen showed moved, or when no newer template
is waiting.
"""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from agents_handler_fixtures import ADMIN, USER
from agents_handler_fixtures import call as _call
from engineering_skills_fixtures import DELEGATED_ADMIN, SKILLS, SkillsEnv, skills_env

from engineering.skills.templates import TemplateSkill, bundled
from engineering.skills.test.fixtures import content


def _template(role: str) -> TemplateSkill:
    found = bundled().skill(role)
    assert found is not None
    return found


FIXER = _template('fixer')


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[SkillsEnv]:
    with skills_env(monkeypatch) as found:
        yield found


def _get(lambda_context: Any, role: str = 'fixer', claims: dict[str, Any] = ADMIN) -> tuple[int, dict[str, Any]]:
    return _call(lambda_context, 'GET', f'{SKILLS}/{role}/template', query={'connection': ''}, claims=claims)


def _adopt(lambda_context: Any, body: dict[str, Any], role: str = 'fixer',
           claims: dict[str, Any] = ADMIN) -> tuple[int, dict[str, Any]]:
    return _call(lambda_context, 'POST', f'{SKILLS}/{role}/template/adopt', body=body, query={'connection': ''},
                 claims=claims)


ADOPT = {'expected_current': 1, 'template_version': FIXER.version}


def test_the_template_is_read_against_the_version_the_scope_runs(lambda_context: Any, env: SkillsEnv) -> None:
    env.shared()
    status, answer = _get(lambda_context)
    assert status == 200, answer
    assert answer['template'] == {'version': FIXER.version, 'label': FIXER.label, 'newer': True}
    assert (answer['connection'], answer['role'], answer['current_version']) == ('', 'fixer', 1)
    assert answer['record']['tool_policy'] == list(FIXER.skill.tool_policy)
    assert answer['record']['model'] == FIXER.skill.model
    # (its diff from the shared v1: the person's tools against the template's)
    assert answer['diff']['first'] is False
    assert set(answer['diff']['tools_added']) == set(FIXER.skill.tool_policy) - set(content().tool_policy)


@pytest.mark.usefixtures('env')
def test_a_scope_with_no_version_reads_the_template_as_its_first_and_none_newer(lambda_context: Any) -> None:
    status, answer = _get(lambda_context)
    assert (status, answer['current_version'], answer['diff']['first'], answer['template']['newer']) == (
        200, 0, True, False)


def test_a_role_with_no_template_is_404(lambda_context: Any, env: SkillsEnv) -> None:
    env.shared()
    assert _get(lambda_context, 'coach')[0] == 404
    assert _adopt(lambda_context, ADOPT, 'coach')[0] == 404


def test_an_adoption_is_a_persons_proposal_never_applied_until_an_administrator_accepts_it(
        lambda_context: Any, env: SkillsEnv) -> None:
    env.shared()
    status, answer = _adopt(lambda_context, ADOPT)
    assert status == 200, answer
    stored = env.proposed(answer)
    assert (stored.provenance, stored.template_version, stored.reason.comment) == (
        'template', FIXER.version, f'Adopted the template {FIXER.label}.')
    assert tuple(stored.skill.content.tool_policy) == tuple(FIXER.skill.tool_policy)
    # The template is waiting no more; once accepted as any proposal, it is what the scope runs.
    assert _get(lambda_context)[1]['template']['newer'] is False
    assert _adopt(lambda_context, ADOPT)[0] == 409
    env.accept_proposed(lambda_context)


@pytest.mark.parametrize('body', [{**ADOPT, 'expected_current': 0}, {**ADOPT, 'template_version': FIXER.version + 1}],
                         ids=['the current version moved', 'the template moved'])
def test_what_the_screen_showed_that_moved_is_409_and_nothing_is_written(lambda_context: Any, env: SkillsEnv,
                                                                         body: dict[str, Any]) -> None:
    env.shared()
    env.expect_moved(_adopt(lambda_context, body))


@pytest.mark.parametrize('body', [{'expected_current': 1}, {**ADOPT, 'template_version': 'v3'},
                                  {**ADOPT, 'template_version': True}, {**ADOPT, 'extra': 1},
                                  {**ADOPT, 'expected_current': -1}],
                         ids=['no template version', 'a text', 'a flag', 'an extra field', 'a negative current'])
def test_a_body_off_its_shape_is_400(lambda_context: Any, env: SkillsEnv, body: dict[str, Any]) -> None:
    env.shared()
    assert _adopt(lambda_context, body)[0] == 400


@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN], ids=['plain user', 'MCP credential of an admin'])
def test_both_are_403_for_anyone_but_an_administrator_acting_for_themselves(lambda_context: Any, env: SkillsEnv,
                                                                            claims: dict[str, Any]) -> None:
    env.shared()
    assert (_get(lambda_context, claims=claims)[0], _adopt(lambda_context, ADOPT, claims=claims)[0]) == (403, 403)
    assert env.head().versions == 1


@pytest.mark.usefixtures('env')
@pytest.mark.parametrize('missing', ['ENGINEERING_AGENTS', 'ENGINEERING_TABLE'])
def test_both_are_404_while_the_module_is_off(lambda_context: Any, monkeypatch: pytest.MonkeyPatch,
                                             missing: str) -> None:
    monkeypatch.delenv(missing)
    for claims in (ADMIN, USER):
        assert (_get(lambda_context, claims=claims)[0], _adopt(lambda_context, ADOPT, claims=claims)[0]) == (404, 404)
