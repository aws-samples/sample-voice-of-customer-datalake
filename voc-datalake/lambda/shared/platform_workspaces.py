"""The platform console's workspaces: create and list (docs/multi-workspace.md, "Control plane" and "Credentials").

Platform admins only; the routes (``POST /platform/workspaces``, ``GET /platform/workspaces``) live in
lambda/api/workspaces_handler.py, which checks the caller live first (shared/platform_admin.py).

Creating a workspace is ONE DynamoDB transaction (all or nothing), every put conditional on a new key:

    SLUG#{slug}     / META              workspace_id, created_at: the slug guard (taken: 409, nothing written)
    WS#{ws}         / META              name, slug, status active, created_by, created_at, secret_status pending
    WS#{ws}         / MEMBER#{sub}      role admin, invited_by (the creator), joined_at
    USER#{sub}      / WS#{ws}           name, slug, role admin: the creator's "my workspaces" row
    WORKSPACES      / {name}#{ws}       workspace_id, name, slug, status, created_at, secret_status: the listing row
    AUDIT#WS#{ws}   / {iso}#{random}    kind workspace_created, actor, at, slug (under the audit-row guard)

No row carries ``ttl``: only ``INVITE#`` rows expire (lib/customer-data-deletes.test.ts pins it).

The listing partition ``WORKSPACES`` is sorted by the name (case-folded) and then the id, so the list is one paged
Query, never a Scan. It is a single partition read only by platform admins and written once per created
workspace, far under a partition's limits. A later rename or status change moves or updates the listing row too.

The credentials secret ``{prefix}/{ws}/credentials`` (prefix ``voc/ws``, ``<deployment prefix>-voc/ws`` in a
prefixed deployment) is created AFTER the transaction, encrypted with the deployment's customer-managed key, with
``{}`` as its first value and the tag ``workspace_id``. Its name is built only from the id generated here, never
from the request. A secret that already exists under that name is kept when it carries this workspace's tag.
Until the secret is there the workspace's ``META`` says ``secret_status: pending``; the create flips it to
``ready`` once the secret exists. A secret that could not be made leaves ``pending`` (and the answer says so):
the workspace is not rolled back, because its audit row stays (D4) and deleting a workspace is an open tenet
question (D5).
"""
from __future__ import annotations

import re
import secrets
import time
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.exceptions import ConflictError, ValidationError
from shared.feedback_cursor import TABLE_KEY_FIELDS, decode_key_cursor, encode_key_cursor
from shared.ids import is_key_collision
from shared.logging import logger
from shared.request_body import reject_unknown_fields, validated_text
from shared.timestamps import now_iso
from shared.workspace import ACTIVE, audit_key, audit_sort_key, is_workspace_id, text_fields, ws_key
from shared.workspace_ids import credentials_secret_name

NAME_MAX_CHARS: Final = 80
#: 3 to 40 of a-z, 0-9 and '-', neither first nor last a '-'.
_SLUG: Final = re.compile(r'[a-z0-9][a-z0-9-]{1,38}[a-z0-9]')
#: Slugs that would read as a part of the platform in a ``/w/{slug}`` address or a mail address.
RESERVED_SLUGS: Final = frozenset({'admin', 'api', 'app', 'platform', 'www'})
LISTING_PK: Final = 'WORKSPACES'
WORKSPACE_CREATED: Final = 'workspace_created'
#: The values of META's ``secret_status``: the credentials secret is not there yet, or is.
CREDENTIALS_PENDING: Final = 'pending'
CREDENTIALS_READY: Final = 'ready'
#: The tag key that names the workspace on its credentials secret.
WORKSPACE_TAG_KEY: Final = 'workspace_id'
SLUG_TAKEN: Final = 'That slug is taken: choose another'
#: Crockford base32: 0-9 and A-Z without I, L, O and U.
_CROCKFORD: Final = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
_TIME_BITS: Final = 48
_RANDOM_BITS: Final = 80
_FRESH: Final = 'attribute_not_exists(pk)'


@dataclass(frozen=True)
class NewWorkspace:
    """A validated create request."""

    name: str
    slug: str


class CredentialsSecretError(Exception):
    """A secret by the workspace's name exists but is not this workspace's (no ``workspace_id`` tag for it)."""


def parse_new_workspace(body: Mapping[str, Any]) -> NewWorkspace:
    """``{name, slug}`` validated, or a 400 that says what to fix."""
    reject_unknown_fields(body, ('name', 'slug'))
    name = validated_text(body.get('name'), 'name', NAME_MAX_CHARS, required=True)
    if any(unicodedata.category(char) == 'Cc' for char in name):
        raise ValidationError('name must not contain control characters')
    slug = body.get('slug')
    if not isinstance(slug, str) or not _SLUG.fullmatch(slug):
        raise ValidationError('slug must be 3 to 40 characters of a-z, 0-9 and "-", not starting or ending with "-"')
    if slug in RESERVED_SLUGS:
        raise ValidationError(f'slug "{slug}" is reserved: choose another')
    return NewWorkspace(name=name, slug=slug)


def new_workspace_id(now_ms: int | None = None) -> str:
    """``ws_`` + a ULID: 48 bits of milliseconds then 80 random bits, as 26 Crockford base32 characters (first 0-7)."""
    millis = time.time_ns() // 1_000_000 if now_ms is None else now_ms
    value = ((millis & ((1 << _TIME_BITS) - 1)) << _RANDOM_BITS) | secrets.randbits(_RANDOM_BITS)
    return 'ws_' + ''.join(_CROCKFORD[(value >> shift) & 31] for shift in range(125, -1, -5))


def _listing_sort_key(name: str, ws: str) -> str:
    return f'{name.casefold()}#{ws}'


def _put(table_name: str, item: dict[str, Any]) -> dict[str, Any]:
    return {'Put': {'TableName': table_name, 'Item': item, 'ConditionExpression': _FRESH}}


def _creation_items(table_name: str, new: NewWorkspace, ws: str, creator: str, at: str) -> list[dict[str, Any]]:
    """The transaction's puts (see the module docstring); the slug guard is first, so a 409 reads index 0."""
    base = {'name': new.name, 'slug': new.slug}
    return [_put(table_name, item) for item in (
        {'pk': f'SLUG#{new.slug}', 'sk': 'META', 'workspace_id': ws, 'created_at': at},
        {'pk': ws_key(ws), 'sk': 'META', **base, 'status': ACTIVE, 'created_by': creator, 'created_at': at,
         'secret_status': CREDENTIALS_PENDING},
        {'pk': ws_key(ws), 'sk': f'MEMBER#{creator}', 'role': 'admin', 'invited_by': creator, 'joined_at': at},
        {'pk': f'USER#{creator}', 'sk': f'WS#{ws}', **base, 'role': 'admin'},
        {'pk': LISTING_PK, 'sk': _listing_sort_key(new.name, ws), 'workspace_id': ws, **base, 'status': ACTIVE,
         'created_at': at, 'secret_status': CREDENTIALS_PENDING},
        {'pk': audit_key(ws), 'sk': audit_sort_key(at), 'kind': WORKSPACE_CREATED, 'actor': creator, 'at': at,
         'slug': new.slug},
    )]


def create_workspace(table: Any, new: NewWorkspace, creator: str) -> str:
    """Write the new workspace in one transaction and return its id; 409 when the slug is taken."""
    ws = new_workspace_id()
    try:
        # The token makes botocore's retry of a create whose answer was lost succeed (DynamoDB keeps it idempotent
        # for 10 minutes) instead of failing its own slug guard as a false 409.
        table.meta.client.transact_write_items(
            TransactItems=_creation_items(table.name, new, ws, creator, now_iso()), ClientRequestToken=ws)
    except ClientError as exc:
        if is_key_collision(exc, put_index=0):
            raise ConflictError(SLUG_TAKEN) from exc
        raise
    logger.info('Workspace created', extra={'workspace_id': ws})
    return ws


def ensure_credentials_secret(client: Any, *, prefix: str, ws: str, kms_key_arn: str) -> None:
    """Create the workspace's secret (``{}``, the customer-managed key, the ``workspace_id`` tag), or keep the one that
    is already there for this workspace. ``CredentialsSecretError`` when that one is not this workspace's; every
    Secrets Manager error propagates."""
    name = credentials_secret_name(prefix, ws)
    try:
        client.create_secret(Name=name, KmsKeyId=kms_key_arn, SecretString='{}',
                             Description='Plugin credentials of one workspace (docs/multi-workspace.md)',
                             Tags=[{'Key': WORKSPACE_TAG_KEY, 'Value': ws}])
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') != 'ResourceExistsException':
            raise
        # A retried create whose first attempt landed: keep it, if it is this workspace's.
        tags = client.describe_secret(SecretId=name).get('Tags', [])
        if {'Key': WORKSPACE_TAG_KEY, 'Value': ws} not in tags:
            raise CredentialsSecretError(name) from exc


def mark_secret_ready(table: Any, ws: str, name: str) -> None:
    """``secret_status: ready`` on the workspace's ``META`` and its listing row together (one transaction, each only
    while it exists and is ``pending``), so the platform list shows which workspaces still lack their secret."""
    def ready(key: dict[str, str]) -> dict[str, Any]:
        return {'Update': {
            'TableName': table.name, 'Key': key, 'UpdateExpression': 'SET secret_status = :ready',
            'ConditionExpression': 'attribute_exists(pk) AND secret_status = :pending',
            'ExpressionAttributeValues': {':ready': CREDENTIALS_READY, ':pending': CREDENTIALS_PENDING},
        }}

    # The token makes an SDK retry of a mark that landed (its answer lost) succeed, instead of failing its own
    # `pending` condition and reporting a false `pending` (35 characters, under DynamoDB's 36).
    table.meta.client.transact_write_items(TransactItems=[
        ready({'pk': ws_key(ws), 'sk': 'META'}),
        ready({'pk': LISTING_PK, 'sk': _listing_sort_key(name, ws)}),
    ], ClientRequestToken=f'{ws}-ready')


def list_workspaces(table: Any, *, limit: int, cursor: str | None) -> tuple[list[dict[str, str]], str | None]:
    """One page of every workspace ``[{id, name, slug, status, created_at, secret_status}]`` by name, and the next page's cursor.

    One Query of the listing partition (never a Scan). ``ValueError`` for a cursor that did not come from it. A
    row whose id is not well formed is left out and counted in the log.
    """
    request: dict[str, Any] = {
        'KeyConditionExpression': 'pk = :pk',
        'ExpressionAttributeValues': {':pk': LISTING_PK},
        'Limit': limit,
        # A workspace created a moment ago is listed at once.
        'ConsistentRead': True,
    }
    if cursor:
        request['ExclusiveStartKey'] = decode_key_cursor(cursor, TABLE_KEY_FIELDS, ('pk', LISTING_PK))
    response = table.query(**request)
    workspaces = []
    for row in response.get('Items', []):
        ws, name, slug, status, created_at, secret_status = text_fields(
            row, 'workspace_id', 'name', 'slug', 'status', 'created_at', 'secret_status')
        if is_workspace_id(ws):
            workspaces.append({'id': ws, 'name': name, 'slug': slug, 'status': status, 'created_at': created_at,
                               'secret_status': secret_status})
    if left_out := len(response.get('Items', [])) - len(workspaces):
        logger.warning('Left out malformed workspace listing rows', extra={'count': left_out})
    last = response.get('LastEvaluatedKey')
    sk = last.get('sk') if isinstance(last, Mapping) else None
    return workspaces, encode_key_cursor({'pk': LISTING_PK, 'sk': sk}) if isinstance(sk, str) and sk else None
