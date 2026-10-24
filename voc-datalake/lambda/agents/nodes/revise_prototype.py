"""revise_prototype — the next prototype version, from the conductor's brief and the tester pins.

When ``collect_prototype_feedback`` ran on the current prototype, its pins join
the brief as a ``<prototype_pins>`` DATA block; once the revision exists they
are marked ADDRESSED by it and recorded in ``addressed_pins``, for the
conductor to resolve after a later passing review.
"""
from __future__ import annotations

from agents import pins
from agents.nodes.base import NodeContext, NodeFailure, job_document_id
from agents.nodes.prototypes import finish_prototype, start_prototype


def start(ctx: NodeContext) -> dict:
    current = ctx.document('prototype')
    if not current:
        raise NodeFailure('there is no prototype to revise yet')
    feedback = pins.feedback_for(ctx.context, current)
    return start_prototype(ctx, base_prototype_id=current,
                           extra_feedback=pins.pins_block(feedback) if feedback else '')


def finish(ctx: NodeContext, job: dict) -> dict:
    result = finish_prototype(ctx, job)
    base = ctx.document('prototype')
    feedback = pins.feedback_for(ctx.context, base)
    if not feedback or not base:
        return result
    revision = job_document_id(job)
    addressed = pins.mark_addressed(ctx.claims, ctx.require_project(), feedback, revision)
    updates = dict(result.get('updates') or {})
    updates[pins.CONTEXT_KEY] = None
    if addressed:
        updates[pins.ADDRESSED_KEY] = pins.with_addressed(ctx.context, base, addressed, revision)
        result['summary'] = f"{result.get('summary')}; addressed {len(addressed)} tester pin(s)"
    return {**result, 'updates': updates}
