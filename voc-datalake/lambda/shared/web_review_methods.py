"""Which method reads a review site, learned per workspace (docs/web-reviews.md → Learning which method works).

A web_reviews target whose ``method`` is ``auto`` (shared/web_review_targets.py) is read by a cascade of steps
(``CASCADE``): the deployment's signed browser, then Amazon Bedrock web search, then AgentCore Web Search's
snippets, each later step only when the one before it was blocked or read nothing. What each step got on a site is
kept per workspace and site, in ONE record of voc-aggregates::

    pk WS#{ws}#WEB_REVIEWS#METHODS   sk {domain}     a run in a workspace (through its ws_table view)
    pk WEB_REVIEWS#METHODS           sk {domain}     a deployment-wide run (no workspace)

``domain`` is the page's host, lower-cased, without ``www.`` (``site_domain``). A record holds no review and no
page content: ``best_method`` (the step that last read the site, or ``none``), ``learned_at`` (when it did) and, per
step tried, ``last_outcome`` (``readable``, ``blocked:<vendor>``, ``no_reviews``, ``error``), ``last_at``,
``successes``, ``failures`` and ``last_reviews``. Each workspace starts with no record and learns from its own runs
only: nothing is shared between workspaces and nothing is seeded (no eval result, no static hint).

How a run uses it (``plan_for``), a step blocked within ``BLOCKED_SKIP_DAYS`` always left out:

* ``known``: the best step read the site within ``FRESH_DAYS``: it goes first, and the cascade's other steps, from
  the top, are the fallback when it fails now;
* ``reprobe``: the same, but the best step is not the browser and the browser was last tried more than
  ``REPROBE_DAYS`` ago (or never): the browser first, once, then the best step (a site may let the browser in again);
* ``cascade``: no record, or a best step that is stale or ``none``: the whole cascade.

After the target's read the record is updated with what each step got (``learned``): the first step that read reviews
is the new best; when the known best fails now and nothing else reads the site, the best is ``none`` (the next run
tries the whole cascade); a step skipped for time changes nothing. The ingestor writes the whole record (a put; of two
runs at once the last one wins). ``GET /integrations/web_reviews/methods`` lists the request's workspace's records and
``DELETE /integrations/web_reviews/methods/{domain}`` clears one (lambda/api/integrations_handler.py). A workspace's
records go with its hard delete (lambda/jobs/workspace_delete/sweeps.py ``web_review_methods``); its export leaves them
out (operational: its runs learn them again; lambda/jobs/workspace_export/entities.py ``NOT_EXPORTED``).
"""
from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Final
from urllib.parse import urlparse

from shared.web_review_targets import METHOD_BEDROCK_WEB_SEARCH, METHOD_BROWSER
from shared.ws_repo import WorkspaceScope

#: The record's partition: its key family (a workspace's ``WS#{ws}#WEB_REVIEWS#METHODS``) and the deployment's.
METHODS_FAMILY: Final = 'WEB_REVIEWS'
METHODS_PART: Final = 'METHODS'
DEPLOYMENT_PARTITION: Final = f'{METHODS_FAMILY}#{METHODS_PART}'

#: The steps of ``auto``, in cascade order, and the best method of a site nothing read.
STEP_BROWSER: Final = METHOD_BROWSER
STEP_BEDROCK_WEB_SEARCH: Final = METHOD_BEDROCK_WEB_SEARCH
STEP_AGENTCORE_WEB_SEARCH: Final = 'agentcore_web_search'
CASCADE: Final = (STEP_BROWSER, STEP_BEDROCK_WEB_SEARCH, STEP_AGENTCORE_WEB_SEARCH)
NO_METHOD: Final = 'none'

#: A step's outcome as the record keeps it (a block names its vendor: ``blocked:Cloudflare``).
READABLE: Final = 'readable'
NO_REVIEWS: Final = 'no_reviews'
STEP_ERROR: Final = 'error'
BLOCKED_PREFIX: Final = 'blocked:'

#: Days a best step's last success counts as known, a block keeps its step out, and a known non-browser site waits
#: before the browser is tried again.
FRESH_DAYS: Final = 30
BLOCKED_SKIP_DAYS: Final = 7
REPROBE_DAYS: Final = 14

#: How a run's order was chosen (``Plan.kind``).
PLAN_KNOWN: Final = 'known'
PLAN_REPROBE: Final = 'reprobe'
PLAN_CASCADE: Final = 'cascade'

#: Records one listing answers at most (one per site a workspace reads).
MAX_LISTED: Final = 200
#: A record's domain: a DNS name, lower-case, at most 253 characters.
_DOMAIN_RE: Final = re.compile(r'^(?=.{1,253}\Z)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\Z')
_SECONDS_PER_DAY: Final = 86400


def site_domain(url: str) -> str:
    """The site of a page: its host, lower-cased, without ``www.`` (``https://www.g2.com/x`` is ``g2.com``)."""
    host = (urlparse(url).hostname or '').lower()
    return host.removeprefix('www.')


def is_site_domain(value: object) -> bool:
    """Whether *value* can be a record's domain (a lower-case DNS name)."""
    return isinstance(value, str) and bool(_DOMAIN_RE.match(value))


def methods_partition(scope: WorkspaceScope | None) -> str:
    """``WS#{ws}#WEB_REVIEWS#METHODS`` in *scope*, ``WEB_REVIEWS#METHODS`` deployment-wide."""
    return DEPLOYMENT_PARTITION if scope is None else scope.key(METHODS_FAMILY, METHODS_PART)


def record_key(scope: WorkspaceScope | None, domain: str) -> dict[str, str]:
    return {'pk': methods_partition(scope), 'sk': domain}


@dataclass(frozen=True)
class StepStats:
    """What one step got on a site, the last time it was tried, and how often it read it or not."""

    last_outcome: str
    last_at: str
    successes: int = 0
    failures: int = 0
    last_reviews: int = 0


@dataclass(frozen=True)
class MethodRecord:
    domain: str
    best_method: str = NO_METHOD
    learned_at: str | None = None
    steps: Mapping[str, StepStats] = field(default_factory=dict)


@dataclass(frozen=True)
class Plan:
    """The steps of one ``auto`` read, in order, and why (``kind``); what the record knew; the steps left out."""

    order: tuple[str, ...]
    kind: str
    known_method: str | None = None
    learned_at: str | None = None
    skipped: tuple[str, ...] = ()


@dataclass(frozen=True)
class Attempt:
    """A step that ran: its outcome (``READABLE``, ``blocked:<vendor>``, ``NO_REVIEWS``, ``STEP_ERROR``) and its reviews."""

    step: str
    outcome: str
    reviews: int = 0


def _days_since(iso: str | None, now: datetime) -> float | None:
    if not iso:
        return None
    try:
        then = datetime.fromisoformat(iso)
    except ValueError:
        return None
    if then.tzinfo is None or now.tzinfo is None:
        return None
    return (now - then).total_seconds() / _SECONDS_PER_DAY


def _within(iso: str | None, days: int, now: datetime) -> bool:
    age = _days_since(iso, now)
    return age is not None and age <= days


def plan_for(record: MethodRecord | None, now: datetime) -> Plan:
    """The order the steps of an ``auto`` read take on a site (the module docstring's three plans)."""
    if record is None:
        return Plan(CASCADE, PLAN_CASCADE)
    blocked = tuple(step for step in CASCADE if (stats := record.steps.get(step)) is not None
                    and stats.last_outcome.startswith(BLOCKED_PREFIX) and _within(stats.last_at, BLOCKED_SKIP_DAYS, now))
    best = record.best_method
    best_stats = record.steps.get(best)
    if not (best in CASCADE and best_stats is not None and best_stats.last_outcome == READABLE
            and _within(best_stats.last_at, FRESH_DAYS, now)):
        order = tuple(step for step in CASCADE if step not in blocked)
        return Plan(order or CASCADE, PLAN_CASCADE, skipped=blocked if order else ())
    rest = tuple(step for step in CASCADE if step != best and step not in blocked)
    browser = record.steps.get(STEP_BROWSER)
    if best != STEP_BROWSER and (browser is None or not _within(browser.last_at, REPROBE_DAYS, now)):
        order = (STEP_BROWSER, best, *(step for step in rest if step != STEP_BROWSER))
        return Plan(order, PLAN_REPROBE, best, record.learned_at, tuple(s for s in blocked if s != STEP_BROWSER))
    return Plan((best, *rest), PLAN_KNOWN, best, record.learned_at, blocked)


def learned(record: MethodRecord | None, domain: str, attempts: Sequence[Attempt], now: str) -> MethodRecord | None:
    """*record* (None: the site's first) after *attempts*, at *now* (ISO); None when no step ran (nothing learned)."""
    if not attempts:
        return record
    steps = dict(record.steps) if record is not None else {}
    for attempt in attempts:
        before = steps.get(attempt.step)
        read = attempt.outcome == READABLE
        steps[attempt.step] = StepStats(
            last_outcome=attempt.outcome, last_at=now,
            successes=(before.successes if before else 0) + int(read),
            failures=(before.failures if before else 0) + int(not read),
            last_reviews=attempt.reviews,
        )
    winner = next((attempt.step for attempt in attempts if attempt.outcome == READABLE), None)
    if winner is not None:
        return MethodRecord(domain, winner, now, steps)
    best = record.best_method if record is not None else NO_METHOD
    learned_at = record.learned_at if record is not None else None
    if best in {attempt.step for attempt in attempts}:
        best, learned_at = NO_METHOD, None  # the known best failed now, and nothing else read the site
    return MethodRecord(domain, best, learned_at, steps)


def _count(value: object) -> int:
    """A stored count (DynamoDB reads a number back as a ``Decimal``); 0 for anything else."""
    if isinstance(value, bool) or not isinstance(value, int | float | Decimal):
        return 0
    return max(int(value), 0)


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _stats(value: object) -> StepStats | None:
    if not isinstance(value, Mapping):
        return None
    outcome, at = _text(value.get('last_outcome')), _text(value.get('last_at'))
    if outcome is None or at is None:
        return None
    return StepStats(outcome, at, _count(value.get('successes')), _count(value.get('failures')),
                     _count(value.get('last_reviews')))


def record_from_item(item: Mapping[str, Any] | None) -> MethodRecord | None:
    """A stored item as a record; None when it is not one (a step that is not one is left out)."""
    if not item or not is_site_domain(item.get('sk')):
        return None
    raw = item.get('methods')
    steps = {step: stats for step, value in (raw.items() if isinstance(raw, Mapping) else ())
             if step in CASCADE and (stats := _stats(value)) is not None}
    best = item.get('best_method')
    return MethodRecord(str(item['sk']), best if best in CASCADE else NO_METHOD, _text(item.get('learned_at')), steps)


def _steps_out(record: MethodRecord) -> dict[str, dict[str, Any]]:
    return {step: {'last_outcome': stats.last_outcome, 'last_at': stats.last_at, 'successes': stats.successes,
                   'failures': stats.failures, 'last_reviews': stats.last_reviews}
            for step, stats in record.steps.items()}


def record_item(scope: WorkspaceScope | None, record: MethodRecord, now: str) -> dict[str, Any]:
    """The stored form of *record* (its key, the best step, and each step's numbers; no review, no page content)."""
    item: dict[str, Any] = {
        **record_key(scope, record.domain), 'best_method': record.best_method, 'updated_at': now,
        'methods': _steps_out(record),
    }
    if record.learned_at:
        item['learned_at'] = record.learned_at
    return item


def browser_recheck_due_at(record: MethodRecord) -> str | None:
    """When a run tries the browser again on a site another step reads (``REPROBE_DAYS`` after its last try; its
    learned time when it was never tried: the next run); None when the best step is the browser or none."""
    if record.best_method in (STEP_BROWSER, NO_METHOD):
        return None
    browser = record.steps.get(STEP_BROWSER)
    try:
        last = datetime.fromisoformat(browser.last_at) if browser is not None else None
    except ValueError:
        last = None
    return (last + timedelta(days=REPROBE_DAYS)).isoformat() if last is not None else record.learned_at


def public_record(record: MethodRecord) -> dict[str, Any]:
    """What the API answers of *record* (``GET /integrations/web_reviews/methods``)."""
    return {'domain': record.domain, 'best_method': record.best_method, 'learned_at': record.learned_at,
            'browser_recheck_due_at': browser_recheck_due_at(record), 'methods': _steps_out(record)}


def methods_answer(view: Any, scope: WorkspaceScope | None) -> dict[str, Any]:
    """The answer of both listing routes (``GET /integrations/web_reviews/methods``, ``GET /scrapers/review-methods``):
    the scope's records, each as ``public_record``."""
    return {'methods': [public_record(record) for record in list_records(view, scope)]}


def read_record(view: Any, scope: WorkspaceScope | None, domain: str) -> MethodRecord | None:
    """*domain*'s record in *view* (the scope's ws_table view, or the deployment's table); None when there is none."""
    return record_from_item(view.get_item(record_key(scope, domain)).get('Item'))


def write_record(view: Any, scope: WorkspaceScope | None, record: MethodRecord, now: str) -> None:
    view.put_item(record_item(scope, record, now))


def list_records(view: Any, scope: WorkspaceScope | None) -> list[MethodRecord]:
    """The scope's records, by domain, at most ``MAX_LISTED``."""
    answer = view.query('pk', methods_partition(scope), Limit=MAX_LISTED)
    return [record for item in answer.get('Items', []) if (record := record_from_item(item)) is not None]


def clear_record(view: Any, scope: WorkspaceScope | None, domain: str) -> bool:
    """Delete *domain*'s record in the scope; whether there was one."""
    answer = view.delete_item(record_key(scope, domain), ReturnValues='ALL_OLD')
    return bool(answer.get('Attributes'))
