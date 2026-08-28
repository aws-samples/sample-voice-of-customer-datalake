"""
Web Scraper Ingestor - Configurable scraper for extracting feedback from websites.
Supports multiple scraper configurations with custom selectors and frequencies.
"""
import os
from bs4 import BeautifulSoup
from datetime import datetime, timezone, timedelta
from typing import Generator
from urllib.parse import urljoin, urlparse
import hashlib
import json
import random
import re
import time

from _shared.base_ingestor import BaseIngestor, logger, tracer, metrics
from shared.http_utils import OutboundUrlBlocked, fetch_checked_with_retry
import requests


# Word-based star-rating classes, e.g. <p class="star-rating Three">. Used by
# books.toscrape.com and similar review widgets that encode the star count as a
# number word in the element's CSS class rather than a digit or an attribute.
# Keys MUST be lowercase — lookups normalize the class token via .lower().
WORD_STAR_RATINGS = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5}

# Per-page fetch budget. The two values are a split of one invocation, not
# independent knobs.
#
# `manifest.json` gives this Lambda `"timeout": 300`, and ONE config may name
# MAX_SCRAPER_URLS (50) URLs that all share that invocation. A per-request timeout
# bounds nothing useful across it: `fetch_checked_with_retry` walks up to
# MAX_REDIRECT_HOPS + 1 = 6 hops and each hop is separately retried
# RETRY_MAX_ATTEMPTS = 3 times, so 15 s per request is 18 requests — measured at
# ~294 s on a fake clock, i.e. one stalling URL could consume the whole 300 s.
#
# What that costs is worse than a lost page. The invocation is killed inside
# `fetch_new_items`, so the final `_update_run_status` never runs and the run row
# `POST /scrapers/<id>/run` created stays at `status: 'running'` for ever —
# nothing reconciles a stuck run — and the `OutboundUrlBlocked` -> `errors` ->
# `completed_with_errors` path never gets to report anything either.
#
# The resulting `requests.exceptions.Timeout` is a `RequestException`, so a
# stalling page stays a warn-and-continue in `_scrape_page` and the run's other
# URLs still get their turn.
SCRAPE_PAGE_HOP_TIMEOUT_SECONDS = 15
SCRAPE_PAGE_TOTAL_TIMEOUT_SECONDS = 60

# Budget for the whole INVOCATION, which is the thing the 300 s timeout is
# actually compared against. The per-page value above bounds a page; nothing
# summed those pages, and the sum is what gets the Lambda killed: a config with
# `pagination.max_pages: 10` yields 10 URLs, measured at 450 s on a fake clock,
# and MAX_SCRAPER_URLS (50) URLs is ~2450 s — 8x the invocation. So the failure
# the per-page budget was added to prevent moved from 1 stalling URL to 6 rather
# than being closed.
#
# Invocation-wide rather than per-config, because `fetch_new_items` iterates
# EVERY due config in one invocation: a per-config budget multiplies by config
# count and bounds nothing again (measured 5 configs x 2 stalling URLs = 450 s).
#
# Measured on the wall clock, not as a sum of page budgets, so the 2-5 s
# randomized `time.sleep` between pages — which spends from the same invocation —
# is counted too.
#
# 60 s of headroom under the manifest's 300 s is for the terminal
# `_update_run_status`: exhausting the budget must leave enough time to RECORD
# the truncation, since a run row abandoned at `status: 'running'` is the outcome
# this whole arrangement exists to avoid. Truncation is appended to `errors`, so
# the run reports `completed_with_errors` rather than a truthful-looking
# `completed` over a partial URL set.
SCRAPE_RUN_TOTAL_TIMEOUT_SECONDS = 240

# Watermark recording that the run budget cut a config short. Read ONLY to order
# the config loop (see `_configs_in_fairness_order`) — `_should_run_scraper` does
# not consult it, so it changes when a config is visited, never whether it is due.
#
# It exists because "retried" and "able to run" are different guarantees, and
# holding `scraper_{id}_last_run` for a truncated config buys the first at the
# cost of the second. A config with no last_run watermark is due on EVERY
# invocation, the budget then `break`s the loop, and `self.scraper_configs` is
# iterated in stored order — so one site that cannot finish inside the budget
# pinned position 1 for ever and no later config ran again. Measured over 20
# scheduled invocations (5 hours at the manifest's rate(15 minutes)) with one
# stalling config ahead of two healthy ones: zero watermarks written, and the
# healthy configs fetched 0 of 2 URLs — not degraded, never. Advancing the
# watermark instead (what this did before the hold) rotated the queue as a side
# effect, which is why removing it turned a URL-scope starvation into a
# config-scope one.
#
# Ordering by it puts a config that truncated LAST time at the back this time, so
# both guarantees hold at once: the truncated config is still due immediately, and
# the configs behind it get the budget first.
SCRAPER_TRUNCATED_WATERMARK = 'scraper_{scraper_id}_last_truncated'


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
            logger.error("Invalid webscraper_configs JSON")
            return []

    def _update_run_status(self, scraper_id: str, updates: dict):
        """Update run status in DynamoDB for progress tracking."""
        if not self.aggregates_table or not self.execution_id:
            return
        try:
            update_expr = 'SET ' + ', '.join([f'#{k} = :{k}' for k in updates.keys()])
            expr_names = {f'#{k}': k for k in updates.keys()}
            expr_values = {f':{k}': v for k, v in updates.items()}
            
            self.aggregates_table.update_item(
                Key={'pk': f'SCRAPER_RUN#{scraper_id}', 'sk': self.execution_id},
                UpdateExpression=update_expr,
                ExpressionAttributeNames=expr_names,
                ExpressionAttributeValues=expr_values
            )
        except Exception as e:
            logger.warning(f"Failed to update run status: {e}")

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
            try:
                data = json.loads(script.string)
                
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
                logger.warning(f"Error processing JSON-LD: {e}")

    def _extract_from_jsonld_item(self, item: dict, config: dict, url: str) -> dict | None:
        """Extract review data from a JSON-LD Review item."""
        try:
            text = item.get('reviewBody', '')
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
            author_url = None
            author_data = item.get('author', {})
            if isinstance(author_data, dict):
                author = author_data.get('name', 'Anonymous')
                author_url = author_data.get('url')
            elif isinstance(author_data, str):
                author = author_data
            
            date_published = item.get('datePublished', '')
            created_at = datetime.now(timezone.utc).isoformat()
            if date_published:
                try:
                    from zoneinfo import ZoneInfo
                    date_str = date_published.replace(' ', 'T').replace('Z', '+00:00')
                    if '+' not in date_str and 'T' in date_str:
                        date_str += '+00:00'
                    dt = datetime.fromisoformat(date_str)
                    cet = ZoneInfo('Europe/Berlin')
                    dt_cet = dt.astimezone(cet)
                    created_at = dt_cet.isoformat()
                except Exception:
                    created_at = date_published
            
            item_id = self._generate_id(author_url or url, text)
            scraper_name = config.get('name', urlparse(url).netloc)
            
            return {
                'id': f"scraper_{config['id']}_{item_id}",
                'channel': 'web_scrape_jsonld',
                'url': author_url or url,
                'text': f"{title}\n\n{text}" if title else text,
                'title': title,
                'rating': rating,
                'created_at': created_at,
                'brand_handles_matched': [self.brand_name],
                'author': author,
                'scraper_id': config['id'],
                'scraper_name': scraper_name,
                'domain': urlparse(url).netloc,
                'extraction_method': 'jsonld',
                'source_platform_override': scraper_name,
            }
        except Exception as e:
            logger.warning(f"Error extracting JSON-LD item: {e}")
            return None

    def _scrape_page(
        self,
        config: dict,
        url: str,
        total_timeout: float | None = None,
        outcome: dict | None = None,
    ) -> Generator[dict, None, None]:
        """
        Scrape a single page based on configuration.

        The fetch goes through `fetch_checked_with_retry`, which applies the
        shared outbound-URL policy to `url` immediately before the request and
        again to every redirect target it follows (issue #244). A saved config
        was already checked on write, but a host can start resolving internally
        afterwards, so the destination is re-resolved here rather than trusted.

        `OutboundUrlBlocked` is deliberately NOT caught: it is not a
        `requests.RequestException`, so it escapes the handler below — which
        would log "failed to fetch" at warning and move on — and reaches
        `fetch_new_items`, which records it in the run's `errors`. A blocked
        destination must be visible in the run status, not a silent skip.

        The fetch carries a wall-clock budget as well as a per-request timeout
        (see SCRAPE_PAGE_TOTAL_TIMEOUT_SECONDS): the retried redirect walk could
        otherwise spend most of this Lambda's 300 s on one stalling URL, and being
        killed mid-run loses the run-status write, not just the page.

        Args:
            total_timeout: The wall-clock budget for THIS page, already reduced by
                what the run has left (see SCRAPE_RUN_TOTAL_TIMEOUT_SECONDS).
                Defaults to the per-page value for the callers — tests, and any
                future one-page path — that have no run budget to spend from.
            outcome: Optional dict this generator marks `{'fetched': True}` on once
                a page has actually been retrieved and parsed. A generator cannot
                return a value to a `for` loop, and the caller needs the
                distinction: it counted every attempted URL as `pages_scraped`, so
                a run in which every page timed out reported
                `status: 'completed'`, `errors: []` and a non-zero page count —
                indistinguishable from an empty but healthy run. A 403 bot-block
                is not marked either, for the same reason: nothing was retrieved
                to parse, and a wholly bot-blocked run should not report every
                page as scraped.
        """
        try:
            # Set Referer to the site's root so it looks like in-site navigation
            page_headers = {**self.headers, 'Referer': f"https://{urlparse(url).netloc}/"}
            response = fetch_checked_with_retry(
                url,
                headers=page_headers,
                timeout=SCRAPE_PAGE_HOP_TIMEOUT_SECONDS,
                total_timeout=(
                    SCRAPE_PAGE_TOTAL_TIMEOUT_SECONDS if total_timeout is None
                    else total_timeout
                ),
            )
            if response.status_code == 403:
                logger.warning(f"Access denied (403) for {url} - site may be blocking automated requests")
                return
            response.raise_for_status()
            soup = BeautifulSoup(response.text, 'html.parser')
        except requests.RequestException as e:
            logger.warning(f"Failed to fetch {url}: {e}")
            return

        if outcome is not None:
            outcome['fetched'] = True

        extraction_method = config.get('extraction_method', 'css')
        if extraction_method == 'jsonld':
            yield from self._extract_jsonld_reviews(soup, config, url)
            return

        container_selector = config.get('container_selector', '.review')
        containers = soup.select(container_selector)

        if not containers:
            logger.warning(f"No containers found with selector '{container_selector}' on {url}")
            return

        for container in containers:
            try:
                text_selector = config.get('text_selector', '.review-text')
                text_elem = container.select_one(text_selector)
                text = self._extract_text(text_elem, config.get('text_config', {}))

                if not text or len(text) < 10:
                    continue

                title = ''
                title_selector = config.get('title_selector')
                if title_selector:
                    title_elem = container.select_one(title_selector)
                    title = self._extract_text(title_elem, {}) if title_elem else ''

                rating = None
                rating_selector = config.get('rating_selector')
                if rating_selector:
                    rating_elem = container.select_one(rating_selector)
                    rating = self._extract_rating(rating_elem, config)

                created_at = datetime.now(timezone.utc).isoformat()
                date_selector = config.get('date_selector')
                if date_selector:
                    date_elem = container.select_one(date_selector)
                    if date_elem:
                        created_at = date_elem.get('datetime') or date_elem.get_text(strip=True)

                author = 'Anonymous'
                author_selector = config.get('author_selector')
                if author_selector:
                    author_elem = container.select_one(author_selector)
                    author = self._extract_text(author_elem, {}) if author_elem else 'Anonymous'

                item_url = url
                link_selector = config.get('link_selector', 'a')
                link_elem = container.select_one(link_selector)
                if link_elem and link_elem.has_attr('href'):
                    item_url = urljoin(url, link_elem['href'])

                item_id = self._generate_id(item_url, text)
                scraper_name = config.get('name', urlparse(url).netloc)

                yield {
                    'id': f"scraper_{config['id']}_{item_id}",
                    'channel': 'web_scrape',
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
                    'extraction_method': 'css',
                    'source_platform_override': scraper_name,
                }

            except Exception as e:
                logger.warning(f"Error extracting item from {url}: {e}")

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
        """Check if scraper should run based on frequency."""
        scraper_id = config['id']
        last_run = self.get_watermark(f'scraper_{scraper_id}_last_run')
        
        if not last_run:
            return True
        
        frequency_minutes = config.get('frequency_minutes', 60)
        last_run_time = datetime.fromisoformat(last_run.replace('Z', '+00:00'))
        next_run = last_run_time + timedelta(minutes=frequency_minutes)
        
        return datetime.now(timezone.utc) >= next_run

    def _configs_in_fairness_order(self) -> list:
        """
        `self.scraper_configs`, with configs that truncated most recently last.

        The run budget `break`s the config loop, so the loop's ORDER decides which
        configs get to run at all when the budget is short. Stored order made that
        a fixed priority: a config whose URLs cannot finish inside the budget was
        visited first on every invocation and every config behind it was starved
        permanently — measured 0 of 2 healthy configs reached across 20 scheduled
        invocations.

        Sorting by the truncation watermark rotates it instead. A config that has
        never truncated sorts first (the common case, so ordinary accounts keep
        their stored order — the key is constant for all of them and the sort is
        stable). One that truncated sorts after those, oldest truncation first, so
        the config that ran out of budget last time yields to the ones it blocked.

        Deliberately NOT `scraper_{id}_last_run`: least-recently-run ordering would
        also rotate, but it reorders every healthy account on every invocation for
        no benefit, and a config that has never run has no watermark to sort by.
        Only truncation is a reason to move a config back.

        A non-dict entry is dropped, and logged at ERROR rather than skipped
        quietly. `fetch_new_items` iterates THIS list and must test THIS list for
        emptiness too: while its guard still read `self.scraper_configs`, a stored
        array of entirely non-dict entries took neither branch — the guard saw a
        non-empty list, the loop then iterated nothing, and a manual run's row was
        left at `status: 'running'` for ever with no terminal write at all. That is
        the same abandoned row the run budget exists to prevent, by a different
        route, so the filter and the guard must reason about the same list.

        Defence in depth rather than a reachable path today: `_load_scraper_configs`
        calls `c.get('enabled', True)` on every entry, so a non-dict one raises
        AttributeError there first and this code is never reached with one.
        """
        def truncated_at(config: dict) -> str:
            key = SCRAPER_TRUNCATED_WATERMARK.format(
                scraper_id=config.get('id', 'unknown')
            )
            value = self.get_watermark(key)
            # Only a STRING is usable as a sort key, and this value comes from
            # DynamoDB — anything else ('' , None, a number, a dict) is treated as
            # "never truncated" rather than compared. Returning it unchecked let a
            # non-string make `sorted` raise TypeError, and this sort runs before
            # the config loop, so that aborted the ENTIRE invocation: one unusable
            # watermark would have stopped all scraping rather than costing one
            # config its place in the order. '' sorts before any ISO timestamp, so
            # never-truncated configs keep their stored order.
            return value if isinstance(value, str) else ''

        usable = []
        for config in self.scraper_configs:
            if isinstance(config, dict):
                usable.append(config)
            else:
                logger.error(
                    f"Ignoring a stored scraper configuration that is not an "
                    f"object: {type(config).__name__}"
                )

        return sorted(usable, key=truncated_at)

    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch new items from all configured scrapers."""
        # Computed BEFORE the guard, and the guard tests it rather than
        # `self.scraper_configs`: the loop below iterates this list, so a stored
        # array with no usable config must take the error branch here instead of
        # falling between the two — see `_configs_in_fairness_order`.
        configs = self._configs_in_fairness_order()
        if not configs:
            logger.warning("No webscraper configurations found")
            if self.execution_id and self.target_scraper_id:
                self._update_run_status(self.target_scraper_id, {
                    'status': 'error',
                    'completed_at': datetime.now(timezone.utc).isoformat(),
                    'errors': ['No scraper configuration found']
                })
            return

        # ONE deadline for the whole invocation, taken before the config loop
        # rather than inside it: this loop processes EVERY due config, so a
        # per-config budget would multiply by config count and bound nothing.
        # See SCRAPE_RUN_TOTAL_TIMEOUT_SECONDS for the arithmetic.
        run_deadline = time.monotonic() + SCRAPE_RUN_TOTAL_TIMEOUT_SECONDS
        run_budget_exhausted = False
        # The config that last SPENT budget, i.e. attempted a URL. When the budget
        # runs out exactly at a config boundary, the loop discovers it at the top of
        # the NEXT config, and that config has requested nothing — so it is this id,
        # not the one being visited, that the truncation is attributed to.
        budget_spender_id = None

        # Ordered, not stored order: the budget `break`s this loop, so a config
        # that truncated last time must not get first refusal again. See
        # `_configs_in_fairness_order` and SCRAPER_TRUNCATED_WATERMARK.
        for config in configs:
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
            # Whether THIS config's URL loop was cut short, as distinct from the
            # invocation-wide flag: it decides the watermark below, and a config
            # that ran to the end must still record its run.
            config_truncated = False
            # Whether the budget was already gone when this config was reached, so
            # it requested nothing at all. Distinct from `config_truncated`, which
            # means this config spent the budget: a config that made no request has
            # neither been truncated nor run, and must be reported as neither.
            config_unattempted = False

            for index, url in enumerate(urls):
                remaining = run_deadline - time.monotonic()
                if remaining <= 0:
                    run_budget_exhausted = True
                    # Alertable without reading a run's `errors`, and without the
                    # scraper id in the name so a persistently truncating config
                    # cannot fan out into unbounded metric names — the same
                    # reasoning as ScraperOutboundUrlBlocked below. An account that
                    # truncates on every schedule is ingesting less than it thinks,
                    # which the run row alone does not surface for SCHEDULED runs:
                    # `_update_run_status` returns early without an execution_id.
                    # Once per truncated invocation: the config loop breaks below.
                    metrics.add_metric(
                        name="ScraperRunBudgetExhausted", unit="Count", value=1
                    )
                    if index == 0:
                        # This config has requested NOTHING, so it did not spend the
                        # budget — the config before it did, by finishing its own URL
                        # list with the budget exactly gone. Blaming the config that
                        # merely discovered the shortage inverted everything
                        # downstream: it recorded `completed_with_errors` and "N
                        # URL(s) not attempted" against a scraper that made no
                        # request, while the culprit recorded a clean run, and the
                        # truncation marker demoted the victim so the culprit kept
                        # first refusal for ever. Measured with 5 stalling URLs ahead
                        # of one healthy config: the healthy config was fetched 0
                        # times across 40 scheduled invocations. Handled after this
                        # loop, where the run's other bookkeeping is.
                        config_unattempted = True
                        break
                    # Stop while there is still time to RECORD stopping. Running
                    # into the Lambda's own timeout instead loses the terminal
                    # `_update_run_status` below, and the run row stays at
                    # `status: 'running'` for ever with nothing to reconcile it.
                    # The message goes into `errors` so the run reports
                    # completed_with_errors: a truncated run reporting `completed`
                    # would hide exactly the truncation this budget introduces.
                    error_msg = (
                        f"Run budget of {SCRAPE_RUN_TOTAL_TIMEOUT_SECONDS}s exhausted; "
                        f"{len(urls) - index} URL(s) not attempted for {scraper_name}"
                    )
                    logger.error(error_msg)
                    errors.append(error_msg)
                    config_truncated = True
                    break

                # Recorded BEFORE the fetch, and only where the budget had time
                # left: this config is about to spend from it, so it is the one
                # accountable if the next config finds the budget gone.
                budget_spender_id = scraper_id

                try:
                    page_items = 0
                    outcome: dict = {}
                    for item in self._scrape_page(
                        config,
                        url,
                        # Whichever bound bites first: one page may not overrun the
                        # invocation just because its own budget has room left.
                        total_timeout=min(SCRAPE_PAGE_TOTAL_TIMEOUT_SECONDS, remaining),
                        outcome=outcome,
                    ):
                        items_found += 1
                        page_items += 1
                        yield item
                    # Only a page that was actually retrieved counts. Counting
                    # every attempt made a run whose every page timed out report
                    # `completed`, `errors: []` and a non-zero page count — which
                    # reads exactly like an empty but healthy run.
                    if outcome.get('fetched'):
                        pages_scraped += 1
                    
                    if page_items == 0:
                        logger.info(f"No items found on {url}")
                    
                    self._update_run_status(scraper_id, {
                        'pages_scraped': pages_scraped,
                        'items_found': items_found,
                        'current_url': url
                    })
                    
                    # Rate limit: randomized delay between pages to avoid bot
                    # detection. Clamped to what is left of the run budget, and
                    # skipped once that is gone: the pause paces the NEXT request,
                    # and when the loop is about to stop there is none — measured
                    # 243 s against a 240 s budget before this, because a pause
                    # taken after the last page still spends from the invocation.
                    remaining_after = run_deadline - time.monotonic()
                    if remaining_after > 0:
                        time.sleep(min(random.uniform(2.0, 5.0), remaining_after))
                except OutboundUrlBlocked as e:
                    # Logged at ERROR, unlike the generic warning below: a saved
                    # config pointing at an internal address — or redirecting to
                    # one — is a security signal, not a flaky page. The URL is
                    # still only skipped so the scraper's other URLs proceed.
                    error_msg = f"Blocked outbound URL {url}: {e}"
                    logger.error(error_msg)
                    errors.append(error_msg)
                    # Emitted so a config blocked on every scheduled run is
                    # visible without opening a run's `errors`: a run reports
                    # completed_with_errors either way, and the ONE case worth
                    # alerting on — a saved host that has started resolving
                    # internally — otherwise looks like an ordinary flaky page in
                    # the run list. Named without the scraper id, unlike the
                    # per-scraper item counter below, so a repeatedly-blocked
                    # config cannot fan out into unbounded metric names.
                    metrics.add_metric(name="ScraperOutboundUrlBlocked", unit="Count", value=1)
                except Exception as e:
                    error_msg = f"Error scraping {url}: {str(e)}"
                    logger.warning(error_msg)
                    errors.append(error_msg)

            if config_unattempted:
                # This config requested nothing, so there is nothing to report about
                # it: no watermark (leaving it due, which is what an unreached config
                # gets anyway), and no run row claiming URLs it never attempted. The
                # truncation is attributed to the config that actually spent the
                # budget, so `_configs_in_fairness_order` demotes the culprit rather
                # than this one — the inversion that let a stalling config keep first
                # refusal for ever.
                logger.warning(
                    f"Not attempting {scraper_name}: the "
                    f"{SCRAPE_RUN_TOTAL_TIMEOUT_SECONDS}s run budget was already "
                    f"spent by {budget_spender_id}, which is the config demoted"
                )
                if budget_spender_id:
                    self.set_watermark(
                        SCRAPER_TRUNCATED_WATERMARK.format(
                            scraper_id=budget_spender_id
                        ),
                        datetime.now(timezone.utc).isoformat(),
                    )
                break

            # NOT advanced for a config the run budget truncated. `_should_run_
            # scraper` reads this watermark, so writing it for a config whose URLs
            # went unattempted marks it as having just run and it waits out its
            # whole `frequency_minutes` before trying again. And because
            # `_get_urls_to_scrape` rebuilds the list in the same order every
            # time, the next invocation restarts at URL 0 — so the skipped tail
            # was not deferred, it was STARVED: measured with 20 stalling URLs
            # followed by 10 healthy ones, the healthy tail was reached 0 of 10
            # times, on every invocation, indefinitely.
            #
            # Holding the watermark leaves the config due, so the next scheduled
            # invocation retries it. That retry re-walks the URL list from the
            # start rather than resuming — making progress through a persistently
            # stalling prefix needs a stored resume index, which is a larger
            # change than keeping the retry claim true.
            #
            # Being due is not the same as getting to RUN, though, and holding this
            # watermark alone bought the first at the cost of the second: a config
            # that is due on every invocation and is visited first on every
            # invocation starves every config behind it. So the truncation is
            # recorded separately, and `_configs_in_fairness_order` reads it to put
            # this config behind the ones it just blocked. Both guarantees together:
            # retried immediately, and unable to monopolise the loop.
            if config_truncated:
                logger.warning(
                    f"Holding the watermark for {scraper_name}: the run budget "
                    f"truncated it, so it stays due for the next invocation"
                )
                self.set_watermark(
                    SCRAPER_TRUNCATED_WATERMARK.format(scraper_id=scraper_id),
                    datetime.now(timezone.utc).isoformat(),
                )
            else:
                self.set_watermark(
                    f'scraper_{scraper_id}_last_run',
                    datetime.now(timezone.utc).isoformat(),
                )
                # Cleared once this config gets through all of its URLs, so the
                # demotion is self-correcting: a site that was slow one day would
                # otherwise sort behind every never-truncated config for ever, on
                # the strength of a truncation it has since recovered from. Written
                # only when there is something to clear, so an ordinary run costs
                # the one watermark write it always did.
                truncated_key = SCRAPER_TRUNCATED_WATERMARK.format(
                    scraper_id=scraper_id
                )
                if self.get_watermark(truncated_key):
                    self.set_watermark(truncated_key, '')

            self._update_run_status(scraper_id, {
                'status': 'completed' if not errors else 'completed_with_errors',
                'completed_at': datetime.now(timezone.utc).isoformat(),
                'pages_scraped': pages_scraped,
                'items_found': items_found,
                'errors': errors
            })
            
            metrics.add_metric(name=f"Scraper_{scraper_id}_Items", unit="Count", value=items_found)
            logger.info(f"Scraper {scraper_name} found {items_found} items from {pages_scraped} pages")

            if run_budget_exhausted:
                # After this config's terminal status write, not instead of it: the
                # budget exists to leave time for that write, so breaking earlier
                # would recreate the abandoned-run row it is meant to prevent.
                #
                # Every config remains due for the next scheduled invocation, by
                # three routes: the ones never reached were never written, the
                # truncated one had its write SKIPPED above, and a config the budget
                # never let start returns early above without writing either. Only
                # the first is automatic — see the watermark block.
                #
                # Being due is only half of it. Because this `break` stops the loop,
                # the ORDER decides who runs at all, and the truncated config would
                # otherwise be due-and-first for ever — starving everything behind
                # it. `_configs_in_fairness_order` moves it to the back, so the two
                # guarantees hold together: a truncated config is retried, and it
                # cannot prevent other configs from running.
                logger.error(
                    f"Stopping the invocation after {scraper_name}: the "
                    f"{SCRAPE_RUN_TOTAL_TIMEOUT_SECONDS}s run budget is spent"
                )
                break


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
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
