"""The board's side of a run's flow: the conductor's plan read for the run, and the board's checks against it.

In a run started from a flow (its ``FLOW`` copy, ``engineering/flow/record.py``), the board takes a post only for a
step the conductor says is live, for a role that step takes, from a poster it allows (the run coordinator for any
live step, another agent only on a board step that names it a poster, within the board's own rule of who posts for
whom), with the map's shard for a step after a map, and at most one task under way for an agent step (or a shard): a
``SLOT#`` marker in the post's own transaction holds that against a racing post. It launches an agent only for a
task of a live step (a person's own task, posted with no step, too). The run coordinator reads the plan (``flow``)
and records the steps it does itself (``step``: an agent step of its own role, a board it closes, a map's shards).
So the model cannot skip a step or take them out of order: what it may do next is the conductor's, from the record.

A run without a flow is as before: a post or launch names no step, and the coordinator plans from its goal.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from engineering.board.model import FINAL, PERSON_PREFIX, Task
from engineering.board.store import COORDINATOR, BoardError, BoardStore, slot_sk, spec_hash
from engineering.connectors.identity import WORKSPACE
from engineering.flow.conductor import Flow, FlowError, Plan
from engineering.flow.ledger import ReadRecord
from engineering.flow.record import DONE, FAN_OUT, FlowRecord, step_sk
from engineering.runtime.checkout import check_sparse_path
from engineering.runtime.interface import RuntimeRefused

NO_FLOW = 'this run follows no flow: a task names no step (the coordinator plans from the run\'s goal)'
#: The longest step id the board takes (shared/workflow_schema.py's ids are at most 64 characters), and shard.
MAX_STEP = 64
MAX_SHARD = 512


@dataclass(frozen=True)
class PostFields:
    """What a post records of the flow: its step and shard, the step's one-task marker ('' for none), the rows that
    must not exist when it lands (``absent``: the step closed, ``STEP#<step>#done``), and whether it may only be
    answered as the equal task it repeats (``retry``: never a new task, which would skip the step's check)."""

    step: str = ''
    shard: str = ''
    slot: str = ''
    absent: tuple[str, ...] = ()
    retry: bool = False


def _step_text(body: Mapping[str, Any], key: str) -> str:
    """A step id (``step``, ``flow_step``: at most ``MAX_STEP`` characters) or a shard (``shard``: a path), '' when
    left out."""
    limit = MAX_SHARD if key == 'shard' else MAX_STEP
    value = body.get(key, '')
    if not isinstance(value, str) or len(value) > limit:
        raise BoardError('invalid', f'"{key}" is a string of at most {limit} characters')
    return value.strip()


def _path(path: str) -> str:
    try:
        return check_sparse_path(path)
    except RuntimeRefused as exc:
        raise BoardError('invalid', str(exc)[:200]) from exc


class FlowGuard:
    def __init__(self, store: BoardStore, read: ReadRecord | None = None) -> None:
        """``read``: a gate record by its key (``ledger.read_gate_record`` on the workspace), so a quality gate's
        verdict is the GO ledger's; without it, a gate whose final go ended is never taken for a GO."""
        self.store = store
        self.read = read
        self.record = FlowRecord(store.client, store.table)

    def _flow(self, run_id: str) -> Flow | None:
        """The run's copy of its flow (None: started without one); a copy the conductor cannot follow is the run's
        record broken: a conflict."""
        try:
            return self.record.flow(WORKSPACE, run_id)
        except FlowError as exc:
            raise BoardError('conflict', f'the run\'s copy of its flow cannot be followed: {exc}') from exc

    def plan(self, run_id: str, tasks: Sequence[Task] | None = None) -> Plan | None:
        """The conductor's plan for the run (None: a run without a flow): its copy of the flow, its tasks, its step
        rows and META's task cap."""
        flow = self._flow(run_id)
        if flow is None:
            return None
        listed = self.store.tasks(WORKSPACE, run_id) if tasks is None else tasks
        return self.record.plan_of(flow, WORKSPACE, run_id, listed, self.store.meta(WORKSPACE, run_id),
                                   read=self.read)

    def post_fields(self, run_id: str, body: Mapping[str, Any], *, role: str, poster: str, spec: Mapping[str, Any],
                    parent_task: str, person: bool = False) -> PostFields:
        """The step a post is for, checked against the plan (``BoardError`` when it may not be posted now).

        ``poster``: the posting agent's role; ``person``: a person's post, which may name a live step (for any role
        it takes) or none (their own task, off the flow). An equal task still under way is answered as it is (a
        retried post), never refused for its step, and never taken over: the store only answers it (``retry``), so a
        post whose equal task ended meanwhile is refused, not made a new task past the step's check. Every post for a
        step holds, in its own transaction, that the step was not closed (``absent``)."""
        step, shard = _step_text(body, 'flow_step'), _step_text(body, 'shard')
        flow = self._flow(run_id)   # (one read of the run's FLOW row: none, so no task list is read)
        if flow is None:
            if step or shard:
                raise BoardError('invalid', NO_FLOW)
            return PostFields()
        tasks = self.store.tasks(WORKSPACE, run_id)
        plan = self.record.plan_of(flow, WORKSPACE, run_id, tasks, self.store.meta(WORKSPACE, run_id),
                                   read=self.read)
        if not step:
            if person and not shard:
                return PostFields()
            raise BoardError('invalid', "this run follows its flow: name the ready step the task is for (read the "
                                        'flow)')
        shard = _path(shard) if shard else ''
        digest = spec_hash(role, parent_task, spec, step, shard)
        if any(task.spec_hash == digest and task.state not in FINAL for task in tasks):
            return PostFields(step, shard, retry=True)
        refusal = plan.post_refusal(step, role, poster=COORDINATOR if person else poster, shard=shard)
        if refusal is not None:
            raise BoardError(*refusal)
        closed = (step_sk(step, DONE),)
        if plan.flow.steps[step].type != 'agent':
            return PostFields(step, shard, absent=closed)   # (a board or a gate takes several tasks at once)
        ended = sum(task.flow_step == step and task.shard == shard and task.state in FINAL for task in tasks)
        return PostFields(step, shard, slot_sk(step, shard, ended), absent=closed)

    def launch_check(self, run_id: str, task: Task) -> None:
        """A launch only for a task of a live step of the run's flow, or a person's own task (posted with no step)."""
        plan = None if task.role == COORDINATOR else self.plan(run_id)   # (the coordinate task: the store refuses it)
        if plan is None:
            return
        if not task.flow_step:
            if task.posted_by.startswith(PERSON_PREFIX):
                return
            raise BoardError('conflict', 'the task names no step of the run\'s flow: post its work for a ready step')
        refusal = plan.launch_refusal(task.flow_step)
        if refusal is not None:
            raise BoardError('conflict', refusal)

    def view(self, run_id: str, actor: str) -> dict[str, Any]:
        """The ``flow`` op: the plan as data for the run coordinator; each step it passed as not yet run is recorded
        (once, create-only) on the way."""
        plan = self.plan(run_id)
        if plan is None:
            return {'flow': None, 'note': NO_FLOW}
        at = self.store.now().isoformat()
        self.record.mark_not_yet_run(WORKSPACE, run_id, plan, actor=actor, at=at)
        if self.read is not None:   # (the verdicts read from their records, kept for the readers without them)
            self.record.record_verdicts(WORKSPACE, run_id, plan, self.store.tasks(WORKSPACE, run_id), actor=actor,
                                        at=at)
        return {'flow': plan.view()}

    def step(self, run_id: str, body: Mapping[str, Any], actor: str) -> dict[str, Any]:
        """The ``step`` op: ``{step, action: complete}`` (an agent step of the coordinator's own role, or a board it
        closes) or ``{step, action: fan_out, shards}`` (a map's shards: repository paths, each once, at most its
        ``shard_cap``), recorded create-only; the plan after it is answered."""
        step, action = _step_text(body, 'step'), body.get('action')
        plan = self.plan(run_id)
        if plan is None:
            raise BoardError('conflict', NO_FLOW)
        at = self.store.now().isoformat()
        if action == 'complete':
            refusal = plan.complete_refusal(step)
            if refusal is not None:
                raise BoardError('conflict', refusal)
            recorded = self.record.record(WORKSPACE, run_id, step, DONE, actor=actor, at=at)
        elif action == 'fan_out':
            raw = body.get('shards')
            if not isinstance(raw, list) or not all(isinstance(shard, str) for shard in raw):
                raise BoardError('invalid', '"shards" is a list of repository paths')
            shards = [_path(shard) for shard in raw]
            refusal = plan.fan_out_refusal(step, shards)
            if refusal is not None:
                raise BoardError('conflict', refusal)
            recorded = self.record.record(WORKSPACE, run_id, step, FAN_OUT, actor=actor, at=at, shards=shards)
        else:
            raise BoardError('invalid', '"action" is complete or fan_out')
        after = self.plan(run_id)
        return {'step': step, 'recorded': recorded, 'flow': None if after is None else after.view()}
