"""The live platform-admin gate of a route that changes what the whole deployment shares (docs/multi-workspace.md,
"Per-workspace configuration": the deployment kinds of settings are a platform admin's, decision 7).

A route calls, in this order, each an unconditional statement of its body (lambda/api/test/test_route_admin_gates.py
looks for all three): ``require_admin`` (shared/api.py), ``require_platform_admin`` (the token's ``platform-admins``
group, shared/platform_admin.py) and ``require_live_platform_admin`` (below): the live Cognito membership and an
enabled account of the same person (``is_live_platform_admin``), so a revoked or disabled platform admin is refused at
once, not when the token expires. The Lambda needs ``USER_POOL_ID`` and Cognito ``AdminListGroupsForUser`` and
``AdminGetUser`` on the pool.

``confirm_live_platform_admin`` is that live check alone, in the pool ``USER_POOL_ID`` names: also the check a domain
API's workspace resolution runs before a platform admin enters (shared/request_workspace.py). The workspaces API
(lambda/api/workspaces_handler.py) uses both since 6.18.00, for its /platform routes and its workspace entries; its
own resolution (``_workspace``) stays, since it answers 400 without the header where shared/request_workspace.py
answers the deployment as before.
"""
from __future__ import annotations

import os

from botocore.exceptions import BotoCoreError, ClientError

from shared.aws import get_cognito_idp_client
from shared.exceptions import AuthorizationError, ConfigurationError, ServiceError
from shared.logging import logger
from shared.platform_admin import is_live_platform_admin

__all__ = ['confirm_live_platform_admin', 'require_live_platform_admin']


def confirm_live_platform_admin(event: dict) -> bool:
    """Whether the caller is a platform admin now, in the pool ``USER_POOL_ID`` names (``ConfigurationError``
    without it); a Cognito fault raises."""
    user_pool_id = os.environ.get('USER_POOL_ID', '')
    if not user_pool_id:
        raise ConfigurationError('User pool not configured')
    return is_live_platform_admin(event, get_cognito_idp_client(), user_pool_id)


def require_live_platform_admin(event: dict, public_error: str) -> None:
    """403 unless the caller is a platform admin now; 500 ``ConfigurationError`` without ``USER_POOL_ID``; a failed
    Cognito look-up answers ``public_error`` (500, the AWS text only in the log) and admits nobody."""
    try:
        confirmed = confirm_live_platform_admin(event)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error checking the caller platform admin membership')
        raise ServiceError(public_error) from exc
    if not confirmed:
        raise AuthorizationError('Platform admin access required')
