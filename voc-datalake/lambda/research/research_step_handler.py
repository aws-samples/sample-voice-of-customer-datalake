"""
Research Step Lambda Handler
Handles individual steps of the research workflow orchestrated by Step Functions.
Each step can run up to 15 minutes, allowing for deep analysis.
"""

import json
import os
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from boto3.dynamodb.conditions import Key

from shared import category_access
from shared.agentic_search import run_agentic_web_search
from shared.api import api_handler
from shared.aws import get_s3_client
from shared.converse import BedrockThrottlingError, converse
from shared.derivation import (
    DERIVATION_FIELD,
    ROLE_REFERENCE,
    build_derivation,
    derivation_source,
)
from shared.feedback import (
    feedback_char_budget,
    feedback_item_limit,
    format_feedback_for_llm,
    get_feedback_statistics,
    truncate_feedback_context,
    validate_date_basis,
)
from shared.feedback import (
    get_feedback_context as _get_feedback_context,
)
from shared.feedback_sampling import MAX_INPUT_FEEDBACK_IDS, input_feedback_ids
from shared.grounding import Grounding
from shared.ids import timestamped_id
from shared.job_knowledge import derivation_knowledge, shared_grounding, with_guidance
from shared.jobs import update_job_status

# Shared module imports
from shared.logging import logger, tracer
from shared.model_config import surface_context_window_tokens
from shared.persona_context import personas_prompt_context
from shared.project_writes import create_counted_project_child
from shared.prompt_labels_store import load_prompt_labels
from shared.prompts import (
    get_research_step_config,
    get_response_language_instruction,
)
from shared.research_title import research_document_title
from shared.tables import get_feedback_table, get_projects_table
from shared.web_search import is_web_search_configured

# Use shared table accessors - these will be initialized on first use
feedback_table: Any = None
projects_table: Any = None


def _get_feedback_table():
    """Get feedback table, initializing if needed."""
    global feedback_table
    if feedback_table is None:
        feedback_table = get_feedback_table()
    return feedback_table
def _get_projects_table():
    """Get projects table, initializing if needed."""
    global projects_table
    if projects_table is None:
        projects_table = get_projects_table()
    return projects_table
# Alias for backward compatibility with Step Functions error handling
BedrockThrottlingException = BedrockThrottlingError
def invoke_bedrock_with_retry(
    system_prompt: str,
    user_message: str,
    max_tokens: int = 4096,
    max_retries: int = 3,
    thinking_budget: int = 0,
    step_name: str = 'unknown',
) -> str:
    """Invoke Bedrock with retry support using shared converse module."""
    return converse(
        prompt=user_message,
        system_prompt=system_prompt,
        max_tokens=max_tokens,
        thinking_budget=thinking_budget,
        surface='documents',
        max_retries=max_retries,
        raise_on_throttle=True,
        step_name=step_name,
    )


def _step_inference(step_name: str, config: dict) -> dict:
    """Resolve a research step's system prompt and token budgets.

    Both research paths read the SAME config (lambda/api/prompts/
    research-analysis.json): the sync path via build_chain_steps, this async
    Step Functions path via here. Previously this module hardcoded its own
    budgets and duplicated the system prompts, so edits to that JSON silently
    had no effect on the async path — it looked authoritative but was never
    read. Keep it that way: budgets belong in the JSON, not inline.

    The user prompt stays inline per step, because this path adds context the
    templated sync path has no placeholders for (personas, uploaded documents,
    public web-search results).
    """
    step_config = get_research_step_config(step_name)
    system_prompt = step_config['system_prompt']
    lang_instruction = get_response_language_instruction(config.get('response_language'))
    if lang_instruction:
        system_prompt = f"{system_prompt}\n\n{lang_instruction}"
    return {
        'system_prompt': system_prompt,
        'max_tokens': step_config['max_tokens'],
        'thinking_budget': step_config['thinking_budget'],
        # Resolved by shared.prompts from the config's 'name', so [BEDROCK] log
        # lines match between this path and the sync chain.
        'step_name': step_config['step_name'],
    }


def _call_step_ai(project_id: str, job_id: str, inference: dict, user_prompt: str,
                  *, calling_progress: int, complete_progress: int,
                  complete_status: str) -> str:
    """Run one research step's model call, bracketed by its job-status updates."""
    update_job_status(project_id, job_id, 'running', calling_progress, 'calling_ai')
    text = invoke_bedrock_with_retry(
        inference['system_prompt'],
        user_prompt,
        max_tokens=inference['max_tokens'],
        thinking_budget=inference['thinking_budget'],
        step_name=inference['step_name'],
    )

    update_job_status(project_id, job_id, 'running', complete_progress, complete_status)

    return text
# Wrapper function to pass module-level table reference to shared function
def get_feedback_context(filters: dict, limit: int = 100) -> list[dict]:
    """Get feedback items based on filters for LLM context."""
    return _get_feedback_context(_get_feedback_table(), filters, limit)


# Research feedback budget (#231). Same mechanism as persona and document
# generation (shared/feedback.py): a character budget derived from the context
# window of the model the 'documents' surface resolves to, a fetch limit derived
# from that budget, a record-boundary trim, and a report of what reached the model.
#
# The feedback block does NOT travel the Step Functions state (256 KB per state,
# which once capped research at 50,000 characters). step_initialize stashes it in
# the raw data bucket under a per-job scratch key and step_analyze reads it back:
# the claim-check the document generator uses (jobs/document_generator/handler.py).
SCRATCH_BUCKET = os.environ.get('RAW_DATA_BUCKET', '')


def research_feedback_budget() -> tuple[int, int]:
    """``(char_budget, fetch_limit)`` for one research run, resolved at call time."""
    char_budget = feedback_char_budget(window_tokens=surface_context_window_tokens('documents'))
    return char_budget, feedback_item_limit(char_budget)


def _feedback_context_key(job_id: str) -> str:
    """The scratch key of one job's feedback block. Derived from the job id, never
    read from execution input, so a forged input cannot point a step at another object."""
    return f'scratch/research_jobs/{job_id}/feedback_context.txt'


def _stash_feedback_context(job_id: str, text: str) -> None:
    get_s3_client().put_object(
        Bucket=SCRATCH_BUCKET, Key=_feedback_context_key(job_id), Body=text.encode('utf-8'),
    )


def _feedback_context_for(event: dict) -> str:
    """The feedback block step_analyze puts in the prompt.

    An execution started on the definition that carried the block inline still
    passes it as ``feedback_context``; every newer one reads the stash, and a
    missing stash fails the step (there is nothing to analyse without it).
    """
    inline = event.get('feedback_context')
    if isinstance(inline, str) and inline:
        return inline
    response = get_s3_client().get_object(Bucket=SCRATCH_BUCKET, Key=_feedback_context_key(event['job_id']))
    return response['Body'].read().decode('utf-8')


def _discard_feedback_context(job_id: str) -> None:
    """Best-effort removal of the job's scratch blocks once the job has ended."""
    for key in (_feedback_context_key(job_id), _grounding_key(job_id)):
        try:
            get_s3_client().delete_object(Bucket=SCRATCH_BUCKET, Key=key)
        except Exception:
            logger.exception(f"Research scratch cleanup failed for job {job_id} (non-fatal)")


# Company knowledge (shared.job_knowledge, POLICY_SHARED): company context and
# COMPANY memories only — a research report is a project document other members
# read, so the starter's personal objectives and memories never reach it. Like
# the feedback block it rides the scratch claim-check, never the state; only the
# boolean ``grounding_included`` travels the state machine, so a job without
# company knowledge makes no extra S3 read.
GROUNDING_SECTION_HEADING = '## COMPANY KNOWLEDGE (background about the company, NOT customer evidence)'


def _grounding_key(job_id: str) -> str:
    """The scratch key of one job's company-knowledge block (derived from the job id)."""
    return f'scratch/research_jobs/{job_id}/grounding.txt'


def _research_grounding(job_id: str, config: dict) -> Grounding:
    """Company knowledge for the research question, stashed for the model steps.

    Best effort end to end: a failed stash costs the report its company
    knowledge (and records none of it), never the job.
    """
    grounding = shared_grounding(
        str(config.get('question') or ''), config.get(category_access.SCOPE_CONFIG_KEY),
    )
    if not grounding.text:
        return grounding
    try:
        get_s3_client().put_object(
            Bucket=SCRATCH_BUCKET, Key=_grounding_key(job_id), Body=grounding.text.encode('utf-8'),
        )
    except Exception:
        logger.exception(f"Research company knowledge not stashed for job {job_id} (continuing without)")
        return Grounding()
    return grounding


def _grounding_for(event: dict) -> Grounding:
    """The stashed company knowledge for a model step, or an empty Grounding."""
    if event.get('grounding_included') is not True:
        return Grounding()
    try:
        response = get_s3_client().get_object(Bucket=SCRATCH_BUCKET, Key=_grounding_key(event['job_id']))
        text = response['Body'].read().decode('utf-8')
    except Exception:
        logger.exception("Research company knowledge unavailable (continuing without)")
        return Grounding()
    return Grounding(text=text)


def _grounding_section(grounding: Grounding) -> str:
    """The user-prompt section carrying the company-knowledge DATA blocks ('' when none)."""
    return f"\n{GROUNDING_SECTION_HEADING}\n\n{grounding.text}\n" if grounding.text else ''


def _feedback_usage(
    items_read: int, items_used: int, trimmed: bool, fetch_limit: int, input_ids: list[str] | None = None,
) -> dict:
    """What the research model saw of the corpus, in the persona job's ``metadata`` shape.

    That is the shape the SPA's job list reads (``parseJobGrounding``), so a
    research job gets the same "based on N of M items" notices. ``context_truncated``
    is the character trim only; ``fetch_limit_reached`` is the separate loss of
    matching feedback the fetch never read. ``input_feedback_ids`` (#236) are the
    reviews the model read, in prompt order; step_save stores them on the document.
    """
    return {
        'feedback_count': items_read,
        'feedback_items_used': items_used,
        'context_truncated': trimmed,
        'fetch_limit_reached': items_read >= fetch_limit,
        'fetch_limit': fetch_limit,
        INPUT_IDS_KEY: list(input_ids or []),
    }


INPUT_IDS_KEY = 'input_feedback_ids'


_USAGE_COUNT_KEYS = ('feedback_count', 'feedback_items_used', 'fetch_limit')
_USAGE_FLAG_KEYS = ('context_truncated', 'fetch_limit_reached')


def _is_count(value: object) -> bool:
    """A non-negative int that is not a bool (``True`` is an ``int`` in Python)."""
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _received_feedback_usage(value: object) -> dict:
    """``_feedback_usage``'s output as it arrives at step_save, or ``{}``.

    Step Functions input is an unvalidated boundary, and an execution started on
    a definition that does not forward the field passes nothing, so anything
    that is not exactly the expected shape reads as "not reported".
    """
    if not isinstance(value, dict):
        return {}
    counts_ok = all(_is_count(value.get(key)) for key in _USAGE_COUNT_KEYS)
    flags_ok = all(isinstance(value.get(key), bool) for key in _USAGE_FLAG_KEYS)
    if not (counts_ok and flags_ok):
        return {}
    usage = {key: value[key] for key in (*_USAGE_COUNT_KEYS, *_USAGE_FLAG_KEYS)}
    ids = value.get(INPUT_IDS_KEY)
    if isinstance(ids, list) and all(isinstance(fid, str) and fid for fid in ids):
        usage[INPUT_IDS_KEY] = ids[:MAX_INPUT_FEEDBACK_IDS]
    return usage


def _job_usage(usage: dict) -> dict:
    """The job result's ``metadata``: the usage counts, without the id list (that lives on the document)."""
    return {key: value for key, value in usage.items() if key != INPUT_IDS_KEY}


def _document_usage_fields(usage: dict) -> dict:
    """The saved research document's usage fields, as the document generator stores them.

    On a document ``context_truncated`` means "the model saw less than the
    filters match", so it folds in the fetch cap as well as the trim.
    """
    if not usage:
        return {}
    return {
        'feedback_items_used': usage['feedback_items_used'],
        'context_truncated': usage['context_truncated'] or usage['fetch_limit_reached'],
        **({INPUT_IDS_KEY: usage[INPUT_IDS_KEY]} if INPUT_IDS_KEY in usage else {}),
    }


def _feedback_analyzed_line(feedback_count: int, usage: dict) -> str:
    """The report header's count: what reached the model, and what was read when they differ."""
    if usage and usage['context_truncated']:
        return (
            f"{usage['feedback_items_used']} of {usage['feedback_count']} items read "
            f"(the rest did not fit the context budget)"
        )
    return f'{feedback_count} items'


# Ceiling on the query pages one project read walks. A project partition holds
# its personas, documents and members, each item well under the 400 KB item cap,
# so 50 pages of up to 1 MB is far past any real project while still stopping a
# runaway partition from holding a 15-minute step on reads.
MAX_PROJECT_ITEM_PAGES = 50


def _project_items(proj_table: Any, project_id: str) -> list[dict]:
    """Every item of the project's partition, across query pages (bounded).

    One query page stops at 1 MB, so a project with many long documents had its
    later personas and documents silently missing from the research context.
    """
    query: dict[str, Any] = {'KeyConditionExpression': Key('pk').eq(f'PROJECT#{project_id}')}
    items: list[dict] = []
    for _page in range(MAX_PROJECT_ITEM_PAGES):
        response = proj_table.query(**query)
        items.extend(response.get('Items', []))
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            return items
        query['ExclusiveStartKey'] = last_key
    logger.warning(
        'Project read stopped at the page ceiling; some items were not read',
        extra={'project_id': project_id, 'max_pages': MAX_PROJECT_ITEM_PAGES, 'items_read': len(items)},
    )
    return items


def _sort_key(item: dict) -> str:
    sk = item.get('sk')
    return sk if isinstance(sk, str) else ''


def _selected_personas_context(
    proj_table: Any, project_id: str, job_id: str, selected_persona_ids: list,
) -> tuple[str, list[str]]:
    """Optional: the selected personas' prompt block and the persona ids it used."""
    if not (selected_persona_ids and proj_table):
        return "", []
    update_job_status(project_id, job_id, 'running', 17, 'fetching_personas')
    selected_personas = [
        p for p in _project_items(proj_table, project_id)
        if _sort_key(p).startswith('PERSONA#') and p.get('persona_id') in selected_persona_ids
    ]
    if not selected_personas:
        return "", []
    # `goals`, `frustrations` and singular `quote` were all phantom keys,
    # so this block reached the analysis step as headings with no content.
    # Field paths live in shared/persona_context.py, which caps each list
    # deliberately: this string crosses a Step Functions state boundary.
    personas_context = personas_prompt_context(
        selected_personas, header="## Selected Personas"
    )
    return personas_context, [p['persona_id'] for p in selected_personas if p.get('persona_id')]


def _selected_documents_context(
    proj_table: Any, project_id: str, job_id: str, selected_document_ids: list,
) -> tuple[str, list[dict]]:
    """Optional: the selected reference documents' prompt block and their sources."""
    if not (selected_document_ids and proj_table):
        return "", []
    update_job_status(project_id, job_id, 'running', 18, 'fetching_documents')
    selected_docs = [
        d for d in _project_items(proj_table, project_id)
        if _sort_key(d).startswith(('DOC#', 'RESEARCH#', 'PRD#', 'PRFAQ#'))
        and d.get('document_id') in selected_document_ids
    ]
    if not selected_docs:
        return "", []
    documents_context = "## Reference Documents\n\n"
    # Recorded from THIS loop, so the report's provenance names the
    # documents that actually reached the model rather than every id the
    # request selected; selected_document_count keeps the difference
    # visible. The [:3] cap is left exactly as it is.
    used_sources: list[dict] = []
    for d in selected_docs[:3]:  # Limit to 3 docs to avoid context overflow
        content = d.get('content', '')[:5000]  # Truncate long docs
        documents_context += f"### {d.get('title', 'Untitled')} ({d.get('document_type', 'doc').upper()})\n\n{content}\n\n---\n\n"
        source = derivation_source(d.get('document_id'), ROLE_REFERENCE)
        if source:
            used_sources.append(source)
    return documents_context, used_sources


def _web_query_cap(config: dict) -> dict:
    """``{'max_queries': n}`` when an agent step capped this job's searches (its run's
    web budget), else ``{}``. Execution input is unvalidated: only a plain int counts."""
    cap = config.get('web_query_cap')
    if isinstance(cap, bool) or not isinstance(cap, int):
        return {}
    return {'max_queries': cap}


def _web_search_context(
    project_id: str, job_id: str, config: dict, feedback_stats: str,
) -> tuple[str, list[str]]:
    """Optional: web search grounding as ``(web_context, web_search_queries)``.

    AgentCore Web Search Tool via a bounded agentic loop — the model plans
    several queries, reviews results, and refines until coverage is sufficient
    (shared.agentic_search). Always an enrichment — a search/planning failure
    must never fail the research job, and the 'web_context' key must ALWAYS be
    present in step_initialize's return value because the Step Functions
    resultSelector references it unconditionally (as must 'web_search_queries',
    which flows to step_save for the report disclosure).
    Strict boolean: the state machine can be started by other producers or
    execution replays, where a string "false" must not enable a billed feature
    (parity with projects_handler's normalization).
    """
    if config.get('use_web_search') is not True:
        return '', []
    if not is_web_search_configured():
        logger.warning("use_web_search requested but web search is not configured; skipping")
        return '', []
    update_job_status(project_id, job_id, 'running', 19, 'searching_web')
    question = config.get('question', '')
    try:
        outcome = run_agentic_web_search(question, context_hint=feedback_stats, **_web_query_cap(config))
    except Exception:
        # run_agentic_web_search degrades internally; this is the
        # final belt so no web-search failure mode can kill the job.
        logger.exception("Web search failed, continuing without web context")
        return '', []
    logger.info(
        f"Web search grounding: {len(outcome.queries)} queries, "
        f"{outcome.result_count} results"
    )
    return outcome.context, outcome.queries


@tracer.capture_method
def step_initialize(event: dict) -> dict:
    """Step 1: Initialize research - fetch data and prepare context."""
    project_id = event['project_id']
    job_id = event['job_id']
    config = event['research_config']

    logger.info(f"Initializing research for project {project_id}, job {job_id}")
    update_job_status(project_id, job_id, 'running', 10, 'initializing')

    # Get feedback data - this is the PRIMARY data source for research
    filters = {
        'sources': config.get('sources', []),
        'categories': config.get('categories', []),
        'sentiments': config.get('sentiments', []),
        'days': config.get('days', 30),
        # Step Functions execution input is an unvalidated boundary (anyone
        # with StartExecution can pass arbitrary JSON), so validate here
        # rather than trusting the API layer's earlier validation.
        'date_basis': validate_date_basis(config.get('date_basis')),
        # The starter's category scope, captured by the API at job start;
        # get_feedback_context intersects the category filter with it (an
        # absent key is a pre-scope job and reads unrestricted).
        category_access.SCOPE_CONFIG_KEY: config.get(category_access.SCOPE_CONFIG_KEY),
    }

    update_job_status(project_id, job_id, 'running', 12, 'fetching_feedback')

    char_budget, fetch_limit = research_feedback_budget()
    feedback_items = get_feedback_context(filters, limit=fetch_limit)
    logger.info(f"Fetched {len(feedback_items)} feedback items")

    if not feedback_items:
        raise ValueError("No feedback data found matching the filters")

    update_job_status(project_id, job_id, 'running', 15, 'formatting_data')

    labels = load_prompt_labels()  # categories and sources by name, never by id
    feedback_context, items_used, trimmed = truncate_feedback_context(
        format_feedback_for_llm(feedback_items, labels), char_budget,
    )
    feedback_stats = get_feedback_statistics(feedback_items, labels)
    feedback_usage = _feedback_usage(
        len(feedback_items), items_used, trimmed, fetch_limit, input_feedback_ids(feedback_items, items_used),
    )
    if trimmed or feedback_usage['fetch_limit_reached']:
        logger.info(
            "Research feedback context does not cover every matching item",
            extra={**_job_usage(feedback_usage), 'budget_chars': char_budget},
        )

    selected_persona_ids = config.get('selected_persona_ids', [])
    selected_document_ids = config.get('selected_document_ids', [])
    proj_table = _get_projects_table()
    personas_context, used_persona_ids = _selected_personas_context(
        proj_table, project_id, job_id, selected_persona_ids,
    )
    documents_context, used_sources = _selected_documents_context(
        proj_table, project_id, job_id, selected_document_ids,
    )
    # Planned from the question and the feedback statistics ONLY (privacy
    # guard): the company knowledge below is read after, and never reaches a query.
    web_context, web_search_queries = _web_search_context(project_id, job_id, config, feedback_stats)
    grounding = _research_grounding(job_id, config)

    # The block is far larger than a Step Functions state may be; only step_analyze needs it.
    _stash_feedback_context(job_id, feedback_context)

    update_job_status(project_id, job_id, 'running', 20, 'data_ready')

    return {
        'feedback_stats': feedback_stats,
        'feedback_count': len(feedback_items),
        'personas_context': personas_context,
        'documents_context': documents_context,
        'web_context': web_context,
        'web_search_queries': web_search_queries,
        # How much of the corpus reached the model, for step_save to record
        # on the job result and the document. Always present.
        'feedback_usage': feedback_usage,
        # Whether company knowledge was stashed for the model steps. ALWAYS
        # present: the resultSelector references it unconditionally.
        'grounding_included': bool(grounding.text),
        # What this research report was built from. Decided here — this is the
        # only step that reads the inputs — and written by step_save, so it
        # travels the state machine like web_search_queries does. ALWAYS
        # present (empty when nothing was selected), because the resultSelector
        # references it unconditionally and an absent key fails the state.
        # Spelled literally, NOT as DERIVATION_FIELD: this is the Step Functions
        # payload key, whose counterparts are `event.get('derivation')` in
        # step_save and 'derivation.$': '$.Payload.derivation' in the CDK.
        # DERIVATION_FIELD is the DynamoDB attribute name, and coupling the two
        # would make renaming the stored column silently change the wire.
        'derivation': build_derivation(
            sources=used_sources,
            selected_document_count=len(selected_document_ids),
            # The records the model saw, not the ones the fetch returned.
            feedback_count=items_used,
            persona_ids=used_persona_ids,
            **derivation_knowledge(grounding, web_search_count=len(web_search_queries)),
        ),
    }
@tracer.capture_method
def step_analyze(event: dict) -> dict:
    """Step 2: Deep analysis of feedback data."""
    project_id = event['project_id']
    job_id = event['job_id']
    config = event['research_config']
    feedback_context = _feedback_context_for(event)
    feedback_stats = event['feedback_stats']
    personas_context = event.get('personas_context', '')
    documents_context = event.get('documents_context', '')
    web_context = event.get('web_context', '')
    grounding = _grounding_for(event)

    research_question = config.get('question', 'What are the main customer pain points?')

    logger.info(f"Starting analysis for job {job_id}")
    update_job_status(project_id, job_id, 'running', 25, 'preparing_analysis')

    inference = _step_inference('data_analysis', config)
    inference['system_prompt'] = with_guidance(inference['system_prompt'], grounding)

    # Build additional context sections
    additional_context = f"\n{personas_context}\n" if personas_context else ""
    additional_context += _grounding_section(grounding)
    if documents_context:
        additional_context += f"\n{documents_context}\n"
    if web_context:
        additional_context += f"""
## PUBLIC WEB SEARCH RESULTS

The following results come from public web searches (grouped by the search
query that found them), NOT from customer feedback. Use them only to add
market/industry context. When you draw on a web result, cite its source URL
inline and clearly attribute the finding to "public web sources" rather than
to customers.

{web_context}
"""

    user_prompt = f"""Conduct a thorough analysis to answer this research question based on the ACTUAL CUSTOMER FEEDBACK DATA provided below.

RESEARCH QUESTION: {research_question}

## FEEDBACK STATISTICS:
{feedback_stats}

## ACTUAL CUSTOMER FEEDBACK DATA:
{feedback_context}
{additional_context}
---

Based on the ACTUAL FEEDBACK DATA above{' and the provided context' if additional_context else ''}, analyze:
1. **Key Themes & Patterns**: What recurring themes appear in the feedback related to the research question?
2. **Frequency & Severity**: How often do issues appear? How severe are they based on sentiment and urgency?
3. **Customer Quotes**: Include 5-10 direct quotes from the feedback that best illustrate the findings
4. **Sentiment Analysis**: What is the overall sentiment? Are there differences by category or source?
5. **Root Causes**: What underlying issues do customers identify?
6. **Gaps in Data**: What questions remain unanswered?

IMPORTANT: Base ALL findings on the actual feedback data provided. Do not make assumptions beyond what the data shows."""

    analysis = _call_step_ai(
        project_id, job_id, inference, user_prompt,
        calling_progress=30, complete_progress=45, complete_status='analysis_complete',
    )

    return {'analysis': analysis}
@tracer.capture_method
def step_synthesize(event: dict) -> dict:
    """Step 3: Synthesize findings into actionable insights."""
    project_id = event['project_id']
    job_id = event['job_id']
    analysis = event['analysis']
    config = event.get('research_config', {})

    logger.info(f"Synthesizing findings for job {job_id}")
    update_job_status(project_id, job_id, 'running', 50, 'preparing_synthesis')

    inference = _step_inference('synthesis', config)
    grounding = _grounding_for(event)
    inference['system_prompt'] = with_guidance(inference['system_prompt'], grounding)

    user_prompt = f"""Synthesize the analysis into clear findings.

Previous analysis:
{analysis}
{_grounding_section(grounding)}
Provide:
1. **Executive Summary** (2-3 sentences)
2. **Key Findings** (prioritized list with confidence levels)
3. **Supporting Evidence** (quotes and data points)
4. **Recommendations** (actionable next steps)
5. **Areas for Further Research**"""

    synthesis = _call_step_ai(
        project_id, job_id, inference, user_prompt,
        calling_progress=55, complete_progress=70, complete_status='synthesis_complete',
    )

    return {'synthesis': synthesis}
@tracer.capture_method
def step_validate(event: dict) -> dict:
    """Step 4: Validate and cross-check findings."""
    project_id = event['project_id']
    job_id = event['job_id']
    analysis = event['analysis']
    synthesis = event['synthesis']
    config = event.get('research_config', {})

    logger.info(f"Validating research for job {job_id}")
    update_job_status(project_id, job_id, 'running', 75, 'preparing_validation')

    inference = _step_inference('validation', config)

    user_prompt = f"""Review and validate the research findings.

Analysis:
{analysis}

Synthesis:
{synthesis}

Check:
1. Are conclusions supported by the data?
2. Are there alternative interpretations?
3. What are the confidence levels?
4. What biases might be present?

Provide a final validated research report."""

    validation = _call_step_ai(
        project_id, job_id, inference, user_prompt,
        calling_progress=80, complete_progress=90, complete_status='validation_complete',
    )

    return {'validation': validation}
@tracer.capture_method
def step_save(event: dict) -> dict:
    """Step 5: Save final research results."""
    project_id = event['project_id']
    job_id = event['job_id']
    config = event['research_config']
    feedback_count = event['feedback_count']
    analysis = event['analysis']
    synthesis = event['synthesis']
    validation = event['validation']
    # Absent on an execution whose definition does not forward it yet.
    feedback_usage = _received_feedback_usage(event.get('feedback_usage'))

    logger.info(f"Saving research results for job {job_id}")
    update_job_status(project_id, job_id, 'running', 95, 'saving')

    research_question = config.get('question', 'Research')
    filters = config.get('filters', {})
    # The basis step_initialize actually queried with (#258) — re-validated, as
    # execution input is an unvalidated boundary.
    date_basis = validate_date_basis(config.get('date_basis'))

    now_dt = datetime.now(UTC)
    now = now_dt.isoformat()
    # Research is not versioned: the creation time in the title tells two runs apart.
    title = research_document_title(config.get('title'), research_question, now_dt)

    # Strict boolean for parity with step_initialize's gating: a foreign
    # "false" string skips the search, so it must not stamp the disclosure.
    # The executed queries flow from step_initialize through the state machine
    # ('' on old executions pinned to a pre-#207 definition — .get defaults).
    # Research asks for web search by default, so a deployment without the
    # gateway must not claim "enabled" on reports that searched nothing.
    web_search_used = config.get('use_web_search') is True and is_web_search_configured()
    # Queries land verbatim in the report markdown — collapse whitespace and
    # newlines so a model-drafted query can't break the list layout.
    web_queries = [
        ' '.join(q.split())
        for q in (event.get('web_search_queries') or [])
        if isinstance(q, str) and q.strip()
    ] if web_search_used else []
    if web_search_used and web_queries:
        query_word = 'query' if len(web_queries) == 1 else 'queries'
        web_search_note = f' | Web search: enabled ({len(web_queries)} {query_word})'
    elif web_search_used:
        web_search_note = ' | Web search: enabled'
    else:
        web_search_note = ''
    # Acceptable-use disclosure: list the exact searches that grounded the
    # report so readers can judge the web-sourced context.
    web_searches_section = ''
    if web_queries:
        listed = '\n'.join(f'{i}. "{q}"' for i, q in enumerate(web_queries, 1))
        web_searches_section = f"""
---

## Web Searches

Public-web grounding for this report came from the following searches:

{listed}
"""
    # Build comprehensive report
    full_report = f"""# Research Report: {research_question}

**Generated:** {now[:10]}
**Feedback Analyzed:** {_feedback_analyzed_line(feedback_count, feedback_usage)}
**Filters:** Sources: {', '.join(filters.get('sources', [])) or 'All'} | Categories: {', '.join(filters.get('categories', [])) or 'All'} | Sentiments: {', '.join(filters.get('sentiments', [])) or 'All'} | Days: {filters.get('days', 30)} | Date basis: {date_basis}{web_search_note}

---

## Executive Summary & Key Findings

{synthesis}

---

## Detailed Analysis

{analysis}

---

## Validation & Confidence Assessment

{validation}
{web_searches_section}"""

    # Truncate if needed (DynamoDB 400KB limit)
    max_content_size = 350000
    if len(full_report) > max_content_size:
        full_report = full_report[:max_content_size] + "\n\n---\n\n*[Report truncated due to size limits]*"

    # Save to projects table
    proj_table = _get_projects_table()
    research_id = timestamped_id('research')
    if proj_table:
        def build(document_id: str) -> dict:
            return {
                'pk': f'PROJECT#{project_id}',
                'sk': f'RESEARCH#{document_id}',
                'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS',
                'gsi1sk': now,
                'document_id': document_id,
                'document_type': 'research',
                'title': title,
                'question': research_question,
                'content': full_report,
                'feedback_count': feedback_count,
                **_document_usage_fields(feedback_usage),
                'date_basis': date_basis,
                'job_id': job_id,
                # Built by step_initialize and threaded through the state machine.
                # The .get() default covers the rollout skew where an in-flight
                # execution is still pinned to a definition that does not forward it
                # (same pattern as web_search_queries): an empty derivation reads as
                # "no lineage", which is a legitimate answer rather than an error.
                DERIVATION_FIELD: event.get('derivation') or build_derivation(),
                'created_at': now,
            }

        research_id = create_counted_project_child(
            proj_table, project_id, 'research', build, 'document_count',
        )['document_id']

    # Update job as completed
    update_job_status(
        project_id, job_id, 'completed', 100, 'complete',
        result={
            'document_id': research_id,
            'title': title,
            # The persona job's shape, which the SPA's job list already reads.
            **({'metadata': _job_usage(feedback_usage)} if feedback_usage else {}),
        },
    )
    _discard_feedback_context(job_id)

    return {
        'success': True,
        'document_id': research_id,
        'feedback_count': feedback_count
    }
@tracer.capture_method
def step_error(event: dict) -> dict:
    """Handle errors - update job status."""
    project_id = event['project_id']
    job_id = event['job_id']
    error = event.get('error', {})
    logger.error(error)
    raw_cause = error.get('Cause', '{}')
    try:
        cause = json.loads(raw_cause)
    except (json.JSONDecodeError, TypeError):
        cause = {}
    if 'errorMessage' in cause:
        error_message = cause['errorMessage']
    elif raw_cause and raw_cause != '{}':
        error_message = raw_cause
    else:
        error_message = error.get('Error', 'Unknown error')
    logger.error(f"Research job {job_id} failed: {error_message}")

    update_job_status(project_id, job_id, 'failed', 0, 'error', error=error_message)
    _discard_feedback_context(job_id)

    return {'success': False, 'error': error_message}


def _step_function(step: str) -> Callable[[dict], dict]:
    """The handler for one state machine step; ValueError for an unknown step."""
    steps: dict[str, Callable[[dict], dict]] = {
        'initialize': step_initialize,
        'analyze': step_analyze,
        'synthesize': step_synthesize,
        'validate': step_validate,
        'save': step_save,
        'error': step_error,
    }
    handler = steps.get(step)
    if handler is None:
        raise ValueError(f"Unknown step: {step}")
    return handler


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler - routes to appropriate step function."""
    step = event.get('step', 'unknown')
    logger.info(f"Executing research step: {step}")

    try:
        return _step_function(step)(event)
    except BedrockThrottlingException as e:
        # Re-raise with specific error type for Step Functions retry
        logger.exception(f"Bedrock throttling in step {step}: {e}")
        raise
    except Exception as e:
        logger.exception(f"Step {step} failed: {e}")
        raise
