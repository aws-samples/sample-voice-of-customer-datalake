"""The Agents API's read of the scheduled cross-run Learn pass's weekly record (``GET /agents/engineering/learn``,
7.53.00, shared/agents_engineering_learn_routes.py): an administrator acting for themselves reads a flow's record of a
week (its newest when none is named), with the weeks it has and its model text named; a week with no record is never
read (404); 403 for anyone else, a delegated credential included; 404 while the module is off; 400 off its shape."""
from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from agents_handler_fixtures import USER
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call
from moto import mock_aws

from engineering.learning.cross_run import MODEL_TEXT, record_key

BUCKET = 'voc-eng-workspace-test'
FLOW = '01JD3R4NZXQ7Y2W8K4M6P9FLOW'
PATH = '/agents/engineering/learn'
DELEGATED_ADMIN = {'sub': 'mcp:tok_1', 'cognito:username': 'alice', 'voc:acting_subject': 'admin-sub',
                   'cognito:groups': 'admins'}


def _record(week: str) -> dict[str, Any]:
    return {'schema': 'voc-cross-run/1', 'flow': FLOW, 'week': week, 'failures': [],
            'analysis': {'convergence': 'Converging: three runs done in a row.'}}


@pytest.fixture
def s3(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    """The agents tables, the module on, and the workspace bucket with the flow's records of two weeks."""
    with _api(), mock_aws():
        client = boto3.client('s3', region_name='us-east-1')
        client.create_bucket(Bucket=BUCKET)
        for week in ('2026-W46', '2026-W47'):
            client.put_object(Bucket=BUCKET, Key=record_key(FLOW, week), Body=json.dumps(_record(week)).encode())
        monkeypatch.setenv('ENGINEERING_AGENTS', 'on')
        monkeypatch.setenv('ENGINEERING_TABLE', 'voc-engineering-test')
        monkeypatch.setenv('ENGINEERING_WORKSPACE_BUCKET', BUCKET)
        with patch('shared.aws.get_s3_client', return_value=client):
            yield client


def test_an_administrator_reads_the_flows_newest_week_labelled_as_model_text(s3: Any, lambda_context: Any) -> None:
    assert s3 is not None
    status, body = _call(lambda_context, 'GET', PATH, query={'flow': FLOW})
    assert (status, body['week'], body['weeks'], body['key']) == (
        200, '2026-W47', ['2026-W47', '2026-W46'], record_key(FLOW, '2026-W47'))
    assert (body['record']['analysis']['convergence'], body['model_text']) == (
        'Converging: three runs done in a row.', list(MODEL_TEXT))
    assert body['label'].startswith('model text')


def test_a_named_week_is_read_and_a_week_with_no_record_is_404_unread(s3: Any, lambda_context: Any) -> None:
    assert s3 is not None
    status, body = _call(lambda_context, 'GET', PATH, query={'flow': FLOW, 'week': '2026-W46'})
    assert (status, body['record']['week']) == (200, '2026-W46')
    with patch('engineering.workspace.store.WorkspaceStore.read_text') as read:
        status, _body = _call(lambda_context, 'GET', PATH, query={'flow': FLOW, 'week': '2026-W45'})
    assert (status, read.call_count) == (404, 0)
    assert _call(lambda_context, 'GET', PATH, query={'flow': 'another-flow'})[0] == 404


@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN])
def test_anyone_but_an_administrator_acting_for_themselves_is_refused(
        s3: Any, lambda_context: Any, claims: dict[str, str]) -> None:
    assert s3 is not None
    assert _call(lambda_context, 'GET', PATH, query={'flow': FLOW}, claims=claims)[0] == 403


@pytest.mark.parametrize('query', [{'flow': 'no-flow'}, {'flow': 'a/b'}, {}, {'flow': FLOW, 'week': '2026-47'},
                                   {'flow': FLOW, 'week': '2026-W54'}])
def test_a_flow_or_a_week_off_its_shape_is_400(s3: Any, lambda_context: Any, query: dict[str, str]) -> None:
    assert s3 is not None
    assert _call(lambda_context, 'GET', PATH, query=query)[0] == 400


def test_the_route_is_404_while_the_module_is_off(s3: Any, lambda_context: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert s3 is not None
    monkeypatch.delenv('ENGINEERING_AGENTS')
    assert _call(lambda_context, 'GET', PATH, query={'flow': FLOW})[0] == 404
