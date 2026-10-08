"""Mutation hardening for `api/manual_import_handler.py`.

`test_manual_import_handler.py`, `test_manual_import_csv_upload.py` and
`test_manual_import_json_upload.py` pin the shape of each route (a 400 here, a
404 there, two SQS sends for two reviews, the frozen `csv-row-v1` recipe). A
mutation run found what none of them can see:

* the WORDING of every refusal and of every warning — the 400/404/500 bodies are
  what the operator reads in the Scrapers page, and the `warnings` list is what
  tells them which CSV row was skipped and why. The earlier tests checked
  `'error' in body` or a substring an `XX…XX` mutant still contains;
* the ACCEPTED side of each bound (`>` vs `>=`): exactly 10 000 characters of
  pasted text, exactly 10 MiB of CSV, exactly the row cap, exactly five warnings
  quoted in the "no valid rows" refusal, twenty kept in the response, ten item
  errors quoted in the json-upload refusal;
* the exact AWS calls: the job row written at parse start (`status`, the empty
  `reviews`/`unparsed_sections`, `error: None`, the one-hour `ttl`), the `failed`
  update when the processor cannot be invoked, the `imported` update, every S3
  key (`raw/manual_import/…`, `raw/csv_upload/…`, `raw/json_upload/…`), the
  `ContentType`s, the `Metadata`, the per-review and batched queue messages field
  by field, the batch `Id`s, and the row number a failed batch entry is reported
  under;
* the caller identity written to S3: `sub`, then `cognito:username`, then
  `'unknown'` — for a missing authorizer, a missing `requestContext`, and claims
  that are not a mapping;
* every CSV header synonym (`stars`, `score`, `user_id`, `subject`, `link`, …),
  the lookup priority among them, header trimming, the identity of an id-less row
  (position-keyed, as a pinned literal), and the non-ASCII handling of the
  fingerprint;
* the cold-start state: the environment variables the module reads, the `''`
  defaults, the `None` table, and the lambda root put first on `sys.path`.
"""
from __future__ import annotations

import json
import os
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import BotoCoreError, ClientError
from handler_events_fixtures import aws_error, call_route
from module_reload_fixtures import reload_cycle

import manual_import_handler as h
from shared.csv_columns import AUTO_COLUMNS
from shared.exceptions import ConfigurationError, NotFoundError, ValidationError
from shared.test.instrumentation_fixtures import assert_handler_wrapped, assert_tracer_wrapped
from shared.test.source_profile_fixtures import unconfigured_upload_profile


@pytest.fixture(autouse=True)
def _no_source_profiles() -> Iterator[None]:
    """No profiles stored: every upload files under the defaults (pii allow, keep forever)."""
    with patch.object(h, 'upload_profile', side_effect=unconfigured_upload_profile):
        yield


QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue'
BUCKET = 'test-raw-data-bucket'
PROCESSOR = 'voc-manual-import-processor'
NOW = datetime(2026, 3, 7, 12, 30, 45, tzinfo=UTC)
NOW_ISO = '2026-03-07T12:30:45+00:00'
EPOCH = 1_700_000_000
JOB_ID = 'job-123'
JOB_KEY = {'pk': 'MANUAL_IMPORT#job-123', 'sk': 'JOB'}
FIXED_UUID = 'a1b2c3d4-0000-4000-8000-000000000001'

G2_JOB = {
    'source_origin': 'g2',
    'source_url': 'https://g2.com/review/example',
    'raw_text': 'Original raw text',
    'reviews': [{'text': 'Great!', 'rating': 5}],
}
TWO_REVIEWS = [
    {'text': 'Great product!', 'rating': 5, 'author': 'John', 'title': 'Love it', 'date': '2026-01-10'},
    {'text': 'Good service', 'rating': 4, 'author': 'Jane', 'date': '2026-01-09'},
]


def _s3_error() -> ClientError:
    return aws_error('S3 upload failed', 'PutObject')


S3_ERROR_TEXT = 'An error occurred (InternalFailure) when calling the PutObject operation: S3 upload failed'


def _batch_ok(entries):
    return {'Successful': [{'Id': e['Id']} for e in entries], 'Failed': []}


def _batch_sqs() -> MagicMock:
    sqs = MagicMock()
    sqs.send_message_batch.side_effect = lambda Entries, **_kwargs: _batch_ok(Entries)
    return sqs


def _messages(logger: MagicMock, level: str) -> list[str]:
    return [c.args[0] for c in getattr(logger, level).call_args_list]


def _plain_context() -> SimpleNamespace:
    # A plain object, not a MagicMock: Powertools reads `context.lambda_context`
    # whenever that attribute exists, and a MagicMock has every attribute.
    return SimpleNamespace(
        function_name='voc-manual-import-under-test',
        memory_limit_in_mb=256,
        invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:voc-manual-import-under-test',
        aws_request_id='req-manual-import-mutation-0001',
        get_remaining_time_in_millis=lambda: 30_000,
    )


@pytest.fixture
def frozen() -> Iterator[None]:
    """A fixed clock, epoch and uuid, so every key, ttl and id is a literal."""
    clock = MagicMock()
    clock.now.return_value = NOW
    with patch.object(h, 'datetime', clock), \
            patch.object(h, 'time', MagicMock(time=MagicMock(return_value=EPOCH))), \
            patch.object(h, 'uuid', MagicMock(uuid4=MagicMock(return_value=FIXED_UUID))):
        yield


def _post(api_gateway_event, lambda_context, path: str, body: dict, **event_kwargs):
    return call_route(h.lambda_handler, api_gateway_event, lambda_context,
                      method='POST', path=path, body=body, **event_kwargs)


def _parse(api_gateway_event, lambda_context, body: dict):
    return _post(api_gateway_event, lambda_context, '/scrapers/manual/parse', body)


def _status(api_gateway_event, lambda_context, job_id: str = JOB_ID):
    return call_route(h.lambda_handler, api_gateway_event, lambda_context, method='GET',
                      path=f'/scrapers/manual/parse/{job_id}', path_params={'job_id': job_id})


def _confirm(api_gateway_event, lambda_context, body: dict):
    return _post(api_gateway_event, lambda_context, '/scrapers/manual/confirm', body)


def _csv(api_gateway_event, lambda_context, body: dict, **event_kwargs):
    return _post(api_gateway_event, lambda_context, '/scrapers/manual/csv-upload', body, **event_kwargs)


def _json_upload(api_gateway_event, lambda_context, items: list):
    return _post(api_gateway_event, lambda_context, '/scrapers/manual/json-upload', {'items': items})


# ============================================
# Cold start and module constants
# ============================================


class TestColdStart:
    @pytest.fixture
    def reload_with_env(self, monkeypatch):
        yield from reload_cycle(monkeypatch, h)

    def test_nothing_in_the_environment_means_empty_names_and_no_table(self, reload_with_env):
        module = reload_with_env(AGGREGATES_TABLE=None, PROCESSING_QUEUE_URL=None, RAW_DATA_BUCKET=None,
                                 MANUAL_IMPORT_PROCESSOR_FUNCTION=None)
        assert (module.AGGREGATES_TABLE, module.PROCESSING_QUEUE_URL, module.RAW_DATA_BUCKET,
                module.MANUAL_IMPORT_PROCESSOR_FUNCTION) == ('', '', '', '')
        assert module.aggregates_table is None

    def test_the_names_are_read_from_their_own_variables(self, reload_with_env):
        module = reload_with_env(AGGREGATES_TABLE='t-1', PROCESSING_QUEUE_URL='q-1', RAW_DATA_BUCKET='b-1',
                                 MANUAL_IMPORT_PROCESSOR_FUNCTION='f-1')
        assert (module.AGGREGATES_TABLE, module.PROCESSING_QUEUE_URL, module.RAW_DATA_BUCKET,
                module.MANUAL_IMPORT_PROCESSOR_FUNCTION) == ('t-1', 'q-1', 'b-1', 'f-1')
        assert module.aggregates_table.name == 't-1'

    def test_the_lambda_root_is_put_ahead_of_whatever_was_first_on_sys_path(self, reload_with_env):
        lambda_root = os.path.dirname(os.path.dirname(os.path.abspath(h.__file__)))
        sentinel = os.path.join(os.sep, 'somewhere-else-with-its-own-shared')
        sys.path[:] = [sentinel] + [entry for entry in sys.path if entry != lambda_root]
        reload_with_env(AGGREGATES_TABLE='t-1')
        assert sys.path[:2] == [lambda_root, sentinel]
        assert os.path.isdir(os.path.join(lambda_root, 'shared'))

    def test_the_bounds_and_tables_are_the_documented_literals(self):
        assert h.MAX_CHARACTERS == 10000
        assert h.JOB_TTL_SECONDS == 3600
        assert h.MAX_JSON_UPLOAD_ITEMS == 50000
        assert h.MAX_CSV_BYTES == 10485760
        assert h.MAX_CSV_ROW_ID_LENGTH == 256
        assert h.DOMAIN_TO_SOURCE == {
            'g2.com': 'g2', 'www.g2.com': 'g2',
            'capterra.com': 'capterra', 'www.capterra.com': 'capterra',
        }
        assert AUTO_COLUMNS['text'] == ('text', 'review', 'comment', 'feedback')
        assert (ClientError, BotoCoreError) == h._AWS_WRITE_ERRORS

    def test_the_module_holds_one_client_per_service_it_talks_to(self):
        assert h.s3.meta.service_model.service_name == 's3'
        assert h.sqs.meta.service_model.service_name == 'sqs'
        assert h.dynamodb.meta.service_name == 'dynamodb'


class TestEveryEntryPointIsInstrumented:
    ROUTES = ('start_parse', 'get_parse_status', 'confirm_import', 'csv_upload', 'json_upload')

    @pytest.mark.parametrize('route', ROUTES)
    def test_every_route_is_the_tracer_wrapper_around_the_named_function(self, route):
        assert_tracer_wrapped(h, route)

    def test_the_handler_is_wrapped_and_injects_the_invocation_context_into_the_logger(self, api_gateway_event):
        assert_handler_wrapped(h)
        with patch.object(h, 'aggregates_table') as table:
            table.get_item.return_value = {'Item': {'status': 'processing'}}
            response = h.lambda_handler(
                api_gateway_event(method='GET', path='/scrapers/manual/parse/job-123',
                                  path_params={'job_id': 'job-123'}),
                _plain_context(),
            )
        assert response['statusCode'] == 200
        keys = h.logger.get_current_keys()
        assert keys['function_name'] == 'voc-manual-import-under-test'
        assert keys['function_request_id'] == 'req-manual-import-mutation-0001'


# ============================================
# Who uploaded: the caller identity stamped on S3
# ============================================


class TestTheCallerIdentityStampedOnTheArchive:
    """`_caller_user_id`, observed through the csv archive's `Metadata.uploaded_by`."""

    def _uploaded_by(self, event, lambda_context) -> str:
        s3 = MagicMock()
        with patch.object(h, 'PROCESSING_QUEUE_URL', ''), patch.object(h, 'RAW_DATA_BUCKET', BUCKET), \
                patch.object(h, 's3', s3):
            response = h.lambda_handler(event, lambda_context)
        assert response['statusCode'] == 200
        return s3.put_object.call_args.kwargs['Metadata']['uploaded_by']

    @pytest.mark.parametrize(('claims', 'expected'), [
        ({'sub': 'sub-0001', 'cognito:username': 'alice'}, 'sub-0001'),
        ({'cognito:username': 'alice'}, 'alice'),
        ({}, 'unknown'),
        ('not-a-mapping', 'unknown'),
    ])
    def test_sub_then_username_then_unknown(self, api_gateway_event, lambda_context, claims, expected):
        event = api_gateway_event(method='POST', path='/scrapers/manual/csv-upload',
                                  body={'csv_text': 'text\nhello\n'}, claims=claims)
        assert self._uploaded_by(event, lambda_context) == expected

    def test_an_authorizer_without_claims_is_unknown(self, api_gateway_event, lambda_context):
        event = api_gateway_event(method='POST', path='/scrapers/manual/csv-upload', body={'csv_text': 'text\nhello\n'})
        event['requestContext']['authorizer'] = {}
        assert self._uploaded_by(event, lambda_context) == 'unknown'

    def test_an_event_without_a_request_context_is_unknown(self, api_gateway_event, lambda_context):
        event = api_gateway_event(method='POST', path='/scrapers/manual/csv-upload', body={'csv_text': 'text\nhello\n'})
        del event['requestContext']
        assert self._uploaded_by(event, lambda_context) == 'unknown'


# ============================================
# Source detection
# ============================================


class TestExtractSourceFromUrl:
    @pytest.mark.parametrize(('url', 'source'), [
        ('https://WWW.G2.COM/products/x', 'g2'),
        ('https://user:pw@G2.com:8080/x', 'g2'),
        ('https://Capterra.com/reviews/12345', 'capterra'),
        ('https://www.capterra.com/p/12345/product', 'capterra'),
        ('https://www.www.g2.com/x', 'g2'),
        ('https://www.www.example.com/x', 'example.com'),
        ('https://shop.www.example.com/x', 'shop.example.com'),
        ('https://EXAMPLE.com/reviews', 'example.com'),
        ('https://www.Example.com/reviews', 'example.com'),
        ('https://custom-reviews.io/page', 'custom-reviews.io'),
        ('ftp://example.com', 'example.com'),
        ('not-a-url', 'unknown'),
        ('', 'unknown'),
        (None, 'unknown'),
    ])
    def test_the_host_is_lower_cased_and_mapped(self, url, source):
        assert h.extract_source_from_url(url) == source

    @pytest.mark.parametrize(('url', 'message'), [
        ('http://[::1', "Failed to parse URL 'http://[::1': Invalid IPv6 URL"),
        (123, "Failed to parse URL '123': 'int' object has no attribute 'decode'"),
    ])
    def test_a_url_that_cannot_be_parsed_is_unknown_and_logged(self, url, message):
        with patch.object(h.logger, 'warning') as warning:
            assert h.extract_source_from_url(url) == 'unknown'
        warning.assert_called_once_with(message)


# ============================================
# POST /scrapers/manual/parse
# ============================================


PARSE_BODY = {'source_url': 'https://g2.com/review/example', 'raw_text': 'Great product! 5 stars.'}


class TestStartParse:
    @pytest.fixture(autouse=True)
    def _configured(self) -> Iterator[None]:
        with patch.object(h, 'MANUAL_IMPORT_PROCESSOR_FUNCTION', PROCESSOR), \
                patch.object(h, 'aggregates_table') as table, \
                patch.object(h, 'invoke_lambda_async') as invoke:
            self.table: MagicMock = table
            self.invoke: MagicMock = invoke
            yield

    def test_no_table_is_a_configuration_error_naming_the_variable(self, api_gateway_event, lambda_context):
        with patch.object(h, 'aggregates_table', None):
            response, body = _parse(api_gateway_event, lambda_context, PARSE_BODY)
        assert response['statusCode'] == 500
        assert body == {'success': False, 'error': 'AGGREGATES_TABLE not configured'}

    def test_no_processor_function_is_a_configuration_error_naming_the_variable(self, api_gateway_event, lambda_context):
        with patch.object(h, 'MANUAL_IMPORT_PROCESSOR_FUNCTION', ''):
            response, body = _parse(api_gateway_event, lambda_context, PARSE_BODY)
        assert response['statusCode'] == 500
        assert body == {'success': False, 'error': 'MANUAL_IMPORT_PROCESSOR_FUNCTION not configured'}
        self.table.put_item.assert_not_called()

    @pytest.mark.parametrize(('body', 'message'), [
        ({'raw_text': 'x'}, 'Source URL is required'),
        ({'source_url': '   ', 'raw_text': 'x'}, 'Source URL is required'),
        ({'source_url': 'https://g2.com/x'}, 'Raw text is required'),
        ({'source_url': 'https://g2.com/x', 'raw_text': '  \n '}, 'Raw text is required'),
        ({'source_url': 'https://g2.com/x', 'raw_text': 'x' * 10001}, 'Text exceeds maximum of 10000 characters'),
    ])
    def test_every_refusal_is_a_400_with_the_exact_message(self, api_gateway_event, lambda_context, body, message):
        response, decoded = _parse(api_gateway_event, lambda_context, body)
        assert response['statusCode'] == 400
        assert decoded == {'success': False, 'error': message}
        self.table.put_item.assert_not_called()
        self.invoke.assert_not_called()

    def test_exactly_the_maximum_length_is_accepted(self, api_gateway_event, lambda_context):
        response, body = _parse(api_gateway_event, lambda_context,
                                {'source_url': 'https://g2.com/x', 'raw_text': 'x' * 10000})
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert self.table.put_item.call_args.kwargs['Item']['raw_text'] == 'x' * 10000

    @pytest.mark.usefixtures('frozen')
    def test_the_job_row_is_written_then_the_processor_invoked(self, api_gateway_event, lambda_context):
        response, body = _parse(api_gateway_event, lambda_context, PARSE_BODY)
        assert response['statusCode'] == 200
        assert body == {'success': True, 'job_id': FIXED_UUID, 'source_origin': 'g2'}
        self.table.put_item.assert_called_once_with(Item={
            'pk': f'MANUAL_IMPORT#{FIXED_UUID}',
            'sk': 'JOB',
            'status': 'processing',
            'source_url': 'https://g2.com/review/example',
            'source_origin': 'g2',
            'raw_text': 'Great product! 5 stars.',
            'reviews': [],
            'unparsed_sections': [],
            'error': None,
            'created_at': NOW_ISO,
            'ttl': EPOCH + 3600,
        })
        self.invoke.assert_called_once_with(PROCESSOR, {'job_id': FIXED_UUID})
        self.table.update_item.assert_not_called()

    @pytest.mark.usefixtures('frozen')
    def test_a_processor_that_cannot_be_invoked_marks_the_job_failed_and_answers_500(
        self, api_gateway_event, lambda_context,
    ):
        self.invoke.side_effect = RuntimeError('Lambda invoke failed')
        with patch.object(h.logger, 'exception') as log:
            response, body = _parse(api_gateway_event, lambda_context, PARSE_BODY)
        assert response['statusCode'] == 500
        assert body == {'success': False, 'error': 'Failed to start processing'}
        self.table.update_item.assert_called_once_with(
            Key={'pk': f'MANUAL_IMPORT#{FIXED_UUID}', 'sk': 'JOB'},
            UpdateExpression='SET #status = :status, #error = :error',
            ExpressionAttributeNames={'#status': 'status', '#error': 'error'},
            ExpressionAttributeValues={':status': 'failed', ':error': 'Lambda invoke failed'},
        )
        assert log.call_args_list[0].args == ('Failed to invoke processor: Lambda invoke failed',)


# ============================================
# GET /scrapers/manual/parse/<job_id>
# ============================================


class TestGetParseStatus:
    def test_the_job_is_read_under_its_manual_import_key(self, api_gateway_event, lambda_context):
        with patch.object(h, 'aggregates_table') as table:
            table.get_item.return_value = {'Item': {'status': 'processing'}}
            _status(api_gateway_event, lambda_context)
        table.get_item.assert_called_once_with(Key=JOB_KEY)

    def test_a_missing_job_is_a_404_naming_the_job(self, api_gateway_event, lambda_context):
        with patch.object(h, 'aggregates_table') as table:
            table.get_item.return_value = {}
            response, body = _status(api_gateway_event, lambda_context, 'nonexistent-job')
        assert response['statusCode'] == 404
        assert body == {'success': False, 'error': 'Job nonexistent-job not found'}

    @pytest.mark.parametrize(('item', 'view'), [
        ({'status': 'processing', 'source_origin': 'g2', 'source_url': 'https://g2.com/x'},
         {'status': 'processing', 'source_origin': 'g2', 'source_url': 'https://g2.com/x'}),
        ({'pk': 'MANUAL_IMPORT#job-123'},
         {'status': 'unknown', 'source_origin': None, 'source_url': None}),
        ({'status': 'completed'},
         {'status': 'completed', 'source_origin': None, 'source_url': None, 'reviews': [], 'unparsed_sections': []}),
        ({'status': 'completed', 'reviews': [{'text': 'A'}], 'unparsed_sections': ['junk'], 'error': 'ignored'},
         {'status': 'completed', 'source_origin': None, 'source_url': None,
          'reviews': [{'text': 'A'}], 'unparsed_sections': ['junk']}),
        ({'status': 'failed'},
         {'status': 'failed', 'source_origin': None, 'source_url': None, 'error': 'Unknown error'}),
        ({'status': 'failed', 'error': 'LLM parsing failed', 'reviews': [{'text': 'hidden'}]},
         {'status': 'failed', 'source_origin': None, 'source_url': None, 'error': 'LLM parsing failed'}),
    ])
    def test_the_view_shows_exactly_what_the_status_allows(self, api_gateway_event, lambda_context, item, view):
        with patch.object(h, 'aggregates_table') as table:
            table.get_item.return_value = {'Item': item}
            response, body = _status(api_gateway_event, lambda_context)
        assert response['statusCode'] == 200
        assert body == view

    def test_a_table_failure_is_a_500_with_a_fixed_message_and_the_cause_logged(self, api_gateway_event, lambda_context):
        with patch.object(h, 'aggregates_table') as table, patch.object(h.logger, 'exception') as log:
            table.get_item.side_effect = RuntimeError('DynamoDB error')
            response, body = _status(api_gateway_event, lambda_context)
        assert response['statusCode'] == 500
        assert body == {'success': False, 'error': 'Failed to retrieve job status'}
        assert log.call_args_list[0].args == ('Failed to get job status: DynamoDB error',)

    def test_no_table_is_a_500_naming_the_table(self, api_gateway_event, lambda_context):
        with patch.object(h, 'aggregates_table', None):
            response, body = _status(api_gateway_event, lambda_context)
        assert response['statusCode'] == 500
        assert body == {'success': False, 'error': 'Table not configured'}

    def test_require_job_itself_refuses_without_a_table(self):
        with patch.object(h, 'aggregates_table', None), pytest.raises(ConfigurationError) as exc:
            h._require_job(JOB_ID, 'unused')
        assert str(exc.value) == 'Table not configured'

    def test_require_job_raises_the_given_not_found_message(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {}}
        with patch.object(h, 'aggregates_table', table), pytest.raises(NotFoundError) as exc:
            h._require_job(JOB_ID, 'Nope')
        assert str(exc.value) == 'Nope'


# ============================================
# POST /scrapers/manual/confirm
# ============================================


class TestConfirmRefusals:
    @pytest.mark.parametrize(('body', 'message'), [
        ({'reviews': [{'text': 'x', 'date': '2026-01-01'}]}, 'Job ID is required'),
        ({'job_id': '', 'reviews': [{'text': 'x', 'date': '2026-01-01'}]}, 'Job ID is required'),
        ({'job_id': JOB_ID}, 'No reviews to import'),
        ({'job_id': JOB_ID, 'reviews': []}, 'No reviews to import'),
        ({'job_id': JOB_ID, 'reviews': [{'text': 'a', 'date': '2026-01-01'}, {'text': 'b'}]},
         'Review 2 is missing a date. All reviews must have a date.'),
        ({'job_id': JOB_ID, 'reviews': [{'text': 'a', 'date': ''}, {'text': 'b', 'date': '2026-01-01'}, {'text': 'c'}]},
         'Reviews 1, 3 are missing dates. All reviews must have a date.'),
    ])
    def test_every_refusal_is_a_400_with_the_exact_message(self, api_gateway_event, lambda_context, body, message):
        with patch.object(h, 'aggregates_table') as table:
            response, decoded = _confirm(api_gateway_event, lambda_context, body)
        assert response['statusCode'] == 400
        assert decoded == {'success': False, 'error': message}
        table.get_item.assert_not_called()

    def test_all_dated_reviews_pass_the_date_check(self):
        assert h._validate_review_dates([{'date': '2026-01-01'}, {'date': '2026-01-02'}]) is None

    def test_no_table_is_a_500_naming_the_table(self, api_gateway_event, lambda_context):
        with patch.object(h, 'aggregates_table', None):
            response, body = _confirm(api_gateway_event, lambda_context,
                                      {'job_id': JOB_ID, 'reviews': [{'text': 'x', 'date': '2026-01-01'}]})
        assert response['statusCode'] == 500
        assert body == {'success': False, 'error': 'Table not configured'}

    def test_a_missing_job_is_a_404(self, api_gateway_event, lambda_context):
        with patch.object(h, 'aggregates_table') as table:
            table.get_item.return_value = {}
            response, body = _confirm(api_gateway_event, lambda_context,
                                      {'job_id': 'nonexistent-job', 'reviews': [{'text': 'x', 'date': '2026-01-01'}]})
        assert response['statusCode'] == 404
        assert body == {'success': False, 'error': 'Job not found'}
        table.get_item.assert_called_once_with(Key={'pk': 'MANUAL_IMPORT#nonexistent-job', 'sk': 'JOB'})

    def test_an_unexpected_failure_is_a_500_with_a_fixed_message_and_the_cause_logged(
        self, api_gateway_event, lambda_context,
    ):
        with patch.object(h, 'aggregates_table') as table, patch.object(h.logger, 'exception') as log:
            table.get_item.side_effect = RuntimeError('Unexpected error')
            response, body = _confirm(api_gateway_event, lambda_context,
                                      {'job_id': JOB_ID, 'reviews': [{'text': 'x', 'date': '2026-01-01'}]})
        assert response['statusCode'] == 500
        assert body == {'success': False, 'error': 'Failed to import reviews'}
        assert log.call_args_list[0].args == ('Failed to confirm import: Unexpected error',)

    def test_import_itself_refuses_without_a_table(self):
        with patch.object(h, 'aggregates_table', None), patch.object(h, 'RAW_DATA_BUCKET', ''), \
                patch.object(h, 'PROCESSING_QUEUE_URL', ''), patch.object(h, '_caller_user_id', return_value='u'), \
                pytest.raises(ConfigurationError) as exc:
            h._import_confirmed_reviews(G2_JOB, JOB_ID, TWO_REVIEWS)
        assert str(exc.value) == 'Table not configured'


ARCHIVE_KEY = f'raw/manual_import/2026/03/07/{JOB_ID}.json'
ARCHIVE_URI = f's3://{BUCKET}/{ARCHIVE_KEY}'


def _confirmed_message(idx: int, review: dict, s3_uri: str | None, job: dict = G2_JOB) -> dict:
    return {
        'id': f'manual-{JOB_ID}-{idx}',
        'source_platform': 'manual_import',
        'source_origin': job.get('source_origin', 'unknown'),
        'source_channel': job.get('source_origin', 'unknown'),
        'source_url': job.get('source_url', ''),
        'url': job.get('source_url', ''),
        'ingestion_method': 'manual',
        'manual_import_job_id': JOB_ID,
        'text': review.get('text', ''),
        # The three optional review fields pass through as-is (None when absent).
        **{field: review.get(field) for field in ('rating', 'author', 'title')},
        'created_at': review.get('date'),
        's3_raw_uri': s3_uri,
        # No profile stored, so the manual_import source runs the allow policy.
        'pii_policy_applied': 'allow',
    }


@pytest.mark.usefixtures('frozen')
class TestConfirmImport:
    @pytest.fixture(autouse=True)
    def _wired(self) -> Iterator[None]:
        with patch.object(h, 'PROCESSING_QUEUE_URL', QUEUE_URL), patch.object(h, 'RAW_DATA_BUCKET', BUCKET), \
                patch.object(h, 'aggregates_table') as table, patch.object(h, 's3') as s3, \
                patch.object(h, 'sqs') as sqs:
            table.get_item.return_value = {'Item': G2_JOB}
            self.table: MagicMock = table
            self.s3: MagicMock = s3
            self.sqs: MagicMock = sqs
            yield

    def _sent(self) -> list[dict]:
        calls = self.sqs.send_message.call_args_list
        assert all(c.kwargs['QueueUrl'] == QUEUE_URL for c in calls)
        return [json.loads(c.kwargs['MessageBody']) for c in calls]

    def test_the_whole_job_is_archived_as_confirmed(self, api_gateway_event, lambda_context):
        response, body = _confirm(api_gateway_event, lambda_context, {'job_id': JOB_ID, 'reviews': TWO_REVIEWS})
        assert response['statusCode'] == 200
        assert body == {'success': True, 'imported_count': 2, 's3_uri': ARCHIVE_URI}
        self.s3.put_object.assert_called_once_with(
            Bucket=BUCKET,
            Key=ARCHIVE_KEY,
            Body=json.dumps({
                'job_id': JOB_ID,
                'source_url': 'https://g2.com/review/example',
                'source_origin': 'g2',
                'raw_text': 'Original raw text',
                'llm_response': {'reviews': [{'text': 'Great!', 'rating': 5}]},
                'final_reviews': TWO_REVIEWS,
                'imported_at': NOW_ISO,
                'imported_by': 'test-user-id',
            }),
            ContentType='application/json',
        )

    def test_one_queue_message_per_review_numbered_from_zero(self, api_gateway_event, lambda_context):
        _confirm(api_gateway_event, lambda_context, {'job_id': JOB_ID, 'reviews': TWO_REVIEWS})
        assert self._sent() == [
            _confirmed_message(0, TWO_REVIEWS[0], ARCHIVE_URI),
            _confirmed_message(1, TWO_REVIEWS[1], ARCHIVE_URI),
        ]

    def test_the_job_is_marked_imported_with_the_count_and_time(self, api_gateway_event, lambda_context):
        _confirm(api_gateway_event, lambda_context, {'job_id': JOB_ID, 'reviews': TWO_REVIEWS})
        self.table.update_item.assert_called_once_with(
            Key=JOB_KEY,
            UpdateExpression='SET #status = :status, imported_count = :count, imported_at = :at',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':status': 'imported', ':count': 2, ':at': NOW_ISO},
        )

    def test_a_job_record_missing_its_fields_falls_back_to_empty_and_unknown(self, api_gateway_event, lambda_context):
        self.table.get_item.return_value = {'Item': {'pk': 'MANUAL_IMPORT#job-123'}}
        review = {'date': '2026-01-10'}
        _confirm(api_gateway_event, lambda_context, {'job_id': JOB_ID, 'reviews': [review]})
        archived = json.loads(self.s3.put_object.call_args.kwargs['Body'])
        assert archived == {
            'job_id': JOB_ID, 'source_url': '', 'source_origin': 'unknown', 'raw_text': '',
            'llm_response': {'reviews': []}, 'final_reviews': [review],
            'imported_at': NOW_ISO, 'imported_by': 'test-user-id',
        }
        assert self._sent() == [_confirmed_message(0, review, ARCHIVE_URI, job={})]
        assert self._sent()[0]['text'] == ''

    def test_without_a_bucket_nothing_is_archived_and_the_messages_carry_no_uri(self, api_gateway_event, lambda_context):
        with patch.object(h, 'RAW_DATA_BUCKET', ''):
            _response, body = _confirm(api_gateway_event, lambda_context, {'job_id': JOB_ID, 'reviews': TWO_REVIEWS})
        self.s3.put_object.assert_not_called()
        assert body == {'success': True, 'imported_count': 2, 's3_uri': None}
        assert [m['s3_raw_uri'] for m in self._sent()] == [None, None]

    def test_without_a_queue_every_review_still_counts_as_imported(self, api_gateway_event, lambda_context):
        with patch.object(h, 'PROCESSING_QUEUE_URL', ''):
            _response, body = _confirm(api_gateway_event, lambda_context, {'job_id': JOB_ID, 'reviews': TWO_REVIEWS})
        self.sqs.send_message.assert_not_called()
        assert body == {'success': True, 'imported_count': 2, 's3_uri': ARCHIVE_URI}
        assert self.table.update_item.call_args.kwargs['ExpressionAttributeValues'][':count'] == 2

    def test_an_archive_failure_is_logged_and_the_import_goes_on_without_a_uri(self, api_gateway_event, lambda_context):
        self.s3.put_object.side_effect = _s3_error()
        with patch.object(h.logger, 'warning') as warning:
            _response, body = _confirm(api_gateway_event, lambda_context, {'job_id': JOB_ID, 'reviews': TWO_REVIEWS})
        assert body == {'success': True, 'imported_count': 2, 's3_uri': None}
        warning.assert_called_once_with(f'Failed to store to S3: {S3_ERROR_TEXT}')
        assert [m['s3_raw_uri'] for m in self._sent()] == [None, None]

    def test_a_review_the_queue_refuses_is_named_by_index_and_not_counted(self, api_gateway_event, lambda_context):
        sqs_text = 'An error occurred (InternalFailure) when calling the SendMessage operation: SQS error'
        self.sqs.send_message.side_effect = [None, aws_error('SQS error', 'SendMessage')]
        with patch.object(h.logger, 'warning') as warning:
            _response, body = _confirm(api_gateway_event, lambda_context, {'job_id': JOB_ID, 'reviews': TWO_REVIEWS})
        assert body == {'success': True, 'imported_count': 1, 's3_uri': ARCHIVE_URI, 'errors': [f'Review 1: {sqs_text}']}
        warning.assert_called_once_with(f'Failed to send review 1 to SQS: {sqs_text}')
        assert self.table.update_item.call_args.kwargs['ExpressionAttributeValues'][':count'] == 1


# ============================================
# CSV row identity
# ============================================


class TestCsvRowIdentity:
    def test_an_id_less_row_is_keyed_by_its_position(self):
        items, _ = h._parse_csv_to_items('text\nrow one\nrow two\n', 's')
        assert [i['id'] for i in items] == ['9e18b60afd07e2b404ed7a196dcb0f36', '941b2124227c2621e0159b9f35953c92']

    def test_non_ascii_text_is_fingerprinted_as_written_not_escaped(self):
        items, _ = h._parse_csv_to_items('id,text\n7,café\n', 's')
        assert items[0]['id'] == '564948e0583a020d3e2442aa914161ec'

    def test_the_fingerprint_is_the_first_32_hex_digits(self):
        assert len(h._csv_row_id(dict.fromkeys(h.CSV_ROW_ID_FIELDS, ''))) == 32


# ============================================
# Batched queue sends
# ============================================


class TestSendItemsToSqs:
    @pytest.fixture(autouse=True)
    def _queue(self) -> Iterator[None]:
        with patch.object(h, 'PROCESSING_QUEUE_URL', QUEUE_URL):
            yield

    def test_each_batch_entry_is_numbered_from_zero_within_its_batch(self):
        sqs = _batch_sqs()
        messages = [{'id': str(i)} for i in range(12)]
        with patch.object(h, 'sqs', sqs):
            assert h._send_items_to_sqs(messages) == (12, [])
        assert sqs.send_message_batch.call_args_list[0].kwargs == {
            'QueueUrl': QUEUE_URL,
            'Entries': [{'Id': str(i), 'MessageBody': json.dumps({'id': str(i)})} for i in range(10)],
        }
        assert sqs.send_message_batch.call_args_list[1].kwargs == {
            'QueueUrl': QUEUE_URL,
            'Entries': [{'Id': '0', 'MessageBody': json.dumps({'id': '10'})},
                        {'Id': '1', 'MessageBody': json.dumps({'id': '11'})}],
        }

    def test_a_failed_entry_is_reported_under_its_row_in_the_whole_upload(self):
        def second_batch_third_fails(Entries, **_kwargs):
            if json.loads(Entries[0]['MessageBody'])['id'] == '0':
                return _batch_ok(Entries)
            return {'Successful': [{'Id': e['Id']} for e in Entries if e['Id'] != '3'],
                    'Failed': [{'Id': '3', 'Message': 'boom'}]}
        sqs = MagicMock()
        sqs.send_message_batch.side_effect = second_batch_third_fails
        with patch.object(h, 'sqs', sqs):
            assert h._send_items_to_sqs([{'id': str(i)} for i in range(15)]) == (14, ['row 13: boom'])

    def test_a_failed_entry_without_id_or_message_is_reported_at_the_batch_start(self):
        sqs = MagicMock()
        sqs.send_message_batch.side_effect = [
            _batch_ok([{'Id': str(i)} for i in range(10)]),
            {'Successful': [], 'Failed': [{}]},
        ]
        with patch.object(h, 'sqs', sqs):
            assert h._send_items_to_sqs([{'id': str(i)} for i in range(11)]) == (10, ['row 10: send failed'])

    def test_the_label_names_the_kind_of_thing_that_failed(self):
        sqs = MagicMock()
        sqs.send_message_batch.return_value = {'Successful': [], 'Failed': [{'Id': '0', 'Message': 'boom'}]}
        with patch.object(h, 'sqs', sqs):
            assert h._send_items_to_sqs([{'id': '1'}], label='item') == (0, ['item 0: boom'])

    def test_a_batch_the_queue_rejects_is_reported_as_a_row_range_and_logged(self):
        text = 'An error occurred (InternalFailure) when calling the SendMessageBatch operation: sqs down'
        sqs = MagicMock()
        sqs.send_message_batch.side_effect = [
            _batch_ok([{'Id': str(i)} for i in range(10)]), aws_error('sqs down', 'SendMessageBatch'),
        ]
        with patch.object(h, 'sqs', sqs), patch.object(h.logger, 'warning') as warning:
            assert h._send_items_to_sqs([{'id': str(i)} for i in range(12)]) == (10, [f'rows 10-11: {text}'])
        warning.assert_called_once_with(f'Failed to send SQS batch at row 10: {text}')


# The batch answer for a two-message send whose first message failed.
ONE_OF_TWO_FAILED = {'Successful': [{'Id': '1'}], 'Failed': [{'Id': '0', 'Message': 'boom'}]}


@contextmanager
def _upload_clients() -> Iterator[tuple[MagicMock, MagicMock]]:
    """The upload routes wired to a queue and a bucket: the patched `s3` and batch-answering `sqs`."""
    with patch.object(h, 'PROCESSING_QUEUE_URL', QUEUE_URL), patch.object(h, 'RAW_DATA_BUCKET', BUCKET), \
            patch.object(h, 's3') as s3, patch.object(h, 'sqs', _batch_sqs()) as sqs:
        yield s3, sqs


# ============================================
# CSV parsing
# ============================================


class TestCsvColumns:
    @pytest.mark.parametrize(('header', 'field', 'value'), [
        ('text', 'text', 'hello'), ('review', 'text', 'hello'), ('comment', 'text', 'hello'), ('feedback', 'text', 'hello'),
        ('id', 'csv_row_id', '4711'), ('review_id', 'csv_row_id', '4711'),
        ('rating', 'rating', 4), ('stars', 'rating', 4), ('score', 'rating', 4),
        ('date', 'timestamp', '2026-01-01'), ('timestamp', 'timestamp', '2026-01-01'),
        ('created_at', 'timestamp', '2026-01-01'),
        ('author', 'author', 'alice'), ('user', 'author', 'alice'), ('user_id', 'author', 'alice'),
        ('name', 'author', 'alice'),
        ('title', 'title', 'Subject line'), ('subject', 'title', 'Subject line'),
        ('url', 'url', 'https://x.example'), ('link', 'url', 'https://x.example'),
        ('source', 'source', 'alpha'), ('source_channel', 'source', 'alpha'),
    ])
    def test_every_header_synonym_feeds_its_field(self, header, field, value):
        text_column = '' if field == 'text' else 'text,'
        text_value = '' if field == 'text' else 'hello,'
        items, warnings = h._parse_csv_to_items(f'{text_column}{header}\n{text_value}{value}\n', 'dflt')
        assert warnings == []
        assert items[0][field] == value

    def test_the_first_non_blank_synonym_wins_in_declared_order(self):
        items, _ = h._parse_csv_to_items('review,text\nfrom review,from text\n', 's')
        assert items[0]['text'] == 'from text'
        items, _ = h._parse_csv_to_items('text,review\n"  ",from review\n', 's')
        assert items[0]['text'] == 'from review'

    def test_a_short_row_leaves_its_missing_columns_blank(self):
        items, warnings = h._parse_csv_to_items('text,rating,author\nhello\n', 's')
        assert warnings == []
        assert (items[0]['rating'], items[0]['author']) == (None, '')

    def test_headers_are_trimmed_and_blank_headers_ignored(self):
        items, warnings = h._parse_csv_to_items(' Text ,,Rating\n  padded  ,x,3\n', 's')
        assert warnings == []
        assert (items[0]['text'], items[0]['rating']) == ('padded', 3)

    def test_the_item_carries_exactly_these_fields(self):
        items, warnings = h._parse_csv_to_items(
            'id,text,rating,date,author,title,url,source\n'
            '9,Solid,4.7,2026-02-01,Ann,Nice,https://x.example/r,shop\n', 'dflt')
        assert warnings == []
        assert items == [{
            'id': items[0]['id'],
            'csv_row_id': '9',
            'text': 'Solid',
            'rating': 4,
            'author': 'Ann',
            'title': 'Nice',
            'url': 'https://x.example/r',
            'timestamp': '2026-02-01',
            'source': 'shop',
        }]

    @pytest.mark.usefixtures('frozen')
    def test_a_row_without_a_date_is_stamped_with_now(self):
        items, _ = h._parse_csv_to_items('text\nhello\n', 's')
        assert items[0]['timestamp'] == NOW_ISO


class TestCsvRefusalsAndWarnings:
    @pytest.mark.parametrize(('csv_text', 'message'), [
        ('', 'CSV is empty or has no header row'),
        ('id,rating\n1,5\n', 'CSV must include a "text" column (also accepted: review / comment / feedback)'),
    ])
    def test_a_csv_without_a_usable_header_is_refused_with_the_exact_message(self, csv_text, message):
        with pytest.raises(ValidationError) as exc:
            h._parse_csv_to_items(csv_text, 's')
        assert str(exc.value) == message

    def test_every_warning_names_the_row_and_the_reason(self):
        long_id = 'x' * 257
        items, warnings = h._parse_csv_to_items(
            f'id,text,rating\n1,hello,five\n2,,1\n1,hello,five\n{long_id},kept,2\n', 's')
        assert [i['text'] for i in items] == ['hello', 'kept']
        assert items[1]['csv_row_id'] == ''
        assert warnings == [
            'row 1: rating "five" is not a number — left blank',
            'row 2: empty text — skipped',
            'row 3: duplicate row — skipped',
            'row 4: id exceeds 256 characters — not kept for lookup, row imported',
        ]


class _WiredUploads:
    """Base for the upload-route suites: every test runs with `_upload_clients` and keeps the
    patched clients on ``self.s3`` / ``self.sqs``."""

    @pytest.fixture(autouse=True)
    def _wired(self) -> Iterator[None]:
        with _upload_clients() as (s3, sqs):
            self.s3: MagicMock = s3
            self.sqs: MagicMock = sqs
            yield


class TestCsvUpload(_WiredUploads):
    def _sent(self) -> list[dict]:
        return [json.loads(e['MessageBody'])
                for c in self.sqs.send_message_batch.call_args_list for e in c.kwargs['Entries']]

    @pytest.mark.parametrize(('body', 'message'), [
        ({'csv_text': 123}, 'csv_text is required'),
        ({'csv_text': '   \n'}, 'csv_text is required'),
        ({'csv_text': 'text,rating\n,1\n,2\n,3\n,4\n,5\n,6\n'},
         'CSV produced no valid rows. row 1: empty text — skipped; row 2: empty text — skipped; '
         'row 3: empty text — skipped; row 4: empty text — skipped; row 5: empty text — skipped'),
        ({'csv_text': 'text\n\n'}, 'CSV produced no valid rows. '),
    ])
    def test_every_refusal_is_a_400_with_the_exact_message(self, api_gateway_event, lambda_context, body, message):
        response, decoded = _csv(api_gateway_event, lambda_context, body)
        assert response['statusCode'] == 400
        assert decoded == {'success': False, 'error': message}
        self.sqs.send_message_batch.assert_not_called()

    def test_a_null_body_is_the_missing_csv_text_refusal(self, api_gateway_event, lambda_context):
        event = api_gateway_event(method='POST', path='/scrapers/manual/csv-upload')
        event['body'] = 'null'
        response = h.lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400
        assert json.loads(response['body']) == {'success': False, 'error': 'csv_text is required'}

    def test_exactly_ten_mebibytes_are_accepted_and_one_more_byte_is_not(self, api_gateway_event, lambda_context):
        # 104 rows of 100 000 bytes and one of 85 755 (the csv module caps a field at 131 072).
        at_bound = 'text\n' + ('x' * 99999 + '\n') * 104 + 'x' * 85754 + '\n'
        assert len(at_bound.encode('utf-8')) == 10485760
        response, body = _csv(api_gateway_event, lambda_context, {'csv_text': at_bound})
        assert response['statusCode'] == 200
        assert body['total_rows'] == 105
        response, body = _csv(api_gateway_event, lambda_context, {'csv_text': at_bound + 'x'})
        assert response['statusCode'] == 400
        assert body == {'success': False, 'error': 'CSV exceeds 10 MB limit'}

    def test_the_row_cap_is_inclusive_and_the_refusal_says_how_to_recover(self, api_gateway_event, lambda_context):
        with patch.object(h, 'MAX_JSON_UPLOAD_ITEMS', 2):
            response, body = _csv(api_gateway_event, lambda_context, {'csv_text': 'text\na\nb\n'})
            assert response['statusCode'] == 200
            assert body['total_rows'] == 2
            response, body = _csv(api_gateway_event, lambda_context, {'csv_text': 'text\na\nb\nc\n'})
        assert response['statusCode'] == 400
        assert body == {'success': False,
                        'error': 'Maximum 2 rows per upload (got 3). Split the file and try again.'}

    @pytest.mark.parametrize(('body', 'default_source', 'source'), [
        ({'csv_text': 'text\nhello\n'}, 'csv_upload', 'csv_upload'),
        ({'csv_text': 'text\nhello\n', 'default_source': '   '}, 'csv_upload', 'csv_upload'),
        ({'csv_text': 'text\nhello\n', 'default_source': '  store_reviews '}, 'store_reviews', 'store_reviews'),
        ({'csv_text': 'text,source\nhello,in_file\n', 'default_source': 'store_reviews'}, 'store_reviews', 'in_file'),
    ])
    def test_the_default_source_is_trimmed_and_falls_back_to_csv_upload(
        self, api_gateway_event, lambda_context, body, default_source, source,
    ):
        _csv(api_gateway_event, lambda_context, body)
        assert self._sent()[0]['source_channel'] == source
        assert self.s3.put_object.call_args.kwargs['Metadata']['default_source'] == default_source

    @pytest.mark.usefixtures('frozen')
    def test_the_original_csv_is_archived_under_the_upload_key(self, api_gateway_event, lambda_context):
        csv_text = 'id,text,rating,date,author,title,url\n7,Solid,5,2026-02-01,Ann,Nice,https://x.example/r\n'
        response, body = _csv(api_gateway_event, lambda_context, {'csv_text': csv_text, 'default_source': 'shop'})
        assert response['statusCode'] == 200
        key = f'raw/csv_upload/2026/03/07/{FIXED_UUID}.csv'
        self.s3.put_object.assert_called_once_with(
            Bucket=BUCKET,
            Key=key,
            Body=csv_text.encode('utf-8'),
            ContentType='text/csv; charset=utf-8',
            Metadata={'uploaded_by': 'test-user-id', 'default_source': 'shop', 'source_id': 'manual_import'},
        )
        assert body == {'success': True, 'imported_count': 1, 'total_rows': 1, 's3_uri': f's3://{BUCKET}/{key}'}
        assert self._sent() == [{
            'id': self._sent()[0]['id'],
            'csv_row_id': '7',
            'source_platform': 'manual_import',
            'source_channel': 'shop',
            'ingestion_method': 'csv_upload',
            'text': 'Solid',
            'rating': 5,
            'author': 'Ann',
            'title': 'Nice',
            'url': 'https://x.example/r',
            'created_at': '2026-02-01',
            's3_raw_uri': f's3://{BUCKET}/{key}',
            'pii_policy_applied': 'allow',
        }]

    def test_an_archive_failure_is_logged_and_the_rows_still_go_through_without_a_uri(
        self, api_gateway_event, lambda_context,
    ):
        self.s3.put_object.side_effect = _s3_error()
        with patch.object(h.logger, 'warning') as warning:
            response, body = _csv(api_gateway_event, lambda_context, {'csv_text': 'text\nhello\n'})
        assert response['statusCode'] == 200
        assert body == {'success': True, 'imported_count': 1, 'total_rows': 1, 's3_uri': None}
        warning.assert_called_once_with(f'Failed to store CSV upload to S3: {S3_ERROR_TEXT}')
        assert self._sent()[0]['s3_raw_uri'] is None

    def test_without_a_bucket_nothing_is_archived(self, api_gateway_event, lambda_context):
        with patch.object(h, 'RAW_DATA_BUCKET', ''):
            _response, body = _csv(api_gateway_event, lambda_context, {'csv_text': 'text\nhello\n'})
        self.s3.put_object.assert_not_called()
        assert body['s3_uri'] is None

    def test_at_most_twenty_warnings_are_returned(self, api_gateway_event, lambda_context):
        blanks = ''.join(f',{i}\n' for i in range(21))
        _response, body = _csv(api_gateway_event, lambda_context, {'csv_text': f'text,rating\n{blanks}ok,5\n'})
        assert body['imported_count'] == 1
        assert body['total_rows'] == 1
        assert len(body['warnings']) == 20
        assert body['warnings'][0] == 'row 1: empty text — skipped'
        assert body['warnings'][19] == 'row 20: empty text — skipped'

    def test_send_errors_are_returned_beside_the_count(self, api_gateway_event, lambda_context):
        self.sqs.send_message_batch.side_effect = None
        self.sqs.send_message_batch.return_value = ONE_OF_TWO_FAILED
        with patch.object(h, 'RAW_DATA_BUCKET', ''):
            _response, body = _csv(api_gateway_event, lambda_context, {'csv_text': 'text\na\nb\n'})
        assert body == {'success': True, 'imported_count': 1, 'total_rows': 2, 's3_uri': None,
                        'errors': ['row 0: boom']}


# ============================================
# JSON upload
# ============================================


VALID_ITEM = {'id': 'r1', 'text': 'Great', 'source': 'app_store', 'timestamp': '2026-01-01T00:00:00Z'}


class TestJsonUploadRefusals:
    @pytest.mark.parametrize(('items', 'message'), [
        ('not-a-list', 'Request must contain a non-empty "items" array'),
        ([], 'Request must contain a non-empty "items" array'),
        (['string-item'], 'Validation failed: Item 0: must be an object'),
        ([{'text': '', 'id': '', 'source': '', 'timestamp': ''}],
         'Validation failed: Item 0: "text" is required and must be a non-empty string; '
         'Item 0: "id" is required for deduplication; Item 0: "source" is required; '
         'Item 0: "timestamp" is required (ISO 8601 format)'),
        ([{**VALID_ITEM, 'text': 7}],
         'Validation failed: Item 0: "text" is required and must be a non-empty string'),
        ([{'id': 'r1', 'source': 's', 'timestamp': 't'}],
         'Validation failed: Item 0: "text" is required and must be a non-empty string'),
        ([{**VALID_ITEM, 'text': '   '}],
         'Validation failed: Item 0: "text" is required and must be a non-empty string'),
        ([VALID_ITEM, {'text': 'x', 'id': 'r2', 'source': 's'}],
         'Validation failed: Item 1: "timestamp" is required (ISO 8601 format)'),
        ([{'text': 'x', 'id': 'r2', 'timestamp': 't', 'source_channel': ''}],
         'Validation failed: Item 0: "source" is required'),
    ])
    def test_every_refusal_is_a_400_with_the_exact_message(self, api_gateway_event, lambda_context, items, message):
        with patch.object(h, 'sqs') as sqs:
            response, body = _json_upload(api_gateway_event, lambda_context, items)
        assert response['statusCode'] == 400
        assert body == {'success': False, 'error': message}
        sqs.send_message_batch.assert_not_called()

    def test_only_the_first_ten_item_errors_are_quoted(self, api_gateway_event, lambda_context):
        response, body = _json_upload(api_gateway_event, lambda_context, ['bad'] * 11)
        assert response['statusCode'] == 400
        assert body['error'] == 'Validation failed: ' + '; '.join(f'Item {i}: must be an object' for i in range(10))

    def test_the_item_cap_is_inclusive_and_the_refusal_names_it(self, api_gateway_event, lambda_context):
        with patch.object(h, 'MAX_JSON_UPLOAD_ITEMS', 2), patch.object(h, 'RAW_DATA_BUCKET', ''), \
                patch.object(h, 'PROCESSING_QUEUE_URL', ''):
            response, body = _json_upload(api_gateway_event, lambda_context, [VALID_ITEM, VALID_ITEM])
            assert response['statusCode'] == 200
            assert body['total_items'] == 2
            response, body = _json_upload(api_gateway_event, lambda_context, [VALID_ITEM] * 3)
        assert response['statusCode'] == 400
        assert body == {'success': False, 'error': 'Maximum 2 items per upload'}

    def test_source_channel_and_created_at_satisfy_the_required_fields(self):
        assert h._json_upload_item_errors([{'id': 'r', 'text': 'x', 'source_channel': 'web', 'created_at': 't'}]) == []


class TestJsonUploadMessage:
    def test_the_message_carries_exactly_these_fields(self):
        item = {'id': 'r1', 'text': '  Great  ', 'source': 'app_store', 'source_channel': 'ignored',
                'timestamp': '2026-01-01', 'created_at': 'ignored', 'rating': 5, 'user_id': 'u1',
                'author': 'ignored', 'title': 'T', 'url': 'https://x.example'}
        assert h._json_upload_message(item, 's3://b/k') == {
            'id': 'r1',
            'source_platform': 'manual_import',
            'source_channel': 'app_store',
            'ingestion_method': 'json_upload',
            'text': 'Great',
            'rating': 5,
            'author': 'u1',
            'title': 'T',
            'url': 'https://x.example',
            'created_at': '2026-01-01',
            's3_raw_uri': 's3://b/k',
        }

    def test_the_fallback_names_are_used_when_the_primary_ones_are_absent(self):
        message = h._json_upload_message(
            {'text': 'x', 'source_channel': 'web', 'created_at': '2026-01-02', 'author': 'bob'}, None)
        assert (message['id'], message['source_channel'], message['created_at'], message['author'],
                message['s3_raw_uri']) == ('', 'web', '2026-01-02', 'bob', None)

    def test_a_missing_text_becomes_an_empty_string(self):
        assert h._json_upload_message({'id': 'r'}, None)['text'] == ''

    @pytest.mark.parametrize(('metadata', 'passed'), [
        ({'custom_field': 'value'}, True),
        ({}, False),
        ('not-a-dict', False),
        (None, False),
    ])
    def test_metadata_passes_through_only_as_a_non_empty_mapping(self, metadata, passed):
        message = h._json_upload_message({**VALID_ITEM, 'metadata': metadata}, None)
        assert ('metadata' in message) is passed
        if passed:
            assert message['metadata'] == metadata


@pytest.mark.usefixtures('frozen')
class TestJsonUpload(_WiredUploads):
    def test_the_whole_upload_is_archived_under_the_upload_key(self, api_gateway_event, lambda_context):
        items = [VALID_ITEM, {**VALID_ITEM, 'id': 'r2'}]
        response, body = _json_upload(api_gateway_event, lambda_context, items)
        assert response['statusCode'] == 200
        key = f'raw/json_upload/2026/03/07/{FIXED_UUID}.json'
        self.s3.put_object.assert_called_once_with(
            Bucket=BUCKET,
            Key=key,
            Body=json.dumps({'job_id': FIXED_UUID, 'items': items, 'uploaded_at': NOW_ISO, 'uploaded_by': 'test-user-id'}),
            ContentType='application/json',
        )
        assert body == {'success': True, 'imported_count': 2, 'total_items': 2, 's3_uri': f's3://{BUCKET}/{key}'}
        entries = self.sqs.send_message_batch.call_args.kwargs['Entries']
        assert [json.loads(e['MessageBody'])['s3_raw_uri'] for e in entries] == [f's3://{BUCKET}/{key}'] * 2
        assert [json.loads(e['MessageBody'])['id'] for e in entries] == ['r1', 'r2']
        self.sqs.send_message.assert_not_called()  # batched, never one send per item

    def test_an_archive_failure_is_logged_and_the_items_still_go_through_without_a_uri(
        self, api_gateway_event, lambda_context,
    ):
        self.s3.put_object.side_effect = _s3_error()
        with patch.object(h.logger, 'warning') as warning:
            response, body = _json_upload(api_gateway_event, lambda_context, [VALID_ITEM])
        assert response['statusCode'] == 200
        assert body == {'success': True, 'imported_count': 1, 'total_items': 1, 's3_uri': None}
        warning.assert_called_once_with(f'Failed to store JSON upload to S3: {S3_ERROR_TEXT}')

    def test_without_a_bucket_nothing_is_archived(self, api_gateway_event, lambda_context):
        with patch.object(h, 'RAW_DATA_BUCKET', ''):
            _response, body = _json_upload(api_gateway_event, lambda_context, [VALID_ITEM])
        self.s3.put_object.assert_not_called()
        assert body['s3_uri'] is None

    def test_send_errors_are_labelled_item_and_returned_beside_the_count(self, api_gateway_event, lambda_context):
        self.sqs.send_message_batch.side_effect = None
        self.sqs.send_message_batch.return_value = ONE_OF_TWO_FAILED
        _response, body = _json_upload(api_gateway_event, lambda_context, [VALID_ITEM, {**VALID_ITEM, 'id': 'r2'}])
        assert body['imported_count'] == 1
        assert body['total_items'] == 2
        assert body['errors'] == ['item 0: boom']
