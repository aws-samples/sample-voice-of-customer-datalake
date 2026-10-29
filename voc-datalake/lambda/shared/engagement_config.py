"""The engagement Lambda's environment (voc-engagement-api), read at call time.

    PARTICIPANTS_TABLE      voc-participants (people, lists, asks, tokens, settings)
    FEATURE_REQUESTS_TABLE  voc-feature-requests
    EMAIL_FROM              the verified SES sender; '' = email sending is off
    FRONTEND_URL            https://<frontendDomain> (unsubscribe page, board link)
    APP_USER_POOL_ID        the app's Cognito user pool (board callers from it may be admins)
    BOARD_USER_POOL_ID      the board's own pool; '' when it is not deployed
    ENGAGEMENT_FUNCTION     this function's own name (the async send continuation)

AGGREGATES_TABLE (brand name, form configs) and PROJECTS_TABLE (project access) are
read through ``shared.tables`` like every API Lambda.
"""
from __future__ import annotations

import os
from functools import lru_cache
from typing import Any, Final

from shared.aws import get_dynamodb_resource
from shared.exceptions import ConfigurationError
from shared.tables import get_aggregates_table

PARTICIPANTS_TABLE_ENV: Final = 'PARTICIPANTS_TABLE'
FEATURE_REQUESTS_TABLE_ENV: Final = 'FEATURE_REQUESTS_TABLE'
BRAND_KEY: Final = {'pk': 'SETTINGS#brand', 'sk': 'config'}


@lru_cache(maxsize=8)
def _table(resource: Any, name: str) -> Any:
    return resource.Table(name)


def _required_table(env: str) -> Any:
    name = os.environ.get(env, '')
    if not name:
        raise ConfigurationError(f'{env} not configured')
    return _table(get_dynamodb_resource(), name)


def participants_table() -> Any:
    return _required_table(PARTICIPANTS_TABLE_ENV)


def feature_requests_table() -> Any:
    return _required_table(FEATURE_REQUESTS_TABLE_ENV)


def email_from() -> str:
    return os.environ.get('EMAIL_FROM', '').strip()


def frontend_url() -> str:
    return os.environ.get('FRONTEND_URL', '').rstrip('/')


def app_pool_id() -> str:
    return os.environ.get('APP_USER_POOL_ID', '')


def board_pool_id() -> str:
    return os.environ.get('BOARD_USER_POOL_ID', '')


def engagement_function() -> str:
    return os.environ.get('ENGAGEMENT_FUNCTION', '')


def brand_name() -> str:
    """The deployment's brand name (Administration -> General), '' when unset or unreadable."""
    table = get_aggregates_table()
    if table is None:
        return ''
    item = table.get_item(Key=BRAND_KEY).get('Item') or {}
    name = item.get('brand_name')
    return name.strip() if isinstance(name, str) else ''
