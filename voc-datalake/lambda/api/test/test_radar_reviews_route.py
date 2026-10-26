"""GET /radar/brands/{brand}/reviews — read the reviews behind a theme, a day or a category (docs/radar.md)."""
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from category_access_fixtures import RESTRICTED_CLAIMS, RESTRICTED_SUB
from test_radar_handler import ADMIN, _call, radar_tables

from shared.category_access import access_key
from shared.radar_reviews import encode_cursor
from shared.radar_store import radar_item, store_item

PATH = '/radar/brands/acme/reviews'


def _ago(days: int) -> str:
    return (datetime.now(UTC).date() - timedelta(days=days)).isoformat()


# (days ago, sentiment, category, subcategory, text)
SEED = [
    (0, 'negative', 'billing', 'refunds', 'Charged twice, write to me at ana@example.com'),
    (0, 'positive', 'delivery', None, 'Came a day early'),
    (1, 'positive', 'delivery', 'speed', 'Very quick courier'),
    (2, 'mixed', 'delivery', 'speed', 'Quick but the box was crushed'),
    (40, 'negative', 'delivery', None, 'Lost parcel last month'),
]


def _stored(n: int, ago: int, label: str, category: str, subcategory: str | None, text: str) -> dict:
    return {
        'feedback_id': f'r{n}', 'date': _ago(0), 'source_created_at': _ago(ago), 'original_text': text,
        'category': category, 'subcategory': subcategory, 'sentiment_label': label,
        'sentiment_score': Decimal('0.5'), 'source_platform': 'rival_reviews', 'author': 'Ana',
        'author_email': 'ana@example.com', 'rating': Decimal('2'), 'problem_summary': f'Summary {n}',
        'source_url': 'https://reviews.example/acme' if n % 2 else 'javascript:alert(1)',
    }


@pytest.fixture
def seeded():
    with radar_tables() as (radar, aggregates):
        for n, row in enumerate(SEED):
            store_item(radar, 'acme', radar_item(_stored(n, *row), 'acme', 'Acme'))
        yield radar, aggregates


def _reviews(seeded, lambda_context, claims=ADMIN, **query):
    status, body, _ = _call(seeded, lambda_context, 'GET', PATH, claims=claims, query=query or None)
    return status, body


def _texts(body) -> list[str]:
    return [review['text'] for review in body['reviews']]


def test_reviews_come_newest_first_with_their_fields(seeded, lambda_context):
    status, body = _reviews(seeded, lambda_context)
    assert status == 200
    assert [r['day'] for r in body['reviews']] == [_ago(0), _ago(0), _ago(1), _ago(2), _ago(40)]
    assert (body['brand']['key'], body['next_cursor'], body['limit']) == ('acme', None, 25)
    early = next(r for r in body['reviews'] if r['text'] == 'Came a day early')
    assert early == {
        'feedback_id': 'r1', 'day': _ago(0), 'text': 'Came a day early', 'sentiment_label': 'positive',
        'sentiment_score': 0.5, 'category': 'delivery', 'subcategory': None, 'source_platform': 'rival_reviews',
        'rating': 2.0, 'problem_summary': 'Summary 1', 'source_url': 'https://reviews.example/acme',
    }


def test_text_is_redacted_and_no_author_or_unsafe_link_leaves(seeded, lambda_context):
    _, body = _reviews(seeded, lambda_context, category='billing')
    [billing] = body['reviews']
    assert 'ana@example.com' not in str(body)
    assert 'Charged twice' in billing['text']
    assert not {'author', 'author_email', 'source_url'} & set(billing)


def test_filters_narrow_by_category_subcategory_sentiment_and_day(seeded, lambda_context):
    assert _texts(_reviews(seeded, lambda_context, category='delivery', subcategory='speed')[1]) == [
        'Very quick courier', 'Quick but the box was crushed']
    assert _texts(_reviews(seeded, lambda_context, category='delivery', subcategory='')[1]) == [
        'Came a day early', 'Lost parcel last month']
    assert _texts(_reviews(seeded, lambda_context, sentiment='mixed')[1]) == ['Quick but the box was crushed']
    assert _texts(_reviews(seeded, lambda_context, day=_ago(1))[1]) == ['Very quick courier']


def test_the_days_window_bounds_the_list(seeded, lambda_context):
    _, body = _reviews(seeded, lambda_context, days='30')
    assert 'Lost parcel last month' not in _texts(body)
    assert len(body['reviews']) == 4


def test_cursor_round_trip_pages_through_every_review(seeded, lambda_context):
    _, first = _reviews(seeded, lambda_context, limit='2')
    _, second = _reviews(seeded, lambda_context, limit='2', cursor=first['next_cursor'])
    _, third = _reviews(seeded, lambda_context, limit='2', cursor=second['next_cursor'])
    pages = [_texts(page) for page in (first, second, third)]
    assert [len(page) for page in pages] == [2, 2, 1]
    assert len({text for page in pages for text in page}) == 5
    assert third['next_cursor'] is None


@pytest.mark.parametrize('cursor', [
    'not base64 !!', encode_cursor({'pk': 'RADAR#globex#ITEMS#2026-01', 'sk': '2026-01-01#x'}),
    encode_cursor({'pk': 'RADAR#acme#daily_total', 'sk': '2026-01-01#x'}),
])
def test_a_bad_cursor_is_a_400(seeded, lambda_context, cursor):
    assert _reviews(seeded, lambda_context, cursor=cursor)[0] == 400


@pytest.mark.parametrize('query', [
    {'sentiment': 'angry'}, {'day': 'yesterday'}, {'day': '2026-02-30'}, {'day': _ago(200), 'days': '30'},
])
def test_bad_filters_are_a_400(seeded, lambda_context, query):
    status, body = _reviews(seeded, lambda_context, **query)
    assert status == 400
    assert body['success'] is False


def test_limit_is_capped_at_50(seeded, lambda_context):
    assert _reviews(seeded, lambda_context, limit='500')[1]['limit'] == 50
    assert _reviews(seeded, lambda_context, limit='0')[1]['limit'] == 1


def test_a_hidden_or_unknown_brand_is_a_404(seeded, lambda_context):
    status, _, _ = _call(seeded, lambda_context, 'GET', '/radar/brands/globex/reviews')
    assert status == 404
    assert _call(seeded, lambda_context, 'GET', '/radar/brands/nope/reviews', claims=ADMIN)[0] == 404


def test_the_callers_category_scope_applies(seeded, lambda_context):
    _, aggregates = seeded
    aggregates.put_item(Item={**access_key(RESTRICTED_SUB), 'categories': ['billing'], 'sources': ['rival_reviews']})
    _, everything = _reviews(seeded, lambda_context, claims=RESTRICTED_CLAIMS)
    assert {r['category'] for r in everything['reviews']} == {'billing'}
    _, hidden = _reviews(seeded, lambda_context, claims=RESTRICTED_CLAIMS, category='delivery')
    assert (hidden['reviews'], hidden['next_cursor']) == ([], None)
