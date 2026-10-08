"""
Tests for shared/api.py - API utilities for VoC Lambda functions.
"""

import json
from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest


class TestDecimalEncoder:
    """Tests for DecimalEncoder JSON encoder."""

    def test_encodes_decimal_as_float(self):
        """Converts Decimal to float in JSON output."""
        from shared.api import DecimalEncoder

        data = {'price': Decimal('19.99'), 'count': Decimal(5)}
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
        """Zero is all time and is kept; negatives clamp to zero."""
        from shared.api import ALL_TIME_DAYS, validate_days

        assert validate_days(0) == ALL_TIME_DAYS == 0
        assert validate_days('0') == 0
        assert validate_days(-5) == 0
        assert validate_days(0, min_val=7) == 7

    def test_clamps_to_maximum(self):
        """Clamps value to maximum bound."""
        from shared.api import MAX_FEEDBACK_WINDOW_DAYS, validate_days

        assert MAX_FEEDBACK_WINDOW_DAYS == 9999
        assert validate_days(9999) == 9999
        assert validate_days(10000) == 9999
        assert validate_days(1000, max_val=90) == 90

    def test_returns_default_for_invalid_string(self):
        """Returns default for non-numeric string."""
        from shared.api import validate_days

        assert validate_days('invalid') == 7
        assert validate_days('abc', default=14) == 14

    def test_a_float_string_is_unreadable_not_truncated(self):
        """`int('7.5')` raises, so the default comes back — not 7."""
        from shared.api import validate_days

        assert validate_days('7.5', default=3) == 3


class TestEffectiveWindowDays:
    """`days` (0 = all time) resolved against the earliest-data watermark."""

    TODAY = date(2026, 3, 10)

    def test_all_time_is_the_history_inclusive(self):
        from shared.api import effective_window_days

        assert effective_window_days(0, '2026-03-01', self.TODAY) == 10

    def test_a_window_past_the_history_is_narrowed_to_it(self):
        from shared.api import effective_window_days

        assert effective_window_days(9999, '2026-03-01', self.TODAY) == 10
        assert effective_window_days(11, '2026-03-01', self.TODAY) == 10

    def test_a_window_inside_the_history_is_unchanged(self):
        from shared.api import effective_window_days

        assert effective_window_days(10, '2026-03-01', self.TODAY) == 10
        assert effective_window_days(7, '2026-03-01', self.TODAY) == 7

    def test_data_from_today_or_a_future_watermark_is_one_day(self):
        from shared.api import effective_window_days

        assert effective_window_days(0, '2026-03-10', self.TODAY) == 1
        assert effective_window_days(0, '2026-04-01', self.TODAY) == 1

    def test_without_a_watermark_the_request_is_served_as_asked(self):
        from shared.api import ALL_TIME_FALLBACK_DAYS, effective_window_days

        assert effective_window_days(30, None, self.TODAY) == 30
        assert effective_window_days(0, None, self.TODAY) == ALL_TIME_FALLBACK_DAYS == 365
        assert effective_window_days(0, 'garbage', self.TODAY) == 365

    def test_a_corrupt_ancient_watermark_cannot_exceed_the_ceiling(self):
        from shared.api import MAX_FEEDBACK_WINDOW_DAYS, effective_window_days

        assert effective_window_days(0, '0001-01-01', self.TODAY) == MAX_FEEDBACK_WINDOW_DAYS


class TestResolveWindowDays:
    def test_reads_the_watermark_once(self):
        from shared.api import resolve_window_days

        table = MagicMock()
        table.get_item.return_value = {'Item': {'date': '2026-03-01'}}
        assert resolve_window_days(0, table, today=date(2026, 3, 10)) == 10
        table.get_item.assert_called_once_with(Key={'pk': 'METRIC#meta', 'sk': 'earliest_date'})

    def test_fails_open_to_the_request(self):
        from shared.api import resolve_window_days

        table = MagicMock()
        table.get_item.side_effect = RuntimeError('boom')
        assert resolve_window_days(30, table, today=date(2026, 3, 10)) == 30
        assert resolve_window_days(30, None, today=date(2026, 3, 10)) == 30


class TestValidateDateBasis:
    """Tests for validate_date_basis function."""

    def test_returns_imported_for_none(self):
        """Defaults to 'imported' when the parameter is absent."""
        from shared.api import validate_date_basis

        assert validate_date_basis(None) == 'imported'

    def test_accepts_review(self):
        """Returns 'review' for the review basis."""
        from shared.api import validate_date_basis

        assert validate_date_basis('review') == 'review'

    def test_accepts_imported(self):
        """Returns 'imported' when passed explicitly."""
        from shared.api import validate_date_basis

        assert validate_date_basis('imported') == 'imported'

    def test_normalizes_case_and_whitespace(self):
        """Accepts padded or upper-cased values."""
        from shared.api import validate_date_basis

        assert validate_date_basis(' Review ') == 'review'
        assert validate_date_basis('IMPORTED') == 'imported'

    def test_falls_back_to_imported_for_unknown_values(self):
        """Unknown values preserve historical behavior."""
        from shared.api import validate_date_basis

        assert validate_date_basis('bogus') == 'imported'
        assert validate_date_basis('') == 'imported'


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

    def test_returns_default_for_a_non_finite_float_instead_of_raising(self):
        """A non-finite float falls back like any other unreadable value.

        `int(float('inf'))` raises OverflowError, which is neither of the errors
        the fallback originally caught — so this validator, documented never to
        raise, raised. A body carrying `Infinity` is reachable because `json.loads`
        is non-strict by default, and in a handler that writes as it validates the
        escape surfaced as a 500 part way through the work.
        """
        from shared.api import validate_int

        # Parse the literals the way a request body is parsed, so the values
        # arrive untyped exactly as they do in a handler.
        assert validate_int(json.loads('Infinity'), default=15) == 15
        assert validate_int(json.loads('-Infinity'), default=15) == 15
        assert validate_int(json.loads('NaN'), default=15) == 15

    def test_a_bool_is_coerced_rather_than_refused(self):
        """Pins the documented surprise: `isinstance(True, int)` is true.

        Not a behaviour this test endorses — it exists so the contract is checked
        rather than implied, because a caller whose value is a score a human chose
        (rather than a page size) has to refuse `bool` itself, and cannot know to
        do that unless the coercion is written down.
        """
        from shared.api import validate_int

        assert validate_int(True, default=15) == 1
        assert validate_int(False, default=15, min_val=0) == 0


class TestCreateCorsConfig:
    """Tests for create_cors_config function."""

    @patch.dict('os.environ', {'ALLOWED_ORIGIN': 'https://example.com'})
    def test_uses_env_var_origin(self):
        """Uses ALLOWED_ORIGIN environment variable."""
        from shared.api import create_cors_config

        config = create_cors_config()

        assert config._allowed_origins == ['https://example.com']



class TestCreateApiResolver:
    """Tests for create_api_resolver function."""

    def test_returns_api_gateway_resolver(self):
        """Returns configured APIGatewayRestResolver."""
        from aws_lambda_powertools.event_handler import APIGatewayRestResolver

        from shared.api import create_api_resolver

        resolver = create_api_resolver()

        assert isinstance(resolver, APIGatewayRestResolver)

    def test_enables_validation(self):
        """Enables request validation."""
        from shared.api import create_api_resolver

        resolver = create_api_resolver()

        assert resolver._enable_validation is True


class TestGetConfiguredCategories:
    """Tests for get_configured_categories function."""

    def test_returns_categories_from_dynamodb(self):
        """Returns categories from DynamoDB settings."""
        from shared.api import clear_categories_cache, get_configured_categories
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
        from shared.api import (
            DEFAULT_CATEGORIES,
            clear_categories_cache,
            get_configured_categories,
        )
        clear_categories_cache()

        result = get_configured_categories(None)

        assert result == DEFAULT_CATEGORIES

    def test_returns_default_on_dynamodb_error(self):
        """Returns default categories on DynamoDB error."""
        from shared.api import (
            DEFAULT_CATEGORIES,
            clear_categories_cache,
            get_configured_categories,
        )
        clear_categories_cache()

        mock_table = MagicMock()
        mock_table.get_item.side_effect = Exception('DynamoDB error')

        result = get_configured_categories(mock_table)

        assert result == DEFAULT_CATEGORIES

    def test_caches_categories(self):
        """Caches categories for subsequent calls."""
        from shared.api import clear_categories_cache, get_configured_categories
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
        from shared.api import (
            DEFAULT_CATEGORIES,
            clear_categories_cache,
            get_configured_categories,
        )
        clear_categories_cache()

        mock_table = MagicMock()
        mock_table.get_item.return_value = {}

        result = get_configured_categories(mock_table)

        assert result == DEFAULT_CATEGORIES


class TestClearCategoriesCache:
    """Tests for clear_categories_cache function."""

    def test_clears_cache(self):
        """Clears the categories cache."""
        from shared.api import clear_categories_cache, get_configured_categories
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


class TestApiHandlerDecorator:
    """Tests for api_handler decorator."""

    def test_preserves_function_name(self):
        """Preserves original function name."""
        from shared.api import api_handler

        @api_handler
        def my_custom_handler(_event, context):
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
        mock_metrics.log_metrics = lambda **_kwargs: lambda f: f

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


class TestInvocationCostLog:
    """Every API request logs its CPU use (QA perf: the 70%-CPU rule needs a number).

    Lambda's REPORT line has memory and duration but no CPU, X-Ray is off, and
    Lambda Insights is not installed, so this line is the only CPU signal.
    """

    @staticmethod
    def _run(mock_logger, mock_tracer, mock_metrics, handler_body, memory='256'):
        mock_logger.inject_lambda_context = lambda f: f
        mock_tracer.capture_lambda_handler = lambda f: f
        mock_metrics.log_metrics = lambda **_kwargs: lambda f: f
        from shared.api import api_handler

        context = MagicMock()
        context.memory_limit_in_mb = memory
        # The line is written by shared.invocation_cost, through the same shared logger.
        with patch('shared.invocation_cost.logger', mock_logger):
            return api_handler(handler_body)({}, context)

    @staticmethod
    def _cost_fields(mock_logger) -> dict:
        calls = [c for c in mock_logger.info.call_args_list if c.args == ('invocation_cost',)]
        assert len(calls) == 1, mock_logger.info.call_args_list
        return calls[0].kwargs['extra']

    @patch('shared.api.metrics')
    @patch('shared.api.tracer')
    @patch('shared.api.logger')
    def test_logs_cpu_wall_and_share_of_the_allocation(self, mock_logger, mock_tracer, mock_metrics):
        def busy(_event, _context):
            sum(i * i for i in range(200_000))
            return {'statusCode': 200}

        assert self._run(mock_logger, mock_tracer, mock_metrics, busy) == {'statusCode': 200}

        fields = self._cost_fields(mock_logger)
        assert fields['cpu_ms'] > 0
        assert fields['wall_ms'] >= fields['cpu_ms'] * 0.5
        # 256 MB is 256/1769 of a vCPU, so busy work reads far above 100%.
        assert fields['cpu_pct_of_allocation'] == pytest.approx(
            fields['cpu_ms'] / (fields['wall_ms'] * 256 / 1769) * 100, rel=0.05)

    @patch('shared.api.metrics')
    @patch('shared.api.tracer')
    @patch('shared.api.logger')
    def test_still_logs_when_the_handler_raises(self, mock_logger, mock_tracer, mock_metrics):
        def failing(_event, _context):
            raise RuntimeError('boom')

        with pytest.raises(RuntimeError, match='boom'):
            self._run(mock_logger, mock_tracer, mock_metrics, failing)
        assert 'cpu_ms' in self._cost_fields(mock_logger)

    @patch('shared.api.metrics')
    @patch('shared.api.tracer')
    @patch('shared.api.logger')
    def test_omits_the_share_when_memory_is_unknown(self, mock_logger, mock_tracer, mock_metrics):
        self._run(mock_logger, mock_tracer, mock_metrics, lambda _e, _c: {'statusCode': 200}, memory='')
        assert 'cpu_pct_of_allocation' not in self._cost_fields(mock_logger)


def _event_with_groups(groups):
    """An API Gateway event whose Cognito claims carry *groups* (None for no claim)."""
    claims = {} if groups is None else {'cognito:groups': groups}
    return {'requestContext': {'authorizer': {'claims': claims}}}


class TestGetCallerGroups:
    """Tests for get_caller_groups (moved from test_users_handler when the
    local users_handler copy was consolidated into shared.api)."""

    def test_extracts_space_separated_groups(self):
        from shared.api import get_caller_groups
        assert get_caller_groups(_event_with_groups('admins viewers')) == ['admins', 'viewers']

    def test_handles_comma_separated_groups(self):
        from shared.api import get_caller_groups
        assert get_caller_groups(_event_with_groups('admins, viewers')) == ['admins', 'viewers']

    def test_handles_list_claim(self):
        from shared.api import get_caller_groups
        assert get_caller_groups(_event_with_groups(['admins'])) == ['admins']

    def test_handles_bracket_wrapped_rest_serialization(self):
        """REST API Gateway serializes the array claim as '[admins, users]' —
        the format the old users_handler local copy mishandled."""
        from shared.api import get_caller_groups
        groups = get_caller_groups(_event_with_groups('[admins, users]'))
        assert groups == ['admins', 'users']

    def test_returns_empty_list_when_no_groups(self):
        from shared.api import get_caller_groups
        assert get_caller_groups(_event_with_groups(None)) == []

    def test_handles_single_group(self):
        from shared.api import get_caller_groups
        assert get_caller_groups(_event_with_groups('admins')) == ['admins']


class TestRequireAdmin:
    """Tests for require_admin (the single shared implementation — all
    handlers, including users_handler, gate through this)."""

    def test_passes_for_admin_caller(self):
        from shared.api import require_admin
        # The gate returns None (rather than raising) for any caller in admins,
        # whether admins is the only group or one of several.
        assert require_admin(_event_with_groups('admins')) is None
        assert require_admin(_event_with_groups('users, admins')) is None

    def test_raises_authorization_error_for_non_admin(self):
        from shared.api import require_admin
        from shared.exceptions import AuthorizationError
        with pytest.raises(AuthorizationError):
            require_admin(_event_with_groups('users'))

    def test_raises_authorization_error_when_groups_missing(self):
        from shared.api import require_admin
        from shared.exceptions import AuthorizationError
        with pytest.raises(AuthorizationError):
            require_admin(_event_with_groups(None))


class TestGetCallerSubject:
    """Tests for get_caller_subject — fail-closed identity extraction."""

    def _event(self, sub):
        claims = {} if sub is None else {'sub': sub}
        return {'requestContext': {'authorizer': {'claims': claims}}}

    def test_returns_sub_when_present(self):
        from shared.api import get_caller_subject
        assert get_caller_subject(self._event('abc-123')) == 'abc-123'

    def test_raises_authorization_error_when_sub_missing(self):
        """Fail closed: absent sub must raise, not return a fallback."""
        from shared.api import get_caller_subject
        from shared.exceptions import AuthorizationError
        with pytest.raises(AuthorizationError):
            get_caller_subject(self._event(None))

    def test_raises_authorization_error_when_sub_empty_string(self):
        """An empty sub string must be treated as absent."""
        from shared.api import get_caller_subject
        from shared.exceptions import AuthorizationError
        with pytest.raises(AuthorizationError):
            get_caller_subject(self._event(''))

    def test_raises_authorization_error_when_claims_missing(self):
        """No requestContext at all must raise, not crash."""
        from shared.api import get_caller_subject
        from shared.exceptions import AuthorizationError
        with pytest.raises(AuthorizationError):
            get_caller_subject({})

    def test_raises_authorization_error_when_authorizer_missing(self):
        """requestContext without authorizer must raise."""
        from shared.api import get_caller_subject
        from shared.exceptions import AuthorizationError
        with pytest.raises(AuthorizationError):
            get_caller_subject({'requestContext': {}})

    def test_raises_authorization_error_when_sub_whitespace_only(self):
        """A whitespace-only sub must be treated as absent (fail closed)."""
        from shared.api import get_caller_subject
        from shared.exceptions import AuthorizationError
        with pytest.raises(AuthorizationError):
            get_caller_subject(self._event('   '))

    def test_raises_authorization_error_when_authorizer_is_none(self):
        """requestContext.authorizer=null must raise, not crash with AttributeError."""
        from shared.api import get_caller_subject
        from shared.exceptions import AuthorizationError
        with pytest.raises(AuthorizationError):
            get_caller_subject({'requestContext': {'authorizer': None}})

    def test_raises_authorization_error_when_claims_is_none(self):
        """requestContext.authorizer.claims=null must raise, not crash."""
        from shared.api import get_caller_subject
        from shared.exceptions import AuthorizationError
        with pytest.raises(AuthorizationError):
            get_caller_subject({'requestContext': {'authorizer': {'claims': None}}})

    def test_raises_authorization_error_when_request_context_is_none(self):
        """requestContext=null must raise AuthorizationError, not AttributeError."""
        from shared.api import get_caller_subject
        from shared.exceptions import AuthorizationError
        with pytest.raises(AuthorizationError):
            get_caller_subject({'requestContext': None})

    def test_raises_authorization_error_when_sub_is_non_string(self):
        """A non-string sub (e.g. integer from custom authorizer) must raise AuthorizationError."""
        from shared.api import get_caller_subject
        from shared.exceptions import AuthorizationError
        with pytest.raises(AuthorizationError):
            get_caller_subject({'requestContext': {'authorizer': {'claims': {'sub': 123}}}})
