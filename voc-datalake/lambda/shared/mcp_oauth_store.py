"""Grant rows in the projects table's ``MCPGTOKEN`` partition (docs/mcp.md → "OAuth sign-in").

Every write here is conditional, so a revoke racing a sign-in can never leave a revoked grant with a new
chain: ``record_chain`` applies only while the row is unrevoked and the consent window it read is still
the stored one; ``revoke`` applies only to the caller's own unrevoked grant and empties its chains.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from botocore.exceptions import ClientError

from shared import mcp_global_tokens as gt
from shared import mcp_oauth_grants as grants
from shared.aws import is_conditional_check_failure
from shared.batch_get import batch_get_all
from shared.exceptions import ServiceError


def _key(token_id: str) -> dict[str, str]:
    return {'pk': gt.GLOBAL_TOKEN_PK, 'sk': gt.token_sk(token_id)}


def load_grant(table: Any, token_id: str) -> dict | None:
    item = table.get_item(Key=_key(token_id), ConsistentRead=True).get('Item')
    return item if isinstance(item, dict) else None


def put_grant(table: Any, item: dict[str, Any]) -> None:
    """A consent: the new grant REPLACES any earlier one of this person and client (never a token row)."""
    table.put_item(Item=item, ConditionExpression='attribute_not_exists(sk) OR #kind = :grant',
                   ExpressionAttributeNames={'#kind': 'kind'},
                   ExpressionAttributeValues={':grant': grants.KIND_OAUTH_GRANT})


def _conditional(update: Any) -> bool:
    try:
        update()
    except ClientError as exc:
        if is_conditional_check_failure(exc):
            return False
        raise
    return True


def record_chain(table: Any, row: dict, origin_jti: str) -> bool:
    """Add ``origin_jti`` to the grant's chains and close its consent window; False when the row moved."""
    return _conditional(lambda: table.update_item(
        Key=_key(str(row['token_id'])),
        UpdateExpression='SET origin_jtis = :chains REMOVE chain_open_until',
        ConditionExpression='attribute_not_exists(revoked_at) AND chain_open_until = :seen',
        ExpressionAttributeValues={':chains': grants.with_chain(row, origin_jti), ':seen': row.get('chain_open_until')},
    ))


def revoke_grant(table: Any, token_id: str, subject: str, now: datetime) -> bool:
    """Revoke the caller's own grant at once (every chain refused); False when absent, foreign or revoked."""
    return _conditional(lambda: table.update_item(
        Key=_key(token_id),
        UpdateExpression='SET revoked_at = :now, origin_jtis = :none REMOVE chain_open_until',
        ConditionExpression='attribute_exists(sk) AND #kind = :grant AND created_by = :me AND attribute_not_exists(revoked_at)',
        ExpressionAttributeNames={'#kind': 'kind'},
        ExpressionAttributeValues={':now': now.isoformat(), ':none': [], ':grant': grants.KIND_OAUTH_GRANT,
                                   ':me': subject},
    ))


def grants_of(table: Any, subject: str, client_ids: list[str]) -> list[dict]:
    """The caller's grants: one derived key per MCP client, so no index and no other person's rows."""
    keys = [_key(grants.grant_id(subject, client_id)) for client_id in client_ids]
    rows = batch_get_all(table, keys, failure=ServiceError('Failed to read your MCP sign-ins'))
    return [row for row in rows if grants.is_grant(row) and row.get('created_by') == subject]
