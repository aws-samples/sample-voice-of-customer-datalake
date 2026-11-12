"""A board task: its states, the moves its owner may make, and its row in the ``voc-engineering`` table.

``WS#<ws>#RUN#<run>`` / ``TASK#<task>`` (plan v3, 4.3). A task is ``open`` until an agent of its role claims it;
the claim sets a lease whose epoch is the task's attempt. Only the lease holder, with that epoch, renews or moves
it, so an agent whose lease was lost (and whose task was re-posted as the next attempt) can no longer act on it.
"""
from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

OPEN, CLAIMED, IN_PROGRESS, IN_REVIEW, DONE, FAILED, NEEDS_HUMAN = (
    'open', 'claimed', 'in_progress', 'in_review', 'done', 'failed', 'needs_human')
FINAL = frozenset({DONE, FAILED, NEEDS_HUMAN})
#: The moves a task's owner may make, from a state to the next.
MOVES = {
    CLAIMED: frozenset({IN_PROGRESS, FAILED, NEEDS_HUMAN}),
    IN_PROGRESS: frozenset({IN_REVIEW, DONE, FAILED, NEEDS_HUMAN}),
    IN_REVIEW: frozenset({IN_PROGRESS, DONE, FAILED, NEEDS_HUMAN}),
}
#: The board event each state publishes (voc-msg/1 types).
EVENT_OF = {CLAIMED: 'task.claimed', IN_PROGRESS: 'task.progress', IN_REVIEW: 'task.review', DONE: 'task.done',
            FAILED: 'task.failed', NEEDS_HUMAN: 'task.needs_human'}


def task_key(ws: str, run_id: str, task_id: str) -> dict[str, dict[str, str]]:
    return {'pk': {'S': f'WS#{ws}#RUN#{run_id}'}, 'sk': {'S': f'TASK#{task_id}'}}


def _s(item: Mapping[str, Any], key: str) -> str:
    return str(item.get(key, {}).get('S', ''))


def _n(item: Mapping[str, Any], key: str) -> int:
    return int(item.get(key, {}).get('N', '0'))


@dataclass(frozen=True)
class Task:
    task_id: str
    role: str
    state: str
    title: str
    spec: str
    spec_hash: str
    depth: int
    priority: int
    attempt: int
    parent_task: str = ''
    lease_agent: str = ''
    lease_epoch: int = 0
    lease_expires: int = 0
    result_keys: tuple[str, ...] = field(default_factory=tuple)
    posted_by: str = ''
    updated_by: str = ''
    updated_at: str = ''

    @classmethod
    def from_item(cls, item: Mapping[str, Any]) -> Task:
        return cls(
            task_id=_s(item, 'task_id'), role=_s(item, 'role'), state=_s(item, 'state'), title=_s(item, 'title'),
            spec=_s(item, 'spec') or '{}', spec_hash=_s(item, 'spec_hash'), depth=_n(item, 'depth'), priority=_n(item, 'priority'),
            attempt=_n(item, 'attempt'), parent_task=_s(item, 'parent_task'), lease_agent=_s(item, 'lease_agent'),
            lease_epoch=_n(item, 'lease_epoch'), lease_expires=_n(item, 'lease_expires'),
            result_keys=tuple(item.get('result_keys', {}).get('SS', ())), posted_by=_s(item, 'posted_by'),
            updated_by=_s(item, 'updated_by'), updated_at=_s(item, 'updated_at'))

    def view(self) -> dict[str, Any]:
        """What the board API answers about a task."""
        return {'task_id': self.task_id, 'role': self.role, 'state': self.state, 'title': self.title,
                'spec': json.loads(self.spec),
                'depth': self.depth, 'priority': self.priority, 'attempt': self.attempt,
                'parent_task': self.parent_task or None, 'lease': {'agent': self.lease_agent,
                                                                  'epoch': self.lease_epoch,
                                                                  'expires': self.lease_expires}
                if self.lease_agent else None, 'result_keys': sorted(self.result_keys), 'posted_by': self.posted_by,
                'updated_by': self.updated_by, 'updated_at': self.updated_at, 'spec_hash': self.spec_hash}
