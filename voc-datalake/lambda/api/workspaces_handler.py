"""
Workspaces API Lambda (voc-workspaces-api): the multi-workspace control plane (docs/multi-workspace.md).
Served under /me/{proxy+} (GET, POST, PUT and DELETE, every signed-in user, each route its own gate) and
/platform/{proxy+} (GET and POST, platform admins).

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

The members of the workspace X-Workspace-Id names (shared/workspace_members.py), each resolved like /current (400
without the header, the one 404 for a non-member; a platform admin enters as admin, live-checked and audited):
    GET /me/workspaces/current/members          {members: [{sub, role, email, name, invited_by, joined_at}],
                                                next_cursor}: any member; ?limit= (1-100, default 25), ?cursor=
    POST /me/workspaces/current/members         {email, role} -> 201 {member: {sub, role, email, name, invited_by,
                                                joined_at, account: 'existing'|'created'}}: workspace admins only
                                                (403 for an editor or a viewer; 403 for an email with no account
                                                unless the caller is in `admins`). 409 for a member already there,
                                                two accounts sharing the email, or the email spelt as another
                                                account's.
    PUT /me/workspaces/current/members/{sub}    {role} -> {member: {sub, role}}: workspace admins only; 409 for the
                                                last admin's demotion or a membership changed meanwhile.
    DELETE /me/workspaces/current/members/{sub} -> {removed: sub}: workspace admins, or the member themselves
                                                (leave); 409 for the last admin or a membership changed meanwhile.
The plugins of the workspace X-Workspace-Id names (shared/workspace_plugin_settings.py; the deployment's
plugins, ENABLED_SOURCES from cdk.context.json, are the ceiling), resolved the same way:
    GET /me/workspaces/current/plugins          {plugins: [{id, enabled, enabled_at?, enabled_by?}]}: any member,
                                                every plugin the deployment offers, in its order
    PUT /me/workspaces/current/plugins/{id}     {enabled} -> {plugin: {id, enabled, ...}}: workspace admins only
                                                (after the 404 and the body's 400, an enable is 409 for
                                                everyone until PER_WORKSPACE_INGESTION is on);
                                                404 for a plugin the deployment does not offer; audited first.
Each write resolves the caller's role from the table, never the 30 s cache (a demoted admin cannot undo it), commits
only while the acting admin is still admin (a check in its transaction: 403 when they were demoted meanwhile), writes
its AUDIT#WS#{ws} row first, and drops the changed member's cached membership in this container (other containers
serve it for up to 30 s, to reads only).

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

from shared.api import api_handler, create_api_resolver, get_caller_subject, is_admin, require_admin
from shared.aws import get_cognito_idp_client, get_dynamodb_resource, get_secrets_client
from shared.enabled_sources import enabled_plugin_ids
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
from shared.workspace import (
    MembershipCache,
    WorkspaceContext,
    list_my_workspaces,
    require_workspace_admin,
    resolve_workspace,
)
from shared.workspace_members import (
    MemberAccountError,
    add_member,
    audit_account_creation,
    change_role,
    find_or_create_account,
    list_members,
    member_sub,
    parse_new_member,
    parse_role_change,
    remove_member,
)
from shared.workspace_plugin_settings import (
    offered_plugin,
    parse_plugin_change,
    set_plugin_enabled,
    workspace_plugins,
)

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
FAILED_MEMBERS = 'Failed to list the members'
FAILED_ADD_MEMBER = 'Failed to add the member'
FAILED_CHANGE_ROLE = "Failed to change the member's role"
FAILED_REMOVE_MEMBER = 'Failed to remove the member'
FAILED_PLUGINS = "Failed to list the workspace's plugins"
FAILED_CHANGE_PLUGIN = 'Failed to change the plugin'

app = create_api_resolver()
# The warm container's resolved memberships (30 s, shared/workspace.py).
memberships = MembershipCache()


def get_workspaces_table() -> Any:
    """The voc-workspaces table resource, or 500 when the deployment did not configure it."""
    if not WORKSPACES_TABLE:
        raise ConfigurationError('Workspaces table not configured')
    return cached_table(get_dynamodb_resource(), WORKSPACES_TABLE)


def _user_pool() -> str:
    """The user pool id, or 500 when the deployment did not configure it."""
    if not USER_POOL_ID:
        raise ConfigurationError('User pool not configured')
    return USER_POOL_ID


def _confirm_platform_admin(event: dict) -> bool:
    """The live platform-admin check (shared/platform_admin.py); a Cognito fault raises."""
    return is_live_platform_admin(event, get_cognito_idp_client(), _user_pool())


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


def _workspace(event: dict, public_error: str, *, fresh: bool = False) -> WorkspaceContext:
    """The workspace X-Workspace-Id names and the caller's role there (shared/workspace.py); a fault answers
    ``public_error`` (500). ``fresh`` (the members writes): resolved from the table, never from the warm cache, so an
    admin demoted or removed a moment ago in another container cannot undo it (a platform admin's write is then
    audited as an entry each time)."""
    try:
        return resolve_workspace(get_workspaces_table(), event, MembershipCache() if fresh else memberships,
                                 confirm_platform_admin=_confirm_platform_admin)
    except (ClientError, BotoCoreError) as exc:
        # A failed read, a failed live platform-admin check, or an entry audit row that could not be written: the
        # entry is refused, the AWS error (table, key, account) stays in the log.
        logger.exception('Error resolving the workspace')
        raise ServiceError(public_error) from exc


@app.get('/me/workspaces/current')
def current_workspace() -> dict:
    context = _workspace(app.current_event.raw_event, FAILED_CURRENT)
    return {'workspace': {
        'id': context.ws, 'name': context.name, 'slug': context.slug, 'role': context.role,
        'platform_admin': context.platform_admin,
    }}


@app.get('/me/workspaces/current/members')
def workspace_members() -> dict:
    context = _workspace(app.current_event.raw_event, FAILED_MEMBERS)
    params = app.current_event.query_string_parameters or {}
    try:
        members, next_cursor = list_members(
            get_workspaces_table(), context.ws, limit=parse_limit(params.get('limit')),
            cursor=params.get('cursor') or None, cognito=get_cognito_idp_client(), user_pool_id=_user_pool())
    except ValueError as exc:
        raise ValidationError('limit or cursor is not valid') from exc
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error listing the workspace members')
        raise ServiceError(FAILED_MEMBERS) from exc
    return {'members': members, 'next_cursor': next_cursor}


@app.post('/me/workspaces/current/members')
def add_workspace_member():  # a Response: the resolver validates a return annotation, so none here
    event = app.current_event.raw_event
    # The body first: a bad one is refused before a platform admin's entry writes its audit row (the 400 says
    # nothing about the workspace).
    new = parse_new_member(json_object_body(app))
    context = _workspace(event, FAILED_ADD_MEMBER, fresh=True)
    require_workspace_admin(context)
    table = get_workspaces_table()
    try:
        # A new account only for a deployment administrator (platform admins are ones): until the data path is keyed
        # by workspace, every account reads the whole deployment (shared/workspace_members.py).
        actor = get_caller_subject(event)
        account = find_or_create_account(
            get_cognito_idp_client(), _user_pool(), new.email, may_create=is_admin(event),
            # A new account is recorded before it exists, so a failed add never leaves one unrecorded (D4).
            before_create=lambda: audit_account_creation(table, context, actor, new.email))
        member = add_member(table, context, account, new.role, actor)
    except (ClientError, BotoCoreError, MemberAccountError) as exc:
        # A Cognito fault, a failed audit row (nothing added) or a failed transaction.
        logger.exception('Error adding a workspace member')
        raise ServiceError(FAILED_ADD_MEMBER) from exc
    memberships.invalidate(context.ws, account.sub)
    body = {'member': {**member, 'account': 'created' if account.created else 'existing'}}
    return Response(status_code=201, content_type=content_types.APPLICATION_JSON, body=json.dumps(body))


@app.put('/me/workspaces/current/members/<sub>')
def change_workspace_member_role(sub: str) -> dict:
    event = app.current_event.raw_event
    target = member_sub(sub)
    role = parse_role_change(json_object_body(app))
    context = _workspace(event, FAILED_CHANGE_ROLE, fresh=True)
    require_workspace_admin(context)
    try:
        member = change_role(get_workspaces_table(), context, target, role, get_caller_subject(event))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error changing a workspace member role')
        raise ServiceError(FAILED_CHANGE_ROLE) from exc
    memberships.invalidate(context.ws, target)
    return {'member': member}


@app.delete('/me/workspaces/current/members/<sub>')
def remove_workspace_member(sub: str) -> dict:
    event = app.current_event.raw_event
    target = member_sub(sub)
    context = _workspace(event, FAILED_REMOVE_MEMBER, fresh=True)
    caller = get_caller_subject(event)
    # A member may leave (remove themselves); removing anyone else is for the workspace's admins.
    if target != caller:
        require_workspace_admin(context)
    try:
        remove_member(get_workspaces_table(), context, target, caller)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error removing a workspace member')
        raise ServiceError(FAILED_REMOVE_MEMBER) from exc
    memberships.invalidate(context.ws, target)
    return {'removed': target}


@app.get('/me/workspaces/current/plugins')
def workspace_plugin_list() -> dict:
    context = _workspace(app.current_event.raw_event, FAILED_PLUGINS)
    try:
        plugins = workspace_plugins(get_workspaces_table(), context.ws, enabled_plugin_ids())
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error listing the workspace plugins')
        raise ServiceError(FAILED_PLUGINS) from exc
    return {'plugins': plugins}


@app.put('/me/workspaces/current/plugins/<plugin_id>')
def change_workspace_plugin(plugin_id: str) -> dict:
    event = app.current_event.raw_event
    # The plugin and the body first: refused before a platform admin's entry writes its audit row.
    plugin = offered_plugin(plugin_id, enabled_plugin_ids())
    enabled = parse_plugin_change(json_object_body(app))
    context = _workspace(event, FAILED_CHANGE_PLUGIN, fresh=True)
    require_workspace_admin(context)
    try:
        entry = set_plugin_enabled(get_workspaces_table(), context, plugin, enabled, get_caller_subject(event))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error changing a workspace plugin')
        raise ServiceError(FAILED_CHANGE_PLUGIN) from exc
    return {'plugin': entry}


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
