"""
User Administration API Lambda - Handles /users/*

Provides Cognito user management for admins:
- List users
- Create users
- Update user groups (admins/users)
- Reset passwords
- Enable/disable users

Only accessible by users in the 'admins' group.
"""
import os
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from shared import category_access, user_flags
from shared.api import (
    DEFAULT_CATEGORIES,
    api_handler,
    create_api_resolver,
    get_caller_subject,
    require_admin,
    validate_bool,
)
from shared.aws import get_dynamodb_resource
from shared.category_gate import read_categories_config
from shared.concurrency import concurrently, ordered_map
from shared.exceptions import (
    ApiError,
    ConfigurationError,
    ConflictError,
    NotFoundError,
    ServiceError,
    ValidationError,
)
from shared.logging import logger, tracer
from shared.request_body import json_body_value, json_object_body
from shared.source_profiles import load_source_profiles

# AWS Clients
cognito = boto3.client('cognito-idp')

# Configuration
USER_POOL_ID = os.environ.get('USER_POOL_ID', '')
AGGREGATES_TABLE = os.environ.get('AGGREGATES_TABLE', '')
aggregates_table = get_dynamodb_resource().Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None

# Client-facing text for an unexpected Cognito failure (#263, after PR #403).
# Each was `ServiceError(str(e))`, and `shared/api.py` returns that message
# verbatim — publishing the user pool id, API name and request id. The detail is
# logged with `logger.exception` instead. Each route also re-raises `ApiError`
# ahead of its catch-all so a typed 4xx raised inside keeps its status.
FAILED_LIST_USERS = 'Failed to list users'
FAILED_CREATE_USER = 'Failed to create user'
FAILED_UPDATE_USER = 'Failed to update user'
FAILED_UPDATE_GROUP = 'Failed to update user group'
FAILED_RESET_CREDENTIAL = 'Failed to reset password'
FAILED_ENABLE_USER = 'Failed to enable user'
FAILED_DISABLE_USER = 'Failed to disable user'
FAILED_DELETE_USER = 'Failed to delete user'
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
    group = body.get('group', 'users')  # Default to users

    if not email:
        raise ValidationError('Email is required')

    if group not in ['admins', 'users']:
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
    """Update user's group (admins/users)."""
    require_admin(app.current_event.raw_event)

    body = json_object_body(app)
    new_group = body.get('group', '').strip()  # pragma: no mutate  any non-group default is refused alike

    if new_group not in ['admins', 'users']:
        raise ValidationError('Group must be "admins" or "users"')

    try:
        # Get current groups
        groups_response = cognito.admin_list_groups_for_user(
            Username=username,
            UserPoolId=USER_POOL_ID
        )
        current_groups = [g['GroupName'] for g in groups_response.get('Groups', [])]

        # Remove from old groups
        for group in current_groups:
            if group in ['admins', 'users']:
                cognito.admin_remove_user_from_group(
                    UserPoolId=USER_POOL_ID,
                    Username=username,
                    GroupName=group
                )

        # Add to new group
        cognito.admin_add_user_to_group(
            UserPoolId=USER_POOL_ID,
            Username=username,
            GroupName=new_group
        )

        # Only admins may be the fallback owner: a demotion drops the flag.
        if new_group != 'admins' and aggregates_table:
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


@app.post('/users/<username>/reset-password')
@tracer.capture_method
def reset_user_password(username: str):
    """Reset user's password (sends new temporary password via email)."""
    require_admin(app.current_event.raw_event)
    return _run_user_action(
        cognito.admin_reset_user_password, username,
        'Error resetting password', FAILED_RESET_CREDENTIAL, 'Password reset email sent to user')


@app.put('/users/<username>/enable')
@tracer.capture_method
def enable_user(username: str):
    """Enable a disabled user."""
    require_admin(app.current_event.raw_event)
    return _run_user_action(cognito.admin_enable_user, username, 'Error enabling user', FAILED_ENABLE_USER, 'User enabled')


@app.put('/users/<username>/disable')
@tracer.capture_method
def disable_user(username: str):
    """Disable a user (prevents login)."""
    require_admin(app.current_event.raw_event)
    return _run_user_action(cognito.admin_disable_user, username, 'Error disabling user', FAILED_DISABLE_USER, 'User disabled')


@app.delete('/users/<username>')
@tracer.capture_method
def delete_user(username: str):
    """Delete a user from Cognito."""
    require_admin(app.current_event.raw_event)
    return _run_user_action(cognito.admin_delete_user, username, 'Error deleting user', FAILED_DELETE_USER, 'User deleted')


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
        'updated_at': datetime.now(UTC).isoformat(),
    }
    try:
        _access_table().put_item(Item=row)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error saving category access')
        raise ServiceError('Failed to save category access') from exc
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
    for user in users:
        user['flags'] = dict(flags_by_sub.get(user['sub'], _NO_FLAGS))


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


@app.put('/users/<username>/flags')
@tracer.capture_method
def put_user_flags(username: str):
    """Set ``{fallback_owner?, memory_reviewer?}`` (admin). Only an admin may be
    the fallback owner, and there is at most one: setting it moves it."""
    event = app.current_event.raw_event
    require_admin(event)
    body = json_object_body(app)
    unknown = set(body) - set(user_flags.FLAG_NAMES)
    if unknown:
        raise ValidationError(f'Unknown flag(s): {", ".join(sorted(unknown))}')
    changes = {name: validate_bool(body[name], False, name) for name in user_flags.FLAG_NAMES if name in body}
    if not changes:
        raise ValidationError('Provide fallback_owner and/or memory_reviewer')
    table = _access_table()
    sub = _user_sub(username)
    if changes.get('fallback_owner'):
        try:
            groups = _user_groups(username)
        except (ClientError, BotoCoreError) as exc:
            logger.exception('Error reading user groups')
            raise ServiceError('Failed to look up user') from exc
        if 'admins' not in groups:
            raise ValidationError('Only an admin can be the fallback owner')
    try:
        flags = user_flags.set_flags(
            table, sub=sub, username=username, changes=changes, actor_sub=get_caller_subject(event))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Error saving user flags')
        raise ServiceError('Failed to save user flags') from exc
    return {'success': True, 'username': username, 'flags': flags}


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
