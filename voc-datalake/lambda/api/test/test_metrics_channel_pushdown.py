"""A small channel inside a big import day is found, exactly (`gsi5-by-channel`, shared/channel_index.py).

Live finding (a customer deployment, 5.23.03): one CSV import put 25,229 reviews on one day,
24,887 of them in channel `soz`. `GET /feedback/entities` counted `google_play` 70 and
`spolecznosc` 246 (the aggregator's counters), yet `/categories?channel=google_play` listed
nothing: the day walk stops at its row caps (5,000 kept, 10,000 examined) and matched the
channel after them. Reproduced on moto with the caps lowered: `soz` rows are the newest of
the day, so the small channel sits past them.

The channel index answers from the channel's own rows, slim (`CHANNEL_INDEX_FIELDS`). The
equivalence class pins that slim rows give every route the SAME answer full reviews give (a
field the projection forgot would change one), and the fallback class that a deployment
without the index still answers through the day walk with the channel pushed down.
"""
from __future__ import annotations

from contextlib import ExitStack
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from unittest.mock import patch

import boto3
import pytest
from boto3.dynamodb.conditions import Key
from category_access_fixtures import RESTRICTED_CLAIMS, RESTRICTED_SUB
from handler_events_fixtures import call_route
from moto import mock_aws
from moto_helpers import pk_sk_table

import metrics_handler
from metrics_handler import lambda_handler
from shared.api import clear_categories_cache
from shared.category_access import access_key
from shared.channel_index import CHANNEL_INDEX_FIELDS

CAP = 20
BIG = 'soz'
SMALL = 'google_play'
SMALL_COUNT = 3
BIG_COUNT = 3 * CAP
CATEGORIES = ['ksef', 'faktury']


def _today() -> str:
    return datetime.now(UTC).strftime('%Y-%m-%d')


def _review(n: int, channel: str) -> dict:
    day = _today()
    stamp = f'{day}T00:{n // 60:02d}:{n % 60:02d}+00:00'
    return {
        'pk': 'SOURCE#manual_import', 'sk': f'FEEDBACK#r{n:04d}', 'feedback_id': f'r{n:04d}',
        'gsi1pk': f'DATE#{day}', 'gsi1sk': f'{stamp}#r{n:04d}', 'date': stamp,
        'source_created_at': (datetime.now(UTC) - timedelta(days=n % 3)).strftime('%Y-%m-%d'),
        'source_platform': 'manual_import', 'source_channel': channel,
        'category': CATEGORIES[n % 2], 'subcategory': ['blad', 'jak_to_zrobic'][n % 2],
        'sentiment_label': ['negative', 'neutral', 'positive'][n % 3],
        'sentiment_score': Decimal(['-0.5', '0', '0.6'][n % 3]),
        'urgency': ['high', 'low'][n % 2], 'persona_type': ['existing_customer', 'prospect'][n % 2],
        'problem_summary': f'certificate upload fails {n % 2}', 'tags': ['KSeF'], 'rating': Decimal(n % 5 + 1),
        'dimensions': {'product': 'Web'},
        # Heavy fields no metric reads (not projected by the index).
        'original_text': f'Full review text {n}', 'normalized_text': f'Full review text {n}',
    }


def _feedback_table(name: str, with_index: bool):
    if not with_index:
        return pk_sk_table(name, gsi1_index='gsi1-by-date')
    keys = ['pk', 'sk', 'gsi1pk', 'gsi1sk', 'source_channel']

    def schema(hash_key: str, range_key: str) -> list:
        return [{'AttributeName': hash_key, 'KeyType': 'HASH'}, {'AttributeName': range_key, 'KeyType': 'RANGE'}]

    return boto3.resource('dynamodb', region_name='us-east-1').create_table(
        TableName=name, BillingMode='PAY_PER_REQUEST', KeySchema=schema('pk', 'sk'),
        AttributeDefinitions=[{'AttributeName': k, 'AttributeType': 'S'} for k in keys],
        GlobalSecondaryIndexes=[
            {'IndexName': 'gsi1-by-date', 'KeySchema': schema('gsi1pk', 'gsi1sk'), 'Projection': {'ProjectionType': 'ALL'}},
            {'IndexName': 'gsi5-by-channel', 'KeySchema': schema('source_channel', 'gsi1sk'),
             'Projection': {'ProjectionType': 'INCLUDE', 'NonKeyAttributes': list(CHANNEL_INDEX_FIELDS)}},
        ],
    )


@pytest.fixture
def world():
    """`use(with_index)` points the handler at a seeded table with or without gsi5-by-channel.

    Today: SMALL_COUNT `google_play` reviews (the oldest), then BIG_COUNT `soz` reviews (newer).
    """
    with ExitStack() as stack:
        stack.enter_context(mock_aws())
        stack.enter_context(patch.object(metrics_handler, 'MAX_FEEDBACK_OFFSET', CAP))
        aggregates = pk_sk_table('channel-aggregates')
        aggregates.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config',
                                  'categories': [{'name': name} for name in CATEGORIES]})
        # A restricted viewer who may see one category (and every non-restricted source).
        aggregates.put_item(Item={**access_key(RESTRICTED_SUB), 'categories': ['ksef']})
        stack.enter_context(patch('metrics_handler.aggregates_table', aggregates))
        tables = {}
        for with_index in (True, False):
            table = _feedback_table(f'channel-feedback-{with_index}', with_index)
            with table.batch_writer() as batch:
                for n in range(SMALL_COUNT + BIG_COUNT):
                    batch.put_item(Item=_review(n, SMALL if n < SMALL_COUNT else BIG))
            tables[with_index] = table
        # Entered once so the original is restored at exit; `use` swaps the patched value.
        stack.enter_context(patch('metrics_handler.feedback_table', tables[True]))

        def use(with_index: bool) -> None:
            metrics_handler.feedback_table = tables[with_index]
            clear_categories_cache()
            metrics_handler.app.clear_context()

        yield use
        clear_categories_cache()


def _get(event_factory, context, path, claims=None, **params):
    extra = {'claims': claims} if claims else {}
    response, body = call_route(lambda_handler, event_factory, context, method='GET', path=path,
                                query_params={k: str(v) for k, v in params.items()}, **extra)
    assert response['statusCode'] == 200, body
    return body


def _answer(use, with_index, event_factory, context, path, claims=None, **params):
    """The route's answer with or without the index, minus what only says how it was read."""
    use(with_index)
    with patch.object(metrics_handler, 'MAX_FEEDBACK_OFFSET', 10_000):  # the fallback reads everything here
        body = _get(event_factory, context, path, claims, **params)
    return {k: v for k, v in body.items() if k not in ('is_partial', 'partial_reason', 'scanned_through')}


class TestASmallChannelBehindTheCap:
    @pytest.mark.parametrize('with_index', [True, False])
    def test_the_feedback_list_finds_every_review_of_the_channel(self, world, api_gateway_event, lambda_context,
                                                                 with_index):
        world(with_index)
        body = _get(api_gateway_event, lambda_context, '/feedback', days=1, channel=SMALL, limit=50)
        assert (body['total'], {item['source_channel'] for item in body['items']}) == (SMALL_COUNT, {SMALL})

    def test_the_list_through_the_index_returns_full_reviews(self, world, api_gateway_event, lambda_context):
        world(True)
        body = _get(api_gateway_event, lambda_context, '/feedback', days=1, channel=SMALL, limit=2, offset=1)
        assert [(i['feedback_id'], i['original_text']) for i in body['items']] == [
            ('r0001', 'Full review text 1'), ('r0000', 'Full review text 0')]
        assert (body['total'], body['count']) == (SMALL_COUNT, 2)

    @pytest.mark.parametrize('with_index', [True, False])
    def test_the_category_breakdown_counts_it(self, world, api_gateway_event, lambda_context, with_index):
        world(with_index)
        body = _get(api_gateway_event, lambda_context, '/metrics/categories', days=1, channel=SMALL)
        assert body['categories'] == {'ksef': 2, 'faktury': 1}

    @pytest.mark.parametrize('with_index', [True, False])
    def test_urgent_only_and_stars_narrow_the_breakdowns_like_the_list(self, world, api_gateway_event, lambda_context,
                                                                       with_index):
        """5.34.00 live finding: the Categories page's rating and "Urgent only" filters left its distribution as is."""
        world(with_index)
        urgent = _get(api_gateway_event, lambda_context, '/metrics/categories', days=1, channel=SMALL, urgent=1)
        rated = _get(api_gateway_event, lambda_context, '/metrics/categories', days=1, channel=SMALL, rating_min=2)
        sentiment = _get(api_gateway_event, lambda_context, '/metrics/sentiment', days=1, channel=SMALL, urgent=1)
        assert (urgent['categories'], rated['categories'], sentiment['total']) == (
            {'ksef': 2}, {'ksef': 1, 'faktury': 1}, 2)

    def test_the_index_counts_a_channel_bigger_than_the_day_walk_cap(self, world, api_gateway_event, lambda_context):
        world(True)
        body = _get(api_gateway_event, lambda_context, '/metrics/categories', days=1, channel=BIG)
        assert (sum(body['categories'].values()), body['is_partial']) == (BIG_COUNT, False)

    def test_without_the_index_a_big_channel_still_stops_at_the_cap(self, world, api_gateway_event, lambda_context):
        world(False)
        body = _get(api_gateway_event, lambda_context, '/feedback', days=1, channel=BIG, limit=50)
        assert body['total'] == CAP


class TestSlimRowsAnswerLikeFullReviews:
    """Every channel-filtered route that reads the slim rows gives the full reviews' answer."""

    def test_the_index_rows_really_are_slim(self, world):
        """Guards the equivalence below: if the double ignored the projection it would prove nothing."""
        world(True)
        table = metrics_handler.feedback_table
        assert table is not None
        rows = table.query(
            IndexName='gsi5-by-channel', KeyConditionExpression=Key('source_channel').eq(SMALL))['Items']
        assert len(rows) == SMALL_COUNT
        assert {'original_text', 'normalized_text', 'gsi1pk'} & set(rows[0]) == set()
        assert set(rows[0]) <= {*CHANNEL_INDEX_FIELDS, 'pk', 'sk', 'source_channel', 'gsi1sk'}

    @pytest.mark.parametrize(('path', 'params'), [
        ('/feedback/entities', {}),
        ('/metrics/categories', {}),
        ('/metrics/sentiment', {}),
        ('/metrics/summary', {}),
        ('/metrics/summary', {'date_basis': 'review', 'days': 3}),
        ('/metrics/sources', {}),
        ('/metrics/personas', {}),
        ('/feedback', {'limit': 100}),
        ('/feedback', {'limit': 100, 'category': 'ksef', 'sentiment': 'negative'}),
        ('/feedback', {'limit': 100, 'tag': 'ksef', 'rating_min': 2}),
    ])
    @pytest.mark.parametrize('channel', [SMALL, BIG])
    def test_same_answer(self, world, api_gateway_event, lambda_context, path, params, channel):
        query = {'days': 1, 'channel': channel, **params}
        with_index = _answer(world, True, api_gateway_event, lambda_context, path, **query)
        without = _answer(world, False, api_gateway_event, lambda_context, path, **query)
        assert with_index == without


class TestARestrictedViewerThroughTheIndex:
    """The caller's category scope is pushed into the index query: same answer, only their category."""

    @pytest.mark.parametrize('path', ['/feedback', '/metrics/categories', '/metrics/summary', '/feedback/entities'])
    def test_same_answer_and_only_the_granted_category(self, world, api_gateway_event, lambda_context, path):
        query = {'days': 1, 'channel': BIG, 'limit': 100}
        with_index = _answer(world, True, api_gateway_event, lambda_context, path, RESTRICTED_CLAIMS, **query)
        without = _answer(world, False, api_gateway_event, lambda_context, path, RESTRICTED_CLAIMS, **query)
        assert with_index == without
        if path == '/feedback':
            assert {item['category'] for item in with_index['items']} == {'ksef'}
            assert with_index['total'] == BIG_COUNT // 2
        if path == '/metrics/categories':
            assert with_index['categories'] == {'ksef': BIG_COUNT // 2}
