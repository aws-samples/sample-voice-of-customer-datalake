"""
Research Step Lambda Handler
Handles individual steps of the research workflow orchestrated by Step Functions.
Each step can run up to 15 minutes, allowing for deep analysis.
"""

import json
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from boto3.dynamodb.conditions import Key

from shared import category_access
from shared.agentic_search import run_agentic_web_search
from shared.api import api_handler
from shared.converse import BedrockThrottlingError, converse
from shared.derivation import (
    DERIVATION_FIELD,
    ROLE_REFERENCE,
    build_derivation,
    derivation_source,
)
from shared.feedback import (
    format_feedback_for_llm,
    get_feedback_statistics,
    validate_date_basis,
)
from shared.feedback import (
    get_feedback_context as _get_feedback_context,
)
from shared.ids import timestamped_id
from shared.jobs import update_job_status

# Shared module imports
from shared.logging import logger, tracer
from shared.persona_context import personas_prompt_context
from shared.project_writes import create_counted_project_child
from shared.prompts import (
    get_research_step_config,
    get_response_language_instruction,
)
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
def _project_items(proj_table: Any, project_id: str) -> list[dict]:
    response = proj_table.query(KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'))
    return response.get('Items', [])


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
        outcome = run_agentic_web_search(question, context_hint=feedback_stats)
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

    feedback_items = get_feedback_context(filters, limit=50)
    logger.info(f"Fetched {len(feedback_items)} feedback items")

    if not feedback_items:
        raise ValueError("No feedback data found matching the filters")

    update_job_status(project_id, job_id, 'running', 15, 'formatting_data')

    feedback_context = format_feedback_for_llm(feedback_items)
    feedback_stats = get_feedback_statistics(feedback_items)

    # Truncate if too large
    if len(feedback_context) > 50000:
        feedback_context = feedback_context[:50000] + "\n\n[... truncated ...]"

    selected_persona_ids = config.get('selected_persona_ids', [])
    selected_document_ids = config.get('selected_document_ids', [])
    proj_table = _get_projects_table()
    personas_context, used_persona_ids = _selected_personas_context(
        proj_table, project_id, job_id, selected_persona_ids,
    )
    documents_context, used_sources = _selected_documents_context(
        proj_table, project_id, job_id, selected_document_ids,
    )
    web_context, web_search_queries = _web_search_context(project_id, job_id, config, feedback_stats)

    update_job_status(project_id, job_id, 'running', 20, 'data_ready')

    return {
        'feedback_context': feedback_context,
        'feedback_stats': feedback_stats,
        'feedback_count': len(feedback_items),
        'personas_context': personas_context,
        'documents_context': documents_context,
        'web_context': web_context,
        'web_search_queries': web_search_queries,
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
            feedback_count=len(feedback_items),
            persona_ids=used_persona_ids,
        ),
    }
@tracer.capture_method
def step_analyze(event: dict) -> dict:
    """Step 2: Deep analysis of feedback data."""
    project_id = event['project_id']
    job_id = event['job_id']
    config = event['research_config']
    feedback_context = event['feedback_context']
    feedback_stats = event['feedback_stats']
    personas_context = event.get('personas_context', '')
    documents_context = event.get('documents_context', '')
    web_context = event.get('web_context', '')

    research_question = config.get('question', 'What are the main customer pain points?')

    logger.info(f"Starting analysis for job {job_id}")
    update_job_status(project_id, job_id, 'running', 25, 'preparing_analysis')

    inference = _step_inference('data_analysis', config)

    # Build additional context sections
    additional_context = f"\n{personas_context}\n" if personas_context else ""
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

    user_prompt = f"""Synthesize the analysis into clear findings.

Previous analysis:
{analysis}

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

    logger.info(f"Saving research results for job {job_id}")
    update_job_status(project_id, job_id, 'running', 95, 'saving')

    research_question = config.get('question', 'Research')
    filters = config.get('filters', {})
    # The basis step_initialize actually queried with (#258) — re-validated, as
    # execution input is an unvalidated boundary.
    date_basis = validate_date_basis(config.get('date_basis'))

    now = datetime.now(UTC).isoformat()

    # Strict boolean for parity with step_initialize's gating: a foreign
    # "false" string skips the search, so it must not stamp the disclosure.
    # The executed queries flow from step_initialize through the state machine
    # ('' on old executions pinned to a pre-#207 definition — .get defaults).
    web_search_used = config.get('use_web_search') is True
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
**Feedback Analyzed:** {feedback_count} items
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
                'title': config.get('title', f'Research: {research_question[:50]}'),
                'question': research_question,
                'content': full_report,
                'feedback_count': feedback_count,
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
        result={'document_id': research_id, 'title': config.get('title', f'Research: {research_question[:50]}')}
    )

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
