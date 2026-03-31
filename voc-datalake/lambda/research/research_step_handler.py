"""
Research Step Lambda Handler
Handles individual steps of the research workflow orchestrated by Step Functions.
Each step can run up to 15 minutes, allowing for deep analysis.
"""
import json
import os
import time
from datetime import datetime, timezone, timedelta
from typing import Any
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from boto3.dynamodb.conditions import Key

# Shared module imports
from shared.logging import logger, tracer
from shared.aws import get_dynamodb_resource, BEDROCK_MODEL_ID
from shared.api import api_handler, DecimalEncoder
from shared.converse import converse, BedrockThrottlingError
from shared.feedback import (
    get_feedback_context as _get_feedback_context,
    format_feedback_for_llm,
    get_feedback_statistics,
)
from shared.tables import get_projects_table, get_feedback_table
from shared.jobs import update_job_status

# AWS Clients (using shared module for connection reuse)
dynamodb = get_dynamodb_resource()

FEEDBACK_TABLE = os.environ.get('FEEDBACK_TABLE', '')
PROJECTS_TABLE = os.environ.get('PROJECTS_TABLE', '')

# Use shared table accessors - these will be initialized on first use
feedback_table = None
projects_table = None

MODEL_ID = BEDROCK_MODEL_ID


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


def invoke_bedrock_with_retry(system_prompt: str, user_message: str, max_tokens: int = 4096, max_retries: int = 3) -> str:
    """Invoke Bedrock with retry support using shared converse module."""
    return converse(
        prompt=user_message,
        system_prompt=system_prompt,
        max_tokens=max_tokens,
        max_retries=max_retries,
        raise_on_throttle=True,
    )


# Wrapper function to pass module-level table reference to shared function
def get_feedback_context(filters: dict, limit: int = 100) -> list[dict]:
    """Get feedback items based on filters for LLM context."""
    return _get_feedback_context(_get_feedback_table(), filters, limit)


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
        'days': config.get('days', 30)
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
    
    # Optional: Get selected personas context
    personas_context = ""
    selected_persona_ids = config.get('selected_persona_ids', [])
    proj_table = _get_projects_table()
    if selected_persona_ids and proj_table:
        update_job_status(project_id, job_id, 'running', 17, 'fetching_personas')
        response = proj_table.query(KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'))
        all_personas = [i for i in response.get('Items', []) if i.get('sk', '').startswith('PERSONA#')]
        selected_personas = [p for p in all_personas if p.get('persona_id') in selected_persona_ids]
        
        if selected_personas:
            personas_context = "## Selected Personas\n\n"
            for p in selected_personas:
                personas_context += f"**{p.get('name')}** - {p.get('tagline', '')}\n"
                personas_context += f"- Goals: {', '.join(p.get('goals', [])[:3])}\n"
                personas_context += f"- Frustrations: {', '.join(p.get('frustrations', [])[:3])}\n"
                personas_context += f"- Quote: \"{p.get('quote', '')}\"\n\n"
    
    # Optional: Get selected documents context
    documents_context = ""
    selected_document_ids = config.get('selected_document_ids', [])
    if selected_document_ids and proj_table:
        update_job_status(project_id, job_id, 'running', 18, 'fetching_documents')
        response = proj_table.query(KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'))
        all_docs = [i for i in response.get('Items', []) if i.get('sk', '').startswith(('DOC#', 'RESEARCH#', 'PRD#', 'PRFAQ#'))]
        selected_docs = [d for d in all_docs if d.get('document_id') in selected_document_ids]
        
        if selected_docs:
            documents_context = "## Reference Documents\n\n"
            for d in selected_docs[:3]:  # Limit to 3 docs to avoid context overflow
                content = d.get('content', '')[:5000]  # Truncate long docs
                documents_context += f"### {d.get('title', 'Untitled')} ({d.get('document_type', 'doc').upper()})\n\n{content}\n\n---\n\n"
    
    update_job_status(project_id, job_id, 'running', 20, 'data_ready')
    
    return {
        'feedback_context': feedback_context,
        'feedback_stats': feedback_stats,
        'feedback_count': len(feedback_items),
        'personas_context': personas_context,
        'documents_context': documents_context
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
    
    research_question = config.get('question', 'What are the main customer pain points?')
    
    logger.info(f"Starting analysis for job {job_id}")
    update_job_status(project_id, job_id, 'running', 25, 'preparing_analysis')
    
    system_prompt = """You are a senior user researcher conducting rigorous analysis of REAL customer feedback data.
Your analysis must be grounded in the actual feedback provided - cite specific reviews, quote customers directly, and identify patterns from the data.
Be thorough, data-driven, and cite specific examples."""
    
    # Build additional context sections
    additional_context = ""
    if personas_context:
        additional_context += f"\n{personas_context}\n"
    if documents_context:
        additional_context += f"\n{documents_context}\n"
    
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

    update_job_status(project_id, job_id, 'running', 30, 'calling_ai')
    analysis = invoke_bedrock_with_retry(system_prompt, user_prompt, max_tokens=4000)
    
    update_job_status(project_id, job_id, 'running', 45, 'analysis_complete')
    
    return {'analysis': analysis}


@tracer.capture_method
def step_synthesize(event: dict) -> dict:
    """Step 3: Synthesize findings into actionable insights."""
    project_id = event['project_id']
    job_id = event['job_id']
    analysis = event['analysis']
    
    logger.info(f"Synthesizing findings for job {job_id}")
    update_job_status(project_id, job_id, 'running', 50, 'preparing_synthesis')
    
    system_prompt = """You are synthesizing research findings into actionable insights.
Focus on clarity, prioritization, and recommendations."""
    
    user_prompt = f"""Synthesize the analysis into clear findings.

Previous analysis:
{analysis}

Provide:
1. **Executive Summary** (2-3 sentences)
2. **Key Findings** (prioritized list with confidence levels)
3. **Supporting Evidence** (quotes and data points)
4. **Recommendations** (actionable next steps)
5. **Areas for Further Research**"""

    update_job_status(project_id, job_id, 'running', 55, 'calling_ai')
    synthesis = invoke_bedrock_with_retry(system_prompt, user_prompt, max_tokens=3000)
    
    update_job_status(project_id, job_id, 'running', 70, 'synthesis_complete')
    
    return {'synthesis': synthesis}


@tracer.capture_method
def step_validate(event: dict) -> dict:
    """Step 4: Validate and cross-check findings."""
    project_id = event['project_id']
    job_id = event['job_id']
    analysis = event['analysis']
    synthesis = event['synthesis']
    
    logger.info(f"Validating research for job {job_id}")
    update_job_status(project_id, job_id, 'running', 75, 'preparing_validation')
    
    system_prompt = """You are a critical reviewer ensuring research quality.
Challenge assumptions and verify conclusions."""
    
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

    update_job_status(project_id, job_id, 'running', 80, 'calling_ai')
    validation = invoke_bedrock_with_retry(system_prompt, user_prompt, max_tokens=3000)
    
    update_job_status(project_id, job_id, 'running', 90, 'validation_complete')
    
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
    
    now = datetime.now(timezone.utc).isoformat()
    research_id = f"research_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    
    # Build comprehensive report
    full_report = f"""# Research Report: {research_question}

**Generated:** {now[:10]}
**Feedback Analyzed:** {feedback_count} items
**Filters:** Sources: {', '.join(filters.get('sources', [])) or 'All'} | Categories: {', '.join(filters.get('categories', [])) or 'All'} | Sentiments: {', '.join(filters.get('sentiments', [])) or 'All'} | Days: {filters.get('days', 30)}

---

## Executive Summary & Key Findings

{synthesis}

---

## Detailed Analysis

{analysis}

---

## Validation & Confidence Assessment

{validation}
"""
    
    # Truncate if needed (DynamoDB 400KB limit)
    max_content_size = 350000
    if len(full_report) > max_content_size:
        full_report = full_report[:max_content_size] + "\n\n---\n\n*[Report truncated due to size limits]*"
    
    # Save to projects table
    proj_table = _get_projects_table()
    if proj_table:
        item = {
            'pk': f'PROJECT#{project_id}',
            'sk': f'RESEARCH#{research_id}',
            'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS',
            'gsi1sk': now,
            'document_id': research_id,
            'document_type': 'research',
            'title': config.get('title', f'Research: {research_question[:50]}'),
            'question': research_question,
            'content': full_report,
            'feedback_count': feedback_count,
            'job_id': job_id,
            'created_at': now,
        }
        proj_table.put_item(Item=item)
        
        # Update document count
        proj_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
            UpdateExpression='SET document_count = document_count + :one, updated_at = :now',
            ExpressionAttributeValues={':one': 1, ':now': now}
        )
    
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


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler - routes to appropriate step function."""
    step = event.get('step', 'unknown')
    logger.info(f"Executing research step: {step}")
    
    try:
        if step == 'initialize':
            return step_initialize(event)
        elif step == 'analyze':
            return step_analyze(event)
        elif step == 'synthesize':
            return step_synthesize(event)
        elif step == 'validate':
            return step_validate(event)
        elif step == 'save':
            return step_save(event)
        elif step == 'error':
            return step_error(event)
        else:
            raise ValueError(f"Unknown step: {step}")
    except BedrockThrottlingException as e:
        # Re-raise with specific error type for Step Functions retry
        logger.error(f"Bedrock throttling in step {step}: {e}")
        raise
    except Exception as e:
        logger.exception(f"Step {step} failed: {e}")
        raise
