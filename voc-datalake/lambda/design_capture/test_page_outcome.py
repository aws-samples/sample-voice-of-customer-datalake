"""A page that fails is reported for what it is: not found, blocked, a site error or a refused request.

Before 5.35.01 every main-document status ≥ 400 read as "The site blocked the secure browser (HTTP 404)".
"""
import pytest
from page_outcome import page_problem


@pytest.mark.parametrize('status', [404, 410])
def test_a_missing_page_is_reported_as_not_found_with_the_address_to_check(status):
    problem = page_problem(status, f'HTTP {status}')
    assert problem is not None
    assert str(problem) == f'The page was not found (HTTP {status}); check the address, then Fetch again'
    assert (problem.reason, problem.http_status) == ('not_found', status)


@pytest.mark.parametrize('status', [401, 403, 429])
def test_a_refusal_status_is_a_block_with_the_upload_next_step(status):
    problem = page_problem(status, f'HTTP {status}')
    assert problem is not None
    assert str(problem).startswith(f'The site blocked the secure browser (HTTP {status}); upload a screenshot')
    assert problem.reason == 'blocked'


@pytest.mark.parametrize('status', [500, 502, 503])
def test_a_server_error_says_the_site_errored_and_to_try_later(status):
    problem = page_problem(status, f'HTTP {status}')
    assert problem is not None
    assert str(problem) == f'The site answered with an error (HTTP {status}); try Fetch again later'
    assert problem.reason == 'site_error'


def test_another_client_error_is_a_refused_request():
    problem = page_problem(400, 'HTTP 400')
    assert problem is not None
    assert str(problem).startswith('The site refused the request (HTTP 400)')


@pytest.mark.parametrize('status', [403, 404, 503, 200])
def test_a_vendor_challenge_is_a_block_whatever_the_status(status):
    problem = page_problem(status, 'Cloudflare')
    assert problem is not None
    assert str(problem).startswith('The site blocked the secure browser (Cloudflare)')
    assert problem.reason == 'blocked'


def test_an_access_denied_page_with_200_is_a_block():
    problem = page_problem(200, 'access denied')
    assert problem is not None
    assert problem.reason == 'blocked'


@pytest.mark.parametrize('status', [0, 200, 304])
def test_a_readable_page_has_no_problem(status):
    assert page_problem(status, None) is None
