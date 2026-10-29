"""
S3 Import API Lambda - File explorer for S3 import bucket.
Dedicated Lambda to avoid 20KB IAM policy limit on OpsApi.

ADMIN ONLY, every route (owner decision 2026-10-08, #242 follow-up): uploading a
file here ingests every row in it into the feedback pipeline (the bucket's
object-created trigger runs the `s3_import` ingestor, which enqueues each row for
Bedrock enrichment), and the listings expose the import bucket's name and every
file another admin staged. Enforced by one resolver middleware (`shared.api.admins_only`),
so a route added later is gated without having to remember the check.

The bucket layout this API reads and writes is `<source>/<filename>`: `<source>`
is a folder made by `POST /s3-import/sources` (`[A-Za-z0-9_-]`), `<filename>` a
`.csv` / `.json` / `.jsonl` file. `processed/` is reserved and never deleted here.

Uploads never overwrite. `upload-url` answers 409 when the key already holds an
object, and the presigned PUT is signed with `If-None-Match: *`, so S3 itself
refuses (412) an object that appeared after the check. The ingestor processes
every object-created event and has no re-upload flow, so replacing a file means
deleting it first (the bucket is versioned, so neither step loses the old bytes).

Ingested files stay where they were uploaded: the ingestor never moves or deletes
them. `processed/<source>/<file>` exists only when an operator archives a file there
by hand (the bucket's lifecycle rule moves that prefix to Glacier after 30 days).
`POST /s3-import/reprocess` re-runs one file of either layout through the ingestor
(issue #144); its run is a `SOURCE_RUN#s3_import` row, polled at
`GET /s3-import/reprocess/<run_id>`.
"""

import json
import os
import re
import sys
import urllib.parse
from typing import Any

from aws_lambda_powertools.event_handler import Response, content_types
from botocore.exceptions import ClientError

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared import s3_import_runs
from shared.api import admins_only, api_handler, create_api_resolver
from shared.aws import get_s3_client, is_missing_s3_object
from shared.exceptions import ConfigurationError, ConflictError, NotFoundError, ServiceError, ValidationError
from shared.logging import logger, tracer
from shared.request_body import json_object_body
from shared.tables import get_aggregates_table

s3_client = get_s3_client()
S3_IMPORT_BUCKET = os.environ.get("S3_IMPORT_BUCKET", "")
# The s3_import ingestor (VocIngestionStack), by name; absent when the plugin is disabled.
S3_IMPORT_INGESTOR_FUNCTION = os.environ.get("S3_IMPORT_INGESTOR_FUNCTION", "")

# The ingestor skips an empty file and one over its MAX_FILE_SIZE_MB (50 MB) without a word,
# so a reprocess refuses both up front rather than reporting a run that imported nothing.
MAX_REPROCESS_BYTES = 50 * 1024 * 1024

IMPORTABLE_EXTENSIONS = ('.csv', '.json', '.jsonl')
PROCESSED_PREFIX = 'processed'
# A source folder name, as `POST /s3-import/sources` and `upload-url` sanitise it.
_SOURCE_NAME = re.compile(r'[A-Za-z0-9_-]+')
# Control characters and a backslash have no place in a staged file name.
_UNSAFE_FILENAME_CHARS = re.compile(r'[\x00-\x1f\x7f\\]')
INVALID_KEY = 'Key is outside the import layout <source>/<file.csv|.json|.jsonl>'

app = create_api_resolver()


# Every S3-import route is admin-only (403 otherwise). See the module docstring.
app.use(middlewares=[admins_only])


def _deletable_key(key: str) -> str:
    """*key* when it is a staged import file; ValidationError otherwise.

    Accepted: exactly `<source>/<filename>`, where `<source>` is a source-folder
    name other than `processed` and `<filename>` is an importable file. Refused:
    a leading `/`, any `..`, a root-level or deeper key, a folder marker, the
    reserved `processed/` prefix, any other extension.
    """
    if key.startswith('/') or '..' in key or _UNSAFE_FILENAME_CHARS.search(key):
        raise ValidationError(INVALID_KEY)
    parts = key.split('/')
    if len(parts) != 2:
        raise ValidationError(INVALID_KEY)
    source, filename = parts
    if not _SOURCE_NAME.fullmatch(source) or source == PROCESSED_PREFIX:
        raise ValidationError(INVALID_KEY)
    if not filename.strip() or not filename.endswith(IMPORTABLE_EXTENSIONS):
        raise ValidationError(INVALID_KEY)
    return key


def _reprocessable_key(key: str) -> str:
    """*key* when it is a staged file or one archived under `processed/`; ValidationError otherwise.

    Accepted: `<source>/<file>` exactly as `_deletable_key`, and `processed/<source>/<file>`
    (an archived copy keeps its folder, which names the source `S3 - <source>` the
    pipeline's duplicate check keys on).
    """
    if key.startswith(f'{PROCESSED_PREFIX}/'):
        return f'{PROCESSED_PREFIX}/{_deletable_key(key[len(PROCESSED_PREFIX) + 1:])}'
    return _deletable_key(key)


def _require_reprocessable_object(key: str) -> None:
    """NotFoundError when *key* holds nothing; ValidationError when the ingestor would skip it."""
    try:
        head = s3_client.head_object(Bucket=S3_IMPORT_BUCKET, Key=key)
    except ClientError as e:
        if is_missing_s3_object(e):
            raise NotFoundError(f'File not found: {key}') from e
        logger.exception(f"Failed to read the file to reprocess: {e}")
        raise ServiceError(s3_import_runs.START_FAILED) from e
    size = head.get('ContentLength', 0)
    if not size:
        raise ValidationError('The file is empty')
    if size > MAX_REPROCESS_BYTES:
        raise ValidationError('The file is larger than the 50 MB import limit')


def _refuse_existing_object(key: str) -> None:
    """ConflictError when *key* already holds an object; ServiceError when S3 cannot say."""
    try:
        s3_client.head_object(Bucket=S3_IMPORT_BUCKET, Key=key)
    except ClientError as e:
        if is_missing_s3_object(e):
            return
        logger.exception(f"Failed to check for an existing file: {e}")
        raise ServiceError('Failed to generate upload URL') from e
    raise ConflictError(f'A file named {key} already exists. Delete it first to upload it again.')


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
            if folder != PROCESSED_PREFIX:
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
                if not isinstance(key, str) or not key.endswith(IMPORTABLE_EXTENSIONS):
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
    """Presign a create-only PUT for one import file (409 when the key is taken)."""
    if not S3_IMPORT_BUCKET:
        raise ConfigurationError('S3 import bucket not configured')

    body = json_object_body(app)
    filename = body.get('filename', '').strip()
    source = body.get('source', 'default').strip()
    content_type = body.get('content_type', 'application/octet-stream')

    if not filename:
        raise ValidationError('Filename is required')

    if not filename.endswith(IMPORTABLE_EXTENSIONS):
        raise ValidationError('Only CSV, JSON, and JSONL files are supported')

    safe_source = re.sub(r'[^a-zA-Z0-9_-]', '_', source)
    safe_filename = re.sub(r'[^a-zA-Z0-9_.-]', '_', filename)
    key = f"{safe_source}/{safe_filename}"
    if safe_source == PROCESSED_PREFIX:
        raise ValidationError(f'"{PROCESSED_PREFIX}" is reserved; choose another source folder')

    _refuse_existing_object(key)

    expires_in = 7200  # 2 hours for large file uploads
    try:
        url = s3_client.generate_presigned_url(
            'put_object',
            Params={'Bucket': S3_IMPORT_BUCKET, 'Key': key, 'ContentType': content_type, 'IfNoneMatch': '*'},
            ExpiresIn=expires_in
        )
    except Exception as e:
        logger.exception(f"Failed to generate upload URL: {e}")
        raise ServiceError('Failed to generate upload URL') from e
    return {
        'success': True, 'upload_url': url, 'key': key, 'bucket': S3_IMPORT_BUCKET, 'expires_in': expires_in,
        # Signed into the URL: the PUT must send exactly these, or S3 refuses it.
        'upload_headers': {'Content-Type': content_type, 'If-None-Match': '*'},
    }


@app.delete("/s3-import/file/<key>")
@tracer.capture_method
def delete_file(key: str):
    """Delete one staged file (`<source>/<file>`); any other key is refused with 400."""
    if not S3_IMPORT_BUCKET:
        raise ConfigurationError('S3 import bucket not configured')

    decoded_key = _deletable_key(urllib.parse.unquote(key))

    try:
        s3_client.delete_object(Bucket=S3_IMPORT_BUCKET, Key=decoded_key)
    except Exception as e:
        logger.exception(f"Failed to delete file: {e}")
        raise ServiceError('Failed to delete file') from e
    return {'success': True, 'deleted_key': decoded_key}


@app.post("/s3-import/reprocess")
@tracer.capture_method
def reprocess_file():
    """Re-run one imported file through the s3_import ingestor → 202 `{success, run}`.

    Duplicates are skipped by the processor (the feedback id is derived from the
    source and the row, not the import time), so only rows missing from the data
    lake are imported again. Existing rows are not re-enriched: that is category
    reprocess (`POST /settings/categories/reprocess`).
    """
    if not S3_IMPORT_BUCKET:
        raise ConfigurationError('S3 import bucket not configured')
    table = get_aggregates_table()
    if not S3_IMPORT_INGESTOR_FUNCTION or table is None:
        raise ConfigurationError('S3 import ingestor not configured')

    body = json_object_body(app)
    raw_key = body.get('key')
    if not isinstance(raw_key, str) or not raw_key.strip():
        raise ValidationError('key is required')
    key = _reprocessable_key(raw_key.strip())
    _require_reprocessable_object(key)

    item = s3_import_runs.start_run(table, S3_IMPORT_INGESTOR_FUNCTION, S3_IMPORT_BUCKET, key)
    logger.info("S3 import reprocess started", extra={'run_id': item['sk'], 'key': key})
    return Response(
        status_code=202,
        content_type=content_types.APPLICATION_JSON,
        body=json.dumps({'success': True, 'run': s3_import_runs.run_view(item)}),
    )


@app.get("/s3-import/reprocess/<run_id>")
@tracer.capture_method
def get_reprocess_run(run_id: str):
    """One reprocess run's `SOURCE_RUN#s3_import` row → `{run}`; 404 when absent."""
    table = get_aggregates_table()
    if table is None:
        raise ConfigurationError('S3 import ingestor not configured')
    item = s3_import_runs.get_run(table, run_id)
    if not item:
        raise NotFoundError('Run not found')
    return {'run': s3_import_runs.run_view(item)}


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
