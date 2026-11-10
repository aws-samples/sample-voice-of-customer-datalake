"""Radar cards on Home: code-only facts, at most three, the Radar API's visibility rule."""
from dataclasses import replace
from datetime import datetime, timedelta, tzinfo
from decimal import Decimal
from unittest.mock import MagicMock

import boto3
import pytest

from briefing import handler, providers, radar_cards, writer
from briefing.build import org_layer
from briefing.test.conftest import NOW
from briefing.todos import Reader
from briefing.writer import Words
from shared import briefing_store as store
from shared.brief_cards import BriefContext
from shared.briefing_requests import build_message
from shared.category_access import UNRESTRICTED, CategoryScope

SHIPPING_ONLY = CategoryScope(all=False, categories=frozenset({'shipping'}))
NO_RIVAL_SOURCE = CategoryScope(all=True, source_deny=frozenset({'radar_rival'}))
ONLY_WEB = CategoryScope(all=True, source_allow=frozenset({'webscraper', 'radar_rival'}))
PROFILES = [{'id': 'radar_rival', 'label': 'Rival reviews', 'radar_brand': 'Rival', 'radar_domains': ['rival.com']}]


def _day(days_ago: int) -> str:
    return (NOW - timedelta(days=days_ago)).strftime('%Y-%m-%d')


@pytest.fixture
def radar(world):
    resource = boto3.resource('dynamodb', region_name='us-east-1')
    table = resource.create_table(
        TableName='test-radar', BillingMode='PAY_PER_REQUEST',
        KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'},
                              {'AttributeName': 'sk', 'AttributeType': 'S'}],
    )
    world.tables.aggregates.put_item(Item={'pk': 'SETTINGS#sources', 'sk': 'config', 'sources': PROFILES})
    return table


def _ctx(world, radar_table, scope=UNRESTRICTED) -> BriefContext:
    return BriefContext(feedback_table=world.tables.feedback, aggregates_table=world.tables.aggregates,
                        scope=scope, now=NOW, extra={'radar_table': radar_table})


def _release(table, feature: str, *, day: str, first_seen: str, urls=('https://rival.com/blog/x',)) -> None:
    table.put_item(Item={
        'pk': 'RELEASE#rival', 'sk': f'{day}#{feature}', 'release_id': feature, 'brand': 'rival',
        'brand_label': 'Rival', 'feature': feature, 'release_date': day, 'date_approximate': False,
        'summary': 'A model summary', 'urls': list(urls), 'titles': ['Blog'], 'source_kind': 'official',
        'mentions': 1, 'first_seen': first_seen, 'last_seen': first_seen,
    })


def _counter(table, metric: str, day: str, count: int) -> None:
    table.put_item(Item={'pk': f'RADAR#rival#{metric}', 'sk': day, 'count': count})


def _reviews(table, days_ago: range, total: int, negative: int) -> None:
    for ago in days_ago:
        _counter(table, 'daily_total', _day(ago), total)
        _counter(table, 'daily_sentiment#negative', _day(ago), negative)


def _complaint(table, feedback_id: str, category: str) -> None:
    month = _day(1)[:7]
    table.put_item(Item={'pk': f'RADAR#rival#ITEMS#{month}', 'sk': f'{_day(1)}#{feedback_id}',
                         'feedback_id': feedback_id, 'category': category, 'sentiment_label': 'negative'})


def _beats_us(world, table, category: str = 'shipping') -> None:
    for ago in range(5):
        _counter(table, f'daily_category#{category}', _day(ago), 4)
        _counter(table, f'category_sentiment#{category}#positive', _day(ago), 4)
        _counter(table, 'daily_total', _day(ago), 4)
        world.counter(f'METRIC#category_sentiment#{category}#positive', _day(ago), 1)
        world.counter(f'METRIC#category_sentiment#{category}#negative', _day(ago), 3)


class TestReleases:
    def test_a_release_found_since_the_previous_brief_is_a_card_with_its_citations(self, world, radar):
        _release(radar, 'Offline mode', day=_day(2), first_seen=(NOW - timedelta(hours=5)).isoformat(),
                 urls=('https://rival.com/blog/offline', 'javascript:alert(1)'))
        [card] = radar_cards.release_cards(_ctx(world, radar))
        assert (card.kind, card.facts['brand_key'], card.facts['releases'][0]['feature']) == (
            'radar_release', 'rival', 'Offline mode')
        assert card.urls == ('https://rival.com/blog/offline',)

    def test_a_release_already_in_the_previous_brief_is_not_new(self, world, radar):
        key = store.org_key(store.scope_hash(UNRESTRICTED), _day(1))
        world.tables.aggregates.put_item(Item={**key, 'generated_at': (NOW - timedelta(hours=20)).isoformat()})
        _release(radar, 'Old news', day=_day(3), first_seen=(NOW - timedelta(hours=30)).isoformat())
        _release(radar, 'Fresh', day=_day(0), first_seen=(NOW - timedelta(hours=2)).isoformat())
        [card] = radar_cards.release_cards(_ctx(world, radar))
        assert [r['feature'] for r in card.facts['releases']] == ['Fresh']

    def test_without_a_previous_brief_only_the_last_week_counts(self, world, radar):
        _release(radar, 'Ancient', day=_day(20), first_seen=(NOW - timedelta(days=20)).isoformat())
        assert radar_cards.release_cards(_ctx(world, radar)) == []

    def test_a_brand_whose_source_the_reader_cannot_see_makes_no_card(self, world, radar):
        _release(radar, 'Offline mode', day=_day(1), first_seen=(NOW - timedelta(hours=5)).isoformat())
        assert radar_cards.radar_cards(_ctx(world, radar, NO_RIVAL_SOURCE)) == []


class TestComplaints:
    def test_a_clear_rise_in_negative_share_names_the_counts_and_top_theme(self, world, radar):
        _reviews(radar, range(7, 14), total=2, negative=0)
        _reviews(radar, range(7), total=2, negative=1)
        _complaint(radar, 'r1', 'billing')
        [card] = radar_cards.complaint_cards(_ctx(world, radar))
        assert (card.severity, card.facts['negative_pct'], card.facts['previous_negative_pct']) == ('warn', 50, 0)
        assert (card.facts['reviews'], card.facts['negative'], card.facts['top_complaint']['category']) == (
            14, 7, 'billing')
        # The display label rides beside the id (the writer names categories by it).
        assert (card.facts['category_label'], card.facts['top_complaint']['category_label']) == ('Billing', 'Billing')

    def test_a_small_move_is_not_a_card(self, world, radar):
        _reviews(radar, range(14), total=2, negative=1)
        assert radar_cards.complaint_cards(_ctx(world, radar)) == []

    def test_a_hidden_category_is_never_the_top_theme(self, world, radar):
        _reviews(radar, range(7, 14), total=2, negative=0)
        _reviews(radar, range(7), total=2, negative=1)
        _complaint(radar, 'r1', 'billing')
        [card] = radar_cards.complaint_cards(_ctx(world, radar, SHIPPING_ONLY))
        assert 'billing' not in str(card.to_item())


class TestBeatsUs:
    def test_a_category_they_win_clearly_is_a_card(self, world, radar):
        _beats_us(world, radar)
        [card] = radar_cards.beats_us_cards(_ctx(world, radar))
        assert (card.facts['categories'], card.facts['comparison'][0]['their_positive_pct'],
                card.facts['comparison'][0]['our_positive_pct']) == (['shipping'], 100, 25)

    def test_the_title_and_facts_name_the_category_by_its_label(self, world, radar):
        _beats_us(world, radar)
        [card] = radar_cards.beats_us_cards(_ctx(world, radar))
        assert ('beats us on Shipping:' in card.title, card.facts['category_labels'],
                card.facts['comparison'][0]['category_label']) == (True, ['Shipping'], 'Shipping')

    def test_a_category_the_reader_cannot_see_is_never_compared(self, world, radar):
        _beats_us(world, radar, 'billing')
        assert radar_cards.beats_us_cards(_ctx(world, radar, SHIPPING_ONLY)) == []

    def test_no_us_side_when_the_source_grant_list_hides_our_sources(self, world, radar):
        _beats_us(world, radar)
        assert radar_cards.beats_us_cards(_ctx(world, radar, ONLY_WEB)) == []


class TestProvider:
    def test_at_most_three_cards_one_of_each_kind(self, world, radar):
        _release(radar, 'Offline mode', day=_day(1), first_seen=(NOW - timedelta(hours=5)).isoformat())
        _reviews(radar, range(7, 14), total=2, negative=0)
        _reviews(radar, range(7), total=2, negative=1)
        _beats_us(world, radar)
        kinds = [card.kind for card in radar_cards.radar_cards(_ctx(world, radar))]
        assert kinds == ['radar_release', 'radar_complaints', 'radar_beats_us']

    def test_no_radar_table_means_no_card_and_no_read(self, world):
        assert radar_cards.radar_cards(_ctx(world, None)) == []

    def test_it_runs_with_the_org_providers(self, world, radar):
        _release(radar, 'Offline mode', day=_day(1), first_seen=(NOW - timedelta(hours=5)).isoformat())
        cards = providers.run_providers(providers.PROVIDERS, _ctx(world, radar))
        assert [c.kind for c in cards if c.kind.startswith('radar_')] == ['radar_release']

    def test_unreadable_source_settings_drop_only_the_radar_cards(self, world, radar):
        world.tables.aggregates.put_item(Item={'pk': 'SETTINGS#sources', 'sk': 'config', 'sources': 'nope'})
        world.counter('METRIC#daily_category#shipping', _day(0), 3)
        cards = providers.run_providers(providers.PROVIDERS, _ctx(world, radar))
        assert [c.kind for c in cards] == ['whats_new']


def test_effective_brands_merge_the_stored_list_with_the_legacy_profiles(world, radar):
    radar.put_item(Item={'pk': 'SETTINGS#radar', 'sk': 'brands',
                         'brands': [{'label': 'Globex', 'domains': ['globex.com']}, {'label': 'Rival', 'domains': []}]})
    brands = radar_cards.effective_brands(world.tables.aggregates, radar)
    assert [(b.key, b.origin, b.sources) for b in brands] == [('globex', 'list', ()), ('rival', 'list', ('radar_rival',))]


def test_a_malformed_stored_list_leaves_only_the_legacy_brands(world, radar):
    radar.put_item(Item={'pk': 'SETTINGS#radar', 'sk': 'brands', 'brands': 'nope'})
    assert [b.key for b in radar_cards.effective_brands(world.tables.aggregates, radar)] == ['rival']


def test_safe_urls_keep_only_web_links():
    assert radar_cards.safe_urls(['https://a.com/x', 'http://b.org', 'ftp://c', 'javascript:x', 'https://', 3]) == (
        'https://a.com/x', 'http://b.org')


def test_the_org_layer_stores_the_radar_cards_with_their_urls(world, radar, monkeypatch):
    monkeypatch.setattr('briefing.build.write_org', _code_words)
    _release(radar, 'Offline mode', day=_day(1), first_seen=(NOW - timedelta(hours=5)).isoformat())
    org = org_layer(replace(world.tables, radar=radar), UNRESTRICTED, NOW, 'marker')
    [card] = [c for c in org.cards if c.kind == 'radar_release']
    assert card.urls == ('https://rival.com/blog/x',)
    assert isinstance(card.facts['new_releases'], int | Decimal)


def _code_words(cards, _grounding, _day) -> Words:
    """The writer without a model: the code-written words."""
    return Words(cards=list(cards))


class _FrozenDatetime(datetime):
    """The handler's clock (``datetime.now(UTC)`` in lambda_handler) pinned to the fixtures' NOW."""

    @classmethod
    def now(cls, tz: tzinfo | None = None) -> datetime:
        return NOW.astimezone(tz) if tz else NOW


def test_a_real_build_reads_radar_inside_the_worker_roles_grants(world, radar, monkeypatch):
    """Through briefing/handler.py, so lambda/shared/test/strict_iam.py judges every voc-radar call."""
    monkeypatch.setattr(handler, 'datetime', _FrozenDatetime)
    monkeypatch.setenv('RADAR_TABLE', 'test-radar')
    monkeypatch.setattr('briefing.build.lookup_reader', lambda *_: Reader('sub-ana', 'ana', 'Ana', is_admin=False))
    monkeypatch.setattr('shared.grounding._recall', lambda *_, **__: [])
    monkeypatch.setattr(writer, 'converse', MagicMock(return_value='{"cards": []}'))
    monkeypatch.setattr(handler, 'tables', lambda: replace(world.tables, radar=radar))
    _release(radar, 'Offline mode', day=_day(1), first_seen=(NOW - timedelta(hours=5)).isoformat())
    _beats_us(world, radar)
    record = {'eventSource': 'aws:sqs', 'messageId': 'm1', 'body': build_message('sub-ana', 'ana', 'refresh')}
    assert handler.lambda_handler({'Records': [record]}, MagicMock()) == {'batchItemFailures': []}
    brief = store.latest_brief(world.tables.aggregates, 'sub-ana')
    assert brief is not None
    kinds = [c['kind'] for c in brief['cards']]
    assert [k for k in kinds if k.startswith('radar_')] == ['radar_release', 'radar_beats_us']


def test_a_lead_on_a_handful_of_their_reviews_is_no_card(world, radar):
    """compare gives a too_few row no verdict, so two glowing reviews never 'beat us'."""
    _beats_us(world, radar)
    for ago in range(2):
        _counter(radar, 'daily_category#billing', _day(ago), 1)
        _counter(radar, 'category_sentiment#billing#positive', _day(ago), 1)
        world.counter('METRIC#category_sentiment#billing#negative', _day(ago), 5)
    [card] = radar_cards.beats_us_cards(_ctx(world, radar))
    assert card.facts['categories'] == ['shipping']
