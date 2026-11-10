"""Exa web search for the Radar news scan (docs/radar.md → "Exa"): request shape, result mapping, errors."""
from unittest.mock import MagicMock

import pytest
import requests

from shared.exa_search import EXA_SEARCH_URL, TIMEOUT_SECONDS, ExaSearchError, exa_search

KEY = 'placeholder' + '_0' * 6  # a fake key


def _answer(status=200, payload=None):
    response = MagicMock(status_code=status)
    response.json.return_value = payload if payload is not None else {'results': []}
    return response


def test_the_request_carries_the_key_header_the_window_and_the_domains():
    post = MagicMock(return_value=_answer())
    exa_search(KEY, '  Acme aktualności ', since='2026-10-01', include_domains=['acme.pl'], post=post)
    post.assert_called_once_with(EXA_SEARCH_URL, timeout=TIMEOUT_SECONDS, json={
        'query': 'Acme aktualności', 'numResults': 8, 'type': 'auto',
        'startPublishedDate': '2026-10-01T00:00:00.000Z', 'includeDomains': ['acme.pl'],
    }, headers={'x-api-key': KEY, 'Content-Type': 'application/json'})


def test_no_domains_sends_no_domain_filter():
    post = MagicMock(return_value=_answer())
    exa_search(KEY, 'Acme news', since='2026-10-01', post=post)
    assert 'includeDomains' not in post.call_args.kwargs['json']


def test_results_take_the_web_search_shape():
    post = MagicMock(return_value=_answer(payload={'results': [
        {'title': 'Acme 5.0', 'url': 'https://acme.pl/n/5', 'publishedDate': '2026-10-20T08:00:00.000Z', 'text': 'x' * 2000},
        {'title': 'Only highlights', 'url': 'https://news.example/a', 'highlights': ['one', 'two']},
        {'title': 'No text', 'url': 'https://news.example/b'},
        {'title': 'Not a link', 'url': 'ftp://news.example/c'}, 'junk',
    ]}))
    found = exa_search(KEY, 'q', since='2026-10-01', post=post)
    assert [(r['url'], r['published_date'], len(r['text'])) for r in found] == [
        ('https://acme.pl/n/5', '2026-10-20', 1200), ('https://news.example/a', '', 7), ('https://news.example/b', '', 7)]
    assert set(found[0]) == {'title', 'url', 'text', 'published_date'}


@pytest.mark.parametrize('post', [
    MagicMock(side_effect=requests.ConnectionError(f'boom {KEY}')),
    MagicMock(return_value=_answer(status=401)),
    MagicMock(return_value=_answer(payload={'error': 'bad'})),
])
def test_every_failure_is_an_exa_error_without_the_key(post):
    with pytest.raises(ExaSearchError) as caught:
        exa_search(KEY, 'q', since='2026-10-01', post=post)
    assert KEY not in str(caught.value)
    assert caught.value.__cause__ is None


def test_a_non_json_answer_is_an_exa_error():
    response = MagicMock(status_code=200)
    response.json.side_effect = ValueError('no json')
    with pytest.raises(ExaSearchError, match='non-JSON'):
        exa_search(KEY, 'q', since='2026-10-01', post=MagicMock(return_value=response))
