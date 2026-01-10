"""
Tests for shared/api.py - API utilities for VoC Lambda functions.
"""

import json
import pytest
from decimal import Decimal
from unittest.mock import MagicMock, patch
from datetime import datetime, timezone


class TestDecimalEncoder:
    """Tests for DecimalEncoder JSON encoder."""

    def test_encodes_decimal_as_float(self):
        """Converts Decimal to float in JSON output."""
        from shared.api import DecimalEncoder
        
        data = {'price': Decimal('19.99'), 'count': Decimal('5')}
        result = json.dumps(data, cls=DecimalEncoder)
        
        assert result == '{"price": 19.99, "count": 5.0}'

    def test_encodes_nested_decimals(self):
        """Handles nested Decimal values."""
        from shared.api import DecimalEncoder
        
        data = {'items': [{'score': Decimal('0.85')}, {'score': Decimal('-0.5')}]}
        result = json.dumps(data, cls=DecimalEncoder)
        parsed = json.loads(result)
        
        assert parsed['items'][0]['score'] == 0.85
        assert parsed['items'][1]['score'] == -0.5

    def test_passes_through_non_decimal_types(self):
        """Passes non-Decimal types to default encoder."""
        from shared.api import DecimalEncoder
        
        data = {'name': 'test', 'count': 5, 'active': True}
        result = json.dumps(data, cls=DecimalEncoder)
        
        assert json.loads(result) == data

    def test_raises_for_non_serializable_types(self):
        """Raises TypeError for non-serializable types."""
        from shared.api import DecimalEncoder
        
        data = {'func': lambda x: x}
        
        with pytest.raises(TypeError):
            json.dumps(data, cls=DecimalEncoder)


class TestValidateDays:
    """Tests for validate_days function."""

    def test_returns_valid_integer(self):
        """Returns valid integer within bounds."""
        from shared.api import validate_days
        
        assert validate_days(30) == 30
        assert validate_days('14') == 14

    def test_returns_default_for_none(self):
        """Returns default when value is None."""
        from shared.api import validate_days
        
        assert validate_days(None) == 7
        assert validate_days(None, default=30) == 30

    def test_clamps_to_minimum(self):
        """Clamps value to minimum bound."""
        from shared.api import validate_days
        
        assert validate_days(0) == 1
        assert validate_days(-5) == 1
        assert validate_days(0, min_val=7) == 7

    def test_clamps_to_maximum(self):
        """Clamps value to maximum bound."""
        from shared.api import validate_days
        
        assert validate_days(500) == 365
        assert validate_days(1000, max_val=90) == 90

    def test_returns_default_for_invalid_string(self):
        """Returns default for non-numeric string."""
        from shared.api import validate_days
        
        assert validate_days('invalid') == 7
        assert validate_days('abc', default=14) == 14

    def test_handles_float_string(self):
        """Handles float string by truncating."""
        from shared.api import validate_days
        
        assert validate_days('7.5') == 7


class TestValidateLimit:
    """Tests for validate_limit function."""

    def test_returns_valid_integer(self):
        """Returns valid integer within bounds."""
        from shared.api import validate_limit
        
        assert validate_limit(25) == 25
        assert validate_limit('50') == 50

    def test_returns_default_for_none(self):
        """Returns default when value is None."""
        from shared.api import validate_limit
        
        assert validate_limit(None) == 50
        assert validate_limit(None, default=25) == 25

    def test_clamps_to_minimum(self):
        """Clamps value to minimum bound."""
        from shared.api import validate_limit
        
        assert validate_limit(0) == 1
        assert validate_limit(-10) == 1

    def test_clamps_to_maximum(self):
        """Clamps value to maximum bound."""
        from shared.api import validate_limit
        
        assert validate_limit(200) == 100
        assert validate_limit(500, max_val=50) == 50


class TestValidateInt:
    """Tests for validate_int function."""

    def test_returns_valid_integer(self):
        """Returns valid integer within bounds."""
        from shared.api import validate_int
        
        assert validate_int(50, default=10) == 50

    def test_returns_default_for_none(self):
        """Returns default when value is None."""
        from shared.api import validate_int
        
        assert validate_int(None, default=42) == 42

    def test_clamps_to_bounds(self):
        """Clamps value to min/max bounds."""
        from shared.api import validate_int
        
        assert validate_int(0, default=10, min_val=5) == 5
        assert validate_int(200, default=10, max_val=50) == 50

    def test_returns_default_for_invalid_input(self):
        """Returns default for invalid input."""
        from shared.api import validate_int
        
        assert validate_int('not_a_number', default=15) == 15


class TestCreateCorsConfig:
    """Tests for create_cors_config function."""

    @patch.dict('os.environ', {'ALLOWED_ORIGIN': 'https://example.com'})
    def test_uses_env_var_origin(self):
        """Uses ALLOWED_ORIGIN environment variable."""
        from shared.api import create_cors_config
        
        config = create_cors_config()
        
        assert 'https://example.com' in config._allowed_origins

    def test_uses_provided_origin(self):
        """Uses provided origin over env var."""
        from shared.api import create_cors_config
        
        config = create_cors_config(allowed_origin='https://custom.com')
        
        assert 'https://custom.com' in config._allowed_origins

    @patch.dict('os.environ', {}, clear=True)
    def test_defaults_to_localhost(self):
        """Defaults to localhost when no origin configured."""
        import os
        os.environ.pop('ALLOWED_ORIGIN', None)
        
        from shared.api import create_cors_config
        
        config = create_cors_config()
        
        assert any('localhost' in origin for origin in config._allowed_origins)

    def test_includes_required_headers(self):
        """Includes required CORS headers."""
        from shared.api import create_cors_config
        
        config = create_cors_config()
        
        assert 'Content-Type' in config.allow_headers
        assert 'Authorization' in config.allow_headers


class TestCreateApiResolver:
    """Tests for create_api_resolver function."""

    def test_returns_api_gateway_resolver(self):
        """Returns configured APIGatewayRestResolver."""
        from shared.api import create_api_resolver
        from aws_lambda_powertools.event_handler import APIGatewayRestResolver
        
        resolver = create_api_resolver()
        
        assert isinstance(resolver, APIGatewayRestResolver)

    def test_enables_validation(self):
        """Enables request validation."""
        from shared.api import create_api_resolver
        
        resolver = create_api_resolver()
        
        assert resolver._enable_validation is True


class TestJsonResponse:
    """Tests for json_response function."""

    def test_returns_200_by_default(self):
        """Returns 200 status code by default."""
        from shared.api import json_response
        
        result = json_response({'message': 'success'})
        
        assert result['statusCode'] == 200

    def test_returns_custom_status_code(self):
        """Returns custom status code when provided."""
        from shared.api import json_response
        
        result = json_response({'created': True}, status_code=201)
        
        assert result['statusCode'] == 201

    def test_includes_content_type_header(self):
        """Includes Content-Type header."""
        from shared.api import json_response
        
        result = json_response({'data': 'test'})
        
        assert result['headers']['Content-Type'] == 'application/json'

    def test_serializes_body_as_json(self):
        """Serializes body as JSON string."""
        from shared.api import json_response
        
        result = json_response({'key': 'value', 'count': 5})
        body = json.loads(result['body'])
        
        assert body == {'key': 'value', 'count': 5}

    def test_handles_decimal_values(self):
        """Handles Decimal values in response."""
        from shared.api import json_response
        
        result = json_response({'score': Decimal('0.95')})
        body = json.loads(result['body'])
        
        assert body['score'] == 0.95


class TestErrorResponse:
    """Tests for error_response function."""

    def test_returns_400_by_default(self):
        """Returns 400 status code by default."""
        from shared.api import error_response
        
        result = error_response('Bad request')
        
        assert result['statusCode'] == 400

    def test_returns_custom_status_code(self):
        """Returns custom status code when provided."""
        from shared.api import error_response
        
        result = error_response('Not found', status_code=404)
        
        assert result['statusCode'] == 404

    def test_includes_error_message(self):
        """Includes error message in body."""
        from shared.api import error_response
        
        result = error_response('Something went wrong')
        body = json.loads(result['body'])
        
        assert body['error'] == 'Something went wrong'


class TestGetConfiguredCategories:
    """Tests for get_configured_categories function."""

    def test_returns_categories_from_dynamodb(self):
        """Returns categories from DynamoDB settings."""
        from shared.api import get_configured_categories, clear_categories_cache
        clear_categories_cache()
        
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'pk': 'SETTINGS#categories',
                'sk': 'config',
                'categories': [
                    {'name': 'delivery'},
                    {'name': 'support'},
                    {'name': 'pricing'}
                ]
            }
        }
        
        result = get_configured_categories(mock_table)
        
        assert result == ['delivery', 'support', 'pricing']

    def test_returns_default_when_table_none(self):
        """Returns default categories when table is None."""
        from shared.api import get_configured_categories, DEFAULT_CATEGORIES, clear_categories_cache
        clear_categories_cache()
        
        result = get_configured_categories(None)
        
        assert result == DEFAULT_CATEGORIES

    def test_returns_default_on_dynamodb_error(self):
        """Returns default categories on DynamoDB error."""
        from shared.api import get_configured_categories, DEFAULT_CATEGORIES, clear_categories_cache
        clear_categories_cache()
        
        mock_table = MagicMock()
        mock_table.get_item.side_effect = Exception('DynamoDB error')
        
        result = get_configured_categories(mock_table)
        
        assert result == DEFAULT_CATEGORIES

    def test_caches_categories(self):
        """Caches categories for subsequent calls."""
        from shared.api import get_configured_categories, clear_categories_cache
        clear_categories_cache()
        
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {'categories': [{'name': 'test'}]}
        }
        
        # First call
        result1 = get_configured_categories(mock_table)
        # Second call should use cache
        result2 = get_configured_categories(mock_table)
        
        assert result1 == result2
        assert mock_table.get_item.call_count == 1

    def test_returns_default_when_no_item(self):
        """Returns default when no settings item exists."""
        from shared.api import get_configured_categories, DEFAULT_CATEGORIES, clear_categories_cache
        clear_categories_cache()
        
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        
        result = get_configured_categories(mock_table)
        
        assert result == DEFAULT_CATEGORIES


class TestClearCategoriesCache:
    """Tests for clear_categories_cache function."""

    def test_clears_cache(self):
        """Clears the categories cache."""
        from shared.api import get_configured_categories, clear_categories_cache
        clear_categories_cache()
        
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {'categories': [{'name': 'cached'}]}
        }
        
        # First call
        get_configured_categories(mock_table)
        
        # Clear cache
        clear_categories_cache()
        
        # Update mock response
        mock_table.get_item.return_value = {
            'Item': {'categories': [{'name': 'new'}]}
        }
        
        # Second call should fetch again
        result = get_configured_categories(mock_table)
        
        assert result == ['new']
        assert mock_table.get_item.call_count == 2


class TestSumDailyMetric:
    """Tests for sum_daily_metric function."""

    def test_sums_metrics_over_date_range(self):
        """Sums metrics over specified date range."""
        from shared.api import sum_daily_metric
        from datetime import datetime, timezone
        
        mock_table = MagicMock()
        mock_table.get_item.return_value = {'Item': {'count': 10}}
        
        current_date = datetime(2024, 1, 15, tzinfo=timezone.utc)
        result = sum_daily_metric(
            mock_table,
            'METRIC#daily_total',
            days=3,
            current_date=current_date
        )
        
        assert result == 30  # 10 * 3 days
        assert mock_table.get_item.call_count == 3

    def test_returns_zero_when_table_none(self):
        """Returns 0 when table is None."""
        from shared.api import sum_daily_metric
        
        result = sum_daily_metric(None, 'METRIC#test', days=7)
        
        assert result == 0

    def test_handles_missing_items(self):
        """Handles missing items gracefully."""
        from shared.api import sum_daily_metric
        from datetime import datetime, timezone
        
        mock_table = MagicMock()
        mock_table.get_item.side_effect = [
            {'Item': {'count': 5}},
            {},  # Missing item
            {'Item': {'count': 3}}
        ]
        
        current_date = datetime(2024, 1, 15, tzinfo=timezone.utc)
        result = sum_daily_metric(
            mock_table,
            'METRIC#daily_total',
            days=3,
            current_date=current_date
        )
        
        assert result == 8  # 5 + 0 + 3

    def test_handles_dynamodb_errors(self):
        """Handles DynamoDB errors gracefully."""
        from shared.api import sum_daily_metric
        from datetime import datetime, timezone
        
        mock_table = MagicMock()
        mock_table.get_item.side_effect = [
            {'Item': {'count': 10}},
            Exception('DynamoDB error'),
            {'Item': {'count': 5}}
        ]
        
        current_date = datetime(2024, 1, 15, tzinfo=timezone.utc)
        result = sum_daily_metric(
            mock_table,
            'METRIC#daily_total',
            days=3,
            current_date=current_date
        )
        
        assert result == 15  # 10 + 0 (error) + 5

    def test_uses_correct_date_format(self):
        """Uses correct date format for DynamoDB keys."""
        from shared.api import sum_daily_metric
        from datetime import datetime, timezone
        
        mock_table = MagicMock()
        mock_table.get_item.return_value = {'Item': {'count': 1}}
        
        current_date = datetime(2024, 3, 15, tzinfo=timezone.utc)
        sum_daily_metric(
            mock_table,
            'METRIC#daily_total',
            days=1,
            current_date=current_date
        )
        
        call_args = mock_table.get_item.call_args
        assert call_args.kwargs['Key'] == {'pk': 'METRIC#daily_total', 'sk': '2024-03-15'}


class TestApiHandlerDecorator:
    """Tests for api_handler decorator."""

    def test_wraps_function_with_powertools_decorators(self):
        """Wraps function with logger, tracer, and metrics decorators."""
        from shared.api import api_handler
        
        @api_handler
        def my_handler(event, context):
            return {'statusCode': 200}
        
        # Verify function is wrapped (has __wrapped__ attribute from functools.wraps)
        assert hasattr(my_handler, '__wrapped__')

    def test_preserves_function_name(self):
        """Preserves original function name."""
        from shared.api import api_handler
        
        @api_handler
        def my_custom_handler(event, context):
            return {'statusCode': 200}
        
        assert my_custom_handler.__name__ == 'my_custom_handler'

    @patch('shared.api.metrics')
    @patch('shared.api.tracer')
    @patch('shared.api.logger')
    def test_calls_wrapped_function(self, mock_logger, mock_tracer, mock_metrics):
        """Calls the wrapped function with event and context."""
        # Setup mocks to pass through
        mock_logger.inject_lambda_context = lambda f: f
        mock_tracer.capture_lambda_handler = lambda f: f
        mock_metrics.log_metrics = lambda **kwargs: lambda f: f
        
        from shared.api import api_handler
        
        call_tracker = []
        
        @api_handler
        def tracked_handler(event, context):
            call_tracker.append((event, context))
            return {'statusCode': 200}
        
        event = {'test': 'event'}
        context = MagicMock()
        
        tracked_handler(event, context)
        
        assert len(call_tracker) == 1
        assert call_tracker[0][0] == event
