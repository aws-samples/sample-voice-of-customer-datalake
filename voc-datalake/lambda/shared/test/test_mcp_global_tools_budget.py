"""The context budget of the global MCP server's ``tools/list`` (shared/mcp_global_tools.py).

Every connected client injects each tool's name, description and input schema
into the model's context before the user types. ChatGPT connectors are reported
to refuse servers whose definitions exceed about 5,000 tokens, and Anthropic
recommends on-demand tool discovery past about 10,000. This pins the WHOLE
catalogue (what an admin-minted write token is shown) under 4,000 tokens, so a
wordy description or a new tool fails here rather than in a client.

No tokenizer is a dependency of the Lambda bundle, so tokens are estimated at
3 characters each over compact JSON — schema JSON is punctuation-dense and
tokenises worse than prose, so this errs high.
"""
from __future__ import annotations

import json

from shared.mcp_global_tools import ENGINEERING_TOOLS, TOOLS

TOKEN_BUDGET = 4_000
CHARS_PER_TOKEN_ESTIMATE = 3


#: An opt-in module's tools (shared/mcp_global_tools.py ENGINEERING_TOOLS) are listed only where the module is on, so
#: they are counted on top of the default catalogue against their own ceiling, still under the clients' 5,000.
OPT_IN_TOKEN_BUDGET = 4_400


def _listed_chars(catalogue: tuple = TOOLS) -> int:
    listing = {'tools': [tool.declaration() for tool in catalogue]}
    return len(json.dumps(listing, separators=(',', ':'), ensure_ascii=False))


def test_the_whole_catalogue_fits_the_token_budget():
    estimated_tokens = _listed_chars() // CHARS_PER_TOKEN_ESTIMATE
    assert estimated_tokens <= TOKEN_BUDGET, (
        f'tools/list is ~{estimated_tokens} tokens (budget {TOKEN_BUDGET}): shorten descriptions, '
        'or fold the new operation into an existing tool as a parameter')


def test_the_catalogue_with_the_engineering_agents_on_fits_its_ceiling():
    estimated_tokens = _listed_chars((*TOOLS, *ENGINEERING_TOOLS)) // CHARS_PER_TOKEN_ESTIMATE
    assert estimated_tokens <= OPT_IN_TOKEN_BUDGET, (
        f'tools/list with the engineering agents on is ~{estimated_tokens} tokens (ceiling {OPT_IN_TOKEN_BUDGET})')
