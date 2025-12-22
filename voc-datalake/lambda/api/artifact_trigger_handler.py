"""
Artifact Builder Trigger Lambda - Starts ECS Fargate tasks from SQS messages.

Triggered by SQS queue when a new job is created.
Launches an ECS Fargate task to execute the artifact generation.
"""
import json
import os
from datetime import datetime, timezone
from typing import Any

import boto3
from aws_lambda_powertools import Logger, Tracer, Metrics
from aws_lambda_powertools.utilities.batch import BatchProcessor, EventType, batch_processor
from aws_lambda_powertools.utilities.data_classes.sqs_event import SQSRecord

logger = Logger()
tracer = Tracer()
metrics = Metrics(namespace="ArtifactBuilder")

# AWS Clients
dynamodb = boto3.resource('dynamodb')
ecs = boto3.client('ecs')

# Configuration
JOBS_TABLE = os.environ.get('JOBS_TABLE', 'artifact-builder-jobs')
ECS_CLUSTER = os.environ.get('ECS_CLUSTER', '')
ECS_TASK_DEF = os.environ.get('ECS_TASK_DEF', '')
ECS_SUBNETS = os.environ.get('ECS_SUBNETS', '').split(',')
ECS_SECURITY_GROUP = os.environ.get('ECS_SECURITY_GROUP', '')
ARTIFACTS_BUCKET = os.environ.get('ARTIFACTS_BUCKET', '')
TEMPLATE_REPO_NAME = os.environ.get('TEMPLATE_REPO_NAME', 'artifact-builder-template')
PREVIEW_URL = os.environ.get('PREVIEW_URL', '')

jobs_table = dynamodb.Table(JOBS_TABLE)
processor = BatchProcessor(event_type=EventType.SQS)


def update_job_status(job_id: str, status: str, error: str = None):
    """Update job status in DynamoDB."""
    now = datetime.now(timezone.utc).isoformat()
    
    update_expr = 'SET #status = :status, updated_at = :now'
    expr_values = {':status': status, ':now': now}
    expr_names = {'#status': 'status'}
    
    # Append to timeline
    update_expr += ', timeline = list_append(if_not_exists(timeline, :empty), :timeline)'
    expr_values[':empty'] = []
    expr_values[':timeline'] = [{'status': status, 'timestamp': now}]
    
    if error:
        update_expr += ', error = :error'
        expr_values[':error'] = error
    
    jobs_table.update_item(
        Key={'pk': f'JOB#{job_id}', 'sk': 'META'},
        UpdateExpression=update_expr,
        ExpressionAttributeNames=expr_names,
        ExpressionAttributeValues=expr_values,
    )


@tracer.capture_method
def record_handler(record: SQSRecord) -> dict:
    """Process a single SQS message and start ECS task."""
    body = json.loads(record.body)
    job_id = body.get('job_id')
    
    if not job_id:
        logger.error("No job_id in message")
        return {"status": "error", "message": "No job_id"}
    
    logger.info(f"Starting ECS task for job {job_id}")
    
    try:
        # Update status to 'generating'
        update_job_status(job_id, 'generating')
        
        # Start ECS Fargate task
        response = ecs.run_task(
            cluster=ECS_CLUSTER,
            taskDefinition=ECS_TASK_DEF,
            launchType='FARGATE',
            networkConfiguration={
                'awsvpcConfiguration': {
                    'subnets': ECS_SUBNETS,
                    'securityGroups': [ECS_SECURITY_GROUP] if ECS_SECURITY_GROUP else [],
                    'assignPublicIp': 'DISABLED',
                }
            },
            overrides={
                'containerOverrides': [
                    {
                        'name': 'executor',
                        'environment': [
                            {'name': 'JOB_ID', 'value': job_id},
                            {'name': 'ARTIFACTS_BUCKET', 'value': ARTIFACTS_BUCKET},
                            {'name': 'JOBS_TABLE', 'value': JOBS_TABLE},
                            {'name': 'TEMPLATE_REPO_NAME', 'value': TEMPLATE_REPO_NAME},
                            {'name': 'PREVIEW_URL', 'value': PREVIEW_URL},
                        ],
                    }
                ]
            },
            count=1,
        )
        
        # Check if task started successfully
        if response.get('failures'):
            failure = response['failures'][0]
            error_msg = f"ECS task failed to start: {failure.get('reason', 'Unknown')}"
            logger.error(error_msg)
            update_job_status(job_id, 'failed', error_msg)
            return {"status": "error", "message": error_msg}
        
        task_arn = response['tasks'][0]['taskArn']
        logger.info(f"Started ECS task {task_arn} for job {job_id}")
        
        # Store task ARN in job record
        jobs_table.update_item(
            Key={'pk': f'JOB#{job_id}', 'sk': 'META'},
            UpdateExpression='SET ecs_task_arn = :arn',
            ExpressionAttributeValues={':arn': task_arn},
        )
        
        metrics.add_metric(name="TasksStarted", unit="Count", value=1)
        
        return {"status": "success", "job_id": job_id, "task_arn": task_arn}
        
    except Exception as e:
        error_msg = f"Failed to start ECS task: {str(e)}"
        logger.exception(error_msg)
        update_job_status(job_id, 'failed', error_msg)
        metrics.add_metric(name="TaskStartFailures", unit="Count", value=1)
        raise


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
@batch_processor(record_handler=record_handler, processor=processor)
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler for SQS events."""
    return processor.response()
