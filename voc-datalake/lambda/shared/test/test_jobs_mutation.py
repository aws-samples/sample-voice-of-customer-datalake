"""Mutation hardening for `shared/jobs.py`.

`test_jobs.py` pins the happy paths (a job is created, a claim is atomic, a
waiter requeues itself) but a mutation run left 130 survivors it cannot see:

* every DynamoDB write was checked by *membership* (`':error' in values`), so
  a mutant that renamed an expression attribute, flipped `+=` to `=` on the
  update expression, dropped `REMOVE #error, #result, completed_at` from the
  claim, or set a TTL in the PAST all passed. Every request is pinned here as
  a whole dict literal.
* every error message was checked with `pytest.raises(match=...)`, which is a
  regex *search*; `XXJob no longer existsXX` matches. Messages are compared
  with `==` here, including the log lines operators grep for (`[JOB] ...`).
* the numbers: the 5-second lease skew, the 30-second requeue floor and its
  boundary (30 requeues, 31 waits), the 1-second poll, the 200-character
  error truncation, the 30-minute default TTL and the 7-day failed/completed
  TTL, `ceil(ms / 1000)` at 1000 and 1001 ms, and that negative remaining
  time clamps to 0 rather than 1.
* the lease arithmetic in the recovery loop: `<=` vs `<` at the exact expiry
  second, a missing lease reading as epoch 0, a corrupt (string) lease
  reading as 0 rather than crashing, and that a `pending`/`failed` owner is
  reclaimed even while its stale lease is in the future.
* the decorator's config lookup: each of the six keys, that the FIRST key in
  the order wins when two are present (`break`, not `continue`), that a
  config-less event calls the body with exactly three arguments and still
  returns its result, and that `@wraps` keeps the body's name.

The run also found one dead clause: the poll interval was
`min(POLL, max(0.05, remaining - minimum_budget))`, but both operands are
whole seconds and the sleep is reached only when `remaining > minimum_budget`,
so the inner `max` was always >= 1 and the sleep always `POLL`. The clause and
`EXECUTION_LEASE_MIN_POLL_SECONDS` were deleted.
"""
from datetime import UTC, datetime
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

import pytest
from botocore.exceptions import ClientError

from shared.exceptions import (
    AuthorizationError,
    ConfigurationError,
    ConflictError,
    NotFoundError,
    ServiceError,
    ValidationError,
)
from shared.jobs import (
    CLAIM_ATTRIBUTE_NAMES,
    CLAIM_CONDITION_EXPRESSION,
    CLAIM_UPDATE_EXPRESSION,
    EXECUTION_LEASE_POLL_SECONDS,
    EXECUTION_LEASE_SKEW_SECONDS,
    EXECUTION_REQUEUE_MIN_SECONDS,
    JobContext,
    _remaining_seconds,
    claim_job_execution,
    create_job,
    job_handler,
    recover_job_execution_claim,
    update_job_status,
)

NOW = datetime(2026, 9, 3, 12, 0, tzinfo=UTC)
NOW_EPOCH = int(NOW.timestamp())
NOW_ISO = NOW.isoformat()
KEY = {'pk': 'PROJECT#p1', 'sk': 'JOB#j1'}
EVENT = {'project_id': 'p1', 'job_id': 'j1'}
TABLE_MISSING = 'JOBS_TABLE environment variable not configured'
RUNNING_FAR_FUTURE = {'Item': {'status': 'running', 'execution_lease_until': 9_999_999_999}}
COMPLETED = {'Item': {'status': 'completed'}}


def _context(*remaining_ms, request_id='request-1', **attrs):
    context = MagicMock()
    if len(remaining_ms) == 1:
        context.get_remaining_time_in_millis.return_value = remaining_ms[0]
    else:
        context.get_remaining_time_in_millis.side_effect = remaining_ms
    context.aws_request_id = request_id
    context.invoked_function_arn = 'arn:aws:lambda:us-east-1:1:function:job'
    context.function_name = 'job'
    for name, value in attrs.items():
        setattr(context, name, value)
    return context


def _three_arg_body(result: dict | None = None, raises: Exception | None = None):
    def body(_ctx, _project_id, _job_id):
        if raises is not None:
            raise raises
        return result if result is not None else {}
    body.__name__ = 'sample_job'
    return body


@pytest.fixture
def table():
    with patch('shared.jobs.get_jobs_table') as get_table:
        mock_table = MagicMock()
        get_table.return_value = mock_table
        yield mock_table


@pytest.fixture
def no_table():
    with patch('shared.jobs.get_jobs_table', return_value=None):
        yield


@pytest.fixture
def frozen_now():
    with patch('shared.jobs.datetime') as mock_datetime:
        mock_datetime.now.return_value = NOW
        yield NOW


@pytest.fixture
def mock_logger():
    with patch('shared.jobs.logger') as mock:
        yield mock


@pytest.fixture
def mock_time():
    with patch('shared.jobs.time') as mock:
        mock.time.return_value = NOW_EPOCH
        yield mock


@pytest.fixture
def mock_invoke():
    with patch('shared.jobs.invoke_lambda_async') as mock:
        yield mock


@pytest.fixture
def mock_claim():
    with patch('shared.jobs.claim_job_execution', return_value=True) as mock:
        yield mock


@pytest.fixture
def mock_update():
    with patch('shared.jobs.update_job_status') as mock:
        yield mock


class TestConstants:
    def test_lease_skew_requeue_floor_and_poll_interval(self):
        assert EXECUTION_LEASE_SKEW_SECONDS == 5
        assert EXECUTION_REQUEUE_MIN_SECONDS == 30
        assert EXECUTION_LEASE_POLL_SECONDS == 1


class TestRemainingSecondsRoundsUpWholeSeconds:
    @pytest.mark.parametrize(('remaining_ms', 'seconds'), [
        (0, 0),
        (-500, 0),
        (1, 1),
        (1000, 1),
        (1001, 2),
        (12_345, 13),
    ])
    def test_ceil_of_milliseconds_clamped_at_zero(self, remaining_ms, seconds):
        assert _remaining_seconds(_context(remaining_ms)) == seconds

    def test_context_without_remaining_time_is_refused(self):
        with pytest.raises(TypeError) as exc:
            _remaining_seconds(SimpleNamespace())
        assert str(exc.value) == 'Lambda context must expose its remaining runtime'


@pytest.mark.usefixtures('frozen_now')
class TestClaimWritesTheExactLeaseRequest:
    def test_update_item_request_is_pinned(self, table):
        assert claim_job_execution('p1', 'j1', _context(12_345)) is True

        table.update_item.assert_called_once_with(
            Key=KEY,
            UpdateExpression=CLAIM_UPDATE_EXPRESSION,
            ConditionExpression=CLAIM_CONDITION_EXPRESSION,
            ExpressionAttributeNames=CLAIM_ATTRIBUTE_NAMES,
            ExpressionAttributeValues={
                ':pending': 'pending',
                ':running': 'running',
                ':failed': 'failed',
                ':zero': 0,
                ':starting': 'starting',
                ':now': NOW_ISO,
                ':now_epoch': NOW_EPOCH,
                ':running_gsi': 'STATUS#running',
                ':lease': NOW_EPOCH + 13 + 5,
                ':owner': 'request-1',
            },
        )

    def test_the_update_expression_is_pinned_clause_by_clause(self):
        set_clauses = [
            ('#status', ':running'), ('progress', ':zero'), ('current_step', ':starting'),
            ('updated_at', ':now'), ('gsi1pk', ':running_gsi'), ('execution_lease_until', ':lease'),
            ('execution_owner', ':owner'),
        ]
        removed = ['#error', '#result', 'completed_at']
        assert (
            'SET ' + ', '.join(f'{name} = {value}' for name, value in set_clauses)
            + ' REMOVE ' + ', '.join(removed)) == CLAIM_UPDATE_EXPRESSION

    def test_the_attribute_names_are_the_three_reserved_words(self):
        assert CLAIM_ATTRIBUTE_NAMES == {'#status': 'status', '#error': 'error', '#result': 'result'}

    def test_the_condition_is_pinned_token_by_token(self):
        tokens = [
            'attribute_exists(pk)', 'AND', 'attribute_exists(sk)', 'AND',
            '(#status', '=', ':pending', 'OR', '#status', '=', ':failed', 'OR',
            '(#status', '=', ':running', 'AND',
            '(attribute_not_exists(execution_lease_until)', 'OR',
            'execution_lease_until', '<=', ':now_epoch)))',
        ]
        assert ' '.join(tokens) == CLAIM_CONDITION_EXPRESSION

    def test_lease_is_remaining_seconds_plus_five(self, table):
        claim_job_execution('p1', 'j1', _context(0))

        values = table.update_item.call_args.kwargs['ExpressionAttributeValues']
        assert values[':lease'] == NOW_EPOCH + 5

    @pytest.mark.parametrize('context', [
        _context(1000, request_id=''),
        SimpleNamespace(get_remaining_time_in_millis=lambda: 1000),
    ], ids=['empty-request-id', 'no-request-id-attribute'])
    def test_owner_without_request_id_is_unknown(self, table, context):
        claim_job_execution('p1', 'j1', context)

        values = table.update_item.call_args.kwargs['ExpressionAttributeValues']
        assert values[':owner'] == 'unknown'

    @pytest.mark.usefixtures('no_table')
    def test_missing_table_is_refused_by_name(self):
        with pytest.raises(ValueError, match=TABLE_MISSING) as exc:
            claim_job_execution('p1', 'j1', _context(1000))
        assert str(exc.value) == TABLE_MISSING


class TestRecoveryReadsAndRefusals:
    def test_reads_the_job_with_a_consistent_read(self, table):
        table.get_item.return_value = COMPLETED

        assert recover_job_execution_claim(EVENT, _context(100_000)) is False
        table.get_item.assert_called_once_with(Key=KEY, ConsistentRead=True)

    @pytest.mark.usefixtures('no_table')
    def test_missing_table_is_refused_by_name(self):
        with pytest.raises(ValueError, match=TABLE_MISSING) as exc:
            recover_job_execution_claim(EVENT, _context(100_000))
        assert str(exc.value) == TABLE_MISSING

    @pytest.mark.parametrize('response', [{}, {'Item': 'not-a-dict'}, None])
    def test_vanished_job_is_a_service_error(self, table, response):
        table.get_item.return_value = response

        with pytest.raises(ServiceError) as exc:
            recover_job_execution_claim(EVENT, _context(100_000))
        assert str(exc.value) == 'Job no longer exists'


@pytest.mark.usefixtures('mock_time')
class TestRequeueBudget:
    def test_requeue_targets_the_arn_and_logs_the_job(self, table, mock_invoke, mock_logger, mock_time):
        table.get_item.return_value = RUNNING_FAR_FUTURE
        event = {'project_id': 'p1', 'job_id': 'j1', 'config': {'x': 1}}

        assert recover_job_execution_claim(event, _context(100_000, 90_000)) is False

        mock_invoke.assert_called_once_with('arn:aws:lambda:us-east-1:1:function:job', event)
        mock_logger.info.assert_called_once_with(
            '[JOB] Requeued lease waiter for project=p1, job=j1',
        )
        mock_time.sleep.assert_not_called()

    @pytest.mark.parametrize(('remaining_ms', 'requeued'), [
        (30_000, True),
        (31_000, False),
    ])
    def test_thirty_second_floor_boundary(self, table, mock_invoke, mock_time, remaining_ms, requeued):
        # 20 s initial budget keeps ceil(20 * 0.9) = 18 below the 30 s floor.
        table.get_item.side_effect = [RUNNING_FAR_FUTURE, COMPLETED]

        assert recover_job_execution_claim(EVENT, _context(20_000, remaining_ms)) is False

        assert mock_invoke.call_count == (1 if requeued else 0)
        assert mock_time.sleep.call_args_list == ([] if requeued else [call(1)])

    @pytest.mark.parametrize(('arn', 'name', 'target'), [
        ('', 'job', 'job'),
        (None, 'job', 'job'),
        ('arn:x', '', 'arn:x'),
    ])
    def test_falls_back_to_function_name_when_arn_is_unusable(
        self, table, mock_invoke, arn, name, target,
    ):
        table.get_item.return_value = RUNNING_FAR_FUTURE
        context = _context(100_000, 90_000, invoked_function_arn=arn, function_name=name)

        assert recover_job_execution_claim(EVENT, context) is False
        mock_invoke.assert_called_once_with(target, EVENT)

    def test_function_name_fallback_reads_that_attribute(self, table, mock_invoke):
        table.get_item.return_value = RUNNING_FAR_FUTURE
        context = SimpleNamespace(
            get_remaining_time_in_millis=MagicMock(side_effect=[100_000, 90_000]),
            function_name='job',
        )

        assert recover_job_execution_claim(EVENT, context) is False
        mock_invoke.assert_called_once_with('job', EVENT)

    @pytest.mark.parametrize(('arn', 'name'), [('', ''), (None, None), (None, 7)])
    def test_context_without_any_function_identity_is_refused(self, table, mock_invoke, arn, name):
        table.get_item.return_value = RUNNING_FAR_FUTURE
        context = _context(100_000, 90_000, invoked_function_arn=arn, function_name=name)

        with pytest.raises(TypeError) as exc:
            recover_job_execution_claim(EVENT, context)
        assert str(exc.value) == 'Lambda context must identify its function'
        mock_invoke.assert_not_called()


class TestLeaseReclaimDecision:
    @pytest.mark.parametrize('status', ['pending', 'failed'])
    def test_pending_or_failed_owner_is_reclaimed_despite_a_future_lease(
        self, table, mock_time, mock_claim, status,
    ):
        table.get_item.return_value = {'Item': {'status': status, 'execution_lease_until': NOW_EPOCH + 1}}
        context = _context(100_000, 100_000)

        assert recover_job_execution_claim(EVENT, context) is True
        mock_claim.assert_called_once_with('p1', 'j1', context)
        mock_time.sleep.assert_not_called()

    @pytest.mark.usefixtures('mock_time')
    @pytest.mark.parametrize('lease', [NOW_EPOCH, NOW_EPOCH - 1, Decimal(NOW_EPOCH)])
    def test_running_owner_is_reclaimed_once_the_lease_second_has_passed(self, table, mock_claim, lease):
        table.get_item.return_value = {'Item': {'status': 'running', 'execution_lease_until': lease}}

        assert recover_job_execution_claim(EVENT, _context(100_000, 100_000)) is True
        mock_claim.assert_called_once()

    @pytest.mark.parametrize('lease', [None, 'not-a-number', True])
    def test_missing_or_corrupt_lease_reads_as_epoch_zero(self, table, mock_time, mock_claim, lease):
        mock_time.time.return_value = 0
        item = {'status': 'running'}
        if lease is not None:
            item['execution_lease_until'] = lease
        table.get_item.return_value = {'Item': item}

        assert recover_job_execution_claim(EVENT, _context(100_000, 100_000)) is True
        mock_claim.assert_called_once()

    def test_running_owner_with_a_live_lease_is_polled_every_second(self, table, mock_time, mock_claim):
        live = {'Item': {'status': 'running', 'execution_lease_until': NOW_EPOCH + 1}}
        table.get_item.side_effect = [live, live, COMPLETED]

        assert recover_job_execution_claim(EVENT, _context(100_000, 100_000, 100_000)) is False

        mock_claim.assert_not_called()
        assert mock_time.sleep.call_args_list == [call(1), call(1)]

    def test_lost_claim_race_keeps_polling(self, table, mock_time, mock_claim):
        mock_claim.return_value = False
        table.get_item.side_effect = [{'Item': {'status': 'pending'}}, COMPLETED]

        assert recover_job_execution_claim(EVENT, _context(100_000, 100_000)) is False
        mock_claim.assert_called_once()
        mock_time.sleep.assert_called_once_with(1)


@pytest.mark.usefixtures('frozen_now')
class TestCreateJobWritesTheExactItem:
    @pytest.fixture(autouse=True)
    def fixed_uuid(self):
        with patch('shared.jobs.uuid') as mock_uuid:
            mock_uuid.uuid4.return_value.hex = '0123456789abcdef0123456789abcdef'
            yield

    def test_running_job_item(self, table):
        assert create_job('p1', 'research', 'research_config', {'q': 1}) == (
            'job_0123456789abcdef', NOW_ISO,
        )

        table.put_item.assert_called_once_with(Item={
            'pk': 'PROJECT#p1',
            'sk': 'JOB#job_0123456789abcdef',
            'gsi1pk': 'STATUS#running',
            'gsi1sk': NOW_ISO,
            'job_id': 'job_0123456789abcdef',
            'project_id': 'p1',
            'job_type': 'research',
            'status': 'running',
            'progress': 0,
            'current_step': 'starting',
            'created_at': NOW_ISO,
            'updated_at': NOW_ISO,
            'ttl': NOW_EPOCH + 30 * 60,
            'research_config': {'q': 1},
        })

    @pytest.mark.parametrize(('ttl_minutes', 'offset'), [(1, 60), (120, 7200)])
    def test_ttl_is_minutes_after_now(self, table, ttl_minutes, offset):
        create_job('p1', 't', 'config', {}, ttl_minutes=ttl_minutes)

        assert table.put_item.call_args.kwargs['Item']['ttl'] == NOW_EPOCH + offset

    @pytest.mark.usefixtures('no_table')
    def test_missing_table_is_refused_by_name(self):
        with pytest.raises(ValueError, match=TABLE_MISSING) as exc:
            create_job('p1', 't', 'config', {})
        assert str(exc.value) == TABLE_MISSING


@pytest.mark.usefixtures('frozen_now')
class TestUpdateJobStatusWritesTheExactRequest:
    BASE_EXPR = 'SET #status = :status, progress = :progress, updated_at = :now, gsi1pk = :gsi1pk'
    SEVEN_DAYS = NOW_EPOCH + 7 * 24 * 3600

    def test_status_and_progress_only(self, table):
        update_job_status('p1', 'j1', 'running', 50)

        table.update_item.assert_called_once_with(
            Key=KEY,
            UpdateExpression=self.BASE_EXPR,
            ExpressionAttributeValues={
                ':status': 'running', ':progress': 50, ':now': NOW_ISO, ':gsi1pk': 'STATUS#running',
            },
            ExpressionAttributeNames={'#status': 'status'},
            ConditionExpression='attribute_exists(pk) AND attribute_exists(sk)',
        )

    def test_current_step_is_appended(self, table):
        update_job_status('p1', 'j1', 'running', 50, 'processing')

        request = table.update_item.call_args.kwargs
        assert request['UpdateExpression'] == self.BASE_EXPR + ', current_step = :step'
        assert request['ExpressionAttributeValues'] == {
            ':status': 'running', ':progress': 50, ':now': NOW_ISO,
            ':gsi1pk': 'STATUS#running', ':step': 'processing',
        }
        assert request['ExpressionAttributeNames'] == {'#status': 'status'}

    def test_error_completes_the_job_and_keeps_it_seven_days(self, table):
        update_job_status('p1', 'j1', 'failed', 0, 'error', error='boom')

        request = table.update_item.call_args.kwargs
        assert request['UpdateExpression'] == (
            self.BASE_EXPR + ', current_step = :step, #error = :error, completed_at = :now, #ttl = :ttl'
        )
        assert request['ExpressionAttributeValues'] == {
            ':status': 'failed', ':progress': 0, ':now': NOW_ISO, ':gsi1pk': 'STATUS#failed',
            ':step': 'error', ':error': 'boom', ':ttl': self.SEVEN_DAYS,
        }
        assert request['ExpressionAttributeNames'] == {
            '#status': 'status', '#error': 'error', '#ttl': 'ttl',
        }

    def test_result_completes_the_job_and_keeps_it_seven_days(self, table):
        update_job_status('p1', 'j1', 'completed', 100, result={'count': 2})

        request = table.update_item.call_args.kwargs
        assert request['UpdateExpression'] == (
            self.BASE_EXPR + ', #result = :result, completed_at = :now, #ttl = :ttl'
        )
        assert request['ExpressionAttributeValues'] == {
            ':status': 'completed', ':progress': 100, ':now': NOW_ISO,
            ':gsi1pk': 'STATUS#completed', ':result': {'count': 2}, ':ttl': self.SEVEN_DAYS,
        }
        assert request['ExpressionAttributeNames'] == {
            '#status': 'status', '#result': 'result', '#ttl': 'ttl',
        }

    @pytest.mark.usefixtures('no_table')
    def test_missing_table_logs_the_skip_and_writes_nothing(self, mock_logger):
        assert update_job_status('p1', 'j1', 'running', 1) is None

        mock_logger.warning.assert_called_once_with(
            'JOBS_TABLE not configured, skipping job status update',
        )

    def test_write_failure_is_logged_with_traceback_not_raised(self, table, mock_logger):
        table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'gone'}}, 'UpdateItem',
        )

        assert update_job_status('p1', 'j1', 'running', 1) is None

        mock_logger.error.assert_called_once()
        message, kwargs = mock_logger.error.call_args.args[0], mock_logger.error.call_args.kwargs
        assert message.startswith('Failed to update job status: An error occurred (ConditionalCheckFailedException)')
        assert kwargs == {'exc_info': True}


@pytest.mark.usefixtures('mock_logger')
class TestJobHandlerConfigLookup:
    @staticmethod
    def _four_arg_job():
        body = MagicMock(return_value={})

        @job_handler()
        def sample_job(ctx, project_id, job_id, config):
            return body(ctx, project_id, job_id, config)

        return sample_job, body

    @pytest.mark.usefixtures('mock_update')
    @pytest.mark.parametrize('key', [
        'filters', 'doc_config', 'merge_config', 'import_config', 'research_config', 'config',
    ])
    def test_each_config_key_is_passed_as_fourth_argument(self, key):
        sample_job, body = self._four_arg_job()

        sample_job({**EVENT, key: {'k': key}})

        body.assert_called_once()
        assert body.call_args.args[1:] == ('p1', 'j1', {'k': key})

    @pytest.mark.usefixtures('mock_update')
    def test_first_key_in_order_wins_when_two_are_present(self):
        sample_job, body = self._four_arg_job()

        sample_job({**EVENT, 'config': {'second': True}, 'filters': {'first': True}})

        assert body.call_args.args[3] == {'first': True}

    def test_config_less_event_calls_the_body_with_three_arguments(self, mock_update):
        body = MagicMock(return_value={'count': 3})

        @job_handler()
        def sample_job(ctx, project_id, job_id):
            return body(ctx, project_id, job_id)

        assert sample_job({**EVENT, 'unrelated': {}}) == {'success': True, 'count': 3}

        body.assert_called_once()
        ctx = body.call_args.args[0]
        assert isinstance(ctx, JobContext)
        assert (ctx.project_id, ctx.job_id) == ('p1', 'j1')
        assert body.call_args.args[1:] == ('p1', 'j1')
        mock_update.assert_called_once_with(
            'p1', 'j1', 'completed', 100, 'complete', result={'count': 3},
        )

    @pytest.mark.usefixtures('mock_update')
    def test_wrapper_keeps_the_body_name(self):
        wrapped = job_handler()(_three_arg_body())

        assert wrapped.__name__ == 'sample_job'


class TestJobHandlerLogsAndErrors:
    @pytest.mark.usefixtures('mock_update')
    def test_success_logs_start_and_completion(self, mock_logger):
        job_handler()(_three_arg_body())(EVENT)

        assert mock_logger.info.call_args_list == [
            call('[JOB] Starting sample_job for project=p1, job=j1'),
            call('[JOB] Completed sample_job for job=j1'),
        ]

    def test_default_error_message_and_two_hundred_character_truncation(self, mock_update, mock_logger):
        sample_job = job_handler()(_three_arg_body(raises=ValueError('x' * 500)))

        with pytest.raises(ServiceError) as exc:
            sample_job(EVENT)

        assert str(exc.value) == 'Job execution failed'
        assert isinstance(exc.value.__cause__, ValueError)
        mock_update.assert_called_once_with(
            'p1', 'j1', 'failed', 0, 'error', error='Job execution failed: ' + 'x' * 200,
        )
        mock_logger.exception.assert_called_once_with(
            '[JOB] sample_job failed for job=j1: ' + 'x' * 500,
        )

    @pytest.mark.usefixtures('mock_logger')
    def test_custom_error_message_prefixes_the_cause(self, mock_update):
        sample_job = job_handler(error_message='Persona generation failed')(
            _three_arg_body(raises=RuntimeError('boom')),
        )

        with pytest.raises(ServiceError) as exc:
            sample_job(EVENT)

        assert str(exc.value) == 'Persona generation failed'
        assert mock_update.call_args.kwargs == {'error': 'Persona generation failed: boom'}

    @pytest.mark.usefixtures('mock_update')
    def test_deferred_delivery_logs_the_job_it_skipped(self, mock_logger, mock_claim):
        mock_claim.return_value = False
        sample_job = job_handler()(_three_arg_body())

        with patch('shared.jobs.recover_job_execution_claim', return_value=False):
            assert sample_job(EVENT, _context(1000)) == {'success': True, 'skipped': True}

        mock_logger.info.assert_called_once_with(
            '[JOB] Delivery deferred or already complete for project=p1, job=j1',
        )

    @pytest.mark.usefixtures('mock_update', 'mock_logger')
    def test_recovered_claim_runs_the_body(self, mock_claim):
        mock_claim.return_value = False
        sample_job = job_handler()(_three_arg_body({'ran': True}))

        with patch('shared.jobs.recover_job_execution_claim', return_value=True):
            assert sample_job(EVENT, _context(1000)) == {'success': True, 'ran': True}

    @pytest.mark.usefixtures('mock_update', 'mock_logger', 'mock_claim')
    def test_first_claim_skips_recovery(self):
        sample_job = job_handler()(_three_arg_body({'ran': True}))

        with patch('shared.jobs.recover_job_execution_claim') as mock_recover:
            assert sample_job(EVENT, _context(1000)) == {'success': True, 'ran': True}

        mock_recover.assert_not_called()


class TestJobHandlerTerminalUserOutcomes:
    """F1 (2026-10): a 4xx ApiError is the job's ANSWER, not a platform fault.

    `voc-job-persona-generator` found no feedback for the caller's filters,
    raised ValidationError, and job_handler re-raised it as ServiceError: Lambda
    counted an unhandled failure, the event landed in the api-async-failures DLQ
    and its alarm fired. A 4xx must fail the job for the user and RETURN.
    """

    @pytest.mark.parametrize('error', [
        ValidationError('No feedback data found for the given filters'),
        NotFoundError('Document not found'),
        AuthorizationError('Not allowed'),
        ConflictError('Already running'),
    ], ids=lambda e: type(e).__name__)
    def test_a_4xx_marks_the_job_failed_and_returns_without_raising(self, mock_update, mock_logger, error):
        sample_job = job_handler(error_message='Persona generation failed')(_three_arg_body(raises=error))

        result = sample_job(EVENT)

        expected_error = f'Persona generation failed: {error.message}'
        assert result == {'success': False, 'error': expected_error}
        mock_update.assert_called_once_with('p1', 'j1', 'failed', 0, 'error', error=expected_error)
        # WARNING without a traceback — not ERROR / exception, which Logs
        # Insights error queries and the ops e2e count as faults. Returning
        # (asserted above) is what keeps Lambda's own Errors metric at 0.
        mock_logger.warning.assert_called_once_with(
            f'[JOB] sample_job ended without a result for job=j1 '
            f'({type(error).__name__}, {error.status_code}): {error.message}',
        )
        mock_logger.exception.assert_not_called()
        mock_logger.error.assert_not_called()

    @pytest.mark.parametrize('error', [
        ServiceError('Bedrock down'),
        ConfigurationError('JOBS_TABLE missing'),
        RuntimeError('boom'),
    ], ids=lambda e: type(e).__name__)
    def test_a_5xx_or_unexpected_error_still_fails_the_job_and_raises(self, mock_update, mock_logger, error):
        sample_job = job_handler(error_message='Persona generation failed')(_three_arg_body(raises=error))

        with pytest.raises(ServiceError) as exc:
            sample_job(EVENT)

        assert str(exc.value) == 'Persona generation failed'
        assert exc.value.__cause__ is error
        mock_update.assert_called_once_with(
            'p1', 'j1', 'failed', 0, 'error', error=f'Persona generation failed: {error}',
        )
        mock_logger.exception.assert_called_once()
        mock_logger.warning.assert_not_called()
