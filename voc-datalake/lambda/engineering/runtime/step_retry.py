"""A person's Resume at a flow step's decision point tries the step again (7.71.04).

A run whose flow waits at a person at a step (``flow:<step>``: a task of it ended needing a person, and the conductor
blocked it) is resumed by a person's Resume of the whole run, which records their decision on the step
(``runs.RunStore.resume``): the conductor then gives the step one more try (``flow/conductor.py``). Until 7.71.04 the
try was the coordinator's to post, and on the live Bug fixer run on b- the reopened coordinator read the committer's
task, ended needing a person, as "the person's", posted nothing and finished, so the run went straight back to a
person. Now the Resume itself posts the step's task again: each task of the step that ended needing a person, and
whose work (its spec) has nothing posted since, is posted once more as it was (its role, title, spec, parent,
priority and shard), as a new task the person posted (``human:<subject>``, D4), through the board's own flow checks
(``FlowGuard.post_fields``: the step must be live after the decision, one task at a time for an agent step), so the
coordinator, continued or new, has only to launch its agent. A task that failed is the coordinator's to post again
(its skill's rule, never twice as it was); one that is under way or done is left alone. Best effort: a refused post
is logged, and the coordinator can still post the step's task itself.
"""
from __future__ import annotations

import json
from collections.abc import Sequence

from engineering.board.flow_guard import FlowGuard
from engineering.board.model import DONE, FINAL, NEEDS_HUMAN, PERSON_PREFIX, Task
from engineering.board.store import BoardError
from engineering.connectors.identity import WORKSPACE
from engineering.runtime.runs import UNATTRIBUTED
from shared.logging import logger


def to_retry(tasks: Sequence[Task], step: str) -> list[Task]:
    """The step's tasks to post again: for each of its works (a spec, by its hash), the newest task, when it ended
    needing a person and none of that work is under way or done. None while anything of the step is under way."""
    mine = [task for task in tasks if task.flow_step == step]
    if any(task.state not in FINAL for task in mine):
        return []
    works: dict[str, list[Task]] = {}
    for task in mine:
        works.setdefault(task.spec_hash, []).append(task)
    found = []
    for same in works.values():
        newest = max(same, key=lambda task: (task.updated_at, task.task_id))
        if newest.state == NEEDS_HUMAN and not any(task.state == DONE for task in same):
            found.append(newest)
    return sorted(found, key=lambda task: task.task_id)


def retry_step(flows: FlowGuard, run_id: str, step: str, *, actor: str) -> list[str]:
    """The step's tasks that ended needing a person posted again after a person's decision on it (module doc); the new
    tasks' ids. A post the board refuses (the step not live, another task of it posted meanwhile) is logged and
    skipped."""
    store = flows.store
    poster = PERSON_PREFIX + (actor or UNATTRIBUTED)
    posted: list[str] = []
    for task in to_retry(store.tasks(WORKSPACE, run_id), step):
        spec = json.loads(task.spec)
        try:
            fields = flows.post_fields(run_id, {'flow_step': step, 'shard': task.shard}, role=task.role,
                                       poster='coordinator', spec=spec, parent_task=task.parent_task, person=True)
            done = store.post(WORKSPACE, run_id, role=task.role, title=task.title, spec=spec,
                              parent_task=task.parent_task, priority=task.priority, actor=poster, step=fields.step,
                              shard=fields.shard, slot=fields.slot, absent=fields.absent, answer_only=fields.retry)
        except BoardError as refused:
            logger.warning('engineering runtime: a step\'s task was not posted again on the Resume',
                           extra={'run_id': run_id, 'step': step, 'task_id': task.task_id, 'reason': str(refused)})
            continue
        posted.append(done.task.task_id)
    if posted:
        logger.info('engineering runtime: a person\'s Resume tries the step again',
                    extra={'run_id': run_id, 'step': step, 'tasks': posted})
    return posted
