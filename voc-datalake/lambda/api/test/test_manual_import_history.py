"""Import history on the manual-import Lambda (#237, docs/import-history.md).

Each import route writes ONE run record with the counts its response reported, and
`GET /scrapers/manual/history[/<run_id>]` reads them back. The `import_run_rows`
conftest fixture captures the rows instead of writing them; the round-trip case at
the end writes to a moto table and reads through the routes.
"""
import json
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from handler_events_fixtures import call_route
from moto import mock_aws
from moto_helpers import pk_sk_table

import manual_import_handler as h
from shared import import_runs
from shared.test.source_profile_fixtures import unconfigured_upload_profile

RUN_ID = '0b1f3c4e-7a2d-4f6b-9c8e-1d2a3b4c5d6e'


@pytest.fixture(autouse=True)
def _no_source_profiles() -> Iterator[None]:
    with patch.object(h, 'upload_profile', side_effect=unconfigured_upload_profile):
        yield


def _batch(failing_ids: frozenset[str] = frozenset()):
    def send(Entries, **_kwargs):
        return {'Successful': [{'Id': e['Id']} for e in Entries if e['Id'] not in failing_ids],
                'Failed': [{'Id': e['Id'], 'Message': 'throttled'} for e in Entries if e['Id'] in failing_ids]}
    return send


@pytest.fixture
def wired() -> Iterator[MagicMock]:
    """Queue + bucket configured, every AWS client a double; yields the SQS double."""
    with patch.object(h, 'PROCESSING_QUEUE_URL', 'https://sqs.example.com/q'), patch.object(h, 'RAW_DATA_BUCKET', 'raw'), \
            patch.object(h, 'aggregates_table', MagicMock()), patch.object(h, 's3'), patch.object(h, 'sqs') as sqs:
        sqs.send_message_batch.side_effect = _batch()
        yield sqs


def _summaries(rows: list[dict]) -> list[dict]:
    return [row for row in rows if row['pk'] == 'IMPORT_RUN']


def _details(rows: list[dict]) -> list[dict]:
    return [row for row in rows if row['pk'].startswith('IMPORT_RUN#')]


def _counts(row: dict) -> dict:
    return {k: row[k] for k in ('received', 'imported', 'skipped', 'duplicate', 'failed')}


CSV = 'id,text\n1,Great\n2,\n1,Great\n3,Slow login\n'


class TestEveryImportWritesOneRecord:
    @pytest.mark.usefixtures("wired")
    def test_csv_upload_records_skipped_and_duplicate_rows(self, import_run_rows, api_gateway_event, lambda_context):
        _, body = call_route(h.lambda_handler, api_gateway_event, lambda_context, method='POST',
                             path='/scrapers/manual/csv-upload', body={'csv_text': CSV, 'default_source': 'Example Air survey'})
        assert body['imported_count'] == 2
        [summary], [detail] = _summaries(import_run_rows), _details(import_run_rows)
        assert summary['method'] == 'csv'
        assert summary['source'] == 'Example Air survey'
        assert _counts(summary) == {'received': 4, 'imported': 2, 'skipped': 1, 'duplicate': 1, 'failed': 0}
        assert summary['status'] == 'completed'
        assert (summary['actor'], summary['actor_email']) == ('test-user-id', 'test@example.com')
        assert summary['raw_s3_key'] == body['s3_uri']
        assert detail['warnings'] == body['warnings']

    @pytest.mark.usefixtures("wired")
    def test_csv_upload_records_every_warning_not_only_the_twenty_the_response_shows(
            self, import_run_rows, api_gateway_event, lambda_context):
        csv_text = 'text,rating\n' + ''.join(f'Row {i},bad\n' for i in range(30))
        _, body = call_route(h.lambda_handler, api_gateway_event, lambda_context, method='POST',
                             path='/scrapers/manual/csv-upload', body={'csv_text': csv_text})
        assert len(body['warnings']) == 20
        assert len(_details(import_run_rows)[0]['warnings']) == 30

    def test_json_upload_records_send_failures_as_partial(self, wired, import_run_rows, api_gateway_event, lambda_context):
        wired.send_message_batch.side_effect = _batch(frozenset({'1'}))
        items = [{'id': f'i{i}', 'text': 'ok', 'source': 'web', 'timestamp': '2026-10-01T00:00:00Z'} for i in range(3)]
        call_route(h.lambda_handler, api_gateway_event, lambda_context, method='POST',
                   path='/scrapers/manual/json-upload', body={'items': items})
        [summary], [detail] = _summaries(import_run_rows), _details(import_run_rows)
        assert summary['method'] == 'json'
        assert summary['source'] == 'manual_import'
        assert _counts(summary) == {'received': 3, 'imported': 2, 'skipped': 0, 'duplicate': 0, 'failed': 1}
        assert summary['status'] == 'partial'
        assert detail['errors'] == ['item 1: throttled']

    @pytest.mark.usefixtures("wired")
    def test_the_assistant_import_is_tagged_with_the_source_the_user_named(
            self, import_run_rows, api_gateway_event, lambda_context):
        items = [{'id': 'a', 'text': 'ok', 'source': 'chat', 'timestamp': '2026-10-01T00:00:00Z'}]
        call_route(h.lambda_handler, api_gateway_event, lambda_context, method='POST', path='/scrapers/manual/json-upload',
                   body={'items': items, 'import_origin': 'assistant', 'source_label': 'Example Air forum'})
        [summary] = _summaries(import_run_rows)
        assert (summary['method'], summary['source']) == ('assistant', 'Example Air forum')

    def test_paste_confirm_records_the_parsed_source(self, import_run_rows, api_gateway_event, lambda_context):
        job = {'source_url': 'https://g2.com/x', 'source_origin': 'g2', 'raw_text': 'r', 'reviews': []}
        reviews = [{'text': 'Great', 'date': '2026-10-01'}, {'text': 'Slow', 'date': '2026-10-02'}]
        with patch.object(h, 'aggregates_table') as table, patch.object(h, 's3'), patch.object(h, 'sqs'), \
                patch.object(h, 'PROCESSING_QUEUE_URL', 'https://sqs.example.com/q'):
            table.get_item.return_value = {'Item': job}
            call_route(h.lambda_handler, api_gateway_event, lambda_context, method='POST',
                       path='/scrapers/manual/confirm', body={'job_id': 'job-1', 'reviews': reviews})
        [summary] = _summaries(import_run_rows)
        assert (summary['method'], summary['source']) == ('paste', 'g2')
        assert _counts(summary) == {'received': 2, 'imported': 2, 'skipped': 0, 'duplicate': 0, 'failed': 0}

    @pytest.mark.usefixtures("wired")
    def test_a_refused_upload_writes_no_record(self, import_run_rows, api_gateway_event, lambda_context):
        response, _ = call_route(h.lambda_handler, api_gateway_event, lambda_context, method='POST',
                                 path='/scrapers/manual/json-upload', body={'items': [{'text': 'no id'}]})
        assert response['statusCode'] == 400
        assert import_run_rows == []

    @pytest.mark.usefixtures("wired")
    def test_a_failed_history_write_does_not_fail_the_import(self, api_gateway_event, lambda_context):
        with patch.object(import_runs, '_put_rows', side_effect=ClientError({'Error': {'Code': 'Throttling'}}, 'PutItem')):
            response, body = call_route(h.lambda_handler, api_gateway_event, lambda_context, method='POST',
                                        path='/scrapers/manual/csv-upload', body={'csv_text': CSV})
        assert response['statusCode'] == 200
        assert body['imported_count'] == 2


_ONE_ITEM = [{'id': 'a', 'text': 'ok', 'source': 'chat', 'timestamp': '2026-10-01T00:00:00Z'}]


@pytest.mark.usefixtures("wired")
class TestTheRecordHoldsNoCustomerValues:
    def test_a_rating_cell_holding_an_email_never_reaches_the_stored_record(
            self, import_run_rows, api_gateway_event, lambda_context):
        email = 'jane.doe@example.com'
        call_route(h.lambda_handler, api_gateway_event, lambda_context, method='POST',
                   path='/scrapers/manual/csv-upload', body={'csv_text': f'text,rating\nGreat flight,{email}\n'})
        [detail] = _details(import_run_rows)
        assert detail['warnings'] == ['row 1: rating is not a number — left blank']
        assert email not in json.dumps(import_run_rows, default=str)


@pytest.mark.usefixtures("wired")
class TestTheJsonUploadSourceLabel:
    def _summary(self, rows, event, context, **extra) -> dict:
        call_route(h.lambda_handler, event, context, method='POST', path='/scrapers/manual/json-upload',
                   body={'items': _ONE_ITEM, **extra})
        [summary] = _summaries(rows)
        return summary

    def test_a_label_without_the_assistant_origin_is_ignored(self, import_run_rows, api_gateway_event, lambda_context):
        summary = self._summary(import_run_rows, api_gateway_event, lambda_context, source_label='Forged origin')
        assert (summary['method'], summary['source']) == ('json', 'manual_import')

    def test_an_unknown_origin_is_a_plain_json_upload(self, import_run_rows, api_gateway_event, lambda_context):
        summary = self._summary(import_run_rows, api_gateway_event, lambda_context,
                                import_origin='s3', source_label='Forged origin')
        assert (summary['method'], summary['source']) == ('json', 'manual_import')

    def test_the_assistant_label_is_capped_at_120_characters(self, import_run_rows, api_gateway_event, lambda_context):
        summary = self._summary(import_run_rows, api_gateway_event, lambda_context,
                                import_origin='assistant', source_label='x' * 500)
        assert summary['source'] == 'x' * 120

    def test_control_and_format_characters_are_removed_from_the_label(
            self, import_run_rows, api_gateway_event, lambda_context):
        summary = self._summary(import_run_rows, api_gateway_event, lambda_context,
                                import_origin='assistant', source_label='\x1b[31mExample\u202e Air\n\x00forum ')
        assert summary['source'] == '[31mExample Airforum'

    @pytest.mark.parametrize('label', [None, 42, '', '  \x07\n '])
    def test_an_assistant_import_without_a_usable_label_names_the_profile(
            self, label, import_run_rows, api_gateway_event, lambda_context):
        summary = self._summary(import_run_rows, api_gateway_event, lambda_context,
                                import_origin='assistant', source_label=label)
        assert (summary['method'], summary['source']) == ('assistant', 'manual_import')


class TestHistoryRoutes:
    def test_the_list_passes_limit_and_cursor_through(self, api_gateway_event, lambda_context):
        with patch.object(h, 'list_import_runs', return_value=([{'run_id': RUN_ID}], 'next')) as listing:
            response, body = call_route(h.lambda_handler, api_gateway_event, lambda_context, path='/scrapers/manual/history',
                                        query_params={'limit': '10', 'cursor': 'abc'})
        assert response['statusCode'] == 200
        assert body == {'runs': [{'run_id': RUN_ID}], 'next_cursor': 'next'}
        assert listing.call_args.kwargs == {'limit': 10, 'cursor': 'abc'}

    def test_a_bad_cursor_or_limit_is_a_400(self, api_gateway_event, lambda_context):
        for params in ({'limit': 'ten'}, {'cursor': 'not-a-cursor'}):
            response, _ = call_route(h.lambda_handler, api_gateway_event, lambda_context,
                                     path='/scrapers/manual/history', query_params=params)
            assert response['statusCode'] == 400

    def test_an_unknown_run_is_a_404(self, api_gateway_event, lambda_context):
        with patch.object(h, 'aggregates_table') as table:
            table.get_item.return_value = {}
            response, _ = call_route(h.lambda_handler, api_gateway_event, lambda_context,
                                     path=f'/scrapers/manual/history/{RUN_ID}', path_params={'run_id': RUN_ID})
        assert response['statusCode'] == 404

    def test_a_non_admin_cannot_read_the_history(self, api_gateway_event, lambda_context):
        response, _ = call_route(h.lambda_handler, api_gateway_event, lambda_context, path='/scrapers/manual/history',
                                 claims={'sub': 'u', 'cognito:groups': 'users'})
        assert response['statusCode'] == 403


def test_an_upload_reads_back_through_the_history_routes(api_gateway_event, lambda_context):
    """End to end on a moto table: CSV upload, then the list, then the run's detail.

    The conftest capture of `_put_rows` is replaced by a real write for this case only.
    """
    def put_rows(table, rows):
        for row in rows:
            table.put_item(Item=dict(row))

    with mock_aws(), patch.object(import_runs, '_put_rows', side_effect=put_rows):
        table = pk_sk_table('test-aggregates-history')
        with patch.object(h, 'aggregates_table', table), patch.object(h, 'RAW_DATA_BUCKET', ''), \
                patch.object(h, 'PROCESSING_QUEUE_URL', ''):
            call_route(h.lambda_handler, api_gateway_event, lambda_context, method='POST',
                       path='/scrapers/manual/csv-upload', body={'csv_text': CSV})
            _, listing = call_route(h.lambda_handler, api_gateway_event, lambda_context, path='/scrapers/manual/history')
            [run] = listing['runs']
            _, detail = call_route(h.lambda_handler, api_gateway_event, lambda_context,
                                   path=f"/scrapers/manual/history/{run['run_id']}", path_params={'run_id': run['run_id']})
    assert listing['next_cursor'] is None
    assert run['counts'] == {'received': 4, 'imported': 2, 'skipped': 1, 'duplicate': 1, 'failed': 0}
    assert 'warnings' not in run
    assert detail['run']['warnings'] == ['row 2: empty text — skipped', 'row 3: duplicate row — skipped']
    assert json.dumps(detail)  # JSON-safe: no Decimal leaks out of the read
