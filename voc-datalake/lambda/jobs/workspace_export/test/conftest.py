"""Fixtures for the workspace export job: moto voc-feedback (with ``gsi1-by-date``), voc-aggregates, voc-workspaces,
voc-memory (with ``gsi1-by-memory-status``) and voc-conversations, an in-memory S3 for the export objects, and one workspace seeded with
a little of everything."""
from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal
from functools import partial
from typing import Any, Final
from unittest.mock import MagicMock, patch

import boto3
import pytest
from boto3.dynamodb.types import Binary
from moto import mock_aws
from suite_clock import suite_midday

from jobs.workspace_export import handler
from jobs.workspace_export.zip_stream import PartSink
from shared.indexes import FEEDBACK_BY_DATE_INDEX, MEMORY_BY_STATUS_INDEX
from shared.test.export_s3_double import ExportS3
from shared.test.moto_tables import create_pk_sk_table

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
EXPORT_ID = 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
BUCKET = 'test-raw-data-bucket'
WORKSPACES_TABLE = 'test-workspaces'
MEMORY_TABLE = 'test-memory'
CONVERSATIONS_TABLE = 'test-conversations'
#: The suite clock's noon (conftest.py at the root): this conftest may load before the clock travels (a run naming
#: this folder loads it first), and the claim's freshness compares the row's created_at with the handler's clock.
CREATED = suite_midday()
#: Small parts, so a small export still spans several (S3's rules are the same at any size).
SMALL_PART, SMALL_MIN = 2048, 512
FEEDBACK_DAYS = 3
FEEDBACK_PER_DAY = 10


def day(offset: int) -> str:
    return (CREATED.date() - timedelta(days=offset)).isoformat()


def feedback_item(ws: str, n: int, on: str) -> dict[str, Any]:
    return {'pk': f'WS#{ws}#SOURCE#web', 'sk': f'FEEDBACK#fb-{n}', 'gsi1pk': f'WS#{ws}#DATE#{on}',
            'gsi1sk': f'{on}#fb-{n}', 'feedback_id': f'fb-{n}', 'date': on, 'source_platform': 'web',
            'original_text': f'Review {n}: the checkout page loads slowly on a phone ({ws[-4:]}).',
            'sentiment_score': Decimal('0.25'), 'tags': {'checkout', 'mobile'}, 'workspace_marker': ws}


@dataclass
class World:
    feedback: Any
    aggregates: Any
    workspaces: Any
    s3: ExportS3
    invoke: MagicMock
    notify: MagicMock
    memory: Any
    conversations: Any


def _table_with_gsi1(resource: Any, name: str, index: str) -> Any:
    """A pk/sk table with one full-projection index on gsi1pk/gsi1sk (voc-feedback's by date, voc-memory's by
    status, shared/indexes.py)."""
    return resource.create_table(
        TableName=name, BillingMode='PAY_PER_REQUEST',
        KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        AttributeDefinitions=[{'AttributeName': attribute, 'AttributeType': 'S'}
                              for attribute in ('pk', 'sk', 'gsi1pk', 'gsi1sk')],
        GlobalSecondaryIndexes=[{
            'IndexName': index, 'Projection': {'ProjectionType': 'ALL'},
            'KeySchema': [{'AttributeName': 'gsi1pk', 'KeyType': 'HASH'},
                          {'AttributeName': 'gsi1sk', 'KeyType': 'RANGE'}]}])


def memory_item(ws: str, owner: str | None, memory_id: str, status: str = 'active') -> dict[str, Any]:
    """A memory as shared/memory_store.py writes it in a workspace: company (``owner`` None) or one member's."""
    scope = 'company' if owner is None else 'personal'
    pk = f'WS#{ws}#MEM#company' if owner is None else f'WS#{ws}#MEM#user#{owner}'
    return {'pk': pk, 'sk': f'MEM#{memory_id}', 'memory_id': memory_id, 'scope': scope, 'status': status,
            'kind': 'product', 'statement': f'The checkout page matters ({memory_id}).',
            'gsi1pk': f'WS#{ws}#MEMSTATUS#{scope}#{status}', 'gsi1sk': f'2026-11-0{len(memory_id) % 9 + 1}T00:00:00',
            'embedding': Binary(b'\x00\x00\x80?' * 4), 'supporters': 2, 'supporter_set': {'h' * 64, 'g' * 64},
            # Mined from one member's chat, and reinforced by an import (lambda/memory/extractor).
            'sources': [{'type': 'session', 'ref': f'sess-of-ada-{memory_id}', 'at': '2026-11-01T00:00:00',
                         'turn': 'what ada said'},
                        {'type': 'import', 'ref': 'imp_1', 'at': '2026-11-02T00:00:00'}]}


#: The seeded memories: three company ones, two of one member's, one of another's (archived), each with events.
COMPANY_MEMORIES: Final = ('mem_c1', 'mem_c2', 'mem_c3')
PERSONAL_MEMORIES: Final = (('sub-ada', 'mem_p1', 'active'), ('sub-ada', 'mem_p2', 'proposed'),
                            ('sub-vic', 'mem_p3', 'archived'))
EVENTS_PER_MEMORY: Final = 3


def seed_memory(world: World) -> None:
    for memory_id in COMPANY_MEMORIES:
        world.memory.put_item(Item=memory_item(WS, None, memory_id))
    for owner, memory_id, status in PERSONAL_MEMORIES:
        world.memory.put_item(Item=memory_item(WS, owner, memory_id, status))
    for memory_id in (*COMPANY_MEMORIES, *(memory_id for _owner, memory_id, _status in PERSONAL_MEMORIES)):
        for n in range(EVENTS_PER_MEMORY):
            world.memory.put_item(Item={'pk': f'WS#{WS}#MEMEVT#{memory_id}', 'sk': f'2026-11-0{n + 1}T00:00:00#{n}',
                                        'action': 'created' if n == 0 else 'reinforced', 'actor': 'h' * 64})
    for session in ('s1', 's2'):
        world.memory.put_item(Item={'pk': f'WS#{WS}#MEMCURSOR', 'sk': f'SESSION#{session}', 'last_turn': 4})
    world.memory.put_item(Item={'pk': f'WS#{WS}#MEMIMPORT', 'sk': 'imp_1', 'import_id': 'imp_1', 'status': 'done',
                                'title': 'Release notes', 'created_by_hash': 'h' * 64, 'created_by_username': 'ada'})
    # Another workspace's memory, beside it: never read into this export.
    world.memory.put_item(Item=memory_item(OTHER, None, 'mem_other'))
    world.memory.put_item(Item=memory_item(OTHER, 'sub-ada', 'mem_other_p'))
    world.memory.put_item(Item={'pk': f'WS#{OTHER}#MEMEVT#mem_other', 'sk': '2026-11-01T00:00:00#0', 'event': 'x'})


def seed(world: World, daily_total: int = FEEDBACK_DAYS * FEEDBACK_PER_DAY) -> None:
    """One workspace with feedback over three days, its counters, a plugin config, a form, an import run, an
    erasure job and its lock, its META, two members and audit rows; another workspace's feedback beside it."""
    n = 0
    for offset in range(FEEDBACK_DAYS):
        for _ in range(FEEDBACK_PER_DAY):
            world.feedback.put_item(Item=feedback_item(WS, n, day(offset)))
            n += 1
    for other in range(5):
        world.feedback.put_item(Item=feedback_item(OTHER, 100 + other, day(0)))
    prefix = f'WS#{WS}#'
    aggregates = [
        {'pk': f'{prefix}METRIC#meta', 'sk': 'earliest_date', 'date': day(FEEDBACK_DAYS - 1)},
        {'pk': f'{prefix}METRIC#daily_total', 'sk': day(0), 'count': Decimal(daily_total - 10)},
        {'pk': f'{prefix}METRIC#daily_total', 'sk': day(1), 'count': Decimal(10)},
        {'pk': f'{prefix}PLUGIN_CONFIG', 'sk': 'webscraper', 'configs': '[{"id": "s1", "url": "https://example.com"}]'},
        {'pk': f'{prefix}FEEDBACK_FORM', 'sk': 'FORM#ff_1', 'form_id': 'ff_1', 'name': 'Checkout survey'},
        {'pk': f'{prefix}IMPORT_RUN', 'sk': '2026-11-01T10:00:00+00:00#run1', 'run_id': 'run1', 'method': 'csv'},
        {'pk': f'{prefix}IMPORT_RUN#run1', 'sk': 'RUN', 'run_id': 'run1', 'method': 'csv', 'errors': ['row 3: empty']},
        {'pk': f'{prefix}IMPORT_RUN', 'sk': '2026-11-02T10:00:00+00:00#run2', 'run_id': 'run2', 'method': 'paste'},
        {'pk': f'{prefix}JOB#erasure', 'sk': 'er_0123456789ab', 'field': 'author', 'value_hash': 'f' * 64,
         'status': 'completed'},
        {'pk': f'{prefix}JOB#erasure', 'sk': 'LOCK', 'job_id': 'er_0123456789ab', 'locked_at': '2026-11-01T00:00:00'},
        {'pk': f'WS#{OTHER}#PLUGIN_CONFIG', 'sk': 'webscraper', 'configs': '[]'},
        {'pk': f'{prefix}PLUGIN_CONFIG#HISTORY', 'sk': 'webscraper#2026-11-01T08:00:00+00:00#a1', 'configs': '[]',
         'updated_at': '2026-11-01T07:00:00+00:00', 'updated_by': 'sub-ada',
         'superseded_at': '2026-11-01T08:00:00+00:00', 'superseded_by_sub': 'sub-ada'},
        {'pk': f'WS#{OTHER}#PLUGIN_CONFIG#HISTORY', 'sk': 'webscraper#2026-11-01T08:00:00+00:00#b2',
         'configs': '["other"]', 'superseded_at': '2026-11-01T08:00:00+00:00', 'superseded_by_sub': 'sub-other'},
    ]
    for item in aggregates:
        world.aggregates.put_item(Item=item)
    for item in (
        {'pk': f'WS#{WS}', 'sk': 'META', 'name': 'Acme Outfitters', 'slug': 'acme', 'status': 'active'},
        {'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-ada', 'role': 'admin', 'email': 'ada@example.com'},
        {'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-vic', 'role': 'viewer'},
        {'pk': f'AUDIT#WS#{WS}', 'sk': '2026-11-01T09:00:00#aa', 'kind': 'workspace_created', 'actor': 'sub-ada'},
        {'pk': f'AUDIT#WS#{WS}', 'sk': '2026-11-02T09:00:00#bb', 'kind': 'member_added', 'actor': 'sub-ada'},
        {'pk': 'USER#sub-ada', 'sk': f'WS#{WS}', 'role': 'admin'},
        {'pk': f'WS#{OTHER}', 'sk': 'META', 'name': 'Other', 'slug': 'other', 'status': 'active'},
    ):
        world.workspaces.put_item(Item=item)
    queue(world)


def queue(world: World, export_id: str = EXPORT_ID, ws: str = WS) -> dict[str, Any]:
    """The route's queued job row and lock, and the event it invokes the job with."""
    world.aggregates.put_item(Item={'pk': f'WS#{WS}#JOB#export', 'sk': export_id, 'export_id': export_id,
                                    'status': 'queued', 'started_by_sub': 'sub-ada',
                                    'created_at': CREATED.isoformat(), 'workspace_id': ws})
    world.aggregates.put_item(Item={'pk': f'WS#{WS}#JOB#export', 'sk': 'LOCK', 'job_id': export_id,
                                    'locked_at': CREATED.isoformat()})
    return {'export_id': export_id, 'workspace_id': WS}


@pytest.fixture
def world() -> Iterator[World]:
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        feedback = _table_with_gsi1(resource, handler.FEEDBACK_TABLE, FEEDBACK_BY_DATE_INDEX)
        aggregates = create_pk_sk_table(handler.AGGREGATES_TABLE, resource)
        workspaces = create_pk_sk_table(WORKSPACES_TABLE, resource)
        memory = _table_with_gsi1(resource, MEMORY_TABLE, MEMORY_BY_STATUS_INDEX)
        conversations = create_pk_sk_table(CONVERSATIONS_TABLE, resource)
        s3 = ExportS3(BUCKET, min_part=SMALL_MIN)
        invoke, notify = MagicMock(), MagicMock(return_value=True)
        with patch.object(handler, 'get_dynamodb_resource', return_value=resource), \
                patch.object(handler, 'MEMORY_TABLE', MEMORY_TABLE), \
                patch.object(handler, 'CONVERSATIONS_TABLE', CONVERSATIONS_TABLE), \
                patch.object(handler, 'get_s3_client', return_value=s3), \
                patch.object(handler, 'get_workspaces_table', return_value=workspaces), \
                patch.object(handler, 'RAW_DATA_BUCKET', BUCKET), \
                patch.object(handler, 'invoke_lambda_async', invoke), \
                patch.object(handler, 'notify', notify), \
                patch.object(handler, 'PartSink', partial(PartSink, part_size=SMALL_PART, min_part=SMALL_MIN)):
            yield World(feedback, aggregates, workspaces, s3, invoke, notify, memory, conversations)


class Budget:
    """A Lambda context whose time runs low after ``checks`` looks at the clock (one invocation's budget)."""

    function_name = 'voc-workspace-export'

    def __init__(self, checks: int | None = None) -> None:
        self._left = checks

    def get_remaining_time_in_millis(self) -> int:
        if self._left is None:
            return 900_000
        self._left -= 1
        return 900_000 if self._left >= 0 else 60_000
