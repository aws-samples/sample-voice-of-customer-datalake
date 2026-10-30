"""Loopback redirect URIs for native MCP clients (RFC 8252 §7.3), docs/mcp.md → "OAuth sign-in".

A desktop client (Kiro, Claude Code, Cursor) listens on ``http://127.0.0.1:<random port><path>`` for the
authorization response. Cognito matches callbacks EXACTLY, so the facade registers one relay URL there
and sends the code on to the client's own loopback URI. This module decides which URIs count as
loopback: plain ``http``, host ``127.0.0.1`` / ``localhost`` / ``[::1]``, an explicit port in
1024-65535, exactly the expected path, and nothing else — no user info, query or fragment, and no
characters (``@ ? # \\`` or whitespace) a lenient parser could read as a different host.
"""

from __future__ import annotations

import re
from typing import Final
from urllib.parse import urlsplit

LOOPBACK_HOSTS: Final = frozenset({'127.0.0.1', 'localhost', '::1'})
MIN_PORT: Final = 1024
MAX_PORT: Final = 65535
MAX_URI_LENGTH: Final = 256
_FORBIDDEN: Final = re.compile(r'[@?#\\\s]')


def loopback_path(uri: object) -> str | None:
    """The path of a well-formed loopback URI, or None for anything that is not one."""
    if not isinstance(uri, str) or not uri or len(uri) > MAX_URI_LENGTH or _FORBIDDEN.search(uri):
        return None
    try:
        parts = urlsplit(uri)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme != 'http' or parts.hostname not in LOOPBACK_HOSTS or port is None:
        return None
    if not MIN_PORT <= port <= MAX_PORT or not parts.path.startswith('/'):
        return None
    return parts.path


def is_loopback_for(uri: object, path: str) -> bool:
    """True when ``uri`` is a loopback URI on exactly ``path`` (any allowed port)."""
    return loopback_path(uri) == path
