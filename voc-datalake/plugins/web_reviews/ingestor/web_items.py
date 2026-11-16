"""Web-review targets as the ingestor reads them, and the queue items their reviews become."""

import hashlib
import json
import unicodedata
from dataclasses import dataclass
from typing import Final
from urllib.parse import urlparse

from extract import ExtractedReview
from review_text import plain_review_text

from shared.radar_brands import radar_stamp
from shared.timestamps import now_iso
from shared.web_review_methods import STEP_AGENTCORE_WEB_SEARCH, STEP_BEDROCK_WEB_SEARCH
from shared.web_review_targets import MAX_PAGES, METHOD_AUTO, validated_target, web_review_source_id

CHANNEL_MAX_CHARS: Final = 100
#: A metadata value's ceiling (shared/ingest_schemas.py MAX_METADATA_VALUE_LENGTH: flat primitives, 1,000 characters).
METADATA_VALUE_MAX_CHARS: Final = 1000
#: The steps whose review text a model relays (Amazon Bedrock web search, AgentCore Web Search's snippets): its
#: "verbatim" body varies from one read to the next, so their reviews are known by stable fields (``review_id``).
MODEL_RELAYED_STEPS: Final = frozenset({STEP_BEDROCK_WEB_SEARCH, STEP_AGENTCORE_WEB_SEARCH})
#: Characters of its normalized text a model-relayed review with neither title nor author is known by.
RELAYED_TEXT_PREFIX_CHARS: Final = 200


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
    #: How it is read: ``auto`` (the default), ``browser`` or ``bedrock_web_search`` (shared/web_review_targets.py METHODS).
    method: str = METHOD_AUTO

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
        method=cleaned['method'],
    )


def stored_configs(secrets: dict) -> list[object]:
    """The ``configs`` array of the plugin's secret namespace (``[]`` when absent or malformed)."""
    raw = secrets.get('configs')
    try:
        configs = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return []
    return configs if isinstance(configs, list) else []


def _normalized(value: str | None) -> str:
    """*value* compared loosely: plain text (``plain_review_text``), NFKC, case-folded, and every run of whitespace and
    punctuation one space (``''`` for none)."""
    if not value:
        return ''
    folded = unicodedata.normalize('NFKC', plain_review_text(value)).casefold()
    # Every run of anything but letters and digits (whitespace, punctuation, underscores) is one space. Spelled out
    # here, not shared: a review's id must not move when another module's text rule does.
    return ' '.join(''.join(char if char.isalnum() else ' ' for char in folded).split())


def _page_path(page_url: str) -> str:
    """The path of *page_url*, lower-cased, without its trailing slash (``/`` for none)."""
    return (urlparse(page_url).path.rstrip('/') or '/').lower()


def relayed_review_key(host: str, review: ExtractedReview, page_url: str) -> str:
    """What a model-relayed review is known by: the site, the page's path and the review's date, then its author and
    title (normalized) when it has either, else the first ``RELAYED_TEXT_PREFIX_CHARS`` characters of its normalized
    text. Never the whole text: the model's "verbatim" body varies between reads (more, or fewer, words at its end)."""
    head = [host.lower(), _page_path(page_url), review.date or '']
    author, title = _normalized(review.author), _normalized(review.title)
    if author or title:
        return '\n'.join(['relayed', *head, 'by', author, title])
    prefix = _normalized(review.text)[:RELAYED_TEXT_PREFIX_CHARS].rstrip()
    return '\n'.join(['relayed', *head, 'text', prefix])


def _is_relayed_step(method_used: object) -> bool:
    return isinstance(method_used, str) and method_used in MODEL_RELAYED_STEPS


def review_id(host: str, review: ExtractedReview, *, method_used: object = None, page_url: str = '') -> str:
    """Deterministic: the same review read again (another run, another page) gets the same id.

    A review the browser read (any *method_used* but a model-relayed one) hashes the host, its extracted text and
    its date, exactly as every stored one did. A model-relayed one (``MODEL_RELAYED_STEPS``) hashes
    ``relayed_review_key`` over *page_url* (the target's page: the one page such a read asks for).
    """
    if _is_relayed_step(method_used):
        material = relayed_review_key(host, review, page_url)
    else:
        material = f'{host.lower()}\n{review.text}\n{review.date or ""}'
    return f'web_{hashlib.sha256(material.encode()).hexdigest()}'


def is_model_relayed(item: dict) -> bool:
    """Whether the queue item *item* holds a review a model relayed (its ``method_used``: ``MODEL_RELAYED_STEPS``)."""
    metadata = item.get('metadata')
    return isinstance(metadata, dict) and _is_relayed_step(metadata.get('method_used'))


def created_at(review: ExtractedReview) -> str:
    """The review's own date (midnight UTC), else the ingest time."""
    if review.date:
        return f'{review.date}T00:00:00+00:00'
    return now_iso()


def url_list(urls: list[str]) -> str:
    """*urls* space-separated for a metadata value: as many whole URLs as fit its ceiling."""
    kept: list[str] = []
    for url in urls:
        if len(' '.join([*kept, url])) > METADATA_VALUE_MAX_CHARS:
            break
        kept.append(url)
    return ' '.join(kept)


def queue_item(target: WebTarget, review: ExtractedReview, *, page: int, page_url: str, brand_name: str,
               attribution: dict[str, object] | None = None) -> dict:
    """The item ``BaseIngestor.normalize_item`` turns into a processing-queue message.

    *attribution*: flat metadata (strings, and the ``excerpt`` flag) a method stores on every review it read: the step
    that read it (``method_used``: ``browser``, ``bedrock_web_search`` or ``agentcore_web_search``); for
    bedrock_web_search the method, model, site, source URL, when it was read, the URLs opened and cited; for an
    AgentCore Web Search excerpt the snippet, its URL, title and publication time; beside the target and the page.
    """
    method_used = (attribution or {}).get('method_used')
    return {
        # A model-relayed review is known by its stable fields on the target's page, not by the page it came from.
        'id': review_id(target.host, review, method_used=method_used, page_url=target.url),
        'channel': target.name[:CHANNEL_MAX_CHARS],
        # Plain text, cleaned HERE rather than at extraction: a browser read's `review_id` hashes the extracted
        # text, so a review stored before the cleaning keeps its id and is not stored twice.
        'text': plain_review_text(review.text),
        'title': plain_review_text(review.title) if review.title else review.title,
        'rating': review.rating,
        'created_at': created_at(review),
        'url': page_url,
        'author': review.author,
        'brand_handles_matched': [brand_name] if brand_name else [],
        'source_platform_override': target.source_platform,
        'metadata': {'target': target.name, 'page': page, **(attribution or {})},
        **radar_stamp(target.radar_brand),
    }
