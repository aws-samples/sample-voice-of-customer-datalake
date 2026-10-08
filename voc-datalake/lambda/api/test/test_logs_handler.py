"""
Tests for logs_handler.py - /logs/* endpoints.
Provides access to validation failures and processing errors.

The route shapes, refusal wording, DynamoDB calls and redaction bounds are pinned
in `test_logs_handler_mutation.py`; this file keeps the unfiltered-listing default,
the zero summary, the #256 fan-out regression, the real-clock scraper window and
the clear's count.
"""
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from handler_events_fixtures import call_route

from logs_handler import lambda_handler


def _today_iso() -> str:
    """Today as ISO timestamp. Used for scraper_run started_at fixtures so they
    fall within the default 7-day lookback regardless of when tests run."""
    return datetime.now(UTC).isoformat()


def _scraper_run(sk: str, *, started_at: str, pages_scraped: int, items_found: int) -> dict:
    """A completed SCRAPER#scraper-123 run row."""
    return {
        'pk': 'SCRAPER#scraper-123', 'sk': sk, 'status': 'completed',
        'started_at': started_at, 'completed_at': started_at,
        'pages_scraped': pages_scraped, 'items_found': items_found, 'errors': [],
    }


class TestGetValidationLogs:
    """Tests for GET /logs/validation endpoint."""

    @patch('logs_handler.aggregates_table')
    def test_returns_empty_list_when_no_logs_exist(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns empty array when no validation failures in date range."""
        # Arrange
        mock_table.query.return_value = {'Items': []}


        # Act
        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/logs/validation', query_params={'days': '7'},
        )

        # Assert
        assert response['statusCode'] == 200
        assert body['logs'] == []
        assert body['count'] == 0
        assert body['days'] == 7


class TestGetLogsSummary:
    """Tests for GET /logs/summary endpoint."""

    @patch('logs_handler.aggregates_table')
    def test_returns_zero_counts_when_no_logs_exist(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns zero counts when no logs in date range."""
        # Arrange
        mock_table.query.return_value = {'Items': []}

        # Act
        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/logs/summary', query_params={'days': '7'},
        )

        # Assert
        assert response['statusCode'] == 200
        assert body['summary']['total_validation_failures'] == 0
        assert body['summary']['total_processing_errors'] == 0
        assert body['days'] == 7

    @patch('logs_handler.aggregates_table')
    def test_counts_every_enabled_plugin_not_a_hardcoded_list(
        self, mock_table, api_gateway_event, lambda_context, monkeypatch
    ):
        """Issue #256: a plugin enabled at deploy time is summarised.

        `synthetic_reviews` was enabled in `pluginStatus` yet never listed, because
        the handler fanned out over a hardcoded triple instead of ENABLED_SOURCES.
        """
        monkeypatch.setenv('ENABLED_SOURCES', '["synthetic_reviews"]')
        mock_table.query.return_value = {'Items': [{'id': '1'}]}

        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/logs/summary',
        )

        assert body['summary']['validation_failures'] == {'synthetic_reviews': 1, 'manual_import': 1}


class TestGetScraperLogs:
    """Tests for GET /logs/scraper/{scraper_id} endpoint."""

    @patch('logs_handler.aggregates_table')
    def test_excludes_runs_older_than_lookback_window(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Runs whose started_at predates the `days` window are filtered out.

        Regression: the cutoff was previously computed but never applied, so the
        `days` query param was a no-op and every run was returned. This test
        fails if that filter is removed again.
        """
        # Arrange: one recent run (kept) and one a year old (must be dropped).
        recent = _today_iso()
        old = (datetime.now(UTC) - timedelta(days=365)).isoformat()
        mock_table.query.return_value = {
            'Items': [
                _scraper_run(f'RUN#{recent}', started_at=recent, pages_scraped=5, items_found=20),
                _scraper_run(f'RUN#{old}', started_at=old, pages_scraped=99, items_found=999),
            ]
        }

        # Act
        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET',
            path='/logs/scraper/scraper-123',
            path_params={'scraper_id': 'scraper-123'},
            query_params={'days': '7'},
        )

        # Assert: only the recent run survives the cutoff.
        assert response['statusCode'] == 200
        assert body['count'] == 1
        assert body['logs'][0]['started_at'] == recent
        returned_started = [log['started_at'] for log in body['logs']]
        assert old not in returned_started


class TestClearValidationLogs:
    """Tests for DELETE /logs/validation/{source} endpoint."""

    @pytest.mark.parametrize(('source', 'stored', 'expected_deleted'), [
        # Deletes all validation logs for the specified source.
        ('webscraper', [
            {'pk': 'LOGS#validation#webscraper', 'sk': '2025-01-01T12:00:00Z'},
            {'pk': 'LOGS#validation#webscraper', 'sk': '2025-01-01T13:00:00Z'},
        ], 2),
        # Zero deleted when the source has no logs.
        ('unknown', [], 0),
    ])
    @patch('logs_handler.aggregates_table')
    def test_reports_how_many_logs_it_cleared_for_the_source(
        self, mock_table, api_gateway_event, lambda_context, source, stored, expected_deleted
    ):
        # Arrange. One page as an exhaustible list, not a return_value: a pager that
        # fails to stop then hits StopIteration on its second query and answers 500
        # instead of spinning forever against the mock.
        mock_table.query.side_effect = [{'Items': stored}]
        mock_batch_writer = MagicMock()
        mock_batch_writer.__enter__ = MagicMock(return_value=mock_batch_writer)
        mock_table.batch_writer.return_value = mock_batch_writer

        # Act
        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='DELETE',
            path=f'/logs/validation/{source}',
            path_params={'source': source},
        )

        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['deleted'] == expected_deleted
