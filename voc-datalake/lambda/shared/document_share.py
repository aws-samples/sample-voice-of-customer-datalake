"""Review links for a PR/FAQ or PRD series (docs/document-review.md -> Share for review).

One ACTIVE link per series. Rows in the projects table:

- ``DOCSHARE#{share_id}`` / ``META``: the link (project, series, type, base title, audience,
  ``expires_at_epoch``, ``revoked``, creator). Read by the review routes and by the board pool's
  PreSignUp trigger (``shared.review_share_audience``). Kept after revocation or expiry, with a
  DynamoDB ``ttl`` 30 days past expiry, so an old link answers "no longer valid" for a while.
- ``DCOMMENTS#{project_id}#{series_id}`` / ``SHARE``: which link is the series' current one.
- ``DCRATE#{share_id}#{email digest}`` / ``{UTC day}``: a reviewer's comments that day (``ttl``).

Anyone who can EDIT the project creates or revokes the link (the route's gate); a reviewer signs
in with the board pool's emailed code and may read the newest version and comment, nothing else.

In a workspace (since 7.37.00, docs/multi-workspace.md, the project plan, 3e; no route passes one yet) each row is the
workspace's (``WS#{ws}#DOCSHARE#{id}``, ``WS#{ws}#DCOMMENTS#…``, ``WS#{ws}#DCRATE#…``: shared/project_keys.py), every
call through the workspace layer, and a new link is ONE scoped transaction: the link's deployment-wide routing row
``DOCSHARE#{id}`` naming the workspace (shared/ws_repo.py ``route_share_id``, the layer's own entry), the link, the
series' pointer, the series' row among the project's commented ones (``comment_series_item``) and the link's row in the
workspace's registry ``WS#{ws}#DOCSHARE_IDS`` (which the hard delete reads). A reviewer's link is resolved by its id
alone (``require_share_for``): the ``DOCSHARE#`` row, and for a routing row the link read from the workspace it names.
Without a workspace every request is the one sent before.
"""
from __future__ import annotations

import secrets
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.aws import is_conditional_check_failure
from shared.document_comments import email_digest
from shared.dynamo_values import plain
from shared.exceptions import ConflictError, NotFoundError, TooManyRequestsError, ValidationError
from shared.feature_boards_audience import audience_emails
from shared.feature_boards_limits import RATE_LIMITED
from shared.ingest_tables import scoped_calls
from shared.participants_settings import validated_domains
from shared.project_keys import (
    comment_series_item,
    comments_pk,
    review_link_key,
    review_link_registry_key,
    reviewer_rate_pk,
)
from shared.project_writes import transact_project_writes
from shared.review_share_audience import (
    MODE_ANYONE,
    MODE_LIST,
    MODES,
    is_active,
    is_share_id,
    routed_share,
    share_admits,
)
from shared.workspace_config import get_scoped_item
from shared.ws_repo import WorkspaceScope, read_share_route, route_share_id

DEFAULT_EXPIRY_DAYS: Final = 30
MAX_EXPIRY_DAYS: Final = 90
MAX_AUDIENCE_DOMAINS: Final = 20
MAX_AUDIENCE_EMAILS: Final = 200
# A reviewer's new threads + replies per UTC day on one link (an `anyone` link is open to the world).
MAX_REVIEWER_WRITES_PER_DAY: Final = 40
KEPT_AFTER_EXPIRY_SECONDS: Final = 30 * 86_400
SHARE_INDEX_SK: Final = 'SHARE'
LINK_GONE: Final = 'This review link has expired or was turned off'
RATE_TTL_SECONDS: Final = 2 * 86_400
SECONDS_PER_DAY: Final = 86_400
MAX_ACTOR_NAME_CHARS: Final = 120
REVIEW_PATH_PREFIX: Final = '/review/'


def new_share_id() -> str:
    return f'shr_{secrets.token_hex(16)}'


def _now_epoch() -> int:
    return int(time.time())


def validate_share_body(body: Mapping[str, Any]) -> dict[str, Any]:
    """``{audience?: {mode, domains?, emails?}, expires_in_days?}`` (default: anyone, 30 days)."""
    if set(body) - {'audience', 'expires_in_days'}:
        raise ValidationError('body must be {audience?, expires_in_days?}')
    days = body.get('expires_in_days', DEFAULT_EXPIRY_DAYS)
    if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= MAX_EXPIRY_DAYS:
        raise ValidationError(f'expires_in_days must be a whole number from 1 to {MAX_EXPIRY_DAYS}')
    return {'audience': _audience(body.get('audience')), 'expires_in_days': days}


def _audience(raw: object) -> dict[str, Any]:
    if raw is None:
        return {'mode': MODE_ANYONE, 'domains': [], 'emails': []}
    if not isinstance(raw, Mapping) or set(raw) - {'mode', 'domains', 'emails'} or raw.get('mode') not in MODES:
        raise ValidationError(f'audience must be {{mode: {"|".join(MODES)}, domains?, emails?}}')
    try:
        domains = validated_domains(raw.get('domains') or [], 'audience.domains', MAX_AUDIENCE_DOMAINS)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    emails = audience_emails(raw.get('emails') or [], MAX_AUDIENCE_EMAILS)
    if raw['mode'] == MODE_LIST and not domains and not emails:
        raise ValidationError('A list audience needs at least one domain or email address')
    return {'mode': raw['mode'], 'domains': domains, 'emails': emails}


def share_view(item: Mapping[str, Any]) -> dict[str, Any]:
    """A link as its project's team sees it (the SPA builds the full URL from its own origin)."""
    view = {key: item.get(key) for key in (
        'share_id', 'series_id', 'document_type', 'base_title', 'audience', 'created_at', 'created_by_name',
        'expires_at', 'revoked',
    )}
    view['path'] = f'{REVIEW_PATH_PREFIX}{item.get("share_id", "")}'
    view['active'] = is_active(item, _now_epoch())
    return plain(view)


def _index_key(project_id: str, series_id: str, workspace: WorkspaceScope | None) -> dict[str, str]:
    return {'pk': comments_pk(project_id, series_id, workspace=workspace), 'sk': SHARE_INDEX_SK}


def _get(table: Any, key: Mapping[str, str], workspace: WorkspaceScope | None) -> dict[str, Any] | None:
    """The row at ``key`` (strongly consistent; the workspace's view when given), or None."""
    return get_scoped_item(table, key, workspace, ConsistentRead=True) or None


def current_share(table: Any, project_id: str, series_id: str, *,
                  workspace: WorkspaceScope | None = None) -> dict[str, Any] | None:
    """The series' active link, or None (the workspace's series when given)."""
    index = _get(table, _index_key(project_id, series_id, workspace), workspace)
    share_id = index.get('share_id') if index else None
    share = _get(table, review_link_key(share_id, workspace=workspace), workspace) if is_share_id(share_id) else None
    return share if is_active(share, _now_epoch()) else None


def create_share(table: Any, *, project_id: str, series: Mapping[str, str], document_id: str,
                 creator: Mapping[str, str], values: Mapping[str, Any],
                 workspace: WorkspaceScope | None = None) -> tuple[dict[str, Any], bool]:
    """The series' active link, creating one when there is none: ``(link, created)``. In a workspace the link's
    routing row, its series' listing and its registry row go in the same transaction (the module docstring)."""
    existing = current_share(table, project_id, series['series_id'], workspace=workspace)
    if existing is not None:
        return existing, False
    now = datetime.now(UTC)
    expires = _now_epoch() + int(values['expires_in_days']) * SECONDS_PER_DAY
    share_id = new_share_id()
    item = {
        **review_link_key(share_id, workspace=workspace), 'share_id': share_id, 'project_id': project_id,
        'document_id': document_id,
        'series_id': series['series_id'], 'document_type': series['document_type'], 'base_title': series['base_title'],
        'audience': values['audience'], 'revoked': False, 'created_at': now.isoformat(),
        'created_by_sub': creator.get('sub', ''), 'created_by_name': creator.get('name', ''),
        'expires_at_epoch': expires, 'expires_at': datetime.fromtimestamp(expires, UTC).isoformat(),
        'ttl': expires + KEPT_AFTER_EXPIRY_SECONDS,
    }
    index = {**_index_key(project_id, series['series_id'], workspace), 'share_id': share_id,
             'updated_at': now.isoformat()}
    entries = [
        {'Put': {'TableName': table.name, 'Item': item, 'ConditionExpression': 'attribute_not_exists(pk)'}},
        {'Put': {'TableName': table.name, 'Item': index}},
    ]
    route = None
    if workspace is not None:
        route = route_share_id(share_id, workspace=workspace, routed_at=now.isoformat(), ttl=item['ttl'])
        entries += _workspace_rows(table, project_id, series['series_id'], share_id, now.isoformat(), workspace)
    try:
        transact_project_writes(table, entries, workspace=workspace, outside=route)
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') == 'TransactionCanceledException':
            raise ConflictError('The review link changed meanwhile; reload and try again') from error
        raise
    return item, True


def _workspace_rows(table: Any, project_id: str, series_id: str, share_id: str, at: str,
                    workspace: WorkspaceScope) -> list[dict[str, Any]]:
    """A workspace link's other two rows: its series among the project's commented ones (shared/project_keys.py
    ``comment_series_item``, which says why this put is unconditioned) and the link in the workspace's registry (only
    if new), naming the link's project and series, so the per-project delete (3h) reaches a project's links, revoked
    ones too, and prunes their registry rows. No ``ttl``: the registry row stays until the workspace's delete, so that
    delete always finds the link, whose routing row alone expires with it, leaving an expired link dark."""
    listing = comment_series_item(project_id, series_id, at, workspace=workspace)
    registry = {**review_link_registry_key(share_id, workspace=workspace), 'created_at': at, 'project_id': project_id,
                'series_id': series_id}
    return [{'Put': {'TableName': table.name, 'Item': listing}},
            {'Put': {'TableName': table.name, 'Item': registry, 'ConditionExpression': 'attribute_not_exists(pk)'}}]


def revoke_share(table: Any, project_id: str, series_id: str, actor_name: str, *,
                 workspace: WorkspaceScope | None = None) -> bool:
    """Turn off the series' link (kept as revoked); False when there was none (the workspace's series when given)."""
    index = _get(table, _index_key(project_id, series_id, workspace), workspace)
    share_id = index.get('share_id') if index else None
    if not is_share_id(share_id):
        return False
    calls = scoped_calls(table, workspace)
    try:
        calls.update_item(
            Key=review_link_key(share_id, workspace=workspace), UpdateExpression='SET revoked = :yes, revoked_by = :by',
            ConditionExpression='attribute_exists(pk)',
            ExpressionAttributeValues={':yes': True, ':by': actor_name[:MAX_ACTOR_NAME_CHARS]},
        )
    except ClientError as error:
        if not is_conditional_check_failure(error):
            raise
    calls.delete_item(Key=_index_key(project_id, series_id, workspace))
    return True


def require_share_for(table: Any, share_id: str, email_lc: str) -> tuple[dict[str, Any], WorkspaceScope | None]:
    """The active link when it admits ``email_lc``, and the workspace it is kept in (None: the deployment's); 404
    (one message) for anything else. The id alone names it (shared/ws_repo.py ``read_share_route``: the one GetItem
    sent before for a deployment's link); a routing row's link is read from the workspace it names, and nowhere else,
    and kept only when it is that id's (``routed_share``); a routing row naming anything but a workspace refuses."""
    if not is_share_id(share_id):
        raise NotFoundError(LINK_GONE)
    share, workspace = read_share_route(table, share_id)
    if workspace is not None:
        share = routed_share(share_id, _get(table, review_link_key(share_id, workspace=workspace), workspace))
    if share is None or not share_admits(share, email_lc, _now_epoch()):
        raise NotFoundError(LINK_GONE)
    return share, workspace


def count_reviewer_write(table: Any, share_id: str, email_lc: str, *, workspace: WorkspaceScope | None = None) -> None:
    """One more reviewer write today; 429 ``rate_limited`` past the daily budget (the link's workspace when given)."""
    day = datetime.now(UTC).strftime('%Y-%m-%d')
    try:
        scoped_calls(table, workspace).update_item(
            Key={'pk': reviewer_rate_pk(share_id, email_digest(email_lc), workspace=workspace), 'sk': day},
            UpdateExpression='ADD n :one SET #ttl = :ttl',
            ConditionExpression='attribute_not_exists(n) OR n < :max',
            ExpressionAttributeNames={'#ttl': 'ttl'},
            ExpressionAttributeValues={':one': 1, ':max': MAX_REVIEWER_WRITES_PER_DAY, ':ttl': _now_epoch() + RATE_TTL_SECONDS},
        )
    except ClientError as error:
        if is_conditional_check_failure(error):
            raise TooManyRequestsError(RATE_LIMITED) from error
        raise
