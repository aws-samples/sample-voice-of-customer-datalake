"""Test support: a valid voc-msg/1 message, changed as each test needs, and ULID event ids."""
from __future__ import annotations

import os
import time
from typing import Any

RUN = 'run-1'
AGENT_SOURCE = f'voc.engineering/agent/fixer/default/{RUN}/fixer-1'
_CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'


def new_event_id(now_ms: int | None = None) -> str:
    """A ULID: 48 bits of milliseconds then 80 random bits, Crockford base32 (sorts by time)."""
    value = ((now_ms if now_ms is not None else time.time_ns() // 1_000_000) << 80) | int.from_bytes(
        os.urandom(10), 'big')
    return ''.join(_CROCKFORD[(value >> shift) & 31] for shift in range(125, -1, -5))


def message(**changes: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        'schema': 'voc-msg/1', 'event_id': new_event_id(1_700_000_000_000), 'ws': 'default', 'run_id': RUN,
        'thread_id': 't-1', 'attempt': 1, 'from': {'kind': 'agent', 'id': 'fixer-1'},
        'to': {'kind': 'agent', 'id': 'reviewer-1'}, 'type': 'msg.question', 'summary': 'Is the page size inclusive?',
        'refs': {'s3': [f'ws/default/runs/{RUN}/fixer-1/commits/abc1234/pkg/attempt-1/q.jsonl']},
        'at': '2026-11-12T09:00:00Z'}
    base.update(changes)
    return base
