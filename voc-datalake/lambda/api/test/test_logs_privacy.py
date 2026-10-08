"""Decision 3 (2026-10-04): `/logs/*` reads are open to every signed-in user, so
no response carries PII or raw exception text — including rows written before
the processor stopped storing them — and `DELETE /logs/*` is admin-only.
"""
import json
from datetime import UTC, datetime
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route, clear_validation_logs

import logs_handler
from logs_handler import lambda_handler
from shared import scraper_run_errors

EMAIL = 'jane.doe@example.com'
NAME = 'Jane Doe'
SECRET_TEXT = 'my order 4111 never arrived'
PLANTED = (EMAIL, NAME, SECRET_TEXT, 'jane', 'example.com', '4111', 'boom-detail')

NON_ADMIN = {'sub': 'user-1', 'email': 'user@example.com', 'cognito:groups': 'users'}

LEGACY_VALIDATION_ROW = {
    'source_platform': 'webscraper', 'message_id': 'msg-1', 'timestamp': '2025-01-01T12:00:00Z',
    'log_type': 'validation_failure',
    'raw_preview': json.dumps({'submitter_email': EMAIL, 'submitter_name': NAME, 'text': SECRET_TEXT}),
    'errors': [
        'source_platform: Field required',
        f"metadata: Value error, metadata key '{EMAIL}...' exceeds max length",
        f"{EMAIL}: Extra inputs are not permitted",
        f": Value error, {NAME} boom-detail",
        {'not': 'a string'},
    ],
}
NEW_VALIDATION_ROW = {
    'source_platform': 'webscraper', 'message_id': 'msg-2', 'timestamp': '2025-01-01T12:00:00Z',
    'log_type': 'validation_failure',
    'errors': ['source_platform: missing', 'metadata: value_error'],
    'record_keys': ['*', 'id', 'submitter_email', EMAIL],
    'text_length': 27,
}
LEGACY_PROCESSING_ROW = {
    'source_platform': 'webscraper', 'message_id': 'msg-3', 'timestamp': '2025-01-01T12:00:00Z',
    'log_type': 'processing_error',
    'error_type': 'KeyError', 'error_message': f"'{NAME} <{EMAIL}>' {SECRET_TEXT}",
}
LEGACY_THROTTLE_ROW = {
    **LEGACY_PROCESSING_ROW, 'message_id': 'msg-4',
    'error_type': 'bedrock_throttling', 'error_message': f'throttled while reading {EMAIL}',
}
HOSTILE_TYPE_ROW = {**LEGACY_PROCESSING_ROW, 'message_id': 'msg-5', 'error_type': f'{NAME} {EMAIL}'}


def _assert_clean(body: object) -> None:
    dumped = json.dumps(body).lower()
    for secret in PLANTED:
        assert secret.lower() not in dumped, secret


def _get(api_gateway_event, lambda_context, path, **kwargs):
    return call_route(lambda_handler, api_gateway_event, lambda_context, method='GET', path=path,
                      claims=NON_ADMIN, **kwargs)


class TestReadsCarryNoPii:

    @patch('logs_handler.aggregates_table')
    def test_validation_rows_new_and_legacy(self, mock_table, api_gateway_event, lambda_context):
        mock_table.query.return_value = {'Items': [LEGACY_VALIDATION_ROW, NEW_VALIDATION_ROW]}

        response, body = _get(api_gateway_event, lambda_context, '/logs/validation',
                              query_params={'source': 'webscraper'})

        assert response['statusCode'] == 200
        _assert_clean(body)
        legacy, new = body['logs']
        assert 'raw_preview' not in legacy
        assert legacy['errors'] == [
            'source_platform: invalid', 'metadata: invalid',
            logs_handler.VALIDATION_ERROR_WITHHELD, logs_handler.VALIDATION_ERROR_WITHHELD,
            logs_handler.VALIDATION_ERROR_WITHHELD,
        ]
        assert new['errors'] == ['source_platform: missing', 'metadata: value_error']
        assert new['record_keys'] == ['*', 'id', 'submitter_email', '*']
        assert new['text_length'] == 27

    @patch('logs_handler.aggregates_table')
    def test_processing_rows_return_the_type_and_a_fixed_message(self, mock_table, api_gateway_event, lambda_context):
        mock_table.query.return_value = {'Items': [LEGACY_PROCESSING_ROW, LEGACY_THROTTLE_ROW, HOSTILE_TYPE_ROW]}

        _, body = _get(api_gateway_event, lambda_context, '/logs/processing', query_params={'source': 'webscraper'})

        _assert_clean(body)
        assert [(log['error_type'], log['error_message']) for log in body['logs']] == [
            ('KeyError', logs_handler.PROCESSING_FAILED_MESSAGE),
            ('bedrock_throttling', logs_handler.THROTTLED_MESSAGE),
            (logs_handler.UNKNOWN_ERROR_TYPE, logs_handler.PROCESSING_FAILED_MESSAGE),
        ]

    @patch('logs_handler.aggregates_table')
    def test_scraper_run_errors_drop_legacy_exception_text(self, mock_table, api_gateway_event, lambda_context):
        url = 'https://shop.example/reviews'
        policy = f'Error scraping {url}: URL blocked by policy (Access to localhost is not allowed)'
        mock_table.query.return_value = {'Items': [{
            'sk': 'run-1', 'status': 'completed_with_errors', 'started_at': datetime.now(UTC).isoformat(),
            'errors': [
                f'Error scraping {url}: 500 Server Error for {EMAIL} boom-detail',
                f'Error scraping {url}: KeyError',
                policy,
                'No scraper configuration found',
                f'{NAME} {SECRET_TEXT}',
            ],
        }]}

        _, body = _get(api_gateway_event, lambda_context, '/logs/scraper/s-1', path_params={'scraper_id': 's-1'})

        _assert_clean(body)
        assert body['logs'][0]['errors'] == [
            f'Error scraping {url}: {scraper_run_errors.SCRAPER_DETAIL_WITHHELD}',
            f'Error scraping {url}: KeyError',
            policy,
            'No scraper configuration found',
            scraper_run_errors.SCRAPER_ERROR_WITHHELD,
        ]


class TestDeleteIsAdminOnly:

    @patch('logs_handler.aggregates_table')
    def test_a_non_admin_gets_403_and_nothing_is_read_or_deleted(self, mock_table, api_gateway_event, lambda_context):
        # A real page shape, so an ungated handler fails this test instead of paging a MagicMock forever.
        mock_table.query.return_value = {'Items': [{'pk': 'LOGS#validation#webscraper', 'sk': 'a'}]}

        response, _ = call_route(lambda_handler, api_gateway_event, lambda_context,
                                 method='DELETE', path='/logs/validation/webscraper',
                                 path_params={'source': 'webscraper'}, claims=NON_ADMIN)

        assert response['statusCode'] == 403
        mock_table.query.assert_not_called()
        mock_table.batch_writer.assert_not_called()

    @pytest.mark.parametrize('path', ['/logs/validation', '/logs/processing', '/logs/summary'])
    @patch('logs_handler.aggregates_table')
    def test_reads_stay_open_to_a_non_admin(self, mock_table, path, api_gateway_event, lambda_context):
        mock_table.query.return_value = {'Items': []}

        response, _ = _get(api_gateway_event, lambda_context, path)

        assert response['statusCode'] == 200

    @patch('logs_handler.aggregates_table')
    def test_an_admin_clears(self, mock_table, api_gateway_event, lambda_context):
        # One page as an exhaustible list: a pager that fails to stop answers 500 instead of spinning.
        mock_table.query.side_effect = [{'Items': [{'pk': 'LOGS#validation#webscraper', 'sk': 'a'}]}]

        response, body, _ = clear_validation_logs(lambda_handler, mock_table, api_gateway_event, lambda_context)

        assert response['statusCode'] == 200
        assert body['deleted'] == 1
