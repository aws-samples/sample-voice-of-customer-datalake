"""The context budget of the global MCP server's ``tools/list`` (shared/mcp_global_tools.py, docs/mcp.md → Testing).

Every connected client puts each tool's name, description and input schema into the model's context
before the user types. Clients cache the list (a 2026-07-28 ``tools/list`` says so with ``ttlMs`` and
``cacheScope: "private"``; a legacy client keeps it for the session), and a client that caches its
prompt prefix pays for the list in full once per conversation, not on every turn. Past about
10,000 tokens a client is better served by searching tools on demand, and some clients refuse large
servers, so this pins the WHOLE catalogue (what an admin-minted write token is shown) under 10,000
tokens (owner decision 24, 6.10.00; 4,000 before): a wordy description or a new tool fails here rather
than in a client.

No tokenizer is a dependency of the Lambda bundle, so tokens are estimated at
3 characters each over compact JSON — schema JSON is punctuation-dense and
tokenises worse than prose, so this errs high.
"""
from __future__ import annotations

import json

from shared.mcp_global_tools import AREAS, TOOLS, area_of

TOKEN_BUDGET = 10_000
CHARS_PER_TOKEN_ESTIMATE = 3


def _listed_chars() -> int:
    listing = {'tools': [tool.declaration() for tool in TOOLS]}
    return len(json.dumps(listing, separators=(',', ':'), ensure_ascii=False))


def test_the_whole_catalogue_fits_the_token_budget():
    estimated_tokens = _listed_chars() // CHARS_PER_TOKEN_ESTIMATE
    assert estimated_tokens <= TOKEN_BUDGET, (
        f'tools/list is ~{estimated_tokens} tokens (budget {TOKEN_BUDGET}): shorten descriptions, '
        'or (past the budget) add tool search (docs/mcp.md, Tools)')


def test_every_tool_name_starts_with_its_area_and_the_list_is_grouped_by_area():
    """A client that lists or searches tools by name finds an area's tools together (feedback_, projects_, …)."""
    areas = [area_of(tool.name) for tool in TOOLS]
    assert None not in areas, [tool.name for tool in TOOLS if area_of(tool.name) is None]
    assert areas == sorted(areas, key=lambda area: AREAS.index(area or ''))
