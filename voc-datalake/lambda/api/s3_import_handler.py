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

from shared.logging import logger, tracer
from shared.aws import get_s3_client
from shared.api import create_api_resolver, api_handler
from shared.exceptions import ConfigurationError, ValidationError, ServiceError

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
            folder = prefix['Prefix'].rstrip('/')
            if folder != 'processed':
                sources.append({'name': folder, 'display_name': f"S3 - {folder}"})
        return {'sources': sources, 'bucket': S3_IMPORT_BUCKET}
    except Exception as e:
        logger.exception(f"Failed to list S3 sources: {e}")
        raise ServiceError('Failed to list sources')


@app.post("/s3-import/sources")
@tracer.capture_method
def create_source():
    """Create a new source folder in the S3 import bucket."""
    if not S3_IMPORT_BUCKET:
        raise ConfigurationError('S3 import bucket not configured')
    
    body = app.current_event.json_body
    source_name = body.get('name', '').strip()
    
    if not source_name:
        raise ValidationError('Source name is required')
    
    safe_name = re.sub(r'[^a-zA-Z0-9_-]', '_', source_name)
    
    try:
        s3_client.put_object(Bucket=S3_IMPORT_BUCKET, Key=f"{safe_name}/", Body=b'')
        return {'success': True, 'source': {'name': safe_name, 'display_name': f"S3 - {safe_name}"}}
    except Exception as e:
        logger.exception(f"Failed to create source folder: {e}")
        raise ServiceError('Failed to create source folder')


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
        raise ServiceError('Failed to list files')


# Bound on the source-field column NAME. Generous (it names a column, not a
# value), but capped so it stays a sane S3 metadata header value.
MAX_SOURCE_FIELD_LENGTH = 128


def _validate_source_field(raw: Any) -> str | None:
    """Validate the optional per-row source column name for upload metadata.

    Returns the trimmed name, or None when absent/blank (the common case — most
    uploads have no per-row source). This is a COLUMN NAME, not a source value;
    the ingestor reads each row's value at that column and normalizes it. It only
    has to be a safe S3 metadata header value here: printable ASCII, bounded, no
    control characters (S3 rejects non-ASCII metadata and it would break the
    signed header).
    """
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise ValidationError('source_field must be a string')
    value = raw.strip()
    if not value:
        return None
    if len(value) > MAX_SOURCE_FIELD_LENGTH:
        raise ValidationError(f'source_field exceeds {MAX_SOURCE_FIELD_LENGTH} characters')
    if not all(32 <= ord(ch) <= 126 for ch in value):
        raise ValidationError('source_field must be printable ASCII (it names a column)')
    return value


@app.post("/s3-import/upload-url")
@tracer.capture_method
def get_upload_url():
    """Generate a presigned URL for uploading a file to S3."""
    if not S3_IMPORT_BUCKET:
        raise ConfigurationError('S3 import bucket not configured')
    
    body = app.current_event.json_body
    filename = body.get('filename', '').strip()
    source = body.get('source', 'default').strip()
    content_type = body.get('content_type', 'application/octet-stream')
    source_field = _validate_source_field(body.get('source_field'))
    
    if not filename:
        raise ValidationError('Filename is required')
    
    if not filename.endswith(('.csv', '.json', '.jsonl')):
        raise ValidationError('Only CSV, JSON, and JSONL files are supported')
    
    safe_source = re.sub(r'[^a-zA-Z0-9_-]', '_', source)
    safe_filename = re.sub(r'[^a-zA-Z0-9_.-]', '_', filename)
    key = f"{safe_source}/{safe_filename}"

    # The per-row source column (Phase 5): sign it INTO the URL as object
    # metadata so S3 stores `x-amz-meta-source-field`. It must be signed here —
    # a presigned PUT only accepts the headers baked into the signature — and the
    # ingestor reads `head_object().Metadata['source-field']` to apply it per row
    # (see plugins/s3_import/ingestor/handler.py). Absent, every row keeps the
    # file-level source, exactly as before.
    params: dict[str, Any] = {'Bucket': S3_IMPORT_BUCKET, 'Key': key, 'ContentType': content_type}
    if source_field:
        params['Metadata'] = {'source-field': source_field}
    
    try:
        expires_in = 7200  # 2 hours for large file uploads
        url = s3_client.generate_presigned_url(
            'put_object',
            Params=params,
            ExpiresIn=expires_in
        )
        return {
            'success': True, 'upload_url': url, 'key': key,
            'bucket': S3_IMPORT_BUCKET, 'expires_in': expires_in,
            # Echoed so the client can send the matching PUT header, and so the
            # response is self-describing about what the URL was signed for.
            'source_field': source_field,
        }
    except Exception as e:
        logger.exception(f"Failed to generate upload URL: {e}")
        raise ServiceError('Failed to generate upload URL')


@app.delete("/s3-import/file/<key>")
@tracer.capture_method
def delete_file(key: str):
    """Delete a file from the S3 import bucket."""
    if not S3_IMPORT_BUCKET:
        raise ConfigurationError('S3 import bucket not configured')
    
    decoded_key = urllib.parse.unquote(key)
    
    try:
        s3_client.delete_object(Bucket=S3_IMPORT_BUCKET, Key=decoded_key)
        return {'success': True, 'deleted_key': decoded_key}
    except Exception as e:
        logger.exception(f"Failed to delete file: {e}")
        raise ServiceError('Failed to delete file')


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
