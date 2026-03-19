"""
Shared utilities for app review ingestor plugins (iOS and Android).

Extracts common logic for frequency throttling, watermark management,
and integer parsing to avoid duplication across platform-specific handlers.
"""

from datetime import datetime, timedelta, timezone
from typing import Generator

from _shared.base_ingestor import logger, metrics


def parse_int(value: str, default: int) -> int:
    """Safely parse a positive integer from string, returning default on failure."""
    try:
        parsed = int(value)
        return parsed if parsed > 0 else default
    except (ValueError, TypeError):
        return default


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
        last_run_dt = datetime.fromisoformat(last_run.replace("Z", "+00:00"))
        next_run = last_run_dt + timedelta(minutes=frequency_minutes)
        return datetime.now(timezone.utc) >= next_run
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
        if watermark_dt and review_dt and review_dt <= watermark_dt:
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
) -> Generator[dict, None, None]:
    """
    Shared review processing pipeline for a single app.

    Handles frequency throttling, watermark loading, review collection,
    filtering, yielding, watermark updates, and metrics emission.
    """
    # Check frequency-based throttling
    if not is_due_for_run(get_watermark_fn, app_name, frequency_minutes):
        logger.info(
            f"Skipping {platform_label} {app_name} - not due yet "
            f"(frequency: {frequency_minutes}m)"
        )
        return

    logger.info(f"Collecting {platform_label} reviews for {app_name}")

    # Load watermark
    watermark_key = f"{app_name}_last_published_at"
    watermark_dt = load_watermark_dt(get_watermark_fn, watermark_key)

    try:
        reviews = collect_fn(app_config)
    except Exception as e:
        logger.error(f"Failed to collect reviews for {app_name}: {e}")
        metrics.add_metric(
            name=f"{platform_label}_{app_name}_Errors", unit="Count", value=1
        )
        return

    newest_date = watermark_dt
    yielded = 0

    for formatted, review_dt in yield_new_reviews(
        reviews, watermark_dt, date_field, format_fn, app_config
    ):
        yield formatted
        yielded += 1

        if review_dt and (newest_date is None or review_dt > newest_date):
            newest_date = review_dt

    # Update watermarks
    if newest_date and newest_date != watermark_dt:
        set_watermark_fn(watermark_key, newest_date.isoformat())

    set_watermark_fn(
        f"{app_name}_last_run", datetime.now(timezone.utc).isoformat()
    )

    metrics.add_metric(
        name=f"{platform_label}_{app_name}_Reviews", unit="Count", value=yielded
    )
    logger.info(
        f"{platform_label} {app_name}: yielded {yielded} new reviews "
        f"(from {len(reviews)} candidates)"
    )
