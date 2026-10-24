"""Shared by build_prototype / revise_prototype: one prototype job.

``POST /projects/{id}/build-prototype`` does the building with the company
design system (injected by the generator). The agent aims it at the run's
latest PR/FAQ, PRD and research; a revision passes the conductor's brief as
``feedback`` and the current prototype as ``base_prototype_id``.
"""
from __future__ import annotations

from agents.nodes.base import (
    NodeContext,
    document_updates,
    done,
    job_document_id,
    started_job,
)
from agents.nodes.documents import document_title

MAX_FEEDBACK_CHARS = 6000


def start_prototype(ctx: NodeContext, *, base_prototype_id: str | None = None, extra_feedback: str = '') -> dict:
    project_id = ctx.require_project()
    research = ctx.document('research')
    body = {
        'title': f'Prototype: {document_title(ctx)}'[:120],
        'source_prfaq_id': ctx.document('prfaq'),
        'source_prd_id': ctx.document('prd'),
        'use_product_context': True,
        'use_research': bool(research),
        'selected_research_ids': [research] if research else [],
    }
    if base_prototype_id:
        body['base_prototype_id'] = base_prototype_id
        body['feedback'] = '\n\n'.join(
            part for part in (ctx.envelope[:MAX_FEEDBACK_CHARS], extra_feedback) if part)
    payload = ctx.projects('POST', f'/projects/{project_id}/build-prototype',
                           body={k: v for k, v in body.items() if v is not None},
                           path_parameters={'project_id': project_id})
    verb = 'revision' if base_prototype_id else 'build'
    return started_job(ctx, payload, project_id, f'Prototype {verb} started')


def finish_prototype(ctx: NodeContext, job: dict) -> dict:
    document_id = job_document_id(job)
    return done(ctx, 'Prototype built',
                artifacts={'project_id': ctx.require_project(), 'document_id': document_id,
                           'document_type': 'prototype'},
                updates=document_updates(ctx, 'prototype', document_id))
