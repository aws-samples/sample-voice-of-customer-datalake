"""
The Lambda entry point every partial-batch consumer shares.

The SQS processor and the DynamoDB Streams aggregator are both "one record handler
behind a Powertools `BatchProcessor`", and their `lambda_handler`s were the same
four decorators around `processor.response()`. They are built here once, so the
observability stack (structured logging context, X-Ray, cold-start metric) and the
partial-failure contract (`reportBatchItemFailures`) cannot drift between them.
"""

from collections.abc import Callable
from typing import Any

from aws_lambda_powertools.utilities.batch import BasePartialBatchProcessor, BatchProcessor, EventType, batch_processor
from aws_lambda_powertools.utilities.batch.types import PartialItemFailureResponse

from shared.concurrency import ordered_map
from shared.invocation_cost import measure_invocation_cost
from shared.logging import logger, metrics, tracer


class ConcurrentSqsBatchProcessor(BatchProcessor):
    """An SQS `BatchProcessor` that runs up to `max_workers` records at once.

    The serial processor makes a batch wait for the SUM of its records' work; a
    record whose enrichment is three network round-trips plus a model call then
    holds up every record behind it. The records of one SQS batch are independent
    (each has its own idempotency key and its own DynamoDB item), so they run on a
    bounded thread pool instead.

    The partial-batch contract is unchanged: Powertools' `_process_record` already
    turns a raise into a failure entry (it never propagates), so each record still
    succeeds or fails on its own and `batchItemFailures` names exactly the records
    that raised. Workers finish in any order, so the success/failure lists are put
    back into the batch's own order before the response is built — the reported
    failures read the same as the serial processor's.

    The record handler must be thread-safe: no shared mutable state without a lock.
    """

    def __init__(self, max_workers: int, **kwargs: Any) -> None:
        super().__init__(event_type=EventType.SQS, **kwargs)
        self.max_workers = max(1, max_workers)

    def process(self) -> list[tuple]:
        results = ordered_map(self._process_record, self.records, max_workers=self.max_workers)
        position = {record['messageId']: index for index, record in enumerate(self.records)}

        def batch_order(message: Any) -> int:
            return position.get(_message_id(message), len(position))

        self.success_messages.sort(key=batch_order)
        self.fail_messages.sort(key=batch_order)
        return results


def _message_id(message: Any) -> str:
    """The SQS messageId of a success entry (the raw record) or a failure entry (the SQSRecord)."""
    if isinstance(message, dict):
        return str(message.get('messageId', ''))
    return str(getattr(message, 'message_id', ''))


def batch_lambda_handler(
    record_handler: Callable[..., Any],
    processor: BasePartialBatchProcessor,
) -> Callable[[dict, Any], PartialItemFailureResponse]:
    """A Lambda handler that runs `record_handler` over the batch through `processor`.

    The response is the processor's: `{'batchItemFailures': [...]}` naming only the
    records that raised, so the event source redelivers those and keeps the rest.
    The whole batch logs one `invocation_cost` line (shared/invocation_cost.py).
    """

    @logger.inject_lambda_context
    @tracer.capture_lambda_handler
    @metrics.log_metrics(capture_cold_start_metric=True)
    @measure_invocation_cost
    @batch_processor(record_handler=record_handler, processor=processor)
    def lambda_handler(_event: dict, context: Any) -> PartialItemFailureResponse:
        """Main Lambda handler."""
        return processor.response()

    return lambda_handler
