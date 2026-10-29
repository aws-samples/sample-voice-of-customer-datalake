"""radar_handler: GET /radar/all, the Radar page's "All brands" view (moto, docs/radar.md).

Pins: each brand's totals follow ``days``; its latest release is its newest; the combined feed is
newest first, brand-tagged and capped (with the total before the cap); a brand the caller may not
see is absent from both; ``days`` is parsed like the brand page; no brand is an empty answer; and
``all`` can never be a brand key (the SPA's All view would collide with it).
"""
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from test_radar_handler import ADMIN, PROFILES, _call, _review, radar_tables

from shared import radar_all
from shared.radar_brands import BRAND_LIST_KEY, validate_brand_list
from shared.radar_releases import ReleaseCandidate, store_candidate
from shared.radar_store import radar_item, store_item

VECTOR = [1.0] + [0.0] * 1023
ORTHOGONAL = [0.0, 1.0] + [0.0] * 1022


def _ago(days):
    return (datetime.now(UTC).date() - timedelta(days=days)).isoformat()


def _release(radar, brand, label, feature, days_ago, vector=VECTOR):
    store_candidate(radar, ReleaseCandidate(brand, label, feature, f'{feature} shipped.', _ago(days_ago),
                                            (f'https://{brand}.example.com/{days_ago}',), ('News',), 'official'),
                    vector, datetime.now(UTC).date(), datetime.now(UTC).isoformat())


@pytest.fixture
def all_tables():
    """Acme (visible: 2 reviews today, 1 forty days ago; 2 releases), Globex (restricted; 1 release),
    Initech (listed, no reviews, no releases)."""
    with radar_tables() as (radar, aggregates):
        radar.put_item(Item={**BRAND_LIST_KEY, 'brands': [{'label': 'Initech', 'domains': []}]})
        for n, label in enumerate(('positive', 'negative')):
            store_item(radar, 'acme', radar_item(_review(n, label, 'delivery', f'Quote {n}'), 'acme', 'Acme'))
        old = {**_review(5, 'positive', 'billing', 'Old quote'), 'date': _ago(40)}
        store_item(radar, 'acme', radar_item(old, 'acme', 'Acme'))
        _release(radar, 'acme', 'Acme', 'Dark mode', 10)
        _release(radar, 'acme', 'Acme', 'Offline sync', 3, ORTHOGONAL)
        _release(radar, 'globex', 'Globex', 'Secret launch', 1)
        _release(radar, 'acme', 'Acme', 'Ancient feature', 200, ORTHOGONAL[::-1])
        yield radar, aggregates


def _all(tables, lambda_context, days=None, claims=None):
    query = None if days is None else {'days': days}
    kwargs = {} if claims is None else {'claims': claims}
    return _call(tables, lambda_context, 'GET', '/radar/all', query=query, **kwargs)[:2]


def test_brands_come_in_the_overview_order_with_totals_over_the_window(all_tables, lambda_context):
    status, body = _all(all_tables, lambda_context, days='30')
    assert status == 200
    assert body['days'] == 30
    _, overview, _ = _call(all_tables, lambda_context, 'GET', '/radar')
    assert [b['key'] for b in body['brands']] == [b['key'] for b in overview['brands']] == ['initech', 'acme']
    acme = body['brands'][1]
    assert (acme['total'], acme['sentiment']['positive'], acme['sentiment']['negative']) == (2, 1, 1)
    assert {key: acme[key] for key in ('label', 'domains', 'origin', 'sources')} == \
        {key: overview['brands'][1][key] for key in ('label', 'domains', 'origin', 'sources')}
    _, wider = _all(all_tables, lambda_context, days='90')
    assert wider['brands'][1]['total'] == 3


def test_the_default_window_is_the_overview_s_ninety_days(all_tables, lambda_context):
    _, body = _all(all_tables, lambda_context)
    assert body['days'] == 90
    assert body['brands'][1]['total'] == 3


def test_each_brand_carries_its_newest_release_and_its_count_in_the_window(all_tables, lambda_context):
    _, body = _all(all_tables, lambda_context, days='90')
    initech, acme = body['brands']
    assert (initech['releases_in_window'], initech['latest_release']) == (0, None)
    assert acme['releases_in_window'] == 2
    assert acme['latest_release']['feature'] == 'Offline sync'
    assert acme['latest_release']['release_date'] == _ago(3)
    assert 'embedding' not in acme['latest_release']


def test_the_feed_is_newest_first_brand_tagged_and_only_the_window(all_tables, lambda_context):
    _, body = _all(all_tables, lambda_context, days='30', claims=ADMIN)
    assert [(r['brand']['key'], r['feature']) for r in body['releases']] == [
        ('globex', 'Secret launch'), ('acme', 'Offline sync'), ('acme', 'Dark mode')]
    assert body['releases'][0]['brand'] == {'key': 'globex', 'label': 'Globex'}
    assert body['releases'][0]['urls'] == ['https://globex.example.com/1']
    assert (body['releases_total'], body['releases_capped']) == (3, False)


def test_the_feed_is_capped_and_says_how_many_there_were(all_tables, lambda_context):
    with patch.object(radar_all, 'MAX_ALL_RELEASES', 2):
        _, body = _all(all_tables, lambda_context, days='30', claims=ADMIN)
    assert [r['feature'] for r in body['releases']] == ['Secret launch', 'Offline sync']
    assert (body['releases_total'], body['releases_capped']) == (3, True)


def test_the_total_stays_exact_when_one_brand_alone_has_more_than_the_cap(all_tables, lambda_context):
    # A cap of 1: each brand's read stops at one row, so the old count (rows read) said 2 for 3 releases.
    with patch.object(radar_all, 'MAX_ALL_RELEASES', 1):
        _, body = _all(all_tables, lambda_context, days='30', claims=ADMIN)
    assert [r['feature'] for r in body['releases']] == ['Secret launch']
    assert (body['releases_total'], body['releases_capped']) == (3, True)
    acme = next(brand for brand in body['brands'] if brand['key'] == 'acme')
    assert acme['releases_in_window'] == 2
    assert acme['latest_release']['feature'] == 'Offline sync'


def test_a_brand_the_caller_may_not_see_is_absent_from_brands_and_releases(all_tables, lambda_context):
    _, body = _all(all_tables, lambda_context, days='30')
    assert 'globex' not in [b['key'] for b in body['brands']]
    assert 'globex' not in [r['brand']['key'] for r in body['releases']]
    assert (body['releases_total'], body['releases_capped']) == (2, False)
    _, admin = _all(all_tables, lambda_context, days='30', claims=ADMIN)
    assert [b['key'] for b in admin['brands']] == ['initech', 'acme', 'globex']


@pytest.mark.parametrize(('days', 'parsed'), [('0', 1), ('366', 365), ('soon', 90), ('-5', 1)])
def test_an_out_of_range_window_is_read_like_the_brand_page(all_tables, lambda_context, days, parsed):
    """The page's own parser: clamped into 1..365, unreadable = the 90-day default (never a 400)."""
    status, body = _all(all_tables, lambda_context, days=days)
    page_status, page, _ = _call(all_tables, lambda_context, 'GET', '/radar/brands/acme/page', query={'days': days})
    assert status == page_status == 200
    assert body['days'] == page['detail']['days'] == parsed


def test_no_brand_is_an_empty_answer(lambda_context):
    with radar_tables() as (radar, aggregates):
        aggregates.put_item(Item={**PROFILES, 'sources': [{'id': 'web'}]})
        status, body = _all((radar, aggregates), lambda_context, days='7')
    assert status == 200
    assert body == {'days': 7, 'brands': [], 'releases': [], 'releases_total': 0, 'releases_capped': False}


@pytest.mark.parametrize('label', ['All', ' all ', 'ALL'])
def test_all_is_reserved_and_never_a_brand_key(label):
    with pytest.raises(ValueError, match='reserved'):
        validate_brand_list({'brands': [{'label': label}]})


def test_saving_a_brand_named_all_is_a_400(all_tables, lambda_context):
    status, body, _ = _call(all_tables, lambda_context, 'PUT', '/radar/brands', claims=ADMIN,
                            body={'brands': [{'label': 'All'}]})
    assert status == 400
    assert 'reserved' in str(body)


def test_a_label_merely_containing_all_is_still_allowed():
    assert [b['label'] for b in validate_brand_list({'brands': [{'label': 'All Star'}, {'label': 'Allbirds'}]})] \
        == ['All Star', 'Allbirds']


def test_count_releases_follows_every_page_and_reads_no_item():
    from unittest.mock import MagicMock

    from shared.radar_releases import count_releases

    table = MagicMock()
    table.query.side_effect = [{'Count': 250, 'LastEvaluatedKey': {'sk': 'x'}}, {'Count': 7}]
    assert count_releases(table, 'acme', datetime(2026, 1, 1, tzinfo=UTC).date()) == 257
    first, second = (call.kwargs for call in table.query.call_args_list)
    assert first['Select'] == second['Select'] == 'COUNT'
    assert 'ExclusiveStartKey' not in first
    assert second['ExclusiveStartKey'] == {'sk': 'x'}
