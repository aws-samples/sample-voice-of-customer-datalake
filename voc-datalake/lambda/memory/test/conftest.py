"""Fixtures for the memory workers (extractor, scanner, retention)."""
from unittest.mock import MagicMock

import pytest

from memory.extractor import handler as extractor
from memory.scanner import handler as scanner
from shared.test.memory_fixtures import RAW_BUCKET, memory_world


@pytest.fixture
def world(monkeypatch):
    """The moto memory world, wired into both worker modules."""
    with memory_world(monkeypatch) as w:
        for module in (extractor, scanner):
            monkeypatch.setattr(module, 'MEMORY_QUEUE_URL', w.queue_url)
            monkeypatch.setattr(module, 'get_conversations_table', lambda: w.conversations)
            monkeypatch.setattr(module, 'get_sqs_client', lambda: w.sqs)
        monkeypatch.setattr(extractor, 'RAW_DATA_BUCKET', RAW_BUCKET)
        monkeypatch.setattr(extractor, 'get_aggregates_table', lambda: w.aggregates)
        monkeypatch.setattr(extractor, 'get_s3_client', lambda: w.s3)
        yield w


@pytest.fixture
def worker_context():
    context = MagicMock()
    context.function_name = 'voc-memory-worker'
    context.memory_limit_in_mb = 512
    context.invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789012:function:voc-memory-worker'
    context.aws_request_id = 'test-request'
    context.get_remaining_time_in_millis.return_value = 600_000
    return context
