"""
Reprocess runs of the S3 import ingestor (issue #144, docs/data-lake-structure.md → Reprocessing a file).

`POST /s3-import/reprocess` (s3_import_handler.py) re-runs one imported file through
the `s3_import` ingestor. The run is recorded in the SAME place as every manual
source run: a `SOURCE_RUN#s3_import` / `<run id>` row of the aggregates table,
written `running` here before the invoke and moved to `completed` / `error` by the
ingestor (`BaseIngestor._update_source_run_status`). `GET /sources/status?run_status=s3_import`,
the assistant's `get_source_run` and plan waits read the same rows.

On either path (docs/multi-workspace.md): every function takes a keyword-only `scope` (None: the
deployment's `SOURCE_RUN#s3_import`, exactly the requests it always sent); in a workspace the run
partition is `WS#{ws}#SOURCE_RUN#s3_import` (shared/run_rows.py `source_run_partition`, the one the
ingestor's run in that workspace moves) and every read and write goes through shared/ws_repo.py
`ws_table` (shared/ingest_tables.py `table_view`). `start_run` takes the request's resolved membership
instead (`workspace`, a `WorkspaceContext`): the run's scope is its scope, and the ingestor's event
names the workspace through shared/workspace_routing.py `workspace_payload`, so the two cannot differ.

A row's `file_key` is the key as the caller named it (`<source>/<file>`, the same words in every
place); the ingestor's event names the object's key in the bucket (`ws/{ws}/<source>/<file>` in a
workspace).

The ingestor's input is the S3 trigger's own event shape (one `ObjectCreated` record)
plus the run id and `reprocess: True`; see `reprocess_event`.
"""

import re
import urllib.parse
from datetime import UTC, datetime, timedelta
from functools import partial
from types import SimpleNamespace
from typing import Any

from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError

from shared.aws import invoke_lambda_async
from shared.dynamo_paging import query_all
from shared.exceptions import ConflictError, ServiceError
from shared.ids import STAMP_FORMAT, timestamped_id
from shared.ingest_tables import table_view
from shared.logging import logger
from shared.run_rows import source_run_partition
from shared.scoped_query import SortRange, query_partition
from shared.timestamps import now_iso, parse_iso
from shared.workspace import WorkspaceContext
from shared.workspace_routing import workspace_payload
from shared.ws_repo import WorkspaceScope, optional_scope

SOURCE = 's3_import'
#: The deployment's run partition, `run_partition(None)`'s answer (spelled out: lib/stacks/api-s3-import-lambda.test.ts
#: reads it here to pin the role's `dynamodb:LeadingKeys`).
SOURCE_RUN_PK = 'SOURCE_RUN#s3_import'
RUN_ID_PREFIX = 'run_s3_import'
_RUN_ID = re.compile(r'run_s3_import_\d{14}_[0-9a-f]{8}')
START_FAILED = 'Failed to start reprocessing'
# The run row's `errors` when the ingestor was never invoked (a type-like name, as the ingestor writes).
INVOKE_FAILED = 'InvokeFailed'
ALREADY_RUNNING = 'This file is already being reprocessed'

# The s3_import ingestor's Lambda timeout: `infrastructure.ingestor.timeout` in
# plugins/s3_import/manifest.json (VocIngestionStack sets the function's timeout
# from it; test_s3_import_reprocess.py pins the two equal). A `running` row younger
# than this may still have a live invocation, so a second reprocess of the same file
# is refused (409). An older one is a run that timed out without closing its row.
INGESTOR_TIMEOUT_SECONDS = 300
# How far back (by run id, which starts with its creation time) the duplicate check
# looks. Wider than the timeout: Lambda's async retries (2, about 1 and 2 minutes
# after a failed attempt) re-run an older run id, and the ingestor then moves the
# row's `started_at` to the retry's start.
_DUPLICATE_LOOKBACK = timedelta(seconds=4 * INGESTOR_TIMEOUT_SECONDS)


def run_partition(scope: WorkspaceScope | None) -> str:
    """The reprocess runs' partition: `SOURCE_RUN_PK`, or `WS#{ws}#SOURCE_RUN#s3_import` in *scope* (both
    shared/run_rows.py `source_run_partition`'s: test_s3_import_workspace.py pins the deployment's equal)."""
    return SOURCE_RUN_PK if scope is None else source_run_partition(scope, SOURCE)


def is_run_id(value: str) -> bool:
    """Whether *value* has the shape `start_run` gives a run id."""
    return bool(_RUN_ID.fullmatch(value))


def reprocess_event(bucket: str, key: str, run_id: str, started_by: str = '') -> dict:
    """The ingestor's input: one S3 ObjectCreated record (the trigger's shape) plus the run id.

    `execution_id` is the key `POST /sources/{source}/run` passes every ingestor.
    `reprocess: True` is the one explicit addition: it lets the ingestor name a
    `processed/<source>/<file>` key's source `S3 - <source>`, as the original upload was.
    The key is URL-encoded the way S3 encodes it in a notification (a space as `+`, `/` kept).
    `started_by` is the starter's Cognito sub: the ingestor tells them when the run ends (docs/realtime.md).
    A workspace's run also names it (`start_run`, through `workspace_payload`), never here.
    """
    return {
        'execution_id': run_id,
        'reprocess': True,
        **({'started_by': started_by} if started_by else {}),
        'Records': [{
            'eventSource': 'aws:s3',
            'eventName': 'ObjectCreated:Put',
            's3': {'bucket': {'name': bucket}, 'object': {'key': urllib.parse.quote_plus(key, safe='/')}},
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


def _mark_not_started(table: Any, run_id: str, *, scope: WorkspaceScope | None = None) -> None:
    """Close a run whose ingestor could not be invoked. Never raises: the invoke error is the one to report."""
    try:
        table_view(scope, table).update_item(
            {'pk': run_partition(scope), 'sk': run_id},
            UpdateExpression='SET #s = :s, #c = :c, #e = :e',
            ExpressionAttributeNames={'#s': 'status', '#c': 'completed_at', '#e': 'errors'},
            ExpressionAttributeValues={':s': 'error', ':c': now_iso(), ':e': [INVOKE_FAILED]},
        )
    except ClientError as e:
        logger.warning(f"Failed to close the reprocess run: {e}")


def _recent_running_rows(table: Any, key: str, now: datetime, scope: WorkspaceScope | None) -> list[dict]:
    """Every `running` reprocess row of *key* in *scope*'s partition whose run id is within `_DUPLICATE_LOOKBACK`."""
    lower = f'{RUN_ID_PREFIX}_{(now - _DUPLICATE_LOOKBACK).strftime(STAMP_FORMAT)}'
    upper = f'{RUN_ID_PREFIX}_{"9" * len(now.strftime(STAMP_FORMAT))}~'
    # shared/scoped_query.py's one Query of the partition, bound for the pager: deployment-wide the key condition it
    # always was (`Key('pk').eq(…) & Key('sk').between(…)` on the table), in a workspace built by its `ws_table` view.
    pages = SimpleNamespace(query=partial(query_partition, scope, table, 'pk', run_partition(scope),
                                          sort=SortRange('sk', 'between', lower, upper)))
    return query_all(pages, {'FilterExpression': Attr('status').eq('running') & Attr('file_key').eq(key)})


def refuse_running_duplicate(table: Any, key: str, now: datetime | None = None, *,
                             scope: WorkspaceScope | None = None) -> None:
    """ConflictError when a run of *key* is `running` in *scope*'s partition and started within the ingestor's timeout.

    A finished run, or a `running` one older than `INGESTOR_TIMEOUT_SECONDS` (it timed
    out without closing its row), does not block. ServiceError when the runs cannot be read.
    Two requests in the same instant can both pass; a duplicate run is harmless (the
    processor skips rows already in the data lake), the check only bounds how many start.
    """
    moment = now or datetime.now(UTC)
    try:
        rows = _recent_running_rows(table, key, moment, scope)
    except ClientError as e:
        logger.exception(f"Failed to read the reprocess runs: {e}")
        raise ServiceError(START_FAILED) from e
    cutoff = moment - timedelta(seconds=INGESTOR_TIMEOUT_SECONDS)
    if any(_is_live_run_of(row, key, cutoff) for row in rows):
        raise ConflictError(ALREADY_RUNNING)


def _is_live_run_of(row: dict, key: str, cutoff: datetime) -> bool:
    """Whether *row* is a `running` run of *key* started after *cutoff*.

    Status and key are re-checked here as well as in the FilterExpression, so what
    blocks a start is exact and testable without DynamoDB.
    """
    if row.get('status') != 'running' or row.get('file_key') != key:
        return False
    started = parse_iso(row.get('started_at'))
    return started is not None and started > cutoff


def start_run(table: Any, function_name: str, bucket: str, key: str, started_by: str = '', *,
              file_key: str | None = None, workspace: WorkspaceContext | None = None) -> dict:
    """Write the `running` row, then async-invoke the ingestor for the object *key* of *bucket*. Returns the row.

    *file_key* is the key as the caller named it, the row's `file_key` and the duplicate check's (default *key*).
    *workspace* is the request's resolved membership (None: deployment-wide): the row is in its partition and the
    event names it (`workspace_payload`).
    ConflictError when *file_key* already has a live run there (`refuse_running_duplicate`).
    ServiceError when the row cannot be written or the invoke fails; on a failed
    invoke the row is closed as `error` first, so a poller never spins on it.
    """
    scope = optional_scope(workspace)
    named = key if file_key is None else file_key
    refuse_running_duplicate(table, named, scope=scope)
    run_id = timestamped_id(RUN_ID_PREFIX, datetime.now(UTC))
    item = {
        'pk': run_partition(scope), 'sk': run_id, 'status': 'running', 'items_found': 0,
        'started_at': now_iso(), 'file_key': named,
    }
    try:
        table_view(scope, table).put_item(item)
    except ClientError as e:
        logger.exception(f"Failed to record the reprocess run: {e}")
        raise ServiceError(START_FAILED) from e
    try:
        invoke_lambda_async(function_name, workspace_payload(reprocess_event(bucket, key, run_id, started_by),
                                                             workspace))
    except Exception as e:
        logger.exception("Failed to start the S3 import ingestor")
        _mark_not_started(table, run_id, scope=scope)
        raise ServiceError(START_FAILED) from e
    return item


def get_run(table: Any, run_id: str, *, scope: WorkspaceScope | None = None) -> dict | None:
    """The run row for *run_id* in *scope*'s partition, or None (an id of the wrong shape is never looked up;
    another place's run is in another partition, so it is None too)."""
    if not is_run_id(run_id):
        return None
    return table_view(scope, table).get_item({'pk': run_partition(scope), 'sk': run_id}).get('Item')
