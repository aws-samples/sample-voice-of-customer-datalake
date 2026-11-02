"""Feedback boards keep a raw copy of what people file (shared/feature_requests_raw.py).

A request on create and on every content edit, a +1 on create and on every edit; write-once
versions under raw/feature_requests/, policy-gated, and never queued into voc-feedback.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest
from engagement_fixtures import ADMIN, BOARD, BOARD_2, engagement_world, ok

from shared.participants_settings import SETTINGS_KEY
from shared.test.raw_lake_fixtures import RAW_BUCKET, raw_keys, raw_lake_client
from shared.test.source_profile_fixtures import seeded_source_profiles

BUCKET = RAW_BUCKET


@pytest.fixture
def world() -> Iterator[tuple[Any, Any]]:
    with engagement_world() as w, seeded_source_profiles(), raw_lake_client() as s3:
        w.participants.put_item(Item={**SETTINGS_KEY, 'company_domains': ['acme.example']})
        yield w, s3


def _objects(s3: Any) -> dict[str, dict]:
    keys = raw_keys(s3)
    return {key: json.loads(s3.get_object(Bucket=BUCKET, Key=key)['Body'].read()) for key in keys}


def _file(ctx: Any) -> dict:
    body = {'title': 'SSO with SAML', 'description': 'Needed for the enterprise tier', 'customer': 'Acme',
            'impact': 'at_risk', 'amount_usd': 120_000, 'name': 'Sam Seller'}
    return ok(ctx, 'POST', '/feature-requests', 201, claims=BOARD, body=body)


def _in_folder(objects: dict[str, dict], stem: str) -> list[dict]:
    return [content for key, content in objects.items() if key.split('/')[5] == stem]


def test_a_new_request_keeps_the_request_and_the_reporters_plus_one(world, lambda_context):
    _, s3 = world
    created = _file(lambda_context)
    request_id = created['request']['request_id']
    support_id = created['supports'][0]['support_id']

    objects = _objects(s3)
    assert all(key.startswith('raw/feature_requests/') for key in objects)
    [request] = _in_folder(objects, request_id)
    assert request['title'] == 'SSO with SAML'
    assert request['reporter_email'] == 'sam@acme.example'
    # What the person filed, not the row's bookkeeping or the triage state.
    assert not {'status', 'totals', 'version', 'pk', 'gsi1pk'} & request.keys()
    [support] = _in_folder(objects, support_id)
    assert support['email'] == 'sam@acme.example'
    assert 'pk' not in support
    meta = s3.head_object(Bucket=BUCKET, Key=next(iter(objects)))['Metadata']
    assert meta == {'connector': 'feature_requests', 'connector-version': '9.1.0'}


def test_an_edit_is_a_new_version_and_a_status_change_is_not(world, lambda_context):
    _, s3 = world
    request_id = _file(lambda_context)['request']['request_id']

    ok(lambda_context, 'PUT', f'/feature-requests/{request_id}', claims=BOARD, body={'title': 'SAML SSO'})
    ok(lambda_context, 'PUT', f'/feature-requests/{request_id}/status', claims=ADMIN,
       body={'status': 'under_review'})

    titles = sorted(content['title'] for content in _in_folder(_objects(s3), request_id))
    assert titles == ['SAML SSO', 'SSO with SAML']


def test_a_plus_one_and_its_edit_are_kept(world, lambda_context):
    _, s3 = world
    request_id = _file(lambda_context)['request']['request_id']
    body = {'customer': 'Example Air', 'impact': 'committed', 'amount_usd': 50_000, 'name': 'Kim'}
    support = ok(lambda_context, 'POST', f'/feature-requests/{request_id}/supports', 201, claims=BOARD_2,
                 body=body)['support']
    ok(lambda_context, 'PUT', f'/feature-requests/{request_id}/supports/{support["support_id"]}', claims=BOARD_2,
       body={**body, 'amount_usd': 60_000})

    versions = _in_folder(_objects(s3), support['support_id'])
    assert sorted(str(v['amount_usd']) for v in versions) == ['50000', '60000']
    assert {v['email'] for v in versions} == {'kim@acme.example'}


def test_a_redact_profile_keeps_no_copy(world, lambda_context):
    _, s3 = world
    with seeded_source_profiles([{'id': 'feature_requests', 'label': 'Boards', 'pii': 'redact'}]):
        _file(lambda_context)
    assert _objects(s3) == {}
