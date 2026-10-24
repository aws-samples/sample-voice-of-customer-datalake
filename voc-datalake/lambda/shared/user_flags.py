"""Per-user flags: ``fallback_owner`` and ``memory_reviewer`` (aggregates table).

    USERFLAGS#{sub}         / config  {fallback_owner: bool, memory_reviewer: bool, updated_at, updated_by}
    SETTINGS#fallback_owner / config  {sub, username, updated_at}   — the ONE fallback owner

Invariants (enforced by `set_flags`, which the users Lambda calls):

- at most one user is the fallback owner. The pointer row is the source of
  truth and the per-user rows mirror it; all three rows (pointer, new owner,
  previous owner) are written in ONE transaction conditioned on the pointer
  still naming the previous owner, so two admins ticking the box at once can't
  leave two owners.
- only admins may be the fallback owner (the caller checks the group; demoting
  an admin clears the flag via `clear_fallback_owner_if`).

Readers: the agents runtime (handoff owner when a category has none) reads
`get_fallback_owner`; the memory routes read `is_memory_reviewer`.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from botocore.exceptions import ClientError

from shared.exceptions import ConflictError

FALLBACK_OWNER_PK = 'SETTINGS#fallback_owner'
CONFIG_SK = 'config'
FLAG_NAMES = ('fallback_owner', 'memory_reviewer')
_BATCH_GET_LIMIT = 100
_BATCH_GET_ROUNDS = 5


def flags_key(sub: str) -> dict[str, str]:
    return {'pk': f'USERFLAGS#{sub}', 'sk': CONFIG_SK}


def _flags_of(item: dict | None) -> dict[str, bool]:
    item = item or {}
    return {name: item.get(name) is True for name in FLAG_NAMES}


def get_user_flags(table: Any, sub: str) -> dict[str, bool]:
    """``{fallback_owner, memory_reviewer}`` for one user (all False when unset)."""
    return _flags_of(table.get_item(Key=flags_key(sub), ConsistentRead=True).get('Item'))


def is_memory_reviewer(table: Any, sub: str) -> bool:
    return get_user_flags(table, sub)['memory_reviewer']


def get_fallback_owner(table: Any) -> dict | None:
    """``{sub, username}`` of the fallback owner, or None when nobody is."""
    item = table.get_item(Key={'pk': FALLBACK_OWNER_PK, 'sk': CONFIG_SK}, ConsistentRead=True).get('Item')
    if not isinstance(item, dict) or not isinstance(item.get('sub'), str) or not item['sub']:
        return None
    return {'sub': item['sub'], 'username': item.get('username') or ''}


def flags_for_subs(dynamodb: Any, table_name: str, subs: list[str]) -> dict[str, dict[str, bool]]:
    """Flags for many users in BatchGetItem pages; unknown subs get all-False.

    The fallback-owner value comes from the pointer row, not the mirrors, so a
    list can never show two fallback owners even mid-way through a transaction.
    """
    unique = [s for s in dict.fromkeys(subs) if s]
    found: dict[str, dict[str, bool]] = {}
    for start in range(0, len(unique), _BATCH_GET_LIMIT):
        request = {table_name: {'Keys': [flags_key(s) for s in unique[start:start + _BATCH_GET_LIMIT]]}}
        # Bounded: a throttled table keeps returning UnprocessedKeys, and a
        # user list must not spin; unread users show all-False flags.
        for _ in range(_BATCH_GET_ROUNDS):
            response = dynamodb.batch_get_item(RequestItems=request)
            for item in response.get('Responses', {}).get(table_name, []):
                sub = str(item.get('pk', '')).removeprefix('USERFLAGS#')
                found[sub] = _flags_of(item)
            request = response.get('UnprocessedKeys') or {}
            if not request:
                break
    owner = get_fallback_owner(dynamodb.Table(table_name))
    owner_sub = owner['sub'] if owner else None
    return {
        sub: {**found.get(sub, _flags_of(None)), 'fallback_owner': sub == owner_sub}
        for sub in unique
    }


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _put(table_name: str, item: dict, condition: dict | None = None) -> dict:
    # Plain Python values: `table.meta.client` is the RESOURCE's client, which
    # serialises attribute values itself (pre-serialised {'S': …} would nest).
    put: dict[str, Any] = {
        'TableName': table_name,
        'Item': item,
    }
    if condition:
        put.update(condition)
    return {'Put': put}


def _flags_row(sub: str, flags: dict[str, bool], actor_sub: str) -> dict:
    return {**flags_key(sub), **flags, 'updated_at': _now(), 'updated_by': actor_sub}


def _pointer_condition(previous_sub: str | None) -> dict:
    """The pointer must still name what we read, or someone else won the race."""
    if previous_sub:
        return {
            'ConditionExpression': '#s = :prev',
            'ExpressionAttributeNames': {'#s': 'sub'},
            'ExpressionAttributeValues': {':prev': previous_sub},
        }
    return {
        'ConditionExpression': 'attribute_not_exists(pk) OR attribute_not_exists(#s)',
        'ExpressionAttributeNames': {'#s': 'sub'},
    }


def set_flags(
    table: Any,
    *,
    sub: str,
    username: str,
    changes: dict[str, bool],
    actor_sub: str,
) -> dict[str, bool]:
    """Apply ``changes`` to one user's flags and return the resulting flags.

    Plain ``memory_reviewer`` changes are one put. Any ``fallback_owner``
    change goes through one transaction with the pointer row (see module doc).

    Raises:
        ConflictError: the fallback owner changed concurrently — re-read and retry.
    """
    current = get_user_flags(table, sub)
    owner = get_fallback_owner(table)
    current['fallback_owner'] = bool(owner and owner['sub'] == sub)
    updated = {**current, **{k: v for k, v in changes.items() if k in FLAG_NAMES}}

    if updated['fallback_owner'] == current['fallback_owner']:
        table.put_item(Item=_flags_row(sub, updated, actor_sub))
        return updated

    table_name = table.name
    previous_sub = owner['sub'] if owner else None
    pointer_key = {'pk': FALLBACK_OWNER_PK, 'sk': CONFIG_SK}
    if updated['fallback_owner']:
        pointer = {**pointer_key, 'sub': sub, 'username': username, 'updated_at': _now()}
    else:
        # Cleared: the pointer row stays, with no sub (an empty pointer reads as "nobody").
        pointer = {**pointer_key, 'updated_at': _now()}
    items = [
        _put(table_name, pointer, _pointer_condition(previous_sub)),
        _put(table_name, _flags_row(sub, updated, actor_sub)),
    ]
    # Reached only when the flag changes, so a new owner is never `previous_sub`.
    if updated['fallback_owner'] and previous_sub:
        previous_flags = {**get_user_flags(table, previous_sub), 'fallback_owner': False}
        items.append(_put(table_name, _flags_row(previous_sub, previous_flags, actor_sub)))
    try:
        table.meta.client.transact_write_items(TransactItems=items)
    except ClientError as e:
        if e.response.get('Error', {}).get('Code') == 'TransactionCanceledException':
            raise ConflictError('The fallback owner changed at the same time; reload and try again') from e
        raise
    return updated


def clear_fallback_owner_if(table: Any, *, sub: str, actor_sub: str) -> bool:
    """Clear the fallback-owner flag when ``sub`` holds it (e.g. on demotion). True when cleared."""
    owner = get_fallback_owner(table)
    if not owner or owner['sub'] != sub:
        return False
    set_flags(table, sub=sub, username=owner['username'], changes={'fallback_owner': False}, actor_sub=actor_sub)
    return True
