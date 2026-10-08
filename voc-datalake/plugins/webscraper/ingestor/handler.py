"""
Web Scraper Ingestor - Configurable scraper for extracting feedback from websites.
Supports multiple scraper configurations with custom selectors and frequencies.
"""
import hashlib
import json
import os
import re
import secrets
import time
from collections.abc import Generator
from datetime import UTC, datetime, timedelta
from urllib.parse import urljoin, urlparse

import requests
from botocore.exceptions import BotoCoreError, ClientError
from bs4 import BeautifulSoup

from _shared.base_ingestor import BaseIngestor, logger, metrics, tracer
from shared.http_utils import UnsafeURLError, fetch_public_url
from shared.invocation_cost import measure_invocation_cost
from shared.producer_labels import message_labels

# Inter-page delay jitter only needs a uniform draw; it is not security-relevant.
_jitter = secrets.SystemRandom()

# Word-based star-rating classes, e.g. <p class="star-rating Three">. Used by
# books.toscrape.com and similar review widgets that encode the star count as a
# number word in the element's CSS class rather than a digit or an attribute.
# Keys MUST be lowercase — lookups normalize the class token via .lower().
WORD_STAR_RATINGS = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5}
# `frequency_minutes` value the Scrapers UI shows as 'Manual only'.
MANUAL_ONLY_FREQUENCY = 0


def _scraper_defaults(config: dict) -> dict:
    """The scraper's ``dimension_defaults`` and ``tags`` as message ``dimensions`` / ``tags``."""
    return message_labels(config.get('dimension_defaults'), config.get('tags'))



def _jsonld_created_at(date_published: object) -> object:
    """A JSON-LD `datePublished` as an ISO-8601 UTC timestamp.

    Normalised to UTC like every other `created_at` the platform writes
    (issue #267 item 6): it used to be re-rendered in Europe/Berlin, so the same
    instant carried a +01:00/+02:00 offset depending on the season and sorted
    against other sources' UTC strings by wall-clock text.

    A value without an offset is read as UTC (schema.org gives no zone, and the
    page's zone is unknowable). A negative offset is honoured — the old suffix
    check (`'+' not in`) appended `+00:00` to it and lost the date. Anything that
    is not a parseable ISO string is kept verbatim, as before.
    """
    if not isinstance(date_published, str):
        return date_published
    try:
        parsed = datetime.fromisoformat(date_published)
        aware = parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
        return aware.astimezone(UTC).isoformat()
    except (OverflowError, ValueError):
        return date_published

class WebScraperIngestor(BaseIngestor):
    """Configurable web scraper for extracting feedback from websites."""

    def __init__(self, execution_id: str | None = None, target_scraper_id: str | None = None):
        # execution_id → BaseIngestor manual-run cache clear (#141/#215).
        super().__init__(execution_id=execution_id)
        self.target_scraper_id = target_scraper_id
        self.scraper_configs = self._load_scraper_configs()
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate',
            'Cache-Control': 'no-cache',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
        }
        self.aggregates_table_name = os.environ.get('AGGREGATES_TABLE', '')
        self.aggregates_table = None
        if self.aggregates_table_name:
            import boto3
            dynamodb = boto3.resource('dynamodb')
            self.aggregates_table = dynamodb.Table(self.aggregates_table_name)

    def _load_scraper_configs(self) -> list:
        """Load scraper configurations from secrets."""
        # After prefix stripping, 'webscraper_configs' becomes 'configs'
        configs_json = self.secrets.get('configs', '[]')
        try:
            configs = json.loads(configs_json) if configs_json else []
            if self.target_scraper_id:
                return [c for c in configs if c.get('id') == self.target_scraper_id]
            return [c for c in configs if c.get('enabled', True)]
        except json.JSONDecodeError:
            logger.exception("Invalid webscraper_configs JSON")
            return []

    def _update_run_status(self, scraper_id: str, updates: dict):
        """Update run status in DynamoDB for progress tracking."""
        if not self.aggregates_table or not self.execution_id:
            return
        try:
            update_expr = 'SET ' + ', '.join([f'#{k} = :{k}' for k in updates])
            expr_names = {f'#{k}': k for k in updates}
            expr_values = {f':{k}': v for k, v in updates.items()}

            self.aggregates_table.update_item(
                Key={'pk': f'SCRAPER_RUN#{scraper_id}', 'sk': self.execution_id},
                UpdateExpression=update_expr,
                ExpressionAttributeNames=expr_names,
                ExpressionAttributeValues=expr_values
            )
        except (BotoCoreError, ClientError, TypeError) as e:
            # TypeError: boto3's DynamoDB serializer rejecting a value type.
            logger.warning(f"Failed to update run status: {e}", exc_info=True)

    def _generate_id(self, url: str, text: str) -> str:
        """Generate unique ID for scraped content."""
        content = f"{url}:{text[:100]}"
        return hashlib.sha256(content.encode()).hexdigest()[:16]

    def _extract_text(self, element, selector_config: dict) -> str:
        """Extract text from element based on config."""
        if not element:
            return ''
        attr = selector_config.get('attribute')
        if attr:
            return element.get(attr, '')
        return element.get_text(strip=True)

    def _extract_rating(self, element, config: dict) -> int | None:
        """Extract rating from element."""
        if not element:
            return None

        rating_attr = config.get('rating_attribute', 'data-rating')
        if element.has_attr(rating_attr):
            try:
                return int(float(element[rating_attr]))
            except (ValueError, TypeError):
                pass

        for cls in element.get('class', []):
            match = re.search(r'(\d+)', cls)
            if match:
                rating = int(match.group(1))
                if 1 <= rating <= 5:
                    return rating
            # Only consulted on the element the config's rating_selector
            # resolves to, so a bare 'one'/'two' grid-column class elsewhere
            # in the DOM can't leak in as a rating.
            word_rating = WORD_STAR_RATINGS.get(cls.lower())
            if word_rating is not None:
                return word_rating

        text = element.get_text(strip=True)
        match = re.search(r'(\d+(?:\.\d+)?)\s*(?:/\s*5|stars?|★)', text, re.I)
        if match:
            return min(5, max(1, int(float(match.group(1)))))

        return None

    def _extract_jsonld_reviews(self, soup: BeautifulSoup, config: dict, url: str) -> Generator[dict, None, None]:
        """Extract reviews from JSON-LD structured data."""
        scripts = soup.find_all('script', type='application/ld+json')

        for script in scripts:
            raw_json = script.string
            if raw_json is None:
                # An empty <script> tag: logged and skipped, as before.
                logger.warning("Error processing JSON-LD: script tag has no text content")
                continue
            try:
                data = json.loads(raw_json)

                if isinstance(data, dict) and '@graph' in data:
                    items = data['@graph']
                elif isinstance(data, dict) and 'review' in data:
                    items = data['review']
                elif isinstance(data, list):
                    items = data
                else:
                    items = [data]

                for item in items:
                    if item.get('@type') != 'Review':
                        continue

                    review_data = self._extract_from_jsonld_item(item, config, url)
                    if review_data:
                        yield review_data

            except json.JSONDecodeError:
                continue
            except Exception as e:
                logger.exception(f"Error processing JSON-LD: {e}")

    def _scraped_item(self, config: dict, url: str, *, item_url: str, extraction_method: str,
                      channel: str, title: str, text: str, rating, created_at, author) -> dict:
        """The pipeline record for one scraped review, however it was extracted."""
        item_id = self._generate_id(item_url, text)
        scraper_name = config.get('name', urlparse(url).netloc)

        return {
            'id': f"scraper_{config['id']}_{item_id}",
            'channel': channel,
            'url': item_url,
            'text': f"{title}\n\n{text}" if title else text,
            'title': title,
            'rating': rating,
            'created_at': created_at,
            'brand_handles_matched': [self.brand_name],
            'author': author,
            'scraper_id': config['id'],
            'scraper_name': scraper_name,
            'domain': urlparse(url).netloc,
            'extraction_method': extraction_method,
            'source_platform_override': scraper_name,
            **_scraper_defaults(config),
        }

    def _extract_from_jsonld_item(self, item: dict, config: dict, url: str) -> dict | None:
        """Extract review data from a JSON-LD Review item."""
        try:
            text = item.get('reviewBody')
            if not text or len(text) < 5:
                return None

            title = item.get('headline', item.get('name', ''))

            rating = None
            rating_value = item.get('reviewRating', {})
            if isinstance(rating_value, dict):
                rating = rating_value.get('ratingValue')
            if rating:
                try:
                    rating = int(float(rating))
                except (ValueError, TypeError):
                    rating = None

            author = 'Anonymous'
            author_url = None  # pragma: no mutate  falsy sentinel: only ever read as `author_url or url`
            author_data = item.get('author', {})
            if isinstance(author_data, dict):
                author = author_data.get('name', 'Anonymous')
                author_url = author_data.get('url')
            elif isinstance(author_data, str):
                author = author_data

            date_published = item.get('datePublished', '')
            created_at = _jsonld_created_at(date_published) if date_published else datetime.now(UTC).isoformat()

            return self._scraped_item(
                config, url,
                item_url=author_url or url,
                extraction_method='jsonld',
                channel='web_scrape_jsonld',
                title=title, text=text, rating=rating,
                created_at=created_at, author=author,
            )
        except Exception as e:
            logger.exception(f"Error extracting JSON-LD item: {e}")
            return None

    def _fetch_soup(self, url: str) -> BeautifulSoup | None:
        """Fetch *url* and parse it; None (logged) when it cannot be fetched.

        Goes through `fetch_public_url`: the URL policy (shared/url_policy.py)
        is checked before the first request and on every redirect hop, and
        redirects are followed manually with a hop bound (#244). A refusal
        raises `UnsafeURLError`, which is NOT caught here: it reaches the
        per-URL handler in `fetch_new_items`, which logs it and records it in
        the run's `errors`, so that URL fails visibly and the run continues.
        """
        try:
            # Set Referer to the site's root so it looks like in-site navigation
            page_headers = {**self.headers, 'Referer': f"https://{urlparse(url).netloc}/"}
            response = fetch_public_url(url, headers=page_headers, timeout=15)
            if response.status_code == 403:
                logger.warning(f"Access denied (403) for {url} - site may be blocking automated requests")
                return None
            response.raise_for_status()
            soup = BeautifulSoup(response.text, 'html.parser')
        except requests.RequestException as e:
            logger.warning(f"Failed to fetch {url}: {e}")
            return None
        return soup

    def _optional_text(self, container, selector: str | None, default: str) -> str:
        """Text of *selector*'s first match in *container*, else *default*."""
        if not selector:
            return default
        elem = container.select_one(selector)
        return self._extract_text(elem, {}) if elem else default

    def _container_created_at(self, container, config: dict) -> str:
        """The container's date (``datetime`` attribute or text), else now."""
        created_at = datetime.now(UTC).isoformat()
        date_selector = config.get('date_selector')
        if date_selector:
            date_elem = container.select_one(date_selector)
            if date_elem:
                created_at = date_elem.get('datetime') or date_elem.get_text(strip=True)
        return created_at

    def _container_item_url(self, container, config: dict, url: str) -> str:
        """The container's own link resolved against *url*, else *url*."""
        link_elem = container.select_one(config.get('link_selector', 'a'))
        if link_elem and link_elem.has_attr('href'):
            href = link_elem['href']
            # `href` is not a multi-valued attribute, so bs4 returns it as str.
            if isinstance(href, str):
                return urljoin(url, href)
        return url

    def _extract_css_item(self, container, config: dict, url: str) -> dict | None:
        """The pipeline record for one CSS-selected review container, or None
        when its text is missing or too short."""
        text_elem = container.select_one(config.get('text_selector', '.review-text'))
        text = self._extract_text(text_elem, config.get('text_config', {}))
        if not text or len(text) < 10:
            return None

        rating = None
        rating_selector = config.get('rating_selector')
        if rating_selector:
            rating = self._extract_rating(container.select_one(rating_selector), config)

        return self._scraped_item(
            config, url,
            item_url=self._container_item_url(container, config, url),
            extraction_method='css',
            channel='web_scrape',
            title=self._optional_text(container, config.get('title_selector'), ''),
            text=text, rating=rating,
            created_at=self._container_created_at(container, config),
            author=self._optional_text(container, config.get('author_selector'), 'Anonymous'),
        )

    def _scrape_page(self, config: dict, url: str) -> Generator[dict, None, None]:
        """Scrape a single page based on configuration."""
        soup = self._fetch_soup(url)
        if soup is None:
            return

        # Anything but 'jsonld' (including no setting at all) is CSS extraction.
        if config.get('extraction_method') == 'jsonld':
            yield from self._extract_jsonld_reviews(soup, config, url)
            return

        container_selector = config.get('container_selector', '.review')
        containers = soup.select(container_selector)

        if not containers:
            logger.warning(f"No containers found with selector '{container_selector}' on {url}")
            return

        for container in containers:
            try:
                item = self._extract_css_item(container, config, url)
            except Exception as e:
                logger.exception(f"Error extracting item from {url}: {e}")
                continue
            if item is not None:
                yield item

    def _get_urls_to_scrape(self, config: dict) -> list[str]:
        """Get list of URLs to scrape based on config."""
        urls = []

        if config.get('urls'):
            urls.extend(config['urls'])

        base_url = config.get('base_url')
        if base_url:
            urls.append(base_url)

            pagination = config.get('pagination', {})
            if pagination.get('enabled'):
                max_pages = pagination.get('max_pages', 5)
                page_param = pagination.get('param', 'page')
                start_page = pagination.get('start', 1)

                for page in range(start_page + 1, start_page + max_pages):
                    if '?' in base_url:
                        urls.append(f"{base_url}&{page_param}={page}")
                    else:
                        urls.append(f"{base_url}?{page_param}={page}")

        return urls

    def _should_run_scraper(self, config: dict) -> bool:
        """Check if scraper should run based on frequency.

        `frequency_minutes: 0` is 'Manual only' in the Scrapers UI: never due on a
        scheduled tick, run only by `POST /scrapers/{id}/run` (which sets
        `execution_id`, so `fetch_new_items` never asks this method).
        """
        frequency_minutes = config.get('frequency_minutes', 60)
        if frequency_minutes == MANUAL_ONLY_FREQUENCY:
            return False

        scraper_id = config['id']
        last_run = self.get_watermark(f'scraper_{scraper_id}_last_run')

        if not last_run:
            return True

        # Python 3.11+ fromisoformat accepts a trailing 'Z' as UTC directly.
        last_run_time = datetime.fromisoformat(last_run)
        next_run = last_run_time + timedelta(minutes=frequency_minutes)

        return datetime.now(UTC) >= next_run

    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch new items from all configured scrapers."""
        if not self.scraper_configs:
            logger.warning("No webscraper configurations found")
            if self.execution_id and self.target_scraper_id:
                self._update_run_status(self.target_scraper_id, {
                    'status': 'error',
                    'completed_at': datetime.now(UTC).isoformat(),
                    'errors': ['No scraper configuration found']
                })
            return

        for config in self.scraper_configs:
            scraper_id = config.get('id', 'unknown')
            scraper_name = config.get('name', scraper_id)

            if not self.execution_id and not self._should_run_scraper(config):
                logger.info(f"Skipping scraper {scraper_name} - not due yet")
                continue

            logger.info(f"Running scraper: {scraper_name}")
            urls = self._get_urls_to_scrape(config)
            items_found = 0
            pages_scraped = 0
            errors = []

            for url in urls:
                try:
                    items_before_page = items_found
                    for item in self._scrape_page(config, url):
                        items_found += 1
                        yield item
                    pages_scraped += 1

                    if items_found == items_before_page:
                        logger.info(f"No items found on {url}")

                    self._update_run_status(scraper_id, {
                        'pages_scraped': pages_scraped,
                        'items_found': items_found,
                        'current_url': url
                    })

                    # Rate limit: randomized delay between pages to avoid bot detection
                    time.sleep(_jitter.uniform(2.0, 5.0))
                except Exception as e:
                    error_msg = _run_error_text(url, e)
                    logger.exception(error_msg)
                    errors.append(error_msg)

            self.set_watermark(f'scraper_{scraper_id}_last_run', datetime.now(UTC).isoformat())

            self._update_run_status(scraper_id, {
                'status': 'completed' if not errors else 'completed_with_errors',
                'completed_at': datetime.now(UTC).isoformat(),
                'pages_scraped': pages_scraped,
                'items_found': items_found,
                'errors': errors
            })

            metrics.add_metric(name=f"Scraper_{scraper_id}_Items", unit="Count", value=items_found)
            logger.info(f"Scraper {scraper_name} found {items_found} items from {pages_scraped} pages")


def _run_error_text(url: str, error: Exception) -> str:
    """The run-status `errors` entry for a URL that failed to scrape.

    `errors` is served to every signed-in user by `GET /logs/scraper/*` (and
    `/scrapers/{id}/status`), so it never carries `str(error)`, whose text can hold
    page content or response bodies — only the class name. A URL-policy refusal
    keeps its reason: a fixed, operator-useful string from shared/url_policy.py.
    The full exception still reaches CloudWatch through `logger.exception`.
    """
    if isinstance(error, UnsafeURLError):
        return f"Error scraping {url}: URL blocked by policy ({error.reason})"
    return f"Error scraping {url}: {type(error).__name__}"


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
@measure_invocation_cost
def lambda_handler(event, context):
    """Lambda entry point."""
    execution_id = event.get('execution_id')
    scraper_id = event.get('scraper_id')

    # Manual-run secret-cache clearing (issue #141) is centralized in
    # BaseIngestor.__init__ — passing execution_id below triggers it.
    ingestor = WebScraperIngestor(
        execution_id=execution_id,
        target_scraper_id=scraper_id
    )
    return ingestor.run()
