"""
Additional coverage tests for shared.api module.
Targets uncovered lines: 49 (decimal_default Decimal branch), 154-155 (ValidationError handler),
163-164 (NotFoundError handler), 172-173 (ConfigurationError handler), 181-182 (ServiceError handler).
"""

import json
import pytest
from decimal import Decimal
from unittest.mock import MagicMock, patch


def _make_event(path: str) -> dict:
    """Helper to build a minimal API Gateway event."""
    return {
        'httpMethod': 'GET',
        'path': path,
        'resource': path,
        'queryStringParameters': {},
        'pathParameters': {},
        'body': None,
        'headers': {'Content-Type': 'application/json'},
        'requestContext': {'requestId': 'test', 'stage': 'test'},
        'isBase64Encoded': False,
    }


class TestExceptionHandlers:
    """Tests for all exception handlers registered by _register_exception_handlers."""

    def test_validation_error_returns_400(self):
        """ValidationError handler returns 400 response."""
        from shared.api import create_api_resolver
        from shared.exceptions import ValidationError

        app = create_api_resolver()

        @app.get("/test-validation")
        def test_route():
            raise ValidationError("Field 'name' is required")

        result = app.resolve(_make_event("/test-validation"), MagicMock())
        assert result['statusCode'] == 400
        body = json.loads(result['body'])
        assert body['success'] is False
        assert "name" in body['error']

    def test_not_found_error_returns_404(self):
        """NotFoundError handler returns 404 response."""
        from shared.api import create_api_resolver
        from shared.exceptions import NotFoundError

        app = create_api_resolver()

        @app.get("/test-notfound")
        def test_route():
            raise NotFoundError("Project not found")

        result = app.resolve(_make_event("/test-notfound"), MagicMock())
        assert result['statusCode'] == 404
        body = json.loads(result['body'])
        assert body['success'] is False
        assert "Project not found" in body['error']

    def test_configuration_error_returns_500(self):
        """ConfigurationError handler returns 500 response."""
        from shared.api import create_api_resolver
        from shared.exceptions import ConfigurationError

        app = create_api_resolver()

        @app.get("/test-config")
        def test_route():
            raise ConfigurationError("TABLE_NAME not set")

        result = app.resolve(_make_event("/test-config"), MagicMock())
        assert result['statusCode'] == 500
        body = json.loads(result['body'])
        assert body['success'] is False
        assert "TABLE_NAME" in body['error']

    def test_service_error_returns_500(self):
        """ServiceError handler returns 500 response."""
        from shared.api import create_api_resolver
        from shared.exceptions import ServiceError

        app = create_api_resolver()

        @app.get("/test-service")
        def test_route():
            raise ServiceError("DynamoDB write failed")

        result = app.resolve(_make_event("/test-service"), MagicMock())
        assert result['statusCode'] == 500
        body = json.loads(result['body'])
        assert body['success'] is False
        assert "DynamoDB" in body['error']

    def test_authorization_error_returns_403(self):
        """AuthorizationError handler returns 403 response."""
        from shared.api import create_api_resolver
        from shared.exceptions import AuthorizationError

        app = create_api_resolver()

        @app.get("/test-auth")
        def test_route():
            raise AuthorizationError("Not authorized to access this resource")

        result = app.resolve(_make_event("/test-auth"), MagicMock())
        assert result['statusCode'] == 403
        body = json.loads(result['body'])
        assert body['success'] is False
        assert 'Not authorized' in body['error']

    def test_conflict_error_returns_409(self):
        """ConflictError handler returns 409 response."""
        from shared.api import create_api_resolver
        from shared.exceptions import ConflictError

        app = create_api_resolver()

        @app.get("/test-conflict")
        def test_route():
            raise ConflictError("Resource already exists")

        result = app.resolve(_make_event("/test-conflict"), MagicMock())
        assert result['statusCode'] == 409
        body = json.loads(result['body'])
        assert body['success'] is False
        assert 'already exists' in body['error']

    def test_generic_api_error_returns_custom_status(self):
        """Generic ApiError catch-all handler returns 500 status code."""
        from shared.api import create_api_resolver
        from shared.exceptions import ApiError

        app = create_api_resolver()

        @app.get("/test-api-error")
        def test_route():
            raise ApiError("Custom API error")

        result = app.resolve(_make_event("/test-api-error"), MagicMock())
        assert result['statusCode'] == 500
        body = json.loads(result['body'])
        assert body['success'] is False
        assert 'Custom API error' in body['error']


class TestDecimalDefault:
    """Tests for decimal_default function."""

    def test_returns_float_for_decimal(self):
        """Returns float when given a Decimal value."""
        from shared.api import decimal_default

        assert decimal_default(Decimal('3.14')) == 3.14
        assert decimal_default(Decimal('0')) == 0.0
        assert decimal_default(Decimal('-42.5')) == -42.5

    def test_raises_type_error_for_non_decimal(self):
        """Raises TypeError for non-Decimal objects."""
        from shared.api import decimal_default

        with pytest.raises(TypeError, match="not JSON serializable"):
            decimal_default(set())


class TestSumDailyMetricDefaultDate:
    """Tests for sum_daily_metric with default current_date."""

    def test_uses_current_date_when_none(self):
        """Uses current UTC date when current_date is None."""
        from shared.api import sum_daily_metric

        mock_table = MagicMock()
        mock_table.get_item.return_value = {'Item': {'count': 5}}

        result = sum_daily_metric(mock_table, 'METRIC#daily_total', days=1)

        assert result == 5
        mock_table.get_item.assert_called_once()
        call_key = mock_table.get_item.call_args.kwargs['Key']
        assert call_key['pk'] == 'METRIC#daily_total'
        assert len(call_key['sk']) == 10


class TestValidateDaysInvalidString:
    """Tests for validate_days with invalid string input."""

    def test_returns_default_for_invalid_string(self):
        """Returns default for non-numeric string."""
        from shared.api import validate_days

        assert validate_days('invalid') == 7
        assert validate_days('abc', default=14) == 14

    def test_returns_default_for_none_like_object(self):
        """Returns default for objects that fail int() conversion."""
        from shared.api import validate_days

        assert validate_days(object(), default=30) == 30


class TestValidateLimitInvalidString:
    """Tests for validate_limit with invalid string input."""

    def test_returns_default_for_invalid_string(self):
        """Returns default for non-numeric string."""
        from shared.api import validate_limit

        assert validate_limit('invalid') == 50
        assert validate_limit('abc', default=25) == 25
