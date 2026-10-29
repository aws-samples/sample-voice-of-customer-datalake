"""Mutation hardening for `shared/retention.py`.

`test_retention.py` and the worker's moto suite only checked that the filters
were built (``is not None``) and that one archive went away. The mutation run
showed nothing pinned the filters' exact clauses (the ``FEEDBACK#`` prefix, the
``|`` between sources, the source scope of an erasure, the de-duplicated email
spellings), the retention-day boundary (0 vs 1, non-int values), the
1,000-version batch size of a raw delete, the exact-key filter on a listed
version, the refusal on a partial S3 failure, or the order "raw archive first,
item second". These tests pin each with literal values.
"""
from __future__ import annotations

from datetime import date
from typing import Any, Final
from unittest.mock import MagicMock, call, patch

import pytest
from boto3.dynamodb.conditions import Attr

from shared import retention
from shared.retention import (
    _delete_all_versions,
    delete_item,
    erase_filter,
    item_raw_key,
    retention_cutoffs,
    retention_filter,
)

BUCKET = 'bkt'
KEY = 'raw/web/2026/01/01/r1.json'
FEEDBACK = Attr('sk').begins_with('FEEDBACK#')
ITEM: Final = {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#r1', 'source_id': 'r1', 's3_raw_uri': f's3://{BUCKET}/{KEY}'}


def _s3(*pages: dict[str, Any], responses: list[dict[str, Any]] | None = None) -> MagicMock:
    s3 = MagicMock()
    s3.get_paginator.return_value.paginate.return_value = list(pages)
    s3.delete_objects.side_effect = responses if responses is not None else [{}] * 5
    return s3


def _version(key: str, version_id: str | None) -> dict[str, Any]:
    return {'Key': key, 'VersionId': version_id}


class TestRetentionCutoffs:
    @pytest.mark.parametrize(('days', 'expected'), [
        (1, {'src': '2026-03-30'}),
        (365, {'src': '2025-03-31'}),
        (0, {}),
        (-5, {}),
        ('30', {}),
        (30.0, {}),
        (False, {}),
        (None, {}),
    ])
    def test_only_a_positive_int_sets_a_cutoff(self, days: object, expected: dict[str, str]) -> None:
        assert retention_cutoffs([{'id': 'src', 'retention_days': days}], date(2026, 3, 31)) == expected

    def test_the_id_is_stringified_and_every_profile_counts(self) -> None:
        profiles = [{'id': 7, 'retention_days': 2}, {'id': 'b', 'retention_days': 10}]
        assert retention_cutoffs(profiles, date(2026, 1, 10)) == {'7': '2026-01-08', 'b': '2025-12-31'}


class TestFiltersAreExact:
    def test_one_retained_source(self) -> None:
        expected = FEEDBACK & (Attr('source_platform').eq('a') & Attr('date').lt('2026-01-01'))
        assert retention_filter({'a': '2026-01-01'}) == expected

    def test_several_sources_are_ored_in_order(self) -> None:
        a = Attr('source_platform').eq('a') & Attr('date').lt('2026-01-01')
        b = Attr('source_platform').eq('b') & Attr('date').lt('2026-02-01')
        c = Attr('source_platform').eq('c') & Attr('date').lt('2026-03-01')
        cutoffs = {'a': '2026-01-01', 'b': '2026-02-01', 'c': '2026-03-01'}
        assert retention_filter(cutoffs) == FEEDBACK & ((a | b) | c)

    def test_no_source_is_refused(self) -> None:
        with pytest.raises(ValueError, match=r'^retention_filter needs at least one source$'):
            retention_filter({})

    @pytest.mark.parametrize('field', ['author', 'source_id', 'csv_row_id'])
    def test_a_plain_field_matches_by_equality(self, field: str) -> None:
        assert erase_filter(field, 'Jane', None) == FEEDBACK & Attr(field).eq('Jane')

    def test_a_source_scopes_the_erasure(self) -> None:
        expected = (FEEDBACK & Attr('author').eq('Jane')) & Attr('source_platform').eq('tickets')
        assert erase_filter('author', 'Jane', 'tickets') == expected

    def test_an_empty_source_does_not_scope(self) -> None:
        assert erase_filter('author', 'Jane', '') == FEEDBACK & Attr('author').eq('Jane')

    @pytest.mark.parametrize(('value', 'spellings'), [
        (' Jane@Example.COM ', ['jane@example.com', ' Jane@Example.COM ']),
        ('jane@example.com', ['jane@example.com']),
    ])
    def test_an_email_matches_both_paths_and_both_spellings(self, value: str, spellings: list[str]) -> None:
        match = Attr('metadata.email').is_in(spellings) | Attr('metadata.submitter_email').is_in(spellings)
        assert erase_filter('email', value, None) == FEEDBACK & match

    def test_an_unknown_field_is_refused_by_name(self) -> None:
        with pytest.raises(ValueError, match=r'^Unknown erasure field "text"$'):
            erase_filter('text', 'x', None)


class TestItemRawKey:
    @pytest.mark.parametrize(('item', 'bucket', 'expected'), [
        ({'s3_raw_uri': f's3://{BUCKET}//{KEY}', 'source_id': 'r1'}, BUCKET, KEY),
        ({'s3_raw_uri': f's3://{BUCKET}/raw/web/r1', 'source_id': 'r1'}, BUCKET, 'raw/web/r1'),
        ({'s3_raw_uri': f's3://{BUCKET}/raw/r1.json', 'source_id': 'r1'}, BUCKET, 'raw/r1.json'),
        ({'s3_raw_uri': f's3://{BUCKET}/{KEY}', 'source_id': 'r1'}, '', None),
        ({'s3_raw_uri': f's3://{BUCKET}/{KEY}', 'source_id': 1}, BUCKET, None),
        ({'s3_raw_uri': f's3://{BUCKET}/{KEY}'}, BUCKET, None),
        ({'source_id': 'r1'}, BUCKET, None),
        ({'s3_raw_uri': f's3://{BUCKET}/rawweb/r1.json', 'source_id': 'r1'}, BUCKET, None),
        ({'s3_raw_uri': f's3://{BUCKET}/Xraw/web/r1.json', 'source_id': 'r1'}, BUCKET, None),  # only `/` stripped
        ({'s3_raw_uri': f's3://{BUCKET}/raw/web/..r1/r1.json', 'source_id': 'r1'}, BUCKET,
         'raw/web/..r1/r1.json'),
        ({'s3_raw_uri': f's3://{BUCKET}/raw/web/../r1.json', 'source_id': 'r1'}, BUCKET, None),
    ])
    def test_only_the_items_own_archive(self, item: dict[str, Any], bucket: str, expected: str | None) -> None:
        assert item_raw_key(item, bucket) == expected


class TestDeleteAllVersions:
    def test_lists_exactly_the_key_and_deletes_only_its_versions_and_markers(self) -> None:
        s3 = _s3({'Versions': [_version(KEY, 'v1'), _version(f'{KEY}.bak', 'x'), _version(KEY, None)],
                  'DeleteMarkers': [_version(KEY, 'm1')]})
        assert _delete_all_versions(s3, BUCKET, KEY) is True
        s3.get_paginator.assert_called_once_with('list_object_versions')
        s3.get_paginator.return_value.paginate.assert_called_once_with(Bucket=BUCKET, Prefix=KEY)
        s3.delete_objects.assert_called_once_with(Bucket=BUCKET, Delete={
            'Objects': [{'Key': KEY, 'VersionId': 'v1'}, {'Key': KEY, 'VersionId': 'm1'}], 'Quiet': True})

    @pytest.mark.parametrize('page', [{'Versions': [_version(KEY, 'v1')]}, {'DeleteMarkers': [_version(KEY, 'v1')]}])
    def test_a_page_may_lack_either_list(self, page: dict[str, Any]) -> None:
        s3 = _s3(page)
        assert _delete_all_versions(s3, BUCKET, KEY) is True
        s3.delete_objects.assert_called_once_with(
            Bucket=BUCKET, Delete={'Objects': [{'Key': KEY, 'VersionId': 'v1'}], 'Quiet': True})

    def test_nothing_listed_is_false_and_deletes_nothing(self) -> None:
        s3 = _s3({}, {'Versions': [_version('raw/other.json', 'v1')]})
        assert _delete_all_versions(s3, BUCKET, KEY) is False
        s3.delete_objects.assert_not_called()

    @pytest.mark.parametrize(('count', 'sizes'), [(1000, [1000]), (1001, [1000, 1]), (2001, [1000, 1000, 1])])
    def test_versions_are_deleted_in_batches_of_1000(self, count: int, sizes: list[int]) -> None:
        versions = [_version(KEY, f'v{n}') for n in range(count)]
        s3 = _s3({'Versions': versions})
        assert _delete_all_versions(s3, BUCKET, KEY) is True
        batches = [c.kwargs['Delete']['Objects'] for c in s3.delete_objects.call_args_list]
        assert [len(b) for b in batches] == sizes
        assert [o['VersionId'] for b in batches for o in b] == [f'v{n}' for n in range(count)]

    def test_every_page_is_deleted(self) -> None:
        s3 = _s3({'Versions': [_version(KEY, 'v1')]}, {'Versions': [_version(KEY, 'v2')]})
        assert _delete_all_versions(s3, BUCKET, KEY) is True
        assert s3.delete_objects.call_count == 2

    def test_a_partial_failure_raises_with_the_count(self) -> None:
        s3 = _s3({'Versions': [_version(KEY, 'v1')]}, responses=[{'Errors': [{'Key': KEY}, {'Key': KEY}]}])
        with pytest.raises(RuntimeError, match=r'^2 raw object versions could not be deleted$'):
            _delete_all_versions(s3, BUCKET, KEY)


class TestDeleteItem:
    def test_archive_then_item_and_both_counted(self) -> None:
        order = MagicMock()
        s3 = _s3({'Versions': [_version(KEY, 'v1')]})
        order.attach_mock(s3.delete_objects, 's3_delete')
        order.attach_mock(order.table.delete_item, 'table_delete')
        with patch.object(retention, 'logger') as logger:
            assert delete_item(order.table, s3, BUCKET, ITEM) == (1, 1)
        assert [c[0] for c in order.mock_calls] == ['s3_delete', 'table_delete']
        assert order.mock_calls[1] == call.table_delete(Key={'pk': 'SOURCE#web', 'sk': 'FEEDBACK#r1'})
        logger.debug.assert_called_once_with('Deleted one feedback item under its retention / erasure rule')

    def test_no_listed_version_counts_no_object(self) -> None:
        table, s3 = MagicMock(), _s3({})
        assert delete_item(table, s3, BUCKET, ITEM) == (1, 0)
        table.delete_item.assert_called_once_with(Key={'pk': 'SOURCE#web', 'sk': 'FEEDBACK#r1'})

    def test_an_item_without_its_own_archive_never_touches_s3(self) -> None:
        table, s3 = MagicMock(), _s3()
        item = {**ITEM, 's3_raw_uri': f's3://{BUCKET}/raw/csv_upload/2026/01/01/r1.json'}
        assert delete_item(table, s3, BUCKET, item) == (1, 0)
        s3.get_paginator.assert_not_called()
        table.delete_item.assert_called_once_with(Key={'pk': 'SOURCE#web', 'sk': 'FEEDBACK#r1'})

    def test_a_failed_archive_delete_keeps_the_item(self) -> None:
        table = MagicMock()
        s3 = _s3({'Versions': [_version(KEY, 'v1')]}, responses=[{'Errors': [{'Key': KEY}]}])
        with pytest.raises(RuntimeError, match=r'^1 raw object versions could not be deleted$'):
            delete_item(table, s3, BUCKET, ITEM)
        table.delete_item.assert_not_called()
