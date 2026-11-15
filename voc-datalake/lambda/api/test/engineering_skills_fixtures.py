"""The arrange block shared by the Agents API's skills suites (``test_agents_engineering_skills.py``, the reads, and
``test_agents_engineering_skill_actions.py``, the actions): the engineering table on moto beside the agents tables, the
module on, the handler's DynamoDB client pointed at it, and the fictional people and coach who write the versions.
"""
from __future__ import annotations

from collections.abc import Generator
from contextlib import contextmanager
from typing import Any
from unittest.mock import patch

import pytest
from agents_handler_fixtures import api as _api

from engineering.board.test.table import TABLE, create_table
from engineering.knowledge.store import Actor
from engineering.skills.model import MadeWith, Reason
from engineering.skills.store import SHARED, SkillRef, SkillStore
from engineering.skills.test.fixtures import RUN, SONNET, stricter

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


def propose_as_coach(skills: SkillStore) -> None:
    """The coach's proposal for CONN on the shared v1 (from a run's NO-GO), expecting to gain on slug-cut-bug."""
    skills.propose_version(WS, CONN, 'fixer', stricter(), proposer=COACH, base=SkillRef(SHARED, 1),
                           reason=Reason(RUN, 'no_go', 'The gate caught an untested change.'),
                           expected_case='slug-cut-bug', made_with=MadeWith(SONNET, 'coach-prompt/2'))
