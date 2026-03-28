"""
Document Merger Job Lambda Handler

Merges multiple documents into a single document using LLM.
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
from shared.converse import converse
from shared.feedback import query_feedback_by_date

# Environment
PROJECTS_TABLE = os.environ.get('PROJECTS_TABLE', '')
FEEDBACK_TABLE = os.environ.get('FEEDBACK_TABLE', '')


@job_handler(error_message='Document merge failed')
def handle_job(ctx: JobContext, project_id: str, job_id: str, merge_config: dict) -> dict:
    """Handle async document merge job.
    
    Args:
        ctx: Job context for progress updates
        project_id: Project ID
        job_id: Job ID
        merge_config: Merge configuration (output_type, title, instructions, selected_document_ids, etc.)
        
    Returns:
        Result dict with document_id and title
    """
    dynamodb = get_dynamodb_resource()
    projects_table = dynamodb.Table(PROJECTS_TABLE)
    feedback_table = dynamodb.Table(FEEDBACK_TABLE)
    
    ctx.update_progress(10, 'gathering_documents')
    
    output_type = merge_config.get('output_type', 'custom')
    title = merge_config.get('title', 'Merged Document')
    instructions = merge_config.get('instructions', '')
    selected_doc_ids = merge_config.get('selected_document_ids', [])
    selected_persona_ids = merge_config.get('selected_persona_ids', [])
    use_feedback = merge_config.get('use_feedback', False)
    
    resp = projects_table.query(KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'))
    all_items = resp.get('Items', [])
    
    docs = [i for i in all_items if i.get('sk', '').startswith(('RESEARCH#', 'PRD#', 'PRFAQ#', 'DOC#'))]
    selected_docs = [d for d in docs if d.get('document_id') in selected_doc_ids]
    
    if len(selected_docs) < 2:
        raise ValueError("At least 2 documents are required for merging")
    
    ctx.update_progress(20, 'preparing_context')
    
    doc_context = "## SOURCE DOCUMENTS TO MERGE\n\n"
    for i, doc in enumerate(selected_docs, 1):
        doc_context += f"### Document {i}: {doc.get('title', 'Untitled')} ({doc.get('document_type', 'unknown').upper()})\n\n{doc.get('content', '')[:8000]}\n\n---\n\n"
    
    context_parts = [doc_context]
    
    if selected_persona_ids:
        ctx.update_progress(30, 'fetching_personas')
        personas = [i for i in all_items if i.get('sk', '').startswith('PERSONA#')]
        selected_personas = [p for p in personas if p.get('persona_id') in selected_persona_ids]
        if selected_personas:
            persona_text = "## USER PERSONAS FOR CONTEXT\n\n"
            for p in selected_personas:
                persona_text += f"**{p.get('name')}**: {p.get('tagline', '')}\n- Goals: {', '.join(p.get('goals', [])[:3])}\n- Frustrations: {', '.join(p.get('frustrations', [])[:3])}\n\n"
            context_parts.append(persona_text)
    
    if use_feedback:
        ctx.update_progress(40, 'fetching_feedback')
        feedback_sources = merge_config.get('feedback_sources', [])
        feedback_categories = merge_config.get('feedback_categories', [])
        days = merge_config.get('days', 30)
        
        feedback_items = query_feedback_by_date(
            feedback_table,
            days=days,
            sources=feedback_sources or None,
            categories=feedback_categories or None,
            limit=100,
        )
        
        if feedback_items:
            feedback_text = "## ADDITIONAL CUSTOMER FEEDBACK\n\n"
            for i, item in enumerate(feedback_items[:20], 1):
                feedback_text += f"**Review {i}** ({item.get('source_platform', 'unknown')}, {item.get('sentiment_label', 'unknown')}): {item.get('original_text', '')[:250]}\n\n"
            context_parts.append(feedback_text)
    
    ctx.update_progress(50, 'generating_merged_document')
    context = '\n\n'.join(context_parts)
    
    if output_type == 'prd':
        system_prompt = "You are a senior product manager creating a revised PRD. Merge and revise the provided source documents according to the user's instructions."
    elif output_type == 'prfaq':
        system_prompt = "You are creating a revised Amazon-style PR-FAQ. Merge and revise the provided source documents. Include PRESS RELEASE, CUSTOMER FAQ (10 questions), and INTERNAL FAQ (10 questions)."
    else:
        system_prompt = "You are a skilled document editor. Merge and revise the provided source documents according to the user's instructions."
    
    user_prompt = f"## MERGE INSTRUCTIONS\n{instructions}\n\n## OUTPUT DOCUMENT TITLE\n{title}\n\n{context}\n\nCreate a new {output_type.upper() if output_type != 'custom' else 'document'} incorporating all relevant feedback."
    
    ctx.update_progress(60, 'calling_ai')
    max_tokens = 8000 if output_type == 'prfaq' else 6000
    content = converse(prompt=user_prompt, system_prompt=system_prompt, max_tokens=max_tokens)
    
    ctx.update_progress(90, 'saving_document')
    now = datetime.now(timezone.utc).isoformat()
    doc_type_prefix = output_type if output_type in ['prd', 'prfaq'] else 'doc'
    doc_id = f"{doc_type_prefix}_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    
    projects_table.put_item(Item={
        'pk': f'PROJECT#{project_id}',
        'sk': f'{doc_type_prefix.upper()}#{doc_id}',
        'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS',
        'gsi1sk': now,
        'document_id': doc_id,
        'document_type': output_type if output_type in ['prd', 'prfaq'] else 'custom',
        'title': title,
        'content': content,
        'job_id': job_id,
        'source_documents': selected_doc_ids,
        'merge_instructions': instructions,
        'created_at': now,
    })
    projects_table.update_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
        UpdateExpression='SET document_count = document_count + :one, updated_at = :now',
        ExpressionAttributeValues={':one': 1, ':now': now}
    )
    
    return {'document_id': doc_id, 'title': title}


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context) -> dict:
    """Lambda entry point."""
    logger.info(f"Document merger invoked with event keys: {list(event.keys())}")
    return handle_job(event)
