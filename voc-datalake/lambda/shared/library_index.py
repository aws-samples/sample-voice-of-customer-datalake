"""A Documents Library item's passages: written once at extraction, searched in the Lambda (docs/documents-library.md).

The memory store's no-fixed-cost pattern (shared/memory_store.py): each passage is embedded once with Amazon Titan
Text Embeddings V2 (shared/embeddings.py, 1,024 dimensions, normalised), kept as zlib-compressed float32 beside its
text in DynamoDB (``LIBRARY_CHUNKS#{item}`` / ``C#{n}``, at most 2,000 per item), and ranked by cosine in the Lambda
that asks. No vector database, nothing that runs when nobody asks.

``retrieve`` answers a question over at most three items: the best ``MAX_PASSAGES`` passages, at most
``MAX_PASSAGE_CHARS`` characters together, in ranking order, each naming its item, page and passage number (the
``[#slug p.N]`` marker the assistant cites).
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from boto3.dynamodb.types import Binary

from shared.concurrency import ordered_map
from shared.dynamo_paging import iter_query
from shared.embeddings import embed_text
from shared.library_extract import Chunk
from shared.library_keys import CHUNK_SK_PREFIX, chunk_sk, chunks_pk
from shared.memory_store import cosine, decode_embedding, encode_embedding

__all__ = ['MAX_PASSAGE_CHARS', 'delete_chunks', 'retrieve', 'write_chunks']

MAX_PASSAGES: Final = 8
MAX_PASSAGE_CHARS: Final = 12_000
#: Titan calls in flight while an item is indexed (one call per passage; the worker has 15 minutes).
EMBED_WORKERS: Final = 8


def _embedded(chunk: Chunk) -> bytes:
    return encode_embedding(embed_text(chunk.text))


def _chunk_row(item_id: str, index: int, chunk: Chunk, blob: bytes) -> dict[str, Any]:
    row: dict[str, Any] = {'pk': chunks_pk(item_id), 'sk': chunk_sk(index), 'text': chunk.text,
                           'chars': len(chunk.text), 'embedding': Binary(blob)}
    if chunk.page is not None:
        row['page'] = chunk.page
    return row


def write_chunks(table: Any, item_id: str, chunks: Sequence[Chunk]) -> int:
    """Embed every passage and write them (``C#00001`` …): the count written."""
    blobs = ordered_map(_embedded, chunks, max_workers=EMBED_WORKERS)
    rows = [_chunk_row(item_id, index, chunk, blob)
            for index, (chunk, blob) in enumerate(zip(chunks, blobs, strict=True), start=1)]
    with table.batch_writer() as writer:
        for row in rows:
            writer.put_item(Item=row)
    return len(rows)


def _query(item_id: str, **extra: Any) -> dict[str, Any]:
    """The Query of one item's passages (``C#…`` rows of ``LIBRARY_CHUNKS#{item}``), with ``extra`` merged in."""
    return {
        'KeyConditionExpression': '#pk = :pk AND begins_with(#sk, :c)',
        'ExpressionAttributeNames': {'#pk': 'pk', '#sk': 'sk'},
        'ExpressionAttributeValues': {':pk': chunks_pk(item_id), ':c': CHUNK_SK_PREFIX},
        **extra,
    }


def delete_chunks(table: Any, item_id: str) -> int:
    """Delete every passage of the item: the count deleted."""
    keys = [{'pk': row['pk'], 'sk': row['sk']}
            for row in iter_query(table, _query(item_id, ProjectionExpression='#pk, #sk'))]
    with table.batch_writer() as writer:
        for key in keys:
            writer.delete_item(Key=key)
    return len(keys)


@dataclass(frozen=True)
class Passage:
    """One passage found for a question."""

    item_id: str
    chunk: int
    page: int | None
    text: str
    score: float

    def view(self) -> dict[str, Any]:
        return {'item_id': self.item_id, 'chunk': self.chunk, 'page': self.page, 'text': self.text,
                'score': round(self.score, 4)}


def _passages_of(item_id: str, rows: Iterable[Mapping[str, Any]], query: list[float]) -> list[Passage]:
    found: list[Passage] = []
    for row in rows:
        vector = decode_embedding(row.get('embedding'))
        text = row.get('text')
        if vector is None or not isinstance(text, str):
            continue
        sk = str(row.get('sk') or '')
        page = row.get('page')
        found.append(Passage(item_id, int(sk.removeprefix(CHUNK_SK_PREFIX) or 0),
                             int(page) if page is not None else None, text, cosine(query, vector)))
    return found


def best_passages(candidates: Iterable[Passage], *, budget: int = MAX_PASSAGE_CHARS) -> list[Passage]:
    """The highest-scoring passages, at most ``MAX_PASSAGES`` and ``budget`` characters together (one that would
    pass the budget is skipped, a shorter one after it may still fit)."""
    chosen: list[Passage] = []
    used = 0
    for passage in sorted(candidates, key=lambda candidate: (-candidate.score, candidate.item_id, candidate.chunk)):
        if len(chosen) >= MAX_PASSAGES:
            break
        if used + len(passage.text) > budget:
            continue
        chosen.append(passage)
        used += len(passage.text)
    return chosen


def retrieve(table: Any, item_ids: Sequence[str], question: str, *,
             budget: int = MAX_PASSAGE_CHARS) -> list[Passage]:
    """The best passages of ``item_ids`` for ``question`` (one Titan call, then cosine here)."""
    if not item_ids or not question.strip():
        return []
    query = embed_text(question)
    per_item = ordered_map(
        lambda item_id: _passages_of(item_id, iter_query(table, _query(item_id)), query), item_ids)
    return best_passages([passage for passages in per_item for passage in passages], budget=budget)
