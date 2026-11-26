"""The shapes of the autonomous agents' ids (shared/agents_store.py mints them), in a module of their own so the
workspace layer (shared/ws_repo.py) checks an id before it builds a key from it without importing the store.

- an agent ``ag_`` + 12 hex digits;
- a stored workflow ``wf_`` + 12 hex digits (the built-in ``wf_default`` is never stored, so it has no key);
- a run ``ar_`` + 12 to 20 hex digits (the start time in ms and a random tail; older runs have a 4-digit tail).
"""
from __future__ import annotations

import re
from typing import Final

__all__ = ['AGENT_ID_RE', 'RUN_ID_RE', 'WORKFLOW_ID_RE']

AGENT_ID_RE: Final = re.compile(r'ag_[0-9a-f]{12}')
WORKFLOW_ID_RE: Final = re.compile(r'wf_[0-9a-f]{12}')
RUN_ID_RE: Final = re.compile(r'ar_[0-9a-f]{12,20}')
