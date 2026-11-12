"""A workspace's members: list, add, change a role, remove (docs/multi-workspace.md, "Roles" and "Invites").

The routes live in lambda/api/workspaces_handler.py, under ``/me/workspaces/current/members``: each acts in the
workspace ``X-Workspace-Id`` names, as shared/workspace.py ``resolve_workspace`` decides (the caller's role there; a
platform admin enters as ``admin``, live-checked and audited; everyone else gets the one 404). Any member lists the
members; only an ``admin`` there adds a member, changes a role or removes someone else (``require_workspace_admin``);
any member may remove themselves (leave).

Rules:

* A workspace always keeps one member admin: demoting or removing the last one (the caller themselves included) is
  refused (409). The transaction that demotes or removes an admin also checks that another member is still an admin
  (a ``ConditionCheck`` on that row), so two admins demoting each other at once cannot both succeed.
* Adding an email that has a Cognito account makes that account a member at once. A new email first gets a Cognito
  account (``AdminCreateUser``, which emails the temporary password, as the users API does), then the membership;
  only a caller in the deployment's ``admins`` group may create one (403 for any other workspace admin): until the
  data path is keyed by workspace (phase 2) every account reads the whole deployment, and creating accounts stays
  with the people the users API already lets do it.
  No ``INVITE#`` row is written: the membership is immediate either way, so there is nothing to accept. An existing
  account gets no notification email: the deployment has no mail path for account notices (the participant mailer
  is for participant asks, opt-in), so the add is logged instead.
* Every add, role change and removal first writes an audit row ``AUDIT#WS#{ws}`` / ``{iso}#{random}`` (kind, actor,
  target, role before and after) with a conditional put (shared/audit_rows.py), so the row records the attempt: a
  row that cannot be written refuses the change, and a change that then fails leaves the row. Asking for the role a
  member already has changes and records nothing.
* The member's ``MEMBER#`` row and their ``USER#`` row ("my workspaces", the role copied there) change in ONE
  transaction. A new membership also checks that the workspace is still ``active``.
* Deleting a user (the users API, ``DELETE /users/{username}``) removes every membership of theirs BEFORE the Cognito
  account goes (``plan_user_removal`` then ``remove_user_memberships``): one transaction per workspace (the two rows,
  and for an admin the check that the other admin still is one), each after its ``member_removed`` audit row (``via:
  user_deleted``). The last member admin of a workspace is refused (409) unless the caller is a platform admin; then
  the workspace keeps no member admin until a platform admin enters it and names one.
* An admin whose Cognito account is disabled still counts as an admin (``_another_admin`` reads the table only): a
  disabled account may be enabled again, and checking each admin's account would cost one Cognito call per row on
  every demotion and removal. A deleted account no longer counts: its rows go with it.

The rows (``voc-workspaces``):

    WS#{ws}       / MEMBER#{sub}     role, invited_by, joined_at, email, name (email and name as Cognito had them
                                     when the member was added; the creator's row from 6.09.00 has neither)
    USER#{sub}    / WS#{ws}          name, slug, role
    AUDIT#WS#{ws} / {iso}#{random}   kind, actor, target, role_before, role_after, at, platform_admin (+ account;
                                     a user's delete: via, left_without_admin)

No row here carries ``ttl`` (only ``INVITE#`` rows may; lib/customer-data-deletes.test.ts and
shared/test/test_platform_workspaces.py pin it). Emails and subs identify people: neither is ever logged.
"""
from __future__ import annotations

import hashlib
import re
import secrets
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.audit_rows import put_new_audit_row
from shared.dynamo_paging import iter_query
from shared.exceptions import AuthorizationError, ConflictError, NotFoundError, ValidationError
from shared.feedback_cursor import TABLE_KEY_FIELDS, decode_key_cursor, encode_key_cursor
from shared.logging import logger
from shared.ops_alerts import normalize_email
from shared.persona_save import cancellation_codes
from shared.request_body import reject_unknown_fields
from shared.timestamps import now_iso
from shared.workspace import (
    ACTIVE,
    NOT_FOUND,
    ROLES,
    WorkspaceContext,
    audit_key,
    audit_sort_key,
    is_workspace_id,
    text_fields,
    ws_key,
)

MEMBER_ADDED: Final = 'member_added'
MEMBER_ROLE_CHANGED: Final = 'member_role_changed'
MEMBER_REMOVED: Final = 'member_removed'
MEMBER_LEFT: Final = 'member_left'
#: ``via`` on the ``member_removed`` rows of a user's delete (the users API).
VIA_USER_DELETED: Final = 'user_deleted'
#: At most this many workspace names in the refusal of a user's delete.
MAX_NAMED_WORKSPACES: Final = 3
#: The audit kind of a new Cognito account an add creates (written before the account exists).
ACCOUNT_CREATION: Final = 'account_created'
#: ``account`` on an add: the email's Cognito account existed, or the add created it.
ACCOUNT_EXISTING: Final = 'existing'
ACCOUNT_CREATED: Final = 'created'
MEMBER_PREFIX: Final = 'MEMBER#'
#: At most this many members of one page without a stored email are looked up in Cognito (one ListUsers each).
MAX_COGNITO_FILLS: Final = 5
#: A Cognito ``sub`` as the path and the rows carry it (a UUID; the tests' ``sub-ana`` fits too).
_SUB: Final = re.compile(r'[0-9A-Za-z-]{1,64}')

ALREADY_MEMBER: Final = 'That person is already a member of this workspace'
MEMBER_NOT_FOUND: Final = 'Member not found'
LAST_ADMIN: Final = 'A workspace needs an admin: make another member an admin first'
CHANGED_MEANWHILE: Final = 'The membership changed meanwhile: reload the members and try again'
NO_LONGER_ADMIN: Final = 'You are no longer an admin of this workspace'
AMBIGUOUS_EMAIL: Final = 'More than one account has this email: ask a platform admin to resolve it'
EMAIL_ELSEWHERE: Final = 'An account already uses this email under another spelling: add it as that account writes it'
NEW_ACCOUNT_ADMINS_ONLY: Final = ('This email has no account yet: only a deployment administrator can create one '
                                  'while the data is shared across workspaces')


@dataclass(frozen=True)
class NewMember:
    """A validated add request."""

    email: str
    role: str


@dataclass(frozen=True)
class Account:
    """The Cognito account an add makes a member: found by its email, or created."""

    sub: str
    email: str
    name: str
    created: bool


class MemberAccountError(Exception):
    """Cognito answered without the account's ``sub``: a fault, never the caller's doing."""


def _role(value: object) -> str:
    if not isinstance(value, str) or value not in ROLES:
        raise ValidationError('role must be "admin", "editor" or "viewer"')
    return value


def parse_new_member(body: Mapping[str, Any]) -> NewMember:
    """``{email, role}`` validated, or a 400 that says what to fix. The email is kept as written (trimmed)."""
    reject_unknown_fields(body, ('email', 'role'))
    raw = body.get('email')
    normalize_email(raw)  # the app's one address rule: 400 "email is not a valid address"
    email = str(raw).strip()
    if not email.isascii():  # a character whose lower case is ASCII (K, the Kelvin sign) passes the rule above
        raise ValidationError('email is not a valid address')
    return NewMember(email=email, role=_role(body.get('role')))


def parse_role_change(body: Mapping[str, Any]) -> str:
    """``{role}`` validated, or a 400."""
    reject_unknown_fields(body, ('role',))
    return _role(body.get('role'))


def member_sub(value: object) -> str:
    """The ``{sub}`` path part, or the members' 404 for one that cannot be a member."""
    if not isinstance(value, str) or not _SUB.fullmatch(value):
        raise NotFoundError(MEMBER_NOT_FOUND)
    return value


# ── Cognito ─────────────────────────────────────────────────────────────────

def _attributes(user: Mapping[str, Any]) -> dict[str, str]:
    """A Cognito user's ``Attributes`` (ListUsers and AdminCreateUser both use the name) as text by name."""
    attrs: dict[str, str] = {}
    for attr in user.get('Attributes', []):
        name, value = (attr.get('Name'), attr.get('Value')) if isinstance(attr, Mapping) else (None, None)
        if isinstance(name, str) and isinstance(value, str):
            attrs[name] = value
    return attrs


def _display_name(attrs: Mapping[str, str]) -> str:
    return attrs.get('name') or ' '.join(part for part in (attrs.get('given_name'), attrs.get('family_name')) if part)


def _account(user: Mapping[str, Any], *, created: bool) -> Account:
    attrs = _attributes(user)
    sub = attrs.get('sub', '')
    if not _SUB.fullmatch(sub):
        raise MemberAccountError('Cognito returned an account without a usable sub')
    return Account(sub=sub, email=attrs.get('email', ''), name=_display_name(attrs), created=created)


def find_or_create_account(cognito: Any, user_pool_id: str, email: str, *, may_create: bool,
                           before_create: Callable[[], None] | None = None) -> Account:
    """The account whose email is ``email`` (``ListUsers`` filtered on it), or a new one (``AdminCreateUser``: a
    generated username, the email verified, the temporary password emailed) when ``may_create``. 403 for a new email
    when not ``may_create``; 409 when two accounts share the email or Cognito refuses the email as another account's;
    every other Cognito error propagates. ``before_create`` runs right before ``AdminCreateUser`` (the audit row of
    the creation, ``audit_account_creation``): when it raises, no account is made."""
    # `email` passed the app's address rule (ASCII, no quote, backslash or space), so the filter cannot be escaped.
    found = cognito.list_users(UserPoolId=user_pool_id, Filter=f'email = "{email}"', Limit=2).get('Users', [])
    if len(found) > 1:
        raise ConflictError(AMBIGUOUS_EMAIL)
    if found:
        return _account(found[0], created=False)
    if not may_create:
        raise AuthorizationError(NEW_ACCOUNT_ADMINS_ONLY)
    if before_create is not None:
        before_create()
    try:
        response = cognito.admin_create_user(
            UserPoolId=user_pool_id, Username=str(uuid.uuid4()),
            UserAttributes=[{'Name': 'email', 'Value': email}, {'Name': 'email_verified', 'Value': 'true'}],
            DesiredDeliveryMediums=['EMAIL'])
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') in {'AliasExistsException', 'UsernameExistsException'}:
            raise ConflictError(EMAIL_ELSEWHERE) from exc
        raise
    return _account(response.get('User', {}), created=True)


def _account_by_sub(cognito: Any, user_pool_id: str, sub: str) -> Account | None:
    if not _SUB.fullmatch(sub):
        return None
    found = cognito.list_users(UserPoolId=user_pool_id, Filter=f'sub = "{sub}"', Limit=1).get('Users', [])
    return _account(found[0], created=False) if found else None


# ── List ────────────────────────────────────────────────────────────────────

def _member(row: Mapping[str, Any]) -> dict[str, str]:
    sk, role, email, name, invited_by, joined_at = text_fields(
        row, 'sk', 'role', 'email', 'name', 'invited_by', 'joined_at')
    return {'sub': sk.removeprefix(MEMBER_PREFIX), 'role': role, 'email': email, 'name': name,
            'invited_by': invited_by, 'joined_at': joined_at}


def _fill_from_cognito(members: list[dict[str, str]], cognito: Any, user_pool_id: str) -> None:
    """Fill the email and name of up to ``MAX_COGNITO_FILLS`` members whose row holds none; a failed look-up leaves
    them blank (logged, counted)."""
    failed = 0
    for member in [m for m in members if not m['email']][:MAX_COGNITO_FILLS]:
        try:
            account = _account_by_sub(cognito, user_pool_id, member['sub'])
        except (ClientError, BotoCoreError, MemberAccountError):
            failed += 1
            continue
        if account is not None:
            member['email'], member['name'] = account.email, member['name'] or account.name
    if failed:
        logger.warning('Left member emails blank: the Cognito look-up failed', extra={'count': failed})


def list_members(table: Any, ws: str, *, limit: int, cursor: str | None, cognito: Any,
                 user_pool_id: str) -> tuple[list[dict[str, str]], str | None]:
    """One page of the workspace's members ``[{sub, role, email, name, invited_by, joined_at}]`` by sub, and the next
    page's cursor. One Query of the workspace's ``MEMBER#`` rows; ``ValueError`` for a cursor not from it. A row
    whose role is not one of the three is left out and counted in the log."""
    partition = ws_key(ws)
    request: dict[str, Any] = {
        'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :member)',
        'ExpressionAttributeValues': {':pk': partition, ':member': MEMBER_PREFIX},
        'Limit': limit,
        # A member added a moment ago is listed at once.
        'ConsistentRead': True,
    }
    if cursor:
        start = decode_key_cursor(cursor, TABLE_KEY_FIELDS, ('pk', partition))
        if not start['sk'].startswith(MEMBER_PREFIX):
            raise ValueError('cursor is not valid')
        request['ExclusiveStartKey'] = start
    response = table.query(**request)
    rows = response.get('Items', [])
    members = [_member(row) for row in rows if row.get('role') in ROLES]
    if left_out := len(rows) - len(members):
        logger.warning('Left out malformed member rows', extra={'count': left_out})
    _fill_from_cognito(members, cognito, user_pool_id)
    last = response.get('LastEvaluatedKey')
    sk = last.get('sk') if isinstance(last, Mapping) else None
    return members, encode_key_cursor({'pk': partition, 'sk': sk}) if isinstance(sk, str) and sk else None


# ── Writes ──────────────────────────────────────────────────────────────────

def _member_key(ws: str, sub: str) -> dict[str, str]:
    return {'pk': ws_key(ws), 'sk': f'{MEMBER_PREFIX}{sub}'}


def _user_key(ws: str, sub: str) -> dict[str, str]:
    return {'pk': f'USER#{sub}', 'sk': f'WS#{ws}'}


def _stored_role(table: Any, ws: str, sub: str) -> str | None:
    """The member's role (read strongly consistent), or None when ``sub`` is not a member."""
    role = table.get_item(Key=_member_key(ws, sub), ConsistentRead=True).get('Item', {}).get('role')
    return role if isinstance(role, str) and role in ROLES else None


def _another_admin(table: Any, ws: str, sub: str) -> str | None:
    """A member admin of ``ws`` other than ``sub`` (one paged Query of the workspace's members), or None."""
    rows = iter_query(table, {
        'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :member)',
        'FilterExpression': '#role = :admin',
        'ProjectionExpression': 'sk',
        'ExpressionAttributeNames': {'#role': 'role'},
        'ExpressionAttributeValues': {':pk': ws_key(ws), ':member': MEMBER_PREFIX, ':admin': 'admin'},
        'ConsistentRead': True,
    })
    others = (row['sk'].removeprefix(MEMBER_PREFIX) for row in rows if isinstance(row.get('sk'), str))
    return next((other for other in others if other != sub), None)


def _still_admin(table_name: str, ws: str, sub: str) -> dict[str, Any]:
    return {'ConditionCheck': {
        'TableName': table_name, 'Key': _member_key(ws, sub), 'ConditionExpression': '#role = :admin',
        'ExpressionAttributeNames': {'#role': 'role'}, 'ExpressionAttributeValues': {':admin': 'admin'},
    }}


def _audit(table: Any, context: WorkspaceContext, *, kind: str, actor: str, target: str,
           before: str | None, after: str | None, **extra: str | bool) -> None:
    """The audit row of a membership change, written before the change (it records the attempt)."""
    at = now_iso()
    row: dict[str, Any] = {'pk': audit_key(context.ws), 'sk': audit_sort_key(at), 'kind': kind, 'actor': actor,
                           'target': target, 'at': at, 'platform_admin': context.platform_admin, **extra}
    if before is not None:
        row['role_before'] = before
    if after is not None:
        row['role_after'] = after
    put_new_audit_row(table, row)


def audit_account_creation(table: Any, context: WorkspaceContext, actor: str, email: str) -> None:
    """The audit row of a new Cognito account an add is about to create (kind ``account_created``: the actor and the
    email's sha256; the account has no sub yet), written BEFORE ``AdminCreateUser``, so no account is made unrecorded
    even if the add then fails (D4). It records the attempt: a create Cognito then refuses leaves the row. The email
    is kept as its hash (as the participants and the boards key emails): no role can change or remove an audit row,
    so a raw address there could never be erased (D5); the hash still matches the account's email."""
    at = now_iso()
    email_sha256 = hashlib.sha256(email.strip().lower().encode()).hexdigest()
    put_new_audit_row(table, {'pk': audit_key(context.ws), 'sk': audit_sort_key(at), 'kind': ACCOUNT_CREATION,
                              'actor': actor, 'email_sha256': email_sha256, 'at': at,
                              'platform_admin': context.platform_admin})


def _actor_still_admin(table_name: str, context: WorkspaceContext, actor: str, *others: str | None) -> dict | None:
    """The check that the acting admin is STILL admin when the transaction commits (closes the gap between the fresh
    read of their role and the write: a demotion in between refuses the write), or None: a platform admin acts by the
    group, not a row; a member acting on themselves needs none; and a row the transaction already touches (the target,
    the other admin it checks) cannot be named twice in one transaction."""
    if context.platform_admin or actor in others:
        return None
    return _still_admin(table_name, context.ws, actor)


def _raise_for_actor(codes: list[str | None], index: int | None, exc: ClientError) -> None:
    """403 when the acting admin's own check (at ``index``) failed: they stopped being admin meanwhile."""
    if index is not None and codes[index:index + 1] == ['ConditionalCheckFailed']:
        raise AuthorizationError(NO_LONGER_ADMIN) from exc


def _transact(table: Any, items: list[dict[str, Any]]) -> None:
    # A token per request: botocore's own retry of a transaction whose answer was lost succeeds instead of failing
    # its own conditions (DynamoDB keeps it idempotent for 10 minutes).
    table.meta.client.transact_write_items(TransactItems=items, ClientRequestToken=secrets.token_hex(16))


def add_member(table: Any, context: WorkspaceContext, account: Account, role: str, actor: str) -> dict[str, Any]:
    """Make ``account`` a member of the workspace with ``role``: the audit row, then ONE transaction of the
    ``MEMBER#`` and ``USER#`` puts (each conditional on a new key) and a check that the workspace is ``active``.
    409 when the account is already a member; the one workspace 404 when the workspace stopped being active."""
    ws = context.ws
    if _stored_role(table, ws, account.sub) is not None:
        raise ConflictError(ALREADY_MEMBER)
    _audit(table, context, kind=MEMBER_ADDED, actor=actor, target=account.sub, before=None, after=role,
           account=ACCOUNT_CREATED if account.created else ACCOUNT_EXISTING)
    joined_at = now_iso()
    member = {'role': role, 'invited_by': actor, 'joined_at': joined_at, 'email': account.email, 'name': account.name}
    fresh = 'attribute_not_exists(pk)'
    items: list[dict[str, Any]] = [
        {'Put': {'TableName': table.name, 'Item': {**_member_key(ws, account.sub), **member},
                 'ConditionExpression': fresh}},
        {'Put': {'TableName': table.name, 'Item': {**_user_key(ws, account.sub), 'name': context.name,
                                                   'slug': context.slug, 'role': role},
                 'ConditionExpression': fresh}},
        {'ConditionCheck': {'TableName': table.name, 'Key': {'pk': ws_key(ws), 'sk': 'META'},
                            'ConditionExpression': '#status = :active',
                            'ExpressionAttributeNames': {'#status': 'status'},
                            'ExpressionAttributeValues': {':active': ACTIVE}}},
    ]
    actor_check = _actor_still_admin(table.name, context, actor, account.sub)
    if actor_check is not None:
        items.append(actor_check)
    try:
        _transact(table, items)
    except ClientError as exc:
        codes = cancellation_codes(exc)
        _raise_for_actor(codes, 3 if actor_check is not None else None, exc)
        if codes[:1] == ['ConditionalCheckFailed']:
            raise ConflictError(ALREADY_MEMBER) from exc
        if codes[2:3] == ['ConditionalCheckFailed']:
            raise NotFoundError(NOT_FOUND) from exc
        if codes[1:2] == ['ConditionalCheckFailed']:
            # A "my workspaces" row without its MEMBER# row: an inconsistency to repair, said in the log.
            logger.warning('Workspace member add found a USER# row without its MEMBER# row', extra={'workspace_id': ws})
            raise ConflictError(ALREADY_MEMBER) from exc
        if 'TransactionConflict' in codes:
            raise ConflictError(CHANGED_MEANWHILE) from exc
        raise
    if account.created:
        logger.info('Workspace member added with a new account (Cognito emailed the temporary password)',
                    extra={'workspace_id': ws})
    else:
        # No mail path for account notices exists yet (the module docstring): the add is logged, not emailed.
        logger.info('Workspace member added; no notification email is sent', extra={'workspace_id': ws})
    return {'sub': account.sub, **member}


def _refuse_last_admin(table: Any, ws: str, sub: str, before: str, after: str | None) -> str | None:
    """The other admin the transaction must find still admin when ``sub`` stops being one; 409 when none."""
    if before != 'admin' or after == 'admin':
        return None
    other = _another_admin(table, ws, sub)
    if other is None:
        raise ConflictError(LAST_ADMIN)
    return other


def _run_change(table: Any, items: list[dict[str, Any]], other_admin: str | None, context: WorkspaceContext,
                actor: str, target: str) -> None:
    """The change's two row operations, then the other admin's check (if any), then the actor's (if any)."""
    other_index = actor_index = None
    if other_admin is not None:
        other_index = len(items)
        items.append(_still_admin(table.name, context.ws, other_admin))
    actor_check = _actor_still_admin(table.name, context, actor, target, other_admin)
    if actor_check is not None:
        actor_index = len(items)
        items.append(actor_check)
    try:
        _transact(table, items)
    except ClientError as exc:
        codes = cancellation_codes(exc)
        _raise_for_actor(codes, actor_index, exc)
        failed = 'ConditionalCheckFailed'
        # The member's row (index 0) or the other admin's changed since they were read, or another request was
        # changing them at the same moment (TransactionConflict): the caller reads again, a 409. Any other failed
        # condition (an inverse row missing) is an inconsistency, not the caller's to retry: it propagates.
        if codes[:1] == [failed] or (other_index is not None and codes[other_index:other_index + 1] == [failed]) \
                or 'TransactionConflict' in codes:
            raise ConflictError(CHANGED_MEANWHILE) from exc
        raise


def change_role(table: Any, context: WorkspaceContext, sub: str, role: str, actor: str) -> dict[str, str]:
    """Set member ``sub``'s role to ``role`` on their ``MEMBER#`` and ``USER#`` rows (one transaction, after the
    audit row). 404 for a non-member; 409 for the last admin's demotion or a membership that changed meanwhile;
    the same role changes and records nothing."""
    ws = context.ws
    before = _stored_role(table, ws, sub)
    if before is None:
        raise NotFoundError(MEMBER_NOT_FOUND)
    if before == role:
        return {'sub': sub, 'role': role}
    other_admin = _refuse_last_admin(table, ws, sub, before, role)
    _audit(table, context, kind=MEMBER_ROLE_CHANGED, actor=actor, target=sub, before=before, after=role)
    names, values = {'#role': 'role'}, {':after': role, ':before': before}
    _run_change(table, [
        {'Update': {'TableName': table.name, 'Key': _member_key(ws, sub), 'UpdateExpression': 'SET #role = :after',
                    'ConditionExpression': 'attribute_exists(pk) AND #role = :before',
                    'ExpressionAttributeNames': names, 'ExpressionAttributeValues': values}},
        # The inverse row must exist: an update without it would create a row with a role and no name or slug.
        {'Update': {'TableName': table.name, 'Key': _user_key(ws, sub), 'UpdateExpression': 'SET #role = :after',
                    'ConditionExpression': 'attribute_exists(pk)',
                    'ExpressionAttributeNames': names, 'ExpressionAttributeValues': {':after': role}}},
    ], other_admin, context, actor, sub)
    logger.info('Workspace member role changed', extra={'workspace_id': ws})
    return {'sub': sub, 'role': role}


def remove_member(table: Any, context: WorkspaceContext, sub: str, actor: str) -> None:
    """Delete member ``sub``'s ``MEMBER#`` and ``USER#`` rows (one transaction, after the audit row; ``actor ==
    sub`` is a leave). 404 for a non-member; 409 for the last admin or a membership that changed meanwhile."""
    ws = context.ws
    before = _stored_role(table, ws, sub)
    if before is None:
        raise NotFoundError(MEMBER_NOT_FOUND)
    other_admin = _refuse_last_admin(table, ws, sub, before, None)
    _audit(table, context, kind=MEMBER_LEFT if actor == sub else MEMBER_REMOVED, actor=actor, target=sub,
           before=before, after=None)
    _run_change(table, [
        {'Delete': {'TableName': table.name, 'Key': _member_key(ws, sub),
                    'ConditionExpression': 'attribute_exists(pk) AND #role = :before',
                    'ExpressionAttributeNames': {'#role': 'role'}, 'ExpressionAttributeValues': {':before': before}}},
        {'Delete': {'TableName': table.name, 'Key': _user_key(ws, sub)}},
    ], other_admin, context, actor, sub)
    logger.info('Workspace member removed', extra={'workspace_id': ws})


# ── A deleted user's memberships (the users API, DELETE /users/{username}) ──

@dataclass(frozen=True)
class UserMembership:
    """One workspace a user being deleted belongs to, as read before any write."""

    ws: str
    #: The workspace's name and slug, from the user's ``USER#`` row (the refusal names the workspace).
    name: str
    slug: str
    #: The ``MEMBER#`` row's role (the authority); None when only the ``USER#`` row is left.
    role: str | None
    #: For an admin: another member admin the removal checks is still one; None when there is none.
    other_admin: str | None

    @property
    def last_admin(self) -> bool:
        return self.role == 'admin' and self.other_admin is None


@dataclass(frozen=True)
class UserRemoval:
    """What ``remove_user_memberships`` removes: the user's memberships, read and checked."""

    sub: str
    memberships: tuple[UserMembership, ...]
    #: True when the caller is a platform admin now (live-checked; only they may leave a workspace without an admin).
    platform_admin: bool


def last_admin_message(names: list[str]) -> str:
    """The 409 of a user's delete that would leave workspaces without an admin, naming up to three of them."""
    quoted = [f'"{name}"' if name else 'an unnamed workspace' for name in names[:MAX_NAMED_WORKSPACES]]
    more = len(names) - len(quoted)
    which = ', '.join(quoted) + (f' and {more} more' if more else '')
    noun = 'workspace' if len(names) == 1 else 'workspaces'
    return (f'This user is the last admin of the {noun} {which}: make another member an admin there first, '
            'or ask a platform admin to delete the user and name a new admin afterwards.')


def _user_workspace_rows(table: Any, sub: str) -> list[dict]:
    """The user's ``USER#{sub}`` rows (every page, strongly consistent)."""
    return list(iter_query(table, {
        'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :ws)',
        'ExpressionAttributeValues': {':pk': f'USER#{sub}', ':ws': 'WS#'},
        'ConsistentRead': True,
    }))


def plan_user_removal(table: Any, sub: str, *, caller_is_platform_admin: Callable[[], bool]) -> UserRemoval:
    """Read every membership of ``sub`` (one Query of their ``USER#`` rows; per workspace their ``MEMBER#`` role and,
    for an admin, one Query for another admin) and check it may go: 409 when ``sub`` is the last member admin of a
    workspace, unless ``caller_is_platform_admin()`` (the live check; asked once, only when the user has a membership,
    and recorded on every audit row as ``platform_admin``) says yes. Writes nothing."""
    memberships = []
    malformed = 0
    for row in _user_workspace_rows(table, sub):
        sk, name, slug = text_fields(row, 'sk', 'name', 'slug')
        ws = sk.removeprefix('WS#')
        if not is_workspace_id(ws):
            malformed += 1
            continue
        role = _stored_role(table, ws, sub)
        other = _another_admin(table, ws, sub) if role == 'admin' else None
        memberships.append(UserMembership(ws=ws, name=name, slug=slug, role=role, other_admin=other))
    if malformed:
        logger.warning('Left out malformed my-workspaces rows of a deleted user', extra={'count': malformed})
    orphaned = [membership.name for membership in memberships if membership.last_admin]
    platform_admin = bool(memberships) and caller_is_platform_admin()
    if orphaned and not platform_admin:
        raise ConflictError(last_admin_message(orphaned))
    return UserRemoval(sub=sub, memberships=tuple(memberships), platform_admin=platform_admin)


def _remove_deleted_users_membership(table: Any, removal: UserRemoval, membership: UserMembership,
                                     actor: str) -> None:
    ws, sub = membership.ws, removal.sub
    context = WorkspaceContext(ws=ws, role='', name=membership.name, slug=membership.slug,
                               platform_admin=removal.platform_admin)
    _audit(table, context, kind=MEMBER_REMOVED, actor=actor, target=sub, before=membership.role, after=None,
           via=VIA_USER_DELETED, left_without_admin=membership.last_admin)
    member_delete: dict[str, Any] = {'TableName': table.name, 'Key': _member_key(ws, sub)}
    if membership.role is not None:
        # The role read above still holds (a promotion meanwhile would skip the last-admin check).
        member_delete.update(ConditionExpression='#role = :before', ExpressionAttributeNames={'#role': 'role'},
                             ExpressionAttributeValues={':before': membership.role})
    items: list[dict[str, Any]] = [{'Delete': member_delete},
                                   {'Delete': {'TableName': table.name, 'Key': _user_key(ws, sub)}}]
    if membership.other_admin is not None:
        items.append(_still_admin(table.name, ws, membership.other_admin))
    try:
        _transact(table, items)
    except ClientError as exc:
        codes = cancellation_codes(exc)
        if 'ConditionalCheckFailed' in codes or 'TransactionConflict' in codes:
            raise ConflictError(CHANGED_MEANWHILE) from exc
        raise


def remove_user_memberships(table: Any, removal: UserRemoval, actor: str) -> int:
    """Remove every membership ``plan_user_removal`` read: per workspace, its ``member_removed`` audit row (``via:
    user_deleted``; ``left_without_admin`` when the user was its last admin), then ONE transaction deleting the
    ``MEMBER#`` and ``USER#`` rows (the ``MEMBER#`` delete conditional on the role read, and for an admin a check that
    the other admin still is one). 409 when a membership changed meanwhile; any other fault propagates. The workspaces
    already done stay done: a retried delete reads only what is left. The number of memberships removed."""
    for membership in removal.memberships:
        _remove_deleted_users_membership(table, removal, membership, actor)
        if membership.last_admin:
            logger.warning('A deleted user was the last admin of a workspace: a platform admin can name one',
                           extra={'workspace_id': membership.ws})
    if removal.memberships:
        logger.info('Removed a deleted user from their workspaces', extra={'count': len(removal.memberships)})
    return len(removal.memberships)
