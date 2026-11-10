"""One brand's news scan: feeds, web search, the own-domain step, Exa, then more web search (docs/radar.md).

In order, each step stopping as soon as the brand's share of the query cap (``budget``) is spent;
every paid action (a web search, an Exa search, a feed fetch) costs one:

1. ``feeds``: the brand's RSS / Atom feeds (``shared.radar_feeds``), items dated in the whole
   lookback (``windows.LOOKBACK_DAYS``; feeds are free to read again).
2. ``news``: the first third of the brand's share (at least one query) of its ROTATED query plan
   (``queries``: six kinds of news query in its language and in English), each published since
   THAT query last ran (``windows``: the lookback when it never ran), no domain filter.
3. ``own_domains``: only when step 2 found no dated item and the brand has domains: one news
   query restricted to its own domains, WITHOUT a published-date filter (undated pages are dated
   by the extractor's result / URL / page date).
4. ``exa``: only when an Exa key is configured and steps 2-3 found no dated item: one Exa search
   on the brand's domains (when it has some) and one news search in its language, published
   since the Exa step last ran.
5. ``more_news``: the rest of the share continues the rotated plan.

Whatever the step, an item dated before the lookback is not filed (``too_old``); an item found
again is merged into its record (``shared.radar_releases``). A search that ran without an error
is listed in ``stats.ran_steps``, so the handler moves its window to today (``windows.next_state``).

Every step's results go through the brand's ``exclude_terms`` first (``stats.excluded``): a result
whose title or snippet contains one never reaches the model. The general news queries carry the
brand's ``search_terms`` (``queries.with_terms``; Exa: ``plain_terms`` and ``excludeText``).

Steps 2, 3 and 5 need the AgentCore web-search gateway (``search``); without it they are skipped
and cost nothing. The plan's cursor advances by the plan queries that ran, so successive scans
cover every kind of query. One model call per step that has results.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Final

from jobs.radar_scan.extract import Budget, ExtractContext, extract_candidates
from jobs.radar_scan.queries import (
    PlannedQuery,
    own_domain_query,
    plain_terms,
    query_plan,
    query_text,
    rotated,
    with_terms,
)
from jobs.radar_scan.windows import EXA_STEP, OWN_DOMAINS_STEP, BrandWindow
from shared.embeddings import embed_text
from shared.exa_search import ExaSearchError, exa_search
from shared.logging import logger
from shared.radar_brand_terms import is_excluded
from shared.radar_brands import RadarBrand
from shared.radar_feeds import feed_results
from shared.radar_releases import ReleaseCandidate, store_candidate
from shared.web_search import WebSearchError

RESULTS_PER_QUERY: Final = 8
#: Exa's ``excludeText`` takes one phrase of at most this many words.
EXA_EXCLUDE_MAX_WORDS: Final = 5
#: Step 2 takes this fraction of the brand's share (at least one query); the rest waits for steps 3-5.
FIRST_STEP_DIVISOR: Final = 3


@dataclass
class BrandScanStats:
    queries: int = 0
    added: int = 0
    merged: int = 0
    too_old: int = 0
    #: Results dropped before the model call because they contain one of the brand's exclude terms.
    excluded: int = 0
    steps: list[str] = field(default_factory=list)
    query_types: list[str] = field(default_factory=list)
    cursor: int = 0
    #: The searches that ran without an error (``<language>:<type>``, ``own_domains``, ``exa``).
    ran_steps: list[str] = field(default_factory=list)
    by_source: Counter[str] = field(default_factory=Counter)
    by_kind: Counter[str] = field(default_factory=Counter)


@dataclass(frozen=True)
class ScanSources:
    """Where a brand's news comes from: web search (None = no gateway), Exa (None = no key) and feeds.

    ``exa`` / ``feeds`` default to the real clients, looked up when a step runs.
    """

    search: Callable[..., list[dict]] | None
    exa_key: str | None = None
    exa: Callable[..., list[dict]] | None = None
    feeds: Callable[..., list[dict]] | None = None


@dataclass
class _Run:
    """One brand's scan in progress."""

    brand: RadarBrand
    window: BrandWindow
    budget: Budget
    ctx: ExtractContext
    sources: ScanSources
    table: Any
    now_iso: str
    stats: BrandScanStats = field(default_factory=BrandScanStats)
    dated: bool = False


def _unique(results: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for result in results:
        url = result.get('url') or ''
        if url and url not in seen:
            seen.add(url)
            out.append(result)
    return out


def _file(run: _Run, step: str, via: str, results: list[dict[str, Any]]) -> None:
    """Extract the step's news and store it (an item dated before the lookback is not filed)."""
    run.stats.steps.append(step)
    run.stats.by_source[f'{via}_results'] += len(results)
    if run.brand.exclude_terms:
        kept = [result for result in results if not is_excluded(result, run.brand.exclude_terms)]
        run.stats.excluded += len(results) - len(kept)
        results = kept
    candidates: list[ReleaseCandidate] = extract_candidates(_unique(results), run.ctx, via) if results else []
    for candidate in candidates:
        if candidate.release_date and candidate.release_date < run.window.lookback:
            run.stats.too_old += 1
            continue
        if candidate.release_date and via != 'feed':
            run.dated = True
        vector = embed_text(f'{candidate.brand_label}: {candidate.feature}')
        outcome = store_candidate(run.table, candidate, vector, run.ctx.today, run.now_iso)
        if outcome == 'added':
            run.stats.added += 1
        else:
            run.stats.merged += 1
        run.stats.by_source[via] += 1
        run.stats.by_kind[candidate.kind] += 1


def _web(run: _Run, query: str, **filters: Any) -> list[dict[str, Any]] | None:
    """One web search (the budget already taken); None when it fails (or there is no gateway)."""
    search = run.sources.search
    if search is None:
        return None
    try:
        return search(query, RESULTS_PER_QUERY, **filters)
    except WebSearchError:
        logger.warning('Radar: a web search failed; continuing')
        return None


def _searched(run: _Run, step: str, found: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """``found`` (``[]`` on a failure); a search that answered moves its window (``stats.ran_steps``)."""
    if found is None:
        return []
    run.stats.ran_steps.append(step)
    return found


def _plan_step(run: _Run, step: str, planned: list[PlannedQuery]) -> None:
    results: list[dict[str, Any]] = []
    ran = 0
    for query in planned:
        if not run.budget.take():
            break
        ran += 1
        key = f'{query.language}:{query.type}'
        run.stats.query_types.append(key)
        text = with_terms(query.text, run.brand.search_terms, run.brand.exclude_terms)
        results.extend(_searched(run, key, _web(run, text, include_domains=None,
                                                published_after=run.window.since(key))))
    run.stats.cursor += ran
    if ran:
        _file(run, step, 'web', results)


def _feeds_step(run: _Run) -> None:
    read = run.sources.feeds or feed_results
    results: list[dict[str, Any]] = []
    for url in run.brand.feed_urls:
        if not run.budget.take():
            break
        results.extend(read(url, date.fromisoformat(run.window.lookback), run.ctx.today, run.ctx.fetch))
    if run.brand.feed_urls:
        _file(run, 'feeds', 'feed', results)


def _own_domains_step(run: _Run) -> None:
    if not run.brand.domains or run.dated or run.sources.search is None or not run.budget.take():
        return
    # Exclusions only: a query restricted to the brand's own sites is already about the brand.
    query = with_terms(own_domain_query(run.brand.label, run.brand.effective_language), (), run.brand.exclude_terms)
    # No published_after: the own site's undated pages are dated by the extractor (result / URL / page date).
    found = _web(run, query, include_domains=list(run.brand.domains))
    _file(run, 'own_domains', 'web', _searched(run, OWN_DOMAINS_STEP, found))


def _exa_exclude(terms: tuple[str, ...]) -> str | None:
    """The first exclude term Exa's ``excludeText`` accepts (one phrase of a few words), or None."""
    return next((term for term in terms if len(term.split()) <= EXA_EXCLUDE_MAX_WORDS), None)


def _exa_call(search: Callable[..., list[dict]], key: str, query: str, since: str, domains: list[str] | None,
              exclude: str | None) -> list[dict]:
    """One Exa search; ``exclude_text`` only when the brand has an exclude phrase Exa takes."""
    if exclude:
        return search(key, query, since=since, include_domains=domains, exclude_text=exclude)
    return search(key, query, since=since, include_domains=domains)


def _exa_step(run: _Run) -> None:
    key = run.sources.exa_key
    if not key or run.dated:
        return
    label, language = run.brand.label, run.brand.effective_language
    searches = [(own_domain_query(label, language), list(run.brand.domains))] if run.brand.domains else []
    searches.append((plain_terms(query_text(label, 'company_news', language), run.brand.search_terms), []))
    search = run.sources.exa or exa_search
    exclude = _exa_exclude(run.brand.exclude_terms)
    results: list[dict[str, Any]] = []
    ran, failed = 0, False
    for query, domains in searches:
        if not run.budget.take():
            break
        ran += 1
        try:
            results.extend(_exa_call(search, key, query, run.window.since(EXA_STEP), domains or None, exclude))
        except ExaSearchError as error:
            failed = True
            logger.warning(f'Radar: an Exa search failed ({error}); continuing')
    if ran == len(searches) and not failed:
        run.stats.ran_steps.append(EXA_STEP)
    if ran:
        _file(run, 'exa', 'exa', results)


def _log(run: _Run) -> None:
    stats = run.stats
    logger.info('Radar: brand scanned', extra={
        'brand': run.brand.key, 'paid_calls': stats.queries, 'steps': stats.steps, 'query_types': stats.query_types,
        'added': stats.added, 'merged': stats.merged, 'too_old': stats.too_old, 'excluded': stats.excluded,
        'by_source': dict(stats.by_source), 'by_kind': dict(stats.by_kind),
    })


def scan_brand(brand: RadarBrand, *, window: BrandWindow, budget: Budget, ctx: ExtractContext, table: Any,
               now_iso: str, sources: ScanSources) -> BrandScanStats:
    """Run the brand's steps within ``budget`` and file what they find; the scan's stats.

    ``stats.cursor`` is the plan position the next scan starts at.
    """
    run = _Run(brand, window, budget, ctx, sources, table, now_iso)
    run.stats.cursor = window.cursor
    plan = rotated(query_plan(brand.label, brand.effective_language), window.cursor) if sources.search else []
    first = max(1, budget.remaining // FIRST_STEP_DIVISOR)
    _feeds_step(run)
    if plan and budget.remaining:
        _plan_step(run, 'news', plan[:first])
    _own_domains_step(run)
    _exa_step(run)
    if plan[first:] and budget.remaining:
        _plan_step(run, 'more_news', plan[first:])
    run.stats.queries = budget.used
    _log(run)
    return run.stats
