"""An ended run's retrospective, from what the platform records today. Pure: the record in, the retrospective out.

What it reads (``records.RunRecord``, built by ``records.RunRecordReader`` from the run's own rows and objects):

- the board's tasks and their history (``TASK#``, ``TASKLOG#``): each task's attempts, who held each one (its
  ``claim`` move, else its ``launch``), how each ended (the task's final state for its last attempt; a re-post by
  the supervisor, ``stalled`` or a lost lease as a time-out and ``crashed`` as a crash, or a person's release, for
  an earlier one) and how often it went to review (its ``in_review`` moves);
- the quality gate's records (``_gate/…/record.json`` named on the final-go tasks): a NO-GO (the verdict, or the
  final go's) is a failure of the task the gate judged (the final-go task's parent), and the gate's rounds are
  review rounds of that task's attempt;
- the agents' session rows (``AGENT#``): each agent's role and skill version, its session seconds and cost, its
  crashes and the last failure the supervisor recorded (the run monitor's inspection data);
- the run's ``META``: its connection, status and times.

What it cannot read yet: people's reactions on the host (review comments on the agents' pull requests, edits after a
merge, reverted commits), since the broker reads no host data. They come in through ``HostReactions``, a port that
answers nothing today (``no_host_reactions``), and become the comments of a failure's evidence once it does.

What it gives:

- ``failures``: one per task attempt that ended failed, timed out, crashed or got a NO-GO, most severe first
  (NO-GO, failed, crashed, timed out; then the task's priority, id and attempt); ``to_coach``, the first of them
  per role and failure kind (the coach proposes once per run, role and kind: ``SkillStore``'s ``RUN#`` row), at most
  ``MAX_COACHED``, each with its evidence bounded and redacted (``evidence``);
- ``scorecards``: a line per role and skill version: tasks done, failed and needing a person (by the agent of each
  task's last attempt), re-posts and review rounds (by the agent of the attempt), attempts, and the cost and session
  seconds of that version's agents.

A person's own attempt (a task taken by ``human:…``) is nobody's skill: it is left out of both. An agent's attempt a
person took over (``take``) ends, for the agent, at the take: handed over, neither a failure nor a task done, failed
or needing a person, and the gate's verdict on the person's work is not the agent's.
"""
from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from decimal import Decimal
from typing import Final, Literal

from engineering.board.model import DONE, FAILED, IN_REVIEW, NEEDS_HUMAN, PERSON_PREFIX, Move, Task
from engineering.board.store import REPOST_OP
from engineering.coach.failure import MAX_ATTEMPT, Evidence
from engineering.quality_gate.text import redact
from engineering.runtime.runs import SUPERVISOR

#: The failures the coach is asked about per run (one Converse call each).
MAX_COACHED: Final = 3
#: The failures a retrospective lists (its counts cover all of them).
MAX_LISTED: Final = 50
#: Each piece of a failure's evidence, cut to fit (the coach's own bounds are larger: the caller chooses what to keep).
TASK_CHARS: Final = 2_000
OUTPUT_CHARS: Final = 2_000
COMMENT_CHARS: Final = 1_000
MAX_MOVE_LINES: Final = 30
MAX_COMMENTS: Final = 12
#: A skill version as a session row names it (``runtime/harness/skills.skill_label``: ``<role>@<version>``).
VERSION_LABEL: Final = re.compile(r'[a-z0-9][a-z0-9-]{0,62}@[0-9]{1,6}\Z')
#: The label of an agent whose row names no skill version (a role with no skill yet), and of one off that shape.
NO_VERSION: Final = 'none'
OFF_SHAPE_VERSION: Final = 'unlabelled'

Ending = Literal['done', 'failed', 'needs_human', 'timed_out', 'crashed', 'released', 'unfinished']
FailureHow = Literal['no_go', 'failed', 'crashed', 'timed_out']
#: Most severe first.
SEVERITY: Final[Mapping[FailureHow, int]] = {'no_go': 0, 'failed': 1, 'crashed': 2, 'timed_out': 3}
#: The coach's failure kind (``skills.model.FAILURE_KINDS``) of each way an attempt fails.
COACH_KIND: Final[Mapping[FailureHow, str]] = {'no_go': 'no_go', 'failed': 'error', 'crashed': 'error',
                                               'timed_out': 'timeout'}
#: What the supervisor's re-post reason says about the attempt it ended (supervisor.py), and who it is on the board.
CRASHED_REASON: Final = 'crashed'
#: A person's take-over of a task (board/store.py ``take``): the agent's part of the attempt ends there.
TAKE_OP: Final = 'take'
#: A session the supervisor ended as failed (it kept crashing: runtime/sessions.py).
FAILED_SESSION: Final = 'failed'


@dataclass(frozen=True)
class AgentRecord:
    """One agent of the run, as its session row records it."""

    agent: str
    role: str
    skill_version: str
    microvm_seconds: int
    cost_usd: Decimal
    crashes: int = 0
    #: The session's status (``failed``: it kept crashing).
    status: str = ''
    #: The supervisor's last word on why it failed (``last_failure``, the last exit's code and tails), redacted.
    last_failure: str = ''


@dataclass(frozen=True)
class GateVerdict:
    """A final-go task's gate record, as far as the retrospective reads it."""

    task_id: str
    attempt: int
    verdict: str
    no_go: bool
    rounds: int
    #: The final go's reasons, then the open blocking findings' titles.
    reasons: tuple[str, ...] = ()


@dataclass(frozen=True)
class RunRecord:
    ws: str
    run_id: str
    connection: str
    status: str
    started_at: str
    ended_at: str
    tasks: tuple[Task, ...]
    history: Mapping[str, Sequence[Move]]
    agents: tuple[AgentRecord, ...]
    gates: tuple[GateVerdict, ...] = ()


@dataclass(frozen=True)
class HostReaction:
    """A person's reaction on the host to an agent's work on a task: a review comment, an edit after the merge, a
    revert (none is readable yet: the broker reads no host data)."""

    task_id: str
    kind: Literal['comment', 'edit_after_merge', 'revert']
    text: str


#: The port people's reactions come in through: the run's record in, its reactions out.
type HostReactions = Callable[[RunRecord], Sequence[HostReaction]]


def no_host_reactions(_run: RunRecord) -> tuple[HostReaction, ...]:
    """What the host's reactions are today: none (the broker reads no host data yet)."""
    return ()


@dataclass(frozen=True)
class Attempt:
    task: Task
    attempt: int
    #: Who held it (``''``: nobody claimed it), and that agent's role and skill version label.
    agent: str
    role: str
    version: str
    ending: Ending
    reason: str
    review_rounds: int
    moves: tuple[Move, ...]


@dataclass(frozen=True)
class FailedAttempt:
    attempt: Attempt
    how: FailureHow
    #: The gate's verdict, for a NO-GO.
    gate: GateVerdict | None = None

    @property
    def kind(self) -> str:
        return COACH_KIND[self.how]

    @property
    def key(self) -> str:
        """``<task>#<attempt>#<how>``: the failure, as a learning step names it."""
        return f'{self.attempt.task.task_id}#{self.attempt.attempt}#{self.how}'

    def order(self) -> tuple[int, int, str, int]:
        return (SEVERITY[self.how], -self.attempt.task.priority, self.attempt.task.task_id, self.attempt.attempt)


@dataclass(frozen=True)
class ScoreLine:
    """One skill version's part of one run."""

    role: str
    version: str
    tasks_done: int = 0
    tasks_failed: int = 0
    needs_human: int = 0
    reposts: int = 0
    review_rounds: int = 0
    attempts: int = 0
    cost_usd: Decimal = Decimal(0)
    seconds: int = 0


@dataclass(frozen=True)
class Retrospective:
    run: RunRecord
    failures: tuple[FailedAttempt, ...]
    #: How many failures there were in all (``failures`` lists at most ``MAX_LISTED``).
    failure_count: int
    to_coach: tuple[FailedAttempt, ...]
    scorecards: tuple[ScoreLine, ...]
    #: NO-GOs of a final-go task with no parent task: no attempt to charge them to.
    unattributed_no_go: int = 0
    reactions: tuple[HostReaction, ...] = field(default_factory=tuple)


def version_label(raw: str) -> str:
    """The scorecard's label of a skill version: ``<role>@<n>``, ``none`` for none, ``unlabelled`` for one off it."""
    if not raw:
        return NO_VERSION
    return raw if VERSION_LABEL.fullmatch(raw) else OFF_SHAPE_VERSION


def _agent_of(moves: Sequence[Move]) -> str:
    """The agent that held the attempt: its claim's, else its launch's (a launch never claimed), else ''."""
    for move in moves:
        if move.op == 'claim':
            return move.actor
    for move in moves:
        if move.op == 'launch' and move.reason.startswith('launched '):
            return move.reason.removeprefix('launched ')
    return ''


def _ending_of(task: Task, attempt: int, ender: Move | None, agent: AgentRecord | None) -> tuple[Ending, str]:
    """How an attempt ended: the move that opened the next one, else the task's state. A supervisor's re-post is a
    crash (``crashed``) or a time-out (any other reason); a re-post by anyone else (a person's Resume replacing a
    coordinator whose session failed) is a crash when the agent's session failed, else no failure, as a person's
    release is."""
    if ender is not None:
        if ender.op == REPOST_OP and ender.actor == SUPERVISOR:
            return ('crashed' if ender.reason == CRASHED_REASON else 'timed_out'), ender.reason
        if ender.op == REPOST_OP and agent is not None and agent.status == FAILED_SESSION:
            return 'crashed', ender.reason
        return 'released', ender.reason
    if attempt < task.attempt:
        return 'unfinished', ''
    endings: Mapping[str, Ending] = {DONE: 'done', FAILED: 'failed', NEEDS_HUMAN: 'needs_human'}
    return endings.get(task.state, 'unfinished'), task.step


def _gates_by_judged(run: RunRecord) -> tuple[dict[str, GateVerdict], int]:
    """The latest gate verdict of each final-go task, by the task it judged (its parent); and how many NO-GOs had
    no parent to charge them to."""
    by_id = {task.task_id: task for task in run.tasks}
    latest: dict[str, GateVerdict] = {}
    for gate in run.gates:
        if gate.task_id not in latest or gate.attempt >= latest[gate.task_id].attempt:
            latest[gate.task_id] = gate
    judged: dict[str, GateVerdict] = {}
    unattributed = 0
    for gate in latest.values():
        parent = by_id[gate.task_id].parent_task if gate.task_id in by_id else ''
        if parent and parent in by_id:
            judged[parent] = gate
        elif gate.no_go:
            unattributed += 1
    return judged, unattributed


def _attempts(run: RunRecord) -> tuple[list[Attempt], dict[str, GateVerdict], int]:
    """Every agent attempt of every task, oldest first per task; the gate verdicts by judged task; the NO-GOs
    nobody's attempt carries."""
    agents = {agent.agent: agent for agent in run.agents}
    judged, unattributed = _gates_by_judged(run)
    found: list[Attempt] = []
    for task in run.tasks:
        moves = tuple(run.history.get(task.task_id, ()))
        for number in range(1, max(task.attempt, 1) + 1):
            own = tuple(move for move in moves if move.attempt == number and move.op not in (REPOST_OP, 'release'))
            ender = next((move for move in moves if move.attempt == number + 1 and move.op in (REPOST_OP, 'release')),
                         None)
            agent = _agent_of(own)
            if not agent or agent.startswith(PERSON_PREFIX):
                continue   # never claimed nor launched, or a person's own: nobody's skill
            record = agents.get(agent)
            taken = next((i for i, move in enumerate(own) if move.op == TAKE_OP
                          and move.actor.startswith(PERSON_PREFIX)), None)
            if taken is not None:
                # A person took the task over: the agent's part ends there, handed over (no failure, no tally), and
                # whatever came after (the person's own moves, the gate's verdict on their work) is nobody's skill.
                own = own[:taken]
                ending, reason = 'released', 'taken over by a person'
            else:
                ending, reason = _ending_of(task, number, ender, record)
            rounds = sum(move.state == IN_REVIEW for move in own)
            gate = judged.get(task.task_id)
            if gate is not None and number == task.attempt and taken is None:
                rounds += gate.rounds
            found.append(Attempt(task=task, attempt=number, agent=agent, role=record.role if record else task.role,
                                 version=version_label(record.skill_version if record else ''), ending=ending,
                                 reason=reason, review_rounds=rounds, moves=own))
    return found, judged, unattributed


def _failures(attempts: Sequence[Attempt], judged: Mapping[str, GateVerdict]) -> list[FailedAttempt]:
    failed: list[FailedAttempt] = []
    hows: Mapping[Ending, FailureHow] = {'failed': 'failed', 'crashed': 'crashed', 'timed_out': 'timed_out'}
    for attempt in attempts:
        how = hows.get(attempt.ending)
        if how is not None:
            failed.append(FailedAttempt(attempt, how))
        gate = judged.get(attempt.task.task_id)
        if (gate is not None and gate.no_go and attempt.attempt == attempt.task.attempt
                and attempt.ending != 'released'):
            failed.append(FailedAttempt(attempt, 'no_go', gate))
    return sorted(failed, key=FailedAttempt.order)


def _to_coach(failures: Sequence[FailedAttempt]) -> tuple[FailedAttempt, ...]:
    """The first failure per role and coach kind, at most ``MAX_COACHED`` (the coach never coaches itself)."""
    chosen: list[FailedAttempt] = []
    seen: set[tuple[str, str]] = set()
    for failure in failures:
        key = (failure.attempt.role, failure.kind)
        if failure.attempt.role == 'coach' or key in seen:
            continue
        seen.add(key)
        chosen.append(failure)
        if len(chosen) == MAX_COACHED:
            break
    return tuple(chosen)


def _tally(line: ScoreLine, attempt: Attempt) -> ScoreLine:
    """``line`` with ``attempt`` counted: its review rounds, a re-post, and its task's end when it was the last."""
    last = attempt.attempt == attempt.task.attempt
    return replace(
        line, attempts=line.attempts + 1, review_rounds=line.review_rounds + attempt.review_rounds,
        reposts=line.reposts + (attempt.ending in ('crashed', 'timed_out')),
        tasks_done=line.tasks_done + (last and attempt.ending == 'done'),
        tasks_failed=line.tasks_failed + (last and attempt.ending == 'failed'),
        needs_human=line.needs_human + (last and attempt.ending == 'needs_human'))


def _scorecards(run: RunRecord, attempts: Sequence[Attempt]) -> tuple[ScoreLine, ...]:
    lines: dict[tuple[str, str], ScoreLine] = {}
    for attempt in attempts:
        key = (attempt.role, attempt.version)
        lines[key] = _tally(lines.get(key, ScoreLine(*key)), attempt)
    for agent in run.agents:
        key = (agent.role, version_label(agent.skill_version))
        line = lines.get(key, ScoreLine(*key))
        lines[key] = replace(line, cost_usd=line.cost_usd + agent.cost_usd, seconds=line.seconds + agent.microvm_seconds)
    return tuple(lines[key] for key in sorted(lines))


def build_retrospective(run: RunRecord, reactions: HostReactions = no_host_reactions) -> Retrospective:
    attempts, judged, unattributed = _attempts(run)
    failures = _failures(attempts, judged)
    return Retrospective(run=run, failures=tuple(failures[:MAX_LISTED]), failure_count=len(failures),
                         to_coach=_to_coach(failures), scorecards=_scorecards(run, attempts),
                         unattributed_no_go=unattributed, reactions=tuple(reactions(run)))


# ── evidence ─────────────────────────────────────────────────────────────────────────────────────────────────────
def fit(text: str, limit: int) -> str:
    """``text`` with its credential-shaped strings replaced, cut to ``limit`` characters (marked when cut)."""
    clean = redact(text).replace('\x00', '')
    if len(clean) <= limit:
        return clean
    marker = ' [cut]'
    return clean[:limit - len(marker)] + marker


def _move_line(move: Move) -> str:
    why = f' ({move.reason})' if move.reason else ''
    return f'{move.at} {move.state} by {move.actor} via {move.op}{why}'


def _gate_text(gate: GateVerdict) -> str:
    lines = [f'Quality gate: {gate.verdict}, {gate.rounds} round(s).', *gate.reasons]
    return '\n'.join(lines)


def evidence(failure: FailedAttempt, run: RunRecord, reactions: Sequence[HostReaction] = ()) -> Evidence:
    """What the coach reads about the failure: the task, how the attempt ended and its moves, the agent's last
    failure, the gate's verdict for a NO-GO, and people's reactions to the task (none yet). Each piece is cut to fit
    and redacted; the coach's ``Evidence`` checks and redacts it again."""
    attempt = failure.attempt
    task = attempt.task
    spec = task.spec or '{}'
    outputs = [fit(f'Attempt {attempt.attempt} of the {attempt.role} task ended {attempt.ending}'
                   + (f' ({attempt.reason})' if attempt.reason else '') + f'; held by {attempt.agent}.',
                   OUTPUT_CHARS)]
    if attempt.moves:
        outputs.append(fit('\n'.join(_move_line(move) for move in attempt.moves[-MAX_MOVE_LINES:]), OUTPUT_CHARS))
    agent = next((agent for agent in run.agents if agent.agent == attempt.agent), None)
    if agent is not None and agent.last_failure:
        outputs.append(fit(f'The supervisor recorded ({agent.crashes} crash(es)): {agent.last_failure}',
                           OUTPUT_CHARS))
    if failure.gate is not None:
        outputs.append(fit(_gate_text(failure.gate), OUTPUT_CHARS))
    comments = tuple(fit(f'{reaction.kind}: {reaction.text}', COMMENT_CHARS) for reaction in reactions
                     if reaction.task_id == task.task_id)[:MAX_COMMENTS]
    return Evidence(task=fit(f'{task.title}\n\n{spec}', TASK_CHARS), outputs=tuple(outputs), comments=comments)


def coach_attempt(attempt: int) -> int:
    """The attempt as the coach's failure takes it (0 to ``MAX_ATTEMPT``)."""
    return min(attempt, MAX_ATTEMPT)
