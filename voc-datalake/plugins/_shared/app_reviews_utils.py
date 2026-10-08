"""
Shared utilities for app review ingestor plugins (iOS and Android).

Extracts common logic for frequency throttling, watermark management,
and integer parsing to avoid duplication across platform-specific handlers.
"""

import json
from abc import abstractmethod
from collections.abc import Callable, Generator, Iterable
from datetime import UTC, datetime, timedelta
from typing import ClassVar, Protocol

from _shared.base_ingestor import BaseIngestor, logger, metrics, tracer


class AppConfigLike(Protocol):
    """The fields every platform's app config dataclass shares."""

    name: str
    enabled: bool


def parse_int(value: str | None, default: int, *, allow_zero: bool = False) -> int:
    """Safely parse a non-negative integer from string, returning default on failure.

    Args:
        value: String to parse (``None``, an absent setting, yields *default*).
        default: Fallback when parsing fails or value is out of range.
        allow_zero: When True, 0 is accepted (e.g. frequency_minutes=0 means manual-only).
    """
    if value is None:
        return default
    try:
        parsed = int(value)
    except (ValueError, TypeError):
        return default
    if allow_zero and parsed == 0:
        return 0
    return parsed if parsed > 0 else default


def is_due_for_run(
    get_watermark_fn,
    app_name: str,
    frequency_minutes: int,
) -> bool:
    """
    Check if enough time has passed since the last run.

    Returns True if the app is due for a new collection run.
    """
    last_run = get_watermark_fn(f"{app_name}_last_run")
    if not last_run:
        return True

    try:
        last_run_dt = datetime.fromisoformat(last_run)
        next_run = last_run_dt + timedelta(minutes=frequency_minutes)
        return datetime.now(UTC) >= next_run
    except (ValueError, TypeError):
        return True


def load_watermark_dt(get_watermark_fn, watermark_key: str) -> datetime | None:
    """Load and parse a watermark timestamp, returning None on failure."""
    last_published = get_watermark_fn(watermark_key)
    if not last_published:
        return None
    try:
        return datetime.fromisoformat(last_published.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def yield_new_reviews(
    reviews: list[dict],
    watermark_dt: datetime | None,
    date_field: str,
    format_fn,
    app_config,
) -> Generator[tuple[dict, datetime | None], None, None]:
    """
    Yield formatted reviews newer than the watermark.

    Yields (formatted_review, review_datetime) tuples.
    The caller is responsible for tracking the newest date and updating watermarks.
    """
    for review in reviews:
        review_date = review.get(date_field)
        if review_date and hasattr(review_date, "isoformat"):
            review_dt = review_date
        else:
            review_dt = None

        # Skip reviews older than watermark
        if watermark_dt is not None and review_dt is not None and review_dt <= watermark_dt:
            continue

        formatted = format_fn(review, app_config)
        yield formatted, review_dt


def process_app_reviews(
    *,
    app_config,
    app_name: str,
    platform_label: str,
    date_field: str,
    get_watermark_fn,
    set_watermark_fn,
    frequency_minutes: int,
    collect_fn,
    format_fn,
    execution_id: str | None = None,
) -> Generator[dict, None, None]:
    """
    Shared review processing pipeline for a single app.

    Handles frequency throttling, watermark loading, review collection,
    filtering, yielding, watermark updates, and metrics emission.

    When execution_id is set (manual run), frequency checks are skipped —
    matching the webscraper pattern.
    """
    # Manual run (has execution_id): always run, skip frequency check
    # Scheduled run (no execution_id): check frequency, skip if manual-only (0)
    if not execution_id:
        if frequency_minutes == 0:
            logger.info(
                f"Skipping {platform_label} {app_name} - manual-only frequency"
            )
            return
        if not is_due_for_run(get_watermark_fn, app_name, frequency_minutes):
            logger.info(
                f"Skipping {platform_label} {app_name} - not due yet "
                f"(frequency: {frequency_minutes}m)"
            )
            return

    logger.info(f"Collecting {platform_label} reviews for {app_name}")

    # Load watermark — skip date filtering on manual runs to allow backfilling.
    # When max_reviews_per_run increases, older reviews that were never fetched
    # would be permanently blocked by the watermark. The processor deduplicates
    # by review ID, so re-sending already-ingested reviews is safe.
    watermark_key = f"{app_name}_last_published_at"
    if execution_id:
        watermark_dt = None
        logger.info("Manual run: skipping watermark filter for backfill")
    else:
        watermark_dt = load_watermark_dt(get_watermark_fn, watermark_key)

    try:
        reviews = collect_fn(app_config)
    except Exception as e:
        logger.exception(f"Failed to collect reviews for {app_name}: {e}")
        metrics.add_metric(
            name=f"{platform_label}_{app_name}_Errors", unit="Count", value=1
        )
        return

    newest_date = None
    yielded = 0

    for formatted, review_dt in yield_new_reviews(
        reviews, watermark_dt, date_field, format_fn, app_config
    ):
        yield formatted
        yielded += 1

        if review_dt and (newest_date is None or review_dt > newest_date):
            newest_date = review_dt

    # Update watermarks
    # Every dated review yielded is newer than the watermark, so any newest date advances it.
    if newest_date:
        set_watermark_fn(watermark_key, newest_date.isoformat())

    set_watermark_fn(
        f"{app_name}_last_run", datetime.now(UTC).isoformat()
    )

    metrics.add_metric(
        name=f"{platform_label}_{app_name}_Reviews", unit="Count", value=yielded
    )
    logger.info(
        f"{platform_label} {app_name}: yielded {yielded} new reviews "
        f"(from {len(reviews)} candidates)"
    )


def load_app_configs(
    secrets: dict,
    *,
    platform_label: str,
    legacy_id_key: str,
    from_entry: Callable[[dict], object],
    from_legacy: Callable[[str, str, int], object],
) -> list:
    """Load app configurations from the ``configs`` JSON array, falling back
    to the legacy single-app flat keys (``app_name`` + *legacy_id_key*).

    ``from_entry`` builds one config from an array entry; ``from_legacy`` builds
    the single legacy config from ``(app_name, app_identifier, max_reviews)``.
    Both may raise ``ValueError``/``TypeError`` for an invalid config, which is
    logged and skipped.
    """
    # Try new multi-app format first
    configs_json = secrets.get("configs", "")
    if configs_json:
        try:
            configs_list = json.loads(configs_json) if isinstance(configs_json, str) else configs_json
            if isinstance(configs_list, list):
                result = []
                for cfg in configs_list:
                    try:
                        result.append(from_entry(cfg))
                    except (ValueError, TypeError) as e:
                        logger.warning(f"Skipping invalid {platform_label} app config: {e}")
                if result:
                    return result
        except (json.JSONDecodeError, TypeError) as e:
            logger.warning(f"Failed to parse {platform_label} configs array: {e}")

    # Fallback to legacy single-app flat keys
    app_name = secrets.get("app_name", "").strip()
    app_identifier = secrets.get(legacy_id_key, "").strip()
    max_reviews = parse_int(secrets.get("max_reviews_per_run"), 500)

    if not app_name or not app_identifier:
        return []

    try:
        return [from_legacy(app_name, app_identifier, max_reviews)]
    except (ValueError, TypeError) as e:
        logger.warning(f"Invalid {platform_label} app config: {e}")
        return []


def merge_reviews_by_composite_id(
    all_reviews: dict[str, dict],
    reviews: Iterable[dict],
    *,
    country: str,
    composite_id_for: Callable[[dict], str | None],
) -> None:
    """Add *reviews* to *all_reviews* keyed by their composite id, keeping the
    first copy of each id and tagging it with the storefront *country*.

    A review for which ``composite_id_for`` returns a falsy id is skipped.
    """
    for review in reviews:
        composite_id = composite_id_for(review)
        if not composite_id:
            continue
        if composite_id not in all_reviews:
            all_reviews[composite_id] = {
                **review,
                "composite_id": composite_id,
                "country": country,
            }


def newest_first(reviews: Iterable[dict], *, date_field: str, cap: int) -> list[dict]:
    """Sort reviews by *date_field* descending (undated last) and cap the list."""
    sorted_reviews = sorted(
        reviews,
        key=lambda r: r.get(date_field) or datetime.min.replace(tzinfo=UTC),
        reverse=True,
    )
    return sorted_reviews[:cap]


def review_created_at(date) -> str:
    """ISO timestamp for a review date that may be a datetime, a string or absent."""
    if date and hasattr(date, "isoformat"):
        return date.isoformat()
    if isinstance(date, str):
        return date
    return datetime.now(UTC).isoformat()


def process_enabled_apps[AppT: AppConfigLike](
    ingestor: "AppReviewsIngestor[AppT]",
    *,
    platform_label: str,
    app_identifier_of: Callable[[AppT], str],
    date_field: str,
    collect_fn: Callable[[AppT], list[dict]],
    format_fn: Callable[[dict, AppT], dict],
) -> Generator[dict, None, None]:
    """Run ``process_app_reviews`` for every enabled app config of *ingestor*
    (an ``AppReviewsIngestor`` with ``app_configs`` and ``frequency_minutes``),
    skipping disabled apps before any review collection happens."""
    if not ingestor.app_configs:
        logger.warning(f"No {platform_label} app configurations found")
        return

    for app in ingestor.app_configs:
        if not app.enabled:
            logger.info(
                f"Skipping disabled {platform_label} app: {app.name} ({app_identifier_of(app)})"
            )
            continue
        yield from process_app_reviews(
            app_config=app,
            app_name=app.name,
            platform_label=platform_label,
            date_field=date_field,
            get_watermark_fn=ingestor.get_watermark,
            set_watermark_fn=ingestor.set_watermark,
            frequency_minutes=ingestor.frequency_minutes,
            collect_fn=collect_fn,
            format_fn=format_fn,
            execution_id=ingestor.execution_id,
        )


class AppReviewsIngestor[AppT: AppConfigLike](BaseIngestor):
    """Common base for the iOS and Android app-review ingestors.

    Subclasses set ``PLATFORM_LABEL``, ``DATE_FIELD`` and ``DEFAULT_SORT_BY`` and
    implement the platform-specific config loading, collection and formatting.
    """

    PLATFORM_LABEL: ClassVar[str]
    DATE_FIELD: ClassVar[str]
    DEFAULT_SORT_BY: ClassVar[str]

    def __init__(self, execution_id: str | None = None):
        # execution_id → BaseIngestor manual-run cache clear (#141/#215).
        super().__init__(execution_id=execution_id)
        self.app_configs: list[AppT] = self._load_app_configs()
        self.sort_by = self.secrets.get("sort_by", self.DEFAULT_SORT_BY)
        self.frequency_minutes = parse_int(
            self.secrets.get("frequency_minutes"), 60, allow_zero=True
        )

    @abstractmethod
    def _load_app_configs(self) -> list[AppT]:
        """Load app configurations from JSON array or legacy flat keys."""

    @abstractmethod
    def app_identifier(self, app: AppT) -> str:
        """The store identifier of *app* (matched against ``event['app_id']``)."""

    @abstractmethod
    def _collect_reviews_for_app(self, app: AppT) -> list[dict]:
        """Collect raw reviews for a single app."""

    @abstractmethod
    def _format_review(self, review: dict, app: AppT) -> dict:
        """Format a raw review into the VoC pipeline schema."""

    @tracer.capture_method
    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch new reviews from all configured apps of this platform."""
        yield from process_enabled_apps(
            self,
            platform_label=self.PLATFORM_LABEL,
            app_identifier_of=self.app_identifier,
            date_field=self.DATE_FIELD,
            collect_fn=self._collect_reviews_for_app,
            format_fn=self._format_review,
        )

    @classmethod
    def run_for_event(cls, event: object) -> dict:
        """Lambda body: build the ingestor and run it, optionally filtered to
        a single app via ``event['app_id']``.

        Manual-run secret-cache clearing (issue #141) is centralized in
        BaseIngestor.__init__ — passing execution_id below triggers it.
        """
        execution_id = event.get("execution_id") if isinstance(event, dict) else None
        ingestor = cls(execution_id=execution_id)
        if isinstance(event, dict):
            app_id = event.get("app_id")
            if app_id:
                ingestor.app_configs = [
                    c for c in ingestor.app_configs if ingestor.app_identifier(c) == app_id
                ]
        return ingestor.run()
