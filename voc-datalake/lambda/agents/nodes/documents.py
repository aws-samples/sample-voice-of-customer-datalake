"""Shared by write_prfaq / write_prd / revise_document: one PR/FAQ or PRD job.

The existing ``POST /projects/{id}/document`` route does the writing (company
context and design system are injected by the generator itself). The agent sends:

- ``feature_idea`` — the aggregated problems as plain text (stored with the document);
- ``writer_context`` — the ``<reviews>`` (the scope's review count, problems and quotes:
  ``NodeContext.evidence_text``), ``<memory>`` and ``<conductor_message>`` (a revision's
  brief) DATA blocks, for the prompt only (``shared/document_writer_brief.py``, which
  repeats them in every writing step). Each block has its own budget and together they
  fit ``MAX_WRITER_CONTEXT_CHARS``, so no block is cut off by the total: they were
  once the feature idea, which the generator used as the PR/FAQ heading, so every
  agent PR/FAQ began with the writer's own prompt;
- ``writer_instructions`` — the agent's and the step's instructions, which reach
  every writing step (they used to reach only the first, analysis, step);
- ``length_budget_words`` — the step's ``max_words``, or ``BRIEF_LENGTH_WORDS`` when
  the instructions ask for short documents.

A revision reuses the same title, so the generator files it as the next version
of the series, and selects the previous version as a reference document.
"""
from __future__ import annotations

import re
from typing import Any

from agents import context_blocks, principal
from agents.failure_reason import document_label
from agents.fields import dict_field, list_field
from agents.nodes.base import (
    DEFAULT_REVIEW_DAYS,
    NodeContext,
    NodeFailure,
    document_updates,
    done,
    job_document_id,
    scope_categories,
    started_job,
)
from shared.ai_writing import AUTONOMOUS_REFUSAL_PREFIX, GATED_DOC_TYPES

DOC_TYPES = GATED_DOC_TYPES
MAX_FEATURE_IDEA_CHARS = 2000
#: Per-block budgets; the blocks (with tags and the memory block's own 4,000) fit the total.
EVIDENCE_CHARS = 5000
CONDUCTOR_MESSAGE_CHARS = 6000
MAX_WRITER_CONTEXT_CHARS = 16000
MAX_WRITER_INSTRUCTIONS_CHARS = 3000
DEFAULT_DAYS = DEFAULT_REVIEW_DAYS
#: The word budget when the instructions ask for short documents and the step sets none.
BRIEF_LENGTH_WORDS = 1200
MIN_LENGTH_WORDS = 200
MAX_LENGTH_WORDS = 8000
#: "Keep it short" in the platform's nine languages (case-insensitive, whole words).
_BREVITY_RE = re.compile(
    r'\b(short|shorter|brief|briefly|concise|concisely|succinct|compact|kurz|kürzer|knapp|court|courts|'
    r'courte|courtes|concis|breve|breves|corto|cortos|corta|curto|curtos|conciso|concisos|'
    r'zwięz\w*|zwięź\w*|krótk\w*)\b|短|簡潔|简洁|짧|간결',
    re.IGNORECASE,
)


def document_title(ctx: NodeContext) -> str:
    aggregate = dict_field(ctx.context, 'aggregate')
    return str(ctx.param('title') or aggregate.get('title') or ctx.node.title)[:120]


def writer_instructions(ctx: NodeContext) -> str:
    """The agent's instructions, then the step's, as the writer reads them ('' when neither)."""
    parts = []
    agent_text = ctx.agent.get('instructions')
    if isinstance(agent_text, str) and agent_text.strip():
        parts.append(agent_text.strip())
    if ctx.node.instructions.strip():
        parts.append(ctx.node.instructions.strip())
    return '\n\n'.join(parts)[:MAX_WRITER_INSTRUCTIONS_CHARS]


def length_budget(ctx: NodeContext, instructions: str) -> int | None:
    """The step's ``max_words`` (clamped), else ``BRIEF_LENGTH_WORDS`` when asked for brevity."""
    value = ctx.param('max_words')
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return min(max(value, MIN_LENGTH_WORDS), MAX_LENGTH_WORDS)
    return BRIEF_LENGTH_WORDS if _BREVITY_RE.search(instructions) else None


def _start_writing(ctx: NodeContext, project_id: str, body: dict) -> Any:
    """``POST /projects/{id}/document`` as the agent; a way-of-working refusal is a plain node failure.

    The route refuses a PR/FAQ / PRD unless the agent's owner (and the project's owner)
    work AI-driven (docs/ways-of-working.md); that 403 says why in its own words.
    """
    try:
        return ctx.projects('POST', f'/projects/{project_id}/document', body=body,
                            path_parameters={'project_id': project_id})
    except principal.RouteError as exc:
        if exc.status_code == 403 and str(exc).startswith(AUTONOMOUS_REFUSAL_PREFIX):
            raise NodeFailure(str(exc)) from exc
        raise


def start_document(ctx: NodeContext, doc_type: str, *, revision_of: str | None = None) -> dict:
    if doc_type not in DOC_TYPES:
        raise NodeFailure(f'unsupported document type {doc_type}')
    project_id = ctx.require_project()
    persona_ids = list_field(ctx.context, 'persona_ids')
    references = [d for d in (ctx.document('research'), revision_of) if d]
    writer_context = context_blocks.join_blocks(
        context_blocks.wrap('reviews', ctx.evidence_text(EVIDENCE_CHARS), EVIDENCE_CHARS),
        context_blocks.memories(ctx.claims, ctx.aggregate_text(800), project_id),
        context_blocks.wrap('conductor_message', ctx.envelope, CONDUCTOR_MESSAGE_CHARS),
    )[:MAX_WRITER_CONTEXT_CHARS]
    instructions = writer_instructions(ctx)
    budget = length_budget(ctx, instructions)
    days = ctx.param('days', DEFAULT_DAYS)
    payload = _start_writing(ctx, project_id, {
        'doc_type': doc_type,
        'title': document_title(ctx),
        'feature_idea': ctx.aggregate_text(MAX_FEATURE_IDEA_CHARS),
        'writer_context': writer_context,
        **({'writer_instructions': instructions} if instructions else {}),
        **({'length_budget_words': budget} if budget is not None else {}),
        'data_sources': {'feedback': True, 'personas': bool(persona_ids),
                         'research': bool(references), 'documents': bool(references)},
        'feedback_categories': scope_categories(ctx.agent),
        'days': days if isinstance(days, int) else DEFAULT_DAYS,
        'selected_persona_ids': persona_ids[:20],
        'selected_document_ids': references,
    })
    verb = 'Revision' if revision_of else 'Writing'
    return started_job(ctx, payload, project_id, f'{verb} of the {document_label(doc_type)} started')


def finish_document(ctx: NodeContext, job: dict, doc_type: str) -> dict:
    document_id = job_document_id(job)
    return done(ctx, f'{document_label(doc_type)} written',
                artifacts={'project_id': ctx.require_project(), 'document_id': document_id,
                           'document_type': doc_type},
                updates=document_updates(ctx, doc_type, document_id))
