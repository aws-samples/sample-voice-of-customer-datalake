"""`POST /scrapers` is open to every authenticated user (owner decision, 2026-10-04)
and writes the shared API-credentials secret, so what one save may store is bounded.

The bound-by-bound cases (each refusal's exact message, and the accepted side of
every limit) live in `test_scrapers_handler_mutation.py`. What stays here is the
EDITOR's view of those bounds: the payload the frontend sends for a new scraper
is accepted whole, an edit of a scraper is still allowed when the count is already
at the cap (the cap is on creates), and an edit that SHRINKS a `webscraper_configs`
value already over the byte budget is accepted so an oversized secret can be
repaired. The URL policy is stubbed to "allow" so these exercise the bounds alone
(the policy has its own cases in
`test_scrapers_handler.py::TestSaveScraperValidatesEveryUrl`).

Each case asserts the write too: a refusal after the write would satisfy a
status-code-only check.
"""
import json
from unittest.mock import patch

import pytest

import scrapers_handler
from scrapers_handler import (
    MAX_SCRAPER_BYTES,
    MAX_SCRAPERS,
    MAX_WEBSCRAPER_CONFIGS_BYTES,
    lambda_handler,
)

# What the frontend editor sends for a new scraper (DEFAULT_SCRAPER + a URL).
EDITOR_SCRAPER = {
    'id': 'scraper_1760000000000',
    'name': 'New Scraper',
    'enabled': True,
    'base_url': 'https://reviews.example/product',
    'urls': ['https://reviews.example/a'],
    'frequency_minutes': 1440,
    'extraction_method': 'css',
    'container_selector': '.review',
    'text_selector': '.review-text',
    'title_selector': '',
    'rating_selector': '',
    'date_selector': '',
    'author_selector': '',
    'link_selector': 'a',
    'pagination': {'enabled': False, 'param': 'page', 'max_pages': 5, 'start': 1},
}


def _non_admin(api_gateway_event, **kwargs):
    event = api_gateway_event(**kwargs)
    event['requestContext']['authorizer']['claims']['cognito:groups'] = 'users'
    return event


@pytest.fixture
def save(api_gateway_event, lambda_context):
    """POST one scraper as a non-admin over `stored`; returns (status, body, put mock)."""
    def _save(scraper, stored=None):
        with (
            patch.object(scrapers_handler, 'validate_url', return_value=(True, '')),
            patch.object(scrapers_handler, 'put_secret_json') as put,
            patch.object(scrapers_handler, 'secretsmanager') as secrets,
        ):
            secrets.get_secret_value.return_value = {
                'SecretString': json.dumps({'webscraper_configs': json.dumps(stored or [])})
            }
            response = lambda_handler(
                _non_admin(api_gateway_event, method='POST', path='/scrapers', body={'scraper': scraper}),
                lambda_context,
            )
        return response['statusCode'], json.loads(response['body']), put
    return _save


def test_the_control_the_editor_payload_is_accepted(save):
    status, body, put = save(EDITOR_SCRAPER)
    assert status == 200, body
    assert put.call_count == 1


class TestTheWholeSecretIsBounded:
    def test_the_control_an_edit_at_the_count_is_accepted(self, save):
        stored = [{'id': f's{i}'} for i in range(MAX_SCRAPERS - 1)] + [{'id': EDITOR_SCRAPER['id']}]
        status, body, put = save(EDITOR_SCRAPER, stored)
        assert status == 200, body
        assert put.call_count == 1

    def test_the_control_an_edit_that_shrinks_an_oversized_value_is_accepted(self, save):
        """A value already over budget (saved before the cap) can still be repaired."""
        filler = 'x' * (MAX_SCRAPER_BYTES // 2)
        count = MAX_WEBSCRAPER_CONFIGS_BYTES // len(filler) + 2
        stored = [{'id': f's{i}', 'text_config': filler} for i in range(count)]
        status, body, put = save({'id': 's0'}, stored)
        assert status == 200, body
        assert put.call_count == 1
