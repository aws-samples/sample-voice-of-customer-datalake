"""
S3 Import API Lambda - File explorer for S3 import bucket.
Dedicated Lambda to avoid 20KB IAM policy limit on OpsApi.
"""

import os
import re
import sys
import urllib.parse
from typing import Any

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.api import api_handler, create_api_resolver
from shared.aws import get_s3_client
from shared.exceptions import ConfigurationError, ServiceError, ValidationError
from shared.logging import logger, tracer
from shared.request_body import json_object_body

s3_client = get_s3_client()
S3_IMPORT_BUCKET = os.environ.get("S3_IMPORT_BUCKET", "")

app = create_api_resolver()


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
            folder = prefix.get('Prefix', '').rstrip('/')
            if folder != 'processed':
                sources.append({'name': folder, 'display_name': f"S3 - {folder}"})
    except Exception as e:
        logger.exception(f"Failed to list S3 sources: {e}")
        raise ServiceError('Failed to list sources') from e
    return {'sources': sources, 'bucket': S3_IMPORT_BUCKET}


@app.post("/s3-import/sources")
@tracer.capture_method
def create_source():
    """Create a new source folder in the S3 import bucket."""
    if not S3_IMPORT_BUCKET:
        raise ConfigurationError('S3 import bucket not configured')

    body = json_object_body(app)
    source_name = body.get('name', '').strip()

    if not source_name:
        raise ValidationError('Source name is required')

    safe_name = re.sub(r'[^a-zA-Z0-9_-]', '_', source_name)

    try:
        s3_client.put_object(Bucket=S3_IMPORT_BUCKET, Key=f"{safe_name}/", Body=b'')
    except Exception as e:
        logger.exception(f"Failed to create source folder: {e}")
        raise ServiceError('Failed to create source folder') from e
    return {'success': True, 'source': {'name': safe_name, 'display_name': f"S3 - {safe_name}"}}


@app.get("/s3-import/files")
@tracer.capture_method
def list_files():
    """List files in the S3 import bucket."""
    if not S3_IMPORT_BUCKET:
        return {'files': [], 'bucket': None}

    params = app.current_event.query_string_parameters or {}
    source = params.get('source', '')
    include_processed = str(params.get('include_processed')).lower() == 'true'

    try:
        prefix = f"{source}/" if source else ''
        paginator = s3_client.get_paginator('list_objects_v2')
        files = []

        for page in paginator.paginate(Bucket=S3_IMPORT_BUCKET, Prefix=prefix):
            for obj in page.get('Contents', []):
                key = obj.get('Key')
                if not isinstance(key, str) or not key.endswith(('.csv', '.json', '.jsonl')):
                    continue
                if key.startswith('processed/') and not include_processed:
                    continue

                parts = key.split('/')
                last_modified = obj.get('LastModified')
                files.append({
                    'key': key,
                    'filename': parts[-1],
                    'source': parts[0] if len(parts) > 1 else 'root',
                    'size': obj.get('Size', 0),
                    'last_modified': last_modified.isoformat() if last_modified else '',
                    'status': 'processed' if key.startswith('processed/') else 'pending'
                })
    except Exception as e:
        logger.exception(f"Failed to list S3 files: {e}")
        raise ServiceError('Failed to list files') from e
    return {'files': files, 'bucket': S3_IMPORT_BUCKET}


@app.post("/s3-import/upload-url")
@tracer.capture_method
def get_upload_url():
    """Generate a presigned URL for uploading a file to S3."""
    if not S3_IMPORT_BUCKET:
        raise ConfigurationError('S3 import bucket not configured')

    body = json_object_body(app)
    filename = body.get('filename', '').strip()
    source = body.get('source', 'default').strip()
    content_type = body.get('content_type', 'application/octet-stream')

    if not filename:
        raise ValidationError('Filename is required')

    if not filename.endswith(('.csv', '.json', '.jsonl')):
        raise ValidationError('Only CSV, JSON, and JSONL files are supported')

    safe_source = re.sub(r'[^a-zA-Z0-9_-]', '_', source)
    safe_filename = re.sub(r'[^a-zA-Z0-9_.-]', '_', filename)
    key = f"{safe_source}/{safe_filename}"

    expires_in = 7200  # 2 hours for large file uploads
    try:
        url = s3_client.generate_presigned_url(
            'put_object',
            Params={'Bucket': S3_IMPORT_BUCKET, 'Key': key, 'ContentType': content_type},
            ExpiresIn=expires_in
        )
    except Exception as e:
        logger.exception(f"Failed to generate upload URL: {e}")
        raise ServiceError('Failed to generate upload URL') from e
    return {'success': True, 'upload_url': url, 'key': key, 'bucket': S3_IMPORT_BUCKET, 'expires_in': expires_in}


@app.delete("/s3-import/file/<key>")
@tracer.capture_method
def delete_file(key: str):
    """Delete a file from the S3 import bucket."""
    if not S3_IMPORT_BUCKET:
        raise ConfigurationError('S3 import bucket not configured')

    decoded_key = urllib.parse.unquote(key)

    try:
        s3_client.delete_object(Bucket=S3_IMPORT_BUCKET, Key=decoded_key)
    except Exception as e:
        logger.exception(f"Failed to delete file: {e}")
        raise ServiceError('Failed to delete file') from e
    return {'success': True, 'deleted_key': decoded_key}


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
