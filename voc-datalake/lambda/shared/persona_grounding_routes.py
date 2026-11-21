"""The personas' evidence routes (docs/project-workspace.md → Persona focus groups), on the projects API.

Included by ``api/projects_handler.py``; its project-access middleware has already gated the project in the path
(``shared.project_access.required_level``: the pack's POST and the freshness GET are view, the refresh POST edit):

- ``POST /projects/{id}/personas/evidence-pack`` ``{persona_ids, question?, limit?}`` — each persona's stored and
  fresh evidence as the caller may see it (a read despite the verb: the stream's focus groups call it through their
  read-only invoker, ``lambda/stream/src/assistant/tools/internal-api.ts``);
- ``GET /projects/{id}/personas/{persona_id}/evidence-freshness`` — how many matching reviews arrived since the
  persona was generated or last refreshed (the persona card's badge);
- ``POST /projects/{id}/personas/{persona_id}/evidence/refresh`` — append them to its ``evidence_updates``.

Every read is the caller's: their category scope (category and source rules) is read here, from the request's
claims, and only what it admits is ever answered or stored. The logic is ``shared/persona_grounding.py``.
"""
from __future__ import annotations

from typing import Any

from aws_lambda_powertools.event_handler.api_gateway import Router

from shared import category_gate, persona_grounding
from shared.delete_audit import actor_from_event
from shared.logging import tracer
from shared.request_body import json_object_body
from shared.tables import configured_table, get_aggregates_table, get_feedback_table, get_projects_table

app = Router()


def _reader() -> persona_grounding.Reader:
    """The tables, and the caller's category scope (a restricted caller's access row is read once a request)."""
    return persona_grounding.Reader(
        projects_table=configured_table(get_projects_table(), 'Projects'),
        feedback_table=configured_table(get_feedback_table(), 'Feedback'),
        scope=category_gate.scope_for_event(app.current_event.raw_event, get_aggregates_table()),
    )


@app.post("/projects/<project_id>/personas/evidence-pack")
@tracer.capture_method
def persona_evidence_pack(project_id: str) -> dict[str, Any]:
    persona_ids, question, limit = persona_grounding.validated_pack_request(json_object_body(app))
    return persona_grounding.evidence_pack(_reader(), project_id, persona_ids, question, limit)


@app.get("/projects/<project_id>/personas/<persona_id>/evidence-freshness")
@tracer.capture_method
def persona_evidence_freshness(project_id: str, persona_id: str) -> dict[str, Any]:
    return persona_grounding.evidence_freshness(_reader(), project_id, persona_id)


@app.post("/projects/<project_id>/personas/<persona_id>/evidence/refresh")
@tracer.capture_method
def refresh_persona_evidence(project_id: str, persona_id: str) -> dict[str, Any]:
    actor = actor_from_event(app.current_event.raw_event)
    return {'success': True, **persona_grounding.refresh_evidence(_reader(), project_id, persona_id, actor)}
