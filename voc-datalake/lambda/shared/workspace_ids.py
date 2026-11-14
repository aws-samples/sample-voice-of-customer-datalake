"""A workspace's id and the names built from it (docs/multi-workspace.md), with no import beyond the standard library.

Split out of shared/workspace.py (the request middleware, which imports the API helpers), so the asynchronous
workers that only need to check an id or build a name (the plugin ingestors, the processing-queue schema in
shared/ingest_schemas.py, the repository layer shared/ws_repo.py) carry none of the request path's imports.

* ``is_workspace_id``: ``ws_`` + a ULID, 26 Crockford base32 characters (no I, L, O, U), the first one 0-7.
* ``ws_key``: ``WS#{ws}#a#b``, a key inside the workspace.
* ``credentials_parameter_name``: where one plugin's credentials of one workspace live in SSM Parameter Store
  (decision 19): ``{prefix}/{ws}/credentials/{plugin}``, its keys as one JSON object (the webhook secret among them);
  ``credentials_path`` is their parent. The prefix is ``/voc/ws`` (``/<deployment prefix>-voc/ws`` in a prefixed
  deployment), which CDK hands every role that reads or writes them in ``WORKSPACE_PARAMETER_PREFIX``
  (lib/utils/workspace-secrets.ts). A plugin's config list is not a credential: it is a row (shared/plugin_configs.py).
"""
from __future__ import annotations

import re
from typing import Final

# Standard library only as well (re): the plugin id rule, declared once.
from shared.plugin_identity import is_valid_plugin_identifier

__all__ = [
    'ACTIVE',
    'credentials_parameter_name',
    'credentials_path',
    'is_workspace_id',
    'ws_key',
]

#: The status of a workspace in use (its ``META``'s ``status``): any other (``deleting``), or no ``META`` at all, is a
#: workspace nothing may enter or write (shared/workspace.py ``resolve_workspace``, shared/ws_repo.py
#: ``workspace_is_active``).
ACTIVE: Final = 'active'
#: ``ws_`` + a ULID: 26 Crockford base32 characters (no I, L, O, U), the first one 0-7 (128 bits).
_WORKSPACE_ID: Final = re.compile(r'ws_[0-7][0-9A-HJKMNP-TV-Z]{25}')
#: A parameter prefix: ``/`` then path segments of letters, digits, ``-`` and ``_`` (``/voc/ws``, ``/stg-voc/ws``).
_PREFIX: Final = re.compile(r'(?:/[A-Za-z0-9_-]+)+')


def is_workspace_id(value: object) -> bool:
    """Whether ``value`` is a well-formed workspace id (``ws_`` + a ULID)."""
    return isinstance(value, str) and _WORKSPACE_ID.fullmatch(value) is not None


def ws_key(ws: str, *parts: str) -> str:
    """``WS#{ws}#a#b``: a key inside the workspace. Refuses (ValueError) an id that is not well formed."""
    if not is_workspace_id(ws):
        raise ValueError('not a workspace id')
    return '#'.join(('WS', ws, *parts))


def credentials_path(prefix: str, ws: str) -> str:
    """``{prefix}/{ws}/credentials``, the parent of every plugin's credentials parameter in the workspace. Refuses
    (ValueError) an id that is not well formed, or a prefix that is not ``/a/b`` (empty, no leading ``/``, a trailing
    ``/``, ``..`` or any other character)."""
    if not is_workspace_id(ws):
        raise ValueError('not a workspace id')
    if not _PREFIX.fullmatch(prefix):
        raise ValueError('no parameter prefix')
    return f'{prefix}/{ws}/credentials'


def credentials_parameter_name(prefix: str, ws: str, plugin: str) -> str:
    """``{prefix}/{ws}/credentials/{plugin}``. Refuses (ValueError) a malformed workspace id or prefix, and a plugin id
    outside shared/plugin_identity.py's rule (so no ``/``, ``.`` or ``-`` can reach another plugin's name)."""
    path = credentials_path(prefix, ws)
    if not is_valid_plugin_identifier(plugin):
        raise ValueError('not a plugin id')
    return f'{path}/{plugin}'
