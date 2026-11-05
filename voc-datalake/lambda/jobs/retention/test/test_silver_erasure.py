"""voc-retention reaches the kept Silver versions (TENETS.md D5): ``silver/{source}/{feedback_id}/``.

An in-place change keeps the item as it was (``shared/silver_provenance.py``). Those versions are
copies of the customer's data, so an erasure or a retention delete of the item deletes every one of
them (every object version), and a whole-source erasure sweeps what is left under ``silver/{source}/``.
"""
from typing import Any

from jobs.retention import handler
from jobs.retention.test.conftest import BUCKET, days_ago
from shared.digests import sha256_hex
from shared.retention import silver_source_prefix

JOB_ID = 'er_00000000beef'
BASIS = 'GDPR art. 17 request #456'


def _feedback(aws, feedback_id: str, source: str = 'web', **extra: Any) -> None:
    aws['feedback'].put_item(Item={'pk': f'SOURCE#{source}', 'sk': f'FEEDBACK#{feedback_id}',
                                   'feedback_id': feedback_id, 'source_id': feedback_id, 'source_platform': source,
                                   'date': days_ago(1), **extra})


def _kept_version(aws, source: str, feedback_id: str, name: str = '20260101T000000000000Z-0a0b0c0d') -> str:
    key = f'silver/{source}/{feedback_id}/{name}.json'
    aws['s3'].put_object(Bucket=BUCKET, Key=key, Body=b'{"item": {"author": "Jane"}}')
    return key


def _job(aws, field: str, value: str, source: str | None = None) -> dict:
    aws['aggregates'].put_item(Item={
        'pk': 'JOB#erasure', 'sk': JOB_ID, 'job_id': JOB_ID, 'status': 'queued', 'field': field,
        'value_hash': sha256_hex(value), 'legal_basis': BASIS, **({'source': source} if source else {})})
    return {'mode': 'erase', 'job_id': JOB_ID, 'value': value}


def _versions(aws) -> set[str]:
    page = aws['s3'].list_object_versions(Bucket=BUCKET, Prefix='silver/')
    return {entry['Key'] for entry in [*page.get('Versions', []), *page.get('DeleteMarkers', [])]}


def test_an_erased_item_takes_every_kept_version_with_it(aws, worker_context):
    _feedback(aws, 'f1', author='Jane')
    _feedback(aws, 'f2', author='John')
    first = _kept_version(aws, 'web', 'f1')
    aws['s3'].put_object(Bucket=BUCKET, Key=first, Body=b'{"second": "version"}')  # two object versions
    _kept_version(aws, 'web', 'f1', '20260102T000000000000Z-1a1b1c1d')
    other = _kept_version(aws, 'web', 'f2')

    handler.handle_event(_job(aws, 'author', 'Jane'), worker_context)

    assert _versions(aws) == {other}


def test_a_retention_delete_takes_the_kept_versions_too(aws, worker_context):
    aws['aggregates'].put_item(Item={'pk': 'SETTINGS#sources', 'sk': 'config', 'sources': [
        {'id': 'web', 'label': 'Web', 'retention_days': 30, 'retention_legal_basis': BASIS}]})
    _feedback(aws, 'old', date=days_ago(400))
    _kept_version(aws, 'web', 'old')

    handler.handle_event({'mode': 'retention'}, worker_context)

    assert _versions(aws) == set()


def test_a_whole_source_erasure_sweeps_silver_of_that_source_only(aws, worker_context):
    _feedback(aws, 'f1')
    _kept_version(aws, 'web', 'f1')
    orphan = _kept_version(aws, 'web', 'gone-already')
    kept_elsewhere = _kept_version(aws, 'web_shop', 'f9')

    handler.handle_event(_job(aws, 'source', 'web', source='web'), worker_context)

    assert orphan not in _versions(aws)
    assert _versions(aws) == {kept_elsewhere}


def test_the_silver_prefix_of_a_source():
    assert silver_source_prefix('web') == 'silver/web/'
    assert silver_source_prefix('a/b') is None
    assert silver_source_prefix('') is None
