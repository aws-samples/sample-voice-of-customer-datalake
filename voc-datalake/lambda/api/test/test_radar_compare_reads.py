"""radar_handler: the compare route reads the brand list once, and the table object is reused (moto).

The compare route used to read the brand list and the source profiles twice per
request (once to find the brand, once for the Radar source ids), and every
``get_radar_table()`` rebuilt boto3's Table class. Pins: one read of each, the same
answer as before (``test_radar_handler`` pins the payload), and one Table per resource.
"""
from unittest.mock import MagicMock, patch

import pytest
from test_radar_handler import _call, radar_tables

import radar_handler
from shared.radar_store import radar_item, store_item


@pytest.fixture
def tables():
    with radar_tables() as (radar, aggregates):
        review = {'feedback_id': 'f1', 'date': '2026-01-01', 'category': 'delivery', 'subcategory': None,
                  'sentiment_label': 'positive', 'direct_customer_quote': 'Fast', 'source_platform': 'rival_reviews'}
        store_item(radar, 'acme', radar_item(review, 'acme', 'Acme'))
        yield radar, aggregates


def test_compare_reads_the_brand_list_and_profiles_once(tables, lambda_context):
    with patch.object(radar_handler, 'load_brand_list', wraps=radar_handler.load_brand_list) as brand_list, \
            patch.object(radar_handler, 'load_source_profiles', wraps=radar_handler.load_source_profiles) as profiles:
        status, body, _ = _call(tables, lambda_context, 'GET', '/radar/brands/acme/compare', query={'days': '365'})

    assert status == 200
    assert body['brand']['key'] == 'acme'
    assert brand_list.call_count == 1
    assert profiles.call_count == 1


def test_compare_still_answers_404_for_an_unknown_brand(tables, lambda_context):
    status, _, _ = _call(tables, lambda_context, 'GET', '/radar/brands/nobody/compare')
    assert status == 404


def test_one_table_object_per_resource_and_name():
    first, second = MagicMock(), MagicMock()

    assert radar_handler._table(first, 'voc-radar') is radar_handler._table(first, 'voc-radar')
    assert radar_handler._table(second, 'voc-radar') is not radar_handler._table(first, 'voc-radar')
    first.Table.assert_called_once_with('voc-radar')
