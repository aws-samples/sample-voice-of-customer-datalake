"""voc-participants seen on either path (docs/multi-workspace.md, the project plan, 3d; plumbing since 7.31.00).

Without a workspace a store calls the table itself, exactly as it always did: ``scoped_calls(table, None)`` IS the
table, and ``scoped_rows`` / ``rows_by_id_in`` send the deployment's own request, so every request the deployment
sends is the one it sent before. In a workspace every call goes through the workspace layer (shared/ws_repo.py
``ws_table``), which refuses a key, an item, an index partition or a cursor outside the workspace before DynamoDB:
shared/ingest_tables.py ``scoped_calls`` gives ``ScopedUpdates`` (boto3's call shape over the view), ``scoped_rows`` is
shared/scoped_query.py ``iter_partition``, and the multi-item calls (``rows_by_id_in``, ``delete_many``,
``transact``) are the view's own. The keys are
shared/participants_keys.py's.
"""
from __future__ import annotations

from collections.abc import Iterable, Iterator, Mapping, Sequence
from typing import Any

from botocore.exceptions import ClientError

from shared.dynamo_paging import iter_query
from shared.engagement_common import rows_by_id
from shared.exceptions import ServiceError
from shared.logging import logger
from shared.scoped_query import iter_partition
from shared.ws_repo import UnprocessedKeysError, WorkspaceScope, ws_table

#: How many times ``unlist_if_empty`` sends its transaction when a concurrent write cancels it.
UNLIST_ATTEMPTS = 3


def scoped_rows(table: Any, workspace: WorkspaceScope | None, partition: str, *, attribute: str = 'pk',
                sort_prefix: str | None = None, limit: int | None = None, index: str | None = None,
                placeholders: tuple[str, str] = (':pk', ':prefix')) -> Iterator[dict[str, Any]]:
    """The rows of one partition (``attribute`` ``pk``, or ``gsi1pk`` on ``index``), only those whose ``sk`` begins
    with ``sort_prefix`` when given, across every page as they are read, at most ``limit``; the query described once
    for both paths. Without a workspace the request is the one the stores always sent, a string key condition
    (``{attribute} = {placeholder}``, then ``AND begins_with(sk, {placeholder})``) with the store's own
    ``placeholders``; in one, shared/scoped_query.py ``iter_partition`` (the layer's Query, which refuses a partition
    or cursor outside the workspace and a caller's placeholder spelled like its own)."""
    options: dict[str, Any] = {'IndexName': index} if index else {}
    if workspace is not None:
        return iter_partition(workspace, table, attribute, partition, sort_prefix=sort_prefix, max_items=limit,
                              **options)
    value, prefix = placeholders
    condition = f'{attribute} = {value}' + (f' AND begins_with(sk, {prefix})' if sort_prefix is not None else '')
    values = {value: partition, **({prefix: sort_prefix} if sort_prefix is not None else {})}
    return iter_query(table, {**options, 'KeyConditionExpression': condition, 'ExpressionAttributeValues': values},
                      max_items=limit)


def rows_by_id_in(table: Any, workspace: WorkspaceScope | None, keys: list[dict[str, str]], id_field: str,
                  noun: str) -> dict[str, dict[str, Any]]:
    """``{row[id_field]: row}`` for the ``keys`` that exist (strongly consistent): shared/engagement_common.py
    ``rows_by_id`` without a workspace, the view's BatchGetItem in one (a read left unprocessed is the same 500)."""
    if workspace is None:
        return rows_by_id(table, keys, id_field, noun)
    if not keys:
        return {}
    try:
        found = ws_table(workspace, table).batch_get_item(keys)
    except UnprocessedKeysError as error:
        raise ServiceError(f'Could not read the {noun}. Please retry.') from error
    return {row[id_field]: row for row in found if isinstance(row.get(id_field), str)}


def delete_many(table: Any, workspace: WorkspaceScope, keys: Iterable[Mapping[str, Any]]) -> int:
    """Delete every row ``keys`` names (each once), through the view's checked batch delete."""
    unique = list({(str(key['pk']), str(key['sk'])): {'pk': key['pk'], 'sk': key['sk']} for key in keys}.values())
    return ws_table(workspace, table).batch_delete(unique) if unique else 0


def unlist_if_empty(table: Any, workspace: WorkspaceScope, index_key: Mapping[str, Any],
                    row_key: Mapping[str, Any]) -> bool:
    """Delete the index row ``index_key`` only while ``row_key`` (the row it lists: an address guard) is absent, in
    one transaction, which a writer listing and writing that row again (its own transaction) is serialised against.
    A cancel for a concurrent write is tried again, at most ``UNLIST_ATTEMPTS`` times in all. False when the row is
    there (the index row is kept, so the hard delete still finds it), or when every try conflicted: then the index row
    is kept too, the safe direction (the hard delete reads its partition and deletes it)."""
    entries = [{'ConditionCheck': {'Key': dict(row_key), 'ConditionExpression': 'attribute_not_exists(pk)'}},
               {'Delete': {'Key': dict(index_key)}}]
    for _attempt in range(UNLIST_ATTEMPTS):
        try:
            transact(table, workspace, entries)
        except ClientError as error:
            if error.response.get('Error', {}).get('Code') != 'TransactionCanceledException':
                raise
            if 'ConditionalCheckFailed' in cancellation_codes(error):
                return False
            continue
        return True
    # Counts and the workspace only: the index row holds an address's hash.
    logger.warning('An index row was kept after every try conflicted; the hard delete removes it',
                   extra={'workspace_id': workspace.ws, 'attempts': UNLIST_ATTEMPTS})
    return False


def transact(table: Any, workspace: WorkspaceScope | None, entries: Sequence[Mapping[str, Any]]) -> dict:
    """One TransactWriteItems of ``entries`` (each ``{action: body}``, no ``TableName``): through the workspace's
    view in one, which sends them to its own table and checks every entry; on the table's client without one, each
    entry naming the table."""
    if workspace is not None:
        return ws_table(workspace, table).transact_write_items(entries)
    named = [{action: {'TableName': table.name, **body} for action, body in entry.items()} for entry in entries]
    return table.meta.client.transact_write_items(TransactItems=named)


def cancellation_codes(error: ClientError) -> list[str | None]:
    """The per-entry codes of a cancelled TransactWriteItems (empty for any other error), in the entries' order."""
    if error.response.get('Error', {}).get('Code') != 'TransactionCanceledException':
        return []
    return [reason.get('Code') for reason in error.response.get('CancellationReasons') or []]
