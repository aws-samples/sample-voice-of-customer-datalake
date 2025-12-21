"""
Projects API Lambda Handler
Separate Lambda to handle projects endpoints and avoid policy size limits.
"""

import json
import os
import sys
from datetime import timedelta
from decimal import Decimal
from typing import Any

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.logging import logger, tracer, metrics

from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig
from projects import (
    list_projects,
    create_project,
    get_project,
    update_project,
    delete_project,
    generate_personas,
    generate_prd,
    generate_prfaq,
    project_chat,
    run_research,
    create_document,
    update_document,
    delete_document,
    create_persona,
    update_persona,
    delete_persona,
    import_persona,
    add_persona_note,
    update_persona_note,
    delete_persona_note,
    regenerate_persona_avatar,
)

# Configure CORS - restrict to CloudFront domain in production
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "http://localhost:5173")
cors_config = CORSConfig(
    allow_origin=ALLOWED_ORIGIN,
    allow_headers=[
        "Content-Type",
        "Authorization",
        "X-Requested-With",
        "X-Amz-Date",
        "X-Api-Key",
        "X-Amz-Security-Token",
    ],
    expose_headers=["Content-Type"],
    max_age=300,
    allow_credentials=False,
)

app = APIGatewayRestResolver(cors=cors_config, enable_validation=True)


class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


@app.get("/projects/config")
@tracer.capture_method
def api_get_config():
    """Return API configuration including streaming endpoint."""
    return {
        'chat_stream_url': os.environ.get('CHAT_STREAM_URL', ''),
    }


@app.get("/projects")
@tracer.capture_method
def api_list_projects():
    return list_projects()


@app.post("/projects")
@tracer.capture_method
def api_create_project():
    body = app.current_event.json_body
    return create_project(body)


@app.get("/projects/<project_id>")
@tracer.capture_method
def api_get_project(project_id: str):
    return get_project(project_id)


@app.put("/projects/<project_id>")
@tracer.capture_method
def api_update_project(project_id: str):
    body = app.current_event.json_body
    return update_project(project_id, body)


@app.delete("/projects/<project_id>")
@tracer.capture_method
def api_delete_project(project_id: str):
    return delete_project(project_id)


# Persona CRUD routes
@app.post("/projects/<project_id>/personas")
@tracer.capture_method
def api_create_persona(project_id: str):
    body = app.current_event.json_body
    return create_persona(project_id, body)


@app.post("/projects/<project_id>/personas/import")
@tracer.capture_method
def api_import_persona(project_id: str):
    """Import a persona from PDF, image, or text - runs as background job."""
    import boto3
    import uuid
    from datetime import datetime, timezone
    
    body = app.current_event.json_body or {}
    
    # Create a job ID
    job_id = f"job_{uuid.uuid4().hex[:16]}"
    now = datetime.now(timezone.utc).isoformat()
    # TTL: 30 minutes for running jobs, extended to 7 days when completed
    ttl = int((datetime.now(timezone.utc) + timedelta(minutes=30)).timestamp())
    
    # Store job status in Jobs table
    jobs_table = boto3.resource('dynamodb').Table(os.environ.get('JOBS_TABLE', ''))
    jobs_table.put_item(Item={
        'pk': f'PROJECT#{project_id}',
        'sk': f'JOB#{job_id}',
        'gsi1pk': 'STATUS#running',
        'gsi1sk': now,
        'job_id': job_id,
        'project_id': project_id,
        'job_type': 'import_persona',
        'status': 'running',
        'progress': 0,
        'current_step': 'starting',
        'created_at': now,
        'updated_at': now,
        'ttl': ttl,
        'import_config': {
            'input_type': body.get('input_type', 'text'),
            'content': body.get('content', ''),
            'media_type': body.get('media_type', '')
        }
    })
    
    # Invoke Lambda asynchronously
    lambda_client = boto3.client('lambda')
    lambda_client.invoke(
        FunctionName=os.environ.get('AWS_LAMBDA_FUNCTION_NAME', 'voc-projects-api'),
        InvocationType='Event',  # Async invocation
        Payload=json.dumps({
            'job_type': 'import_persona',
            'project_id': project_id,
            'job_id': job_id,
            'import_config': {
                'input_type': body.get('input_type', 'text'),
                'content': body.get('content', ''),
                'media_type': body.get('media_type', '')
            }
        })
    )
    
    return {
        'success': True,
        'job_id': job_id,
        'status': 'running',
        'message': 'Persona import started. Check Background Jobs for progress.'
    }


@app.put("/projects/<project_id>/personas/<persona_id>")
@tracer.capture_method
def api_update_persona(project_id: str, persona_id: str):
    body = app.current_event.json_body
    return update_persona(project_id, persona_id, body)


@app.delete("/projects/<project_id>/personas/<persona_id>")
@tracer.capture_method
def api_delete_persona(project_id: str, persona_id: str):
    return delete_persona(project_id, persona_id)


# Persona Research Notes routes
@app.post("/projects/<project_id>/personas/<persona_id>/notes")
@tracer.capture_method
def api_add_persona_note(project_id: str, persona_id: str):
    """Add a research note to a persona."""
    body = app.current_event.json_body
    return add_persona_note(project_id, persona_id, body)


@app.put("/projects/<project_id>/personas/<persona_id>/notes/<note_id>")
@tracer.capture_method
def api_update_persona_note(project_id: str, persona_id: str, note_id: str):
    """Update a research note."""
    body = app.current_event.json_body
    return update_persona_note(project_id, persona_id, note_id, body)


@app.delete("/projects/<project_id>/personas/<persona_id>/notes/<note_id>")
@tracer.capture_method
def api_delete_persona_note(project_id: str, persona_id: str, note_id: str):
    """Delete a research note."""
    return delete_persona_note(project_id, persona_id, note_id)


# Persona Avatar routes
@app.post("/projects/<project_id>/personas/<persona_id>/regenerate-avatar")
@tracer.capture_method
def api_regenerate_persona_avatar(project_id: str, persona_id: str):
    """Regenerate the AI avatar for a persona."""
    return regenerate_persona_avatar(project_id, persona_id)


@app.post("/projects/<project_id>/personas/generate")
@tracer.capture_method
def api_generate_personas(project_id: str):
    """Start async persona generation and return job ID."""
    import boto3
    import uuid
    from datetime import datetime, timezone
    
    body = app.current_event.json_body or {}
    # Frontend sends filters at top level, not nested under 'filters' key
    filters = {
        'sources': body.get('sources', []),
        'categories': body.get('categories', []),
        'sentiments': body.get('sentiments', []),
        'days': body.get('days', 30),
        'persona_count': body.get('persona_count', 3),
        'custom_instructions': body.get('custom_instructions', ''),
    }
    
    # Create a job ID
    job_id = f"job_{uuid.uuid4().hex[:16]}"
    now = datetime.now(timezone.utc).isoformat()
    # TTL: 30 days from now
    ttl = int((datetime.now(timezone.utc) + timedelta(days=30)).timestamp())
    
    # Store job status in Jobs table
    jobs_table = boto3.resource('dynamodb').Table(os.environ.get('JOBS_TABLE', ''))
    jobs_table.put_item(Item={
        'pk': f'PROJECT#{project_id}',
        'sk': f'JOB#{job_id}',
        'gsi1pk': 'STATUS#running',
        'gsi1sk': now,
        'job_id': job_id,
        'project_id': project_id,
        'job_type': 'generate_personas',
        'status': 'running',
        'progress': 0,
        'current_step': 'starting',
        'created_at': now,
        'updated_at': now,
        'ttl': ttl,
        'filters': filters
    })
    
    # Invoke Lambda asynchronously
    lambda_client = boto3.client('lambda')
    lambda_client.invoke(
        FunctionName=os.environ.get('AWS_LAMBDA_FUNCTION_NAME', 'voc-projects-api'),
        InvocationType='Event',  # Async invocation
        Payload=json.dumps({
            'job_type': 'generate_personas',
            'project_id': project_id,
            'job_id': job_id,
            'filters': filters
        })
    )
    
    return {
        'success': True,
        'job_id': job_id,
        'status': 'running',
        'message': 'Persona generation started. Poll /projects/{project_id}/jobs/{job_id} for status.'
    }


@app.post("/projects/<project_id>/prd/generate")
@tracer.capture_method
def api_generate_prd(project_id: str):
    body = app.current_event.json_body
    return generate_prd(project_id, body)


@app.post("/projects/<project_id>/prfaq/generate")
@tracer.capture_method
def api_generate_prfaq(project_id: str):
    body = app.current_event.json_body
    return generate_prfaq(project_id, body)


@app.post("/projects/<project_id>/chat")
@tracer.capture_method
def api_project_chat(project_id: str):
    body = app.current_event.json_body
    return project_chat(project_id, body)


@app.post("/projects/<project_id>/research")
@tracer.capture_method
def api_run_research(project_id: str):
    """Start research via Step Functions and return job ID."""
    import boto3
    import uuid
    from datetime import datetime, timezone
    
    body = app.current_event.json_body or {}
    
    # Create a job ID
    job_id = f"job_{uuid.uuid4().hex[:16]}"
    now = datetime.now(timezone.utc).isoformat()
    # TTL: 30 minutes for running jobs (auto-cleanup if stuck), extended to 7 days when completed
    ttl = int((datetime.now(timezone.utc) + timedelta(minutes=30)).timestamp())
    
    # Build research config with optional persona/document context
    research_config = {
        'question': body.get('question', 'What are the main customer pain points?'),
        'title': body.get('title', ''),
        'sources': body.get('sources', []),
        'categories': body.get('categories', []),
        'sentiments': body.get('sentiments', []),
        'days': body.get('days', 30),
        'selected_persona_ids': body.get('selected_persona_ids', []),
        'selected_document_ids': body.get('selected_document_ids', []),
        'filters': body
    }
    
    # Store job status in Jobs table
    jobs_table = boto3.resource('dynamodb').Table(os.environ.get('JOBS_TABLE', ''))
    jobs_table.put_item(Item={
        'pk': f'PROJECT#{project_id}',
        'sk': f'JOB#{job_id}',
        'gsi1pk': 'STATUS#pending',
        'gsi1sk': now,
        'job_id': job_id,
        'project_id': project_id,
        'job_type': 'research',
        'status': 'pending',
        'progress': 0,
        'current_step': 'queued',
        'created_at': now,
        'updated_at': now,
        'ttl': ttl,
        'research_config': research_config
    })
    
    # Start Step Functions execution
    sfn_client = boto3.client('stepfunctions')
    state_machine_arn = os.environ.get('RESEARCH_STATE_MACHINE_ARN', '')
    
    if state_machine_arn:
        sfn_client.start_execution(
            stateMachineArn=state_machine_arn,
            name=job_id,
            input=json.dumps({
                'job_id': job_id,
                'project_id': project_id,
                'research_config': research_config
            })
        )
    else:
        logger.warning("RESEARCH_STATE_MACHINE_ARN not configured, falling back to sync")
        # Fallback to sync execution if Step Functions not configured
        result = run_research(project_id, body)
        return result
    
    return {
        'success': True,
        'job_id': job_id,
        'status': 'pending',
        'message': 'Research started. Poll /projects/{project_id}/jobs/{job_id} for status.'
    }


@app.post("/projects/<project_id>/document")
@tracer.capture_method
def api_generate_document(project_id: str):
    """Generate PRD or PR-FAQ document via Step Functions."""
    import boto3
    import uuid
    from datetime import datetime, timezone
    
    body = app.current_event.json_body or {}
    
    doc_type = body.get('doc_type', 'prd')
    
    # Create a job ID
    job_id = f"job_{uuid.uuid4().hex[:16]}"
    now = datetime.now(timezone.utc).isoformat()
    ttl = int((datetime.now(timezone.utc) + timedelta(minutes=30)).timestamp())
    
    # Store job status in Jobs table
    jobs_table = boto3.resource('dynamodb').Table(os.environ.get('JOBS_TABLE', ''))
    jobs_table.put_item(Item={
        'pk': f'PROJECT#{project_id}',
        'sk': f'JOB#{job_id}',
        'gsi1pk': 'STATUS#pending',
        'gsi1sk': now,
        'job_id': job_id,
        'project_id': project_id,
        'job_type': f'generate_{doc_type}',
        'status': 'pending',
        'progress': 0,
        'current_step': 'queued',
        'created_at': now,
        'updated_at': now,
        'ttl': ttl,
        'doc_config': body
    })
    
    # Start Step Functions execution
    sfn_client = boto3.client('stepfunctions')
    state_machine_arn = os.environ.get('DOCUMENT_STATE_MACHINE_ARN', '')
    
    if state_machine_arn:
        sfn_client.start_execution(
            stateMachineArn=state_machine_arn,
            name=job_id,
            input=json.dumps({
                'job_id': job_id,
                'project_id': project_id,
                'doc_config': body
            })
        )
    else:
        logger.warning("DOCUMENT_STATE_MACHINE_ARN not configured, running sync")
        # Fallback to sync - invoke Lambda async
        lambda_client = boto3.client('lambda')
        lambda_client.invoke(
            FunctionName=os.environ.get('AWS_LAMBDA_FUNCTION_NAME', 'voc-projects-api'),
            InvocationType='Event',
            Payload=json.dumps({
                'job_type': f'generate_{doc_type}',
                'project_id': project_id,
                'job_id': job_id,
                'doc_config': body
            })
        )
    
    return {
        'success': True,
        'job_id': job_id,
        'status': 'pending',
        'message': f'{doc_type.upper()} generation started.'
    }


@app.post("/projects/<project_id>/documents")
@tracer.capture_method
def api_create_document(project_id: str):
    body = app.current_event.json_body
    return create_document(project_id, body)


@app.post("/projects/<project_id>/documents/merge")
@tracer.capture_method
def api_merge_documents(project_id: str):
    """Merge multiple documents into a new document using AI."""
    import boto3
    import uuid
    from datetime import datetime, timezone
    
    body = app.current_event.json_body or {}
    
    output_type = body.get('output_type', 'custom')
    
    # Create a job ID
    job_id = f"job_{uuid.uuid4().hex[:16]}"
    now = datetime.now(timezone.utc).isoformat()
    ttl = int((datetime.now(timezone.utc) + timedelta(minutes=30)).timestamp())
    
    # Store job status in Jobs table
    jobs_table = boto3.resource('dynamodb').Table(os.environ.get('JOBS_TABLE', ''))
    jobs_table.put_item(Item={
        'pk': f'PROJECT#{project_id}',
        'sk': f'JOB#{job_id}',
        'gsi1pk': 'STATUS#pending',
        'gsi1sk': now,
        'job_id': job_id,
        'project_id': project_id,
        'job_type': 'merge_documents',
        'status': 'pending',
        'progress': 0,
        'current_step': 'queued',
        'created_at': now,
        'updated_at': now,
        'ttl': ttl,
        'merge_config': body
    })
    
    # Invoke Lambda asynchronously
    lambda_client = boto3.client('lambda')
    lambda_client.invoke(
        FunctionName=os.environ.get('AWS_LAMBDA_FUNCTION_NAME', 'voc-projects-api'),
        InvocationType='Event',
        Payload=json.dumps({
            'job_type': 'merge_documents',
            'project_id': project_id,
            'job_id': job_id,
            'merge_config': body
        })
    )
    
    return {
        'success': True,
        'job_id': job_id,
        'status': 'pending',
        'message': f'Document merge started. Output type: {output_type.upper()}'
    }


@app.put("/projects/<project_id>/documents/<document_id>")
@tracer.capture_method
def api_update_document(project_id: str, document_id: str):
    body = app.current_event.json_body
    return update_document(project_id, document_id, body)


@app.delete("/projects/<project_id>/documents/<document_id>")
@tracer.capture_method
def api_delete_document(project_id: str, document_id: str):
    return delete_document(project_id, document_id)


@app.get("/projects/<project_id>/jobs/<job_id>")
@tracer.capture_method
def api_get_job_status(project_id: str, job_id: str):
    """Get job status from jobs table."""
    import boto3
    
    jobs_table = boto3.resource('dynamodb').Table(os.environ.get('JOBS_TABLE', ''))
    response = jobs_table.get_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': f'JOB#{job_id}'}
    )
    
    item = response.get('Item')
    if not item:
        return {'success': False, 'message': 'Job not found'}
    
    return {
        'success': True,
        'job_id': job_id,
        'status': item.get('status'),
        'progress': item.get('progress', 0),
        'current_step': item.get('current_step'),
        'job_type': item.get('job_type'),
        'created_at': item.get('created_at'),
        'updated_at': item.get('updated_at'),
        'completed_at': item.get('completed_at'),
        'error': item.get('error'),
        'result': item.get('result')
    }


@app.get("/projects/<project_id>/jobs")
@tracer.capture_method
def api_list_jobs(project_id: str):
    """List all jobs for a project."""
    import boto3
    from boto3.dynamodb.conditions import Key
    
    jobs_table = boto3.resource('dynamodb').Table(os.environ.get('JOBS_TABLE', ''))
    response = jobs_table.query(
        KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'),
        ScanIndexForward=False,
        Limit=50
    )
    
    jobs = []
    for item in response.get('Items', []):
        jobs.append({
            'job_id': item.get('job_id'),
            'job_type': item.get('job_type'),
            'status': item.get('status'),
            'progress': item.get('progress', 0),
            'current_step': item.get('current_step'),
            'created_at': item.get('created_at'),
            'updated_at': item.get('updated_at'),
            'completed_at': item.get('completed_at'),
            'error': item.get('error'),
            'result': item.get('result')
        })
    
    return {'success': True, 'jobs': jobs}


@app.delete("/projects/<project_id>/jobs/<job_id>")
@tracer.capture_method
def api_delete_job(project_id: str, job_id: str):
    """Delete/dismiss a job."""
    import boto3
    
    jobs_table = boto3.resource('dynamodb').Table(os.environ.get('JOBS_TABLE', ''))
    jobs_table.delete_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': f'JOB#{job_id}'}
    )
    
    return {'success': True}


# =============================================================================
# PRIORITIZATION ENDPOINTS
# Store and retrieve PR/FAQ prioritization scores across all projects
# =============================================================================

@app.get("/projects/prioritization")
@tracer.capture_method
def api_get_prioritization_scores():
    """Get all prioritization scores."""
    import boto3
    
    aggregates_table = boto3.resource('dynamodb').Table(os.environ.get('AGGREGATES_TABLE', ''))
    
    try:
        response = aggregates_table.get_item(
            Key={'pk': 'PRIORITIZATION', 'sk': 'SCORES'}
        )
        item = response.get('Item', {})
        scores = item.get('scores', {})
        return {'scores': scores}
    except Exception as e:
        logger.warning(f"Failed to get prioritization scores: {e}")
        return {'scores': {}}


@app.put("/projects/prioritization")
@tracer.capture_method
def api_save_prioritization_scores():
    """Save prioritization scores."""
    import boto3
    from datetime import datetime, timezone
    
    body = app.current_event.json_body or {}
    scores = body.get('scores', {})
    
    aggregates_table = boto3.resource('dynamodb').Table(os.environ.get('AGGREGATES_TABLE', ''))
    now = datetime.now(timezone.utc).isoformat()
    
    try:
        aggregates_table.put_item(Item={
            'pk': 'PRIORITIZATION',
            'sk': 'SCORES',
            'scores': scores,
            'updated_at': now
        })
        return {'success': True}
    except Exception as e:
        logger.exception(f"Failed to save prioritization scores: {e}")
        return {'success': False, 'message': 'Failed to save prioritization scores'}


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler for projects API."""
    try:
        logger.info(f"Received event: {json.dumps(event)}")
        
        # Check if this is an async job invocation (persona generation still uses Lambda async)
        job_type = event.get('job_type')
        if job_type == 'generate_personas':
            project_id = event['project_id']
            job_id = event['job_id']
            
            import boto3
            from datetime import datetime, timezone
            
            jobs_table = boto3.resource('dynamodb').Table(os.environ.get('JOBS_TABLE', ''))
            
            def update_persona_job_progress(progress: int, step: str):
                """Update job progress in DynamoDB."""
                now = datetime.now(timezone.utc).isoformat()
                jobs_table.update_item(
                    Key={'pk': f'PROJECT#{project_id}', 'sk': f'JOB#{job_id}'},
                    UpdateExpression='SET progress = :progress, current_step = :step, updated_at = :now',
                    ExpressionAttributeValues={':progress': progress, ':step': step, ':now': now}
                )
            
            try:
                filters = event['filters']
                result = generate_personas(project_id, filters, progress_callback=update_persona_job_progress)
                
                # Update job status in jobs table
                jobs_table.update_item(
                    Key={'pk': f'PROJECT#{project_id}', 'sk': f'JOB#{job_id}'},
                    UpdateExpression='SET #status = :status, progress = :progress, completed_at = :completed, #result = :result, gsi1pk = :gsi1pk',
                    ExpressionAttributeNames={'#status': 'status', '#result': 'result'},
                    ExpressionAttributeValues={
                        ':status': 'completed',
                        ':progress': 100,
                        ':completed': datetime.now(timezone.utc).isoformat(),
                        ':result': result,
                        ':gsi1pk': 'STATUS#completed'
                    }
                )
                
                return {'statusCode': 200, 'body': json.dumps({'success': True})}
                
            except Exception as e:
                logger.exception(f"Async job failed: {e}")
                jobs_table.update_item(
                    Key={'pk': f'PROJECT#{project_id}', 'sk': f'JOB#{job_id}'},
                    UpdateExpression='SET #status = :status, completed_at = :completed, error = :error, gsi1pk = :gsi1pk',
                    ExpressionAttributeNames={'#status': 'status'},
                    ExpressionAttributeValues={
                        ':status': 'failed',
                        ':completed': datetime.now(timezone.utc).isoformat(),
                        ':error': 'Job execution failed',
                        ':gsi1pk': 'STATUS#failed'
                    }
                )
                return {'statusCode': 500, 'body': json.dumps({'success': False, 'error': 'Job execution failed'})}
        
        # Handle document generation jobs (PRD/PRFAQ)
        if job_type in ['generate_prd', 'generate_prfaq']:
            project_id = event['project_id']
            job_id = event['job_id']
            doc_config = event['doc_config']
            
            import boto3
            from datetime import datetime, timezone
            from boto3.dynamodb.conditions import Key
            
            dynamodb = boto3.resource('dynamodb')
            jobs_table = dynamodb.Table(os.environ.get('JOBS_TABLE', ''))
            projects_table = dynamodb.Table(os.environ.get('PROJECTS_TABLE', ''))
            feedback_table = dynamodb.Table(os.environ.get('FEEDBACK_TABLE', ''))
            
            def update_doc_job_status(status, progress, step, error=None, result=None):
                now = datetime.now(timezone.utc).isoformat()
                update_expr = 'SET #status = :status, progress = :progress, current_step = :step, updated_at = :now'
                expr_values = {':status': status, ':progress': progress, ':step': step, ':now': now}
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
                jobs_table.update_item(
                    Key={'pk': f'PROJECT#{project_id}', 'sk': f'JOB#{job_id}'},
                    UpdateExpression=update_expr,
                    ExpressionAttributeValues=expr_values,
                    ExpressionAttributeNames=expr_names
                )
            
            try:
                update_doc_job_status('running', 10, 'gathering_context')
                
                doc_type = doc_config.get('doc_type', 'prd')
                title = doc_config.get('title', 'Untitled')
                feature_idea = doc_config.get('feature_idea', '')
                data_sources = doc_config.get('data_sources', {})
                customer_questions = doc_config.get('customer_questions', [])
                
                context_parts = []
                
                # Gather feedback if selected
                if data_sources.get('feedback'):
                    update_doc_job_status('running', 20, 'fetching_feedback')
                    feedback_sources = doc_config.get('feedback_sources', [])
                    feedback_categories = doc_config.get('feedback_categories', [])
                    days = doc_config.get('days', 30)
                    
                    feedback_items = []
                    from datetime import timedelta as td
                    current_date = datetime.now(timezone.utc)
                    
                    if feedback_sources:
                        for source in feedback_sources[:3]:
                            resp = feedback_table.query(
                                KeyConditionExpression=Key('pk').eq(f'SOURCE#{source}'),
                                Limit=20, ScanIndexForward=False
                            )
                            feedback_items.extend(resp.get('Items', []))
                    else:
                        for i in range(min(days, 14)):
                            date = (current_date - td(days=i)).strftime('%Y-%m-%d')
                            resp = feedback_table.query(
                                IndexName='gsi1-by-date',
                                KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
                                Limit=30 - len(feedback_items), ScanIndexForward=False
                            )
                            feedback_items.extend(resp.get('Items', []))
                            if len(feedback_items) >= 30:
                                break
                    
                    if feedback_categories:
                        feedback_items = [f for f in feedback_items if f.get('category') in feedback_categories]
                    
                    if feedback_items:
                        feedback_text = "## Customer Feedback\n\n"
                        for i, item in enumerate(feedback_items[:30], 1):
                            feedback_text += f"**Review {i}** ({item.get('source_platform', 'unknown')}, {item.get('sentiment_label', 'unknown')}): {item.get('original_text', '')[:300]}\n\n"
                        context_parts.append(feedback_text)
                
                # Gather personas if selected
                if data_sources.get('personas'):
                    update_doc_job_status('running', 30, 'fetching_personas')
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
                
                # Gather documents if selected
                if data_sources.get('documents') or data_sources.get('research'):
                    update_doc_job_status('running', 40, 'fetching_documents')
                    selected_ids = doc_config.get('selected_document_ids', [])
                    resp = projects_table.query(KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'))
                    docs = [i for i in resp.get('Items', []) if i.get('sk', '').startswith(('RESEARCH#', 'PRD#', 'PRFAQ#', 'DOC#'))]
                    if selected_ids:
                        docs = [d for d in docs if d.get('document_id') in selected_ids]
                    if docs:
                        doc_text = "## Reference Documents\n\n"
                        for d in docs[:3]:
                            content = d.get('content', '')[:3000]
                            doc_text += f"### {d.get('title', 'Untitled')}\n{content}\n\n"
                        context_parts.append(doc_text)
                
                update_doc_job_status('running', 50, 'generating_document')
                
                # Build prompt based on doc type
                import boto3
                from botocore.config import Config
                bedrock_config = Config(read_timeout=300, connect_timeout=10, retries={'max_attempts': 2})
                bedrock = boto3.client('bedrock-runtime', config=bedrock_config)
                
                context = '\n\n'.join(context_parts) if context_parts else 'No additional context provided.'
                
                if doc_type == 'prd':
                    system_prompt = """You are a senior product manager creating a Product Requirements Document (PRD).
Create a comprehensive PRD that includes: Problem Statement, Goals & Success Metrics, User Stories, Requirements (functional & non-functional), Out of Scope, Timeline, and Risks."""
                    
                    user_prompt = f"""Create a PRD for: {title}

Feature Description: {feature_idea}

{context}

Generate a complete PRD in markdown format."""
                    
                else:  # prfaq
                    # Amazon's 5 customer questions
                    q_labels = [
                        "Who is the customer?",
                        "What is the customer problem or opportunity?",
                        "What is the most important customer benefit?",
                        "How do you know what customers need or want?",
                        "What does the customer experience look like?"
                    ]
                    questions_context = ""
                    for i, q in enumerate(customer_questions[:5]):
                        if q and q.strip():
                            questions_context += f"**{q_labels[i]}**\n{q.strip()}\n\n"
                    
                    system_prompt = """You are creating an Amazon-style Working Backwards PR-FAQ document.

CRITICAL GUIDELINES:
- Write in "Oprah-speak" NOT "Geek-speak" - imagine explaining this on Oprah's couch to a general audience
- Keep it simple: 3-4 sentences for most paragraphs
- This is NOT a spec - it's a customer-focused announcement
- Write as if it's launch day and the product is ready

The Press Release MUST follow this EXACT structure:
1. **Heading** - Product name the customer will understand
2. **Sub-Heading** - One sentence: who is the market and what benefit they get
3. **Summary Paragraph** - Product summary and benefit (assume reader reads nothing else)
4. **Problem Paragraph** - Describe the problem your product solves
5. **Solution Paragraph** - How your product elegantly solves the problem
6. **Quote from Spokesperson** - A quote from a company leader
7. **How to Get Started** - Describe how easy it is to get started
8. **Customer Quote** - A hypothetical customer describing their experience with the benefit
9. **Closing and Call to Action** - Wrap up and tell reader where to go next"""
                    
                    user_prompt = f"""Create an Amazon Working Backwards PR-FAQ for: {title}

Feature Description: {feature_idea}

## Working Backwards Input (Amazon's 5 Questions):
{questions_context if questions_context else 'Use the customer feedback context below to inform these answers.'}

{context}

---

Generate a COMPLETE PR-FAQ document with ALL THREE sections:

# PRESS RELEASE

Follow the exact Amazon format:
- **Heading** (product name customers understand)
- **Sub-heading** (one sentence: market + benefit)
- **Summary paragraph**
- **Problem paragraph**
- **Solution paragraph**
- **Spokesperson quote**
- **How to get started**
- **Customer quote** (hypothetical but realistic)
- **Closing and call to action**

Write in plain language. No jargon. No technical specs. Focus on customer benefits.

---

# CUSTOMER FAQ (External)

Generate 10 questions and answers that CUSTOMERS would ask:
- Focus on benefits, pricing, availability, how it works
- Use simple language
- Address concerns and objections
- Include questions about getting started, support, compatibility

---

# INTERNAL FAQ (Stakeholders)

Generate 10 questions and answers for INTERNAL stakeholders:
- Implementation timeline and milestones
- Success metrics and KPIs
- Technical dependencies and risks
- Resource requirements
- Go-to-market strategy
- Competitive positioning
- Cost and ROI projections
- Rollback plan if issues arise
- Team ownership and responsibilities
- Integration with existing systems"""
                
                update_doc_job_status('running', 60, 'calling_ai')
                
                # Use more tokens for PR-FAQ (press release + 20 FAQs)
                max_tokens = 8000 if doc_type == 'prfaq' else 5000
                
                response = bedrock.invoke_model(
                    modelId='global.anthropic.claude-sonnet-4-5-20250929-v1:0',
                    contentType='application/json',
                    accept='application/json',
                    body=json.dumps({
                        'anthropic_version': 'bedrock-2023-05-31',
                        'max_tokens': max_tokens,
                        'system': system_prompt,
                        'messages': [{'role': 'user', 'content': user_prompt}]
                    })
                )
                result_body = json.loads(response['body'].read())
                content = result_body['content'][0]['text']
                
                update_doc_job_status('running', 90, 'saving_document')
                
                # Save document
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
                
                update_doc_job_status('completed', 100, 'complete', result={'document_id': doc_id, 'title': title})
                
                return {'statusCode': 200, 'body': json.dumps({'success': True, 'document_id': doc_id})}
                
            except Exception as e:
                logger.exception(f"Document generation failed: {e}")
                update_doc_job_status('failed', 0, 'error', error='Document generation failed')
                return {'statusCode': 500, 'body': json.dumps({'success': False, 'error': 'Document generation failed'})}
        
        # Handle merge documents job
        if job_type == 'merge_documents':
            project_id = event['project_id']
            job_id = event['job_id']
            merge_config = event['merge_config']
            
            import boto3
            from datetime import datetime, timezone
            from boto3.dynamodb.conditions import Key
            from botocore.config import Config
            
            dynamodb = boto3.resource('dynamodb')
            jobs_table = dynamodb.Table(os.environ.get('JOBS_TABLE', ''))
            projects_table = dynamodb.Table(os.environ.get('PROJECTS_TABLE', ''))
            feedback_table = dynamodb.Table(os.environ.get('FEEDBACK_TABLE', ''))
            
            def update_merge_job_status(status, progress, step, error=None, result=None):
                now = datetime.now(timezone.utc).isoformat()
                update_expr = 'SET #status = :status, progress = :progress, current_step = :step, updated_at = :now'
                expr_values = {':status': status, ':progress': progress, ':step': step, ':now': now}
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
                jobs_table.update_item(
                    Key={'pk': f'PROJECT#{project_id}', 'sk': f'JOB#{job_id}'},
                    UpdateExpression=update_expr,
                    ExpressionAttributeValues=expr_values,
                    ExpressionAttributeNames=expr_names
                )
            
            try:
                update_merge_job_status('running', 10, 'gathering_documents')
                
                output_type = merge_config.get('output_type', 'custom')
                title = merge_config.get('title', 'Merged Document')
                instructions = merge_config.get('instructions', '')
                selected_doc_ids = merge_config.get('selected_document_ids', [])
                selected_persona_ids = merge_config.get('selected_persona_ids', [])
                use_feedback = merge_config.get('use_feedback', False)
                
                # Fetch selected documents
                resp = projects_table.query(KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'))
                all_items = resp.get('Items', [])
                
                # Get documents
                docs = [i for i in all_items if i.get('sk', '').startswith(('RESEARCH#', 'PRD#', 'PRFAQ#', 'DOC#'))]
                selected_docs = [d for d in docs if d.get('document_id') in selected_doc_ids]
                
                if len(selected_docs) < 2:
                    raise ValueError("At least 2 documents are required for merging")
                
                update_merge_job_status('running', 20, 'preparing_context')
                
                # Build document context
                doc_context = "## SOURCE DOCUMENTS TO MERGE\n\n"
                for i, doc in enumerate(selected_docs, 1):
                    doc_context += f"### Document {i}: {doc.get('title', 'Untitled')} ({doc.get('document_type', 'unknown').upper()})\n\n"
                    doc_context += doc.get('content', '')[:8000]
                    doc_context += "\n\n---\n\n"
                
                context_parts = [doc_context]
                
                # Add persona context if selected
                if selected_persona_ids:
                    update_merge_job_status('running', 30, 'fetching_personas')
                    personas = [i for i in all_items if i.get('sk', '').startswith('PERSONA#')]
                    selected_personas = [p for p in personas if p.get('persona_id') in selected_persona_ids]
                    if selected_personas:
                        persona_text = "## USER PERSONAS FOR CONTEXT\n\n"
                        for p in selected_personas:
                            persona_text += f"**{p.get('name')}**: {p.get('tagline', '')}\n"
                            persona_text += f"- Goals: {', '.join(p.get('goals', [])[:3])}\n"
                            persona_text += f"- Frustrations: {', '.join(p.get('frustrations', [])[:3])}\n\n"
                        context_parts.append(persona_text)
                
                # Add feedback context if selected
                if use_feedback:
                    update_merge_job_status('running', 40, 'fetching_feedback')
                    feedback_sources = merge_config.get('feedback_sources', [])
                    feedback_categories = merge_config.get('feedback_categories', [])
                    days = merge_config.get('days', 30)
                    
                    feedback_items = []
                    from datetime import timedelta as td
                    current_date = datetime.now(timezone.utc)
                    
                    if feedback_sources:
                        for source in feedback_sources[:3]:
                            resp = feedback_table.query(
                                KeyConditionExpression=Key('pk').eq(f'SOURCE#{source}'),
                                Limit=15, ScanIndexForward=False
                            )
                            feedback_items.extend(resp.get('Items', []))
                    else:
                        for i in range(min(days, 14)):
                            date = (current_date - td(days=i)).strftime('%Y-%m-%d')
                            resp = feedback_table.query(
                                IndexName='gsi1-by-date',
                                KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
                                Limit=20 - len(feedback_items), ScanIndexForward=False
                            )
                            feedback_items.extend(resp.get('Items', []))
                            if len(feedback_items) >= 20:
                                break
                    
                    if feedback_categories:
                        feedback_items = [f for f in feedback_items if f.get('category') in feedback_categories]
                    
                    if feedback_items:
                        feedback_text = "## ADDITIONAL CUSTOMER FEEDBACK\n\n"
                        for i, item in enumerate(feedback_items[:20], 1):
                            feedback_text += f"**Review {i}** ({item.get('source_platform', 'unknown')}, {item.get('sentiment_label', 'unknown')}): {item.get('original_text', '')[:250]}\n\n"
                        context_parts.append(feedback_text)
                
                update_merge_job_status('running', 50, 'generating_merged_document')
                
                context = '\n\n'.join(context_parts)
                
                # Build system prompt based on output type
                if output_type == 'prd':
                    system_prompt = """You are a senior product manager creating a revised Product Requirements Document (PRD).
Your task is to merge and revise the provided source documents according to the user's instructions.
Create a comprehensive PRD that includes: Problem Statement, Goals & Success Metrics, User Stories, Requirements (functional & non-functional), Out of Scope, Timeline, and Risks.
Incorporate feedback and improvements from all source documents."""
                elif output_type == 'prfaq':
                    system_prompt = """You are creating a revised Amazon-style Working Backwards PR-FAQ document.
Your task is to merge and revise the provided source documents according to the user's instructions.

CRITICAL GUIDELINES:
- Write in "Oprah-speak" NOT "Geek-speak"
- Keep it simple: 3-4 sentences for most paragraphs
- This is NOT a spec - it's a customer-focused announcement
- Incorporate feedback and improvements from all source documents

The output MUST include:
1. PRESS RELEASE (with all 9 sections: Heading, Sub-heading, Summary, Problem, Solution, Spokesperson Quote, How to Get Started, Customer Quote, Closing)
2. CUSTOMER FAQ (10 questions customers would ask)
3. INTERNAL FAQ (10 questions for stakeholders)"""
                else:  # custom
                    system_prompt = """You are a skilled document editor and synthesizer.
Your task is to merge and revise the provided source documents according to the user's instructions.
Create a well-structured document that incorporates the best elements from all sources.
Follow the user's specific instructions carefully."""
                
                user_prompt = f"""## MERGE INSTRUCTIONS
{instructions}

## OUTPUT DOCUMENT TITLE
{title}

{context}

---

Based on the source documents above and the merge instructions, create a new {output_type.upper() if output_type != 'custom' else 'document'}.
Incorporate all relevant feedback, address concerns, and improve upon the original documents.
Output the complete merged document in markdown format."""
                
                update_merge_job_status('running', 60, 'calling_ai')
                
                bedrock_config = Config(read_timeout=300, connect_timeout=10, retries={'max_attempts': 2})
                bedrock = boto3.client('bedrock-runtime', config=bedrock_config)
                
                max_tokens = 8000 if output_type == 'prfaq' else 6000
                
                response = bedrock.invoke_model(
                    modelId='global.anthropic.claude-sonnet-4-5-20250929-v1:0',
                    contentType='application/json',
                    accept='application/json',
                    body=json.dumps({
                        'anthropic_version': 'bedrock-2023-05-31',
                        'max_tokens': max_tokens,
                        'system': system_prompt,
                        'messages': [{'role': 'user', 'content': user_prompt}]
                    })
                )
                result_body = json.loads(response['body'].read())
                content = result_body['content'][0]['text']
                
                update_merge_job_status('running', 90, 'saving_document')
                
                # Save merged document
                now = datetime.now(timezone.utc).isoformat()
                doc_type_prefix = output_type if output_type in ['prd', 'prfaq'] else 'doc'
                doc_id = f"{doc_type_prefix}_{datetime.now().strftime('%Y%m%d%H%M%S')}"
                sk_prefix = doc_type_prefix.upper()
                
                projects_table.put_item(Item={
                    'pk': f'PROJECT#{project_id}',
                    'sk': f'{sk_prefix}#{doc_id}',
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
                
                update_merge_job_status('completed', 100, 'complete', result={'document_id': doc_id, 'title': title})
                
                return {'statusCode': 200, 'body': json.dumps({'success': True, 'document_id': doc_id})}
                
            except Exception as e:
                logger.exception(f"Document merge failed: {e}")
                update_merge_job_status('failed', 0, 'error', error='Document merge failed')
                return {'statusCode': 500, 'body': json.dumps({'success': False, 'error': 'Document merge failed'})}
        
        # Handle import persona job
        if job_type == 'import_persona':
            project_id = event['project_id']
            job_id = event['job_id']
            import_config = event['import_config']
            
            import boto3
            from datetime import datetime, timezone
            from botocore.config import Config
            
            dynamodb = boto3.resource('dynamodb')
            jobs_table = dynamodb.Table(os.environ.get('JOBS_TABLE', ''))
            projects_table = dynamodb.Table(os.environ.get('PROJECTS_TABLE', ''))
            
            def update_import_job_status(status, progress, step, error=None, result=None):
                now = datetime.now(timezone.utc).isoformat()
                update_expr = 'SET #status = :status, progress = :progress, current_step = :step, updated_at = :now'
                expr_values = {':status': status, ':progress': progress, ':step': step, ':now': now}
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
                jobs_table.update_item(
                    Key={'pk': f'PROJECT#{project_id}', 'sk': f'JOB#{job_id}'},
                    UpdateExpression=update_expr,
                    ExpressionAttributeValues=expr_values,
                    ExpressionAttributeNames=expr_names
                )
            
            try:
                update_import_job_status('running', 10, 'extracting_persona')
                
                input_type = import_config.get('input_type', 'text')
                content = import_config.get('content', '')
                media_type = import_config.get('media_type', '')
                
                logger.info(f"[IMPORT_PERSONA_JOB] Starting import from {input_type} for project {project_id}")
                
                # Build the multimodal message for Claude
                system_prompt = """You are a UX researcher expert at extracting persona information from documents and images.
Extract persona data from the provided input and output a structured JSON object.
If information is not available, use reasonable defaults or null.
CRITICAL: Output ONLY valid JSON, no markdown, no explanation."""

                user_content = []
                json_schema = """{
    "name": "Full Name",
    "tagline": "One sentence describing this persona",
    "confidence": "high",
    "identity": {"age_range": "30-45", "location": "City, Country", "occupation": "Job Title", "income_bracket": "$50k-100k or null", "education": "Degree or null", "family_status": "Status or null", "bio": "2-3 sentence background story"},
    "goals_motivations": {"primary_goal": "Main objective", "secondary_goals": ["Goal 2", "Goal 3"], "success_definition": "What success looks like", "underlying_motivations": ["Motivation 1", "Motivation 2"]},
    "pain_points": {"current_challenges": ["Challenge 1", "Challenge 2"], "blockers": ["Blocker 1"], "workarounds": ["Workaround 1"], "emotional_impact": "How frustrations affect them"},
    "behaviors": {"current_solutions": ["Solution 1"], "tools_used": ["Tool 1", "Tool 2"], "activity_frequency": "Daily|Weekly|Monthly", "tech_savviness": "low|medium|high", "decision_style": "Data-driven|Gut instinct|Research-heavy"},
    "context_environment": {"usage_context": "When and where they use the product", "devices": ["Device 1", "Device 2"], "time_constraints": "Time constraints", "social_context": "Work/social environment", "influencers": ["Influencer 1"]},
    "quotes": [{"text": "Quote from the persona", "context": "Context"}],
    "scenario": {"title": "Scenario title", "narrative": "3-4 sentence user story", "trigger": "What triggers this scenario", "outcome": "Desired outcome"}
}"""
                
                if input_type == 'pdf':
                    user_content.append({"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": content}})
                    user_content.append({"type": "text", "text": f"Extract the persona information from this PDF document.\n\nOutput a JSON object with this structure:\n```json\n{json_schema}\n```\n\nOutput ONLY the JSON object."})
                elif input_type == 'image':
                    user_content.append({"type": "image", "source": {"type": "base64", "media_type": media_type or "image/png", "data": content}})
                    user_content.append({"type": "text", "text": f"Extract the persona information from this image.\n\nOutput a JSON object with this structure:\n```json\n{json_schema}\n```\n\nOutput ONLY the JSON object."})
                else:  # text
                    user_content.append({"type": "text", "text": f"Extract the persona information from this text:\n\n---\n{content}\n---\n\nOutput a JSON object with this structure:\n```json\n{json_schema}\n```\n\nOutput ONLY the JSON object."})
                
                update_import_job_status('running', 30, 'calling_ai')
                
                bedrock_config = Config(read_timeout=300, connect_timeout=10, retries={'max_attempts': 2})
                bedrock = boto3.client('bedrock-runtime', config=bedrock_config)
                
                response = bedrock.invoke_model(
                    modelId='global.anthropic.claude-sonnet-4-5-20250929-v1:0',
                    contentType='application/json',
                    accept='application/json',
                    body=json.dumps({
                        'anthropic_version': 'bedrock-2023-05-31',
                        'max_tokens': 4096,
                        'system': system_prompt,
                        'messages': [{'role': 'user', 'content': user_content}]
                    })
                )
                
                result_body = json.loads(response['body'].read())
                response_text = result_body['content'][0]['text']
                
                # Parse JSON from response
                json_text = response_text
                if '```json' in json_text:
                    json_text = json_text.split('```json')[1].split('```')[0]
                elif '```' in json_text:
                    json_text = json_text.split('```')[1].split('```')[0]
                
                persona_data = json.loads(json_text.strip())
                logger.info(f"[IMPORT_PERSONA_JOB] Extracted persona: {persona_data.get('name', 'Unknown')}")
                
                update_import_job_status('running', 60, 'generating_avatar')
                
                # Create the persona in DynamoDB
                now = datetime.now(timezone.utc).isoformat()
                persona_id = f"persona_{datetime.now().strftime('%Y%m%d%H%M%S')}"
                
                item = {
                    'pk': f'PROJECT#{project_id}',
                    'sk': f'PERSONA#{persona_id}',
                    'gsi1pk': f'PROJECT#{project_id}#PERSONAS',
                    'gsi1sk': now,
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
                    'created_at': now,
                    'updated_at': now,
                }
                
                # Generate avatar using existing flow
                from projects import generate_persona_avatar, get_avatar_cdn_url
                s3_bucket = os.environ.get('RAW_DATA_BUCKET', '')
                
                avatar_data = {'persona_id': persona_id, **item}
                avatar_result = generate_persona_avatar(avatar_data, s3_bucket)
                
                if avatar_result.get('avatar_url'):
                    item['avatar_url'] = avatar_result['avatar_url']
                    item['avatar_prompt'] = avatar_result.get('avatar_prompt', '')
                    logger.info(f"[IMPORT_PERSONA_JOB] Avatar generated: {avatar_result['avatar_url']}")
                
                update_import_job_status('running', 90, 'saving_persona')
                
                # Save to DynamoDB
                projects_table.put_item(Item=item)
                
                # Update persona count
                projects_table.update_item(
                    Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
                    UpdateExpression='SET persona_count = persona_count + :one, updated_at = :now',
                    ExpressionAttributeValues={':one': 1, ':now': now}
                )
                
                # Convert S3 URI to CDN URL for result
                persona_name = item.get('name', 'Imported Persona')
                if item.get('avatar_url') and item['avatar_url'].startswith('s3://'):
                    item['avatar_url'] = get_avatar_cdn_url(item['avatar_url'])
                
                update_import_job_status('completed', 100, 'complete', result={'persona_id': persona_id, 'title': f'Imported: {persona_name}'})
                
                logger.info(f"[IMPORT_PERSONA_JOB] Successfully imported persona: {persona_name}")
                return {'statusCode': 200, 'body': json.dumps({'success': True, 'persona_id': persona_id})}
                
            except json.JSONDecodeError as e:
                logger.error(f"[IMPORT_PERSONA_JOB] Failed to parse JSON: {e}")
                update_import_job_status('failed', 0, 'error', error='Failed to parse persona data')
                return {'statusCode': 500, 'body': json.dumps({'success': False, 'error': 'Failed to parse persona data'})}
            except Exception as e:
                logger.exception(f"[IMPORT_PERSONA_JOB] Import failed: {e}")
                update_import_job_status('failed', 0, 'error', error='Persona import failed')
                return {'statusCode': 500, 'body': json.dumps({'success': False, 'error': 'Persona import failed'})}
        
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
            'body': json.dumps({'error': 'Internal server error', 'message': 'An unexpected error occurred. Please try again.'})
        }
