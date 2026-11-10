"""The processor hands its Lambda context to the IdempotencyConfig (Powertools' documented way).

Without ``IdempotencyConfig.register_lambda_context(context)`` every idempotent record logs
"UserWarning: Couldn't determine the remaining time left. Did you call
register_lambda_context on IdempotencyConfig?" and an in-progress claim cannot expire with
the invocation, so a record whose invocation timed out stays locked for the whole
idempotency window (seen in voc-feedback-processor's logs).
"""
from unittest.mock import MagicMock, patch

from processor.test.sqs_fixtures import sqs_record


@patch('processor.handler.write_to_dynamodb', return_value=True)
@patch('processor.handler.process_feedback')
def test_the_context_is_registered_before_any_record_runs(process, write, lambda_context, sample_sqs_record):
    from processor import handler

    order: list[str] = []
    config = MagicMock()
    config.register_lambda_context.side_effect = lambda _ctx: order.append('registered')
    process.side_effect = lambda _raw: order.append('record') or {'feedback_id': 'ok', 'llm_metadata': {}}
    with patch.object(handler, 'idempotency_config', config), patch.object(handler, 'persistence_layer', None):
        handler.lambda_handler({'Records': [sqs_record('m1', sample_sqs_record)]}, lambda_context)
    config.register_lambda_context.assert_called_once_with(lambda_context)
    assert (order, write.call_count) == (['registered', 'record'], 1)
