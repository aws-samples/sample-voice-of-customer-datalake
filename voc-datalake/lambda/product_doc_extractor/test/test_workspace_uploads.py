"""A workspace's product-doc upload (docs/multi-workspace.md, the project plan, 3f).

A workspace's upload is ``ws/{ws}/projects/{id}/product_docs/raw/{doc}.{ext}``. It is extracted inside that workspace
only, after the project's claim (``PROJECT_ID#{id}`` / ``CLAIM``) is found to name the same workspace and the
workspace is found active; anything else is refused with nothing written and one log line that carries its error
type alone. The deployment's ``projects/`` uploads send exactly the requests they sent before.
"""
from __future__ import annotations

import io
import json
from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock

import boto3
import pytest
from moto import mock_aws

from api.test.moto_helpers import pk_sk_table

from .conftest import PROJECT_KEYS_SPEC, TEST_BUCKET, TEST_PROJECTS_TABLE, TEST_WORKSPACES_TABLE, png_header

A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
PROJECT = 'proj_20261115101500_a1b2c3d4'
DOC = '0123456789abcdef'
BODY = b'# Checkout\n\nThe pay button sits under the basket. \xe2\x9c\x93\n'
RAW_KEY = f'ws/{A}/projects/{PROJECT}/product_docs/raw/{DOC}.md'
EXTRACTED_KEY = f'ws/{A}/projects/{PROJECT}/product_docs/extracted/{DOC}.txt'
DOC_KEY = {'pk': f'WS#{A}#PROJECT#{PROJECT}', 'sk': f'PRODUCT_DOC#{DOC}'}
#: The fields a JSON log line has of its own; a refusal adds its error type and nothing else.
_LINE_FIELDS = {'level', 'message', 'timestamp', 'service'}


def _event(key: str, size: int = len(BODY)) -> dict[str, Any]:
    return {'Records': [{'eventName': 'ObjectCreated:Put',
                         's3': {'bucket': {'name': TEST_BUCKET}, 'object': {'key': key, 'size': size}}}]}


def _doc(content_type: str = 'text/markdown', raw_key: str = RAW_KEY) -> dict[str, Any]:
    """The record create_upload_url writes, in the workspace's partition."""
    return {**DOC_KEY, 'doc_id': DOC, 'filename': 'checkout.md', 'content_type': content_type, 'size_bytes': len(BODY),
            's3_raw_key': raw_key, 's3_extracted_key': None, 'status': 'pending', 'error': None,
            'extracted_chars': 0, 'created_at': '2026-11-15T10:15:00+00:00'}


class _World:
    """The raw bucket, voc-projects and voc-workspaces (moto), seeded with one workspace upload."""

    def __init__(self) -> None:
        self.s3 = boto3.client('s3', region_name='us-east-1')
        self.s3.create_bucket(Bucket=TEST_BUCKET)
        self.projects = pk_sk_table(TEST_PROJECTS_TABLE)
        self.workspaces = pk_sk_table(TEST_WORKSPACES_TABLE)

    def seed(self, *, claim: str | None = A, status: str | None = 'active', content_type: str = 'text/markdown',
             body: bytes = BODY, raw_key: str = RAW_KEY) -> None:
        self.s3.put_object(Bucket=TEST_BUCKET, Key=raw_key, Body=body)
        self.projects.put_item(Item=_doc(content_type, raw_key))
        if claim is not None:
            self.projects.put_item(Item={'pk': f'PROJECT_ID#{PROJECT}', 'sk': 'CLAIM', 'workspace_id': claim,
                                         'claimed_at': '2026-11-15T10:15:00+00:00'})
        if status is not None:
            self.workspaces.put_item(Item={'pk': f'WS#{A}', 'sk': 'META', 'status': status, 'name': 'Checkout team'})

    def objects(self) -> list[str]:
        return sorted(o.get('Key', '') for o in self.s3.list_objects_v2(Bucket=TEST_BUCKET).get('Contents', []))

    def project_rows(self) -> list[dict[str, Any]]:
        return sorted(self.projects.scan()['Items'], key=lambda row: (row['pk'], row['sk']))


@pytest.fixture
def world() -> Iterator[_World]:
    """Real (moto) AWS for the handler: with the `extractor` fixture its client cache is empty, so it builds its
    clients inside the mock."""
    with mock_aws():
        yield _World()


def _refusals(json_logs) -> list[str]:
    """The error type of every refusal line, as the handler's formatter wrote it (the context of the moment
    included), each line checked to carry exactly the line's own fields and its error type: no key, id or text."""
    lines = [line for line in json_logs() if 'error_type' in line]
    assert [set(line) for line in lines] == [{*_LINE_FIELDS, 'error_type'}] * len(lines)
    return [line['error_type'] for line in lines]


def test_a_workspace_upload_is_extracted_into_its_own_workspace(extractor, world):
    world.seed()
    before = world.project_rows()

    assert extractor.lambda_handler(_event(RAW_KEY)) == {'processed': 1}

    assert world.objects() == sorted([RAW_KEY, EXTRACTED_KEY])
    assert world.s3.get_object(Bucket=TEST_BUCKET, Key=EXTRACTED_KEY)['Body'].read() == BODY
    doc = world.projects.get_item(Key=DOC_KEY)['Item']
    assert {k: doc[k] for k in ('status', 'error', 's3_extracted_key')} == {
        'status': 'ready', 'error': None, 's3_extracted_key': EXTRACTED_KEY}
    assert int(doc['extracted_chars']) == len(BODY.decode('utf-8'))
    # The doc row is the one row that changed; nothing was written outside the workspace.
    assert [row['pk'] for row in world.project_rows()] == [row['pk'] for row in before]


def test_its_log_lines_carry_the_workspace(extractor, world, json_logs):
    world.seed()

    extractor.lambda_handler(_event(RAW_KEY))

    ready = [line for line in json_logs() if line['message'].endswith('chars)')]
    assert [{k: line.get(k) for k in ('workspace_id', 'project_id', 'doc_id')} for line in ready] == [
        {'workspace_id': A, 'project_id': PROJECT, 'doc_id': DOC}]


@pytest.mark.parametrize(('seed', 'error_type'), [
    ({'claim': B}, 'claim_mismatch'),
    ({'claim': None}, 'claim_missing'),
    ({'claim': 'not-a-workspace'}, 'claim_malformed'),
    ({'status': 'deleting'}, 'workspace_not_active'),
    ({'status': None}, 'workspace_not_active'),
], ids=['another-workspaces-claim', 'no-claim', 'malformed-claim', 'deleting', 'no-meta'])
def test_an_upload_its_claim_or_status_does_not_allow_is_refused_with_nothing_written(
        extractor, world, json_logs, seed, error_type):
    world.seed(**seed)
    before = world.project_rows()

    assert extractor.lambda_handler(_event(RAW_KEY)) == {'processed': 1}

    assert world.objects() == [RAW_KEY]
    assert world.project_rows() == before
    assert _refusals(json_logs) == [error_type]


def test_an_image_fails_in_its_workspace_with_its_reason_while_the_model_picks_are_the_deployments(
        extractor, world, monkeypatch):
    """Never left `pending` (the API's stall check would tell the user to upload again, which cannot help); no model
    setting is read and nothing is described."""
    image_key = RAW_KEY.replace('.md', '.png')
    world.seed(content_type='image/png', body=png_header(10, 10), raw_key=image_key)
    monkeypatch.setattr(extractor, '_resolve_model_id', lambda: pytest.fail('read the model picks'))

    extractor.lambda_handler(_event(image_key))

    doc = world.projects.get_item(Key=DOC_KEY)['Item']
    assert {k: doc[k] for k in ('status', 'error')} == {'status': 'failed', 'error': extractor.WORKSPACE_IMAGE_MESSAGE}
    assert world.objects() == [image_key]


def test_a_record_that_names_another_object_is_refused_with_nothing_written(extractor, world, json_logs):
    world.seed()
    other = RAW_KEY.replace(DOC, 'fedcba9876543210')
    world.s3.put_object(Bucket=TEST_BUCKET, Key=other, Body=BODY)
    world.projects.put_item(Item={**_doc(), 'sk': 'PRODUCT_DOC#fedcba9876543210'})
    before = world.project_rows()

    extractor.lambda_handler(_event(other))

    assert world.project_rows() == before
    assert world.objects() == sorted([RAW_KEY, other])
    assert _refusals(json_logs) == ['raw_key_mismatch']


def test_a_workspace_deleted_during_the_extraction_gets_no_text(extractor, world, monkeypatch, json_logs):
    """The status is read again just before the put: a delete that began meanwhile has swept, or will sweep, the
    prefix, and no text may land under it afterwards."""
    world.seed()
    extract = extractor._extract_by_type

    def extract_then_delete(*args: Any) -> tuple[str, bytes]:
        answer = extract(*args)
        world.workspaces.update_item(Key={'pk': f'WS#{A}', 'sk': 'META'}, UpdateExpression='SET #s = :s',
                                     ExpressionAttributeNames={'#s': 'status'},
                                     ExpressionAttributeValues={':s': 'deleting'})
        return answer

    monkeypatch.setattr(extractor, '_extract_by_type', extract_then_delete)

    extractor.lambda_handler(_event(RAW_KEY))

    assert world.objects() == [RAW_KEY]
    assert world.projects.get_item(Key=DOC_KEY)['Item']['status'] == 'extracting'
    assert _refusals(json_logs) == ['workspace_not_active']


def test_a_lost_extracting_write_stops_a_workspace_upload(extractor, world, monkeypatch, json_logs):
    """In a workspace any failure of the `extracting` write (not only a refused condition) ends the record: no text
    is written for a record that may be gone."""
    world.seed()
    table = extractor._table(TEST_PROJECTS_TABLE)

    def failing_update(**_kwargs: Any) -> dict[str, Any]:
        raise RuntimeError(f'throttled writing {PROJECT}')

    monkeypatch.setattr(table, 'update_item', failing_update)

    extractor.lambda_handler(_event(RAW_KEY))

    assert world.objects() == [RAW_KEY]
    assert _refusals(json_logs) == ['extracting_not_written']
    # The failed write's warning names the error's class, never its text.
    warning = [line for line in json_logs() if line['message'] == 'Could not update product doc']
    assert [(line['error_class'], f'throttled writing {PROJECT}' in json.dumps(line)) for line in warning] == [
        ('RuntimeError', False)]


def test_a_record_deleted_while_its_text_was_put_takes_the_text_back(extractor, world, monkeypatch):
    """The document's delete (api/product_context.py `delete_doc`) deletes the row, then sweeps the objects; a text
    put after that sweep finds the row gone when it marks it ready, and the extractor deletes the text again: the
    exact version it put, so a versioned bucket keeps no copy of it either."""
    world.s3.put_bucket_versioning(Bucket=TEST_BUCKET, VersioningConfiguration={'Status': 'Enabled'})
    world.seed()
    s3 = boto3.client('s3', region_name='us-east-1')
    put = s3.put_object

    def put_then_delete_the_record(**kwargs: Any) -> Any:
        answer = put(**kwargs)
        world.projects.delete_item(Key=DOC_KEY)
        return answer

    monkeypatch.setattr(s3, 'put_object', put_then_delete_the_record)
    extractor._clients['s3'] = s3

    extractor.lambda_handler(_event(RAW_KEY))

    versions = world.s3.list_object_versions(Bucket=TEST_BUCKET, Prefix=EXTRACTED_KEY)
    assert [versions.get('Versions', []), versions.get('DeleteMarkers', [])] == [[], []]
    assert 'Item' not in world.projects.get_item(Key=DOC_KEY)


class _Recording:
    """A client or table that records every call in one shared log and answers it from ``answers`` (by method),
    else with nothing."""

    def __init__(self, name: str, calls: list[tuple[str, str, dict[str, Any]]],
                 answers: dict[str, dict[str, Any]] | None = None) -> None:
        self._name = name
        self._calls = calls
        self._answers = answers or {}

    def __getattr__(self, method: str):
        def call(**kwargs: Any) -> dict[str, Any]:
            self._calls.append((self._name, method, kwargs))
            return self._answers.get(method, {})
        return call


@pytest.fixture
def recorded(extractor) -> list[tuple[str, str, dict[str, Any]]]:
    calls: list[tuple[str, str, dict[str, Any]]] = []
    extractor._clients.update({
        's3': _Recording('s3', calls), 'bedrock': _Recording('bedrock', calls),
        f'table:{TEST_PROJECTS_TABLE}': _Recording('projects', calls),
        f'table:{TEST_WORKSPACES_TABLE}': _Recording('workspaces', calls),
    })
    return calls


@pytest.mark.parametrize('key', [pytest.param(rejected['key'], id=rejected['why'])
                                 for rejected in PROJECT_KEYS_SPEC['rejected_keys']])
def test_a_malformed_or_tricked_key_is_refused_before_any_read(extractor, recorded, json_logs, key):
    assert extractor.lambda_handler(_event(key)) == {'processed': 1}

    assert recorded == []
    assert _refusals(json_logs) == ['malformed_key']


@pytest.mark.parametrize('key', [
    EXTRACTED_KEY,
    f'ws/{A}/raw/webhooks/2026/11/15/item.md',
    f'ws/{A}/memory-imports/imp_1.txt',
])
def test_another_workspace_object_is_ignored_quietly(extractor, recorded, json_logs, key):
    extractor.lambda_handler(_event(key))

    assert recorded == []
    assert _refusals(json_logs) == []
    assert [line['message'] for line in json_logs()] == [
        'Ignoring a workspace object - not a product-doc upload', 'invocation_cost']


def _claims_for(workspace: str) -> MagicMock:
    """voc-projects answering every GetItem with a claim naming ``workspace``."""
    table = MagicMock()
    table.get_item.return_value = {'Item': {'workspace_id': workspace}}
    return table


def _failing(message: str) -> MagicMock:
    """A table whose every GetItem fails with ``message``."""
    table = MagicMock()
    table.get_item.side_effect = RuntimeError(message)
    return table


def test_a_claim_that_cannot_be_read_refuses_the_upload(extractor, json_logs):
    extractor._clients[f'table:{TEST_PROJECTS_TABLE}'] = _failing(f'throttled reading {PROJECT}')

    extractor.lambda_handler(_event(RAW_KEY))

    assert _refusals(json_logs) == ['claim_unreadable']
    assert PROJECT not in json.dumps(json_logs())


def test_a_status_that_cannot_be_read_refuses_the_upload(extractor, json_logs):
    extractor._clients.update({f'table:{TEST_PROJECTS_TABLE}': _claims_for(A),
                               f'table:{TEST_WORKSPACES_TABLE}': _failing('throttled')})

    extractor.lambda_handler(_event(RAW_KEY))

    assert _refusals(json_logs) == ['status_unreadable']


def test_no_status_table_refuses_every_workspace_upload(extractor, monkeypatch, json_logs):
    extractor._clients[f'table:{TEST_PROJECTS_TABLE}'] = _claims_for(A)
    monkeypatch.setattr(extractor, 'WORKSPACES_TABLE', '')

    extractor.lambda_handler(_event(RAW_KEY))

    assert _refusals(json_logs) == ['status_unconfigured']


def test_the_deployments_upload_sends_the_requests_it_sent_before(extractor, recorded):
    """Pinned whole: the deployment's text upload reads its record, marks it, reads the object, writes the text and
    marks it ready, and reads no claim and no workspace status."""
    raw, extracted = 'projects/proj_1/product_docs/raw/abc123.md', 'projects/proj_1/product_docs/extracted/abc123.txt'
    key = {'pk': 'PROJECT#proj_1', 'sk': 'PRODUCT_DOC#abc123'}
    condition = {'ConditionExpression': 'attribute_exists(pk) AND #doc_status IN (:s0, :s1)'}
    statuses = {':s0': 'pending', ':s1': 'extracting'}
    extractor._clients.update({
        f'table:{TEST_PROJECTS_TABLE}': _Recording('projects', recorded, {
            'get_item': {'Item': {**key, 'status': 'pending', 'content_type': 'text/plain'}}}),
        's3': _Recording('s3', recorded, {'get_object': {'Body': io.BytesIO(b'notes')}}),
    })

    extractor.lambda_handler(_event(raw, size=5))

    assert recorded == [
        ('projects', 'get_item', {'Key': key}),
        ('projects', 'update_item', {
            'Key': key, 'UpdateExpression': 'SET #k0 = :v0', **condition,
            'ExpressionAttributeNames': {'#k0': 'status', '#doc_status': 'status'},
            'ExpressionAttributeValues': {':v0': 'extracting', **statuses}}),
        ('s3', 'get_object', {'Bucket': TEST_BUCKET, 'Key': raw}),
        ('s3', 'put_object', {'Bucket': TEST_BUCKET, 'Key': extracted, 'Body': b'notes',
                              'ContentType': 'text/plain; charset=utf-8'}),
        ('projects', 'update_item', {
            'Key': key, 'UpdateExpression': 'SET #k0 = :v0, #k1 = :v1, #k2 = :v2, #k3 = :v3', **condition,
            'ExpressionAttributeNames': {'#k0': 'status', '#k1': 'error', '#k2': 's3_extracted_key',
                                         '#k3': 'extracted_chars', '#doc_status': 'status'},
            'ExpressionAttributeValues': {':v0': 'ready', ':v1': None, ':v2': extracted, ':v3': 5, **statuses}}),
    ]
