"""A workspace's id and the names built from it (docs/multi-workspace.md), with no import beyond the standard library.

Split out of shared/workspace.py (the request middleware, which imports the API helpers), so the asynchronous
workers that only need to check an id or build a name (the plugin ingestors, the processing-queue schema in
shared/ingest_schemas.py, the repository layer shared/ws_repo.py) carry none of the request path's imports.

* ``is_workspace_id``: ``ws_`` + a ULID, 26 Crockford base32 characters (no I, L, O, U), the first one 0-7.
* ``ws_key``: ``WS#{ws}#a#b``, a key inside the workspace.
* ``credentials_secret_name``: the workspace's credentials secret ``{prefix}/{ws}/credentials`` (decision 8), the
  prefix ``voc/ws`` (``<deployment prefix>-voc/ws`` in a prefixed deployment) that CDK hands every role that reads
  or creates one in ``WORKSPACE_SECRET_PREFIX``.
"""
from __future__ import annotations

import re
from typing import Final

__all__ = ['credentials_secret_name', 'is_workspace_id', 'ws_key']

#: ``ws_`` + a ULID: 26 Crockford base32 characters (no I, L, O, U), the first one 0-7 (128 bits).
_WORKSPACE_ID: Final = re.compile(r'ws_[0-7][0-9A-HJKMNP-TV-Z]{25}')


def is_workspace_id(value: object) -> bool:
    """Whether ``value`` is a well-formed workspace id (``ws_`` + a ULID)."""
    return isinstance(value, str) and _WORKSPACE_ID.fullmatch(value) is not None


def ws_key(ws: str, *parts: str) -> str:
    """``WS#{ws}#a#b``: a key inside the workspace. Refuses (ValueError) an id that is not well formed."""
    if not is_workspace_id(ws):
        raise ValueError('not a workspace id')
    return '#'.join(('WS', ws, *parts))


def credentials_secret_name(prefix: str, ws: str) -> str:
    """``{prefix}/{ws}/credentials``. Refuses (ValueError) an id that is not well formed, or an empty prefix."""
    if not is_workspace_id(ws):
        raise ValueError('not a workspace id')
    if not prefix:
        raise ValueError('no secret prefix')
    return f'{prefix}/{ws}/credentials'
