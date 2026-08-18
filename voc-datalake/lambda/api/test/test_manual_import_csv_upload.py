"""
Tests for the POST /scrapers/manual/csv-upload endpoint and the SQS batch-send
helper in manual_import_handler.py (prd-fix #7 / P9).

Regression intent (fail-on-revert):
- Reverting MAX_JSON_UPLOAD_ITEMS to 500 fails test_upload_cap_is_50000.
- Reverting _send_items_to_sqs to per-item send_message fails the batching tests.
- Removing the /scrapers/manual/csv-upload route fails every TestCsvUploadEndpoint test.
"""
import json
from unittest.mock import patch, MagicMock


def _batch_ok(queue_url, entries):
    """SQS SendMessageBatch stub: everything succeeds."""
    return {'Successful': [{'Id': e['Id']} for e in entries], 'Failed': []}


def _make_sqs(side_effect=None):
    mock_sqs = MagicMock()
    mock_sqs.send_message_batch.side_effect = side_effect or (
        lambda QueueUrl, Entries: _batch_ok(QueueUrl, Entries)
    )
    return mock_sqs


CSV_BASIC = (
    'id,text,rating,date,author,source\n'
    '1,"Great app, fast and reliable",5,2026-01-15,Alice,app_review\n'
    '2,"Login fails on iOS",1,2026-01-16,Bob,app_review\n'
)


class TestUploadCap:
    def test_upload_cap_is_50000(self):
        """The cap raise (500 -> 50000) is the core of prd-fix #7."""
        import manual_import_handler
        assert manual_import_handler.MAX_JSON_UPLOAD_ITEMS == 50000

    def test_csv_size_cap_is_10mb(self):
        import manual_import_handler
        assert manual_import_handler.MAX_CSV_BYTES == 10 * 1024 * 1024


class TestSendItemsToSqs:
    """The batch-send helper — what makes the 50k cap safe within API GW 29s."""

    @patch('manual_import_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/q')
    def test_chunks_into_batches_of_10(self):
        from manual_import_handler import _send_items_to_sqs
        mock_sqs = _make_sqs()
        with patch('manual_import_handler.sqs', mock_sqs):
            imported, errors = _send_items_to_sqs([{'id': str(i)} for i in range(25)])
        assert imported == 25
        assert errors == []
        assert mock_sqs.send_message_batch.call_count == 3  # 10 + 10 + 5
        sizes = [len(c.kwargs['Entries']) for c in mock_sqs.send_message_batch.call_args_list]
        assert sizes == [10, 10, 5]

    @patch('manual_import_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/q')
    def test_reports_partial_batch_failures(self):
        from manual_import_handler import _send_items_to_sqs

        def one_fails(QueueUrl, Entries):
            return {
                'Successful': [{'Id': e['Id']} for e in Entries[1:]],
                'Failed': [{'Id': Entries[0]['Id'], 'Message': 'boom'}],
            }

        mock_sqs = _make_sqs(side_effect=one_fails)
        with patch('manual_import_handler.sqs', mock_sqs):
            imported, errors = _send_items_to_sqs([{'id': str(i)} for i in range(3)])
        assert imported == 2
        assert len(errors) == 1
        assert 'boom' in errors[0]

    @patch('manual_import_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/q')
    def test_reports_whole_batch_exception(self):
        from manual_import_handler import _send_items_to_sqs
        mock_sqs = _make_sqs(side_effect=RuntimeError('sqs down'))
        with patch('manual_import_handler.sqs', mock_sqs):
            imported, errors = _send_items_to_sqs([{'id': '1'}, {'id': '2'}])
        assert imported == 0
        assert len(errors) == 1
        assert 'sqs down' in errors[0]

    @patch('manual_import_handler.PROCESSING_QUEUE_URL', '')
    def test_no_queue_counts_all_as_imported(self):
        """Matches pre-batching json-upload behavior for local/test setups."""
        from manual_import_handler import _send_items_to_sqs
        imported, errors = _send_items_to_sqs([{'id': '1'}, {'id': '2'}])
        assert imported == 2
        assert errors == []


class TestCsvParsing:
    def test_parses_basic_csv(self):
        from manual_import_handler import _parse_csv_to_items
        items, warnings = _parse_csv_to_items(CSV_BASIC, 'csv_upload')
        assert len(items) == 2
        assert warnings == []
        assert items[0]['id'] == '1'
        assert items[0]['text'] == 'Great app, fast and reliable'
        assert items[0]['rating'] == 5
        assert items[0]['source'] == 'app_review'

    def test_accepts_header_synonyms_case_insensitive(self):
        from manual_import_handler import _parse_csv_to_items
        csv_text = 'Review,Stars,User\n"Nice product",4,alice\n'
        items, warnings = _parse_csv_to_items(csv_text, 'my_source')
        assert len(items) == 1
        assert items[0]['text'] == 'Nice product'
        assert items[0]['rating'] == 4
        assert items[0]['author'] == 'alice'
        assert items[0]['source'] == 'my_source'  # default applied

    def test_synthesizes_stable_id_when_missing(self):
        from manual_import_handler import _parse_csv_to_items
        csv_text = 'text\nrow one\nrow two\n'
        items, _ = _parse_csv_to_items(csv_text, 's')
        assert len(items) == 2
        assert items[0]['id'] and items[1]['id']
        assert items[0]['id'] != items[1]['id']
        # deterministic: same input -> same ids
        again, _ = _parse_csv_to_items(csv_text, 's')
        assert [i['id'] for i in again] == [i['id'] for i in items]

    def test_skips_empty_text_and_duplicate_ids_with_warnings(self):
        from manual_import_handler import _parse_csv_to_items
        csv_text = 'id,text\n1,hello\n2,\n1,world\n'
        items, warnings = _parse_csv_to_items(csv_text, 's')
        assert len(items) == 1
        assert any('empty text' in w for w in warnings)
        assert any('duplicate id' in w for w in warnings)

    def test_bad_rating_warns_and_leaves_blank(self):
        from manual_import_handler import _parse_csv_to_items
        csv_text = 'text,rating\nokay,five\n'
        items, warnings = _parse_csv_to_items(csv_text, 's')
        assert items[0]['rating'] is None
        assert any('rating' in w for w in warnings)

    def test_rejects_csv_without_text_column(self):
        from manual_import_handler import _parse_csv_to_items
        from shared.exceptions import ValidationError
        import pytest
        with pytest.raises(ValidationError):
            _parse_csv_to_items('id,rating\n1,5\n', 's')

    def test_handles_quoted_commas_and_embedded_newlines(self):
        from manual_import_handler import _parse_csv_to_items
        csv_text = 'text\n"line one,\nline two"\n'
        items, _ = _parse_csv_to_items(csv_text, 's')
        assert len(items) == 1
        assert 'line one' in items[0]['text'] and 'line two' in items[0]['text']


class TestCsvUploadEndpoint:
    def _post(self, api_gateway_event, body):
        return api_gateway_event(
            method='POST', path='/scrapers/manual/csv-upload', body=body,
        )

    @patch('manual_import_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/q')
    @patch('manual_import_handler.RAW_DATA_BUCKET', 'test-bucket')
    @patch('manual_import_handler.s3')
    def test_successful_csv_upload(self, mock_s3, api_gateway_event, lambda_context):
        from manual_import_handler import lambda_handler
        mock_sqs = _make_sqs()
        with patch('manual_import_handler.sqs', mock_sqs):
            response = lambda_handler(
                self._post(api_gateway_event, {'csv_text': CSV_BASIC}), lambda_context
            )
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['imported_count'] == 2
        assert body['total_rows'] == 2
        assert body['s3_uri'].startswith('s3://test-bucket/raw/csv_upload/')
        # original CSV archived to S3
        put_kwargs = mock_s3.put_object.call_args.kwargs
        assert put_kwargs['Body'] == CSV_BASIC.encode('utf-8')
        assert put_kwargs['ContentType'].startswith('text/csv')
        # message shape matches the processing pipeline contract
        entries = mock_sqs.send_message_batch.call_args.kwargs['Entries']
        msg = json.loads(entries[0]['MessageBody'])
        assert msg['source_platform'] == 'manual_import'
        assert msg['ingestion_method'] == 'csv_upload'
        assert msg['text'] == 'Great app, fast and reliable'
        assert msg['s3_raw_uri'] == body['s3_uri']

    def test_rejects_missing_csv_text(self, api_gateway_event, lambda_context):
        from manual_import_handler import lambda_handler
        response = lambda_handler(self._post(api_gateway_event, {}), lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 400
        assert 'csv_text' in body['error']

    @patch('manual_import_handler.MAX_CSV_BYTES', 10)
    def test_rejects_oversize_csv(self, api_gateway_event, lambda_context):
        from manual_import_handler import lambda_handler
        response = lambda_handler(
            self._post(api_gateway_event, {'csv_text': 'text\n' + 'x' * 100}), lambda_context
        )
        assert response['statusCode'] == 400

    @patch('manual_import_handler.MAX_JSON_UPLOAD_ITEMS', 1)
    def test_rejects_too_many_rows(self, api_gateway_event, lambda_context):
        from manual_import_handler import lambda_handler
        response = lambda_handler(
            self._post(api_gateway_event, {'csv_text': CSV_BASIC}), lambda_context
        )
        body = json.loads(response['body'])
        assert response['statusCode'] == 400
        assert 'Maximum' in body['error']

    def test_rejects_csv_with_no_valid_rows(self, api_gateway_event, lambda_context):
        from manual_import_handler import lambda_handler
        response = lambda_handler(
            self._post(api_gateway_event, {'csv_text': 'text\n\n'}), lambda_context
        )
        assert response['statusCode'] == 400

    @patch('manual_import_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/q')
    @patch('manual_import_handler.RAW_DATA_BUCKET', '')
    def test_warnings_surface_in_response(self, api_gateway_event, lambda_context):
        from manual_import_handler import lambda_handler
        mock_sqs = _make_sqs()
        with patch('manual_import_handler.sqs', mock_sqs):
            response = lambda_handler(
                self._post(api_gateway_event, {'csv_text': 'id,text\n1,hello\n2,\n'}),
                lambda_context,
            )
        body = json.loads(response['body'])
        assert body['imported_count'] == 1
        assert any('empty text' in w for w in body['warnings'])

    @patch('manual_import_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/q')
    @patch('manual_import_handler.RAW_DATA_BUCKET', '')
    def test_default_source_label_applied(self, api_gateway_event, lambda_context):
        from manual_import_handler import lambda_handler
        mock_sqs = _make_sqs()
        with patch('manual_import_handler.sqs', mock_sqs):
            lambda_handler(
                self._post(api_gateway_event, {
                    'csv_text': 'text\nhello\n',
                    'default_source': 'store_reviews',
                }),
                lambda_context,
            )
        entries = mock_sqs.send_message_batch.call_args.kwargs['Entries']
        msg = json.loads(entries[0]['MessageBody'])
        assert msg['source_channel'] == 'store_reviews'
