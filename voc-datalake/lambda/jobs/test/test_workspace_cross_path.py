"""One workspace review across the whole data path, on the open path (7.14.00: the ingestion hold lifted;
docs/multi-workspace.md, phase 2).

It starts at the processing queue: a message written by hand in the shape ``workspace_payload`` gives a form
submission, a webhook delivery and a workspace run (``workspace_id`` last); the routes that build it are tested in
their own suites. That message goes through the real processor, its stored item's stream records through the real
aggregator, the workspace's category reprocess worker replays it, and voc-retention's erasure by email removes it:
every step against ONE set of moto tables and one versioned raw bucket. At each step the review, its index
partitions, its counters and its objects are the workspace's own (``WS#{ws}#…``, ``ws/{ws}/…``), and neither another
workspace nor the deployment sees any of it.
"""
from __future__ import annotations

import json
import os
from collections.abc import Iterator
from contextlib import ExitStack
from datetime import UTC, datetime
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
import pytest
from aws_lambda_powertools.utilities.batch import process_partial_response
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer
from moto import mock_aws

from jobs.category_reprocess import handler as reprocess
from jobs.retention import handler as retention
from jobs.retention.test.conftest import BUCKET, erasure_job
from processor import handler as processor
from processor.test import test_source_updates as issues
from shared import reprocess_jobs
from shared.data_version import BatchBump
from shared.test.moto_s3 import create_versioned_bucket
from shared.test.moto_tables import create_pk_sk_table
from shared.test.source_profile_fixtures import seeded_source_profiles
from shared.workspace_settings import settings_key
from shared.ws_repo import WorkspaceScope

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
EMAIL = 'rowan@example.com'
#: The workspace keeps its reviews' text and a raw copy (its own source profile).
ALLOW = [{'id': 'webscraper', 'label': 'Reviews', 'pii': 'allow'}]
#: The workspace's own taxonomy, which the replay files the review under.
WS_CATEGORIES = [{'name': 'trail_gear', 'description': 'Trail gear', 'subcategories': [{'name': 'brakes'}]}]
JOB_ID = 'er_00000000cafe'


def _message(ws: str) -> dict:
    """A review as a workspace run queues it: every field, then ``workspace_id`` last (``workspace_payload``)."""
    return {'id': 'rev-1', 'source_platform': 'webscraper', 'source_channel': 'reviews',
            'text': 'The rear brakes squeal on every descent', 'created_at': datetime.now(UTC).isoformat(),
            'metadata': {'email': EMAIL}, 'raw_data': {'id': 'rev-1', 'body': 'The rear brakes squeal'},
            'workspace_id': ws}


def _detailed(**kwargs: Any) -> Any:
    """The replay's recorder answers through ``shared.categorization.converse`` (patched per test)."""
    from shared import categorization
    from shared.converse import ConverseResult

    text = categorization.converse(**kwargs)
    return ConverseResult(text=text, model_id=kwargs.get('model_id'), requested_model_id=kwargs.get('model_id'))


@pytest.fixture
def lake() -> Iterator[dict[str, Any]]:
    """The tables and the raw bucket every step shares, and each Lambda pointed at them."""
    assert reprocess.FEEDBACK_TABLE == retention.FEEDBACK_TABLE
    assert reprocess.AGGREGATES_TABLE == retention.AGGREGATES_TABLE
    with mock_aws(), ExitStack() as stack:
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        s3 = create_versioned_bucket(BUCKET)
        feedback = create_pk_sk_table(retention.FEEDBACK_TABLE, resource)
        aggregates = create_pk_sk_table(retention.AGGREGATES_TABLE, resource)
        for name in ('RADAR_TABLE', 'PROJECTS_TABLE', 'FEATURE_REQUESTS_TABLE', 'WORKSPACES_TABLE'):
            table_name = getattr(retention, name) or f'test-{name.lower()}'
            create_pk_sk_table(table_name, resource)
            stack.enter_context(patch.object(retention, name, table_name))
        aggregates.put_item(Item={**settings_key(WS, 'categories'), 'categories': WS_CATEGORIES})
        converse = MagicMock(return_value='{"category": "trail_gear", "subcategory": "brakes"}')
        llm = MagicMock(side_effect=lambda *_a, **_k: issues.insights())
        for target, value in (
                (processor, {'feedback_table': feedback, 'aggregates_table': aggregates, 'persistence_layer': None,
                             'idempotency_config': None, 'invoke_bedrock_llm': llm,
                             'get_categories_config': MagicMock(return_value=issues.CATEGORIES),
                             'detect_language': MagicMock(return_value='en'),
                             'translate_text': MagicMock(side_effect=lambda text, _s, _d: text),
                             'get_comprehend_sentiment': MagicMock(
                                 return_value={'label': 'negative', 'score': -0.4})}),
                (reprocess, {'get_dynamodb_resource': MagicMock(return_value=resource),
                             'invoke_lambda_async': MagicMock()}),
                (retention, {'get_dynamodb_resource': MagicMock(return_value=resource),
                             'get_s3_client': MagicMock(return_value=s3), 'RAW_DATA_BUCKET': BUCKET})):
            for name, replacement in value.items():
                stack.enter_context(patch.object(target, name, replacement))
        for name, replacement in (('shared.raw_copy.get_s3_client', MagicMock(return_value=s3)),
                                  ('shared.aws.get_s3_client', MagicMock(return_value=s3)),
                                  ('shared.categorization.converse', converse),
                                  ('shared.reprocess_lineage.converse_detailed', MagicMock(side_effect=_detailed)),
                                  ('shared.categorization.get_active_model_id', MagicMock(return_value='m')),
                                  ('shared.reprocess_lineage.get_active_model_id', MagicMock(return_value='m'))):
            stack.enter_context(patch(name, replacement))
        stack.enter_context(patch.dict(os.environ, {'RAW_DATA_BUCKET': BUCKET}))
        stack.enter_context(seeded_source_profiles(workspaces={WS: ALLOW, OTHER: ALLOW}))
        processor._settings_cache.clear()
        processor._workspace_categories.clear()
        for key in ('dimensions', 'sources', ('dimensions', WS), ('dimensions', OTHER)):
            processor._settings_cache[key] = (float('inf'), [])
        for ws in (WS, OTHER):
            processor._settings_cache[('sources', ws)] = (float('inf'), list(ALLOW))
        yield {'feedback': feedback, 'aggregates': aggregates, 's3': s3, 'converse': converse}
        processor._settings_cache.clear()
        processor._workspace_categories.clear()


_SERIALIZER = TypeSerializer()


def _raw(name: str, seq: int, *, new: dict, old: dict | None = None) -> dict:
    """A DynamoDB stream record of the feedback table (NEW_AND_OLD_IMAGES), as the aggregator receives it."""
    body: dict = {'SequenceNumber': f'{1000 + seq}', 'StreamViewType': 'NEW_AND_OLD_IMAGES',
                  'NewImage': {key: _SERIALIZER.serialize(value) for key, value in new.items()}}
    if old is not None:
        body['OldImage'] = {key: _SERIALIZER.serialize(value) for key, value in old.items()}
    return {'eventID': f'cross-path-{seq}', 'eventName': name, 'eventSource': 'aws:dynamodb', 'dynamodb': body}


def _apply(table: Any, records: list[dict]) -> dict:
    """One stream batch through the real aggregator, writing ``table``."""
    from aggregator import handler

    with patch.object(handler, 'aggregates_table', table), patch.object(handler, 'AGGREGATES_TABLE', table.name), \
            patch.object(handler.time, 'sleep'):
        return dict(process_partial_response(event={'Records': records}, record_handler=handler.record_handler,
                                             processor=handler.processor))


@pytest.fixture
def aggregator_as_deployed(monkeypatch: pytest.MonkeyPatch) -> None:
    """No dedupe table, a fresh batch counter (the aggregator suite's own defaults)."""
    from aggregator import handler

    monkeypatch.setattr(handler, 'IDEMPOTENCY_TABLE', '')
    monkeypatch.setattr(handler, '_known_earliest_date', None)
    monkeypatch.setattr(handler, 'data_changed', BatchBump(handler.bump_data_version))


def _context(name: str) -> MagicMock:
    context = MagicMock()
    context.function_name = name
    context.get_remaining_time_in_millis.return_value = 900_000
    return context


def _deliver(message: dict) -> dict:
    return processor.record_handler(MagicMock(body=json.dumps(message)))


def _reviews(lake: dict) -> list[dict]:
    return sorted(lake['feedback'].scan()['Items'], key=lambda item: item['pk'])


def _object_keys(lake: dict, prefix: str = '') -> list[str]:
    page = lake['s3'].list_object_versions(Bucket=BUCKET, Prefix=prefix)
    return sorted(entry['Key'] for entry in page.get('Versions', []))


def _counter_partitions(lake: dict) -> set[str]:
    """Every partition of voc-aggregates but the settings and job rows this test seeded or started."""
    return {row['pk'] for row in lake['aggregates'].scan()['Items']
            if '#SETTINGS#' not in row['pk'] and '#JOB#' not in row['pk'] and not row['pk'].startswith('JOB#')}


def _stored_review(lake: dict) -> dict:
    (item,) = _reviews(lake)
    return item


def _replay(lake: dict, ws: str) -> dict:
    """Workspace ``ws``'s own category reprocess (processed mode), started and run to its end by the real worker."""
    job = reprocess_jobs.start_job(lake['aggregates'], mode=reprocess_jobs.MODE_PROCESSED, days=0,
                                   include_manual=False, started_by='rowan', now=datetime.now(UTC),
                                   started_by_sub='sub-rowan', scope=WorkspaceScope(ws))
    assert job is not None
    return reprocess.run_job({'job_id': job['sk'], 'workspace_id': ws}, _context('voc-job-category-reprocess'))


@pytest.mark.usefixtures('aggregator_as_deployed')
class TestAWorkspaceReviewAcrossTheDataPath:
    def test_it_is_stored_counted_replayed_and_erased_in_its_workspace_only(self, lake):
        # 1. The processor stores the message in its workspace, its inline raw copy under ws/{ws}/raw/.
        processed = _deliver(_message(WS))
        stored = _stored_review(lake)
        raw_keys = _object_keys(lake)

        assert processed['status'] == 'success'
        prefix = f'WS#{WS}#'
        assert (stored['pk'], stored['sk']) == (f'{prefix}SOURCE#webscraper', f"FEEDBACK#{stored['feedback_id']}")
        assert all(str(stored[f'gsi{n}pk']).startswith(prefix) for n in range(1, 6))
        assert len(raw_keys) == 1
        assert raw_keys[0].startswith(f'ws/{WS}/raw/webscraper/')
        assert stored['s3_raw_uri'] == f's3://{BUCKET}/{raw_keys[0]}'

        # 2. Its stream INSERT moves the workspace's counters only.
        inserted = _apply(lake['aggregates'], [_raw('INSERT', 1, new=stored)])
        counted = _counter_partitions(lake)

        assert inserted == {'batchItemFailures': []}
        assert f'{prefix}METRIC#daily_total' in counted
        assert {pk for pk in counted if not pk.startswith(prefix)} == set()

        # 3. The workspace's own reprocess replays it with the workspace's taxonomy, in place, its old version kept.
        replayed = _replay(lake, WS)
        after = _stored_review(lake)
        silver_keys = _object_keys(lake, f'ws/{WS}/silver/')

        assert (replayed['status'], replayed['updated']) == ('completed', 1)
        assert (after['pk'], after['sk']) == (stored['pk'], stored['sk'])
        assert (after['category'], after['gsi2pk']) == ('trail_gear', f'{prefix}CATEGORY#trail_gear')
        assert len(silver_keys) == 1
        modified = _apply(lake['aggregates'], [_raw('MODIFY', 2, old=stored, new=after)])
        recounted = _counter_partitions(lake)
        assert modified == {'batchItemFailures': []}
        assert {pk for pk in recounted if not pk.startswith(prefix)} == set()

        # 4. An erasure by the reviewer's email removes the review and every object of it, tombstoned first.
        erased = retention.handle_event(erasure_job(lake, JOB_ID, 'email', EMAIL), _context('voc-retention'))
        left = _reviews(lake)
        objects = _object_keys(lake, f'ws/{WS}/')
        tombstones = lake['aggregates'].query(
            KeyConditionExpression=Key('pk').eq('AUDIT#tombstone#webscraper'))['Items']

        assert left == []
        assert objects == []
        assert (erased['deleted_items'], erased['deleted_workspace_items']) == (1, 1)
        assert [(row['sk'], row['workspace_id']) for row in tombstones] == [(f"{WS}#{stored['feedback_id']}", WS)]
        assert EMAIL not in str(tombstones)

    def test_two_workspaces_copies_of_one_source_item_stay_apart_until_one_is_replayed(self, lake):
        first = _deliver(_message(WS))
        second = _deliver(_message(OTHER))
        mine, theirs = (item for item in _reviews(lake) if item['pk'].startswith(f'WS#{WS}#')), \
            (item for item in _reviews(lake) if item['pk'].startswith(f'WS#{OTHER}#'))
        (own,), (other,) = list(mine), list(theirs)
        raw_roots = {key.split('/raw/')[0] for key in _object_keys(lake)}

        assert (first['status'], second['status']) == ('success', 'success')
        assert own['feedback_id'] == other['feedback_id']
        assert raw_roots == {f'ws/{WS}', f'ws/{OTHER}'}
        assert not any(item['pk'].startswith('SOURCE#') for item in _reviews(lake))

        replayed = _replay(lake, WS)
        untouched = lake['feedback'].get_item(Key={'pk': other['pk'], 'sk': other['sk']})['Item']

        assert (replayed['status'], replayed['scanned'], replayed['updated']) == ('completed', 1, 1)
        assert untouched == other
