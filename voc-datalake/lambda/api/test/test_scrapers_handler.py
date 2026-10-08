"""
Tests for scrapers_handler.py - /scrapers/* endpoints.

What remains here after `test_scrapers_handler_mutation.py` took over the
field-by-field pins: the two `ValidationError` re-raises (an over-limit secret
surfaces as a 400 on save AND delete, not a 500), the redaction of stored run
errors on `/status` and `/runs`, and `POST /scrapers` running the REAL URL policy
(a resolver is stubbed, nothing else) over `base_url` and every `urls` entry.
"""
import json
from typing import ClassVar
from unittest.mock import MagicMock, patch

import pytest
from handler_events_fixtures import call_route

from scrapers_handler import lambda_handler
from shared import scraper_run_errors


class TestSecretSizeGuardSurfacesAs400:
    """
    An over-limit secret must reach the caller as a 400, on BOTH write routes.

    put_secret_json refuses a serialized secret over the Secrets Manager limit by
    raising ValidationError. Each route wraps its work in `except Exception ->
    ServiceError`, so without an explicit re-raise that actionable 400 is
    flattened into an opaque 500.

    delete_scraper matters even though a delete only ever SHRINKS this key: the
    secret can already be over the limit from before the guard existed, and the
    caller hitting that is precisely the one deleting to get back under it.
    """

    @staticmethod
    def _oversized_secret() -> dict:
        from shared.aws import SECRET_STRING_MAX_BYTES

        return {
            'webscraper_configs': json.dumps([{'id': 'delete-this', 'name': 'D'}]),
            'other_feature_blob': 'y' * SECRET_STRING_MAX_BYTES,
        }

    @patch('scrapers_handler.secretsmanager')
    def test_save_returns_400_not_500(self, mock_secrets, api_gateway_event, lambda_context):
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps(self._oversized_secret())
        }
        response = lambda_handler(
            api_gateway_event(
                method='POST', path='/scrapers',
                body={'scraper': {'id': 's1', 'name': 'New'}},
            ),
            lambda_context,
        )
        assert response['statusCode'] == 400, response['body']
        mock_secrets.put_secret_value.assert_not_called()

    @patch('scrapers_handler.secretsmanager')
    def test_delete_returns_400_not_500(self, mock_secrets, api_gateway_event, lambda_context):
        """Regression: removing `except ValidationError: raise` makes this a 500."""
        mock_secrets.get_secret_value.return_value = {
            'SecretString': json.dumps(self._oversized_secret())
        }
        response = lambda_handler(
            api_gateway_event(
                method='DELETE', path='/scrapers/delete-this',
                path_params={'scraper_id': 'delete-this'},
            ),
            lambda_context,
        )
        assert response['statusCode'] == 400, response['body']
        mock_secrets.put_secret_value.assert_not_called()


class TestScraperRunErrorsAreRedacted:
    """`/status` and `/runs` are readable by every user: a stored run's raw
    exception text is withheld exactly as GET /logs/scraper/<id> withholds it
    (shared/scraper_run_errors.py)."""

    URL = 'https://shop.example/reviews'
    STORED_ERRORS = (
        f'Error scraping {URL}: 500 Server Error for jane@example.com token=SECRET-9',
        f'Error scraping {URL}: KeyError',
    )
    RETURNED_ERRORS = (
        f'Error scraping {URL}: {scraper_run_errors.SCRAPER_DETAIL_WITHHELD}',
        f'Error scraping {URL}: KeyError',
    )

    @pytest.mark.parametrize(('suffix', 'errors_of'), [
        pytest.param('status', lambda body: body['errors'], id='status'),
        pytest.param('runs', lambda body: body['runs'][0]['errors'], id='runs'),
    ])
    @patch('scrapers_handler.get_aggregates_table')
    def test_legacy_exception_text_is_withheld(
        self, mock_get_table, suffix, errors_of, api_gateway_event, lambda_context
    ):
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': [{
            'pk': 'SCRAPER_RUN#s-1', 'sk': 'run-1', 'status': 'completed_with_errors',
            'errors': list(self.STORED_ERRORS),
        }]}
        mock_get_table.return_value = mock_table

        response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path=f'/scrapers/s-1/{suffix}', path_params={'scraper_id': 's-1'},
        )

        assert response['statusCode'] == 200
        assert errors_of(body) == list(self.RETURNED_ERRORS)
        assert 'SECRET-9' not in response['body']


class TestSaveScraperValidatesEveryUrl:
    """POST /scrapers runs every URL the ingestor would fetch through the URL
    policy before persisting (#244); a refusal is a 400 naming the URL."""

    PUBLIC_DNS: ClassVar[list[tuple]] = [(2, 1, 6, '', ('93.184.216.34', 0))]

    def _save(self, scraper, api_gateway_event, lambda_context):
        return call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='POST', path='/scrapers', body={'scraper': scraper},
        )

    @patch('scrapers_handler.secretsmanager')
    def test_a_metadata_base_url_is_rejected_and_nothing_is_written(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        scraper = {'id': 's1', 'base_url': 'http://169.254.169.254/latest/meta-data/'}
        response, body = self._save(scraper, api_gateway_event, lambda_context)
        assert response['statusCode'] == 400
        assert 'http://169.254.169.254/latest/meta-data/' in json.dumps(body)
        mock_secrets.put_secret_value.assert_not_called()

    @patch('scrapers_handler.secretsmanager')
    def test_the_failing_entry_of_urls_is_named(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        def resolver(host, *_args, **_kwargs):
            ip = '10.0.0.5' if host == 'intranet.example' else '93.184.216.34'
            return [(2, 1, 6, '', (ip, 0))]

        scraper = {
            'id': 's1', 'base_url': 'https://shop.example/reviews',
            'urls': ['https://shop.example/more', 'https://intranet.example/admin'],
        }
        with patch('shared.url_policy.socket.getaddrinfo', side_effect=resolver):
            response, body = self._save(scraper, api_gateway_event, lambda_context)
        assert response['statusCode'] == 400
        text = json.dumps(body)
        assert 'https://intranet.example/admin' in text
        assert 'internal/private' in text
        mock_secrets.put_secret_value.assert_not_called()

    @patch('scrapers_handler.secretsmanager')
    def test_public_urls_and_an_empty_base_url_are_saved(
        self, mock_secrets, api_gateway_event, lambda_context
    ):
        mock_secrets.get_secret_value.return_value = {'SecretString': json.dumps({'webscraper_configs': '[]'})}
        scraper = {'id': 's1', 'base_url': '', 'urls': ['https://shop.example/reviews']}
        with patch('shared.url_policy.socket.getaddrinfo', return_value=self.PUBLIC_DNS):
            response, body = self._save(scraper, api_gateway_event, lambda_context)
        assert response['statusCode'] == 200
        assert body['success'] is True
        mock_secrets.put_secret_value.assert_called_once()
