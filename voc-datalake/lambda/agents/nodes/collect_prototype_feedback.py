"""collect_prototype_feedback — the open tester pins on the run's prototype, for the next revision.

Reads them through the projects API as the agent (``agents.pins.open_pins``);
pins the injection screen flagged are left out and counted. Nothing is written
to the project: the pins only reach ``revise_prototype`` through the run
context (``prototype_feedback``), and become ADDRESSED once a revision exists.
"""
from __future__ import annotations

from agents import pins, principal
from agents.nodes.base import NodeContext, NodeFailure, done
from shared.logging import logger
from shared.mcp_delegate import DelegationUnavailable


def start(ctx: NodeContext) -> dict:
    project_id = ctx.require_project()
    document_id = ctx.document('prototype')
    if not document_id:
        raise NodeFailure('there is no prototype to collect feedback for yet')
    try:
        usable, flagged = pins.open_pins(project_id, document_id, ctx.claims)
    except (principal.RouteError, DelegationUnavailable) as exc:
        # Pins are an input, not a gate: the revision proceeds on the persona brief alone.
        logger.warning('Prototype pins unavailable', extra={'error_type': type(exc).__name__})
        return done(ctx, 'Tester pins were unavailable; revising from the review alone',
                    artifacts={'project_id': project_id}, updates={pins.CONTEXT_KEY: None})
    summary = f'{len(usable)} open tester pin(s) on the prototype'
    if flagged:
        summary += f'; {flagged} flagged pin(s) left for a human'
    return done(ctx, summary,
                artifacts={'project_id': project_id},
                updates={pins.CONTEXT_KEY: {'document_id': document_id, 'pins': usable, 'flagged': flagged}})
