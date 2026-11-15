"""Turn every plugin of the deployment on in the workspaces created before 7.40.00 (docs/multi-workspace.md,
"Upgrading").

Since 7.40.00 a new workspace starts with every plugin the deployment offers on (``PLUGIN#{plugin}`` / ``WS#{ws}``,
written by its creation, shared/platform_workspaces.py). A workspace created before then has a row only for each
plugin an admin enabled. This script, once, for one deployment:

1. lists every workspace from the platform console's listing (``WORKSPACES``, one paged Query), the active ones only
   (a workspace being deleted is left alone);
2. for each plugin the deployment offers (``--plugins``, else the workspaces API's ``ENABLED_SOURCES``), finds the
   workspaces without its row;
3. with ``--apply``, enables each through the same writer Workspace settings uses (``set_plugin_enabled``: the audit
   row ``plugin_enabled`` first, then the row, conditional), acting as ``script:enable-all-plugins`` with a platform
   admin's standing. It never disables a plugin and never touches anything else.

It turns on plugins an admin turned off as well: pass ``--workspace <id>`` (repeatable) to limit it. DRY RUN BY
DEFAULT: it prints each (workspace, plugin) it would enable and a summary. Idempotent: a second run enables nothing.

Usage (from voc-datalake/):
    .venv/bin/python scripts/workspaces/enable_all_plugins.py --table b-voc-workspaces-<account>-<region> \
        [--plugins '["webscraper","web_reviews"]' | --function b-voc-workspaces-api-<account>-<region>] [--apply]
"""
from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

# `lambda/`, so the keys and the writer are the ones the workspaces API uses.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'lambda'))

from shared.dynamo_paging import iter_query
from shared.platform_workspaces import LISTING_PK
from shared.workspace import ACTIVE, WorkspaceContext, is_workspace_id
from shared.workspace_plugin_settings import plugin_key, set_plugin_enabled

ACTOR = 'script:enable-all-plugins'


def active_workspaces(table: Any, only: Sequence[str] = ()) -> Iterator[WorkspaceContext]:
    """The listing's active workspaces (``only``: these ids), each as a platform admin's context."""
    rows = iter_query(table, {'KeyConditionExpression': 'pk = :pk', 'ExpressionAttributeValues': {':pk': LISTING_PK},
                              'ConsistentRead': True})
    for row in rows:
        ws = row.get('workspace_id')
        if not isinstance(ws, str) or not is_workspace_id(ws) or row.get('status') != ACTIVE:
            continue
        if only and ws not in only:
            continue
        yield WorkspaceContext(ws=ws, role='admin', name=str(row.get('name') or ''), slug=str(row.get('slug') or ''),
                               platform_admin=True)


def missing(table: Any, workspaces: Sequence[WorkspaceContext], plugins: Sequence[str]) -> list[tuple[WorkspaceContext, str]]:
    """Each (workspace, plugin) without its ``PLUGIN#`` row (one strongly consistent GetItem each)."""
    return [(context, plugin) for context in workspaces for plugin in plugins
            if 'Item' not in table.get_item(Key=plugin_key(plugin, context.ws), ConsistentRead=True)]


def deployment_plugins(function_name: str, region: str | None) -> list[str]:
    """The workspaces API's ``ENABLED_SOURCES`` (the deployment's plugins, cdk.context.json), read from its config."""
    import boto3

    env = boto3.client('lambda', region_name=region).get_function_configuration(
        FunctionName=function_name)['Environment']['Variables']
    plugins = json.loads(env['ENABLED_SOURCES'])
    if not isinstance(plugins, list) or not all(isinstance(plugin, str) for plugin in plugins):
        raise SystemExit('ENABLED_SOURCES is not a JSON list of plugin ids')
    return plugins


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or '').split('\n\n')[0])
    parser.add_argument('--table', required=True, help='the voc-workspaces table name')
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--plugins', help='the plugin ids, a JSON list')
    source.add_argument('--function', help='the workspaces API function, whose ENABLED_SOURCES names them')
    parser.add_argument('--workspace', action='append', default=[], help='only this workspace id (repeatable)')
    parser.add_argument('--region', default=None)
    parser.add_argument('--apply', action='store_true', help='write (default: a dry run)')
    args = parser.parse_args(argv)

    import boto3

    plugins = json.loads(args.plugins) if args.plugins else deployment_plugins(args.function, args.region)
    table = boto3.resource('dynamodb', region_name=args.region).Table(args.table)
    workspaces = list(active_workspaces(table, args.workspace))
    todo = missing(table, workspaces, plugins)
    for context, plugin in todo:
        print(f'{"enable" if args.apply else "would enable"} {plugin} in {context.slug} ({context.ws})')
        if args.apply:
            set_plugin_enabled(table, context, plugin, True, ACTOR)
    print(f'{len(workspaces)} active workspace(s), {len(plugins)} plugin(s): '
          f'{len(todo)} {"enabled" if args.apply else "to enable (dry run: --apply writes)"}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
