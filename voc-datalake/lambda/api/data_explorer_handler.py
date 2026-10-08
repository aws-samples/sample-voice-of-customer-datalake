"""
Data Explorer API Lambda - admin browser for S3 raw data and DynamoDB feedback.

Provides endpoints for:
- Browsing and previewing S3 raw data files
- Creating S3 files (objects under `raw/` are write-once: never overwritten)
- Editing DynamoDB feedback records

NOTHING HERE DELETES. A VoC data lake reads and interprets customer data but never
removes it, so there is no DELETE route for S3 objects or feedback records, a PUT
refuses to overwrite an existing raw object (409), and a feedback edit never
writes back to the raw object it came from.

ADMIN ONLY, every route: raw S3 objects cannot be filtered by the per-user category
scope the rest of the API enforces, so the explorer is not a route a restricted
user may reach at all. Enforced by one resolver middleware, so a new route is
covered without having to remember the check.

Dedicated Lambda to avoid 20KB IAM policy limit.
"""

import json
import os
import sys
from datetime import UTC, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aws_lambda_powertools.event_handler import APIGatewayRestResolver
from aws_lambda_powertools.event_handler.middlewares import NextMiddleware
from botocore.exceptions import BotoCoreError, ClientError

if TYPE_CHECKING:
    from mypy_boto3_s3.type_defs import PutObjectRequestTypeDef

from shared.api import api_handler, create_api_resolver, require_admin
from shared.aws import get_dynamodb_resource, get_s3_client, get_sqs_client
from shared.exceptions import (
    ApiError,
    ConfigurationError,
    ConflictError,
    NotFoundError,
    ServiceError,
    ValidationError,
)
from shared.feedback_category import (
    CategoryChange,
    apply_conditional_update,
    categories_config,
    category_change,
    category_label,
    item_exists,
    override_record,
    update_expression,
    validate_target,
)
from shared.indexes import FEEDBACK_BY_ID_INDEX
from shared.logging import logger, tracer
from shared.project_gate import caller_from_event
from shared.request_body import json_object_body
from shared.source_policy import apply_source_policy, raw_archive_allowed
from shared.source_profiles import cached_source_profile_strict
from shared.tables import get_aggregates_table

s3_client = get_s3_client()
dynamodb = get_dynamodb_resource()
sqs_client = get_sqs_client()

RAW_DATA_BUCKET = os.environ.get("RAW_DATA_BUCKET", "")
FEEDBACK_TABLE = os.environ.get("FEEDBACK_TABLE", "")
PROCESSING_QUEUE_URL = os.environ.get("PROCESSING_QUEUE_URL", "")

# Available buckets for browsing
AVAILABLE_BUCKETS = {
    'raw-data': {'name': RAW_DATA_BUCKET, 'label': 'VoC Raw Data', 'description': 'Raw feedback data from all sources'},
}

# Ingested raw data lives under this prefix and is immutable once written.
RAW_PREFIX = 'raw/'

# S3 answers a failed `IfNoneMatch='*'` with one of these: 412 when the object
# exists, 409 when a concurrent conditional write to the same key is in flight.
_OBJECT_EXISTS_ERROR_CODES = frozenset({'PreconditionFailed', 'ConditionalRequestConflict'})

# Client-facing text for an unexpected failure (#263, after PR #403). Never
# `str(e)`: `shared/api.py` returns a ServiceError's message verbatim, and boto
# text carries the bucket/table names, key structure and request ids. Each site
# logs the fault with `logger.exception` instead, and re-raises `ApiError` ahead
# of its catch-all so a typed 4xx raised inside keeps its own status.
FAILED_LIST = 'Failed to list S3 objects'
FAILED_PREVIEW = 'Failed to preview file'
FAILED_SAVE = 'Failed to save file'
FAILED_BUCKET_STATS = 'Failed to read bucket contents'

# "That key is not there", which S3 spells differently per operation:
# `head_object` has no response body to model `NoSuchKey` from, so it raises a
# bare ClientError with code '404'; only `get_object` raises `NoSuchKey`.
S3_MISSING_KEY_CODES = frozenset({'404', 'NoSuchKey', 'NotFound'})

app = create_api_resolver()


def _admins_only(app: APIGatewayRestResolver, next_middleware: NextMiddleware):
    """Every data-explorer route is admin-only (403 otherwise). See the module docstring."""
    require_admin(app.current_event.raw_event)
    return next_middleware(app)


app.use(middlewares=[_admins_only])


def _reject_prototype_mutation(key: str) -> None:
    if key.startswith('prototypes/'):
        raise ValidationError('Generated prototypes are read-only in Data Explorer')


def _is_raw_key(key: str) -> bool:
    return key.startswith(RAW_PREFIX)


def _keyed_bucket_request(request: dict) -> tuple[str, str]:
    """`(bucket name, object key)` from a request naming a `bucket` id and a `key`.

    The bucket must be one of `AVAILABLE_BUCKETS` and configured (else a 500: the
    deployment, not the caller, is missing it); the key must be present (else 400).
    """
    bucket_id = request.get('bucket', 'raw-data')
    key = request.get('key', '')
    bucket_name = AVAILABLE_BUCKETS.get(bucket_id, {}).get('name', '')
    if not bucket_name:
        raise ConfigurationError('Bucket not configured')
    if not key:
        raise ValidationError('File key is required')
    return bucket_name, key


# ============================================
# S3 Raw Data (read + create)
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
            folder_path = common_prefix.get('Prefix', '')
            folder_name = folder_path.rstrip('/').split('/')[-1]
            objects.append({
                'key': folder_name,
                'size': 0,
                'lastModified': '',
                'isFolder': True
            })

        # Files
        for obj in response.get('Contents', []):
            key = obj.get('Key', '')
            if key == prefix:
                continue
            filename = key.split('/')[-1]
            if filename:
                last_modified = obj.get('LastModified')
                objects.append({
                    'key': filename,
                    'fullKey': key,
                    'size': obj.get('Size', 0),
                    'lastModified': last_modified.isoformat() if last_modified else '',
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

    except ApiError:
        raise
    except Exception as e:
        logger.exception("Failed to list S3 objects")
        raise ServiceError(FAILED_LIST) from e


_IMAGE_EXTENSIONS = ('jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico')
_MAX_PREVIEW_BYTES = 1024 * 1024
_TRUNCATION_MARKER = '\n\n... [truncated - file too large]'


def _extension(key: str) -> str:
    """The lower-cased text after the key's last dot, or '' when it has none."""
    return key.split('.')[-1].lower() if '.' in key else ''


def _is_binary_object(key: str, content_type: str) -> bool:
    """Images and PDFs are previewed by URL, everything else inline as text."""
    ext = _extension(key)
    is_image = content_type.startswith('image/') or ext in _IMAGE_EXTENSIONS
    is_pdf = content_type == 'application/pdf' or ext == 'pdf'
    return is_image or is_pdf


def _read_text_preview(bucket_name: str, key: str, size: int) -> str:
    """The object's text, cut to the first MiB (with a visible marker) when larger."""
    if size > _MAX_PREVIEW_BYTES:
        response = s3_client.get_object(Bucket=bucket_name, Key=key, Range=f'bytes=0-{_MAX_PREVIEW_BYTES - 1}')
        return response['Body'].read().decode('utf-8', errors='replace') + _TRUNCATION_MARKER
    response = s3_client.get_object(Bucket=bucket_name, Key=key)
    return response['Body'].read().decode('utf-8', errors='replace')


def _decoded_preview_content(content: str) -> object:
    """Parsed JSON when the (untruncated part of the) text is JSON; the text itself otherwise."""
    body = content.split('\n... [truncated')[0] if '... [truncated' in content else content
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return content


def _object_preview(bucket_name: str, key: str) -> dict:
    """The preview payload for one object: a presigned URL for binaries, content for text."""
    head_response = s3_client.head_object(Bucket=bucket_name, Key=key)
    size = head_response['ContentLength']
    content_type = head_response.get('ContentType', 'application/octet-stream')

    # For binary files, return a presigned URL
    if _is_binary_object(key, content_type):
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
    content = _read_text_preview(bucket_name, key, size)
    return {'content': _decoded_preview_content(content), 'size': size, 'contentType': content_type, 'key': key}


@app.get("/data-explorer/s3/preview")
@tracer.capture_method
def preview_s3_file():
    """Preview a file from S3 bucket.

    For text/JSON files: returns the content directly.
    For binary files (images, PDFs): returns a presigned URL.
    """
    bucket_name, key = _keyed_bucket_request(app.current_event.query_string_parameters or {})

    try:
        preview = _object_preview(bucket_name, key)
    except s3_client.exceptions.NoSuchKey as e:
        # The get_object path. Kept beside the ClientError clause below rather
        # than folded into it, so the 404 does not rest on botocore's modelling.
        raise NotFoundError('File not found') from e
    except ClientError as e:
        # The head_object path — see S3_MISSING_KEY_CODES. Any other code falls
        # through to the generic 500.
        if e.response.get('Error', {}).get('Code') in S3_MISSING_KEY_CODES:
            raise NotFoundError('File not found') from e
        logger.exception("Failed to preview S3 file")
        raise ServiceError(FAILED_PREVIEW) from e
    except ApiError:
        raise
    except Exception as e:
        logger.exception("Failed to preview S3 file")
        raise ServiceError(FAILED_PREVIEW) from e
    return preview


def _put_object(bucket_name: str, key: str, content: str) -> None:
    """Write one object; under `raw/` only if no object exists at `key` yet.

    The check is S3's own conditional write (`IfNoneMatch='*'`), not a HEAD
    followed by a PUT, so two concurrent saves cannot both "create" the object.
    """
    write_once = _is_raw_key(key)
    request: PutObjectRequestTypeDef = {
        'Bucket': bucket_name,
        'Key': key,
        'Body': content.encode('utf-8'),
        'ContentType': 'application/json',
    }
    if write_once:
        request['IfNoneMatch'] = '*'
    try:
        s3_client.put_object(**request)
    except ClientError as e:
        code = e.response.get('Error', {}).get('Code')
        if write_once and code in _OBJECT_EXISTS_ERROR_CODES:
            raise ConflictError(
                'Raw data is immutable: an object already exists at this key under raw/'
            ) from e
        raise


def _raw_key_source(key: str) -> str | None:
    """The source a `raw/{source}/...` key archives for, or None outside that layout."""
    parts = key.split('/')
    return parts[1] if len(parts) > 2 and parts[0] == 'raw' and parts[1] else None


def _refuse_policy_blocked_archive(key: str) -> None:
    """A redact / summary-only source keeps no raw copy, so no raw object may be created for it."""
    source = _raw_key_source(key)
    # Strict: an unreadable policy is a 503 (retry), never "allow" by default.
    if source is not None and not raw_archive_allowed(cached_source_profile_strict(source)):
        raise ValidationError(f'Source "{source}" keeps no raw copies (its PII policy is not "allow")')


def _policy_queue_message(parsed: dict, bucket_name: str, key: str) -> dict | None:
    """The saved object as a processing-queue message, under its source's PII policy."""
    source = str(parsed.get('source_platform') or _raw_key_source(key) or '')
    profile = cached_source_profile_strict(source)
    message = apply_source_policy(parsed, profile)
    if message is not None and raw_archive_allowed(profile):
        message['s3_raw_uri'] = f"s3://{bucket_name}/{key}"
    return message


@app.put("/data-explorer/s3")
@tracer.capture_method
def save_s3_file():
    """Create a file in S3 (update only outside `raw/`, whose objects are write-once)."""
    body = json_object_body(app)
    bucket_id = body.get('bucket', 'raw-data')
    content = body.get('content', '')
    sync_to_dynamo = body.get('sync_to_dynamo', False)
    bucket_name, key = _keyed_bucket_request(body)
    _reject_prototype_mutation(key)

    # Ensure content is a string
    if isinstance(content, dict):
        content = json.dumps(content, indent=2)
    if not isinstance(content, str):
        raise ValidationError('content must be a string or a JSON object')
    _refuse_policy_blocked_archive(key)
    try:
        _put_object(bucket_name, key, content)
    except ApiError:
        raise
    except Exception as e:
        logger.exception("Failed to save S3 file")
        raise ServiceError(FAILED_SAVE) from e

    synced = False
    # Only sync to DynamoDB for raw-data bucket
    if sync_to_dynamo and PROCESSING_QUEUE_URL and bucket_id == 'raw-data':
        # Send to processing queue to process the new raw object
        try:
            message = _policy_queue_message(json.loads(content), bucket_name, key)
            if message is not None:
                sqs_client.send_message(
                    QueueUrl=PROCESSING_QUEUE_URL,
                    MessageBody=json.dumps(message)
                )
                synced = True
                logger.info("Sent new raw object to the processing queue")
        except (ClientError, BotoCoreError, ValueError, TypeError, AttributeError) as e:
            # The save itself succeeded; a non-JSON / non-object body or a queue
            # failure only means it is not re-processed now (synced=False).
            logger.warning(f"Failed to sync to DynamoDB: {e}")

    return {'success': True, 'message': 'File saved', 'key': key, 'synced': synced}


# ============================================
# DynamoDB Feedback (read + edit)
# ============================================

# Fields an admin may edit on a processed feedback record. `category` and
# `subcategory` are NOT plain fields: a change to either goes through
# `shared.feedback_category`, exactly like PUT /feedback/{id}/category.
UPDATABLE_FEEDBACK_FIELDS = (
    'original_text', 'normalized_text',
    'sentiment_label', 'sentiment_score', 'urgency', 'impact_area',
    'problem_summary', 'problem_root_cause_hypothesis', 'persona_name',
    'persona_type', 'journey_stage', 'rating',
)
CATEGORY_FIELDS = ('category', 'subcategory')


def _plain_field_update(data: dict) -> tuple[list[str], dict, dict]:
    """`(SET clauses, names, values)` for the plain editable fields present in `data`."""
    sets: list[str] = []
    names: dict[str, str] = {}
    values: dict[str, Any] = {}
    for name in UPDATABLE_FEEDBACK_FIELDS:
        if name in data:
            sets.append(f"#{name} = :{name}")
            names[f"#{name}"] = name
            value = data[name]
            # Convert floats to Decimal for DynamoDB
            values[f":{name}"] = Decimal(str(value)) if isinstance(value, float) else value
    return sets, names, values


def _feedback_key(table, feedback_id: str, source_platform: str) -> dict:
    """The record's primary key: from `source_platform` when given, else via the by-id GSI."""
    if source_platform:
        return {'pk': f"SOURCE#{source_platform}", 'sk': f"FEEDBACK#{feedback_id}"}
    response = table.query(
        IndexName=FEEDBACK_BY_ID_INDEX,
        KeyConditionExpression='feedback_id = :fid',
        ExpressionAttributeValues={':fid': feedback_id},
        Limit=1
    )
    items = response.get('Items') or []
    if not items:
        raise NotFoundError('Feedback not found')
    return {'pk': items[0]['pk'], 'sk': items[0]['sk']}


def _stored_item(table, key: dict) -> dict:
    """The record at `key`, strongly read, or 404."""
    item = table.get_item(Key=key, ConsistentRead=True).get('Item')
    if not item:
        raise NotFoundError('Feedback not found')
    return item


def _requested_category(item: dict, data: dict) -> tuple[str, str | None] | None:
    """`(category, subcategory)` when `data` changes the item's, else None.

    The editor sends the whole record, so an unchanged category is not a change
    (it must not stamp `category_source='manual'`). A new category without a
    subcategory drops the old one, which belonged to the old category.
    """
    if not any(name in data for name in CATEGORY_FIELDS):
        return None
    current = (item.get('category'), item.get('subcategory'))
    category = category_label(data.get('category', current[0]), 'category', required=True)
    if 'subcategory' in data:
        subcategory = category_label(data.get('subcategory'), 'subcategory', required=False)
    else:
        subcategory = current[1] if category == current[0] else None
    return None if (category, subcategory) == current else (category, subcategory)


def _category_change(item: dict, data: dict) -> CategoryChange | None:
    """The validated, audited category move `data` asks for (see `shared.feedback_category`)."""
    requested = _requested_category(item, data)
    if requested is None:
        return None
    category, subcategory = requested
    aggregates_table = get_aggregates_table()
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    validate_target(categories_config(aggregates_table), category, subcategory)
    caller = caller_from_event(app.current_event.raw_event)
    return category_change(item, category, subcategory, override_record(item, caller))


def _update_kwargs(key: dict, data: dict, change: CategoryChange | None) -> dict:
    """One conditional `update_item`: plain fields, the category move, `updated_at`.

    Always conditional on the item existing (an edit can never create one); a
    category move adds "still has the category that was read".
    """
    sets, names, values = _plain_field_update(data)
    if change is not None:
        sets = [*sets, *change.sets]
        names, values = {**names, **change.names}, {**values, **change.values}
    sets.append("#updated_at = :updated_at")
    names["#updated_at"] = "updated_at"
    values[":updated_at"] = datetime.now(UTC).isoformat()
    return {
        'Key': key,
        'UpdateExpression': update_expression(sets, change.removes if change is not None else []),
        'ConditionExpression': change.condition if change is not None else item_exists(),
        'ExpressionAttributeNames': names,
        'ExpressionAttributeValues': values,
    }


@app.put("/data-explorer/feedback")
@tracer.capture_method
def save_feedback():
    """Update a feedback record in DynamoDB, in place.

    The raw object the record was ingested from is never touched: raw data is
    immutable, so there is no write-back to S3 (the former `sync_to_s3` flag is
    ignored). A category change is validated, moves `gsi2pk` and is audited
    exactly as `PUT /feedback/{id}/category` does (409 on a concurrent change).
    """
    if not FEEDBACK_TABLE:
        raise ConfigurationError('Feedback table not configured')

    body = json_object_body(app)
    feedback_id = body.get('feedback_id', '')
    data = body.get('data', {})

    if not feedback_id:
        raise ValidationError('Feedback ID is required')
    if not isinstance(data, dict):
        raise ValidationError('data must be an object')
    if not any(name in data for name in (*UPDATABLE_FEEDBACK_FIELDS, *CATEGORY_FIELDS)):
        raise ValidationError('No fields to update')

    table = dynamodb.Table(FEEDBACK_TABLE)
    try:
        key = _feedback_key(table, feedback_id, data.get('source_platform', ''))
        change = _category_change(_stored_item(table, key), data)
    except ApiError:
        raise
    except Exception as e:
        logger.exception("Failed to read feedback")
        raise ServiceError('Failed to update feedback') from e
    if change is None and not any(name in data for name in UPDATABLE_FEEDBACK_FIELDS):
        return {'success': True, 'message': 'No changes'}

    # A failed existence-only condition means the item vanished (404); with a
    # category move it is the shared lost-update 409.
    missing = None if change is not None else NotFoundError('Feedback not found')
    apply_conditional_update(table, _update_kwargs(key, data, change), on_condition_failed=missing)
    return {'success': True, 'message': 'Feedback updated'}


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
        'dynamodb': {'table': FEEDBACK_TABLE, 'configured': bool(FEEDBACK_TABLE)}
    }

    # Add info for each configured bucket
    for bucket_id, config in AVAILABLE_BUCKETS.items():
        bucket_name = config.get('name', '')
        if bucket_name:
            bucket_info: dict[str, Any] = {
                'id': bucket_id,
                'name': bucket_name,
                'label': config.get('label', bucket_name),
            }
            try:
                response = s3_client.list_objects_v2(Bucket=bucket_name, Delimiter='/', MaxKeys=100)
                prefixes = (p.get('Prefix', '').rstrip('/') for p in response.get('CommonPrefixes', []))
                folders = [folder for folder in prefixes if folder]
                bucket_info['folders'] = folders
                bucket_info['folder_count'] = len(folders)
            except (ClientError, BotoCoreError):
                logger.exception(f"Failed to get stats for bucket {bucket_name}")
                # Returned inside a 200 body, so `str(e)` here leaked boto text
                # (bucket name, access-denied detail, request id) as surely as a
                # ServiceError message would (#263).
                bucket_info['error'] = FAILED_BUCKET_STATS
            stats['s3']['buckets'].append(bucket_info)

    return stats


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
