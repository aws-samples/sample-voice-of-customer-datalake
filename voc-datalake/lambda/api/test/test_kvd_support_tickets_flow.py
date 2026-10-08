"""Cross-track: one restricted `support_tickets` CSV upload from ingestion to deletion.

Each track tested its own half; this chains them on the SAME data so a contract
drift between tracks fails here (docs/source-policies.md, docs/dimensions.md):

1. manual import (A2) applies the profile before anything is archived or queued;
2. the processor (A1) stores that message under the profile's policy;
3. metrics (A1) shows the stored item only to callers the source rule admits (A2),
   and a source-restricted caller is served from items, never from counters;
4. the retention worker (A2) deletes it once it is past the profile's retention,
   and nothing else.

Profile: `support_tickets` = pii redact, restricted, retention 365. By the contract
(`raw_archive_allowed` = pii allow) a redact source keeps NO raw copy at all — the
redacted message is what travels — so step 1 asserts the archive is absent.
"""
import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from unittest.mock import MagicMock, patch

import boto3
import pytest
from handler_events_fixtures import call_route
from moto import mock_aws

import manual_import_handler
import metrics_handler
from jobs.retention import handler as retention
from processor import handler as processor
from shared.api import clear_categories_cache
from shared.category_access import access_key
from shared.test.moto_tables import create_pk_sk_table

TODAY = datetime.now(UTC).strftime('%Y-%m-%d')
SUPPORT = {'id': 'support_tickets', 'label': 'Support tickets', 'pii': 'redact', 'restricted': True,
           'retention_days': 365}
PROFILES_ROW = {'pk': 'SETTINGS#sources', 'sk': 'config', 'sources': [SUPPORT, {'id': 'sales_csv'}]}
DIMENSIONS = [
    {'key': 'product', 'label': 'Product', 'infer': False, 'values': [{'name': 'app'}, {'name': 'web'}]},
    {'key': 'module', 'label': 'Module', 'infer': False, 'parent': 'product',
     'values': [{'name': 'checkout', 'parent_value': 'app'}]},
]
DIMENSIONS_ROW = {'pk': 'SETTINGS#dimensions', 'sk': 'config', 'dimensions': DIMENSIONS}
CSV = ('Ticket,Customer,Product,Module,Plan\n'
       '"Card declined, call me on +49 30 12345678 or jane@example.com",Jane Doe,app,checkout,pro\n')
COLUMN_MAP = {'Ticket': 'text', 'Customer': 'author', 'Product': 'dimension:product',
              'Module': 'dimension:module'}
VIEWER = {'sub': 'sub-viewer', 'cognito:groups': 'users'}
SUPPORT_LEAD = {'sub': 'sub-lead', 'cognito:groups': 'users'}


# ── 1 + 2: ingestion, then the processor, on the same message ──

def _ingested_message(api_gateway_event, lambda_context) -> tuple[dict, MagicMock]:
    aggregates = MagicMock()
    aggregates.get_item.return_value = {'Item': PROFILES_ROW}
    sqs = MagicMock()
    sqs.send_message_batch.side_effect = lambda **kw: {'Successful': [{'Id': e['Id']} for e in kw['Entries']]}
    with patch.object(manual_import_handler, 'aggregates_table', aggregates), \
            patch.object(manual_import_handler, 'sqs', sqs), patch.object(manual_import_handler, 's3') as s3, \
            patch.object(manual_import_handler, 'PROCESSING_QUEUE_URL', 'https://sqs/q'), \
            patch.object(manual_import_handler, 'RAW_DATA_BUCKET', 'bkt'):
        response, body = call_route(manual_import_handler.lambda_handler, api_gateway_event, lambda_context,
                                    method='POST', path='/scrapers/manual/csv-upload',
                                    body={'csv_text': CSV, 'source_id': 'support_tickets', 'column_map': COLUMN_MAP})
    assert (response['statusCode'], body['s3_uri']) == (200, None)
    [entry] = [e for call in sqs.send_message_batch.call_args_list for e in call.kwargs['Entries']]
    return json.loads(entry['MessageBody']), s3


def _processed(message: dict) -> dict:
    llm = {'insights': {'category': 'billing', 'subcategory': None, 'sentiment_label': 'negative',
                        'sentiment_score': -0.7, 'urgency': 'high',
                        'problem_summary': 'Card declined', 'direct_customer_quote': 'Card declined'},
           'metadata': {}}
    processor._settings_cache.update({'dimensions': (float('inf'), DIMENSIONS),
                                      'sources': (float('inf'), PROFILES_ROW['sources'])})
    try:
        with patch.object(processor, 'check_duplicate', return_value=False), \
                patch.object(processor, 'detect_language', return_value='en'), \
                patch.object(processor, 'translate_text', side_effect=lambda text, *_: text), \
                patch.object(processor, 'get_comprehend_sentiment', return_value={'label': 'negative', 'score': -0.7}), \
                patch.object(processor, 'invoke_bedrock_llm', return_value=llm), \
                patch.object(processor, 'get_categories_config', return_value=[{'name': 'billing'}]):
            item = processor.process_feedback(message)
    finally:
        processor._settings_cache.clear()
    assert item is not None, 'the processor dropped the ticket'
    return item


@pytest.fixture
def stored_ticket(api_gateway_event, lambda_context) -> dict:
    """The support ticket as the processor stores it, after a real CSV upload."""
    message, _ = _ingested_message(api_gateway_event, lambda_context)
    return _processed(message)


class TestIngestionToStorage:
    def test_the_upload_redacts_drops_the_author_and_archives_nothing(self, api_gateway_event, lambda_context):
        message, s3 = _ingested_message(api_gateway_event, lambda_context)
        assert (message['source_platform'], message['pii_policy_applied']) == ('support_tickets', 'redact')
        assert message['text'] == 'Card declined, call me on [PHONE] or [EMAIL]'
        assert ('author' not in message, message['dimensions']) == (True, {'product': 'app', 'module': 'checkout'})
        s3.put_object.assert_not_called()

    def test_the_processor_stores_the_policy_dimensions_and_no_personal_data(self, stored_ticket):
        assert (stored_ticket['pk'], stored_ticket['pii_policy']) == ('SOURCE#support_tickets', 'redact')
        assert stored_ticket['dimensions'] == {'product': 'app', 'module': 'checkout'}
        assert stored_ticket['dimension_sources'] == {'product': 'source', 'module': 'source'}
        stored = json.dumps(stored_ticket, default=str)
        assert ('author' not in stored_ticket, 'jane' in stored.lower(), '12345678' in stored) == (True, False, False)


# ── 3: who sees it ──

def _sales_item() -> dict:
    return {'pk': 'SOURCE#sales_csv', 'sk': 'FEEDBACK#s1', 'feedback_id': 's1', 'source_platform': 'sales_csv',
            'date': TODAY, 'category': 'billing', 'sentiment_label': 'positive', 'sentiment_score': Decimal('0.8'),
            'urgency': 'low', 'original_text': 'Great sales call', 'dimensions': {'product': 'web'}}


@pytest.fixture
def metrics_tables(stored_ticket) -> Iterator[tuple[MagicMock, MagicMock]]:
    ticket = {**stored_ticket, 'date': TODAY}
    items = [ticket, _sales_item()]
    feedback = MagicMock()

    def query(**kwargs):
        values = kwargs['KeyConditionExpression'].get_expression()['values']
        if kwargs.get('IndexName') == 'gsi4-by-feedback-id':
            return {'Items': [i for i in items if i['feedback_id'] == values[1]]}
        return {'Items': list(items), 'ScannedCount': len(items)}

    feedback.query.side_effect = query
    feedback.get_item.side_effect = lambda Key, **_: {'Item': next(i for i in items if i['sk'] == Key['sk'])}
    rows = {(r['pk'], r['sk']): r for r in [
        PROFILES_ROW, DIMENSIONS_ROW,
        {**access_key(SUPPORT_LEAD['sub']), 'categories': ['*'], 'sources': ['support_tickets']},
    ]}
    aggregates = MagicMock()
    aggregates.get_item.side_effect = lambda Key, **_: {'Item': rows[(Key['pk'], Key['sk'])]} \
        if (Key['pk'], Key['sk']) in rows else {}
    aggregates.query.return_value = {'Items': []}
    clear_categories_cache()
    metrics_handler.app.clear_context()
    with patch('metrics_handler.feedback_table', feedback), patch('metrics_handler.aggregates_table', aggregates):
        yield feedback, aggregates
    clear_categories_cache()


def _get(api_gateway_event, lambda_context, path: str, claims: dict, **params: str):
    return call_route(metrics_handler.lambda_handler, api_gateway_event, lambda_context, method='GET', path=path,
                      query_params={'days': '1', **params}, claims=claims)


@pytest.mark.usefixtures('metrics_tables')
class TestSourceAccessAcrossRoutes:
    @pytest.mark.parametrize(('claims', 'sees_ticket'), [(VIEWER, False), (SUPPORT_LEAD, True)])
    def test_feedback_list(self, api_gateway_event, lambda_context, stored_ticket, claims, sees_ticket):
        # The lead's grant is exactly ['support_tickets'], so it excludes the sales item.
        _, body = _get(api_gateway_event, lambda_context, '/feedback', claims)
        expected = [stored_ticket['feedback_id']] if sees_ticket else ['s1']
        assert [item['feedback_id'] for item in body['items']] == expected

    @pytest.mark.parametrize(('claims', 'status'), [(VIEWER, 404), (SUPPORT_LEAD, 200)])
    def test_feedback_by_id(self, api_gateway_event, lambda_context, stored_ticket, claims, status):
        response, _ = _get(api_gateway_event, lambda_context, f"/feedback/{stored_ticket['feedback_id']}", claims)
        assert response['statusCode'] == status

    @pytest.mark.parametrize(('claims', 'app_count'), [(VIEWER, 0), (SUPPORT_LEAD, 1)])
    def test_dimension_metrics(self, api_gateway_event, lambda_context, claims, app_count):
        _, body = _get(api_gateway_event, lambda_context, '/metrics/dimensions', claims, key='product')
        assert body['values']['app']['count'] == app_count

    @pytest.mark.parametrize(('claims', 'expected'), [
        (VIEWER, {'product': {'web': 1}, 'module': {}}),
        (SUPPORT_LEAD, {'product': {'app': 1}, 'module': {'checkout': 1}}),
    ])
    def test_entities(self, api_gateway_event, lambda_context, claims, expected):
        _, body = _get(api_gateway_event, lambda_context, '/feedback/entities', claims)
        assert body['entities']['dimensions'] == expected

    @pytest.mark.parametrize('path', ['/metrics/summary', '/metrics/dimensions', '/feedback/entities'])
    def test_a_source_restricted_caller_is_served_from_items(self, metrics_tables, api_gateway_event,
                                                            lambda_context, path):
        feedback, aggregates = metrics_tables
        _get(api_gateway_event, lambda_context, path, VIEWER, key='product')
        feedback.query.assert_called()
        metric_reads = [c for c in aggregates.query.call_args_list if 'METRIC#' in repr(c.kwargs)]
        assert metric_reads == []


# ── 4: retention ──

@pytest.fixture
def retention_tables() -> Iterator[dict]:
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='bkt')
        tables = {'feedback': create_pk_sk_table(retention.FEEDBACK_TABLE, resource),
                  'aggregates': create_pk_sk_table(retention.AGGREGATES_TABLE, resource)}
        tables['aggregates'].put_item(Item=PROFILES_ROW)
        with patch.object(retention, 'get_dynamodb_resource', return_value=resource), \
                patch.object(retention, 'get_s3_client', return_value=s3), \
                patch.object(retention, 'RAW_DATA_BUCKET', 'bkt'):
            yield tables


def _days_ago(days: int) -> str:
    return (datetime.now(UTC).date() - timedelta(days=days)).isoformat()


def test_retention_deletes_only_the_expired_ticket(retention_tables, stored_ticket):
    feedback = retention_tables['feedback']
    feedback.put_item(Item={**stored_ticket, 'date': _days_ago(400)})
    feedback.put_item(Item={**stored_ticket, 'sk': 'FEEDBACK#fresh', 'feedback_id': 'fresh', 'date': _days_ago(10)})
    feedback.put_item(Item={**_sales_item(), 'date': _days_ago(4000)})
    context = MagicMock(function_name='voc-retention')
    context.get_remaining_time_in_millis.return_value = 900_000
    result = retention.handle_event({'mode': 'retention'}, context)
    assert (result['status'], result['deleted_items']) == ('completed', 1)
    assert {i['feedback_id'] for i in feedback.scan()['Items']} == {'fresh', 's1'}
