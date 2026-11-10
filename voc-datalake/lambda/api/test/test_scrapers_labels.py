"""POST /scrapers: `dimension_defaults` and `tags` are validated against the dimensions config."""
from unittest.mock import MagicMock, patch

import pytest

import scrapers_handler
from shared.exceptions import ServiceError, ValidationError

SCRAPER = {'id': 's1', 'name': 'Shop', 'urls': ['https://reviews.example/a']}
DIMENSIONS = {'dimensions': [{'key': 'product', 'values': [{'name': 'app'}]}]}


def _validated(scraper: dict, stored: object) -> dict:
    table = MagicMock()
    table.get_item.return_value = {'Item': stored}
    with patch.object(scrapers_handler, 'validate_url', return_value=(True, '')), \
            patch.object(scrapers_handler, 'get_aggregates_table', return_value=table):
        return scrapers_handler._validated_scraper({'scraper': scraper})


def test_labels_are_normalised():
    out = _validated({**SCRAPER, 'dimension_defaults': {'product': 'app'}, 'tags': ['x', 'X']}, DIMENSIONS)
    assert (out['dimension_defaults'], out['tags']) == ({'product': 'app'}, ['x'])


def test_a_scraper_without_labels_reads_no_config():
    table = MagicMock()
    with patch.object(scrapers_handler, 'validate_url', return_value=(True, '')), \
            patch.object(scrapers_handler, 'get_aggregates_table', return_value=table):
        assert scrapers_handler._validated_scraper({'scraper': dict(SCRAPER)}) == SCRAPER
    table.get_item.assert_not_called()


def test_an_unknown_value_is_a_400():
    with pytest.raises(ValidationError, match='is not a value'):
        _validated({**SCRAPER, 'dimension_defaults': {'product': 'web'}}, DIMENSIONS)


def test_a_corrupt_config_is_a_500():
    with pytest.raises(ServiceError):
        _validated({**SCRAPER, 'tags': ['x']}, {'dimensions': 'corrupt'})
