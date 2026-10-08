"""
Text embeddings for memory (Amazon Titan Text Embeddings V2 via bedrock-runtime).

ONE place names the embedding model: ``MEMORY_EMBED_MODEL_ID`` (env, set by CDK)
falling back to ``DEFAULT_EMBED_MODEL_ID``. Callers ask for a vector and never see
a model id, the same discipline ``shared.model_config`` applies to text surfaces.
The IAM grant (``bedrock:InvokeModel`` on the foundation-model ARN of this id)
lives in CDK and must name the same id.

Vectors are requested normalised (unit length), so cosine similarity is a plain
dot product — see ``shared.memory_store.cosine``.
"""

from __future__ import annotations

import json
import os
from typing import Final

from shared.aws import get_bedrock_client
from shared.converse import bedrock_call_with_retry
from shared.exceptions import ServiceError

DEFAULT_EMBED_MODEL_ID: Final = 'amazon.titan-embed-text-v2:0'
EMBED_MODEL_ENV: Final = 'MEMORY_EMBED_MODEL_ID'
EMBED_DIMENSIONS: Final = 1024
# Titan V2 accepts up to 8,192 tokens / 50,000 characters. Memory statements are
# ≤ 500 chars and retrieval queries are a user's message, so this bound only ever
# bites on a pathological query; truncating beats a hard ValidationException.
MAX_EMBED_INPUT_CHARS: Final = 20_000
# Attempts including the first. Fewer than converse()'s default: an embed sits on
# the synchronous path of API routes (retrieve, add), which have a 29 s ceiling.
EMBED_MAX_ATTEMPTS: Final = 3


def embed_model_id() -> str:
    """The configured embedding model id (env override, else the Titan V2 default)."""
    configured = os.environ.get(EMBED_MODEL_ENV, '').strip()
    return configured or DEFAULT_EMBED_MODEL_ID


def _parse_embedding(raw_body: bytes | str) -> list[float]:
    try:
        payload = json.loads(raw_body)
    except ValueError as exc:
        raise ServiceError('Embedding response was not JSON') from exc
    vector = payload.get('embedding') if isinstance(payload, dict) else None
    if (
        not isinstance(vector, list)
        or len(vector) != EMBED_DIMENSIONS
        or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vector)
    ):
        raise ServiceError('Embedding response had an unexpected shape')
    return [float(v) for v in vector]


def embed_text(text: str) -> list[float]:
    """The unit-length 1024-dimension embedding of ``text``.

    Raises:
        ValueError: for blank text (a caller bug — nothing to embed).
        ServiceError: when Bedrock answers with something that is not a vector.
        BedrockThrottlingError: when throttling outlasts the retry budget.
    """
    cleaned = (text or '').strip()
    if not cleaned:
        raise ValueError('cannot embed blank text')
    body = json.dumps({
        'inputText': cleaned[:MAX_EMBED_INPUT_CHARS],
        'dimensions': EMBED_DIMENSIONS,
        'normalize': True,
    })
    model_id = embed_model_id()
    client = get_bedrock_client()

    response = bedrock_call_with_retry(
        lambda: client.invoke_model(
            modelId=model_id, body=body, contentType='application/json', accept='application/json',
        ),
        max_retries=EMBED_MAX_ATTEMPTS, step_name='memory_embed', call_label='the embedding call',
    )
    if 'body' not in response:
        raise ServiceError('Embedding call returned no body')
    return _parse_embedding(response['body'].read())
