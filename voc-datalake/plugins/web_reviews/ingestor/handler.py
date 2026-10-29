"""
Web Reviews Ingestor - reads customer reviews from public review pages with a managed browser.

Each configured target (``POST /integrations/web_reviews/apps``: a name, an https
URL, ``max_pages``, ``max_reviews``, ``frequency_minutes``) is read in ONE AgentCore
browser session per run (``agentcore_browser``), page by page (``target_reader``), and
its reviews are taken from the page's JSON-LD or, failing that, from its text by the
``enrichment`` model (``extract``). A page unchanged since the last read is skipped
(``page_cache``), and a read cut short by time or the run's review cap continues in
the next run from a cursor (``resume``). Every target is its own source, stored on it
as ``source_id`` (``web_trustpilot_example_air``), so source profiles apply per connector. A blocked site
is reported in the run's errors (``<target>: blocked by <vendor>``), never read as
"no reviews". See docs/web-reviews.md.
"""

import time
from collections.abc import Callable, Generator
from datetime import date, timedelta
from typing import Any, Final

from agentcore_browser import BrowserUnavailableError, browser_session, session_seconds
from cdp_client import CdpError
from extract import LLM_MAX_TOKENS, LLM_SURFACE, Completion, ExtractedReview, extract_reviews
from page_cache import PageCache
from page_reader import BrowserTab, PageLoadError, PageSnapshot
from resume import ResumeCursor, ResumeStore, next_cursor
from target_reader import ReadLimits, TargetResult, read_target
from web_items import WebTarget, queue_item, stored_configs, target_from_config

from _shared.app_reviews_utils import is_due_for_run
from _shared.base_ingestor import BaseIngestor, logger, metrics, tracer
from shared.converse import converse
from shared.invocation_cost import measure_invocation_cost
from shared.timestamps import now_iso
from shared.web_review_targets import MAX_REVIEWS, TargetError

#: Reviews one run sends at most, across every target (a target's own limit at most).
MAX_REVIEWS_PER_RUN: Final = MAX_REVIEWS
#: Run errors kept on the SOURCE_RUN record, and characters per error.
MAX_RUN_ERRORS: Final = 20
MAX_ERROR_CHARS: Final = 200
#: Seconds a page needs at worst (load or fetch, then a model call); no page starts with less left.
PAGE_BUDGET_SECONDS: Final = 120
#: Seconds kept back at the end of the invocation for queueing and bookkeeping.
RESERVE_SECONDS: Final = 30
#: A review older than the target's newest date minus this is not sent again.
WATERMARK_SLACK: Final = timedelta(days=1)
DEFAULT_TIMEOUT_SECONDS: Final = 900


def _model_completion(prompt: str, system_prompt: str) -> str:
    return converse(
        prompt=prompt, system_prompt=system_prompt, max_tokens=LLM_MAX_TOKENS, temperature=None,
        surface=LLM_SURFACE, step_name='web_reviews', max_continuations=0,
    )


class WebReviewsIngestor(BaseIngestor):
    """Ingestor for reviews read from public web pages."""

    def __init__(self, execution_id: str | None = None, *, deadline: float | None = None,
                 complete: Completion = _model_completion):
        super().__init__(execution_id=execution_id)
        self.run_errors: list[str] = []
        self.only_target: str | None = None  # pragma: no mutate  annotation unevaluated in a function; read only by truthiness
        self._deadline = deadline if deadline is not None else time.monotonic() + DEFAULT_TIMEOUT_SECONDS
        self._complete = complete
        self._sent = 0
        self._resume = ResumeStore(self.get_watermark, self.set_watermark)

    # ── bookkeeping ──────────────────────────────────────────────────────────

    def _remaining(self) -> float:
        return self._deadline - time.monotonic() - RESERVE_SECONDS

    def _has_time(self) -> bool:
        return self._remaining() >= PAGE_BUDGET_SECONDS

    def _report(self, message: str) -> None:
        if len(self.run_errors) < MAX_RUN_ERRORS:
            self.run_errors.append(message[:MAX_ERROR_CHARS])

    def _update_source_run_status(self, updates: dict):
        """A completed run carries its per-target errors (blocked sites), so they reach the UI."""
        if updates.get('status') == 'completed' and self.run_errors:
            updates = {**updates, 'errors': list(self.run_errors)}
        super()._update_source_run_status(updates)

    # ── targets ──────────────────────────────────────────────────────────────

    def _targets(self) -> list[WebTarget]:
        targets: list[WebTarget] = []
        for config in stored_configs(self.secrets):
            name = config.get('app_name') if isinstance(config, dict) else None
            try:
                targets.append(target_from_config(config))
            except TargetError as error:
                self._report(f'{name or "A target"}: {error}')
        if self.only_target:
            targets = [t for t in targets if self.only_target in (t.id, t.url)]
        return [t for t in targets if t.enabled and self._is_due(t)]

    def _is_due(self, target: WebTarget) -> bool:
        if self.execution_id:
            return True  # a manual run reads every enabled target
        if target.frequency_minutes == 0:
            return False
        return is_due_for_run(self.get_watermark, target.watermark_prefix, target.frequency_minutes)

    def _watermark(self, target: WebTarget) -> date | None:
        stored = self.get_watermark(f'{target.watermark_prefix}_newest_review')
        try:
            return date.fromisoformat(stored) if stored else None
        except ValueError:
            return None

    # ── reading ──────────────────────────────────────────────────────────────

    def _extract(self, snapshot: PageSnapshot) -> list[ExtractedReview]:
        return extract_reviews(snapshot.jsonld, snapshot.text, self._complete)

    def _extractor(self, cache: PageCache, backfill: bool) -> Callable[[PageSnapshot], list[ExtractedReview]]:
        """The page extraction of one read: an incremental read skips a page unchanged since it was last read."""
        def extract(snapshot: PageSnapshot) -> list[ExtractedReview]:
            if not backfill and cache.unchanged(snapshot):
                return []  # nothing new on it, and no model call
            return self._extract(snapshot)
        return extract

    def _review_caps(self, target: WebTarget, cursor: ResumeCursor | None) -> tuple[int, int | None]:
        """``(reviews this read may take, what the target's own limit leaves (None: no limit))``."""
        limit = target.review_limit
        target_left = None if limit is None else limit - (cursor.reviews if cursor else 0)
        run_left = MAX_REVIEWS_PER_RUN - self._sent
        return (run_left if target_left is None else min(target_left, run_left)), target_left

    def _read(self, tab: BrowserTab, target: WebTarget, cursor: ResumeCursor | None) -> tuple[TargetResult, int | None]:
        """The target read from its URL, or from *cursor* (a backfill: every review is new)."""
        watermark = self._watermark(target)
        cutoff = watermark - WATERMARK_SLACK if watermark else None

        def is_new(review: ExtractedReview) -> bool:
            return cursor is not None or cutoff is None or review.date is None or date.fromisoformat(review.date) >= cutoff

        cap, target_left = self._review_caps(target, cursor)
        cache = PageCache(target.watermark_prefix, self.get_watermark, self.set_watermark)
        limits = ReadLimits(max_pages=target.page_limit, max_reviews=cap, has_time=self._has_time, is_new=is_new,
                            start_page=cursor.page if cursor else 0, stop_when_nothing_new=cursor is None,
                            after_page=cache.remember)
        if cursor is not None:
            logger.info(f'web_reviews {target.host}: resuming at page {cursor.page + 1} '
                        f'({cursor.reviews} reviews read so far)')
        url = cursor.url if cursor else target.url
        return read_target(tab, url, self._extractor(cache, cursor is not None), limits), target_left

    def _items_of(self, target: WebTarget, result: TargetResult,
                  resume_at: ResumeCursor | None) -> Generator[dict, None, None]:
        for read in result.reviews:
            yield queue_item(target, read.review, page=read.page, page_url=read.page_url, brand_name=self.brand_name)
            self._sent += 1
        newest = max((read.review.date for read in result.reviews if read.review.date), default=None)
        previous = self._watermark(target)
        if newest and (previous is None or newest > previous.isoformat()):
            self.set_watermark(f'{target.watermark_prefix}_newest_review', newest)
        self._resume.save(target, resume_at)
        self.set_watermark(f'{target.watermark_prefix}_last_run', now_iso())
        metrics.add_metric(name='WebReviewsRead', unit='Count', value=len(result.reviews))
        logger.info(f'web_reviews {target.host}: {len(result.reviews)} reviews from {result.pages_read} pages '
                    f'(stop: {result.stop})')
        if resume_at is not None:
            logger.info(f'web_reviews {target.host}: will resume at page {resume_at.page + 1}')

    def _read_target(self, tab: BrowserTab, target: WebTarget) -> tuple[TargetResult, ResumeCursor | None] | None:
        """The target's reviews and where a later run resumes it, or ``None`` after reporting why there are none."""
        if not self._has_time():
            self._report(f'{target.name}: skipped, the run ran out of time')
            return None
        cursor = self._resume.load(target)
        try:
            result, target_left = self._read(tab, target, cursor)
        except (PageLoadError, CdpError) as error:
            self._report(f'{target.name}: {error}')
            self._resume.save(target, None)
            return None
        except Exception as error:  # one target's failure must not lose the others
            logger.exception(f'web_reviews target {target.host} failed')
            self._report(f'{target.name}: failed ({type(error).__name__})')
            self._resume.save(target, None)
            return None
        if result.off_host:
            self._report(f'{target.name}: redirected off-host')
        if result.blocked:
            self._report(f'{target.name}: blocked by {result.blocked}')
            metrics.add_metric(name='WebReviewsBlocked', unit='Count', value=1)
        return result, next_cursor(cursor, result, target_limit_left=target_left)

    @tracer.capture_method
    def fetch_new_items(self) -> Generator[dict, None, None]:
        targets = self._targets()
        if not targets:
            logger.info('web_reviews: no target is due')
            return
        try:
            with browser_session(session_seconds(self._remaining() + RESERVE_SECONDS)) as cdp:
                tab = BrowserTab(cdp)
                tab.open()
                for target in targets:
                    if self._sent >= MAX_REVIEWS_PER_RUN:
                        self._report(f'{target.name}: skipped, the run reached {MAX_REVIEWS_PER_RUN} reviews')
                        continue
                    read = self._read_target(tab, target)
                    if read is not None:
                        yield from self._items_of(target, *read)
        except BrowserUnavailableError as error:
            self._report(str(error))
        except (PageLoadError, CdpError) as error:
            self._report(f'The browser session failed: {error}')

    @classmethod
    def run_for_event(cls, event: object, context: Any = None) -> dict:
        """Lambda body: one run, optionally limited to one target (``event['app_id']``: its id or URL)."""
        execution_id = event.get('execution_id') if isinstance(event, dict) else None
        remaining_ms = context.get_remaining_time_in_millis() if context is not None else None
        deadline = time.monotonic() + remaining_ms / 1000 if remaining_ms is not None else None
        ingestor = cls(execution_id=execution_id, deadline=deadline)
        if isinstance(event, dict) and isinstance(event.get('app_id'), str):
            ingestor.only_target = event['app_id']
        return ingestor.run()

    def normalize_item(self, item: dict, raw_content: str | None = None) -> dict:
        """Base normalization plus the item's ``metadata`` (target name, page), which the queue schema accepts."""
        normalized = super().normalize_item(item, raw_content)
        if isinstance(item.get('metadata'), dict):
            normalized['metadata'] = item['metadata']
        return normalized


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
@measure_invocation_cost
def lambda_handler(event, context):
    return WebReviewsIngestor.run_for_event(event, context)
