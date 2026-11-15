"""The learning loop: an ended run's retrospective, written down, and its failures taken to the coach and to memory.

Two steps, each its own invocation of voc-engineering-runtime (``runtime/handler.py``'s ``retrospective`` action),
so no model call ever runs inside a run's end:

1. ``LearningLoop.retrospective(ws, run_id)`` (handed on once the ended run has no live agent): reads the run's
   record (``records.py``), builds its retrospective (``retrospective.py``), writes a scorecard row per skill
   version (``scorecard.py``, create-only) and the failures it takes to the coach (at most ``MAX_COACHED``, the
   first per role and failure kind), each by its key (``<task>#<attempt>#<how>``), once, in a create-only
   ``RETRO#coach`` row of the run's partition: a later retrospective of the same run reads that row back, so the
   bound of three per run holds whatever runs twice. It answers the keys for the caller to hand one by one to step
   2. A run that has not ended, or one with no connection (it launched no agent), is left alone.
2. ``LearningLoop.learn_from(ws, run_id, key)``: the same retrospective read again (the run has ended: its record
   no longer moves), the failure with that key (one the ``RETRO#coach`` row names, else refused), then:

   - its claim, a create-only ``LEARN#<key>`` row in the run's partition (who: the retrospective; when): a second
     invocation for the same failure (a duplicate asynchronous delivery, a second start) finds it and stops before
     anything else is written or asked, so each failure gets one lesson and costs at most one Converse call, ever;
   - one lesson draft in agent memory at the failed role's scope for the run's connection
     (``AgentMemoryStore.learn_agent_memory``: always a draft, for an administrator to approve), learned by the
     run's coach (``coach-<run>``, an agent of the run's connection) with the run and the task as its provenance: a
     line made by rule for the way the attempt failed, with no model or task text, so the same lesson from another
     run confirms it rather than adding one. It is written before the coach's call, so the call's outcome never
     takes it away. The coach's why is not drafted: the proposed version's reason holds it, and model-written
     drafts must not fill a role's scope (``MAX_PER_SCOPE``) ahead of an administrator's own memories;
   - the coach (``Coach.propose_for``: its own guard, once per run, role and failure kind, the ``RUN#`` row; a role
     with no skill yet, a refused answer or a guard already spent is an outcome, not an error), with the
     deployment's benchmark case ids; skipped when the deployment names none. The call is bounded to end well
     inside this invocation's limit (``coach/model.py``: a 200 s read timeout, one attempt, an 8,000-token cap);
     one that runs past its timeout or fails is recorded as ``timed_out`` or ``failed`` and not retried;
   - what came of it, a create-only ``LEARNED#<key>`` row beside the claim (the proposed version, the memory, or
     why not: D1, D4).

The coach's ``skill.proposed`` announcement is returned in the outcome, not published: voc-engineering-runtime's
role speaks on the bus only as the supervisor, and the announcement is the coach's (planned with the bus's coach
publisher; the proposal itself is in the skills store's history meanwhile).
"""
from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, Final

from botocore.exceptions import ClientError, ReadTimeoutError

from engineering.agent_memory.model import (
    MAX_STATEMENT,
    AgentMemoryError,
    MemoryInput,
    Provenance,
    RunContext,
    Scope,
)
from engineering.agent_memory.store import AgentMemoryStore
from engineering.coach.failure import CoachError, Failure
from engineering.coach.model import READ_TIMEOUT_SECONDS
from engineering.coach.proposer import Coach, coach_actor
from engineering.learning.records import RunRecordReader
from engineering.learning.retrospective import (
    FailedAttempt,
    HostReactions,
    Retrospective,
    build_retrospective,
    coach_attempt,
    evidence,
    no_host_reactions,
)
from engineering.learning.scorecard import WRITER, ScorecardError, ScorecardStore
from engineering.rows import get_row, run_pk
from engineering.runtime.runs import ENDED
from engineering.skills.model import SkillError
from shared.aws import is_conditional_check_failure
from shared.logging import logger

#: How a coach's call that ended in error is recorded (the ``LEARNED#`` row's ``coach``, first word): it ran past
#: its read timeout, or it failed otherwise. Neither is retried.
COACH_TIMED_OUT: Final = 'timed_out'
COACH_FAILED: Final = 'failed'
#: The run's row naming the failures its retrospective takes to the coach, written once.
CHOSEN_SK: Final = 'RETRO#coach'
#: A learned lesson's confidence: the memory layer's floor for an automated write (it is a draft either way).
LESSON_CONFIDENCE: Final = 0.8
#: What a rule-made lesson says, per way an attempt failed (no model text, no task text: a run repeating it confirms
#: the same memory instead of adding one).
RULE_LESSONS: Final = {
    'no_go': 'A {role} change got a NO-GO from the quality gate before it reached a pull request.',
    'failed': 'A {role} attempt ended failed on its task.',
    'crashed': 'A {role} attempt crashed and the supervisor re-posted its task.',
    'timed_out': 'A {role} attempt stopped answering or let its lease run out, and its task was re-posted.',
}


@dataclass(frozen=True)
class Summary:
    """What a retrospective did: the scorecard rows written (and those written already), and the failures."""

    run_id: str
    scorecards_written: int
    scorecards_kept: int
    failure_count: int
    to_coach: tuple[str, ...]
    skipped: str = ''


@dataclass(frozen=True)
class Learned:
    """What came of one failure: the version the coach proposed (or why not), the lesson drafted (or why not), and
    the announcement for the caller to publish (``None`` when nothing was proposed)."""

    key: str
    proposed_version: int = 0
    #: ``proposed``, or why the coach proposed nothing.
    coach: str = ''
    #: The rule's lesson: its memory, and ``drafted``, ``confirmed`` (the same lesson was there already) or why it
    #: was not kept.
    memory_id: str = ''
    lesson: str = ''
    announcement: dict[str, Any] | None = None
    skipped: str = ''


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _connection_or_none(retro: Retrospective) -> str:
    if retro.run.status not in ENDED:
        return 'the run has not ended'
    if not retro.run.connection:
        return 'the run has no connection (it launched no agent)'
    return ''


@dataclass(frozen=True)
class LearningLoop:
    reader: RunRecordReader
    scorecards: ScorecardStore
    memory: AgentMemoryStore
    #: The coach, built when a failure is taken to it (the Bedrock adapter is made only then).
    coach: Callable[[], Coach]
    #: The deployment's benchmark case ids (the coach names one its version should gain on); empty: no coach call.
    cases: Sequence[str]
    reactions: HostReactions = no_host_reactions
    now: Callable[[], datetime] = _utc_now

    def _retro(self, ws: str, run_id: str) -> Retrospective | None:
        record = self.reader.read(ws, run_id)
        return None if record is None else build_retrospective(record, self.reactions)

    def _put_once(self, ws: str, run_id: str, sk: str, extra: dict[str, Any]) -> bool:
        """A create-only row of the run's (``RETRO#``, ``LEARN#``, ``LEARNED#``); False when it exists."""
        item = {'pk': {'S': run_pk(ws, run_id)}, 'sk': {'S': sk}, 'kind': {'S': 'learning'},
                'by': {'S': WRITER}, 'at': {'S': self.now().isoformat()}, **extra}
        try:
            self.reader.client.put_item(TableName=self.reader.table, Item=item,
                                        ConditionExpression='attribute_not_exists(pk)')
        except ClientError as exc:
            if is_conditional_check_failure(exc):
                return False
            raise
        return True

    def _chosen(self, ws: str, run_id: str, retro: Retrospective) -> tuple[str, ...]:
        """The failures the run's retrospective takes to the coach, as its ``RETRO#coach`` row recorded them the first
        time (written now when there is none)."""
        keys = tuple(failure.key for failure in retro.to_coach)
        if self._put_once(ws, run_id, CHOSEN_SK, {'keys': {'L': [{'S': key} for key in keys]}}):
            return keys
        row = get_row(self.reader.client, self.reader.table, {'pk': {'S': run_pk(ws, run_id)}, 'sk': {'S': CHOSEN_SK}})
        stored = (row or {}).get('keys', {}).get('L', [])
        return tuple(str(value.get('S', '')) for value in stored if isinstance(value, dict))

    def retrospective(self, ws: str, run_id: str) -> Summary:
        """Step 1: the scorecards written, the failures to coach named (once)."""
        retro = self._retro(ws, run_id)
        if retro is None:
            return Summary(run_id, 0, 0, 0, (), skipped='no such run')
        skipped = _connection_or_none(retro)
        if skipped:
            return Summary(run_id, 0, 0, retro.failure_count, (), skipped=skipped)
        written = kept = 0
        for line in retro.scorecards:
            try:
                fresh = self.scorecards.write(retro.run, line)
            except ScorecardError as error:
                logger.warning('learning: a scorecard row was not written',
                               extra={'run_id': run_id, 'role': line.role, 'reason': str(error)})
                continue
            written, kept = written + fresh, kept + (not fresh)
        if retro.unattributed_no_go:
            logger.info('learning: NO-GOs with no judged task', extra={'run_id': run_id,
                                                                        'count': retro.unattributed_no_go})
        return Summary(run_id, written, kept, retro.failure_count, self._chosen(ws, run_id, retro))

    def learn_from(self, ws: str, run_id: str, key: str) -> Learned:
        """Step 2: one failure the retrospective chose, to memory and to the coach, once."""
        retro = self._retro(ws, run_id)
        skipped = 'no such run' if retro is None else _connection_or_none(retro)
        if retro is None or skipped:
            return Learned(key, skipped=skipped)
        chosen = self._chosen(ws, run_id, retro)
        failure = next((f for f in (*retro.to_coach, *retro.failures) if f.key == key), None) if key in chosen else None
        if failure is None:
            return Learned(key, skipped='not a failure this run\'s retrospective takes to the coach')
        if not self._put_once(ws, run_id, f'LEARN#{key}', {}):
            return Learned(key, skipped='this failure was taken to the coach already')
        record = Failure(run_id=run_id, connection=retro.run.connection, role=failure.attempt.role,
                         task_id=failure.attempt.task.task_id, attempt=coach_attempt(failure.attempt.attempt),
                         kind=failure.kind, evidence=evidence(failure, retro.run, retro.reactions), ws=ws)
        # The lesson before the coach's call: whatever the call's outcome, the failure leaves its lesson.
        memory_id, lesson = self._lesson(record, failure)
        learned = self._coach(record, Learned(key, memory_id=memory_id, lesson=lesson))
        self._put_once(ws, run_id, f'LEARNED#{key}', {
            'proposed_version': {'N': str(learned.proposed_version)}, 'coach': {'S': learned.coach[:400]},
            'memory_id': {'S': learned.memory_id}, 'lesson': {'S': learned.lesson[:400]}})
        return learned

    def _coach(self, record: Failure, learned: Learned) -> Learned:
        """``learned`` with the coach's proposal for the failure, or why there is none (an outcome, never raised)."""
        if not self.cases:
            return replace(learned, coach='no benchmark cases in this deployment: the coach was not asked')
        try:
            proposal = self.coach().propose_for(record, self.cases)
        except (CoachError, SkillError) as refused:
            # A role with no skill yet, the guard spent, an answer refused: an outcome, recorded and logged.
            logger.info('learning: the coach proposed nothing', extra={'run_id': record.run_id, 'reason': str(refused)})
            return replace(learned, coach=str(refused))
        except ReadTimeoutError:
            # The call ran past its read timeout (coach/model.py: well inside this invocation's limit). Claimed, so
            # it is never made again; the lesson is drafted already.
            logger.warning('learning: the coach timed out', extra={'run_id': record.run_id, 'key': learned.key})
            return replace(learned, coach=f'{COACH_TIMED_OUT}: the call ran past {READ_TIMEOUT_SECONDS} s, nothing '
                                          'was proposed (not retried)')
        except Exception:
            # The model or the store could not be reached: the failure stays claimed (never a second call), and its
            # lesson is drafted already.
            logger.exception('learning: the coach failed', extra={'run_id': record.run_id, 'key': learned.key})
            return replace(learned, coach=f'{COACH_FAILED}: the call failed (see the log), nothing was proposed '
                                          '(not retried)')
        version = proposal.change.version
        return replace(learned, proposed_version=version.version, coach='proposed',
                       announcement={'source': proposal.source, 'message': proposal.message.to_dict()})

    def _lesson(self, record: Failure, failure: FailedAttempt) -> tuple[str, str]:
        """The rule's line for the failure as a lesson draft at the failed role's scope, on the subject of the role and
        how the attempt failed (``fixer no go``): the memory's id ('' when none was kept) and ``drafted``,
        ``confirmed`` (it was there already) or why it was not kept (never raised).

        ``review_texts`` is empty because an engineering run cites no customer reviews: its record holds none (no
        route attaches feedback to a run yet), and the lesson is the rule's own text. The memory's hygiene still
        runs, and the draft waits for an administrator."""
        scope = Scope('role', connection=record.connection, role=record.role)
        run = RunContext(agent=coach_actor(record), run_id=record.run_id, role=record.role)
        memory = MemoryInput(subject=f'{record.role} {failure.how.replace("_", " ")}', kind='lesson',
                             statement=RULE_LESSONS[failure.how].format(role=record.role)[:MAX_STATEMENT],
                             provenance=Provenance(run_id=record.run_id, task_id=record.task_id),
                             confidence=LESSON_CONFIDENCE)
        try:
            kept = self.memory.learn_agent_memory(record.ws, scope, memory, run=run, review_texts=())
        except AgentMemoryError as refused:
            logger.info('learning: a lesson was not kept', extra={'run_id': record.run_id, 'reason': str(refused)})
            return '', f'not kept: {refused}'
        except Exception:
            logger.exception('learning: a lesson could not be written', extra={'run_id': record.run_id})
            return '', 'not kept: the memory store failed (see the log)'
        return kept.memory.memory_id, 'confirmed' if kept.confirmed else 'drafted'
