"""
User Administration API Lambda - Handles /users/*

Provides Cognito user management for admins:
- List users
- Create users
- Update user groups (admins/users)
- Reset passwords
- Enable/disable users
- Grant and revoke the ``platform-admins`` group (``PUT /users/{username}/platform-admin``)

Only accessible by users in the 'admins' group, except ``GET /users/me/ai-mode``
(the caller's own way of working with AI, docs/ways-of-working.md). A member of
``platform-admins`` is managed by platform admins only (docs/multi-workspace.md →
Control plane; the rules in shared/user_admin_guard.py): the platform-admin route,
and demoting, disabling, enabling, deleting or resetting the password of a platform
admin, answer 403 to anyone else; no request may leave zero enabled platform admins
(409). Every grant and revoke (a demotion and a delete of a platform admin too)
writes an ``AUDIT#platform-admins`` row in voc-aggregates before the change.

Deleting a user also removes their workspace memberships in voc-workspaces
(docs/multi-workspace.md → Invites; shared/workspace_members.py ``plan_user_removal``
and ``remove_user_memberships``), BEFORE ``AdminDeleteUser``, so a refusal or a
fault leaves the account as it was: the last admin of a workspace is refused (409)
unless the caller is a platform admin.
"""
import os
import secrets
import uuid
from collections.abc import Callable
from typing import Any, Final

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from shared import ai_mode, category_access, user_admin_guard, user_flags, workspace_members
from shared.api import (
    DEFAULT_CATEGORIES,
    api_handler,
    create_api_resolver,
    get_caller_subject,
    require_admin,
    validate_bool,
)
from shared.audit_rows import put_new_audit_row
from shared.aws import get_dynamodb_resource
from shared.category_gate import read_categories_config
from shared.concurrency import concurrently, ordered_map
from shared.data_version import bump_config_version
from shared.exceptions import (
    ApiError,
    AuthorizationError,
    ConfigurationError,
    ConflictError,
    NotFoundError,
    ServiceError,
    ValidationError,
)
from shared.logging import logger, tracer
from shared.platform_admin import PLATFORM_ADMIN_GROUP, is_live_platform_admin, require_platform_admin
from shared.project_access import ADMIN_GROUP
from shared.request_body import json_body_value, json_object_body
from shared.source_profiles import load_source_profiles
from shared.timestamps import now_iso

# AWS Clients
cognito = boto3.client('cognito-idp')

# Configuration
USER_POOL_ID = os.environ.get('USER_POOL_ID', '')
AGGREGATES_TABLE = os.environ.get('AGGREGATES_TABLE', '')
aggregates_table = get_dynamodb_resource().Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None
# voc-workspaces: a deleted user's memberships go with them (delete_user). The stack always sets it.
WORKSPACES_TABLE = os.environ.get('WORKSPACES_TABLE', '')
workspaces_table = get_dynamodb_resource().Table(WORKSPACES_TABLE) if WORKSPACES_TABLE else None

# Client-facing text for an unexpected Cognito failure (#263, after PR #403).
# Each was `ServiceError(str(e))`, and `shared/api.py` returns that message
# verbatim — publishing the user pool id, API name and request id. The detail is
# logged with `logger.exception` instead. Each route also re-raises `ApiError`
# ahead of its catch-all so a typed 4xx raised inside keeps its status.
USER_GROUP: Final = 'users'
# The two Cognito groups a user's role is: exactly one of them at a time.
ROLE_GROUPS: Final = (ADMIN_GROUP, USER_GROUP)

FAILED_LIST_USERS = 'Failed to list users'
FAILED_CREATE_USER = 'Failed to create user'
FAILED_UPDATE_USER = 'Failed to update user'
FAILED_UPDATE_GROUP = 'Failed to update user group'
FAILED_RESET_CREDENTIAL = 'Failed to reset password'
FAILED_ENABLE_USER = 'Failed to enable user'
FAILED_DISABLE_USER = 'Failed to disable user'
FAILED_DELETE_USER = 'Failed to delete user'
FAILED_UPDATE_PLATFORM_ADMIN = 'Failed to update platform admin membership'
# The audit trail of platform-admin membership (voc-aggregates; the audit-row guard,
# lib/utils/audit-row-guard.ts, lets this role put only this partition and no role change one).
PLATFORM_ADMIN_AUDIT_PK: Final = 'AUDIT#platform-admins'
PLATFORM_ADMIN_GRANT: Final = 'platform_admin_grant'
PLATFORM_ADMIN_REVOKE: Final = 'platform_admin_revoke'
# Cognito ListUsersInGroup calls GET /users makes at once. The pool has two
# groups today; the cap keeps a pool with many groups well under Cognito's
# per-account list-operation quota.
MAX_PARALLEL_GROUP_LISTINGS = 4

app = create_api_resolver()


# Admin gating uses the shared require_admin/get_caller_groups (shared/api.py):
# same semantics as the old local copy, plus handling for the REST-authorizer
# bracket-wrapped groups claim ("[admins, users]") the local copy missed.


def _paged(operation: Callable[..., dict], items_key: str, **params: Any) -> list[dict]:
    """Every item of a Cognito list call, following `NextToken` / `PaginationToken`.

    The two spellings are Cognito's: `ListUsers` pages with `PaginationToken`,
    `ListGroups` and `ListUsersInGroup` with `NextToken`.
    """
    items: list[dict] = []
    token_param: dict[str, str] = {}
    while True:
        response = operation(**params, **token_param)
        items.extend(response.get(items_key, []))
        # Only a non-empty string is a token: anything else ends the walk rather
        # than looping on it.
        next_token = response.get('NextToken')
        pagination_token = response.get('PaginationToken')
        if isinstance(next_token, str) and next_token:
            token_param = {'NextToken': next_token}
        elif isinstance(pagination_token, str) and pagination_token:
            token_param = {'PaginationToken': pagination_token}
        else:
            return items


def _groups_by_username() -> dict[str, list[str]]:
    """Each user's group names, from one membership listing per GROUP.

    `GET /users` used to call `AdminListGroupsForUser` once per user, serially —
    13 users meant 13 round-trips before the response (E2E F10: p95 ~3.8 s). The
    pool has a handful of groups (`admins`, `users`), so listing each group's
    members costs a constant few calls however many users there are. Groups are
    listed in `ListGroups` order, which is what each user's `groups` array keeps.
    """
    memberships: dict[str, list[str]] = {}
    groups = [group['GroupName'] for group in _paged(cognito.list_groups, 'Groups', UserPoolId=USER_POOL_ID, Limit=60)]
    # One paged listing per group, all groups at once; `ordered_map` keeps
    # ListGroups order, which each user's `groups` array preserves.
    members_by_group = ordered_map(
        lambda name: _paged(cognito.list_users_in_group, 'Users', UserPoolId=USER_POOL_ID, GroupName=name, Limit=60),
        groups, max_workers=MAX_PARALLEL_GROUP_LISTINGS)
    for name, members in zip(groups, members_by_group, strict=True):
        for member in members:
            memberships.setdefault(member['Username'], []).append(name)
    return memberships


def _user_row(user: dict, groups: list[str]) -> dict:
    """The wire shape of one listed user."""
    attrs = {attr['Name']: attr['Value'] for attr in user.get('Attributes', [])}
    return {
        'username': user['Username'],
        # The stable Cognito subject: category owners and category
        # access rows are keyed by it (the owner picker needs it).
        'sub': attrs.get('sub', ''),
        'email': attrs.get('email', ''),
        'name': attrs.get('name', ''),
        'given_name': attrs.get('given_name', ''),
        'family_name': attrs.get('family_name', ''),
        'status': user['UserStatus'],
        'enabled': user['Enabled'],
        'groups': groups,
        'platform_admin': PLATFORM_ADMIN_GROUP in groups,
        'created_at': user['UserCreateDate'].isoformat() if user.get('UserCreateDate') else None,
        'last_modified': user['UserLastModifiedDate'].isoformat() if user.get('UserLastModifiedDate') else None,
    }


@app.get('/users')
@tracer.capture_method
def list_users():
    """List all users in the Cognito User Pool, each with its groups."""
    require_admin(app.current_event.raw_event)

    try:
        # The membership walk and the user listing are independent Cognito
        # reads, so they overlap rather than queue (each pages serially).
        groups_of, listed = concurrently(
            _groups_by_username,
            lambda: _paged(cognito.list_users, 'Users', UserPoolId=USER_POOL_ID, Limit=60),
        )
        users = [_user_row(user, groups_of.get(user['Username'], [])) for user in listed]
        _attach_flags(users)

    except ApiError:
        raise
    except Exception as e:
        logger.exception('Error listing users')
        raise ServiceError(FAILED_LIST_USERS) from e
    return {'success': True, 'users': users}


@app.post('/users')
@tracer.capture_method
def create_user():
    """Create a new user in Cognito."""
    require_admin(app.current_event.raw_event)

    body = json_object_body(app)
    email = body.get('email', '').strip()
    name = body.get('name', '').strip()
    given_name = body.get('given_name', '').strip()
    family_name = body.get('family_name', '').strip()
    group = body.get('group', USER_GROUP)

    if not email:
        raise ValidationError('Email is required')

    if group not in ROLE_GROUPS:
        raise ValidationError('Group must be "admins" or "users"')

    try:
        # Create user with temporary password (they'll be forced to change on first login)
        user_attrs = [
            {'Name': 'email', 'Value': email},
            {'Name': 'email_verified', 'Value': 'true'},
        ]
        # Build display name from given/family name if provided
        if given_name:
            user_attrs.append({'Name': 'given_name', 'Value': given_name})
        if family_name:
            user_attrs.append({'Name': 'family_name', 'Value': family_name})
        # Use given_name + family_name as display name, or fall back to provided name
        display_name = f'{given_name} {family_name}'.strip() if (given_name or family_name) else name
        if display_name:
            user_attrs.append({'Name': 'name', 'Value': display_name})

        response = cognito.admin_create_user(
            UserPoolId=USER_POOL_ID,
            Username=str(uuid.uuid4()),  # Generate unique username (email is set as alias attribute)
            UserAttributes=user_attrs,
            DesiredDeliveryMediums=['EMAIL'],
        )

        username = response['User']['Username']

        # Add user to group
        cognito.admin_add_user_to_group(
            UserPoolId=USER_POOL_ID,
            Username=username,
            GroupName=group
        )

    except cognito.exceptions.UsernameExistsException as exc:
        raise ConflictError('A user with this email already exists') from exc
    except ApiError:
        raise
    except Exception as e:
        logger.exception('Error creating user')
        raise ServiceError(FAILED_CREATE_USER) from e
    return {
        'success': True,
        'message': f'User created. Temporary password sent to {email}',
        'user': {
            'username': username,
            'email': email,
            'name': display_name,
            'given_name': given_name,
            'family_name': family_name,
            'groups': [group],
            'status': 'FORCE_CHANGE_PASSWORD',
        }
    }


def _merged_names(body: dict, current_attrs: dict) -> tuple[str, str]:
    """The (given_name, family_name) after applying ``body`` over the stored attributes;
    at least one must be non-empty (a 400 otherwise)."""
    given_name = body['given_name'].strip() if 'given_name' in body else current_attrs.get('given_name', '')
    family_name = body['family_name'].strip() if 'family_name' in body else current_attrs.get('family_name', '')
    if not given_name and not family_name:
        raise ValidationError('At least one of given_name or family_name must be non-empty')
    return given_name, family_name


@app.put('/users/<username>')
@tracer.capture_method
def update_user(username: str):
    """Update user attributes (given_name, family_name)."""
    require_admin(app.current_event.raw_event)

    body = json_object_body(app)

    if 'given_name' not in body and 'family_name' not in body:
        raise ValidationError('At least one of given_name or family_name is required')

    # Validate types
    for field in ('given_name', 'family_name'):
        if field in body and not isinstance(body[field], str):
            raise ValidationError(f'{field} must be a string')

    try:
        # Fetch current attributes to merge with incoming changes
        current_user = cognito.admin_get_user(
            UserPoolId=USER_POOL_ID,
            Username=username,
        )
        current_attrs = {
            attr['Name']: attr['Value']
            for attr in current_user.get('UserAttributes', [])
        }

        given_name, family_name = _merged_names(body, current_attrs)

        user_attrs = []
        if 'given_name' in body:
            user_attrs.append({'Name': 'given_name', 'Value': given_name})
        if 'family_name' in body:
            user_attrs.append({'Name': 'family_name', 'Value': family_name})

        # Compute display name from merged values
        display_name = f'{given_name} {family_name}'.strip()
        if display_name:
            user_attrs.append({'Name': 'name', 'Value': display_name})

        cognito.admin_update_user_attributes(
            UserPoolId=USER_POOL_ID,
            Username=username,
            UserAttributes=user_attrs,
        )

    except cognito.exceptions.UserNotFoundException as exc:
        raise NotFoundError('User not found') from exc
    # Load-bearing, not precautionary: this `try` raises its own ValidationError
    # ('...must be non-empty') after the AWS call, which the catch-all below would
    # otherwise rewrap as a 500 (#263).
    except ApiError:
        raise
    # Was `(ClientError, BotoCoreError)`, so any other fault (e.g. a TypeError
    # from a malformed admin_get_user payload) escaped as a bare 502 without CORS.
    except Exception as e:
        logger.exception('Error updating user')
        raise ServiceError(FAILED_UPDATE_USER) from e
    return {
        'success': True,
        'message': 'User updated',
        'username': username,
        'given_name': given_name,
        'family_name': family_name,
        'name': display_name,
    }


@app.put('/users/<username>/group')
@tracer.capture_method
def update_user_group(username: str):
    """Update user's group (admins/users). A demotion also revokes ``platform-admins`` (audited)."""
    require_admin(app.current_event.raw_event)

    body = json_object_body(app)
    new_group = body.get('group', '').strip()  # pragma: no mutate  any non-group default is refused alike

    if new_group not in ROLE_GROUPS:
        raise ValidationError('Group must be "admins" or "users"')
    demotion = new_group != ADMIN_GROUP
    if demotion:
        _refuse_unsafe_admin_change(username, user_admin_guard.ACTION_ROLE, FAILED_UPDATE_GROUP)
    current_groups = _groups_or_fail(username, 'Error updating user group', FAILED_UPDATE_GROUP)
    # Only an administrator is a platform admin: the demotion takes the group with it.
    revokes = demotion and _guard_platform_admin_target(
        username, current_groups, user_admin_guard.ACTION_ROLE, FAILED_UPDATE_GROUP, removes=True)
    if revokes:
        _audit_platform_admin(username, PLATFORM_ADMIN_REVOKE, 'demotion', FAILED_UPDATE_GROUP)
    # platform-admins goes FIRST: a fault part-way then leaves an administrator without it (what the audit row
    # says), never a platform admin who is no administrator.
    # The target group is never removed: a "promotion" of an administrator to admins changes nothing, rather than
    # removing and re-adding the group (a fault between the two would strip it).
    leaving = ([PLATFORM_ADMIN_GROUP] if revokes else []) + [
        group for group in current_groups if group in ROLE_GROUPS and group != new_group]

    try:
        for group in leaving:
            cognito.admin_remove_user_from_group(
                UserPoolId=USER_POOL_ID,
                Username=username,
                GroupName=group
            )

        # Add to new group (a member already is: nothing to add)
        if new_group not in current_groups:
            cognito.admin_add_user_to_group(
                UserPoolId=USER_POOL_ID,
                Username=username,
                GroupName=new_group
            )

        # Only admins may be the fallback owner: a demotion drops the flag.
        if new_group != ADMIN_GROUP and aggregates_table:
            _clear_fallback_owner_on_demotion(username)

    except cognito.exceptions.UserNotFoundException as exc:
        raise NotFoundError('User not found') from exc
    except ApiError:
        raise
    except Exception as e:
        logger.exception('Error updating user group')
        raise ServiceError(FAILED_UPDATE_GROUP) from e
    return {
        'success': True,
        'message': f'User group updated to {new_group}',
        'username': username,
        'group': new_group
    }


def _run_user_action(
    action: Callable[..., Any], username: str, failure: str, public_error: str, message: str,
) -> dict:
    """Run one Cognito admin call on ``username``: 404 for an unknown user,
    ``ServiceError(public_error)`` (the fault logged as ``failure``) for anything else.
    The client never sees the Cognito text (#263)."""
    try:
        action(UserPoolId=USER_POOL_ID, Username=username)
    except cognito.exceptions.UserNotFoundException as exc:
        raise NotFoundError('User not found') from exc
    except ApiError:
        raise
    except Exception as e:
        logger.exception(failure)
        raise ServiceError(public_error) from e
    return {'success': True, 'message': message, 'username': username}


def _refuse_unsafe_admin_change(username: str, action: str, public_error: str) -> None:
    """409 for the caller's own account and for the last enabled administrator (tenet 4).

    Checked here, for every client; the SPA and the assistant check the same as UX.
    A Cognito fault answers the route's own fixed message (#263).
    """
    caller_sub = get_caller_subject(app.current_event.raw_event)
    try:
        target = cognito.admin_get_user(UserPoolId=USER_POOL_ID, Username=username)
        admins = _paged(cognito.list_users_in_group, 'Users', UserPoolId=USER_POOL_ID, GroupName=ADMIN_GROUP, Limit=60)
    except cognito.exceptions.UserNotFoundException as exc:
        raise NotFoundError('User not found') from exc
    except Exception as e:
        logger.exception('Error checking the administrators')
        raise ServiceError(public_error) from e
    target_sub = next((a.get('Value') for a in target.get('UserAttributes', [])
                       if isinstance(a, dict) and a.get('Name') == 'sub'), '')
    user_admin_guard.refuse_own_account(caller_sub, str(target_sub or ''), action)
    # Compared by the canonical username: the path may name the user by its email alias.
    canonical = target.get('Username')
    user_admin_guard.refuse_last_admin(canonical if isinstance(canonical, str) and canonical else username, admins)


# ============================================
# Platform admins (docs/multi-workspace.md → Control plane)
# ============================================


def _groups_or_fail(username: str, logged: str, public_error: str) -> list[str]:
    """``username``'s groups: 404 for an unknown user, the route's fixed 500 (``logged``) for a fault (#263)."""
    try:
        return _user_groups(username)
    except cognito.exceptions.UserNotFoundException as exc:
        raise NotFoundError('User not found') from exc
    except ApiError:
        raise
    except Exception as e:
        logger.exception(logged)
        raise ServiceError(public_error) from e


def _refuse_last_platform_admin(username: str, public_error: str) -> None:
    """409 when ``username`` is the last enabled platform admin. The path may name the user by an alias (the
    email), while the group lists canonical usernames: the target is compared by the name ``AdminGetUser`` answers."""
    try:
        found = cognito.admin_get_user(UserPoolId=USER_POOL_ID, Username=username).get('Username')
        members = _paged(cognito.list_users_in_group, 'Users', UserPoolId=USER_POOL_ID,
                         GroupName=PLATFORM_ADMIN_GROUP, Limit=60)
    except cognito.exceptions.UserNotFoundException as exc:
        raise NotFoundError('User not found') from exc
    except Exception as e:
        logger.exception('Error checking the platform admins')
        raise ServiceError(public_error) from e
    user_admin_guard.refuse_last_platform_admin(found if isinstance(found, str) and found else username, members)


def _caller_is_platform_admin(event: dict, public_error: str) -> bool:
    """Whether the caller is a platform admin NOW (``shared.platform_admin.is_live_platform_admin``: the token's
    group, the live Cognito membership and an enabled account), so a revoked platform admin's token cannot grant the
    group back. A failed look-up answers the route's fixed 500 and admits no one."""
    try:
        return is_live_platform_admin(event, cognito, USER_POOL_ID)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error checking the caller platform admin membership')
        raise ServiceError(public_error) from exc


def _guard_platform_admin_target(username: str, groups: list[str], action: str, public_error: str, *,
                                 removes: bool) -> bool:
    """Whether ``username`` (in ``groups``) is a platform admin; for one, 403 unless the caller is one too (live,
    ``_caller_is_platform_admin``) and, when the request ``removes`` it (demote, disable, delete), 409 for the last
    enabled one."""
    if PLATFORM_ADMIN_GROUP not in groups:
        return False
    user_admin_guard.refuse_platform_admin_target(
        _caller_is_platform_admin(app.current_event.raw_event, public_error), action)
    if removes:
        _refuse_last_platform_admin(username, public_error)
    return True


def _audit_platform_admin(username: str, kind: str, via: str, public_error: str) -> None:
    """Record a grant or revoke of ``platform-admins`` (``AUDIT#platform-admins`` / ``{iso}#{random}``: kind, via,
    the target's and the actor's subs, the time), BEFORE the change, so no change goes unrecorded: a row that cannot
    be written refuses the change with the route's fixed 500 (a failed look-up of the target's sub answers
    ``_user_sub``'s own fixed 500). A change that fails after it leaves its row (and a 500)."""
    at = now_iso()
    item = {'pk': PLATFORM_ADMIN_AUDIT_PK, 'sk': f'{at}#{secrets.token_hex(8)}', 'kind': kind, 'via': via,
            'target': _user_sub(username), 'actor': get_caller_subject(app.current_event.raw_event), 'at': at}
    try:
        put_new_audit_row(_access_table(), item)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error recording a platform admin change')
        raise ServiceError(public_error) from exc


def _guarded_user_action(
    username: str, guard_action: str, action: Callable[..., Any], logged: tuple[str, str], message: str, *,
    removes: bool = False,
) -> dict:
    """``_run_user_action`` after the platform-admin rules on its target; ``logged`` = (log line, public error).

    ``removes``: the action takes a platform admin out of service (disable), so the last enabled one is refused.
    """
    failure, public_error = logged
    groups = _groups_or_fail(username, failure, public_error)
    _guard_platform_admin_target(username, groups, guard_action, public_error, removes=removes)
    return _run_user_action(action, username, failure, public_error, message)


def _plan_workspace_removal(username: str) -> workspace_members.UserRemoval | None:
    """The user's workspace memberships, read and checked (shared/workspace_members.py ``plan_user_removal``): 409 for
    the last admin of a workspace unless the caller is a platform admin (live), the route's fixed 500 for a fault.
    None without the workspaces table."""
    if workspaces_table is None:
        return None
    sub = _user_sub(username)
    event = app.current_event.raw_event
    try:
        return workspace_members.plan_user_removal(
            workspaces_table, sub,
            caller_is_platform_admin=lambda: _caller_is_platform_admin(event, FAILED_DELETE_USER))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error reading the user workspace memberships')
        raise ServiceError(FAILED_DELETE_USER) from exc


def _remove_workspace_memberships(removal: workspace_members.UserRemoval | None) -> None:
    """Remove the memberships ``_plan_workspace_removal`` read (each audited first); the route's fixed 500 for a
    fault, 409 when one changed meanwhile. The ones already removed stay removed, and the account stays."""
    if removal is None or workspaces_table is None:
        return
    try:
        workspace_members.remove_user_memberships(
            workspaces_table, removal, get_caller_subject(app.current_event.raw_event))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error removing the user workspace memberships')
        raise ServiceError(FAILED_DELETE_USER) from exc


@app.post('/users/<username>/reset-password')
@tracer.capture_method
def reset_user_password(username: str):
    """Reset user's password (sends new temporary password via email)."""
    require_admin(app.current_event.raw_event)
    return _guarded_user_action(
        username, user_admin_guard.ACTION_RESET_CREDENTIAL, cognito.admin_reset_user_password,
        ('Error resetting password', FAILED_RESET_CREDENTIAL), 'Password reset email sent to user')


@app.put('/users/<username>/enable')
@tracer.capture_method
def enable_user(username: str):
    """Enable a disabled user."""
    require_admin(app.current_event.raw_event)
    return _guarded_user_action(username, user_admin_guard.ACTION_ENABLE, cognito.admin_enable_user,
                                ('Error enabling user', FAILED_ENABLE_USER), 'User enabled')


@app.put('/users/<username>/disable')
@tracer.capture_method
def disable_user(username: str):
    """Disable a user (prevents login)."""
    require_admin(app.current_event.raw_event)
    _refuse_unsafe_admin_change(username, user_admin_guard.ACTION_DISABLE, FAILED_DISABLE_USER)
    return _guarded_user_action(username, user_admin_guard.ACTION_DISABLE, cognito.admin_disable_user,
                                ('Error disabling user', FAILED_DISABLE_USER), 'User disabled', removes=True)


@app.delete('/users/<username>')
@tracer.capture_method
def delete_user(username: str):
    """Delete a user: every refusal first (own account, last administrator, a platform admin's rules, the last admin
    of a workspace), then a platform admin's revoke audit row (Cognito drops a deleted user's groups itself), then
    the user's workspace memberships (each audited first), and only then the Cognito account, so a refusal or a fault
    before it leaves the account as it was."""
    require_admin(app.current_event.raw_event)
    _refuse_unsafe_admin_change(username, user_admin_guard.ACTION_DELETE, FAILED_DELETE_USER)
    failure = 'Error deleting user'
    groups = _groups_or_fail(username, failure, FAILED_DELETE_USER)
    platform_admin_target = _guard_platform_admin_target(
        username, groups, user_admin_guard.ACTION_DELETE, FAILED_DELETE_USER, removes=True)
    removal = _plan_workspace_removal(username)
    if platform_admin_target:
        _audit_platform_admin(username, PLATFORM_ADMIN_REVOKE, 'delete', FAILED_DELETE_USER)
    _remove_workspace_memberships(removal)
    return _run_user_action(cognito.admin_delete_user, username, failure, FAILED_DELETE_USER, 'User deleted')


def _platform_admin_body() -> bool:
    body = json_object_body(app)
    if set(body) != {'platform_admin'} or not isinstance(body['platform_admin'], bool):
        raise ValidationError('Body must be {"platform_admin": true} or {"platform_admin": false}')
    return body['platform_admin']


@app.put('/users/<username>/platform-admin')
@tracer.capture_method
def put_user_platform_admin(username: str):
    """Grant (``{"platform_admin": true}``) or revoke (``false``) ``platform-admins`` (platform admins only).

    Only an administrator can be granted it (400 otherwise); a revoke that would leave no enabled platform admin,
    the caller's own included, is 409. Asking for what already holds changes nothing and records nothing; every
    grant and revoke writes its audit row first (``_audit_platform_admin``).
    """
    event = app.current_event.raw_event
    require_admin(event)
    require_platform_admin(event)
    grant = _platform_admin_body()
    # The token's group is not enough: a revoked platform admin must not be able to grant it back (live check).
    if not _caller_is_platform_admin(event, FAILED_UPDATE_PLATFORM_ADMIN):
        raise AuthorizationError('Platform admin access required')
    groups = _groups_or_fail(username, 'Error updating platform admin membership', FAILED_UPDATE_PLATFORM_ADMIN)
    answer = {'success': True, 'username': username, 'platform_admin': grant}
    if grant == (PLATFORM_ADMIN_GROUP in groups):
        return {**answer, 'message': 'Platform admin membership unchanged'}
    if grant and ADMIN_GROUP not in groups:
        raise ValidationError('Only an administrator can be a platform admin: make the user an administrator first')
    if not grant:
        _refuse_last_platform_admin(username, FAILED_UPDATE_PLATFORM_ADMIN)
    _audit_platform_admin(username, PLATFORM_ADMIN_GRANT if grant else PLATFORM_ADMIN_REVOKE,
                          'platform_admin_route', FAILED_UPDATE_PLATFORM_ADMIN)
    change = cognito.admin_add_user_to_group if grant else cognito.admin_remove_user_from_group
    try:
        change(UserPoolId=USER_POOL_ID, Username=username, GroupName=PLATFORM_ADMIN_GROUP)
    except cognito.exceptions.UserNotFoundException as exc:
        raise NotFoundError('User not found') from exc
    except Exception as e:
        logger.exception('Error updating platform admin membership')
        raise ServiceError(FAILED_UPDATE_PLATFORM_ADMIN) from e
    return {**answer, 'message': 'Platform admin granted' if grant else 'Platform admin revoked'}


# ============================================
# Category access (which categories of reviews a user may see)
# ============================================


def _user_sub(username: str) -> str:
    """The Cognito ``sub`` of ``username`` (404 when there is no such user)."""
    try:
        response = cognito.admin_get_user(UserPoolId=USER_POOL_ID, Username=username)
    except cognito.exceptions.UserNotFoundException as exc:
        raise NotFoundError('User not found') from exc
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error resolving user')
        raise ServiceError('Failed to look up user') from exc
    for attribute in response.get('UserAttributes', []):
        if attribute.get('Name') == 'sub' and attribute.get('Value'):
            return attribute['Value']
    raise ServiceError('User has no subject')


def _access_table():
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    return aggregates_table


def _categories_config() -> list[dict]:
    """The categories config, read fresh (a just-added category is grantable at once)."""
    return read_categories_config(_access_table())


def _access_response(username: str, sub: str, row: dict | None, config: list) -> dict:
    stored = category_access.stored_categories(row)
    return {
        'success': True,
        'username': username,
        # No row (or '*') = every category: the deploy-safe default.
        'all': stored is None or category_access.WILDCARD in stored,
        'categories': [category_access.WILDCARD] if stored is None else stored,
        # ['*'] = every source incl. restricted; a list = exactly those; None = the
        # default (every source that is not restricted).
        'sources': category_access.stored_sources(row),
        # Categories this user owns — visible to them whatever the row says.
        'owned_categories': sorted(category_access.owned_categories(sub, config)),
        'updated_at': (row or {}).get('updated_at'),
    }


def _read_access_row(sub: str) -> dict | None:
    try:
        return _access_table().get_item(
            Key=category_access.access_key(sub), ConsistentRead=True).get('Item')
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error reading category access')
        raise ServiceError('Failed to read category access') from exc


def _granted_sources(body: dict, sub: str) -> list[str] | None:
    """The ``sources`` the row will store: the body's (validated against the configured
    profile ids), or — when the body omits it — the row's current value. None = the
    default rule (every source that is not restricted); an explicit ``sources: null``
    clears a stored list back to it."""
    if 'sources' not in body:
        return category_access.stored_sources(_read_access_row(sub))
    if body['sources'] is None:
        return None
    try:
        known = [profile['id'] for profile in load_source_profiles(_access_table())]
    except (ClientError, BotoCoreError, ValueError) as exc:
        logger.exception('Error reading source profiles')
        raise ServiceError('Failed to read source settings') from exc
    try:
        return category_access.validate_access_sources(body.get('sources'), known)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc


@app.get('/users/<username>/category-access')
@tracer.capture_method
def get_user_category_access(username: str):
    """The categories and sources ``username`` may see (admin only)."""
    require_admin(app.current_event.raw_event)
    sub = _user_sub(username)
    return _access_response(username, sub, _read_access_row(sub), _categories_config())


@app.put('/users/<username>/category-access')
@tracer.capture_method
def put_user_category_access(username: str):
    """Set what ``username`` may see: ``{categories: ['*'] | [names], sources?: ['*'] | [ids] | null}``
    (admin only; ``sources`` omitted = unchanged, null = back to the default rule)."""
    event = app.current_event.raw_event
    require_admin(event)
    body = json_body_value(app)
    if not isinstance(body, dict):
        raise ValidationError('Request body must be a JSON object')
    config = _categories_config()
    # With nothing configured, reviews are classified into the built-in
    # DEFAULT_CATEGORIES, so those are the names an admin can grant.
    known = [c['name'] for c in config] if config else DEFAULT_CATEGORIES
    try:
        categories = category_access.validate_access_categories(body.get('categories'), known)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    sub = _user_sub(username)
    sources = _granted_sources(body, sub)
    row = {
        **category_access.access_key(sub),
        'categories': categories,
        **({'sources': sources} if sources is not None else {}),
        'updated_by': get_caller_subject(event),
        'updated_at': now_iso(),
    }
    try:
        _access_table().put_item(Item=row)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error saving category access')
        raise ServiceError('Failed to save category access') from exc
    # What this user's cached reads return depends on the grant (docs/caching.md).
    bump_config_version(_access_table())
    return _access_response(username, sub, row, config)


# ============================================
# User flags: fallback_owner (one admin) and memory_reviewer
# (storage + invariants: shared/user_flags.py)
# ============================================

_NO_FLAGS = dict.fromkeys(user_flags.FLAG_NAMES, False)


def _attach_flags(users: list[dict]) -> None:
    """Add ``flags`` to every listed user (each a `_user_row`, so it carries ``sub``).
    A read failure degrades to all-False (logged) rather than failing the whole user list."""
    flags_by_sub: dict = {}
    if aggregates_table:
        try:
            flags_by_sub = user_flags.flags_for_subs(
                get_dynamodb_resource(), AGGREGATES_TABLE, [u['sub'] for u in users])
        except (ClientError, BotoCoreError):
            logger.warning('User flags unavailable; listing users without them')
    modes_by_sub: dict = {}
    if aggregates_table:
        try:
            modes_by_sub = ai_mode.ai_modes_for_subs(
                get_dynamodb_resource(), AGGREGATES_TABLE, [u['sub'] for u in users])
        except (ClientError, BotoCoreError):
            logger.warning('Ways of working unavailable; listing users with the default')
    for user in users:
        user['flags'] = dict(flags_by_sub.get(user['sub'], _NO_FLAGS))
        user['ai_mode'] = modes_by_sub.get(user['sub'], ai_mode.DEFAULT_AI_MODE).to_dict()


def _clear_fallback_owner_on_demotion(username: str) -> None:
    try:
        user_flags.clear_fallback_owner_if(
            aggregates_table, sub=_user_sub(username),
            actor_sub=get_caller_subject(app.current_event.raw_event))
    except Exception:
        logger.exception('Could not clear the fallback owner after a demotion')


def _user_groups(username: str) -> list[str]:
    response = cognito.admin_list_groups_for_user(Username=username, UserPoolId=USER_POOL_ID)
    return [g['GroupName'] for g in response.get('Groups', [])]


def _ai_mode_changes(body: dict) -> dict:
    """The validated way-of-working fields of a flags body (shared/ai_mode.py)."""
    changes: dict = {}
    if 'ai_mode' in body:
        if body['ai_mode'] not in ai_mode.MODES:
            raise ValidationError(f'ai_mode must be one of: {", ".join(ai_mode.MODES)}')
        changes['ai_mode'] = body['ai_mode']
    for field in ai_mode.UNLOCK_FIELDS.values():
        if field in body:
            changes[field] = validate_bool(body[field], False, field)
    return changes


def _save_ai_mode(sub: str, changes: dict, actor_sub: str) -> dict:
    try:
        return ai_mode.set_ai_mode(_access_table(), sub=sub, changes=changes, actor_sub=actor_sub).to_dict()
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error saving the way of working')
        raise ServiceError('Failed to save the way of working') from exc


@app.put('/users/<username>/flags')
@tracer.capture_method
def put_user_flags(username: str):
    """Set ``{fallback_owner?, memory_reviewer?, ai_mode?, ai_writing_prfaq?, ai_writing_prd?}``
    (admin). Only an admin may be the fallback owner, and there is at most one: setting
    it moves it. The way-of-working fields go to their own row (shared/ai_mode.py)."""
    event = app.current_event.raw_event
    require_admin(event)
    body = json_object_body(app)
    unknown = set(body) - set(user_flags.FLAG_NAMES) - set(ai_mode.FIELD_NAMES)
    if unknown:
        raise ValidationError(f'Unknown flag(s): {", ".join(sorted(unknown))}')
    changes = {name: validate_bool(body[name], False, name) for name in user_flags.FLAG_NAMES if name in body}
    mode_changes = _ai_mode_changes(body)
    if not changes and not mode_changes:
        raise ValidationError('Provide at least one flag or way-of-working field')
    table = _access_table()
    sub = _user_sub(username)
    actor_sub = get_caller_subject(event)
    if not changes:
        return {'success': True, 'username': username, 'ai_mode': _save_ai_mode(sub, mode_changes, actor_sub)}
    if changes.get('fallback_owner'):
        try:
            groups = _user_groups(username)
        except (ClientError, BotoCoreError) as exc:
            logger.exception('Error reading user groups')
            raise ServiceError('Failed to look up user') from exc
        if ADMIN_GROUP not in groups:
            raise ValidationError('Only an admin can be the fallback owner')
    try:
        flags = user_flags.set_flags(
            table, sub=sub, username=username, changes=changes, actor_sub=actor_sub)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error saving user flags')
        raise ServiceError('Failed to save user flags') from exc
    answer = {'success': True, 'username': username, 'flags': flags}
    if mode_changes:
        answer['ai_mode'] = _save_ai_mode(sub, mode_changes, actor_sub)
    return answer


@app.get('/users/me/ai-mode')
@tracer.capture_method
def get_my_ai_mode():
    """The caller's own way of working ``{mode, ai_writing_prfaq, ai_writing_prd}`` (any signed-in user).

    Read by the SPA to shape the editor (Coach me / Review my draft); the server
    gate (shared/ai_writing.py) is the authority. An unreadable row answers 500
    rather than a default, so the SPA never shows AI writing it would refuse.
    """
    sub = get_caller_subject(app.current_event.raw_event)
    try:
        mode = ai_mode.get_ai_mode(_access_table(), sub)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error reading the way of working')
        raise ServiceError('Failed to read your way of working') from exc
    return {'success': True, 'ai_mode': mode.to_dict()}


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
