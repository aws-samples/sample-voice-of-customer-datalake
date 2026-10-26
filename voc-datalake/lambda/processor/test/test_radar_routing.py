"""A Radar source's review (another brand, docs/radar.md) goes to voc-radar, never voc-feedback."""
import json
from unittest.mock import MagicMock, patch

import pytest
from moto import mock_aws

from processor import handler
from shared.data_version import BatchBump, bump_radar_version
from shared.radar_routing import BrandLabels, RadarBrandListUnavailableError, UnknownRadarBrandError
from shared.radar_store import counter_pk, is_stored, radar_day
from shared.source_profiles import SourceProfilesUnavailable
from shared.test.radar_fixtures import radar_pk_sk_table

PROFILE = {'id': 'rival_reviews', 'pii': 'redact', 'radar_brand': 'Acme Corp', 'radar_domains': ['acme.com']}
INSIGHTS = {
    'category': 'billing', 'subcategory': 'refund', 'sentiment_label': 'negative', 'sentiment_score': -0.5,
    'urgency': 'low', 'problem_summary': 'Refund slow', 'direct_customer_quote': 'Refund took weeks',
}


def _record(source='rival_reviews', record_id='r1'):
    return {'id': record_id, 'source_platform': source, 'text': 'Refund took weeks',
            'created_at': '2026-10-01T00:00:00Z'}


def _sqs(body):
    return MagicMock(body=json.dumps(body))


@pytest.fixture
def radar_table():
    with mock_aws():
        table = radar_pk_sk_table('radar')
        handler._settings_cache['sources'] = (float('inf'), [PROFILE])
        llm = {'insights': INSIGHTS, 'metadata': {}}
        # Fresh per test: an empty brand-list cache and no batch mark left by another test.
        with patch.object(handler, 'radar_brand_labels', BrandLabels()), \
             patch.object(handler, 'radar_changed', BatchBump(bump_radar_version)), \
             patch.object(handler, 'radar_table', table), \
             patch.object(handler, 'persistence_layer', None), \
             patch.object(handler, 'feedback_table') as feedback, \
             patch.object(handler, 'detect_language', return_value='en'), \
             patch.object(handler, 'translate_text', side_effect=lambda text, *_: text), \
             patch.object(handler, 'get_comprehend_sentiment', return_value={'label': 'neutral', 'score': 0.0}), \
             patch.object(handler, 'invoke_bedrock_llm', return_value=llm) as model, \
             patch.object(handler, 'get_categories_config', return_value=[{'name': 'billing'}]):
            yield table, feedback, model


def test_a_radar_review_lands_in_voc_radar_and_never_touches_voc_feedback(radar_table):
    table, feedback, _ = radar_table
    result = handler.record_handler(_sqs(_record()))
    assert result['status'] == 'success'
    assert result['radar'] is True
    assert feedback.method_calls == []
    assert is_stored(table, 'acme-corp', result['feedback_id'])


def test_the_stored_review_keeps_its_enrichment_and_drops_the_feedback_indexes(radar_table):
    table, _, _ = radar_table
    handler.record_handler(_sqs(_record()))
    items = [row for row in table.scan()['Items'] if row['pk'].startswith('RADAR#acme-corp#ITEMS#')]
    assert len(items) == 1
    item = items[0]
    assert (item['category'], item['sentiment_label'], item['radar_brand_label']) == ('billing', 'negative', 'Acme Corp')
    assert item['pii_policy'] == 'redact'
    assert not {'gsi1pk', 'gsi2pk', 'gsi3pk'} & set(item)


def test_counters_move_once_even_when_the_message_is_redelivered(radar_table):
    table, _, model = radar_table
    handler.record_handler(_sqs(_record()))
    again = handler.record_handler(_sqs(_record()))
    assert again['status'] == 'skipped'
    assert model.call_count == 1
    rows = table.query(KeyConditionExpression='pk = :pk',
                       ExpressionAttributeValues={':pk': counter_pk('acme-corp', 'daily_total')})['Items']
    assert [int(row['count']) for row in rows] == [1]
    by_category = table.query(KeyConditionExpression='pk = :pk', ExpressionAttributeValues={
        ':pk': counter_pk('acme-corp', 'category_sentiment#billing#negative')})['Items']
    assert [int(row['count']) for row in by_category] == [1]


@pytest.mark.usefixtures('radar_table')
def test_an_ordinary_source_still_goes_to_voc_feedback():
    with patch.object(handler, 'process_feedback', return_value=None) as ordinary, \
         patch.object(handler, 'process_radar_record') as radar:
        result = handler.record_handler(_sqs(_record(source='webscraper')))
    assert result == {'status': 'skipped', 'reason': 'duplicate'}
    ordinary.assert_called_once()
    radar.assert_not_called()


def test_unreadable_source_profiles_store_nothing_anywhere(radar_table):
    table, feedback, _ = radar_table
    handler._failed_settings.add('sources')
    with pytest.raises(SourceProfilesUnavailable):
        handler.record_handler(_sqs(_record()))
    assert feedback.method_calls == []
    assert table.scan()['Items'] == []


def test_a_radar_review_without_a_radar_table_is_retried_not_redirected(radar_table):
    _, feedback, _ = radar_table
    with patch.object(handler, 'radar_table', None), pytest.raises(handler.RadarTableUnavailableError):
        handler.record_handler(_sqs(_record()))
    assert feedback.method_calls == []


def test_a_backfilled_review_is_bucketed_by_the_day_it_was_written(radar_table):
    # Regression: a CSV backfill of another brand's reviews was dated by import day, so the
    # whole history piled onto one day of the Radar trend.
    table, _, _ = radar_table
    handler.record_handler(_sqs({**_record(record_id='old'), 'created_at': '2026-09-20T08:00:00Z'}))
    [item] = [r for r in table.scan()['Items'] if '#ITEMS#' in r['pk']]
    assert (item['pk'], item['sk'][:10], item['radar_day']) == ('RADAR#acme-corp#ITEMS#2026-09', '2026-09-20', '2026-09-20')
    assert table.get_item(Key={'pk': counter_pk('acme-corp', 'daily_total'), 'sk': '2026-09-20'}).get('Item')



@pytest.mark.parametrize(('created', 'expected'), [
    ('2026-09-20T08:00:00Z', '2026-09-20'),   # written before the import: its own day
    ('2099-01-01T00:00:00Z', '2026-10-18'),   # after the import day (clock skew): the import day
    ('', '2026-10-18'), ('not a date', '2026-10-18'),  # missing or malformed: the import day
])
def test_radar_day_is_the_written_day_never_after_the_import(created, expected):
    assert radar_day({'date': '2026-10-18', 'source_created_at': created}) == expected


# --- radar_brand_key: a scraper / connector / upload naming a brand on the brand list -------------

def _stamped(key, record_id='s1'):
    return {**_record(source='Initech reviews', record_id=record_id), 'radar_brand_key': key}


def _list_brands(table, *labels):
    table.put_item(Item={'pk': 'SETTINGS#radar', 'sk': 'brands',
                         'brands': [{'label': label, 'domains': []} for label in labels]})


def test_a_stamped_review_goes_to_its_listed_brand(radar_table):
    table, feedback, _ = radar_table
    _list_brands(table, 'Initech')
    result = handler.record_handler(_sqs(_stamped('initech')))
    assert (result['status'], result['radar']) == ('success', True)
    assert is_stored(table, 'initech', result['feedback_id'])
    assert feedback.method_calls == []


def test_a_stamped_key_of_a_legacy_profile_brand_stays_valid(radar_table):
    # Back-compat: prod's profile radar_example_air names Example Air; its key `example-air` keeps working unlisted.
    table, _, _ = radar_table
    handler._settings_cache['sources'] = (float('inf'), [PROFILE, {'id': 'radar_example_air', 'radar_brand': 'Example Air'}])
    _list_brands(table)
    result = handler.record_handler(_sqs(_stamped('example-air')))
    assert is_stored(table, 'example-air', result['feedback_id'])


def test_an_unknown_brand_key_fails_closed(radar_table):
    table, feedback, model = radar_table
    _list_brands(table, 'Initech')
    with pytest.raises(UnknownRadarBrandError):
        handler.record_handler(_sqs(_stamped('nope')))
    assert feedback.method_calls == []
    assert model.call_count == 0
    assert [row for row in table.scan()['Items'] if row['pk'] != 'SETTINGS#radar'] == []


def test_a_brand_listed_after_the_cache_was_filled_is_found_on_a_fresh_read(radar_table):
    table, _, _ = radar_table
    _list_brands(table, 'Initech')
    handler.record_handler(_sqs(_stamped('initech')))
    table.put_item(Item={'pk': 'SETTINGS#radar', 'sk': 'brands', 'brands': [
        {'label': 'Initech', 'domains': []}, {'label': 'Hooli', 'domains': []}]})
    result = handler.record_handler(_sqs(_stamped('hooli', record_id='s2')))
    assert is_stored(table, 'hooli', result['feedback_id'])


def test_an_unreadable_brand_list_fails_closed(radar_table):
    table, feedback, _ = radar_table
    table.put_item(Item={'pk': 'SETTINGS#radar', 'sk': 'brands', 'brands': 'corrupt'})
    with pytest.raises(RadarBrandListUnavailableError):
        handler.record_handler(_sqs(_stamped('initech')))
    assert feedback.method_calls == []


def test_a_stamped_review_without_a_radar_table_is_retried_not_redirected(radar_table):
    _, feedback, _ = radar_table
    with patch.object(handler, 'radar_table', None), pytest.raises(handler.RadarTableUnavailableError):
        handler.record_handler(_sqs(_stamped('initech')))
    assert feedback.method_calls == []


def test_a_malformed_brand_key_is_rejected_by_the_queue_schema(radar_table):
    _, feedback, _ = radar_table
    with pytest.raises(handler.MessageRejectedError):
        handler.record_handler(_sqs(_stamped('Not A Key')))
    assert feedback.method_calls == []


def _radar_version(table) -> int:
    from shared.data_version import RADAR_VERSION_KEY
    item = table.get_item(Key=RADAR_VERSION_KEY).get('Item') or {}
    return int(item.get('v', 0))


def test_a_batch_that_stored_radar_reviews_bumps_the_radar_version_once(radar_table):
    """docs/caching.md: once per SQS batch, never per record."""
    table, _, _ = radar_table
    handler.record_handler(_sqs(_record(record_id='r1')))
    handler.record_handler(_sqs(_record(record_id='r2')))
    handler._bump_after_batch()
    assert _radar_version(table) == 1


def test_a_batch_of_duplicates_leaves_the_radar_version_alone(radar_table):
    table, _, _ = radar_table
    handler.record_handler(_sqs(_record()))
    handler._bump_after_batch()
    handler.record_handler(_sqs(_record()))
    handler._bump_after_batch()
    assert _radar_version(table) == 1
