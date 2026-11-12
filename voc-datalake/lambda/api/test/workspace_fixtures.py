"""A request acting in one workspace, for the tests of a route that resolves it (shared/request_workspace.py).

The resolution itself is pinned by shared/test/test_request_workspace.py and, route by route, by the cross-workspace
suite (test_cross_workspace_routes.py); a route's own tests stub it with ``act_in_workspace`` to test the rest.
"""
from __future__ import annotations

from typing import Any

import pytest

from shared.workspace import WorkspaceContext

#: The workspace a stubbed request acts in.
WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'


def act_in_workspace(monkeypatch: pytest.MonkeyPatch, handler: Any, role: str = 'admin') -> WorkspaceContext:
    """Make ``handler.request_workspace`` answer ``WS`` with ``role`` (the caller's membership there)."""
    context = WorkspaceContext(ws=WS, role=role, name='Acme Outfitters', slug='acme', platform_admin=False)
    monkeypatch.setattr(handler, 'request_workspace', lambda _event, _public_error, **_options: context)
    return context
