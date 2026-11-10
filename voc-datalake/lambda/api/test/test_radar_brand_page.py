"""radar_handler: GET /radar/brands/<brand>/page, the Radar page's one read for a brand (moto).

The page used to ask for the detail, the releases and the compare at once: three requests,
so a cold function took a second cold start for whichever request its one busy environment
could not take (CloudWatch, 2026-10-25: Radar's first load paid two Init Durations of 1.3
and 1.4 s, one after the other). Pins: the page answer IS the three views (same bodies),
from one read of the brand list and the profiles, and the same scope rules (404 when hidden).
"""
from unittest.mock import patch

import pytest
from test_radar_handler import _call, _review, radar_tables

import radar_handler
from shared.radar_store import radar_item, store_item


@pytest.fixture
def page_tables():
    with radar_tables() as (radar, aggregates):
        for n, (label, category) in enumerate([('positive', 'delivery'), ('negative', 'billing')]):
            store_item(radar, 'acme', radar_item(_review(n, label, category, f'Quote {n}'), 'acme', 'Acme'))
        yield radar, aggregates


def test_the_brand_page_is_detail_releases_and_compare_in_one_answer(page_tables, lambda_context):
    status, page, _ = _call(page_tables, lambda_context, 'GET', '/radar/brands/acme/page', query={'days': '30'})
    assert status == 200
    _, detail, _ = _call(page_tables, lambda_context, 'GET', '/radar/brands/acme', query={'days': '30'})
    _, releases, _ = _call(page_tables, lambda_context, 'GET', '/radar/brands/acme/releases')
    _, compare, _ = _call(page_tables, lambda_context, 'GET', '/radar/brands/acme/compare', query={'days': '30'})
    assert page == {'detail': detail, 'releases': releases, 'compare': compare}
    # Releases keep their own year, whatever window the page shows.
    assert (page['detail']['days'], page['releases']['days']) == (30, radar_handler.DEFAULT_RELEASE_DAYS)


def test_the_brand_page_reads_the_brand_list_and_profiles_once(page_tables, lambda_context):
    with patch.object(radar_handler, 'load_brand_list', wraps=radar_handler.load_brand_list) as brand_list, \
            patch.object(radar_handler, 'load_source_profiles', wraps=radar_handler.load_source_profiles) as profiles:
        status, _, _ = _call(page_tables, lambda_context, 'GET', '/radar/brands/acme/page')
    assert status == 200
    assert (brand_list.call_count, profiles.call_count) == (1, 1)


def test_the_brand_page_of_a_hidden_or_unknown_brand_is_a_404(page_tables, lambda_context):
    assert _call(page_tables, lambda_context, 'GET', '/radar/brands/globex/page')[0] == 404
    assert _call(page_tables, lambda_context, 'GET', '/radar/brands/nope/page')[0] == 404
