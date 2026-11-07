"""Refusals that keep a deployment administrable (tenet 4; docs/account-vs-admin.md → Users).

``api/users_handler.py`` refuses, for every client (SPA, assistant, MCP, a script):

* an administrator changing their OWN role, disabling or deleting their own account
  (409: another administrator has to do it), and
* demoting, disabling or deleting the LAST enabled administrator (409).

The SPA and the assistant check the same rules before asking, as UX; this module is
the rule. Pure: the handler passes in what Cognito answered.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Final

from shared.exceptions import ConflictError

ACTION_ROLE: Final = 'change the role of'
ACTION_DISABLE: Final = 'disable'
ACTION_DELETE: Final = 'delete'

LAST_ADMIN_MESSAGE: Final = (
    'This is the last enabled administrator: make another user an administrator first.'
)


def refuse_own_account(caller_sub: str, target_sub: str, action: str) -> None:
    """409 when the caller acts on their own account."""
    if caller_sub and caller_sub == target_sub:
        raise ConflictError(f'You cannot {action} your own account. Ask another administrator.')


def refuse_last_admin(target_username: str, admins: Iterable[Mapping[str, Any]]) -> None:
    """409 when ``target_username`` is the only enabled member of the admins group.

    ``admins`` is the group's membership as Cognito lists it (``Username``, ``Enabled``).
    A target outside the group is never the last administrator.
    """
    members = list(admins)
    if not any(m.get('Username') == target_username for m in members):
        return
    others = [m for m in members if m.get('Username') != target_username and m.get('Enabled', True) is not False]
    if not others:
        raise ConflictError(LAST_ADMIN_MESSAGE)
