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
from shared.persona_context import personas_prompt_context
from shared.derivation import (
    DERIVATION_FIELD,
    ROLE_MERGE_INPUT,
    build_derivation,
    derivation_source,
)
from shared.document_versions import (
    get_versioned_document_by_allocation,
    persist_versioned_document,
)
from shared.project_writes import put_project_item_and_increment

# Prototype HTML is created only by the prototype generator. Unchecked merger
# values, including ``prototype``, stay on the custom DOC# path.
MERGE_OUTPUT_TYPES = ('prd', 'prfaq', 'custom')
MERGE_VERSIONED_DOCUMENT_TYPES = frozenset({'prd', 'prfaq'})

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
    
    output_type = merge_config.get('output_type', 'custom')
    if not isinstance(output_type, str) or output_type not in MERGE_OUTPUT_TYPES:
        raise ValueError(
            f'output_type must be one of: {", ".join(MERGE_OUTPUT_TYPES)} '
            f'(got {type(output_type).__name__})'
        )
    title = merge_config.get('title', 'Merged Document')
    document_type = (
        output_type if output_type in MERGE_VERSIONED_DOCUMENT_TYPES else 'custom'
    )
    if document_type in MERGE_VERSIONED_DOCUMENT_TYPES:
        existing = get_versioned_document_by_allocation(
            projects_table, project_id, document_type, job_id,
        )
        if existing is not None:
            return {
                'document_id': existing['document_id'],
                'title': existing['title'],
            }

    ctx.update_progress(10, 'gathering_documents')

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
    # Built from THIS loop, so it lists the documents that actually reached the
    # model. selected_doc_ids can name a document that no longer exists — it is
    # filtered out above, and only selected_document_count below still counts it.
    used_sources = []
    for i, doc in enumerate(selected_docs, 1):
        doc_context += f"### Document {i}: {doc.get('title', 'Untitled')} ({doc.get('document_type', 'unknown').upper()})\n\n{doc.get('content', '')[:8000]}\n\n---\n\n"
        source = derivation_source(doc.get('document_id'), ROLE_MERGE_INPUT)
        if source:
            used_sources.append(source)
    
    context_parts = [doc_context]
    used_persona_ids = []
    used_feedback_count = 0
    
    if selected_persona_ids:
        ctx.update_progress(30, 'fetching_personas')
        personas = [i for i in all_items if i.get('sk', '').startswith('PERSONA#')]
        selected_personas = [p for p in personas if p.get('persona_id') in selected_persona_ids]
        if selected_personas:
            # Was reading phantom `goals`/`frustrations`, so every merged document
            # carried persona headings with empty values. Field paths live in
            # shared/persona_context.py.
            persona_text = personas_prompt_context(
                selected_personas, header="## USER PERSONAS FOR CONTEXT"
            )
            for p in selected_personas:
                if p.get('persona_id'):
                    used_persona_ids.append(p['persona_id'])
            if persona_text:
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
                used_feedback_count += 1
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
    # Higher token limits to support CJK languages (Korean, Japanese, Chinese)
    # which use 2-3x more tokens than English for equivalent content.
    max_tokens = 16000 if output_type == 'prfaq' else 12000
    content = converse(prompt=user_prompt, system_prompt=system_prompt, max_tokens=max_tokens, surface='documents')
    
    ctx.update_progress(90, 'saving_document')
    now = datetime.now(timezone.utc).isoformat()
    item_fields = {
        'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS',
        'gsi1sk': now,
        'content': content,
        'job_id': job_id,
        # Unchanged: the requested ids, in the merger's own long-standing shape.
        'source_documents': selected_doc_ids,
        'merge_instructions': instructions,
        # The same relation in the one shape every document type uses — and
        # unlike source_documents above, the documents that were actually merged.
        DERIVATION_FIELD: build_derivation(
            sources=used_sources,
            selected_document_count=len(selected_doc_ids),
            feedback_count=used_feedback_count,
            persona_ids=used_persona_ids,
        ),
        'created_at': now,
    }

    if document_type in MERGE_VERSIONED_DOCUMENT_TYPES:
        item = persist_versioned_document(
            projects_table,
            project_id,
            document_type,
            title,
            job_id,
            item_fields,
        )
    else:
        doc_id = f"doc_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
        item = {
            **item_fields,
            'pk': f'PROJECT#{project_id}',
            'sk': f'DOC#{doc_id}',
            'document_id': doc_id,
            'document_type': document_type,
            'title': title,
        }
        put_project_item_and_increment(
            projects_table, project_id, item, 'document_count',
        )

    return {'document_id': item['document_id'], 'title': item['title']}


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context) -> dict:
    """Lambda entry point."""
    logger.info(f"Document merger invoked with event keys: {list(event.keys())}")
    return handle_job(event, context)
