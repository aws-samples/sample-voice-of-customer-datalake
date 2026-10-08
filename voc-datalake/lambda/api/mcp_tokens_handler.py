"""Global MCP token management API (``voc-mcp-tokens-api``) — ``/connect/tokens/*``.

Behind Cognito. Every signed-in user manages THEIR OWN credentials for the global
MCP endpoint (``POST /mcp/global``, docs/mcp.md); nobody — admins included — can
list, revoke or read the audit log of somebody else's token through this API (a
foreign token answers 404, no existence leak).

Routes:
- ``GET    /connect/tokens``                    my tokens (active, expired and revoked), newest first
- ``POST   /connect/tokens``                    mint ``{name, scope, expires_in_days?, project_id?}``;
                                            the raw credential is returned ONCE
- ``DELETE /connect/tokens/{token_id}``         revoke (soft: the row and its audit stay listable)
- ``GET    /connect/tokens/{token_id}``         one token + a page of its tool calls, newest first

A credential minted by a credential is refused: a token acts AS its minter, so the
minter must be a person.

Own role (20 KB policy limit): projects table Query/GetItem/BatchGetItem/PutItem/
UpdateItem on the ``MCPGTOKEN`` partition only, plus GetItem on ``PROJECT#…`` META
(the pin check); jobs table Query on ``MCPAUDIT#…`` partitions only.

"My tokens" is a key-condition Query on the caller's creator-scoped pointer rows
(``CREATOR#{sub}#TOKEN#{id}``, written with the token in one transaction) plus a
consistent BatchGetItem of the token rows — never a read of other users' rows.
Until the backfill marker exists (scripts/mcp_tokens/backfill_creator_index.py)
the old filtered partition read is merged in, so pre-index tokens stay listed.
"""

from __future__ import annotations

import base64
import binascii
import json
from datetime import UTC, datetime
from typing import Any

from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError

from shared import mcp_global_tokens as gt
from shared import mcp_tokens, project_access, project_gate
from shared.api import api_handler, create_api_resolver
from shared.batch_get import batch_get_all
from shared.exceptions import (
    AuthorizationError,
    ConfigurationError,
    ConflictError,
    NotFoundError,
    ServiceError,
    ValidationError,
)
from shared.logging import logger, tracer
from shared.project_access import Caller
from shared.request_body import json_object_body
from shared.snapstart import api_route_warmer, register_snapshot_hooks
from shared.tables import get_jobs_table, get_projects_table

TOKEN_NOT_FOUND = 'Token not found'
# The endpoint every global token is for, relative to the API base URL. Returned
# by the list route so the Connect page never hard-codes it.
GLOBAL_ENDPOINT_PATH = '/mcp/global'

app = create_api_resolver()


def _now() -> datetime:
    return datetime.now(UTC)


def _caller() -> Caller:
    """A real signed-in person, or 403 — a credential cannot manage credentials."""
    caller = project_gate.caller_from_event(app.current_event.raw_event)
    if caller.delegated or not caller.subject:
        raise AuthorizationError('Only a signed-in user can manage MCP tokens')
    return caller


def _projects_table() -> Any:
    table = get_projects_table()
    if table is None:
        raise ConfigurationError('Projects table not configured')
    return table


def _jobs_table() -> Any:
    table = get_jobs_table()
    if table is None:
        raise ConfigurationError('Jobs table not configured')
    return table


def _paged_query(**kwargs: Any) -> list[dict]:
    """Every item of one projects-table Query, following pagination."""
    rows: list[dict] = []
    while True:
        response = _projects_table().query(**kwargs)
        rows.extend(item for item in response.get('Items', []) if isinstance(item, dict))
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            return rows
        kwargs['ExclusiveStartKey'] = last_key


def _indexed_token_ids(subject: str) -> list[str]:
    """The token ids on ``subject``'s pointer rows: a key-condition Query on the
    creator prefix, so no other user's row is read at all."""
    pointers = _paged_query(
        KeyConditionExpression=Key('pk').eq(gt.GLOBAL_TOKEN_PK)
        & Key('sk').begins_with(gt.creator_index_prefix(subject)),
        ProjectionExpression='token_id',
        ConsistentRead=True,
    )
    return [str(p['token_id']) for p in pointers if gt.is_path_id(p.get('token_id'))]


def _token_rows(token_ids: list[str]) -> list[dict]:
    """The ``TOKEN#`` rows for ``token_ids``, consistently, failing closed: a list
    that silently dropped a token would hide a live credential from the one person
    who can revoke it."""
    keys = [{'pk': gt.GLOBAL_TOKEN_PK, 'sk': gt.token_sk(token_id)} for token_id in sorted(set(token_ids))]
    return batch_get_all(_projects_table(), keys, failure=ServiceError('Failed to read your MCP tokens'))


def _legacy_rows_minted_by(subject: str) -> list[dict]:
    """The pre-index read: the token rows of the whole partition, filtered by minter.

    Only while the backfill marker is absent (see ``_creator_index_complete``).
    """
    return _paged_query(
        KeyConditionExpression=Key('pk').eq(gt.GLOBAL_TOKEN_PK) & Key('sk').begins_with(gt.token_sk('')),
        FilterExpression=Attr('created_by').eq(subject),
    )


# Once the marker has been seen it stays (the backfill never removes it), so a warm
# container stops paying the extra GetItem.
_index_state = {'complete': False}


def _creator_index_complete() -> bool:
    if not _index_state['complete']:
        marker = _projects_table().get_item(
            Key={'pk': gt.GLOBAL_TOKEN_PK, 'sk': gt.CREATOR_INDEX_MARKER_SK}, ConsistentRead=True,
        ).get('Item')
        _index_state['complete'] = isinstance(marker, dict)
    return _index_state['complete']


def _rows_minted_by(subject: str) -> list[dict]:
    """Every global token row minted by ``subject``.

    The pointer rows say WHICH tokens; the token rows themselves are still checked
    for ``created_by``, so a stray pointer can never surface someone else's token.
    """
    rows = {str(row.get('token_id')): row for row in _token_rows(_indexed_token_ids(subject))
            if row.get('created_by') == subject}
    if not _creator_index_complete():
        for row in _legacy_rows_minted_by(subject):
            rows.setdefault(str(row.get('token_id')), row)
    return list(rows.values())


def _owned_row(token_id: str, caller: Caller) -> dict:
    """The caller's own token row, or 404 (malformed id, unknown, or someone else's)."""
    if not token_id.startswith(mcp_tokens.TOKEN_ID_PREFIX) or not gt.is_path_id(token_id):
        raise NotFoundError(TOKEN_NOT_FOUND)
    item = _projects_table().get_item(
        Key={'pk': gt.GLOBAL_TOKEN_PK, 'sk': gt.token_sk(token_id)}, ConsistentRead=True,
    ).get('Item')
    if not isinstance(item, dict) or item.get('created_by') != caller.subject:
        raise NotFoundError(TOKEN_NOT_FOUND)
    return item


# ── Mint validation ─────────────────────────────────────────────────────────
def _token_name(body: dict) -> str:
    name = body.get('name')
    if not isinstance(name, str) or not name.strip():
        raise ValidationError('name is required')
    if len(name.strip()) > gt.MAX_TOKEN_NAME_LENGTH:
        raise ValidationError(f'name must be at most {gt.MAX_TOKEN_NAME_LENGTH} characters')
    return name.strip()


def _token_scope(body: dict) -> str:
    """REQUIRED, like the per-project mint: omitting it must not yield the wider grant."""
    scope = body.get('scope')
    if not gt.scope_is_valid(scope):
        raise ValidationError(f'scope is required and must be one of: {", ".join(gt.VALID_SCOPES)}')
    return str(scope)


def _token_expiry(body: dict, now: datetime) -> str:
    try:
        return gt.expiry_for(body.get('expires_in_days'), now)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc


def _token_project(body: dict, caller: Caller) -> str | None:
    """The optional project pin, which the minter must be able to view.

    Checked for admins too (who skip the access gate), so a pin always names a
    project that exists.
    """
    project_id = body.get('project_id')
    if project_id is None or project_id == '':
        return None
    if not gt.is_path_id(project_id):
        raise ValidationError('project_id is not a valid project id')
    table = _projects_table()
    project_gate.require_project_level(
        lambda: project_gate.read_gate_meta(table, project_id), caller, project_access.LEVEL_VIEW,
    )
    if caller.is_admin and not project_gate.read_gate_meta(table, project_id):
        raise NotFoundError(project_gate.PROJECT_NOT_FOUND)
    return str(project_id)


def _require_room_for_another(caller: Caller, now: datetime) -> None:
    active = [row for row in _rows_minted_by(caller.subject) if gt.token_status(row, now) == gt.STATUS_ACTIVE]
    if len(active) >= gt.MAX_ACTIVE_TOKENS_PER_USER:
        raise ConflictError(
            f'You already have {gt.MAX_ACTIVE_TOKENS_PER_USER} active MCP tokens; revoke one first'
        )


def _put_with_creator_index(item: dict[str, Any]) -> None:
    """The token row and its creator pointer, both or neither (one transaction).

    Each Put is conditional on a fresh sort key; TransactWriteItems is authorised
    per participant as PutItem, so it needs no grant of its own.
    """
    table = _projects_table()
    pointer = gt.creator_index_item(str(item['created_by']), str(item['token_id']), str(item['created_at']))
    fresh = 'attribute_not_exists(sk)'
    table.meta.client.transact_write_items(TransactItems=[
        {'Put': {'TableName': table.name, 'Item': item, 'ConditionExpression': fresh}},
        {'Put': {'TableName': table.name, 'Item': pointer, 'ConditionExpression': fresh}},
    ])


# ── Routes ──────────────────────────────────────────────────────────────────
@app.get('/connect/tokens')
@tracer.capture_method
def list_tokens():
    caller = _caller()
    now = _now()
    tokens = [gt.token_view(row, now) for row in _rows_minted_by(caller.subject)]
    tokens.sort(key=lambda t: str(t.get('created_at') or ''), reverse=True)
    return {
        'tokens': tokens,
        'endpoint_path': GLOBAL_ENDPOINT_PATH,
        # Only an admin's write token is offered run_agent (agent runs are admin-only).
        'can_mint_agent_runner': caller.is_admin,
        'limits': {
            'default_expiry_days': gt.DEFAULT_EXPIRY_DAYS,
            'max_expiry_days': gt.MAX_EXPIRY_DAYS,
            'max_active_tokens': gt.MAX_ACTIVE_TOKENS_PER_USER,
        },
    }


@app.post('/connect/tokens')
@tracer.capture_method
def mint_token():
    caller = _caller()
    body = json_object_body(app)
    now = _now()
    name = _token_name(body)
    scope = _token_scope(body)
    expires_at = _token_expiry(body, now)
    project_id = _token_project(body, caller)
    _require_room_for_another(caller, now)

    minted = mcp_tokens.mint_token()
    item: dict[str, Any] = {
        'pk': gt.GLOBAL_TOKEN_PK,
        'sk': gt.token_sk(minted.token_id),
        'token_id': minted.token_id,
        'name': name,
        # Only the SECRET half, hashed (shared.mcp_tokens): token_id stays loggable.
        'secret_hash': minted.secret_hash,
        'scope': scope,
        'created_by': caller.subject,
        # Cognito usernames are immutable, so the MCP Lambda can re-check the
        # minter's admin membership per run_agent call with one AdminListGroupsForUser.
        'created_by_username': caller.username,
        'minted_by_admin': caller.is_admin,
        'created_at': now.isoformat(),
        'expires_at': expires_at,
    }
    if project_id:
        item['project_id'] = project_id
    _put_with_creator_index(item)
    logger.info('Minted global MCP token', extra={'token_id': minted.token_id, 'scope': scope,
                                                  'pinned': bool(project_id)})
    # The one and only time the raw credential leaves this service.
    return {'token': minted.raw, **gt.token_view(item, now)}


@app.delete('/connect/tokens/<token_id>')
@tracer.capture_method
def revoke_token(token_id: str):
    caller = _caller()
    row = _owned_row(token_id, caller)
    now = _now()
    if not row.get('revoked_at'):
        try:
            updated = _projects_table().update_item(
                Key={'pk': gt.GLOBAL_TOKEN_PK, 'sk': gt.token_sk(token_id)},
                UpdateExpression='SET revoked_at = :now',
                ConditionExpression='attribute_exists(sk) AND attribute_not_exists(revoked_at)',
                ExpressionAttributeValues={':now': now.isoformat()},
                ReturnValues='ALL_NEW',
            )
            row = updated.get('Attributes', {**row, 'revoked_at': now.isoformat()})
            logger.info('Revoked global MCP token', extra={'token_id': token_id})
        except ClientError as exc:
            # A concurrent revoke won the race: the token is revoked either way.
            if exc.response.get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
                raise
            row = _owned_row(token_id, caller)
    return {'token': gt.token_view(row, now)}


def _decoded_cursor(raw: str | None, token_id: str) -> dict | None:
    """The audit page cursor, which must address this token's own partition."""
    if not raw:
        return None
    try:
        cursor = json.loads(base64.urlsafe_b64decode(raw.encode()).decode())
    except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
        raise ValidationError('cursor is invalid') from exc
    if (not isinstance(cursor, dict) or cursor.get('pk') != gt.audit_pk(token_id)
            or not isinstance(cursor.get('sk'), str) or set(cursor) != {'pk', 'sk'}):
        raise ValidationError('cursor is invalid')
    return cursor


def _encoded_cursor(last_key: object) -> str | None:
    if not isinstance(last_key, dict):
        return None
    return base64.urlsafe_b64encode(json.dumps(last_key).encode()).decode()


@app.get('/connect/tokens/<token_id>')
@tracer.capture_method
def token_detail(token_id: str):
    """One of my tokens, with a page of its audit log (tool calls, newest first)."""
    caller = _caller()
    row = _owned_row(token_id, caller)
    params = app.current_event.query_string_parameters or {}
    kwargs: dict[str, Any] = {
        'KeyConditionExpression': Key('pk').eq(gt.audit_pk(token_id)),
        'ScanIndexForward': False,
        'Limit': gt.AUDIT_PAGE_SIZE,
    }
    cursor = _decoded_cursor(params.get('cursor'), token_id)
    if cursor:
        kwargs['ExclusiveStartKey'] = cursor
    response = _jobs_table().query(**kwargs)
    return {
        'token': gt.token_view(row, _now()),
        'events': [gt.audit_view(item) for item in response.get('Items', [])],
        'next_cursor': _encoded_cursor(response.get('LastEvaluatedKey')),
    }


# SnapStart (lib/utils/snapstart.ts): build the DynamoDB resource and both tables
# before the snapshot, so a restored environment skips them.
register_snapshot_hooks(get_projects_table, get_jobs_table, api_route_warmer(app))


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
