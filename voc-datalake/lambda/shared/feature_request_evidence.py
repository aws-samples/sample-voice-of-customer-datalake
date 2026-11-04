"""Feedback-board requests as a SEPARATE evidence source (docs/project-workspace.md -> Feature requests).

Board requests never enter the feedback pipeline (voc-feedback, the METRIC# aggregates): they stay
in voc-feature-requests with their own light enrichment (``enrichment`` on ``FR#{id}`` / ``META``),
and this loader is the one read the search route, persona generation, research and document
generation share.

``load_feature_request_evidence`` walks the requests partition of the listing index (``gsi1pk``
``FRS``, ``gsi1sk`` ``{created_at}#{request_id}``, newest first; ``days`` becomes a key condition),
bounded by ``MAX_SCANNED_REQUESTS``, keeps the requests of non-archived boards (narrowed to
``board_ids`` and ``visible_board_ids`` when given) that pass the category / status / text
filters, and answers them most-supported first. Every item is a SLIM view: never the reporter's
email or name, never a support row, the description cut to ``MAX_DESCRIPTION_CHARS``.
"""
from __future__ import annotations

import os
from collections.abc import Collection, Iterator, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any, Final

from shared.aws import get_dynamodb_resource
from shared.dynamo_paging import iter_query
from shared.dynamo_values import as_count
from shared.exceptions import ConfigurationError
from shared.feature_boards_store import SEEDED_BOARD_ID, list_boards
from shared.feature_requests_store import REQUESTS_PARTITION, board_id_of
from shared.indexes import FEATURE_REQUESTS_LISTING_INDEX

FEATURE_REQUESTS_TABLE_ENV: Final = 'FEATURE_REQUESTS_TABLE'
# Request rows one load reads at most. A row is a few KB, so this keeps one load well inside a
# Lambda's memory and a few seconds of reads; past it the result says ``truncated``.
MAX_SCANNED_REQUESTS: Final = 5000
MAX_DESCRIPTION_CHARS: Final = 1000
MAX_LIMIT: Final = 1000
UNCATEGORIZED: Final = 'uncategorized'


@dataclass(frozen=True)
class FeatureRequestEvidence:
    """``items`` (slim, at most ``limit``), how many matched (``total``) and whether that is a
    floor: ``truncated`` when more matched than were returned or the read stopped at its bound."""

    items: list[dict[str, Any]]
    total: int
    truncated: bool


@dataclass(frozen=True)
class _Filters:
    boards: frozenset[str]
    cutoff: str | None
    categories: frozenset[str] | None
    statuses: frozenset[str] | None
    terms: tuple[str, ...]


@lru_cache(maxsize=4)
def _table_named(name: str) -> Any:
    return get_dynamodb_resource().Table(name)


def feature_requests_table() -> Any:
    """voc-feature-requests (env ``FEATURE_REQUESTS_TABLE``); a ConfigurationError (500) when unset."""
    name = os.environ.get(FEATURE_REQUESTS_TABLE_ENV, '')
    if not name:
        raise ConfigurationError(f'{FEATURE_REQUESTS_TABLE_ENV} not configured')
    return _table_named(name)


def _text(value: object) -> str:
    return value if isinstance(value, str) else ''


def _optional_text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _folded(values: Sequence[str] | None) -> frozenset[str] | None:
    """The values lower-cased; None (no filter) for None or a list with no usable value."""
    folded = frozenset(value.strip().lower() for value in values or () if value.strip())
    return folded or None


def _open_board_ids(table: Any) -> frozenset[str]:
    """The ids of every non-archived board. A table with no board yet (never seeded) holds only
    requests filed before boards, which belong to the seeded board."""
    boards = list_boards(table)
    if not boards:
        return frozenset({SEEDED_BOARD_ID})
    return frozenset(str(board['board_id']) for board in boards
                     if board.get('archived') is not True and isinstance(board.get('board_id'), str))


def _allowed_boards(table: Any, board_ids: Sequence[str] | None,
                    visible_board_ids: Collection[str] | None) -> frozenset[str]:
    allowed = _open_board_ids(table)
    if board_ids is not None:
        allowed &= frozenset(board_ids)
    if visible_board_ids is not None:
        allowed &= frozenset(visible_board_ids)
    return allowed


def _cutoff(days: int | None) -> str | None:
    """The oldest ``created_at`` a ``days`` window admits (None or ≤ 0 = all time)."""
    if days is None or days <= 0:
        return None
    return (datetime.now(UTC) - timedelta(days=days)).isoformat()


def _enrichment(item: Mapping[str, Any]) -> Mapping[str, Any]:
    raw = item.get('enrichment')
    return raw if isinstance(raw, Mapping) else {}


def _category_key(item: Mapping[str, Any]) -> str:
    category = _optional_text(_enrichment(item).get('category'))
    return category.strip().lower() if category else UNCATEGORIZED


def _searchable(item: Mapping[str, Any]) -> str:
    parts = (item.get('title'), item.get('description'), _enrichment(item).get('problem_summary'))
    return '\n'.join(_text(part) for part in parts).lower()


def _matches(item: Mapping[str, Any], filters: _Filters) -> bool:
    if board_id_of(item) not in filters.boards:
        return False
    if filters.categories is not None and _category_key(item) not in filters.categories:
        return False
    if filters.statuses is not None and _text(item.get('status')).lower() not in filters.statuses:
        return False
    if filters.terms:
        text = _searchable(item)
        return all(term in text for term in filters.terms)
    return True


def _supporters(item: Mapping[str, Any]) -> int:
    totals = item.get('totals')
    return as_count(totals.get('supporters')) if isinstance(totals, Mapping) else 0


def slim_request(item: Mapping[str, Any]) -> dict[str, Any]:
    """The evidence view of one request row: ids, text, status, support count and enrichment.
    Never an email, a name or a field value (a deal, a customer) from the board."""
    enrichment = _enrichment(item)
    return {
        'request_id': _text(item.get('request_id')),
        'board_id': board_id_of(item),
        'title': _text(item.get('title')),
        'description': _text(item.get('description'))[:MAX_DESCRIPTION_CHARS],
        'status': _text(item.get('status')),
        'supporters': _supporters(item),
        'category': _optional_text(enrichment.get('category')),
        'sentiment': _optional_text(enrichment.get('sentiment')),
        'problem_summary': _optional_text(enrichment.get('problem_summary')),
        'created_at': _text(item.get('created_at')),
    }


def _request_rows(table: Any, cutoff: str | None) -> Iterator[dict[str, Any]]:
    condition = 'gsi1pk = :p'
    values: dict[str, str] = {':p': REQUESTS_PARTITION}
    if cutoff is not None:
        condition += ' AND gsi1sk >= :c'
        values[':c'] = cutoff
    return iter_query(table, {
        'IndexName': FEATURE_REQUESTS_LISTING_INDEX, 'KeyConditionExpression': condition,
        'ExpressionAttributeValues': values, 'ScanIndexForward': False,
    }, max_items=MAX_SCANNED_REQUESTS)


def _ranked(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Most supporters first; newest first among equals."""
    by_date = sorted(items, key=lambda item: item['created_at'], reverse=True)
    return sorted(by_date, key=lambda item: item['supporters'], reverse=True)


def load_feature_request_evidence(
    *, board_ids: Sequence[str] | None = None, days: int | None = None,
    categories: Sequence[str] | None = None, statuses: Sequence[str] | None = None, query: str | None = None,
    limit: int = 200, visible_board_ids: Collection[str] | None = None,
) -> FeatureRequestEvidence:
    """The board requests matching every given filter (None = no filter on that field).

    ``categories`` match the enrichment's category case-insensitively (``uncategorized`` = none
    yet); ``statuses`` the request status; ``query`` every whitespace-separated term, in the
    title, description or problem summary. Archived boards never count.
    """
    table = feature_requests_table()
    boards = _allowed_boards(table, board_ids, visible_board_ids)
    if not boards:
        return FeatureRequestEvidence([], 0, False)
    filters = _Filters(boards=boards, cutoff=_cutoff(days), categories=_folded(categories),
                       statuses=_folded(statuses), terms=tuple((query or '').lower().split()))
    matched: list[dict[str, Any]] = []
    scanned = 0
    for row in _request_rows(table, filters.cutoff):
        scanned += 1
        if _matches(row, filters):
            matched.append(slim_request(row))
    cap = max(0, min(limit, MAX_LIMIT))
    truncated = len(matched) > cap or scanned >= MAX_SCANNED_REQUESTS
    return FeatureRequestEvidence(_ranked(matched)[:cap], len(matched), truncated)
