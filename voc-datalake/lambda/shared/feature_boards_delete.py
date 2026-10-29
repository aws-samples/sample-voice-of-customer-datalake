"""Deleting a feedback board, optionally with its requests (docs/feature-requests.md -> API).

``DELETE /feature-requests/boards/{ref}`` without ``with_requests`` deletes an EMPTY board only
(409 ``board_not_empty``). With ``?with_requests=true`` it empties the board first: it archives
the board (so only admins can post while it empties), then deletes its requests oldest first,
each with every support (``delete_request``), for at most ``DELETE_BUDGET_SECONDS``. When requests
remain the board is kept and the answer says how many (``done: false``); the call is idempotent
and resumes where the last one stopped. When none remain the board itself is deleted.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from time import monotonic
from typing import Any, Final

from shared.exceptions import ConflictError, ValidationError
from shared.feature_boards_store import delete_board, update_board
from shared.feature_requests_store import (
    board_requests,
    count_board_requests,
    delete_request,
    get_request,
    has_requests,
)

# Under API Gateway's 29 s cut, leaving room for the count and the board delete after the loop.
DELETE_BUDGET_SECONDS: Final = 20.0
DELETE_PAGE: Final = 100
BOARD_NOT_EMPTY: Final = 'board_not_empty'
_WITH_REQUESTS_VALUES: Final = {'true': True, '1': True, 'false': False, '0': False}


@dataclass(frozen=True)
class BoardRemoval:
    """One call's outcome: ``done`` = the board is gone; ``deleted`` = requests removed by this call."""

    done: bool
    deleted: int
    remaining: int

    def view(self) -> dict[str, Any]:
        return {'success': True, 'done': self.done, 'deleted': self.deleted, 'remaining': self.remaining}


def parse_with_requests(params: Mapping[str, Any] | None) -> bool:
    """``with_requests``: absent = False; true/false or 1/0 (any case); anything else is a 400."""
    raw = (params or {}).get('with_requests')
    if raw is None:
        return False
    value = _WITH_REQUESTS_VALUES.get(str(raw).strip().lower())
    if value is None:
        raise ValidationError('with_requests must be true or false')
    return value


def remove_board_and_requests(table: Any, participants: Any, board: Mapping[str, Any], *,
                              with_requests: bool) -> BoardRemoval:
    """Delete ``board`` (an empty one only, unless ``with_requests``)."""
    board_id = str(board['board_id'])
    if not with_requests:
        if has_requests(table, board_id):
            raise ConflictError(BOARD_NOT_EMPTY)
        delete_board(table, participants, board)
        return BoardRemoval(done=True, deleted=0, remaining=0)
    deleted = _delete_requests(table, participants, board, monotonic() + DELETE_BUDGET_SECONDS)
    remaining = count_board_requests(table, board_id)
    if remaining:
        return BoardRemoval(done=False, deleted=deleted, remaining=remaining)
    delete_board(table, participants, board)
    return BoardRemoval(done=True, deleted=deleted, remaining=0)


def _delete_requests(table: Any, participants: Any, board: Mapping[str, Any], deadline: float) -> int:
    """Delete the board's requests until none is left or ``deadline`` passes (at least one is
    attempted per call, so every call makes progress); how many were deleted."""
    board_id = str(board['board_id'])
    archive = _Archiver(table, participants, board)
    seen: set[str] = set()
    deleted = 0
    while True:
        page = [row for row in board_requests(table, board_id, limit=DELETE_PAGE)
                if str(row.get('request_id', '')) not in seen]
        if not page:  # none left, or the index still lists only what this call removed
            return deleted
        for row in page:
            if seen and monotonic() >= deadline:
                return deleted
            request_id = str(row.get('request_id', ''))
            seen.add(request_id)
            deleted += _delete_one(table, request_id, archive)


@dataclass
class _Archiver:
    """Archives the board once, right before its first request is deleted."""

    table: Any
    participants: Any
    board: Mapping[str, Any]
    done: bool = field(init=False)

    def __post_init__(self) -> None:
        self.done = self.board.get('archived') is True

    def __call__(self) -> None:
        if not self.done:
            update_board(self.table, self.participants, self.board, {'archived': True})
            self.done = True


def _delete_one(table: Any, request_id: str, archive: _Archiver) -> int:
    """1 when the request was deleted; 0 when it was already gone (the index lags behind deletes)."""
    request = get_request(table, request_id)
    if request is None:
        return 0
    archive()
    delete_request(table, request)
    return 1
