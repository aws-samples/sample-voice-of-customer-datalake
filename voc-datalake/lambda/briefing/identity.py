"""Who a brief is built for, re-checked in Cognito on every build.

A brief reads as its reader: the scope comes from their CURRENT groups (an admin who
was demoted gets a restricted brief at once) and a disabled or deleted account gets
none. A directory fault raises ``DirectoryUnavailable`` so the queue retries the build.
"""
from __future__ import annotations

import os
from typing import Any, Final

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from briefing.todos import Reader
from shared import user_flags
from shared.logging import logger
from shared.project_access import ADMIN_GROUP

USER_POOL_ENV: Final = 'USER_POOL_ID'
_GROUPS_PAGE: Final = 60

_client: dict[str, Any] = {}


class DirectoryUnavailable(Exception):
    """Cognito could not answer; the build is retried."""


def _cognito() -> Any:
    if 'cognito' not in _client:
        _client['cognito'] = boto3.client('cognito-idp')
    return _client['cognito']


def _call(operation: str, **kwargs: Any) -> dict | None:
    """The directory answer, None for "no such user"."""
    pool = os.environ.get(USER_POOL_ENV, '')
    if not pool:
        raise DirectoryUnavailable('USER_POOL_ID is not configured')
    try:
        return getattr(_cognito(), operation)(UserPoolId=pool, **kwargs)
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') == 'UserNotFoundException':
            return None
        logger.exception('Brief reader lookup failed', extra={'operation': operation})
        raise DirectoryUnavailable(operation) from exc
    except BotoCoreError as exc:
        raise DirectoryUnavailable(operation) from exc


def lookup_reader(username: str, sub: str, aggregates_table: Any) -> Reader | None:
    """The reader as Cognito knows them now; None when the account is gone, disabled or not theirs."""
    if not username or not sub:
        return None
    user = _call('admin_get_user', Username=username)
    if user is None or not user.get('Enabled', False):
        return None
    attributes = {a.get('Name'): a.get('Value') for a in user.get('UserAttributes', []) if isinstance(a, dict)}
    if attributes.get('sub') != sub:
        return None
    groups_page = _call('admin_list_groups_for_user', Username=username, Limit=_GROUPS_PAGE) or {}
    groups = {g.get('GroupName') for g in groups_page.get('Groups', []) if isinstance(g, dict)}
    is_admin = ADMIN_GROUP in groups
    name = attributes.get('name') or attributes.get('given_name') or ''
    return Reader(sub=sub, username=username, name=str(name), is_admin=is_admin,
                  is_curator=is_admin or user_flags.is_memory_reviewer(aggregates_table, sub))
