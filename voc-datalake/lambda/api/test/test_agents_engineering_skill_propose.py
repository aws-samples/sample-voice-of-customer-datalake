"""A person's own skill version (7.52.00): ``POST /agents/engineering/skills/<role>/versions?connection=``
``{base_version, instructions, examples, summary, reason?}`` (engineering/skills/actions.py ``SkillActions.propose``).

It is a PROPOSAL, written on the version the scope runs with that version's tools, model and harness (a person's edit
is the text), never applied: an administrator accepts it through the accept route as any other. 409 when the scope runs
another version than the one the screen showed; 400 for a body off its shape or a version that changes nothing; 403 for
anyone but an administrator acting for themselves; 404 while the module is off.
"""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from agents_handler_fixtures import ADMIN, USER
from agents_handler_fixtures import call as _call
from engineering_skills_fixtures import DELEGATED_ADMIN, SKILLS, SkillsEnv, skills_env

from engineering.skills.test.fixtures import content

EXAMPLES = [{'situation': 'A test fails on a boundary.', 'action': 'Fix the comparison and add the boundary test.'}]


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[SkillsEnv]:
    with skills_env(monkeypatch) as found:
        yield found


def _propose(lambda_context: Any, body: dict[str, Any], *, connection: str = '',
             claims: dict[str, Any] = ADMIN) -> tuple[int, dict[str, Any]]:
    return _call(lambda_context, 'POST', f'{SKILLS}/fixer/versions', body=body, query={'connection': connection},
                 claims=claims)


BODY = {'base_version': 1, 'instructions': 'Fix the bug the task names, with a test that fails without the fix.',
        'examples': EXAMPLES, 'summary': 'Ask for a failing test first', 'reason': 'Fixes kept missing their tests.'}


def test_a_persons_version_is_proposed_on_the_one_the_scope_runs_and_never_applied(lambda_context: Any,
                                                                                    env: SkillsEnv) -> None:
    env.shared()
    status, answer = _propose(lambda_context, BODY)
    assert status == 201, answer
    stored = env.proposed(answer)
    # (the record: who and when on the version row, its provenance, its base and why; the text is the person's,
    # the tools, model and harness the base's)
    assert (stored.provenance, stored.reason.comment) == (
        'person', 'Ask for a failing test first\n\nFixes kept missing their tests.')
    assert (stored.skill.content.instructions, [e.situation for e in stored.skill.content.examples]) == (
        BODY['instructions'], ['A test fails on a boundary.'])
    base = content()
    assert (stored.skill.content.tool_policy, stored.skill.content.model, stored.skill.content.harness) == (
        base.tool_policy, base.model, base.harness)
    env.accept_proposed(lambda_context)


def test_a_connection_with_no_version_of_its_own_proposes_on_the_shared_one(lambda_context: Any,
                                                                           env: SkillsEnv) -> None:
    env.shared()
    status, answer = _propose(lambda_context, BODY, connection='shop')
    assert status == 201, answer
    assert (answer['connection'], answer['version']['version'], answer['version']['base']) == (
        'shop', 1, {'shared': True, 'version': 1})


@pytest.mark.parametrize('base', [0, 2], ids=['none shown', 'a later one shown'])
def test_a_base_that_is_not_the_version_the_scope_runs_is_409_and_nothing_is_written(lambda_context: Any,
                                                                                      env: SkillsEnv,
                                                                                      base: int) -> None:
    env.shared()
    env.expect_moved(_propose(lambda_context, {**BODY, 'base_version': base}))


@pytest.mark.parametrize('body', [
    {**BODY, 'base_version': True}, {**BODY, 'base_version': -1}, {**BODY, 'summary': ''},
    {**BODY, 'summary': 'two\nlines'}, {**BODY, 'summary': 'x' * 201}, {**BODY, 'examples': [{'situation': 'x'}]},
    {**BODY, 'instructions': 3}, {**BODY, 'model': 'other'}, {k: v for k, v in BODY.items() if k != 'summary'},
    {**BODY, 'instructions': content().instructions,
     'examples': [{'situation': e.situation, 'action': e.action} for e in content().examples]},
], ids=['a flag', 'a negative base', 'no summary', 'a two-line summary', 'a long summary', 'an example off its shape',
        'instructions not text', 'a model', 'the summary left out', 'nothing changed'])
def test_a_body_off_its_shape_or_that_changes_nothing_is_400(lambda_context: Any, env: SkillsEnv,
                                                             body: dict[str, Any]) -> None:
    env.shared()
    assert _propose(lambda_context, body)[0] == 400
    assert env.head().versions == 1


@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN], ids=['a plain user', 'a delegated admin credential'])
def test_it_is_403_for_anyone_but_an_administrator_acting_for_themselves(lambda_context: Any, env: SkillsEnv,
                                                                         claims: dict[str, Any]) -> None:
    env.shared()
    assert _propose(lambda_context, BODY, claims=claims)[0] == 403
    assert env.head().versions == 1


def test_it_is_404_while_the_module_is_off(lambda_context: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('ENGINEERING_AGENTS', raising=False)
    assert _propose(lambda_context, BODY)[0] == 404
