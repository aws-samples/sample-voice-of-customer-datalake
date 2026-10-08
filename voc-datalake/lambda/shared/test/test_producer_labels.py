"""`shared/producer_labels.py`: producer dimension values and tags (save + ingest halves)."""
import pytest

from shared.dimension_config import validate_dimensions
from shared.producer_labels import clean_dimensions, clean_tags, message_labels, validate_label_config

# One configured dimension is enough: the save half checks keys and values against it.
_DIMENSIONS = validate_dimensions([{'key': 'product', 'values': [{'name': 'app'}, {'name': 'web'}]}])


def test_clean_dimensions_keeps_well_formed_pairs_stringified():
    raw = {'product': 'app', 'year': 2026, 'Bad Key': 'x', 'module': 'has space', 'nested': {'a': 1}, 'none': None}
    assert clean_dimensions(raw) == {'product': 'app', 'year': '2026'}


def test_clean_dimensions_caps_the_count_and_ignores_non_mappings():
    assert len(clean_dimensions({f'k{i}': 'v' for i in range(15)})) == 10
    assert clean_dimensions(['product']) == {}


@pytest.mark.parametrize(('raw', 'expected'), [
    ('vip; beta ,VIP,,', ['vip', 'beta']),
    (['a', 'A', 'bad#tag', 3, 'b'], ['a', 'b']),
    (None, []),
    ({'a': 1}, []),
])
def test_clean_tags(raw, expected):
    assert clean_tags(raw) == expected


def test_clean_tags_caps_at_twenty():
    assert len(clean_tags([f't{i}' for i in range(30)])) == 20


def test_message_labels_omits_empty_halves():
    assert message_labels({'product': 'app'}, []) == {'dimensions': {'product': 'app'}}
    assert message_labels(None, 'x') == {'tags': ['x']}
    assert message_labels() == {}


def test_validate_label_config_normalises():
    entry = {'dimension_defaults': {'product': 'web'}, 'tags': [' vip ', 'VIP']}
    assert validate_label_config(entry, _DIMENSIONS) == {'dimension_defaults': {'product': 'web'}, 'tags': ['vip']}
    assert validate_label_config({}) == {'dimension_defaults': {}, 'tags': []}


@pytest.mark.parametrize(('entry', 'message'), [
    ({'dimension_defaults': ['product']}, 'must be an object'),
    ({'dimension_defaults': {'product': 3}}, 'map dimension keys'),
    ({'dimension_defaults': {'Product': 'app'}}, 'map dimension keys'),
    ({'dimension_defaults': {'module': 'x'}}, 'unknown dimension "module"'),
    ({'dimension_defaults': {'product': 'tv'}}, '"tv" is not a value'),
    ({'dimension_defaults': {f'k{i}': 'v' for i in range(11)}}, 'at most 10'),
    ({'tags': ['a#b']}, 'Tags must be'),
])
def test_validate_label_config_refusals(entry, message):
    with pytest.raises(ValueError, match=message):
        validate_label_config(entry, _DIMENSIONS)


def test_without_a_config_only_the_shape_is_checked():
    assert validate_label_config({'dimension_defaults': {'module': 'x'}})['dimension_defaults'] == {'module': 'x'}
