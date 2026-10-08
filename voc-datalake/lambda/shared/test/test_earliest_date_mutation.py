"""Mutation hardening for `shared/earliest_date.py`.

The module has no test file of its own: the aggregator, the metrics routes and
`remove_ttl.py` exercise it only through their own tests, and those pin the
watermark's KEY and the condition expression but not the module's remaining
contract. A mutation run found what they cannot see:

* `parse_iso_date` accepts ONLY a ten-character 'YYYY-MM-DD' string. Without the
  length guard, `date.fromisoformat` also accepts the basic form ``'20250115'``
  (and with ``and`` in place of ``or`` a non-string reaches ``len()``). Both
  the rejected shapes and the one accepted shape are pinned as literals here.
* `earliest_date_from_item` reads BOTH item shapes: the deserialised one and the
  low-level wire shape ``{'S': '2025-01-15'}`` that a `ClientError`'s
  ``ALL_OLD`` item carries. The wire shape's attribute key (``'S'``), the
  attribute name (``'date'``) and the non-Mapping refusals were unpinned.
* `lower_watermark_request` is a dict of literals the aggregator and the
  retention script send to DynamoDB verbatim; every key, expression and
  placeholder is pinned by one whole-dict equality.
"""
from datetime import date

import pytest

from shared.earliest_date import (
    EARLIEST_DATE_ATTRIBUTE,
    EARLIEST_DATE_KEY,
    EARLIEST_DATE_PK,
    EARLIEST_DATE_SK,
    earliest_date_from_item,
    lower_watermark_request,
    parse_iso_date,
)


class TestTheWatermarkLivesAtOneFixedKey:
    def test_the_partition_and_sort_keys(self):
        assert EARLIEST_DATE_PK == 'METRIC#meta'
        assert EARLIEST_DATE_SK == 'earliest_date'
        assert EARLIEST_DATE_KEY == {'pk': 'METRIC#meta', 'sk': 'earliest_date'}

    def test_the_attribute_name(self):
        assert EARLIEST_DATE_ATTRIBUTE == 'date'


class TestOnlyATenCharacterIsoDateParses:
    @pytest.mark.parametrize(('value', 'expected'), [
        ('2025-01-15', date(2025, 1, 15)),
        ('2024-12-31', date(2024, 12, 31)),
        ('2024-02-29', date(2024, 2, 29)),
    ])
    def test_a_calendar_date_string_parses(self, value, expected):
        assert parse_iso_date(value) == expected

    @pytest.mark.parametrize('value', [
        '20250115',       # eight characters: the basic ISO form fromisoformat would take
        '2025-01-1',      # nine
        '2025-01-15 ',    # eleven
        '2025-01-15T00:00:00',
        '2025-13-01',     # ten characters, not a date
        '2025-02-30',
        'not-a-date',     # ten characters, not a date
        '',
    ])
    def test_a_wrong_length_or_non_date_string_is_none(self, value):
        assert parse_iso_date(value) is None

    @pytest.mark.parametrize('value', [
        None,
        20250115,
        date(2025, 1, 15),
        ['2025-01-15'],
        {'S': '2025-01-15'},
        b'2025-01-15',
    ])
    def test_a_non_string_is_none_without_measuring_it(self, value):
        assert parse_iso_date(value) is None


class TestTheItemReaderAcceptsBothItemShapes:
    @pytest.mark.parametrize('item', [
        {'pk': 'METRIC#meta', 'sk': 'earliest_date', 'date': '2025-01-15'},
        {'date': '2025-01-15'},
        {'pk': {'S': 'METRIC#meta'}, 'date': {'S': '2025-01-15'}},
    ])
    def test_the_date_is_read_from_the_date_attribute(self, item):
        assert earliest_date_from_item(item) == '2025-01-15'

    @pytest.mark.parametrize('item', [
        {},
        {'pk': 'METRIC#meta', 'sk': 'earliest_date'},
        {'DATE': '2025-01-15'},
        {'earliest_date': '2025-01-15'},
        {'date': None},
        {'date': 20250115},
        {'date': '20250115'},
        {'date': 'not-a-date'},
        {'date': {'N': '20250115'}},
        {'date': {'s': '2025-01-15'}},
        {'date': {'S': 'not-a-date'}},
        {'date': {'S': {'S': '2025-01-15'}}},
        {'date': {}},
    ])
    def test_an_absent_or_malformed_date_is_none(self, item):
        assert earliest_date_from_item(item) is None

    @pytest.mark.parametrize('item', [
        None,
        '2025-01-15',
        ['2025-01-15'],
        [('date', '2025-01-15')],
        42,
    ])
    def test_a_non_mapping_item_is_none_without_being_indexed(self, item):
        assert earliest_date_from_item(item) is None


class TestTheLoweringRequestIsSentVerbatim:
    def test_the_whole_update_item_request(self):
        assert lower_watermark_request('2025-01-15', '2025-06-01T12:00:00+00:00') == {
            'Key': {'pk': 'METRIC#meta', 'sk': 'earliest_date'},
            'UpdateExpression': 'SET #date = :date, updated_at = :now',
            'ConditionExpression': 'attribute_not_exists(#date) OR #date > :date',
            'ExpressionAttributeNames': {'#date': 'date'},
            'ExpressionAttributeValues': {':date': '2025-01-15', ':now': '2025-06-01T12:00:00+00:00'},
            'ReturnValuesOnConditionCheckFailure': 'ALL_OLD',
        }

    def test_the_key_is_a_copy_the_caller_may_mutate(self):
        request = lower_watermark_request('2025-01-15', '2025-06-01T12:00:00+00:00')
        request['Key']['sk'] = 'something-else'
        assert EARLIEST_DATE_KEY == {'pk': 'METRIC#meta', 'sk': 'earliest_date'}
        assert lower_watermark_request('2025-01-15', 'now')['Key'] == {'pk': 'METRIC#meta', 'sk': 'earliest_date'}
