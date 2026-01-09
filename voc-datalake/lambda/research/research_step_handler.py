"""
Research Step Lambda Handler
Handles individual steps of the research workflow orchestrated by Step Functions.
Each step can run up to 15 minutes, allowing for deep analysis.
"""
import json
import os
import time
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from typing import Any
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from boto3.dynamodb.conditions import Key

# Shared module imports
from shared.logging import logger, tracer, metrics
from shared.aws import get_dynamodb_resource, BEDROCK_MODEL_ID

# AWS Clients (using shared module for connection reuse)
dynamodb = get_dynamodb_resource()
# Bedrock client with extended timeout for long-running LLM calls
bedrock_config = Config(read_timeout=300, connect_timeout=10, retries={'max_attempts': 3})
bedrock = boto3.client('bedrock-runtime', config=bedrock_config)

FEEDBACK_TABLE = os.environ.get('FEEDBACK_TABLE', '')
PROJECTS_TABLE = os.environ.get('PROJECTS_TABLE', '')
JOBS_TABLE = os.environ.get('JOBS_TABLE', '')

feedback_table = dynamodb.Table(FEEDBACK_TABLE) if FEEDBACK_TABLE else None
projects_table = dynamodb.Table(PROJECTS_TABLE) if PROJECTS_TABLE else None
jobs_table = dynamodb.Table(JOBS_TABLE) if JOBS_TABLE else None

MODEL_ID = BEDROCK_MODEL_ID


class BedrockThrottlingException(Exception):
    """Custom exception for Bedrock throttling - allows Step Functions to retry."""
    pass


class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def invoke_bedrock_with_retry(system_prompt: str, user_message: str, max_tokens: int = 4096, max_retries: int = 3) -> str:
    """Invoke Bedrock with Claude Sonnet 4.5 with exponential backoff retry."""
    last_error = None
    
    for attempt in range(max_retries):
        try:
            response = bedrock.invoke_model(
                modelId=MODEL_ID,
                contentType='application/json',
                accept='application/json',
                body=json.dumps({
                    'anthropic_version': 'bedrock-2023-05-31',
                    'max_tokens': max_tokens,
                    'system': system_prompt,
                    'messages': [{'role': 'user', 'content': user_message}]
                })
            )
            result = json.loads(response['body'].read())
            return result['content'][0]['text']
        except ClientError as e:
            error_code = e.response.get('Error', {}).get('Code', '')
            last_error = e
            
            # Retry on throttling or service errors
            if error_code in ['ThrottlingException', 'ServiceUnavailableException', 'ModelStreamErrorException']:
                wait_time = (2 ** attempt) + (attempt * 0.5)  # Exponential backoff
                logger.warning(f"Bedrock {error_code}, retrying in {wait_time}s (attempt {attempt + 1}/{max_retries})")
                time.sleep(wait_time)
                continue
            else:
                # Non-retryable error
                raise
        except Exception as e:
            last_error = e
            wait_time = (2 ** attempt) + (attempt * 0.5)
            logger.warning(f"Bedrock error: {e}, retrying in {wait_time}s (attempt {attempt + 1}/{max_retries})")
            time.sleep(wait_time)
    
    # All retries exhausted - raise custom exception for Step Functions
    logger.error(f"Bedrock invocation failed after {max_retries} attempts: {last_error}")
    raise BedrockThrottlingException(f"Bedrock invocation failed after {max_retries} retries: {last_error}")


def update_job_status(project_id: str, job_id: str, status: str, progress: int, 
                      current_step: str = None, error: str = None, result: dict = None):
    """Update job status in DynamoDB."""
    if not jobs_table:
        return
    
    now = datetime.now(timezone.utc).isoformat()
    
    update_expr = 'SET #status = :status, progress = :progress, updated_at = :now'
    expr_values = {':status': status, ':progress': progress, ':now': now}
    expr_names = {'#status': 'status'}
    
    if current_step:
        update_expr += ', current_step = :step'
        expr_values[':step'] = current_step
    
    if error:
        update_expr += ', #error = :error, completed_at = :now, #ttl = :ttl'
        expr_values[':error'] = error
        expr_names['#error'] = 'error'
        expr_names['#ttl'] = 'ttl'
        # Extend TTL to 7 days for failed jobs (for debugging)
        expr_values[':ttl'] = int((datetime.now(timezone.utc) + timedelta(days=7)).timestamp())
    
    if result:
        update_expr += ', #result = :result, completed_at = :now, #ttl = :ttl'
        expr_values[':result'] = result
        expr_names['#result'] = 'result'
        expr_names['#ttl'] = 'ttl'
        # Extend TTL to 7 days for completed jobs
        expr_values[':ttl'] = int((datetime.now(timezone.utc) + timedelta(days=7)).timestamp())
    
    try:
        jobs_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': f'JOB#{job_id}'},
            UpdateExpression=update_expr,
            ExpressionAttributeValues=expr_values,
            ExpressionAttributeNames=expr_names
        )
    except Exception as e:
        logger.error(f"Failed to update job status: {e}")


def get_feedback_context(filters: dict, limit: int = 100) -> list[dict]:
    """Get feedback items based on filters for LLM context."""
    if not feedback_table:
        return []
    
    days = filters.get('days', 30)
    categories = filters.get('categories', [])
    sentiments = filters.get('sentiments', [])
    sources = filters.get('sources', [])
    
    items = []
    current_date = datetime.now(timezone.utc)
    
    # Query by date or category, then filter by source_platform in memory
    # This ensures consistent filtering with metrics aggregation
    if categories and not sources:
        for category in categories:
            response = feedback_table.query(
                IndexName='gsi2-by-category',
                KeyConditionExpression=Key('gsi2pk').eq(f'CATEGORY#{category}'),
                Limit=limit // len(categories) + 1,
                ScanIndexForward=False
            )
            items.extend(response.get('Items', []))
    else:
        for i in range(min(days, 30)):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = feedback_table.query(
                IndexName='gsi1-by-date',
                KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
                Limit=500,
                ScanIndexForward=False
            )
            items.extend(response.get('Items', []))
            if len(items) >= limit * 3:
                break
    
    # Apply source filter using source_platform field
    if sources:
        items = [i for i in items if i.get('source_platform') in sources]
    if sentiments:
        items = [i for i in items if i.get('sentiment_label') in sentiments]
    if categories and sources:
        items = [i for i in items if i.get('category') in categories]
    
    return items[:limit]


def format_feedback_for_llm(items: list[dict]) -> str:
    """Format feedback items for LLM context."""
    lines = []
    for i, item in enumerate(items, 1):
        quote = item.get('direct_customer_quote', '')
        root_cause = item.get('problem_root_cause_hypothesis', '')
        
        lines.append(f"""
### Review {i}
- Source: {item.get('source_platform', 'unknown')}
- Date: {item.get('source_created_at', '')[:10] if item.get('source_created_at') else 'N/A'}
- Sentiment: {item.get('sentiment_label', 'unknown')} (score: {item.get('sentiment_score', 0):.2f})
- Category: {item.get('category', 'other')}
- Rating: {item.get('rating', 'N/A')}/5
- Urgency: {item.get('urgency', 'low')}
- Full Text: "{item.get('original_text', '')[:600]}"
{f'- Key Quote: "{quote}"' if quote else ''}
{f'- Problem Summary: {item.get("problem_summary", "")}' if item.get('problem_summary') else ''}
{f'- Root Cause: {root_cause}' if root_cause else ''}
""")
    return '\n'.join(lines)


def get_feedback_statistics(items: list[dict]) -> str:
    """Generate summary statistics from feedback items."""
    if not items:
        return "No feedback data available."
    
    sentiments = {}
    categories = {}
    sources = {}
    urgency_counts = {'high': 0, 'medium': 0, 'low': 0}
    ratings = []
    
    for item in items:
        sent = item.get('sentiment_label', 'unknown')
        sentiments[sent] = sentiments.get(sent, 0) + 1
        
        cat = item.get('category', 'other')
        categories[cat] = categories.get(cat, 0) + 1
        
        src = item.get('source_platform', 'unknown')
        sources[src] = sources.get(src, 0) + 1
        
        urg = item.get('urgency', 'low')
        if urg in urgency_counts:
            urgency_counts[urg] += 1
        
        if item.get('rating'):
            ratings.append(float(item['rating']))
    
    avg_rating = sum(ratings) / len(ratings) if ratings else 0
    
    return f"""## Feedback Statistics (n={len(items)})

**Sentiment Distribution:**
{chr(10).join([f"- {k}: {v} ({v/len(items)*100:.1f}%)" for k, v in sorted(sentiments.items(), key=lambda x: x[1], reverse=True)])}

**Top Categories:**
{chr(10).join([f"- {k}: {v}" for k, v in sorted(categories.items(), key=lambda x: x[1], reverse=True)[:5]])}

**Sources:**
{chr(10).join([f"- {k}: {v}" for k, v in sorted(sources.items(), key=lambda x: x[1], reverse=True)])}

**Urgency:** High: {urgency_counts['high']} | Medium: {urgency_counts['medium']} | Low: {urgency_counts['low']}

**Average Rating:** {avg_rating:.1f}/5 (from {len(ratings)} rated reviews)
"""


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
    if selected_persona_ids and projects_table:
        update_job_status(project_id, job_id, 'running', 17, 'fetching_personas')
        response = projects_table.query(KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'))
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
    if selected_document_ids and projects_table:
        update_job_status(project_id, job_id, 'running', 18, 'fetching_documents')
        response = projects_table.query(KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'))
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
    if projects_table:
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
        projects_table.put_item(Item=item)
        
        # Update document count
        projects_table.update_item(
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
    
    error_message = str(error.get('Cause', error.get('Error', 'Unknown error')))
    logger.error(f"Research job {job_id} failed: {error_message}")
    
    update_job_status(project_id, job_id, 'failed', 0, 'error', error=error_message)
    
    return {'success': False, 'error': error_message}


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
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
