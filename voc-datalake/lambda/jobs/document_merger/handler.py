"""
Document Merger Job Lambda Handler

Merges multiple documents into a single document using LLM.
"""

import os
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from boto3.dynamodb.conditions import Key

from shared import category_access
from shared.aws import get_dynamodb_resource
from shared.converse import converse
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
from shared.feedback import query_feedback_by_date
from shared.invocation_cost import instrumented_handler
from shared.jobs import JobContext, job_handler
from shared.logging import logger
from shared.persona_context import personas_prompt_context
from shared.project_writes import create_counted_project_child

# Prototype HTML is created only by the prototype generator. Unchecked merger
# values, including ``prototype``, stay on the custom DOC# path.
MERGE_OUTPUT_TYPES = ('prd', 'prfaq', 'custom')
MERGE_VERSIONED_DOCUMENT_TYPES = frozenset({'prd', 'prfaq'})

# Environment
PROJECTS_TABLE = os.environ.get('PROJECTS_TABLE', '')
FEEDBACK_TABLE = os.environ.get('FEEDBACK_TABLE', '')

SOURCE_DOCUMENT_PREFIXES = ('RESEARCH#', 'PRD#', 'PRFAQ#', 'DOC#')
SYSTEM_PROMPTS = {
    'prd': "You are a senior product manager creating a revised PRD. Merge and revise the provided source documents according to the user's instructions.",
    'prfaq': "You are creating a revised Amazon-style PR-FAQ. Merge and revise the provided source documents. Include PRESS RELEASE, CUSTOMER FAQ (10 questions), and INTERNAL FAQ (10 questions).",
    'custom': "You are a skilled document editor. Merge and revise the provided source documents according to the user's instructions.",
}


def _text(item: Mapping[str, Any], key: str, default: str = '') -> str:
    """``item[key]`` when it is a string, else ``default`` (DynamoDB rows are untyped)."""
    value = item.get(key)
    return value if isinstance(value, str) else default


def _validated_output_type(merge_config: dict) -> str:
    output_type = merge_config.get('output_type', 'custom')
    if not isinstance(output_type, str) or output_type not in MERGE_OUTPUT_TYPES:
        raise ValueError(
            f'output_type must be one of: {", ".join(MERGE_OUTPUT_TYPES)} '
            f'(got {type(output_type).__name__})'
        )
    return output_type


def _documents_context(selected_docs: Sequence[Mapping[str, Any]]) -> tuple[str, list]:
    """The source-documents prompt block and the derivation sources it used.

    Built from THIS loop, so the sources list the documents that actually reached
    the model. selected_doc_ids can name a document that no longer exists — it is
    filtered out by the caller, and only selected_document_count still counts it.
    """
    doc_context = "## SOURCE DOCUMENTS TO MERGE\n\n"
    used_sources = []
    for i, doc in enumerate(selected_docs, 1):
        doc_type = _text(doc, 'document_type', 'unknown').upper()
        doc_context += f"### Document {i}: {_text(doc, 'title', 'Untitled')} ({doc_type})\n\n{_text(doc, 'content')[:8000]}\n\n---\n\n"
        document_id = doc.get('document_id')
        source = derivation_source(document_id if isinstance(document_id, str) else None, ROLE_MERGE_INPUT)
        if source:
            used_sources.append(source)
    return doc_context, used_sources


def _personas_context(
    all_items: Sequence[Mapping[str, Any]], selected_persona_ids: list,
) -> tuple[str | None, list[str]]:
    """The personas prompt block (None when empty) and the persona ids it used."""
    selected_personas = [
        i for i in all_items
        if _text(i, 'sk').startswith('PERSONA#') and i.get('persona_id') in selected_persona_ids
    ]
    if not selected_personas:
        return None, []
    # Was reading phantom `goals`/`frustrations`, so every merged document
    # carried persona headings with empty values. Field paths live in
    # shared/persona_context.py.
    persona_text = personas_prompt_context(
        selected_personas, header="## USER PERSONAS FOR CONTEXT"
    )
    used_persona_ids = [pid for p in selected_personas if (pid := _text(p, 'persona_id'))]
    return persona_text or None, used_persona_ids


def _feedback_context(feedback_table: Any, merge_config: dict) -> tuple[str | None, int]:
    """The customer-feedback prompt block (None when no feedback) and its review count."""
    feedback_items = query_feedback_by_date(
        feedback_table,
        days=merge_config.get('days', 30),
        sources=merge_config.get('feedback_sources', []) or None,
        categories=merge_config.get('feedback_categories', []) or None,
        limit=100,
        # The starter's scope, captured at job start (projects_handler).
        category_scope=category_access.scope_from_config(
            merge_config.get(category_access.SCOPE_CONFIG_KEY)),
    )
    if not feedback_items:
        return None, 0
    reviews = feedback_items[:20]
    feedback_text = "## ADDITIONAL CUSTOMER FEEDBACK\n\n"
    for i, item in enumerate(reviews, 1):
        feedback_text += f"**Review {i}** ({item.get('source_platform', 'unknown')}, {item.get('sentiment_label', 'unknown')}): {item.get('original_text', '')[:250]}\n\n"
    return feedback_text, len(reviews)


def _save_merged_document(
    projects_table: Any, project_id: str, document_type: str, title: str, job_id: str,
    item_fields: dict,
) -> Mapping[str, Any]:
    if document_type in MERGE_VERSIONED_DOCUMENT_TYPES:
        return persist_versioned_document(
            projects_table,
            project_id,
            document_type,
            title,
            job_id,
            item_fields,
        )
    def build(doc_id: str) -> dict:
        return {
            **item_fields,
            'pk': f'PROJECT#{project_id}',
            'sk': f'DOC#{doc_id}',
            'document_id': doc_id,
            'document_type': document_type,
            'title': title,
        }

    return create_counted_project_child(projects_table, project_id, 'doc', build, 'document_count')


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

    output_type = _validated_output_type(merge_config)
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

    resp = projects_table.query(KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'))
    all_items = resp.get('Items', [])

    selected_docs = [
        i for i in all_items
        if _text(i, 'sk').startswith(SOURCE_DOCUMENT_PREFIXES) and i.get('document_id') in selected_doc_ids
    ]
    if len(selected_docs) < 2:
        raise ValueError("At least 2 documents are required for merging")

    ctx.update_progress(20, 'preparing_context')
    doc_context, used_sources = _documents_context(selected_docs)
    context_parts = [doc_context]
    used_persona_ids: list[str] = []

    if selected_persona_ids:
        ctx.update_progress(30, 'fetching_personas')
        persona_text, used_persona_ids = _personas_context(all_items, selected_persona_ids)
        if persona_text:
            context_parts.append(persona_text)

    # One pair, so "no feedback asked for" is the same (None, 0) the helper
    # answers when the window holds no feedback.
    feedback_text, used_feedback_count = None, 0
    if merge_config.get('use_feedback', False):
        ctx.update_progress(40, 'fetching_feedback')
        feedback_text, used_feedback_count = _feedback_context(feedback_table, merge_config)
    if feedback_text:
        context_parts.append(feedback_text)

    ctx.update_progress(50, 'generating_merged_document')
    context = '\n\n'.join(context_parts)
    system_prompt = SYSTEM_PROMPTS[output_type]
    user_prompt = f"## MERGE INSTRUCTIONS\n{instructions}\n\n## OUTPUT DOCUMENT TITLE\n{title}\n\n{context}\n\nCreate a new {output_type.upper() if output_type != 'custom' else 'document'} incorporating all relevant feedback."

    ctx.update_progress(60, 'calling_ai')
    # Higher token limits to support CJK languages (Korean, Japanese, Chinese)
    # which use 2-3x more tokens than English for equivalent content.
    max_tokens = 16000 if output_type == 'prfaq' else 12000
    content = converse(prompt=user_prompt, system_prompt=system_prompt, max_tokens=max_tokens, surface='documents')

    ctx.update_progress(90, 'saving_document')
    now = datetime.now(UTC).isoformat()
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
    item = _save_merged_document(projects_table, project_id, document_type, title, job_id, item_fields)
    return {'document_id': item['document_id'], 'title': item['title']}


@instrumented_handler
def lambda_handler(event: dict, context) -> dict:
    """Lambda entry point."""
    logger.info(f"Document merger invoked with event keys: {list(event.keys())}")
    return handle_job(event, context)
