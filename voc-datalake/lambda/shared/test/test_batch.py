"""`shared.batch.batch_lambda_handler` — the partial-batch entry point both stream
consumers share. The consumers' own suites exercise it end to end, and
`test_batch_mutation.py` pins the per-record failure report; this pins the one
contract left: a batch where every record raised fails the invocation."""

from typing import Any
from unittest.mock import MagicMock

import pytest
from aws_lambda_powertools.utilities.batch import BatchProcessor, EventType
from aws_lambda_powertools.utilities.batch.exceptions import BatchProcessingError
from aws_lambda_powertools.utilities.data_classes.sqs_event import SQSRecord

from shared.batch import batch_lambda_handler


def _sqs_event(*bodies: str) -> dict[str, Any]:
    return {'Records': [
        {'messageId': f'm{i}', 'body': body, 'receiptHandle': 'r', 'attributes': {},
         'messageAttributes': {}, 'md5OfBody': '', 'eventSource': 'aws:sqs',
         'eventSourceARN': 'arn:aws:sqs:us-east-1:123456789012:q', 'awsRegion': 'us-east-1'}
        for i, body in enumerate(bodies)
    ]}


def _context() -> MagicMock:
    context = MagicMock()
    context.function_name = 'voc-test'
    context.memory_limit_in_mb = 128
    context.invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789012:function:voc-test'
    context.aws_request_id = 'req-1'
    return context


class TestBatchLambdaHandler:
    def test_a_batch_where_every_record_fails_raises(self):
        """Powertools' rule: an all-failed batch is an invocation failure, not a report."""
        def record_handler(_record: SQSRecord) -> None:
            raise ValueError('bad record')

        handler = batch_lambda_handler(record_handler, BatchProcessor(event_type=EventType.SQS))

        with pytest.raises(BatchProcessingError):
            handler(_sqs_event('poison'), _context())
