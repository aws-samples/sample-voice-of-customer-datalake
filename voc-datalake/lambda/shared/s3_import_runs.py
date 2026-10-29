"""
Reprocess runs of the S3 import ingestor (issue #144, docs/s3-import.md).

`POST /s3-import/reprocess` (s3_import_handler.py) re-runs one imported file through
the `s3_import` ingestor. The run is recorded in the SAME place as every manual
source run: a `SOURCE_RUN#s3_import` / `<run id>` row of the aggregates table,
written `running` here before the invoke and moved to `completed` / `error` by the
ingestor (`BaseIngestor._update_source_run_status`). `GET /sources/status?run_status=s3_import`,
the assistant's `get_source_run` and plan waits read the same rows.

The ingestor's input is the S3 trigger's own event shape (one `ObjectCreated` record)
plus the run id and `reprocess: True`; see `reprocess_event`.
"""

import re
import urllib.parse
from datetime import UTC, datetime
from typing import Any

from botocore.exceptions import ClientError

from shared.aws import invoke_lambda_async
from shared.exceptions import ServiceError
from shared.ids import timestamped_id
from shared.logging import logger
from shared.timestamps import now_iso

SOURCE_RUN_PK = 'SOURCE_RUN#s3_import'
RUN_ID_PREFIX = 'run_s3_import'
_RUN_ID = re.compile(r'run_s3_import_\d{14}_[0-9a-f]{8}')
START_FAILED = 'Failed to start reprocessing'
# The run row's `errors` when the ingestor was never invoked (a type-like name, as the ingestor writes).
INVOKE_FAILED = 'InvokeFailed'


def is_run_id(value: str) -> bool:
    """Whether *value* has the shape `start_run` gives a run id."""
    return bool(_RUN_ID.fullmatch(value))


def reprocess_event(bucket: str, key: str, run_id: str) -> dict:
    """The ingestor's input: one S3 ObjectCreated record (the trigger's shape) plus the run id.

    `execution_id` is the key `POST /sources/{source}/run` passes every ingestor.
    `reprocess: True` is the one explicit addition: it lets the ingestor name a
    `processed/<source>/<file>` key's source `S3 - <source>`, as the original upload was.
    The key is URL-encoded the way S3 encodes it in a notification.
    """
    return {
        'execution_id': run_id,
        'reprocess': True,
        'Records': [{
            'eventSource': 'aws:s3',
            'eventName': 'ObjectCreated:Put',
            's3': {'bucket': {'name': bucket}, 'object': {'key': urllib.parse.quote_plus(key)}},
        }],
    }


def run_view(item: dict) -> dict:
    """A `SOURCE_RUN#s3_import` row as the reprocess routes answer it."""
    return {
        'run_id': item.get('sk'),
        'key': item.get('file_key'),
        'status': item.get('status', 'unknown'),
        'items_found': int(item.get('items_found') or 0),
        'started_at': item.get('started_at'),
        'completed_at': item.get('completed_at'),
        'errors': list(item.get('errors') or []),
    }


def _mark_not_started(table: Any, run_id: str) -> None:
    """Close a run whose ingestor could not be invoked. Never raises: the invoke error is the one to report."""
    try:
        table.update_item(
            Key={'pk': SOURCE_RUN_PK, 'sk': run_id},
            UpdateExpression='SET #s = :s, #c = :c, #e = :e',
            ExpressionAttributeNames={'#s': 'status', '#c': 'completed_at', '#e': 'errors'},
            ExpressionAttributeValues={':s': 'error', ':c': now_iso(), ':e': [INVOKE_FAILED]},
        )
    except ClientError as e:
        logger.warning(f"Failed to close the reprocess run: {e}")


def start_run(table: Any, function_name: str, bucket: str, key: str) -> dict:
    """Write the `running` row, then async-invoke the ingestor for *key*. Returns the row.

    ServiceError when the row cannot be written or the invoke fails; on a failed
    invoke the row is closed as `error` first, so a poller never spins on it.
    """
    run_id = timestamped_id(RUN_ID_PREFIX, datetime.now(UTC))
    item = {
        'pk': SOURCE_RUN_PK, 'sk': run_id, 'status': 'running', 'items_found': 0,
        'started_at': now_iso(), 'file_key': key,
    }
    try:
        table.put_item(Item=item)
    except ClientError as e:
        logger.exception(f"Failed to record the reprocess run: {e}")
        raise ServiceError(START_FAILED) from e
    try:
        invoke_lambda_async(function_name, reprocess_event(bucket, key, run_id))
    except Exception as e:
        logger.exception("Failed to start the S3 import ingestor")
        _mark_not_started(table, run_id)
        raise ServiceError(START_FAILED) from e
    return item


def get_run(table: Any, run_id: str) -> dict | None:
    """The run row for *run_id*, or None (an id of the wrong shape is never looked up)."""
    if not is_run_id(run_id):
        return None
    return table.get_item(Key={'pk': SOURCE_RUN_PK, 'sk': run_id}).get('Item')
