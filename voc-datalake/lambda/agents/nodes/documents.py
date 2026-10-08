"""Shared by write_prfaq / write_prd / revise_document: one PR/FAQ or PRD job.

The existing ``POST /projects/{id}/document`` route does the writing (company
context and design system are injected by the generator itself). The agent's
contribution is the ``feature_idea`` it sends — the aggregated problems, the
conductor's brief and the top memories, each a DATA block. A revision reuses
the same title, so the generator files it as the next version of the series,
and selects the previous version as a reference document.
"""
from __future__ import annotations

from agents import context_blocks
from agents.fields import dict_field, list_field
from agents.nodes.base import (
    NodeContext,
    NodeFailure,
    document_updates,
    done,
    job_document_id,
    scope_categories,
    started_job,
)

DOC_TYPES = ('prfaq', 'prd')
MAX_FEATURE_IDEA_CHARS = 12000
DEFAULT_DAYS = 30


def document_title(ctx: NodeContext) -> str:
    aggregate = dict_field(ctx.context, 'aggregate')
    return str(ctx.param('title') or aggregate.get('title') or ctx.node.title)[:120]


def start_document(ctx: NodeContext, doc_type: str, *, revision_of: str | None = None) -> dict:
    if doc_type not in DOC_TYPES:
        raise NodeFailure(f'unsupported document type {doc_type}')
    project_id = ctx.require_project()
    persona_ids = list_field(ctx.context, 'persona_ids')
    references = [d for d in (ctx.document('research'), revision_of) if d]
    feature_idea = context_blocks.join_blocks(
        context_blocks.wrap('reviews', ctx.aggregate_text(), 4000),
        context_blocks.memories(ctx.claims, ctx.aggregate_text(800), project_id),
        context_blocks.wrap('conductor_message', ctx.envelope, 6000),
    )[:MAX_FEATURE_IDEA_CHARS]
    days = ctx.param('days', DEFAULT_DAYS)
    payload = ctx.projects('POST', f'/projects/{project_id}/document', body={
        'doc_type': doc_type,
        'title': document_title(ctx),
        'feature_idea': feature_idea,
        'data_sources': {'feedback': True, 'personas': bool(persona_ids),
                         'research': bool(references), 'documents': bool(references)},
        'feedback_categories': scope_categories(ctx.agent),
        'days': days if isinstance(days, int) else DEFAULT_DAYS,
        'selected_persona_ids': persona_ids[:20],
        'selected_document_ids': references,
    }, path_parameters={'project_id': project_id})
    verb = 'Revision' if revision_of else 'Writing'
    return started_job(ctx, payload, project_id, f'{verb} of the {doc_type.upper()} started')


def finish_document(ctx: NodeContext, job: dict, doc_type: str) -> dict:
    document_id = job_document_id(job)
    return done(ctx, f'{doc_type.upper()} written',
                artifacts={'project_id': ctx.require_project(), 'document_id': document_id,
                           'document_type': doc_type},
                updates=document_updates(ctx, doc_type, document_id))
