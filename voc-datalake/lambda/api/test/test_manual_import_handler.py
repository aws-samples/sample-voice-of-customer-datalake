"""
Tests for manual_import_handler.py - /scrapers/manual/* endpoints.

The route-by-route behaviour (every refusal's wording, every AWS call, every
bound) is pinned in `test_manual_import_handler_mutation.py`; this file keeps
the input-trimming check and the `decimal_default` serializer tests.
"""
from unittest.mock import MagicMock, patch

import pytest
from handler_events_fixtures import call_route

from manual_import_handler import lambda_handler


class TestStartParseEndpoint:
    """POST /scrapers/manual/parse."""

    @patch('manual_import_handler.invoke_lambda_async', new=MagicMock())
    @patch('manual_import_handler.aggregates_table')
    @patch('manual_import_handler.MANUAL_IMPORT_PROCESSOR_FUNCTION', 'test-processor')
    def test_trims_whitespace_from_inputs(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Trims whitespace from source_url and raw_text."""
        _response, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='POST',
            path='/scrapers/manual/parse',
            body={
                'source_url': '  https://g2.com/review/example  ',
                'raw_text': '  Great product!  '
            },
        )

        assert body['success'] is True
        # Verify the put_item was called with trimmed values
        call_args = mock_table.put_item.call_args
        item = call_args[1]['Item']
        assert item['source_url'] == 'https://g2.com/review/example'
        assert item['raw_text'] == 'Great product!'


class TestDecimalDefault:
    """Tests for decimal_default JSON serializer."""

    def test_converts_decimal_to_float(self):
        """Converts Decimal to float for JSON serialization."""
        from decimal import Decimal

        from shared.api import decimal_default

        assert decimal_default(Decimal('3.14')) == 3.14
        assert decimal_default(Decimal('100')) == 100.0

    def test_raises_type_error_for_non_decimal(self):
        """Raises TypeError for non-Decimal types."""
        from shared.api import decimal_default

        with pytest.raises(TypeError):
            decimal_default({'key': 'value'})
