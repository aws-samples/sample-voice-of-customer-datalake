"""deep_research — the research workflow (web search on by default)."""
from __future__ import annotations

from agents.fields import dict_field, list_field
from agents.nodes import web
from agents.nodes.base import (
    DEFAULT_REVIEW_DAYS,
    NodeContext,
    document_updates,
    done,
    job_document_id,
    scope_categories,
    started_job,
)
from shared.agentic_search import MAX_TOTAL_QUERIES
from shared.text_clip import clip_words

DEFAULT_DAYS = DEFAULT_REVIEW_DAYS
#: Characters of the run's title the research report's title quotes (clipped on a word).
TITLE_SUBJECT_CHARS = 80


def start(ctx: NodeContext) -> dict:
    project_id = ctx.require_project()
    aggregate = dict_field(ctx.context, 'aggregate')
    question = (ctx.node.instructions or str(aggregate.get('research_question') or '')
                or 'What are the main customer pain points and how could we solve them?')
    days = ctx.param('days', DEFAULT_DAYS)
    persona_ids = list_field(ctx.context, 'persona_ids')
    # The research job runs its own planned searches; this step reserves them
    # from the run's web budget first and caps the job at what was granted.
    web_queries = web.granted_queries(ctx, MAX_TOTAL_QUERIES)
    payload = ctx.projects('POST', f'/projects/{project_id}/research', body={
        'question': question[:2000],
        'title': f"Research: {clip_words(str(aggregate.get('title') or question), TITLE_SUBJECT_CHARS)}",
        'categories': scope_categories(ctx.agent),
        'days': days if isinstance(days, int) else DEFAULT_DAYS,
        'selected_persona_ids': persona_ids[:20],
        'use_web_search': web_queries > 0,
        **({'web_query_cap': web_queries} if web_queries else {}),
    }, path_parameters={'project_id': project_id})
    return started_job(ctx, payload, project_id, 'Research started')


def finish(ctx: NodeContext, job: dict) -> dict:
    document_id = job_document_id(job)
    return done(ctx, 'Research report written',
                artifacts={'project_id': ctx.require_project(), 'document_id': document_id,
                           'document_type': 'research'},
                updates=document_updates(ctx, 'research', document_id))
