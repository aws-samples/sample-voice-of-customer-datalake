"""A malformed request to the scraper routes is the caller's 400, never a 5xx.

Production security probe (2026-10-06, 2.14.00): POST /scrapers/analyze-url with
an invalid-JSON or JSON-array body answered 502 — `json_body.get('url')` raised
outside any registered exception handler — and a public URL redirecting to the
metadata IP was refused (never fetched) but answered 500 "Failed to analyze URL",
because the refused hop's HTTPError fell into the generic `except`.
"""
import json
import urllib.error
from email.message import Message
from unittest.mock import patch

import pytest

import scrapers_handler
from scrapers_handler import lambda_handler

MALFORMED_BODIES = [
    pytest.param('{"url": ', id='invalid-json'),
    pytest.param('["https://public.example/"]', id='json-array'),
    pytest.param('"https://public.example/"', id='json-string'),
]


def _post(api_gateway_event, lambda_context, path: str, raw_body: str) -> tuple[int, dict]:
    event = api_gateway_event(method='POST', path=path)
    event['body'] = raw_body
    response = lambda_handler(event, lambda_context)
    return response['statusCode'], json.loads(response['body'])


@pytest.mark.parametrize('raw_body', MALFORMED_BODIES)
def test_analyze_url_answers_a_malformed_body_with_400(api_gateway_event, lambda_context, raw_body):
    with patch.object(scrapers_handler, '_fetch_html') as fetch:
        status, body = _post(api_gateway_event, lambda_context, '/scrapers/analyze-url', raw_body)

    assert status == 400
    assert body['success'] is False
    fetch.assert_not_called()


@pytest.mark.parametrize('raw_body', MALFORMED_BODIES)
def test_save_scraper_answers_a_malformed_body_with_400(api_gateway_event, lambda_context, raw_body):
    with (
        patch.object(scrapers_handler, 'SECRETS_ARN', 'arn:aws:secretsmanager:us-east-1:123:secret:test'),
        patch.object(scrapers_handler, 'put_secret_json') as put,
    ):
        status, _ = _post(api_gateway_event, lambda_context, '/scrapers', raw_body)

    assert status == 400
    put.assert_not_called()


def test_a_refused_redirect_hop_is_the_callers_400_and_nothing_is_analyzed(api_gateway_event, lambda_context):
    refused = scrapers_handler._RedirectRefusedError(
        'http://169.254.169.254/latest/meta-data/', 302,
        'Redirect refused: Access to internal/private IP addresses is not allowed', Message(), None,
    )
    with (
        patch.object(scrapers_handler, 'validate_url', return_value=(True, '')),
        patch.object(scrapers_handler._SAFE_OPENER, 'open', side_effect=refused),
        patch('shared.converse.converse') as converse,
    ):
        status, body = _post(
            api_gateway_event, lambda_context, '/scrapers/analyze-url',
            json.dumps({'url': 'https://public.example/redirects-to-metadata'}),
        )

    assert status == 400
    assert body['error'] == 'Redirect refused: Access to internal/private IP addresses is not allowed'
    converse.assert_not_called()


def test_any_other_http_error_while_fetching_stays_the_generic_500(api_gateway_event, lambda_context):
    not_found = urllib.error.HTTPError('https://public.example/', 404, 'Not Found', Message(), None)
    with (
        patch.object(scrapers_handler, 'validate_url', return_value=(True, '')),
        patch.object(scrapers_handler._SAFE_OPENER, 'open', side_effect=not_found),
    ):
        status, body = _post(
            api_gateway_event, lambda_context, '/scrapers/analyze-url',
            json.dumps({'url': 'https://public.example/'}),
        )

    assert status == 500
    assert body['error'] == 'Failed to analyze URL'
