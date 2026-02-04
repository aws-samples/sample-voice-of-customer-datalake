"""
Projects API Lambda Handler
Separate Lambda to handle projects endpoints and avoid policy size limits.
"""

import json
import os
from datetime import datetime, timezone
from typing import Any

from shared.logging import logger, tracer
from shared.aws import invoke_lambda_async
from shared.api import create_api_resolver, validate_days, validate_int, api_handler, DecimalEncoder
from shared.tables import get_jobs_table, get_aggregates_table
from shared.jobs import create_job
from shared.exceptions import NotFoundError, ServiceError

from boto3.dynamodb.conditions import Key
import boto3

from projects import (
    list_projects, create_project, get_project, update_project, delete_project,
    generate_personas, project_chat, run_research,
    create_document, update_document, delete_document,
    create_persona, update_persona, delete_persona,
    add_persona_note, update_persona_note, delete_persona_note,
    regenerate_persona_avatar,
)

# API resolver with standard CORS
app = create_api_resolver()

# Environment - Job Lambda function names
PERSONA_GENERATOR_FUNCTION = os.environ.get('PERSONA_GENERATOR_FUNCTION', '')
DOCUMENT_GENERATOR_FUNCTION = os.environ.get('DOCUMENT_GENERATOR_FUNCTION', '')
DOCUMENT_MERGER_FUNCTION = os.environ.get('DOCUMENT_MERGER_FUNCTION', '')
PERSONA_IMPORTER_FUNCTION = os.environ.get('PERSONA_IMPORTER_FUNCTION', '')


def validate_persona_count(value, default=3):
    """Validate persona count parameter."""
    return validate_int(value, default=default, min_val=1, max_val=10)


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
    invoke_lambda_async(PERSONA_IMPORTER_FUNCTION, {
        'project_id': project_id,
        'job_id': job_id,
        'import_config': config
    })
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
    invoke_lambda_async(PERSONA_GENERATOR_FUNCTION, {
        'project_id': project_id,
        'job_id': job_id,
        'filters': filters
    })
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
    """Generate PRD or PR-FAQ document via async Lambda invocation."""
    body = app.current_event.json_body or {}
    doc_type = body.get('doc_type', 'prd')
    job_id, _ = create_job(project_id, f'generate_{doc_type}', 'doc_config', body, status='pending')
    invoke_lambda_async(DOCUMENT_GENERATOR_FUNCTION, {
        'project_id': project_id,
        'job_id': job_id,
        'doc_config': body
    })
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
    invoke_lambda_async(DOCUMENT_MERGER_FUNCTION, {
        'project_id': project_id,
        'job_id': job_id,
        'merge_config': body
    })
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
        raise NotFoundError('Job not found')
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
        raise ServiceError('Failed to save prioritization scores')


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
        raise ServiceError('Failed to save prioritization scores')


# ============================================
# Lambda Handler
# ============================================

@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler for projects API."""
    try:
        logger.info(f"Received event: {json.dumps(event)}")
        
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
