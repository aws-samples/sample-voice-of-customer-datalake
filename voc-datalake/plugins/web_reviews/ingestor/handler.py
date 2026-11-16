"""
Web Reviews Ingestor - reads customer reviews from public review pages with a managed browser.

Each configured target (``POST /integrations/web_reviews/apps``: a name, an https
URL, ``max_pages``, ``max_reviews``, ``frequency_minutes``) is read in ONE AgentCore
browser session per run (``agentcore_browser``), page by page (``target_reader``), and
its reviews are taken from the page's JSON-LD or, failing that, from its text by the
``enrichment`` model (``extract``). A page unchanged since the last read is skipped
(``page_cache``), and a read cut short by time or the run's review cap continues in
the next run from a cursor (``resume``). One browser session serves every target of a run;
when its connection closes mid-run, ONE new session continues with the target that was being
read and those after it (``MAX_RECONNECTS``). Every target is its own source, stored on it
as ``source_id`` (``web_trustpilot_example_air``), so source profiles apply per connector. A blocked site
is reported in the run's errors (``<target>: blocked by <vendor>``), never read as
"no reviews". A target whose ``method`` is ``bedrock_web_search`` is not read in the browser:
its page is read once per run from the Amazon Bedrock web search cache by an OpenAI GPT
model (``web_search_reader``: the ``web_reviews_search`` surface's, Administration -> AI models, with its
capacity fallback), and every review it yields carries its attribution.

A target whose ``method`` is ``auto`` (the default) is read by a cascade (``cascade.Cascade``): the signed browser;
when it is blocked (a bot wall, an HTTP 4xx/5xx page, a redirect to an error page), its page did not load, or it
reads no review on a page that has some (``_expects_reviews``), Amazon Bedrock web search; when that also gets
nothing, AgentCore Web Search's snippets (``snippet_reader``: excerpts, ``excerpt: true``). The order comes from
what the workspace learned of the site (shared/web_review_methods.py ``plan_for``: a fresh best method first, the
browser re-checked every 14 days, a recent block left out), and what each step got is learned back after the read.
A run therefore has three phases: the steps an ``auto`` plan puts before the browser, then ONE browser session for
every target that needs the browser, then the steps after it. A later step is skipped, and reported, when the
Lambda has too little time left for it. Every item carries ``method_used``, and the run row's ``reads`` say, per
target, the step that read it and every step tried with its outcome (``cascade.read_row``). See docs/web-reviews.md.
"""

import os
import time
from collections import deque
from collections.abc import Callable, Generator
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any, Final

import boto3
from agentcore_browser import BrowserUnavailableError, browser_session, session_seconds
from botocore.exceptions import BotoCoreError, ClientError
from cascade import BLOCKED, MAX_RUN_READS, NOT_OFFERED, SKIPPED_TIME, Cascade, StepReport, read_row
from cdp_client import BrowserConnectionClosed, CdpError
from extract import LLM_MAX_TOKENS, LLM_SURFACE, Completion, ExtractedReview, extract_reviews
from page_cache import PageCache
from page_reader import BrowserTab, PageLoadError, PageSnapshot
from resume import ResumeCursor, ResumeStore, next_cursor
from snippet_reader import (
    MAX_SNIPPET_REVIEWS,
    SEARCH_REGIONS,
    SnippetReview,
    SnippetSearchError,
    invoke_web_search,
    on_page,
    query_for,
    snippet_reviews,
)
from target_reader import ReadLimits, ReadReview, TargetResult, read_target
from web_items import (
    METADATA_VALUE_MAX_CHARS,
    WebTarget,
    is_model_relayed,
    queue_item,
    stored_configs,
    target_from_config,
    url_list,
)
from web_search_reader import MAX_WEB_SEARCH_REVIEWS, WebSearchError, WebSearchRead, read_with_fallback

from _shared.app_reviews_utils import is_due_for_run
from _shared.base_ingestor import BaseIngestor, logger, metrics, run_in_workspace, tracer
from shared.converse import converse
from shared.invocation_cost import measure_invocation_cost
from shared.model_config import WEB_SEARCH_SURFACE, fallback_chain, get_active_model_id
from shared.timestamps import now_iso
from shared.web_review_methods import (
    NO_REVIEWS,
    READABLE,
    STEP_AGENTCORE_WEB_SEARCH,
    STEP_BEDROCK_WEB_SEARCH,
    STEP_BROWSER,
    STEP_ERROR,
    MethodRecord,
    learned,
    plan_for,
    read_record,
    site_domain,
    write_record,
)
from shared.web_review_targets import (
    MAX_REVIEWS,
    METHOD_AUTO,
    METHOD_BEDROCK_WEB_SEARCH,
    METHOD_BROWSER,
    TargetError,
)
from shared.ws_repo import OutOfScopeError, WorkspaceScope

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
#: New browser sessions a run may start after its connection closed (the target being read is read again).
MAX_RECONNECTS: Final = 1


#: The attribution of a browser read's reviews.
BROWSER_ATTRIBUTION: Final[dict[str, object]] = {'method_used': STEP_BROWSER}
#: What an auto target's browser step says of a redirect off its site, and of a redirect to an error page.
REDIRECTED: Final = 'redirected off-host'
ERROR_PAGE: Final = 'an error page'


@dataclass
class ReadNotes:
    """What one browser read saw beside its reviews: a page skipped as unchanged since it was last read."""

    unchanged: bool = False


def _model_completion(prompt: str, system_prompt: str) -> str:
    return converse(
        prompt=prompt, system_prompt=system_prompt, max_tokens=LLM_MAX_TOKENS, temperature=None,
        surface=LLM_SURFACE, step_name='web_reviews', max_continuations=0,
    )


def _region() -> str:
    return os.environ.get('AWS_REGION') or os.environ.get('AWS_DEFAULT_REGION') or 'us-east-1'


class WebReviewsIngestor(BaseIngestor):
    """Ingestor for reviews read from public web pages."""

    def __init__(self, scope: WorkspaceScope | None, execution_id: str | None = None, *, deadline: float | None = None,
                 complete: Completion = _model_completion):
        super().__init__(scope, execution_id=execution_id)
        self.run_errors: list[str] = []
        #: The run row's ``reads``: one entry per target read (cascade.read_row).
        self.reads: list[dict[str, object]] = []
        self.only_target: str | None = None  # pragma: no mutate  annotation unevaluated in a function; read only by truthiness
        self._deadline = deadline if deadline is not None else time.monotonic() + DEFAULT_TIMEOUT_SECONDS
        self._complete = complete
        self._sent = 0
        #: The ids of the model-relayed reviews this run queued: the same review relayed again (its text a little
        #: different, the same stable fields: web_items.relayed_review_key) is queued once.
        self._relayed_ids: set[str] = set()
        self._resume = ResumeStore(self.get_watermark, self.set_watermark)
        #: The ``auto`` targets' cascades, by watermark prefix (one per target), and the learned records by domain.
        self._cascades: dict[str, Cascade] = {}
        self._records: dict[str, MethodRecord | None] = {}

    # ── bookkeeping ──────────────────────────────────────────────────────────

    def _remaining(self) -> float:
        return self._deadline - time.monotonic() - RESERVE_SECONDS

    def _has_time(self) -> bool:
        return self._remaining() >= PAGE_BUDGET_SECONDS

    def _report(self, message: str) -> None:
        if len(self.run_errors) < MAX_RUN_ERRORS:
            self.run_errors.append(message[:MAX_ERROR_CHARS])

    def _update_source_run_status(self, updates: dict):
        """A completed run carries its per-target errors (blocked sites) and reads (how each was read), so they reach
        the UI."""
        if updates.get('status') == 'completed':
            updates = {**updates, **({'errors': list(self.run_errors)} if self.run_errors else {}),
                       **({'reads': list(self.reads)} if self.reads else {})}
        super()._update_source_run_status(updates)

    def _note_read(self, target: WebTarget, steps: list[StepReport], sent: int, cascade: Cascade | None = None) -> None:
        if len(self.reads) < MAX_RUN_READS:
            self.reads.append(read_row(target, steps, sent, cascade))

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

    def _is_new_enough(self, target: WebTarget) -> Callable[[ExtractedReview], bool]:
        """A review of a one-page read (web search, snippets) the watermark lets through (an undated one always)."""
        watermark = self._watermark(target)
        cutoff = watermark - WATERMARK_SLACK if watermark else None
        return lambda review: cutoff is None or review.date is None or date.fromisoformat(review.date) >= cutoff

    # ── learning which method reads a site (shared/web_review_methods.py) ────

    def _record(self, domain: str) -> MethodRecord | None:
        """The workspace's record of *domain*, read once per run (None: none, or no table)."""
        if domain not in self._records:
            record = None
            if self.aggregates_table is not None:
                try:
                    record = read_record(self.aggregates_table, self.scope, domain)
                except (BotoCoreError, ClientError, OutOfScopeError) as error:
                    logger.warning(f'web_reviews {domain}: the learned methods could not be read ({type(error).__name__})')
            self._records[domain] = record
        return self._records[domain]

    def _cascade(self, target: WebTarget) -> Cascade:
        domain = site_domain(target.url)
        record = self._record(domain)
        plan = plan_for(record, datetime.now(UTC))
        logger.info(f'web_reviews {domain}: {plan.kind} plan {" -> ".join(plan.order)} (known: {plan.known_method}, '
                    f'learned {plan.learned_at}; left out as recently blocked: {", ".join(plan.skipped) or "none"})')
        return Cascade(target=target, domain=domain, plan=plan, record=record)

    def _learn(self, cascade: Cascade) -> None:
        """Store what the cascade's steps got on its site (a time-skipped step changes nothing)."""
        now = now_iso()
        record = learned(self._records.get(cascade.domain), cascade.domain, cascade.attempts(), now)
        if record is None or record is self._records.get(cascade.domain):
            return
        self._records[cascade.domain] = record
        logger.info(f'web_reviews {cascade.domain}: learned best method {record.best_method} '
                    f'({", ".join(f"{a.step} {a.outcome}" for a in cascade.attempts())})')
        if self.aggregates_table is None:
            return
        try:
            write_record(self.aggregates_table, self.scope, record, now)
        except (BotoCoreError, ClientError, OutOfScopeError, TypeError) as error:
            logger.warning(f'web_reviews {cascade.domain}: the learned methods could not be saved '
                           f'({type(error).__name__})')

    def _finish(self, cascade: Cascade) -> None:
        """The cascade's end: learned back, reported when nothing read the page, and noted on the run row."""
        self._learn(cascade)
        if cascade.used is None and not cascade.stopped:
            self._report(cascade.failure())
        self._note_read(cascade.target, cascade.steps, sum(step.reviews for step in cascade.steps), cascade)

    # ── reading ──────────────────────────────────────────────────────────────

    def _extract(self, snapshot: PageSnapshot) -> list[ExtractedReview]:
        return extract_reviews(snapshot.jsonld, snapshot.text, self._complete)

    def _extractor(self, cache: PageCache, backfill: bool,
                   notes: ReadNotes) -> Callable[[PageSnapshot], list[ExtractedReview]]:
        """The page extraction of one read: an incremental read skips a page unchanged since it was last read."""
        def extract(snapshot: PageSnapshot) -> list[ExtractedReview]:
            if not backfill and cache.unchanged(snapshot):
                notes.unchanged = True
                return []  # nothing new on it, and no model call
            return self._extract(snapshot)
        return extract

    def _review_caps(self, target: WebTarget, cursor: ResumeCursor | None) -> tuple[int, int | None]:
        """``(reviews this read may take, what the target's own limit leaves (None: no limit))``."""
        limit = target.review_limit
        target_left = None if limit is None else limit - (cursor.reviews if cursor else 0)
        run_left = MAX_REVIEWS_PER_RUN - self._sent
        return (run_left if target_left is None else min(target_left, run_left)), target_left

    def _read(self, tab: BrowserTab, target: WebTarget, cursor: ResumeCursor | None,
              notes: ReadNotes) -> tuple[TargetResult, int | None]:
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
        return read_target(tab, url, self._extractor(cache, cursor is not None, notes), limits), target_left

    def _items_of(self, target: WebTarget, result: TargetResult, resume_at: ResumeCursor | None,
                  attribution: dict[str, object] | None = None) -> Generator[dict, None, None]:
        for read in result.reviews:
            item = queue_item(target, read.review, page=read.page, page_url=read.page_url, brand_name=self.brand_name,
                              attribution={**(attribution or {}), **(read.attribution or {})})
            if is_model_relayed(item):
                if item['id'] in self._relayed_ids:
                    continue  # a near-duplicate of a review this run already queued
                self._relayed_ids.add(item['id'])
            yield item
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

    def _browse(self, tab: BrowserTab, target: WebTarget,
                notes: ReadNotes) -> tuple[TargetResult, ResumeCursor | None, ResumeCursor | None] | StepReport:
        """The target's read in the browser (its result, the cursor it started from, where a later run resumes it), or
        the step's failure when the page could not be read (the cursor cleared)."""
        cursor = self._resume.load(target)
        try:
            result, target_left = self._read(tab, target, cursor, notes)
        except BrowserConnectionClosed:
            raise  # not this target's failure: the run reads it again in a new session
        except (PageLoadError, CdpError) as error:
            self._resume.save(target, None)
            return StepReport(STEP_BROWSER, STEP_ERROR, detail=str(error))
        except Exception as error:  # one target's failure must not lose the others
            logger.exception(f'web_reviews target {target.host} failed')
            self._resume.save(target, None)
            return StepReport(STEP_BROWSER, STEP_ERROR, detail=f'failed ({type(error).__name__})')
        return result, cursor, next_cursor(cursor, result, target_limit_left=target_left)

    def _read_target(self, tab: BrowserTab, target: WebTarget) -> Generator[dict, None, None]:
        """A ``browser`` target's read: its reviews, or the reason there are none in the run's errors."""
        before = self._sent
        if not self._has_time():
            self._report(f'{target.name}: skipped, the run ran out of time')
            self._note_read(target, [StepReport(STEP_BROWSER, SKIPPED_TIME)], 0)
            return
        read = self._browse(tab, target, ReadNotes())
        if isinstance(read, StepReport):
            self._report(f'{target.name}: {read.detail}')
            self._note_read(target, [read], 0)
            return
        result, _cursor, resume_at = read
        if result.off_host:
            self._report(f'{target.name}: redirected off-host')
        if result.blocked:
            self._report(f'{target.name}: blocked by {result.blocked}')
            metrics.add_metric(name='WebReviewsBlocked', unit='Count', value=1)
        yield from self._items_of(target, result, resume_at, attribution=BROWSER_ATTRIBUTION)
        self._note_read(target, [self._browser_step_of(result, self._sent - before)], self._sent - before)

    @staticmethod
    def _browser_step_of(result: TargetResult, sent: int) -> StepReport:
        """How a ``browser`` target's read ended, for the run row."""
        if result.off_host and not result.extracted:
            return StepReport(STEP_BROWSER, STEP_ERROR, detail='redirected off-host')
        if result.blocked and not result.extracted:
            return StepReport(STEP_BROWSER, BLOCKED, vendor=result.blocked)
        return StepReport(STEP_BROWSER, READABLE, reviews=sent)

    def _expects_reviews(self, cascade: Cascade, result: TargetResult) -> bool:
        """Whether the page has reviews the browser did not read: its JSON-LD declares some, the target read some
        before, a step read the site before, or the target was never read (a page added as a review page)."""
        target = cascade.target
        return (result.declares_reviews or self._watermark(target) is not None
                or self.get_watermark(f'{target.watermark_prefix}_last_run') is None
                or (cascade.record is not None and any(stats.successes for stats in cascade.record.steps.values())))

    def _browser_failure(self, cascade: Cascade, result: TargetResult, cursor: ResumeCursor | None,
                         notes: ReadNotes) -> StepReport | None:
        """Why an ``auto`` target's browser read got nothing (None when it read the page): a redirect to another
        site's page (the cascade ends), a block (a bot wall, an HTTP error page, a redirect to an error page), or no
        review on a page that has some."""
        if result.extracted:
            return None
        if result.off_host and not result.error_page:
            return StepReport(STEP_BROWSER, STEP_ERROR, detail=REDIRECTED)
        if result.off_host or result.blocked:
            return StepReport(STEP_BROWSER, BLOCKED, vendor=result.blocked or ERROR_PAGE)
        if not notes.unchanged and cursor is None and self._expects_reviews(cascade, result):
            return StepReport(STEP_BROWSER, NO_REVIEWS)
        return None

    def _browser_step(self, tab: BrowserTab, cascade: Cascade) -> Generator[dict, None, None]:
        """An ``auto`` target's browser step: its reviews, or the failure that hands the page to the next step."""
        target, before = cascade.target, self._sent
        if not self._has_time():
            cascade.add(StepReport(STEP_BROWSER, SKIPPED_TIME))
            return
        notes = ReadNotes()
        read = self._browse(tab, target, notes)
        if isinstance(read, StepReport):
            cascade.add(read)
            return
        result, cursor, resume_at = read
        failure = self._browser_failure(cascade, result, cursor, notes)
        if failure is None or failure.outcome == NO_REVIEWS:
            cascade.title = result.title  # the page itself (not a wall): the AgentCore Web Search query's subject
        if failure is not None:
            if failure.outcome == BLOCKED:
                metrics.add_metric(name='WebReviewsBlocked', unit='Count', value=1)
            if failure.detail == REDIRECTED:
                self._report(f'{target.name}: redirected off-host')
                cascade.stopped = True  # another site's page: nothing of it is the target's, and no later step reads it
            yield from self._items_of(target, result, None, attribution=BROWSER_ATTRIBUTION)
            cascade.add(failure)
            return
        if result.off_host:
            self._report(f'{target.name}: redirected off-host')  # a later page; what was read is kept
        elif result.blocked:
            self._report(f'{target.name}: blocked by {result.blocked}')
        yield from self._items_of(target, result, resume_at, attribution=BROWSER_ATTRIBUTION)
        cascade.add(StepReport(STEP_BROWSER, READABLE, reviews=self._sent - before))

    # ── bedrock_web_search ───────────────────────────────────────────────────

    def _web_search(self, target: WebTarget, max_reviews: int) -> WebSearchRead:
        """*target* read by the web search surface's model (Administration -> AI models; its own pick, else
        Luna), stepping down the surface's chain when a model cannot serve (shared/model_config.py)."""
        chain = fallback_chain(get_active_model_id(WEB_SEARCH_SURFACE), WEB_SEARCH_SURFACE)
        return read_with_fallback(target.url, chain, max_reviews, region=_region(),
                                  credentials=boto3.Session().get_credentials())

    def _out_of_reviews_or_time(self, target: WebTarget, step: str, report: bool) -> StepReport | None:
        """Why *step* cannot start now (the run's review cap, too little time left), reported when *report*."""
        if self._sent >= MAX_REVIEWS_PER_RUN:
            if report:
                self._report(f'{target.name}: skipped, the run reached {MAX_REVIEWS_PER_RUN} reviews')
            return StepReport(step, SKIPPED_TIME, detail=f'the run reached {MAX_REVIEWS_PER_RUN} reviews')
        if not self._has_time():
            if report:
                self._report(f'{target.name}: skipped, the run ran out of time')
            return StepReport(step, SKIPPED_TIME)
        return None

    def _bedrock_step(self, target: WebTarget, *, report: bool) -> Generator[dict, None, StepReport]:
        """*target*'s page, read once from the Bedrock web search cache: its new reviews, with their attribution, and
        the step's outcome (its failures reported on the target when *report*: a ``bedrock_web_search`` target)."""
        skipped = self._out_of_reviews_or_time(target, STEP_BEDROCK_WEB_SEARCH, report)
        if skipped is not None:
            return skipped
        cap = min(self._review_caps(target, None)[0], MAX_WEB_SEARCH_REVIEWS)
        fetched_at = now_iso()
        try:
            read = self._web_search(target, cap)
        except WebSearchError as error:
            if report:
                self._report(f'{target.name}: Amazon Bedrock web search failed ({error})')
            return StepReport(STEP_BEDROCK_WEB_SEARCH, STEP_ERROR, detail=f'failed ({error})')
        if not read.fetched and report:
            self._report(f'{target.name}: Amazon Bedrock web search could not open the page ({read.reason or "no reason"})')
        new = [review for review in read.reviews if self._is_new_enough(target)(review)]
        logger.info(f'web_reviews {target.host}: {len(new)} new of {len(read.reviews)} reviews from the Bedrock web '
                    f'search cache ({read.model}; {read.dropped} dropped as summaries or invalid)')
        result = TargetResult(reviews=[ReadReview(review, 1, target.url) for review in new], pages_read=1, stop='pages')
        before = self._sent
        yield from self._items_of(target, result, None, attribution=self._citation(target, read, fetched_at))
        if not read.fetched:
            return StepReport(STEP_BEDROCK_WEB_SEARCH, STEP_ERROR,
                              detail=f'could not open the page ({read.reason or "no reason"})')
        if not read.reviews:
            return StepReport(STEP_BEDROCK_WEB_SEARCH, NO_REVIEWS)
        return StepReport(STEP_BEDROCK_WEB_SEARCH, READABLE, reviews=self._sent - before)

    def _read_by_web_search(self, target: WebTarget) -> Generator[dict, None, None]:
        """A ``bedrock_web_search`` target: its page, read once from the Bedrock web search cache."""
        before = self._sent
        step = yield from self._bedrock_step(target, report=True)
        self._note_read(target, [step], self._sent - before)

    @staticmethod
    def _citation(target: WebTarget, read: WebSearchRead, fetched_at: str) -> dict[str, object]:
        """What every review of a web-search read carries (the Web Search terms: keep the citations and links)."""
        attribution: dict[str, object] = {
            'method': METHOD_BEDROCK_WEB_SEARCH, 'method_used': STEP_BEDROCK_WEB_SEARCH, 'model': read.model,
            'site': target.host, 'fetched_at': fetched_at, 'opened_urls': url_list(read.opened_urls),
            'cited_urls': url_list(read.cited_urls)}
        if len(target.url) <= METADATA_VALUE_MAX_CHARS:
            attribution['source_url'] = target.url
        return attribution

    # ── agentcore_web_search (snippet_reader.py) ─────────────────────────────

    def _snippet_step(self, cascade: Cascade) -> Generator[dict, None, StepReport]:
        """An ``auto`` target's last step: the reviews in AgentCore Web Search's snippets of its page, as excerpts."""
        target = cascade.target
        region = _region()
        if region not in SEARCH_REGIONS:
            return StepReport(STEP_AGENTCORE_WEB_SEARCH, NOT_OFFERED)
        skipped = self._out_of_reviews_or_time(target, STEP_AGENTCORE_WEB_SEARCH, report=False)
        if skipped is not None:
            return skipped
        query = query_for(cascade.title or target.name)
        fetched_at = now_iso()
        try:
            results = invoke_web_search(query, cascade.domain, region=region,
                                        credentials=boto3.Session().get_credentials())
            page_results = on_page(results, target.url)
            found, dropped = snippet_reviews(page_results, self._complete,
                                             min(self._review_caps(target, None)[0], MAX_SNIPPET_REVIEWS))
        except SnippetSearchError as error:
            return StepReport(STEP_AGENTCORE_WEB_SEARCH, STEP_ERROR, detail=f'failed ({error})')
        except Exception as error:  # the extraction model's failure must not lose the run
            logger.exception(f'web_reviews {target.host}: the snippets could not be read')
            return StepReport(STEP_AGENTCORE_WEB_SEARCH, STEP_ERROR, detail=f'failed ({type(error).__name__})')
        logger.info(f'web_reviews {target.host}: AgentCore web search "{query}": {len(results)} results, '
                    f'{len(page_results)} on the page, {len(found)} reviews in their snippets ({dropped} dropped)')
        if not found:
            return StepReport(STEP_AGENTCORE_WEB_SEARCH, NO_REVIEWS,
                              detail=None if page_results else 'no result on the page itself')
        is_new = self._is_new_enough(target)
        result = TargetResult(reviews=[ReadReview(item.review, 1, item.source.url, self._excerpt(target, item, query,
                                                                                                fetched_at))
                                       for item in found if is_new(item.review)], pages_read=1, stop='pages')
        before = self._sent
        yield from self._items_of(target, result, None, attribution={'method_used': STEP_AGENTCORE_WEB_SEARCH})
        return StepReport(STEP_AGENTCORE_WEB_SEARCH, READABLE, reviews=self._sent - before)

    @staticmethod
    def _excerpt(target: WebTarget, item: SnippetReview, query: str, fetched_at: str) -> dict[str, object]:
        """What a snippet's review carries: it is an excerpt, the snippet and its result (url, title, publication
        time), the query and when it was read (AgentCore Web Search's terms: keep the citations and links)."""
        source = item.source
        attribution: dict[str, object] = {
            'excerpt': True, 'snippet_cut': item.cut, 'snippet': ' '.join(source.text.split())[:METADATA_VALUE_MAX_CHARS],
            'site': target.host, 'query': query, 'fetched_at': fetched_at,
        }
        if len(source.url) <= METADATA_VALUE_MAX_CHARS:
            attribution['snippet_url'] = source.url
        if source.title:
            attribution['snippet_title'] = source.title[:METADATA_VALUE_MAX_CHARS]
        if source.published_at:
            attribution['snippet_published_date'] = source.published_at[:METADATA_VALUE_MAX_CHARS]
        if len(target.url) <= METADATA_VALUE_MAX_CHARS:
            attribution['source_url'] = target.url
        return attribution

    # ── auto: the steps around the browser ───────────────────────────────────

    def _run_steps(self, cascade: Cascade) -> Generator[dict, None, None]:
        """*cascade*'s next steps until it needs the browser or is over (each step's outcome added to it)."""
        while (step := cascade.next_step()) is not None and step != STEP_BROWSER:
            if step == STEP_BEDROCK_WEB_SEARCH:
                cascade.add((yield from self._bedrock_step(cascade.target, report=False)))
            else:
                cascade.add((yield from self._snippet_step(cascade)))

    # ── the browser ──────────────────────────────────────────────────────────

    def _read_in_one_session(self, pending: deque[WebTarget]) -> Generator[dict, None, None]:
        """Read *pending* in one browser session, each target leaving it once read; a closed connection leaves
        the target being read (and those after it) pending."""
        with browser_session(session_seconds(self._remaining() + RESERVE_SECONDS)) as cdp:
            tab = BrowserTab(cdp)
            tab.open()
            while pending:
                target = pending[0]
                cascade = self._cascades.get(target.watermark_prefix)
                if self._sent >= MAX_REVIEWS_PER_RUN:
                    self._report(f'{target.name}: skipped, the run reached {MAX_REVIEWS_PER_RUN} reviews')
                    if cascade is not None:
                        cascade.add(StepReport(STEP_BROWSER, SKIPPED_TIME,
                                               detail=f'the run reached {MAX_REVIEWS_PER_RUN} reviews'))
                    pending.popleft()
                    continue
                if cascade is None:
                    yield from self._read_target(tab, target)
                else:
                    yield from self._browser_step(tab, cascade)
                pending.popleft()

    @tracer.capture_method
    def fetch_new_items(self) -> Generator[dict, None, None]:
        targets = self._targets()
        if not targets:
            logger.info('web_reviews: no target is due')
            return
        self._cascades = {target.watermark_prefix: self._cascade(target)
                          for target in targets if target.method == METHOD_AUTO}
        cascades = [self._cascades[target.watermark_prefix] for target in targets if target.method == METHOD_AUTO]
        # 1. The steps an auto plan puts before the browser (a site the workspace knows web search reads).
        for cascade in cascades:
            yield from self._run_steps(cascade)
        # 2. ONE browser session (none, so none billed, when no target needs it) for the browser targets and the auto
        #    ones whose next step is the browser.
        browsed = [target for target in targets if target.method == METHOD_BROWSER or (
            target.method == METHOD_AUTO and self._cascades[target.watermark_prefix].next_step() == STEP_BROWSER)]
        if browsed:
            yield from self._read_in_the_browser(browsed)
        for target in targets:
            if target.method == METHOD_BEDROCK_WEB_SEARCH:
                yield from self._read_by_web_search(target)
        # 3. The auto steps after the browser, then what each cascade learned.
        for cascade in cascades:
            yield from self._run_steps(cascade)
            self._finish(cascade)

    def _read_in_the_browser(self, targets: list[WebTarget]) -> Generator[dict, None, None]:
        """The browser targets in one session, and ONE more when its connection closes mid-run."""
        pending = deque(targets)
        reconnects = 0
        while True:
            try:
                yield from self._read_in_one_session(pending)
            except BrowserConnectionClosed as error:
                if reconnects >= MAX_RECONNECTS or not self._has_time():
                    self._browser_failed(pending, f'The browser session failed: {error}')
                    return
                reconnects += 1
                logger.warning(f'web_reviews: {error}; a new browser session reads the {len(pending)} targets left')
            except BrowserUnavailableError as error:
                self._browser_failed(pending, str(error))
                return
            except (PageLoadError, CdpError) as error:
                self._browser_failed(pending, f'The browser session failed: {error}')
                return
            else:
                return

    def _browser_failed(self, pending: deque[WebTarget], message: str) -> None:
        """The session could not go on: reported when a ``browser`` target is left; an auto target left goes on to
        its next step."""
        left = list(pending)
        for target in left:
            if (cascade := self._cascades.get(target.watermark_prefix)) is not None:
                cascade.add(StepReport(STEP_BROWSER, STEP_ERROR, detail=message))
        if any(target.watermark_prefix not in self._cascades for target in left) or not left:
            self._report(message)
        else:
            logger.warning(f'web_reviews: {message}; the {len(left)} auto targets left go on to their next step')


    @classmethod
    def run_for_event(cls, event: object, context: Any = None) -> dict:
        """Lambda body (``run_in_workspace``): one run, in the workspace the event names or deployment-wide,
        optionally limited to one target (``event['app_id']``: its id or URL); the tick also fans out."""
        execution_id = event.get('execution_id') if isinstance(event, dict) else None
        remaining_ms = context.get_remaining_time_in_millis() if context is not None else None
        deadline = time.monotonic() + remaining_ms / 1000 if remaining_ms is not None else None

        def run(scope: WorkspaceScope | None) -> dict:
            ingestor = cls(scope, execution_id=execution_id, deadline=deadline)
            if isinstance(event, dict) and isinstance(event.get('app_id'), str):
                ingestor.only_target = event['app_id']
            return ingestor.run()

        return run_in_workspace(event, run)

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
