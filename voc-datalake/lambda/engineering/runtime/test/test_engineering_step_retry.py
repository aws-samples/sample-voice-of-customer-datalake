"""runtime/step_retry.py (7.71.04): which of a step's tasks a person's Resume at its decision point posts again, and a
refused post left to the coordinator. The Resume end to end is test_engineering_bug_hunt_resume.py's."""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from engineering.board.flow_guard import FlowGuard, PostFields
from engineering.board.model import Task
from engineering.board.store import BoardError, BoardStore
from engineering.runtime.step_retry import retry_step, to_retry


def _task(task_id: str, state: str, *, step: str = 'commit', work: str = 'w1', at: str = '2026-11-25T10:00:00') -> Task:
    return Task(task_id=task_id, role='committer', state=state, title='Commit the fix', spec='{"patch": "p"}',
                spec_hash=work, depth=0, priority=0, attempt=1, flow_step=step, updated_at=at)


def test_the_newest_task_of_each_work_that_ended_at_a_person_is_posted_again() -> None:
    tasks = [_task('t1', 'failed', at='2026-11-25T09:00:00'), _task('t2', 'needs_human'),
             _task('t3', 'needs_human', work='w2'), _task('t4', 'needs_human', step='hunt', work='w3')]
    assert [task.task_id for task in to_retry(tasks, 'commit')] == ['t2', 't3']


def test_a_work_that_failed_last_or_was_done_and_a_step_under_way_post_nothing_again() -> None:
    assert to_retry([_task('t1', 'needs_human', at='2026-11-25T09:00:00'), _task('t2', 'failed')], 'commit') == []
    assert to_retry([_task('t1', 'done', at='2026-11-25T09:00:00'), _task('t2', 'needs_human')], 'commit') == []
    assert to_retry([_task('t1', 'needs_human'), _task('t2', 'claimed', work='w2')], 'commit') == []


class _Listed(BoardStore):
    """The board's store with the run's tasks as listed (no table is read)."""

    def __init__(self, listed: list[Task]) -> None:
        super().__init__(None, 'unused', new_id=lambda: 'unused')
        self.listed = listed

    def tasks(self, ws: str, run_id: str) -> list[Task]:
        assert (ws, run_id) == ('default', 'run-1')
        return list(self.listed)


class _RefusingGuard(FlowGuard):
    """The board's flow checks, refusing every post (the step not live), each one asked kept."""

    def __init__(self, store: BoardStore) -> None:   # (its flow record never read: the refusal comes first)
        super().__init__(store)
        self.asked: list[tuple[Any, ...]] = []

    def post_fields(self, run_id: str, body: Mapping[str, Any], *, role: str, poster: str, spec: Mapping[str, Any],
                    parent_task: str, person: bool = False) -> PostFields:
        self.asked.append((run_id, dict(body), role, poster, dict(spec), parent_task, person))
        raise BoardError('conflict', 'step commit is blocked: only a ready step takes tasks (read the flow)')


def test_a_post_the_board_refuses_is_skipped_for_the_coordinator_to_post() -> None:
    guard = _RefusingGuard(_Listed([_task('t1', 'needs_human')]))
    assert retry_step(guard, 'run-1', 'commit', actor='admin-1') == []
    # (asked as a person's post for the step, the same role, spec and parent)
    assert guard.asked == [('run-1', {'flow_step': 'commit', 'shard': ''}, 'committer', 'coordinator', {'patch': 'p'},
                            '', True)]
