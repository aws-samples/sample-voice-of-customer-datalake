"""Mutation hardening for `api/settings_handler.py`.

`test_settings_handler.py`, `test_settings_reprocess.py`,
`test_settings_company_context.py` and the settings cases in
`test_category_access_routes.py` pin that each route answers the right status
and writes the right row, but a mutation run found what they cannot see:

* the WORDING of every refusal and every failure. A `ValidationError` reaches the
  SPA as the 400 body and a `ServiceError` as the 500 body; the earlier tests
  mostly checked `'error' in body`, so every message is pinned here as a literal.
* the ACCEPTED side of each bound: a 255-character and a 255-byte problem key
  save and one more of either is refused; `days=0` and `days=9999` start a
  reprocess; a 1 000-character integration token is kept.
* the exact DynamoDB arguments a `MagicMock` table swallows: the condition and
  attribute values of the single conditional resolve, the parent-map
  materialisation, the chunked prune (`REMOVE #r.#k0, #r.#k1`), the unresolve,
  and the tidy-up rules of the model-settings item (an empty surfaces map and a
  null global override are dropped from the row).
* the constants the fixtures ignore: Bedrock `max_tokens=4096` and
  `temperature=0.3` for category generation (the old test allowed `>= 4096`),
  the 500-entry resolution cap in both the condition value and the message, the
  prune chunk of 20, the 600 s upload and 3 600 s logo URL lifetimes.
* every log line a route emits — the structured `extra` payloads are part of
  the operational contract (the dashboards filter on them).
* the cold-start module state: the table named by `AGGREGATES_TABLE`, the
  worker named by `CATEGORY_REPROCESS_FUNCTION`, the TTL env parse, and every
  route wrapped by the tracer with the handler wrapped by `api_handler`.
"""
import json
import os
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import ClassVar
from unittest.mock import MagicMock, call, patch

import pytest
from botocore.exceptions import ClientError
from handler_events_fixtures import call_route
from module_reload_fixtures import reload_cycle

import settings_handler
from settings_handler import lambda_handler
from shared.category_access import CategoryScope
from shared.exceptions import AuthorizationError, ValidationError
from shared.model_config import ALLOWED_MODEL_IDS, PICKER_SURFACES
from shared.test.instrumentation_fixtures import assert_tracer_wrapped

HAIKU = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'
OPUS = 'global.anthropic.claude-opus-5'
FIXED_NOW = datetime(2026, 10, 5, 12, 0, 0, 1, tzinfo=UTC)
FIXED_NOW_ISO = '2026-10-05T12:00:00.000001+00:00'
USER = {'sub': 'user-sub', 'cognito:username': 'bob', 'cognito:groups': 'users'}
RESOLVED_KEY = {'pk': 'SETTINGS#resolved_problems', 'sk': 'config'}


def _client_error(code: str, message: str = 'from the table') -> ClientError:
    return ClientError({'Error': {'Code': code, 'Message': message}}, 'UpdateItem')


def _ccfe(message: str = 'cap') -> ClientError:
    return _client_error('ConditionalCheckFailedException', message)


def _entry(days_old: int) -> dict:
    return {'resolved_at': (datetime.now(UTC) - timedelta(days=days_old)).isoformat()}


@pytest.fixture
def table():
    mock = MagicMock()
    mock.get_item.return_value = {}
    with patch.object(settings_handler, 'aggregates_table', mock):
        yield mock


@pytest.fixture
def logger():
    with patch.object(settings_handler, 'logger') as mock:
        yield mock


@pytest.fixture
def fixed_now():
    fake_datetime = MagicMock(wraps=datetime)
    fake_datetime.now.return_value = FIXED_NOW
    with patch.object(settings_handler, 'datetime', fake_datetime):
        yield FIXED_NOW


@pytest.fixture
def route(api_gateway_event, lambda_context):
    def _call(method, path, body=None, claims=None, **kw):
        return call_route(lambda_handler, api_gateway_event, lambda_context,
                          method=method, path=path, body=body, claims=claims, **kw)
    return _call


# ── Module state ─────────────────────────────────────────────────────────────

class TestTheColdStartModuleState:
    @pytest.fixture
    def reload_with_env(self, monkeypatch):
        yield from reload_cycle(monkeypatch, settings_handler, restore_sys_path=False)

    def test_the_table_is_the_one_named_in_the_environment(self, reload_with_env):
        module = reload_with_env(AGGREGATES_TABLE='named-aggregates', CATEGORY_REPROCESS_FUNCTION='voc-worker',
                                 RAW_DATA_BUCKET='named-bucket', DESIGN_INTEGRATIONS_SECRET_ARN='arn:secret',
                                 RESOLVED_PROBLEMS_TTL_DAYS='45')
        assert module.AGGREGATES_TABLE == 'named-aggregates'
        assert module.aggregates_table.name == 'named-aggregates'
        assert module.CATEGORY_REPROCESS_FUNCTION == 'voc-worker'
        assert module.RAW_DATA_BUCKET == 'named-bucket'
        assert module.DESIGN_INTEGRATIONS_SECRET_ARN == 'arn:secret'
        assert module.RESOLVED_PROBLEMS_TTL_DAYS == 45

    def test_nothing_in_the_environment_means_no_table_and_the_documented_defaults(self, reload_with_env):
        import shared.logging
        with patch.object(shared.logging.logger, 'warning') as warning:
            module = reload_with_env(AGGREGATES_TABLE=None, CATEGORY_REPROCESS_FUNCTION=None, RAW_DATA_BUCKET=None,
                                     DESIGN_INTEGRATIONS_SECRET_ARN=None, RESOLVED_PROBLEMS_TTL_DAYS=None)
        warning.assert_not_called()   # the built-in TTL default parses; only a console typo warns
        assert module.AGGREGATES_TABLE == ''
        assert module.aggregates_table is None
        assert module.CATEGORY_REPROCESS_FUNCTION == ''
        assert module.RAW_DATA_BUCKET == ''
        assert module.DESIGN_INTEGRATIONS_SECRET_ARN == ''
        assert module.RESOLVED_PROBLEMS_TTL_DAYS == 180

    def test_the_lambda_root_is_put_first_on_sys_path(self, reload_with_env):
        import sys
        lambda_root = os.path.dirname(os.path.dirname(os.path.abspath(settings_handler.__file__)))
        saved = list(sys.path)
        try:
            sys.path[:] = [entry for entry in sys.path if entry != lambda_root]
            reload_with_env()
            assert sys.path[0] == lambda_root
        finally:
            sys.path[:] = saved

    def test_the_module_constants_are_the_documented_values(self):
        assert (settings_handler.SETTINGS_PK, settings_handler.SETTINGS_SK) == ('SETTINGS#brand', 'config')
        assert (settings_handler.CATEGORIES_PK, settings_handler.CATEGORIES_SK) == ('SETTINGS#categories', 'config')
        assert (settings_handler.RESOLVED_PROBLEMS_PK, settings_handler.RESOLVED_PROBLEMS_SK) == (
            'SETTINGS#resolved_problems', 'config')
        assert (settings_handler.MAX_PROBLEM_KEY_LEN, settings_handler.MAX_PROBLEM_KEY_BYTES,
                settings_handler.MAX_RESOLVED_ENTRIES, settings_handler._PRUNE_CHUNK_SIZE) == (255, 255, 500, 20)
        assert settings_handler.DESIGN_REFRESH_ACTION == 'design_reference_refresh'
        assert (settings_handler.UPLOAD_URL_TTL_SECONDS, settings_handler.LOGO_URL_TTL_SECONDS,
                settings_handler.MAX_INTEGRATION_TOKEN_CHARS) == (600, 3600, 1_000)
        assert settings_handler.INTEGRATION_FIELDS == {'figma_token': 'figma', 'github_token': 'github'}
        assert (settings_handler.LOGO_KEY_ATTR, settings_handler.LOGO_PENDING_KEY_ATTR) == (
            'logo_s3_key', 'logo_pending_s3_key')
        assert settings_handler.LOGO_KEY_PREFIX == 'company-context/design/logo_'

    def test_the_ttl_parse_warns_with_the_raw_value_and_the_default(self, logger):
        assert settings_handler._parse_ttl_days('180d') == 180
        logger.warning.assert_called_once_with(
            'Invalid RESOLVED_PROBLEMS_TTL_DAYS; falling back to default',
            extra={'raw_value': '180d', 'default_days': 180},
        )

    def test_a_valid_ttl_does_not_warn(self, logger):
        assert settings_handler._parse_ttl_days('7') == 7
        logger.warning.assert_not_called()


ROUTES = [
    'get_model_settings', 'save_model_settings', 'get_resolved_problems', 'set_problem_resolution',
    '_prune_expired_entries', 'get_brand_settings', 'save_brand_settings', 'get_categories_config',
    'save_categories_config', 'generate_categories', 'start_category_reprocess',
    'get_latest_category_reprocess', 'get_category_reprocess', 'cancel_category_reprocess',
    'get_company_context_route', 'put_company_context_route', 'get_my_context_route', 'put_my_context_route',
    'put_design_integrations_route', 'create_logo_upload_route', 'get_design_system_route',
    'put_design_system_route', 'create_design_reference_route', 'refresh_design_reference_route',
    'archive_design_reference_route',
]


class TestTheRoutesAreInstrumented:
    @pytest.mark.parametrize('route', ROUTES)
    def test_every_route_is_the_tracer_wrapper_around_the_named_function(self, route):
        assert_tracer_wrapped(settings_handler, route)

    @pytest.mark.usefixtures('table')
    def test_the_handler_injects_the_invocation_context_into_the_logger(self, api_gateway_event):
        context = SimpleNamespace(
            function_name='voc-settings-api-under-test',
            memory_limit_in_mb=256,
            invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:voc-settings-api-under-test',
            aws_request_id='req-settings-handler-mutation-0001',
            get_remaining_time_in_millis=lambda: 30_000,
        )
        response = lambda_handler(api_gateway_event(method='GET', path='/settings/brand'), context)
        assert response['statusCode'] == 200
        keys = settings_handler.logger.get_current_keys()
        assert keys['function_name'] == 'voc-settings-api-under-test'
        assert keys['function_request_id'] == 'req-settings-handler-mutation-0001'
        assert vars(lambda_handler)['__wrapped__'].__qualname__ == 'lambda_handler'


# ── Every failure names its cause ────────────────────────────────────────────

class TestEveryUnconfiguredTableIsNamed:
    @pytest.mark.parametrize(('method', 'path', 'body'), [
        ('GET', '/settings/model', None),
        ('PUT', '/settings/model', {'model_id': None}),
        ('GET', '/settings/resolved-problems', None),
        ('PUT', '/settings/resolved-problems', {'key': 'k', 'resolved': True}),
        ('GET', '/settings/brand', None),
        ('PUT', '/settings/brand', {'brand_name': 'x'}),
        ('PUT', '/settings/categories', {'categories': []}),
        ('POST', '/settings/categories/reprocess', {'mode': 'raw', 'days': 0}),
        ('GET', '/settings/categories/reprocess', None),
        ('GET', '/settings/company-context', None),
        ('PUT', '/settings/company-context', {}),
        ('GET', '/settings/my-context', None),
        ('PUT', '/settings/my-context', {}),
        ('GET', '/settings/design-system', None),
        ('PUT', '/settings/design-system', {}),
        ('POST', '/settings/design-system/references', {'kind': 'github', 'title': 'x',
                                                        'url': 'https://github.com/acme/ui'}),
        ('POST', '/settings/design-system/references/ref_0123456789ab/refresh', None),
        ('DELETE', '/settings/design-system/references/ref_0123456789ab', None),
    ])
    def test_a_missing_aggregates_table_is_a_500_naming_it(self, route, method, path, body):
        with patch.object(settings_handler, 'aggregates_table', None), \
                patch.object(settings_handler, 'CATEGORY_REPROCESS_FUNCTION', 'worker'):
            response, payload = route(method, path, body)
        assert response['statusCode'] == 500
        assert payload['error'] == 'Aggregates table not configured'

    def test_get_categories_degrades_to_an_empty_list_naming_the_table(self, route):
        with patch.object(settings_handler, 'aggregates_table', None):
            response, payload = route('GET', '/settings/categories')
        assert response['statusCode'] == 200
        assert payload == {'categories': [], 'error': 'Aggregates table not configured'}

    def test_a_missing_logo_bucket_is_named(self, route, table):
        with patch.object(settings_handler, 'RAW_DATA_BUCKET', ''):
            response, payload = route('POST', '/settings/design-system/logo',
                                      {'content_type': 'image/png', 'size_bytes': 10})
        assert response['statusCode'] == 500
        assert payload['error'] == 'Raw data bucket not configured'
        table.update_item.assert_not_called()

    def test_a_missing_upload_bucket_is_named_before_the_row_is_written(self, route, table):
        table.query.return_value = {'Items': []}
        with patch.object(settings_handler, 'RAW_DATA_BUCKET', ''):
            response, payload = route('POST', '/settings/design-system/references',
                                      {'kind': 'screenshot', 'title': 'Home', 'content_type': 'image/png',
                                       'size_bytes': 10})
        assert response['statusCode'] == 500
        assert payload['error'] == 'Raw data bucket not configured'
        table.put_item.assert_not_called()

    @pytest.mark.usefixtures('table')
    def test_a_missing_integrations_secret_is_named(self, route):
        with patch.object(settings_handler, 'DESIGN_INTEGRATIONS_SECRET_ARN', ''):
            response, payload = route('PUT', '/settings/design-system/integrations', {'figma_token': 'x'})
        assert response['statusCode'] == 500
        assert payload['error'] == 'Design integrations secret not configured'

    @pytest.mark.usefixtures('table')
    def test_a_missing_reprocess_worker_is_named(self, route):
        with patch.object(settings_handler, 'CATEGORY_REPROCESS_FUNCTION', ''):
            response, payload = route('POST', '/settings/categories/reprocess', {'mode': 'raw', 'days': 0})
        assert response['statusCode'] == 500
        assert payload['error'] == 'Category reprocess worker not configured'


class TestEveryServiceFailureIsLoggedAndNamed:
    """A table that raises turns into a 500 whose body and `logger.exception`
    line name the operation (never the boto message)."""

    @pytest.mark.parametrize(('method', 'path', 'body', 'table_method', 'message', 'log'), [
        ('GET', '/settings/model', None, 'get_item', 'Failed to retrieve model settings',
         'Failed to get model settings: boom'),
        ('PUT', '/settings/model', {'model_id': HAIKU}, 'get_item', 'Failed to save model settings',
         'Failed to save model settings: boom'),
        ('GET', '/settings/resolved-problems', None, 'get_item', 'Failed to retrieve resolved problems',
         'Failed to get resolved problems'),
        ('PUT', '/settings/resolved-problems', {'key': 'k', 'resolved': True}, 'update_item',
         'Failed to update problem resolution', 'Failed to update problem resolution'),
        ('PUT', '/settings/resolved-problems', {'key': 'k', 'resolved': False}, 'update_item',
         'Failed to update problem resolution', 'Failed to update problem resolution'),
        ('GET', '/settings/brand', None, 'get_item', 'Failed to retrieve brand settings',
         'Failed to get brand settings: boom'),
        ('PUT', '/settings/brand', {'brand_name': 'x'}, 'put_item', 'Failed to save brand settings',
         'Failed to save brand settings: boom'),
        ('PUT', '/settings/categories', {'categories': []}, 'put_item', 'Failed to save categories',
         'Failed to save categories config: boom'),
    ])
    def test_the_500_and_the_log_line(self, route, table, logger, method, path, body, table_method, message, log):
        getattr(table, table_method).side_effect = RuntimeError('boom')
        response, payload = route(method, path, body)
        assert response['statusCode'] == 500
        assert payload['error'] == message
        logger.exception.assert_called_once_with(log)

    def test_a_failing_categories_read_degrades_to_an_empty_list(self, route, table, logger):
        table.get_item.side_effect = RuntimeError('boom')
        response, payload = route('GET', '/settings/categories')
        assert response['statusCode'] == 200
        assert payload == {'categories': [], 'error': 'Failed to retrieve categories'}
        logger.exception.assert_called_once_with('Failed to get categories config: boom')

    @pytest.mark.usefixtures('table')
    def test_a_failing_bedrock_call_is_named(self, route, logger):
        with patch('shared.converse.converse', side_effect=RuntimeError('boom')):
            response, payload = route('POST', '/settings/categories/generate', {'company_description': 'Shoes'})
        assert response['statusCode'] == 500
        assert payload['error'] == 'Failed to generate categories'
        logger.exception.assert_called_once_with('Failed to generate categories: boom')

    @pytest.mark.usefixtures('table')
    def test_an_answer_without_json_is_named(self, route, logger):
        with patch('shared.converse.converse', return_value='Sorry, no categories today.'):
            response, payload = route('POST', '/settings/categories/generate', {'company_description': 'Shoes'})
        assert response['statusCode'] == 500
        assert payload['error'] == 'Could not parse categories from response'
        logger.exception.assert_not_called()


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize(('path', 'body', 'message'), [
        ('/settings/model', {'surface': 'chat'}, 'model_id is required (an allowlisted id, or null to clear)'),
        ('/settings/model', {'model_id': 'anthropic.evil'},
         f"model_id must be null or one of: {', '.join(sorted(ALLOWED_MODEL_IDS))}"),
        ('/settings/model', {'surface': 'bogus', 'model_id': None},
         f"surface must be null or one of: {', '.join(PICKER_SURFACES)}"),
        ('/settings/model', {'surface': 'default', 'model_id': None},
         f"surface must be null or one of: {', '.join(PICKER_SURFACES)}"),
        ('/settings/model', {'surface': 'chat', 'model_id': 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'},
         f"model_id must be null or one of: {', '.join(sorted(ALLOWED_MODEL_IDS))}"),
        ('/settings/resolved-problems', {'resolved': True}, 'key must be a non-empty string'),
        ('/settings/resolved-problems', {'key': 7, 'resolved': True}, 'key must be a non-empty string'),
        ('/settings/resolved-problems', {'key': '', 'resolved': True}, 'key must be a non-empty string'),
        ('/settings/resolved-problems', {'key': '  ', 'resolved': True}, 'key must be a non-empty string'),
        ('/settings/resolved-problems', {'key': 'x' * 256, 'resolved': True},
         'key must be at most 255 characters'),
        ('/settings/resolved-problems', {'key': 'é' * 128, 'resolved': True},
         'key must be at most 255 bytes (UTF-8)'),
        ('/settings/resolved-problems', {'key': 'k'}, 'resolved must be a boolean'),
        ('/settings/resolved-problems', {'key': 'k', 'resolved': 1}, 'resolved must be a boolean'),
        ('/settings/resolved-problems', {'key': 'k', 'resolved': 'yes'}, 'resolved must be a boolean'),
        ('/settings/categories', [1, 2], 'Request body must be a JSON object'),
        ('/settings/categories', {'categories': 'x'}, 'categories must be a list'),
        ('/settings/design-system/integrations', {'slack_token': 'x', 'figma_token': 'y'},
         'Unknown field(s): slack_token'),
        ('/settings/design-system/integrations', {'slack_token': 'x', 'jira_token': 'y'},
         'Unknown field(s): jira_token, slack_token'),
        ('/settings/design-system/integrations', {'figma_token': 'x' * 1001},
         'figma_token must be a string of at most 1000 characters, or null'),
        ('/settings/design-system/integrations', {'github_token': 7},
         'github_token must be a string of at most 1000 characters, or null'),
        ('/settings/design-system/integrations', {'github_token': '   '},
         'github_token must be a string of at most 1000 characters, or null'),
    ])
    def test_a_put_is_refused_with_the_message(self, route, table, path, body, message):
        with patch.object(settings_handler, 'DESIGN_INTEGRATIONS_SECRET_ARN', 'arn:secret'), \
                patch.object(settings_handler, 'get_secrets_client') as secrets:
            secrets.return_value.get_secret_value.return_value = {'SecretString': '{}'}
            response, payload = route('PUT', path, body)
        assert response['statusCode'] == 400
        assert payload['error'] == message
        table.put_item.assert_not_called()
        table.update_item.assert_not_called()
        secrets.return_value.put_secret_value.assert_not_called()

    @pytest.mark.usefixtures('route', 'table')
    def test_the_lone_surrogate_message(self, api_gateway_event, lambda_context):
        event = api_gateway_event(method='PUT', path='/settings/resolved-problems', body={'key': 'k', 'resolved': True})
        event['body'] = json.dumps({'key': 'broken \ud83d', 'resolved': True}, ensure_ascii=True)
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400
        assert json.loads(response['body'])['error'] == 'key must be valid Unicode (no unpaired surrogates)'

    @pytest.mark.parametrize(('body', 'message'), [
        ({'company': 'Acme'}, 'Company description is required'),
        ({'company_description': ''}, 'Company description is required'),
    ])
    @pytest.mark.usefixtures('table')
    def test_generate_needs_a_description(self, route, body, message):
        with patch('shared.converse.converse') as converse:
            response, payload = route('POST', '/settings/categories/generate', body)
        assert response['statusCode'] == 400
        assert payload['error'] == message
        converse.assert_not_called()

    @pytest.mark.parametrize(('body', 'message'), [
        ([1], 'Request body must be a JSON object'),
        ({'mode': 'everything', 'days': 0}, 'mode must be one of: processed, raw, dimensions'),
        ({'mode': 'raw'}, 'days must be an integer (0 = all time)'),
        ({'mode': 'raw', 'days': True}, 'days must be an integer (0 = all time)'),
        ({'mode': 'raw', 'days': '7'}, 'days must be an integer (0 = all time)'),
        ({'mode': 'raw', 'days': -1}, 'days must be between 0 and 9999'),
        ({'mode': 'raw', 'days': 10000}, 'days must be between 0 and 9999'),
        ({'mode': 'raw', 'days': 0, 'include_manual': 'yes'}, 'include_manual must be true or false, got str'),
    ])
    @pytest.mark.usefixtures('table')
    def test_a_reprocess_start_is_refused_with_the_message(self, route, body, message):
        with patch.object(settings_handler, 'CATEGORY_REPROCESS_FUNCTION', 'worker'), \
                patch.object(settings_handler.reprocess_jobs, 'start_job') as start_job:
            response, payload = route('POST', '/settings/categories/reprocess', body)
        assert response['statusCode'] == 400
        assert payload['error'] == message
        start_job.assert_not_called()

    def test_the_resolution_cap_message_names_the_cap(self, route, table):
        table.update_item.side_effect = [_ccfe(), {}, _ccfe()]
        table.get_item.return_value = {'Item': {'resolved': {'live': _entry(1)}}}
        response, payload = route('PUT', '/settings/resolved-problems', {'key': 'one too many', 'resolved': True})
        assert response['statusCode'] == 400
        assert payload['error'] == ('Resolved-problem limit reached (500). '
                                    'Unresolve entries you no longer need first.')

    def test_a_reprocess_job_that_does_not_exist_is_named(self, route, table):
        table.get_item.return_value = {}
        response, payload = route('GET', '/settings/categories/reprocess/rp_000000000000',
                                  path_params={'job_id': 'rp_000000000000'},
                                  resource='/settings/categories/reprocess/{job_id}')
        assert response['statusCode'] == 404
        assert payload['error'] == 'Reprocess job not found'
        table.get_item.assert_called_once_with(Key={'pk': 'JOB#category_reprocess', 'sk': 'rp_000000000000'},
                                               ConsistentRead=True)

    def test_a_malformed_job_id_is_not_even_read(self, route, table):
        response, payload = route('POST', '/settings/categories/reprocess/not-a-job/cancel',
                                  path_params={'job_id': 'not-a-job'},
                                  resource='/settings/categories/reprocess/{job_id}/cancel')
        assert response['statusCode'] == 404
        assert payload['error'] == 'Reprocess job not found'
        table.get_item.assert_not_called()
        table.update_item.assert_not_called()

    def test_a_cancel_of_a_missing_job_is_named(self, route, table):
        with patch.object(settings_handler.reprocess_jobs, 'cancel_job', return_value=None) as cancel_job:
            response, payload = route('POST', '/settings/categories/reprocess/rp_000000000000/cancel',
                                      path_params={'job_id': 'rp_000000000000'},
                                      resource='/settings/categories/reprocess/{job_id}/cancel')
        assert response['statusCode'] == 404
        assert payload['error'] == 'Reprocess job not found'
        cancel_job.assert_called_once_with(table, 'rp_000000000000')

    @pytest.mark.usefixtures('table')
    def test_a_second_reprocess_is_a_409_naming_the_running_one(self, route):
        with patch.object(settings_handler, 'CATEGORY_REPROCESS_FUNCTION', 'worker'), \
                patch.object(settings_handler.reprocess_jobs, 'start_job', return_value=None), \
                patch.object(settings_handler, 'invoke_lambda_async') as invoke:
            response, payload = route('POST', '/settings/categories/reprocess', {'mode': 'raw', 'days': 0})
        assert response['statusCode'] == 409
        assert payload['error'] == 'A reprocess job is already queued or running'
        invoke.assert_not_called()


class TestStartingAReprocess:
    JOB: ClassVar[dict[str, object]] = {'pk': 'JOB#category_reprocess', 'sk': 'rp_0123456789ab', 'status': 'queued', 'mode': 'raw', 'days': 0,
                                       'include_manual': False, 'started_by': 'alice', 'created_at': FIXED_NOW_ISO, 'updated_at': FIXED_NOW_ISO}
    CLAIMS: ClassVar[dict[str, object]] = {'sub': 'admin-sub', 'cognito:username': 'alice', 'cognito:groups': 'admins'}

    @pytest.fixture
    def jobs(self, table):
        with patch.object(settings_handler, 'CATEGORY_REPROCESS_FUNCTION', 'voc-worker'), \
                patch.object(settings_handler.reprocess_jobs, 'start_job', return_value=dict(self.JOB)) as start, \
                patch.object(settings_handler.reprocess_jobs, 'finish_job') as finish, \
                patch.object(settings_handler, 'invoke_lambda_async') as invoke:
            yield SimpleNamespace(start=start, finish=finish, invoke=invoke, table=table)

    @pytest.mark.usefixtures('fixed_now')
    def test_the_job_is_started_for_the_caller_with_the_flag_defaulting_to_false(self, route, jobs, logger):
        response, payload = route('POST', '/settings/categories/reprocess', {'mode': 'raw', 'days': 0},
                                  claims=self.CLAIMS)
        assert response['statusCode'] == 202
        assert response['multiValueHeaders']['Content-Type'] == ['application/json']
        jobs.start.assert_called_once_with(jobs.table, mode='raw', days=0, include_manual=False,
                                           started_by='alice', now=FIXED_NOW)
        jobs.invoke.assert_called_once_with('voc-worker', {'job_id': 'rp_0123456789ab'})
        jobs.finish.assert_not_called()
        logger.info.assert_called_once_with('Category reprocess started',
                                            extra={'job_id': 'rp_0123456789ab', 'mode': 'raw', 'days': 0})
        assert payload['job']['job_id'] == 'rp_0123456789ab'
        assert payload['job']['started_by'] == 'alice'

    def test_a_worker_that_cannot_be_started_fails_the_job_and_names_both(self, route, jobs, logger):
        jobs.invoke.side_effect = RuntimeError('lambda down')
        response, payload = route('POST', '/settings/categories/reprocess', {'mode': 'processed', 'days': 30})
        assert response['statusCode'] == 500
        assert payload['error'] == 'Failed to start reprocess job'
        jobs.finish.assert_called_once_with(jobs.table, 'rp_0123456789ab', 'failed',
                                            error='Could not start the reprocess worker')
        logger.exception.assert_called_once_with('Failed to start category reprocess worker')
        logger.info.assert_not_called()

    def test_a_missing_design_reference_is_named(self, route, table):
        response, payload = route('DELETE', '/settings/design-system/references/ref_0123456789ab',
                                  path_params={'ref_id': 'ref_0123456789ab'},
                                  resource='/settings/design-system/references/{ref_id}')
        assert response['statusCode'] == 404
        assert payload['error'] == 'Design reference not found'
        table.update_item.assert_not_called()

    def test_refreshing_an_archived_reference_is_a_409(self, route, table):
        table.get_item.return_value = {'Item': {'id': 'ref_0123456789ab', 'status': 'archived'}}
        response, payload = route('POST', '/settings/design-system/references/ref_0123456789ab/refresh',
                                  path_params={'ref_id': 'ref_0123456789ab'},
                                  resource='/settings/design-system/references/{ref_id}/refresh')
        assert response['statusCode'] == 409
        assert payload['error'] == 'Restore is not supported; add the reference again'
        table.update_item.assert_not_called()

    def test_too_many_references_is_named(self, route, table):
        table.query.return_value = {'Items': [{'id': f'ref_{i:012x}', 'status': 'ready'} for i in range(50)]}
        response, payload = route('POST', '/settings/design-system/references',
                                  {'kind': 'github', 'title': 'Repo', 'url': 'https://github.com/acme/ui'})
        assert response['statusCode'] == 400
        assert payload['error'] == 'At most 50 active references; archive one first'
        table.put_item.assert_not_called()

    def test_a_bad_upload_spec_is_named_verbatim(self, route, table):
        table.query.return_value = {'Items': []}
        response, payload = route('POST', '/settings/design-system/references',
                                  {'kind': 'screenshot', 'title': 'Home', 'content_type': 'image/gif',
                                   'size_bytes': 10})
        assert response['statusCode'] == 400
        assert payload['error'] == 'content_type must be one of: image/png, image/jpeg, image/webp'
        response, payload = route('POST', '/settings/design-system/logo', {'content_type': 'image/png',
                                                                            'size_bytes': 5_000_001})
        assert response['statusCode'] == 400
        assert payload['error'] == 'size_bytes must be between 1 and 5000000'


# ── Problem resolutions ──────────────────────────────────────────────────────

class TestTheAcceptedSideOfTheKeyBounds:
    @pytest.mark.parametrize('key', ['x' * 255, 'é' * 127 + 'x'])
    def test_exactly_255_characters_or_bytes_saves(self, route, table, key):
        assert len(key) <= 255
        assert len(key.encode('utf-8')) == 255
        response, payload = route('PUT', '/settings/resolved-problems', {'key': key, 'resolved': True})
        assert response['statusCode'] == 200
        assert payload == {'success': True, 'key': key, 'resolved': True}
        assert table.update_item.call_args.kwargs['ExpressionAttributeNames'] == {'#r': 'resolved', '#k': key}

    @pytest.mark.usefixtures('table')
    def test_exactly_256_bytes_is_refused(self, route):
        key = 'é' * 128
        assert len(key) == 128
        assert len(key.encode('utf-8')) == 256
        response, payload = route('PUT', '/settings/resolved-problems', {'key': key, 'resolved': True})
        assert response['statusCode'] == 400
        assert payload['error'] == 'key must be at most 255 bytes (UTF-8)'


class TestTheResolveWrites:
    @pytest.mark.usefixtures('fixed_now')
    def test_the_single_conditional_set(self, route, table):
        route('PUT', '/settings/resolved-problems', {'key': 'cat|sub|late', 'resolved': True})
        table.update_item.assert_called_once_with(
            Key=RESOLVED_KEY,
            UpdateExpression='SET #r.#k = :entry',
            ConditionExpression='attribute_exists(#r.#k) OR size(#r) < :max',
            ExpressionAttributeNames={'#r': 'resolved', '#k': 'cat|sub|late'},
            ExpressionAttributeValues={':entry': {'resolved_at': FIXED_NOW_ISO}, ':max': 500},
        )
        table.get_item.assert_not_called()   # the cap costs no read

    @pytest.mark.usefixtures('fixed_now')
    @pytest.mark.parametrize('first_failure', [_ccfe('no parent'), _client_error('ValidationException', 'bad path')])
    def test_the_parent_map_materialisation(self, route, table, first_failure):
        table.update_item.side_effect = [first_failure, {}, {}]
        response, _ = route('PUT', '/settings/resolved-problems', {'key': 'k', 'resolved': True})
        assert response['statusCode'] == 200
        assert table.update_item.call_args_list[1] == call(
            Key=RESOLVED_KEY,
            UpdateExpression='SET #r = if_not_exists(#r, :empty)',
            ExpressionAttributeNames={'#r': 'resolved'},
            ExpressionAttributeValues={':empty': {}},
        )
        first, _, retry = table.update_item.call_args_list
        assert retry == first
        assert retry.kwargs['ExpressionAttributeNames'] == {'#r': 'resolved', '#k': 'k'}

    @pytest.mark.usefixtures('fixed_now')
    def test_the_slot_freed_by_pruning_is_written_with_the_same_key(self, route, table):
        table.update_item.side_effect = [_ccfe(), {}, _ccfe(), {}, {}]
        table.get_item.return_value = {'Item': {'resolved': {'old': _entry(200)}}}
        response, payload = route('PUT', '/settings/resolved-problems', {'key': 'new', 'resolved': True})
        assert response['statusCode'] == 200
        assert payload == {'success': True, 'key': 'new', 'resolved': True}
        first, _, retry, prune, final = table.update_item.call_args_list
        assert final == retry == first
        assert final.kwargs['ExpressionAttributeNames'] == {'#r': 'resolved', '#k': 'new'}
        assert prune.kwargs['ExpressionAttributeNames'] == {'#r': 'resolved', '#k0': 'old'}

    @pytest.mark.parametrize(('attempts', 'stored'), [
        ([_ccfe(), {}, _ccfe('final')], {'live': _entry(1)}),                 # nothing to prune
        ([_ccfe(), {}, _ccfe(), {}, _ccfe('final')], {'old': _entry(200)}),   # pruned, still full
    ])
    def test_the_cap_error_is_chained_to_the_last_failed_write(self, table, attempts, stored):
        table.update_item.side_effect = attempts
        table.get_item.return_value = {'Item': {'resolved': stored}}
        with pytest.raises(ValidationError) as raised:
            settings_handler._resolve_problem_key('new')
        assert raised.value.__cause__ is attempts[-1]

    def test_the_unresolve_write(self, route, table):
        response, payload = route('PUT', '/settings/resolved-problems', {'key': 'k', 'resolved': False})
        assert response['statusCode'] == 200
        assert payload == {'success': True, 'key': 'k', 'resolved': False}
        table.update_item.assert_called_once_with(
            Key=RESOLVED_KEY,
            UpdateExpression='REMOVE #r.#k',
            ConditionExpression='attribute_exists(#r)',
            ExpressionAttributeNames={'#r': 'resolved', '#k': 'k'},
        )

    @pytest.mark.parametrize('code', ['ProvisionedThroughputExceededException', 'ValidationException'])
    def test_any_other_unresolve_error_is_a_500(self, route, table, code):
        table.update_item.side_effect = _client_error(code)
        response, payload = route('PUT', '/settings/resolved-problems', {'key': 'k', 'resolved': False})
        assert response['statusCode'] == 500
        assert payload['error'] == 'Failed to update problem resolution'

    def test_a_first_attempt_error_other_than_the_two_expected_codes_is_a_500(self, route, table):
        table.update_item.side_effect = _client_error('ProvisionedThroughputExceededException')
        response, payload = route('PUT', '/settings/resolved-problems', {'key': 'k', 'resolved': True})
        assert response['statusCode'] == 500
        assert payload['error'] == 'Failed to update problem resolution'
        assert table.update_item.call_count == 1

    def test_a_retry_error_other_than_the_failed_condition_is_a_500(self, route, table):
        table.update_item.side_effect = [_ccfe(), {}, _client_error('ValidationException')]
        response, payload = route('PUT', '/settings/resolved-problems', {'key': 'k', 'resolved': True})
        assert response['statusCode'] == 500
        assert payload['error'] == 'Failed to update problem resolution'
        table.get_item.assert_not_called()

    def test_a_cap_that_holds_after_pruning_is_the_cap_error(self, route, table):
        table.update_item.side_effect = [_ccfe(), {}, _ccfe(), {}, _ccfe('still full')]
        table.get_item.return_value = {'Item': {'resolved': {'old': _entry(200), 'live': _entry(1)}}}
        response, payload = route('PUT', '/settings/resolved-problems', {'key': 'new', 'resolved': True})
        assert response['statusCode'] == 400
        assert payload['error'] == ('Resolved-problem limit reached (500). '
                                    'Unresolve entries you no longer need first.')
        assert table.update_item.call_count == 5

    def test_a_final_retry_error_other_than_the_failed_condition_is_a_500(self, route, table):
        table.update_item.side_effect = [_ccfe(), {}, _ccfe(), {}, _client_error('ValidationException')]
        table.get_item.return_value = {'Item': {'resolved': {'old': _entry(200)}}}
        response, payload = route('PUT', '/settings/resolved-problems', {'key': 'new', 'resolved': True})
        assert response['statusCode'] == 500
        assert payload['error'] == 'Failed to update problem resolution'

    def test_nothing_to_prune_means_no_final_retry(self, route, table):
        table.update_item.side_effect = [_ccfe(), {}, _ccfe()]
        table.get_item.return_value = {'Item': {'resolved': {'live': _entry(1)}}}
        response, _ = route('PUT', '/settings/resolved-problems', {'key': 'new', 'resolved': True})
        assert response['statusCode'] == 400
        assert table.update_item.call_count == 3


class TestThePrune:
    def test_the_chunked_remove_expressions_cover_every_stale_key_in_order(self, table, logger):
        stale = {f'old {i:02d}': _entry(300) for i in range(45)}
        table.get_item.return_value = {'Item': {'resolved': {**stale, 'live': _entry(1)}}}
        assert settings_handler._prune_expired_entries() == 45
        table.get_item.assert_called_once_with(Key=RESOLVED_KEY)
        calls = table.update_item.call_args_list
        assert [len(c.kwargs['ExpressionAttributeNames']) - 1 for c in calls] == [20, 20, 5]
        removed = [c.kwargs['ExpressionAttributeNames'][alias]
                   for c in calls for alias in c.kwargs['ExpressionAttributeNames'] if alias != '#r']
        assert removed == list(stale)
        assert calls[2] == call(
            Key=RESOLVED_KEY,
            UpdateExpression='REMOVE #r.#k0, #r.#k1, #r.#k2, #r.#k3, #r.#k4',
            ExpressionAttributeNames={'#r': 'resolved', '#k0': 'old 40', '#k1': 'old 41', '#k2': 'old 42',
                                      '#k3': 'old 43', '#k4': 'old 44'},
        )
        logger.info.assert_called_once_with('Pruned expired resolved-problem entries under cap pressure',
                                            extra={'count': 45})

    def test_nothing_stale_means_no_write_and_no_log(self, table, logger):
        table.get_item.return_value = {'Item': {'resolved': {'live': _entry(1)}}}
        assert settings_handler._prune_expired_entries() == 0
        table.update_item.assert_not_called()
        logger.info.assert_not_called()

    def test_a_disabled_ttl_prunes_nothing_without_reading(self, table):
        with patch.object(settings_handler, 'RESOLVED_PROBLEMS_TTL_DAYS', 0):
            assert settings_handler._prune_expired_entries() == 0
        table.get_item.assert_not_called()

    @pytest.mark.parametrize('stored', [{}, {'Item': {}}, {'Item': {'resolved': 'corrupted'}},
                                        {'Item': {'resolved': ['a']}}])
    def test_malformed_or_missing_storage_prunes_nothing(self, table, stored):
        table.get_item.return_value = stored
        assert settings_handler._prune_expired_entries() == 0
        table.update_item.assert_not_called()


class TestExpiry:
    @pytest.mark.usefixtures('fixed_now')
    @pytest.mark.parametrize(('ttl', 'cutoff'), [
        (10, '2026-09-25T12:00:00.000001+00:00'),
        (1, '2026-10-04T12:00:00.000001+00:00'),   # one day is the shortest live TTL
    ])
    def test_the_cutoff_is_ttl_days_before_now(self, ttl, cutoff):
        with patch.object(settings_handler, 'RESOLVED_PROBLEMS_TTL_DAYS', ttl):
            assert settings_handler._resolution_expiry_cutoff() == cutoff

    @pytest.mark.parametrize('ttl', [0, -1])
    def test_a_non_positive_ttl_disables_expiry(self, ttl):
        with patch.object(settings_handler, 'RESOLVED_PROBLEMS_TTL_DAYS', ttl):
            assert settings_handler._resolution_expiry_cutoff() is None

    @pytest.mark.parametrize(('entry', 'expired'), [
        ({'resolved_at': '2026-01-01T00:00:00+00:00'}, False),   # exactly the cutoff is still live
        ({'resolved_at': '2026-01-01T00:00:00.000001+00:00'}, False),
        ({'resolved_at': '2025-12-31T23:59:59+00:00'}, True),
        ({'resolved_at': ''}, True),
        ({'resolved_at': None}, True),
        ({'resolved_at': 20260101}, True),
        ({}, True),
        ('2026-01-01', True),
        (None, True),
    ])
    def test_an_entry_is_expired_strictly_before_the_cutoff(self, entry, expired):
        assert settings_handler._is_expired_entry(entry, '2026-01-01T00:00:00+00:00') is expired

    def test_without_expired_keeps_order_and_passes_everything_when_disabled(self):
        resolved = {'b': _entry(500), 'a': _entry(1)}
        assert settings_handler._without_expired(resolved) == {'a': resolved['a']}
        with patch.object(settings_handler, 'RESOLVED_PROBLEMS_TTL_DAYS', 0):
            assert settings_handler._without_expired(resolved) is resolved
        assert settings_handler._without_expired(['x']) == {}

    def test_get_reads_the_resolved_row(self, route, table):
        table.get_item.return_value = {'Item': {'resolved': {'k': {'resolved_at': '2099-01-01T00:00:00+00:00'}}}}
        response, payload = route('GET', '/settings/resolved-problems')
        assert response['statusCode'] == 200
        assert payload == {'resolved': {'k': {'resolved_at': '2099-01-01T00:00:00+00:00'}}}
        table.get_item.assert_called_once_with(Key=RESOLVED_KEY)


# ── Model settings ───────────────────────────────────────────────────────────

class TestTheModelSettingsRow:
    def test_the_row_is_read_by_its_key(self, route, table):
        route('GET', '/settings/model')
        table.get_item.assert_called_once_with(Key={'pk': 'SETTINGS#model', 'sk': 'config'})

    def test_a_non_dict_surfaces_attribute_reads_as_automatic(self, route, table):
        table.get_item.return_value = {'Item': {'surfaces': 'chat=haiku', 'model_id': OPUS}}
        _, payload = route('GET', '/settings/model')
        assert all(s['selected'] is None for s in payload['surfaces'])
        assert payload['model_id'] == OPUS
        assert [s['key'] for s in payload['surfaces']] == list(PICKER_SURFACES)

    @pytest.mark.usefixtures('fixed_now')
    def test_pinning_a_surface_writes_the_whole_tidy_row(self, route, table):
        table.get_item.return_value = {'Item': {'pk': 'SETTINGS#model', 'sk': 'config', 'surfaces': 'bad'}}
        response, payload = route('PUT', '/settings/model', {'surface': 'documents', 'model_id': OPUS})
        assert response['statusCode'] == 200
        assert payload == {'success': True, 'surface': 'documents', 'model_id': OPUS}
        table.put_item.assert_called_once_with(Item={
            'pk': 'SETTINGS#model', 'sk': 'config', 'surfaces': {'documents': OPUS}, 'updated_at': FIXED_NOW_ISO,
        })

    @pytest.mark.usefixtures('fixed_now')
    def test_clearing_the_last_surface_drops_the_map_from_the_row(self, route, table):
        table.get_item.return_value = {'Item': {'surfaces': {'chat': HAIKU}, 'model_id': OPUS}}
        response, payload = route('PUT', '/settings/model', {'surface': 'chat', 'model_id': None})
        assert response['statusCode'] == 200
        assert payload == {'success': True, 'surface': 'chat', 'model_id': None}
        table.put_item.assert_called_once_with(Item={
            'pk': 'SETTINGS#model', 'sk': 'config', 'model_id': OPUS, 'updated_at': FIXED_NOW_ISO,
        })

    @pytest.mark.usefixtures('fixed_now')
    def test_clearing_the_global_override_drops_it_from_the_row(self, route, table):
        table.get_item.return_value = {'Item': {'surfaces': {'chat': HAIKU}, 'model_id': OPUS}}
        response, payload = route('PUT', '/settings/model', {'model_id': None})
        assert response['statusCode'] == 200
        assert payload == {'success': True, 'surface': None, 'model_id': None}
        table.put_item.assert_called_once_with(Item={
            'pk': 'SETTINGS#model', 'sk': 'config', 'surfaces': {'chat': HAIKU}, 'updated_at': FIXED_NOW_ISO,
        })

    @pytest.mark.usefixtures('fixed_now')
    def test_setting_the_global_override_keeps_the_surfaces(self, route, table):
        table.get_item.return_value = {'Item': {'surfaces': {'chat': HAIKU}}}
        route('PUT', '/settings/model', {'model_id': OPUS})
        table.get_item.assert_called_once_with(Key={'pk': 'SETTINGS#model', 'sk': 'config'})
        table.put_item.assert_called_once_with(Item={
            'pk': 'SETTINGS#model', 'sk': 'config', 'surfaces': {'chat': HAIKU}, 'model_id': OPUS,
            'updated_at': FIXED_NOW_ISO,
        })

    @pytest.mark.usefixtures('fixed_now')
    def test_a_stored_null_global_override_is_dropped_on_the_next_write(self, route, table):
        table.get_item.return_value = {'Item': {'surfaces': {}, 'model_id': None}}
        route('PUT', '/settings/model', {'surface': 'chat', 'model_id': HAIKU})
        table.put_item.assert_called_once_with(Item={
            'pk': 'SETTINGS#model', 'sk': 'config', 'surfaces': {'chat': HAIKU}, 'updated_at': FIXED_NOW_ISO,
        })

    def test_the_cache_is_cleared_after_the_write_not_before_a_refusal(self, route, table):
        with patch.object(settings_handler, 'clear_model_cache') as clear:
            route('PUT', '/settings/model', {'model_id': 'anthropic.evil'})
            clear.assert_not_called()
            table.put_item.side_effect = RuntimeError('boom')
            route('PUT', '/settings/model', {'model_id': OPUS})
            clear.assert_not_called()
            table.put_item.side_effect = None
            route('PUT', '/settings/model', {'model_id': OPUS})
            clear.assert_called_once_with()


# ── Brand ────────────────────────────────────────────────────────────────────

class TestBrand:
    def test_a_row_missing_every_field_reads_as_the_defaults(self, route, table):
        table.get_item.return_value = {'Item': {'pk': 'SETTINGS#brand', 'sk': 'config'}}
        response, payload = route('GET', '/settings/brand')
        assert response['statusCode'] == 200
        assert payload == {'brand_name': '', 'brand_handles': [], 'hashtags': [], 'urls_to_track': []}
        table.get_item.assert_called_once_with(Key={'pk': 'SETTINGS#brand', 'sk': 'config'})

    @pytest.mark.usefixtures('fixed_now')
    def test_a_partial_save_writes_the_whole_row_with_defaults(self, route, table):
        response, payload = route('PUT', '/settings/brand', {'brand_name': 'Acme'})
        assert response['statusCode'] == 200
        assert payload == {
            'success': True, 'message': 'Brand settings saved',
            'settings': {'brand_name': 'Acme', 'brand_handles': [], 'hashtags': [], 'urls_to_track': []},
        }
        table.put_item.assert_called_once_with(Item={
            'pk': 'SETTINGS#brand', 'sk': 'config', 'brand_name': 'Acme', 'brand_handles': [], 'hashtags': [],
            'urls_to_track': [], 'updated_at': FIXED_NOW_ISO,
        })

    def test_a_full_save_echoes_every_field(self, route, table):
        body = {'brand_name': 'Acme', 'brand_handles': ['@acme'], 'hashtags': ['#acme'],
                'urls_to_track': ['https://acme.test']}
        _, payload = route('PUT', '/settings/brand', body)
        assert payload['settings'] == body
        item = table.put_item.call_args.kwargs['Item']
        assert {k: item[k] for k in body} == body

    def test_a_save_without_a_name_stores_an_empty_name(self, route, table):
        _, payload = route('PUT', '/settings/brand', {'hashtags': ['#acme']})
        assert payload['settings'] == {'brand_name': '', 'brand_handles': [], 'hashtags': ['#acme'],
                                       'urls_to_track': []}
        assert table.put_item.call_args.kwargs['Item']['brand_name'] == ''


# ── Categories ───────────────────────────────────────────────────────────────

class TestCategories:
    OWNER: ClassVar[dict[str, object]] = {'sub': 'owner-sub', 'username': 'olga', 'email': 'olga@example.com'}

    def test_no_row_reads_as_an_empty_config_with_a_null_timestamp(self, route, table):
        response, payload = route('GET', '/settings/categories')
        assert response['statusCode'] == 200
        assert payload == {'categories': [], 'updated_at': None}
        table.get_item.assert_called_once_with(Key={'pk': 'SETTINGS#categories', 'sk': 'config'})

    def test_a_row_without_categories_reads_as_empty(self, route, table):
        table.get_item.return_value = {'Item': {'updated_at': 'then'}}
        _, payload = route('GET', '/settings/categories')
        assert payload == {'categories': [], 'updated_at': 'then'}

    def test_a_non_admin_gets_the_redacted_scoped_view(self, route, table):
        table.get_item.return_value = {'Item': {'updated_at': 'then', 'categories': [
            {'name': 'delivery', 'owners': [self.OWNER]}, {'name': 'billing', 'owners': [self.OWNER]}]}}
        scope = CategoryScope(all=False, categories=frozenset({'billing'}))
        with patch.object(settings_handler, 'scope_for_caller', return_value=scope) as scope_for_caller:
            _, payload = route('GET', '/settings/categories', claims=USER)
        assert payload == {'categories': [{'name': 'billing', 'owners': [{'username': 'olga'}]}], 'updated_at': 'then'}
        assert scope_for_caller.call_args.args[1] is table
        assert scope_for_caller.call_args.args[0].subject == 'user-sub'

    def test_the_admin_view_is_verbatim_and_never_consults_the_scope(self, route, table):
        stored = [{'name': 'delivery', 'owners': [self.OWNER], 'junk': 1}]
        table.get_item.return_value = {'Item': {'updated_at': 'then', 'categories': stored}}
        with patch.object(settings_handler, 'scope_for_caller') as scope_for_caller:
            _, payload = route('GET', '/settings/categories')
        assert payload == {'categories': stored, 'updated_at': 'then'}
        scope_for_caller.assert_not_called()

    def test_a_delegated_admin_token_gets_the_redacted_view(self, route, table):
        table.get_item.return_value = {'Item': {'categories': [{'name': 'delivery', 'owners': [self.OWNER]}]}}
        claims = {'sub': 'mcp:tok_1', 'acting_sub': 'user-sub', 'cognito:groups': 'admins'}
        scope = CategoryScope(all=True, categories=frozenset())
        with patch.object(settings_handler, 'scope_for_caller', return_value=scope), \
                patch.object(settings_handler, 'caller_from_event',
                             return_value=SimpleNamespace(is_admin=True, delegated=True, subject='user-sub')):
            _, payload = route('GET', '/settings/categories', claims=claims)
        assert payload['categories'] == [{'name': 'delivery', 'owners': [{'username': 'olga'}]}]

    @pytest.mark.parametrize(('owners', 'public'), [
        ('olga', []),
        (['olga', {'sub': 's'}, {'sub': 's', 'username': 7}, {'sub': 's', 'username': 'olga'}],
         [{'username': ''}, {'username': ''}, {'username': 'olga'}]),
    ])
    def test_public_owners_keep_only_string_usernames(self, owners, public):
        assert settings_handler._public_owners(owners) == public

    def test_redaction_drops_non_dict_categories_and_leaves_ownerless_ones_alone(self):
        scope = CategoryScope(all=True, categories=frozenset())
        categories = ['junk', {'name': 'a'}, {'name': 'b', 'owners': 'x'}, {'name': None}]
        assert settings_handler._redacted_categories(categories, scope) == [
            {'name': 'a'}, {'name': 'b', 'owners': []}, {'name': None}]
        assert settings_handler._redacted_categories({'name': 'a'}, scope) == []
        assert settings_handler._redacted_categories(categories, scope)[1] is not categories[1]

    @pytest.mark.usefixtures('fixed_now')
    def test_a_save_writes_the_normalised_row_and_counts_it(self, route, table):
        response, payload = route('PUT', '/settings/categories', {'categories': [{'name': 'a'}, {'name': 'b'}]})
        assert response['statusCode'] == 200
        assert payload == {'success': True, 'message': 'Saved 2 categories'}
        table.put_item.assert_called_once_with(Item={
            'pk': 'SETTINGS#categories', 'sk': 'config', 'updated_at': FIXED_NOW_ISO,
            'categories': [
                {'name': 'a', 'description': '', 'subcategories': []},
                {'name': 'b', 'description': '', 'subcategories': []},
            ],
        })

    def test_a_save_without_the_key_saves_nothing(self, route, table):
        _, payload = route('PUT', '/settings/categories', {'other': 1})
        assert payload == {'success': True, 'message': 'Saved 0 categories'}
        assert table.put_item.call_args.kwargs['Item']['categories'] == []

    @pytest.mark.usefixtures('table')
    def test_a_non_admin_save_is_refused_before_the_table_is_consulted(self, route):
        with patch.object(settings_handler, 'aggregates_table', None):
            response, payload = route('PUT', '/settings/categories', {'categories': []}, claims=USER)
        assert response['statusCode'] == 403
        assert payload['error'] == 'Admin access required'


class TestGenerateCategories:
    DESCRIPTION = 'We sell running shoes online.'

    @pytest.mark.usefixtures('table')
    def test_the_bedrock_call_and_the_prompt(self, route):
        answer = 'Here you go:\n{"categories": [{"id": "fit", "name": "fit", "description": "Fit", "subcategories": []}]}'
        with patch('shared.converse.converse', return_value=answer) as converse:
            response, payload = route('POST', '/settings/categories/generate',
                                      {'company_description': self.DESCRIPTION})
        assert response['statusCode'] == 200
        assert payload == {'success': True, 'categories': [
            {'id': 'fit', 'name': 'fit', 'description': 'Fit', 'subcategories': []}]}
        assert converse.call_args.kwargs == {
            'prompt': converse.call_args.kwargs['prompt'], 'max_tokens': 4096, 'temperature': 0.3,
            'surface': 'utility',
        }
        prompt = converse.call_args.kwargs['prompt']
        assert prompt.startswith('Based on the following company/product description, generate a comprehensive '
                                 'list of feedback categories and subcategories.\n\nCompany Description:\n'
                                 + self.DESCRIPTION + '\n\nGenerate 6-10 main categories, each with 3-5 relevant '
                                 'subcategories.\n\nReturn ONLY valid JSON in this exact format (no markdown, no '
                                 'explanation):\n{\n  "categories": [\n    {\n      "id": "category_id_snake_case",')
        assert prompt.endswith('"subcategories": [\n        {"id": "subcategory_id_snake_case", "name": '
                               '"subcategory_id_snake_case", "description": "Human Readable Subcategory Name"}\n'
                               '      ]\n    }\n  ]\n}')

    @pytest.mark.usefixtures('table')
    def test_an_answer_without_a_categories_key_is_an_empty_list(self, route):
        with patch('shared.converse.converse', return_value='{"items": []}'):
            _, payload = route('POST', '/settings/categories/generate', {'company_description': self.DESCRIPTION})
        assert payload == {'success': True, 'categories': []}


# ── Company context, personal context ────────────────────────────────────────

DESIGN_KEY = {'pk': 'SETTINGS#design_system', 'sk': 'config'}
REF_ID = 'ref_0123456789ab'
REF_KEY = {'pk': 'SETTINGS#design_system', 'sk': f'REF#{REF_ID}'}


class TestTheCallerUsername:
    @pytest.mark.parametrize(('claims', 'username'), [
        ({'sub': 's', 'cognito:username': ' alice ', 'username': 'bob'}, 'alice'),
        ({'sub': 's', 'cognito:username': '  ', 'username': ' bob '}, 'bob'),
        ({'sub': 's', 'cognito:username': 7, 'email': 'a@b.c'}, None),
        ({'sub': 's'}, None),
    ])
    def test_the_display_username_is_the_first_non_blank_username_claim(self, claims, username):
        event = {'requestContext': {'authorizer': {'claims': claims}}}
        assert settings_handler._caller_username(event) == username

    @pytest.mark.parametrize('event', [{}, {'requestContext': None},
                                       {'requestContext': {'authorizer': {'claims': 'not-a-dict'}}}])
    def test_a_malformed_context_has_no_username(self, event):
        assert settings_handler._caller_username(event) is None

    @pytest.mark.parametrize(('claims', 'label'), [
        ({'sub': 's', 'cognito:username': ' alice ', 'email': 'a@b.c'}, 'alice'),
        ({'sub': 's', 'username': 'bob', 'email': 'a@b.c'}, 'bob'),
        ({'sub': 's', 'cognito:username': '', 'email': ' a@b.c '}, 'a@b.c'),
        ({'sub': 'the-sub', 'email': 7}, 'the-sub'),
        ({'sub': 'the-sub'}, 'the-sub'),
    ])
    def test_the_job_label_falls_back_through_username_email_and_sub(self, claims, label):
        event = {'requestContext': {'authorizer': {'claims': claims}}}
        assert settings_handler._caller_label(event) == label

    def test_the_job_label_of_a_malformed_claims_block_fails_closed(self):
        with pytest.raises(AuthorizationError):
            settings_handler._caller_label({'requestContext': {'authorizer': {'claims': 'nope'}}})


class TestContextWrites:
    @pytest.mark.usefixtures('fixed_now')
    def test_the_company_row_and_its_log_line(self, route, table, logger):
        claims = {'sub': 'admin-sub', 'cognito:username': 'alice', 'cognito:groups': 'admins'}
        response, _ = route('PUT', '/settings/company-context',
                            {'vision': 'Be loved', 'objectives': [{'title': 'Retention', 'horizon': 'long'}]},
                            claims=claims)
        assert response['statusCode'] == 200
        item = table.put_item.call_args.kwargs['Item']
        assert {k: item[k] for k in ('pk', 'sk', 'vision', 'updated_at', 'updated_by_username')} == {
            'pk': 'SETTINGS#company_context', 'sk': 'config', 'vision': 'Be loved',
            'updated_at': FIXED_NOW_ISO, 'updated_by_username': 'alice',
        }
        assert [o['title'] for o in item['objectives']] == ['Retention']
        logger.info.assert_called_once_with('Company context saved', extra={'objectives': 1})
        table.get_item.assert_called_once_with(Key={'pk': 'SETTINGS#company_context', 'sk': 'config'})

    @pytest.mark.usefixtures('fixed_now')
    def test_the_personal_row_is_keyed_by_the_callers_sub(self, route, table):
        response, _ = route('PUT', '/settings/my-context', {'objectives': [{'title': 'Ship'}]}, claims=USER)
        assert response['statusCode'] == 200
        item = table.put_item.call_args.kwargs['Item']
        assert {k: item[k] for k in ('pk', 'sk', 'updated_at')} == {
            'pk': 'USERCTX#user-sub', 'sk': 'config', 'updated_at': FIXED_NOW_ISO}
        assert [o['title'] for o in item['objectives']] == ['Ship']
        assert 'updated_by_username' not in item
        table.get_item.assert_called_once_with(Key={'pk': 'USERCTX#user-sub', 'sk': 'config'})

    def test_my_context_is_read_for_the_callers_sub(self, route, table):
        response, payload = route('GET', '/settings/my-context', claims=USER)
        assert response['statusCode'] == 200
        assert payload == {'objectives': [], 'updated_at': None}
        table.get_item.assert_called_once_with(Key={'pk': 'USERCTX#user-sub', 'sk': 'config'})


# ── Design integrations secret ───────────────────────────────────────────────

@pytest.fixture
def secrets():
    client = MagicMock()
    with patch.object(settings_handler, 'DESIGN_INTEGRATIONS_SECRET_ARN', 'arn:secret'), \
            patch.object(settings_handler, 'get_secrets_client', return_value=client), \
            patch.object(settings_handler, 'put_secret_json') as put_secret_json:
        client.put_secret_json = put_secret_json
        yield client


class TestTheIntegrationSecret:
    def test_it_is_read_fresh_by_its_arn(self, secrets):
        secrets.get_secret_value.return_value = {'SecretString': '{"figma_token": "f"}'}
        assert settings_handler._read_integration_secret() == {'figma_token': 'f'}
        assert settings_handler._read_integration_secret() == {'figma_token': 'f'}
        assert secrets.get_secret_value.call_args_list == [call(SecretId='arn:secret')] * 2

    def test_no_arn_means_an_empty_secret_without_a_read(self, secrets):
        with patch.object(settings_handler, 'DESIGN_INTEGRATIONS_SECRET_ARN', ''):
            assert settings_handler._read_integration_secret() == {}
        secrets.get_secret_value.assert_not_called()

    @pytest.mark.parametrize('stored', [{'SecretString': None}, {'SecretString': ''}, {}, {'SecretString': '[1]'},
                                        {'SecretString': '"x"'}])
    def test_an_empty_or_non_object_secret_reads_as_empty(self, secrets, logger, stored):
        secrets.get_secret_value.return_value = stored
        assert settings_handler._read_integration_secret() == {}
        logger.warning.assert_not_called()

    def test_a_missing_secret_is_empty_and_silent(self, secrets, logger):
        secrets.get_secret_value.side_effect = ClientError({'Error': {'Code': 'ResourceNotFoundException'}}, 'Get')
        assert settings_handler._read_integration_secret() == {}
        logger.warning.assert_not_called()

    @pytest.mark.parametrize(('failure', 'warning'), [
        (ClientError({'Error': {'Code': 'AccessDeniedException'}}, 'Get'), 'Design integrations secret unreadable'),
        (ClientError({'Error': {}}, 'Get'), 'Design integrations secret unreadable'),
    ])
    def test_an_unreadable_secret_is_empty_and_warned(self, secrets, logger, failure, warning):
        secrets.get_secret_value.side_effect = failure
        assert settings_handler._read_integration_secret() == {}
        logger.warning.assert_called_once_with(warning)

    def test_a_non_json_secret_is_empty_and_warned(self, secrets, logger):
        secrets.get_secret_value.return_value = {'SecretString': 'not json'}
        assert settings_handler._read_integration_secret() == {}
        logger.warning.assert_called_once_with('Design integrations secret is not JSON')

    @pytest.mark.parametrize(('secret', 'status'), [
        ({}, {'figma': False, 'github': False}),
        ({'figma_token': 'f', 'github_token': 'g'}, {'figma': True, 'github': True}),
        ({'figma_token': '', 'github_token': 7}, {'figma': False, 'github': False}),
        ({'figma_token': ['f']}, {'figma': False, 'github': False}),
    ])
    def test_the_status_is_whether_a_non_empty_string_token_is_set(self, secret, status):
        assert settings_handler._integrations_status(secret) == status


class TestIntegrationWrites:
    @pytest.mark.usefixtures('table')
    def test_tokens_are_stripped_and_written_with_the_log_line(self, route, secrets, logger):
        secrets.get_secret_value.return_value = {'SecretString': '{"figma_token": "old", "extra": 1}'}
        response, payload = route('PUT', '/settings/design-system/integrations',
                                  {'github_token': '  gh  ', 'figma_token': 'x' * 1000})
        assert response['statusCode'] == 200
        assert payload == {'integrations': {'figma': True, 'github': True}}
        secrets.put_secret_json.assert_called_once_with(
            secrets, 'arn:secret', {'figma_token': 'x' * 1000, 'extra': 1, 'github_token': 'gh'})
        logger.info.assert_called_once_with('Design integrations updated',
                                            extra={'fields': ['figma_token', 'github_token']})

    @pytest.mark.parametrize('cleared', [None, ''])
    @pytest.mark.usefixtures('table')
    def test_null_or_empty_clears_a_token_and_leaves_the_other(self, route, secrets, logger, cleared):
        secrets.get_secret_value.return_value = {'SecretString': '{"figma_token": "f", "github_token": "g"}'}
        response, payload = route('PUT', '/settings/design-system/integrations', {'figma_token': cleared})
        assert response['statusCode'] == 200
        assert payload == {'integrations': {'figma': False, 'github': True}}
        secrets.put_secret_json.assert_called_once_with(secrets, 'arn:secret', {'github_token': 'g'})
        logger.info.assert_called_once_with('Design integrations updated', extra={'fields': ['figma_token']})

    @pytest.mark.usefixtures('table')
    def test_a_body_naming_no_field_rewrites_the_secret_unchanged(self, route, secrets, logger):
        secrets.get_secret_value.return_value = {'SecretString': '{"figma_token": "f"}'}
        response, payload = route('PUT', '/settings/design-system/integrations', {'figma_token': 'f'})
        assert response['statusCode'] == 200
        assert payload == {'integrations': {'figma': True, 'github': False}}
        secrets.put_secret_json.assert_called_once_with(secrets, 'arn:secret', {'figma_token': 'f'})
        logger.info.assert_called_once_with('Design integrations updated', extra={'fields': ['figma_token']})


# ── Design system view, logo ─────────────────────────────────────────────────

@pytest.fixture
def s3():
    client = MagicMock()
    client.generate_presigned_url.return_value = 'https://s3/presigned'
    with patch.object(settings_handler, 'get_s3_client', return_value=client), \
            patch.object(settings_handler, 'RAW_DATA_BUCKET', 'the-bucket'):
        yield client


LOGO_KEY = 'company-context/design/logo_0123456789ab.png'
PENDING_KEY = 'company-context/design/logo_abcdef012345.webp'


class TestTheDesignView:
    @pytest.mark.parametrize(('query', 'claims', 'include_archived'), [
        ({'include_archived': 'true'}, None, True),
        ({'include_archived': 'true'}, USER, False),
        ({'include_archived': 'True'}, None, False),
        ({'include_archived': '1'}, None, False),
        ({}, None, False),
    ])
    @pytest.mark.usefixtures('s3')
    def test_archived_references_are_included_only_for_an_admin_asking_true(
            self, route, table, secrets, query, claims, include_archived):
        secrets.get_secret_value.return_value = {'SecretString': '{}'}
        with patch.object(settings_handler.company_context, 'get_design_system',
                          return_value={'tokens': {}}) as get_design_system:
            response, payload = route('GET', '/settings/design-system', query_params=query, claims=claims)
        assert response['statusCode'] == 200
        get_design_system.assert_called_once_with(table, include_archived=include_archived)
        assert payload == {'tokens': {}, 'integrations': {'figma': False, 'github': False}}

    def test_the_view_carries_the_signed_logo_url(self, route, table, s3, secrets):
        secrets.get_secret_value.return_value = {'SecretString': '{}'}
        table.get_item.return_value = {'Item': {'logo_s3_key': LOGO_KEY}}
        table.query.return_value = {'Items': []}
        _, payload = route('GET', '/settings/design-system')
        assert payload['logo_url'] == 'https://s3/presigned'
        s3.generate_presigned_url.assert_called_once_with(
            ClientMethod='get_object', Params={'Bucket': 'the-bucket', 'Key': LOGO_KEY}, ExpiresIn=3600)
        s3.head_object.assert_not_called()

    def test_no_bucket_means_no_logo_and_no_logo_read(self, table):
        with patch.object(settings_handler, 'RAW_DATA_BUCKET', ''):
            assert settings_handler._current_logo_key(table) is None
        table.get_item.assert_not_called()

    @pytest.mark.parametrize('stored', [{}, {'Item': {}}, {'Item': {'logo_s3_key': 'company-context/design/ref_x.png'}},
                                        {'Item': {'logo_s3_key': 7}}])
    @pytest.mark.usefixtures('s3')
    def test_no_logo_key_or_one_outside_the_logo_prefix_is_no_logo(self, table, stored):
        table.get_item.return_value = stored
        assert settings_handler._current_logo_key(table) is None
        table.get_item.assert_called_once_with(Key=DESIGN_KEY)
        table.update_item.assert_not_called()

    def test_a_pending_upload_that_has_not_landed_leaves_the_current_logo(self, table, s3):
        table.get_item.return_value = {'Item': {'logo_s3_key': LOGO_KEY, 'logo_pending_s3_key': PENDING_KEY}}
        s3.head_object.side_effect = ClientError({'Error': {'Code': '404'}}, 'HeadObject')
        assert settings_handler._current_logo_key(table) == LOGO_KEY
        s3.head_object.assert_called_once_with(Bucket='the-bucket', Key=PENDING_KEY)
        table.update_item.assert_not_called()

    @pytest.mark.usefixtures('s3')
    def test_a_landed_upload_is_promoted_with_a_guarded_write(self, table):
        table.get_item.return_value = {'Item': {'logo_s3_key': LOGO_KEY, 'logo_pending_s3_key': PENDING_KEY}}
        assert settings_handler._current_logo_key(table) == PENDING_KEY
        table.update_item.assert_called_once_with(
            Key=DESIGN_KEY,
            UpdateExpression='SET #k = :p REMOVE #pk',
            ConditionExpression='#pk = :p',
            ExpressionAttributeNames={'#k': 'logo_s3_key', '#pk': 'logo_pending_s3_key'},
            ExpressionAttributeValues={':p': PENDING_KEY},
        )

    def test_a_pending_key_outside_the_prefix_is_never_promoted(self, table, s3):
        table.get_item.return_value = {'Item': {'logo_s3_key': LOGO_KEY, 'logo_pending_s3_key': 'elsewhere/x.png'}}
        assert settings_handler._current_logo_key(table) == LOGO_KEY
        s3.head_object.assert_not_called()

    @pytest.mark.usefixtures('s3')
    def test_a_promotion_lost_to_another_reader_still_shows_the_new_logo(self, table):
        table.get_item.return_value = {'Item': {'logo_pending_s3_key': PENDING_KEY}}
        table.update_item.side_effect = _ccfe('already promoted')
        assert settings_handler._current_logo_key(table) == PENDING_KEY

    @pytest.mark.usefixtures('s3')
    def test_any_other_promotion_failure_raises(self, table):
        table.get_item.return_value = {'Item': {'logo_pending_s3_key': PENDING_KEY}}
        table.update_item.side_effect = _client_error('ProvisionedThroughputExceededException')
        with pytest.raises(ClientError):
            settings_handler._current_logo_key(table)

    def test_the_head_check_is_true_only_when_the_object_exists(self, s3):
        assert settings_handler._uploaded(PENDING_KEY) is True
        s3.head_object.assert_called_once_with(Bucket='the-bucket', Key=PENDING_KEY)
        s3.head_object.side_effect = ClientError({'Error': {'Code': '403'}}, 'HeadObject')
        assert settings_handler._uploaded(PENDING_KEY) is False


class TestTheLogoUpload:
    @pytest.mark.usefixtures('fixed_now')
    def test_the_pending_write_and_the_signed_put(self, route, table, s3):
        with patch.object(settings_handler.company_context, 'new_id', return_value='logo_0123456789ab') as new_id:
            response, payload = route('POST', '/settings/design-system/logo',
                                      {'content_type': 'image/webp', 'size_bytes': 2048})
        assert response['statusCode'] == 201
        assert response['multiValueHeaders']['Content-Type'] == ['application/json']
        new_id.assert_called_once_with('logo')
        key = 'company-context/design/logo_0123456789ab.webp'
        table.update_item.assert_called_once_with(
            Key=DESIGN_KEY,
            UpdateExpression='SET #pk = :key, updated_at = :now',
            ExpressionAttributeNames={'#pk': 'logo_pending_s3_key'},
            ExpressionAttributeValues={':key': key, ':now': FIXED_NOW_ISO},
        )
        s3.generate_presigned_url.assert_called_once_with(
            ClientMethod='put_object',
            Params={'Bucket': 'the-bucket', 'Key': key, 'ContentType': 'image/webp', 'ContentLength': 2048},
            ExpiresIn=600,
        )
        assert payload == {'upload': {'url': 'https://s3/presigned', 'method': 'PUT',
                                      'headers': {'Content-Type': 'image/webp'}, 'expires_in': 600}}

    @pytest.mark.usefixtures('s3')
    def test_a_non_admin_cannot_start_one(self, route, table):
        response, payload = route('POST', '/settings/design-system/logo',
                                  {'content_type': 'image/png', 'size_bytes': 1}, claims=USER)
        assert response['statusCode'] == 403
        assert payload['error'] == 'Admin access required'
        table.update_item.assert_not_called()


class TestTheDesignSystemWrite:
    @pytest.mark.usefixtures('s3', 'fixed_now')
    def test_the_logo_attributes_under_the_prefix_are_carried_over(self, route, table, secrets):
        secrets.get_secret_value.return_value = {'SecretString': '{}'}
        table.get_item.return_value = {'Item': {
            'logo_s3_key': LOGO_KEY, 'logo_pending_s3_key': 'elsewhere/x.png', 'guidelines': 'old'}}
        table.query.return_value = {'Items': []}
        claims = {'sub': 'admin-sub', 'cognito:username': 'alice', 'cognito:groups': 'admins'}
        response, _ = route('PUT', '/settings/design-system',
                            {'tokens': {'colors': [], 'typography': []}, 'guidelines': 'Calm.'}, claims=claims)
        assert response['statusCode'] == 200
        table.put_item.assert_called_once_with(Item={
            'pk': 'SETTINGS#design_system', 'sk': 'config',
            'tokens': {'colors': [], 'typography': []}, 'guidelines': 'Calm.',
            'logo_s3_key': LOGO_KEY, 'updated_at': FIXED_NOW_ISO, 'updated_by_username': 'alice',
        })
        assert table.get_item.call_args_list[0] == call(Key=DESIGN_KEY)

    @pytest.mark.usefixtures('fixed_now')
    def test_a_pending_logo_is_carried_too(self, route, table, s3, secrets):
        secrets.get_secret_value.return_value = {'SecretString': '{}'}
        table.get_item.return_value = {'Item': {'logo_pending_s3_key': PENDING_KEY}}
        table.query.return_value = {'Items': []}
        s3.head_object.side_effect = ClientError({'Error': {'Code': '404'}}, 'HeadObject')
        route('PUT', '/settings/design-system', {'tokens': {'colors': [], 'typography': []}, 'guidelines': ''})
        item = table.put_item.call_args.kwargs['Item']
        assert item['logo_pending_s3_key'] == PENDING_KEY
        assert 'logo_s3_key' not in item
        assert item['updated_by_username'] is None

    def test_the_view_after_a_save_never_includes_archived_references(self, route, table, s3, secrets):
        secrets.get_secret_value.return_value = {'SecretString': '{}'}
        with patch.object(settings_handler.company_context, 'get_design_system',
                          return_value={'tokens': {}}) as get_design_system:
            response, payload = route('PUT', '/settings/design-system',
                                      {'tokens': {'colors': [], 'typography': []}, 'guidelines': ''})
        assert response['statusCode'] == 200
        get_design_system.assert_called_once_with(table, include_archived=False)
        assert payload == {'tokens': {}, 'integrations': {'figma': False, 'github': False}}
        s3.head_object.assert_not_called()


# ── Design references ────────────────────────────────────────────────────────

@pytest.fixture
def invoke():
    with patch.object(settings_handler, 'invoke_lambda_async') as mock, \
            patch.dict('os.environ', {'AWS_LAMBDA_FUNCTION_NAME': 'voc-settings-api'}):
        yield mock


class TestReferenceWrites:
    LINK: ClassVar[dict[str, object]] = {'kind': 'github', 'title': 'Repo', 'url': 'https://github.com/acme/ui'}

    @pytest.mark.usefixtures('fixed_now')
    def test_a_link_reference_row_and_the_refresh_it_starts(self, route, table, invoke):
        table.query.return_value = {'Items': [{'id': f'ref_{i:012x}', 'status': 'ready'} for i in range(49)]}
        table.get_item.return_value = {'Item': {**REF_KEY, 'id': REF_ID, **self.LINK, 'status': 'pending',
                                                'created_at': FIXED_NOW_ISO, 'updated_at': FIXED_NOW_ISO}}
        with patch.object(settings_handler.company_context, 'new_id', return_value=REF_ID) as new_id:
            response, payload = route('POST', '/settings/design-system/references', self.LINK)
        assert response['statusCode'] == 201
        new_id.assert_called_once_with('ref')
        table.put_item.assert_called_once_with(Item={
            **REF_KEY, 'id': REF_ID, 'kind': 'github', 'title': 'Repo', 'url': 'https://github.com/acme/ui',
            'status': 'pending', 'created_at': FIXED_NOW_ISO, 'updated_at': FIXED_NOW_ISO,
        })
        invoke.assert_called_once_with('voc-settings-api', {'action': 'design_reference_refresh', 'ref_id': REF_ID})
        assert payload == {'reference': {
            'id': REF_ID, 'kind': 'github', 'title': 'Repo', 'status': 'pending', 'created_at': FIXED_NOW_ISO,
            'updated_at': FIXED_NOW_ISO, 'url': 'https://github.com/acme/ui'}}
        table.get_item.assert_called_once_with(Key=REF_KEY)

    @pytest.mark.usefixtures('fixed_now')
    def test_an_upload_reference_row_carries_its_key_and_type(self, route, table, s3, invoke):
        table.query.return_value = {'Items': []}
        table.get_item.return_value = {'Item': {'id': REF_ID, 'kind': 'html', 'status': 'pending'}}
        body = {'kind': 'html', 'title': 'Home', 'content_type': 'text/html', 'size_bytes': 77}
        with patch.object(settings_handler.company_context, 'new_id', return_value=REF_ID):
            response, payload = route('POST', '/settings/design-system/references', body)
        assert response['statusCode'] == 201
        key = f'company-context/design/{REF_ID}.html'
        table.put_item.assert_called_once_with(Item={
            **REF_KEY, 'id': REF_ID, 'kind': 'html', 'title': 'Home', 'status': 'pending',
            'created_at': FIXED_NOW_ISO, 'updated_at': FIXED_NOW_ISO, 's3_key': key, 'content_type': 'text/html',
        })
        s3.generate_presigned_url.assert_called_once_with(
            ClientMethod='put_object',
            Params={'Bucket': 'the-bucket', 'Key': key, 'ContentType': 'text/html', 'ContentLength': 77},
            ExpiresIn=600,
        )
        assert payload['upload'] == {'url': 'https://s3/presigned', 'method': 'PUT',
                                     'headers': {'Content-Type': 'text/html'}, 'expires_in': 600}
        assert payload['reference']['id'] == REF_ID
        invoke.assert_not_called()

    @pytest.mark.usefixtures('fixed_now')
    def test_the_refresh_write_and_its_202(self, route, table, invoke):
        table.get_item.return_value = {'Item': {'id': REF_ID, 'kind': 'github', 'status': 'error'}}
        response, payload = route('POST', f'/settings/design-system/references/{REF_ID}/refresh')
        assert response['statusCode'] == 202
        assert response['multiValueHeaders']['Content-Type'] == ['application/json']
        table.update_item.assert_called_once_with(
            Key=REF_KEY,
            UpdateExpression='SET #st = :pending, #u = :u REMOVE #e',
            ExpressionAttributeNames={'#st': 'status', '#u': 'updated_at', '#e': 'error'},
            ExpressionAttributeValues={':pending': 'pending', ':u': FIXED_NOW_ISO},
        )
        invoke.assert_called_once_with('voc-settings-api', {'action': 'design_reference_refresh', 'ref_id': REF_ID})
        assert payload == {'reference': {'id': REF_ID, 'kind': 'github', 'title': '', 'status': 'error',
                                         'created_at': None, 'updated_at': None}}

    @pytest.mark.usefixtures('fixed_now')
    def test_the_archive_write(self, route, table):
        table.get_item.return_value = {'Item': {'id': REF_ID, 'kind': 'figma', 'status': 'ready'}}
        response, payload = route('DELETE', f'/settings/design-system/references/{REF_ID}')
        assert response['statusCode'] == 200
        table.update_item.assert_called_once_with(
            Key=REF_KEY,
            UpdateExpression='SET #st = :archived, #u = :u',
            ExpressionAttributeNames={'#st': 'status', '#u': 'updated_at'},
            ExpressionAttributeValues={':archived': 'archived', ':u': FIXED_NOW_ISO},
        )
        assert payload['reference']['id'] == REF_ID

    @pytest.mark.parametrize(('method', 'path'), [
        ('POST', '/settings/design-system/references'),
        ('POST', f'/settings/design-system/references/{REF_ID}/refresh'),
        ('DELETE', f'/settings/design-system/references/{REF_ID}'),
        ('PUT', '/settings/design-system'),
        ('PUT', '/settings/company-context'),
    ])
    def test_a_non_admin_is_refused_before_any_read(self, route, table, method, path):
        response, payload = route(method, path, {'kind': 'github'}, claims=USER)
        assert response['statusCode'] == 403
        assert payload['error'] == 'Admin access required'
        table.get_item.assert_not_called()
        table.put_item.assert_not_called()


class TestStartingARefresh:
    @pytest.mark.usefixtures('fixed_now')
    @pytest.mark.parametrize('environment', [{}, {'AWS_LAMBDA_FUNCTION_NAME': ''}])
    def test_without_a_function_name_the_failure_is_recorded_on_the_reference(
            self, table, logger, monkeypatch, environment):
        monkeypatch.delenv('AWS_LAMBDA_FUNCTION_NAME', raising=False)
        for name, value in environment.items():
            monkeypatch.setenv(name, value)
        with patch.object(settings_handler, 'invoke_lambda_async') as invoke, \
                patch.object(settings_handler.design_references, 'record_outcome') as record_outcome:
            settings_handler._start_reference_refresh(table, REF_ID)
        invoke.assert_not_called()
        logger.warning.assert_called_once_with('Could not start design reference refresh: RuntimeError')
        record_outcome.assert_called_once_with(
            table, REF_ID, {'status': 'error', 'error': 'Could not start the refresh; try again'}, FIXED_NOW_ISO)

    @pytest.mark.usefixtures('fixed_now')
    def test_a_refused_invoke_is_recorded_with_its_type(self, table, logger, invoke):
        invoke.side_effect = PermissionError('AccessDenied')
        with patch.object(settings_handler.design_references, 'record_outcome') as record_outcome:
            settings_handler._start_reference_refresh(table, REF_ID)
        logger.warning.assert_called_once_with('Could not start design reference refresh: PermissionError')
        record_outcome.assert_called_once_with(
            table, REF_ID, {'status': 'error', 'error': 'Could not start the refresh; try again'}, FIXED_NOW_ISO)

    @pytest.mark.usefixtures('invoke')
    def test_a_started_refresh_records_nothing(self, table, logger):
        with patch.object(settings_handler.design_references, 'record_outcome') as record_outcome:
            settings_handler._start_reference_refresh(table, REF_ID)
        record_outcome.assert_not_called()
        logger.warning.assert_not_called()


class TestTheWorkerBranch:
    EVENT: ClassVar[dict[str, object]] = {'action': 'design_reference_refresh', 'ref_id': REF_ID}

    def test_the_reference_is_processed_with_the_named_collaborators(self, table, s3, secrets, logger, lambda_context):
        secrets.get_secret_value.return_value = {'SecretString': '{"github_token": "gh"}'}
        item = {'id': REF_ID, 'kind': 'github', 'status': 'pending'}
        table.get_item.return_value = {'Item': item}
        with patch.object(settings_handler.design_references, 'process_reference',
                          return_value={'status': 'ready', 'extracted_summary': 'x'}) as process:
            assert lambda_handler(self.EVENT, lambda_context) == {'status': 'ready'}
        process.assert_called_once()
        passed_table, passed_item, deps = process.call_args.args
        assert passed_table is table
        assert passed_item == item
        assert (deps.s3, deps.bucket, deps.secrets) == (s3, 'the-bucket', {'github_token': 'gh'})
        assert deps.summarise is settings_handler.design_references.summarise_text
        assert deps.summarise_image is settings_handler.design_references.summarise_image
        logger.info.assert_called_once_with('Design reference processed', extra={'kind': 'github', 'status': 'ready'})
        table.get_item.assert_called_once_with(Key=REF_KEY)

    @pytest.mark.parametrize('stored', [{}, {'Item': {'id': REF_ID, 'status': 'archived'}}])
    def test_a_missing_or_archived_reference_is_skipped(self, table, logger, lambda_context, stored):
        table.get_item.return_value = stored
        with patch.object(settings_handler.design_references, 'process_reference') as process:
            assert lambda_handler(self.EVENT, lambda_context) == {'status': 'skipped'}
        process.assert_not_called()
        logger.info.assert_called_once_with('Design reference refresh skipped (missing or archived)')

    @pytest.mark.parametrize('ref_id', [None, 7, ['ref_0123456789ab']])
    def test_a_non_string_id_is_skipped_without_a_read(self, table, lambda_context, ref_id):
        assert lambda_handler({'action': 'design_reference_refresh', 'ref_id': ref_id}, lambda_context) == {
            'status': 'skipped'}
        table.get_item.assert_not_called()

    @pytest.mark.usefixtures('table')
    def test_another_action_on_an_api_event_is_routed_normally(self, route):
        with patch.object(settings_handler, '_process_reference_event') as process:
            response, _ = route('GET', '/settings/brand', headers={'x-action': 'design_reference_refresh'})
        assert response['statusCode'] == 200
        process.assert_not_called()

    @pytest.mark.usefixtures('table')
    def test_a_direct_event_with_another_action_is_not_the_worker(self, lambda_context):
        with patch.object(settings_handler, '_process_reference_event') as process, \
                patch.object(settings_handler.app, 'resolve', return_value={'statusCode': 200}) as resolve:
            assert lambda_handler({'action': 'other', 'ref_id': REF_ID}, lambda_context) == {'statusCode': 200}
        process.assert_not_called()
        resolve.assert_called_once_with({'action': 'other', 'ref_id': REF_ID}, lambda_context)
