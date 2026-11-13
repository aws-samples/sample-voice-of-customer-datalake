"""A workspace's plugins: which of the deployment's plugins run for it (docs/multi-workspace.md, "Per-workspace
configuration": the deployment's plugins are the ceiling, each workspace picks a subset at run time).

The ceiling is what the deployment offers: the plugins ``cdk.context.json`` enables, rendered into the Lambda's
``ENABLED_SOURCES`` at synth time (shared/enabled_sources.py). A workspace enables one of them with a row in
voc-workspaces::

    PLUGIN#{plugin_id} / WS#{ws}    enabled_by, enabled_at

present = enabled. The plugin's scheduled ingestor reads its own ``PLUGIN#{plugin_id}`` partition to fan its tick out
over the workspaces that enabled it (the data path, phase 2), so the partition is per plugin and the sort key per
workspace. Reading a workspace's plugins is one GetItem per plugin of the ceiling (a handful).

A change is a workspace admin's (the route calls ``require_workspace_admin``) and is audited first, like a membership
change (``AUDIT#WS#{ws}``, kind ``plugin_enabled`` or ``plugin_disabled``: the plugin, the actor, ``platform_admin``),
so a row that cannot be written refuses the change; then ONE transaction writes the row (a put conditional on a new
key, or a delete conditional on an existing one) with a check that the workspace is still ``active`` and, for a member
admin, that they are still admin. Asking for what already holds changes and records nothing. A plugin outside the
ceiling is answered like an unknown one (404): the deployment does not offer it.

Since 7.14.00 a workspace's admins enable plugins (the workspaces role's PutItem on ``PLUGIN#*``,
lib/stacks/api-workspaces-lambda.ts): the row is what the plugin's scheduled ingestor fans its tick out over, into the
workspace's own raw data, processing, counters, erasure and replay (the data path, phase 2); disabling deletes it, so
the next tick no longer reaches the workspace. A run the operator routes start in a workspace (Run now, a scraper's
run) runs only a plugin the workspace enabled (``require_plugin_enabled``: 409 ``PLUGIN_NOT_ENABLED`` otherwise), and a
workspace webhook takes a delivery only for one (plugins/_shared/base_webhook.py, the bad signature's 401 otherwise).
The deployment-only plugins (``DEPLOYMENT_ONLY_PLUGINS``) are neither listed for a workspace nor enabled in one.
"""
from __future__ import annotations

import secrets
from collections.abc import Sequence
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.audit_rows import put_new_audit_row
from shared.exceptions import AuthorizationError, ConflictError, NotFoundError, ValidationError
from shared.persona_save import cancellation_codes
from shared.plugin_identity import S3_IMPORT_SOURCE, is_valid_plugin_identifier
from shared.request_body import reject_unknown_fields
from shared.timestamps import now_iso
from shared.workspace import ACTIVE, NOT_FOUND, WorkspaceContext, audit_key, audit_sort_key, ws_key
from shared.workspace_members import NO_LONGER_ADMIN
from shared.workspace_plugins import plugin_partition

__all__ = ['offered_plugin', 'parse_plugin_change', 'require_plugin_enabled', 'set_plugin_enabled', 'workspace_plugins']

PLUGIN_ENABLED: Final = 'plugin_enabled'
PLUGIN_DISABLED: Final = 'plugin_disabled'
#: A run in a workspace of a plugin the workspace has not enabled (``require_plugin_enabled``).
PLUGIN_NOT_ENABLED: Final = 'Enable this plugin for the workspace first'
#: The plugins of the ceiling that never run in a workspace, so a workspace is neither shown nor allowed to enable
#: them: the S3 import (its bucket, upload routes and trigger are the deployment's; its API answers a request that
#: names a workspace with one 400, shared/workspace_request.py ``deployment_only``).
DEPLOYMENT_ONLY_PLUGINS: Final = frozenset({S3_IMPORT_SOURCE})
#: One answer for a plugin outside the ceiling and an id that is not a plugin's.
PLUGIN_NOT_FOUND: Final = 'Plugin not found'
CHANGED_MEANWHILE: Final = "The workspace's plugins changed meanwhile: reload them and try again"


def plugin_key(plugin_id: str, ws: str) -> dict[str, str]:
    """``PLUGIN#{plugin_id}`` / ``WS#{ws}``: the row that says the workspace enabled the plugin (its partition is
    the one the ingestors' fan-out reads, shared/workspace_plugins.py ``plugin_partition``)."""
    return {'pk': plugin_partition(plugin_id), 'sk': ws_key(ws)}


def workspace_ceiling(ceiling: Sequence[str]) -> list[str]:
    """The plugins of the deployment's ceiling a workspace can run, in its order: all but the deployment-only ones
    (``DEPLOYMENT_ONLY_PLUGINS``)."""
    return [plugin_id for plugin_id in ceiling if plugin_id not in DEPLOYMENT_ONLY_PLUGINS]


def offered_plugin(plugin_id: object, ceiling: Sequence[str]) -> str:
    """``plugin_id`` when the deployment offers it to workspaces; the one 404 otherwise (a deployment-only plugin
    included: it is not a workspace's to enable)."""
    if (not isinstance(plugin_id, str) or plugin_id not in workspace_ceiling(ceiling)
            or not is_valid_plugin_identifier(plugin_id)):
        raise NotFoundError(PLUGIN_NOT_FOUND)
    return plugin_id


def parse_plugin_change(body: dict[str, Any]) -> bool:
    """``{enabled: true|false}`` -> the asked state; 400 for anything else."""
    reject_unknown_fields(body, {'enabled'})
    enabled = body.get('enabled')
    if not isinstance(enabled, bool):
        raise ValidationError('enabled must be true or false')
    return enabled


def require_plugin_enabled(table: Any, ws: str, plugin_id: str) -> None:
    """409 ``PLUGIN_NOT_ENABLED`` unless workspace ``ws`` enabled ``plugin_id`` (its ``PLUGIN#{plugin_id}`` /
    ``WS#{ws}`` row exists: one strongly consistent GetItem of ``pk`` alone, as the attribute-limited grants of the
    roles that call it require). A run in a workspace (Run now, a scraper's run) and a workspace webhook's delivery
    take in only a plugin its admins turned on there, the rows the scheduled tick fans out over too. DynamoDB errors
    propagate."""
    found = table.get_item(Key=plugin_key(plugin_id, ws), ConsistentRead=True, ProjectionExpression='pk')
    if 'Item' not in found:
        raise ConflictError(PLUGIN_NOT_ENABLED)


def _stored(table: Any, plugin_id: str, ws: str) -> dict | None:
    return table.get_item(Key=plugin_key(plugin_id, ws), ConsistentRead=True).get('Item')


def workspace_plugins(table: Any, ws: str, ceiling: Sequence[str]) -> list[dict[str, Any]]:
    """Every plugin the deployment offers to workspaces (``workspace_ceiling``), in its order, with whether the
    workspace enabled it (and when, by whom)."""
    plugins = []
    for plugin_id in workspace_ceiling(ceiling):
        row = _stored(table, plugin_id, ws)
        entry: dict[str, Any] = {'id': plugin_id, 'enabled': row is not None}
        if row is not None:
            entry.update({key: row[key] for key in ('enabled_at', 'enabled_by') if isinstance(row.get(key), str)})
        plugins.append(entry)
    return plugins


def _checks(table_name: str, context: WorkspaceContext, actor: str) -> list[dict[str, Any]]:
    """The workspace is still active; a member admin is still admin (a platform admin acts by the group)."""
    checks: list[dict[str, Any]] = [{'ConditionCheck': {
        'TableName': table_name, 'Key': {'pk': ws_key(context.ws), 'sk': 'META'},
        'ConditionExpression': '#status = :active', 'ExpressionAttributeNames': {'#status': 'status'},
        'ExpressionAttributeValues': {':active': ACTIVE}}}]
    if not context.platform_admin:
        checks.append({'ConditionCheck': {
            'TableName': table_name, 'Key': {'pk': ws_key(context.ws), 'sk': f'MEMBER#{actor}'},
            'ConditionExpression': '#role = :admin', 'ExpressionAttributeNames': {'#role': 'role'},
            'ExpressionAttributeValues': {':admin': 'admin'}}})
    return checks


def set_plugin_enabled(table: Any, context: WorkspaceContext, plugin_id: str, enabled: bool,
                       actor: str) -> dict[str, Any]:
    """Enable or disable ``plugin_id`` (already checked against the ceiling) for the workspace; the plugin's entry.

    The audit row first, then one transaction (the row's put or delete and the checks). 409 when the row changed
    meanwhile; 403 when the acting member admin stopped being admin; the one workspace 404 when it stopped being
    active."""
    ws = context.ws
    stored = _stored(table, plugin_id, ws)
    if (stored is not None) == enabled:
        # Nothing to change: the entry as GET shows it.
        return {'id': plugin_id, 'enabled': enabled,
                **{key: stored[key] for key in ('enabled_at', 'enabled_by') if stored and isinstance(stored.get(key), str)}}
    at = now_iso()
    put_new_audit_row(table, {'pk': audit_key(ws), 'sk': audit_sort_key(at),
                              'kind': PLUGIN_ENABLED if enabled else PLUGIN_DISABLED, 'plugin': plugin_id,
                              'actor': actor, 'at': at, 'platform_admin': context.platform_admin})
    key = plugin_key(plugin_id, ws)
    change = ({'Put': {'TableName': table.name, 'Item': {**key, 'enabled_by': actor, 'enabled_at': at},
                       'ConditionExpression': 'attribute_not_exists(pk)'}}
              if enabled else
              {'Delete': {'TableName': table.name, 'Key': key, 'ConditionExpression': 'attribute_exists(pk)'}})
    items = [change, *_checks(table.name, context, actor)]
    try:
        # A token per request: botocore's retry of a transaction whose answer was lost succeeds (idempotent 10 min).
        table.meta.client.transact_write_items(TransactItems=items, ClientRequestToken=secrets.token_hex(16))
    except ClientError as exc:
        codes = cancellation_codes(exc)
        if codes[2:3] == ['ConditionalCheckFailed']:
            raise AuthorizationError(NO_LONGER_ADMIN) from exc
        if codes[1:2] == ['ConditionalCheckFailed']:
            raise NotFoundError(NOT_FOUND) from exc
        if codes[:1] == ['ConditionalCheckFailed'] or 'TransactionConflict' in codes:
            raise ConflictError(CHANGED_MEANWHILE) from exc
        raise
    return {'id': plugin_id, 'enabled': enabled, **({'enabled_at': at, 'enabled_by': actor} if enabled else {})}
