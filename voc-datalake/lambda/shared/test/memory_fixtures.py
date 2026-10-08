"""Memory test fixtures: a deterministic fake embedder and a moto-backed memory world.

``fake_vector`` is a bag-of-words hashing embedder: statements sharing words have a
proportionally high cosine, identical ones exactly 1.0, so dedup/neighbour tests can
reason about similarity without Bedrock. ``memory_world`` stands up every resource
the memory Lambdas touch (memory table with gsi1, aggregates, conversations, raw
bucket, queue) inside ``mock_aws`` and patches the embedder and the model call.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
from moto import mock_aws

from api.test.moto_helpers import pk_sk_table
from shared import memory_store
from shared.converse import ConverseResult
from shared.embeddings import EMBED_DIMENSIONS
from shared.indexes import MEMORY_BY_STATUS_INDEX

MEMORY_TABLE_NAME = 'test-memory'
AGGREGATES_TABLE_NAME = 'test-aggregates'
CONVERSATIONS_TABLE_NAME = 'test-conversations'
RAW_BUCKET = 'test-raw-data-bucket'
QUEUE_NAME = 'test-memory-queue'

ADMIN_CLAIMS = {'sub': 'sub-admin', 'cognito:groups': 'admins', 'cognito:username': 'ada'}
REVIEWER_CLAIMS = {'sub': 'sub-reviewer', 'cognito:username': 'rita'}
USER_CLAIMS = {'sub': 'sub-user', 'cognito:username': 'ulla'}
OTHER_CLAIMS = {'sub': 'sub-other', 'cognito:username': 'otto'}
MCP_CLAIMS = {'sub': 'mcp:tok1', 'voc:acting_subject': 'sub-user'}

_WORD_RE = re.compile(r'[a-z0-9]+')


def fake_vector(text: str) -> list[float]:
    vector = [0.0] * EMBED_DIMENSIONS
    for word in _WORD_RE.findall(text.lower()):
        vector[int(hashlib.md5(word.encode(), usedforsecurity=False).hexdigest(), 16) % EMBED_DIMENSIONS] += 1.0
    norm = math.sqrt(sum(v * v for v in vector)) or 1.0
    return [v / norm for v in vector]


def model_reply(memories: list[dict]) -> str:
    """A model answer in the extractor's JSON shape."""
    return json.dumps({'memories': memories})


def relations_reply(labels: list[str]) -> str:
    return json.dumps({'relations': labels})


def _as_detailed(scripted: MagicMock):
    """Adapt a scripted model — replies as ``text`` or ``(text, resolved_tier)`` —
    to ``converse_detailed``'s ``ConverseResult``. The mock still records every
    call's kwargs, so tests assert on ``world.converse`` as before."""
    def call(**kwargs: Any) -> ConverseResult:
        reply = scripted(**kwargs)
        text, tier = reply if isinstance(reply, tuple) else (reply, None)
        requested = kwargs.get('service_tier')
        return ConverseResult(text=text, requested_tier=requested, resolved_tier=tier,
                              flex_fallback=requested == 'flex' and tier not in (None, 'flex'))
    return call


@dataclass
class MemoryWorld:
    memory: Any
    aggregates: Any
    conversations: Any
    s3: Any
    sqs: Any
    queue_url: str
    converse: MagicMock

    def queued(self) -> list[dict]:
        response = self.sqs.receive_message(QueueUrl=self.queue_url, MaxNumberOfMessages=10)
        return [json.loads(m['Body']) for m in response.get('Messages', [])]

    def memories(self, pk: str = memory_store.COMPANY_PK) -> list[dict]:
        return [r for r in memory_store.query_partition(self.memory, pk) if str(r['sk']).startswith('MEM#')]

    def flag_reviewer(self, sub: str) -> None:
        self.aggregates.put_item(Item={'pk': f'USERFLAGS#{sub}', 'sk': 'config', 'memory_reviewer': True})


@contextmanager
def memory_world(monkeypatch):
    """Every memory resource inside moto, with the embedder and model patched."""
    with mock_aws(), ExitStack() as stack:
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        memory = pk_sk_table(MEMORY_TABLE_NAME, gsi1_index=MEMORY_BY_STATUS_INDEX)
        aggregates = pk_sk_table(AGGREGATES_TABLE_NAME)
        conversations = pk_sk_table(CONVERSATIONS_TABLE_NAME)
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=RAW_BUCKET)
        sqs = boto3.client('sqs', region_name='us-east-1')
        queue_url = sqs.create_queue(QueueName=QUEUE_NAME)['QueueUrl']
        monkeypatch.setenv(memory_store.MEMORY_TABLE_ENV, MEMORY_TABLE_NAME)
        converse = MagicMock(return_value=relations_reply([]))
        stack.enter_context(patch.object(memory_store, 'get_dynamodb_resource', return_value=resource))
        stack.enter_context(patch.object(memory_store, 'embed_text', side_effect=fake_vector))
        stack.enter_context(patch.object(memory_store, 'converse_detailed', side_effect=_as_detailed(converse)))
        memory_store._table_cache.clear()
        memory_store.clear_pool_cache()
        memory_store.clear_objective_cache()
        try:
            yield MemoryWorld(memory, aggregates, conversations, s3, sqs, queue_url, converse)
        finally:
            memory_store._table_cache.clear()
            memory_store.clear_pool_cache()
            memory_store.clear_objective_cache()


def candidate(statement: str, *, scope: str = 'company', kind: str = 'product', confidence: float = 0.9,
              supporter: str = 'h-user', owner_sub: str | None = None, source_kind: str = 'extracted',
              source: dict | None = None) -> memory_store.Candidate:
    return memory_store.Candidate(
        statement=statement, kind=kind, scope=scope, confidence=confidence, source_kind=source_kind,
        source=source or {'type': 'session', 'ref': 's1', 'at': '2026-10-01T00:00:00+00:00'},
        supporter=supporter, owner_sub=owner_sub,
    )
