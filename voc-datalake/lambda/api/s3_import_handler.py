"""
S3 Import API Lambda - File explorer for S3 import bucket.
Dedicated Lambda to avoid 20KB IAM policy limit on OpsApi.

ADMIN ONLY, every route (#242): uploading a
file here ingests every row in it into the feedback pipeline (the bucket's
object-created trigger runs the `s3_import` ingestor, which enqueues each row for
Bedrock enrichment), and the listings expose the import bucket's name and every
file another admin staged. Each route's first statement is the two-path gate
(`_request.require_request_admin()`, shared/workspace_request.py `ResolvedRoutes`).

ON EITHER PATH (docs/multi-workspace.md, "Request flow"), as the manual import:
`_request.middleware` resolves `X-Workspace-Id` before every route (400 for an empty
header, the one 404 for a workspace the caller is not in). Without the header the
deployment's `admins` act on the bucket's root folders, as before; with it the
workspace's admins only (a member admin or an entered platform admin; an editor or a
viewer 403, the deployment's `admins` group grants nothing there) act on its files.

The bucket layout this API reads and writes is `<source>/<filename>`: `<source>`
is a folder made by `POST /s3-import/sources` (`[A-Za-z0-9_-]`), `<filename>` a
`.csv` / `.json` / `.jsonl` file. In a workspace the same layout lives under the
workspace's own prefix: the object is `ws/{ws}/<source>/<filename>`
(shared/ws_repo.py `s3_prefix`), and every key on the wire (a request's and an
answer's) is still `<source>/<filename>`, so the web app is the same on both paths
(`_bucket_key` / `_wire_key`). Two source names are reserved: `processed/` (never
deleted here) and `ws/` (the workspaces' folder, the ingestor's WORKSPACE_FOLDER):
no source, upload or key may name `ws`, and no request outside a workspace lists under
`ws/` (the root's folders are listed one by one, `ws/` never). The bucket's object-created trigger routes a `ws/{ws}/…` upload into
that workspace (plugins/s3_import/ingestor).

The prefix is built from the request's RESOLVED workspace only (`_request.scope()`),
never from a header, body or key the caller sent. The Lambda's S3 grant stays
bucket-wide: the deployment's path needs the root keys, and IAM's `*` matches `/`,
so no resource pattern could keep the root's keys from a workspace's; the isolation
is this module's, as the webhook role's secret read is soft-isolated.

Uploads never overwrite. `upload-url` answers 409 when the key already holds an
object, and the presigned PUT is signed with `If-None-Match: *`, so S3 itself
refuses (412) an object that appeared after the check. The ingestor processes
every object-created event and has no re-upload flow, so replacing a file means
deleting it first (the bucket is versioned, so neither step loses the old bytes).

Ingested files stay where they were uploaded: the ingestor never moves or deletes
them. `processed/<source>/<file>` exists only when an operator archives a file there
by hand (the bucket's lifecycle rule moves that prefix to Glacier after 30 days).
`POST /s3-import/reprocess` re-runs one file of either layout through the ingestor
(issue #144); its run is a `SOURCE_RUN#s3_import` row (`WS#{ws}#SOURCE_RUN#s3_import`
in a workspace, shared/s3_import_runs.py), polled at `GET /s3-import/reprocess/<run_id>`:
another place's run id answers as an unknown one. The ingestor's event names the
object's bucket key and, in a workspace, the workspace (`workspace_payload`).
"""

import json
import os
import re
import sys
import urllib.parse
from collections.abc import Iterator
from typing import Any

from aws_lambda_powertools.event_handler import Response, content_types
from botocore.exceptions import ClientError

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared import s3_import_runs
from shared.api import api_handler, create_api_resolver, get_caller_subject
from shared.aws import get_s3_client, is_missing_s3_object
from shared.exceptions import ConfigurationError, ConflictError, NotFoundError, ServiceError, ValidationError
from shared.logging import logger, tracer
from shared.request_body import json_object_body
from shared.tables import get_aggregates_table
from shared.workspace_request import ResolvedRoutes
from shared.ws_repo import WorkspaceScope, s3_prefix

s3_client = get_s3_client()
S3_IMPORT_BUCKET = os.environ.get("S3_IMPORT_BUCKET", "")
# The s3_import ingestor (VocIngestionStack), by name; absent when the plugin is disabled.
S3_IMPORT_INGESTOR_FUNCTION = os.environ.get("S3_IMPORT_INGESTOR_FUNCTION", "")

# The ingestor skips an empty file and one over its MAX_FILE_SIZE_MB (50 MB) without a word,
# so a reprocess refuses both up front rather than reporting a run that imported nothing.
MAX_REPROCESS_BYTES = 50 * 1024 * 1024
# How long an upload link may start its PUT (S3 checks the expiry when the request starts, so a long upload begun in
# time still completes): 2 hours deployment-wide; 15 minutes in a workspace, so few links outlive its hard delete's
# `import_objects` sweep (docs/multi-workspace.md, step 4).
UPLOAD_URL_SECONDS = 7200
WORKSPACE_UPLOAD_URL_SECONDS = 900

IMPORTABLE_EXTENSIONS = ('.csv', '.json', '.jsonl')
PROCESSED_PREFIX = 'processed'
# The workspaces' folder: a workspace's files are `ws/{ws}/<source>/<file>` (the s3_import ingestor's
# WORKSPACE_FOLDER), so `ws` is no source name on either path.
WORKSPACE_FOLDER = 'ws'
RESERVED_SOURCES = (PROCESSED_PREFIX, WORKSPACE_FOLDER)
# A character a source folder name never holds: `POST /s3-import/sources` and `upload-url` make each one `_`, and a
# staged key's source folder and a listed `source` hold none (one rule for all four).
_NOT_SOURCE_NAME = re.compile(r'[^A-Za-z0-9_-]')
# Control characters and a backslash have no place in a staged file name.
_UNSAFE_FILENAME_CHARS = re.compile(r'[\x00-\x1f\x7f\\]')
INVALID_KEY = 'Key is outside the import layout <source>/<file.csv|.json|.jsonl>'
INVALID_SOURCE = 'source must be a source folder name (letters, digits, _ and -)'
# The one answer for a file that is not there: it never repeats the key it was sent.
FILE_NOT_FOUND = 'File not found'

app = create_api_resolver()

# The request's workspace (shared/workspace_request.py ResolvedRoutes, the manual import's own), resolved before every
# route; each route then gates on the admin role on its path (see the module docstring).
_request = ResolvedRoutes(app)
app.use(middlewares=[_request.middleware])


def _reserved(source: str) -> str:
    return f'"{source}" is reserved; choose another source folder'


def _bucket_key(wire_key: str, scope: WorkspaceScope | None) -> str:
    """The object a wire key (`<source>/<file>`) names: itself deployment-wide, `ws/{ws}/<source>/<file>` in *scope*
    (the request's resolved workspace, never anything the caller sent)."""
    return wire_key if scope is None else f'{s3_prefix(scope)}{wire_key}'


def _wire_key(bucket_key: str, scope: WorkspaceScope | None) -> str | None:
    """The key on the wire for an object of *scope*'s listing: deployment-wide the object's own key (its listings
    never list under `ws/`: `_deployment_objects`, and `ws` is no source); in a workspace the key without its
    `ws/{ws}/` prefix (None for an object outside it)."""
    if scope is None:
        return bucket_key
    prefix = s3_prefix(scope)
    return bucket_key[len(prefix):] if bucket_key.startswith(prefix) else None


def _deletable_key(key: str) -> str:
    """*key* when it is a staged import file; ValidationError otherwise.

    Accepted: exactly `<source>/<filename>`, where `<source>` is a source-folder
    name other than `processed` and `ws` and `<filename>` is an importable file. Refused:
    a leading `/`, any `..`, a root-level or deeper key, a folder marker, the
    reserved `processed/` prefix, the workspaces' `ws/` folder, any other extension.
    """
    if key.startswith('/') or '..' in key or _UNSAFE_FILENAME_CHARS.search(key):
        raise ValidationError(INVALID_KEY)
    parts = key.split('/')
    if len(parts) != 2:
        raise ValidationError(INVALID_KEY)
    source, filename = parts
    if source == WORKSPACE_FOLDER:
        raise ValidationError(_reserved(WORKSPACE_FOLDER))
    if not source or _NOT_SOURCE_NAME.search(source) or source == PROCESSED_PREFIX:
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


# A staged file expires from the import bucket (an inbox, VocIngestionStack IMPORT_STAGED_EXPIRATION_DAYS,
# passed to this Lambda as env IMPORT_STAGED_EXPIRATION_DAYS by api-s3-import-lambda.ts); the durable copy of
# the original is the raw lake's (plugins/s3_import: raw/s3_import/..., when the s3_import source profile keeps
# whole files; a workspace's under its own `ws/{ws}/raw/s3_import/`), so a gone file is re-uploaded, not reprocessed.
_RAW_FOLDER = 'the raw lake under raw/s3_import/'
# A workspace's raw folder, named without its id: the hint is one fixed text, the same for every workspace.
_WORKSPACE_RAW_FOLDER = "the raw lake under the workspace's own folder, ws/<workspace>/raw/s3_import/"


def _staged_file_gone(days: str, raw_folder: str = _RAW_FOLDER) -> str:
    """The 404 hint; the expiry is named only when the stack passed a whole number of days."""
    expiry = f'Staged files expire after {days} days' if days.isdigit() else 'Staged files expire'
    return (f'{expiry} (the import bucket is an inbox). If the s3_import source keeps whole-file raw copies, '
            f'its original is in {raw_folder}. Upload it again to import it.')


_STAGED_DAYS = os.environ.get('IMPORT_STAGED_EXPIRATION_DAYS', '').strip()
STAGED_FILE_GONE = _staged_file_gone(_STAGED_DAYS)
WORKSPACE_STAGED_FILE_GONE = _staged_file_gone(_STAGED_DAYS, _WORKSPACE_RAW_FOLDER)


def _require_reprocessable_object(key: str, scope: WorkspaceScope | None) -> None:
    """NotFoundError when the object *key* holds nothing (one fixed answer per place, the hint naming its raw folder:
    the key is never repeated, so another place's file answers as one that exists nowhere); ValidationError when the
    ingestor would skip it."""
    try:
        head = s3_client.head_object(Bucket=S3_IMPORT_BUCKET, Key=key)
    except ClientError as e:
        if is_missing_s3_object(e):
            hint = STAGED_FILE_GONE if scope is None else WORKSPACE_STAGED_FILE_GONE
            raise NotFoundError(f'{FILE_NOT_FOUND}. {hint}') from e
        logger.exception(f"Failed to read the file to reprocess: {e}")
        raise ServiceError(s3_import_runs.START_FAILED) from e
    size = head.get('ContentLength', 0)
    if not size:
        raise ValidationError('The file is empty')
    if size > MAX_REPROCESS_BYTES:
        raise ValidationError('The file is larger than the 50 MB import limit')


def _refuse_existing_object(key: str, wire_key: str) -> None:
    """ConflictError (naming *wire_key*) when the object *key* already exists; ServiceError when S3 cannot say."""
    try:
        s3_client.head_object(Bucket=S3_IMPORT_BUCKET, Key=key)
    except ClientError as e:
        if is_missing_s3_object(e):
            return
        logger.exception(f"Failed to check for an existing file: {e}")
        raise ServiceError('Failed to generate upload URL') from e
    raise ConflictError(f'A file named {wire_key} already exists. Delete it first to upload it again.')


def _require_staged_object(key: str) -> None:
    """NotFoundError (``FILE_NOT_FOUND``) when the object *key* holds nothing; ServiceError when S3 cannot say. A
    delete checks first: on this versioned bucket deleting a missing key would still write a delete marker."""
    try:
        s3_client.head_object(Bucket=S3_IMPORT_BUCKET, Key=key)
    except ClientError as e:
        if is_missing_s3_object(e):
            raise NotFoundError(FILE_NOT_FOUND) from e
        logger.exception(f"Failed to read the file to delete: {e}")
        raise ServiceError('Failed to delete file') from e


@app.get("/s3-import/sources")
@tracer.capture_method
def list_sources():
    """List the source folders of the request's place (the bucket's root, or the workspace's `ws/{ws}/`)."""
    _request.require_request_admin()
    if not S3_IMPORT_BUCKET:
        return {'sources': [], 'bucket': None}

    scope = _request.scope()
    try:
        if scope is None:
            response = s3_client.list_objects_v2(Bucket=S3_IMPORT_BUCKET, Delimiter='/')
        else:
            response = s3_client.list_objects_v2(Bucket=S3_IMPORT_BUCKET, Prefix=s3_prefix(scope), Delimiter='/')
        sources = []
        for prefix in response.get('CommonPrefixes', []):
            folder = (_wire_key(prefix.get('Prefix', ''), scope) or '').rstrip('/')
            if folder not in RESERVED_SOURCES:
                sources.append({'name': folder, 'display_name': f"S3 - {folder}"})
    except Exception as e:
        logger.exception(f"Failed to list S3 sources: {e}")
        raise ServiceError('Failed to list sources') from e
    return {'sources': sources, 'bucket': S3_IMPORT_BUCKET}


@app.post("/s3-import/sources")
@tracer.capture_method
def create_source():
    """Create a new source folder in the request's place."""
    _request.require_request_admin()
    if not S3_IMPORT_BUCKET:
        raise ConfigurationError('S3 import bucket not configured')

    body = json_object_body(app)
    source_name = body.get('name', '').strip()

    if not source_name:
        raise ValidationError('Source name is required')

    safe_name = _NOT_SOURCE_NAME.sub('_', source_name)
    if safe_name in RESERVED_SOURCES:
        raise ValidationError(_reserved(safe_name))

    try:
        s3_client.put_object(Bucket=S3_IMPORT_BUCKET, Key=_bucket_key(f"{safe_name}/", _request.scope()), Body=b'')
    except Exception as e:
        logger.exception(f"Failed to create source folder: {e}")
        raise ServiceError('Failed to create source folder') from e
    return {'success': True, 'source': {'name': safe_name, 'display_name': f"S3 - {safe_name}"}}


@app.get("/s3-import/files")
@tracer.capture_method
def list_files():
    """List the files of the request's place (one source folder when `source` names one), keyed as on the wire."""
    _request.require_request_admin()
    if not S3_IMPORT_BUCKET:
        return {'files': [], 'bucket': None}

    params = app.current_event.query_string_parameters or {}
    source = params.get('source', '')
    include_processed = str(params.get('include_processed')).lower() == 'true'
    # A folder name only: `ws/<id>` or `a/b` would list another place's files, or a deeper prefix.
    if source and (_NOT_SOURCE_NAME.search(source) or source == WORKSPACE_FOLDER):
        raise ValidationError(INVALID_SOURCE)
    scope = _request.scope()

    try:
        files = []
        for obj in _listed_objects(scope, source, include_processed):
            entry = _file_entry(obj, scope, include_processed)
            if entry is not None:
                files.append(entry)
    except Exception as e:
        logger.exception(f"Failed to list S3 files: {e}")
        raise ServiceError('Failed to list files') from e
    return {'files': files, 'bucket': S3_IMPORT_BUCKET}


def _listed_objects(scope: WorkspaceScope | None, source: str, include_processed: bool) -> Iterator[Any]:
    """Every object the files route looks at, in the bucket's key order: one folder's (`source`), the workspace's
    (`ws/{ws}/`), or the deployment's root and its folders (`_deployment_objects`)."""
    paginator = s3_client.get_paginator('list_objects_v2')
    if scope is None and not source:
        yield from _deployment_objects(paginator, include_processed)
        return
    for page in paginator.paginate(Bucket=S3_IMPORT_BUCKET, Prefix=_bucket_key(f"{source}/" if source else '', scope)):
        yield from page.get('Contents', [])


def _deployment_objects(paginator: Any, include_processed: bool) -> Iterator[dict]:
    """The deployment's objects without listing under `ws/`: the root by `Delimiter='/'` (its own files, and its
    folders as `CommonPrefixes`), then each folder by its own prefix, but never `ws/` (the workspaces' folder) and
    `processed/` only with *include_processed*. The root's files and folders are merged by name, so the objects come
    in the order the bucket's flat listing gave them (S3 sorts each listing by key, and a folder's keys sort exactly
    where its `<name>/` does among the root's)."""
    entries: list[tuple[str, dict | None]] = []
    for page in paginator.paginate(Bucket=S3_IMPORT_BUCKET, Delimiter='/'):
        entries.extend((obj.get('Key') if isinstance(obj.get('Key'), str) else '', obj)
                       for obj in page.get('Contents', []))
        entries.extend((folder['Prefix'], None) for folder in page.get('CommonPrefixes', [])
                       if isinstance(folder.get('Prefix'), str))
    for name, obj in sorted(entries, key=lambda entry: entry[0]):
        if obj is not None:
            yield obj
        elif _lists_folder(name, include_processed):
            for page in paginator.paginate(Bucket=S3_IMPORT_BUCKET, Prefix=name):
                yield from page.get('Contents', [])


def _lists_folder(prefix: str, include_processed: bool) -> bool:
    """Whether the deployment's listing reads the root folder *prefix* (`<name>/`)."""
    folder = prefix[:-1]
    return folder != WORKSPACE_FOLDER and (include_processed or folder != PROCESSED_PREFIX)


def _file_entry(obj: dict, scope: WorkspaceScope | None, include_processed: bool) -> dict | None:
    """One listed object as the files route answers it (its wire key), or None when it is not listed: not an
    importable file, archived (without `include_processed`), or not of the request's place."""
    bucket_key = obj.get('Key')
    if not isinstance(bucket_key, str) or not bucket_key.endswith(IMPORTABLE_EXTENSIONS):
        return None
    key = _wire_key(bucket_key, scope)
    if key is None or (key.startswith('processed/') and not include_processed):
        return None
    parts = key.split('/')
    last_modified = obj.get('LastModified')
    return {
        'key': key,
        'filename': parts[-1],
        'source': parts[0] if len(parts) > 1 else 'root',
        'size': obj.get('Size', 0),
        'last_modified': last_modified.isoformat() if last_modified else '',
        'status': 'processed' if key.startswith('processed/') else 'pending'
    }


@app.post("/s3-import/upload-url")
@tracer.capture_method
def get_upload_url():
    """Presign a create-only PUT for one import file of the request's place (409 when the key is taken)."""
    _request.require_request_admin()
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

    safe_source = _NOT_SOURCE_NAME.sub('_', source)
    safe_filename = re.sub(r'[^a-zA-Z0-9_.-]', '_', filename)
    key = f"{safe_source}/{safe_filename}"
    if safe_source in RESERVED_SOURCES:
        raise ValidationError(_reserved(safe_source))
    scope = _request.scope()
    bucket_key = _bucket_key(key, scope)

    _refuse_existing_object(bucket_key, key)

    expires_in = UPLOAD_URL_SECONDS if scope is None else WORKSPACE_UPLOAD_URL_SECONDS
    try:
        url = s3_client.generate_presigned_url(
            'put_object',
            Params={'Bucket': S3_IMPORT_BUCKET, 'Key': bucket_key, 'ContentType': content_type, 'IfNoneMatch': '*'},
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
    """Delete one staged file (`<source>/<file>`) of the request's place; any other key is refused with 400, a file
    that is not there with the one 404 (nothing written)."""
    _request.require_request_admin()
    if not S3_IMPORT_BUCKET:
        raise ConfigurationError('S3 import bucket not configured')

    decoded_key = _deletable_key(urllib.parse.unquote(key))
    bucket_key = _bucket_key(decoded_key, _request.scope())
    _require_staged_object(bucket_key)

    try:
        s3_client.delete_object(Bucket=S3_IMPORT_BUCKET, Key=bucket_key)
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
    reprocess (`POST /settings/categories/reprocess`). In a workspace the run is the workspace's
    and the ingestor's event names it (shared/s3_import_runs.py `start_run`).
    """
    _request.require_request_admin()
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
    context = _request.context()
    scope = _request.scope()
    bucket_key = _bucket_key(key, scope)
    _require_reprocessable_object(bucket_key, scope)

    item = s3_import_runs.start_run(table, S3_IMPORT_INGESTOR_FUNCTION, S3_IMPORT_BUCKET, bucket_key,
                                    started_by=get_caller_subject(app.current_event.raw_event),
                                    file_key=key, workspace=context)
    logger.info("S3 import reprocess started", extra={'run_id': item['sk'], 'key': key})
    return Response(
        status_code=202,
        content_type=content_types.APPLICATION_JSON,
        body=json.dumps({'success': True, 'run': s3_import_runs.run_view(item)}),
    )


@app.get("/s3-import/reprocess/<run_id>")
@tracer.capture_method
def get_reprocess_run(run_id: str):
    """One reprocess run's row of the request's place → `{run}`; 404 when absent (another place's run too)."""
    _request.require_request_admin()
    table = get_aggregates_table()
    if table is None:
        raise ConfigurationError('S3 import ingestor not configured')
    item = s3_import_runs.get_run(table, run_id, scope=_request.scope())
    if not item:
        raise NotFoundError('Run not found')
    return {'run': s3_import_runs.run_view(item)}


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
