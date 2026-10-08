"""Per-dimension-value, per-dimension-sentiment and per-tag daily counters."""
import pytest

from aggregator.handler import (
    channel_bucket,
    counter_dimensions,
    counter_keys,
    counter_transaction_items,
    dimension_buckets,
    get_metric_type,
    tag_buckets,
)

ITEM = {
    'category': 'billing', 'sentiment_label': 'negative', 'urgency': 'high', 'subcategory': 'refund',
    'dimensions': {'product': 'App', 'module': 'checkout'},
    'tags': ['VIP', 'vip', ' Beta Users '],
}


def test_each_dimension_value_and_tag_has_its_rows():
    pks = {pk for pk, _ in counter_dimensions(ITEM)}
    assert {
        'METRIC#daily_dim#product#App', 'METRIC#daily_dim_sentiment#product#App#negative',
        'METRIC#daily_dim#module#checkout', 'METRIC#daily_dim_sentiment#module#checkout#negative',
        'METRIC#daily_tag#vip', 'METRIC#daily_tag#beta users',
    } <= pks


def test_no_two_counters_share_an_item():
    """A transaction may name one item once (see test_the_transaction_names_each_item_once)."""
    keys = counter_keys(ITEM, '2026-10-01')
    assert len({(pk, sk) for pk, sk, _ in keys}) == len(keys) == len(counter_transaction_items(keys))


def test_a_full_item_stays_far_inside_the_transaction_limit():
    item = {**ITEM, 'dimensions': {f'd{i}': 'v' for i in range(12)}, 'tags': [f't{i}' for i in range(30)]}
    assert len(counter_keys(item, '2026-10-01')) + 2 <= 100
    assert len(dimension_buckets(item)) == 10
    assert len(tag_buckets(item)) == 20


@pytest.mark.parametrize('dimensions', [None, 'x', {'Product': 'App'}, {'product': 'a#b'}, {'product': 3}])
def test_unsafe_or_absent_dimensions_count_nothing(dimensions):
    assert dimension_buckets({'dimensions': dimensions}) == []


@pytest.mark.parametrize('tags', [None, 'vip', ['a#b', 7, '  ']])
def test_unsafe_or_absent_tags_count_nothing(tags):
    assert tag_buckets({'tags': tags}) == []


def test_a_rebucket_moves_only_the_changed_rows():
    old = {**ITEM, 'tags': []}
    new = {**old, 'dimensions': {'product': 'Web', 'module': 'checkout'}}
    old_keys, new_keys = counter_keys(old, '2026-10-01'), counter_keys(new, '2026-10-01')
    assert {k[0] for k in old_keys - new_keys} == {
        'METRIC#daily_dim#product#App', 'METRIC#daily_dim_sentiment#product#App#negative'}
    assert {k[0] for k in new_keys - old_keys} == {
        'METRIC#daily_dim#product#Web', 'METRIC#daily_dim_sentiment#product#Web#negative'}


def test_the_sentiment_rows_are_on_the_metric_type_index_per_dimension():
    assert get_metric_type('METRIC#daily_dim_sentiment#product#App#negative') == 'dim_sentiment#product'
    assert get_metric_type('METRIC#daily_dim#product#App') is None
    assert get_metric_type('METRIC#daily_tag#vip') == 'tag'
    assert get_metric_type('METRIC#daily_channel#email') == 'channel'


@pytest.mark.parametrize(('channel', 'bucket'), [
    ('email', 'email'), ('', None), ('a#b', None), ('x' * 65, None), (None, None), (3, None)])
def test_the_channel_counter_is_key_safe(channel, bucket):
    assert channel_bucket({'source_channel': channel}) == bucket
    rows = [pk for pk, _ in counter_dimensions({'source_channel': channel}) if pk.startswith('METRIC#daily_channel#')]
    assert rows == ([f'METRIC#daily_channel#{bucket}'] if bucket else [])
