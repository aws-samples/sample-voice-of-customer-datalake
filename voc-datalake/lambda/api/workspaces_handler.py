"""
Workspaces API Lambda (voc-workspaces-api): the multi-workspace control plane (docs/multi-workspace.md).
Served under /me/{proxy+} (GET, every signed-in user) and /platform/{proxy+} (GET and POST, platform admins).

Routes:
    GET /me/workspaces          {workspaces: [{id, name, slug, role}]}: the caller's own workspaces, by name
                                (one Query of the caller's USER#{sub} partition, shared/workspace.py); each
                                role is the membership row's, while /current answers the effective one
    GET /me/workspaces/current  {workspace: {id, name, slug, role, platform_admin}}: the workspace the
                                X-Workspace-Id header names, as the caller may act in it. 400 without the
                                header; 404 for a malformed id, a missing or deleting workspace, or a caller
                                who is not a member. A platform admin who is not a member admin enters as admin
                                when the live check confirms them, and the entry is audited (shared/workspace.py
                                resolve_workspace); an entry whose audit row cannot be written is refused.
    POST /platform/workspaces   {name, slug} -> 201 {workspace: {id, name, slug, role: 'admin', secret_status}}:
                                a new workspace with the caller as its admin, in one transaction, then its
                                credentials secret (shared/platform_workspaces.py). 400 for a bad name or slug,
                                409 for a slug that is taken; secret_status 'pending' when the secret could not
                                be made (logged; the workspace stays, its META says so).
    GET /platform/workspaces    {workspaces: [{id, name, slug, status, created_at, secret_status}], next_cursor}: every
                                workspace by name, ?limit= (1-100, default 25) and ?cursor= (one Query of the
                                listing partition, never a Scan).

The /platform routes are for platform admins only: an administrator (``require_admin``), the token's
``platform-admins`` group (``require_platform_admin``), then the live check (shared/platform_admin.py: the live
Cognito membership and an enabled account), so a revoked or disabled platform admin is refused (403) at once.

A DynamoDB, Cognito or Secrets Manager fault answers a fixed 500, never the AWS error text, which is logged.
"""

import json
import os
from typing import Any

from aws_lambda_powertools.event_handler import Response, content_types
from botocore.exceptions import BotoCoreError, ClientError

from shared.api import api_handler, create_api_resolver, get_caller_subject, require_admin
from shared.aws import get_cognito_idp_client, get_dynamodb_resource, get_secrets_client
from shared.exceptions import AuthorizationError, ConfigurationError, ServiceError, ValidationError
from shared.import_runs import parse_limit
from shared.logging import logger
from shared.platform_admin import is_live_platform_admin, require_platform_admin
from shared.platform_workspaces import (
    CREDENTIALS_PENDING,
    CREDENTIALS_READY,
    CredentialsSecretError,
    create_workspace,
    ensure_credentials_secret,
    list_workspaces,
    mark_secret_ready,
    parse_new_workspace,
)
from shared.request_body import json_object_body
from shared.tables import cached_table
from shared.warm_init import warm_at_init
from shared.workspace import MembershipCache, list_my_workspaces, resolve_workspace

WORKSPACES_TABLE = os.environ.get('WORKSPACES_TABLE', '')
USER_POOL_ID = os.environ.get('USER_POOL_ID', '')
# The customer-managed key and the name prefix of the per-workspace credentials secrets (voc/ws, or
# <deployment prefix>-voc/ws): lib/stacks/api-workspaces-lambda.ts.
KMS_KEY_ARN = os.environ.get('KMS_KEY_ARN', '')
WORKSPACE_SECRET_PREFIX = os.environ.get('WORKSPACE_SECRET_PREFIX', '')
# The fixed answers of a fault (#263: never the AWS text).
FAILED_LIST = 'Failed to list your workspaces'
FAILED_CURRENT = 'Failed to open the workspace'
FAILED_CREATE = 'Failed to create the workspace'
FAILED_PLATFORM_LIST = 'Failed to list the workspaces'

app = create_api_resolver()
# The warm container's resolved memberships (30 s, shared/workspace.py).
memberships = MembershipCache()


def get_workspaces_table() -> Any:
    """The voc-workspaces table resource, or 500 when the deployment did not configure it."""
    if not WORKSPACES_TABLE:
        raise ConfigurationError('Workspaces table not configured')
    return cached_table(get_dynamodb_resource(), WORKSPACES_TABLE)


def _confirm_platform_admin(event: dict) -> bool:
    """The live platform-admin check (shared/platform_admin.py); a Cognito fault raises."""
    if not USER_POOL_ID:
        raise ConfigurationError('User pool not configured')
    return is_live_platform_admin(event, get_cognito_idp_client(), USER_POOL_ID)


def _require_live_platform_admin(event: dict, public_error: str) -> None:
    """403 unless the caller is a platform admin now; a failed look-up answers ``public_error`` (500)."""
    try:
        confirmed = _confirm_platform_admin(event)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error checking the caller platform admin membership')
        raise ServiceError(public_error) from exc
    if not confirmed:
        raise AuthorizationError('Platform admin access required')


@app.get('/me/workspaces')
def my_workspaces() -> dict:
    sub = get_caller_subject(app.current_event.raw_event)
    try:
        workspaces = list_my_workspaces(get_workspaces_table(), sub)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error listing my workspaces')
        raise ServiceError(FAILED_LIST) from exc
    return {'workspaces': workspaces}


@app.get('/me/workspaces/current')
def current_workspace() -> dict:
    try:
        context = resolve_workspace(get_workspaces_table(), app.current_event.raw_event, memberships,
                                    confirm_platform_admin=_confirm_platform_admin)
    except (ClientError, BotoCoreError) as exc:
        # A failed read, a failed live platform-admin check, or an entry audit row that could not be written: the
        # entry is refused, the AWS error (table, key, account) stays in the log.
        logger.exception('Error resolving the workspace')
        raise ServiceError(FAILED_CURRENT) from exc
    return {'workspace': {
        'id': context.ws, 'name': context.name, 'slug': context.slug, 'role': context.role,
        'platform_admin': context.platform_admin,
    }}


def _credentials_secret_status(table: Any, ws: str, name: str) -> str:
    """Create the workspace's credentials secret and mark it ready; ``pending`` (logged) when that fails."""
    try:
        ensure_credentials_secret(get_secrets_client(), prefix=WORKSPACE_SECRET_PREFIX, ws=ws,
                                  kms_key_arn=KMS_KEY_ARN)
        mark_secret_ready(table, ws, name)
    except (ClientError, BotoCoreError, CredentialsSecretError):
        logger.exception('Workspace created without its credentials secret: secret_status stays pending',
                         extra={'workspace_id': ws})
        return CREDENTIALS_PENDING
    return CREDENTIALS_READY


@app.post('/platform/workspaces')
def create_platform_workspace():  # a Response: the resolver validates a return annotation, so none here
    event = app.current_event.raw_event
    require_admin(event)
    require_platform_admin(event)
    _require_live_platform_admin(event, FAILED_CREATE)
    new = parse_new_workspace(json_object_body(app))
    if not (KMS_KEY_ARN and WORKSPACE_SECRET_PREFIX):
        # Refused before anything is written: a workspace must be able to get its secret.
        raise ConfigurationError('Workspace credentials not configured')
    table = get_workspaces_table()
    try:
        ws = create_workspace(table, new, get_caller_subject(event))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error creating a workspace')
        raise ServiceError(FAILED_CREATE) from exc
    workspace = {'id': ws, 'name': new.name, 'slug': new.slug, 'role': 'admin',
                 'secret_status': _credentials_secret_status(table, ws, new.name)}
    return Response(status_code=201, content_type=content_types.APPLICATION_JSON,
                    body=json.dumps({'workspace': workspace}))


@app.get('/platform/workspaces')
def list_platform_workspaces() -> dict:
    event = app.current_event.raw_event
    require_admin(event)
    require_platform_admin(event)
    _require_live_platform_admin(event, FAILED_PLATFORM_LIST)
    params = app.current_event.query_string_parameters or {}
    try:
        workspaces, next_cursor = list_workspaces(get_workspaces_table(), limit=parse_limit(params.get('limit')),
                                                  cursor=params.get('cursor') or None)
    except ValueError as exc:
        raise ValidationError('limit or cursor is not valid') from exc
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error listing the workspaces')
        raise ServiceError(FAILED_PLATFORM_LIST) from exc
    return {'workspaces': workspaces, 'next_cursor': next_cursor}


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource)


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
