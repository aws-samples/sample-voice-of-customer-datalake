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
import re

from _shared.base_ingestor import BaseIngestor, logger, tracer, metrics, fetch_with_retry
import requests


class WebScraperIngestor(BaseIngestor):
    """Configurable web scraper for extracting feedback from websites."""

    def __init__(self, execution_id: str = None, target_scraper_id: str = None):
        super().__init__()
        self.execution_id = execution_id
        self.target_scraper_id = target_scraper_id
        self.scraper_configs = self._load_scraper_configs()
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
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

    def _scrape_page(self, config: dict, url: str) -> Generator[dict, None, None]:
        """Scrape a single page based on configuration."""
        try:
            response = fetch_with_retry(url, headers=self.headers, timeout=30)
            response.raise_for_status()
            soup = BeautifulSoup(response.text, 'html.parser')
        except requests.RequestException as e:
            logger.warning(f"Failed to fetch {url}: {e}")
            return

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

    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch new items from all configured scrapers."""
        if not self.scraper_configs:
            logger.warning("No webscraper configurations found")
            if self.execution_id and self.target_scraper_id:
                self._update_run_status(self.target_scraper_id, {
                    'status': 'error',
                    'completed_at': datetime.now(timezone.utc).isoformat(),
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
                    for item in self._scrape_page(config, url):
                        items_found += 1
                        yield item
                    pages_scraped += 1
                    
                    self._update_run_status(scraper_id, {
                        'pages_scraped': pages_scraped,
                        'items_found': items_found,
                        'current_url': url
                    })
                except Exception as e:
                    error_msg = f"Error scraping {url}: {str(e)}"
                    logger.warning(error_msg)
                    errors.append(error_msg)
            
            self.set_watermark(f'scraper_{scraper_id}_last_run', datetime.now(timezone.utc).isoformat())
            
            self._update_run_status(scraper_id, {
                'status': 'completed' if not errors else 'completed_with_errors',
                'completed_at': datetime.now(timezone.utc).isoformat(),
                'pages_scraped': pages_scraped,
                'items_found': items_found,
                'errors': errors
            })
            
            metrics.add_metric(name=f"Scraper_{scraper_id}_Items", unit="Count", value=items_found)
            logger.info(f"Scraper {scraper_name} found {items_found} items from {pages_scraped} pages")


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    """Lambda entry point."""
    execution_id = event.get('execution_id')
    scraper_id = event.get('scraper_id')
    
    ingestor = WebScraperIngestor(
        execution_id=execution_id,
        target_scraper_id=scraper_id
    )
    return ingestor.run()
