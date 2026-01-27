"""
Projects API Lambda Handler
Separate Lambda to handle projects endpoints and avoid policy size limits.
"""

import json
import os
import base64
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any

from shared.logging import logger, tracer
from shared.aws import (
    get_dynamodb_resource, get_bedrock_client, invoke_self_async, BEDROCK_MODEL_ID
)
from shared.api import create_api_resolver, validate_days, validate_int, api_handler, DecimalEncoder
from shared.converse import converse

from boto3.dynamodb.conditions import Key
import boto3

from projects import (
    list_projects, create_project, get_project, update_project, delete_project,
    generate_personas, project_chat, run_research,
    create_document, update_document, delete_document,
    create_persona, update_persona, delete_persona,
    add_persona_note, update_persona_note, delete_persona_note,
    regenerate_persona_avatar, generate_persona_avatar, get_avatar_cdn_url,
)

# API resolver with standard CORS
app = create_api_resolver()

# Environment
JOBS_TABLE = os.environ.get('JOBS_TABLE', '')
PROJECTS_TABLE = os.environ.get('PROJECTS_TABLE', '')
FEEDBACK_TABLE = os.environ.get('FEEDBACK_TABLE', '')
RAW_DATA_BUCKET = os.environ.get('RAW_DATA_BUCKET', '')
AGGREGATES_TABLE = os.environ.get('AGGREGATES_TABLE', '')

# Cached table references
_jobs_table = None
_aggregates_table = None


def get_jobs_table():
    """Get jobs table resource with connection reuse."""
    global _jobs_table
    if _jobs_table is None:
        _jobs_table = get_dynamodb_resource().Table(JOBS_TABLE)
    return _jobs_table


def get_aggregates_table():
    """Get aggregates table resource with connection reuse."""
    global _aggregates_table
    if _aggregates_table is None:
        _aggregates_table = get_dynamodb_resource().Table(AGGREGATES_TABLE)
    return _aggregates_table


def validate_persona_count(value, default=3):
    """Validate persona count parameter."""
    return validate_int(value, default=default, min_val=1, max_val=10)


def create_job(project_id: str, job_type: str, config_key: str, config: dict, ttl_minutes: int = 30, status: str = 'running') -> tuple[str, str]:
    """Create a job record and return (job_id, now).
    
    Args:
        project_id: Project ID
        job_type: Type of job (e.g., 'generate_personas', 'research')
        config_key: Key name for the config in the item (e.g., 'filters', 'doc_config')
        config: Configuration dict for the job
        ttl_minutes: TTL in minutes (default 30)
        status: Initial status ('running' or 'pending')
    """
    job_id = f"job_{uuid.uuid4().hex[:16]}"
    now = datetime.now(timezone.utc).isoformat()
    ttl = int((datetime.now(timezone.utc) + timedelta(minutes=ttl_minutes)).timestamp())
    
    item = {
        'pk': f'PROJECT#{project_id}',
        'sk': f'JOB#{job_id}',
        'gsi1pk': f'STATUS#{status}',
        'gsi1sk': now,
        'job_id': job_id,
        'project_id': project_id,
        'job_type': job_type,
        'status': status,
        'progress': 0,
        'current_step': 'queued' if status == 'pending' else 'starting',
        'created_at': now,
        'updated_at': now,
        'ttl': ttl,
        config_key: config
    }
    get_jobs_table().put_item(Item=item)
    return job_id, now


# ============================================
# Project CRUD Routes
# ============================================

@app.get("/projects/config")
@tracer.capture_method
def api_get_config():
    return {'chat_stream_url': os.environ.get('CHAT_STREAM_URL', '')}


@app.get("/projects")
@tracer.capture_method
def api_list_projects():
    return list_projects()


@app.post("/projects")
@tracer.capture_method
def api_create_project():
    return create_project(app.current_event.json_body)


@app.get("/projects/<project_id>")
@tracer.capture_method
def api_get_project(project_id: str):
    return get_project(project_id)


@app.put("/projects/<project_id>")
@tracer.capture_method
def api_update_project(project_id: str):
    return update_project(project_id, app.current_event.json_body)


@app.delete("/projects/<project_id>")
@tracer.capture_method
def api_delete_project(project_id: str):
    return delete_project(project_id)


# ============================================
# Persona Routes
# ============================================

@app.post("/projects/<project_id>/personas")
@tracer.capture_method
def api_create_persona(project_id: str):
    return create_persona(project_id, app.current_event.json_body)


@app.post("/projects/<project_id>/personas/import")
@tracer.capture_method
def api_import_persona(project_id: str):
    """Import a persona from PDF, image, or text - runs as background job."""
    body = app.current_event.json_body or {}
    config = {
        'input_type': body.get('input_type', 'text'),
        'content': body.get('content', ''),
        'media_type': body.get('media_type', '')
    }
    job_id, _ = create_job(project_id, 'import_persona', 'import_config', config)
    invoke_self_async({'job_type': 'import_persona', 'project_id': project_id, 'job_id': job_id, 'import_config': config})
    return {'success': True, 'job_id': job_id, 'status': 'running', 'message': 'Persona import started.'}


@app.put("/projects/<project_id>/personas/<persona_id>")
@tracer.capture_method
def api_update_persona(project_id: str, persona_id: str):
    return update_persona(project_id, persona_id, app.current_event.json_body)


@app.delete("/projects/<project_id>/personas/<persona_id>")
@tracer.capture_method
def api_delete_persona(project_id: str, persona_id: str):
    return delete_persona(project_id, persona_id)


@app.post("/projects/<project_id>/personas/<persona_id>/notes")
@tracer.capture_method
def api_add_persona_note(project_id: str, persona_id: str):
    return add_persona_note(project_id, persona_id, app.current_event.json_body)


@app.put("/projects/<project_id>/personas/<persona_id>/notes/<note_id>")
@tracer.capture_method
def api_update_persona_note(project_id: str, persona_id: str, note_id: str):
    return update_persona_note(project_id, persona_id, note_id, app.current_event.json_body)


@app.delete("/projects/<project_id>/personas/<persona_id>/notes/<note_id>")
@tracer.capture_method
def api_delete_persona_note(project_id: str, persona_id: str, note_id: str):
    return delete_persona_note(project_id, persona_id, note_id)


@app.post("/projects/<project_id>/personas/<persona_id>/regenerate-avatar")
@tracer.capture_method
def api_regenerate_persona_avatar(project_id: str, persona_id: str):
    return regenerate_persona_avatar(project_id, persona_id)


@app.post("/projects/<project_id>/personas/generate")
@tracer.capture_method
def api_generate_personas(project_id: str):
    """Start async persona generation."""
    body = app.current_event.json_body or {}
    filters = {
        'sources': body.get('sources', []),
        'categories': body.get('categories', []),
        'sentiments': body.get('sentiments', []),
        'days': validate_days(body.get('days'), default=30),
        'persona_count': validate_persona_count(body.get('persona_count')),
        'custom_instructions': body.get('custom_instructions', ''),
    }
    job_id, _ = create_job(project_id, 'generate_personas', 'filters', filters, ttl_minutes=30*24*60)
    invoke_self_async({'job_type': 'generate_personas', 'project_id': project_id, 'job_id': job_id, 'filters': filters})
    return {'success': True, 'job_id': job_id, 'status': 'running', 'message': 'Persona generation started.'}


# ============================================
# Document Routes
# ============================================

@app.post("/projects/<project_id>/chat")
@tracer.capture_method
def api_project_chat(project_id: str):
    return project_chat(project_id, app.current_event.json_body)


@app.post("/projects/<project_id>/research")
@tracer.capture_method
def api_run_research(project_id: str):
    """Start research via Step Functions."""
    body = app.current_event.json_body or {}
    research_config = {
        'question': body.get('question', 'What are the main customer pain points?'),
        'title': body.get('title', ''),
        'sources': body.get('sources', []),
        'categories': body.get('categories', []),
        'sentiments': body.get('sentiments', []),
        'days': validate_days(body.get('days'), default=30),
        'selected_persona_ids': body.get('selected_persona_ids', []),
        'selected_document_ids': body.get('selected_document_ids', []),
        'filters': body
    }
    job_id, _ = create_job(project_id, 'research', 'research_config', research_config, status='pending')
    
    state_machine_arn = os.environ.get('RESEARCH_STATE_MACHINE_ARN', '')
    if state_machine_arn:
        boto3.client('stepfunctions').start_execution(
            stateMachineArn=state_machine_arn,
            name=job_id,
            input=json.dumps({'job_id': job_id, 'project_id': project_id, 'research_config': research_config})
        )
    else:
        return run_research(project_id, body)
    
    return {'success': True, 'job_id': job_id, 'status': 'pending', 'message': 'Research started.'}


@app.post("/projects/<project_id>/document")
@tracer.capture_method
def api_generate_document(project_id: str):
    """Generate PRD or PR-FAQ document."""
    body = app.current_event.json_body or {}
    doc_type = body.get('doc_type', 'prd')
    job_id, _ = create_job(project_id, f'generate_{doc_type}', 'doc_config', body, status='pending')
    
    state_machine_arn = os.environ.get('DOCUMENT_STATE_MACHINE_ARN', '')
    if state_machine_arn:
        boto3.client('stepfunctions').start_execution(
            stateMachineArn=state_machine_arn,
            name=job_id,
            input=json.dumps({'job_id': job_id, 'project_id': project_id, 'doc_config': body})
        )
    else:
        invoke_self_async({'job_type': f'generate_{doc_type}', 'project_id': project_id, 'job_id': job_id, 'doc_config': body})
    
    return {'success': True, 'job_id': job_id, 'status': 'pending', 'message': f'{doc_type.upper()} generation started.'}


@app.post("/projects/<project_id>/documents")
@tracer.capture_method
def api_create_document(project_id: str):
    return create_document(project_id, app.current_event.json_body)


@app.post("/projects/<project_id>/documents/merge")
@tracer.capture_method
def api_merge_documents(project_id: str):
    """Merge multiple documents."""
    body = app.current_event.json_body or {}
    job_id, _ = create_job(project_id, 'merge_documents', 'merge_config', body, status='pending')
    invoke_self_async({'job_type': 'merge_documents', 'project_id': project_id, 'job_id': job_id, 'merge_config': body})
    return {'success': True, 'job_id': job_id, 'status': 'pending', 'message': 'Document merge started.'}


@app.put("/projects/<project_id>/documents/<document_id>")
@tracer.capture_method
def api_update_document(project_id: str, document_id: str):
    return update_document(project_id, document_id, app.current_event.json_body)


@app.delete("/projects/<project_id>/documents/<document_id>")
@tracer.capture_method
def api_delete_document(project_id: str, document_id: str):
    return delete_document(project_id, document_id)


# ============================================
# Job Routes
# ============================================

@app.get("/projects/<project_id>/jobs/<job_id>")
@tracer.capture_method
def api_get_job_status(project_id: str, job_id: str):
    response = get_jobs_table().get_item(Key={'pk': f'PROJECT#{project_id}', 'sk': f'JOB#{job_id}'})
    item = response.get('Item')
    if not item:
        return {'success': False, 'message': 'Job not found'}
    return {
        'success': True, 'job_id': job_id, 'status': item.get('status'),
        'progress': item.get('progress', 0), 'current_step': item.get('current_step'),
        'job_type': item.get('job_type'), 'created_at': item.get('created_at'),
        'updated_at': item.get('updated_at'), 'completed_at': item.get('completed_at'),
        'error': item.get('error'), 'result': item.get('result')
    }


@app.get("/projects/<project_id>/jobs")
@tracer.capture_method
def api_list_jobs(project_id: str):
    response = get_jobs_table().query(
        KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'),
        ScanIndexForward=False, Limit=50
    )
    jobs = [{
        'job_id': i.get('job_id'), 'job_type': i.get('job_type'), 'status': i.get('status'),
        'progress': i.get('progress', 0), 'current_step': i.get('current_step'),
        'created_at': i.get('created_at'), 'updated_at': i.get('updated_at'),
        'completed_at': i.get('completed_at'), 'error': i.get('error'), 'result': i.get('result')
    } for i in response.get('Items', [])]
    return {'success': True, 'jobs': jobs}


@app.delete("/projects/<project_id>/jobs/<job_id>")
@tracer.capture_method
def api_delete_job(project_id: str, job_id: str):
    get_jobs_table().delete_item(Key={'pk': f'PROJECT#{project_id}', 'sk': f'JOB#{job_id}'})
    return {'success': True}


# ============================================
# Prioritization Routes
# ============================================

@app.get("/projects/prioritization")
@tracer.capture_method
def api_get_prioritization_scores():
    try:
        response = get_aggregates_table().get_item(Key={'pk': 'PRIORITIZATION', 'sk': 'SCORES'})
        return {'scores': response.get('Item', {}).get('scores', {})}
    except Exception as e:
        logger.warning(f"Failed to get prioritization scores: {e}")
        return {'scores': {}}


@app.put("/projects/prioritization")
@tracer.capture_method
def api_save_prioritization_scores():
    body = app.current_event.json_body or {}
    try:
        get_aggregates_table().put_item(Item={
            'pk': 'PRIORITIZATION', 'sk': 'SCORES',
            'scores': body.get('scores', {}),
            'updated_at': datetime.now(timezone.utc).isoformat()
        })
        return {'success': True}
    except Exception as e:
        logger.exception(f"Failed to save prioritization scores: {e}")
        return {'success': False, 'message': 'Failed to save prioritization scores'}


@app.patch("/projects/prioritization")
@tracer.capture_method
def api_patch_prioritization_scores():
    body = app.current_event.json_body or {}
    changed_scores = body.get('scores', {})
    if not changed_scores:
        return {'success': True, 'message': 'No changes to save'}
    try:
        table = get_aggregates_table()
        response = table.get_item(Key={'pk': 'PRIORITIZATION', 'sk': 'SCORES'})
        existing_scores = response.get('Item', {}).get('scores', {})
        merged_scores = {**existing_scores, **changed_scores}
        table.put_item(Item={
            'pk': 'PRIORITIZATION', 'sk': 'SCORES',
            'scores': merged_scores,
            'updated_at': datetime.now(timezone.utc).isoformat()
        })
        return {'success': True, 'updated_count': len(changed_scores)}
    except Exception as e:
        logger.exception(f"Failed to patch prioritization scores: {e}")
        return {'success': False, 'message': 'Failed to save prioritization scores'}


# ============================================
# Async Job Handlers
# ============================================

def update_job_status(project_id: str, job_id: str, status: str, progress: int, step: str, error: str = None, result: dict = None):
    """Update job status in DynamoDB."""
    now = datetime.now(timezone.utc).isoformat()
    update_expr = 'SET #status = :status, progress = :progress, current_step = :step, updated_at = :now, gsi1pk = :gsi1pk'
    expr_values = {':status': status, ':progress': progress, ':step': step, ':now': now, ':gsi1pk': f'STATUS#{status}'}
    expr_names = {'#status': 'status'}
    
    if error:
        update_expr += ', #error = :error, completed_at = :now, #ttl = :ttl'
        expr_values[':error'] = error
        expr_names['#error'] = 'error'
        expr_names['#ttl'] = 'ttl'
        expr_values[':ttl'] = int((datetime.now(timezone.utc) + timedelta(days=7)).timestamp())
    if result:
        update_expr += ', #result = :result, completed_at = :now, #ttl = :ttl'
        expr_values[':result'] = result
        expr_names['#result'] = 'result'
        expr_names['#ttl'] = 'ttl'
        expr_values[':ttl'] = int((datetime.now(timezone.utc) + timedelta(days=7)).timestamp())
    
    get_jobs_table().update_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': f'JOB#{job_id}'},
        UpdateExpression=update_expr,
        ExpressionAttributeValues=expr_values,
        ExpressionAttributeNames=expr_names
    )


def handle_generate_personas_job(event: dict) -> dict:
    """Handle async persona generation job."""
    import time
    
    logger.info(f"[JOB] ========== ASYNC PERSONA JOB STARTED ==========")
    logger.info(f"[JOB] Event: {event}")
    job_start = time.time()
    
    project_id = event['project_id']
    job_id = event['job_id']
    filters = event['filters']
    
    logger.info(f"[JOB] Project: {project_id}, Job: {job_id}")
    logger.info(f"[JOB] Filters: {filters}")
    
    def progress_callback(progress: int, step: str):
        logger.info(f"[JOB] Progress callback: {progress}% - {step}")
        try:
            update_job_status(project_id, job_id, 'running', progress, step)
            logger.info(f"[JOB] Job status updated successfully")
        except Exception as e:
            logger.error(f"[JOB] Failed to update job status: {e}")
    
    try:
        logger.info(f"[JOB] Calling generate_personas...")
        result = generate_personas(project_id, filters, progress_callback=progress_callback)
        
        job_elapsed = time.time() - job_start
        logger.info(f"[JOB] generate_personas returned after {job_elapsed:.2f}s")
        logger.info(f"[JOB] Result success: {result.get('success', False)}")
        
        update_job_status(project_id, job_id, 'completed', 100, 'complete', result=result)
        logger.info(f"[JOB] ========== ASYNC PERSONA JOB COMPLETED ==========")
        return {'statusCode': 200, 'body': json.dumps({'success': True})}
    except Exception as e:
        job_elapsed = time.time() - job_start
        logger.exception(f"[JOB] Persona generation FAILED after {job_elapsed:.2f}s: {type(e).__name__}: {e}")
        update_job_status(project_id, job_id, 'failed', 0, 'error', error=f'Job execution failed: {str(e)[:200]}')
        logger.info(f"[JOB] ========== ASYNC PERSONA JOB FAILED ==========")
        return {'statusCode': 500, 'body': json.dumps({'success': False, 'error': 'Job execution failed'})}


def handle_generate_document_job(event: dict) -> dict:
    """Handle async document generation job (PRD/PRFAQ)."""
    project_id = event['project_id']
    job_id = event['job_id']
    doc_config = event['doc_config']
    
    dynamodb = get_dynamodb_resource()
    projects_table = dynamodb.Table(PROJECTS_TABLE)
    feedback_table = dynamodb.Table(FEEDBACK_TABLE)
    
    try:
        update_job_status(project_id, job_id, 'running', 10, 'gathering_context')
        
        doc_type = doc_config.get('doc_type', 'prd')
        title = doc_config.get('title', 'Untitled')
        feature_idea = doc_config.get('feature_idea', '')
        data_sources = doc_config.get('data_sources', {})
        customer_questions = doc_config.get('customer_questions', [])
        
        context_parts = []
        
        # Gather feedback
        if data_sources.get('feedback'):
            update_job_status(project_id, job_id, 'running', 20, 'fetching_feedback')
            feedback_sources = doc_config.get('feedback_sources', [])
            feedback_categories = doc_config.get('feedback_categories', [])
            days = doc_config.get('days', 30)
            
            feedback_items = []
            current_date = datetime.now(timezone.utc)
            for i in range(min(days, 14)):
                date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
                resp = feedback_table.query(
                    IndexName='gsi1-by-date',
                    KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
                    Limit=100, ScanIndexForward=False
                )
                feedback_items.extend(resp.get('Items', []))
                if len(feedback_items) >= 100:
                    break
            
            if feedback_sources:
                feedback_items = [f for f in feedback_items if f.get('source_platform') in feedback_sources]
            if feedback_categories:
                feedback_items = [f for f in feedback_items if f.get('category') in feedback_categories]
            
            if feedback_items:
                feedback_text = "## Customer Feedback\n\n"
                for i, item in enumerate(feedback_items[:30], 1):
                    feedback_text += f"**Review {i}** ({item.get('source_platform', 'unknown')}, {item.get('sentiment_label', 'unknown')}): {item.get('original_text', '')[:300]}\n\n"
                context_parts.append(feedback_text)
        
        # Gather personas
        if data_sources.get('personas'):
            update_job_status(project_id, job_id, 'running', 30, 'fetching_personas')
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
            update_job_status(project_id, job_id, 'running', 40, 'fetching_documents')
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
        
        update_job_status(project_id, job_id, 'running', 50, 'generating_document')
        context = '\n\n'.join(context_parts) if context_parts else 'No additional context provided.'
        
        # Build prompts based on doc type
        if doc_type == 'prd':
            system_prompt = """You are a senior product manager creating a Product Requirements Document (PRD).
Create a comprehensive PRD that includes: Problem Statement, Goals & Success Metrics, User Stories, Requirements (functional & non-functional), Out of Scope, Timeline, and Risks."""
            user_prompt = f"Create a PRD for: {title}\n\nFeature Description: {feature_idea}\n\n{context}\n\nGenerate a complete PRD in markdown format."
        else:
            q_labels = ["Who is the customer?", "What is the customer problem or opportunity?", "What is the most important customer benefit?", "How do you know what customers need or want?", "What does the customer experience look like?"]
            questions_context = "\n\n".join([f"**{q_labels[i]}**\n{q.strip()}" for i, q in enumerate(customer_questions[:5]) if q and q.strip()])
            system_prompt = """You are creating an Amazon-style Working Backwards PR-FAQ document. Write in "Oprah-speak" NOT "Geek-speak". Keep it simple. This is NOT a spec - it's a customer-focused announcement."""
            user_prompt = f"Create an Amazon Working Backwards PR-FAQ for: {title}\n\nFeature Description: {feature_idea}\n\n## Working Backwards Input:\n{questions_context or 'Use the customer feedback context below.'}\n\n{context}\n\nGenerate a COMPLETE PR-FAQ with PRESS RELEASE, CUSTOMER FAQ (10 questions), and INTERNAL FAQ (10 questions)."
        
        update_job_status(project_id, job_id, 'running', 60, 'calling_ai')
        max_tokens = 8000 if doc_type == 'prfaq' else 5000
        content = converse(prompt=user_prompt, system_prompt=system_prompt, max_tokens=max_tokens)
        
        update_job_status(project_id, job_id, 'running', 90, 'saving_document')
        now = datetime.now(timezone.utc).isoformat()
        doc_id = f"{doc_type}_{datetime.now().strftime('%Y%m%d%H%M%S')}"
        
        projects_table.put_item(Item={
            'pk': f'PROJECT#{project_id}', 'sk': f'{doc_type.upper()}#{doc_id}',
            'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS', 'gsi1sk': now,
            'document_id': doc_id, 'document_type': doc_type, 'title': title,
            'content': content, 'job_id': job_id, 'created_at': now,
        })
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
            UpdateExpression='SET document_count = document_count + :one, updated_at = :now',
            ExpressionAttributeValues={':one': 1, ':now': now}
        )
        
        update_job_status(project_id, job_id, 'completed', 100, 'complete', result={'document_id': doc_id, 'title': title})
        return {'statusCode': 200, 'body': json.dumps({'success': True, 'document_id': doc_id})}
        
    except Exception as e:
        logger.exception(f"Document generation failed: {e}")
        update_job_status(project_id, job_id, 'failed', 0, 'error', error='Document generation failed')
        return {'statusCode': 500, 'body': json.dumps({'success': False, 'error': 'Document generation failed'})}


def handle_merge_documents_job(event: dict) -> dict:
    """Handle async document merge job."""
    project_id = event['project_id']
    job_id = event['job_id']
    merge_config = event['merge_config']
    
    dynamodb = get_dynamodb_resource()
    projects_table = dynamodb.Table(PROJECTS_TABLE)
    feedback_table = dynamodb.Table(FEEDBACK_TABLE)
    
    try:
        update_job_status(project_id, job_id, 'running', 10, 'gathering_documents')
        
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
        
        update_job_status(project_id, job_id, 'running', 20, 'preparing_context')
        
        doc_context = "## SOURCE DOCUMENTS TO MERGE\n\n"
        for i, doc in enumerate(selected_docs, 1):
            doc_context += f"### Document {i}: {doc.get('title', 'Untitled')} ({doc.get('document_type', 'unknown').upper()})\n\n{doc.get('content', '')[:8000]}\n\n---\n\n"
        
        context_parts = [doc_context]
        
        if selected_persona_ids:
            update_job_status(project_id, job_id, 'running', 30, 'fetching_personas')
            personas = [i for i in all_items if i.get('sk', '').startswith('PERSONA#')]
            selected_personas = [p for p in personas if p.get('persona_id') in selected_persona_ids]
            if selected_personas:
                persona_text = "## USER PERSONAS FOR CONTEXT\n\n"
                for p in selected_personas:
                    persona_text += f"**{p.get('name')}**: {p.get('tagline', '')}\n- Goals: {', '.join(p.get('goals', [])[:3])}\n- Frustrations: {', '.join(p.get('frustrations', [])[:3])}\n\n"
                context_parts.append(persona_text)
        
        if use_feedback:
            update_job_status(project_id, job_id, 'running', 40, 'fetching_feedback')
            feedback_sources = merge_config.get('feedback_sources', [])
            feedback_categories = merge_config.get('feedback_categories', [])
            days = merge_config.get('days', 30)
            
            feedback_items = []
            current_date = datetime.now(timezone.utc)
            for i in range(min(days, 14)):
                date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
                resp = feedback_table.query(
                    IndexName='gsi1-by-date',
                    KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
                    Limit=100, ScanIndexForward=False
                )
                feedback_items.extend(resp.get('Items', []))
                if len(feedback_items) >= 100:
                    break
            
            if feedback_sources:
                feedback_items = [f for f in feedback_items if f.get('source_platform') in feedback_sources]
            if feedback_categories:
                feedback_items = [f for f in feedback_items if f.get('category') in feedback_categories]
            
            if feedback_items:
                feedback_text = "## ADDITIONAL CUSTOMER FEEDBACK\n\n"
                for i, item in enumerate(feedback_items[:20], 1):
                    feedback_text += f"**Review {i}** ({item.get('source_platform', 'unknown')}, {item.get('sentiment_label', 'unknown')}): {item.get('original_text', '')[:250]}\n\n"
                context_parts.append(feedback_text)
        
        update_job_status(project_id, job_id, 'running', 50, 'generating_merged_document')
        context = '\n\n'.join(context_parts)
        
        if output_type == 'prd':
            system_prompt = "You are a senior product manager creating a revised PRD. Merge and revise the provided source documents according to the user's instructions."
        elif output_type == 'prfaq':
            system_prompt = "You are creating a revised Amazon-style PR-FAQ. Merge and revise the provided source documents. Include PRESS RELEASE, CUSTOMER FAQ (10 questions), and INTERNAL FAQ (10 questions)."
        else:
            system_prompt = "You are a skilled document editor. Merge and revise the provided source documents according to the user's instructions."
        
        user_prompt = f"## MERGE INSTRUCTIONS\n{instructions}\n\n## OUTPUT DOCUMENT TITLE\n{title}\n\n{context}\n\nCreate a new {output_type.upper() if output_type != 'custom' else 'document'} incorporating all relevant feedback."
        
        update_job_status(project_id, job_id, 'running', 60, 'calling_ai')
        max_tokens = 8000 if output_type == 'prfaq' else 6000
        content = converse(prompt=user_prompt, system_prompt=system_prompt, max_tokens=max_tokens)
        
        update_job_status(project_id, job_id, 'running', 90, 'saving_document')
        now = datetime.now(timezone.utc).isoformat()
        doc_type_prefix = output_type if output_type in ['prd', 'prfaq'] else 'doc'
        doc_id = f"{doc_type_prefix}_{datetime.now().strftime('%Y%m%d%H%M%S')}"
        
        projects_table.put_item(Item={
            'pk': f'PROJECT#{project_id}', 'sk': f'{doc_type_prefix.upper()}#{doc_id}',
            'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS', 'gsi1sk': now,
            'document_id': doc_id, 'document_type': output_type if output_type in ['prd', 'prfaq'] else 'custom',
            'title': title, 'content': content, 'job_id': job_id,
            'source_documents': selected_doc_ids, 'merge_instructions': instructions, 'created_at': now,
        })
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
            UpdateExpression='SET document_count = document_count + :one, updated_at = :now',
            ExpressionAttributeValues={':one': 1, ':now': now}
        )
        
        update_job_status(project_id, job_id, 'completed', 100, 'complete', result={'document_id': doc_id, 'title': title})
        return {'statusCode': 200, 'body': json.dumps({'success': True, 'document_id': doc_id})}
        
    except Exception as e:
        logger.exception(f"Document merge failed: {e}")
        update_job_status(project_id, job_id, 'failed', 0, 'error', error='Document merge failed')
        return {'statusCode': 500, 'body': json.dumps({'success': False, 'error': 'Document merge failed'})}


def handle_import_persona_job(event: dict) -> dict:
    """Handle async persona import job."""
    project_id = event['project_id']
    job_id = event['job_id']
    import_config = event['import_config']
    
    dynamodb = get_dynamodb_resource()
    projects_table = dynamodb.Table(PROJECTS_TABLE)
    
    try:
        update_job_status(project_id, job_id, 'running', 10, 'extracting_persona')
        
        input_type = import_config.get('input_type', 'text')
        content = import_config.get('content', '')
        media_type = import_config.get('media_type', '')
        
        logger.info(f"[IMPORT_PERSONA_JOB] Starting import from {input_type} for project {project_id}")
        
        system_prompt = """You are a UX researcher expert at extracting persona information from documents and images.
Extract persona data from the provided input and output a structured JSON object.
CRITICAL: Output ONLY valid JSON, no markdown, no explanation."""

        json_schema = '{"name": "Full Name", "tagline": "One sentence", "confidence": "high", "identity": {...}, "goals_motivations": {...}, "pain_points": {...}, "behaviors": {...}, "context_environment": {...}, "quotes": [...], "scenario": {...}}'
        
        # Build converse content
        converse_content = []
        if input_type == 'image':
            converse_content.append({
                'image': {
                    'format': (media_type or 'image/png').split('/')[-1],
                    'source': {'bytes': base64.b64decode(content)}
                }
            })
            converse_content.append({'text': f"Extract the persona information from this image.\n\nOutput a JSON object with this structure:\n{json_schema}\n\nOutput ONLY the JSON object."})
        else:
            text_content = content if input_type == 'text' else f"[PDF content - extract persona from this document]"
            converse_content.append({'text': f"Extract the persona information from this text:\n\n---\n{text_content}\n---\n\nOutput a JSON object with this structure:\n{json_schema}\n\nOutput ONLY the JSON object."})
        
        update_job_status(project_id, job_id, 'running', 30, 'calling_ai')
        
        bedrock = get_bedrock_client()
        response = bedrock.converse(
            modelId=BEDROCK_MODEL_ID,
            system=[{'text': system_prompt}],
            messages=[{'role': 'user', 'content': converse_content}],
            inferenceConfig={'maxTokens': 4096}
        )
        
        response_text = response.get('output', {}).get('message', {}).get('content', [{}])[0].get('text', '')
        
        # Parse JSON
        json_text = response_text
        if '```json' in json_text:
            json_text = json_text.split('```json')[1].split('```')[0]
        elif '```' in json_text:
            json_text = json_text.split('```')[1].split('```')[0]
        
        persona_data = json.loads(json_text.strip())
        logger.info(f"[IMPORT_PERSONA_JOB] Extracted persona: {persona_data.get('name', 'Unknown')}")
        
        update_job_status(project_id, job_id, 'running', 60, 'generating_avatar')
        
        now = datetime.now(timezone.utc).isoformat()
        persona_id = f"persona_{datetime.now().strftime('%Y%m%d%H%M%S')}"
        
        item = {
            'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}',
            'gsi1pk': f'PROJECT#{project_id}#PERSONAS', 'gsi1sk': now,
            'persona_id': persona_id,
            'name': persona_data.get('name', 'Imported Persona'),
            'tagline': persona_data.get('tagline', ''),
            'confidence': persona_data.get('confidence', 'medium'),
            'identity': persona_data.get('identity', {}),
            'goals_motivations': persona_data.get('goals_motivations', {}),
            'pain_points': persona_data.get('pain_points', {}),
            'behaviors': persona_data.get('behaviors', {}),
            'context_environment': persona_data.get('context_environment', {}),
            'quotes': persona_data.get('quotes', []),
            'scenario': persona_data.get('scenario', {}),
            'research_notes': [],
            'imported_from': input_type,
            'created_at': now, 'updated_at': now,
        }
        
        # Generate avatar
        avatar_data = {'persona_id': persona_id, **item}
        avatar_result = generate_persona_avatar(avatar_data, RAW_DATA_BUCKET)
        if avatar_result.get('avatar_url'):
            item['avatar_url'] = avatar_result['avatar_url']
            item['avatar_prompt'] = avatar_result.get('avatar_prompt', '')
        
        update_job_status(project_id, job_id, 'running', 90, 'saving_persona')
        
        projects_table.put_item(Item=item)
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
            UpdateExpression='SET persona_count = persona_count + :one, updated_at = :now',
            ExpressionAttributeValues={':one': 1, ':now': now}
        )
        
        persona_name = item.get('name', 'Imported Persona')
        if item.get('avatar_url') and item['avatar_url'].startswith('s3://'):
            item['avatar_url'] = get_avatar_cdn_url(item['avatar_url'])
        
        update_job_status(project_id, job_id, 'completed', 100, 'complete', result={'persona_id': persona_id, 'title': f'Imported: {persona_name}'})
        logger.info(f"[IMPORT_PERSONA_JOB] Successfully imported persona: {persona_name}")
        return {'statusCode': 200, 'body': json.dumps({'success': True, 'persona_id': persona_id})}
        
    except json.JSONDecodeError as e:
        logger.error(f"[IMPORT_PERSONA_JOB] Failed to parse JSON: {e}")
        update_job_status(project_id, job_id, 'failed', 0, 'error', error='Failed to parse persona data')
        return {'statusCode': 500, 'body': json.dumps({'success': False, 'error': 'Failed to parse persona data'})}
    except Exception as e:
        logger.exception(f"[IMPORT_PERSONA_JOB] Import failed: {e}")
        update_job_status(project_id, job_id, 'failed', 0, 'error', error='Persona import failed')
        return {'statusCode': 500, 'body': json.dumps({'success': False, 'error': 'Persona import failed'})}


# ============================================
# Lambda Handler
# ============================================

@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler for projects API."""
    try:
        logger.info(f"Received event: {json.dumps(event)}")
        
        # Route async job invocations
        job_type = event.get('job_type')
        if job_type == 'generate_personas':
            return handle_generate_personas_job(event)
        if job_type in ['generate_prd', 'generate_prfaq']:
            return handle_generate_document_job(event)
        if job_type == 'merge_documents':
            return handle_merge_documents_job(event)
        if job_type == 'import_persona':
            return handle_import_persona_job(event)
        
        # Normal API Gateway request
        result = app.resolve(event, context)
        logger.info(f"Returning result: {json.dumps(result, cls=DecimalEncoder)}")
        return result
        
    except Exception as e:
        logger.exception(f"Lambda handler error: {e}")
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With,X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
                'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
            },
            'body': json.dumps({'error': 'Internal server error', 'message': 'An unexpected error occurred.'})
        }
