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
from assist_worker_fixtures import inline_assist_worker, start_and_poll

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


def _analyze_when_the_fetch_fails(api_gateway_event, lambda_context, error: Exception, url: str):
    """(job status, job error, model calls) of analyze-url when opening *url* raises *error*.

    The fetch runs in the scrapers worker now (the route answers 202 first), so the
    refusal is the polled job's ``error`` — the same text the route used to answer.
    """
    with (
        inline_assist_worker(scrapers_handler, lambda_context),
        patch.object(scrapers_handler, 'validate_url', return_value=(True, '')),
        patch.object(scrapers_handler._SAFE_OPENER, 'open', side_effect=error),
        patch('shared.converse.converse') as converse,
    ):
        status, _, job = start_and_poll(scrapers_handler, api_gateway_event, lambda_context,
                                        path='/scrapers/analyze-url', body={'url': url},
                                        poll_prefix='/scrapers/jobs')
    assert status == 202
    return job['status'], job['error'], converse.call_count


def test_a_refused_redirect_hop_is_the_callers_refusal_and_nothing_is_analyzed(api_gateway_event, lambda_context):
    refused = scrapers_handler._RedirectRefusedError(
        'http://169.254.169.254/latest/meta-data/', 302,
        'Redirect refused: Access to internal/private IP addresses is not allowed', Message(), None,
    )
    assert _analyze_when_the_fetch_fails(
        api_gateway_event, lambda_context, refused, 'https://public.example/redirects-to-metadata',
    ) == ('failed', 'Redirect refused: Access to internal/private IP addresses is not allowed', 0)


@pytest.mark.parametrize(('status', 'reason'), [(404, 'Not Found'), (410, 'Gone'), (500, 'Server Error'), (503, 'Unavailable')])
def test_any_other_error_status_from_the_site_is_the_callers_refusal_naming_it(
        api_gateway_event, lambda_context, status, reason):
    """Live-caught (prod, 10-15): a target's 404 answered "Failed to analyze URL" and logged ERROR."""
    answered = urllib.error.HTTPError('https://public.example/', status, reason, Message(), None)
    with patch('shared.assist_jobs.logger') as worker_log:
        outcome = _analyze_when_the_fetch_fails(api_gateway_event, lambda_context, answered, 'https://public.example/')
    assert outcome == (
        'failed',
        f'The site refused the request (HTTP {status}), so its selectors cannot be analyzed. '
        'Check that the URL is correct and opens in a browser.',
        0,
    )
    worker_log.info.assert_called_once_with('Assist ended with a user-facing refusal',
                                            extra={'job_type': 'assist_analyze_url', 'status_code': 400})
    worker_log.warning.assert_not_called()
    worker_log.exception.assert_not_called()


def test_the_sites_status_is_logged_as_detail_not_as_a_second_warning(api_gateway_event, lambda_context):
    answered = urllib.error.HTTPError('https://public.example/', 404, 'Not Found', Message(), None)
    with patch.object(scrapers_handler, 'logger') as log:
        _analyze_when_the_fetch_fails(api_gateway_event, lambda_context, answered, 'https://public.example/')
    log.info.assert_any_call('analyze-url: the target site answered an HTTP error status',
                             extra={'upstream_status': 404})
    log.warning.assert_not_called()
    log.exception.assert_not_called()


def test_a_failure_that_is_not_the_sites_answer_stays_the_generic_error(api_gateway_event, lambda_context):
    """A dropped connection is not a site refusal: still "Failed to analyze URL", with a traceback at ERROR."""
    dropped = urllib.error.URLError('socket closed')
    with patch('shared.assist_jobs.logger') as worker_log:
        status, error, _calls = _analyze_when_the_fetch_fails(api_gateway_event, lambda_context, dropped, 'https://public.example/')
    assert (status, error) == ('failed', 'Failed to analyze URL')
    worker_log.exception.assert_called_once_with('Assist failed', extra={'job_type': 'assist_analyze_url'})


@pytest.mark.parametrize('status', [403, 429])
def test_a_site_that_refuses_plain_http_is_the_callers_refusal_with_what_to_use_instead(
        api_gateway_event, lambda_context, status):
    """Live-caught: Trustpilot answers 403 to a plain fetch; it was a 500 the assistant read as an outage."""
    refused = urllib.error.HTTPError('https://public.example/', status, 'Forbidden', Message(), None)
    job_status, error, calls = _analyze_when_the_fetch_fails(api_gateway_event, lambda_context, refused, 'https://public.example/')
    assert (job_status, error, calls) == (
        'failed',
        f'The site refused a plain HTTP request (HTTP {status}), so its selectors cannot be analyzed. '
        'Sites that block plain fetches can be read with the Web Reviews connector (managed browser) instead.',
        0,
    )
