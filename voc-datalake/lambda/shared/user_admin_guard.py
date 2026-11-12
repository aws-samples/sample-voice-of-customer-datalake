"""Refusals that keep a deployment administrable (tenet 4; docs/account-vs-admin.md → Users).

``api/users_handler.py`` refuses, for every client (SPA, assistant, MCP, a script):

* an administrator changing their OWN role, disabling or deleting their own account
  (409: another administrator has to do it), and
* demoting, disabling or deleting the LAST enabled administrator (409);
* demoting, disabling, enabling, deleting or resetting the password of a member of
  ``platform-admins`` by a caller who is not one (403), and
* demoting, disabling, deleting or revoking the LAST enabled platform admin (409).

The SPA and the assistant check the same rules before asking, as UX; this module is
the rule. Pure: the handler passes in what Cognito answered.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Final

from shared.exceptions import AuthorizationError, ConflictError

ACTION_ROLE: Final = 'change the role of'
ACTION_DISABLE: Final = 'disable'
ACTION_ENABLE: Final = 'enable'
ACTION_DELETE: Final = 'delete'
ACTION_RESET_CREDENTIAL: Final = 'reset the password of'

LAST_ADMIN_MESSAGE: Final = (
    'This is the last enabled administrator: make another user an administrator first.'
)
LAST_PLATFORM_ADMIN_MESSAGE: Final = (
    'This is the last enabled platform admin: make another administrator a platform admin first.'
)


def refuse_own_account(caller_sub: str, target_sub: str, action: str) -> None:
    """409 when the caller acts on their own account."""
    if caller_sub and caller_sub == target_sub:
        raise ConflictError(f'You cannot {action} your own account. Ask another administrator.')


def _refuse_last_enabled(target_username: str, members: Iterable[Mapping[str, Any]], message: str) -> None:
    """409 ``message`` when ``target_username`` is the only enabled one of ``members`` (``Username``, ``Enabled``,
    as Cognito lists a group). A target outside the group is never its last member."""
    listed = list(members)
    if not any(m.get('Username') == target_username for m in listed):
        return
    others = [m for m in listed if m.get('Username') != target_username and m.get('Enabled', True) is not False]
    if not others:
        raise ConflictError(message)


def refuse_last_admin(target_username: str, admins: Iterable[Mapping[str, Any]]) -> None:
    """409 when ``target_username`` is the only enabled member of the admins group."""
    _refuse_last_enabled(target_username, admins, LAST_ADMIN_MESSAGE)


def refuse_last_platform_admin(target_username: str, platform_admins: Iterable[Mapping[str, Any]]) -> None:
    """409 when ``target_username`` is the only enabled member of ``platform-admins`` (the caller included: a
    platform admin cannot revoke, demote, disable or delete themselves as the last one)."""
    _refuse_last_enabled(target_username, platform_admins, LAST_PLATFORM_ADMIN_MESSAGE)


def refuse_platform_admin_target(caller_is_platform_admin: bool, action: str) -> None:
    """403 when a caller outside ``platform-admins`` acts on a member of it."""
    if not caller_is_platform_admin:
        raise AuthorizationError(f'Only a platform admin can {action} a platform admin.')
