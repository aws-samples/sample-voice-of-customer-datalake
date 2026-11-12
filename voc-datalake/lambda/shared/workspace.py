"""The workspace a request acts in (docs/multi-workspace.md, "Control plane", "Request flow" and "Roles").

The web app names the workspace in the ``X-Workspace-Id`` header (looked up case-insensitively). A
workspace id is ``ws_`` plus a 26-character ULID in Crockford base32 (upper case, first character 0-7).

* No header (or an empty one): 400 ``ValidationError``.
* A malformed id, a workspace that does not exist, one whose status is not ``active`` (``deleting``), or a
  caller who is not a member: 404 ``NotFoundError``, with ONE message for all of them, so an answer never
  confirms that another team's workspace exists.
* A member gets the role of their ``MEMBER#{sub}`` row (``admin``, ``editor`` or ``viewer``); a row with any
  other role counts as no membership.
* A caller in the Cognito group ``platform-admins`` who is not a member, or a member below ``admin``, passes as
  ``admin`` (decision 2: full admin rights in any workspace), flagged ``platform_admin``, and the entry writes an
  audit row ``AUDIT#WS#{ws}`` / ``{iso}#{random}`` (kind ``platform_admin_entry``, the actor's sub, the time)
  with a conditional put, so it never overwrites a row. The partition starts with ``AUDIT#`` so the audit-row
  guard covers it (lib/utils/audit-row-guard.ts: no role may change or remove it, only this API's role may put
  one) and the role's PutItem is scoped to ``AUDIT#WS#*`` (lib/stacks/api-workspaces-lambda.ts).
  When that row cannot be written, the entry is refused (the error propagates, nothing is cached).

Warm-container cache. A resolved membership is kept per ``(workspace, sub)`` for ``MEMBERSHIP_TTL_SECONDS``
(30 s) in the ``MembershipCache`` the handler owns, so a page's burst of calls costs two GetItems once. A
platform-admin entry writes its audit row once per cache fill, not once per request: one row per entry
and per 30 s of continued use, per warm container. Refusals are not cached, so a new membership works at
once; a removed membership, a changed role or a workspace set to ``deleting`` takes effect within the TTL.

The table layout (``voc-workspaces``, VocCoreStack):

    WS#{ws}       / META             name, slug, status
    WS#{ws}       / MEMBER#{sub}     role
    USER#{sub}    / WS#{ws}          name, slug, role: the inverse row behind "my workspaces"
    AUDIT#WS#{ws} / {iso}#{random}   kind, actor, at: a platform admin's entry

The caller's sub identifies a person: it is stored in the audit row and never logged.
"""
from __future__ import annotations

import re
import secrets
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Final

from shared.api import get_caller_groups, get_caller_subject
from shared.dynamo_paging import iter_query
from shared.exceptions import NotFoundError, ValidationError
from shared.http_cache import request_header
from shared.logging import logger
from shared.timestamps import now_iso

#: The request header that names the workspace (HTTP header names are case-insensitive).
WORKSPACE_HEADER: Final = 'x-workspace-id'
#: ``ws_`` + a ULID: 26 Crockford base32 characters (no I, L, O, U), the first one 0-7 (128 bits).
_WORKSPACE_ID: Final = re.compile(r'ws_[0-7][0-9A-HJKMNP-TV-Z]{25}')
ROLES: Final = frozenset({'viewer', 'editor', 'admin'})
PLATFORM_ADMIN_GROUP: Final = 'platform-admins'
PLATFORM_ADMIN_ENTRY: Final = 'platform_admin_entry'
ACTIVE: Final = 'active'
MEMBERSHIP_TTL_SECONDS: Final = 30.0
#: A warm container keeps at most this many memberships; a full cache starts again empty.
MAX_CACHED_MEMBERSHIPS: Final = 1024
#: The one answer for a malformed id, a missing or deleting workspace and a caller who is not a member.
NOT_FOUND: Final = 'Workspace not found'


@dataclass(frozen=True)
class WorkspaceContext:
    """The workspace a request acts in and the caller's role there."""

    ws: str
    role: str
    name: str
    slug: str
    #: True when a platform admin entered without being a member admin (audited).
    platform_admin: bool


class MembershipCache:
    """Resolved memberships of one warm container, per ``(workspace, sub, platform admin or not)``, for
    ``ttl_seconds``."""

    def __init__(self, ttl_seconds: float = MEMBERSHIP_TTL_SECONDS,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._ttl = ttl_seconds
        self._clock = clock
        self._entries: dict[tuple[str, str, bool], tuple[float, WorkspaceContext]] = {}

    def get(self, ws: str, sub: str, platform_admin: bool = False) -> WorkspaceContext | None:
        key = (ws, sub, platform_admin)
        entry = self._entries.get(key)
        if entry is None:
            return None
        expires_at, context = entry
        if self._clock() >= expires_at:
            del self._entries[key]
            return None
        return context

    def put(self, ws: str, sub: str, context: WorkspaceContext, platform_admin: bool = False) -> None:
        if len(self._entries) >= MAX_CACHED_MEMBERSHIPS:
            self._entries.clear()
        self._entries[(ws, sub, platform_admin)] = (self._clock() + self._ttl, context)


def ws_key(ws: str, *parts: str) -> str:
    """``WS#{ws}#a#b``: a key inside the workspace. Refuses (ValueError) an id that is not well formed."""
    if not _WORKSPACE_ID.fullmatch(ws):
        raise ValueError('not a workspace id')
    return '#'.join(('WS', ws, *parts))


def _workspace_id(event: Mapping[str, Any]) -> str:
    value = request_header(event, WORKSPACE_HEADER)
    ws = value.strip() if isinstance(value, str) else ''
    if not ws:
        raise ValidationError('The X-Workspace-Id header is required')
    if not _WORKSPACE_ID.fullmatch(ws):
        raise NotFoundError(NOT_FOUND)
    return ws


def _texts(item: Mapping[str, Any], *fields: str) -> list[str]:
    """Each ``item[field]`` that is text, else ``''``, in the order asked."""
    return [value if isinstance(value := item.get(field), str) else '' for field in fields]


def _item(table: Any, pk: str, sk: str) -> dict:
    """One row, read strongly consistent: a cache fill sees a removed member or a `deleting` status at once."""
    found = table.get_item(Key={'pk': pk, 'sk': sk}, ConsistentRead=True).get('Item')
    return found if isinstance(found, dict) else {}


def audit_key(ws: str) -> str:
    """``AUDIT#WS#{ws}``: the partition of a workspace's entry audit rows (under the audit-row guard)."""
    return f'AUDIT#{ws_key(ws)}'


def _audit_platform_admin_entry(table: Any, ws: str, sub: str) -> None:
    at = now_iso()
    table.put_item(
        Item={'pk': audit_key(ws), 'sk': f'{at}#{secrets.token_hex(4)}',
              'kind': PLATFORM_ADMIN_ENTRY, 'actor': sub, 'at': at},
        ConditionExpression='attribute_not_exists(pk)',
    )
    logger.info('Platform admin entered a workspace', extra={'workspace_id': ws})


def _load(table: Any, ws: str, sub: str, platform_admin: bool) -> WorkspaceContext:
    stored = _item(table, ws_key(ws), f'MEMBER#{sub}').get('role')
    role = stored if isinstance(stored, str) and stored in ROLES else None
    # Decision 2: a platform admin enters with full admin rights, a member with a lower role too (audited).
    enters_as_platform_admin = platform_admin and role != 'admin'
    if role is None and not enters_as_platform_admin:
        # Answered before the workspace row is read: a non-member costs the same one read whether or not the
        # workspace exists, so neither the answer nor its timing confirms another team's workspace.
        raise NotFoundError(NOT_FOUND)
    meta = _item(table, ws_key(ws), 'META')
    if meta.get('status') != ACTIVE:
        raise NotFoundError(NOT_FOUND)
    name, slug = _texts(meta, 'name', 'slug')
    if enters_as_platform_admin:
        _audit_platform_admin_entry(table, ws, sub)
        return WorkspaceContext(ws=ws, role='admin', name=name, slug=slug, platform_admin=True)
    return WorkspaceContext(ws=ws, role=role or '', name=name, slug=slug, platform_admin=False)


def resolve_workspace(table: Any, event: dict, cache: MembershipCache) -> WorkspaceContext:
    """The workspace ``event``'s ``X-Workspace-Id`` names and the caller's role in it (see the module docstring)."""
    ws = _workspace_id(event)
    sub = get_caller_subject(event)
    # Part of the cache key: a token that gained or lost the group is resolved again, not served the old answer.
    platform_admin = PLATFORM_ADMIN_GROUP in get_caller_groups(event)
    context = cache.get(ws, sub, platform_admin)
    if context is None:
        context = _load(table, ws, sub, platform_admin)
        cache.put(ws, sub, context, platform_admin)
    return context


def list_my_workspaces(table: Any, sub: str) -> list[dict[str, str]]:
    """The caller's workspaces ``[{id, name, slug, role}]`` from their ``USER#{sub}`` rows, by name.

    One Query of the caller's own partition (every page). Each ``role`` is the membership row's; the role a
    platform admin acts with inside a workspace (``resolve_workspace``, decision 2) can be higher. A row whose id
    or role is not well formed is left out, and the count is logged. The rows carry no status: a workspace being deleted stays listed until the delete removes its
    rows, and entering it answers 404 (``resolve_workspace``).
    """
    rows = iter_query(table, {
        'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :ws)',
        'ExpressionAttributeValues': {':pk': f'USER#{sub}', ':ws': 'WS#'},
    })
    workspaces = []
    left_out = 0
    for row in rows:
        sk, name, slug, role = _texts(row, 'sk', 'name', 'slug', 'role')
        ws = sk.removeprefix('WS#')
        if _WORKSPACE_ID.fullmatch(ws) and role in ROLES:
            workspaces.append({'id': ws, 'name': name, 'slug': slug, 'role': role})
        else:
            left_out += 1
    if left_out:
        # A broken inverse row would otherwise only vanish from the picker. The count, never the caller's sub.
        logger.warning('Left out malformed my-workspaces rows', extra={'count': left_out})
    return sorted(workspaces, key=lambda workspace: (workspace['name'].casefold(), workspace['id']))
