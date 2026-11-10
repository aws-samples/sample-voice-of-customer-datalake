"""
App-review connector configs and review-list helpers (iOS and Android).

Split out of ``app_reviews_utils.py`` (the collection pipeline): reading one app
connector's stored config — including its own ``frequency_minutes`` and ``sort_by``,
which override the plugin's top-level values — and the pure helpers that merge,
order and date the reviews a storefront returned.
"""

import json
from collections.abc import Callable, Iterable
from datetime import UTC, datetime

from _shared.base_ingestor import logger
from shared.radar_brands import radar_stamp
from shared.timestamps import now_iso


def config_radar_brand(cfg: dict) -> str:
    """The Radar brand key an app connector's config names (``""`` = one of our own apps).

    Taken as stored, not re-validated: ``radar_stamp`` sends a malformed one on so the
    queue schema refuses it (fail closed), rather than queueing another brand's reviews
    as our own.
    """
    return radar_stamp(cfg.get("radar_brand")).get("radar_brand_key", "")


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


def app_frequency_minutes(cfg: dict) -> int | None:
    """One app connector's own ``frequency_minutes`` (0 = manual runs only).

    ``None`` when the entry does not set a usable one, so the plugin's top-level value
    applies (an entry saved before per-app schedules existed). The connector form saves
    the value as a string ("1440").
    """
    raw = cfg.get("frequency_minutes")
    if raw is None or not str(raw).strip():
        return None
    parsed = parse_int(str(raw).strip(), -1, allow_zero=True)
    return parsed if parsed >= 0 else None


def app_sort_by(cfg: dict) -> str:
    """One app connector's own ``sort_by`` (``""`` = the plugin's top-level value)."""
    return str(cfg.get("sort_by") or "").strip()


def app_entry_fields(cfg: dict) -> dict:
    """The config fields every platform's app entry shares (name, enabled, review cap,
    schedule, sort order, Radar brand); the platform adds its store identifier."""
    return {
        "name": cfg.get("app_name", "").strip(),
        "enabled": cfg.get("enabled", True),
        # An absent cap stringifies to "None", which parse_int rejects → 500.
        "max_reviews_per_run": parse_int(str(cfg.get("max_reviews_per_run")), 500),
        "frequency_minutes": app_frequency_minutes(cfg),
        "sort_by": app_sort_by(cfg),
        "radar_brand": config_radar_brand(cfg),
    }


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
    return now_iso()
