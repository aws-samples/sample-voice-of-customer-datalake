"""A workspace's plugin config lists, and a plugin's values in a workspace (docs/multi-workspace.md, Credentials;
decision 19).

A plugin's ``configs`` list (the webscraper's scrapers; an app plugin's connectors or review pages) is configuration,
not a credential: no field of one is a secret (URLs, selectors, pagination, schedules, labels, app ids, a Radar
brand), every member may read it (``GET /scrapers``, ``GET /integrations/{source}/apps``), and the ingestors build
their own request headers. So in a workspace it is a row of voc-aggregates, the table the plugin's run already reads
and writes there (its run rows), seen only through the workspace layer (shared/ws_repo.py ``ws_table``)::

    pk WS#{ws}#PLUGIN_CONFIG   sk {plugin}   configs (the list's JSON text, as the shared secret held it), updated_at

The operator routes write it (shared/workspace_plugin_store.py), a run reads it (plugins/_shared/base_ingestor.py).
A list is bounded as in the shared secret: the scraper routes' own limits (8 KiB a scraper, 48 KiB in all,
shared/scraper_limits.py), and no list larger than the whole shared secret may be (``SECRET_STRING_MAX_BYTES``), far
under DynamoDB's 400 KB item. Deployment-wide the lists stay in the shared secret.

``read_plugin_values`` is the one read of "a plugin's values in a workspace": its credentials parameter
(shared/workspace_credentials.py) and its list, merged under ``configs``, as the shared secret's namespace would hold
them; a run and an operator route both read through it.
"""
from __future__ import annotations

from typing import Any, Final

from shared.aws import SECRET_STRING_MAX_BYTES
from shared.exceptions import ValidationError
from shared.timestamps import now_iso
from shared.workspace_credentials import read_credentials
from shared.ws_repo import WorkspaceTable, plugin_config_key, plugin_config_pk

__all__ = ['CONFIGS_KEY', 'checked_configs', 'read_all_configs', 'read_configs', 'read_plugin_values', 'save_configs']

#: The bare key a plugin's list goes under (``<plugin>_configs`` in the shared secret), and the row's attribute.
CONFIGS_KEY: Final = 'configs'


def read_configs(table: WorkspaceTable, plugin: str) -> str | None:
    """``plugin``'s stored list (its JSON text) in the table's workspace, or None when none was saved. Strongly
    consistent, so a run started right after a save reads it."""
    item = table.get_item(plugin_config_key(table.scope, plugin), ConsistentRead=True).get('Item') or {}
    value = item.get(CONFIGS_KEY)
    return value if isinstance(value, str) else None


def read_all_configs(table: WorkspaceTable) -> dict[str, str]:
    """Every plugin's stored list in the table's workspace, by plugin id: one paged Query of its one partition."""
    return {item['sk']: item[CONFIGS_KEY]
            for item in table.iter_query('pk', plugin_config_pk(table.scope), ConsistentRead=True)
            if isinstance(item.get('sk'), str) and isinstance(item.get(CONFIGS_KEY), str)}


def read_plugin_values(ssm: Any, prefix: str, table: WorkspaceTable, plugin: str) -> dict:
    """``plugin``'s values in the table's workspace: its credentials parameter's keys (one GetParameter) and, under
    ``configs``, its list (one GetItem); ``{}`` when neither is saved."""
    values = read_credentials(ssm, prefix, table.scope.ws, plugin)
    configs = read_configs(table, plugin)
    return values if configs is None else {**values, CONFIGS_KEY: configs}


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


def save_configs(table: WorkspaceTable, plugin: str, configs: object) -> None:
    """Store ``configs`` (``checked_configs``) as ``plugin``'s list in the table's workspace, whole."""
    table.put_item({**plugin_config_key(table.scope, plugin), CONFIGS_KEY: checked_configs(plugin, configs),
                    'updated_at': now_iso()})
