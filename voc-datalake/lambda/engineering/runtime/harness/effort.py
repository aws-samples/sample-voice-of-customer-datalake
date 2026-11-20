"""The effort each Claude model runs at, on every harness: Converse sends it (``output_config.effort``), Kiro selects
it (``session/set_config_option`` ``effortLevel``). Standard library only.

Effort is Claude's main control for how much it thinks, and with it quality, latency and cost. Without one, each harness
falls back to its own default, and those differ (Bedrock's is the model's API default; Kiro's followed the session's
earlier choices), so the same role could think more on one harness than on the other. Each level here is the model's
API default (https://platform.claude.com/docs/en/build-with-claude/effort): what the Converse loop ran before it was
pinned. Change one only with an eval sweep that shows quality holds at the new level.
"""
from __future__ import annotations

from typing import Final

#: The levels Claude takes, cheapest first.
EFFORT_LEVELS: Final = ('low', 'medium', 'high', 'xhigh', 'max')

#: Each Claude model's effort, by its Bedrock id; a model not named runs at its own default.
CLAUDE_EFFORT: Final = {
    'global.anthropic.claude-opus-5-5': 'medium',
    'global.anthropic.claude-sonnet-5-5': 'high',
    'global.anthropic.claude-haiku-5-5': 'medium',
}


def claude_effort(model_id: str) -> str | None:
    """The effort ``model_id`` runs at, None for a model this table does not name (or names at a level Claude does not
    take, which no request carries)."""
    level = CLAUDE_EFFORT.get(model_id)
    return level if level in EFFORT_LEVELS else None
