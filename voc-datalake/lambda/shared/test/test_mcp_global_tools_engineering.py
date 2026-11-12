"""The engineering agents' MCP read tool: offered only where the module is on, and the routes it becomes."""
from __future__ import annotations

import re
from typing import Any

import pytest

from shared import mcp_global_tools as tools
from shared.engineering_agents import ENGINEERING_AGENTS_ENV
from shared.mcp_global_kit import InvalidToolArgument

ENGINEERING = tools.ENGINEERING_TOOLS[0]


def _route(args: dict[str, Any]) -> tuple[str, str, str, dict[str, Any]]:
    request = ENGINEERING.build(args, None)
    return request.domain, request.method, request.path, request.query


def test_it_is_offered_and_callable_only_where_the_engineering_agents_are_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(ENGINEERING_AGENTS_ENV, raising=False)
    assert tools.deployment_tools() == tools.TOOLS
    assert tools.deployment_tool('get_engineering_run') is None
    monkeypatch.setenv(ENGINEERING_AGENTS_ENV, 'yes')
    assert tools.deployment_tool('get_engineering_run') is None
    monkeypatch.setenv(ENGINEERING_AGENTS_ENV, 'on')
    assert tools.deployment_tools() == (*tools.TOOLS, ENGINEERING)
    assert tools.deployment_tool('get_engineering_run') is ENGINEERING
    assert tools.deployment_tool('get_feedback') is tools.TOOLS_BY_NAME['get_feedback']


def test_its_declaration() -> None:
    declaration = ENGINEERING.declaration()
    assert declaration['name'] == 'get_engineering_run'
    assert declaration['inputSchema']['required'] == ['run_id']
    assert set(declaration['inputSchema']['properties']) == {'run_id', 'view', 'after', 'limit', 'level', 'subject',
                                                             'version'}
    assert (ENGINEERING.write, ENGINEERING.admin_only, ENGINEERING.project_scoped) == (False, False, False)


@pytest.mark.parametrize(('args', 'route'), [
    ({'run_id': 'R1'}, ('agents', 'GET', '/agents/engineering/R1/board', {})),
    ({'run_id': 'R1', 'view': 'board'}, ('agents', 'GET', '/agents/engineering/R1/board', {})),
    ({'run_id': 'R1', 'view': 'conversation'},
     ('agents', 'GET', '/agents/engineering/R1/conversation', {'after': 0, 'limit': 50})),
    ({'run_id': 'R1', 'view': 'conversation', 'after': 7, 'limit': 200},
     ('agents', 'GET', '/agents/engineering/R1/conversation', {'after': 7, 'limit': 200})),
    ({'run_id': 'R1', 'view': 'reports'}, ('agents', 'GET', '/agents/engineering/R1/reports', {})),
    ({'run_id': 'R1', 'view': 'report', 'level': 'pr', 'subject': '42'},
     ('agents', 'GET', '/agents/engineering/R1/reports/pr/42', {})),
    ({'run_id': 'R1', 'view': 'report', 'level': 'goal', 'subject': 'R1', 'version': 3},
     ('agents', 'GET', '/agents/engineering/R1/reports/goal/R1', {'version': 3})),
])
def test_each_view_is_its_route(args: dict[str, Any], route: tuple[str, str, str, dict[str, Any]]) -> None:
    assert _route(args) == route


@pytest.mark.parametrize(('args', 'message'), [
    ({}, 'run_id is required and must be an id (letters, digits, _ and -)'),
    ({'run_id': '../x'}, 'run_id is required and must be an id (letters, digits, _ and -)'),
    ({'run_id': 'R1', 'view': 'tasks'}, 'view is one of board, conversation, reports, report'),
    ({'run_id': 'R1', 'view': 'conversation', 'limit': 201}, 'limit must be an integer between 1 and 200'),
    ({'run_id': 'R1', 'view': 'conversation', 'after': -1}, 'after must be an integer between 0 and 99999998'),
    ({'run_id': 'R1', 'view': 'report', 'subject': '42'}, 'level is one of commit, pr, goal for view report'),
    ({'run_id': 'R1', 'view': 'report', 'level': 'pr'},
     'subject is required and must be an id (letters, digits, _ and -)'),
    ({'run_id': 'R1', 'view': 'report', 'level': 'pr', 'subject': '42', 'version': 0},
     'version must be an integer between 1 and 9999'),
])
def test_bad_arguments_are_refused_with_what_to_change(args: dict[str, Any], message: str) -> None:
    with pytest.raises(InvalidToolArgument, match=f'^{re.escape(message)}\\Z'):
        ENGINEERING.build(args, None)
