"""The conductor: which steps of a run's flow come next, from the flow's graph and the board's state. Pure (no AWS).

A run started from a flow keeps a copy of its ``voc-workflow/2`` definition (``record.py``); the conductor reads that
copy and what the board holds for each step (the tasks posted for it, the run coordinator's own records of a step
it did, a map's shards, a person's decisions) and says, for every step, where it is:

- ``waiting``: a step before it has not finished;
- ``ready``: its turn (tasks may be posted and launched for it, or the run coordinator does it itself);
- ``running``: tasks of it are under way (more may still be posted where the step takes several);
- ``collecting``: a board whose posters are still at work: it takes their posts, and the coordinator's, before its
  turn comes;
- ``done``; ``not_yet_run``: the runtime cannot do the step yet, and the flow goes on without it; ``passed``: a person
  went past it (a human decision point, or a step that stopped);
- ``blocked``: one of its tasks ended without being done (failed, or needing a person) and nobody decided since;
  ``stopped``: the runtime cannot do it and the flow cannot go on without it; ``human``: a human decision point the
  flow reached. Each of these three puts the run at a person, the step named;
- ``skipped``: on a way the flow did not take (a quality gate's other arrow).

What each step type means here:

- ``agent``: one task for its role, done when that task is done. An agent of the coordinator's own role (a Feature's
  plan) is the run coordinator's to do: it records the step done itself (``complete``).
- ``map`` (``shard_by: packages``): the run coordinator lists the packages from its checkout (``fan_out``, at most the
  map's ``shard_cap``); every agent step between the map and its reduce then takes one task per shard and is done
  when every shard's task is. ``history`` and ``pr_pages`` have no shard source yet: the map stops at a person.
- ``reduce``: where the map's shards meet, done once every shard of the agent steps before it is (the next step reads
  their results).
- ``board``: tasks for its claimers, posted by the run coordinator and by its posters (each within the board's own
  rule of who posts for whom), while its posters still run too; done when the coordinator closes it, with nothing
  under way (``until: caps``: only once the run's task cap is reached; an empty board only when an agent other than
  the coordinator was to post on it).
- ``quality_gate``: the gate runner's and the revisers' tasks, and the final go's once a gate runner's task is done;
  its verdict is the GO ledger's (``ledger.py``, read for the conductor into ``BoardState.verdicts``): ``go`` (its
  ``pass`` arrow) only for a final go that ended done with a GO record, ``no_go`` (its ``fail`` arrow, to a human
  decision point) for anything else, and a verdict the reader could not read keeps the gate running, never a GO. The
  broker still opens a pull request only for a gate record's GO on the exact tree.
- ``memory`` and ``learning_loop``: not run yet; the flow goes on (a read is context, a write a record, the learning
  loop the run's own retrospective at its end, which still runs). ``self_improvement``: not run yet, and it is the
  whole of its flow's work, so it stops at a person.
- ``stop_at_pr``: the flow ends at the draft pull request (the broker's dial still decides whether one is opened);
  ``end``: the flow ends, at a person when its status is ``needs_human``.

A person's decision on a step (a Resume of the run at that step's decision point, ``runs.RunStore.resume``) passes a
human decision point or a stopped step, and gives a blocked step one more try (each decision one more failed task;
on a step after a map, one more on each shard, so one decision retries every shard that failed once).
Several ways at once are followed together; a step after a join waits for every way that was taken. The flow has
finished when no step is live and an end was reached.
"""
from __future__ import annotations

from collections import deque
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from engineering.board.store import COORDINATOR
from engineering.flow.ledger import FINAL_GO_ROLE
from shared.workflow_engineering import NODE_STOP_AT_PR, SCHEMA_V2

GATE_RUNNER: Final = 'gate-runner'
#: A quality gate step's verdict, as the GO ledger reads it (``flow/ledger.py``; ``record.py`` reads it for the
#: conductor), and the one a reader without the gate records cannot tell yet.
GO, NO_GO, UNREAD = 'go', 'no_go', 'unread'

WAITING, READY, RUNNING, COLLECTING = 'waiting', 'ready', 'running', 'collecting'
DONE, NOT_YET_RUN, PASSED = 'done', 'not_yet_run', 'passed'
BLOCKED, STOPPED, HUMAN = 'blocked', 'stopped', 'human'
SKIPPED = 'skipped'
#: A step whose way goes on past it.
COMPLETE: Final = frozenset({DONE, NOT_YET_RUN, PASSED})
#: A step that takes tasks now (posts and launches for it).
LIVE: Final = frozenset({READY, RUNNING, COLLECTING})
#: A step that puts the run at a person.
HALTED: Final = frozenset({BLOCKED, STOPPED, HUMAN})

#: The run's outcome as the flow says it.
GOING, AT_A_PERSON, FINISHED = 'running', 'needs_human', 'finished'
#: The decision point a run waits at for a step of its flow (``RunStore.needs_human``): ``flow:<step>``.
DECISION_PREFIX: Final = 'flow:'

#: A board task's states (engineering.board.model; the board's tests hold the two together).
TASK_DONE: Final = 'done'
TASK_ENDED: Final = frozenset({'done', 'failed', 'needs_human'})

#: The map shard sources the runtime has: the run coordinator lists the repository's packages from its checkout.
SHARD_SOURCES: Final = frozenset({'packages'})
#: A quality gate step's tasks: the gate runner's (packs and review rounds), the revisers' (a blocking finding's fix,
#: committed and reviewed) and, once a gate runner's task is done, the final go's.
GATE_ROLES: Final = (GATE_RUNNER, 'fixer', 'builder', 'committer', 'commit-reviewer', FINAL_GO_ROLE)
TERMINALS: Final = frozenset({'end', NODE_STOP_AT_PR})

#: Why a step the runtime cannot run yet is passed, or stops the run.
NOT_RUN: Final = {
    'memory': 'memory steps are not run yet: the flow goes on without this read or write',
    'learning_loop': "a flow's learning loop is not run yet: the flow goes on (the run's retrospective still runs "
                     'at its end)',
}
SELF_IMPROVEMENT_STOP: Final = ("the coach's self-improvement step is not run by a flow yet, and the flow has nothing "
                                'to do without it: a person decides')
#: What the run coordinator does at a live step of each kind (platform text, shown with the step's settings).
NEXT: Final = {
    'agent': 'post one task for its role (post_task with this step), then launch its agent (launch_agent)',
    'coordinator': 'do this step yourself, then record it done (complete_step)',
    'map': "list the repository's packages from your checkout, at most its shard_cap, and record them (fan_out)",
    'shards': 'post one task per shard left (post_task with this step and the shard), then launch each one',
    'board': 'post tasks for its claimers and launch them; close it (complete_step) once everything on it is done',
    'quality_gate': "post the gate runner's task, the revisers' for a blocking finding, then the final go's",
}


class FlowError(ValueError):
    """A definition the conductor cannot follow (not an engineering flow, or one with a cycle)."""


@dataclass(frozen=True)
class Step:
    id: str
    type: str
    title: str
    params: Mapping[str, Any]
    instructions: str = ''


@dataclass(frozen=True)
class Arrow:
    source: str
    target: str
    label: str = ''


def _topological(ids: Sequence[str], arrows: Sequence[Arrow]) -> tuple[str, ...]:
    """The steps in an order where every arrow goes forward (definition order among equals); FlowError on a cycle."""
    into = dict.fromkeys(ids, 0)
    out: dict[str, list[str]] = {step: [] for step in ids}
    for arrow in arrows:
        into[arrow.target] += 1
        out[arrow.source].append(arrow.target)
    rank = {step: index for index, step in enumerate(ids)}
    ready = deque(step for step in ids if not into[step])
    order: list[str] = []
    while ready:
        step = ready.popleft()
        order.append(step)
        for after in sorted(out[step], key=rank.__getitem__):
            into[after] -= 1
            if not into[after]:
                ready.append(after)
    if len(order) != len(ids):
        raise FlowError('the flow has a cycle: the runtime follows only a flow whose arrows all go forward')
    return tuple(order)


def _regions(steps: Mapping[str, Step], arrows: Sequence[Arrow], order: Sequence[str]) -> dict[str, str]:
    """Each step between a map and the reduce its shards meet at, mapped to that map (the nearest one)."""
    out: dict[str, list[str]] = {step: [] for step in steps}
    for arrow in arrows:
        out[arrow.source].append(arrow.target)
    region: dict[str, str] = {}
    for map_id in (step for step in order if steps[step].type == 'map'):
        seen: set[str] = set()
        queue = deque(out[map_id])
        while queue:
            step = queue.popleft()
            if step in seen or steps[step].type in TERMINALS | {'reduce'}:
                continue
            seen.add(step)
            region[step] = map_id   # (a later map in the order is a nearer one)
            queue.extend(out[step])
    return region


def _texts(item: Mapping[str, Any], *keys: str) -> tuple[str, ...]:
    """The string values of ``keys`` in ``item``, '' for one missing or not a string."""
    return tuple(value if isinstance(value := item.get(key), str) else '' for key in keys)


@dataclass(frozen=True)
class Flow:
    """A ``voc-workflow/2`` definition as the conductor follows it."""

    steps: Mapping[str, Step]
    arrows: tuple[Arrow, ...]
    order: tuple[str, ...]
    #: The steps between a map and its reduce, each to its map: an agent step there takes one task per shard.
    region: Mapping[str, str]

    @classmethod
    def from_definition(cls, definition: Mapping[str, Any]) -> Flow:
        if definition.get('schema') != SCHEMA_V2:
            raise FlowError(f'a run follows an engineering flow ({SCHEMA_V2})')
        nodes, edges = definition.get('nodes'), definition.get('edges')
        if not isinstance(nodes, list) or not isinstance(edges, list):
            raise FlowError('a flow has its steps and its arrows')
        steps: dict[str, Step] = {}
        for node in nodes:
            data = node.get('data') if isinstance(node, Mapping) else None
            if not isinstance(data, Mapping) or not isinstance(node.get('id'), str) or node['id'] in steps:
                raise FlowError('every step has its own id and its data')
            params = data.get('params')
            (kind,), (title, instructions) = _texts(node, 'type'), _texts(data, 'title', 'instructions')
            steps[node['id']] = Step(id=node['id'], type=kind, title=title, instructions=instructions,
                                     params=params if isinstance(params, Mapping) else {})
        arrows = tuple(Arrow(*_texts(edge, 'source', 'target', 'label')) for edge in edges if isinstance(edge, Mapping))
        if len(arrows) != len(edges) or any(a.source not in steps or a.target not in steps for a in arrows):
            raise FlowError('every arrow joins two steps of the flow')
        order = _topological(list(steps), arrows)
        return cls(steps=steps, arrows=arrows, order=order, region=_regions(steps, arrows, order))

    def into(self, step: str) -> list[Arrow]:
        return [arrow for arrow in self.arrows if arrow.target == step]


@dataclass(frozen=True)
class StepTask:
    """A board task as the conductor reads it: the step it was posted for, and the map's shard it works on."""

    task_id: str
    step: str
    role: str
    state: str
    shard: str = ''
    updated_at: str = ''


@dataclass(frozen=True)
class BoardState:
    """What the run recorded for its flow's steps."""

    tasks: tuple[StepTask, ...] = ()
    #: A map's shards, as the run coordinator listed them (``fan_out``).
    fanned_out: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    #: The steps the run coordinator recorded done itself (its own agent steps, a closed board).
    completed: frozenset[str] = frozenset()
    #: A person's decisions on each step (each Resume at its decision point).
    decisions: Mapping[str, int] = field(default_factory=dict)
    #: The run's task cap is reached (a board ``until: caps`` closes only then).
    cap_reached: bool = False
    #: Each quality gate step's verdict, as the GO ledger reads it (``go``, ``no_go``; ``unread`` where the reader
    #: cannot read the gate records: never a GO).
    verdicts: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class StepState:
    step: str
    type: str
    status: str
    reason: str = ''
    #: The roles it takes tasks for now (none: the run coordinator does it itself, or it takes none).
    roles: tuple[str, ...] = ()
    #: A step after a map: the shards with no task under way or done yet.
    shards_left: tuple[str, ...] = ()
    #: A quality gate's: ``go`` or ``no_go``.
    verdict: str = ''
    #: The tasks posted for it so far (a board's: an empty board closes only when an agent other than the coordinator
    #: was to post on it).
    task_count: int = 0


@dataclass(frozen=True)
class _Tally:
    done: bool
    live: bool
    failures: int


def _tally(tasks: Sequence[StepTask]) -> _Tally:
    return _Tally(done=any(task.state == TASK_DONE for task in tasks),
                  live=any(task.state not in TASK_ENDED for task in tasks),
                  failures=sum(task.state in TASK_ENDED and task.state != TASK_DONE for task in tasks))


Refusal = tuple[str, str]


@dataclass(frozen=True)
class Plan:
    """Every step's state, in the flow's order, and where the run stands: ``running``, ``needs_human`` at ``at``, or
    ``finished`` at ``at`` (the end it reached)."""

    flow: Flow
    steps: Mapping[str, StepState]
    outcome: str
    at: str = ''
    reason: str = ''
    #: The run's task cap is reached (a board ``until: caps`` closes only then).
    cap_reached: bool = False
    #: The gates' verdicts it was given (``BoardState.verdicts``), whether or not their turn has come.
    verdicts: Mapping[str, str] = field(default_factory=dict)

    def live(self) -> list[StepState]:
        return [state for state in self.steps.values() if state.status in LIVE]

    def not_yet_run(self) -> list[StepState]:
        return [state for state in self.steps.values() if state.status == NOT_YET_RUN]

    @property
    def decision_point(self) -> str:
        """The run's decision point while the flow waits at a person (``flow:<step>``), else ''."""
        return f'{DECISION_PREFIX}{self.at}' if self.outcome == AT_A_PERSON else ''

    def lit(self) -> dict[str, str]:
        """Each step's status, for the run monitor's flow (its steps lit)."""
        return {step: state.status for step, state in self.steps.items()}

    def post_refusal(self, step: str, role: str, *, poster: str, shard: str = '') -> Refusal | None:
        """Why a task for ``role`` may not be posted for ``step`` now (``(kind, message)``), or None. ``poster``: the
        posting agent's role, ``coordinator`` for the run coordinator and a person (who post for any role a live step
        takes)."""
        state = self.steps.get(step)
        if state is None:
            return 'invalid', f'the run\'s flow has no step {step!r}'
        flow_step = self.flow.steps[step]
        per_shard = flow_step.type == 'agent' and step in self.flow.region
        poster_allowed = poster == COORDINATOR or (flow_step.type == 'board'
                                                   and poster in (flow_step.params.get('posters') or ()))
        takes = ', '.join(state.roles) or 'none: the run coordinator does it itself'
        left = ', '.join(state.shards_left[:5]) or 'none'
        # (the first that holds is the refusal, in this order)
        checks: tuple[tuple[bool, Refusal], ...] = (
            (state.status not in LIVE,
             ('conflict', f'step {step} is {state.status}: only a ready step takes tasks (read the flow)')),
            (role not in state.roles, ('forbidden', f'step {step} takes tasks for {takes}, not for {role}')),
            (not poster_allowed, ('forbidden', f'a {poster} posts only on a board step that names it a poster')),
            (per_shard and shard not in state.shards_left,
             ('conflict', f'step {step} takes one task per shard of its map: name a shard left ({left})')),
            (bool(shard) and not per_shard, ('invalid', f'only a step after a map takes a shard, not {step}')),
            (flow_step.type == 'agent' and not per_shard and state.status == RUNNING,
             ('conflict', f'step {step} has its task under way')),
        )
        return next((refusal for holds, refusal in checks if holds), None)

    def launch_refusal(self, step: str) -> str | None:
        state = self.steps.get(step)
        if state is None:
            return f'the run\'s flow has no step {step!r}'
        if state.status not in LIVE:
            return f'step {step} is {state.status}: agents are launched only for a ready step (read the flow)'
        return None

    def complete_refusal(self, step: str) -> str | None:
        """Why the run coordinator may not record ``step`` done now: only its own agent step, or a board it closes
        with nothing under way (``until: caps``, only at the run's task cap)."""
        state, flow_step = self.steps.get(step), self.flow.steps.get(step)
        if state is None or flow_step is None:
            return f'the run\'s flow has no step {step!r}'
        board = flow_step.type == 'board'
        own = flow_step.type == 'agent' and flow_step.params.get('role') == COORDINATOR
        # (an empty board's work was the coordinator's to post when it is the board's only poster)
        others_post = bool(set(flow_step.params.get('posters') or ()) - {COORDINATOR})
        checks: tuple[tuple[bool, str], ...] = (
            (not (own or board), f'step {step} is not one the run coordinator records done: its tasks do'),
            (state.status != READY, f'step {step} is {state.status}: a board closes only once its turn has come and '
                                    'nothing on it is under way' if board else f'step {step} is {state.status}, not ready'),
            (board and flow_step.params.get('until') == 'caps' and not self.cap_reached,
             f'board {step} runs until the run\'s caps: it closes only at the run\'s task cap'),
            (board and not state.task_count and not others_post,
             f'board {step} has no task yet, and only you post on it: post its work before you close it'),
        )
        return next((refusal for holds, refusal in checks if holds), None)

    def fan_out_refusal(self, step: str, shards: Sequence[str]) -> str | None:
        state, flow_step = self.steps.get(step), self.flow.steps.get(step)
        if state is None or flow_step is None or flow_step.type != 'map':
            return f'{step!r} is not a map step of the run\'s flow'
        if state.status != READY:
            return f'map {step} is {state.status}: its shards are listed once, when its turn comes'
        cap = flow_step.params.get('shard_cap', 200)
        if not 0 < len(shards) <= cap or len(set(shards)) != len(shards):
            return f'map {step} takes 1 to {cap} shards, each once'
        return None

    def view(self) -> dict[str, Any]:
        """The plan as the run coordinator reads it (as data): the outcome, then every step, the live ones with their
        settings and what to do at them."""
        steps = []
        for step_id, state in self.steps.items():
            flow_step = self.flow.steps[step_id]
            item: dict[str, Any] = {'step': step_id, 'type': state.type, 'title': flow_step.title,
                                    'status': state.status}
            if state.reason:
                item['reason'] = state.reason
            if state.verdict:
                item['verdict'] = state.verdict
            if state.status in LIVE:
                item.update(roles=list(state.roles), settings=dict(flow_step.params), next=self._next(flow_step))
                if flow_step.instructions:
                    item['instructions'] = flow_step.instructions
                if step_id in self.flow.region and flow_step.type == 'agent':
                    item['shards_left'] = list(state.shards_left)
            steps.append(item)
        return {'outcome': self.outcome, 'at': self.at or None, 'reason': self.reason or None, 'steps': steps}

    def _next(self, step: Step) -> str:
        if step.type == 'agent' and step.params.get('role') == COORDINATOR:
            return NEXT['coordinator']
        if step.type == 'agent' and step.id in self.flow.region:
            return NEXT['shards']
        return NEXT.get(step.type, '')


class _Conductor:
    def __init__(self, flow: Flow, board: BoardState) -> None:
        self.flow = flow
        self.board = board
        self.states: dict[str, StepState] = {}
        self.tasks: dict[str, list[StepTask]] = {}
        for task in board.tasks:
            self.tasks.setdefault(task.step, []).append(task)

    def _decided(self, step: str) -> int:
        return max(0, int(self.board.decisions.get(step, 0)))

    def _state(self, step: Step, status: str, **more: Any) -> StepState:
        return StepState(step=step.id, type=step.type, status=status, task_count=len(self.tasks.get(step.id, ())),
                         **more)

    def run(self) -> dict[str, StepState]:
        for step_id in self.flow.order:
            step = self.flow.steps[step_id]
            self.states[step_id] = self._evaluate(step)
        return self.states

    def _ways_in(self, step: Step) -> tuple[list[str], int]:
        """The steps before ``step`` still under way (pending), and how many ways into it the flow took (a skipped
        step's way, and a quality gate's arrow its verdict did not take, are not taken)."""
        pending: list[str] = []
        taken = 0
        for arrow in self.flow.into(step.id):
            before = self.states[arrow.source]
            if before.status in COMPLETE:
                gate = self.flow.steps[arrow.source].type == 'quality_gate'
                taken += not gate or arrow.label == ('pass' if before.verdict == GO else 'fail')
            elif before.status != SKIPPED:
                pending.append(arrow.source)
        return pending, taken

    def _evaluate(self, step: Step) -> StepState:
        if step.type == 'start':
            return self._state(step, DONE)
        pending, taken = self._ways_in(step)
        if pending:
            if step.type == 'board' and self._collecting(step, pending):
                return self._state(step, COLLECTING, roles=self._claimers(step))
            return self._state(step, WAITING)
        if not taken:
            return self._state(step, SKIPPED)
        return self._reached(step)

    @staticmethod
    def _claimers(step: Step) -> tuple[str, ...]:
        return tuple(str(role) for role in step.params.get('claimers') or ())

    def _collecting(self, step: Step, pending: Sequence[str]) -> bool:
        """A board takes posts before its turn while each step still under way before it is an agent of one of its
        posters, at work (the hunter posts the fixes as it finds the bugs)."""
        posters = set(step.params.get('posters') or ())
        return all(self.flow.steps[before].type == 'agent' and self.flow.steps[before].params.get('role') in posters
                   and self.states[before].status in LIVE for before in pending)

    def _reached(self, step: Step) -> StepState:
        """A step whose turn has come, by its kind."""
        kinds: dict[str, Callable[[Step], StepState]] = {
            'end': self._end, 'agent': self._agent, 'map': self._map, 'board': self._board, 'quality_gate': self._gate,
            NODE_STOP_AT_PR: lambda s: self._state(s, DONE, reason='the flow ends at the draft pull request'),
            'reduce': lambda s: self._state(s, DONE),
            'self_improvement': lambda s: self._passed_or(s, SELF_IMPROVEMENT_STOP),
            **{kind: lambda s: self._state(s, NOT_YET_RUN, reason=NOT_RUN[s.type]) for kind in NOT_RUN},
        }
        unknown = f'the runtime does not run {step.type or "this kind of"} step'
        return kinds.get(step.type, lambda s: self._passed_or(s, unknown))(step)

    def _end(self, step: Step) -> StepState:
        if step.params.get('status') != 'needs_human':
            return self._state(step, DONE)
        if self._decided(step.id):
            return self._state(step, PASSED, reason='a person decided')
        return self._state(step, HUMAN, reason=f'the flow reached the decision point {step.title or step.id}')

    def _passed_or(self, step: Step, reason: str) -> StepState:
        """A step the flow cannot go on without: stopped at a person, passed once one decides."""
        if self._decided(step.id):
            return self._state(step, PASSED, reason=f'a person went on without it ({reason.partition(":")[0]})')
        return self._state(step, STOPPED, reason=reason)

    def _agent(self, step: Step) -> StepState:
        role = str(step.params.get('role', ''))
        if role == COORDINATOR:
            return self._state(step, DONE if step.id in self.board.completed else READY)
        if step.id in self.flow.region:
            return self._shards(step, role, self.flow.region[step.id])
        tally = _tally(self.tasks.get(step.id, ()))
        if tally.done:
            return self._state(step, DONE)
        if tally.live:
            return self._state(step, RUNNING, roles=(role,))
        if tally.failures > self._decided(step.id):
            return self._state(step, BLOCKED, reason=f'its {role} task ended without being done: a person decides')
        return self._state(step, READY, roles=(role,))

    def _shards(self, step: Step, role: str, map_id: str) -> StepState:
        shards = self.board.fanned_out.get(map_id, ())
        if not shards:   # (its map was passed by a person without shards)
            return self._state(step, NOT_YET_RUN, reason=f'its map {map_id} did not run')
        mine = self.tasks.get(step.id, [])
        left: list[str] = []
        live = False
        for shard in shards:
            tally = _tally([task for task in mine if task.shard == shard])
            if tally.done:
                continue
            if tally.live:
                live = True
            elif tally.failures > self._decided(step.id):
                return self._state(step, BLOCKED,
                                   reason=f'its {role} task for {shard} ended without being done: a person decides')
            else:
                left.append(shard)
        if not left and not live:
            return self._state(step, DONE)
        return self._state(step, RUNNING if live else READY, roles=(role,) if left else (), shards_left=tuple(left))

    def _map(self, step: Step) -> StepState:
        if step.id in self.board.fanned_out:
            return self._state(step, DONE)
        shard_by = str(step.params.get('shard_by', ''))
        if shard_by in SHARD_SOURCES:
            return self._state(step, READY)
        return self._passed_or(step, f'no shard source for {shard_by or "this map"} yet (the runtime lists only a '
                                     "repository's packages): a person decides")

    def _board(self, step: Step) -> StepState:
        tally = _tally(self.tasks.get(step.id, ()))
        claimers = self._claimers(step)
        if tally.live:
            return self._state(step, RUNNING, roles=claimers)
        if tally.failures > self._decided(step.id):
            return self._state(step, BLOCKED, reason='a task on the board ended without being done: a person decides')
        if step.id in self.board.completed:
            return self._state(step, DONE)
        return self._state(step, READY, roles=claimers)

    def _gate(self, step: Step) -> StepState:
        """Its verdict is the GO ledger's (``BoardState.verdicts``): only a final go that ended done with a GO record
        takes the ``pass`` arrow; one whose record cannot be read here waits (never a GO on a guess)."""
        tasks = self.tasks.get(step.id, [])
        if any(task.role == FINAL_GO_ROLE and task.state in TASK_ENDED for task in tasks):
            verdict = self.board.verdicts.get(step.id, UNREAD)
            if verdict == GO:
                return self._state(step, DONE, verdict=GO)
            if verdict == NO_GO:
                return self._state(step, DONE, verdict=NO_GO,
                                   reason='the final go answered NO-GO: its fail arrow goes to a person')
            return self._state(step, RUNNING, reason='its final go ended: its gate record is read where the GO ledger '
                                                     'is (the board)')
        # The final go only once a gate runner's task is done: it judges a gated change, never none.
        gated = any(task.role == GATE_RUNNER and task.state == TASK_DONE for task in tasks)
        roles = GATE_ROLES if gated else tuple(role for role in GATE_ROLES if role != FINAL_GO_ROLE)
        tally = _tally(tasks)
        if tally.live:
            return self._state(step, RUNNING, roles=roles)
        if tally.failures > self._decided(step.id):
            return self._state(step, BLOCKED, reason='a task of the gate ended without being done: a person decides')
        return self._state(step, READY, roles=roles)


def conduct(flow: Flow, board: BoardState) -> Plan:
    """The plan: every step's state, and where the run stands."""
    states = _Conductor(flow, board).run()
    ordered = {step: states[step] for step in flow.order}
    halted = [state for state in ordered.values() if state.status in HALTED]
    live = [state for state in ordered.values() if state.status in LIVE]
    ends = [state for state in ordered.values()
            if flow.steps[state.step].type in TERMINALS and state.status in COMPLETE]
    if halted:
        outcome, at, reason = AT_A_PERSON, halted[0].step, halted[0].reason
    elif live:
        outcome, at, reason = GOING, '', ''
    elif ends:
        outcome, at, reason = FINISHED, ends[0].step, ends[0].reason or 'the flow reached its end'
    else:   # (nothing live and no end reached: never for a flow the server validated)
        outcome, at, reason = AT_A_PERSON, '', 'the flow cannot go on: no step is ready'
    return Plan(flow=flow, steps=ordered, outcome=outcome, at=at, reason=reason, cap_reached=board.cap_reached,
                verdicts=dict(board.verdicts))
