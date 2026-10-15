"""
Tests for the POST /scrapers/manual/csv-upload endpoint and the SQS batch-send
helper in manual_import_handler.py (prd-fix #7 / P9).

Regression intent (fail-on-revert):
- Reverting MAX_JSON_UPLOAD_ITEMS to 500 fails test_upload_cap_is_50000.
- Reverting _send_items_to_sqs to per-item send_message fails the batching tests.
- Removing the /scrapers/manual/csv-upload route fails every TestCsvUploadEndpoint test.
- Reusing an explicit source ID for different CSV rows must not collapse them.
- Exact re-uploads and row reordering must preserve deterministic row IDs.
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


# Identity of CSV_BASIC's first row under the frozen `csv-row-v1` recipe.
# This is a PINNED CONTRACT VALUE, not a computed expectation: rows already
# stored in DynamoDB were keyed with it. If a change makes this assertion fail,
# the fix is to add a new version tag in CSV_ROW_ID_FIELDS — NOT to recompute
# this constant, which would silently re-key every previously imported row.
CSV_BASIC_ROW1_ID = 'e29470dc28b81c8147604603dc0d73d5'


class TestCsvParsing:
    def test_parses_basic_csv(self):
        from manual_import_handler import _parse_csv_to_items
        items, warnings = _parse_csv_to_items(CSV_BASIC, 'csv_upload')
        assert len(items) == 2
        assert warnings == []
        assert items[0]['id'] == CSV_BASIC_ROW1_ID
        assert items[0]['text'] == 'Great app, fast and reliable'
        assert items[0]['rating'] == 5
        assert items[0]['source'] == 'app_review'

    def test_row_id_recipe_field_order_is_frozen(self):
        """The persisted contract: order changes re-key every prior upload."""
        from manual_import_handler import CSV_ROW_ID_FIELDS, CSV_ROW_ID_VERSION
        assert CSV_ROW_ID_VERSION == 'csv-row-v1'
        assert CSV_ROW_ID_FIELDS == (
            'source_id', 'row_index', 'text', 'rating',
            'created_at', 'author', 'title', 'url', 'source',
        )

    def test_row_id_raises_when_a_contract_field_is_missing(self):
        import pytest
        from manual_import_handler import _csv_row_id
        with pytest.raises(KeyError):
            _csv_row_id({'source_id': '1', 'text': 'hello'})

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
        # deterministic: same input -> same ids, even though missing dates use now
        again, _ = _parse_csv_to_items(csv_text, 's')
        assert [i['id'] for i in again] == [i['id'] for i in items]

    def test_keeps_repeated_identical_rows_without_id(self):
        """
        Survey exports of short free-text answers repeat verbatim ("Good", "OK",
        "n/a"). With no id column the row's position is its only distinguishing
        input, so dropping it from the recipe would silently lose records — the
        same failure class this fingerprint exists to fix.
        """
        from manual_import_handler import _parse_csv_to_items
        items, warnings = _parse_csv_to_items('text\ngood\ngood\ngood\n', 's')
        assert len(items) == 3
        assert len({i['id'] for i in items}) == 3
        assert warnings == []

    def test_repeated_rows_without_id_keep_their_ids_on_re_upload(self):
        """Position is stable for an unchanged file, so re-upload stays idempotent."""
        from manual_import_handler import _parse_csv_to_items
        first, _ = _parse_csv_to_items('text\ngood\ngood\n', 's')
        again, _ = _parse_csv_to_items('text\ngood\ngood\n', 's')
        assert [i['id'] for i in again] == [i['id'] for i in first]

    def test_reused_explicit_id_with_different_text_yields_different_ids(self):
        """The exact shape of the two 400-row files that collapsed into 400."""
        from manual_import_handler import _parse_csv_to_items
        one, _ = _parse_csv_to_items('id,text\n1,Cloud review\n', 'workshop')
        two, _ = _parse_csv_to_items('id,text\n1,Agentic review\n', 'workshop')
        assert one[0]['id'] != two[0]['id']

    def test_reused_explicit_id_with_different_date_yields_different_ids(self):
        from manual_import_handler import _parse_csv_to_items
        one, _ = _parse_csv_to_items('id,text,date\n1,same,2026-09-01\n', 'w')
        two, _ = _parse_csv_to_items('id,text,date\n1,same,2026-09-02\n', 'w')
        assert one[0]['id'] != two[0]['id']

    def test_reused_explicit_id_with_different_rating_yields_different_ids(self):
        from manual_import_handler import _parse_csv_to_items
        one, _ = _parse_csv_to_items('id,text,rating\n1,same,5\n', 'w')
        two, _ = _parse_csv_to_items('id,text,rating\n1,same,1\n', 'w')
        assert one[0]['id'] != two[0]['id']

    def test_request_default_source_does_not_change_row_ids(self):
        """
        `default_source` is an upload-time UI selection, not row content. If it
        keyed rows, re-uploading one file under a different label would import a
        whole second copy of it.
        """
        from manual_import_handler import _parse_csv_to_items
        one, _ = _parse_csv_to_items('id,text\n1,hello\n', 'label_one')
        two, _ = _parse_csv_to_items('id,text\n1,hello\n', 'label_two')
        assert one[0]['id'] == two[0]['id']

    def test_row_source_column_does_change_row_ids(self):
        """A `source` column in the file IS row content, unlike default_source."""
        from manual_import_handler import _parse_csv_to_items
        one, _ = _parse_csv_to_items('id,text,source\n1,hello,alpha\n', 'x')
        two, _ = _parse_csv_to_items('id,text,source\n1,hello,beta\n', 'x')
        assert one[0]['id'] != two[0]['id']

    def test_edited_row_gets_a_new_id_rather_than_updating_in_place(self):
        """
        Documented trade-off of content-addressed identity: re-uploading a file
        with a corrected row imports that row as an ADDITIONAL record, because
        the processor keys DynamoDB off the id emitted here. Correcting a file
        in place is not an update path; delete the prior import first.
        """
        from manual_import_handler import _parse_csv_to_items
        before, _ = _parse_csv_to_items('id,text\n1,teh app crashes\n', 'w')
        after, _ = _parse_csv_to_items('id,text\n1,the app crashes\n', 'w')
        assert before[0]['id'] != after[0]['id']

    def test_preserves_the_customers_row_identifier_for_lookups(self):
        from manual_import_handler import _parse_csv_to_items
        items, _ = _parse_csv_to_items('review_id,text\n4711,hello\n', 'w')
        assert items[0]['csv_row_id'] == '4711'
        assert items[0]['id'] != '4711'  # not usable as the item id

    def test_imports_the_row_but_drops_an_over_long_identifier(self):
        """
        `csv_row_id` is informational and bounded by the message schema. An
        identifier past that bound must not reject an otherwise importable row,
        and must not be truncated either — a partial id would not match what an
        operator searches for.
        """
        from manual_import_handler import MAX_CSV_ROW_ID_LENGTH, _parse_csv_to_items
        long_id = 'x' * (MAX_CSV_ROW_ID_LENGTH + 1)
        items, warnings = _parse_csv_to_items(f'id,text\n{long_id},hello\n', 'w')
        assert len(items) == 1
        assert items[0]['csv_row_id'] == ''
        assert any('exceeds' in w for w in warnings)

    def test_keeps_an_identifier_exactly_at_the_length_bound(self):
        from manual_import_handler import MAX_CSV_ROW_ID_LENGTH, _parse_csv_to_items
        at_bound = 'x' * MAX_CSV_ROW_ID_LENGTH
        items, warnings = _parse_csv_to_items(f'id,text\n{at_bound},hello\n', 'w')
        assert items[0]['csv_row_id'] == at_bound
        assert warnings == []

    def test_over_long_identifier_still_keys_the_row_at_full_length(self):
        """Dropping the informational copy must not weaken identity."""
        from manual_import_handler import MAX_CSV_ROW_ID_LENGTH, _parse_csv_to_items
        base = 'x' * (MAX_CSV_ROW_ID_LENGTH + 1)
        one, _ = _parse_csv_to_items(f'id,text\n{base}a,hello\n', 'w')
        two, _ = _parse_csv_to_items(f'id,text\n{base}b,hello\n', 'w')
        assert one[0]['csv_row_id'] == two[0]['csv_row_id'] == ''
        assert one[0]['id'] != two[0]['id']

    def test_mixed_file_keys_only_the_id_less_rows_by_position(self):
        """
        A file where only some rows carry an id: reordering re-keys the blank
        ones and leaves the identified ones alone.
        """
        from manual_import_handler import _parse_csv_to_items
        forward, _ = _parse_csv_to_items('id,text\n7,has id\n,no id\n', 'w')
        reverse, _ = _parse_csv_to_items('id,text\n,no id\n7,has id\n', 'w')
        by_text_forward = {i['text']: i['id'] for i in forward}
        by_text_reverse = {i['text']: i['id'] for i in reverse}
        assert by_text_forward['has id'] == by_text_reverse['has id']
        assert by_text_forward['no id'] != by_text_reverse['no id']

    def test_preserves_row_ids_when_rows_are_reordered(self):
        from manual_import_handler import _parse_csv_to_items
        forward, _ = _parse_csv_to_items('id,text\n1,hello\n2,world\n', 's')
        reverse, _ = _parse_csv_to_items('id,text\n2,world\n1,hello\n', 's')
        assert {i['text']: i['id'] for i in forward} == {i['text']: i['id'] for i in reverse}

    def test_skips_empty_text_and_exact_duplicate_rows_with_warnings(self):
        from manual_import_handler import _parse_csv_to_items
        csv_text = 'id,text\n1,hello\n2,\n1,world\n1,hello\n'
        items, warnings = _parse_csv_to_items(csv_text, 's')
        assert [i['text'] for i in items] == ['hello', 'world']
        assert any('empty text' in w for w in warnings)
        assert any('duplicate row' in w for w in warnings)

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
        messages = [json.loads(entry['MessageBody']) for entry in entries]
        assert messages[0]['id'] == CSV_BASIC_ROW1_ID
        assert messages[0]['csv_row_id'] == '1'
        assert messages[0]['source_platform'] == 'manual_import'
        assert messages[0]['ingestion_method'] == 'csv_upload'
        assert messages[0]['text'] == 'Great app, fast and reliable'
        assert messages[0]['s3_raw_uri'] == body['s3_uri']
        assert messages[0]['id'] != messages[1]['id']

    @patch('manual_import_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/q')
    @patch('manual_import_handler.RAW_DATA_BUCKET', '')
    def test_omits_csv_row_id_when_the_file_has_no_id_column(
        self, api_gateway_event, lambda_context
    ):
        from manual_import_handler import lambda_handler
        mock_sqs = _make_sqs()
        with patch('manual_import_handler.sqs', mock_sqs):
            lambda_handler(
                self._post(api_gateway_event, {'csv_text': 'text\nhello\n'}), lambda_context
            )
        entries = mock_sqs.send_message_batch.call_args.kwargs['Entries']
        assert json.loads(entries[0]['MessageBody'])['csv_row_id'] is None

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
