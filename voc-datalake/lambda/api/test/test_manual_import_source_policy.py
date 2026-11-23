"""Manual import under source profiles: `source_id`, `column_map`, metadata, labels, PII policy."""
import json
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from handler_events_fixtures import call_route

import manual_import_handler as h
from shared import pii_redaction

QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/q'
_PROFILES = [{'id': 'support_tickets', 'pii': 'redact', 'retention_days': 365},
             {'id': 'sales_csv', 'retention_days': 90, 'tags': ['sales']}]


@pytest.fixture
def wired() -> Iterator[MagicMock]:
    table = MagicMock()
    table.get_item.return_value = {'Item': {'sources': _PROFILES}}
    sqs = MagicMock()
    sqs.send_message_batch.side_effect = lambda **kw: {'Successful': [{'Id': e['Id']} for e in kw['Entries']]}
    with patch.object(h, 'aggregates_table', table), patch.object(h, 'sqs', sqs), \
            patch.object(h, 's3') as s3, patch.object(h, 'PROCESSING_QUEUE_URL', QUEUE_URL), \
            patch.object(h, 'RAW_DATA_BUCKET', 'bkt'):
        sqs.s3 = s3
        yield sqs


def _sent(sqs: MagicMock) -> list[dict]:
    return [json.loads(e['MessageBody']) for call in sqs.send_message_batch.call_args_list
            for e in call.kwargs['Entries']]


def _upload(api_gateway_event, lambda_context, path: str, body: dict):
    return call_route(h.lambda_handler, api_gateway_event, lambda_context, method='POST', path=path, body=body)


CSV = 'Body,Customer,Product,Labels,Plan,date\n"Call +49 30 12345678",Jane,app,vip;beta,pro,2026-01-02\n'
MAP = {'Body': 'text', 'Customer': 'author', 'Product': 'dimension:product', 'Labels': 'tags'}


def test_csv_redact_source_redacts_drops_author_and_archives_nothing(wired, api_gateway_event, lambda_context):
    response, body = _upload(api_gateway_event, lambda_context, '/scrapers/manual/csv-upload',
                             {'csv_text': CSV, 'source_id': 'support_tickets', 'column_map': MAP})
    assert (response['statusCode'], body['s3_uri']) == (200, None)
    [message] = _sent(wired)
    assert (message['text'], message['source_platform'], message['pii_policy_applied']) == \
        ('Call [PHONE]', 'support_tickets', 'redact')
    assert 'author' not in message
    assert (message['dimensions'], message['tags'], message['metadata']) == \
        ({'product': 'app'}, ['vip', 'beta'], {'Plan': 'pro'})
    wired.s3.put_object.assert_not_called()


def test_a_large_csv_upload_under_a_redacting_source_calls_no_entity_model(wired, api_gateway_event, lambda_context,
                                                                           monkeypatch):
    """Review round 1 (the csv-upload sibling of Q1): a reviews or tickets row names no language, so its redaction is
    the patterns alone, never Comprehend, even with PII_COMPREHEND=1: no per-call text budget is needed here (the
    survey import's rows do name their form's language, hence its 250-text bound)."""
    from shared import pii_redaction

    monkeypatch.setenv('PII_COMPREHEND', '1')
    rows = '\n'.join(f'"Ticket {n}: call +49 30 1234{n:04d}",Jane,app,vip,pro,2026-01-02' for n in range(1000))
    with patch.object(pii_redaction, '_redact_entities', side_effect=AssertionError('Comprehend called')) as model:
        response, body = _upload(api_gateway_event, lambda_context, '/scrapers/manual/csv-upload',
                                 {'csv_text': f'Body,Customer,Product,Labels,Plan,date\n{rows}\n',
                                  'source_id': 'support_tickets', 'column_map': MAP})
    assert (response['statusCode'], body['imported_count']) == (200, 1000)
    model.assert_not_called()
    assert all('[PHONE]' in message['text'] for message in _sent(wired))


def test_csv_retention_source_archives_per_item(wired, api_gateway_event, lambda_context):
    _upload(api_gateway_event, lambda_context, '/scrapers/manual/csv-upload',
            {'csv_text': CSV, 'source_id': 'sales_csv', 'column_map': MAP})
    [message] = _sent(wired)
    assert message['s3_raw_uri'].startswith('s3://bkt/raw/sales_csv/')
    assert message['author'] == 'Jane'
    assert wired.s3.put_object.call_args.kwargs['Key'].startswith('raw/sales_csv/')


@pytest.mark.parametrize(('body', 'needle'), [
    ({'csv_text': CSV, 'source_id': 'unknown_src', 'column_map': MAP}, 'Unknown source_id'),
    ({'csv_text': CSV, 'column_map': {'Body': 'bogus'}}, 'is not one of'),
])
def test_csv_refusals_are_400(wired, api_gateway_event, lambda_context, body, needle):
    response, payload = _upload(api_gateway_event, lambda_context, '/scrapers/manual/csv-upload', body)
    assert response['statusCode'] == 400
    assert needle in json.dumps(payload)
    assert _sent(wired) == []


def test_json_upload_carries_dimensions_tags_and_the_source(wired, api_gateway_event, lambda_context):
    item = {'id': 'i1', 'text': 'hello', 'source': 'web', 'timestamp': '2026-01-02T00:00:00Z',
            'dimensions': {'product': 'web', 'bad key': 'x'}, 'tags': ['a', 'A']}
    response, _ = _upload(api_gateway_event, lambda_context, '/scrapers/manual/json-upload',
                          {'items': [item], 'source_id': 'sales_csv'})
    [message] = _sent(wired)
    assert response['statusCode'] == 200
    assert (message['source_platform'], message['dimensions'], message['tags']) == \
        ('sales_csv', {'product': 'web'}, ['a'])


def _comprehend_failing_on(word: str) -> MagicMock:
    """A Comprehend client that throttles (past its retries) on a text with ``word`` and finds nothing elsewhere."""
    def detect(**request: str) -> dict:
        if word in request['Text']:
            raise ClientError({'Error': {'Code': 'ThrottlingException'}}, 'DetectPiiEntities')
        return {'Entities': []}

    client = MagicMock()
    client.detect_pii_entities.side_effect = detect
    return client


def test_a_redacting_upload_refuses_a_row_comprehend_could_not_read_and_counts_it_skipped(wired, api_gateway_event,
                                                                                         lambda_context):
    """F1 (7.71.02): every redacting upload's redaction is strict, as the form import's: a row whose text Comprehend
    should have read and could not (every text read as English here, as a row that named its language would be) is
    refused and counted with the skipped rows, never queued with the patterns' redaction alone; the others are."""
    items = [{'id': f'i{n}', 'text': text, 'source': 'web', 'timestamp': '2026-01-02T00:00:00Z'}
             for n, text in enumerate(['Call +49 30 12345678', 'unreadable by the model'])]
    with patch.object(pii_redaction, 'comprehend_language', return_value='en'), \
            patch.object(pii_redaction, '_comprehend', return_value=_comprehend_failing_on('unreadable')), \
            patch.object(h, '_record_run') as recorded:
        response, body = _upload(api_gateway_event, lambda_context, '/scrapers/manual/json-upload',
                                 {'items': items, 'source_id': 'support_tickets'})
    assert (response['statusCode'], body['imported_count'], body['total_items']) == (200, 1, 2)
    assert [(message['id'], message['text']) for message in _sent(wired)] == [('i0', 'Call [PHONE]')]
    counts = recorded.call_args.args[3]
    assert (counts.received, counts.imported, counts.skipped) == (2, 1, 1)
