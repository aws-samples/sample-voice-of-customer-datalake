"""The key of a workspace's settings row: ``WS#{ws}#SETTINGS#{kind}`` (docs/multi-workspace.md, "Per-workspace
configuration": a workspace kind of settings moves under its workspace; a deployment kind keeps ``SETTINGS#{kind}``).

The one place such a key is built (lambda/shared/test/test_settings_scopes.py holds the deployment-wide keys to the
code and leaves this module out on purpose), always from a workspace the request resolved (shared/request_workspace.py)
and a kind that is a plain name.
"""
from __future__ import annotations

import re
from typing import Final

from shared.workspace import ws_key

__all__ = ['settings_key']

_KIND: Final = re.compile(r'[a-z_]+')


def settings_key(ws: str, kind: str) -> dict[str, str]:
    """``{'pk': 'WS#{ws}#SETTINGS#{kind}', 'sk': 'config'}``. ValueError for a malformed workspace id or kind."""
    if _KIND.fullmatch(kind) is None:
        raise ValueError('not a settings kind')
    return {'pk': ws_key(ws, f'SETTINGS#{kind}'), 'sk': 'config'}
