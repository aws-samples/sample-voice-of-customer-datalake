"""A CSV dataset upload end to end under a redact source (issue #411 security review).

The real manual-import handler (preview, upload, confirmed update) and the real processor
`record_handler` share one moto feedback table: every message the upload queues is delivered
to the processor, so the digest the preview compares is the one the processor stored.
"""
import json
from collections.abc import Iterator
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest

import manual_import_handler as h
from processor import handler as processor
from processor.test.test_csv_updates import deliver, items, world
from processor.test.test_source_updates import insights
from shared.csv_datasets import dataset_key

DATASET = 'Example Air Q3'
REDACT_PROFILE = {'id': 'manual_import', 'label': 'Manual import', 'pii': 'redact', 'retention_days': None}
FIRST = 'id,text,author\n4711,teh app crashes - write to ann@example.com,Ann\n'
ONLY_PII_CHANGED = 'id,text,author\n4711,teh app crashes - write to bob@example.com,Bob\n'
CORRECTED = 'id,text,author\n4711,the app crashes - write to ann@example.com,Ann\n'


@pytest.fixture(autouse=True)
def _processor_settings_seeded() -> Iterator[None]:
    """No dimensions, no source profiles for the processor (as processor/test/conftest.py seeds them)."""
    seeded = (float('inf'), [])
    processor._settings_cache.clear()
    processor._settings_cache.update({'dimensions': seeded, 'sources': seeded})
    processor._failed_settings.clear()
    yield
    processor._settings_cache.clear()
    processor._failed_settings.clear()


@contextmanager
def platform() -> Iterator[tuple[object, MagicMock]]:
    """The processor's moto world with the upload Lambda wired to the same feedback table."""
    with world([insights(), insights('performance', -0.9, 'high')]) as (feedback, _llm):
        sqs = MagicMock()
        sqs.send_message_batch.side_effect = lambda Entries, **_kw: {
            'Successful': [{'Id': e['Id']} for e in Entries], 'Failed': []}
        with patch.object(h, 'feedback_table', feedback), patch.object(h, 'sqs', sqs), \
             patch.object(h, 'PROCESSING_QUEUE_URL', 'https://sqs.example.com/q'), \
             patch.object(h, 'RAW_DATA_BUCKET', ''), \
             patch('manual_import_handler.upload_profile', return_value=REDACT_PROFILE):
            yield feedback, sqs


def _upload(event, context, csv_text: str, **extra) -> tuple[int, dict]:
    body = {'csv_text': csv_text, 'dataset_name': DATASET, **extra}
    response = h.lambda_handler(event(method='POST', path='/scrapers/manual/csv-upload', body=body), context)
    return response['statusCode'], json.loads(response['body'])


def _drain(sqs: MagicMock) -> list[dict]:
    """Deliver every queued message to the processor, once; the messages."""
    messages = [json.loads(e['MessageBody']) for c in sqs.send_message_batch.call_args_list for e in c.kwargs['Entries']]
    sqs.send_message_batch.reset_mock()
    for message in messages:
        deliver(message)
    return messages


def test_a_redact_dataset_upload_previews_updates_and_stores_without_a_pii_confirming_digest(
        api_gateway_event, lambda_context):
    with platform() as (feedback, sqs):
        assert _upload(api_gateway_event, lambda_context, FIRST)[0] == 200
        (first,) = _drain(sqs)
        (stored,) = items(feedback)

        # Stored redacted, and the digest is not the one of the file's own (PII-bearing) values.
        assert 'ann@example.com' not in stored['original_text']
        assert 'author' not in stored
        assert stored['csv_content_hash'] == first['csv_content_hash']
        (allow_item,), _ = h._parse_csv_to_items(FIRST, 'csv_upload', None, dataset_key(DATASET))
        assert stored['csv_content_hash'] != allow_item['content_hash']

        # The same file, and one that changes only redacted PII, preview as unchanged (the trade-off).
        for csv_text in (FIRST, ONLY_PII_CHANGED):
            status, preview = _upload(api_gateway_event, lambda_context, csv_text, dry_run=True)
            assert (status, preview['counts']['unchanged'], preview['counts']['changed']) == (200, 1, 0)

        # A correction of what is stored previews as changed, is refused until confirmed, then applied in place.
        status, preview = _upload(api_gateway_event, lambda_context, CORRECTED, dry_run=True)
        assert (status, preview['counts']['changed']) == (200, 1)
        assert _upload(api_gateway_event, lambda_context, CORRECTED)[0] == 409
        assert _upload(api_gateway_event, lambda_context, CORRECTED, apply_updates=True)[0] == 200
        (correction,) = _drain(sqs)
        (updated,) = items(feedback)

    assert correction['csv_replace'] is True
    assert updated['original_text'].startswith('the app crashes')
    assert 'ann@example.com' not in updated['original_text']
    assert updated['csv_content_hash'] == correction['csv_content_hash'] != stored['csv_content_hash']
    assert updated['sk'] == stored['sk']
