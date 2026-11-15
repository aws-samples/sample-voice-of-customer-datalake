"""The proposer: a failure in, a proposed version of the failed role's skill out, through the skills store.

``Coach.propose_for(failure, cases)``:

1. holds the coach to one proposal per run and failure kind: when the store already has the coach's ``RUN#`` row
   for them, it refuses before spending a model call (the proposal's own transaction holds the rule again);
2. reads the role's current skill for the connection (the connection's own accepted version, else the shared one;
   ``SkillStore.current``); a role with none runs on the platform's own instructions, and its first skill is a
   person's to write, since the coach never sets a tool policy, a model or a harness;
3. asks the model (``CoachModel``) with the prompt of ``prompt.build_prompt``, every piece of evidence and the current
   skill fenced as data under a fresh fence;
4. reads the answer strictly (``answer.read_answer``) and refuses it with a plain reason;
5. proposes the new content as the coach of the failure's connection (``Actor`` kind agent, its ``connection`` the
   run's), why being the run, the failure kind and the answer's why, written on the version it read, with the
   expected case the answer named (the version row's ``expected_case``, which ``record_benchmark`` holds the
   benchmark to) and how it was made (``made_with``: the model that actually answered, as the reply names it after
   any capacity fallback, and ``prompt.COACH_PROMPT``, D4);
6. returns the store's change, its ``skill.proposed`` announcement as a ``voc-msg/1`` message and the coach's
   run-scoped source (``voc.engineering/coach/<ws>/<run>``, bus/senders.py) for the caller to publish: the coach
   publishes nothing itself, as the store does not.

The run's retrospective calls it on the run's failures (``learning/loop.py``, at most three per run).
"""
from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final

from engineering.bus.publish import change_event_id
from engineering.bus.schema import Message, Party, fit_summary, parse
from engineering.bus.senders import PREFIX
from engineering.coach.answer import read_answer
from engineering.coach.failure import CoachError, Failure
from engineering.coach.model import CoachModel
from engineering.coach.prompt import COACH_PROMPT, SYSTEM, build_prompt
from engineering.knowledge.store import Actor
from engineering.quality_gate.text import nonce
from engineering.skills.model import CASE_ID, MAX_BENCHMARK_CASES, MadeWith, Reason
from engineering.skills.store import Announcement, Proposed, SkillStore

#: The bus party the coach speaks as (``from.kind`` coach, which only its run-scoped source proves).
COACH_KIND: Final = 'coach'


class CoachConflict(CoachError):
    kind = 'conflict'


@dataclass(frozen=True)
class Proposal:
    """A proposed version and what announces it: ``message`` for the caller to publish with ``source``."""

    change: Proposed
    message: Message
    source: str


def coach_actor(failure: Failure) -> Actor:
    """The coach of the failure's run, acting for the run's connection (from the run's record, as the failure is)."""
    return Actor(f'{COACH_KIND}-{failure.run_id}', 'agent', connection=failure.connection)


def coach_source(failure: Failure) -> str:
    """The run's coach's own bus source: run-scoped, so the router holds it to the run (bus/senders.py)."""
    return f'{PREFIX}{COACH_KIND}/{failure.ws}/{failure.run_id}'


def _at(created_at: str) -> datetime:
    return datetime.fromisoformat(created_at).astimezone(UTC)


def announcement_message(announcement: Announcement, failure: Failure, created_at: str) -> Message:
    """The ``skill.proposed`` announcement as a checked ``voc-msg/1`` message from the run's coach to the run, its
    id made from the change (``change_event_id``), so publishing it again is a redelivery."""
    at = _at(created_at)
    message = Message(
        event_id=change_event_id(at, announcement.id), ws=failure.ws, run_id=failure.run_id,
        thread_id=failure.task_id, task_id=failure.task_id, attempt=failure.attempt,
        sender=Party(COACH_KIND, coach_actor(failure).id), to=Party('run', failure.run_id), type=announcement.type,
        summary=fit_summary(announcement.summary), at=at.strftime('%Y-%m-%dT%H:%M:%S.%fZ'))
    return parse(message.to_dict())


def _cases(cases: Sequence[str]) -> tuple[str, ...]:
    found = tuple(cases)
    if not 0 < len(found) <= MAX_BENCHMARK_CASES or len(set(found)) != len(found):
        raise CoachError(f"the benchmark's cases are 1-{MAX_BENCHMARK_CASES} case ids, each once")
    if not all(CASE_ID.match(case) for case in found):
        raise CoachError('a case id is lower case letters, digits and hyphens')
    return found


@dataclass(frozen=True)
class Coach:
    store: SkillStore
    model: CoachModel
    #: A fresh fence per prompt (``quality_gate.text.nonce``; a test's fixed one).
    fence: Callable[[], str] = nonce

    def propose_for(self, failure: Failure, cases: Sequence[str]) -> Proposal:
        """Propose a new version of ``failure.role``'s skill for its connection from ``failure``, its expected case
        one of the benchmark's ``cases``; CoachError (or the store's SkillError) with the reason it is refused."""
        suite = _cases(cases)
        ws, connection, role = failure.ws, failure.connection, failure.role
        reason = Reason(failure.run_id, failure.kind)
        if self.store.coach_proposed(ws, connection, role, reason):
            raise CoachConflict(f"the coach has proposed a version for this run's {failure.kind} already")
        current = self.store.current(ws, connection, role)
        if current is None:
            raise CoachConflict(f'the {role} role has no skill yet: a person writes its first version')
        prompt = build_prompt(failure, current.skill, suite, self.fence())
        reply = self.model(SYSTEM, prompt)
        answer = read_answer(reply.text, current.skill.content, suite)
        change = self.store.propose_version(
            ws, connection, role, answer.content(current.skill.content), proposer=coach_actor(failure),
            reason=Reason(failure.run_id, failure.kind, answer.why), base=current.ref,
            expected_case=answer.expected_case, made_with=MadeWith(reply.model_id, COACH_PROMPT))
        return Proposal(change, announcement_message(change.announcement, failure, change.version.created_at),
                        coach_source(failure))
