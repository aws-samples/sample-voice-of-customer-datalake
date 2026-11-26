"""A workspace's id and the names built from it (docs/multi-workspace.md), with no import beyond the standard library.

Split out of shared/workspace.py (the request middleware, which imports the API helpers), so the asynchronous
workers that only need to check an id or build a name (the plugin ingestors, the processing-queue schema in
shared/ingest_schemas.py, the repository layer shared/ws_repo.py) carry none of the request path's imports.

* ``is_workspace_id``: ``ws_`` + a ULID, 26 Crockford base32 characters (no I, L, O, U), the first one 0-7.
* ``is_workspace_slug``: a slug a workspace may have (``WORKSPACE_SLUG``, not one of ``RESERVED_WORKSPACE_SLUGS``),
  the ``<slug>`` of its pages' ``/workspace/<slug>`` (shared/platform_workspaces.py makes them; the engineering
  GitHub App's manifest returns into one, engineering/connectors/github_apps.py).
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
    'RESERVED_WORKSPACE_SLUGS',
    'WORKSPACE_SLUG',
    'credentials_parameter_name',
    'credentials_path',
    'is_workspace_id',
    'is_workspace_slug',
    'ws_key',
]

#: The status of a workspace in use (its ``META``'s ``status``): any other (``deleting``), or no ``META`` at all, is a
#: workspace nothing may enter or write (shared/workspace.py ``resolve_workspace``, shared/ws_repo.py
#: ``workspace_is_active``).
ACTIVE: Final = 'active'
#: ``ws_`` + a ULID: 26 Crockford base32 characters (no I, L, O, U), the first one 0-7 (128 bits).
WORKSPACE_ID_TEXT: Final = r'ws_[0-7][0-9A-HJKMNP-TV-Z]{25}'
#: The field an asynchronous message (SQS body, Lambda async payload) names its workspace in; every log line's tag too
#: (shared/system_log_scope.py). Re-exported by shared/ws_repo.py, where most modules import it from.
WORKSPACE_FIELD: Final = 'workspace_id'
_WORKSPACE_ID: Final = re.compile(WORKSPACE_ID_TEXT)
#: A parameter prefix: ``/`` then path segments of letters, digits, ``-`` and ``_`` (``/voc/ws``, ``/stg-voc/ws``).
_PREFIX: Final = re.compile(r'(?:/[A-Za-z0-9_-]+)+')
#: A workspace's slug: 3 to 40 of a-z, 0-9 and '-', neither first nor last a '-'.
WORKSPACE_SLUG: Final = re.compile(r'[a-z0-9][a-z0-9-]{1,38}[a-z0-9]')
#: Slugs that would read as a part of the platform in a ``/workspace/{slug}`` address or a mail address.
RESERVED_WORKSPACE_SLUGS: Final = frozenset({'admin', 'api', 'app', 'platform', 'www'})


def is_workspace_id(value: object) -> bool:
    """Whether ``value`` is a well-formed workspace id (``ws_`` + a ULID)."""
    return isinstance(value, str) and _WORKSPACE_ID.fullmatch(value) is not None



def is_workspace_slug(value: object) -> bool:
    """A slug a workspace may have: ``WORKSPACE_SLUG``'s shape and not one of ``RESERVED_WORKSPACE_SLUGS``."""
    return isinstance(value, str) and WORKSPACE_SLUG.fullmatch(value) is not None and value not in RESERVED_WORKSPACE_SLUGS

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
