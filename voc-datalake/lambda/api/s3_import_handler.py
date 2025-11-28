"""
S3 Import API Lambda - File explorer for S3 import bucket.
Dedicated Lambda to avoid 20KB IAM policy limit on OpsApi.
"""
import json
import os
import re
import urllib.parse
from datetime import datetime, timezone
from typing import Any
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig
import boto3

logger = Logger()
tracer = Tracer()

s3_client = boto3.client('s3')
S3_IMPORT_BUCKET = os.environ.get('S3_IMPORT_BUCKET', '')

cors_config = CORSConfig(
    allow_origin="*",
    allow_headers=["Content-Type", "Authorization"],
    max_age=300,
    allow_credentials=False
)

app = APIGatewayRestResolver(cors=cors_config, enable_validation=True)


@app.get("/s3-import/sources")
@tracer.capture_method
def list_sources():
    """List all source folders in the S3 import bucket."""
    if not S3_IMPORT_BUCKET:
        return {'sources': [], 'bucket': None}
    
    try:
        response = s3_client.list_objects_v2(Bucket=S3_IMPORT_BUCKET, Delimiter='/')
        sources = []
        for prefix in response.get('CommonPrefixes', []):
            folder = prefix['Prefix'].rstrip('/')
            if folder != 'processed':
                sources.append({'name': folder, 'display_name': f"S3 - {folder}"})
        return {'sources': sources, 'bucket': S3_IMPORT_BUCKET}
    except Exception as e:
        logger.exception(f"Failed to list S3 sources: {e}")
        return {'sources': [], 'error': str(e)}


@app.post("/s3-import/sources")
@tracer.capture_method
def create_source():
    """Create a new source folder in the S3 import bucket."""
    if not S3_IMPORT_BUCKET:
        return {'success': False, 'message': 'S3 import bucket not configured'}
    
    body = app.current_event.json_body
    source_name = body.get('name', '').strip()
    
    if not source_name:
        return {'success': False, 'message': 'Source name is required'}
    
    safe_name = re.sub(r'[^a-zA-Z0-9_-]', '_', source_name)
    
    try:
        s3_client.put_object(Bucket=S3_IMPORT_BUCKET, Key=f"{safe_name}/", Body=b'')
        return {'success': True, 'source': {'name': safe_name, 'display_name': f"S3 - {safe_name}"}}
    except Exception as e:
        logger.exception(f"Failed to create source folder: {e}")
        return {'success': False, 'message': str(e)}


@app.get("/s3-import/files")
@tracer.capture_method
def list_files():
    """List files in the S3 import bucket."""
    if not S3_IMPORT_BUCKET:
        return {'files': [], 'bucket': None}
    
    params = app.current_event.query_string_parameters or {}
    source = params.get('source', '')
    include_processed = params.get('include_processed', 'false').lower() == 'true'
    
    try:
        prefix = f"{source}/" if source else ''
        paginator = s3_client.get_paginator('list_objects_v2')
        files = []
        
        for page in paginator.paginate(Bucket=S3_IMPORT_BUCKET, Prefix=prefix):
            for obj in page.get('Contents', []):
                key = obj['Key']
                if key.endswith('/') or not key.endswith(('.csv', '.json', '.jsonl')):
                    continue
                if key.startswith('processed/') and not include_processed:
                    continue
                
                parts = key.split('/')
                files.append({
                    'key': key,
                    'filename': parts[-1],
                    'source': parts[0] if len(parts) > 1 else 'root',
                    'size': obj['Size'],
                    'last_modified': obj['LastModified'].isoformat(),
                    'status': 'processed' if key.startswith('processed/') else 'pending'
                })
        
        return {'files': files, 'bucket': S3_IMPORT_BUCKET}
    except Exception as e:
        logger.exception(f"Failed to list S3 files: {e}")
        return {'files': [], 'error': str(e)}


@app.post("/s3-import/upload-url")
@tracer.capture_method
def get_upload_url():
    """Generate a presigned URL for uploading a file to S3."""
    if not S3_IMPORT_BUCKET:
        return {'success': False, 'message': 'S3 import bucket not configured'}
    
    body = app.current_event.json_body
    filename = body.get('filename', '').strip()
    source = body.get('source', 'default').strip()
    content_type = body.get('content_type', 'application/octet-stream')
    
    if not filename:
        return {'success': False, 'message': 'Filename is required'}
    
    if not filename.endswith(('.csv', '.json', '.jsonl')):
        return {'success': False, 'message': 'Only CSV, JSON, and JSONL files are supported'}
    
    safe_source = re.sub(r'[^a-zA-Z0-9_-]', '_', source)
    safe_filename = re.sub(r'[^a-zA-Z0-9_.-]', '_', filename)
    key = f"{safe_source}/{safe_filename}"
    
    try:
        url = s3_client.generate_presigned_url(
            'put_object',
            Params={'Bucket': S3_IMPORT_BUCKET, 'Key': key, 'ContentType': content_type},
            ExpiresIn=3600
        )
        return {'success': True, 'upload_url': url, 'key': key, 'bucket': S3_IMPORT_BUCKET, 'expires_in': 3600}
    except Exception as e:
        logger.exception(f"Failed to generate upload URL: {e}")
        return {'success': False, 'message': str(e)}


@app.delete("/s3-import/file/<key>")
@tracer.capture_method
def delete_file(key: str):
    """Delete a file from the S3 import bucket."""
    if not S3_IMPORT_BUCKET:
        return {'success': False, 'message': 'S3 import bucket not configured'}
    
    decoded_key = urllib.parse.unquote(key)
    
    try:
        s3_client.delete_object(Bucket=S3_IMPORT_BUCKET, Key=decoded_key)
        return {'success': True, 'deleted_key': decoded_key}
    except Exception as e:
        logger.exception(f"Failed to delete file: {e}")
        return {'success': False, 'message': str(e)}


@logger.inject_lambda_context
@tracer.capture_lambda_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
