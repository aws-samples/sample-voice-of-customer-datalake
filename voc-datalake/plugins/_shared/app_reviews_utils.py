"""
Shared collection pipeline for app review ingestor plugins (iOS and Android).

Frequency throttling (per app: an app connector's own ``frequency_minutes`` wins
over the plugin's top-level one), watermark management, and the run's health
report: storefront failures and "no reviews from any storefront" warnings, which
also reach a manual run's ``SOURCE_RUN#`` row as short ``errors`` text. Config
parsing and the review-list helpers live in ``app_reviews_config.py``.
"""

from abc import abstractmethod
from collections.abc import Callable, Generator
from datetime import UTC, datetime, timedelta
from typing import ClassVar, Protocol

from botocore.exceptions import BotoCoreError, ClientError

from _shared import app_reviews_parts as parts
from _shared.app_reviews_config import parse_int
from _shared.app_reviews_health import StorefrontTally, check_review_drop
from _shared.base_ingestor import BaseIngestor, logger, metrics, tracer
from shared.timestamps import now_iso

# Run-row ``errors`` entries one run keeps (one per app with a problem; the row is
# shown on the Data sources page, so it stays short).
MAX_RUN_WARNINGS = 20


class AppConfigLike(Protocol):
    """The fields every platform's app config dataclass shares."""

    name: str
    enabled: bool
    # The app connector's own schedule (None = the plugin's top-level value).
    frequency_minutes: int | None
    # The app connector's own sort order ("" = the plugin's top-level value).
    sort_by: str


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


def _ignore_warning(_text: str) -> None:
    """The default ``on_warning``: a caller without a run row to fill."""


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
    on_warning: Callable[[str], None] = _ignore_warning,
) -> Generator[dict, None, None]:
    """
    Shared review processing pipeline for a single app.

    Handles frequency throttling, watermark loading, review collection,
    filtering, yielding, watermark updates, and metrics emission.

    When execution_id is set (manual run), frequency checks are skipped —
    matching the webscraper pattern. ``on_warning`` receives the short run-row
    text of a collection failure or an app that stopped returning reviews.
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
        on_warning(f"{app_name}: collection failed ({type(e).__name__})")
        return

    drop = check_review_drop(
        get_watermark_fn, set_watermark_fn,
        platform_label=platform_label, app_name=app_name, candidates=len(reviews),
    )
    if drop:
        on_warning(drop)

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
        f"{app_name}_last_run", now_iso()
    )

    metrics.add_metric(
        name=f"{platform_label}_{app_name}_Reviews", unit="Count", value=yielded
    )
    logger.info(
        f"{platform_label} {app_name}: yielded {yielded} new reviews "
        f"(from {len(reviews)} candidates)"
    )


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
    skipping disabled apps before any review collection happens.

    Each app runs on its own ``frequency_minutes`` when its connector sets one
    (0 = manual only), else on the plugin's top-level value."""
    if not ingestor.app_configs:
        logger.warning(f"No {platform_label} app configurations found")
        return

    enabled: list[AppT] = []
    for app in ingestor.app_configs:
        if app.enabled:
            enabled.append(app)
        else:
            logger.info(f"Skipping disabled {platform_label} app: {app.name} ({app_identifier_of(app)})")

    for index, app in enumerate(enabled):
        # Out of time for another app: the rest run in the next part (app_reviews_parts.py).
        if ingestor.budget.must_hand_off():
            ingestor.pending_apps = enabled[index:]
            logger.info(f"{platform_label}: time budget reached after {index} apps; "
                        f"{len(enabled) - index} continue in part {ingestor.carried.part + 1}")
            return
        with ingestor.budget.timing_app():
            yield from process_app_reviews(
                app_config=app,
                app_name=app.name,
                platform_label=platform_label,
                date_field=date_field,
                get_watermark_fn=ingestor.get_watermark,
                set_watermark_fn=ingestor.set_watermark,
                frequency_minutes=ingestor.frequency_for(app),
                collect_fn=collect_fn,
                format_fn=format_fn,
                execution_id=ingestor.execution_id,
                on_warning=ingestor.record_run_warning,
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
        # Short problem texts of this run (storefront failures, review drops), added
        # to the run row's `errors` when the run completes.
        self.run_warnings: list[str] = []
        # Time-budgeted parts (app_reviews_parts.py): the earlier parts' totals, this
        # part's budget (none until run_for_event hands it the Lambda context) and
        # the apps left for the next part when the budget ran out.
        self.carried = parts.Carried()
        self.budget = parts.RunBudget()
        self.pending_apps: list[AppT] = []

    def frequency_for(self, app: AppT) -> int:
        """The app connector's own schedule, else the plugin's top-level one."""
        return self.frequency_minutes if app.frequency_minutes is None else app.frequency_minutes

    def sort_by_for(self, app: AppT) -> str:
        """The app connector's own sort order, else the plugin's top-level one."""
        return app.sort_by or self.sort_by

    def record_run_warning(self, text: str) -> None:
        if len(self.run_warnings) < MAX_RUN_WARNINGS:
            self.run_warnings.append(text)

    def new_tally(self, app: AppT) -> StorefrontTally:
        """An empty storefront tally for one collection of *app*."""
        return StorefrontTally(self.PLATFORM_LABEL, app.name, self.app_identifier(app))

    def report_storefronts(self, tally: StorefrontTally) -> None:
        """Log *tally*'s summary and keep its run-row text when storefronts failed."""
        text = tally.report()
        if text:
            self.record_run_warning(text)

    def _update_source_run_status(self, updates: dict):
        """Run-row writes with the earlier parts' totals and warnings (``run_row_updates``);
        a part out of time hands off instead of writing ``completed``."""
        if updates.get("status") == "completed" and self.pending_apps:
            self._continue_in_next_part(int(updates.get("items_found", 0)))
            return
        warnings = [*self.carried.warnings, *self.run_warnings]
        super()._update_source_run_status(
            parts.run_row_updates(updates, self.carried, warnings, MAX_RUN_WARNINGS)
        )

    def _continue_in_next_part(self, items_this_part: int) -> None:
        """Hand ``pending_apps`` to the next part; a failed hand-off ends the run as ``error``."""
        total = self.carried.items_found + items_this_part
        warnings = [*self.carried.warnings, *self.run_warnings][: MAX_RUN_WARNINGS - 1]
        apps = [(self.app_identifier(app), app.name) for app in self.pending_apps]
        event = parts.continuation_event(execution_id=self.execution_id, apps=apps, items_found=total,
                                         warnings=warnings, part=self.carried.part + 1)
        super()._update_source_run_status({"items_found": total})
        try:
            parts.start_next_part(event)
        except (BotoCoreError, ClientError, RuntimeError) as error:
            logger.exception(f"{self.PLATFORM_LABEL}: could not start the next part: {error}")
            metrics.add_metric(name="AppReviewsPartErrors", unit="Count", value=1)
            super()._update_source_run_status(
                parts.hand_off_failure_updates(total, warnings, len(self.pending_apps), error)
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
    def run_for_event(cls, event: object, context: object = None) -> dict:
        """Lambda body: build the ingestor and run it on the apps the event names
        (``configs_for_event``: one ``app_id``, a continuation part's apps, or all),
        with the Lambda *context*'s remaining time as its budget.

        Manual-run secret-cache clearing (issue #141) is centralized in
        BaseIngestor.__init__ — passing execution_id below triggers it.
        """
        execution_id = event.get("execution_id") if isinstance(event, dict) else None
        ingestor = cls(execution_id=execution_id)
        ingestor.budget = parts.RunBudget.for_context(context)
        try:
            ingestor.carried = parts.parse_continuation(event)
        except parts.InvalidContinuationError as error:
            return ingestor._refuse_part(f"invalid continuation event ({error})")
        ingestor.app_configs = parts.configs_for_event(
            event, ingestor.carried, ingestor.app_configs, ingestor.app_identifier
        )
        result = ingestor.run()
        if ingestor.carried.is_continuation and result.get("status") == "skipped":
            # A later part skipped by an open breaker would leave the row `running`.
            return ingestor._refuse_part(str(result.get("reason", "skipped")))
        return result

    def _refuse_part(self, reason: str) -> dict:
        """End a run whose part cannot run: logged, and the run row (if any) set to ``error``."""
        logger.error(f"{self.PLATFORM_LABEL}: run part not run: {reason}")
        self._update_source_run_status(
            {"status": "error", "completed_at": now_iso(), "errors": ["RunPartRefused"]}
        )
        return {"status": "skipped", "reason": reason}
