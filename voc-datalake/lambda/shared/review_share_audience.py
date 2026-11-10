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


def is_share_id(value: object) -> TypeGuard[str]:
    return isinstance(value, str) and SHARE_ID_RE.match(value) is not None


def share_key(share_id: str) -> dict[str, str]:
    return {'pk': f'{SHARE_PK_PREFIX}{share_id}', 'sk': SHARE_SK}


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
