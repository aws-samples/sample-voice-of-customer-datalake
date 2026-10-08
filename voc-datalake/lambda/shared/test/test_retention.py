"""`shared/retention.py`: which raw object is an item's own, filters, cutoffs."""
import hashlib
from datetime import date

import pytest

from shared.archive_keys import archive_key_stem
from shared.retention import erase_filter, item_raw_key, retention_cutoffs, retention_filter, value_hash

B = 'bkt'


@pytest.mark.parametrize(('uri', 'source_id', 'expected'), [
    ('s3://bkt/raw/web/2026/01/01/r1.json', 'r1', 'raw/web/2026/01/01/r1.json'),
    ('s3://bkt/raw/web/2026/01/01/a_b.json', 'a_b', 'raw/web/2026/01/01/a_b.json'),
    ('s3://bkt/raw/web/2026/01/01/a_b.json', 'a/b', None),       # `a_b`'s archive, not `a/b`'s
    ('s3://bkt/raw/web/2026/01/01/other.json', 'r1', None),       # not this item's archive
    ('s3://bkt/raw/csv_upload/2026/01/01/r1.json', 'r1', None),   # whole-upload archive
    ('s3://bkt/raw/json_upload/2026/01/01/r1.json', 'r1', None),
    ('s3://other/raw/web/2026/01/01/r1.json', 'r1', None),        # foreign bucket
    ('s3://bkt/avatars/r1.json', 'r1', None),                     # outside raw/
    ('s3://bkt/raw/../avatars/r1.json', 'r1', None),
    ('https://bkt/raw/web/r1.json', 'r1', None),
    (None, 'r1', None),
    ('s3://bkt/raw/web/2026/01/01/r1.json', '', None),
])
def test_item_raw_key(uri, source_id, expected):
    assert item_raw_key({'s3_raw_uri': uri, 'source_id': source_id}, B) == expected


def test_ids_that_once_shared_a_key_each_match_only_their_own_archive():
    """`a/b` and `a_b` (and two ids equal in their first 64 chars) used to be one key; the writers now
    give `a/b` / the long ids a sha256 stem, and the matcher tells them apart."""
    for first, second in [('a/b', 'a_b'), ('q' * 64 + '1', 'q' * 64 + '2')]:
        first_key, second_key = (f'raw/web/2026/01/01/{archive_key_stem(i)}.json' for i in (first, second))
        assert first_key != second_key
        assert item_raw_key({'s3_raw_uri': f's3://{B}/{first_key}', 'source_id': first}, B) == first_key
        assert item_raw_key({'s3_raw_uri': f's3://{B}/{second_key}', 'source_id': first}, B) is None


def test_writer_and_matcher_agree_on_the_hashed_stem():
    key = f'raw/web/2026/01/01/h.{hashlib.sha256(b"a/b").hexdigest()}.json'
    assert item_raw_key({'s3_raw_uri': f's3://{B}/{key}', 'source_id': 'a/b'}, B) == key


def test_cutoffs_only_for_profiles_with_a_retention_period():
    profiles = [{'id': 'a', 'retention_days': 30}, {'id': 'b', 'retention_days': None}, {'id': 'c'},
                {'id': 'd', 'retention_days': True}]
    assert retention_cutoffs(profiles, date(2026, 3, 31)) == {'a': '2026-03-01'}


def test_filters_build_and_refuse_bad_input():
    assert retention_filter({'a': '2026-01-01', 'b': '2026-02-01'}) is not None
    assert erase_filter('email', 'x', 'src') is not None
    with pytest.raises(ValueError, match='at least one source'):
        retention_filter({})
    with pytest.raises(ValueError, match='Unknown erasure field'):
        erase_filter('text', 'x', None)


def test_value_hash_is_sha256_hex():
    assert value_hash('a') == 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb'
