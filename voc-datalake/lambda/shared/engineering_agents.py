"""The one switch of the opt-in engineering agents module (tenet 7: off, it adds nothing).

Only a deployment with ``-c engineeringAgents=true`` sets ``ENGINEERING_AGENTS=on``, on the Agents API (its
``/agents/engineering/*`` routes, which also get the module's table and workspace bucket,
lib/stacks/api-assistant-lambdas.ts). Anywhere else those routes answer 404. They are admin-only, so the global MCP
server, whose tokens never act as an admin, has no engineering tool.
"""
from __future__ import annotations

import os
from typing import Any, Final

from shared.exceptions import NotFoundError

ENGINEERING_AGENTS_ENV: Final = 'ENGINEERING_AGENTS'
#: The GitHub Apps' token function's name (7.45.00, voc-engineering-app-tokens): the Agents API's, for an installation's
#: read, and the github_issues ingestor's, for a deployment-wide run's sign-in with an App.
APP_TOKENS_FUNCTION_ENV: Final = 'ENGINEERING_APP_TOKENS_FUNCTION'
#: The GitHub Issues settings function's name (7.50.02, voc-engineering-issues-config): the Agents API's, for the
#: connections' follow of the deployment's GitHub Issues source (set only where that plugin is deployed).
ISSUES_CONFIG_FUNCTION_ENV: Final = 'ENGINEERING_ISSUES_CONFIG_FUNCTION'
#: The user authorizations' function's name (7.57.00, voc-engineering-user-auth): the Agents API's alone, for the code
#: exchange of a person's GitHub user authorization (engineering/connectors/user_auth.py).
USER_AUTH_FUNCTION_ENV: Final = 'ENGINEERING_USER_AUTH_FUNCTION'
#: voc-engineering's name, where the module is on (the Agents API, the broker, the agents' heartbeat: 7.47.00).
ENGINEERING_TABLE_ENV: Final = 'ENGINEERING_TABLE'
#: An engineering run's statuses (engineering/runtime/runs.py: its two live ones and the three it ends in), as the
#: runs list's filter takes them: the Agents API's route (shared/agents_engineering_run_routes.py) and the MCP tool's
#: (shared/mcp_global_tools_engineering.py).
RUN_STATUSES: Final = ('active', 'needs_human', 'done', 'failed', 'stopped')


def engineering_agents_on() -> bool:
    return os.environ.get(ENGINEERING_AGENTS_ENV) == 'on'


def require_engineering_on() -> None:
    """404 while the engineering agents are off, or on without their table (the caller is checked after)."""
    if not (engineering_agents_on() and os.environ.get(ENGINEERING_TABLE_ENV)):
        raise NotFoundError('The engineering agents are not on in this deployment')


def engineering_client_and_table() -> tuple[Any, str]:
    """A low-level DynamoDB client and voc-engineering's name (a route's, once ``require_engineering_on`` held)."""
    from shared.aws import get_dynamodb_client

    return get_dynamodb_client(), os.environ[ENGINEERING_TABLE_ENV]
