"""Mutation hardening for `api/logs_handler.py`.

`test_logs_handler.py` pins the shape of each `/logs/*` route, `test_logs_params_and_paging.py`
the clamped query params and the paged DELETE, and `test_logs_privacy.py` that no response
carries PII. A mutation run found what none of them can see:

* the WORDING of every refusal — `'Aggregates table not configured'`, `'Failed to retrieve
  logs'`, `'Failed to retrieve summary'`, `'Failed to clear logs'` — and of every fixed
  redaction string, which the earlier tests read back through the module's own constants
  (so a constant that drifts to `XX…XX` still "matched") or checked as `'error' in body`;
* the exact DynamoDB calls: the `LOGS#<type>#<source>` / `SCRAPER_RUN#<id>` partition keys,
  the `sk >= cutoff` range, `ScanIndexForward=False`, the 100 / 50 / 1000 `Limit`s, the
  `pk, sk` projection on a clear, the `{pk, sk}` key of every `delete_item`;
* the cross-source listing: each source is asked for `limit // len(sources) + 1` rows and
  the merge is newest first by `timestamp`; the summary ADDS each source's counts into
  the totals;
* the scraper window: a run started exactly at the cutoff is kept (`<`, not `<=`), an old
  run is skipped rather than ending the scan, and a row with none of the optional fields
  answers `''` / `None` / `0` / `[]` by name;
* the redaction bounds and guards: the 51st record key is cut, a non-string key or error
  type is masked rather than crashing the comparison, a boolean `text_length` is dropped,
  both throttling type spellings map to the fixed throttling message;
* the module state: every route is the tracer's wrapper, the handler carries
  `api_handler`, the Lambda root is put FIRST on `sys.path`, the table is resolved at import.
"""
from __future__ import annotations

import os
import sys
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from decimal import Decimal
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock, call, patch

import pytest
from boto3.dynamodb.conditions import Key
from handler_events_fixtures import call_route, clear_validation_logs
from logs_fixtures import LIST_ROUTES
from module_reload_fixtures import reload_cycle

import logs_handler as h
from shared.exceptions import ConfigurationError
from shared.test.instrumentation_fixtures import assert_handler_wrapped, assert_tracer_wrapped

NOW = datetime(2026, 3, 10, 12, 0, 0, tzinfo=UTC)
CUTOFF_7D = '2026-03-03T12:00:00+00:00'
NOT_CONFIGURED = 'Aggregates table not configured'


def _get(api_gateway_event, lambda_context, path: str, path_params: dict | None = None,
         query: dict | None = None) -> tuple[dict, dict]:
    return call_route(h.lambda_handler, api_gateway_event, lambda_context,
                      method='GET', path=path, path_params=path_params or {}, query_params=query or {})


def _validation_row(message_id: str, timestamp: str, **extra: object) -> dict:
    return {'source_platform': 'webscraper', 'message_id': message_id, 'timestamp': timestamp,
            'log_type': 'validation', 'errors': [], **extra}


def _processing_row(message_id: str, error_type: object) -> dict:
    return {'source_platform': 'webscraper', 'message_id': message_id, 'timestamp': '2026-03-09T00:00:00+00:00',
            'log_type': 'processing', 'error_type': error_type, 'error_message': 'stored text, never echoed'}


@pytest.fixture
def frozen_clock() -> Iterator[MagicMock]:
    """`datetime.now(UTC)` inside the module answers NOW, so every cutoff is CUTOFF_7D-shaped."""
    with patch.object(h, 'datetime') as clock:
        clock.now.return_value = NOW
        yield clock


@pytest.fixture
def table() -> Iterator[MagicMock]:
    with patch.object(h, 'aggregates_table') as mock_table:
        mock_table.query.return_value = {'Items': []}
        yield mock_table


# ============================================
# Module state
# ============================================

class TestTheColdStartModuleState:
    def test_the_table_is_resolved_at_import_and_the_bounds_are_the_documented_ones(self):
        assert h.aggregates_table.name == 'test-aggregates'
        assert (h.DEFAULT_DAYS, h.LIST_LIMIT_DEFAULT, h.LIST_LIMIT_MAX) == (7, 100, 500)
        assert (h.SCRAPER_LIMIT_DEFAULT, h.SCRAPER_LIMIT_MAX, h.MAX_RETURNED_KEYS) == (50, 200, 50)

    def test_the_fixed_strings_are_the_documented_wording(self):
        assert h.MASKED_SEGMENT == '*'
        assert h.VALIDATION_ERROR_WITHHELD == 'Validation failed (details withheld)'
        assert h.UNKNOWN_ERROR_TYPE == 'UnknownError'
        assert h.PROCESSING_FAILED_MESSAGE == 'Processing failed; details are in the processor CloudWatch logs'
        assert h.THROTTLED_MESSAGE == 'Bedrock throttled the request; SQS will retry the message'
        assert sorted(h._THROTTLING_ERROR_TYPES) == ['BedrockThrottlingError', 'bedrock_throttling']

    @pytest.fixture
    def reload_with_env(self, monkeypatch) -> Iterator[Callable[..., ModuleType]]:
        yield from reload_cycle(monkeypatch, h)

    def test_the_lambda_root_is_put_ahead_of_whatever_was_first_on_sys_path(self, reload_with_env):
        lambda_root = os.path.dirname(os.path.dirname(os.path.abspath(h.__file__)))
        sentinel = os.path.join(os.sep, 'somewhere-else-with-its-own-shared')
        sys.path[:] = [sentinel] + [entry for entry in sys.path if entry != lambda_root]
        reload_with_env(AGGREGATES_TABLE='test-aggregates')
        assert sys.path[:2] == [lambda_root, sentinel]
        assert os.path.isdir(os.path.join(lambda_root, 'shared'))


class TestEveryEntryPointIsInstrumented:
    ROUTES = ('get_validation_logs', 'get_processing_logs', 'get_scraper_logs',
              'get_logs_summary', 'clear_validation_logs')

    @pytest.mark.parametrize('route', ROUTES)
    def test_every_route_is_the_tracer_wrapper_around_the_named_function(self, route):
        assert_tracer_wrapped(h, route)

    @pytest.mark.usefixtures('table')
    def test_the_handler_is_wrapped_and_injects_the_invocation_context_into_the_logger(self, api_gateway_event):
        assert_handler_wrapped(h)
        context = SimpleNamespace(
            function_name='voc-logs-under-test',
            memory_limit_in_mb=256,
            invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:voc-logs-under-test',
            aws_request_id='req-logs-mutation-0001',
            get_remaining_time_in_millis=lambda: 30_000,
        )
        response = h.lambda_handler(api_gateway_event(method='GET', path='/logs/summary'), context)
        assert response['statusCode'] == 200
        keys = h.logger.get_current_keys()
        assert keys['function_name'] == 'voc-logs-under-test'
        assert keys['function_request_id'] == 'req-logs-mutation-0001'


# ============================================
# Refusals name their cause
# ============================================

class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize(('path', 'path_params'), LIST_ROUTES)
    def test_an_unconfigured_table_is_a_500_that_names_it(self, path, path_params, api_gateway_event, lambda_context):
        with patch.object(h, 'aggregates_table', None):
            response, body = _get(api_gateway_event, lambda_context, path, path_params)
        assert response['statusCode'] == 500
        assert body == {'success': False, 'error': NOT_CONFIGURED}

    def test_an_unconfigured_table_refuses_the_clear_before_any_read(self, api_gateway_event, lambda_context):
        with patch.object(h, 'aggregates_table', None):
            response, body = call_route(h.lambda_handler, api_gateway_event, lambda_context, method='DELETE',
                                        path='/logs/validation/webscraper', path_params={'source': 'webscraper'})
        assert response['statusCode'] == 500
        assert body == {'success': False, 'error': NOT_CONFIGURED}

    def test_the_query_helper_refuses_an_unconfigured_table_by_name(self):
        with patch.object(h, 'aggregates_table', None), pytest.raises(ConfigurationError) as exc:
            h._query_logs_for_source('validation', 'webscraper', 7, 10)
        assert str(exc.value) == NOT_CONFIGURED

    def test_the_key_pager_refuses_an_unconfigured_table_by_name(self):
        with patch.object(h, 'aggregates_table', None), pytest.raises(ConfigurationError) as exc:
            next(h._validation_log_keys('webscraper'))
        assert str(exc.value) == NOT_CONFIGURED

    @pytest.mark.parametrize(('path', 'path_params', 'logged', 'answered'), [
        pytest.param('/logs/validation', {}, 'Failed to get validation logs: boom', 'Failed to retrieve logs',
                     id='validation'),
        pytest.param('/logs/processing', {}, 'Failed to get processing logs: boom', 'Failed to retrieve logs',
                     id='processing'),
        pytest.param('/logs/summary', {}, 'Failed to get logs summary: boom', 'Failed to retrieve summary',
                     id='summary'),
        pytest.param('/logs/scraper/s-1', {'scraper_id': 's-1'}, 'Failed to get scraper logs: boom',
                     'Failed to retrieve logs', id='scraper'),
    ])
    def test_a_failing_query_is_logged_with_the_route_and_answered_without_the_cause(
        self, path, path_params, logged, answered, table, api_gateway_event, lambda_context
    ):
        table.query.side_effect = RuntimeError('boom')
        with patch.object(h.logger, 'exception') as log:
            response, body = _get(api_gateway_event, lambda_context, path, path_params)
        assert response['statusCode'] == 500
        assert body == {'success': False, 'error': answered}
        # The second line is the shared ServiceError handler's own.
        assert log.call_args_list == [call(logged), call(f'Service error: {answered}')]

    def test_a_failing_clear_is_logged_and_answered_without_the_cause(self, table, api_gateway_event, lambda_context):
        table.query.side_effect = RuntimeError('boom')
        with patch.object(h.logger, 'exception') as log:
            response, body, _ = clear_validation_logs(h.lambda_handler, table, api_gateway_event, lambda_context)
        assert response['statusCode'] == 500
        assert body == {'success': False, 'error': 'Failed to clear logs'}
        assert log.call_args_list == [
            call('Failed to clear validation logs: boom'), call('Service error: Failed to clear logs')]


# ============================================
# The listing routes
# ============================================

class TestTheListingAsksDynamoForExactlyTheWindow:
    @pytest.mark.parametrize(('path', 'log_type'), [
        ('/logs/validation', 'validation'), ('/logs/processing', 'processing'),
    ])
    @pytest.mark.usefixtures('frozen_clock')
    def test_a_named_source_is_one_query_on_its_partition_newest_first_with_the_default_limit(
        self, path, log_type, table, api_gateway_event, lambda_context
    ):
        _, body = _get(api_gateway_event, lambda_context, path, query={'source': 'webscraper'})
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq(f'LOGS#{log_type}#webscraper') & Key('sk').gte(CUTOFF_7D),
            ScanIndexForward=False,
            Limit=100,
        )
        assert body == {'logs': [], 'count': 0, 'days': 7}

    @pytest.mark.usefixtures('frozen_clock')
    def test_the_cutoff_is_days_before_now(self, table, api_gateway_event, lambda_context):
        _get(api_gateway_event, lambda_context, '/logs/validation', query={'source': 'webscraper', 'days': '3'})
        assert table.query.call_args.kwargs['KeyConditionExpression'] == (
            Key('pk').eq('LOGS#validation#webscraper') & Key('sk').gte('2026-03-07T12:00:00+00:00'))

    def test_a_page_without_items_is_an_empty_listing(self, table, api_gateway_event, lambda_context):
        table.query.return_value = {}
        response, body = _get(api_gateway_event, lambda_context, '/logs/validation', query={'source': 'webscraper'})
        assert response['statusCode'] == 200
        assert body['logs'] == []

    def test_every_entry_carries_the_four_envelope_fields_by_name(self, table, api_gateway_event, lambda_context):
        table.query.return_value = {'Items': [{
            'source_platform': 'webscraper', 'message_id': 'msg-1', 'timestamp': '2026-03-09T00:00:00+00:00',
            'log_type': 'validation_failure', 'errors': ['text: missing'], 'pk': 'LOGS#validation#webscraper',
        }]}
        _, body = _get(api_gateway_event, lambda_context, '/logs/validation', query={'source': 'webscraper'})
        assert body['logs'] == [{
            'source_platform': 'webscraper', 'message_id': 'msg-1', 'timestamp': '2026-03-09T00:00:00+00:00',
            'log_type': 'validation_failure', 'errors': ['text: missing'],
        }]


class TestTheUnfilteredListingFansOutOverEverySource:
    SOURCES = ('webscraper', 'app_reviews_ios', 'manual_import')

    @pytest.fixture(autouse=True)
    def three_sources(self, monkeypatch):
        monkeypatch.setenv('ENABLED_SOURCES', '["webscraper", "app_reviews_ios"]')

    @pytest.mark.usefixtures('frozen_clock')
    def test_each_source_is_asked_for_its_share_of_the_limit_plus_one(
        self, table, api_gateway_event, lambda_context
    ):
        _get(api_gateway_event, lambda_context, '/logs/processing', query={'limit': '100'})
        assert table.query.call_args_list == [
            call(KeyConditionExpression=Key('pk').eq(f'LOGS#processing#{source}') & Key('sk').gte(CUTOFF_7D),
                 ScanIndexForward=False, Limit=34)
            for source in self.SOURCES
        ]

    @pytest.mark.parametrize(('limit', 'share'), [('3', 2), ('2', 1), ('500', 167)])
    def test_the_share_is_the_floor_plus_one(self, limit, share, table, api_gateway_event, lambda_context):
        _get(api_gateway_event, lambda_context, '/logs/validation', query={'limit': limit})
        assert [c.kwargs['Limit'] for c in table.query.call_args_list] == [share, share, share]

    def test_the_merge_is_newest_first_by_timestamp_then_cut_to_the_limit(
        self, table, api_gateway_event, lambda_context
    ):
        by_source = {
            'webscraper': [_validation_row('ws-old', '2026-03-05T00:00:00+00:00'),
                           _validation_row('ws-new', '2026-03-09T00:00:00+00:00')],
            'app_reviews_ios': [_validation_row('ios', '2026-03-08T00:00:00+00:00')],
            'manual_import': [_validation_row('mi', '2026-03-07T00:00:00+00:00')],
        }
        table.query.side_effect = [{'Items': by_source[s]} for s in self.SOURCES]

        _, body = _get(api_gateway_event, lambda_context, '/logs/validation', query={'limit': '3'})

        assert [log['message_id'] for log in body['logs']] == ['ws-new', 'ios', 'mi']
        assert body['count'] == 3

    def test_a_merge_of_one_row_per_source_keeps_them_all_in_timestamp_order(
        self, table, api_gateway_event, lambda_context
    ):
        by_source = {
            'webscraper': [_validation_row('b', '2026-03-08T00:00:00+00:00')],
            'app_reviews_ios': [_validation_row('c', '2026-03-09T00:00:00+00:00')],
            'manual_import': [_validation_row('a', '2026-03-07T00:00:00+00:00')],
        }
        table.query.side_effect = [{'Items': by_source[s]} for s in self.SOURCES]

        _, body = _get(api_gateway_event, lambda_context, '/logs/validation')

        assert [log['message_id'] for log in body['logs']] == ['c', 'b', 'a']


# ============================================
# The scraper route
# ============================================

class TestTheScraperListing:
    def test_it_is_one_query_on_the_run_partition_newest_first_with_the_default_limit(
        self, table, api_gateway_event, lambda_context
    ):
        _, body = _get(api_gateway_event, lambda_context, '/logs/scraper/scraper-123', {'scraper_id': 'scraper-123'})
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq('SCRAPER_RUN#scraper-123'),
            ScanIndexForward=False,
            Limit=50,
        )
        assert body == {'scraper_id': 'scraper-123', 'logs': [], 'count': 0}

    @pytest.mark.parametrize(('started_at', 'kept'), [
        pytest.param(CUTOFF_7D, True, id='exactly-at-the-cutoff-is-kept'),
        pytest.param('2026-03-03T11:59:59.999999+00:00', False, id='a-microsecond-older-is-dropped'),
        pytest.param('2026-03-03T12:00:00.000001+00:00', True, id='a-microsecond-newer-is-kept'),
    ])
    @pytest.mark.usefixtures('frozen_clock')
    def test_the_window_is_closed_at_the_cutoff(
        self, started_at, kept, table, api_gateway_event, lambda_context
    ):
        table.query.return_value = {'Items': [{'sk': 'RUN#1', 'started_at': started_at}]}
        _, body = _get(api_gateway_event, lambda_context, '/logs/scraper/s-1', {'scraper_id': 's-1'})
        assert body['count'] == (1 if kept else 0)

    @pytest.mark.usefixtures('frozen_clock')
    def test_an_old_run_is_skipped_not_the_end_of_the_scan(self, table, api_gateway_event, lambda_context):
        table.query.return_value = {'Items': [
            {'sk': 'RUN#old', 'started_at': '2026-01-01T00:00:00+00:00'},
            {'sk': 'RUN#new', 'started_at': '2026-03-09T00:00:00+00:00'},
        ]}
        _, body = _get(api_gateway_event, lambda_context, '/logs/scraper/s-1', {'scraper_id': 's-1'})
        assert [log['run_id'] for log in body['logs']] == ['RUN#new']

    @pytest.mark.parametrize('started_at', [None, 123, ''])
    def test_a_run_without_a_readable_start_is_kept(self, started_at, table, api_gateway_event, lambda_context):
        table.query.return_value = {'Items': [{'sk': 'RUN#1', 'started_at': started_at}]}
        _, body = _get(api_gateway_event, lambda_context, '/logs/scraper/s-1', {'scraper_id': 's-1'})
        assert body['count'] == 1
        assert body['logs'][0]['started_at'] == started_at

    def test_a_row_with_no_optional_fields_answers_the_documented_defaults_by_name(
        self, table, api_gateway_event, lambda_context
    ):
        table.query.return_value = {'Items': [{'pk': 'SCRAPER_RUN#s-1'}]}
        _, body = _get(api_gateway_event, lambda_context, '/logs/scraper/s-1', {'scraper_id': 's-1'})
        assert body['logs'] == [{
            'run_id': '', 'status': None, 'started_at': '', 'completed_at': None,
            'pages_scraped': 0, 'items_found': 0, 'errors': [],
        }]

    @pytest.mark.usefixtures('frozen_clock')
    def test_every_stored_field_is_copied_under_its_own_name(
        self, table, api_gateway_event, lambda_context
    ):
        table.query.return_value = {'Items': [{
            'pk': 'SCRAPER_RUN#s-1', 'sk': 'RUN#2026-03-09', 'status': 'completed_with_errors',
            'started_at': '2026-03-09T00:00:00+00:00', 'completed_at': '2026-03-09T00:05:00+00:00',
            'pages_scraped': 3, 'items_found': 12, 'errors': ['No scraper configuration found'],
        }]}
        _, body = _get(api_gateway_event, lambda_context, '/logs/scraper/s-1', {'scraper_id': 's-1'})
        assert body['logs'] == [{
            'run_id': 'RUN#2026-03-09', 'status': 'completed_with_errors',
            'started_at': '2026-03-09T00:00:00+00:00', 'completed_at': '2026-03-09T00:05:00+00:00',
            'pages_scraped': 3, 'items_found': 12, 'errors': ['No scraper configuration found'],
        }]


# ============================================
# The summary
# ============================================

class TestTheSummaryAddsUpEverySource:
    @pytest.fixture(autouse=True)
    def two_sources(self, monkeypatch):
        monkeypatch.setenv('ENABLED_SOURCES', '["webscraper"]')

    @pytest.mark.usefixtures('frozen_clock')
    def test_each_source_is_asked_for_validation_then_processing_rows_up_to_a_thousand(
        self, table, api_gateway_event, lambda_context
    ):
        _get(api_gateway_event, lambda_context, '/logs/summary')
        assert table.query.call_args_list == [
            call(KeyConditionExpression=Key('pk').eq(f'LOGS#{log_type}#{source}') & Key('sk').gte(CUTOFF_7D),
                 ScanIndexForward=False, Limit=1000)
            for source in ('webscraper', 'manual_import')
            for log_type in ('validation', 'processing')
        ]

    def test_counts_are_per_source_and_the_totals_are_their_sums(self, table, api_gateway_event, lambda_context):
        def rows(n: int) -> dict:
            return {'Items': [_validation_row(f'm{i}', '2026-03-09T00:00:00+00:00') for i in range(n)]}
        # webscraper: 2 validation, 3 processing; manual_import: 4 validation, 1 processing.
        table.query.side_effect = [rows(2), rows(3), rows(4), rows(1)]

        _, body = _get(api_gateway_event, lambda_context, '/logs/summary')

        assert body == {
            'summary': {
                'validation_failures': {'webscraper': 2, 'manual_import': 4},
                'processing_errors': {'webscraper': 3, 'manual_import': 1},
                'total_validation_failures': 6,
                'total_processing_errors': 4,
            },
            'days': 7,
        }

    def test_a_source_without_rows_is_left_out_of_the_per_source_counts(self, table, api_gateway_event, lambda_context):
        one = {'Items': [_validation_row('m', '2026-03-09T00:00:00+00:00')]}
        # webscraper: 0 validation, 1 processing; manual_import: 1 validation, 0 processing.
        table.query.side_effect = [{'Items': []}, one, one, {'Items': []}]

        _, body = _get(api_gateway_event, lambda_context, '/logs/summary')

        assert body['summary'] == {
            'validation_failures': {'manual_import': 1}, 'processing_errors': {'webscraper': 1},
            'total_validation_failures': 1, 'total_processing_errors': 1,
        }


# ============================================
# The clear
# ============================================

class TestTheClearDeletesExactlyTheKeysItPaged:
    def test_the_page_query_projects_the_key_only_and_each_row_is_deleted_by_its_own_key(
        self, table, api_gateway_event, lambda_context
    ):
        pk = 'LOGS#validation#webscraper'
        # One page as an exhaustible list, not a return_value: a pager that fails to stop
        # then hits StopIteration on its second query and answers 500 instead of spinning.
        table.query.side_effect = [{'Items': [{'pk': pk, 'sk': 'a'}, {'pk': pk, 'sk': 'b'}]}]

        response, body, batch = clear_validation_logs(h.lambda_handler, table, api_gateway_event, lambda_context)

        assert (response['statusCode'], body) == (200, {'success': True, 'deleted': 2})
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq(pk), ProjectionExpression='pk, sk')
        assert batch.delete_item.call_args_list == [
            call(Key={'pk': pk, 'sk': 'a'}), call(Key={'pk': pk, 'sk': 'b'}),
        ]

    def test_the_pager_yields_every_page_and_stops_when_dynamo_names_no_next_key(self, table):
        pk = 'LOGS#validation#webscraper'
        table.query.side_effect = [
            {'Items': [{'pk': pk, 'sk': 'a'}], 'LastEvaluatedKey': {'pk': pk, 'sk': 'a'}},
            {'Items': [{'pk': pk, 'sk': 'b'}], 'LastEvaluatedKey': {'pk': pk, 'sk': 'b'}},
            {'Items': []},
        ]
        assert list(h._validation_log_keys('webscraper')) == [{'pk': pk, 'sk': 'a'}, {'pk': pk, 'sk': 'b'}]
        assert [c.kwargs.get('ExclusiveStartKey') for c in table.query.call_args_list] == [
            None, {'pk': pk, 'sk': 'a'}, {'pk': pk, 'sk': 'b'},
        ]

    def test_a_page_without_items_yields_nothing(self, table):
        table.query.side_effect = [{}]
        assert list(h._validation_log_keys('webscraper')) == []


# ============================================
# Read-time redaction
# ============================================

class TestValidationErrorRedaction:
    @pytest.mark.parametrize(('stored', 'shown'), [
        pytest.param('metadata.key: missing', 'metadata.key: missing', id='dotted-schema-path-and-code'),
        pytest.param('items.0.text: too_short', 'items.0.text: too_short', id='index-segment'),
        pytest.param('*: missing', '*: missing', id='wildcard-segment'),
        pytest.param('  text : missing', 'text: missing', id='path-is-stripped'),
        pytest.param('metadata: Value error, a: b', 'metadata: invalid', id='only-the-first-colon-splits'),
        pytest.param('text: Missing', 'text: invalid', id='an-uppercase-detail-is-not-a-code'),
        pytest.param('text: value error', 'text: invalid', id='a-spaced-detail-is-not-a-code'),
        pytest.param('text:missing', 'Validation failed (details withheld)', id='no-colon-space'),
        pytest.param('jane.doe@example.com: missing', 'Validation failed (details withheld)',
                     id='an-email-shaped-path-is-withheld-whole'),
        pytest.param('a.: missing', 'Validation failed (details withheld)', id='an-empty-segment'),
        pytest.param(f'{"a" * 65}: missing', 'Validation failed (details withheld)', id='a-65-char-segment'),
        pytest.param(f'{"a" * 64}: missing', f'{"a" * 64}: missing', id='a-64-char-segment'),
        pytest.param('1234567: missing', 'Validation failed (details withheld)', id='a-7-digit-index'),
        pytest.param(f'text: {"a" * 65}', 'text: invalid', id='a-65-char-code-is-not-a-code'),
        pytest.param(f'text: {"a" * 64}', f'text: {"a" * 64}', id='a-64-char-code'),
        pytest.param(42, 'Validation failed (details withheld)', id='not-a-string'),
    ])
    def test_each_stored_error_is_shown_as(self, stored, shown):
        assert h._redact_validation_error(stored) == shown

    @pytest.mark.parametrize(('raw', 'path'), [
        ('a.b', 'a.b'), (' a ', 'a'), ('', None), ('a..b', None), ('a b', None), ('.', None),
    ])
    def test_safe_path(self, raw, path):
        assert h._safe_path(raw) == path


class TestValidationFieldRedaction:
    def test_errors_that_are_not_a_list_become_an_empty_list_and_other_fields_stay_absent(self):
        assert h._redacted_validation_fields({'errors': 'text: missing', 'record_keys': 'id', 'text_length': '27'}) \
            == {'errors': []}

    def test_at_most_fifty_errors_are_returned(self):
        fields = h._redacted_validation_fields({'errors': [f'f{i}: missing' for i in range(51)]})
        assert fields['errors'] == [f'f{i}: missing' for i in range(50)]

    def test_at_most_fifty_record_keys_are_returned_and_each_is_schema_shaped_or_masked(self):
        keys = [f'k{i}' for i in range(49)] + ['jane@example.com', 'k50']
        fields = h._redacted_validation_fields({'errors': [], 'record_keys': keys})
        assert fields['record_keys'] == [f'k{i}' for i in range(49)] + ['*']
        assert len(fields['record_keys']) == 50

    def test_exactly_fifty_record_keys_are_all_returned(self):
        fields = h._redacted_validation_fields({'errors': [], 'record_keys': [f'k{i}' for i in range(50)]})
        assert fields['record_keys'] == [f'k{i}' for i in range(50)]

    @pytest.mark.parametrize(('key', 'shown'), [
        (5, '*'), (None, '*'), ('', '*'), ('*', '*'), ('_x', '_x'), ('9', '9'), ('a-b', '*'), ('A' * 64, 'A' * 64),
        ('A' * 65, '*'),
    ])
    def test_each_record_key_is_shown_as(self, key, shown):
        assert h._redacted_validation_fields({'record_keys': [key]})['record_keys'] == [shown]

    @pytest.mark.parametrize(('stored', 'shown'), [
        pytest.param(27, 27, id='int'),
        pytest.param(Decimal('27'), 27, id='decimal'),
        pytest.param(0, 0, id='zero'),
    ])
    def test_a_numeric_text_length_is_returned_as_an_int(self, stored, shown):
        fields = h._redacted_validation_fields({'text_length': stored})
        assert fields['text_length'] == shown
        assert type(fields['text_length']) is int

    @pytest.mark.parametrize('stored', [True, False, '27', 27.5, None])
    def test_a_non_numeric_text_length_is_dropped(self, stored):
        assert 'text_length' not in h._redacted_validation_fields({'text_length': stored})


class TestProcessingFieldRedaction:
    @pytest.mark.parametrize(('stored', 'shown_type', 'shown_message'), [
        pytest.param('KeyError', 'KeyError', 'Processing failed; details are in the processor CloudWatch logs',
                     id='a-plain-type'),
        pytest.param('BedrockThrottlingError', 'BedrockThrottlingError',
                     'Bedrock throttled the request; SQS will retry the message', id='throttling-class-name'),
        pytest.param('bedrock_throttling', 'bedrock_throttling',
                     'Bedrock throttled the request; SQS will retry the message', id='throttling-snake-case'),
        pytest.param('Jane Doe <jane@example.com>', 'UnknownError',
                     'Processing failed; details are in the processor CloudWatch logs', id='a-hostile-type'),
        pytest.param(7, 'UnknownError', 'Processing failed; details are in the processor CloudWatch logs',
                     id='not-a-string'),
        pytest.param(None, 'UnknownError', 'Processing failed; details are in the processor CloudWatch logs',
                     id='absent'),
    ])
    def test_the_type_is_echoed_only_when_schema_shaped_and_the_message_derives_from_it(
        self, stored, shown_type, shown_message
    ):
        assert h._redacted_processing_fields({'error_type': stored, 'error_message': 'never echoed'}) == {
            'error_type': shown_type, 'error_message': shown_message,
        }

    def test_the_processing_route_carries_both_redacted_fields(self, table, api_gateway_event, lambda_context):
        table.query.return_value = {'Items': [_processing_row('m-1', 'BedrockThrottlingError')]}
        _, body = _get(api_gateway_event, lambda_context, '/logs/processing', query={'source': 'webscraper'})
        assert body['logs'] == [{
            'source_platform': 'webscraper', 'message_id': 'm-1', 'timestamp': '2026-03-09T00:00:00+00:00',
            'log_type': 'processing', 'error_type': 'BedrockThrottlingError',
            'error_message': 'Bedrock throttled the request; SQS will retry the message',
        }]
