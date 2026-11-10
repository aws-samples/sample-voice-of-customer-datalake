"""The memory workers run inside their roles' DynamoDB grants (the scanner outage, F2).

Production: every 15-minute ``voc-memory-scanner`` run died with
``AccessDeniedException ... dynamodb:BatchGetItem`` from ``store.get_cursors`` —
the role lacked the action. The root conftest enforces
``lib/stacks/memory-agents-dynamodb-grants.json`` on every moto call
(shared/test/strict_iam.py); these tests run each cursor reader end to end under
it, and show the same run is refused when the grant is taken away.
"""
from __future__ import annotations

import copy
from datetime import UTC, datetime, timedelta

import pytest
from aws_lambda_powertools.utilities.batch.exceptions import BatchProcessingError
from botocore.exceptions import ClientError

from memory.extractor import handler as extractor
from memory.scanner import handler as scanner
from memory.test.test_extractor import MESSAGES, OWNER, _session, _sqs_event
from shared.test import strict_iam
from shared.test.memory_fixtures import model_reply

NOW = datetime.now(UTC)


def _ended_session(world, session_id: str = 'ended') -> None:
    world.conversations.put_item(Item={
        'pk': 'USER#sub-a', 'sk': f'CONV#{session_id}', 'conversation_id': session_id, 'kind': 'assistant',
        'message_count': 4, 'updated_at': (NOW - timedelta(minutes=45)).isoformat(),
    })


def _without(monkeypatch: pytest.MonkeyPatch, role: str, table: str, action: str) -> None:
    revoked = copy.deepcopy(strict_iam.manifest())
    revoked['roles'][role]['grants'][table].remove(action)
    monkeypatch.setattr(strict_iam, 'manifest', lambda: revoked)


def test_the_scanner_runs_inside_its_grants(world, worker_context) -> None:
    _ended_session(world)
    assert scanner.lambda_handler({'source': 'aws.events'}, worker_context) == {'scanned': 1, 'enqueued': 1}


def test_the_scanner_is_refused_without_batch_get_item(world, worker_context, monkeypatch) -> None:
    _ended_session(world)
    _without(monkeypatch, 'MemoryWorkersMemoryScannerRole', 'Memory', 'dynamodb:BatchGetItem')
    with pytest.raises(ClientError, match='dynamodb:BatchGetItem'):
        scanner.lambda_handler({'source': 'aws.events'}, worker_context)


def test_the_extractor_reads_and_advances_session_cursors_inside_its_grants(world, worker_context) -> None:
    """The extractor calls the same store.get_cursors (BatchGetItem) before it advances a cursor."""
    _session(world, MESSAGES)
    world.converse.return_value = model_reply([])
    result = extractor.lambda_handler(_sqs_event({'kind': 'session', 'session_id': 'conv1', 'owner_sub': OWNER}),
                                      worker_context)
    assert result == {'batchItemFailures': []}


def test_the_extractor_is_refused_without_batch_get_item(world, worker_context, monkeypatch) -> None:
    _session(world, MESSAGES)
    world.converse.return_value = model_reply([])
    _without(monkeypatch, 'MemoryWorkersMemoryExtractorRole', 'Memory', 'dynamodb:BatchGetItem')
    with pytest.raises(BatchProcessingError, match='dynamodb:BatchGetItem'):
        extractor.lambda_handler(_sqs_event({'kind': 'session', 'session_id': 'conv1', 'owner_sub': OWNER}),
                                 worker_context)
