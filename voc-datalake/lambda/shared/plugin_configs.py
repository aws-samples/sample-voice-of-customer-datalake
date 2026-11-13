"""A workspace's plugin config lists, and a plugin's values in a workspace (docs/multi-workspace.md, Credentials;
decision 19).

A plugin's ``configs`` list (the webscraper's scrapers; an app plugin's connectors or review pages) is configuration,
not a credential: no field of one is a secret (URLs, selectors, pagination, schedules, labels, app ids, a Radar
brand), every member may read it (``GET /scrapers``, ``GET /integrations/{source}/apps``), and the ingestors build
their own request headers. So in a workspace it is a row of voc-aggregates, the table the plugin's run already reads
and writes there (its run rows), seen only through the workspace layer (shared/ws_repo.py ``ws_table``)::

    pk WS#{ws}#PLUGIN_CONFIG   sk {plugin}   configs (the list's JSON text, as the shared secret held it),
                                             updated_at, updated_by (the sub of the member who saved it)
    pk WS#{ws}#PLUGIN_CONFIG#HISTORY   sk {plugin}#{superseded_at}#{random}   configs, updated_at, updated_by (the
                                             replaced list's), superseded_at, superseded_by_sub

The operator routes write it (shared/workspace_plugin_store.py), a run reads it (plugins/_shared/base_ingestor.py).
A save that changes the list keeps the list it replaces as a history row (what the shared secret's versions kept
deployment-wide), kept forever (no ttl), in one transaction with the new row, which is conditioned on the row being
the one the route read (its list and its ``updated_at`` as stored; no list at all for a first save, which has no
history row): a concurrent save gets a 409 (``CONFIG_CHANGED``) instead of losing a history entry. An unchanged list writes nothing.
A list is bounded as in the shared secret: the scraper routes' own limits (8 KiB a scraper, 48 KiB in all,
shared/scraper_limits.py), and no list larger than the whole shared secret may be (``SECRET_STRING_MAX_BYTES``), far
under DynamoDB's 400 KB item. Deployment-wide the lists stay in the shared secret.

``read_plugin_values`` is the one read of "a plugin's values in a workspace": its credentials parameter
(shared/workspace_credentials.py) and its list, merged under ``configs``, as the shared secret's namespace would hold
them; a run and an operator route both read through it.
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.aws import SECRET_STRING_MAX_BYTES
from shared.exceptions import ConflictError, ValidationError
from shared.timestamps import now_iso
from shared.workspace_credentials import read_credentials
from shared.ws_repo import WorkspaceTable, plugin_config_history_key, plugin_config_key, plugin_config_pk

__all__ = ['CONFIGS_KEY', 'ConfigRow', 'read_all_configs', 'read_configs', 'read_plugin_values', 'save_configs']

#: The bare key a plugin's list goes under (``<plugin>_configs`` in the shared secret), and the row's attribute.
CONFIGS_KEY: Final = 'configs'
#: The 409 of a save that lost to another one made since the route read the list.
CONFIG_CHANGED: Final = ('These settings were changed by someone else while you were editing them. '
                         'Reload to see the latest, then save again.')
#: A cancelled transaction's reasons that mean another write got there first (a 409), not a fault.
_LOST_RACE: Final = frozenset({'ConditionalCheckFailed', 'TransactionConflict'})


#: What a row records of its save, copied onto the history row of the list it holds once that list is replaced.
_STAMPS: Final = ('updated_at', 'updated_by')


@dataclass(frozen=True)
class ConfigRow:
    """A stored list as read: its JSON text, and those of its ``_STAMPS`` it has, raw as stored (none on a row from
    before; a save compares ``updated_at`` exactly, so no value of it can lock the row)."""

    configs: str
    stamps: dict[str, Any]


def read_config_row(table: WorkspaceTable, plugin: str) -> ConfigRow | None:
    """``plugin``'s stored row in the table's workspace, or None when no list was saved. Strongly consistent, so a
    run started right after a save reads it."""
    item = table.get_item(plugin_config_key(table.scope, plugin), ConsistentRead=True).get('Item') or {}
    value = item.get(CONFIGS_KEY)
    if not isinstance(value, str):
        return None
    return ConfigRow(value, {name: item[name] for name in _STAMPS if name in item})


def read_configs(table: WorkspaceTable, plugin: str) -> str | None:
    """``plugin``'s stored list (its JSON text) in the table's workspace, or None when none was saved."""
    row = read_config_row(table, plugin)
    return row.configs if row is not None else None


def read_all_configs(table: WorkspaceTable) -> dict[str, str]:
    """Every plugin's stored list in the table's workspace, by plugin id: one paged Query of its one partition."""
    return {item['sk']: item[CONFIGS_KEY]
            for item in table.iter_query('pk', plugin_config_pk(table.scope), ConsistentRead=True)
            if isinstance(item.get('sk'), str) and isinstance(item.get(CONFIGS_KEY), str)}


def read_plugin_values(ssm: Any, prefix: str, table: WorkspaceTable, plugin: str,
                       rows: dict[str, ConfigRow | None] | None = None) -> dict:
    """``plugin``'s values in the table's workspace: its credentials parameter's keys (one GetParameter) and, under
    ``configs``, its list (one GetItem); ``{}`` when neither is saved. ``rows``, when given, keeps the row as read
    under ``plugin`` (what a save then replaces: shared/workspace_plugin_store.py)."""
    values = read_credentials(ssm, prefix, table.scope.ws, plugin)
    row = read_config_row(table, plugin)
    if rows is not None:
        rows[plugin] = row
    return values if row is None else {**values, CONFIGS_KEY: row.configs}


def checked_configs(plugin: str, configs: object) -> str:
    """``configs`` when it may be stored: a list's JSON text within ``SECRET_STRING_MAX_BYTES``. ``TypeError`` for a
    value that is not text, ``ValidationError`` (400) for one too large. Called before anything is written."""
    if not isinstance(configs, str):
        raise TypeError('a configs list is stored as its JSON text')
    size = len(configs.encode('utf-8'))
    if size > SECRET_STRING_MAX_BYTES:
        raise ValidationError(
            f'The {plugin} configurations of this workspace would take {size} bytes, over the '
            f'{SECRET_STRING_MAX_BYTES}-byte limit. Remove some entries and retry.')
    return configs


def _current_condition(replaced: ConfigRow | None) -> dict[str, Any]:
    """The new row's condition: the row is still the one ``replaced`` read, its list and its ``updated_at`` exactly as
    stored (so a save of another list and then the same one again, in between, is still a change); no list at all
    for a first save."""
    if replaced is None:
        return {'ConditionExpression': 'attribute_not_exists(#configs)',
                'ExpressionAttributeNames': {'#configs': CONFIGS_KEY}}
    names = {'#configs': CONFIGS_KEY, '#updated_at': 'updated_at'}
    values: dict[str, Any] = {':old': replaced.configs}
    if 'updated_at' in replaced.stamps:
        values[':at'] = replaced.stamps['updated_at']
        stamp = '#updated_at = :at'
    else:
        stamp = 'attribute_not_exists(#updated_at)'
    return {'ConditionExpression': f'#configs = :old AND {stamp}', 'ExpressionAttributeNames': names,
            'ExpressionAttributeValues': values}


def _history_row(table: WorkspaceTable, plugin: str, replaced: ConfigRow, *, at: str, by: str) -> dict[str, Any]:
    """The history row of ``replaced`` (its sort key starts with the plugin): its list and its own stamps, and who
    superseded it when. No ttl."""
    return {**plugin_config_history_key(table.scope, plugin, at, secrets.token_hex(8)), **replaced.stamps,
            CONFIGS_KEY: replaced.configs, 'superseded_at': at, 'superseded_by_sub': by}


def _lost_race(error: ClientError) -> bool:
    """Whether a refused transaction lost to another write (its condition failed, or a concurrent transaction)."""
    if error.response.get('Error', {}).get('Code') != 'TransactionCanceledException':
        return False
    return any(reason.get('Code') in _LOST_RACE for reason in error.response.get('CancellationReasons', []))


def save_configs(table: WorkspaceTable, plugin: str, configs: object, *, replaced: ConfigRow | None,
                 updated_by: str) -> None:
    """Store ``configs`` (``checked_configs``) as ``plugin``'s list in the table's workspace, whole, in place of
    ``replaced`` (the row as the caller read it; None: no list was saved then). ``updated_by`` is the caller's sub,
    from the request's authorizer, never from a body.

    The same list as ``replaced`` writes nothing. Otherwise one transaction: the new row, stamped ``updated_by`` and
    ``updated_at`` and conditioned on the row being the one read (``_current_condition``), and, when a list is
    replaced, its history row. ``TypeError`` for an empty ``updated_by``; ``ConflictError`` (409,
    ``CONFIG_CHANGED``) when the row changed meanwhile: nothing is written."""
    text = checked_configs(plugin, configs)
    if replaced is not None and replaced.configs == text:
        return
    if not updated_by:
        raise TypeError("a config list is saved with the caller's sub")
    at = now_iso()
    item = {**plugin_config_key(table.scope, plugin), CONFIGS_KEY: text, 'updated_at': at, 'updated_by': updated_by}
    entries: list[dict[str, Any]] = [{'Put': {'Item': item, **_current_condition(replaced)}}]
    if replaced is not None:
        history = _history_row(table, plugin, replaced, at=at, by=updated_by)
        entries.insert(0, {'Put': {'Item': history, 'ConditionExpression': 'attribute_not_exists(pk)'}})
    try:
        table.transact_write_items(entries)
    except ClientError as error:
        if _lost_race(error):
            raise ConflictError(CONFIG_CHANGED) from error
        raise
