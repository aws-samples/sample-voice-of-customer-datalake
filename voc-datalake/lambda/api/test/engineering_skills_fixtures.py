"""The arrange block shared by the Agents API's skills suites (``test_agents_engineering_skills.py``, the reads, and
``test_agents_engineering_skill_actions.py``, the actions): the engineering table on moto beside the agents tables, the
module on, the handler's DynamoDB client pointed at it, and the fictional people and coach who write the versions.
"""
from __future__ import annotations

from collections.abc import Generator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any
from unittest.mock import patch

import pytest
from agents_handler_fixtures import ADMIN, call
from agents_handler_fixtures import api as _api

from engineering.board.test.table import TABLE, create_table
from engineering.knowledge.store import Actor
from engineering.skills.model import MadeWith, Reason
from engineering.skills.store import SHARED, ScopeHead, SkillRef, SkillStore, SkillVersion
from engineering.skills.test.fixtures import RUN, SONNET, content, stricter

SKILLS = '/agents/engineering/skills'
WS = 'default'
CONN, OTHER = 'conn-harbor', 'conn-lantern'
PERSON = Actor('admin-sub', 'person', admin=True)
COACH = Actor('coach-0', 'agent', connection=CONN)
#: An MCP credential an administrator minted: delegated, so never an administrator here.
DELEGATED_ADMIN = {'sub': 'mcp:tok_1', 'cognito:username': 'alice', 'voc:acting_subject': 'admin-sub',
                   'cognito:groups': 'admins'}


@contextmanager
def engineering_skills(monkeypatch: pytest.MonkeyPatch) -> Generator[tuple[Any, SkillStore]]:
    """The tables on moto with the module on; the engineering table's low-level client and its skills store."""
    with _api():
        client = create_table()
        monkeypatch.setenv('ENGINEERING_AGENTS', 'on')
        monkeypatch.setenv('ENGINEERING_TABLE', TABLE)
        with patch('shared.aws.get_dynamodb_client', return_value=client):
            yield client, SkillStore(client, TABLE)


@dataclass
class SkillsEnv:
    """A skills suite's tables (``engineering_skills``): the low-level client and the skills store."""

    client: Any
    skills: SkillStore

    def shared(self) -> None:
        """The shared Fixer v1, a person's, accepted (no version of it seeded from a template)."""
        first = self.skills.propose_version(WS, SHARED, 'fixer', content(), proposer=PERSON, base=None,
                                            reason=Reason(comment='The first Fixer skill.'))
        self.skills.accept_version(WS, SHARED, 'fixer', first.version.version, PERSON)

    def head(self) -> ScopeHead:
        """The shared Fixer's head (``shared`` wrote it)."""
        found = self.skills.head(WS, SHARED, 'fixer')
        if found is None:
            raise AssertionError('the shared Fixer has no head')
        return found

    def proposed(self, answer: Mapping[str, Any]) -> SkillVersion:
        """The stored v2 an administrator's proposal on the shared v1 answered (its answer checked), never applied."""
        shown = answer['version']
        _expect((shown['version'], shown['status'], shown['proposed_by'], shown['base'], self.head().current_version),
                (2, 'proposed', ADMIN['sub'], {'shared': True, 'version': 1}, 1))
        return self.skills.version(WS, SHARED, 'fixer', 2)

    def expect_moved(self, answered: tuple[int, Mapping[str, Any]]) -> None:
        """A route's 409 for what the screen showed that moved (read it again), and nothing written."""
        status, answer = answered
        _expect((status, 'read it again' in answer['error'], self.head().versions), (409, True, 1), answer)

    def accept_proposed(self, lambda_context: Any) -> None:
        """The proposed v2 accepted by an administrator: the shared scope runs it."""
        status, body = call(lambda_context, 'POST', f'{SKILLS}/fixer/versions/2/accept', query={'connection': ''},
                            body={'expected_status': 'proposed', 'expected_current': 1})
        _expect((status, self.head().current_version), (200, 2), body)


def _expect(actual: object, wanted: object, answer: object = None) -> None:
    """A fixture's check (``assert`` is the tests' own): ``answer``, when given, says what came back."""
    if actual != wanted:
        raise AssertionError(f'{actual!r} != {wanted!r}' + ('' if answer is None else f' ({answer!r})'))


@contextmanager
def skills_env(monkeypatch: pytest.MonkeyPatch) -> Generator[SkillsEnv]:
    """``engineering_skills`` as a ``SkillsEnv``."""
    with engineering_skills(monkeypatch) as (client, skills):
        yield SkillsEnv(client, skills)


def propose_as_coach(skills: SkillStore) -> None:
    """The coach's proposal for CONN on the shared v1 (from a run's NO-GO), expecting to gain on slug-cut-bug."""
    skills.propose_version(WS, CONN, 'fixer', stricter(), proposer=COACH, base=SkillRef(SHARED, 1),
                           reason=Reason(RUN, 'no_go', 'The gate caught an untested change.'),
                           expected_case='slug-cut-bug', made_with=MadeWith(SONNET, 'coach-prompt/2'))
