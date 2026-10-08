"""Mutation hardening for `api/scrapers_handler.py`.

`test_scrapers_handler.py` drives every route once, `test_scrapers_save_bounds.py`
pins one over-the-limit value per bound, `test_scrapers_security.py` the admin
gates and the schedule policy, and `test_scrapers_ssrf.py` the URL policy and the
pinned opener. A mutation run found what none of them can see:

* the WORDING of every refusal and every fixed string — the 400 messages of the
  shape checks (read back so far as `'at most' in body`, or through the module's
  own constants, so a bound that drifted still "matched"), the 500 messages of
  the three write/run routes, the `logger` lines, the template catalogue, the
  analyze prompt and the `User-Agent` / `Accept` headers of the fetch;
* the ACCEPTED side of each bound: exactly 500 characters in every text field,
  a 64-character id, 2048-character URL, `max_pages` 1 and 50, `start` 0 and
  10 000, `frequency_minutes` 0 and 43 200, a scraper of exactly 8192 bytes, a
  `webscraper_configs` value that lands exactly on the 49 152-byte budget, and an
  edit that keeps an already-oversized value the SAME size;
* the exact DynamoDB and Lambda calls: the `SCRAPER_RUN#<id>` partition,
  `ScanIndexForward=False`, `Limit=1` / `Limit=10`, the run row's seven fields,
  the invoke's `FunctionName` / `InvocationType='Event'` / payload, and that a
  missing table skips the row but still invokes;
* the read-modify-write of the secret: a `GetSecretValue` answer with no
  `SecretString`, or a secret with no `webscraper_configs`, reads as an empty
  list rather than a warning or a 500; an edit replaces the entry IN PLACE
  between its neighbours and a non-object entry in the stored list is kept;
* the cold-start state: an unset `SECRETS_ARN` / `WEBSCRAPER_FUNCTION_NAME`
  reads as `''`, the Lambda root is put FIRST on `sys.path`, the two clients are
  the named services, and every route is the tracer's wrapper.
"""
from __future__ import annotations

import importlib
import json
import os
import sys
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from http.client import HTTPMessage
from io import BytesIO
from types import ModuleType, SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import Key
from handler_events_fixtures import aws_error, call_route
from module_reload_fixtures import env_reloader

import scrapers_handler as h
from shared import scraper_run_errors
from shared.exceptions import ServiceError, ValidationError
from shared.test.instrumentation_fixtures import assert_tracer_wrapped

NOW = datetime(2026, 3, 10, 12, 0, 0, tzinfo=UTC)
USERS_CLAIMS = {'sub': 'user-1', 'email': 'user@example.com', 'cognito:groups': 'users'}
SECRETS_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secrets'


def _secret_answer(configs: list | None, secret: dict | None = None) -> dict:
    """`GetSecretValue`'s answer holding `configs` (None = the key is absent)."""
    body = dict(secret or {})
    if configs is not None:
        body['webscraper_configs'] = json.dumps(configs)
    return {'SecretString': json.dumps(body)}


@pytest.fixture
def store() -> Iterator[SimpleNamespace]:
    """The secret's two halves: `client` answers `GetSecretValue` (an empty list by
    default), `put` records the one `put_secret_json` a write route makes."""
    with (
        patch.object(h, 'secretsmanager') as client,
        patch.object(h, 'put_secret_json') as put,
    ):
        client.get_secret_value.return_value = _secret_answer([])
        yield SimpleNamespace(client=client, put=put)


@pytest.fixture
def logger() -> Iterator[MagicMock]:
    with patch.object(h, 'logger') as mock:
        yield mock


@pytest.fixture
def allow_every_url() -> Iterator[None]:
    with patch.object(h, 'validate_url', return_value=(True, '')):
        yield


@pytest.fixture
def save(api_gateway_event, lambda_context, store) -> Callable[..., tuple[int, dict]]:
    """POST one scraper over `stored` (as an admin unless `claims` says otherwise).

    `stored=None` leaves the `store` fixture's answer alone, so a test may shape
    the whole secret itself.
    """
    def _save(scraper: object, stored: list | None = None, claims: dict | None = None) -> tuple[int, dict]:
        if stored is not None:
            store.client.get_secret_value.return_value = _secret_answer(stored)
        response, body = call_route(
            h.lambda_handler, api_gateway_event, lambda_context,
            method='POST', path='/scrapers', body={'scraper': scraper}, claims=claims,
        )
        return response['statusCode'], body
    return _save


def _written_configs(put: MagicMock) -> list:
    """The `webscraper_configs` array the one `put_secret_json` call wrote."""
    put.assert_called_once()
    (_client, _arn, written), _ = put.call_args
    return json.loads(written['webscraper_configs'])


@pytest.fixture
def table() -> Iterator[MagicMock]:
    with patch.object(h, 'get_aggregates_table') as get_table:
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': []}
        get_table.return_value = mock_table
        yield mock_table


@pytest.fixture
def frozen_clock() -> Iterator[None]:
    with patch.object(h, 'datetime') as clock:
        clock.now.return_value = NOW
        yield


# ============================================
# Module state
# ============================================

class TestTheColdStartModuleState:
    def test_the_bounds_are_the_documented_ones(self):
        assert (h.MAX_SCRAPERS, h.MAX_SCRAPER_BYTES, h.MAX_WEBSCRAPER_CONFIGS_BYTES) == (50, 8192, 49152)
        assert (h.MAX_URLS_PER_SCRAPER, h.MAX_URL_LENGTH, h.MAX_TEXT_FIELD_LENGTH) == (25, 2048, 500)
        assert (h.MAX_PAGINATION_PARAM_LENGTH, h.MAX_PAGINATION_PAGES, h.MAX_PAGINATION_START) == (64, 50, 10_000)
        assert h.MAX_FREQUENCY_MINUTES == 43_200
        assert h.SCRAPER_ID_PATTERN.pattern == r'^[A-Za-z0-9_-]{1,64}$'

    def test_the_field_lists_are_the_documented_ones(self):
        assert h.TEXT_FIELDS == (
            'name', 'template', 'container_selector', 'text_selector', 'title_selector',
            'rating_selector', 'rating_attribute', 'date_selector', 'author_selector',
            'link_selector',
        )
        assert h.EXTRACTION_METHODS == ('css', 'jsonld')
        assert h.SCHEDULE_FIELDS == ('enabled', 'frequency_minutes')
        assert h.NON_ADMIN_DEFAULT_SCHEDULE == {'enabled': True, 'frequency_minutes': 1440}

    def test_the_aws_clients_are_the_named_services(self):
        assert h.secretsmanager.meta.service_model.service_name == 'secretsmanager'
        assert h.lambda_client.meta.service_model.service_name == 'lambda'

    @pytest.fixture
    def reload_with_env(self, monkeypatch) -> Iterator[Callable[..., ModuleType]]:
        """`reload(NAME=value)` re-imports the handler under that environment; the
        teardown restores the environment, `sys.path` and the module itself."""
        original_path = sys.path.copy()
        try:
            yield env_reloader(monkeypatch, h)
        finally:
            monkeypatch.undo()
            sys.path[:] = original_path
            importlib.reload(h)

    @pytest.mark.parametrize(('env', 'expected'), [
        pytest.param({'SECRETS_ARN': None, 'WEBSCRAPER_FUNCTION_NAME': None}, ('', ''), id='unset reads as empty'),
        pytest.param({'SECRETS_ARN': 'arn:x', 'WEBSCRAPER_FUNCTION_NAME': 'fn-x'}, ('arn:x', 'fn-x'), id='read by name'),
    ])
    def test_the_two_settings_are_read_from_the_environment(self, reload_with_env, env, expected):
        reloaded = reload_with_env(**env)
        actual = (reloaded.SECRETS_ARN, reloaded.WEBSCRAPER_FUNCTION_NAME)
        assert actual == expected

    def test_the_lambda_root_is_put_ahead_of_whatever_was_first_on_sys_path(self, reload_with_env):
        lambda_root = os.path.dirname(os.path.dirname(os.path.abspath(h.__file__)))
        while lambda_root in sys.path:
            sys.path.remove(lambda_root)
        sys.path.insert(0, '/elsewhere-with-its-own-shared')
        reload_with_env(SECRETS_ARN=SECRETS_ARN)
        assert sys.path.index(lambda_root) == 0
        assert sys.path[1] == '/elsewhere-with-its-own-shared'


ROUTES = [
    'list_scrapers', 'save_scraper', 'delete_scraper', 'get_templates', 'run_scraper',
    'get_scraper_status', 'get_scraper_runs', 'analyze_url',
]


def _invocation_context(function_name: str, request_id: str) -> SimpleNamespace:
    """A plain object, not a MagicMock: Powertools reads `context.lambda_context`
    whenever that attribute exists, and a MagicMock has every attribute."""
    arn = f'arn:aws:lambda:us-east-1:123456789012:function:{function_name}'
    return SimpleNamespace(
        aws_request_id=request_id, function_name=function_name, invoked_function_arn=arn,
        memory_limit_in_mb=256, get_remaining_time_in_millis=lambda: 30_000,
    )


class TestTheRoutesAreInstrumented:
    def test_every_route_is_the_tracer_wrapper_around_the_named_function(self):
        for route in ROUTES:
            assert_tracer_wrapped(h, route)

    def test_the_handler_carries_api_handler(self):
        wrapped = vars(h.lambda_handler)['__wrapped__']
        assert wrapped.__qualname__ == 'lambda_handler'

    def test_the_handler_injects_the_invocation_context_into_the_logger(self, api_gateway_event):
        event = api_gateway_event(method='GET', path='/scrapers/templates')
        response = h.lambda_handler(event, _invocation_context('voc-scrapers-under-test', 'req-scrapers-mutation-0001'))
        assert response['statusCode'] == 200
        keys = h.logger.get_current_keys()
        assert (keys['function_name'], keys['function_request_id']) == (
            'voc-scrapers-under-test', 'req-scrapers-mutation-0001',
        )


class TestTheRedirectRefusal:
    def test_the_refusal_carries_exactly_the_policy_reason(self):
        handler = h._ValidatingRedirectHandler()
        request = urllib.request.Request('https://public.example/page')
        headers = HTTPMessage()
        headers['Location'] = 'file:///etc/passwd'
        with pytest.raises(urllib.error.HTTPError) as caught:
            handler.redirect_request(request, BytesIO(b''), 302, 'Found', headers, 'file:///etc/passwd')
        assert caught.value.reason == 'Redirect refused: Only http and https URLs are allowed'
        assert (caught.value.code, caught.value.url) == (302, 'file:///etc/passwd')


class TestTheWebscraperFunctionName:
    def test_the_configured_name_is_returned(self):
        with patch.object(h, 'WEBSCRAPER_FUNCTION_NAME', 'webscraper-fn'):
            assert h.require_webscraper_function() == 'webscraper-fn'

    def test_an_empty_name_is_refused_by_name(self):
        with (
            patch.object(h, 'WEBSCRAPER_FUNCTION_NAME', ''),
            pytest.raises(ValueError, match=r'^WEBSCRAPER_FUNCTION_NAME environment variable is required$'),
        ):
            h.require_webscraper_function()


# ============================================
# GET /scrapers
# ============================================

class TestListScrapers:
    def _list(self, api_gateway_event, lambda_context) -> tuple[int, dict]:
        response, body = call_route(h.lambda_handler, api_gateway_event, lambda_context, method='GET', path='/scrapers')
        return response['statusCode'], body

    def test_no_secrets_arn_answers_an_empty_list_without_reading(self, store, api_gateway_event, lambda_context):
        with patch.object(h, 'SECRETS_ARN', ''):
            assert self._list(api_gateway_event, lambda_context) == (200, {'scrapers': []})
        store.client.get_secret_value.assert_not_called()

    def test_the_secret_is_read_by_arn(self, store, api_gateway_event, lambda_context):
        store.client.get_secret_value.return_value = _secret_answer([{'id': 'a'}, {'id': 'b'}])
        assert self._list(api_gateway_event, lambda_context) == (200, {'scrapers': [{'id': 'a'}, {'id': 'b'}]})
        store.client.get_secret_value.assert_called_once_with(SecretId=SECRETS_ARN)

    @pytest.mark.parametrize('answer', [
        pytest.param({}, id='no SecretString'),
        pytest.param({'SecretString': '{}'}, id='no webscraper_configs key'),
    ])
    def test_a_secret_without_configs_is_an_empty_list_and_no_warning(
        self, answer, store, logger, api_gateway_event, lambda_context
    ):
        store.client.get_secret_value.return_value = answer
        assert self._list(api_gateway_event, lambda_context) == (200, {'scrapers': []})
        logger.warning.assert_not_called()

    def test_an_aws_failure_is_an_empty_list_and_one_warning_naming_the_cause(
        self, store, logger, api_gateway_event, lambda_context
    ):
        error = aws_error('denied', 'GetSecretValue', 'AccessDeniedException')
        store.client.get_secret_value.side_effect = error
        assert self._list(api_gateway_event, lambda_context) == (200, {'scrapers': []})
        logger.warning.assert_called_once_with(f'Could not read scraper configs: {error}')

    def test_a_secret_that_is_not_json_is_an_empty_list_and_one_warning(
        self, store, logger, api_gateway_event, lambda_context
    ):
        store.client.get_secret_value.return_value = {'SecretString': 'not json'}
        assert self._list(api_gateway_event, lambda_context) == (200, {'scrapers': []})
        assert logger.warning.call_count == 1
        assert logger.warning.call_args.args[0].startswith('Could not read scraper configs: Expecting value')


# ============================================
# POST /scrapers — the shape checks, each by its message
# ============================================

FULL_URL = 'https://reviews.example/' + 'p' * (2048 - len('https://reviews.example/'))


@pytest.mark.usefixtures('allow_every_url')
class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize(('scraper', 'message'), [
        pytest.param({'id': 'a' * 65}, 'id must be 1-64 letters, digits, "_" or "-"', id='id too long'),
        pytest.param({'id': 'a b'}, 'id must be 1-64 letters, digits, "_" or "-"', id='id with a space'),
        pytest.param({'id': ''}, 'id must be 1-64 letters, digits, "_" or "-"', id='empty id'),
        pytest.param({'id': 7}, 'id must be 1-64 letters, digits, "_" or "-"', id='non-string id'),
        pytest.param({'id': 's1', 'name': 7}, 'name must be a string of at most 500 characters', id='non-string text'),
        pytest.param({'id': 's1', 'extraction_method': 'xpath'}, 'extraction_method must be one of css, jsonld', id='method'),
        pytest.param({'id': 's1', 'urls': ['https://a.example/'] * 26}, 'A scraper may list at most 25 urls', id='26 urls'),
        pytest.param({'id': 's1', 'base_url': FULL_URL + 'p'}, 'A scraper URL may be at most 2048 characters', id='long base_url'),
        pytest.param({'id': 's1', 'urls': [FULL_URL + 'p']}, 'A scraper URL may be at most 2048 characters', id='long url entry'),
        pytest.param({'id': 's1', 'enabled': 1}, 'enabled must be true or false', id='enabled'),
        pytest.param({'id': 's1', 'frequency_minutes': 43_201}, 'frequency_minutes must be an integer from 0 to 43200', id='frequency over'),
        pytest.param({'id': 's1', 'frequency_minutes': -1}, 'frequency_minutes must be an integer from 0 to 43200', id='frequency under'),
        pytest.param({'id': 's1', 'frequency_minutes': True}, 'frequency_minutes must be an integer from 0 to 43200', id='frequency bool'),
        pytest.param({'id': 's1', 'frequency_minutes': '5'}, 'frequency_minutes must be an integer from 0 to 43200', id='frequency str'),
        pytest.param({'id': 's1', 'pagination': 'page'}, 'pagination must be an object', id='pagination'),
        pytest.param({'id': 's1', 'pagination': {'enabled': 'yes'}}, 'pagination.enabled must be true or false', id='pagination.enabled'),
        pytest.param({'id': 's1', 'pagination': {'param': 'p' * 65}}, 'pagination.param must be a string of at most 64 characters', id='param long'),
        pytest.param({'id': 's1', 'pagination': {'param': 1}}, 'pagination.param must be a string of at most 64 characters', id='param non-string'),
        pytest.param({'id': 's1', 'pagination': {'max_pages': 0}}, 'pagination.max_pages must be an integer from 1 to 50', id='max_pages under'),
        pytest.param({'id': 's1', 'pagination': {'max_pages': 51}}, 'pagination.max_pages must be an integer from 1 to 50', id='max_pages over'),
        pytest.param({'id': 's1', 'pagination': {'start': -1}}, 'pagination.start must be an integer from 0 to 10000', id='start under'),
        pytest.param({'id': 's1', 'pagination': {'start': 10_001}}, 'pagination.start must be an integer from 0 to 10000', id='start over'),
        pytest.param({'id': 's1', 'pagination': {'start': 1.5}}, 'pagination.start must be an integer from 0 to 10000', id='start float'),
        pytest.param({'id': 's1', 'text_config': 'x' * 8192}, 'A scraper config may be at most 8192 bytes', id='oversized'),
        pytest.param({'id': 's1', 'base_url': 123}, 'base_url must be a string', id='non-string base_url'),
        pytest.param({'id': 's1', 'urls': 'https://a.example/'}, 'urls must be a list of strings', id='urls string'),
        pytest.param({'id': 's1', 'urls': [1]}, 'urls must be a list of strings', id='urls non-string entry'),
    ])
    def test_the_400_carries_the_exact_message_and_nothing_is_written(self, save, store, scraper, message):
        assert save(scraper) == (400, {'success': False, 'error': message})
        store.put.assert_not_called()

    @pytest.mark.parametrize('field', h.TEXT_FIELDS)
    def test_each_text_field_is_bounded_by_name(self, save, field):
        assert save({'id': 's1', field: 't' * 501}) == (
            400, {'success': False, 'error': f'{field} must be a string of at most 500 characters'},
        )


class TestTheUrlPolicyRefusal:
    @pytest.mark.parametrize(('url', 'error'), [
        ('http://localhost/x', 'Access to localhost is not allowed'),
        ('ftp://a.example/', 'Only http and https URLs are allowed'),
    ])
    def test_a_refused_url_is_named_with_the_policy_reason(self, save, store, url, error):
        assert save({'id': 's1', 'urls': [url]}) == (
            400, {'success': False, 'error': f'Scraper URL rejected ({url}): {error}'},
        )
        store.put.assert_not_called()

    def test_the_shape_is_judged_before_the_url_policy(self, save):
        """A bad id and a bad URL: the cheap check answers, DNS is never consulted."""
        with patch.object(h, 'validate_url') as policy:
            status, body = save({'id': '', 'urls': ['http://localhost/']})
        assert (status, body['error']) == (400, 'id must be 1-64 letters, digits, "_" or "-"')
        policy.assert_not_called()


@pytest.mark.usefixtures('allow_every_url')
class TestTheAcceptedSideOfEveryBound:
    @pytest.mark.parametrize('scraper', [
        pytest.param({'id': 'a' * 64}, id='64-char id'),
        pytest.param({'id': 'A-z_9'}, id='every allowed id character class'),
        pytest.param({'id': 's1', 'extraction_method': 'css'}, id='css'),
        pytest.param({'id': 's1', 'extraction_method': 'jsonld'}, id='jsonld'),
        pytest.param({'id': 's1', 'urls': ['https://a.example/'] * 25}, id='25 urls'),
        pytest.param({'id': 's1', 'base_url': FULL_URL}, id='2048-char base_url'),
        pytest.param({'id': 's1', 'urls': [FULL_URL]}, id='2048-char url entry'),
        pytest.param({'id': 's1', 'enabled': False}, id='enabled false'),
        pytest.param({'id': 's1', 'frequency_minutes': 0}, id='frequency 0'),
        pytest.param({'id': 's1', 'frequency_minutes': 43_200}, id='frequency 43200'),
        pytest.param({'id': 's1', 'pagination': None}, id='pagination null'),
        pytest.param({'id': 's1', 'pagination': {}}, id='pagination empty'),
        pytest.param({'id': 's1', 'pagination': {'enabled': True, 'param': 'p' * 64}}, id='64-char param'),
        pytest.param({'id': 's1', 'pagination': {'max_pages': 1, 'start': 0}}, id='max_pages 1, start 0'),
        pytest.param({'id': 's1', 'pagination': {'max_pages': 50, 'start': 10_000}}, id='max_pages 50, start 10000'),
        pytest.param({'id': 's1', 'base_url': None, 'urls': None}, id='null base_url and urls'),
        pytest.param({'id': 's1', 'base_url': ''}, id='empty base_url is not a URL'),
    ])
    def test_the_value_is_stored_as_sent(self, save, store, scraper):
        assert save(scraper) == (200, {'success': True, 'scraper': scraper})
        assert _written_configs(store.put) == [scraper]

    @pytest.mark.parametrize('field', h.TEXT_FIELDS)
    def test_exactly_500_characters_of_each_text_field_are_accepted(self, save, field):
        status, _body = save({'id': 's1', field: 't' * 500})
        assert status == 200

    def test_a_scraper_of_exactly_the_byte_cap_is_accepted_and_one_more_byte_is_not(self, save):
        empty = len(json.dumps({'id': 's1', 'text_config': ''}).encode())
        at_cap = {'id': 's1', 'text_config': 'x' * (8192 - empty)}
        assert len(json.dumps(at_cap).encode()) == 8192
        assert save(at_cap)[0] == 200
        over = {'id': 's1', 'text_config': 'x' * (8192 - empty + 1)}
        assert save(over) == (400, {'success': False, 'error': 'A scraper config may be at most 8192 bytes'})


# ============================================
# POST /scrapers — the whole-secret budget and the upsert
# ============================================

def _filled(count: int, size: int) -> list[dict]:
    return [{'id': f's{i}', 'text_config': 'x' * size} for i in range(count)]


@pytest.mark.usefixtures('allow_every_url')
class TestTheWebscraperConfigsBudget:
    def test_a_create_landing_exactly_on_the_budget_is_accepted_and_one_byte_over_is_named(self, save):
        stored = _filled(6, 7000)
        base = len(json.dumps([*stored, {'id': 'new', 'text_config': ''}]).encode())
        pad = 49152 - base
        assert 0 < pad < 8000
        assert save({'id': 'new', 'text_config': 'x' * pad}, stored)[0] == 200
        assert save({'id': 'new', 'text_config': 'x' * (pad + 1)}, stored) == (400, {
            'success': False,
            'error': 'Scraper configurations would take 49153 bytes, over the 49152-byte budget. '
                     'Remove some scrapers or URLs.',
        })

    def test_an_edit_that_keeps_an_oversized_value_the_same_size_is_accepted(self, save, store):
        """Over budget, but not GROWING it: `after > before`, not `>=`."""
        stored = _filled(8, 7000)
        assert len(json.dumps(stored).encode()) > 49152
        assert save(stored[3], stored)[0] == 200
        assert _written_configs(store.put) == stored

    def test_the_51st_scraper_is_refused_with_the_full_message(self, save, store):
        stored = [{'id': f's{i}'} for i in range(50)]
        assert save({'id': 'new'}, stored) == (
            400, {'success': False, 'error': 'At most 50 scrapers can be configured. Delete one first.'},
        )
        store.put.assert_not_called()


@pytest.mark.usefixtures('allow_every_url')
class TestTheUpsertKeepsTheListInOrder:
    def test_an_edit_replaces_the_entry_in_place_between_its_neighbours(self, save, store):
        stored = [{'id': 'a', 'name': 'A'}, {'id': 'b', 'name': 'B'}, {'id': 'c', 'name': 'C'}]
        assert save({'id': 'b', 'name': 'B2'}, stored)[0] == 200
        assert _written_configs(store.put) == [
            {'id': 'a', 'name': 'A'}, {'id': 'b', 'name': 'B2'}, {'id': 'c', 'name': 'C'},
        ]

    def test_a_create_is_appended_after_the_stored_entries(self, save, store):
        assert save({'id': 'b'}, [{'id': 'a'}])[0] == 200
        assert _written_configs(store.put) == [{'id': 'a'}, {'id': 'b'}]

    def test_a_non_object_entry_in_the_stored_list_is_kept_and_skipped(self, save, store):
        stored: list[Any] = ['legacy-junk', {'id': 'a', 'name': 'A'}]
        assert save({'id': 'a', 'name': 'A2'}, stored)[0] == 200
        assert _written_configs(store.put) == ['legacy-junk', {'id': 'a', 'name': 'A2'}]

    def test_the_whole_secret_is_written_back_with_only_the_configs_key_changed(self, save, store):
        store.client.get_secret_value.return_value = _secret_answer([], {'github_token': 'keep-me'})
        assert save({'id': 'a'})[0] == 200
        store.put.assert_called_once_with(h.secretsmanager, SECRETS_ARN, {
            'github_token': 'keep-me', 'webscraper_configs': '[{"id": "a"}]',
        })

    def test_a_secret_answer_without_a_secret_string_starts_an_empty_list(self, save, store):
        store.client.get_secret_value.return_value = {}
        assert save({'id': 'a'})[0] == 200
        store.put.assert_called_once_with(h.secretsmanager, SECRETS_ARN, {'webscraper_configs': '[{"id": "a"}]'})

    def test_a_non_admin_create_stores_the_default_schedule_and_answers_it(self, save, store):
        pushed = {'id': 'a', 'enabled': False, 'frequency_minutes': 5}
        expected = {'id': 'a', 'enabled': True, 'frequency_minutes': 1440}
        assert save(pushed, claims=USERS_CLAIMS) == (200, {'success': True, 'scraper': expected})
        assert _written_configs(store.put) == [expected]


class TestTheSaveRouteFailures:
    def test_no_secrets_arn_is_a_500_before_any_read(self, save, store):
        with patch.object(h, 'SECRETS_ARN', ''):
            assert save({'id': 'a'}) == (500, {'success': False, 'error': 'Secrets not configured'})
        store.client.get_secret_value.assert_not_called()

    @pytest.mark.usefixtures('allow_every_url')
    def test_a_failed_write_is_a_500_logged_once_with_the_cause(self, save, store, logger):
        error = aws_error('throttled', 'PutSecretValue', 'ThrottlingException')
        store.put.side_effect = error
        assert save({'id': 'a'}) == (500, {'success': False, 'error': 'Failed to save scraper configuration'})
        logger.exception.assert_called_once_with(f'Failed to save scraper: {error}')

    @pytest.mark.parametrize(('body', 'message'), [
        pytest.param(None, 'No scraper config provided', id='no body'),
        pytest.param(['scraper'], 'No scraper config provided', id='list body'),
        pytest.param({}, 'No scraper config provided', id='no scraper key'),
        pytest.param({'scraper': {}}, 'No scraper config provided', id='empty scraper'),
        pytest.param({'scraper': 'text'}, 'Scraper config must be an object', id='string scraper'),
        pytest.param({'scraper': ['a']}, 'Scraper config must be an object', id='list scraper'),
    ])
    def test_a_body_without_an_object_scraper_is_refused_by_name(self, body, message):
        with pytest.raises(ValidationError) as caught:
            h._validated_scraper(body)
        assert caught.value.message == message

    def test_a_string_scraper_is_a_400_on_the_route(self, save, store):
        assert save('text') == (400, {'success': False, 'error': 'Scraper config must be an object'})
        store.put.assert_not_called()


# ============================================
# DELETE /scrapers/<id>
# ============================================

class TestDeleteScraper:
    def _delete(self, api_gateway_event, lambda_context, scraper_id: str = 'b') -> tuple[int, dict]:
        response, body = call_route(
            h.lambda_handler, api_gateway_event, lambda_context,
            method='DELETE', path=f'/scrapers/{scraper_id}', path_params={'scraper_id': scraper_id},
        )
        return response['statusCode'], body

    def test_only_the_named_entry_is_removed_and_the_rest_of_the_secret_is_kept(
        self, store, api_gateway_event, lambda_context
    ):
        store.client.get_secret_value.return_value = _secret_answer(
            [{'id': 'a'}, {'id': 'b'}, {'id': 'c'}], {'other': 'x'},
        )
        assert self._delete(api_gateway_event, lambda_context) == (200, {'success': True})
        store.put.assert_called_once_with(h.secretsmanager, SECRETS_ARN, {
            'other': 'x', 'webscraper_configs': '[{"id": "a"}, {"id": "c"}]',
        })

    def test_an_unknown_id_writes_the_list_back_unchanged(self, store, api_gateway_event, lambda_context):
        store.client.get_secret_value.return_value = _secret_answer([{'id': 'a'}])
        assert self._delete(api_gateway_event, lambda_context, 'zzz') == (200, {'success': True})
        assert _written_configs(store.put) == [{'id': 'a'}]

    def test_no_secrets_arn_is_a_500_before_any_read(self, store, api_gateway_event, lambda_context):
        with patch.object(h, 'SECRETS_ARN', ''):
            assert self._delete(api_gateway_event, lambda_context) == (
                500, {'success': False, 'error': 'Secrets not configured'},
            )
        store.client.get_secret_value.assert_not_called()

    def test_a_failed_write_is_a_500_logged_once_with_the_cause(self, store, logger, api_gateway_event, lambda_context):
        error = aws_error('throttled', 'PutSecretValue', 'ThrottlingException')
        store.put.side_effect = error
        assert self._delete(api_gateway_event, lambda_context) == (
            500, {'success': False, 'error': 'Failed to delete scraper configuration'},
        )
        logger.exception.assert_called_once_with(f'Failed to delete scraper: {error}')


# ============================================
# GET /scrapers/templates
# ============================================

# Each row: id, name, description, icon, extraction method, then the config the editor copies.
TEMPLATE_CATALOGUE = [
    ('review_jsonld', 'Review JSON-LD', 'Extract reviews using JSON-LD structured data.', 'JSON-LD', 'jsonld',
     {'extraction_method': 'jsonld', 'template': 'review_jsonld',
      'pagination': {'enabled': True, 'param': 'page', 'max_pages': 10, 'start': 1}}),
    ('custom_css', 'Custom (CSS Selectors)', 'Create a custom scraper with CSS selectors.', 'CSS', 'css',
     {'extraction_method': 'css', 'container_selector': '.review', 'text_selector': '.review-text',
      'pagination': {'enabled': False, 'param': 'page', 'max_pages': 10, 'start': 1}}),
]


class TestTheTemplateCatalogue:
    def test_every_template_field_is_the_documented_literal(self, api_gateway_event, lambda_context):
        response, body = call_route(
            h.lambda_handler, api_gateway_event, lambda_context, method='GET', path='/scrapers/templates',
        )
        assert response['statusCode'] == 200
        assert list(body) == ['templates']
        assert [
            (t['id'], t['name'], t['description'], t['icon'], t['extraction_method'], t['config'])
            for t in body['templates']
        ] == TEMPLATE_CATALOGUE
        assert [(t['url_pattern'], t['supports_pagination']) for t in body['templates']] == [('', True), ('', True)]
        assert [sorted(t) for t in body['templates']] == [
            ['config', 'description', 'extraction_method', 'icon', 'id', 'name', 'supports_pagination', 'url_pattern'],
        ] * 2


# ============================================
# POST /scrapers/<id>/run
# ============================================

EXECUTION_ID = 'run_s-1_20260310120000_a1b2c3d4'
RUN_PAYLOAD = json.dumps({'scraper_id': 's-1', 'execution_id': EXECUTION_ID, 'manual_run': True})


@pytest.mark.usefixtures('fixed_id_suffix')
class TestRunScraper:
    @pytest.fixture
    def invoke(self) -> Iterator[MagicMock]:
        with (
            patch.object(h, 'lambda_client') as client,
            patch.object(h, 'WEBSCRAPER_FUNCTION_NAME', 'webscraper-fn'),
        ):
            yield client.invoke

    def _run(self, api_gateway_event, lambda_context) -> tuple[int, dict]:
        response, body = call_route(
            h.lambda_handler, api_gateway_event, lambda_context,
            method='POST', path='/scrapers/s-1/run', path_params={'scraper_id': 's-1'},
        )
        return response['statusCode'], body

    @pytest.mark.usefixtures('frozen_clock')
    def test_the_run_row_and_the_invoke_carry_the_exact_fields(self, table, invoke, api_gateway_event, lambda_context):
        assert self._run(api_gateway_event, lambda_context) == (
            200, {'success': True, 'execution_id': EXECUTION_ID, 'status': 'running'},
        )
        table.put_item.assert_called_once_with(Item={
            'pk': 'SCRAPER_RUN#s-1', 'sk': EXECUTION_ID, 'status': 'running',
            'started_at': '2026-03-10T12:00:00+00:00', 'pages_scraped': 0, 'items_found': 0, 'errors': [],
        })
        invoke.assert_called_once_with(FunctionName='webscraper-fn', InvocationType='Event', Payload=RUN_PAYLOAD)

    @pytest.mark.usefixtures('table', 'invoke')
    def test_the_execution_id_is_a_utc_second_stamp_and_a_random_tail(self, api_gateway_event, lambda_context):
        before = datetime.now(UTC)
        _status, body = self._run(api_gateway_event, lambda_context)
        stamp, tail = body['execution_id'].removeprefix('run_s-1_').split('_')
        assert len(stamp) == 14
        assert tail == 'a1b2c3d4'
        moment = datetime.strptime(stamp, '%Y%m%d%H%M%S').replace(tzinfo=UTC)
        assert abs((moment - before).total_seconds()) < 5

    @pytest.mark.usefixtures('frozen_clock')
    def test_a_missing_table_skips_the_row_but_still_invokes(self, invoke, api_gateway_event, lambda_context):
        with patch.object(h, 'get_aggregates_table', return_value=None):
            assert self._run(api_gateway_event, lambda_context)[0] == 200
        invoke.assert_called_once_with(FunctionName='webscraper-fn', InvocationType='Event', Payload=RUN_PAYLOAD)

    @pytest.mark.usefixtures('table')
    def test_a_failed_invoke_is_a_500_logged_once_with_the_cause(self, invoke, logger, api_gateway_event, lambda_context):
        error = aws_error('nope', 'Invoke', 'ResourceNotFoundException')
        invoke.side_effect = error
        assert self._run(api_gateway_event, lambda_context) == (
            500, {'success': False, 'error': 'Failed to start scraper run'},
        )
        logger.exception.assert_called_once_with(f'Failed to run scraper: {error}')

    @pytest.mark.usefixtures('table')
    def test_an_unconfigured_function_name_is_a_500_that_invokes_nothing(self, logger, api_gateway_event, lambda_context):
        with patch.object(h, 'lambda_client') as client, patch.object(h, 'WEBSCRAPER_FUNCTION_NAME', ''):
            assert self._run(api_gateway_event, lambda_context)[0] == 500
        client.invoke.assert_not_called()
        logger.exception.assert_called_once_with(
            'Failed to run scraper: WEBSCRAPER_FUNCTION_NAME environment variable is required',
        )


# ============================================
# GET /scrapers/<id>/status and /runs
# ============================================

FULL_RUN = {
    'pk': 'SCRAPER_RUN#s-1', 'sk': 'run_s-1_20260310120000', 'status': 'completed',
    'started_at': '2026-03-10T12:00:00+00:00', 'completed_at': '2026-03-10T12:05:00+00:00',
    'pages_scraped': 5, 'items_found': 25,
    'errors': ['Error scraping https://a.example/: 500 Server Error for jane@example.com'],
}
REDACTED = [f'Error scraping https://a.example/: {scraper_run_errors.SCRAPER_DETAIL_WITHHELD}']


class TestScraperStatus:
    def _status(self, api_gateway_event, lambda_context) -> tuple[int, dict]:
        response, body = call_route(
            h.lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/scrapers/s-1/status', path_params={'scraper_id': 's-1'},
        )
        return response['statusCode'], body

    def test_a_missing_table_is_unknown(self, api_gateway_event, lambda_context):
        with patch.object(h, 'get_aggregates_table', return_value=None):
            assert self._status(api_gateway_event, lambda_context) == (200, {'scraper_id': 's-1', 'status': 'unknown'})

    def test_the_newest_run_is_asked_for_by_partition(self, table, api_gateway_event, lambda_context):
        assert self._status(api_gateway_event, lambda_context) == (200, {'scraper_id': 's-1', 'status': 'never_run'})
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq('SCRAPER_RUN#s-1'), ScanIndexForward=False, Limit=1,
        )

    def test_a_full_run_is_answered_field_by_field_with_errors_redacted(self, table, api_gateway_event, lambda_context):
        table.query.return_value = {'Items': [FULL_RUN]}
        assert self._status(api_gateway_event, lambda_context) == (200, {
            'scraper_id': 's-1', 'execution_id': 'run_s-1_20260310120000', 'status': 'completed',
            'started_at': '2026-03-10T12:00:00+00:00', 'completed_at': '2026-03-10T12:05:00+00:00',
            'pages_scraped': 5, 'items_found': 25, 'errors': REDACTED,
        })

    def test_a_bare_run_row_answers_the_documented_defaults(self, table, api_gateway_event, lambda_context):
        table.query.return_value = {'Items': [{'pk': 'SCRAPER_RUN#s-1'}]}
        assert self._status(api_gateway_event, lambda_context) == (200, {
            'scraper_id': 's-1', 'execution_id': None, 'status': 'unknown',
            'started_at': None, 'completed_at': None, 'pages_scraped': 0, 'items_found': 0, 'errors': [],
        })

    def test_an_answer_without_items_is_never_run(self, table, api_gateway_event, lambda_context):
        table.query.return_value = {}
        assert self._status(api_gateway_event, lambda_context)[1] == {'scraper_id': 's-1', 'status': 'never_run'}

    def test_a_failed_query_is_unknown_with_one_warning_naming_the_cause(
        self, table, logger, api_gateway_event, lambda_context
    ):
        error = aws_error('down', 'Query', 'ProvisionedThroughputExceededException')
        table.query.side_effect = error
        assert self._status(api_gateway_event, lambda_context) == (
            200, {'scraper_id': 's-1', 'status': 'unknown', 'error': 'Failed to retrieve status'},
        )
        logger.warning.assert_called_once_with(f'Failed to get scraper status: {error}')


class TestScraperRuns:
    def _runs(self, api_gateway_event, lambda_context) -> tuple[int, dict]:
        response, body = call_route(
            h.lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/scrapers/s-1/runs', path_params={'scraper_id': 's-1'},
        )
        return response['statusCode'], body

    def test_a_missing_table_is_an_empty_history(self, api_gateway_event, lambda_context):
        with patch.object(h, 'get_aggregates_table', return_value=None):
            assert self._runs(api_gateway_event, lambda_context) == (200, {'runs': []})

    def test_the_ten_newest_runs_are_asked_for_by_partition(self, table, api_gateway_event, lambda_context):
        assert self._runs(api_gateway_event, lambda_context) == (200, {'runs': []})
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq('SCRAPER_RUN#s-1'), ScanIndexForward=False, Limit=10,
        )

    def test_each_run_is_returned_whole_with_only_its_errors_redacted(self, table, api_gateway_event, lambda_context):
        table.query.return_value = {'Items': [FULL_RUN, {'sk': 'older'}]}
        assert self._runs(api_gateway_event, lambda_context)[1] == {
            'runs': [{**FULL_RUN, 'errors': REDACTED}, {'sk': 'older', 'errors': []}],
        }

    def test_an_answer_without_items_is_an_empty_history(self, table, api_gateway_event, lambda_context):
        table.query.return_value = {}
        assert self._runs(api_gateway_event, lambda_context)[1] == {'runs': []}

    def test_a_failed_query_is_an_empty_history_with_one_warning_naming_the_cause(
        self, table, logger, api_gateway_event, lambda_context
    ):
        error = aws_error('down', 'Query', 'ProvisionedThroughputExceededException')
        table.query.side_effect = error
        assert self._runs(api_gateway_event, lambda_context) == (
            200, {'runs': [], 'error': 'Failed to retrieve run history'},
        )
        logger.warning.assert_called_once_with(f'Failed to get scraper runs: {error}')


# ============================================
# The fetch, the parse and POST /scrapers/analyze-url
# ============================================

def _page(payload: bytes) -> MagicMock:
    response = MagicMock()
    response.read.return_value = payload
    response.__enter__ = MagicMock(return_value=response)
    return response


class TestTheFetch:
    def test_the_request_carries_the_documented_headers_and_timeout(self):
        with patch.object(h._SAFE_OPENER, 'open', return_value=_page(b'<html></html>')) as opener:
            assert h._fetch_html('https://a.example/reviews') == '<html></html>'
        opener.assert_called_once()
        request = opener.call_args.args[0]
        assert request.full_url == 'https://a.example/reviews'
        assert request.header_items() == [
            ('User-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'),
            ('Accept', 'text/html,application/xhtml+xml'),
        ]
        assert opener.call_args.kwargs == {'timeout': 30}

    def test_the_body_is_decoded_as_utf8_dropping_invalid_bytes(self):
        with patch.object(h._SAFE_OPENER, 'open', return_value=_page(b'caf\xc3\xa9 \xff!')):
            assert h._fetch_html('https://a.example/') == 'café !'

    def test_a_url_error_that_is_not_a_blocked_destination_propagates(self):
        failure = urllib.error.URLError(OSError('timed out'))
        with (
            patch.object(h._SAFE_OPENER, 'open', side_effect=failure),
            pytest.raises(urllib.error.URLError) as caught,
        ):
            h._fetch_html('https://a.example/')
        assert caught.value is failure


class TestTheSelectorParse:
    @pytest.mark.parametrize(('reply', 'selectors'), [
        (
            'Here you go:\n{"container_selector": ".r",\n "confidence": "high"}\nDone.',
            {'container_selector': '.r', 'confidence': 'high'},
        ),
        ('{"a": {"b": 1}}', {'b': 1}),
        ('{} and {"x": 1}', {}),
    ])
    def test_the_first_flat_object_is_returned(self, reply, selectors):
        assert h._parse_selectors(reply) == selectors

    def test_a_reply_without_an_object_is_refused_by_name(self):
        with pytest.raises(ServiceError) as caught:
            h._parse_selectors('no selectors here')
        assert caught.value.message == 'Could not parse selectors from response'


PROMPT_HEAD = 'Analyze this HTML and identify CSS selectors for extracting reviews:\n\n```html\n'
PROMPT_TAIL = (
    '\n```\n\nReturn JSON with: container_selector, text_selector, rating_selector, author_selector, '
    'date_selector, confidence (high/medium/low), detected_reviews_count'
)


class TestAnalyzeUrl:
    @pytest.fixture
    def public_dns(self) -> Iterator[None]:
        with patch('shared.url_policy.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('93.184.216.34', 443))]):
            yield

    def _analyze(self, api_gateway_event, lambda_context, body: dict) -> tuple[int, dict]:
        response, decoded = call_route(
            h.lambda_handler, api_gateway_event, lambda_context,
            method='POST', path='/scrapers/analyze-url', body=body,
        )
        return response['statusCode'], decoded

    @pytest.mark.usefixtures('public_dns')
    def test_the_model_sees_at_most_50000_characters_in_the_documented_prompt(self, api_gateway_event, lambda_context):
        with (
            patch.object(h, '_fetch_html', return_value='h' * 50_001) as fetch,
            patch('shared.converse.converse', return_value='{"container_selector": ".r"}') as converse,
        ):
            assert self._analyze(api_gateway_event, lambda_context, {'url': 'https://a.example/reviews'}) == (
                200, {'success': True, 'selectors': {'container_selector': '.r'}},
            )
        fetch.assert_called_once_with('https://a.example/reviews')
        converse.assert_called_once_with(
            prompt=PROMPT_HEAD + 'h' * 50_000 + PROMPT_TAIL, max_tokens=2048, surface='utility',
        )

    def test_a_body_without_a_url_is_a_400_before_any_fetch(self, api_gateway_event, lambda_context):
        with patch.object(h, '_fetch_html') as fetch:
            assert self._analyze(api_gateway_event, lambda_context, {'other': 1}) == (
                400, {'success': False, 'error': 'URL is required'},
            )
        fetch.assert_not_called()

    @pytest.mark.usefixtures('public_dns')
    @pytest.mark.parametrize(('raised', 'status', 'message'), [
        pytest.param(ValidationError(h.PRIVATE_ADDRESS_ERROR), 400, h.PRIVATE_ADDRESS_ERROR, id='blocked at connect'),
        pytest.param(
            ServiceError('Could not parse selectors from response'), 500, 'Could not parse selectors from response',
            id='service',
        ),
    ])
    def test_a_policy_or_service_refusal_keeps_its_own_message(
        self, api_gateway_event, lambda_context, raised, status, message
    ):
        with patch.object(h, '_fetch_html', side_effect=raised):
            assert self._analyze(api_gateway_event, lambda_context, {'url': 'https://a.example/'}) == (
                status, {'success': False, 'error': message},
            )

    @pytest.mark.usefixtures('public_dns')
    def test_any_other_failure_is_a_500_logged_once_with_the_cause(self, logger, api_gateway_event, lambda_context):
        with patch.object(h, '_fetch_html', side_effect=RuntimeError('socket closed')):
            assert self._analyze(api_gateway_event, lambda_context, {'url': 'https://a.example/'}) == (
                500, {'success': False, 'error': 'Failed to analyze URL'},
            )
        logger.exception.assert_called_once_with('Failed to analyze URL: socket closed')
