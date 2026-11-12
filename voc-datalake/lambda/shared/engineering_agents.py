"""The one switch of the opt-in engineering agents module (tenet 7: off, it adds nothing).

The module's own stack, deployed only with ``-c engineeringAgents=true`` (a later change of this track: until it lands
no deployment sets these), is to set ``ENGINEERING_AGENTS=on`` on every Lambda that serves the module: the Agents API
(its ``/agents/engineering/*`` routes, which also need the module's table and bucket) and the global MCP server (its
engineering tool). Anywhere else the routes answer 404 and the tool is not offered.
"""
from __future__ import annotations

import os
from typing import Final

ENGINEERING_AGENTS_ENV: Final = 'ENGINEERING_AGENTS'


def engineering_agents_on() -> bool:
    return os.environ.get(ENGINEERING_AGENTS_ENV) == 'on'
