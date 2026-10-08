"""Mutation hardening for `shared/api.py`.

`test_api.py` pins the validators' clamping, the window arithmetic, caller
identity extraction and the categories cache's happy path, but a mutation run
found a whole layer it never looked at:

* the resolver's ERROR CONTRACT. Every exception handler registered by
  `create_api_resolver` — the status code, the exact `{'success': False,
  'error': …}` body (plus `message` for 413), which logger method records it
  and with what prefix — was unobserved, so a handler could vanish (falling
  through to the `ApiError` catch-all, which logs a stack trace for a client
  mistake) or answer 401 for a validation error and every test passed.
* the CORS contract a browser sees: the default origin, the exact header
  allowlist, `expose_headers`, `max_age` and that credentials stay off.
* the redaction middleware: that `category_override.by_sub` is stripped from
  dict and list bodies and that non-JSON bodies pass through.
* `api_handler`'s decorator chain: which Powertools decorators wrap the
  handler and that cold starts are recorded.
* the WORDING of every refusal and log line, the constants other modules and
  the frontend size themselves against, `validate_bool` (not tested at all),
  and the categories cache's key, TTL boundary and empty-result caching.
"""
import importlib
import json
from collections.abc import Callable, Iterator
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock, call, patch

import pytest
from aws_lambda_powertools.event_handler import APIGatewayRestResolver, Response

from shared import api as api_module
from shared.api import (
    CATEGORIES_CACHE_TTL,
    DEFAULT_CATEGORIES,
    MAX_PERSONAS_PER_GENERATION,
    SEARCH_QUERY_MIN_LENGTH,
    DecimalEncoder,
    api_handler,
    clear_categories_cache,
    create_api_resolver,
    create_cors_config,
    get_caller_subject,
    get_configured_categories,
    get_raw_categories_config,
    read_earliest_date,
    require_admin,
    validate_bool,
    validate_int,
)
from shared.exceptions import (
    ApiError,
    AuthorizationError,
    ConfigurationError,
    ConflictError,
    NotFoundError,
    PayloadTooLargeError,
    SecretUnreadableError,
    ServiceError,
    ValidationError,
)

ORIGIN = 'https://app.example'

CORS_HEADERS = {
    'Access-Control-Allow-Origin': [ORIGIN],
    'Access-Control-Allow-Headers': [
        'Authorization,Content-Type,X-Amz-Date,X-Amz-Security-Token,X-Api-Key,X-Requested-With',
    ],
    'Access-Control-Expose-Headers': ['Content-Type'],
    'Access-Control-Max-Age': ['300'],
}


def _event(path: str, method: str = 'GET') -> dict:
    """A minimal REST API Gateway proxy event for *path* from ORIGIN."""
    return {
        'httpMethod': method,
        'path': path,
        'resource': path,
        'headers': {'Origin': ORIGIN},
        'requestContext': {'requestId': 'r', 'httpMethod': method, 'path': path, 'resourcePath': path},
        'queryStringParameters': None,
        'multiValueQueryStringParameters': None,
        'pathParameters': None,
        'body': None,
        'isBase64Encoded': False,
    }


def _resolve(app: APIGatewayRestResolver, path: str, method: str = 'GET') -> dict:
    return app.resolve(_event(path, method), MagicMock())


def _app_with_route(path: str, handler: Callable[[], object]) -> APIGatewayRestResolver:
    """A resolver from `create_api_resolver(ORIGIN)` whose only GET route runs *handler*."""
    app = create_api_resolver(ORIGIN)
    app.get(path)(handler)
    return app


def _raising(exc: Exception) -> Callable[[], object]:
    def handler() -> object:
        raise exc
    return handler


class TestConstantsOtherModulesSizeThemselvesAgainst:
    """Each is referenced from another file (or the frontend) by value."""

    def test_personas_per_generation(self):
        assert MAX_PERSONAS_PER_GENERATION == 10

    def test_search_query_min_length(self):
        assert SEARCH_QUERY_MIN_LENGTH == 2

    def test_categories_cache_ttl_is_five_minutes(self):
        assert CATEGORIES_CACHE_TTL == 300

    def test_default_categories_in_order(self):
        assert DEFAULT_CATEGORIES == [
            'delivery', 'customer_support', 'product_quality', 'pricing',
            'website', 'app', 'billing', 'returns', 'communication', 'other',
        ]


class TestDecimalEncoderNamesTheOffendingType:
    def test_message_names_the_type(self):
        with pytest.raises(TypeError) as exc:
            json.dumps({'x': object()}, cls=DecimalEncoder)
        assert str(exc.value) == "Object of type <class 'object'> is not JSON serializable"

    def test_decimal_itself_still_encodes(self):
        assert json.dumps(Decimal('1.5'), cls=DecimalEncoder) == '1.5'


class TestValidateIntDefaultCeiling:
    def test_one_hundred_is_allowed_and_one_hundred_and_one_is_clamped(self):
        assert validate_int(100, default=1) == 100
        assert validate_int(101, default=1) == 100


class TestValidateBool:
    @pytest.mark.parametrize('default', [True, False])
    def test_absent_yields_the_default(self, default):
        assert validate_bool(None, default) is default

    @pytest.mark.parametrize('value', [True, False])
    def test_a_real_bool_is_returned_as_is(self, value):
        assert validate_bool(value, not value) is value

    @pytest.mark.parametrize(('value', 'type_name'), [
        ('false', 'str'),
        (0, 'int'),
        (1.0, 'float'),
        ([], 'list'),
    ])
    def test_anything_else_is_refused_naming_the_type_not_the_value(self, value, type_name):
        with pytest.raises(ValidationError) as exc:
            validate_bool(value, True, field='include_avatars')
        assert exc.value.message == f'include_avatars must be true or false, got {type_name}'

    def test_the_default_field_name_is_value(self):
        with pytest.raises(ValidationError) as exc:
            validate_bool('yes', False)
        assert exc.value.message == 'value must be true or false, got str'


class TestEveryRefusalNamesItsCause:
    def test_missing_identity(self):
        with pytest.raises(AuthorizationError) as exc:
            get_caller_subject({})
        assert exc.value.message == 'Caller identity could not be determined'

    def test_non_admin(self):
        event = {'requestContext': {'authorizer': {'claims': {'cognito:groups': 'users'}}}}
        with pytest.raises(AuthorizationError) as exc:
            require_admin(event)
        assert exc.value.message == 'Admin access required'


class TestReadEarliestDateLogsTheFailure:
    def test_the_exception_is_logged_with_its_text(self):
        table = MagicMock()
        table.get_item.side_effect = RuntimeError('boom')
        with patch('shared.api.logger') as logger:
            assert read_earliest_date(table) is None
        logger.exception.assert_called_once_with('Could not read the earliest-date watermark: boom')


class TestCorsContract:
    @patch.dict('os.environ', {}, clear=True)
    def test_the_default_origin_is_the_vite_dev_server(self):
        assert create_cors_config()._allowed_origins == ['http://localhost:5173']

    def test_the_config_exactly(self):
        config = create_cors_config(ORIGIN)
        assert config._allowed_origins == [ORIGIN]
        assert config.allow_headers == {
            'Authorization', 'Content-Type', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token',
            'X-Requested-With',
        }
        assert config.expose_headers == ['Content-Type']
        assert config.max_age == 300
        assert config.allow_credentials is False

    def test_every_response_carries_exactly_these_cors_headers(self):
        result = _resolve(_app_with_route('/ok', lambda: {'ok': True}), '/ok')
        assert result['statusCode'] == 200
        assert dict(result['multiValueHeaders']) == {'Content-Type': ['application/json'], **CORS_HEADERS}

    def test_preflight_is_answered_with_the_same_allowlist(self):
        result = _resolve(_app_with_route('/ok', lambda: {'ok': True}), '/ok', 'OPTIONS')
        assert result['statusCode'] == 204
        assert dict(result['multiValueHeaders']) == {'Access-Control-Allow-Methods': ['GET,OPTIONS'], **CORS_HEADERS}


class _Teapot(ApiError):
    status_code = 418


class TestEveryErrorHandlerAnswersItsStatusBodyAndLogLine:
    @pytest.mark.parametrize(('exc_type', 'status', 'log_method', 'prefix'), [
        (ValidationError, 400, 'warning', 'Validation error'),
        (NotFoundError, 404, 'warning', 'Not found'),
        (ConfigurationError, 500, 'error', 'Configuration error'),
        (SecretUnreadableError, 500, 'error', 'Configuration error'),
        (ServiceError, 500, 'exception', 'Service error'),
        (AuthorizationError, 403, 'warning', 'Authorization error'),
        (ConflictError, 409, 'warning', 'Conflict error'),
        (ApiError, 500, 'exception', 'API error'),
        (_Teapot, 418, 'exception', 'API error'),
    ])
    def test_status_body_and_log(self, exc_type, status, log_method, prefix):
        app = _app_with_route('/fail', _raising(exc_type('it broke')))
        with patch('shared.api.logger') as logger:
            result = _resolve(app, '/fail')

        assert result['statusCode'] == status
        assert json.loads(result['body']) == {'success': False, 'error': 'it broke'}
        assert result['multiValueHeaders']['Content-Type'] == ['application/json']
        assert result['multiValueHeaders']['Access-Control-Allow-Origin'] == [ORIGIN]
        # Exactly one log line, through exactly this method: a vanished handler falls through to
        # the ApiError catch-all, which keeps the status but logs a stack trace instead.
        assert logger.mock_calls == [getattr(call, log_method)(f'{prefix}: it broke')]

    def test_payload_too_large_answers_both_keys_as_a_warning(self):
        app = _app_with_route('/big', _raising(PayloadTooLargeError('too big')))
        with patch('shared.api.logger') as logger:
            result = _resolve(app, '/big')

        assert result['statusCode'] == 413
        assert json.loads(result['body']) == {'success': False, 'error': 'too big', 'message': 'too big'}
        assert logger.mock_calls == [call.warning('Payload too large: too big')]


OVERRIDE = {'by_sub': 'cognito-sub', 'by_username': 'alice', 'at': '2026-01-01T00:00:00Z'}


class TestRedactionMiddleware:
    def test_by_sub_is_stripped_from_a_dict_body(self):
        app = _app_with_route('/item', lambda: {'id': 'f1', 'category_override': OVERRIDE})
        result = _resolve(app, '/item')
        assert result['statusCode'] == 200
        assert json.loads(result['body']) == {
            'id': 'f1',
            'category_override': {'by_username': 'alice', 'at': '2026-01-01T00:00:00Z'},
        }

    def test_by_sub_is_stripped_from_every_item_of_a_list_body(self):
        app = _app_with_route('/items', lambda: Response(
            status_code=200, content_type='application/json',
            body=[{'category_override': OVERRIDE}, {'plain': 1}],
        ))
        result = _resolve(app, '/items')
        assert json.loads(result['body']) == [
            {'category_override': {'by_username': 'alice', 'at': '2026-01-01T00:00:00Z'}},
            {'plain': 1},
        ]

    def test_a_text_body_passes_through_unchanged(self):
        app = _app_with_route('/text', lambda: Response(
            status_code=200, content_type='text/plain', body='by_sub stays: not JSON',
        ))
        result = _resolve(app, '/text')
        assert result['statusCode'] == 200
        assert result['body'] == 'by_sub stays: not JSON'

    def test_a_downstream_middleware_returning_a_plain_dict_is_passed_through(self):
        app = _app_with_route('/any', lambda: {'never': 'reached'})

        # Powertools types a middleware as returning Response, but `_call_route` converts
        # whatever the stack returns; this pins that the redaction step leaves such a value alone.
        def short_circuit(_app: APIGatewayRestResolver, _next_middleware: Callable[..., Any]) -> Any:
            return {'short': 'circuit'}

        app.use(middlewares=[short_circuit])
        result = _resolve(app, '/any')
        assert result['statusCode'] == 200
        assert json.loads(result['body']) == {'short': 'circuit'}


class TestApiHandlerAppliesEveryPowertoolsDecorator:
    def test_the_exact_chain_and_cold_start_capture(self):
        logger, tracer, metrics = MagicMock(), MagicMock(), MagicMock()

        def handler(_event: dict, _context: object) -> dict:
            return {'statusCode': 200}

        with patch('shared.api.logger', logger), patch('shared.api.tracer', tracer), patch('shared.api.metrics', metrics):
            wrapped = api_handler(handler)

        metrics.log_metrics.assert_called_once_with(capture_cold_start_metric=True)
        metrics.log_metrics.return_value.assert_called_once()
        inner = metrics.log_metrics.return_value.call_args.args[0]
        assert inner.__wrapped__ is handler
        assert inner({'e': 1}, None) == {'statusCode': 200}
        tracer.capture_lambda_handler.assert_called_once_with(metrics.log_metrics.return_value.return_value)
        logger.inject_lambda_context.assert_called_once_with(tracer.capture_lambda_handler.return_value)
        assert wrapped is logger.inject_lambda_context.return_value


def _table_with(categories: list[dict] | None) -> MagicMock:
    table = MagicMock()
    table.get_item.return_value = {'Item': {'categories': categories}} if categories is not None else {}
    return table


@pytest.fixture
def clock() -> Iterator[MagicMock]:
    """Patch `shared.api.datetime` so `now().timestamp()` returns a settable float."""
    with patch('shared.api.datetime') as dt:
        now = dt.now.return_value
        now.timestamp.return_value = 1_000.0
        yield now.timestamp


class TestCategoriesCache:
    @pytest.fixture(autouse=True)
    def _clear(self):
        clear_categories_cache()
        yield
        clear_categories_cache()

    def test_reads_the_settings_row_by_its_exact_key(self):
        table = _table_with([{'name': 'a'}])
        get_raw_categories_config(table)
        table.get_item.assert_called_once_with(Key={'pk': 'SETTINGS#categories', 'sk': 'config'})

    def test_a_load_is_logged_with_its_count(self):
        with patch('shared.api.logger') as logger:
            get_raw_categories_config(_table_with([{'name': 'a'}, {'name': 'b'}, {'name': 'c'}]))
        logger.info.assert_called_once_with('Loaded 3 categories from settings')

    def test_a_failure_is_logged_with_its_text(self):
        table = MagicMock()
        table.get_item.side_effect = RuntimeError('DynamoDB error')
        with patch('shared.api.logger') as logger:
            assert get_raw_categories_config(table) == []
        logger.exception.assert_called_once_with('Could not fetch categories from settings: DynamoDB error')

    def test_an_empty_result_is_cached_too(self):
        table = _table_with(None)
        assert get_configured_categories(table) == DEFAULT_CATEGORIES
        assert get_configured_categories(table) == DEFAULT_CATEGORIES
        assert table.get_item.call_count == 1

    def test_the_cache_is_fresh_just_under_the_ttl_and_stale_at_it(self, clock):
        table = _table_with([{'name': 'a'}])
        get_raw_categories_config(table)
        clock.return_value = 1_000.0 + CATEGORIES_CACHE_TTL - 0.001
        get_raw_categories_config(table)
        assert table.get_item.call_count == 1
        clock.return_value = 1_000.0 + CATEGORIES_CACHE_TTL
        get_raw_categories_config(table)
        assert table.get_item.call_count == 2

    def test_an_expired_empty_cache_picks_up_newly_saved_categories(self, clock):
        table = _table_with(None)
        assert get_configured_categories(table) == DEFAULT_CATEGORIES
        table.get_item.return_value = {'Item': {'categories': [{'name': 'fresh'}]}}
        clock.return_value = 1_000.0 + CATEGORIES_CACHE_TTL
        assert get_configured_categories(table) == ['fresh']
        assert table.get_item.call_count == 2

    def test_clearing_resets_both_cache_slots_to_none(self):
        get_raw_categories_config(_table_with([{'name': 'a'}]))
        clear_categories_cache()
        assert api_module._categories_cache is None
        assert api_module._categories_cache_time is None

    def test_a_fresh_import_starts_with_an_empty_cache(self):
        get_raw_categories_config(_table_with([{'name': 'a'}]))
        importlib.reload(api_module)
        assert api_module._categories_cache is None
        assert api_module._categories_cache_time is None
