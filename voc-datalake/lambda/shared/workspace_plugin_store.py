"""Where an operator route reads and writes a plugin's settings, on either path (docs/multi-workspace.md, Credentials).

The integrations API (plugin credentials, app connectors) and the scrapers API (scraper configs) see what the plugin
ingestors read as one JSON object of ``<plugin>_<key>`` values (plugins/_shared/plugin_secrets.py filters a run's
keys by that namespace), through a ``CredentialsStore`` (``read``, then ``write`` of the edited object):

* a request without ``X-Workspace-Id``: the deployment's shared Secrets Manager secret (``SECRETS_ARN``), as before
  (``SharedSecretStore``);
* a request in a workspace (``WorkspaceStore``, decision 19): each plugin's keys are that workspace's SSM SecureString
  ``{prefix}/{ws}/credentials/{plugin}`` (shared/workspace_credentials.py), and its ``configs`` list a row of
  voc-aggregates, ``WS#{ws}#PLUGIN_CONFIG`` / ``{plugin}`` (shared/plugin_configs.py), seen through the workspace
  layer. Names and keys come ONLY from the request's resolved membership (``credentials_store``), the plugins the
  route serves and the prefix CDK hands down in ``WORKSPACE_PARAMETER_PREFIX``; never from a path, a body or a query
  field. A run in that workspace reads the same (plugins/_shared/base_ingestor.py ``read_workspace_values``).

Nothing is created with a workspace: what does not exist reads as nothing saved, and the first save creates it (the
parameter under the deployment's customer-managed key, ``WORKSPACE_PARAMETER_KEY_ARN``). A credentials value over
4096 bytes, or a list over the shared secret's own limit, is refused (400) before anything is written. Never the shared
secret in a workspace, and a store reads and writes only the plugins it was opened for.
"""
from __future__ import annotations

import json
import os
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Final, Protocol

from shared.aws import get_dynamodb_resource
from shared.exceptions import ConfigurationError
from shared.ingest_tables import ingest_table
from shared.plugin_configs import (
    CONFIGS_KEY,
    ConfigRow,
    read_all_configs,
    read_configs,
    read_plugin_values,
    save_configs,
)
from shared.workspace import WorkspaceContext
from shared.workspace_credentials import checked_credentials, read_workspace, save_credentials
from shared.ws_repo import WorkspaceTable, scope_of

__all__ = ['CredentialsStore', 'StoreClients', 'credentials_store']

_NOT_CONFIGURED: Final = 'Secrets not configured'
#: The environment CDK sets on every Lambda that reads or writes a workspace's parameters (lib/utils/workspace-secrets.ts).
_PREFIX_ENV: Final = 'WORKSPACE_PARAMETER_PREFIX'
#: The customer-managed key a write encrypts with (writers only).
_KEY_ENV: Final = 'WORKSPACE_PARAMETER_KEY_ARN'


class CredentialsStore(Protocol):
    """One request's view of the stored plugin settings, as ``<plugin>_<key>`` keys."""

    def read(self) -> dict: ...

    def read_lists(self) -> dict: ...

    def write(self, secrets: dict) -> None: ...


@dataclass(frozen=True)
class StoreClients:
    """What a module's routes open a store with: the shared secret's ARN, the Secrets Manager and SSM clients, and
    how the shared secret is written (``put_secret_json(client, secret_id, secrets)``)."""

    shared_secret: str
    secrets_client: Any
    ssm_client: Any
    put_secret: Callable[[Any, str, dict], None]


def _read_secret_json(client: Any, secret_id: str) -> dict:
    """The shared secret's JSON object; every failure raises as boto3 raised it, for the route to answer."""
    secrets = json.loads(client.get_secret_value(SecretId=secret_id).get('SecretString', '{}'))
    if not isinstance(secrets, dict):
        # A hand-edited secret that is not a JSON object: the routes answer it as they answer malformed JSON.
        raise ValueError('the credentials secret is not a JSON object')
    return secrets


class SharedSecretStore:
    """The deployment's shared secret, read and written whole (a request without ``X-Workspace-Id``)."""

    def __init__(self, clients: StoreClients) -> None:
        self._clients = clients
        self.secret_id = clients.shared_secret

    def read(self) -> dict:
        return _read_secret_json(self._clients.secrets_client, self.secret_id)

    def read_lists(self) -> dict:
        """Deployment-wide the lists sit in the one shared secret, read whole as before."""
        return self.read()

    def write(self, secrets: dict) -> None:
        """``put_secret`` (shared/aws.py ``put_secret_json``: the 64 KiB check, then the write) of the whole object."""
        self._clients.put_secret(self._clients.secrets_client, self.secret_id, secrets)


def _prefixed(stored: dict[str, dict]) -> dict:
    """Each plugin's bare values as ``<plugin>_<key>`` (what the shared secret would hold for them)."""
    return {f'{plugin}_{key}': value for plugin, values in stored.items() for key, value in values.items()}


def _split(values: dict) -> tuple[dict, object]:
    """A plugin's bare values as (its credentials, its configs list or None)."""
    return {key: value for key, value in values.items() if key != CONFIGS_KEY}, values.get(CONFIGS_KEY)


class WorkspaceStore:
    """One workspace's settings of ``plugins`` (every plugin saved there when ``plugins`` is empty: read only).

    ``actor`` returns the caller's sub (the request's authorizer claim, ``ResolvedRoutes.credentials``): a changed
    list is stamped with it and its history row names it (shared/plugin_configs.py ``save_configs``); required, and
    asked only when a list is saved."""

    def __init__(self, ssm: Any, table: WorkspaceTable, *, prefix: str, plugins: Sequence[str], key_id: str,
                 actor: Callable[[], str]) -> None:
        self._ssm = ssm
        self._table = table
        self._prefix = prefix
        self.ws = table.scope.ws
        self.plugins = tuple(plugins)
        self._key_id = key_id
        self._actor = actor
        self._stored: dict[str, dict] = {}
        #: Each plugin's config row as ``read`` found it (None: no list): what a save replaces, and its condition.
        self._rows: dict[str, ConfigRow | None] = {}

    def _read_every(self) -> dict[str, dict]:
        stored = read_workspace(self._ssm, self._prefix, self.ws)
        for plugin, configs in read_all_configs(self._table).items():
            stored[plugin] = {**stored.get(plugin, {}), CONFIGS_KEY: configs}
        return stored

    def read(self) -> dict:
        """The plugins' keys as ``<plugin>_<key>`` (what the shared secret would hold for them); each config row
        kept as read."""
        if not self.plugins:
            self._stored = self._read_every()
            return _prefixed(self._stored)
        self._stored = {}
        for plugin in self.plugins:
            self._stored[plugin], self._rows[plugin] = read_plugin_values(self._ssm, self._prefix, self._table, plugin)
        return _prefixed(self._stored)

    def read_lists(self) -> dict:
        """Only the plugins' ``configs`` lists, as ``<plugin>_configs``: the member-open list routes' read, which
        never reaches a credentials parameter (no SSM call at all)."""
        return {f'{plugin}_{CONFIGS_KEY}': configs for plugin in self.plugins
                if (configs := read_configs(self._table, plugin)) is not None}

    def write(self, secrets: dict) -> None:
        """Save each of the store's plugins' namespace of ``secrets`` (the object ``read`` returned, edited): its
        credentials parameter when they changed, its configs row when the list changed. A key outside those namespaces
        is never written anywhere. A changed list replaces the row as ``read`` found it (a plugin not read: no list),
        so a save made since then is a 409 (``ConflictError``), not an overwrite. Per plugin, both sizes are checked
        first and the list is saved before the credentials, so that 409 or a 400 writes nothing of the plugin (a store
        of several plugins keeps what it already wrote of the plugins before it). A fault writing the credentials
        after the list saved (an SSM service fault: nothing else can fail there, the sizes being checked) leaves the
        saved list in place and the route answers 500."""
        if not self.plugins:
            raise TypeError('a store opened for every plugin is read only')
        if not self._key_id:
            raise ConfigurationError(_NOT_CONFIGURED)
        for plugin in self.plugins:
            prefix = f'{plugin}_'
            values = {key[len(prefix):]: value for key, value in secrets.items()
                      if key.startswith(prefix) and len(key) > len(prefix)}
            stored, stored_configs = _split(self._stored.get(plugin, {}))
            credentials, configs = _split(values)
            # A list no longer in the object is left as stored: no route removes one. Both values are checked before
            # anything is written, and the list is saved first: a value too large, or a 409 on the list, writes
            # nothing of this plugin.
            if credentials != stored:
                checked_credentials(plugin, credentials)
            if configs is not None and configs != stored_configs:
                save_configs(self._table, plugin, configs, replaced=self._rows.get(plugin),
                             updated_by=self._actor())
            save_credentials(self._ssm, self._prefix, self.ws, plugin, stored=stored, values=credentials,
                             key_id=self._key_id)


def _required_env(name: str) -> str:
    value = os.environ.get(name, '')
    if not value:
        raise ConfigurationError(_NOT_CONFIGURED)
    return value


def credentials_store(context: object, clients: StoreClients, plugins: Sequence[str] = (), *,
                      actor: Callable[[], str]) -> CredentialsStore:
    """The store this request reads and writes: the shared secret deployment-wide (``context`` None), else the
    resolved workspace's settings of ``plugins`` (each a plugin id the route already validated; none: every plugin,
    read only). ``ConfigurationError`` when what it needs is not set. ``context`` is ``WorkspaceContext | None``
    (typed ``object`` so the check below is also a type guard): anything else is a ``TypeError``, never a name.
    ``actor`` (required): the caller's sub, from the request's authorizer (``WorkspaceStore``), never from a body;
    the shared secret records no author."""
    if context is None:
        if not clients.shared_secret:
            raise ConfigurationError(_NOT_CONFIGURED)
        return SharedSecretStore(clients)
    if not isinstance(context, WorkspaceContext):
        raise TypeError('a workspace store needs a resolved workspace')
    # The workspaces' parameter prefix CDK sets (``/voc/ws``, or ``/<deployment prefix>-voc/ws``).
    prefix = _required_env(_PREFIX_ENV)
    # The config lists are rows of voc-aggregates, the table the operator APIs and the ingestors are all handed.
    table = ingest_table(scope_of(context), get_dynamodb_resource(), _required_env('AGGREGATES_TABLE'))
    return WorkspaceStore(clients.ssm_client, table, prefix=prefix, plugins=plugins,
                          key_id=os.environ.get(_KEY_ENV, ''), actor=actor)
