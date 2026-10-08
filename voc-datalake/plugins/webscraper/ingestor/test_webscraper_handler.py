"""
Tests for the Web Scraper Ingestor handler.

Focus: `_extract_rating` rating extraction, including the word-based star
classes fix (issue #148, e.g. ``<p class="star-rating Three">``). Also
characterizes the pre-existing digit-class, rating-attribute, and text
fallbacks so a regression in any of them is caught. Plus the manual-run
secret-cache clear (issue #141).
"""

from unittest.mock import MagicMock, patch

import pytest
from bs4 import BeautifulSoup

from _shared.test.ingestor_fixtures import offline_ingestor_construction
from _shared.test.scoped_secret import scoped_secret

# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------

def _el(html: str):
    """Return the first tag parsed from an HTML snippet."""
    return BeautifulSoup(html, "html.parser").find()


@pytest.fixture
def ingestor():
    """Create a WebScraperIngestor with mocked AWS dependencies."""
    with offline_ingestor_construction():
        from webscraper.ingestor.handler import WebScraperIngestor
        return WebScraperIngestor()


# ---------------------------------------------------------------------------
# Word-based star classes (issue #148)
# ---------------------------------------------------------------------------

class TestExtractRatingWordClasses:
    @pytest.mark.parametrize(("word", "expected"), [
        ("One", 1), ("Two", 2), ("Three", 3), ("Four", 4), ("Five", 5),
    ])
    def test_all_word_ratings(self, ingestor, word, expected):
        # "Three" is the books.toscrape.com pattern (<p class="star-rating Three">).
        el = _el(f'<p class="star-rating {word}"></p>')
        assert ingestor._extract_rating(el, {}) == expected

    def test_word_class_is_case_insensitive(self, ingestor):
        assert ingestor._extract_rating(_el('<p class="FIVE"></p>'), {}) == 5
        assert ingestor._extract_rating(_el('<p class="four"></p>'), {}) == 4

    def test_word_only_matches_whole_class_token(self, ingestor):
        # 'foo-three' must NOT match 'three' (no substring matching), so it
        # falls through to the text fallback and returns None here.
        el = _el('<p class="foo-three"></p>')
        assert ingestor._extract_rating(el, {}) is None

    def test_out_of_range_digit_falls_through_to_word(self, ingestor):
        # First token has a digit outside 1-5 (ignored); the loop must
        # continue and resolve the word token.
        el = _el('<p class="rating-9 Three"></p>')
        assert ingestor._extract_rating(el, {}) == 3


# ---------------------------------------------------------------------------
# Pre-existing behavior (characterization / regression guards)
# ---------------------------------------------------------------------------

class TestExtractRatingExisting:
    def test_digit_in_class_still_works(self, ingestor):
        assert ingestor._extract_rating(_el('<span class="rating-4"></span>'), {}) == 4

    def test_rating_attribute_takes_precedence(self, ingestor):
        # data-rating is checked before class names.
        el = _el('<div data-rating="5" class="Two"></div>')
        assert ingestor._extract_rating(el, {}) == 5

    def test_text_fallback_x_out_of_5(self, ingestor):
        assert ingestor._extract_rating(_el('<span>4/5</span>'), {}) == 4

    def test_text_fallback_stars(self, ingestor):
        assert ingestor._extract_rating(_el('<span>3 stars</span>'), {}) == 3

    def test_none_element_returns_none(self, ingestor):
        assert ingestor._extract_rating(None, {}) is None

    def test_no_rating_signal_returns_none(self, ingestor):
        assert ingestor._extract_rating(_el('<p class="star-rating"></p>'), {}) is None


# ---------------------------------------------------------------------------
# Manual-run secret-cache clear (issue #141)
# ---------------------------------------------------------------------------

@pytest.fixture
def lambda_context():
    ctx = MagicMock()
    ctx.function_name = "test-webscraper"
    ctx.memory_limit_in_mb = 512
    ctx.invoked_function_arn = "arn:aws:lambda:us-east-1:123456789:function:test"
    ctx.aws_request_id = "test-request-id"
    return ctx


class TestLambdaHandlerSecretCache:
    """Save-then-Run-now must not serve a pre-save secret snapshot (#141).

    The cache-clear itself is centralized in BaseIngestor.__init__ (#215) and
    covered by plugins/_shared/test/test_base_ingestor.py — the handler's
    remaining contract is passing execution_id INTO the constructor, which is
    what triggers the guard. These tests fail if that pass-through is removed
    (which would silently reintroduce #141).
    """

    @patch("webscraper.ingestor.handler.WebScraperIngestor")
    def test_manual_run_passes_execution_id_to_constructor(
        self, MockIngestor, lambda_context
    ):
        from webscraper.ingestor.handler import lambda_handler
        MockIngestor.return_value.run.return_value = {"status": "success"}

        lambda_handler(
            {"execution_id": "exec-1", "scraper_id": "s1"}, lambda_context
        )

        MockIngestor.assert_called_once_with(
            execution_id="exec-1", target_scraper_id="s1"
        )

    @patch("webscraper.ingestor.handler.WebScraperIngestor")
    def test_scheduled_run_passes_no_execution_id(
        self, MockIngestor, lambda_context
    ):
        from webscraper.ingestor.handler import lambda_handler
        MockIngestor.return_value.run.return_value = {"status": "success"}

        lambda_handler({}, lambda_context)

        MockIngestor.assert_called_once_with(
            execution_id=None, target_scraper_id=None
        )

    @patch("_shared.base_ingestor.get_dynamodb_resource")
    @patch("_shared.base_ingestor.get_s3_client", new=MagicMock())
    @patch("_shared.base_ingestor.get_sqs_client", new=MagicMock())
    @patch("_shared.base_ingestor.get_secret")
    @patch("_shared.base_ingestor.clear_secret_cache")
    def test_manual_construction_clears_cache_before_config_read(
        self, mock_clear, mock_get_secret, mock_dynamo
    ):
        """End-to-end through the REAL WebScraperIngestor: constructing with
        an execution_id clears the cache before the secret/config is read."""
        call_order = []
        mock_clear.side_effect = lambda: call_order.append("clear")

        def record_get_secret(_arn):
            call_order.append("get_secret")
            return scoped_secret(configs="[]")

        mock_get_secret.side_effect = record_get_secret
        mock_dynamo.return_value.Table.return_value = MagicMock()

        from webscraper.ingestor.handler import WebScraperIngestor
        ingestor = WebScraperIngestor(execution_id="exec-1", target_scraper_id="s1")

        assert call_order == ["clear", "get_secret"]
        assert ingestor.execution_id == "exec-1"


# ---------------------------------------------------------------------------
# Outbound URL policy at fetch time (issue #244)
# ---------------------------------------------------------------------------

def _http_response(status, body='', location=None):
    response = MagicMock()
    response.status_code = status
    response.text = body
    response.headers = {'Location': location} if location else {}
    return response


_PUBLIC_DNS = [(2, 1, 6, '', ('93.184.216.34', 0))]
_REVIEW_PAGE = '<div class="review"><p class="review-text">Great product, would buy again</p></div>'


class TestFetchEnforcesUrlPolicy:
    """The scheduled/manual run re-checks every URL and redirect hop before
    requesting it, even when the stored config was never validated."""

    @patch("shared.http_utils.requests.Session.request")
    def test_a_configured_metadata_url_is_never_requested(self, mock_request, ingestor):
        from shared.http_utils import UnsafeURLError

        with pytest.raises(UnsafeURLError):
            ingestor._fetch_soup('http://169.254.169.254/latest/meta-data/')
        mock_request.assert_not_called()

    @patch("shared.http_utils.requests.Session.request")
    def test_a_redirect_to_the_metadata_ip_is_not_followed(self, mock_request, ingestor):
        from shared.http_utils import UnsafeURLError

        mock_request.return_value = _http_response(302, location='http://169.254.169.254/latest/api/token')
        with patch('shared.url_policy.socket.getaddrinfo', return_value=_PUBLIC_DNS), \
             pytest.raises(UnsafeURLError):
            ingestor._fetch_soup('https://shop.example/reviews')
        assert mock_request.call_count == 1
        assert mock_request.call_args.kwargs['allow_redirects'] is False

    def test_a_dns_rebind_to_the_runtime_api_never_connects(self, ingestor):
        """Public to the check, 127.0.0.1 to the connect: refused, no socket opened (real requests stack)."""
        from shared.http_utils import UnsafeURLError

        answers = iter(['93.184.216.34', '127.0.0.1'])

        def rebinding(_host, port, *_args, **_kwargs):
            return [(2, 1, 6, '', (next(answers, '127.0.0.1'), port or 0))]

        with patch('shared.url_policy.socket.getaddrinfo', side_effect=rebinding), \
             patch('shared.url_policy.socket.create_connection') as connect, \
             pytest.raises(UnsafeURLError):
            ingestor._fetch_soup('http://shop.example:9001/2018-06-01/runtime/invocation/next')
        connect.assert_not_called()

    @patch("webscraper.ingestor.handler.time.sleep", new=MagicMock())
    @patch("shared.http_utils.requests.Session.request")
    def test_a_blocked_url_fails_alone_and_the_run_continues(self, mock_request, ingestor):
        def resolver(host, *_args, **_kwargs):
            ip = '10.0.0.9' if host == 'intranet.example' else '93.184.216.34'
            return [(2, 1, 6, '', (ip, 0))]

        mock_request.return_value = _http_response(200, _REVIEW_PAGE)
        ingestor.scraper_configs = [{
            'id': 's1', 'name': 'Mixed',
            'urls': ['https://intranet.example/admin', 'https://shop.example/reviews'],
        }]
        ingestor.execution_id = 'exec-1'
        status_updates = []
        ingestor._update_run_status = lambda _sid, updates: status_updates.append(updates)
        ingestor.set_watermark = MagicMock()

        with patch('shared.url_policy.socket.getaddrinfo', side_effect=resolver):
            items = list(ingestor.fetch_new_items())

        assert [i['url'] for i in items] == ['https://shop.example/reviews']
        assert [c.kwargs['url'] for c in mock_request.call_args_list] == ['https://shop.example/reviews']
        final = status_updates[-1]
        assert final['status'] == 'completed_with_errors'
        assert len(final['errors']) == 1
        assert 'https://intranet.example/admin' in final['errors'][0]
        assert final['errors'][0] == (
            'Error scraping https://intranet.example/admin: URL blocked by policy '
            '(Access to internal/private IP addresses is not allowed)'
        )

    @patch("webscraper.ingestor.handler.time.sleep", new=MagicMock())
    def test_a_failing_page_records_the_exception_class_not_its_text(self, ingestor):
        """Run errors are readable by every user via GET /logs/scraper/*: no str(e)."""
        ingestor.scraper_configs = [{'id': 's1', 'name': 'Broken', 'urls': ['https://shop.example/reviews']}]
        ingestor.execution_id = 'exec-1'
        status_updates = []
        ingestor._update_run_status = lambda _sid, updates: status_updates.append(updates)
        ingestor.set_watermark = MagicMock()
        ingestor._scrape_page = MagicMock(side_effect=KeyError('review by jane.doe@example.com'))

        list(ingestor.fetch_new_items())

        assert status_updates[-1]['errors'] == ['Error scraping https://shop.example/reviews: KeyError']


# ---------------------------------------------------------------------------
# 'Manual only' schedule: frequency_minutes 0
# ---------------------------------------------------------------------------

class TestManualOnlySchedule:
    """`frequency_minutes: 0` is 'Manual only' in the Scrapers UI: a scheduled tick
    must never run it, however long ago (or whether) it last ran; a manual run
    (`execution_id`) still does."""

    @pytest.mark.parametrize('last_run', [None, '2000-01-01T00:00:00+00:00'])
    def test_a_manual_only_scraper_is_never_due(self, ingestor, last_run):
        ingestor.get_watermark = MagicMock(return_value=last_run)

        assert ingestor._should_run_scraper({'id': 's1', 'frequency_minutes': 0}) is False

    def test_a_scheduled_tick_skips_it(self, ingestor):
        ingestor.scraper_configs = [{'id': 's1', 'frequency_minutes': 0, 'urls': ['https://shop.example/r']}]
        ingestor.get_watermark = MagicMock(return_value=None)
        ingestor._scrape_page = MagicMock(return_value=[])

        assert list(ingestor.fetch_new_items()) == []
        ingestor._scrape_page.assert_not_called()

    @patch("webscraper.ingestor.handler.time.sleep", new=MagicMock())
    def test_a_manual_run_still_scrapes_it(self, ingestor):
        ingestor.scraper_configs = [{'id': 's1', 'frequency_minutes': 0, 'urls': ['https://shop.example/r']}]
        ingestor.execution_id = 'exec-1'
        ingestor.target_scraper_id = 's1'
        ingestor._update_run_status = MagicMock()
        ingestor.set_watermark = MagicMock()
        ingestor._scrape_page = MagicMock(return_value=[{'id': 'r1'}])

        assert list(ingestor.fetch_new_items()) == [{'id': 'r1'}]
        ingestor._scrape_page.assert_called_once()


# ---------------------------------------------------------------------------
# Scraper dimension defaults and tags travel on every message
# ---------------------------------------------------------------------------

class TestScraperLabels:
    def _item(self, ingestor, config):
        return ingestor._scraped_item(
            {'id': 's1', 'name': 'Shop', **config}, 'https://shop.example/reviews',
            item_url='https://shop.example/r/1', extraction_method='css', channel='web',
            title='', text='Great', rating=5, created_at='2026-01-15T00:00:00+00:00', author='A')

    def test_defaults_and_tags_become_message_labels(self, ingestor):
        item = self._item(ingestor, {'dimension_defaults': {'product': 'app'}, 'tags': ['vip', 'VIP']})
        assert (item['dimensions'], item['tags']) == ({'product': 'app'}, ['vip'])

    def test_a_scraper_without_them_adds_neither(self, ingestor):
        assert not {'dimensions', 'tags'} & set(self._item(ingestor, {}))
