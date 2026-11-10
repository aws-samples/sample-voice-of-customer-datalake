"""Org-layer facts: counted for exactly the reader group's scope, never a hidden category."""
import re
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

import pytest

from briefing import providers, signals
from briefing.signals import read_signals, recent_quotes
from briefing.test.conftest import NOW
from shared.brief_cards import BriefCard, BriefContext
from shared.category_access import UNRESTRICTED, CategoryScope

SHIPPING_ONLY = CategoryScope(all=False, categories=frozenset({'shipping'}))
NO_PARTNER_SOURCE = CategoryScope(all=True, source_deny=frozenset({'partner'}))


def _day(days_ago: int) -> str:
    return (NOW - timedelta(days=days_ago)).strftime('%Y-%m-%d')


def _busy_week(world) -> None:
    """Shipping: 1 a day last week, 12 today (a spike); billing: a steady 4 a day."""
    for days_ago in range(1, 14):
        world.counter('METRIC#daily_category#shipping', _day(days_ago), 1)
        world.counter('METRIC#daily_category#billing', _day(days_ago), 4)
    world.counter('METRIC#daily_category#shipping', _day(0), 12)
    world.counter('METRIC#daily_category#billing', _day(0), 4)


def _ctx(world, scope) -> BriefContext:
    return BriefContext(feedback_table=world.tables.feedback, aggregates_table=world.tables.aggregates,
                        scope=scope, now=NOW)


def _categories(cards: list[BriefCard]) -> set[str]:
    return {name for card in cards for name in providers.card_categories(card)}


class TestCountersPath:
    def test_a_hidden_category_is_never_counted(self, world):
        _busy_week(world)
        signals = read_signals(world.tables.feedback, world.tables.aggregates, SHIPPING_ONLY, NOW)
        assert set(signals.categories) == {'shipping'}
        assert signals.totals().current == 12 + 6

    def test_a_spike_raises_a_code_only_alert(self, world):
        _busy_week(world)
        [card] = providers.spike_alert_cards(_ctx(world, UNRESTRICTED))
        assert (card.kind, card.severity, card.facts['category'], card.facts['today']) == (
            'alert_spike', 'alert', 'shipping', 12)

    def test_no_card_of_a_restricted_reader_names_a_hidden_category(self, world):
        _busy_week(world)
        world.review('f-bill', category='billing', day=_day(0), urgency='high')
        cards = providers.run_providers(providers.PROVIDERS, _ctx(world, SHIPPING_ONLY))
        assert cards
        assert 'billing' not in _categories(cards)
        assert 'billing' not in str([c.to_item() for c in cards])


class TestItemsPath:
    def test_a_hidden_source_is_not_counted(self, world):
        world.review('f1', category='shipping', day=_day(0))
        world.review('f2', category='shipping', day=_day(1), source='partner')
        signals = read_signals(world.tables.feedback, world.tables.aggregates, NO_PARTNER_SOURCE, NOW)
        assert signals.categories['shipping'].current == 1

    def test_urgent_reviews_follow_the_scope(self, world):
        for i in range(4):
            world.review(f'u{i}', category='shipping', day=_day(0), urgency='high')
        world.review('u-bill', category='billing', day=_day(0), urgency='high')
        [card] = providers.urgent_alert_cards(_ctx(world, SHIPPING_ONLY))
        assert card.facts['current'] == 4
        assert 'u-bill' not in card.feedback_ids

    def test_the_urgency_index_read_asks_only_for_attributes_the_index_projects(self):
        # moto ignores GSI projections; DynamoDB refuses a ProjectionExpression naming an
        # attribute an INCLUDE index does not carry (the first live brief failed exactly so).
        stack = (Path(__file__).resolve().parents[3] / 'lib' / 'stacks' / 'core-stack.ts').read_text()
        block = stack[stack.index("indexName: 'gsi3-by-urgency'"):]
        included = re.findall(r"'([a-z_]+)'", block[block.index('nonKeyAttributes'):block.index(']')])
        projected = {'pk', 'sk', 'gsi3pk', 'gsi3sk', *included}
        requested = {name.strip() for name in signals._URGENT_INDEX_FIELDS.split(',')}
        assert requested <= projected


class TestQuotes:
    def test_quotes_are_redacted_and_scoped(self, world):
        world.review('q1', category='shipping', day=_day(0), text='Late again, mail me at user@example.com')
        world.review('q2', category='billing', day=_day(0), text='Billing quote')
        quotes = recent_quotes(world.tables.feedback, SHIPPING_ONLY, 'shipping', NOW)
        assert [q['feedback_id'] for q in quotes] == ['q1']
        assert 'user@example.com' not in quotes[0]['text']

    def test_no_quote_from_a_hidden_category(self, world):
        world.review('q2', category='billing', day=_day(0))
        assert recent_quotes(world.tables.feedback, SHIPPING_ONLY, 'billing', NOW) == []


class TestTrendingAndSentiment:
    def test_a_rising_category_trends_with_its_quotes(self, world):
        _busy_week(world)
        world.review('t1', category='shipping', day=_day(0), text='Parcel lost')
        [card] = providers.trending_cards(_ctx(world, UNRESTRICTED))
        assert (card.facts['category'], card.feedback_ids) == ('shipping', ('t1',))

    def test_a_sentiment_shift_is_reported(self, world):
        for days_ago in range(14):
            world.counter('METRIC#daily_category#billing', _day(days_ago), 10)
        for days_ago in range(7):
            world.counter('METRIC#category_sentiment#billing#negative', _day(days_ago), 5)
        [card] = providers.sentiment_cards(_ctx(world, UNRESTRICTED))
        assert (card.severity, card.facts['negative_pct'], card.facts['previous_negative_pct']) == ('warn', 50, 0)


def test_a_failing_provider_is_dropped_and_the_rest_kept(world):
    def broken(_ctx):
        raise KeyError('boom')

    world.counter('METRIC#daily_category#shipping', _day(0), 3)
    cards = providers.run_providers((broken, providers.whats_new_cards), _ctx(world, UNRESTRICTED))
    assert [card.kind for card in cards] == ['whats_new']


@pytest.mark.parametrize(('facts', 'kept'), [
    ({'category': 'shipping'}, True),
    ({'category': 'billing'}, False),
    ({'categories': ['shipping', 'billing']}, False),
    ({}, True),
])
def test_within_scope_drops_a_card_naming_a_hidden_category(facts, kept):
    card = BriefCard(id='x_0123456789abcdef', kind='x', layer='org', severity='info', title='t', facts=facts)
    assert (providers.within_scope([card], SHIPPING_ONLY) == [card]) is kept


class _FlakyBatchClient:
    """BatchGetItem that leaves one key unprocessed on the first call, then answers it."""

    def __init__(self, table_name: str, items: dict[str, dict]) -> None:
        self.table_name, self.items, self.calls = table_name, items, 0

    def batch_get_item(self, RequestItems):
        self.calls += 1
        keys = RequestItems[self.table_name]['Keys']
        answered, unprocessed = (keys[:-1], keys[-1:]) if self.calls == 1 else (keys, [])
        return {
            'Responses': {self.table_name: [self.items[k['sk']] for k in answered]},
            'UnprocessedKeys': {self.table_name: {**RequestItems[self.table_name], 'Keys': unprocessed}}
            if unprocessed else {},
        }


@dataclass
class _Meta:
    client: _FlakyBatchClient


@dataclass
class _Table:
    meta: _Meta
    name: str = 'feedback'


class TestBatchGet:
    def _table(self, client: _FlakyBatchClient) -> _Table:
        return _Table(meta=_Meta(client=client))

    def test_retries_unprocessed_keys_and_keeps_key_order(self):
        items = {s: {'pk': 'p', 'sk': s, 'feedback_id': s} for s in ('a', 'b', 'c')}
        client = _FlakyBatchClient('feedback', items)
        keys = [{'pk': 'p', 'sk': s} for s in ('c', 'a', 'b')]
        got = signals._batch_get(self._table(client), keys)
        assert [i['sk'] for i in got] == ['c', 'a', 'b']
        assert client.calls == 2

    def test_returns_nothing_for_no_keys_without_calling(self):
        client = _FlakyBatchClient('feedback', {})
        assert signals._batch_get(self._table(client), []) == []
        assert client.calls == 0
