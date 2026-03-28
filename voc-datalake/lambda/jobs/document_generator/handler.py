"""
Document Generator Job Lambda Handler

Generates PRD or PR-FAQ documents using LLM with project context.
"""

import os
import sys
from datetime import datetime, timezone, timedelta

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


@job_handler(error_message='Document generation failed')
def handle_job(ctx: JobContext, project_id: str, job_id: str, doc_config: dict) -> dict:
    """Handle async document generation job (PRD/PRFAQ).
    
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
    data_sources = doc_config.get('data_sources', {})
    customer_questions = doc_config.get('customer_questions', [])
    
    context_parts = []
    
    # Gather feedback
    if data_sources.get('feedback'):
        ctx.update_progress(20, 'fetching_feedback')
        feedback_sources = doc_config.get('feedback_sources', [])
        feedback_categories = doc_config.get('feedback_categories', [])
        days = doc_config.get('days', 30)
        
        feedback_items = query_feedback_by_date(
            feedback_table,
            days=days,
            sources=feedback_sources or None,
            categories=feedback_categories or None,
            limit=100,
        )
        
        if feedback_items:
            feedback_text = "## Customer Feedback\n\n"
            for i, item in enumerate(feedback_items[:30], 1):
                feedback_text += f"**Review {i}** ({item.get('source_platform', 'unknown')}, {item.get('sentiment_label', 'unknown')}): {item.get('original_text', '')[:300]}\n\n"
            context_parts.append(feedback_text)
    
    # Gather personas
    if data_sources.get('personas'):
        ctx.update_progress(30, 'fetching_personas')
        selected_ids = doc_config.get('selected_persona_ids', [])
        resp = projects_table.query(KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'))
        personas = [i for i in resp.get('Items', []) if i.get('sk', '').startswith('PERSONA#')]
        if selected_ids:
            personas = [p for p in personas if p.get('persona_id') in selected_ids]
        if personas:
            persona_text = "## User Personas\n\n"
            for p in personas:
                persona_text += f"**{p.get('name')}**: {p.get('tagline', '')}\n- Goals: {', '.join(p.get('goals', [])[:3])}\n- Frustrations: {', '.join(p.get('frustrations', [])[:3])}\n\n"
            context_parts.append(persona_text)
    
    # Gather documents
    if data_sources.get('documents') or data_sources.get('research'):
        ctx.update_progress(40, 'fetching_documents')
        selected_ids = doc_config.get('selected_document_ids', [])
        resp = projects_table.query(KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'))
        docs = [i for i in resp.get('Items', []) if i.get('sk', '').startswith(('RESEARCH#', 'PRD#', 'PRFAQ#', 'DOC#'))]
        if selected_ids:
            docs = [d for d in docs if d.get('document_id') in selected_ids]
        if docs:
            doc_text = "## Reference Documents\n\n"
            for d in docs[:3]:
                doc_text += f"### {d.get('title', 'Untitled')}\n{d.get('content', '')[:3000]}\n\n"
            context_parts.append(doc_text)
    
    ctx.update_progress(50, 'generating_document')
    context = '\n\n'.join(context_parts) if context_parts else 'No additional context provided.'
    
    # Build prompts based on doc type
    if doc_type == 'prd':
        system_prompt = """You are a senior product manager creating a Product Requirements Document (PRD).
Create a comprehensive PRD that includes: Problem Statement, Goals & Success Metrics, User Stories, Requirements (functional & non-functional), Out of Scope, Timeline, and Risks."""
        user_prompt = f"Create a PRD for: {title}\n\nFeature Description: {feature_idea}\n\n{context}\n\nGenerate a complete PRD in markdown format."
    else:
        q_labels = [
            "Who is the customer?",
            "What is the customer problem or opportunity?",
            "What is the most important customer benefit?",
            "How do you know what customers need or want?",
            "What does the customer experience look like?"
        ]
        questions_context = "\n\n".join([
            f"**{q_labels[i]}**\n{q.strip()}"
            for i, q in enumerate(customer_questions[:5])
            if q and q.strip()
        ])
        system_prompt = """You are creating an Amazon-style Working Backwards PR-FAQ document. Write in "Oprah-speak" NOT "Geek-speak". Keep it simple. This is NOT a spec - it's a customer-focused announcement."""
        user_prompt = f"Create an Amazon Working Backwards PR-FAQ for: {title}\n\nFeature Description: {feature_idea}\n\n## Working Backwards Input:\n{questions_context or 'Use the customer feedback context below.'}\n\n{context}\n\nGenerate a COMPLETE PR-FAQ with PRESS RELEASE, CUSTOMER FAQ (10 questions), and INTERNAL FAQ (10 questions)."
    
    ctx.update_progress(60, 'calling_ai')
    max_tokens = 8000 if doc_type == 'prfaq' else 5000
    content = converse(prompt=user_prompt, system_prompt=system_prompt, max_tokens=max_tokens)
    
    ctx.update_progress(90, 'saving_document')
    now = datetime.now(timezone.utc).isoformat()
    doc_id = f"{doc_type}_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    
    projects_table.put_item(Item={
        'pk': f'PROJECT#{project_id}',
        'sk': f'{doc_type.upper()}#{doc_id}',
        'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS',
        'gsi1sk': now,
        'document_id': doc_id,
        'document_type': doc_type,
        'title': title,
        'content': content,
        'job_id': job_id,
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
    logger.info(f"Document generator invoked with event keys: {list(event.keys())}")
    return handle_job(event)
