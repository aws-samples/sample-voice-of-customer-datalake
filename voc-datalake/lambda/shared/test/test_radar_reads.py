"""Radar's view readers per workspace (shared/radar_reads.py; docs/multi-workspace.md, decision 13)."""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from unittest.mock import patch

import pytest
from moto import mock_aws

from shared import radar_counts, radar_store
from shared.category_access import UNRESTRICTED, CategoryScope
from shared.metric_keys import SENTIMENT_PREFIX
from shared.radar_all import all_brands_view
from shared.radar_brands import RadarBrand
from shared.radar_reads import SortRange, partition_query, scoped_key, scoped_pk
from shared.radar_releases import count_releases, list_releases, release_pk
from shared.radar_reviews import decode_cursor, encode_cursor, list_reviews, reviews_page, stored_review
from shared.radar_store import counter_pk, daily_rows, marker_key, radar_item, store_item, sum_counter
from shared.radar_views import compare, counted_totals, themes
from shared.test.radar_fixtures import radar_pk_sk_table
from shared.ws_repo import OutOfScopeError, WorkspaceScope

A = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
B = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9')
START, END = date(2026, 3, 1), date(2026, 4, 30)


def _review(n: int, text: str, sentiment: str = 'positive') -> dict:
    return {'feedback_id': f'f{n}', 'date': f'2026-04-0{n}', 'sentiment_label': sentiment, 'category': 'billing',
            'original_text': text, 'direct_customer_quote': text, 'sentiment_score': Decimal('0.5')}


def _store(table, workspace: WorkspaceScope | None, item: dict) -> None:
    """``store_item``'s rows, written in ``workspace``'s partitions (what the processor's cut-over will write)."""
    stored = radar_item(item, 'acme', 'Acme')
    if workspace is None:
        store_item(table, 'acme', stored)
        return
    actions = radar_store._transaction(table.name, 'acme', stored)
    for action in actions:
        body = action.get('Put') or action['Update']
        row = body.get('Item') or body['Key']
        row['pk'] = scoped_pk(workspace, row['pk'])
        if 'item_pk' in row:
            row['item_pk'] = scoped_pk(workspace, row['item_pk'])
    table.meta.client.transact_write_items(TransactItems=actions)


@pytest.fixture
def table():
    with mock_aws():
        table = radar_pk_sk_table('radar')
        _store(table, None, _review(1, 'the deployment review'))
        _store(table, A, _review(2, 'workspace A likes it'))
        _store(table, A, _review(3, 'workspace A hates it', 'negative'))
        _store(table, B, _review(4, 'workspace B review'))
        yield table


def _texts(items) -> list[str]:
    return sorted(str(item['original_text']) for item in items)


def test_a_workspaces_partition_is_the_deployments_key_inside_it():
    assert scoped_pk(None, 'RADAR#acme#daily_total') == 'RADAR#acme#daily_total'
    assert scoped_pk(A, 'RADAR#acme#daily_total') == f'WS#{A.ws}#RADAR#acme#daily_total'
    assert scoped_key(A, marker_key('acme', 'f1')) == {'pk': f'WS#{A.ws}#RADARID#acme', 'sk': 'f1'}


def test_both_paths_build_one_key_condition():
    class Table:
        def query(self, **kwargs):
            self.request = kwargs
            return {}
    for workspace, pk in ((None, 'RELEASE#acme'), (A, scoped_pk(A, 'RELEASE#acme'))):
        table = Table()
        partition_query(table, workspace, pk, SortRange('2026-03-01')).query(Limit=5)
        assert table.request == {'KeyConditionExpression': '#p = :p AND #radar_sk >= :radar_low',
                                 'ExpressionAttributeNames': {'#p': 'pk', '#radar_sk': 'sk'},
                                 'ExpressionAttributeValues': {':p': pk, ':radar_low': '2026-03-01'}, 'Limit': 5}


def test_a_partition_outside_the_workspace_never_reaches_dynamodb(table):
    for pk in ('RADAR#acme#daily_total', scoped_pk(B, 'RADAR#acme#daily_total')):
        with patch.object(table, 'query') as query, pytest.raises(OutOfScopeError):
            partition_query(table, A, pk).query()
        query.assert_not_called()


def test_the_counters_are_each_workspaces_own(table):
    assert sum_counter(table, counter_pk('acme', 'daily_total'), START, END) == 1
    assert sum_counter(table, counter_pk('acme', 'daily_total'), START, END, workspace=A) == 2
    assert sum_counter(table, counter_pk('acme', 'daily_total'), START, END, workspace=B) == 1
    assert [row['sk'] for row in daily_rows(table, counter_pk('acme', 'daily_total'), START, END, A)] == [
        '2026-04-02', '2026-04-03']


def test_the_review_list_walks_only_the_workspaces_reviews_and_pages_inside_it(table):
    found, cursor = list_reviews(table, 'acme', admits=lambda _item: True, start=START, end=END, limit=1,
                                 workspace=A)
    assert _texts(found) == ['workspace A hates it']
    assert cursor is not None
    after = decode_cursor(cursor, 'acme', START, END, A)
    assert A.owns(after['pk'])
    rest, _ = list_reviews(table, 'acme', admits=lambda _item: True, start=START, end=END, limit=5, after=after,
                           workspace=A)
    assert _texts(rest) == ['workspace A likes it']
    deployment, _ = list_reviews(table, 'acme', admits=lambda _item: True, start=START, end=END, limit=5)
    assert _texts(deployment) == ['the deployment review']


def test_a_cursor_of_another_partition_is_refused():
    for key in ({'pk': 'RADAR#acme#ITEMS#2026-04', 'sk': '2026-04-02#f2'},
                {'pk': f'WS#{B.ws}#RADAR#acme#ITEMS#2026-04', 'sk': '2026-04-02#f2'}):
        with pytest.raises(ValueError, match='cursor'):
            decode_cursor(encode_cursor(key), 'acme', START, END, A)
    with pytest.raises(ValueError, match='cursor'):
        decode_cursor(encode_cursor({'pk': f'WS#{A.ws}#RADAR#acme#ITEMS#2026-04', 'sk': '2026-04-02#f2'}),
                      'acme', START, END)


def test_the_reviews_page_reads_the_workspace(table):
    page = reviews_page(table, 'acme', UNRESTRICTED, {}, (START, END), A)
    assert sorted(review['feedback_id'] for review in page['reviews']) == ['f2', 'f3']


def test_one_review_is_found_only_in_its_own_workspace(table):
    assert (stored_review(table, 'acme', 'f2', A) or {}).get('original_text') == 'workspace A likes it'
    assert stored_review(table, 'acme', 'f2') is None
    assert stored_review(table, 'acme', 'f2', B) is None
    assert stored_review(table, 'acme', 'f1', A) is None
    assert (stored_review(table, 'acme', 'f1') or {}).get('original_text') == 'the deployment review'


def test_a_marker_that_points_outside_the_workspace_reads_as_absent(table):
    table.put_item(Item={**scoped_key(A, marker_key('acme', 'f9')), 'item_pk': 'RADAR#acme#ITEMS#2026-04',
                         'item_sk': '2026-04-01#f1'})
    with patch.object(table, 'get_item', wraps=table.get_item) as reads:
        assert stored_review(table, 'acme', 'f9', A) is None
    assert reads.call_count == 1


def test_the_headers_and_themes_count_the_workspaces_reviews(table):
    totals = counted_totals(table, 'acme', START, END, UNRESTRICTED, with_trend=True, workspace=A)
    assert totals['total'] == 2
    assert totals['sentiment']['negative'] == 1
    # A window too large to walk falls back to the counters: the workspace's too.
    with patch.object(radar_counts, 'MAX_COUNT_READ', 0):
        fallback = counted_totals(table, 'acme', START, END, UNRESTRICTED, with_trend=True, workspace=A)
    assert (fallback['total'], [point['date'] for point in fallback['trend']]) == (2, ['2026-04-02', '2026-04-03'])
    found = themes(table, 'acme', START, END, UNRESTRICTED, A)
    assert [theme['count'] for theme in found['love'] + found['hate']] == [1, 1]


@pytest.fixture
def aggregates():
    with mock_aws():
        aggregates = radar_pk_sk_table('aggregates')
        for workspace, count in ((None, 7), (A, 3)):
            for pk in ('METRIC#category_sentiment#billing#positive', f'{SENTIMENT_PREFIX}positive'):
                aggregates.put_item(Item={'pk': scoped_pk(workspace, pk), 'sk': '2026-04-02', 'count': count})
        yield aggregates


@pytest.mark.parametrize('walked', [True, False], ids=['from-the-reviews', 'from-the-counters'])
@pytest.mark.parametrize('scope', [UNRESTRICTED, CategoryScope(all=False, categories=frozenset({'billing'}))],
                         ids=['every-category', 'billing-only'])
def test_the_comparison_reads_only_the_workspaces_rows(table, aggregates, walked, scope):
    with patch.object(radar_counts, 'MAX_COUNT_READ', radar_counts.MAX_COUNT_READ if walked else 0):
        result = compare(table, aggregates, 'acme', ['billing'], START, END, scope, ours_available=True,
                         workspace=A)
    [row] = result['categories']
    # Theirs: workspace A's two reviews (never the deployment's one or B's); ours: A's own counters (3, not 7).
    assert (row['theirs']['volume'], row['ours']['volume']) == (2, 3)
    assert (result['overall']['theirs']['volume'], result['overall']['ours']['volume']) == (2, 3)


def test_the_releases_are_each_workspaces_own(table):
    for workspace, feature in ((None, 'Deployment feature'), (A, 'Workspace feature')):
        table.put_item(Item={'pk': scoped_pk(workspace, release_pk('acme')), 'sk': '2026-04-05#r1',
                             'feature': feature, 'release_date': '2026-04-05'})
    assert [row['feature'] for row in list_releases(table, 'acme', START, 10, workspace=A)] == ['Workspace feature']
    assert [row['feature'] for row in list_releases(table, 'acme', START, 10)] == ['Deployment feature']
    assert count_releases(table, 'acme', START, A) == 1
    assert count_releases(table, 'acme', START, B) == 0
    brand = RadarBrand(key='acme', label='Acme', domains=(), sources=())
    view = all_brands_view(table, [brand], UNRESTRICTED, 61, END, A)
    assert [row['feature'] for row in view['releases']] == ['Workspace feature']
    assert view['brands'][0]['total'] == 2
