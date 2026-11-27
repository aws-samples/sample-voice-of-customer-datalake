"""A person's Resume at a flow step's decision point tries the step again (7.71.04).

A run whose flow waits at a person at a step (``flow:<step>``: a task of it ended needing a person, and the conductor
blocked it) is resumed by a person's Resume of the whole run, which records their decision on the step
(``runs.RunStore.resume``): the conductor then gives the step another try (``flow/conductor.py``). Until 7.71.04 the
try was the coordinator's to post, and on the live Bug fixer run on b- the reopened coordinator read the committer's
task, ended needing a person, as "the person's", posted nothing and finished, so the run went straight back to a
person. Now the Resume itself posts the step's task again: each of its works whose newest task ended needing a person,
with nothing of that work done or under way, is posted once more as it was (its role, title, spec, parent, priority
and shard), as a new task the person posted (``human:<subject>``, D4), through the board's own flow checks
(``FlowGuard.post_fields``: the step must be live after the decision, one task at a time for an agent step), so the
coordinator, continued or new, has only to launch its agent. A task that failed is the coordinator's to post again
(its skill's rule, never twice as it was); one that is under way or done is left alone. Best effort, each post on its
own: a post the board refuses, or one a store fault stops (a throttled call, a transaction conflict on the posts
counter), is logged with its task's id and the next one is still made.

A work (7.104.00, Q1): an agent step takes one task at a time (per shard after a map), so its work is the step's (the
shard's), and only its newest task is posted again, whatever spec an earlier one named: 7.71.04 keyed works by their
spec, posted the oldest of two at a person, and the board then refused the newest. After a map each shard is its own
work: a shard whose task ended at a person is posted again while a sibling shard's task is still under way (its agent
held while the run waited, then resumed), and a shard with a task under way is left alone. A board's or a gate's
tasks run several at once, each its own work (its spec), and none is posted again while any task of the step is under
way.

Every whole-run Resume also tries again (Q4, 7.104.00) each other agent step that takes a task now whose newest task (a
shard's, after a map) ended needing a person: a step a person decided before 7.71.04, which only the coordinator's
skill would have posted (a stored version 7 posts nothing for a task at a person), or a shard a post on an earlier
Resume left out (refused, logged). Its status is the signal: ready, or after a map running with that shard left; a
step or a shard with a task that ended without being done takes a task again only once a person's decision covered
it.
"""
from __future__ import annotations

import json
from collections.abc import Sequence

from botocore.exceptions import BotoCoreError, ClientError

from engineering.board.flow_guard import FlowGuard
from engineering.board.model import DONE, FINAL, NEEDS_HUMAN, PERSON_PREFIX, Task
from engineering.board.store import BoardError
from engineering.connectors.identity import WORKSPACE
from engineering.flow.conductor import READY, RUNNING, Plan, StepState
from engineering.runtime.runs import UNATTRIBUTED
from shared.logging import logger

#: The step type whose tasks run one at a time (per shard after a map: ``FlowGuard.post_fields``' one-task marker).
AGENT_STEP = 'agent'


def to_retry(tasks: Sequence[Task], step: str, *, one_at_a_time: bool) -> list[Task]:
    """The step's tasks to post again: for each of its works, the newest task, when it ended needing a person and none
    of that work is done or under way. A work is a shard's for a step that takes one task at a time (``one_at_a_time``:
    an agent step, its shard '' before a map), each shard on its own (7.104.00: a shard at a person is posted again
    while a sibling shard's task is still under way), else a spec's (by its hash), and then none while anything of the
    step is under way (a gate's or a board's tasks run together)."""
    mine = [task for task in tasks if task.flow_step == step]
    if not one_at_a_time and any(task.state not in FINAL for task in mine):
        return []
    works: dict[str, list[Task]] = {}
    for task in mine:
        works.setdefault(task.shard if one_at_a_time else task.spec_hash, []).append(task)
    found = []
    for same in works.values():
        newest = max(same, key=lambda task: (task.updated_at, task.task_id))
        if newest.state == NEEDS_HUMAN and all(task.state in FINAL and task.state != DONE for task in same):
            found.append(newest)
    return sorted(found, key=lambda task: task.task_id)


def _takes_a_task(state: StepState) -> bool:
    """An agent step that takes a task now: ready, or (after a map) running with a shard left."""
    return state.status == READY or (state.status == RUNNING and bool(state.shards_left))


def steps_to_retry(plan: Plan, decided: str) -> list[str]:
    """The steps a whole-run Resume tries again: the step it decided (``decided``, '' for none), then (Q4) every other
    agent step that takes a task now (ready, or after a map running with a shard left), in the flow's order."""
    ready = [state.step for state in plan.live() if _takes_a_task(state) and state.step != decided
             and plan.flow.steps[state.step].type == AGENT_STEP]
    return [decided, *ready] if decided in plan.flow.steps else ready


def retry_step(flows: FlowGuard, run_id: str, step: str, tasks: Sequence[Task], *, one_at_a_time: bool,
               actor: str) -> list[str]:
    """The step's tasks that ended needing a person (``to_retry`` of the run's ``tasks``) posted again as ``actor``'s
    (module doc); the new tasks' ids. Each post is best effort on its own: one the board refuses (the step not live,
    another task of it posted meanwhile) or a store fault stops (``ClientError``, ``BotoCoreError``) is logged with its
    task's id and skipped, and the step's later posts are still made."""
    store = flows.store
    poster = PERSON_PREFIX + (actor or UNATTRIBUTED)
    posted: list[str] = []
    for task in to_retry(tasks, step, one_at_a_time=one_at_a_time):
        spec = json.loads(task.spec)
        try:
            fields = flows.post_fields(run_id, {'flow_step': step, 'shard': task.shard}, role=task.role,
                                       poster='coordinator', spec=spec, parent_task=task.parent_task, person=True)
            done = store.post(WORKSPACE, run_id, role=task.role, title=task.title, spec=spec,
                              parent_task=task.parent_task, priority=task.priority, actor=poster, step=fields.step,
                              shard=fields.shard, slot=fields.slot, absent=fields.absent, answer_only=fields.retry)
        except (BoardError, ClientError, BotoCoreError) as refused:
            logger.warning('engineering runtime: a step\'s task was not posted again on the Resume',
                           extra={'run_id': run_id, 'step': step, 'task_id': task.task_id, 'reason': str(refused),
                                  'error_type': type(refused).__name__})
            continue
        posted.append(done.task.task_id)
    if posted:
        logger.info('engineering runtime: a person\'s Resume tries the step again',
                    extra={'run_id': run_id, 'step': step, 'tasks': posted})
    return posted


def retry_steps(flows: FlowGuard, run_id: str, decided: str, *, actor: str) -> list[str]:
    """A person's whole-run Resume: the tasks that ended needing a person of the step it decided and of every other
    agent step that takes a task now posted again (``steps_to_retry``, module doc); the new tasks' ids. The run's tasks
    are read once, for the plan and for which tasks to post again; each post's flow checks (``post_fields``) read the
    board again. Nothing for a run without a flow."""
    tasks = flows.store.tasks(WORKSPACE, run_id)
    plan = flows.plan(run_id, tasks)
    if plan is None:
        return []
    posted: list[str] = []
    for step in steps_to_retry(plan, decided):
        posted += retry_step(flows, run_id, step, tasks, one_at_a_time=plan.flow.steps[step].type == AGENT_STEP,
                             actor=actor)
    return posted
