"""``method: bedrock_web_search`` (7.41.00): a target's page read from the Amazon Bedrock web search cache.

* the request: SigV4-signed for ``bedrock-mantle`` (no API key), the Responses API path of the region, the
  ``web_search`` tool cache-only (``external_web_access: false``), held to the target's site, the JSON schema;
  a model that refuses the schema is asked once more without it;
* the answer: the model's reviews, checked (a ``summary`` or a body that reads like one is dropped, ratings to
  1-5 by their scale, ISO dates only, each review once, the cap), the URLs it opened and cited;
* the handler: a web-search target is never read in the browser (no session for a run of them only), its reviews
  are queued with their attribution, a refusal or an unopened page is reported;
* the model (7.42.00): the web_reviews_search surface's (its pick in Administration -> AI models, else Luna), never
  the target's; a model that is throttled or has no capacity hands the page to the next one of the surface's chain.
"""
import json
from contextlib import contextmanager
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.credentials import Credentials
from test_web_reviews_handler import ingestor, target_config
from web_search_reader import (
    REVIEWS_SCHEMA,
    WebSearchError,
    WebSearchRead,
    page_reviews,
    read_web_search_target,
    read_with_fallback,
    request_body,
    site_domain,
)

from shared import model_fallback
from shared.mantle_responses import responses_url
from shared.model_config import WEB_SEARCH_FALLBACK_ORDER

URL = 'https://www.g2.com/products/amazon-connect/reviews'
CREDENTIALS = Credentials('AKIDEXAMPLE', 'secret')


def answer(reviews: list[dict[str, Any]], *, fetched: bool = True, reason: str | None = None,
           calls: list[dict[str, Any]] | None = None, citations: list[str] | None = None) -> dict[str, Any]:
    text = json.dumps({'fetched': fetched, 'reason': reason, 'reviews': reviews})
    annotations = [{'type': 'url_citation', 'url': url, 'title': 't'} for url in citations or []]
    return {'output': [*(calls or []), {
        'type': 'message', 'content': [{'type': 'output_text', 'text': text, 'annotations': annotations}],
    }]}


def review(body: str = 'Easy setup and very low latency for our remote agents.', **fields: Any) -> dict[str, Any]:
    return {'review_kind': 'review', 'author': None, 'rating': None, 'rating_scale': None, 'date': None,
            'title': None, 'body': body, **fields}


class Recorder:
    """A ``post`` that records what was sent and answers from *answers* in order (status, body)."""

    def __init__(self, *answers: tuple[int, object]):
        self.answers = list(answers)
        self.sent: list[tuple[str, dict[str, Any], dict[str, str], float]] = []

    def __call__(self, url: str, body: bytes, headers: dict[str, str], timeout: float) -> tuple[int, bytes]:
        self.sent.append((url, json.loads(body), headers, timeout))
        status, payload = self.answers.pop(0)
        return status, payload if isinstance(payload, bytes) else json.dumps(payload).encode()


def read(*answers: tuple[int, object], max_reviews: int = 20) -> tuple[WebSearchRead, Recorder]:
    post = Recorder(*answers)
    return read_web_search_target(URL, 'openai.gpt-5.6-luna', max_reviews, region='us-west-2',
                                  credentials=CREDENTIALS, post=post), post


class TestTheRequest:
    def test_is_signed_for_bedrock_mantle_and_sent_to_the_regions_responses_api(self):
        _read, post = read((200, answer([review()])))
        [(url, body, headers, timeout)] = post.sent
        assert url == 'https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses' == responses_url('us-west-2')
        assert headers['Authorization'].startswith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/')
        assert '/us-west-2/bedrock-mantle/aws4_request' in headers['Authorization']
        assert (headers['Content-Type'], timeout) == ('application/json', 180)
        assert body['model'] == 'openai.gpt-5.6-luna'

    def test_uses_the_cache_only_held_to_the_site(self):
        body = request_body(URL, 'openai.gpt-5.6-terra', 7)
        assert body['tools'] == [{'type': 'web_search', 'external_web_access': False, 'search_context_size': 'low',
                                  'filters': {'allowed_domains': ['g2.com']}}]
        assert URL in body['input']
        assert 'at most 7' in body['input']
        assert body['text'] == {'format': {'type': 'json_schema', 'name': 'page_reviews', 'strict': True,
                                           'schema': REVIEWS_SCHEMA}}

    @pytest.mark.parametrize(('url', 'domain'), [
        ('https://www.trustradius.com/products/x/reviews', 'trustradius.com'),
        ('https://uk.trustpilot.com/review/www.amazon.co.uk', 'uk.trustpilot.com'),
        ('https://WWW.Gartner.com/reviews/product/amazon-connect', 'gartner.com'),
    ])
    def test_the_site_is_the_host_without_www(self, url: str, domain: str):
        assert site_domain(url) == domain

    def test_a_model_that_refuses_the_schema_is_asked_once_more_without_it(self):
        refused = (400, {'error': {'message': "Unsupported parameter: 'text.format' with tools"}})
        result, post = read(refused, (200, answer([review()])))
        assert [('text' in body) for _url, body, _h, _t in post.sent] == [True, False]
        assert len(result.reviews) == 1

    @pytest.mark.parametrize(('status', 'payload'), [(403, {'message': 'not authorized to perform CreateInference'}),
                                                     (400, {'error': {'message': 'model not found'}}),
                                                     (500, b'oops')])
    def test_any_other_refusal_is_a_web_search_error_naming_the_status(self, status: int, payload: object):
        with pytest.raises(WebSearchError, match=rf'^HTTP {status}: '):
            read((status, payload))

    def test_no_answer_is_a_web_search_error(self):
        def silent(*_args: object) -> tuple[int, bytes]:
            raise TimeoutError('timed out')

        with pytest.raises(WebSearchError, match=r'^no answer \(TimeoutError\)$'):
            read_web_search_target(URL, 'm', 5, region='us-west-2', credentials=CREDENTIALS, post=silent)

    @pytest.mark.parametrize('payload', [b'not json', b'[1, 2]'])
    def test_an_unreadable_answer_is_a_web_search_error(self, payload: bytes):
        with pytest.raises(WebSearchError, match=r'^an unreadable answer$'):
            read((200, payload))


class TestTheAnswer:
    def test_reviews_keep_their_fields_with_ratings_on_a_five_point_scale(self):
        result, _post = read((200, answer([
            review('Great routing.', author='Ana P.', rating=8, rating_scale=10, date='2026-09-14', title='Solid'),
            review('Works.', rating=4, rating_scale=None),
        ])))
        first, second = result.reviews
        assert (first.text, first.author, first.rating, first.date, first.title) == (
            'Great routing.', 'Ana P.', 4.0, '2026-09-14', 'Solid')
        assert second.rating == 4.0

    def test_summaries_are_dropped_whether_marked_or_not(self):
        result, _post = read((200, answer([
            review('Amazon Connect receives positive feedback for its interface; some users find it hard.',
                   author='Hariesh S.'),
            review('An overview of ratings.', review_kind='summary'),
            review('Our agents like the softphone.'),
        ])))
        assert [r.text for r in result.reviews] == ['Our agents like the softphone.']
        assert result.dropped == 2

    def test_an_odd_rating_or_date_is_dropped_and_the_review_kept(self):
        result, _post = read((200, answer([review('Fine.', rating=0, rating_scale=10, date='March 2026')])))
        [kept] = result.reviews
        assert (kept.rating, kept.date) == (None, None)

    def test_each_review_once_and_at_most_the_cap(self):
        bodies = [review(f'Review number {n}.') for n in range(5)]
        result, _post = read((200, answer([*bodies, bodies[0]])), max_reviews=3)
        assert [r.text for r in result.reviews] == ['Review number 0.', 'Review number 1.', 'Review number 2.']

    def test_an_unopened_page_says_why(self):
        result, _post = read((200, answer([], fetched=False, reason='not in the cache')))
        assert (result.fetched, result.reason, result.reviews) == (False, 'not in the cache', [])

    def test_the_opened_and_cited_urls_are_kept_in_order_each_once(self):
        calls = [{'type': 'web_search_call', 'action': {'type': 'open_page', 'url': URL}},
                 {'type': 'web_search_call', 'action': {'type': 'search', 'query': 'amazon connect'}},
                 {'type': 'web_search_call', 'action': {'type': 'open_page', 'url': URL}},
                 {'type': 'reasoning'}]
        result, _post = read((200, answer([review()], calls=calls, citations=[URL, f'{URL}?page=2', URL])))
        assert result.opened_urls == [URL]
        assert result.cited_urls == [URL, f'{URL}?page=2']

    @pytest.mark.parametrize('text', [
        '```json\n[{"review_kind": "review", "body": "Fenced list."}]\n```',
        '[{"body": "A bare list, no kind."}]',
    ])
    def test_a_fenced_or_bare_list_is_read_as_the_reviews(self, text: str):
        fetched, _reason, reviews, _dropped = page_reviews(text, 10)
        assert fetched is True
        assert len(reviews) == 1

    def test_text_that_is_not_the_json_is_an_unopened_page(self):
        assert page_reviews('FETCH_FAILED: blocked', 10) == (False, 'the answer was not the JSON asked for', [], 0)


@contextmanager
def web_search_run(configs: list[dict[str, str]], result: WebSearchRead | Exception) -> Any:
    from web_reviews.ingestor import handler

    session = MagicMock()
    with ingestor(configs, session=session) as run, patch.object(handler, 'browser_session', return_value=session) as start:
        searched = patch.object(run, '_web_search', side_effect=[result])
        with searched as call:
            yield run, start, call


SEARCH_TARGET = target_config(method='bedrock_web_search', max_reviews='5')


class TestTheHandler:
    def test_a_web_search_target_is_never_read_in_the_browser_and_carries_its_attribution(self):
        found = WebSearchRead(reviews=page_reviews(json.dumps({'reviews': [review('Low latency.', date='2026-10-02')]}), 9)[2],
                              model='openai.gpt-5.6-terra', fetched=True, opened_urls=[target_config()['url']])
        with web_search_run([SEARCH_TARGET], found) as (run, start, call):
            items = list(run.fetch_new_items())
        start.assert_not_called()
        assert call.call_args.args[1] == 5
        [item] = items
        metadata = item['metadata']
        assert {key: metadata[key] for key in ('method', 'model', 'site', 'source_url', 'opened_urls', 'cited_urls')} == {
            'method': 'bedrock_web_search', 'model': 'openai.gpt-5.6-terra', 'site': 'www.trustpilot.com',
            'source_url': target_config()['url'], 'opened_urls': target_config()['url'], 'cited_urls': '',
        }
        assert metadata['fetched_at'].startswith('20')
        assert (item['text'], item['url'], metadata['page']) == ('Low latency.', target_config()['url'], 1)

    def test_a_refusal_is_reported_on_the_target(self):
        with web_search_run([SEARCH_TARGET], WebSearchError('HTTP 403: denied')) as (run, _start, _call):
            assert list(run.fetch_new_items()) == []
        assert run.run_errors == ['Trustpilot: Amazon Bedrock web search failed (HTTP 403: denied)']

    def test_an_unopened_page_is_reported(self):
        unopened = WebSearchRead(reviews=[], model='m', fetched=False, reason='not in the cache')
        with web_search_run([SEARCH_TARGET], unopened) as (run, _start, _call):
            assert list(run.fetch_new_items()) == []
        assert run.run_errors == ['Trustpilot: Amazon Bedrock web search could not open the page (not in the cache)']

    @pytest.mark.parametrize(('pick', 'chain'), [
        ('openai.gpt-5.6-luna',
         ('openai.gpt-5.6-luna', 'openai.gpt-5.6-terra', 'openai.gpt-5.6-sol', 'openai.gpt-5.5', 'openai.gpt-5.4')),
        ('openai.gpt-5.6-sol',
         ('openai.gpt-5.6-sol', 'openai.gpt-5.6-luna', 'openai.gpt-5.6-terra', 'openai.gpt-5.5', 'openai.gpt-5.4')),
    ])
    def test_the_surfaces_model_and_its_chain_read_the_page_never_the_targets(self, pick, chain):
        from web_reviews.ingestor import handler

        stored = target_config(method='bedrock_web_search', model='openai.gpt-5.4')  # a 7.41.00 page model: ignored
        with ingestor([stored]) as run, \
                patch.object(handler, 'get_active_model_id', return_value=pick) as resolve, \
                patch.object(handler, 'read_with_fallback',
                             return_value=WebSearchRead(reviews=[], model='x', fetched=True)) as reader:
            list(run.fetch_new_items())
        resolve.assert_called_once_with('web_reviews_search')
        assert reader.call_args.args[1] == chain
        assert reader.call_args.kwargs['region']


@pytest.fixture
def no_cooldowns():
    """shared.model_fallback remembers a model that could not serve for five minutes; each test starts clean."""
    model_fallback.cooldown_until.clear()
    yield
    model_fallback.cooldown_until.clear()


@pytest.mark.usefixtures('no_cooldowns')
class TestTheCapacityFallback:
    @staticmethod
    def read(*answers: tuple[int, object]) -> tuple[WebSearchRead, Recorder, MagicMock]:
        post = Recorder(*answers)
        with patch.object(model_fallback, 'record_fallback') as recorded:
            result = read_with_fallback(URL, WEB_SEARCH_FALLBACK_ORDER, 20, region='us-west-2',
                                        credentials=CREDENTIALS, post=post)
        return result, post, recorded

    def test_a_throttled_model_hands_the_page_to_the_next(self):
        result, post, recorded = self.read((429, {'error': {'message': 'Too many requests'}}),
                                           (200, answer([review()])))
        assert [body['model'] for _url, body, _h, _t in post.sent] == ['openai.gpt-5.6-luna', 'openai.gpt-5.6-terra']
        assert (result.model, len(result.reviews)) == ('openai.gpt-5.6-terra', 1)
        recorded.assert_called_once_with('web_reviews_search', 'openai.gpt-5.6-luna', 'openai.gpt-5.6-terra',
                                         'HTTP 429')
        assert model_fallback.is_cooling_down('openai.gpt-5.6-luna')

    def test_no_capacity_steps_down_the_whole_family(self):
        busy = (503, {'error': {'message': 'Service Unavailable'}})
        result, post, recorded = self.read(busy, busy, busy, busy, (200, answer([review()])))
        assert [body['model'] for _url, body, _h, _t in post.sent] == list(WEB_SEARCH_FALLBACK_ORDER)
        assert result.model == 'openai.gpt-5.4'
        assert recorded.call_count == 4

    def test_any_other_refusal_is_raised_at_once(self):
        post = Recorder((403, {'message': 'not authorized to perform: bedrock-mantle:CreateInference'}))
        with patch.object(model_fallback, 'record_fallback') as recorded, \
                pytest.raises(WebSearchError, match=r'^HTTP 403: '):
            read_with_fallback(URL, WEB_SEARCH_FALLBACK_ORDER, 20, region='us-west-2', credentials=CREDENTIALS,
                               post=post)
        recorded.assert_not_called()
        assert len(post.sent) == 1

    def test_when_every_model_fails_the_first_ones_error(self):
        post = Recorder(*[(429, {'error': {'message': f'busy {n}'}}) for n in range(5)])
        with patch.object(model_fallback, 'record_fallback'), pytest.raises(WebSearchError, match=r'busy 0'):
            read_with_fallback(URL, WEB_SEARCH_FALLBACK_ORDER, 20, region='us-west-2', credentials=CREDENTIALS,
                               post=post)
        assert len(post.sent) == 5
