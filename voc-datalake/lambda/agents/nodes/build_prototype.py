"""build_prototype — a clickable prototype from the run's PR/FAQ / PRD."""
from __future__ import annotations

from agents.nodes.base import NodeContext
from agents.nodes.prototypes import finish_prototype, start_prototype


def start(ctx: NodeContext) -> dict:
    return start_prototype(ctx)


def finish(ctx: NodeContext, job: dict) -> dict:
    return finish_prototype(ctx, job)
