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
"""
from __future__ import annotations

import secrets
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.aws import is_conditional_check_failure
from shared.document_comments import comments_pk, email_digest
from shared.dynamo_values import plain
from shared.exceptions import ConflictError, NotFoundError, TooManyRequestsError, ValidationError
from shared.feature_boards_audience import audience_emails
from shared.feature_boards_limits import RATE_LIMITED
from shared.participants_settings import validated_domains
from shared.review_share_audience import (
    MODE_ANYONE,
    MODE_LIST,
    MODES,
    is_active,
    is_share_id,
    share_admits,
    share_key,
)

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


def _index_key(project_id: str, series_id: str) -> dict[str, str]:
    return {'pk': comments_pk(project_id, series_id), 'sk': SHARE_INDEX_SK}


def _get(table: Any, key: Mapping[str, str]) -> dict[str, Any] | None:
    item = table.get_item(Key=dict(key), ConsistentRead=True).get('Item')
    return item if isinstance(item, dict) else None


def current_share(table: Any, project_id: str, series_id: str) -> dict[str, Any] | None:
    """The series' active link, or None."""
    index = _get(table, _index_key(project_id, series_id))
    share_id = index.get('share_id') if index else None
    share = _get(table, share_key(share_id)) if is_share_id(share_id) else None
    return share if is_active(share, _now_epoch()) else None


def create_share(table: Any, *, project_id: str, series: Mapping[str, str], document_id: str,
                 creator: Mapping[str, str], values: Mapping[str, Any]) -> tuple[dict[str, Any], bool]:
    """The series' active link, creating one when there is none: ``(link, created)``."""
    existing = current_share(table, project_id, series['series_id'])
    if existing is not None:
        return existing, False
    now = datetime.now(UTC)
    expires = _now_epoch() + int(values['expires_in_days']) * SECONDS_PER_DAY
    share_id = new_share_id()
    item = {
        **share_key(share_id), 'share_id': share_id, 'project_id': project_id, 'document_id': document_id,
        'series_id': series['series_id'], 'document_type': series['document_type'], 'base_title': series['base_title'],
        'audience': values['audience'], 'revoked': False, 'created_at': now.isoformat(),
        'created_by_sub': creator.get('sub', ''), 'created_by_name': creator.get('name', ''),
        'expires_at_epoch': expires, 'expires_at': datetime.fromtimestamp(expires, UTC).isoformat(),
        'ttl': expires + KEPT_AFTER_EXPIRY_SECONDS,
    }
    index = {**_index_key(project_id, series['series_id']), 'share_id': share_id, 'updated_at': now.isoformat()}
    try:
        table.meta.client.transact_write_items(TransactItems=[
            {'Put': {'TableName': table.name, 'Item': item, 'ConditionExpression': 'attribute_not_exists(pk)'}},
            {'Put': {'TableName': table.name, 'Item': index}},
        ])
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') == 'TransactionCanceledException':
            raise ConflictError('The review link changed meanwhile; reload and try again') from error
        raise
    return item, True


def revoke_share(table: Any, project_id: str, series_id: str, actor_name: str) -> bool:
    """Turn off the series' link (kept as revoked); False when there was none."""
    index = _get(table, _index_key(project_id, series_id))
    share_id = index.get('share_id') if index else None
    if not is_share_id(share_id):
        return False
    try:
        table.update_item(
            Key=share_key(share_id), UpdateExpression='SET revoked = :yes, revoked_by = :by',
            ConditionExpression='attribute_exists(pk)',
            ExpressionAttributeValues={':yes': True, ':by': actor_name[:MAX_ACTOR_NAME_CHARS]},
        )
    except ClientError as error:
        if not is_conditional_check_failure(error):
            raise
    table.delete_item(Key=_index_key(project_id, series_id))
    return True


def require_share_for(table: Any, share_id: str, email_lc: str) -> dict[str, Any]:
    """The active link when it admits ``email_lc``; 404 (one message) for anything else."""
    share = _get(table, share_key(share_id)) if is_share_id(share_id) else None
    if share is None or not share_admits(share, email_lc, _now_epoch()):
        raise NotFoundError(LINK_GONE)
    return share


def count_reviewer_write(table: Any, share_id: str, email_lc: str) -> None:
    """One more reviewer write today; 429 ``rate_limited`` past the daily budget."""
    day = datetime.now(UTC).strftime('%Y-%m-%d')
    try:
        table.update_item(
            Key={'pk': f'DCRATE#{share_id}#{email_digest(email_lc)}', 'sk': day},
            UpdateExpression='ADD n :one SET #ttl = :ttl',
            ConditionExpression='attribute_not_exists(n) OR n < :max',
            ExpressionAttributeNames={'#ttl': 'ttl'},
            ExpressionAttributeValues={':one': 1, ':max': MAX_REVIEWER_WRITES_PER_DAY, ':ttl': _now_epoch() + RATE_TTL_SECONDS},
        )
    except ClientError as error:
        if is_conditional_check_failure(error):
            raise TooManyRequestsError(RATE_LIMITED) from error
        raise
