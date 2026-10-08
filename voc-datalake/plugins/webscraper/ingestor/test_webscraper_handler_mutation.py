"""Mutation hardening for `webscraper/ingestor/handler.py`.

`test_webscraper_handler.py` pins `_extract_rating` and the constructor's
`execution_id` pass-through (#141). A mutation run found the rest of the module
unobserved by any test:

* every DEFAULT a scraper config falls back to — `.review` containers,
  `.review-text` text, `a` links, `data-rating`, `page`/5/1 pagination,
  60-minute frequency — could change and no test would notice;
* the pipeline RECORD `_scraped_item` builds: its id prefix, channel names,
  `extraction_method`, `source_platform_override`, the `title\\n\\ntext` join;
* the two length floors (JSON-LD body ≥ 5, CSS text ≥ 10), the 1-5 class-digit
  window and the 1..5 clamp of the text fallback, each on BOTH sides;
* the run bookkeeping a manual "Run now" is reported through — the exact
  `SCRAPER_RUN#` update_item call, `pages_scraped`/`items_found`/`current_url`
  per page, `completed` vs `completed_with_errors`, the per-scraper metric,
  the 2.0-5.0 s inter-page jitter — and the `>=` of the due-time check;
* every WARNING/ERROR a scraper operator reads in CloudWatch to diagnose a
  blocked site or a selector that matches nothing.
"""
import hashlib
import importlib
import json
import os
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import MagicMock, call, patch

import pytest
import requests
from aws_lambda_powertools.metrics.provider.cold_start import reset_cold_start_flag
from botocore.exceptions import BotoCoreError, ClientError
from bs4 import BeautifulSoup

from _shared.base_ingestor import logger as real_logger
from _shared.base_ingestor import metrics as real_metrics
from _shared.base_ingestor import tracer
from _shared.test.scoped_secret import scoped_secret
from shared.test.emf_fixtures import emf_metric_names

if TYPE_CHECKING:
    from webscraper.ingestor.handler import WebScraperIngestor

HANDLER = 'webscraper.ingestor.handler'
CONFIG = {'id': 'shop', 'name': 'Shop Reviews'}
URL = 'https://shop.example.com/reviews'


def _el(html: str):
    return BeautifulSoup(html, 'html.parser').find()


def _soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, 'html.parser')


@contextmanager
def _constructing(configs: str | None = None, **env):
    """Patch the AWS seams BaseIngestor touches; the plugin secret carries *configs*."""
    secret = scoped_secret(configs=configs) if configs is not None else scoped_secret()
    with (
        patch('_shared.base_ingestor.get_dynamodb_resource') as dynamo,
        patch('_shared.base_ingestor.get_s3_client'),
        patch('_shared.base_ingestor.get_sqs_client'),
        patch('_shared.base_ingestor.get_secret', return_value=secret),
        patch.dict('os.environ', env, clear=False),
    ):
        dynamo.return_value.Table.return_value = MagicMock()
        yield


def _ingestor(configs: str | None = None, **kwargs):
    with _constructing(configs):
        from webscraper.ingestor.handler import WebScraperIngestor
        return WebScraperIngestor(**kwargs)


@pytest.fixture
def ingestor():
    return _ingestor()


@pytest.fixture
def logger():
    with patch(f'{HANDLER}.logger') as mock:
        yield mock


# ---------------------------------------------------------------------------
# Construction and config loading
# ---------------------------------------------------------------------------

class TestConstruction:
    def test_browser_headers_are_exactly_these(self, ingestor):
        assert ingestor.headers == {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
                          '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,'
                      'image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate',
            'Cache-Control': 'no-cache',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
        }

    def test_without_aggregates_table_env_there_is_no_table(self):
        with _constructing(AGGREGATES_TABLE=''):
            from webscraper.ingestor.handler import WebScraperIngestor
            ingestor = WebScraperIngestor()
        assert ingestor.aggregates_table_name == ''
        assert ingestor.aggregates_table is None

    def test_an_unset_aggregates_table_env_is_the_same_as_empty(self):
        with _constructing(), patch.dict('os.environ'), patch('boto3.resource') as resource:
            os.environ.pop('AGGREGATES_TABLE', None)
            from webscraper.ingestor.handler import WebScraperIngestor
            ingestor = WebScraperIngestor()
        assert ingestor.aggregates_table_name == ''
        assert ingestor.aggregates_table is None
        resource.assert_not_called()

    def test_aggregates_table_is_resolved_from_env_through_boto3(self):
        with _constructing(AGGREGATES_TABLE='voc-aggregates'), patch('boto3.resource') as resource:
            from webscraper.ingestor.handler import WebScraperIngestor
            ingestor = WebScraperIngestor()
        resource.assert_called_once_with('dynamodb')
        resource.return_value.Table.assert_called_once_with('voc-aggregates')
        assert ingestor.aggregates_table_name == 'voc-aggregates'
        assert ingestor.aggregates_table is resource.return_value.Table.return_value

    def test_target_scraper_id_is_kept(self):
        assert _ingestor(target_scraper_id='s9').target_scraper_id == 's9'


class TestLoadScraperConfigs:
    def test_missing_configs_key_means_no_scrapers_and_is_not_an_error(self):
        with patch(f'{HANDLER}.logger') as logger:
            ingestor = _ingestor()
        assert ingestor.scraper_configs == []
        logger.exception.assert_not_called()

    def test_empty_string_means_no_scrapers(self):
        assert _ingestor(configs='').scraper_configs == []

    def test_only_enabled_configs_load_and_enabled_defaults_to_true(self):
        configs = json.dumps([
            {'id': 'a'}, {'id': 'b', 'enabled': False}, {'id': 'c', 'enabled': True},
        ])
        assert [c['id'] for c in _ingestor(configs=configs).scraper_configs] == ['a', 'c']

    def test_target_id_selects_that_config_even_when_disabled(self):
        configs = json.dumps([{'id': 'a'}, {'id': 'b', 'enabled': False}])
        ingestor = _ingestor(configs=configs, target_scraper_id='b')
        assert ingestor.scraper_configs == [{'id': 'b', 'enabled': False}]

    def test_target_id_matching_nothing_loads_nothing(self):
        assert _ingestor(configs='[{"id": "a"}]', target_scraper_id='zz').scraper_configs == []

    def test_invalid_json_is_logged_and_loads_nothing(self):
        with patch(f'{HANDLER}.logger') as logger:
            ingestor = _ingestor(configs='{not json')
        assert ingestor.scraper_configs == []
        logger.exception.assert_called_once_with('Invalid webscraper_configs JSON')


# ---------------------------------------------------------------------------
# Run-status bookkeeping
# ---------------------------------------------------------------------------

class TestUpdateRunStatus:
    def test_writes_the_scraper_run_record_with_one_placeholder_per_key(self):
        ingestor = _ingestor(execution_id='exec-7')
        ingestor.aggregates_table = MagicMock()
        ingestor._update_run_status('shop', {'status': 'completed', 'items_found': 3})
        ingestor.aggregates_table.update_item.assert_called_once_with(
            Key={'pk': 'SCRAPER_RUN#shop', 'sk': 'exec-7'},
            UpdateExpression='SET #status = :status, #items_found = :items_found',
            ExpressionAttributeNames={'#status': 'status', '#items_found': 'items_found'},
            ExpressionAttributeValues={':status': 'completed', ':items_found': 3},
        )

    def test_no_table_writes_nothing(self, logger):
        ingestor = _ingestor(execution_id='exec-7')
        ingestor.aggregates_table = None
        ingestor._update_run_status('shop', {'status': 'completed'})
        logger.warning.assert_not_called()

    def test_no_execution_id_writes_nothing(self, ingestor):
        ingestor.aggregates_table = MagicMock()
        ingestor.execution_id = None
        ingestor._update_run_status('shop', {'status': 'completed'})
        ingestor.aggregates_table.update_item.assert_not_called()

    @pytest.mark.parametrize('error', [
        TypeError('Float types are not supported'),
        BotoCoreError(),
        ClientError({'Error': {'Code': 'Throttling', 'Message': 'slow down'}}, 'UpdateItem'),
    ])
    def test_a_failed_write_is_a_warning_with_traceback(self, logger, error):
        ingestor = _ingestor(execution_id='exec-7')
        ingestor.aggregates_table = MagicMock()
        ingestor.aggregates_table.update_item.side_effect = error
        ingestor._update_run_status('shop', {'status': 'completed'})
        logger.warning.assert_called_once_with(
            f'Failed to update run status: {error}', exc_info=True)


# ---------------------------------------------------------------------------
# Field extraction
# ---------------------------------------------------------------------------

class TestGenerateId:
    def test_is_the_first_16_hex_of_sha256_over_url_colon_text(self, ingestor):
        expected = hashlib.sha256(b'https://x/a:hello').hexdigest()[:16]
        assert ingestor._generate_id('https://x/a', 'hello') == expected
        assert len(expected) == 16

    def test_only_the_first_100_characters_of_text_count(self, ingestor):
        base = 'a' * 100
        same = ingestor._generate_id(URL, base + 'X')
        assert ingestor._generate_id(URL, base + 'Y') == same      # the 101st char is ignored
        assert ingestor._generate_id(URL, base) == same
        assert ingestor._generate_id(URL, base[:99] + 'Z') != same  # the 100th char counts
        assert ingestor._generate_id(URL, 'b' + base[1:]) != same


class TestExtractText:
    def test_none_element_is_empty(self, ingestor):
        assert ingestor._extract_text(None, {}) == ''

    def test_default_is_stripped_text(self, ingestor):
        assert ingestor._extract_text(_el('<p>  hi  there </p>'), {}) == 'hi  there'

    def test_attribute_config_reads_that_attribute(self, ingestor):
        el = _el('<meta content="from attr">text</meta>')
        assert ingestor._extract_text(el, {'attribute': 'content'}) == 'from attr'

    def test_missing_attribute_is_empty_not_text(self, ingestor):
        assert ingestor._extract_text(_el('<p>text</p>'), {'attribute': 'content'}) == ''


class TestExtractRatingBoundaries:
    @pytest.mark.parametrize(('html', 'expected'), [
        ('<i data-rating="4.6"></i>', 4),          # int(float()) truncates
        ('<i data-rating="nope" class="Two"></i>', 2),   # unparseable attr falls through
        ('<i class="rating-0 Four"></i>', 4),       # 0 is below the window
        ('<i class="rating-1"></i>', 1),
        ('<i class="rating-5"></i>', 5),
        ('<i class="rating-6 Four"></i>', 4),       # 6 is above the window
        ('<i>4.9 / 5</i>', 4),
        ('<i>1 Star</i>', 1),
        ('<i>5★</i>', 5),
        ('<i>9 stars</i>', 5),                       # clamped down
        ('<i>0 stars</i>', 1),                       # clamped up
        ('<i>4 points</i>', None),
        ('<i>1<b> </b>0 stars</i>', 5),              # stripped pieces concatenate: '10 stars' → clamped
    ])
    def test_exact_value(self, ingestor, html, expected):
        assert ingestor._extract_rating(_el(html), {}) == expected

    def test_custom_attribute_is_read_not_data_rating(self, ingestor):
        el = _el('<i data-rating="5" data-stars="2"></i>')
        assert ingestor._extract_rating(el, {'rating_attribute': 'data-stars'}) == 2


# ---------------------------------------------------------------------------
# The pipeline record
# ---------------------------------------------------------------------------

class TestScrapedItem:
    def test_every_field_of_the_record(self, ingestor):
        item = ingestor._scraped_item(
            CONFIG, URL, item_url='https://shop.example.com/r/1', extraction_method='css',
            channel='web_scrape', title='Great', text='Loved it a lot', rating=5,
            created_at='2024-01-01T00:00:00+00:00', author='Ann',
        )
        item_id = hashlib.sha256(b'https://shop.example.com/r/1:Loved it a lot').hexdigest()[:16]
        assert item == {
            'id': f'scraper_shop_{item_id}',
            'channel': 'web_scrape',
            'url': 'https://shop.example.com/r/1',
            'text': 'Great\n\nLoved it a lot',
            'title': 'Great',
            'rating': 5,
            'created_at': '2024-01-01T00:00:00+00:00',
            'brand_handles_matched': ['TestBrand'],
            'author': 'Ann',
            'scraper_id': 'shop',
            'scraper_name': 'Shop Reviews',
            'domain': 'shop.example.com',
            'extraction_method': 'css',
            'source_platform_override': 'Shop Reviews',
        }

    def test_no_title_leaves_text_alone_and_name_defaults_to_the_domain(self, ingestor):
        item = ingestor._scraped_item(
            {'id': 'shop'}, URL, item_url=URL, extraction_method='jsonld',
            channel='web_scrape_jsonld', title='', text='Loved it', rating=None,
            created_at='x', author='Anonymous',
        )
        assert item['text'] == 'Loved it'
        assert item['title'] == ''
        assert item['scraper_name'] == 'shop.example.com'
        assert item['source_platform_override'] == 'shop.example.com'


# ---------------------------------------------------------------------------
# JSON-LD
# ---------------------------------------------------------------------------

def _review(**overrides) -> dict:
    return {'@type': 'Review', 'reviewBody': 'Solid product', **overrides}


def _assert_blank_defaults(item: dict, *, channel: str, extraction_method: str) -> None:
    """*item* carries every default an extractor fills in when the source
    gives only a body, scraped at the frozen 2024-03-01T12:00Z clock."""
    assert item['title'] == ''
    assert item['rating'] is None
    assert item['author'] == 'Anonymous'
    assert item['created_at'] == '2024-03-01T12:00:00+00:00'
    assert item['url'] == URL
    assert item['channel'] == channel
    assert item['extraction_method'] == extraction_method


class TestExtractFromJsonldItem:
    def test_body_of_four_characters_is_dropped_five_is_kept(self, ingestor):
        assert ingestor._extract_from_jsonld_item(_review(reviewBody='abcd'), CONFIG, URL) is None
        kept = ingestor._extract_from_jsonld_item(_review(reviewBody='abcde'), CONFIG, URL)
        assert kept['text'] == 'abcde'

    def test_missing_body_is_dropped(self, ingestor):
        assert ingestor._extract_from_jsonld_item({'@type': 'Review'}, CONFIG, URL) is None

    def test_defaults_when_the_item_carries_only_a_body(self, ingestor):
        fixed = datetime(2024, 3, 1, 12, 0, tzinfo=UTC)
        with patch(f'{HANDLER}.datetime') as dt:
            dt.now.return_value = fixed
            item = ingestor._extract_from_jsonld_item(_review(), CONFIG, URL)
        dt.now.assert_called_once_with(UTC)
        _assert_blank_defaults(item, channel='web_scrape_jsonld', extraction_method='jsonld')

    def test_headline_wins_over_name(self, ingestor):
        item = ingestor._extract_from_jsonld_item(_review(headline='H', name='N'), CONFIG, URL)
        assert item['title'] == 'H'
        assert ingestor._extract_from_jsonld_item(_review(name='N'), CONFIG, URL)['title'] == 'N'

    @pytest.mark.parametrize(('rating', 'expected'), [
        ({'ratingValue': '4.8'}, 4),
        ({'ratingValue': 3}, 3),
        ({'ratingValue': 'five'}, None),
        ({'ratingValue': 0}, 0),      # falsy: the int() step is skipped, 0 stays
        ({}, None),
        ('4', None),  # not a dict
    ])
    def test_rating_value(self, ingestor, rating, expected):
        item = ingestor._extract_from_jsonld_item(_review(reviewRating=rating), CONFIG, URL)
        assert item['rating'] == expected

    def test_author_object_gives_name_and_its_url_becomes_the_item_url(self, ingestor):
        author = {'name': 'Bea', 'url': 'https://shop.example.com/u/bea'}
        item = ingestor._extract_from_jsonld_item(_review(author=author), CONFIG, URL)
        assert item['author'] == 'Bea'
        assert item['url'] == 'https://shop.example.com/u/bea'

    def test_author_object_without_name_is_anonymous_and_keeps_the_page_url(self, ingestor):
        item = ingestor._extract_from_jsonld_item(_review(author={}), CONFIG, URL)
        assert item['author'] == 'Anonymous'
        assert item['url'] == URL

    def test_author_string_is_the_author(self, ingestor):
        assert ingestor._extract_from_jsonld_item(_review(author='Cy'), CONFIG, URL)['author'] == 'Cy'

    def test_author_of_another_type_is_anonymous(self, ingestor):
        assert ingestor._extract_from_jsonld_item(_review(author=7), CONFIG, URL)['author'] == 'Anonymous'

    @pytest.mark.parametrize(('published', 'expected'), [
        ('2024-01-15T10:00:00Z', '2024-01-15T10:00:00+00:00'),        # Z is UTC, kept UTC (#267-6: was +01:00 Berlin)
        ('2024-07-15 10:00:00', '2024-07-15T10:00:00+00:00'),         # space separator, no offset → read as UTC
        ('2024-07-15T10:00:00+05:00', '2024-07-15T05:00:00+00:00'),   # explicit offset converted to UTC
        ('2024-07-15T10:00:00-03:00', '2024-07-15T13:00:00+00:00'),   # a negative offset is honoured too
        ('2024-07-15', '2024-07-15T00:00:00+00:00'),                  # date only → UTC midnight
        ('yesterday', 'yesterday'),                                   # unparseable: kept verbatim
        (20240715, 20240715),                                         # not a string: kept verbatim
    ])
    def test_date_published(self, ingestor, published, expected):
        item = ingestor._extract_from_jsonld_item(_review(datePublished=published), CONFIG, URL)
        assert item['created_at'] == expected

    @pytest.fixture
    def process_in_new_york(self):
        with patch.dict(os.environ, {'TZ': 'America/New_York'}):
            time.tzset()
            yield
        time.tzset()

    @pytest.mark.usefixtures('process_in_new_york')
    def test_the_utc_rendering_does_not_depend_on_the_host_timezone(self, ingestor):
        """Lambda runs in UTC; a developer's laptop may not. A naive value is
        UTC either way, never the process's local zone."""
        item = ingestor._extract_from_jsonld_item(
            _review(datePublished='2024-01-15 10:00:00'), CONFIG, URL)
        assert item['created_at'] == '2024-01-15T10:00:00+00:00'

    def test_a_broken_item_is_logged_and_dropped(self, ingestor, logger):
        item = ingestor._extract_from_jsonld_item(_review(), {}, URL)  # no config id → KeyError
        assert item is None
        assert logger.exception.call_count == 1
        assert logger.exception.call_args.args[0].startswith('Error extracting JSON-LD item: ')


class TestExtractJsonldReviews:
    def _reviews(self, ingestor, html, config=CONFIG):
        return list(ingestor._extract_jsonld_reviews(_soup(html), config, URL))

    @staticmethod
    def _script(payload) -> str:
        return f'<script type="application/ld+json">{json.dumps(payload)}</script>'

    def test_reads_only_ld_json_scripts(self, ingestor):
        html = (f'<script>{json.dumps(_review(reviewBody="plain js"))}</script>'
                + self._script(_review(reviewBody='from ld')))
        assert [r['text'] for r in self._reviews(ingestor, html)] == ['from ld']

    @pytest.mark.parametrize('payload', [
        {'@graph': [{'@type': 'Product'}, _review(reviewBody='in graph'), {'@type': 'Person'}]},
        {'@type': 'Product', 'review': [{'@type': 'Rating'}, _review(reviewBody='in graph')]},
        [{'@type': 'Organization'}, _review(reviewBody='in graph')],
        _review(reviewBody='in graph'),
    ])
    def test_every_json_ld_shape_yields_its_reviews_only(self, ingestor, payload):
        assert [r['text'] for r in self._reviews(ingestor, self._script(payload))] == ['in graph']

    def test_graph_wins_over_review_key(self, ingestor):
        payload = {'@graph': [_review(reviewBody='graph one')], 'review': [_review(reviewBody='rev')]}
        assert [r['text'] for r in self._reviews(ingestor, self._script(payload))] == ['graph one']

    def test_a_short_review_is_dropped_but_the_rest_survive(self, ingestor):
        payload = [_review(reviewBody='tiny'), _review(reviewBody='long enough')]
        assert [r['text'] for r in self._reviews(ingestor, self._script(payload))] == ['long enough']

    def test_empty_script_tag_is_a_warning_and_skipped(self, ingestor, logger):
        html = '<script type="application/ld+json"></script>' + self._script(_review())
        assert len(self._reviews(ingestor, html)) == 1
        logger.warning.assert_called_once_with(
            'Error processing JSON-LD: script tag has no text content')

    def test_invalid_json_is_skipped_silently(self, ingestor, logger):
        html = '<script type="application/ld+json">{oops</script>' + self._script(_review())
        assert len(self._reviews(ingestor, html)) == 1
        logger.warning.assert_not_called()
        logger.exception.assert_not_called()

    def test_a_non_object_entry_is_logged_as_an_error(self, ingestor, logger):
        html = self._script(['just a string'])
        assert self._reviews(ingestor, html) == []
        assert logger.exception.call_count == 1
        assert logger.exception.call_args.args[0].startswith('Error processing JSON-LD: ')


# ---------------------------------------------------------------------------
# Fetching and CSS extraction
# ---------------------------------------------------------------------------

class TestFetchSoup:
    @pytest.fixture
    def fetch(self):
        with patch(f'{HANDLER}.fetch_public_url') as mock:
            mock.return_value.status_code = 200
            mock.return_value.text = '<p class="x">hi</p>'
            yield mock

    def test_sends_browser_headers_plus_site_root_referer_with_a_15s_timeout(self, ingestor, fetch):
        soup = ingestor._fetch_soup('https://shop.example.com/reviews?page=2')
        fetch.assert_called_once_with(
            'https://shop.example.com/reviews?page=2',
            headers={**ingestor.headers, 'Referer': 'https://shop.example.com/'},
            timeout=15,
        )
        fetch.return_value.raise_for_status.assert_called_once_with()
        assert soup.select_one('.x').get_text() == 'hi'

    def test_403_is_a_warning_naming_the_url_and_yields_none(self, ingestor, fetch, logger):
        fetch.return_value.status_code = 403
        assert ingestor._fetch_soup(URL) is None
        fetch.return_value.raise_for_status.assert_not_called()
        logger.warning.assert_called_once_with(
            f'Access denied (403) for {URL} - site may be blocking automated requests')

    def test_other_http_error_is_a_warning_and_yields_none(self, ingestor, fetch, logger):
        fetch.return_value.status_code = 500
        fetch.return_value.raise_for_status.side_effect = requests.HTTPError('500 Server Error')
        assert ingestor._fetch_soup(URL) is None
        logger.warning.assert_called_once_with(f'Failed to fetch {URL}: 500 Server Error')

    def test_connection_error_is_a_warning_and_yields_none(self, ingestor, fetch, logger):
        fetch.side_effect = requests.ConnectionError('refused')
        assert ingestor._fetch_soup(URL) is None
        logger.warning.assert_called_once_with(f'Failed to fetch {URL}: refused')

    def test_a_policy_refusal_is_not_swallowed(self, ingestor, fetch, logger):
        from shared.http_utils import UnsafeURLError

        fetch.side_effect = UnsafeURLError(URL, 'Access to internal/private IP addresses is not allowed')
        with pytest.raises(UnsafeURLError):
            ingestor._fetch_soup(URL)
        logger.warning.assert_not_called()


class TestContainerHelpers:
    def test_optional_text_without_selector_is_the_default(self, ingestor):
        container = _el('<div><span class="a">A</span></div>')
        assert ingestor._optional_text(container, None, 'dflt') == 'dflt'
        assert ingestor._optional_text(container, '', 'dflt') == 'dflt'

    def test_optional_text_reads_the_first_match_else_the_default(self, ingestor):
        container = _el('<div><span class="a"> A1 </span><span class="a">A2</span></div>')
        assert ingestor._optional_text(container, '.a', 'dflt') == 'A1'
        assert ingestor._optional_text(container, '.missing', 'dflt') == 'dflt'

    def test_created_at_prefers_datetime_attribute_then_text_then_now(self, ingestor):
        fixed = datetime(2024, 3, 1, 12, 0, tzinfo=UTC)
        with_attr = _el('<div><time datetime="2024-01-02" class="d">Jan 2</time></div>')
        text_only = _el('<div><span class="d"> Jan 2 </span></div>')
        no_match = _el('<div></div>')
        assert ingestor._container_created_at(with_attr, {'date_selector': '.d'}) == '2024-01-02'
        assert ingestor._container_created_at(text_only, {'date_selector': '.d'}) == 'Jan 2'
        with patch(f'{HANDLER}.datetime') as dt:
            dt.now.return_value = fixed
            assert ingestor._container_created_at(no_match, {'date_selector': '.d'}) == fixed.isoformat()
            assert ingestor._container_created_at(with_attr, {}) == fixed.isoformat()
        assert dt.now.call_args_list == [call(UTC), call(UTC)]

    def test_item_url_defaults_to_the_first_anchor_resolved_against_the_page(self, ingestor):
        container = _el('<div><a href="/r/1">one</a><a href="/r/2">two</a></div>')
        assert ingestor._container_item_url(container, {}, URL) == 'https://shop.example.com/r/1'

    def test_item_url_honours_link_selector(self, ingestor):
        container = _el('<div><a href="/r/1">one</a><a class="p" href="https://o.example/p">p</a></div>')
        assert ingestor._container_item_url(container, {'link_selector': '.p'}, URL) == 'https://o.example/p'

    @pytest.mark.parametrize('html', [
        '<div><a>no href</a></div>',
        '<div><span>no link</span></div>',
    ])
    def test_item_url_falls_back_to_the_page_url(self, ingestor, html):
        assert ingestor._container_item_url(_el(html), {}, URL) == URL


class TestExtractCssItem:
    def test_text_of_nine_characters_is_dropped_ten_is_kept(self, ingestor):
        nine = _el('<div class="review"><p class="review-text">123456789</p></div>')
        ten = _el('<div class="review"><p class="review-text">1234567890</p></div>')
        assert ingestor._extract_css_item(nine, {'id': 'shop'}, URL) is None
        assert ingestor._extract_css_item(ten, {'id': 'shop'}, URL)['text'] == '1234567890'

    def test_missing_text_element_is_dropped(self, ingestor):
        assert ingestor._extract_css_item(_el('<div class="review"></div>'), {'id': 'shop'}, URL) is None

    def test_defaults_text_selector_to_review_text_and_everything_else_to_blank(self, ingestor):
        container = _el('<div><p class="review-text">Really quite good</p>'
                        '<span class="stars rating-4">4</span><b class="who">Dee</b></div>')
        fixed = datetime(2024, 3, 1, 12, 0, tzinfo=UTC)
        with patch(f'{HANDLER}.datetime') as dt:
            dt.now.return_value = fixed
            item = ingestor._extract_css_item(container, {'id': 'shop'}, URL)
        assert item['text'] == 'Really quite good'
        # no rating_selector → the rating is never read
        _assert_blank_defaults(item, channel='web_scrape', extraction_method='css')

    def test_every_selector_in_the_config_is_honoured(self, ingestor):
        container = _el(
            '<div><h3 class="t">Title</h3><p class="body" data-body="attr body text">x</p>'
            '<span class="stars rating-4"></span><b class="who">Dee</b>'
            '<time class="when" datetime="2024-01-02">Jan</time><a class="l" href="/r/9">r</a></div>')
        config = {
            'id': 'shop', 'text_selector': '.body', 'text_config': {'attribute': 'data-body'},
            'title_selector': '.t', 'rating_selector': '.stars', 'author_selector': '.who',
            'date_selector': '.when', 'link_selector': '.l',
        }
        item = ingestor._extract_css_item(container, config, URL)
        assert item['text'] == 'Title\n\nattr body text'
        assert item['title'] == 'Title'
        assert item['rating'] == 4
        assert item['author'] == 'Dee'
        assert item['created_at'] == '2024-01-02'
        assert item['url'] == 'https://shop.example.com/r/9'


class TestScrapePage:
    REVIEW = '<div class="review"><p class="review-text">Really quite good</p></div>'

    def test_unfetchable_page_yields_nothing(self, ingestor):
        with patch.object(ingestor, '_fetch_soup', return_value=None):
            assert list(ingestor._scrape_page({'id': 'shop'}, URL)) == []

    def test_defaults_to_css_with_review_containers(self, ingestor):
        html = self.REVIEW + '<div class="other"><p class="review-text">Not a review container</p></div>'
        with patch.object(ingestor, '_fetch_soup', return_value=_soup(html)):
            items = list(ingestor._scrape_page({'id': 'shop'}, URL))
        assert [i['text'] for i in items] == ['Really quite good']
        assert items[0]['extraction_method'] == 'css'

    def test_container_selector_is_honoured(self, ingestor):
        html = '<li class="r"><p class="review-text">Really quite good</p></li>' + self.REVIEW
        with patch.object(ingestor, '_fetch_soup', return_value=_soup(html)):
            items = list(ingestor._scrape_page({'id': 'shop', 'container_selector': '.r'}, URL))
        assert len(items) == 1
        assert items[0]['text'] == 'Really quite good'

    def test_jsonld_method_uses_jsonld_and_ignores_containers(self, ingestor):
        html = self.REVIEW + (
            '<script type="application/ld+json">'
            + json.dumps(_review(reviewBody='structured')) + '</script>')
        with patch.object(ingestor, '_fetch_soup', return_value=_soup(html)):
            items = list(ingestor._scrape_page({'id': 'shop', 'extraction_method': 'jsonld'}, URL))
        assert [i['text'] for i in items] == ['structured']
        assert items[0]['extraction_method'] == 'jsonld'

    def test_no_containers_is_a_warning_naming_selector_and_url(self, ingestor, logger):
        with patch.object(ingestor, '_fetch_soup', return_value=_soup('<p>nothing</p>')):
            assert list(ingestor._scrape_page({'id': 'shop', 'container_selector': '.r'}, URL)) == []
        logger.warning.assert_called_once_with(f"No containers found with selector '.r' on {URL}")

    def test_a_short_container_is_dropped_without_logging(self, ingestor, logger):
        html = '<div class="review"><p class="review-text">short</p></div>' + self.REVIEW
        with patch.object(ingestor, '_fetch_soup', return_value=_soup(html)):
            items = list(ingestor._scrape_page({'id': 'shop'}, URL))
        assert len(items) == 1
        logger.exception.assert_not_called()

    def test_a_container_that_blows_up_is_logged_and_the_rest_continue(self, ingestor, logger):
        html = self.REVIEW + self.REVIEW
        with (
            patch.object(ingestor, '_fetch_soup', return_value=_soup(html)),
            patch.object(ingestor, '_extract_css_item', side_effect=[RuntimeError('boom'), {'ok': 1}]),
        ):
            assert list(ingestor._scrape_page({'id': 'shop'}, URL)) == [{'ok': 1}]
        logger.exception.assert_called_once_with(f'Error extracting item from {URL}: boom')


# ---------------------------------------------------------------------------
# URL planning and scheduling
# ---------------------------------------------------------------------------

class TestGetUrlsToScrape:
    def test_explicit_urls_come_first_then_base_url(self, ingestor):
        config = {'urls': ['https://a/1', 'https://a/2'], 'base_url': 'https://a/'}
        assert ingestor._get_urls_to_scrape(config) == ['https://a/1', 'https://a/2', 'https://a/']

    def test_nothing_configured_is_no_urls(self, ingestor):
        assert ingestor._get_urls_to_scrape({}) == []
        assert ingestor._get_urls_to_scrape({'urls': []}) == []

    def test_pagination_off_by_default_and_when_disabled(self, ingestor):
        assert ingestor._get_urls_to_scrape({'base_url': 'https://a/r'}) == ['https://a/r']
        config = {'base_url': 'https://a/r', 'pagination': {'enabled': False, 'max_pages': 3}}
        assert ingestor._get_urls_to_scrape(config) == ['https://a/r']

    def test_pagination_defaults_to_pages_2_to_5_on_the_page_param(self, ingestor):
        config = {'base_url': 'https://a/r', 'pagination': {'enabled': True}}
        assert ingestor._get_urls_to_scrape(config) == [
            'https://a/r', 'https://a/r?page=2', 'https://a/r?page=3', 'https://a/r?page=4',
            'https://a/r?page=5',
        ]

    def test_pagination_honours_param_start_and_max_pages_and_appends_to_a_query(self, ingestor):
        config = {'base_url': 'https://a/r?sort=new',
                  'pagination': {'enabled': True, 'max_pages': 3, 'param': 'p', 'start': 0}}
        assert ingestor._get_urls_to_scrape(config) == [
            'https://a/r?sort=new', 'https://a/r?sort=new&p=1', 'https://a/r?sort=new&p=2',
        ]

    def test_max_pages_one_is_the_base_url_only(self, ingestor):
        config = {'base_url': 'https://a/r', 'pagination': {'enabled': True, 'max_pages': 1}}
        assert ingestor._get_urls_to_scrape(config) == ['https://a/r']


class TestShouldRunScraper:
    NOW = datetime(2024, 3, 1, 12, 0, tzinfo=UTC)

    @pytest.fixture(autouse=True)
    def clock(self):
        with patch(f'{HANDLER}.datetime') as dt:
            dt.now.return_value = self.NOW
            dt.fromisoformat.side_effect = datetime.fromisoformat
            yield dt

    def test_never_run_is_due_and_reads_the_scraper_watermark(self, ingestor):
        with patch.object(ingestor, 'get_watermark', return_value=None) as wm:
            assert ingestor._should_run_scraper({'id': 'shop'}) is True
        wm.assert_called_once_with('scraper_shop_last_run')

    @pytest.mark.parametrize(('minutes_ago', 'frequency', 'due'), [
        (60, None, True),    # default frequency is 60 min; exactly due counts as due
        (59, None, False),
        (61, None, True),
        (15, 15, True),
        (14, 15, False),
    ])
    def test_due_exactly_at_last_run_plus_frequency(self, ingestor, minutes_ago, frequency, due):
        last_run = (self.NOW - timedelta(minutes=minutes_ago)).isoformat()
        config = {'id': 'shop'} if frequency is None else {'id': 'shop', 'frequency_minutes': frequency}
        with patch.object(ingestor, 'get_watermark', return_value=last_run):
            assert ingestor._should_run_scraper(config) is due

    def test_a_z_suffixed_watermark_is_read_as_utc(self, ingestor):
        with patch.object(ingestor, 'get_watermark', return_value='2024-03-01T11:00:00Z'):
            assert ingestor._should_run_scraper({'id': 'shop'}) is True
        with patch.object(ingestor, 'get_watermark', return_value='2024-03-01T11:00:01Z'):
            assert ingestor._should_run_scraper({'id': 'shop'}) is False


# ---------------------------------------------------------------------------
# The run itself
# ---------------------------------------------------------------------------

ITEM_A = {'id': 'a', 'text': 'first'}
ITEM_B = {'id': 'b', 'text': 'second'}


@pytest.fixture
def quiet_run():
    """No real sleeping, a fixed clock, and the jitter draw observable."""
    fixed = datetime(2024, 3, 1, 12, 0, tzinfo=UTC)
    with (
        patch(f'{HANDLER}.time') as time_mod,
        patch(f'{HANDLER}._jitter') as jitter,
        patch(f'{HANDLER}.datetime') as dt,
        patch(f'{HANDLER}.metrics') as metrics,
    ):
        jitter.uniform.return_value = 3.3
        dt.now.return_value = fixed
        dt.fromisoformat.side_effect = datetime.fromisoformat
        yield {'time': time_mod, 'jitter': jitter, 'now': fixed.isoformat(), 'metrics': metrics}


@dataclass(frozen=True)
class _Run:
    """An ingestor whose collaborators are stubbed, with the stubs typed as the
    mocks they are (the attribute names match the ingestor's own)."""
    ingestor: 'WebScraperIngestor'
    _scrape_page: MagicMock
    _update_run_status: MagicMock
    set_watermark: MagicMock
    get_watermark: MagicMock

    def fetch_new_items(self) -> Iterator[dict]:
        return self.ingestor.fetch_new_items()


def _runner(configs: list[dict], pages: dict[str, list | Exception] | None = None, **kwargs) -> _Run:
    """An ingestor over *configs* whose `_scrape_page` serves *pages* by url
    (an Exception value is raised for that url)."""
    ingestor = _ingestor(configs=json.dumps(configs), **kwargs)
    served = pages or {}

    def scrape(_config, url):
        result = served.get(url, [])
        if isinstance(result, Exception):
            raise result
        yield from result

    run = _Run(
        ingestor=ingestor,
        _scrape_page=MagicMock(side_effect=scrape),
        _update_run_status=MagicMock(),
        set_watermark=MagicMock(),
        get_watermark=MagicMock(return_value=None),
    )
    ingestor._scrape_page = run._scrape_page
    ingestor._update_run_status = run._update_run_status
    ingestor.set_watermark = run.set_watermark
    ingestor.get_watermark = run.get_watermark
    return run


@pytest.mark.usefixtures('quiet_run')
class TestFetchNewItemsWithoutConfigs:
    def test_warns_and_yields_nothing(self, logger):
        ingestor = _runner([])
        assert list(ingestor.fetch_new_items()) == []
        logger.warning.assert_called_once_with('No webscraper configurations found')
        ingestor._update_run_status.assert_not_called()

    def test_a_manual_run_for_a_missing_scraper_records_the_error(self, quiet_run):
        ingestor = _runner([], execution_id='exec-1', target_scraper_id='gone')
        assert list(ingestor.fetch_new_items()) == []
        ingestor._update_run_status.assert_called_once_with('gone', {
            'status': 'error',
            'completed_at': quiet_run['now'],
            'errors': ['No scraper configuration found'],
        })

    def test_a_manual_run_without_a_target_records_nothing(self):
        ingestor = _runner([], execution_id='exec-1')
        assert list(ingestor.fetch_new_items()) == []
        ingestor._update_run_status.assert_not_called()

    def test_a_scheduled_run_with_a_target_records_nothing(self):
        ingestor = _runner([], target_scraper_id='gone')
        assert list(ingestor.fetch_new_items()) == []
        ingestor._update_run_status.assert_not_called()


@pytest.mark.usefixtures('quiet_run')
class TestFetchNewItemsScheduling:
    def test_a_scraper_not_yet_due_is_skipped_by_name(self, quiet_run, logger):
        ingestor = _runner([CONFIG | {'urls': [URL]}], {URL: [ITEM_A]})
        ingestor.get_watermark.return_value = quiet_run['now']
        assert list(ingestor.fetch_new_items()) == []
        logger.info.assert_called_once_with('Skipping scraper Shop Reviews - not due yet')
        ingestor._scrape_page.assert_not_called()
        ingestor.set_watermark.assert_not_called()

    def test_a_skipped_scraper_does_not_stop_the_ones_after_it(self, quiet_run):
        due = {'id': 'two', 'urls': [URL]}
        ingestor = _runner([CONFIG | {'urls': [URL]}, due], {URL: [ITEM_A]})
        ingestor.get_watermark.side_effect = lambda key: quiet_run['now'] if key == 'scraper_shop_last_run' else None
        assert list(ingestor.fetch_new_items()) == [ITEM_A]
        ingestor._scrape_page.assert_called_once_with(due, URL)
        ingestor.set_watermark.assert_called_once_with('scraper_two_last_run', quiet_run['now'])

    def test_a_manual_run_ignores_the_schedule(self, quiet_run):
        ingestor = _runner([CONFIG | {'urls': [URL]}], {URL: [ITEM_A]}, execution_id='exec-1')
        ingestor.get_watermark.return_value = quiet_run['now']
        assert list(ingestor.fetch_new_items()) == [ITEM_A]
        ingestor.get_watermark.assert_not_called()

    def test_a_scheduled_run_checks_the_schedule(self):
        ingestor = _runner([CONFIG | {'urls': [URL]}], {URL: [ITEM_A]})
        assert list(ingestor.fetch_new_items()) == [ITEM_A]
        ingestor.get_watermark.assert_called_once_with('scraper_shop_last_run')


@pytest.mark.usefixtures('quiet_run')
class TestFetchNewItemsBookkeeping:
    URL2 = 'https://shop.example.com/reviews?page=2'

    def test_yields_every_item_in_page_order(self):
        ingestor = _runner([CONFIG | {'urls': [URL, self.URL2]}], {URL: [ITEM_A], self.URL2: [ITEM_B]})
        assert list(ingestor.fetch_new_items()) == [ITEM_A, ITEM_B]
        assert ingestor._scrape_page.call_args_list == [
            call(CONFIG | {'urls': [URL, self.URL2]}, URL),
            call(CONFIG | {'urls': [URL, self.URL2]}, self.URL2),
        ]

    def test_progress_is_recorded_after_each_page_and_the_run_completes(self, quiet_run):
        ingestor = _runner([CONFIG | {'urls': [URL, self.URL2]}], {URL: [ITEM_A, ITEM_B], self.URL2: []})
        list(ingestor.fetch_new_items())
        assert ingestor._update_run_status.call_args_list == [
            call('shop', {'pages_scraped': 1, 'items_found': 2, 'current_url': URL}),
            call('shop', {'pages_scraped': 2, 'items_found': 2, 'current_url': self.URL2}),
            call('shop', {
                'status': 'completed',
                'completed_at': quiet_run['now'],
                'pages_scraped': 2,
                'items_found': 2,
                'errors': [],
            }),
        ]

    def test_an_empty_page_is_an_info_line(self, logger):
        ingestor = _runner([CONFIG | {'urls': [URL, self.URL2]}], {URL: [ITEM_A], self.URL2: []})
        list(ingestor.fetch_new_items())
        assert logger.info.call_args_list == [
            call('Running scraper: Shop Reviews'),
            call(f'No items found on {self.URL2}'),
            call('Scraper Shop Reviews found 1 items from 2 pages'),
        ]

    def test_sleeps_a_uniform_2_to_5_seconds_after_every_page(self, quiet_run):
        ingestor = _runner([CONFIG | {'urls': [URL, self.URL2]}], {URL: [ITEM_A], self.URL2: []})
        list(ingestor.fetch_new_items())
        assert quiet_run['jitter'].uniform.call_args_list == [call(2.0, 5.0), call(2.0, 5.0)]
        assert quiet_run['time'].sleep.call_args_list == [call(3.3), call(3.3)]

    def test_a_failing_page_is_logged_counted_and_the_run_completes_with_errors(self, quiet_run, logger):
        ingestor = _runner([CONFIG | {'urls': [URL, self.URL2]}],
                           {URL: RuntimeError('boom'), self.URL2: [ITEM_B]})
        assert list(ingestor.fetch_new_items()) == [ITEM_B]
        logger.exception.assert_called_once_with(f'Error scraping {URL}: RuntimeError')
        assert ingestor._update_run_status.call_args_list == [
            call('shop', {'pages_scraped': 1, 'items_found': 1, 'current_url': self.URL2}),
            call('shop', {
                'status': 'completed_with_errors',
                'completed_at': quiet_run['now'],
                'pages_scraped': 1,
                'items_found': 1,
                'errors': [f'Error scraping {URL}: RuntimeError'],
            }),
        ]
        # The failed page neither counted as scraped nor slept.
        assert quiet_run['time'].sleep.call_count == 1

    def test_watermark_metric_and_summary_log_per_scraper(self, quiet_run, logger):
        ingestor = _runner([CONFIG | {'urls': [URL]}, {'id': 'two', 'urls': [self.URL2]}],
                           {URL: [ITEM_A, ITEM_B], self.URL2: []})
        list(ingestor.fetch_new_items())
        assert ingestor.set_watermark.call_args_list == [
            call('scraper_shop_last_run', quiet_run['now']),
            call('scraper_two_last_run', quiet_run['now']),
        ]
        assert quiet_run['metrics'].add_metric.call_args_list == [
            call(name='Scraper_shop_Items', unit='Count', value=2),
            call(name='Scraper_two_Items', unit='Count', value=0),
        ]
        assert logger.info.call_args_list == [
            call('Running scraper: Shop Reviews'),
            call('Scraper Shop Reviews found 2 items from 1 pages'),
            call('Running scraper: two'),
            call(f'No items found on {self.URL2}'),
            call('Scraper two found 0 items from 1 pages'),
        ]

    def test_a_config_without_an_id_is_reported_as_unknown(self, quiet_run, logger):
        # Only a manual run without a target reaches an id-less config: the
        # schedule check indexes config['id'] and would raise first.
        ingestor = _runner([{'urls': [URL]}], {URL: [ITEM_A]}, execution_id='exec-1')
        list(ingestor.fetch_new_items())
        ingestor.set_watermark.assert_called_once_with('scraper_unknown_last_run', quiet_run['now'])
        quiet_run['metrics'].add_metric.assert_called_once_with(
            name='Scraper_unknown_Items', unit='Count', value=1)
        assert logger.info.call_args_list[0] == call('Running scraper: unknown')


class TestInterPageDelay:
    def test_the_real_jitter_draws_between_2_and_5_seconds(self, logger):
        """Unlike the fixture above, `_jitter` is left real: a broken draw would
        surface as an 'Error scraping' entry rather than a pause."""
        ingestor = _runner([CONFIG | {'urls': [URL]}], {URL: [ITEM_A]}, execution_id='exec-1')
        with patch(f'{HANDLER}.time') as time_mod, patch(f'{HANDLER}.metrics'):
            assert list(ingestor.fetch_new_items()) == [ITEM_A]
        (seconds,), _ = time_mod.sleep.call_args
        assert time_mod.sleep.call_count == 1
        assert 2.0 <= seconds <= 5.0
        logger.exception.assert_not_called()


# ---------------------------------------------------------------------------
# The Lambda entry point is wrapped
# ---------------------------------------------------------------------------

class TestLambdaHandlerIsWrapped:
    @pytest.fixture
    def lambda_context(self):
        # A plain namespace, not a MagicMock: Powertools treats anything that has
        # `state` and `lambda_context` attributes as a Step Functions durable context.
        return SimpleNamespace(
            function_name='voc-webscraper-ingestor',
            memory_limit_in_mb=512,
            invoked_function_arn='arn:aws:lambda:us-east-1:123456789:function:test',
            aws_request_id='req-1',
        )

    @pytest.fixture
    def invoke(self, lambda_context):
        real_metrics.clear_metrics()
        reset_cold_start_flag()
        real_logger.remove_keys(['function_name', 'cold_start'])
        with patch(f'{HANDLER}.WebScraperIngestor') as ingestor_cls:
            ingestor_cls.return_value.run.return_value = {'status': 'success'}
            from webscraper.ingestor.handler import lambda_handler
            yield lambda: lambda_handler({'execution_id': 'exec-1', 'scraper_id': 'shop'}, lambda_context)
        real_metrics.clear_metrics()

    def test_the_lambda_context_reaches_the_logger(self, invoke, lambda_context):
        assert invoke() == {'status': 'success'}
        assert real_logger.get_current_keys()['function_name'] == lambda_context.function_name

    def test_the_cold_start_metric_is_flushed_as_emf(self, invoke, capsys):
        invoke()
        assert 'ColdStart' in emf_metric_names(capsys.readouterr().out)

    def test_the_handler_is_registered_with_the_tracer(self):
        with patch.object(tracer, 'capture_lambda_handler', side_effect=lambda f: f) as capture:
            sys.modules.pop(HANDLER, None)
            module = importlib.import_module(HANDLER)
        (wrapped,), _ = capture.call_args
        assert capture.call_count == 1
        assert wrapped.__name__ == 'lambda_handler'
        # The tracer sits between the logger (outermost) and the metrics flush.
        assert module.lambda_handler.__wrapped__ is wrapped
