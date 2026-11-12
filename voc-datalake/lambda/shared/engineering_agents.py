"""The one switch of the opt-in engineering agents module (tenet 7: off, it adds nothing).

Only a deployment with ``-c engineeringAgents=true`` sets ``ENGINEERING_AGENTS=on``, on the Agents API (its
``/agents/engineering/*`` routes, which also get the module's table and workspace bucket,
lib/stacks/api-assistant-lambdas.ts). Anywhere else those routes answer 404. They are admin-only, so the global MCP
server, whose tokens never act as an admin, has no engineering tool.
"""
from __future__ import annotations

import os
from typing import Final

ENGINEERING_AGENTS_ENV: Final = 'ENGINEERING_AGENTS'


def engineering_agents_on() -> bool:
    return os.environ.get(ENGINEERING_AGENTS_ENV) == 'on'
