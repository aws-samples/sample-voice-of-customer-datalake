"""
Artifact Builder API Lambda - Orchestrates artifact generation jobs.

Routes:
- POST /jobs - Create a new artifact generation job
- GET /jobs - List all jobs
- GET /jobs/{jobId} - Get job status and details
- GET /jobs/{jobId}/logs - Get job logs
- GET /jobs/{jobId}/download - Get presigned download URL
- GET /templates - List available project templates
"""
import json
import os
import re
import uuid
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from typing import Any

import boto3
from aws_lambda_powertools import Logger, Tracer, Metrics
from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig
from aws_lambda_powertools.event_handler.exceptions import NotFoundError, BadRequestError

logger = Logger()
tracer = Tracer()
metrics = Metrics(namespace="ArtifactBuilder")

# AWS Clients
dynamodb = boto3.resource('dynamodb')
s3 = boto3.client('s3')
sqs = boto3.client('sqs')
codecommit = boto3.client('codecommit')
ecs = boto3.client('ecs')

# Configuration
ECS_CLUSTER = os.environ.get('ECS_CLUSTER', 'artifact-builder')
JOBS_TABLE = os.environ.get('JOBS_TABLE', 'artifact-builder-jobs')
ARTIFACTS_BUCKET = os.environ.get('ARTIFACTS_BUCKET', '')
JOB_QUEUE_URL = os.environ.get('JOB_QUEUE_URL', '')
PREVIEW_URL = os.environ.get('PREVIEW_URL', '')

jobs_table = dynamodb.Table(JOBS_TABLE)

# CORS config
cors_config = CORSConfig(
    allow_origin="*",
    allow_headers=["Content-Type", "Authorization"],
    max_age=300,
    allow_credentials=False
)

app = APIGatewayRestResolver(cors=cors_config, enable_validation=True)

# Available project templates
TEMPLATES = [
    {
        "id": "react-vite",
        "name": "React + Vite",
        "description": "Modern React app with Vite, Tailwind CSS, and TypeScript",
        "default": True,
    },
    {
        "id": "nextjs-static",
        "name": "Next.js Static Export",
        "description": "Next.js app configured for static export",
        "default": False,
    },
    {
        "id": "docs-site",
        "name": "Documentation Site",
        "description": "VitePress documentation site",
        "default": False,
    },
]

# Style presets
STYLE_PRESETS = [
    {"id": "minimal", "name": "Minimal", "description": "Clean, simple design"},
    {"id": "corporate", "name": "Corporate", "description": "Professional business style"},
    {"id": "playful", "name": "Playful", "description": "Fun, colorful design"},
    {"id": "dark", "name": "Dark Mode", "description": "Dark theme by default"},
]


def decimal_default(obj):
    """JSON serializer for Decimal types."""
    if isinstance(obj, Decimal):
        return float(obj) if obj % 1 else int(obj)
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


def strip_ansi_codes(text: str) -> str:
    """Strip ANSI escape codes and fix Kiro CLI streaming output formatting.
    
    Kiro CLI streams words one at a time with newlines between them.
    This function joins those words back into readable sentences.
    """
    # Strip ESC[ sequences (colors, cursor control, etc.)
    text = re.sub(r'\x1B\[[0-9;]*[A-Za-z]', '', text)
    # Strip OSC sequences (ESC] ... BEL or ESC\)
    text = re.sub(r'\x1B\][^\x07]*\x07', '', text)
    text = re.sub(r'\x1B\][^\x1B]*\x1B\\\\', '', text)
    # Strip standalone ESC characters (important for streaming output)
    text = re.sub(r'\x1B', '', text)
    # Strip bracket-only codes (when ESC was lost/encoded differently)
    text = re.sub(r'\[\?25[lh]', '', text)
    text = re.sub(r'\[\d*m', '', text)
    text = re.sub(r'\[38;5;\d+m', '', text)
    text = re.sub(r'\[48;5;\d+m', '', text)
    # Normalize line endings
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    
    # Process line by line to handle Kiro CLI streaming output
    lines = text.split('\n')
    result = []
    streaming_words = []
    in_streaming_block = False
    
    for line in lines:
        trimmed = line.strip()
        
        # Skip empty lines when in streaming block
        if not trimmed:
            if not in_streaming_block and result and result[-1] != '':
                result.append('')
            continue
        
        # Detect start of streaming block (line starting with >)
        if trimmed.startswith('>'):
            # Flush any previous streaming words
            if streaming_words:
                joined = ' '.join(streaming_words).replace(" ' ", "'").replace('  ', ' ')
                result.append(joined)
                streaming_words = []
            in_streaming_block = True
            streaming_words.append(trimmed)
            continue
        
        # Check if this is a structural line that ends streaming
        is_structural = (
            trimmed.startswith('[') or
            trimmed.startswith('Reading ') or
            trimmed.startswith('Writing ') or
            trimmed.startswith('Creating ') or
            trimmed.startswith('Updating ') or
            trimmed.startswith('Deleting ') or
            '✓' in trimmed or
            '✗' in trimmed or
            'Completed' in trimmed or
            trimmed.startswith('- ') or
            trimmed.startswith('• ') or
            (':' in trimmed and len(trimmed) > 30)
        )
        
        if in_streaming_block:
            if is_structural:
                # End streaming block, flush words
                if streaming_words:
                    joined = ' '.join(streaming_words).replace(" ' ", "'").replace('  ', ' ')
                    result.append(joined)
                    streaming_words = []
                in_streaming_block = False
                result.append(trimmed)
            else:
                # Continue accumulating words
                streaming_words.append(trimmed)
        else:
            # Not in streaming block - add line normally
            result.append(trimmed)
    
    # Flush any remaining streaming words
    if streaming_words:
        joined = ' '.join(streaming_words).replace(" ' ", "'").replace('  ', ' ')
        result.append(joined)
    
    # Join and clean up excessive blank lines
    output = '\n'.join(result)
    output = re.sub(r'\n{3,}', '\n\n', output)
    return output.strip()


@app.get("/templates")
@tracer.capture_method
def list_templates():
    """List available project templates and style presets."""
    return {
        "templates": TEMPLATES,
        "styles": STYLE_PRESETS,
    }


@app.post("/jobs")
@tracer.capture_method
def create_job():
    """Create a new artifact generation job."""
    body = app.current_event.json_body or {}
    
    # Validate required fields
    prompt = body.get('prompt', '').strip()
    if not prompt:
        raise BadRequestError("prompt is required")
    
    if len(prompt) > 50000:
        raise BadRequestError("prompt must be less than 50000 characters")
    
    # Optional fields
    project_type = body.get('project_type', 'react-vite')
    style = body.get('style', 'minimal')
    pages = body.get('pages', [])
    features = body.get('features', [])
    include_mock_data = body.get('include_mock_data', False)
    
    # Iteration support - reference a parent job to continue from
    parent_job_id = body.get('parent_job_id')
    parent_repo_name = None
    
    # If iterating, get the parent job's repo
    if parent_job_id:
        parent_response = jobs_table.get_item(
            Key={'pk': f'JOB#{parent_job_id}', 'sk': 'META'}
        )
        parent_job = parent_response.get('Item')
        if not parent_job:
            raise BadRequestError(f"Parent job {parent_job_id} not found")
        if parent_job.get('status') != 'done':
            raise BadRequestError(f"Parent job {parent_job_id} is not complete")
        # The repo name is artifact-{job_id}
        parent_repo_name = f'artifact-{parent_job_id}'
        logger.info(f"Iterating from parent job {parent_job_id}, repo: {parent_repo_name}")
    
    # Validate project type
    valid_types = [t['id'] for t in TEMPLATES]
    if project_type not in valid_types:
        raise BadRequestError(f"Invalid project_type. Must be one of: {valid_types}")
    
    # Validate style
    valid_styles = [s['id'] for s in STYLE_PRESETS]
    if style not in valid_styles:
        raise BadRequestError(f"Invalid style. Must be one of: {valid_styles}")
    
    # Generate job ID
    job_id = str(uuid.uuid4())[:8]
    now = datetime.now(timezone.utc)
    
    # Create job record
    job = {
        'pk': f'JOB#{job_id}',
        'sk': 'META',
        'job_id': job_id,
        'status': 'queued',
        'prompt': prompt,
        'project_type': project_type,
        'style': style,
        'pages': pages,
        'features': features,
        'include_mock_data': include_mock_data,
        'parent_job_id': parent_job_id,
        'parent_repo_name': parent_repo_name,
        'created_at': now.isoformat(),
        'updated_at': now.isoformat(),
        'timeline': [
            {'status': 'queued', 'timestamp': now.isoformat()}
        ],
        'preview_url': None,
        'download_url': None,
        'summary': None,
        'error': None,
        # TTL: 30 days
        'ttl': int((now + timedelta(days=30)).timestamp()),
    }
    
    # Save to DynamoDB
    jobs_table.put_item(Item=job)
    logger.info(f"Created job {job_id}" + (f" (iterating from {parent_job_id})" if parent_job_id else ""))
    
    # Upload prompt payload to S3
    payload = {
        'job_id': job_id,
        'prompt': prompt,
        'project_type': project_type,
        'style': style,
        'pages': pages,
        'features': features,
        'include_mock_data': include_mock_data,
        'parent_job_id': parent_job_id,
        'parent_repo_name': parent_repo_name,
    }
    
    s3.put_object(
        Bucket=ARTIFACTS_BUCKET,
        Key=f'jobs/{job_id}/request.json',
        Body=json.dumps(payload),
        ContentType='application/json'
    )
    
    # Send message to SQS to trigger execution
    if JOB_QUEUE_URL:
        message_params = {
            'QueueUrl': JOB_QUEUE_URL,
            'MessageBody': json.dumps({'job_id': job_id}),
        }
        # Only add MessageGroupId for FIFO queues
        if '.fifo' in JOB_QUEUE_URL:
            message_params['MessageGroupId'] = job_id
        sqs.send_message(**message_params)
    
    metrics.add_metric(name="JobsCreated", unit="Count", value=1)
    if parent_job_id:
        metrics.add_metric(name="IterationJobsCreated", unit="Count", value=1)
    
    return {
        'job_id': job_id,
        'status': 'queued',
        'message': 'Job created successfully',
        'parent_job_id': parent_job_id,
    }


@app.get("/jobs")
@tracer.capture_method
def list_jobs():
    """List all jobs, optionally filtered by status."""
    params = app.current_event.query_string_parameters or {}
    status_filter = params.get('status')
    limit = min(int(params.get('limit', 50)), 100)
    
    if status_filter:
        # Query by status using GSI
        response = jobs_table.query(
            IndexName='gsi1-by-status',
            KeyConditionExpression='#status = :status',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':status': status_filter},
            ScanIndexForward=False,  # Most recent first
            Limit=limit,
        )
    else:
        # Scan all jobs (for small datasets)
        response = jobs_table.scan(
            FilterExpression='sk = :meta',
            ExpressionAttributeValues={':meta': 'META'},
            Limit=limit,
        )
    
    jobs = response.get('Items', [])
    
    # Sort by created_at descending
    jobs.sort(key=lambda x: x.get('created_at', ''), reverse=True)
    
    return {
        'count': len(jobs),
        'jobs': json.loads(json.dumps(jobs, default=decimal_default)),
    }


@app.get("/jobs/<job_id>")
@tracer.capture_method
def get_job(job_id: str):
    """Get job status and details."""
    response = jobs_table.get_item(
        Key={'pk': f'JOB#{job_id}', 'sk': 'META'}
    )
    
    job = response.get('Item')
    if not job:
        raise NotFoundError(f"Job {job_id} not found")
    
    # Add preview URL if build is complete
    if job.get('status') == 'done' and PREVIEW_URL:
        job['preview_url'] = f"{PREVIEW_URL}/jobs/{job_id}/build/index.html"
    
    return json.loads(json.dumps(job, default=decimal_default))


@app.get("/jobs/<job_id>/logs")
@tracer.capture_method
def get_job_logs(job_id: str):
    """Get job build logs."""
    # Check job exists
    response = jobs_table.get_item(
        Key={'pk': f'JOB#{job_id}', 'sk': 'META'}
    )
    if not response.get('Item'):
        raise NotFoundError(f"Job {job_id} not found")
    
    # Try to fetch logs from S3
    try:
        log_response = s3.get_object(
            Bucket=ARTIFACTS_BUCKET,
            Key=f'jobs/{job_id}/logs.txt'
        )
        logs_content = log_response['Body'].read().decode('utf-8')
        # Strip ANSI escape codes for clean display
        logs_content = strip_ansi_codes(logs_content)
    except s3.exceptions.NoSuchKey:
        logs_content = "Logs not yet available"
    except Exception as e:
        logger.warning(f"Error fetching logs: {e}")
        logs_content = "Logs not yet available"
    
    return {
        'job_id': job_id,
        'logs': logs_content,
    }


@app.get("/jobs/<job_id>/download")
@tracer.capture_method
def get_download_url(job_id: str):
    """Get presigned URL to download source bundle."""
    # Check job exists and is complete
    response = jobs_table.get_item(
        Key={'pk': f'JOB#{job_id}', 'sk': 'META'}
    )
    job = response.get('Item')
    if not job:
        raise NotFoundError(f"Job {job_id} not found")
    
    if job.get('status') != 'done':
        raise BadRequestError("Job is not complete yet")
    
    # Generate presigned URL for source.zip
    try:
        download_url = s3.generate_presigned_url(
            'get_object',
            Params={
                'Bucket': ARTIFACTS_BUCKET,
                'Key': f'jobs/{job_id}/source.zip',
            },
            ExpiresIn=3600,  # 1 hour
        )
    except Exception as e:
        logger.error(f"Error generating download URL: {e}")
        raise BadRequestError("Download not available")
    
    return {
        'job_id': job_id,
        'download_url': download_url,
        'expires_in': 3600,
    }


@app.delete("/jobs/<job_id>")
@tracer.capture_method
def delete_job(job_id: str):
    """Delete a job and all its artifacts (DynamoDB, S3, CodeCommit repo, ECS task)."""
    # Check job exists
    response = jobs_table.get_item(
        Key={'pk': f'JOB#{job_id}', 'sk': 'META'}
    )
    job = response.get('Item')
    if not job:
        raise NotFoundError(f"Job {job_id} not found")
    
    cleanup_results = {
        'dynamodb': False,
        's3': False,
        'codecommit': False,
        'ecs_task': False,
    }
    
    # 1. Stop any running ECS task for this job
    ecs_task_arn = job.get('ecs_task_arn')
    if ecs_task_arn:
        try:
            # Extract task ID from ARN
            task_id = ecs_task_arn.split('/')[-1]
            # Check if task is still running
            task_response = ecs.describe_tasks(
                cluster=ECS_CLUSTER,
                tasks=[task_id]
            )
            tasks = task_response.get('tasks', [])
            if tasks and tasks[0].get('lastStatus') in ['PENDING', 'RUNNING']:
                ecs.stop_task(
                    cluster=ECS_CLUSTER,
                    task=task_id,
                    reason=f'Job {job_id} deleted by user'
                )
                logger.info(f"Stopped ECS task {task_id} for job {job_id}")
            cleanup_results['ecs_task'] = True
        except Exception as e:
            logger.warning(f"Error stopping ECS task for job {job_id}: {e}")
    else:
        cleanup_results['ecs_task'] = True  # No task to stop
    
    # 2. Delete CodeCommit repository (artifact-{job_id})
    repo_name = f'artifact-{job_id}'
    try:
        codecommit.delete_repository(repositoryName=repo_name)
        logger.info(f"Deleted CodeCommit repository {repo_name}")
        cleanup_results['codecommit'] = True
    except codecommit.exceptions.RepositoryDoesNotExistException:
        logger.info(f"CodeCommit repository {repo_name} does not exist, skipping")
        cleanup_results['codecommit'] = True
    except Exception as e:
        logger.warning(f"Error deleting CodeCommit repository {repo_name}: {e}")
    
    # 3. Delete S3 artifacts (all objects under jobs/{job_id}/)
    try:
        paginator = s3.get_paginator('list_objects_v2')
        prefix = f'jobs/{job_id}/'
        
        objects_to_delete = []
        for page in paginator.paginate(Bucket=ARTIFACTS_BUCKET, Prefix=prefix):
            for obj in page.get('Contents', []):
                objects_to_delete.append({'Key': obj['Key']})
        
        if objects_to_delete:
            # Delete in batches of 1000 (S3 limit)
            for i in range(0, len(objects_to_delete), 1000):
                batch = objects_to_delete[i:i+1000]
                s3.delete_objects(
                    Bucket=ARTIFACTS_BUCKET,
                    Delete={'Objects': batch}
                )
            logger.info(f"Deleted {len(objects_to_delete)} S3 objects for job {job_id}")
        cleanup_results['s3'] = True
    except Exception as e:
        logger.warning(f"Error deleting S3 artifacts for job {job_id}: {e}")
    
    # 4. Delete from DynamoDB (do this last so we can retry cleanup if needed)
    try:
        jobs_table.delete_item(
            Key={'pk': f'JOB#{job_id}', 'sk': 'META'}
        )
        cleanup_results['dynamodb'] = True
    except Exception as e:
        logger.error(f"Error deleting job {job_id} from DynamoDB: {e}")
        raise
    
    metrics.add_metric(name="JobsDeleted", unit="Count", value=1)
    
    return {
        'success': True,
        'message': f'Job {job_id} deleted',
        'cleanup': cleanup_results,
    }


@app.get("/jobs/<job_id>/source")
@tracer.capture_method
def list_source_files(job_id: str):
    """List source files from CodeCommit repository for a job."""
    params = app.current_event.query_string_parameters or {}
    path = params.get('path', '')
    
    # Check job exists and is complete
    response = jobs_table.get_item(
        Key={'pk': f'JOB#{job_id}', 'sk': 'META'}
    )
    job = response.get('Item')
    if not job:
        raise NotFoundError(f"Job {job_id} not found")
    
    if job.get('status') != 'done':
        raise BadRequestError("Job is not complete yet")
    
    repo_name = f'artifact-{job_id}'
    
    try:
        # Get the default branch
        repo_info = codecommit.get_repository(repositoryName=repo_name)
        default_branch = repo_info['repositoryMetadata'].get('defaultBranch', 'main')
        
        # Get folder contents
        folder_path = path if path else '/'
        
        response = codecommit.get_folder(
            repositoryName=repo_name,
            commitSpecifier=default_branch,
            folderPath=folder_path
        )
        
        files = []
        
        # Add subfolders
        for folder in response.get('subFolders', []):
            folder_name = folder['absolutePath']
            files.append({
                'path': folder_name,
                'type': 'folder'
            })
        
        # Add files
        for file in response.get('files', []):
            file_path = file['absolutePath']
            files.append({
                'path': file_path,
                'type': 'file'
            })
        
        # Sort: folders first, then files, alphabetically
        files.sort(key=lambda x: (x['type'] == 'file', x['path'].lower()))
        
        return {'files': files}
        
    except codecommit.exceptions.RepositoryDoesNotExistException:
        raise NotFoundError(f"Repository for job {job_id} not found")
    except codecommit.exceptions.FolderDoesNotExistException:
        return {'files': []}
    except Exception as e:
        logger.error(f"Error listing source files for job {job_id}: {e}")
        raise BadRequestError(f"Error listing source files: {str(e)}")


@app.get("/jobs/<job_id>/source/file")
@tracer.capture_method
def get_source_file_content(job_id: str):
    """Get content of a source file from CodeCommit repository."""
    params = app.current_event.query_string_parameters or {}
    file_path = params.get('path', '')
    
    if not file_path:
        raise BadRequestError("path parameter is required")
    
    # Check job exists and is complete
    response = jobs_table.get_item(
        Key={'pk': f'JOB#{job_id}', 'sk': 'META'}
    )
    job = response.get('Item')
    if not job:
        raise NotFoundError(f"Job {job_id} not found")
    
    if job.get('status') != 'done':
        raise BadRequestError("Job is not complete yet")
    
    repo_name = f'artifact-{job_id}'
    
    try:
        # Get the default branch
        repo_info = codecommit.get_repository(repositoryName=repo_name)
        default_branch = repo_info['repositoryMetadata'].get('defaultBranch', 'main')
        
        # Get file content
        response = codecommit.get_file(
            repositoryName=repo_name,
            commitSpecifier=default_branch,
            filePath=file_path
        )
        
        # Decode content (it's returned as bytes)
        content = response['fileContent'].decode('utf-8')
        
        return {
            'path': file_path,
            'content': content
        }
        
    except codecommit.exceptions.RepositoryDoesNotExistException:
        raise NotFoundError(f"Repository for job {job_id} not found")
    except codecommit.exceptions.FileDoesNotExistException:
        raise NotFoundError(f"File {file_path} not found")
    except UnicodeDecodeError:
        raise BadRequestError("File is binary and cannot be displayed")
    except Exception as e:
        logger.error(f"Error getting file content for job {job_id}: {e}")
        raise BadRequestError(f"Error getting file content: {str(e)}")


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
