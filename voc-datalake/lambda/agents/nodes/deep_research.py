"""deep_research — the research workflow (web search on by default)."""
from __future__ import annotations

from agents.fields import dict_field, list_field
from agents.nodes.base import (
    NodeContext,
    document_updates,
    done,
    job_document_id,
    scope_categories,
    started_job,
)

DEFAULT_DAYS = 30


def start(ctx: NodeContext) -> dict:
    project_id = ctx.require_project()
    aggregate = dict_field(ctx.context, 'aggregate')
    question = (ctx.node.instructions or str(aggregate.get('research_question') or '')
                or 'What are the main customer pain points and how could we solve them?')
    days = ctx.param('days', DEFAULT_DAYS)
    persona_ids = list_field(ctx.context, 'persona_ids')
    payload = ctx.projects('POST', f'/projects/{project_id}/research', body={
        'question': question[:2000],
        'title': f"Research: {str(aggregate.get('title') or question)[:80]}",
        'categories': scope_categories(ctx.agent),
        'days': days if isinstance(days, int) else DEFAULT_DAYS,
        'selected_persona_ids': persona_ids[:20],
        'use_web_search': ctx.param('use_web_search', True) is True,
    }, path_parameters={'project_id': project_id})
    return started_job(ctx, payload, project_id, 'Research started')


def finish(ctx: NodeContext, job: dict) -> dict:
    document_id = job_document_id(job)
    return done(ctx, 'Research report written',
                artifacts={'project_id': ctx.require_project(), 'document_id': document_id,
                           'document_type': 'research'},
                updates=document_updates(ctx, 'research', document_id))
