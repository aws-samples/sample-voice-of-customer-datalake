"""Web-review targets as the ingestor reads them, and the queue items their reviews become."""

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final
from urllib.parse import urlparse

from extract import ExtractedReview

from shared.radar_brands import radar_stamp
from shared.web_review_targets import MAX_PAGES, validated_target, web_review_source_id

CHANNEL_MAX_CHARS: Final = 100


@dataclass(frozen=True)
class WebTarget:
    id: str
    name: str
    url: str
    max_pages: int
    max_reviews: int
    frequency_minutes: int
    enabled: bool
    #: The stored source label; empty for a target saved before it existed.
    source_id: str = ''
    #: The Radar brand key its reviews go to (docs/radar.md); empty for one of our own sources.
    radar_brand: str = ''

    @property
    def page_limit(self) -> int:
        """Pages this target reads at most: its ``max_pages``, or the hard cap when that is 0 (every page)."""
        return self.max_pages or MAX_PAGES

    @property
    def review_limit(self) -> int | None:
        """Reviews this target reads at most: its ``max_reviews``, or ``None`` (no limit) when that is 0."""
        return self.max_reviews or None

    @property
    def host(self) -> str:
        return (urlparse(self.url).hostname or '').lower()

    @property
    def source_platform(self) -> str:
        """Its reviews' source: the stored ``source_id``, else minted from its host and name."""
        return self.source_id or web_review_source_id(self.host, self.name)

    @property
    def watermark_prefix(self) -> str:
        """Names this target's watermarks; by its id, or its URL when a hand-edited config has none."""
        key = self.id or hashlib.sha256(self.url.encode()).hexdigest()[:16]
        return f'target_{key}'


def target_from_config(config: object) -> WebTarget:
    """A stored config as a target; ``TargetError`` (client-safe) when it is not a valid one.

    Re-validated on every run: the secret can be edited outside the API.
    """
    cleaned = validated_target(config)
    return WebTarget(
        id=cleaned.get('id', ''),
        name=cleaned['app_name'],
        url=cleaned['url'],
        max_pages=int(cleaned['max_pages']),
        max_reviews=int(cleaned['max_reviews']),
        frequency_minutes=int(cleaned['frequency_minutes']),
        enabled=cleaned['enabled'] == 'true',
        source_id=cleaned.get('source_id', ''),
        radar_brand=cleaned.get('radar_brand', ''),
    )


def stored_configs(secrets: dict) -> list[object]:
    """The ``configs`` array of the plugin's secret namespace (``[]`` when absent or malformed)."""
    raw = secrets.get('configs')
    try:
        configs = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return []
    return configs if isinstance(configs, list) else []


def review_id(host: str, review: ExtractedReview) -> str:
    """Deterministic: the same review read again (another run, another page) gets the same id."""
    material = f'{host.lower()}\n{review.text}\n{review.date or ""}'
    return f'web_{hashlib.sha256(material.encode()).hexdigest()}'


def created_at(review: ExtractedReview) -> str:
    """The review's own date (midnight UTC), else the ingest time."""
    if review.date:
        return f'{review.date}T00:00:00+00:00'
    return datetime.now(UTC).isoformat()


def queue_item(target: WebTarget, review: ExtractedReview, *, page: int, page_url: str, brand_name: str) -> dict:
    """The item ``BaseIngestor.normalize_item`` turns into a processing-queue message."""
    return {
        'id': review_id(target.host, review),
        'channel': target.name[:CHANNEL_MAX_CHARS],
        'text': review.text,
        'title': review.title,
        'rating': review.rating,
        'created_at': created_at(review),
        'url': page_url,
        'author': review.author,
        'brand_handles_matched': [brand_name] if brand_name else [],
        'source_platform_override': target.source_platform,
        'metadata': {'target': target.name, 'page': page},
        **radar_stamp(target.radar_brand),
    }
