"""A workspace's plugin credentials in SSM Parameter Store (docs/multi-workspace.md, decision 19).

Each plugin of each workspace has at most one SecureString parameter (standard tier: no monthly fee, 4 KB),
encrypted with the deployment's customer-managed KMS key, named by shared/workspace_ids.py only::

    {prefix}/{ws}/credentials/{plugin}   its keys as one JSON object of strings ({"api_key": "…", "webhook_secret":
                                         "…", "app_name": "…"}): every ``<plugin>_<key>`` the shared secret holds for
                                         that plugin but its ``configs`` list (a row: shared/plugin_configs.py,
                                         whose ``read_plugin_values`` merges the two)

So no parameter grows with the number of plugins. Nothing is made when a workspace is created: a parameter exists once
something is saved in it, and one that does not exist means "nothing saved" (``ParameterNotFound`` reads as no keys).
A value over 4096 bytes (UTF-8, not characters) is refused before anything is written (``ValidationError``, a 400).

The values handed back are the plugin's bare keys, what plugins/_shared/plugin_secrets.py ``filter_plugin_secrets``
hands a plugin from the shared secret. Which workspace and which plugin is the caller's (a request's resolved
membership, a run's verified scope, a webhook's routed workspace), never a field a client sent.
"""
from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.exceptions import ValidationError
from shared.logging import logger, metrics
from shared.plugin_identity import is_valid_plugin_identifier
from shared.workspace_ids import credentials_parameter_name, credentials_path

__all__ = ['MalformedCredentials', 'checked_credentials', 'read_credentials', 'read_workspace', 'save_credentials']

#: The standard tier's limit on one parameter's value, in bytes.
_MAX_BYTES: Final = 4096


class MalformedCredentials(ValueError):
    """A stored credentials parameter that is not a JSON object (a hand-edited one): a misconfiguration, which a run
    counts; told apart from a ``ValueError`` of a name that cannot be built (a bad prefix or id)."""


def _not_found(error: ClientError) -> bool:
    return error.response.get('Error', {}).get('Code') == 'ParameterNotFound'


def _read_parameter(client: Any, name: str) -> str | None:
    """One SecureString's decrypted value, or None when it does not exist. Every other failure raises as boto3 raised
    it (the caller decides: a route answers 500, a run is not counted against its breaker)."""
    try:
        return client.get_parameter(Name=name, WithDecryption=True)['Parameter']['Value']
    except ClientError as error:
        if _not_found(error):
            return None
        raise


def _keys_of(raw: str | None) -> dict:
    """A credentials parameter's JSON object (``{}`` for none); ``MalformedCredentials`` for one that is not."""
    if raw is None:
        return {}
    try:
        keys = json.loads(raw)
    except ValueError as error:
        raise MalformedCredentials('a credentials parameter is not a JSON object') from error
    if not isinstance(keys, dict):
        raise MalformedCredentials('a credentials parameter is not a JSON object')
    return keys


def read_credentials(client: Any, prefix: str, ws: str, plugin: str) -> dict:
    """``plugin``'s bare keys in workspace ``ws``, ``{}`` when nothing is saved: one GetParameter of that plugin's own
    name. The name is built first, so a bad prefix or id is a plain ``ValueError`` before any call."""
    return _keys_of(_read_parameter(client, credentials_parameter_name(prefix, ws, plugin)))


def read_workspace(client: Any, prefix: str, ws: str) -> dict[str, dict]:
    """Every plugin's bare keys in workspace ``ws``, by plugin id (only plugins with something saved): one paged
    GetParametersByPath of that workspace's credentials path only (the integrations status). A plugin whose parameter
    is not a JSON object is left out, with a warning naming the plugin and the error type, so one hand-edited value
    does not hide every other plugin's status."""
    path = credentials_path(prefix, ws)
    found: dict[str, dict] = {}
    for page in client.get_paginator('get_parameters_by_path').paginate(
            Path=path, Recursive=False, WithDecryption=True):
        for parameter in page.get('Parameters', []):
            plugin = parameter['Name'][len(path) + 1:]
            if not is_valid_plugin_identifier(plugin):
                continue
            try:
                found[plugin] = _keys_of(parameter['Value'])
            except MalformedCredentials as error:
                logger.warning("A workspace's credentials parameter is not a JSON object: left out",
                               extra={'plugin_id': plugin, 'error_type': type(error).__name__})
                # The metric the webhooks count for the same fault (plugins/_shared/base_webhook.py).
                metrics.add_metric(name='WorkspaceCredentialsMalformed', unit='Count', value=1)
    return found


def save_credentials(client: Any, prefix: str, ws: str, plugin: str, *, stored: Mapping[str, Any],
                     values: Mapping[str, Any], key_id: str) -> None:
    """Write ``values`` (``plugin``'s bare keys, the result of a read-modify-write of ``stored``) to the plugin's
    parameter in ``ws`` when they changed: a SecureString under ``key_id`` (the customer-managed key), standard tier,
    overwritten whole. Over 4096 bytes is a ``ValidationError`` and nothing is written."""
    if dict(values) == dict(stored):
        return
    name = credentials_parameter_name(prefix, ws, plugin)
    value = checked_credentials(plugin, values)
    client.put_parameter(Name=name, Value=value, Type='SecureString', KeyId=key_id, Overwrite=True, Tier='Standard')


def checked_credentials(plugin: str, values: Mapping[str, Any]) -> str:
    """``values`` as the parameter's JSON text when it fits in 4096 bytes (UTF-8), else a ``ValidationError`` (400):
    the check a caller makes before writing anything else of the same save."""
    value = json.dumps(dict(values), ensure_ascii=False)
    size = len(value.encode('utf-8'))
    if size > _MAX_BYTES:
        raise ValidationError(
            f"The {plugin} credentials of this workspace would take {size} bytes, over the {_MAX_BYTES}-byte limit "
            "of one stored value. Shorten or remove some values and retry.")
    return value
