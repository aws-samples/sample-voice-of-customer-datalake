"""
Document Generator Job Lambda Handler

Generates PRD or PR-FAQ documents using multi-step LLM chains with project context.
Uses the same prompt templates and chain patterns as the synchronous projects.py path.
"""

import os
import sys
from datetime import datetime, timezone

# Add parent directory to path for shared module imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from boto3.dynamodb.conditions import Key

from shared.logging import logger, tracer, metrics
from shared.jobs import job_handler, JobContext
from shared.aws import get_dynamodb_resource
from shared.converse import converse_chain
from shared.feedback import query_feedback_by_date
from shared.prompts import get_prd_generation_steps, get_prfaq_generation_steps

# Environment
PROJECTS_TABLE = os.environ.get('PROJECTS_TABLE', '')
FEEDBACK_TABLE = os.environ.get('FEEDBACK_TABLE', '')


def _gather_context(
    ctx: JobContext,
    projects_table,
    feedback_table,
    project_id: str,
    doc_config: dict,
) -> tuple[str, str]:
    """Gather feedback, document, and persona context for document generation.

    Returns:
        (feedback_context, personas_context) formatted for LLM prompts.
    """
    data_sources = doc_config.get('data_sources', {})
    feedback_context = ''
    personas_context = ''

    # Gather feedback
    if data_sources.get('feedback'):
        ctx.update_progress(20, 'fetching_feedback')
        feedback_items = query_feedback_by_date(
            feedback_table,
            days=doc_config.get('days', 30),
            sources=doc_config.get('feedback_sources') or None,
            categories=doc_config.get('feedback_categories') or None,
            limit=100,
        )
        if feedback_items:
            parts = []
            for i, item in enumerate(feedback_items[:30], 1):
                parts.append(
                    f"**Review {i}** ({item.get('source_platform', 'unknown')}, "
                    f"{item.get('sentiment_label', 'unknown')}): "
                    f"{item.get('original_text', '')[:300]}"
                )
            feedback_context = '\n\n'.join(parts)

    # Query project items once if we need personas or documents
    all_project_items = []
    needs_project_items = data_sources.get('personas') or data_sources.get('documents') or data_sources.get('research')
    if needs_project_items:
        resp = projects_table.query(KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'))
        all_project_items = resp.get('Items', [])

    # Gather personas
    if data_sources.get('personas'):
        ctx.update_progress(30, 'fetching_personas')
        selected_ids = doc_config.get('selected_persona_ids', [])
        personas = [i for i in all_project_items if i.get('sk', '').startswith('PERSONA#')]
        if selected_ids:
            personas = [p for p in personas if p.get('persona_id') in selected_ids]
        if personas:
            parts = []
            for p in personas:
                parts.append(
                    f"**{p.get('name')}**: {p.get('tagline', '')}\n"
                    f"- Goals: {', '.join(p.get('goals', [])[:3])}\n"
                    f"- Frustrations: {', '.join(p.get('frustrations', [])[:3])}"
                )
            personas_context = '\n\n'.join(parts)

    # Gather reference documents and append to feedback context
    if data_sources.get('documents') or data_sources.get('research'):
        ctx.update_progress(40, 'fetching_documents')
        selected_ids = doc_config.get('selected_document_ids', [])
        docs = [i for i in all_project_items if i.get('sk', '').startswith(('RESEARCH#', 'PRD#', 'PRFAQ#', 'DOC#'))]
        if selected_ids:
            docs = [d for d in docs if d.get('document_id') in selected_ids]
        if docs:
            doc_parts = []
            for d in docs[:3]:
                doc_parts.append(f"### {d.get('title', 'Untitled')}\n{d.get('content', '')[:3000]}")
            doc_text = "## Reference Documents\n\n" + '\n\n'.join(doc_parts)
            feedback_context = f"{feedback_context}\n\n{doc_text}" if feedback_context else doc_text

    return feedback_context, personas_context


def _generate_prd(ctx: JobContext, feature_idea: str, feedback_context: str,
                  personas_context: str, doc_config: dict) -> tuple[str, dict]:
    """Generate PRD using multi-step LLM chain.

    Returns:
        (content, analysis) where analysis contains problem/solution intermediate results.
    """
    chain_steps = get_prd_generation_steps(
        feature_idea=feature_idea,
        personas_context=personas_context,
        feedback_context=feedback_context,
        response_language=doc_config.get('response_language'),
    )

    def progress_callback(progress, step):
        # Map chain progress (15-75%) into our 50-85% range
        mapped = 50 + int((progress - 15) / 60 * 35)
        ctx.update_progress(mapped, step)

    results = converse_chain(chain_steps, progress_callback=progress_callback)

    # results[0] = problem_analysis, results[1] = solution_design, results[2] = prd_document
    content = results[2] if len(results) >= 3 else results[-1]
    analysis = {}
    if len(results) >= 3:
        analysis = {'problem': results[0], 'solution': results[1]}

    return content, analysis


def _generate_prfaq(ctx: JobContext, feature_idea: str, feedback_context: str,
                    personas_context: str, doc_config: dict) -> tuple[str, dict]:
    """Generate PR-FAQ using multi-step LLM chain.

    Returns:
        (content, sections) where sections contains all intermediate results.
    """
    chain_steps = get_prfaq_generation_steps(
        feature_idea=feature_idea,
        personas_context=personas_context,
        feedback_context=feedback_context,
        response_language=doc_config.get('response_language'),
    )

    def progress_callback(progress, step):
        mapped = 50 + int((progress - 15) / 60 * 35)
        ctx.update_progress(mapped, step)

    results = converse_chain(chain_steps, progress_callback=progress_callback)

    # results[0] = customer_thinking, [1] = press_release, [2] = customer_faq, [3] = internal_faq
    full_document = f"""# PR/FAQ: {feature_idea}

## Press Release

{results[1] if len(results) > 1 else ''}

---

## Frequently Asked Questions

### Customer FAQ

{results[2] if len(results) > 2 else ''}

### Internal FAQ

{results[3] if len(results) > 3 else ''}
"""

    sections = {}
    if len(results) >= 4:
        sections = {
            'customer_insights': results[0],
            'press_release': results[1],
            'customer_faq': results[2],
            'internal_faq': results[3],
        }

    return full_document, sections


@job_handler(error_message='Document generation failed')
def handle_job(ctx: JobContext, project_id: str, job_id: str, doc_config: dict) -> dict:
    """Handle async document generation job (PRD/PRFAQ).

    Uses multi-step LLM chains loaded from prompt templates for higher quality
    output and better support for CJK languages.

    Args:
        ctx: Job context for progress updates
        project_id: Project ID
        job_id: Job ID
        doc_config: Document configuration (doc_type, title, feature_idea, data_sources, etc.)

    Returns:
        Result dict with document_id and title
    """
    dynamodb = get_dynamodb_resource()
    projects_table = dynamodb.Table(PROJECTS_TABLE)
    feedback_table = dynamodb.Table(FEEDBACK_TABLE)

    ctx.update_progress(10, 'gathering_context')

    doc_type = doc_config.get('doc_type', 'prd')
    title = doc_config.get('title', 'Untitled')
    feature_idea = doc_config.get('feature_idea', '')

    feedback_context, personas_context = _gather_context(
        ctx, projects_table, feedback_table, project_id, doc_config
    )

    ctx.update_progress(50, 'generating_document')

    if doc_type == 'prd':
        content, analysis = _generate_prd(ctx, feature_idea, feedback_context, personas_context, doc_config)
    else:
        content, analysis = _generate_prfaq(ctx, feature_idea, feedback_context, personas_context, doc_config)

    ctx.update_progress(90, 'saving_document')
    now_dt = datetime.now(timezone.utc)
    now = now_dt.isoformat()
    doc_id = f"{doc_type}_{now_dt.strftime('%Y%m%d%H%M%S')}"

    item = {
        'pk': f'PROJECT#{project_id}',
        'sk': f'{doc_type.upper()}#{doc_id}',
        'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS',
        'gsi1sk': now,
        'document_id': doc_id,
        'document_type': doc_type,
        'title': title,
        'feature_idea': feature_idea,
        'content': content,
        'job_id': job_id,
        'created_at': now,
    }
    if analysis:
        item['analysis'] = analysis

    projects_table.put_item(Item=item)
    projects_table.update_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
        UpdateExpression='SET document_count = if_not_exists(document_count, :zero) + :one, updated_at = :now',
        ExpressionAttributeValues={':one': 1, ':zero': 0, ':now': now}
    )

    return {'document_id': doc_id, 'title': title}


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context) -> dict:
    """Lambda entry point."""
    logger.info(f"Document generator invoked with event keys: {list(event.keys())}")
    return handle_job(event)
