"""The ``LOGS#processing#…`` rows the processor writes and ``GET /logs/*`` reads back.

A stored row never carries the exception text (it can quote customer data); it carries one of these fixed
messages, which the logs API also answers with for a row whose error type it does not recognise.
"""
from typing import Final

PROCESSING_FAILED_MESSAGE: Final = 'Processing failed; details are in the processor CloudWatch logs'
THROTTLED_MESSAGE: Final = 'Bedrock throttled the request; SQS will retry the message'
