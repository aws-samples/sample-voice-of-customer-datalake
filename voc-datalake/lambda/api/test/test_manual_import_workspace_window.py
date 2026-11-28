"""A workspace's manual import keeps raw copies by the deployment's retention window (7.108.00).

A workspace's source profile sets no retention window: the window is the deployment's and voc-retention applies it
to every workspace's items. Before 7.108.00 the manual import (the paste confirm, the CSV and the JSON upload) read
the workspace's profile without that window, so a source with a window that the workspace's own profile allows PII
for was archived as one whole file in a workspace, which per-item retention never deletes. Now each message gets its own raw copy there, as the window asks,
and the deployment's own uploads are as before. The real ``upload_profile`` reads the profiles stored in the moto
table (no stand-in). Made-up names only.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table, workspace_route_call

import manual_import_handler as h
from shared import source_profiles
from shared.import_runs import _put_rows as write_run_rows
from shared.source_profiles import SOURCES_SETTINGS_KEY
from shared.workspace_request import RequestWorkspace
from shared.workspace_settings import settings_key

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
BUCKET = 'raw-bucket'
QUEUE = 'https://sqs.example.com/q'
ADMIN_A = {'sub': 'sub-admin-a', 'cognito:groups': 'users', 'cognito:username': 'a'}
DEPLOYMENT_ADMIN = {'sub': 'sub-deploy', 'cognito:groups': 'admins', 'cognito:username': 'd'}
#: The deployment's profile of the upload source: PII allowed, deleted item by item after 90 days.
WINDOWED = [{'id': 'manual_import', 'label': 'Manual', 'pii': 'allow', 'retention_days': 90,
             'retention_legal_basis': 'Contract clause 4'}]
#: The same window on a deployment profile that redacts: the workspace's own policy (allow) applies, the window too.
REDACTED_WINDOW = [{**WINDOWED[0], 'pii': 'redact'}]
#: The deployment's profile kept for good.
KEPT = [{'id': 'manual_import', 'label': 'Manual', 'pii': 'allow'}]
#: Workspace A's own profile: PII allowed, no window (a workspace profile cannot set one).
WORKSPACE = [{'id': 'manual_import', 'label': 'Trail import', 'pii': 'allow'}]
CSV = 'id,text,rating\n1,Login fails on the tablet,2\n2,Great support from the team,5\n'
JSON_ITEMS = [{'id': f'i{i}', 'text': f'Review {i}', 'source': 'web', 'timestamp': '2026-10-01T00:00:00Z'}
              for i in range(2)]
REVIEWS = [{'text': 'Nice trail map', 'date': '2026-03-01'}, {'text': 'The app crashes', 'date': '2026-03-02'}]


@dataclass
class World:
    aggregates: Any
    s3: Any
    sqs: MagicMock

    def uris(self) -> list[str | None]:
        """Every queued message's raw copy, in order (the batch sends and the paste confirm's single sends)."""
        bodies = [entry['MessageBody'] for sent in self.sqs.send_message_batch.call_args_list
                  for entry in sent.kwargs['Entries']]
        bodies += [sent.kwargs['MessageBody'] for sent in self.sqs.send_message.call_args_list]
        return [json.loads(body)['s3_raw_uri'] for body in bodies]

    def keys(self) -> list[str]:
        listed = self.s3.list_objects_v2(Bucket=BUCKET)
        return [entry['Key'] for entry in listed.get('Contents', [])]


def _all_sent(Entries: list[dict], **_options: Any) -> dict:
    return {'Successful': [{'Id': entry['Id']} for entry in Entries], 'Failed': []}


def _world(deployment: list[dict]) -> Iterator[World]:
    """Workspace A (ADMIN_A its admin) saved ``WORKSPACE``; the deployment saved ``deployment``."""
    with mock_aws():
        tables = {name: pk_sk_table(name) for name in ('aggregates', 'feedback', 'workspaces')}
        tables['workspaces'].put_item(Item={'pk': f'WS#{WS_A}', 'sk': 'META', 'status': 'active', 'name': WS_A,
                                            'slug': 'a'})
        tables['workspaces'].put_item(Item={'pk': f'WS#{WS_A}', 'sk': f"MEMBER#{ADMIN_A['sub']}", 'role': 'admin'})
        tables['aggregates'].put_item(Item={**SOURCES_SETTINGS_KEY, 'sources': deployment})
        tables['aggregates'].put_item(Item={**settings_key(WS_A, 'sources'), 'sources': WORKSPACE})
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        sqs = MagicMock()
        sqs.send_message_batch.side_effect = _all_sent
        members = RequestWorkspace(table=lambda: tables['workspaces'], confirm_platform_admin=lambda _event: False)
        handler = {'aggregates_table': tables['aggregates'], 'feedback_table': tables['feedback'], 's3': s3,
                   'sqs': sqs, 'RAW_DATA_BUCKET': BUCKET, 'PROCESSING_QUEUE_URL': QUEUE}
        source_profiles.clear_source_profiles_cache()
        with patch.multiple(h, **handler), patch.object(h._request, 'workspace', members), \
                patch('shared.import_runs._put_rows', side_effect=write_run_rows):
            yield World(tables['aggregates'], s3, sqs)
        source_profiles.clear_source_profiles_cache()


@pytest.fixture
def windowed() -> Iterator[World]:
    yield from _world(WINDOWED)


@pytest.fixture
def redacted_window() -> Iterator[World]:
    yield from _world(REDACTED_WINDOW)


@pytest.fixture
def kept() -> Iterator[World]:
    yield from _world(KEPT)


def _upload(world: World, lambda_context, how: str, claims: dict, ws: str | None) -> None:
    """One manual import of two messages, ``how``: the paste confirm, a CSV or a JSON upload."""
    if how == 'paste':
        job_key = {'pk': 'MANUAL_IMPORT#job-a', 'sk': 'JOB'}
        world.aggregates.put_item(Item={**job_key, 'status': 'completed', 'source_url': 'https://example.com/r',
                                        'source_origin': 'example', 'raw_text': 't', 'reviews': [],
                                        **({'workspace_id': ws} if ws else {})})
        status, body = workspace_route_call(h, lambda_context, 'POST', '/scrapers/manual/confirm', claims=claims,
                                            ws=ws, body={'job_id': 'job-a', 'reviews': REVIEWS})
    elif how == 'csv':
        status, body = workspace_route_call(h, lambda_context, 'POST', '/scrapers/manual/csv-upload', claims=claims,
                                            ws=ws, body={'csv_text': CSV})
    else:
        status, body = workspace_route_call(h, lambda_context, 'POST', '/scrapers/manual/json-upload', claims=claims,
                                            ws=ws, body={'items': JSON_ITEMS})
    assert status == 200, body


def _per_item(world: World, root: str) -> None:
    """Each of the two messages points at a raw copy of its own under ``root``, and nothing else was written."""
    uris = world.uris()
    keys = world.keys()
    assert len(uris) == 2
    assert len(set(uris)) == 2
    assert {f's3://{BUCKET}/{key}' for key in keys} == set(uris)
    assert len(keys) == 2
    assert all(key.startswith(f'{root}manual_import/') for key in keys)


@pytest.mark.parametrize('how', ['paste', 'csv', 'json'])
def test_a_workspace_upload_of_a_windowed_pii_allowed_source_is_archived_per_item(windowed, lambda_context, how):
    _upload(windowed, lambda_context, how, ADMIN_A, WS_A)

    _per_item(windowed, f'ws/{WS_A}/raw/')


@pytest.mark.parametrize('how', ['paste', 'csv', 'json'])
def test_a_workspace_allow_upload_of_a_source_the_deployment_redacts_keeps_its_window(redacted_window, lambda_context,
                                                                                       how):
    _upload(redacted_window, lambda_context, how, ADMIN_A, WS_A)

    _per_item(redacted_window, f'ws/{WS_A}/raw/')


@pytest.mark.parametrize('how', ['paste', 'csv', 'json'])
def test_the_deployments_upload_of_a_windowed_source_is_archived_per_item_as_before(windowed, lambda_context, how):
    _upload(windowed, lambda_context, how, DEPLOYMENT_ADMIN, None)

    _per_item(windowed, 'raw/')


@pytest.mark.parametrize('how', ['paste', 'csv', 'json'])
@pytest.mark.parametrize('ws', [WS_A, None], ids=['workspace', 'deployment'])
def test_an_upload_of_a_source_kept_for_good_keeps_the_whole_file(kept, lambda_context, how, ws):
    _upload(kept, lambda_context, how, ADMIN_A if ws else DEPLOYMENT_ADMIN, ws)

    [key] = kept.keys()
    assert set(kept.uris()) == {f's3://{BUCKET}/{key}'}
