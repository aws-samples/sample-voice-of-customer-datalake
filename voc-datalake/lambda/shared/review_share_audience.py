"""Who a document review link admits (docs/document-review.md -> Share for review).

A review link is ONE row in the projects table, ``DOCSHARE#{share_id}`` / ``META``, written by the
projects API (``shared.document_share``). Two readers apply the same rule from here:

- the board pool's PreSignUp trigger (``auth/board_triggers.py``): a new board account may be
  created for an email that an ACTIVE link (named by the sign-up's ``ClientMetadata.share_id``)
  admits;
- the review routes (``shared.document_review_routes``): every read and comment re-checks the
  link and the verified email of the caller.

A link is active while it is not revoked and ``expires_at_epoch`` lies in the future. Its
``audience`` is ``{mode, domains, emails}``: ``anyone`` (any email that proves its inbox with the
emailed code) or ``list`` (an allowed domain OR an exact address).

A link made in a workspace (docs/multi-workspace.md, the project plan, 3e; no route makes one yet) is that
workspace's own row, ``WS#{ws}#DOCSHARE#{share_id}`` / ``META`` (shared/project_keys.py
``review_link_key``), and its ``DOCSHARE#{share_id}`` row is only a routing row naming the workspace
(``workspace_id``, written by shared/ws_repo.py ``route_share_id``). Both readers resolve an id the same
way: ``routing_of`` the ``DOCSHARE#`` row (a row naming no workspace is the deployment's link, as before;
a routing row names its workspace; a row naming anything but a workspace id is nothing). A routing row
is refused by both until the switch (``REVIEWER_ROUTES_STORE``); after it, the link is read from that
workspace and nothing else, kept only when it is the link of that id (``routed_share``). A row that names
a workspace is never itself admitted as a link.

Stdlib only: the trigger bundle ships this file beside ``shared/participants_settings.py``
(core-board-auth.ts ``BOARD_TRIGGER_FILES``). Never logs an address.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from decimal import Decimal
from typing import Any, Final, TypeGuard

SHARE_PK_PREFIX: Final = 'DOCSHARE#'
SHARE_SK: Final = 'META'
SHARE_ID_RE: Final = re.compile(r'^shr_[0-9a-f]{32}\Z')
MODE_ANYONE: Final = 'anyone'
MODE_LIST: Final = 'list'
MODES: Final = (MODE_ANYONE, MODE_LIST)
#: The field a routing row names its workspace in (shared/ws_repo.py ``WORKSPACE_FIELD``).
ROUTE_WORKSPACE_FIELD: Final = 'workspace_id'
#: ``ws_`` + a ULID: shared/workspace_ids.py's rule, spelled here for the stdlib-only bundle (a test pins the two).
WORKSPACE_ID_RE: Final = re.compile(r'ws_[0-7][0-9A-HJKMNP-TV-Z]{25}')
#: A review link kept in a workspace is refused by both its readers until the switch (3h): the reviewer routes
#: (shared/document_review_routes.py, ``NotPerWorkspaceError``) and the board pool's sign-up trigger
#: (auth/board_triggers.py, a refused sign-up), since a reviewer's account and writes would reach a workspace without
#: the status check every writer of a workspace's data makes. Both refusals name this store, so 3h lifts them together
#: (the trigger gaining that status check then).
REVIEWER_ROUTES_STORE: Final = 'Review link reviewers'


def is_share_id(value: object) -> TypeGuard[str]:
    return isinstance(value, str) and SHARE_ID_RE.match(value) is not None


def share_key(share_id: str) -> dict[str, str]:
    return {'pk': f'{SHARE_PK_PREFIX}{share_id}', 'sk': SHARE_SK}


def routing_of(item: object) -> tuple[dict[str, Any] | None, str | None]:
    """How a stored ``DOCSHARE#{id}`` row routes: ``(the row, None)`` for a row naming no workspace (the deployment's
    link); ``(None, workspace id)`` for a routing row; ``(None, None)`` for no row, or a row whose workspace field holds
    anything but a workspace id (refused, never read as the deployment's link)."""
    if not isinstance(item, dict):
        return None, None
    if ROUTE_WORKSPACE_FIELD not in item:
        return item, None
    workspace_id = item.get(ROUTE_WORKSPACE_FIELD)
    if isinstance(workspace_id, str) and WORKSPACE_ID_RE.fullmatch(workspace_id):
        return None, workspace_id
    return None, None


def routed_share(share_id: str, item: object) -> dict[str, Any] | None:
    """The row read from the routing row's workspace, only when it is the link of ``share_id`` (its ``share_id``
    field) and names no workspace itself; None otherwise (missing, another link's, or a routing row's shape)."""
    if not isinstance(item, dict) or item.get('share_id') != share_id or ROUTE_WORKSPACE_FIELD in item:
        return None
    return item


def _epoch(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int | Decimal):
        return 0
    return int(value)


def is_active(item: Mapping[str, Any] | None, now_epoch: int) -> bool:
    """A stored link that is neither revoked nor expired."""
    if not item or item.get('revoked') is True:
        return False
    return _epoch(item.get('expires_at_epoch')) > now_epoch


def _strings(value: object) -> frozenset[str]:
    if not isinstance(value, list | set | frozenset | tuple):
        return frozenset()
    return frozenset(entry.lower() for entry in value if isinstance(entry, str))


def audience_admits(audience: object, email_lc: str) -> bool:
    """Does ``audience`` admit the (lower-cased, verified) ``email_lc``? Unreadable = nobody."""
    if not isinstance(audience, Mapping) or email_lc.count('@') != 1:
        return False
    mode = audience.get('mode')
    if mode == MODE_ANYONE:
        return True
    if mode != MODE_LIST:
        return False
    domain = email_lc.rsplit('@', 1)[-1]
    return email_lc in _strings(audience.get('emails')) or domain in _strings(audience.get('domains'))


def share_admits(item: Mapping[str, Any] | None, email_lc: str, now_epoch: int) -> bool:
    """An active link whose audience admits ``email_lc``."""
    return is_active(item, now_epoch) and item is not None and audience_admits(item.get('audience'), email_lc)
