"""write_prd — the PRD for the run's problems (worker)."""
from __future__ import annotations

from agents.nodes.base import NodeContext
from agents.nodes.documents import finish_document, start_document


def start(ctx: NodeContext) -> dict:
    return start_document(ctx, 'prd')


def finish(ctx: NodeContext, job: dict) -> dict:
    return finish_document(ctx, job, 'prd')
