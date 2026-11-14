"""Fixtures for the workspace delete job: every table it reaches in moto (voc-feedback with ``gsi1-by-date``,
voc-aggregates with ``gsi1-by-metric-type``, voc-memory with ``gsi1-by-memory-status``, voc-watermarks, voc-workspaces),
a versioned bucket, SSM, and two workspaces seeded with a row of every family beside the deployment's own rows.

The fictional workspaces: Acme Outfitters (``acme``, the one deleted) and Birch Bakery (``birch``, which must not
change)."""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, Final
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto import mock_aws

from jobs.test.lambda_budget import LambdaBudget
from jobs.workspace_delete import handler
from shared.indexes import FEEDBACK_BY_DATE_INDEX, MEMORY_BY_STATUS_INDEX
from shared.test.moto_tables import (
    create_aggregates_table_with_metric_index,
    create_pk_sk_table,
    create_table_with_gsi1,
)

WS: Final = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER: Final = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
BUCKET: Final = 'test-raw-data-bucket'
PREFIX: Final = '/voc/ws'
MEMORY_TABLE: Final = 'test-memory'
WATERMARKS_TABLE: Final = 'test-watermarks'
WORKSPACES_TABLE: Final = 'test-workspaces'
RADAR_TABLE: Final = 'test-radar'
PLUGINS: Final = ('webscraper', 'app_reviews_ios')
#: A third workspace, for deletes requested together.
THIRD: Final = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DB'
NAMES: Final = {WS: ('Acme Outfitters', 'acme'), OTHER: ('Birch Bakery', 'birch'), THIRD: ('Cedar Cycles', 'cedar')}
FEEDBACK_PER_DAY: Final = 4
DAYS: Final = 3
#: Per workspace: the dated items, one with no date (in no index partition), and one under a brand's partition.
FEEDBACK_ITEMS: Final = FEEDBACK_PER_DAY * DAYS + 2
COMPANY_MEMORIES: Final = ('mem_c1', 'mem_c2')
PERSONAL_MEMORIES: Final = (('sub-ada', 'mem_p1', 'active'), ('sub-vic', 'mem_p2', 'archived'))
EVENTS_PER_MEMORY: Final = 2


@dataclass
class World:
    feedback: Any
    aggregates: Any
    memory: Any
    watermarks: Any
    workspaces: Any
    s3: Any
    ssm: Any
    invoke: MagicMock
    radar: Any = None


def _watermarks_table(resource: Any) -> Any:
    """voc-watermarks as core-stack.ts keys it: ``source`` alone."""
    return resource.create_table(
        TableName=WATERMARKS_TABLE, BillingMode='PAY_PER_REQUEST',
        KeySchema=[{'AttributeName': 'source', 'KeyType': 'HASH'}],
        AttributeDefinitions=[{'AttributeName': 'source', 'AttributeType': 'S'}])


@pytest.fixture
def world() -> Iterator[World]:
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        workspaces = create_pk_sk_table(WORKSPACES_TABLE, resource)
        aggregates = create_aggregates_table_with_metric_index(handler.AGGREGATES_TABLE, resource)
        watermarks = _watermarks_table(resource)
        radar = create_pk_sk_table(RADAR_TABLE, resource)
        memory = create_table_with_gsi1(resource, MEMORY_TABLE, MEMORY_BY_STATUS_INDEX)
        feedback = create_table_with_gsi1(resource, handler.FEEDBACK_TABLE, FEEDBACK_BY_DATE_INDEX)
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        s3.put_bucket_versioning(Bucket=BUCKET, VersioningConfiguration={'Status': 'Enabled'})
        ssm = boto3.client('ssm', region_name='us-east-1')
        invoke = MagicMock()
        with patch.object(handler, 'get_dynamodb_resource', return_value=resource), \
                patch.object(handler, 'get_s3_client', return_value=s3), \
                patch.object(handler, 'get_workspaces_table', return_value=workspaces), \
                patch.object(handler, 'get_ssm_run_client', return_value=ssm), \
                patch.object(handler, 'invoke_lambda_async', invoke), \
                patch.object(handler, 'MEMORY_TABLE', MEMORY_TABLE), \
                patch.object(handler, 'WATERMARKS_TABLE', WATERMARKS_TABLE), \
                patch.object(handler, 'RADAR_TABLE', RADAR_TABLE), \
                patch.object(handler, 'RAW_DATA_BUCKET', BUCKET), \
                patch.object(handler, 'PARAMETER_PREFIX', PREFIX), \
                patch.dict('os.environ', {'PLUGIN_IDS': json.dumps(list(PLUGINS)), 'WORKSPACE_HARD_DELETE': 'true'}):
            yield World(feedback, aggregates, memory, watermarks, workspaces, s3, ssm, invoke, radar)


class Budget(LambdaBudget):
    """The delete's Lambda context (jobs/test/lambda_budget.py)."""

    function_name = 'voc-workspace-delete'


def now() -> datetime:
    return datetime.now(UTC)


def day(offset: int) -> str:
    return (now().date() - timedelta(days=offset)).isoformat()


def feedback_item(ws: str, n: int, on: str | None, source: str = 'webscraper', partition: str | None = None) -> dict:
    item: dict[str, Any] = {
        'pk': f'WS#{ws}#SOURCE#{partition or source}', 'sk': f'FEEDBACK#fb-{n}', 'feedback_id': f'fb-{n}',
        'source_platform': source, 'category': 'delivery' if n % 2 else 'pricing', 'sentiment_label': 'negative',
        'sentiment_score': Decimal('-0.5'), 'tags': ['parcel'], 'urgency': 'high' if n % 3 == 0 else 'low',
        'original_text': f'Review {n}: the parcel arrived late ({ws[-4:]}).'}
    if on is not None:
        item.update(date=on, gsi1pk=f'WS#{ws}#DATE#{on}', gsi1sk=f'{on}#fb-{n}')
    return item


def _counter_rows(ws: str, item: dict) -> list[dict]:
    """The rows the aggregator wrote for ``item`` (its own key function), on the item's day."""
    from aggregator import handler as aggregator
    from shared.metric_keys import metric_partition, metric_type_partition
    from shared.ws_repo import WorkspaceScope

    scope = WorkspaceScope(ws)
    rows = []
    for pk, _field in aggregator.counter_dimensions(item):
        row: dict[str, Any] = {'pk': metric_partition(scope, pk), 'sk': item.get('date') or day(0), 'count': 1}
        if (kind := aggregator.get_metric_type(pk)) is not None:
            row['metric_type'] = metric_type_partition(scope, kind)
        rows.append(row)
    return rows


def memory_item(ws: str, owner: str | None, memory_id: str, status: str = 'active') -> dict:
    scope = 'company' if owner is None else 'personal'
    return {'pk': f'WS#{ws}#MEM#company' if owner is None else f'WS#{ws}#MEM#user#{owner}', 'sk': f'MEM#{memory_id}',
            'memory_id': memory_id, 'scope': scope, 'status': status, 'statement': f'Parcels matter ({memory_id}).',
            'gsi1pk': f'WS#{ws}#MEMSTATUS#{scope}#{status}', 'gsi1sk': f'2026-11-01T00:00:00#{memory_id}'}


def _seed_feedback(world: World, ws: str) -> list[dict]:
    """The workspace's feedback items, and the counter rows the aggregator wrote for them."""
    items = [feedback_item(ws, n, day(n // FEEDBACK_PER_DAY), source='webscraper' if n % 2 else 'feedback_form',
                           partition='webscraper' if n % 2 else 'acme-store') for n in range(FEEDBACK_PER_DAY * DAYS)]
    n = FEEDBACK_PER_DAY * DAYS
    items.append(feedback_item(ws, n, None))  # no date: in no day partition, found through its plugin's partition
    items.append(feedback_item(ws, n + 1, day(0), source='app_reviews_ios', partition='acme-app'))
    counters: dict[tuple[str, str], dict] = {}
    for item in items:
        world.feedback.put_item(Item=item)
        for row in _counter_rows(ws, item):
            counters.setdefault((row['pk'], row['sk']), row)
    return list(counters.values())


def _seed_memory(world: World, ws: str) -> None:
    p = f'WS#{ws}#'
    for memory_id in COMPANY_MEMORIES:
        world.memory.put_item(Item=memory_item(ws, None, memory_id))
    for owner, memory_id, memory_status in PERSONAL_MEMORIES:
        world.memory.put_item(Item=memory_item(ws, owner, memory_id, memory_status))
    for memory_id in (*COMPANY_MEMORIES, *(memory_id for _owner, memory_id, _status in PERSONAL_MEMORIES)):
        for event in range(EVENTS_PER_MEMORY):
            world.memory.put_item(Item={'pk': f'{p}MEMEVT#{memory_id}', 'sk': f'2026-11-0{event + 1}#{event}',
                                        'action': 'created'})
    world.memory.put_item(Item={'pk': f'{p}MEMCURSOR', 'sk': 'SESSION#s1', 'last_turn': 4})
    world.memory.put_item(Item={'pk': f'{p}MEMIMPORT', 'sk': 'imp_1', 'status': 'done'})


def _seed_objects_and_credentials(world: World, ws: str) -> None:
    for key in (f'ws/{ws}/raw/webscraper/2026/11/01/a/0123456789abcdef.json', f'ws/{ws}/silver/webscraper/fb-1/v1.json',
                f'ws/{ws}/exports/ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8/workspace-export.zip',
                f'ws/{ws}/memory-imports/imp_1.txt'):
        world.s3.put_object(Bucket=BUCKET, Key=key, Body=b'one')
        world.s3.put_object(Bucket=BUCKET, Key=key, Body=b'two')
    world.s3.delete_object(Bucket=BUCKET, Key=f'ws/{ws}/silver/webscraper/fb-1/v1.json')  # a delete marker
    world.s3.create_multipart_upload(Bucket=BUCKET, Key=f'ws/{ws}/exports/ex_2/workspace-export.zip')
    world.s3.create_multipart_upload(Bucket=BUCKET, Key=f'ws/{ws}/raw/s3_import/big.csv')
    for plugin in PLUGINS:
        world.ssm.put_parameter(Name=f'{PREFIX}/{ws}/credentials/{plugin}', Value='{"api_key": "k-secret"}',
                                Type='SecureString')


def seed_workspace(world: World, ws: str, *, status: str) -> None:
    """One workspace with a row of every family the delete sweeps (and the rows it keeps)."""
    name, slug = NAMES[ws]
    p = f'WS#{ws}#'
    aggregates = [
        *_seed_feedback(world, ws),
        {'pk': f'{p}METRIC#meta', 'sk': 'earliest_date', 'date': day(DAYS - 1)},
        {'pk': f'{p}METRIC#meta', 'sk': 'data_version', 'v': 3},
        # A source counter no stored item names any more: found through the metric-type index.
        {'pk': f'{p}METRIC#daily_source#retired_source', 'sk': day(9), 'count': 2, 'metric_type': f'{p}source'},
        {'pk': f'{p}SOURCE_RUN#webscraper', 'sk': '2026-11-01T00:00:00', 'status': 'completed'},
        {'pk': f'{p}SOURCE_RUN#app_reviews_ios', 'sk': '2026-11-01T00:00:00', 'status': 'completed'},
        {'pk': f'{p}SCRAPER_RUN#s1', 'sk': '2026-11-01T00:00:00', 'status': 'running'},
        {'pk': f'{p}SCRAPER_RUN#s0', 'sk': '2026-10-01T00:00:00', 'status': 'completed'},
        {'pk': f'{p}FAILURES#webscraper', 'sk': '2026-11-01T00:00:00', 'ttl': 1},
        {'pk': f'{p}CIRCUIT#webscraper', 'sk': 'TRIPPED', 'at': '2026-11-01T00:00:00'},
        {'pk': f'{p}LOGS#validation#webscraper', 'sk': '2026-11-01T00:00:00#m1', 'ttl': 1},
        {'pk': f'{p}LOGS#processing#feedback_form', 'sk': '2026-11-01T00:00:00#m2', 'ttl': 1},
        {'pk': f'{p}PLUGIN_CONFIG', 'sk': 'webscraper', 'configs': '[{"id": "s1", "url": "https://example.com"}]'},
        {'pk': f'{p}PLUGIN_CONFIG#HISTORY', 'sk': 'webscraper#2026-10-01T00:00:00#a1', 'configs': '[{"id": "s0"}]'},
        {'pk': f'{p}FEEDBACK_FORM', 'sk': 'FORM#ff_1', 'form_id': 'ff_1', 'name': 'Checkout survey'},
        {'pk': f'{p}IMPORT_RUN', 'sk': '2026-11-01T10:00:00+00:00#run1', 'run_id': 'run1'},
        {'pk': f'{p}IMPORT_RUN#run1', 'sk': 'RUN', 'run_id': 'run1', 'errors': ['row 3: empty']},
        {'pk': f'{p}JOB#erasure', 'sk': 'er_0123456789ab', 'status': 'completed', 'value_hash': 'f' * 64},
        {'pk': f'{p}JOB#erasure', 'sk': 'LOCK', 'job_id': f'delete-{ws}', 'locked_at': now().isoformat()},
        {'pk': f'{p}JOB#export', 'sk': 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', 'export_id': 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8',
         'status': 'completed'},
        {'pk': f'{p}JOB#export', 'sk': 'LOCK', 'job_id': f'delete-{ws}', 'locked_at': now().isoformat()},
        {'pk': f'{p}WATERMARK_KEYS', 'sk': 'webscraper#last_id'},
        {'pk': f'{p}WATERMARK_KEYS', 'sk': 'app_reviews_ios#cursor'},
    ]
    for item in aggregates:
        world.aggregates.put_item(Item=item)
    for watermark in ('webscraper#last_id', 'app_reviews_ios#cursor'):
        world.watermarks.put_item(Item={'source': f'{p}{watermark}', 'value': '42'})
    _seed_memory(world, ws)
    _seed_objects_and_credentials(world, ws)
    for row in (
        {'pk': f'WS#{ws}', 'sk': 'META', 'name': name, 'slug': slug, 'status': status,
         **({'deleting_at': now().isoformat()} if status == 'deleting' else {})},
        {'pk': f'WS#{ws}', 'sk': 'MEMBER#sub-ada', 'role': 'admin', 'email': 'ada@example.com'},
        {'pk': f'WS#{ws}', 'sk': 'MEMBER#sub-vic', 'role': 'viewer'},
        {'pk': f'WS#{ws}', 'sk': 'INVITE#inv1', 'email': 'new@example.com', 'ttl': 1},
        {'pk': 'USER#sub-ada', 'sk': f'WS#{ws}', 'name': name, 'slug': slug, 'role': 'admin'},
        {'pk': 'USER#sub-vic', 'sk': f'WS#{ws}', 'name': name, 'slug': slug, 'role': 'viewer'},
        {'pk': 'FORM#ff_1' if ws == WS else 'FORM#ff_2', 'sk': 'META', 'workspace_id': ws},
        {'pk': 'PLUGIN#webscraper', 'sk': f'WS#{ws}'},
        {'pk': 'WORKSPACES', 'sk': f'{name.casefold()}#{ws}', 'workspace_id': ws, 'name': name, 'slug': slug,
         'status': status},
        {'pk': f'SLUG#{slug}', 'sk': 'META', 'workspace_id': ws, 'created_at': '2026-01-01T00:00:00+00:00'},
        {'pk': f'AUDIT#WS#{ws}', 'sk': '2026-01-01T00:00:00#aa', 'kind': 'workspace_created', 'actor': 'sub-ada'},
    ):
        world.workspaces.put_item(Item=row)


def seed_deployment(world: World) -> None:
    """The deployment's own rows beside the workspaces: none of them may change."""
    on = day(0)
    world.feedback.put_item(Item={'pk': 'SOURCE#webscraper', 'sk': 'FEEDBACK#fb-1', 'feedback_id': 'fb-1',
                                  'gsi1pk': f'DATE#{on}', 'gsi1sk': f'{on}#fb-1', 'date': on,
                                  'source_platform': 'webscraper'})
    for item in ({'pk': 'METRIC#daily_total', 'sk': on, 'count': 1},
                 {'pk': 'AUDIT#tombstone#webscraper', 'sk': 'fb-9', 'mode': 'erase'},
                 {'pk': 'AUDIT#platform-admins', 'sk': '2026-01-01#x', 'kind': 'granted'},
                 {'pk': 'PLUGIN_CONFIG', 'sk': 'webscraper', 'configs': '[]'}):
        world.aggregates.put_item(Item=item)
    world.watermarks.put_item(Item={'source': 'webscraper#last_id', 'value': '7'})
    world.memory.put_item(Item={'pk': 'MEM#company', 'sk': 'MEM#mem_d', 'memory_id': 'mem_d'})
    world.s3.put_object(Bucket=BUCKET, Key='raw/webscraper/2026/11/01/a/0123456789abcdef.json', Body=b'd')
    world.workspaces.put_item(Item={'pk': 'USER#sub-ada', 'sk': 'PROFILE', 'name': 'Ada'})


def request_job(world: World, ws: str = WS, *, fence_in: timedelta = -timedelta(minutes=1), **fields: Any) -> dict:
    """The job row the route writes (shared/workspace_deletes.py ``request_delete``), its fence ``fence_in`` from
    now (past by default, so the job may begin), and the event the route invokes with."""
    name, slug = NAMES[ws]
    at = now() - timedelta(minutes=21) + fence_in
    row = {'pk': 'WSDELETE', 'sk': ws, 'workspace_id': ws, 'status': 'waiting', 'phase': 'fence',
           'requested_at': now().isoformat(), 'deleting_at': at.isoformat(),
           'fence_at': (now() + fence_in).isoformat(), 'requested_by_sub': 'sub-ada', 'platform_admin': False,
           'legal_basis': 'Customer contract ended (ticket 4512)', 'name': name, 'slug': slug,
           'listing_sk': f'{name.casefold()}#{ws}', 'counts': {}, 'resumes': 0, **fields}
    world.workspaces.put_item(Item=row)
    return {'workspace_id': ws}


def run_to_the_end(world: World, event: dict, *, budget: int | None = None, limit: int = 50) -> list[dict]:
    """Invoke the job, then every hand-over it invokes, until it stops; every outcome, in order."""
    outcomes = []
    for _ in range(limit):
        world.invoke.reset_mock()
        outcomes.append(handler.handle_event(event, Budget(budget)))
        if not world.invoke.called:
            return outcomes
        event = world.invoke.call_args.args[1]
    raise AssertionError('the job did not stop')


def snapshot(world: World) -> dict[str, list]:
    """Every row of every table, every object version and every parameter name, sorted."""
    def rows(table: Any) -> list:
        scanned, kwargs = [], {}
        while True:
            page = table.scan(**kwargs)
            scanned.extend(page['Items'])
            if 'LastEvaluatedKey' not in page:
                return sorted(scanned, key=lambda item: json.dumps(item, sort_keys=True, default=str))
            kwargs['ExclusiveStartKey'] = page['LastEvaluatedKey']
    listed = world.s3.list_object_versions(Bucket=BUCKET)
    uploads = world.s3.list_multipart_uploads(Bucket=BUCKET).get('Uploads') or []
    return {
        'feedback': rows(world.feedback), 'aggregates': rows(world.aggregates), 'memory': rows(world.memory),
        'watermarks': rows(world.watermarks), 'workspaces': rows(world.workspaces), 'radar': rows(world.radar),
        'objects': sorted((entry['Key'], entry['VersionId']) for part in ('Versions', 'DeleteMarkers')
                          for entry in listed.get(part) or []),
        'uploads': sorted(upload['Key'] for upload in uploads),
        'parameters': sorted(parameter['Name'] for page in world.ssm.get_paginator('describe_parameters').paginate()
                             for parameter in page['Parameters']),
    }
