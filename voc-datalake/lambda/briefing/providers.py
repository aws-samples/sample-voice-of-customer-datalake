"""Org-layer card providers: facts from code, no model (``shared/brief_cards.py``).

Each provider reads the scope group's ``Signals`` (``ctx.extra['signals']``, counted
once per build by ``briefing/signals.py`` for exactly that scope) and returns cards
with an English fallback title; the writer model only re-words them. Two kinds are
alerts (spikes and urgent jumps); the others are what the model writes up.

``PROVIDERS`` is the list the worker runs, in order. A provider that raises is
dropped and the rest are kept (``run_providers``).
"""
from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Final

from botocore.exceptions import BotoCoreError, ClientError

from briefing.radar_cards import radar_cards
from briefing.signals import WINDOW_DAYS, CategoryCounts, Signals, read_signals, recent_quotes
from shared import category_access
from shared.api import get_raw_categories_config
from shared.brief_cards import BriefCard, BriefContext, CardProvider, card_id
from shared.display_labels import category_label
from shared.exceptions import ApiError
from shared.logging import logger
from shared.release_watch import release_watch_cards

#: A category "spikes" when today has at least this many reviews ...
SPIKE_MIN: Final = 5
#: ... and at least this multiple of its daily average over the previous week.
SPIKE_RATIO: Final = 2.0
#: Urgent reviews in the current window that make an alert (when also more than the window before).
URGENT_MIN: Final = 3
#: A trending topic: at least this many reviews this week, and this much growth.
TRENDING_MIN: Final = 5
TRENDING_GROWTH: Final = 1.25
MAX_TRENDING: Final = 3
MAX_SPIKES: Final = 3
#: Sentiment shift: the share of negative reviews moved by at least this many points ...
SENTIMENT_SHIFT_POINTS: Final = 10.0
#: ... over at least this many reviews in the current window.
SENTIMENT_MIN_REVIEWS: Final = 20

#: What a provider may raise (a read fault, a malformed row); anything else is a bug and propagates.
PROVIDER_FAULTS: Final = (ClientError, BotoCoreError, ApiError, KeyError, TypeError, ValueError, ArithmeticError)

KIND_WHATS_NEW: Final = 'whats_new'
KIND_TRENDING: Final = 'trending_topic'
KIND_SENTIMENT: Final = 'sentiment_shift'
KIND_SPIKE: Final = 'alert_spike'
KIND_URGENT: Final = 'alert_urgent'


def signals_of(ctx: BriefContext) -> Signals:
    """The build's signals (computed once by the worker), or read now for a lone provider call."""
    cached = ctx.extra.get('signals')
    if isinstance(cached, Signals):
        return cached
    computed = read_signals(ctx.feedback_table, ctx.aggregates_table, ctx.scope, ctx.now)
    ctx.extra['signals'] = computed
    return computed


def label_of(ctx: BriefContext, category: str) -> str:
    """The category's display label (configured name, else humanised id): what titles and the writer use."""
    return category_label(category, get_raw_categories_config(ctx.aggregates_table))


def change_pct(current: int, previous: int) -> int | None:
    """Whole-percent change, None when there is nothing to compare with."""
    return None if previous <= 0 else round((current - previous) * 100 / previous)


def whats_new_cards(ctx: BriefContext) -> list[BriefCard]:
    signals = signals_of(ctx)
    totals = signals.totals()
    current, previous = totals.current, totals.previous
    if current <= 0:
        return []
    change = change_pct(current, previous)
    return [BriefCard(
        id=card_id(KIND_WHATS_NEW, signals.today), kind=KIND_WHATS_NEW, layer='org', severity='info',
        title=f'{current} reviews in the last {WINDOW_DAYS} days',
        facts={'current': current, 'previous': previous, 'change_pct': change, 'window_days': WINDOW_DAYS,
               'partial': signals.partial},
    )]


def _is_trending(counts: CategoryCounts) -> bool:
    return counts.current >= TRENDING_MIN and counts.current > counts.previous * TRENDING_GROWTH


def trending_cards(ctx: BriefContext) -> list[BriefCard]:
    signals = signals_of(ctx)
    rising = sorted(((name, c) for name, c in signals.categories.items() if _is_trending(c)),
                    key=lambda pair: pair[1].current - pair[1].previous, reverse=True)[:MAX_TRENDING]
    cards = []
    for name, counts in rising:
        quotes = recent_quotes(ctx.feedback_table, ctx.scope, name, ctx.now)
        label = label_of(ctx, name)
        cards.append(BriefCard(
            id=card_id(KIND_TRENDING, signals.today, name), kind=KIND_TRENDING, layer='org', severity='info',
            title=f'{label} is trending: {counts.current} reviews this week',
            facts={'category': name, 'category_label': label, 'current': counts.current,
                   'previous': counts.previous,
                   'change_pct': change_pct(counts.current, counts.previous), 'quotes': quotes},
            feedback_ids=tuple(q['feedback_id'] for q in quotes),
        ))
    return cards


def _negative_share(negative: int, total: int) -> float:
    return 0.0 if total <= 0 else negative * 100 / total


def sentiment_cards(ctx: BriefContext) -> list[BriefCard]:
    signals = signals_of(ctx)
    totals = signals.totals()
    current, previous = totals.current, totals.previous
    if current < SENTIMENT_MIN_REVIEWS or previous <= 0:
        return []
    now_share = _negative_share(totals.negative_current, current)
    before = _negative_share(totals.negative_previous, previous)
    shift = now_share - before
    if abs(shift) < SENTIMENT_SHIFT_POINTS:
        return []
    worse = shift > 0
    return [BriefCard(
        id=card_id(KIND_SENTIMENT, signals.today), kind=KIND_SENTIMENT, layer='org',
        severity='warn' if worse else 'info',
        title=f"Negative reviews {'rose' if worse else 'fell'} to {round(now_share)}% (from {round(before)}%)",
        facts={'negative_pct': round(now_share), 'previous_negative_pct': round(before),
               'shift_points': round(shift), 'reviews': current},
    )]


def _week_average(counts: CategoryCounts, today: str) -> float:
    earlier = sorted(day for day in counts.daily if day < today)[-WINDOW_DAYS:]
    return sum(counts.daily[day] for day in earlier) / WINDOW_DAYS


def spike_alert_cards(ctx: BriefContext) -> list[BriefCard]:
    """Code-only alerts: a category whose reviews today jumped past its usual day."""
    signals = signals_of(ctx)
    spikes = []
    for name, counts in signals.categories.items():
        today = counts.daily.get(signals.today, 0)
        average = _week_average(counts, signals.today)
        if today >= SPIKE_MIN and today >= SPIKE_RATIO * max(average, 1.0):
            spikes.append((today - average, name, today, average))
    spikes.sort(reverse=True)
    return [_spike_card(signals.today, name, label_of(ctx, name), today, average)
            for _, name, today, average in spikes[:MAX_SPIKES]]


def _spike_card(day: str, name: str, label: str, today: int, average: float) -> BriefCard:
    return BriefCard(
        id=card_id(KIND_SPIKE, day, name), kind=KIND_SPIKE, layer='org', severity='alert',
        title=f'Spike in {label}: {today} reviews today (usually {round(average, 1)})',
        facts={'category': name, 'category_label': label, 'today': today, 'daily_average': round(average, 1)},
    )


def urgent_alert_cards(ctx: BriefContext) -> list[BriefCard]:
    """Code-only alert: more urgent reviews this week than the week before."""
    signals = signals_of(ctx)
    count = len(signals.urgent_current)
    if count < URGENT_MIN or count <= signals.urgent_previous:
        return []
    ids = tuple(str(i['feedback_id']) for i in signals.urgent_current if isinstance(i.get('feedback_id'), str))
    categories = sorted({category_access.item_category(i) for i in signals.urgent_current})
    return [BriefCard(
        id=card_id(KIND_URGENT, signals.today), kind=KIND_URGENT, layer='org', severity='alert',
        title=f'{count} urgent reviews this week (previous week: {signals.urgent_previous})',
        facts={'current': count, 'previous': signals.urgent_previous, 'categories': categories,
               'category_labels': [label_of(ctx, name) for name in categories]},
        feedback_ids=ids,
    )]


PROVIDERS: Final[tuple[CardProvider, ...]] = (
    spike_alert_cards,
    urgent_alert_cards,
    whats_new_cards,
    trending_cards,
    sentiment_cards,
    release_watch_cards,
    radar_cards,
)


def run_providers(providers: Sequence[CardProvider], ctx: BriefContext) -> list[BriefCard]:
    """Every provider's cards, in order; a provider that raises is dropped (logged), never fatal."""
    cards: list[BriefCard] = []
    for provider in providers:
        try:
            cards.extend(provider(ctx))
        except PROVIDER_FAULTS as exc:
            # One provider's fault must not lose the brief.
            logger.warning('Brief card provider failed',
                           extra={'provider': getattr(provider, '__name__', '?'), 'error_type': type(exc).__name__})
    return cards


def card_categories(card: BriefCard) -> Iterable[str]:
    """Every category a card names in its facts (``category`` and ``categories``)."""
    single = card.facts.get('category')
    if isinstance(single, str):
        yield single
    many = card.facts.get('categories')
    if isinstance(many, list | tuple):
        yield from (name for name in many if isinstance(name, str))


def within_scope(cards: Iterable[BriefCard], scope: category_access.CategoryScope) -> list[BriefCard]:
    """Defence in depth: a card naming any category the scope cannot see is dropped."""
    return [card for card in cards if all(category_access.admits(scope, name) for name in card_categories(card))]
