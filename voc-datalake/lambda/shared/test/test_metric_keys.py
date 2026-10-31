"""`shared.metric_keys.source_keyed_counts`: the `<source>#<value>` counter keys of the per-source metrics."""
from shared.metric_keys import source_keyed_counts


def test_splits_on_the_last_hash_so_a_source_name_may_contain_one():
    counts = {'web#high': 3, 'web#reviews#low': 2}
    assert sorted(source_keyed_counts(counts)) == [('web', 'high', 3), ('web#reviews', 'low', 2)]


def test_skips_a_key_without_a_source_part():
    assert list(source_keyed_counts({'#high': 4, 'high': 1})) == []


def test_leaves_judging_the_value_to_the_caller():
    # An empty value is yielded as is: each caller keeps only the values it knows.
    assert list(source_keyed_counts({'app#': 2})) == [('app', '', 2)]
