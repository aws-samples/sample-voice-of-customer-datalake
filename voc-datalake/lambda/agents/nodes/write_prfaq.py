"""write_prfaq — the PR/FAQ for the run's problems (worker)."""
from __future__ import annotations

from agents.nodes.base import NodeContext
from agents.nodes.documents import finish_document, start_document


def start(ctx: NodeContext) -> dict:
    return start_document(ctx, 'prfaq')


def finish(ctx: NodeContext, job: dict) -> dict:
    return finish_document(ctx, job, 'prfaq')
