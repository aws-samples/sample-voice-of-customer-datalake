"""Who may see and post on a feedback board (docs/feature-requests.md -> Who sees a board).

``board_access(board, viewer, company_domains)`` is the ONE rule, read by every board and
request route:

- an app-pool caller (an employee in the app) uses every non-archived board; an app admin also
  sees archived boards and is the board's admin;
- a board-pool caller uses a non-archived board whose audience admits the verified email
  (``shared.feature_boards_audience.audience_admits``).

A board the caller may not use is INVISIBLE: every board and request route answers 404, never
403, so its existence does not leak. ``BoardScope`` carries one request's caller and reads the
company domains at most once, and only when a board-pool caller meets a ``company`` board.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from functools import cached_property
from typing import Any, Final

from shared import engagement_config
from shared.engagement_identity import POOL_APP, BoardViewer, board_viewer
from shared.exceptions import NotFoundError
from shared.feature_boards_audience import audience_admits, audience_of
from shared.feature_boards_store import (
    BOARD_NOT_FOUND,
    SEEDED_BOARD_ID,
    find_board,
    get_board,
    list_boards,
    seed_if_empty,
)
from shared.feature_requests_store import REQUEST_NOT_FOUND, board_id_of, list_requests
from shared.participants_settings import load_settings

ACCESS_ADMIN: Final = 'admin'
ACCESS_MEMBER: Final = 'member'


def board_access(board: Mapping[str, Any], viewer: BoardViewer, company_domains: Iterable[str] = ()) -> str | None:
    """``'admin'``, ``'member'`` (sees and posts) or None (the board is invisible to ``viewer``)."""
    if viewer.is_admin:
        return ACCESS_ADMIN
    if board.get('archived') is True:
        return None
    if viewer.pool == POOL_APP:
        return ACCESS_MEMBER
    return ACCESS_MEMBER if audience_admits(audience_of(board), viewer.email, company_domains) else None


class BoardScope:
    """One request's view of the boards: ``viewer`` plus the two tables."""

    def __init__(self, viewer: BoardViewer, table: Any, participants: Callable[[], Any],
                 company_domains: Callable[[], list[str]]) -> None:
        self.viewer = viewer
        self.table = table
        self._participants = participants
        self._company_domains = company_domains

    @cached_property
    def company_domains(self) -> list[str]:
        return self._company_domains()

    def access(self, board: Mapping[str, Any]) -> str | None:
        needs_domains = self.viewer.pool != POOL_APP and audience_of(board)['mode'] == 'company'
        return board_access(board, self.viewer, self.company_domains if needs_domains else ())

    def visible(self, board: Mapping[str, Any] | None) -> bool:
        return board is not None and self.access(board) is not None

    def boards(self) -> list[dict[str, Any]]:
        """The boards the caller may use, seeding the Sales board on a table never seeded before."""
        boards = list_boards(self.table) or self._seed()
        return [board for board in boards if self.visible(board)]

    def _seed(self) -> list[dict[str, Any]]:
        """No board at all: create the seeded Sales board (it holds every request filed before boards)."""
        return seed_if_empty(self.table, self._participants(), lambda: len(list_requests(self.table)))

    def board(self, ref: object) -> dict[str, Any]:
        """The board by id or slug; omitted (None / '') = the seeded board. 404 when invisible."""
        board = self._default() if ref is None or ref == '' else find_board(self.table, ref)
        if board is None or not self.visible(board):
            raise NotFoundError(BOARD_NOT_FOUND)
        return board

    def _default(self) -> dict[str, Any] | None:
        board = get_board(self.table, SEEDED_BOARD_ID)
        if board is None and not list_boards(self.table):
            board = next(iter(self._seed()), None)
        return board

    def board_of(self, request: Mapping[str, Any]) -> dict[str, Any]:
        """The request's board; 404 (the REQUEST's not-found) when the caller may not use it."""
        board_id = board_id_of(request)
        board = self._default() if board_id == SEEDED_BOARD_ID else get_board(self.table, board_id)
        if board is None or not self.visible(board):
            raise NotFoundError(REQUEST_NOT_FOUND)
        return board


def _company_domains() -> list[str]:
    return list(load_settings(engagement_config.participants_table()).get('company_domains', []))


def scope_from_event(event: Mapping[str, Any]) -> BoardScope:
    """The scope of the calling board user (403 for an unknown pool or an unverified email)."""
    return scope_for(board_viewer(event))


def scope_for(viewer: BoardViewer) -> BoardScope:
    """The scope of one API call (the engagement Lambda's tables)."""
    return BoardScope(viewer, engagement_config.feature_requests_table(), engagement_config.participants_table,
                      _company_domains)
