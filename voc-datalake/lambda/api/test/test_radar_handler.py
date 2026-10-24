"""radar_handler.py — /radar and /radar/{proxy+} (moto-backed, docs/radar.md)."""
from contextlib import contextmanager
from datetime import UTC, datetime
from decimal import Decimal
from unittest.mock import patch

import pytest
from category_access_fixtures import CATEGORIES_CONFIG, RESTRICTED_CLAIMS, RESTRICTED_SUB
from moto import mock_aws
from moto_helpers import invoke, pk_sk_table, rest_event

import radar_handler
from shared.api import clear_categories_cache
from shared.category_access import access_key
from shared.radar_releases import ReleaseCandidate, store_candidate
from shared.radar_store import radar_item, store_item

ADMIN = {'sub': 'sub-admin', 'cognito:groups': 'admins', 'cognito:username': 'ada'}
USER = {'sub': 'sub-user', 'cognito:groups': 'users', 'cognito:username': 'ana'}
def _today():
    return datetime.now(UTC).date().isoformat()


PROFILES = {'pk': 'SETTINGS#sources', 'sk': 'config', 'sources': [
    {'id': 'rival_reviews', 'radar_brand': 'Acme', 'radar_domains': ['acme.com']},
    {'id': 'secret_rival', 'radar_brand': 'Globex', 'restricted': True},
    {'id': 'web'},
]}


def _review(n, label, category, quote):
    return {'feedback_id': f'f{n}', 'date': _today(), 'category': category, 'subcategory': None,
            'sentiment_label': label, 'sentiment_score': Decimal('0.8') if label == 'positive' else Decimal('-0.6'),
            'direct_customer_quote': quote, 'source_platform': 'rival_reviews'}


@contextmanager
def radar_tables():
    """Moto voc-radar + aggregates (source profiles and the categories config in place)."""
    # get_raw_categories_config caches for 5 minutes per process: another test's
    # taxonomy left in it would hide this test's 'delivery' category from compare.
    clear_categories_cache()
    with mock_aws():
        aggregates = pk_sk_table('aggregates')
        aggregates.put_item(Item=PROFILES)
        aggregates.put_item(Item=CATEGORIES_CONFIG)
        yield pk_sk_table('radar'), aggregates
    clear_categories_cache()


@pytest.fixture
def tables():
    with radar_tables() as (radar, aggregates):
        for n, (label, category, quote) in enumerate([
            ('positive', 'delivery', 'Fast, mail me at ana@example.com'),
            ('positive', 'delivery', 'Arrived early'),
            ('negative', 'billing', 'Charged twice'),
        ]):
            store_item(radar, 'acme', radar_item(_review(n, label, category, quote), 'acme', 'Acme'))
        for label, count in (('positive', 1), ('negative', 3)):
            aggregates.put_item(Item={'pk': f'METRIC#category_sentiment#delivery#{label}', 'sk': _today(), 'count': count})
        yield radar, aggregates


def _call(tables, lambda_context, method, path, claims=USER, body=None, query=None):
    radar, aggregates = tables
    event = rest_event(method, path, claims=claims, body=body)
    event['queryStringParameters'] = query
    with patch.object(radar_handler, 'RADAR_SCAN_FUNCTION', 'voc-radar-scan'), \
         patch.object(radar_handler, 'invoke_lambda_async') as start:
        status, payload = invoke(radar_handler, event, lambda_context, aggregates=aggregates, radar=radar)
    return status, payload, start


def test_the_overview_lists_only_brands_whose_sources_the_caller_may_see(tables, lambda_context):
    status, body, _ = _call(tables, lambda_context, 'GET', '/radar')
    assert status == 200
    assert [(b['key'], b['total']) for b in body['brands']] == [('acme', 3)]
    assert body['settings']['cadence'] == 'weekly'
    _, admin_view, _ = _call(tables, lambda_context, 'GET', '/radar', claims=ADMIN)
    assert [b['key'] for b in admin_view['brands']] == ['acme', 'globex']


def test_the_overview_names_the_source_profiles_feeding_each_brand(tables, lambda_context):
    """Administration -> Sources -> Radar lists them; profiles naming one brand are merged."""
    _, aggregates = tables
    aggregates.put_item(Item={**PROFILES, 'sources': [*PROFILES['sources'], {'id': 'acme_app', 'radar_brand': 'ACME'}]})
    _, user_view, _ = _call(tables, lambda_context, 'GET', '/radar')
    assert [(b['key'], b['sources']) for b in user_view['brands']] == [('acme', ['rival_reviews', 'acme_app'])]
    _, admin_view, _ = _call(tables, lambda_context, 'GET', '/radar', claims=ADMIN)
    assert admin_view['brands'][1]['sources'] == ['secret_rival']


def test_brand_detail_has_trend_and_redacted_love_and_hate(tables, lambda_context):
    status, body, _ = _call(tables, lambda_context, 'GET', '/radar/brands/acme', query={'days': '30'})
    assert status == 200
    assert body['trend'][0]['count'] == 3
    assert [(t['category'], t['count']) for t in body['love']] == [('delivery', 2)]
    assert 'ana@example.com' not in str(body['love'][0]['quotes'])
    assert [t['category'] for t in body['hate']] == ['billing']


def test_the_same_quote_appears_once_per_theme(tables, lambda_context):
    # Regression: a repost / second import of the same text listed the quote twice under one theme.
    radar, _ = tables
    store_item(radar, 'acme', radar_item(_review(9, 'positive', 'delivery', 'Arrived early'), 'acme', 'Acme'))
    _, body, _ = _call(tables, lambda_context, 'GET', '/radar/brands/acme', query={'days': '30'})
    [delivery] = [t for t in body['love'] if t['category'] == 'delivery']
    assert delivery['count'] == 3
    assert sorted(delivery['quotes']).count('Arrived early') == 1


def test_an_unknown_or_hidden_brand_is_a_404(tables, lambda_context):
    assert _call(tables, lambda_context, 'GET', '/radar/brands/nope')[0] == 404
    assert _call(tables, lambda_context, 'GET', '/radar/brands/globex/releases')[0] == 404


def test_compare_puts_us_against_them_per_category(tables, lambda_context):
    status, body, _ = _call(tables, lambda_context, 'GET', '/radar/brands/acme/compare')
    assert status == 200
    delivery = next(row for row in body['categories'] if row['category'] == 'delivery')
    assert (delivery['theirs']['volume'], delivery['ours']['volume']) == (2, 4)
    assert delivery['verdict'] == 'they_are_better'


def test_a_restricted_caller_gets_no_us_side_and_only_their_categories(tables, lambda_context):
    _, aggregates = tables
    aggregates.put_item(Item={**access_key(RESTRICTED_SUB), 'categories': ['billing'], 'sources': ['rival_reviews']})
    _, body, _ = _call(tables, lambda_context, 'GET', '/radar/brands/acme/compare', claims=RESTRICTED_CLAIMS)
    assert [row['category'] for row in body['categories']] == ['billing']
    assert (body['ours_available'], body['categories'][0]['ours']) == (False, None)
    _, detail, _ = _call(tables, lambda_context, 'GET', '/radar/brands/acme', claims=RESTRICTED_CLAIMS)
    assert detail['love'] == []


def test_releases_come_back_newest_first_without_embeddings(tables, lambda_context):
    radar, _ = tables
    vector = [1.0] + [0.0] * 1023
    store_candidate(radar, ReleaseCandidate('acme', 'Acme', 'Dark mode', 'Shipped.', _today(),
                                            ('https://acme.com/n',), ('News',), 'official'),
                    vector, datetime.now(UTC).date(), 'now')
    _, body, _ = _call(tables, lambda_context, 'GET', '/radar/brands/acme/releases')
    assert [(r['feature'], r['titles']) for r in body['releases']] == [('Dark mode', ['News'])]
    assert 'embedding' not in body['releases'][0]


def test_settings_are_admin_writes(tables, lambda_context):
    assert _call(tables, lambda_context, 'PUT', '/radar/settings', body={'cadence': 'daily'})[0] == 403
    status, body, _ = _call(tables, lambda_context, 'PUT', '/radar/settings', claims=ADMIN,
                            body={'cadence': 'daily', 'max_brands': 3, 'query_cap': 9})
    assert (status, body['settings']) == (200, {'cadence': 'daily', 'max_brands': 3, 'query_cap': 9})
    assert _call(tables, lambda_context, 'GET', '/radar/settings')[1]['settings']['cadence'] == 'daily'
    assert _call(tables, lambda_context, 'PUT', '/radar/settings', claims=ADMIN, body={'cadence': 'hourly'})[0] == 400


def test_scan_now_starts_the_worker_for_admins_only(tables, lambda_context):
    assert _call(tables, lambda_context, 'POST', '/radar/scan', body={})[0] == 403
    status, body, start = _call(tables, lambda_context, 'POST', '/radar/scan', claims=ADMIN, body={'brand': 'acme'})
    assert (status, body['status']) == (202, 'started')
    start.assert_called_once_with('voc-radar-scan', {'mode': 'manual', 'requested_by': 'sub-admin', 'brand': 'acme'})
    assert _call(tables, lambda_context, 'POST', '/radar/scan', claims=ADMIN, body={'brand': 'nope'})[0] == 404


def test_scan_now_without_any_radar_brand_points_at_the_brand_list(tables, lambda_context):
    _, aggregates = tables
    aggregates.put_item(Item={**PROFILES, 'sources': [{'id': 'web'}]})
    status, body, start = _call(tables, lambda_context, 'POST', '/radar/scan', claims=ADMIN)
    assert status == 400
    assert 'Administration → Sources → Radar' in body['error']
    start.assert_not_called()


def _radar_version(radar) -> int:
    from shared.data_version import RADAR_VERSION_KEY
    return int((radar.get_item(Key=RADAR_VERSION_KEY).get('Item') or {}).get('v', 0))


def test_radar_writes_bump_the_radar_version(tables, lambda_context):
    """docs/caching.md: PUT /radar/settings and PUT /radar/brands each bump once."""
    radar, _ = tables
    _call(tables, lambda_context, 'PUT', '/radar/settings', claims=ADMIN,
          body={'cadence': 'daily', 'max_brands': 3, 'query_cap': 9})
    assert _radar_version(radar) == 1
    _call(tables, lambda_context, 'PUT', '/radar/brands', claims=ADMIN,
          body={'brands': [{'label': 'Initech', 'domains': ['initech.com']}]})
    assert _radar_version(radar) == 2


def test_a_refused_radar_write_bumps_nothing(tables, lambda_context):
    radar, _ = tables
    assert _call(tables, lambda_context, 'PUT', '/radar/settings', body={'cadence': 'daily'})[0] == 403
    assert _radar_version(radar) == 0


def test_the_cached_overview_follows_a_settings_save(tables, lambda_context):
    """The overview is memoized; a save bumps the version, so the next read is fresh."""
    assert _call(tables, lambda_context, 'GET', '/radar')[1]['settings']['cadence'] == 'weekly'
    _call(tables, lambda_context, 'PUT', '/radar/settings', claims=ADMIN,
          body={'cadence': 'daily', 'max_brands': 3, 'query_cap': 9})
    assert _call(tables, lambda_context, 'GET', '/radar')[1]['settings']['cadence'] == 'daily'


def test_the_cached_overview_follows_new_radar_reviews(tables, lambda_context):
    from shared.data_version import bump_radar_version
    radar, _ = tables
    assert _call(tables, lambda_context, 'GET', '/radar')[1]['brands'][0]['total'] == 3
    store_item(radar, 'acme', radar_item(_review(9, 'negative', 'billing', 'Again'), 'acme', 'Acme'))
    # Unbumped, the memo still answers 3: the processor's per-batch bump is what moves it.
    assert _call(tables, lambda_context, 'GET', '/radar')[1]['brands'][0]['total'] == 3
    bump_radar_version(radar)
    assert _call(tables, lambda_context, 'GET', '/radar')[1]['brands'][0]['total'] == 4
