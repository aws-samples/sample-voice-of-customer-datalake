"""revise_document — the next version of the PR/FAQ or PRD, from the conductor's brief.

``params.target`` names the document (default: what the personas last reviewed,
else the PR/FAQ). The brief synthesised from the persona objections reaches
this crewmate only through the conductor's envelope.
"""
from __future__ import annotations

from agents.nodes.base import NodeContext, NodeFailure
from agents.nodes.documents import DOC_TYPES, finish_document, start_document


def _target(ctx: NodeContext) -> str:
    target = ctx.param('target') or ctx.context.get('last_review_target') or 'prfaq'
    if target not in DOC_TYPES:
        raise NodeFailure('revise_document can revise a prfaq or a prd')
    return target


def start(ctx: NodeContext) -> dict:
    target = _target(ctx)
    previous = ctx.document(target)
    if not previous:
        raise NodeFailure(f'there is no {target} to revise yet')
    return start_document(ctx, target, revision_of=previous)


def finish(ctx: NodeContext, job: dict) -> dict:
    return finish_document(ctx, job, _target(ctx))
