"""snippet_reader.py: AgentCore Web Search's request, which results are the page itself, and the reviews kept from the
snippets (only text a snippet holds)."""
import json
from typing import Any

import pytest
from extract import ExtractedReview, declared_review_count
from page_reader import PageSnapshot
from snippet_reader import (
    MAX_QUERY_CHARS,
    SEARCH_TOOL_ID,
    SearchResult,
    SnippetSearchError,
    from_snippet,
    invoke_web_search,
    on_page,
    query_for,
    search_url,
    snippet_reviews,
)
from target_reader import is_error_page

PAGE = 'https://www.g2.com/products/amazon-connect/reviews'


class Credentials:
    access_key, secret_key, token = 'AKIDEXAMPLE', 'secret', None


class Recorder:
    def __init__(self, status: int, answer: Any):
        self.status, self.answer, self.sent = status, answer, []

    def __call__(self, url: str, body: bytes, headers: dict[str, str], timeout: float) -> tuple[int, bytes]:
        self.sent.append((url, json.loads(body), headers, timeout))
        return self.status, json.dumps(self.answer).encode() if not isinstance(self.answer, bytes) else self.answer


class TestTheRequest:
    def test_one_signed_post_to_the_tools_rest_path_held_to_the_domain(self):
        post = Recorder(200, {'results': [
            {'url': PAGE, 'title': 'Reviews', 'text': 'A snippet.', 'publishedAt': '2026-10-01T00:00:00Z'},
            {'url': 'https://www.g2.com/x', 'text': 7}, {'text': 'no url'}, 'junk']})
        results = invoke_web_search('Amazon Connect reviews', 'g2.com', region='us-west-2', credentials=Credentials(),
                                    post=post)
        assert results == [SearchResult(PAGE, 'Reviews', 'A snippet.', '2026-10-01T00:00:00Z')]
        [(url, body, headers, timeout)] = post.sent
        assert url == search_url('us-west-2') == (
            f'https://bedrock-agentcore.us-west-2.amazonaws.com/web-search/{SEARCH_TOOL_ID}/invoke')
        assert body == {'searchQuery': 'Amazon Connect reviews', 'maxResults': 10,
                        'filters': {'domainFilter': {'include': ['g2.com']}}}
        assert '/us-west-2/bedrock-agentcore/aws4_request' in headers['Authorization']
        assert timeout == 60

    @pytest.mark.parametrize(('status', 'answer', 'message'), [
        (403, {'message': 'not authorized to perform: bedrock-agentcore:InvokeWebSearch'}, r'^HTTP 403: '),
        (200, {'nothing': []}, r'^an answer without results$'),
        (200, b'not json', r'^an unreadable answer$'),
    ])
    def test_a_refusal_or_an_unreadable_answer_is_an_error(self, status, answer, message):
        with pytest.raises(SnippetSearchError, match=message):
            invoke_web_search('q', 'g2.com', region='us-west-2', credentials=Credentials(), post=Recorder(status, answer))

    @pytest.mark.parametrize(('subject', 'query'), [
        ('G2 Amazon Connect', 'G2 Amazon Connect reviews'),
        ('Amazon Connect Reviews 2026 | G2', 'Amazon Connect Reviews 2026 | G2'),
        ('  spaced\n out ', 'spaced out reviews'),
    ])
    def test_the_query_is_the_subject_and_reviews(self, subject, query):
        assert query_for(subject) == query

    def test_the_query_is_bounded(self):
        assert len(query_for('x' * 500)) == MAX_QUERY_CHARS


def result(url: str, text: str = 'snippet') -> SearchResult:
    return SearchResult(url, None, text, None)


class TestTheResultsOnThePage:
    @pytest.mark.parametrize('url', [
        PAGE, f'{PAGE}/', f'{PAGE}?page=3', 'https://g2.com/products/amazon-connect/reviews',
        'https://it.g2.com/products/amazon-connect/reviews?p=2',
    ])
    def test_the_page_itself_on_any_subdomain_any_page_number(self, url):
        assert on_page([result(url)], PAGE) == [result(url)]

    @pytest.mark.parametrize('url', [
        'https://www.g2.com/products/amazon-connect/reviews/amazon-connect-review-1',
        'https://www.g2.com/products/amazon-connect/reviews?qs=pros-and-cons',
        'https://www.g2.com/compare/amazon-connect-vs-nextiva', 'https://www.g2.com/products/other/reviews',
        'https://www.notg2.com/products/amazon-connect/reviews', 'not a url',
    ])
    def test_another_page_is_not(self, url):
        assert on_page([result(url)], PAGE) == []

    def test_a_query_that_names_the_page_must_match(self):
        page = 'https://news.ycombinator.com/item?id=13976567'
        assert on_page([result('https://news.ycombinator.com/item?id=39683889'), result(page)], page) == [result(page)]


def model(*lines: dict) -> Any:
    answer = '\n'.join(json.dumps(line) for line in lines)
    return lambda _prompt, _system: answer


SNIPPET = '... Mia K. wrote on October 1, 2026: Setup was quick, routing just works. 4/5 stars ...'


class TestTheReviewsKept:
    def test_only_a_body_a_snippet_holds_is_kept(self):
        kept, dropped = snippet_reviews([result(PAGE, SNIPPET)], model(
            {'text': 'Setup was quick, routing just works.', 'rating': 4, 'date': '2026-10-01', 'title': None},
            {'text': 'Setup was quick, routing works great.', 'rating': 5}))
        assert dropped == 1
        [one] = kept
        assert one.review == ExtractedReview('Setup was quick, routing just works.', 4.0, '2026-10-01', None, None)
        assert (one.source.url, one.cut) == (PAGE, True)

    def test_a_rating_date_or_title_the_snippet_does_not_show_is_dropped_never_an_author_kept(self):
        review = ExtractedReview('Setup was quick.', 3.0, '2026-02-02', 'Great tool', 'Mia K.')
        assert from_snippet(review, 'Setup was quick. 4/5') == ExtractedReview('Setup was quick.', None, None, None,
                                                                               None)
        assert from_snippet(review, 'Great tool: Setup was quick. 3 stars, 2 Feb 2026') == ExtractedReview(
            'Setup was quick.', 3.0, '2026-02-02', 'Great tool', None)

    def test_at_most_the_cap(self):
        text = ' '.join(f'Review {n} text.' for n in range(5))
        kept, _dropped = snippet_reviews([result(PAGE, text)], model(*({'text': f'Review {n} text.'} for n in range(5))),
                                         max_reviews=2)
        assert [k.review.text for k in kept] == ['Review 0 text.', 'Review 1 text.']

    def test_no_snippet_text_calls_no_model(self):
        def no_model(_prompt: str, _system: str) -> str:
            raise AssertionError('called')
        assert snippet_reviews([result(PAGE, '   ')], no_model) == ([], 0)


def snapshot(url: str, status: int = 200, text: str = 'x' * 4000) -> PageSnapshot:
    return PageSnapshot(url=url, status=status, title='', text=text, html='', jsonld=(), next_url=None)


class TestWhatAutoReadsOfAPage:
    @pytest.mark.parametrize(('page', 'error'), [
        (snapshot('chrome-error://chromewebdata/'), True), (snapshot('https://other.example/x', 404), True),
        (snapshot('https://other.example/x', text='Just a moment...'), True), (snapshot('https://other.example/x'), False),
    ])
    def test_an_error_page(self, page, error):
        assert is_error_page(page) is error

    @pytest.mark.parametrize(('blocks', 'count'), [
        ([json.dumps({'@type': 'Product', 'aggregateRating': {'@type': 'AggregateRating', 'reviewCount': '1,204'}})], 1204),
        ([json.dumps({'@type': 'Product', 'aggregateRating': {'@type': 'AggregateRating', 'reviewCount': 812}})], 812),
        ([json.dumps({'@graph': [{'@type': 'AggregateRating', 'ratingCount': 33, 'reviewCount': 5}]})], 33),
        (['not json', json.dumps({'@type': 'Product'})], 0),
        ([json.dumps({'@type': 'AggregateRating', 'reviewCount': -3})], 0),
        ([json.dumps({'@type': 'AggregateRating', 'reviewCount': True, 'ratingCount': 'many'})], 0),
    ])
    def test_the_review_count_a_page_declares(self, blocks, count):
        assert declared_review_count(blocks) == count
