"""One brand's release scan: three web-search steps, in the owner's order (docs/radar.md).

1. "<brand> new features" / "<brand> release", published since the last scan
   (90 days on the first one), no domain filter: the main search.
2. Only when step 1 found no dated release and the brand has domains: the
   same window restricted to the brand's own domains (site, blog, release notes).
3. Broader, last: press coverage and "<brand> vs <our brand>".

Every query is counted against the brand's share of the scan's query cap and a
step stops as soon as it is spent. Results are web search results only: the
competitor's sites are never crawled (one article page may be fetched for a
missing date, see ``extract``).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Final

from jobs.radar_scan.extract import Budget, ExtractContext, extract_candidates
from shared.embeddings import embed_text
from shared.logging import logger
from shared.radar_brands import RadarBrand
from shared.radar_releases import ReleaseCandidate, store_candidate
from shared.web_search import WebSearchError, search_web

RESULTS_PER_QUERY: Final = 8


@dataclass
class BrandScanStats:
    queries: int = 0
    added: int = 0
    merged: int = 0
    steps: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Step:
    name: str
    queries: tuple[str, ...]
    include_domains: tuple[str, ...] = ()


def steps_for(brand: RadarBrand, our_brand: str) -> tuple[Step, Step, Step]:
    """The three steps' queries for ``brand``."""
    label = brand.label
    broader = (f'{label} announcement press', f'{label} vs {our_brand}' if our_brand else f'{label} review')
    return (
        Step('features', (f'"{label}" new features', f'"{label}" release')),
        Step('own_domains', (f'{label} release notes', f'{label} new features'), brand.domains),
        Step('broader', broader),
    )


def _run_step(step: Step, budget: Budget, since: str, search: Callable[..., list[dict]]) -> list[dict[str, Any]]:
    """The step's results (de-duplicated by URL) for the queries the budget allows."""
    seen: set[str] = set()
    results: list[dict[str, Any]] = []
    for query in step.queries:
        if not budget.take():
            break
        try:
            found = search(query, RESULTS_PER_QUERY, include_domains=list(step.include_domains) or None,
                           published_after=since)
        except WebSearchError:
            logger.warning(f'Radar: web search failed in step {step.name}; continuing')
            continue
        for result in found:
            url = result.get('url') or ''
            if url and url not in seen:
                seen.add(url)
                results.append(result)
    return results


def _file(candidates: list[ReleaseCandidate], ctx: ExtractContext, table: Any, now_iso: str,
          stats: BrandScanStats) -> None:
    for candidate in candidates:
        vector = embed_text(f'{candidate.brand_label}: {candidate.feature}')
        outcome = store_candidate(table, candidate, vector, ctx.today, now_iso)
        if outcome == 'added':
            stats.added += 1
        else:
            stats.merged += 1


def scan_brand(brand: RadarBrand, *, our_brand: str, since: str, budget: Budget, ctx: ExtractContext,
               table: Any, now_iso: str, search: Callable[..., list[dict]] | None = None) -> BrandScanStats:
    """Run the brand's steps within ``budget`` and file what they find; the scan's stats."""
    search = search or search_web
    stats = BrandScanStats()
    features, own_domains, broader = steps_for(brand, our_brand)
    found = extract_candidates(_run_step(features, budget, since, search), ctx)
    stats.steps.append(features.name)
    _file(found, ctx, table, now_iso, stats)
    if brand.domains and not any(candidate.release_date for candidate in found) and budget.remaining:
        stats.steps.append(own_domains.name)
        _file(extract_candidates(_run_step(own_domains, budget, since, search), ctx), ctx, table, now_iso, stats)
    if budget.remaining:
        stats.steps.append(broader.name)
        _file(extract_candidates(_run_step(broader, budget, since, search), ctx), ctx, table, now_iso, stats)
    stats.queries = budget.used
    return stats
