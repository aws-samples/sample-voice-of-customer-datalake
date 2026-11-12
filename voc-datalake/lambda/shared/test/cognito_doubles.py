"""A Cognito double for the live platform-admin check (shared/platform_admin.py ``is_live_platform_admin``)."""
from collections.abc import Iterable
from unittest.mock import MagicMock


def live_cognito(groups: Iterable[str] = ('admins', 'platform-admins'), *, enabled: bool = True,
                 missing: bool = False, sub: str = 'sub-pat') -> MagicMock:
    """The caller's live groups (``AdminListGroupsForUser``), enabled state and ``sub`` (``AdminGetUser``; the tests'
    platform admin is ``pat`` / ``sub-pat``), or, with ``missing``, an unknown user; ``exceptions.UserNotFoundException``
    is a real class, as the check catches it."""
    cognito = MagicMock()
    cognito.exceptions.UserNotFoundException = type('UserNotFoundException', (Exception,), {})
    if missing:
        cognito.admin_list_groups_for_user.side_effect = cognito.exceptions.UserNotFoundException
    cognito.admin_list_groups_for_user.return_value = {'Groups': [{'GroupName': group} for group in groups]}
    cognito.admin_get_user.return_value = {'Username': 'pat', 'Enabled': enabled,
                                           'UserAttributes': [{'Name': 'sub', 'Value': sub}]}
    return cognito
