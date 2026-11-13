"""A board task: its states, the moves its owner may make, and its row in the ``voc-engineering`` table.

``WS#<ws>#RUN#<run>`` / ``TASK#<task>`` (plan v3, 4.3). A task is ``open`` until an agent of its role claims it;
the claim sets a lease whose epoch is the task's attempt. Only the lease holder, with that epoch, renews it,
reports its progress or moves it, so an agent whose lease was lost (and whose task the supervisor re-posted as the
next attempt) can no longer act on it.
"""
from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from engineering.rows import string_attr as _s

OPEN, CLAIMED, IN_PROGRESS, IN_REVIEW, DONE, FAILED, NEEDS_HUMAN = (
    'open', 'claimed', 'in_progress', 'in_review', 'done', 'failed', 'needs_human')
FINAL = frozenset({DONE, FAILED, NEEDS_HUMAN})
#: A person's id on the board (a history row's actor, a held lease's agent): ``human:<their subject>``. An agent's id is
#: ``<role>-<n>``, so the two never meet.
PERSON_PREFIX = 'human:'
#: The moves a task's owner may make, from a state to the next.
MOVES = {
    CLAIMED: frozenset({IN_PROGRESS, FAILED, NEEDS_HUMAN}),
    IN_PROGRESS: frozenset({IN_REVIEW, DONE, FAILED, NEEDS_HUMAN}),
    IN_REVIEW: frozenset({IN_PROGRESS, DONE, FAILED, NEEDS_HUMAN}),
}
#: The board event each state publishes (voc-msg/1 types). ``task.progress`` also carries a holder's progress report
#: (the ``progress`` op): a receiver tells the two apart by its summary, which starts ``progress:`` for a report.
EVENT_OF = {CLAIMED: 'task.claimed', IN_PROGRESS: 'task.progress', IN_REVIEW: 'task.review', DONE: 'task.done',
            FAILED: 'task.failed', NEEDS_HUMAN: 'task.needs_human'}


def task_key(ws: str, run_id: str, task_id: str) -> dict[str, dict[str, str]]:
    return {'pk': {'S': f'WS#{ws}#RUN#{run_id}'}, 'sk': {'S': f'TASK#{task_id}'}}


@dataclass(frozen=True)
class Move:
    """One change of a task, kept as its own row (``TASKLOG#<task>#<at>#<state>``, D1), with who made it and how
    (D4: ``op`` is the board operation, the reason the board knows; ``reason`` why, when its maker gave one: the
    supervisor's for a re-post)."""

    task_id: str
    state: str
    actor: str
    at: str
    attempt: int
    op: str
    result_keys: tuple[str, ...] = ()
    reason: str = ''

    @classmethod
    def from_item(cls, item: Mapping[str, Any]) -> Move:
        return cls(task_id=_s(item, 'task_id'), state=_s(item, 'state'), actor=_s(item, 'actor'), at=_s(item, 'at'),
                   attempt=_n(item, 'attempt'), op=_s(item, 'op'),
                   result_keys=tuple(sorted(item.get('result_keys', {}).get('SS', ()))), reason=_s(item, 'reason'))

    def view(self) -> dict[str, Any]:
        """The move as the board and the reports show it."""
        view: dict[str, Any] = {'state': self.state, 'at': self.at, 'by': self.actor, 'op': self.op,
                                'attempt': self.attempt, 'result_keys': len(self.result_keys)}
        if self.reason:
            view['reason'] = self.reason
        return view

    def item(self, ws: str, run_id: str) -> dict[str, Any]:
        row: dict[str, Any] = {
            'pk': {'S': f'WS#{ws}#RUN#{run_id}'}, 'sk': {'S': f'TASKLOG#{self.task_id}#{self.at}#{self.state}'},
            'task_id': {'S': self.task_id}, 'state': {'S': self.state}, 'actor': {'S': self.actor},
            'at': {'S': self.at}, 'attempt': {'N': str(self.attempt)}, 'op': {'S': self.op}}
        if self.result_keys:
            row['result_keys'] = {'SS': list(self.result_keys)}
        if self.reason:
            row['reason'] = {'S': self.reason}
        return row


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
    #: The op of the last change ``updated_by`` records, when it was a person's take, block or priority or a move (''
    #: after a post, a claim or a re-post, which clear it; a launch records neither): what tells a person's change from
    #: a no-op answered as it is (only the change, or a retry of it while it is still the last, is published).
    updated_op: str = ''
    #: The holder's last progress report (``progress``): when (epoch seconds), its step, and whether it is waiting
    #: on an open question, review or decision (the supervisor leaves a waiting task alone).
    progress_at: int = 0
    step: str = ''
    waiting: bool = False
    #: The agent the run's coordinator launched for this task (the ``launch`` op), the attempt it was launched at (a
    #: retried launch at that attempt reuses it; a repost's new attempt gets a new one) and the paths it was given.
    launched_agent: str = ''
    launched_attempt: int = 0
    launched_paths: tuple[str, ...] = ()
    launched_language: str = ''

    @classmethod
    def from_item(cls, item: Mapping[str, Any]) -> Task:
        return cls(
            task_id=_s(item, 'task_id'), role=_s(item, 'role'), state=_s(item, 'state'), title=_s(item, 'title'),
            spec=_s(item, 'spec') or '{}', spec_hash=_s(item, 'spec_hash'), depth=_n(item, 'depth'), priority=_n(item, 'priority'),
            attempt=_n(item, 'attempt'), parent_task=_s(item, 'parent_task'), lease_agent=_s(item, 'lease_agent'),
            lease_epoch=_n(item, 'lease_epoch'), lease_expires=_n(item, 'lease_expires'),
            result_keys=tuple(item.get('result_keys', {}).get('SS', ())), posted_by=_s(item, 'posted_by'),
            updated_by=_s(item, 'updated_by'), updated_at=_s(item, 'updated_at'), updated_op=_s(item, 'updated_op'),
            progress_at=_n(item, 'progress_at'), step=_s(item, 'step'),
            waiting=item.get('waiting', {}).get('BOOL') is True, launched_agent=_s(item, 'launched_agent'),
            launched_attempt=_n(item, 'launched_attempt'),
            launched_paths=tuple(path['S'] for path in item.get('launched_paths', {}).get('L', ()) if 'S' in path),
            launched_language=_s(item, 'launched_language'))

    def paths(self) -> tuple[str, ...]:
        """The repository paths the task works on: '' (the root), its spec's ``paths`` (strings) and the paths its
        agent was launched on."""
        listed = json.loads(self.spec).get('paths', [])
        spec = [path for path in listed if isinstance(path, str)] if isinstance(listed, list) else []
        return tuple(dict.fromkeys(('', *spec, *self.launched_paths)))

    def view(self) -> dict[str, Any]:
        """What the board API answers about a task."""
        return {'task_id': self.task_id, 'role': self.role, 'state': self.state, 'title': self.title,
                'spec': json.loads(self.spec),
                'depth': self.depth, 'priority': self.priority, 'attempt': self.attempt,
                'parent_task': self.parent_task or None, 'lease': {'agent': self.lease_agent,
                                                                  'epoch': self.lease_epoch,
                                                                  'expires': self.lease_expires}
                if self.lease_agent else None, 'result_keys': sorted(self.result_keys), 'posted_by': self.posted_by,
                'updated_by': self.updated_by, 'updated_at': self.updated_at, 'spec_hash': self.spec_hash,
                'progress': {'at': self.progress_at, 'step': self.step, 'waiting': self.waiting}
                if self.progress_at else None, 'launched_agent': self.launched_agent or None}
