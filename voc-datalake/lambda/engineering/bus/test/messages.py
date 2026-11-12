"""Test support: a valid voc-msg/1 message, changed as each test needs."""
from __future__ import annotations

from typing import Any

from engineering.bus.publish import new_event_id

RUN = 'run-1'
AGENT_SOURCE = f'voc.engineering/agent/fixer/default/{RUN}/fixer-1'


def message(**changes: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        'schema': 'voc-msg/1', 'event_id': new_event_id(), 'ws': 'default', 'run_id': RUN,
        'thread_id': 't-1', 'attempt': 1, 'from': {'kind': 'agent', 'id': 'fixer-1'},
        'to': {'kind': 'agent', 'id': 'reviewer-1'}, 'type': 'msg.question', 'summary': 'Is the page size inclusive?',
        'refs': {'s3': [f'ws/default/runs/{RUN}/fixer-1/commits/abc1234/pkg/attempt-1/q.jsonl']},
        'at': '2026-11-12T09:00:00Z'}
    base.update(changes)
    return base
