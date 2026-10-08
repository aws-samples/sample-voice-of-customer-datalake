"""Mutation hardening for `api/integrations_handler.py`.

The earlier suites pin the security properties of every route — the admin gates,
the source allowlist, the namespace prefix, the seeded-default comparison — but
read most answers loosely (`statusCode == 400`, `'webscraper' in body`). A
mutation run found what none of them could see:

* the WORDING of every refusal and every fixed string: the 400/500 messages
  (including the 40-character preview of a rejected key or source), the
  `logger` lines, and the success bodies of the credentials, run, enable and
  disable routes;
* the ACCEPTED side of both request bounds: exactly 20 credential keys and
  exactly 50 sources pass, 21 and 51 do not;
* the exact AWS calls: the ingestor invoke (`lambda` client, `Event`, payload
  bytes), the `SOURCE_RUN#<source>` row and its query (`ScanIndexForward=False`,
  `Limit=1`), and every field of the run-status answer with its defaults;
* the degraded paths: a `GetSecretValue` answer with no `SecretString` reads as
  an empty secret, an absent `PLUGIN_SECRET_DEFAULTS` logs nothing, one
  malformed entry does not hide the entries after it, a malformed run body runs
  every app, an invoke answer without `StatusCode` is reported as status 0;
* the cold-start state: which environment variable each setting is read from
  (and the precedence of `DEPLOY_*` over `AWS_*`), the two clients' services,
  the SnapStart warmers, and that every route is the tracer's wrapper.
"""
from __future__ import annotations

import json
import re
import sys
import uuid
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from types import ModuleType, SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, call, patch

import pytest
from boto3.dynamodb.conditions import Key
from handler_events_fixtures import aws_error, call_route
from integrations_fixtures import ingestor_behind, secret_string
from module_reload_fixtures import reload_cycle

import integrations_handler as h
from shared.plugin_identity import PLUGIN_IDENTIFIER_RULES
from shared.snapstart import BOTOCORE_MODEL_FILES
from shared.test.instrumentation_fixtures import assert_handler_wrapped, assert_tracer_wrapped

pytestmark = pytest.mark.usefixtures('plugin_secret_defaults')

ROUTES = [
    'get_integration_status', 'get_credentials', 'update_credentials', 'list_app_configs',
    'save_app_config', 'delete_app_config', 'run_source', 'get_sources_status',
    'enable_source', 'disable_source',
]


@pytest.fixture
def route(api_gateway_event, lambda_context) -> Callable[..., tuple[int, Any]]:
    """`route(method, path, **event)` → `(statusCode, decoded body)`; the path
    parameters are filled from the path's shape."""
    def _route(method: str, path: str, **event_kwargs: Any) -> tuple[int, Any]:
        parts = path.strip('/').split('/')
        path_params = {}
        if len(parts) >= 2 and parts[0] in ('integrations', 'sources') and parts[1] != 'status':
            path_params['source'] = parts[1]
        if len(parts) == 4 and parts[2] == 'apps':
            path_params['app_id'] = parts[3]
        response, body = call_route(
            h.lambda_handler, api_gateway_event, lambda_context,
            method=method, path=path, path_params=path_params, **event_kwargs,
        )
        return response['statusCode'], body
    return _route


@pytest.fixture
def secrets() -> Iterator[MagicMock]:
    with patch.object(h, 'secretsmanager') as client:
        client.get_secret_value.return_value = secret_string({})
        yield client


@pytest.fixture
def put() -> Iterator[MagicMock]:
    with patch.object(h, 'put_secret_json') as mock:
        yield mock


@pytest.fixture
def logger() -> Iterator[MagicMock]:
    with patch.object(h, 'logger') as mock:
        yield mock


@pytest.fixture
def no_secrets_arn() -> Iterator[None]:
    with patch.object(h, 'SECRETS_ARN', ''):
        yield


@pytest.fixture
def events() -> Iterator[MagicMock]:
    with patch.object(h, 'events_client') as client:
        client.exceptions.ResourceNotFoundException = type('ResourceNotFoundException', (Exception,), {})
        yield client


@pytest.fixture
def table() -> Iterator[MagicMock]:
    with patch('shared.tables.get_aggregates_table') as get_table:
        mock_table = MagicMock()
        get_table.return_value = mock_table
        yield mock_table


def _written(put: MagicMock) -> dict:
    """The secret dict the one `put_secret_json` call wrote."""
    put.assert_called_once()
    (_client, arn, written), _ = put.call_args
    assert arn == h.SECRETS_ARN
    return written


# ============================================
# Module state
# ============================================

class TestTheColdStartModuleState:
    def test_the_bounds_are_the_documented_ones(self):
        assert (h.MAX_CREDENTIAL_KEYS_PER_REQUEST, h.MAX_SOURCES_PER_STATUS_REQUEST) == (20, 50)
        assert h.MAX_PARALLEL_RULE_DESCRIBES == 8
        assert h.PLUGIN_DEFAULTS_ENV_VAR == 'PLUGIN_SECRET_DEFAULTS'
        assert sorted(h.APP_CONFIG_PLUGINS) == ['app_reviews_android', 'app_reviews_ios']

    def test_the_aws_clients_are_the_named_services(self):
        assert h.secretsmanager.meta.service_model.service_name == 'secretsmanager'
        assert h.events_client.meta.service_model.service_name == 'events'

    @pytest.fixture
    def reload_with_env(self, monkeypatch) -> Iterator[Callable[..., ModuleType]]:
        yield from reload_cycle(monkeypatch, h)

    _UNSET = dict.fromkeys((
        'SECRETS_ARN', 'DEPLOY_ACCOUNT_ID', 'AWS_ACCOUNT_ID', 'DEPLOY_REGION', 'AWS_REGION',
        'INGESTOR_FUNCTION_NAME_PATTERN', 'INGEST_SCHEDULE_RULE_NAME_PATTERN',
    ))

    def test_every_unset_setting_reads_as_empty(self, reload_with_env):
        reloaded = reload_with_env(**self._UNSET)
        assert (reloaded.SECRETS_ARN, reloaded.AWS_ACCOUNT_ID, reloaded.AWS_REGION) == ('', '', '')
        assert reloaded.INGESTOR_FUNCTION_NAME_PATTERN == ''
        assert reloaded.INGEST_SCHEDULE_RULE_NAME_PATTERN == ''

    def test_each_setting_is_read_by_its_name_and_deploy_wins(self, reload_with_env):
        reloaded = reload_with_env(**{
            **self._UNSET,
            'SECRETS_ARN': 'arn:x', 'DEPLOY_ACCOUNT_ID': '111', 'AWS_ACCOUNT_ID': '222',
            'DEPLOY_REGION': 'eu-west-1', 'AWS_REGION': 'us-west-2',
            'INGESTOR_FUNCTION_NAME_PATTERN': 'fn-{source}',
            'INGEST_SCHEDULE_RULE_NAME_PATTERN': 'rule-{source}',
        })
        assert (reloaded.SECRETS_ARN, reloaded.AWS_ACCOUNT_ID, reloaded.AWS_REGION) == (
            'arn:x', '111', 'eu-west-1',
        )
        assert reloaded.INGESTOR_FUNCTION_NAME_PATTERN == 'fn-{source}'
        assert reloaded.INGEST_SCHEDULE_RULE_NAME_PATTERN == 'rule-{source}'

    def test_without_deploy_values_the_runtime_ones_are_used(self, reload_with_env):
        reloaded = reload_with_env(**{**self._UNSET, 'AWS_ACCOUNT_ID': '222', 'AWS_REGION': 'us-west-2'})
        assert (reloaded.AWS_ACCOUNT_ID, reloaded.AWS_REGION) == ('222', 'us-west-2')

    def test_the_snapstart_hooks_prime_the_defaults_and_the_dynamodb_and_lambda_models(
        self, reload_with_env, monkeypatch
    ):
        registered: list[tuple] = []
        fake = SimpleNamespace(
            register_before_snapshot=lambda _prime, warmers: registered.append(warmers),
            register_after_restore=lambda _reseed: None,
        )
        monkeypatch.setitem(sys.modules, 'snapshot_restore_py', fake)
        reloaded = reload_with_env()
        (warmers,) = registered
        assert warmers[0] is reloaded._plugin_secret_defaults
        session = MagicMock()
        with patch('boto3._get_default_session', return_value=session):
            warmers[1]()
        assert session._loader.load_service_model.call_args_list == [
            call(service, model) for service in ('dynamodb', 'lambda') for model in BOTOCORE_MODEL_FILES
        ]


class TestTheRoutesAreInstrumented:
    @pytest.mark.parametrize('name', ROUTES)
    def test_every_route_is_the_tracer_wrapper_around_the_named_function(self, name):
        assert_tracer_wrapped(h, name)

    def test_the_handler_carries_api_handler(self):
        assert_handler_wrapped(h)


# ============================================
# Validation helpers
# ============================================

class TestEveryRefusalNamesItsCause:
    def test_a_long_bad_key_is_previewed_to_40_characters(self):
        with pytest.raises(h.ValidationError) as caught:
            h._validate_credential_key('A' * 50)
        assert caught.value.message == f"Invalid credential key {'A' * 40!r}: keys {PLUGIN_IDENTIFIER_RULES}."

    def test_a_non_string_key_is_shown_whole(self):
        with pytest.raises(h.ValidationError) as caught:
            h._validate_credential_key(5)
        assert caught.value.message == f'Invalid credential key 5: keys {PLUGIN_IDENTIFIER_RULES}.'

    def test_a_long_bad_source_is_previewed_to_40_characters(self, route):
        status, body = route('PUT', f"/sources/{'A' * 50}/enable")
        assert (status, body) == (400, {
            'success': False,
            'error': f"Invalid source identifier {'A' * 40!r}: source {PLUGIN_IDENTIFIER_RULES}.",
        })

    def test_a_long_unknown_source_is_previewed_to_40_characters(self, route):
        status, body = route('PUT', f"/sources/{'x' * 50}/enable")
        assert (status, body) == (400, {
            'success': False,
            'error': f"Unknown source identifier {'x' * 40!r}: it is not a configured plugin.",
        })

    def test_without_the_plugin_list_any_well_formed_source_passes_with_a_warning(self, monkeypatch, logger):
        monkeypatch.delenv(h.PLUGIN_DEFAULTS_ENV_VAR)
        h._plugin_secret_defaults.cache_clear()
        h._validate_source_is_a_known_plugin('anything')
        logger.warning.assert_called_once_with(
            'PLUGIN_SECRET_DEFAULTS unavailable; accepting any well-formed source'
        )


class TestThePluginDefaultsParse:
    @pytest.fixture
    def parse(self, monkeypatch) -> Callable[[str | None], dict]:
        def _parse(raw: str | None) -> dict:
            if raw is None:
                monkeypatch.delenv(h.PLUGIN_DEFAULTS_ENV_VAR, raising=False)
            else:
                monkeypatch.setenv(h.PLUGIN_DEFAULTS_ENV_VAR, raw)
            h._plugin_secret_defaults.cache_clear()
            return h._plugin_secret_defaults()
        return _parse

    def test_an_absent_variable_is_no_sources_and_no_warning(self, parse, logger):
        assert parse(None) == {}
        logger.warning.assert_not_called()

    @pytest.mark.parametrize(('raw', 'message'), [
        ('not json', 'PLUGIN_SECRET_DEFAULTS is not valid JSON; reporting no sources'),
        ('[1]', 'PLUGIN_SECRET_DEFAULTS is not a JSON object; reporting no sources'),
    ])
    def test_an_unusable_variable_is_no_sources_and_says_why(self, parse, logger, raw, message):
        assert parse(raw) == {}
        logger.warning.assert_called_once_with(message)

    def test_a_malformed_entry_is_skipped_and_the_entries_after_it_are_kept(self, parse, logger):
        assert parse(json.dumps({'bad': 1, 'good': {'a': '1'}})) == {'good': {'a': '1'}}
        logger.warning.assert_called_once_with("Ignoring malformed PLUGIN_SECRET_DEFAULTS entry for 'bad'")


class TestTheResourceNames:
    @pytest.mark.parametrize(('account', 'region', 'suffix'), [
        ('123', 'us-east-1', '-123-us-east-1'),
        ('123', '', ''),
        ('', 'us-east-1', ''),
    ])
    def test_the_suffix_needs_both_account_and_region(self, account, region, suffix):
        with patch.object(h, 'AWS_ACCOUNT_ID', account), patch.object(h, 'AWS_REGION', region):
            assert h._build_rule_name('webscraper') == f'voc-ingest-webscraper-schedule{suffix}'
            assert h._build_ingestor_function_name('webscraper') == f'voc-ingestor-webscraper{suffix}'


# ============================================
# GET /integrations/status
# ============================================

class TestTheIntegrationStatus:
    def test_a_secret_without_secretstring_reads_as_empty(self, route, secrets):
        secrets.get_secret_value.return_value = {}
        status, body = route('GET', '/integrations/status')
        assert status == 200
        assert body['webscraper'] == {'configured': False, 'credentials_set': []}

    def test_a_key_that_is_only_the_prefix_is_not_a_credential(self, route, secrets):
        secrets.get_secret_value.return_value = secret_string({'webscraper_': 'set by hand'})
        status, body = route('GET', '/integrations/status')
        assert status == 200
        assert body['webscraper'] == {'configured': False, 'credentials_set': []}

    def test_a_failed_read_is_a_500_logged_with_the_cause(self, route, secrets, logger):
        error = aws_error('denied')
        secrets.get_secret_value.side_effect = error
        assert route('GET', '/integrations/status') == (
            500, {'success': False, 'error': 'Failed to retrieve integration status'},
        )
        logger.exception.assert_called_once_with(f'Failed to get integration status: {error}')


class TestAnUnconfiguredSecretIsNamed:
    @pytest.mark.parametrize(('method', 'path', 'kwargs'), [
        ('GET', '/integrations/status', {}),
        ('GET', '/integrations/webscraper/credentials', {'query_params': {'keys': 'configs'}}),
        ('PUT', '/integrations/webscraper/credentials', {'body': {'configs': 'x'}}),
        ('POST', '/integrations/app_reviews_ios/apps', {'body': {'app': {'app_name': 'A'}}}),
        ('DELETE', '/integrations/app_reviews_ios/apps/a1', {}),
    ])
    @pytest.mark.usefixtures('no_secrets_arn')
    def test_the_route_answers_secrets_not_configured(self, route, method, path, kwargs):
        assert route(method, path, **kwargs) == (500, {'success': False, 'error': 'Secrets not configured'})


# ============================================
# /integrations/<source>/credentials
# ============================================

class TestReadingCredentials:
    def test_no_keys_parameter_is_named(self, route, secrets):
        assert route('GET', '/integrations/webscraper/credentials') == (
            400, {'success': False, 'error': 'Missing required query parameter: keys'},
        )
        secrets.get_secret_value.assert_not_called()

    def test_a_secret_without_secretstring_returns_nothing(self, route, secrets):
        secrets.get_secret_value.return_value = {}
        assert route('GET', '/integrations/webscraper/credentials', query_params={'keys': 'configs'}) == (200, {})

    def test_a_failed_read_is_a_500_logged_with_the_cause(self, route, secrets, logger):
        error = aws_error('denied')
        secrets.get_secret_value.side_effect = error
        assert route('GET', '/integrations/webscraper/credentials', query_params={'keys': 'configs'}) == (
            500, {'success': False, 'error': 'Failed to retrieve credentials'},
        )
        logger.exception.assert_called_once_with(f'Failed to get credentials for webscraper: {error}')


@pytest.mark.usefixtures('secrets')
class TestWritingCredentials:
    def test_exactly_20_keys_are_written(self, route, put):
        body = {f'k{i}': f'v{i}' for i in range(20)}
        assert route('PUT', '/integrations/webscraper/credentials', body=body) == (
            200, {'success': True, 'message': 'Credentials updated for webscraper'},
        )
        assert _written(put) == {f'webscraper_k{i}': f'v{i}' for i in range(20)}

    def test_21_keys_are_refused_with_the_count_and_the_limit(self, route, put):
        body = {f'k{i}': 'v' for i in range(21)}
        assert route('PUT', '/integrations/webscraper/credentials', body=body) == (
            400, {'success': False, 'error': 'Too many keys in request: 21 exceeds the limit of 20.'},
        )
        put.assert_not_called()

    def test_a_list_body_is_refused(self, put, api_gateway_event, lambda_context):
        event = api_gateway_event(
            method='PUT', path='/integrations/webscraper/credentials', path_params={'source': 'webscraper'},
        )
        event['body'] = '["configs"]'
        response = h.lambda_handler(event, lambda_context)
        assert (response['statusCode'], json.loads(response['body'])) == (
            400, {'success': False, 'error': 'Request body must be a JSON object.'},
        )
        put.assert_not_called()

    def test_a_non_string_value_is_refused_with_the_key_previewed_to_40(self, route, put):
        key = 'a' * 50
        assert route('PUT', '/integrations/webscraper/credentials', body={key: 5}) == (
            400, {'success': False, 'error': f"Value for key {'a' * 40!r} must be a string."},
        )
        put.assert_not_called()

    def test_a_secret_without_secretstring_is_written_from_empty(self, route, secrets, put):
        secrets.get_secret_value.return_value = {}
        status, _body = route('PUT', '/integrations/webscraper/credentials', body={'configs': '[1]'})
        assert status == 200
        assert _written(put) == {'webscraper_configs': '[1]'}

    def test_a_failed_write_is_a_500_logged_with_the_cause(self, route, put, logger):
        error = aws_error('denied')
        put.side_effect = error
        assert route('PUT', '/integrations/webscraper/credentials', body={'configs': 'x'}) == (
            500, {'success': False, 'error': 'Failed to update credentials'},
        )
        logger.exception.assert_called_once_with(f'Failed to update credentials: {error}')


# ============================================
# /integrations/<source>/apps
# ============================================

NOT_MULTI = {'success': False, 'error': 'Source webscraper does not support multiple app configs'}


class TestAppConfigs:
    @pytest.mark.parametrize(('method', 'path', 'kwargs'), [
        ('GET', '/integrations/webscraper/apps', {}),
        ('POST', '/integrations/webscraper/apps', {'body': {'app': {'app_name': 'A'}}}),
        ('DELETE', '/integrations/webscraper/apps/a1', {}),
    ])
    @pytest.mark.usefixtures('secrets')
    def test_a_single_instance_plugin_is_refused_by_name(self, route, method, path, kwargs):
        assert route(method, path, **kwargs) == (400, NOT_MULTI)

    @pytest.mark.usefixtures('no_secrets_arn')
    def test_listing_without_a_secret_is_an_empty_list(self, route):
        assert route('GET', '/integrations/app_reviews_ios/apps') == (200, {'apps': []})

    def test_listing_a_secret_without_secretstring_is_an_empty_list(self, route, secrets, logger):
        secrets.get_secret_value.return_value = {}
        assert route('GET', '/integrations/app_reviews_ios/apps') == (200, {'apps': []})
        logger.warning.assert_not_called()

    def test_a_failed_listing_is_an_empty_list_with_a_warning(self, route, secrets, logger):
        error = aws_error('denied')
        secrets.get_secret_value.side_effect = error
        assert route('GET', '/integrations/app_reviews_ios/apps') == (200, {'apps': []})
        logger.warning.assert_called_once_with(f'Could not read app configs for app_reviews_ios: {error}')

    def test_saving_without_an_app_is_refused(self, route, put):
        assert route('POST', '/integrations/app_reviews_ios/apps', body={'other': 1}) == (
            400, {'success': False, 'error': 'No app config provided'},
        )
        put.assert_not_called()

    def test_saving_without_an_app_name_is_refused(self, route, put):
        assert route('POST', '/integrations/app_reviews_ios/apps', body={'app': {'id': 'a1'}}) == (
            400, {'success': False, 'error': 'app_name is required'},
        )
        put.assert_not_called()

    def test_a_new_app_gets_the_first_8_characters_of_a_uuid_and_is_appended(self, route, secrets, put):
        stored = [{'id': 'old', 'app_name': 'Old'}]
        secrets.get_secret_value.return_value = {'SecretString': json.dumps({
            'app_reviews_ios_configs': json.dumps(stored),
        })}
        with patch('uuid.uuid4', return_value=uuid.UUID('12345678-9abc-def0-1234-56789abcdef0')):
            status, body = route('POST', '/integrations/app_reviews_ios/apps', body={'app': {'app_name': 'New'}})
        new = {'app_name': 'New', 'id': '12345678'}
        assert (status, body) == (200, {'success': True, 'app': new})
        assert json.loads(_written(put)['app_reviews_ios_configs']) == [*stored, new]

    def test_an_existing_id_is_replaced_in_place(self, route, secrets, put):
        stored = [{'id': 'a', 'app_name': 'A'}, {'id': 'b', 'app_name': 'B'}, {'id': 'c', 'app_name': 'C'}]
        secrets.get_secret_value.return_value = {'SecretString': json.dumps({
            'app_reviews_ios_configs': json.dumps(stored),
        })}
        edited = {'id': 'b', 'app_name': 'B2'}
        assert route('POST', '/integrations/app_reviews_ios/apps', body={'app': edited}) == (
            200, {'success': True, 'app': edited},
        )
        assert json.loads(_written(put)['app_reviews_ios_configs']) == [stored[0], edited, stored[2]]

    @pytest.mark.usefixtures('secrets')
    def test_a_failed_save_is_a_500_logged_with_the_cause(self, route, put, logger):
        error = aws_error('denied')
        put.side_effect = error
        assert route('POST', '/integrations/app_reviews_ios/apps', body={'app': {'id': 'a', 'app_name': 'A'}}) == (
            500, {'success': False, 'error': 'Failed to save app configuration'},
        )
        logger.exception.assert_called_once_with(f'Failed to save app config for app_reviews_ios: {error}')

    @pytest.mark.usefixtures('secrets')
    def test_a_failed_delete_is_a_500_logged_with_the_cause(self, route, put, logger):
        error = aws_error('denied')
        put.side_effect = error
        assert route('DELETE', '/integrations/app_reviews_ios/apps/a1') == (
            500, {'success': False, 'error': 'Failed to delete app configuration'},
        )
        logger.exception.assert_called_once_with(f'Failed to delete app config for app_reviews_ios: {error}')


# ============================================
# POST /sources/<source>/run
# ============================================

EXECUTION_ID = re.compile(r'^run_webscraper_\d{14}_[0-9a-f]+$')


class TestRunningASource:
    @pytest.fixture
    def invoke(self) -> Iterator[SimpleNamespace]:
        with patch.object(h, 'boto3') as boto3:
            yield SimpleNamespace(boto3=boto3, client=ingestor_behind(boto3))

    def test_the_run_writes_the_row_and_invokes_the_ingestor_asynchronously(self, route, invoke, table, logger):
        status, body = route('POST', '/sources/webscraper/run', body={'app_id': 'app-7'})
        assert status == 200
        execution_id = body['execution_id']
        assert EXECUTION_ID.match(execution_id)
        assert body == {
            'success': True, 'message': 'Triggered webscraper ingestor',
            'source': 'webscraper', 'execution_id': execution_id,
        }
        invoke.boto3.client.assert_called_once_with('lambda')
        invoke.client.invoke.assert_called_once_with(
            FunctionName=h._build_ingestor_function_name('webscraper'),
            InvocationType='Event',
            Payload=json.dumps({
                'manual_trigger': True, 'execution_id': execution_id, 'app_id': 'app-7',
            }).encode(),
        )
        (item,) = [kwargs['Item'] for _args, kwargs in table.put_item.call_args_list]
        started_at = item.pop('started_at')
        assert datetime.fromisoformat(started_at).utcoffset() is not None
        assert item == {
            'pk': 'SOURCE_RUN#webscraper', 'sk': execution_id, 'status': 'running', 'items_found': 0,
        }
        logger.warning.assert_not_called()

    @pytest.mark.usefixtures('table')
    def test_a_body_that_is_not_an_object_runs_every_app(self, invoke, api_gateway_event, lambda_context):
        event = api_gateway_event(method='POST', path='/sources/webscraper/run', path_params={'source': 'webscraper'})
        event['body'] = '[1]'
        response = h.lambda_handler(event, lambda_context)
        assert response['statusCode'] == 200
        payload = json.loads(invoke.client.invoke.call_args.kwargs['Payload'])
        assert set(payload) == {'manual_trigger', 'execution_id'}

    def test_a_failed_row_write_is_a_warning_and_the_run_still_happens(self, route, invoke, table, logger):
        error = aws_error('throttled')
        table.put_item.side_effect = error
        status, _body = route('POST', '/sources/webscraper/run')
        assert status == 200
        logger.warning.assert_called_once_with(f'Failed to create run status: {error}')
        invoke.client.invoke.assert_called_once()

    @pytest.mark.usefixtures('table')
    def test_a_missing_ingestor_is_named(self, route, invoke):
        invoke.client.invoke.side_effect = invoke.client.exceptions.ResourceNotFoundException()
        assert route('POST', '/sources/webscraper/run') == (
            500, {'success': False, 'error': 'Ingestor Lambda not found for source: webscraper'},
        )

    @pytest.mark.usefixtures('table')
    def test_a_failed_invoke_is_a_500_logged_with_the_cause(self, route, invoke, logger):
        error = aws_error('denied')
        invoke.client.invoke.side_effect = error
        assert route('POST', '/sources/webscraper/run') == (
            500, {'success': False, 'error': 'Failed to trigger webscraper ingestor'},
        )
        logger.exception.assert_called_once_with(f'Failed to trigger source webscraper: {error}')

    @pytest.mark.usefixtures('table')
    def test_an_answer_without_a_status_code_is_reported_as_status_0(self, route, invoke):
        invoke.client.invoke.return_value = {}
        assert route('POST', '/sources/webscraper/run') == (
            500, {'success': False, 'error': 'Lambda invoke returned status 0'},
        )


# ============================================
# GET /sources/status?run_status=<source>
# ============================================

class TestTheRunStatus:
    def test_without_a_table_the_status_is_unknown(self, route):
        with patch('shared.tables.get_aggregates_table', return_value=None):
            assert route('GET', '/sources/status', query_params={'run_status': 'webscraper'}) == (
                200, {'source': 'webscraper', 'status': 'unknown'},
            )

    def test_the_latest_row_is_queried_and_no_row_is_never_run(self, route, table):
        table.query.return_value = {}
        assert route('GET', '/sources/status', query_params={'run_status': 'webscraper'}) == (
            200, {'source': 'webscraper', 'status': 'never_run'},
        )
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq('SOURCE_RUN#webscraper'), ScanIndexForward=False, Limit=1,
        )

    def test_every_field_of_the_row_is_reported(self, route, table):
        table.query.return_value = {'Items': [{
            'sk': 'run_1', 'status': 'completed', 'started_at': 's', 'completed_at': 'c',
            'items_found': 7, 'errors': ['e'],
        }]}
        assert route('GET', '/sources/status', query_params={'run_status': 'webscraper'}) == (200, {
            'source': 'webscraper', 'execution_id': 'run_1', 'status': 'completed',
            'started_at': 's', 'completed_at': 'c', 'items_found': 7, 'errors': ['e'],
        })

    def test_a_sparse_row_reports_the_defaults(self, route, table):
        table.query.return_value = {'Items': [{'sk': 'run_1'}]}
        assert route('GET', '/sources/status', query_params={'run_status': 'webscraper'}) == (200, {
            'source': 'webscraper', 'execution_id': 'run_1', 'status': 'unknown',
            'started_at': None, 'completed_at': None, 'items_found': 0, 'errors': [],
        })

    def test_a_failed_query_is_unknown_with_a_warning(self, route, table, logger):
        error = aws_error('throttled')
        table.query.side_effect = error
        assert route('GET', '/sources/status', query_params={'run_status': 'webscraper'}) == (
            200, {'source': 'webscraper', 'status': 'unknown'},
        )
        logger.warning.assert_called_once_with(f'Failed to get source run status: {error}')


# ============================================
# The schedule half of GET /sources/status
# ============================================

class TestTheScheduleStatus:
    def test_exactly_50_sources_are_answered(self, route, events):
        names = [f's{i}' for i in range(50)]
        status, body = route('GET', '/sources/status', query_params={'sources': ','.join(names)})
        assert status == 200
        assert body == {'sources': {name: {'enabled': False, 'exists': False} for name in names}}
        events.describe_rule.assert_not_called()

    def test_51_sources_are_refused_with_the_count_and_the_limit(self, route, events):
        events.describe_rule.side_effect = AssertionError('a refused request describes no rule')
        names = ','.join(f's{i}' for i in range(51))
        assert route('GET', '/sources/status', query_params={'sources': names}) == (
            400, {'success': False, 'error': 'Too many sources in request: 51 exceeds the limit of 50.'},
        )

    @pytest.mark.parametrize(('sources', 'workers'), [
        ('manual_import', 1),
        ('webscraper', 1),
        ('webscraper,s3_import', 2),
    ])
    def test_one_worker_per_addressable_source_and_never_zero(self, route, events, sources, workers):
        events.describe_rule.return_value = {'State': 'DISABLED'}
        with patch.object(h, 'ThreadPoolExecutor', wraps=ThreadPoolExecutor) as pool:
            status, _body = route('GET', '/sources/status', query_params={'sources': sources})
        assert status == 200
        pool.assert_called_once_with(max_workers=workers)

    def test_a_failed_describe_degrades_that_entry_and_is_logged(self, route, events, logger):
        events.describe_rule.side_effect = RuntimeError('boom')
        assert route('GET', '/sources/status', query_params={'sources': 'webscraper'}) == (
            200, {'sources': {'webscraper': {'enabled': False, 'error': 'Failed to retrieve status'}}},
        )
        logger.exception.assert_called_once_with('Failed to get status for source webscraper')


# ============================================
# PUT /sources/<source>/enable|disable
# ============================================

class TestTogglingASchedule:
    @pytest.mark.parametrize(('action', 'enabled'), [('enable', True), ('disable', False)])
    def test_the_rule_is_toggled_and_the_answer_names_the_source(self, route, events, action, enabled):
        assert route('PUT', f'/sources/webscraper/{action}') == (
            200, {'success': True, 'source': 'webscraper', 'enabled': enabled},
        )
        getattr(events, f'{action}_rule').assert_called_once_with(Name=h._build_rule_name('webscraper'))

    @pytest.mark.parametrize('action', ['enable', 'disable'])
    def test_a_failed_toggle_is_a_500_logged_with_the_cause(self, route, events, logger, action):
        error = aws_error('denied')
        getattr(events, f'{action}_rule').side_effect = error
        assert route('PUT', f'/sources/webscraper/{action}') == (
            500, {'success': False, 'error': f'Failed to {action} data source'},
        )
        logger.exception.assert_called_once_with(f'Failed to {action} source webscraper: {error}')
