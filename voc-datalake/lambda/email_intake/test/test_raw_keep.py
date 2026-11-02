"""Raw copies of received mail (email_intake/raw_keep.py): only for a raw-permitted email source."""
from __future__ import annotations

from typing import Any

import pytest

from email_intake.test.conftest import BUCKET, fixture_bytes, queued, run
from shared.test.source_profile_fixtures import seeded_source_profiles

RAW = 'test-raw-lake'
ALLOW = [{'id': 'email_intake', 'label': 'Email', 'pii': 'allow'}]


def _raw_objects(aws: Any) -> list[str]:
    return [o['Key'] for o in aws['s3'].list_objects_v2(Bucket=RAW).get('Contents', [])]


@pytest.fixture
def lake(aws: Any, ctx: Any) -> Any:
    aws['s3'].create_bucket(Bucket=RAW)
    ctx.raw_bucket = RAW
    return ctx


def test_by_default_the_redact_inbox_keeps_no_raw_copy(aws, lake):
    run(aws, lake, 'new.eml')
    assert _raw_objects(aws) == []
    assert 's3_raw_uri' not in queued(aws)[0]


def test_an_allowed_source_keeps_the_email_as_received_and_the_item_points_at_it(aws, lake, monkeypatch):
    monkeypatch.setenv('APP_VERSION', '9.1.0')
    with seeded_source_profiles(ALLOW):
        outcome = run(aws, lake, 'new.eml')
    [key] = _raw_objects(aws)
    assert key.startswith('raw/email_intake/')
    assert key.split('/')[5] == outcome.item_id
    assert key.endswith('.eml')
    obj = aws['s3'].get_object(Bucket=RAW, Key=key)
    assert obj['Body'].read() == fixture_bytes('new.eml')
    assert obj['ContentType'] == 'message/rfc822'
    assert obj['Metadata'] == {'connector': 'email_intake', 'connector-version': '9.1.0'}
    assert queued(aws)[0]['s3_raw_uri'] == f's3://{RAW}/{key}'


def test_filtered_mail_is_kept_with_its_drop_reason(aws, lake):
    resent = fixture_bytes('new.eml').replace(b'Message-ID: <', b'Message-ID: <resent-')
    with seeded_source_profiles(ALLOW):
        run(aws, lake, 'new.eml')
        outcome = run(aws, lake, 'resent.eml', raw=resent)
    assert outcome.reason == 'seen_in_thread'
    kept = {key: aws['s3'].head_object(Bucket=RAW, Key=key)['Metadata'] for key in _raw_objects(aws)}
    assert sorted(meta.get('drop-reason', '') for meta in kept.values()) == ['', 'seen_in_thread']


def test_spam_is_never_kept(aws, lake):
    with seeded_source_profiles(ALLOW):
        outcome = run(aws, lake, 'spam_fail.eml')
    assert outcome.status == 'dropped'
    assert _raw_objects(aws) == []


def test_the_inbox_bucket_is_untouched_by_the_raw_copy(aws, lake):
    with seeded_source_profiles(ALLOW):
        outcome = run(aws, lake, 'new.eml')
    keys = [o['Key'] for o in aws['s3'].list_objects_v2(Bucket=BUCKET).get('Contents', [])]
    assert f'inbound-raw/{outcome.item_id}/message.eml' in keys
