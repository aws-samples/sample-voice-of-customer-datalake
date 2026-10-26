"""Release watch: customer feedback before and after a release, regressions flagged in code.

A *release* is either a GitHub release the github_issues plugin has seen (the
``software_version`` an issue reports against — its release day is the first day
an item names it) or a dated launch (a decision record's ``launched_at``, or a
date the caller names). For each release this module compares the ``window`` days
before the release day with the ``window`` days from it (the after side stops at
today): volume, mean sentiment, top categories and the complaint categories that
grew the most. Everything is computed in code from feedback items the caller has
already scoped to its category access; nothing here calls a model.

A release is a **regression** when either rule fires (constants pinned by
``shared/test/test_release_watch.py``):

* ``sentiment_drop`` — mean sentiment falls by ``SENTIMENT_DROP_THRESHOLD`` or
  more, with at least ``MIN_SENTIMENT_ITEMS`` scored items on each side (the
  "loud minority" guard: two angry reviews are not a trend);
* ``negative_rise`` — negative items per day rise by ``NEGATIVE_RISE_THRESHOLD``
  (50 %) or more, with at least ``MIN_NEGATIVE_ITEMS`` negative items after.

Per-day rates, not raw counts, are compared, so a release three days old is not
"better" merely because its after side is shorter.

Two callers: ``GET /metrics/release-watch`` (``metrics_handler``) and the morning
brief's card provider ``release_watch_cards`` (contract: ``shared.brief_cards``).
"""
from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from boto3.dynamodb.conditions import Key

from shared import category_access
from shared.brief_cards import BriefCard, BriefContext, CardAction, card_id
from shared.dynamo_paging import iter_query
from shared.feedback import DATE_BASIS_REVIEW, basis_date
from shared.github_metrics import GITHUB_SOURCE, item_version, version_sort_key
from shared.indexes import FEEDBACK_BY_DATE_INDEX
from shared.time_budget import WalkBudget, budgeted_days

SENTIMENT_DROP_THRESHOLD = 0.15
NEGATIVE_RISE_THRESHOLD = 0.5
MIN_NEGATIVE_ITEMS = 10
MIN_SENTIMENT_ITEMS = 5

DEFAULT_WINDOW_DAYS = 14
MAX_WINDOW_DAYS = 60
MAX_RELEASES = 5
TOP_CATEGORIES = 3
TOP_COMPLAINT_DELTAS = 5
# A complaint "grew" when its after count beats its before count by at least this much.
MIN_COMPLAINT_GROWTH = 2
MAX_EVIDENCE_IDS = 10
EVIDENCE_TITLE_WORDS = 8
EVIDENCE_TITLE_CHARS = 80

KIND_GITHUB = 'github_release'
KIND_LAUNCH = 'launch'

REASON_SENTIMENT_DROP = 'sentiment_drop'
REASON_NEGATIVE_RISE = 'negative_rise'

# The brief's provider: releases from the last CARD_RECENT_DAYS days get a card.
CARD_KIND = 'release_watch'
CARD_RECENT_DAYS = 14
CARD_MAX_ITEMS = 3000
CARD_WALK_SECONDS = 10
_PAGE_LIMIT = 500


@dataclass(frozen=True)
class Release:
    """One watched release. ``key`` is stable: ``github:<version>`` or ``launch:<id>``."""

    key: str
    label: str
    day: str
    kind: str


def _number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def item_day(item: Mapping[str, Any]) -> str:
    """The day the customer wrote the item (falls back to the import day)."""
    return basis_date(dict(item), DATE_BASIS_REVIEW)


def matches_keywords(item: Mapping[str, Any], keywords: Iterable[str]) -> bool:
    """True when every keyword occurs in the item's text, title or problem summary."""
    words = [w.lower() for w in keywords if w]
    if not words:
        return True
    haystack = ' '.join(
        str(item.get(field) or '') for field in ('original_text', 'title', 'problem_summary')
    ).lower()
    return all(word in haystack for word in words)


def github_releases(items: Iterable[Mapping[str, Any]], *, since: str, limit: int = MAX_RELEASES) -> list[Release]:
    """The latest ``limit`` GitHub versions first seen on or after ``since``, in release order."""
    first_seen: dict[str, str] = {}
    for item in items:
        if item.get('source_platform') != GITHUB_SOURCE:
            continue
        version = item_version(dict(item))
        day = item_day(item)
        if version and day and (version not in first_seen or day < first_seen[version]):
            first_seen[version] = day
    ordered = sorted((v for v, d in first_seen.items() if d >= since), key=version_sort_key)
    return [Release(f'github:{v}', v, first_seen[v], KIND_GITHUB) for v in ordered[-limit:]]


def launch_release(key: str, label: str, day: str) -> Release:
    return Release(f'launch:{key}', label, day, KIND_LAUNCH)


def _side(items: Sequence[Mapping[str, Any]], days: int) -> dict[str, Any]:
    scores = [s for s in (_number(i.get('sentiment_score')) for i in items) if s is not None]
    categories = Counter(category_access.item_category(i) for i in items)
    return {
        'days': days,
        'count': len(items),
        'scored': len(scores),
        'avg_sentiment': round(sum(scores) / len(scores), 3) if scores else None,
        'negative': sum(1 for i in items if i.get('sentiment_label') == 'negative'),
        'top_categories': [{'name': n, 'count': c} for n, c in categories.most_common(TOP_CATEGORIES)],
    }


def sentiment_delta(before: Mapping[str, Any], after: Mapping[str, Any]) -> float | None:
    """After minus before, or None when either side has too few scored items to say."""
    if before['scored'] < MIN_SENTIMENT_ITEMS or after['scored'] < MIN_SENTIMENT_ITEMS:
        return None
    return round(after['avg_sentiment'] - before['avg_sentiment'], 3)


def _rate_change_pct(before: int, before_days: int, after: int, after_days: int) -> int | None:
    """Per-day change in percent, or None when the before side had none."""
    if before == 0 or before_days <= 0 or after_days <= 0:
        return None
    return round(((after / after_days) / (before / before_days) - 1) * 100)


def negative_rise(before: Mapping[str, Any], after: Mapping[str, Any]) -> bool:
    """Negative items per day rose by NEGATIVE_RISE_THRESHOLD or more, with enough of them."""
    if after['negative'] < MIN_NEGATIVE_ITEMS or after['days'] <= 0:
        return False
    # Cross-multiplied, so a before side with no negatives (an infinite rise) needs no special case.
    return after['negative'] * before['days'] >= (1 + NEGATIVE_RISE_THRESHOLD) * before['negative'] * after['days']


def regression_reasons(before: Mapping[str, Any], after: Mapping[str, Any]) -> list[str]:
    reasons = []
    drop = sentiment_delta(before, after)
    if drop is not None and drop <= -SENTIMENT_DROP_THRESHOLD:
        reasons.append(REASON_SENTIMENT_DROP)
    if negative_rise(before, after):
        reasons.append(REASON_NEGATIVE_RISE)
    return reasons


def _complaint_deltas(before: Sequence[Mapping[str, Any]], after: Sequence[Mapping[str, Any]],
                      before_days: int, after_days: int) -> list[dict[str, Any]]:
    """Negative-item categories that actually GREW, ranked by how much their per-day count grew.

    "Grew" is read the way the row reads to a person: the after count is higher than
    the before count by at least ``MIN_COMPLAINT_GROWTH`` (``1 → 1`` or ``3 → 4`` is
    not a growing complaint). The after side is never longer than the before side, so
    a higher raw count is also a higher per-day rate.
    """
    def negatives(items: Sequence[Mapping[str, Any]]) -> Counter:
        return Counter(category_access.item_category(i) for i in items if i.get('sentiment_label') == 'negative')

    was, now = negatives(before), negatives(after)
    rows = [{'name': name, 'before': was[name], 'after': now[name]} for name in now
            if now[name] - was[name] >= MIN_COMPLAINT_GROWTH]
    rows.sort(key=lambda r: (-(r['after'] / after_days - r['before'] / before_days), r['name']))
    return rows[:TOP_COMPLAINT_DELTAS]


def _evidence_title(item: Mapping[str, Any]) -> str:
    """What a review link reads as: the review's title, else its first words."""
    title = ' '.join(str(item.get('title') or '').split())
    if title:
        return title[:EVIDENCE_TITLE_CHARS]
    words = str(item.get('original_text') or item.get('text') or '').split()
    head = ' '.join(words[:EVIDENCE_TITLE_WORDS])[:EVIDENCE_TITLE_CHARS]
    return f'{head}…' if head and len(words) > EVIDENCE_TITLE_WORDS else head


def _evidence(items: Sequence[Mapping[str, Any]]) -> list[dict[str, str]]:
    """The most negative after-side items first (what a reader should open), each with the words its link shows."""
    negatives = [i for i in items if i.get('sentiment_label') == 'negative' and i.get('feedback_id')]
    negatives.sort(key=lambda i: _number(i.get('sentiment_score')) or 0.0)
    return [{'feedback_id': str(i['feedback_id']), 'title': _evidence_title(i)} for i in negatives[:MAX_EVIDENCE_IDS]]


def watch_release(items: Sequence[Mapping[str, Any]], release: Release, *, window_days: int, today: str) -> dict[str, Any]:
    """The before/after comparison of one release (``today`` and ``release.day`` are ISO days)."""
    start = date.fromisoformat(release.day)
    first_before = (start - timedelta(days=window_days)).isoformat()
    last_after = min(start + timedelta(days=window_days - 1), date.fromisoformat(today))
    after_days = (last_after - start).days + 1
    before_items = [i for i in items if first_before <= item_day(i) < release.day]
    after_items = [i for i in items if release.day <= item_day(i) <= last_after.isoformat()]
    before, after = _side(before_items, window_days), _side(after_items, after_days)
    reasons = regression_reasons(before, after)
    evidence = _evidence(after_items)
    return {
        'key': release.key, 'label': release.label, 'kind': release.kind, 'date': release.day,
        'before': before, 'after': after,
        'deltas': {
            'volume_pct': _rate_change_pct(before['count'], window_days, after['count'], after_days),
            'negative_pct': _rate_change_pct(before['negative'], window_days, after['negative'], after_days),
            'sentiment': sentiment_delta(before, after),
        },
        'complaint_deltas': _complaint_deltas(before_items, after_items, window_days, after_days),
        'regression': bool(reasons),
        'reasons': reasons,
        'feedback_ids': [row['feedback_id'] for row in evidence],
        'evidence': evidence,
    }


def release_watch(items: Sequence[Mapping[str, Any]], releases: Iterable[Release], *,
                  window_days: int, today: str) -> list[dict[str, Any]]:
    """Every release that has started (day <= today), newest release day first."""
    started = [r for r in releases if r.day <= today]
    started.sort(key=lambda r: (r.day, r.key), reverse=True)
    return [watch_release(items, r, window_days=window_days, today=today) for r in started]


def thresholds() -> dict[str, float | int]:
    """The rules as published beside every answer, so a reader can see why a flag fired."""
    return {
        'sentiment_drop': SENTIMENT_DROP_THRESHOLD,
        'negative_rise_pct': round(NEGATIVE_RISE_THRESHOLD * 100),
        'min_negative_items': MIN_NEGATIVE_ITEMS,
        'min_sentiment_items': MIN_SENTIMENT_ITEMS,
    }


# ── The morning brief's card provider ────────────────────────────────────────

def read_recent_items(table: Any, days: int, *, now: datetime, budget: WalkBudget,
                      max_items: int = CARD_MAX_ITEMS) -> tuple[list[dict[str, Any]], bool]:
    """Items imported in the last ``days`` days, newest day first, bounded by count and time.

    Returns ``(items, is_partial)``; partial when either bound cut the walk short.
    """
    items: list[dict[str, Any]] = []
    for day in budgeted_days(days, budget, today=now):
        kwargs: dict[str, Any] = {'IndexName': FEEDBACK_BY_DATE_INDEX, 'Limit': _PAGE_LIMIT,
                                  'KeyConditionExpression': Key('gsi1pk').eq(f'DATE#{day}')}
        items.extend(iter_query(table, kwargs, max_items=max_items - len(items)))
        if len(items) >= max_items:
            return items, True
    return items, budget.stopped


def _launches(extra: Mapping[str, Any]) -> list[Release]:
    """Dated launches the brief worker passes in ``ctx.extra['launches']`` ({id, label, day})."""
    raw = extra.get('launches')
    if not isinstance(raw, list):
        return []
    return [
        launch_release(str(entry['id']), str(entry.get('label') or entry['id']), str(entry['day']))
        for entry in raw
        if isinstance(entry, dict) and entry.get('id') and is_iso_day(entry.get('day'))
    ]


def is_iso_day(value: object) -> bool:
    """A real ``YYYY-MM-DD`` calendar day."""
    if not isinstance(value, str) or len(value) != 10:
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def _dynamo_number(value: float | None) -> Decimal | None:
    return None if value is None else Decimal(str(value))


def _card(watch: Mapping[str, Any], day: str, window_days: int) -> BriefCard:
    before, after = watch['before'], watch['after']
    label = watch['label']
    prompt = (
        f"Compare customer feedback in the {window_days} days before and after release {label} "
        f"({watch['date']}). What changed, which complaints grew, and is it a regression?"
    )
    return BriefCard(
        id=card_id(CARD_KIND, day, watch['key']),
        kind=CARD_KIND,
        layer='org',
        severity='alert' if watch['regression'] else 'info',
        title=f'Release watch: {label}',
        facts={
            'release': label, 'release_kind': watch['kind'], 'release_date': watch['date'],
            'window_days': window_days, 'after_days': after['days'],
            'before_count': before['count'], 'after_count': after['count'],
            'before_negative': before['negative'], 'after_negative': after['negative'],
            'before_sentiment': _dynamo_number(before['avg_sentiment']),
            'after_sentiment': _dynamo_number(after['avg_sentiment']),
            'regression': watch['regression'], 'reasons': list(watch['reasons']),
            'top_complaints': [dict(row) for row in watch['complaint_deltas']],
        },
        actions=(CardAction('Investigate', prompt),),
        feedback_ids=tuple(watch['feedback_ids']),
    )


def release_watch_cards(ctx: BriefContext) -> list[BriefCard]:
    """``CardProvider``: one card per release from the last CARD_RECENT_DAYS days.

    Code only. A release with no feedback after it and no regression says nothing,
    so it gets no card.
    """
    window = DEFAULT_WINDOW_DAYS
    today = ctx.now.date()
    budget = WalkBudget(seconds=CARD_WALK_SECONDS)
    items, _ = read_recent_items(ctx.feedback_table, CARD_RECENT_DAYS + window, now=ctx.now, budget=budget)
    items = category_access.filter_items(ctx.scope, items)
    since = (today - timedelta(days=CARD_RECENT_DAYS - 1)).isoformat()
    releases = github_releases(items, since=since) + [r for r in _launches(ctx.extra) if r.day >= since]
    watches = release_watch(items, releases, window_days=window, today=today.isoformat())
    return [_card(w, today.isoformat(), window) for w in watches if w['after']['count'] or w['regression']]
