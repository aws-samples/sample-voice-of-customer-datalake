"""
Data Explorer API Lambda - Full CRUD for S3 raw data and DynamoDB feedback.

Provides endpoints for:
- Browse, create, update, delete S3 raw data files
- View, update, delete DynamoDB feedback records
- Sync changes between S3 and DynamoDB

Dedicated Lambda to avoid 20KB IAM policy limit.
"""

import json
import os
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from shared.logging import logger, tracer
from shared.aws import get_s3_client, get_sqs_client
from shared.api import create_api_resolver, api_handler, DecimalEncoder
from shared.exceptions import ConfigurationError, ValidationError, NotFoundError, ServiceError
from shared.tables import get_feedback_table

s3_client = get_s3_client()
sqs_client = get_sqs_client()

RAW_DATA_BUCKET = os.environ.get("RAW_DATA_BUCKET", "")
PROCESSING_QUEUE_URL = os.environ.get("PROCESSING_QUEUE_URL", "")

# Available buckets for browsing
AVAILABLE_BUCKETS = {
    'raw-data': {'name': RAW_DATA_BUCKET, 'label': 'VoC Raw Data', 'description': 'Raw feedback data from all sources'},
}

app = create_api_resolver()


# ============================================
# S3 Raw Data CRUD
# ============================================

@app.get("/data-explorer/s3")
@tracer.capture_method
def list_s3_objects():
    """List objects in an S3 bucket with folder navigation."""
    params = app.current_event.query_string_parameters or {}
    bucket_id = params.get('bucket', 'raw-data')
    prefix = params.get('prefix', '').strip('/')
    
    # Get bucket name from available buckets
    bucket_config = AVAILABLE_BUCKETS.get(bucket_id, {})
    bucket_name = bucket_config.get('name', '')
    
    if not bucket_name:
        return {'objects': [], 'bucket': None, 'bucketId': bucket_id, 'prefix': '', 'error': 'Bucket not configured'}
    
    if prefix:
        prefix = f"{prefix}/"
    
    try:
        response = s3_client.list_objects_v2(
            Bucket=bucket_name,
            Prefix=prefix,
            Delimiter='/',
            MaxKeys=500
        )
        
        objects = []
        
        # Folders
        for common_prefix in response.get('CommonPrefixes', []):
            folder_path = common_prefix['Prefix']
            folder_name = folder_path.rstrip('/').split('/')[-1]
            objects.append({
                'key': folder_name,
                'size': 0,
                'lastModified': '',
                'isFolder': True
            })
        
        # Files
        for obj in response.get('Contents', []):
            key = obj['Key']
            if key == prefix:
                continue
            filename = key.split('/')[-1]
            if filename:
                objects.append({
                    'key': filename,
                    'fullKey': key,
                    'size': obj['Size'],
                    'lastModified': obj['LastModified'].isoformat(),
                    'isFolder': False
                })
        
        objects.sort(key=lambda x: (not x['isFolder'], x['key'].lower()))
        
        return {
            'objects': objects, 
            'bucket': bucket_name, 
            'bucketId': bucket_id,
            'bucketLabel': bucket_config.get('label', bucket_name),
            'prefix': prefix.rstrip('/')
        }
        
    except Exception as e:
        logger.exception(f"Failed to list S3 objects: {e}")
        raise ServiceError(f'Failed to list S3 objects: {str(e)}')


@app.get("/data-explorer/s3/preview")
@tracer.capture_method
def preview_s3_file():
    """Preview a file from S3 bucket.
    
    For text/JSON files: returns the content directly.
    For binary files (images, PDFs): returns a presigned URL.
    """
    params = app.current_event.query_string_parameters or {}
    bucket_id = params.get('bucket', 'raw-data')
    key = params.get('key', '')
    
    # Get bucket name from available buckets
    bucket_config = AVAILABLE_BUCKETS.get(bucket_id, {})
    bucket_name = bucket_config.get('name', '')
    
    if not bucket_name:
        raise ConfigurationError('Bucket not configured')
    
    if not key:
        raise ValidationError('File key is required')
    
    try:
        head_response = s3_client.head_object(Bucket=bucket_name, Key=key)
        size = head_response['ContentLength']
        content_type = head_response.get('ContentType', 'application/octet-stream')
        
        # Determine file type from content type or extension
        ext = key.split('.')[-1].lower() if '.' in key else ''
        is_image = content_type.startswith('image/') or ext in ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico']
        is_pdf = content_type == 'application/pdf' or ext == 'pdf'
        is_binary = is_image or is_pdf
        
        # For binary files, return a presigned URL
        if is_binary:
            presigned_url = s3_client.generate_presigned_url(
                'get_object',
                Params={'Bucket': bucket_name, 'Key': key},
                ExpiresIn=3600  # 1 hour
            )
            return {
                'content': presigned_url,
                'size': size,
                'contentType': content_type,
                'key': key,
                'isPresignedUrl': True
            }
        
        # For text files, read and return content
        max_preview_size = 1024 * 1024
        if size > max_preview_size:
            response = s3_client.get_object(Bucket=bucket_name, Key=key, Range=f'bytes=0-{max_preview_size - 1}')
            content = response['Body'].read().decode('utf-8', errors='replace')
            content = content + '\n\n... [truncated - file too large]'
        else:
            response = s3_client.get_object(Bucket=bucket_name, Key=key)
            content = response['Body'].read().decode('utf-8', errors='replace')
        
        try:
            parsed = json.loads(content.split('\n... [truncated')[0] if '... [truncated' in content else content)
            return {'content': parsed, 'size': size, 'contentType': content_type, 'key': key}
        except json.JSONDecodeError:
            return {'content': content, 'size': size, 'contentType': content_type, 'key': key}
            
    except s3_client.exceptions.NoSuchKey:
        raise NotFoundError('File not found')
    except Exception as e:
        logger.exception(f"Failed to preview S3 file: {e}")
        raise ServiceError(f'Failed to preview file: {str(e)}')


@app.put("/data-explorer/s3")
@tracer.capture_method
def save_s3_file():
    """Create or update a file in S3 bucket."""
    body = app.current_event.json_body
    bucket_id = body.get('bucket', 'raw-data')
    key = body.get('key', '')
    content = body.get('content', '')
    sync_to_dynamo = body.get('sync_to_dynamo', False)
    
    # Get bucket name from available buckets
    bucket_config = AVAILABLE_BUCKETS.get(bucket_id, {})
    bucket_name = bucket_config.get('name', '')
    
    if not bucket_name:
        raise ConfigurationError('Bucket not configured')
    
    if not key:
        raise ValidationError('File key is required')
    
    try:
        # Ensure content is a string
        if isinstance(content, dict):
            content = json.dumps(content, indent=2)
        
        s3_client.put_object(
            Bucket=bucket_name,
            Key=key,
            Body=content.encode('utf-8'),
            ContentType='application/json'
        )
        
        synced = False
        # Only sync to DynamoDB for raw-data bucket
        if sync_to_dynamo and PROCESSING_QUEUE_URL and bucket_id == 'raw-data':
            # Send to processing queue to reprocess
            try:
                parsed = json.loads(content)
                parsed['s3_raw_uri'] = f"s3://{bucket_name}/{key}"
                sqs_client.send_message(
                    QueueUrl=PROCESSING_QUEUE_URL,
                    MessageBody=json.dumps(parsed)
                )
                synced = True
                logger.info(f"Sent to processing queue for reprocessing: {key}")
            except Exception as e:
                logger.warning(f"Failed to sync to DynamoDB: {e}")
        
        return {'success': True, 'message': 'File saved', 'key': key, 'synced': synced}
        
    except Exception as e:
        logger.exception(f"Failed to save S3 file: {e}")
        raise ServiceError(f'Failed to save file: {str(e)}')


@app.delete("/data-explorer/s3")
@tracer.capture_method
def delete_s3_file():
    """Delete a file from S3 bucket."""
    params = app.current_event.query_string_parameters or {}
    bucket_id = params.get('bucket', 'raw-data')
    key = params.get('key', '')
    
    # Get bucket name from available buckets
    bucket_config = AVAILABLE_BUCKETS.get(bucket_id, {})
    bucket_name = bucket_config.get('name', '')
    
    if not bucket_name:
        raise ConfigurationError('Bucket not configured')
    
    if not key:
        raise ValidationError('File key is required')
    
    try:
        s3_client.delete_object(Bucket=bucket_name, Key=key)
        return {'success': True, 'message': 'File deleted', 'key': key}
    except Exception as e:
        logger.exception(f"Failed to delete S3 file: {e}")
        raise ServiceError(f'Failed to delete file: {str(e)}')


# ============================================
# DynamoDB Feedback CRUD
# ============================================

@app.put("/data-explorer/feedback")
@tracer.capture_method
def save_feedback():
    """Update a feedback record in DynamoDB."""
    table = get_feedback_table()
    if not table:
        raise ConfigurationError('Feedback table not configured')
    
    body = app.current_event.json_body
    feedback_id = body.get('feedback_id', '')
    data = body.get('data', {})
    sync_to_s3 = body.get('sync_to_s3', False)
    
    if not feedback_id:
        raise ValidationError('Feedback ID is required')
    
    try:
        # Get existing item to find the PK/SK
        # feedback_id format is typically: {source}_{id}
        source_platform = data.get('source_platform', '')
        
        # Build update expression
        update_parts = []
        expr_names = {}
        expr_values = {}
        
        # Fields that can be updated
        updatable_fields = [
            'original_text', 'normalized_text', 'category', 'subcategory',
            'sentiment_label', 'sentiment_score', 'urgency', 'impact_area',
            'problem_summary', 'problem_root_cause_hypothesis', 'persona_name',
            'persona_type', 'journey_stage', 'rating'
        ]
        
        for field in updatable_fields:
            if field in data:
                update_parts.append(f"#{field} = :{field}")
                expr_names[f"#{field}"] = field
                value = data[field]
                # Convert floats to Decimal for DynamoDB
                if isinstance(value, float):
                    value = Decimal(str(value))
                expr_values[f":{field}"] = value
        
        if not update_parts:
            raise ValidationError('No fields to update')
        
        # Add updated_at timestamp
        update_parts.append("#updated_at = :updated_at")
        expr_names["#updated_at"] = "updated_at"
        expr_values[":updated_at"] = datetime.now(timezone.utc).isoformat()
        
        update_expression = "SET " + ", ".join(update_parts)
        
        # Query to find the item by feedback_id (using GSI or scan)
        # For simplicity, we'll use the source_platform from data
        pk = f"SOURCE#{source_platform}" if source_platform else None
        sk = f"FEEDBACK#{feedback_id}"
        
        if pk:
            table.update_item(
                Key={'pk': pk, 'sk': sk},
                UpdateExpression=update_expression,
                ExpressionAttributeNames=expr_names,
                ExpressionAttributeValues=expr_values
            )
        else:
            # Need to find the item first
            response = table.query(
                IndexName='feedback-id-index',
                KeyConditionExpression='feedback_id = :fid',
                ExpressionAttributeValues={':fid': feedback_id},
                Limit=1
            )
            if response.get('Items'):
                item = response['Items'][0]
                table.update_item(
                    Key={'pk': item['pk'], 'sk': item['sk']},
                    UpdateExpression=update_expression,
                    ExpressionAttributeNames=expr_names,
                    ExpressionAttributeValues=expr_values
                )
            else:
                raise NotFoundError('Feedback not found')
        
        synced = False
        if sync_to_s3 and RAW_DATA_BUCKET:
            # Update S3 raw data if s3_raw_uri exists
            s3_raw_uri = data.get('s3_raw_uri', '')
            if s3_raw_uri and s3_raw_uri.startswith('s3://'):
                try:
                    # Parse S3 URI
                    uri_parts = s3_raw_uri.replace('s3://', '').split('/', 1)
                    bucket = uri_parts[0]
                    key = uri_parts[1] if len(uri_parts) > 1 else ''
                    
                    if bucket == RAW_DATA_BUCKET and key:
                        s3_client.put_object(
                            Bucket=bucket,
                            Key=key,
                            Body=json.dumps(data, indent=2, cls=DecimalEncoder),
                            ContentType='application/json'
                        )
                        synced = True
                except Exception as e:
                    logger.warning(f"Failed to sync to S3: {e}")
        
        return {'success': True, 'message': 'Feedback updated', 'synced': synced}
        
    except Exception as e:
        logger.exception(f"Failed to update feedback: {e}")
        raise ServiceError(f'Failed to update feedback: {str(e)}')


@app.delete("/data-explorer/feedback")
@tracer.capture_method
def delete_feedback():
    """Delete a feedback record from DynamoDB."""
    table = get_feedback_table()
    if not table:
        raise ConfigurationError('Feedback table not configured')
    
    params = app.current_event.query_string_parameters or {}
    feedback_id = params.get('feedback_id', '')
    
    if not feedback_id:
        raise ValidationError('Feedback ID is required')
    
    try:
        # Find the item first using GSI
        response = table.query(
            IndexName='feedback-id-index',
            KeyConditionExpression='feedback_id = :fid',
            ExpressionAttributeValues={':fid': feedback_id},
            Limit=1
        )
        
        if not response.get('Items'):
            raise NotFoundError('Feedback not found')
        
        item = response['Items'][0]
        
        # Delete the item
        table.delete_item(Key={'pk': item['pk'], 'sk': item['sk']})
        
        return {'success': True, 'message': 'Feedback deleted', 'feedback_id': feedback_id}
        
    except NotFoundError:
        raise
    except Exception as e:
        logger.exception(f"Failed to delete feedback: {e}")
        raise ServiceError(f'Failed to delete feedback: {str(e)}')


@app.get("/data-explorer/buckets")
@tracer.capture_method
def list_buckets():
    """List available S3 buckets for browsing."""
    buckets = []
    for bucket_id, config in AVAILABLE_BUCKETS.items():
        if config.get('name'):
            buckets.append({
                'id': bucket_id,
                'name': config['name'],
                'label': config.get('label', config['name']),
                'description': config.get('description', ''),
            })
    return {'buckets': buckets}


@app.get("/data-explorer/stats")
@tracer.capture_method
def get_data_stats():
    """Get statistics about the data lake."""
    stats = {
        's3': {
            'buckets': [],
            'configured': bool(RAW_DATA_BUCKET)
        },
        'dynamodb': {'table': os.environ.get('FEEDBACK_TABLE', ''), 'configured': get_feedback_table() is not None}
    }
    
    # Add info for each configured bucket
    for bucket_id, config in AVAILABLE_BUCKETS.items():
        bucket_name = config.get('name', '')
        if bucket_name:
            bucket_info = {
                'id': bucket_id,
                'name': bucket_name,
                'label': config.get('label', bucket_name),
            }
            try:
                response = s3_client.list_objects_v2(Bucket=bucket_name, Delimiter='/', MaxKeys=100)
                folders = [p['Prefix'].rstrip('/') for p in response.get('CommonPrefixes', []) if p['Prefix'].rstrip('/')]
                bucket_info['folders'] = folders
                bucket_info['folder_count'] = len(folders)
            except Exception as e:
                logger.warning(f"Failed to get stats for bucket {bucket_name}: {e}")
                bucket_info['error'] = str(e)
            stats['s3']['buckets'].append(bucket_info)
    
    return stats


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
