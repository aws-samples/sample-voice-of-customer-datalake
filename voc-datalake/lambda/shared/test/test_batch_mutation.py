"""Mutation-hardening suite for `shared.batch`.

The earlier suite only drove `batch_lambda_handler` with a SERIAL `BatchProcessor`,
so a mutation run found nothing pinning `ConcurrentSqsBatchProcessor` at all: the
worker floor (`max(1, …)`), the `max_workers` handed to `ordered_map`, the re-sort
of the success/failure lists into batch order (and the "unknown id sorts last"
default), the value `process()` returns, and `_message_id`'s fallbacks. Each of
the four decorators could also be dropped (mutmut deletes decorators) without a
test noticing anything but the batch one; they are pinned here by the exact
arguments each is applied with.

No real threads or waits: workers "finishing out of order" is a fake `ordered_map`
that runs the records in reverse, so the order the lists end up in is
deterministic.
"""

from collections.abc import Callable
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from aws_lambda_powertools.utilities.batch import EventType
from aws_lambda_powertools.utilities.data_classes.sqs_event import SQSRecord

from shared import batch
from shared.batch import ConcurrentSqsBatchProcessor, batch_lambda_handler
from shared.logging import logger, metrics, tracer
from shared.test.emf_fixtures import cold_start_metric_names


def _record(message_id: str, body: str) -> dict[str, Any]:
    return {'messageId': message_id, 'body': body, 'receiptHandle': 'r', 'attributes': {},
            'messageAttributes': {}, 'md5OfBody': '', 'eventSource': 'aws:sqs',
            'eventSourceARN': 'arn:aws:sqs:us-east-1:123456789012:q', 'awsRegion': 'us-east-1'}


def _event(*message_ids: str) -> dict[str, Any]:
    return {'Records': [_record(message_id, f'body-{message_id}') for message_id in message_ids]}


def _context() -> SimpleNamespace:
    return SimpleNamespace(
        function_name='voc-batch-test', memory_limit_in_mb=256,
        invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:voc-batch-test',
        aws_request_id='req-7', get_remaining_time_in_millis=lambda: 600_000,
    )


def _reversed_map(fn: Callable[[Any], Any], items: list[Any], max_workers: int) -> list[Any]:
    """`ordered_map` whose workers finish last-to-first, results still in input order."""
    del max_workers
    done = [(index, fn(item)) for index, item in reversed(list(enumerate(items)))]
    return [result for _, result in sorted(done, key=lambda pair: pair[0])]


def _fail_on(*bad_bodies: str) -> Callable[[SQSRecord], str]:
    def record_handler(record: SQSRecord) -> str:
        if record.body in bad_bodies:
            raise ValueError(f'bad {record.body}')
        return f'done {record.body}'
    return record_handler


class TestTheWorkerCount:
    @pytest.mark.parametrize(('asked', 'kept'), [(-3, 1), (0, 1), (1, 1), (2, 2), (5, 5)])
    def test_max_workers_is_floored_at_one(self, asked: int, kept: int):
        assert ConcurrentSqsBatchProcessor(max_workers=asked).max_workers == kept

    def test_it_is_an_sqs_processor_and_forwards_its_kwargs(self):
        processor = ConcurrentSqsBatchProcessor(max_workers=2, raise_on_entire_batch_failure=False)
        assert processor.event_type is EventType.SQS
        assert processor.raise_on_entire_batch_failure is False

    def test_ordered_map_gets_the_records_and_the_worker_count(self):
        records = [_record('a', 'x'), _record('b', 'y')]
        processor = ConcurrentSqsBatchProcessor(max_workers=3)
        fake_map = MagicMock(return_value=['r1', 'r2'])
        with patch.object(batch, 'ordered_map', fake_map), processor(records, _fail_on()):
            assert processor.process() == ['r1', 'r2']
        fake_map.assert_called_once_with(processor._process_record, records, max_workers=3)


class TestListsComeBackInBatchOrder:
    def test_out_of_order_workers_still_report_in_batch_order(self):
        handler = batch_lambda_handler(_fail_on('body-m1', 'body-m3'), ConcurrentSqsBatchProcessor(max_workers=4))
        with patch.object(batch, 'ordered_map', _reversed_map):
            response = handler(_event('m0', 'm1', 'm2', 'm3'), _context())
        assert response == {'batchItemFailures': [{'itemIdentifier': 'm1'}, {'itemIdentifier': 'm3'}]}

    def test_process_sorts_both_lists_and_returns_the_results_in_input_order(self):
        records = [_record('m0', 'ok0'), _record('m1', 'bad'), _record('m2', 'ok2'), _record('m3', 'bad')]
        processor = ConcurrentSqsBatchProcessor(max_workers=4, raise_on_entire_batch_failure=False)
        with patch.object(batch, 'ordered_map', _reversed_map), processor(records, _fail_on('bad')):
            results = processor.process()
            assert [message['messageId'] for message in processor.success_messages] == ['m0', 'm2']
            assert [message.message_id for message in processor.fail_messages] == ['m1', 'm3']
        assert [(status, value) for status, value, _ in results] == [
            ('success', 'done ok0'), ('fail', "<class 'ValueError'>:bad bad"),
            ('success', 'done ok2'), ('fail', "<class 'ValueError'>:bad bad"),
        ]

    def test_a_message_outside_the_batch_sorts_after_every_batch_message(self):
        records = [_record('m0', 'a'), _record('m1', 'b')]
        processor = ConcurrentSqsBatchProcessor(max_workers=2)
        stray = _record('zz', 'stray')
        with processor(records, _fail_on()):
            processor.success_messages.append(stray)
            processor.process()
            assert [message['messageId'] for message in processor.success_messages] == ['m0', 'm1', 'zz']


class TestMessageId:
    @pytest.mark.parametrize(('message', 'expected'), [
        ({'messageId': 'raw-1'}, 'raw-1'),
        ({'messageId': 42}, '42'),
        ({}, ''),
        (SimpleNamespace(message_id='rec-1'), 'rec-1'),
        (SimpleNamespace(message_id=7), '7'),
        (SimpleNamespace(), ''),
    ])
    def test_reads_the_raw_record_or_the_data_class(self, message: Any, expected: str):
        assert batch._message_id(message) == expected


class TestEveryDecoratorIsApplied:
    def test_the_logger_gets_the_lambda_context(self):
        logger.remove_keys(['function_name', 'cold_start'])
        handler = batch_lambda_handler(_fail_on(), ConcurrentSqsBatchProcessor(max_workers=1))
        assert handler(_event('m0'), _context()) == {'batchItemFailures': []}
        assert logger.get_current_keys()['function_name'] == 'voc-batch-test'

    def test_the_cold_start_metric_is_flushed(self, capsys: pytest.CaptureFixture[str]):
        handler = batch_lambda_handler(_fail_on(), ConcurrentSqsBatchProcessor(max_workers=1))
        assert cold_start_metric_names(metrics, lambda: handler(_event('m0'), _context()), capsys) == {'ColdStart'}

    def test_each_decorator_is_built_with_its_exact_arguments(self):
        record_handler = _fail_on()
        processor = ConcurrentSqsBatchProcessor(max_workers=1)
        log_metrics = MagicMock(return_value=lambda fn: fn)
        batch_decorator = MagicMock(return_value=lambda fn: fn)
        inject = MagicMock(side_effect=lambda fn: fn)
        capture = MagicMock(side_effect=lambda fn: fn)
        with patch.object(metrics, 'log_metrics', log_metrics), \
                patch.object(batch, 'batch_processor', batch_decorator), \
                patch.object(logger, 'inject_lambda_context', inject), \
                patch.object(tracer, 'capture_lambda_handler', capture):
            handler = batch_lambda_handler(record_handler, processor)
        log_metrics.assert_called_once_with(capture_cold_start_metric=True)
        batch_decorator.assert_called_once_with(record_handler=record_handler, processor=processor)
        # Every decorator is the identity here, so each one received the handler that came out.
        inject.assert_called_once_with(handler)
        capture.assert_called_once_with(handler)
        assert handler.__name__ == 'lambda_handler'
