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

# Configuration
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
    
    if len(prompt) > 10000:
        raise BadRequestError("prompt must be less than 10000 characters")
    
    # Optional fields
    project_type = body.get('project_type', 'react-vite')
    style = body.get('style', 'minimal')
    pages = body.get('pages', [])
    features = body.get('features', [])
    include_mock_data = body.get('include_mock_data', False)
    
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
    logger.info(f"Created job {job_id}")
    
    # Upload prompt payload to S3
    payload = {
        'job_id': job_id,
        'prompt': prompt,
        'project_type': project_type,
        'style': style,
        'pages': pages,
        'features': features,
        'include_mock_data': include_mock_data,
    }
    
    s3.put_object(
        Bucket=ARTIFACTS_BUCKET,
        Key=f'jobs/{job_id}/request.json',
        Body=json.dumps(payload),
        ContentType='application/json'
    )
    
    # Send message to SQS to trigger execution
    sqs.send_message(
        QueueUrl=JOB_QUEUE_URL,
        MessageBody=json.dumps({'job_id': job_id}),
        MessageGroupId=job_id if '.fifo' in JOB_QUEUE_URL else None,
    ) if JOB_QUEUE_URL else None
    
    metrics.add_metric(name="JobsCreated", unit="Count", value=1)
    
    return {
        'job_id': job_id,
        'status': 'queued',
        'message': 'Job created successfully',
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


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
