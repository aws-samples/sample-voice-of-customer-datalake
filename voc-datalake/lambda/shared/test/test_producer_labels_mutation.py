"""Mutation hardening for `shared/producer_labels.py`.

`test_producer_labels.py` covers the happy paths of the ingest and save halves,
but a mutation run found what it could not see:

* `normalise_label_fields` — the in-place normaliser `POST /scrapers` and the
  feedback-form save call — had no test at all: when it reads the stored
  dimensions config, which fields it rewrites (and that it adds none), the 400
  it raises for a bad value and the 500 (with its log line) when the config
  cannot be read.
* the WORDING of every save-side refusal: the handlers return `str(exc)` as the
  400 body, so each message is pinned here as a literal.
* the accepted side of the `dimension_defaults` bound (exactly 10 entries).
* the ingest half's input caps and skips: a `None` value is skipped, not the
  end of the mapping, and only the first 100 raw tags are looked at.
"""
import re
from types import MappingProxyType
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import BotoCoreError, ClientError

from shared.dimension_config import DIMENSIONS_SETTINGS_KEY, MAX_DIMENSIONS
from shared.exceptions import ServiceError, ValidationError
from shared.producer_labels import clean_dimensions, clean_tags, normalise_label_fields, validate_label_config

_STORED = [{'key': 'product', 'values': [{'name': 'app'}, {'name': 'web'}]}]


def _table(dimensions: Any = None) -> MagicMock:
    table = MagicMock()
    table.get_item.return_value = {'Item': {'dimensions': _STORED if dimensions is None else dimensions}}
    return table


def _failing_table(error: Exception) -> MagicMock:
    table = MagicMock()
    table.get_item.side_effect = error
    return table


class TestIngestCaps:
    def test_a_none_value_is_skipped_not_the_end_of_the_mapping(self):
        assert clean_dimensions({'none': None, 'nested': [1], 'product': 'app'}) == {'product': 'app'}

    def test_only_the_first_hundred_raw_tags_are_looked_at(self):
        assert clean_tags([7] * 100 + ['late']) == []
        assert clean_tags([7] * 99 + ['last']) == ['last']


class TestEverySaveRefusalNamesItsCause:
    @pytest.mark.parametrize(('defaults', 'message'), [
        (['product'], 'dimension_defaults must be an object'),
        ({f'k{i}': 'v' for i in range(MAX_DIMENSIONS + 1)}, 'dimension_defaults accepts at most 10 entries'),
        ({'product': 3}, 'dimension_defaults must map dimension keys to value names'),
        ({'module': 'x'}, 'dimension_defaults names an unknown dimension "module"'),
        ({'product': 'tv'}, 'dimension_defaults: "tv" is not a value of dimension "product"'),
    ])
    def test_message(self, defaults, message):
        with pytest.raises(ValueError, match=f'^{re.escape(message)}$'):
            validate_label_config({'dimension_defaults': defaults}, _STORED)

    def test_exactly_ten_defaults_are_accepted_without_a_config(self):
        defaults = {f'k{i}': 'v' for i in range(MAX_DIMENSIONS)}
        assert validate_label_config({'dimension_defaults': defaults}) == {'dimension_defaults': defaults, 'tags': []}


class TestNormaliseLabelFields:
    def test_a_body_naming_neither_field_is_untouched_and_reads_nothing(self):
        table, entry = _table(), {'name': 'shop'}
        normalise_label_fields(table, entry)
        assert entry == {'name': 'shop'}
        table.get_item.assert_not_called()

    def test_only_defaults_are_normalised_against_the_stored_config(self):
        table, entry = _table(), {'name': 'shop', 'dimension_defaults': MappingProxyType({'product': 'web'})}
        normalise_label_fields(table, entry)
        assert entry == {'name': 'shop', 'dimension_defaults': {'product': 'web'}}
        assert type(entry['dimension_defaults']) is dict
        table.get_item.assert_called_once_with(Key=DIMENSIONS_SETTINGS_KEY, ConsistentRead=True)

    def test_only_tags_are_normalised(self):
        table, entry = _table(), {'tags': [' vip ', 'VIP', 'beta']}
        normalise_label_fields(table, entry)
        assert entry == {'tags': ['vip', 'beta']}
        table.get_item.assert_called_once_with(Key=DIMENSIONS_SETTINGS_KEY, ConsistentRead=True)

    def test_an_unconfigured_dimension_is_a_400(self):
        with pytest.raises(ValidationError) as caught:
            normalise_label_fields(_table(), {'dimension_defaults': {'module': 'x'}})
        assert caught.value.message == 'dimension_defaults names an unknown dimension "module"'
        assert caught.value.status_code == 400

    @pytest.mark.parametrize(('table', 'cause_type'), [
        (_failing_table(ClientError({'Error': {'Code': 'Throttled', 'Message': 'slow'}}, 'GetItem')), ClientError),
        (_failing_table(BotoCoreError()), BotoCoreError),
        (_table([{'key': 'Bad Key'}]), ValueError),  # a stored row that no longer validates
    ], ids=['client-error', 'botocore-error', 'invalid-stored-row'])
    def test_an_unreadable_config_is_a_logged_500(self, table: MagicMock, cause_type: type[Exception]):
        entry = {'tags': ['vip']}
        with patch('shared.producer_labels.logger') as logger, pytest.raises(ServiceError) as caught:
            normalise_label_fields(table, entry)
        assert caught.value.message == 'Dimension settings could not be read'
        assert caught.value.status_code == 500
        assert type(caught.value.__cause__) is cause_type
        mock_logger: MagicMock = logger
        mock_logger.exception.assert_called_once_with('Dimensions config could not be read to validate a save')
        assert entry == {'tags': ['vip']}
