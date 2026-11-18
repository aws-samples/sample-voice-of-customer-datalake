"""The scheduled cross-run Learn pass (7.53.00): once a week, a flow's recent runs read together, and proposals that a
person accepts.

Learn's per-run step (loop.py) sees one run. This pass sees the flow's last runs at once (at most 50 of the last 28
days, cross_run_input.py) for what recurs and whether the flow converges, and proposes; it applies nothing.

**When.** One weekly EventBridge Scheduler schedule (lib/stacks/engineering-cross-run.ts), created DISABLED and
enabled only with ``-c engineeringCrossRunLearn=weekly``, invokes voc-engineering-runtime with ``{"action":
"learn_cross_run"}``; that invocation lists the index's flows and hands each on as an invocation of its own
(``{"action": "learn_cross_run", "flow"}``, runtime/handler.py), so each flow's model call gets the function's whole
time. ``CrossRunLearn.run(flow)``:

1. reads the flow's recent runs from the transcripts' index; none: skipped, nothing written;
2. reads the flow's Learn settings and its monthly budget from its newest run (its copy of the flow, its META's
   ``budget_usd``: what the flow was when it last ran); ``learn.enabled: false``: skipped, nothing written;
3. claims the week, a create-only ``WS#default#LEARN#<flow>`` / ``WEEK#<yyyy-Www>`` row (the ISO week, UTC): a second
   invocation that week (a duplicate delivery, a second schedule) finds it and writes and asks nothing. From here
   every outcome is recorded;
4. reads each run's manifest, Learn and gate records, and counts the figures by rule (cross_run_input.py);
5. with two runs or more, one model call on Learn's model (the flow's ``learn.model`` when allowed, else the coach's),
   through the coach's bounded Bedrock client (coach/model.py: one attempt, a 200 s read, 8,000 tokens out), its
   prompt fenced as data (cross_run_answer.py). Its cost is Learn's: booked in the spend ledger as the run
   ``learn-<flow>-<week>`` (agent ``learn``, the flow's month total included) and in the flow's ``SPEND#<yyyy-mm>``
   row beside the claim, in one transaction (``CrossRunBudget``), the reply's tokens booked before it is read. The
   call is not made (a recorded outcome) when the flow's month is spent (its month total at or past its monthly
   budget, or the call's worst case would take it past), or when the call's worst case does not fit Learn's
   ``budget_share`` of that budget, less what the pass spent this month. A flow with no monthly budget bounds nothing
   here but its one call a week (its tokens are still booked), as Learn's per-run step does for a run with no cost cap;
6. the answer's proposals go where every proposal goes, each an outcome, never applied:
   - a lesson: a draft at the failing role's scope for the newest run's connection
     (``AgentMemoryStore.learn_agent_memory``, as that run's coach, the run its provenance), which an administrator
     approves; agent memory's hygiene runs, and a lesson about a never-by-an-agent topic is dropped first;
   - a skill addition: the role's current skill with the lines added, read through the coach's own checks
     (``coach.answer.read_answer``: the topics, the bounds, the expected case) and proposed as the coach of that run
     (``SkillStore.propose_version``, its why ``repeated_finding`` with the run, its ``expected_case`` and how it was
     made, ``cross-run-prompt/1``), once per run and role (the coach's ``RUN#`` guard), which the benchmark gate and an
     administrator's accept decide on;
7. writes the record, ``voc-cross-run/1``, create-only at ``ws/default/learn/<flow>/<week>/v1.json``, and the week's
   outcome row (``WEEK#<week>#outcome``, create-only). The record's ``analysis`` and the proposals' texts are model
   text (``MODEL_TEXT``), which the Agents API labels so (``GET /agents/engineering/learn``).

The calibration figures are proposals for a person too: nothing here changes a flow.
"""
from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Final

from botocore.exceptions import ClientError, ReadTimeoutError

from engineering.agent_memory.model import AgentMemoryError, MemoryInput, Provenance, RunContext, Scope
from engineering.agent_memory.store import AgentMemoryStore
from engineering.coach.answer import read_answer
from engineering.coach.failure import CoachError
from engineering.coach.model import COACH_MODEL, MAX_ANSWER_TOKENS, READ_TIMEOUT_SECONDS, CoachModel, CoachReply
from engineering.connectors.identity import WORKSPACE
from engineering.flow.conductor import FlowError
from engineering.flow.settings import LearnSettings, learn_settings
from engineering.knowledge.store import Actor
from engineering.learning.budget import LEARN_AGENT, WORST_TOKENS_IN, Price, spent_with_ledger
from engineering.learning.cross_run_answer import (
    CROSS_RUN_PROMPT,
    MAX_SKILLS,
    SYSTEM,
    CrossRunAnswer,
    SkillIdea,
    build_prompt,
    read_cross_run_answer,
)
from engineering.learning.cross_run_input import (
    WINDOW_DAYS,
    Figures,
    Indexed,
    Lister,
    Recurring,
    RunDigest,
    RunInputReader,
    check_flow,
    figures,
    recent_runs,
)
from engineering.learning.loop import LESSON_CONFIDENCE
from engineering.quality_gate.text import nonce
from engineering.runtime.runs import RunStore
from engineering.skills.model import MadeWith, Reason, SkillError
from engineering.skills.store import SkillStore
from engineering.spend import Usage, Where, flow_month_usd, month_of
from shared.aws import is_conditional_check_failure
from shared.logging import logger
from shared.model_config import ALLOWED_MODEL_IDS

SCHEMA: Final = 'voc-cross-run/1'
WRITER: Final = 'learning/cross_run'
#: A week as the pass keys it: the ISO year and week (``2026-W47``).
WEEK: Final = re.compile(r'20[0-9]{2}-W(?:0[1-9]|[1-4][0-9]|5[0-3])\Z')
#: The pass compares runs: with fewer than this, the figures are recorded and no model is asked.
MIN_RUNS_FOR_MODEL: Final = 2
#: The coach's failure kind a cross-run proposal names (skills/model.py FAILURE_KINDS): a failure that keeps repeating.
REPEATED: Final = 'repeated_finding'
#: The record's parts that are model text (labelled so wherever it is shown).
MODEL_TEXT: Final = ('analysis.convergence', 'analysis.failures[].note', 'proposals.lessons[].statement',
                     'proposals.coach[].add_instructions', 'proposals.coach[].why')
MODEL_LABEL: Final = ("model text: written by Learn's model from the runs' records, unverified; a proposal is used only "
                      'once a person accepts it')
MAX_RECORD_BYTES: Final = 256 * 1024
MAX_OUTCOME: Final = 400
#: What a store or a check refuses with: an outcome, recorded, never raised.
REFUSALS: Final = (CoachError, SkillError, AgentMemoryError)


def week_of(at: datetime) -> str:
    year, week, _day = at.astimezone(UTC).isocalendar()
    return f'{year}-W{week:02d}'


def check_week(week: object) -> str:
    if not isinstance(week, str) or not WEEK.fullmatch(week):
        raise ValueError('a week is an ISO week, yyyy-Www')
    return week


def learn_pk(flow: str) -> str:
    """The flow's cross-run partition: its weeks' claims and outcomes and its months' spend."""
    return f'WS#{WORKSPACE}#LEARN#{check_flow(flow)}'


def flow_prefix(flow: str) -> str:
    """The flow's records' prefix in the workspace bucket: one ``<week>/`` under it per week it was recorded."""
    return f'ws/{WORKSPACE}/learn/{check_flow(flow)}/'


def record_key(flow: str, week: str) -> str:
    return f'{flow_prefix(flow)}{check_week(week)}/v1.json'


def booked_as(flow: str, week: str) -> str:
    """The spend ledger's run for the flow's pass that week."""
    return f'learn-{check_flow(flow)}-{check_week(week)}'


def _utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class CrossRunBudget:
    """The pass's share of its flow's monthly budget, on voc-engineering (a boto3 resource Table)."""

    table: Any
    price: Price
    clock: Callable[[], datetime] = _utc_now

    def spent(self, flow: str, month: str) -> Decimal:
        item = self.table.get_item(Key={'pk': learn_pk(flow), 'sk': f'SPEND#{month}'}, ConsistentRead=True).get('Item')
        return Decimal(str((item or {}).get('cost_usd', 0)))

    def allows(self, flow: str, budget_usd: float | None, share: float, model: str) -> str:
        """'' when one call on ``model`` fits, else why not (the month spent, or Learn's share of it)."""
        if budget_usd is None:
            return ''
        month, budget = month_of(self.clock()), Decimal(str(budget_usd))
        worst = self.price(model, WORST_TOKENS_IN, MAX_ANSWER_TOKENS)
        month_spent = flow_month_usd(self.table, month, flow)
        if month_spent + worst > budget:
            return (f"the month is spent: the flow's runs spent ${month_spent:.2f} of its ${budget:.2f} monthly budget, "
                    f'and the call may cost up to ${worst:.4f}')
        allowance, spent = budget * Decimal(str(share)), self.spent(flow, month)
        if spent + worst > allowance:
            return (f"learn budget: the pass has ${max(allowance - spent, Decimal(0)):.4f} left of Learn's {share:.0%} "
                    f'of the ${budget:.2f} monthly budget, and the call may cost up to ${worst:.4f}')
        return ''

    def record(self, flow: str, week: str, repo: str, model: str, tokens_in: int, tokens_out: int) -> Decimal:
        """A call's tokens, priced, in the flow's ``SPEND#`` row and the ledger (one transaction); the dollars."""
        usd, at = self.price(model, tokens_in, tokens_out), self.clock()
        where = Where(run_id=booked_as(flow, week), agent_id=LEARN_AGENT, flow=flow, repo=repo)
        spent_with_ledger(self.table, {
            'Key': {'pk': learn_pk(flow), 'sk': f'SPEND#{month_of(at)}'},
            'UpdateExpression': 'ADD tokens_in :in, tokens_out :out, cost_usd :usd, calls :one SET updated_at = :at, '
                                'updated_by = :by, kind = :kind',
            'ExpressionAttributeValues': {':in': tokens_in, ':out': tokens_out, ':usd': usd, ':one': 1,
                                          ':at': at.isoformat(), ':by': WRITER, ':kind': 'cross_run_spend'}},
            at, where, {model: Usage(usd=usd, tokens_in=tokens_in, tokens_out=tokens_out)})
        return usd


@dataclass(frozen=True)
class Analysis:
    """What the model said and what came of its proposals (or why it was not asked)."""

    outcome: str
    model: str = ''
    answer: CrossRunAnswer | None = None
    lessons: tuple[dict[str, Any], ...] = ()
    coach: tuple[dict[str, Any], ...] = ()
    spend: tuple[CoachReply, ...] = ()


@dataclass(frozen=True)
class Outcome:
    flow: str
    week: str
    status: str
    reason: str = ''
    key: str = ''
    lessons: int = 0
    proposed: int = 0

    def view(self) -> dict[str, Any]:
        return {'flow': self.flow, 'week': self.week, 'status': self.status, 'reason': self.reason, 'key': self.key,
                'lessons': self.lessons, 'proposed': self.proposed}


#: What a pass's model is: ``(model id, on_reply)`` to the model, every reply's tokens booked before it is read.
type ModelFor = Callable[[str, Callable[[CoachReply], None]], CoachModel]


@dataclass(frozen=True)
class CrossRunLearn:
    lister: Lister
    reader: RunInputReader
    runs: RunStore
    skills: SkillStore
    memory: AgentMemoryStore
    budget: CrossRunBudget
    model_for: ModelFor
    #: The workspace bucket's create-only put (WorkspaceStore.put_once).
    put_once: Callable[[str, str, str], bool]
    #: The deployment's benchmark case ids (a skill addition names one); none: no skill addition is proposed.
    cases: Sequence[str] = ()
    now: Callable[[], datetime] = _utc_now
    fence: Callable[[], str] = nonce

    def run(self, flow: str) -> Outcome:
        """The flow's pass this week (see the module's doc); ValueError for a flow the pass does not take."""
        flow, now = check_flow(flow), self.now()
        week = week_of(now)
        indexed, more = recent_runs(self.lister, flow, now.date())
        if not indexed:
            return Outcome(flow, week, 'skipped', f'no run of the flow in the last {WINDOW_DAYS} days')
        settings, budget_usd = self._settings(indexed[0].run_id)
        if not settings.enabled:
            return Outcome(flow, week, 'skipped', "Learn is off for this flow")
        if not self._put_row(flow, f'WEEK#{week}', {'runs': len(indexed)}):
            return Outcome(flow, week, 'skipped', "this week's pass has run already")
        digests = tuple(found for found in map(self.reader.digest, indexed) if found is not None)
        counted = figures(digests)
        analysis = self._analyse(flow, week, digests, counted, settings, budget_usd)
        record = self._record(flow, week, (indexed, more), digests, counted, analysis,
                              {'budget_share': settings.budget_share, 'monthly_budget_usd': budget_usd})
        key = record_key(flow, week)
        written = self.put_once(key, json.dumps(record, sort_keys=True), 'application/json')
        outcome = Outcome(flow, week, 'written' if written else 'kept', analysis.outcome[:MAX_OUTCOME], key,
                          lessons=sum(line['outcome'] == 'drafted' for line in analysis.lessons),
                          proposed=sum(line['outcome'] == 'proposed' for line in analysis.coach))
        self._put_row(flow, f'WEEK#{week}#outcome', {'status': outcome.status, 'outcome': outcome.reason,
                                                     'record': key, 'lessons': outcome.lessons,
                                                     'proposed': outcome.proposed})
        return outcome

    def _settings(self, run_id: str) -> tuple[LearnSettings, float | None]:
        """The flow's Learn settings and monthly budget as its newest run copied them (the defaults when its copy
        cannot be read: Learn never stops for a setting it cannot read)."""
        try:
            settings = learn_settings(self.runs.flow_definition(run_id))
        except FlowError:
            logger.warning('cross-run learn: the newest run\'s flow copy cannot be read; the defaults apply',
                           extra={'run_id': run_id})
            settings = LearnSettings()
        run = self.runs.get(run_id)
        return settings, run.budget_usd if run is not None else None

    def _put_row(self, flow: str, sk: str, extra: Mapping[str, Any]) -> bool:
        """A create-only row of the flow's partition; False when it exists."""
        try:
            self.runs.table.put_item(Item={'pk': learn_pk(flow), 'sk': sk, 'kind': 'cross_run', 'by': WRITER,
                                           'at': self.now().isoformat(), **extra},
                                     ConditionExpression='attribute_not_exists(pk)')
        except ClientError as error:
            if is_conditional_check_failure(error):
                return False
            raise
        return True

    def _skills(self, connection: str, failures: Sequence[Recurring]) -> dict[str, Any]:
        """The current skill of each failing role the prompt shows (at most ``MAX_SKILLS``), on the connection."""
        found: dict[str, Any] = {}
        for role in dict.fromkeys(failure.role for failure in failures):
            if len(found) == MAX_SKILLS:
                break
            try:
                current = self.skills.current(WORKSPACE, connection, role) if connection else None
            except REFUSALS:
                current = None
            except Exception:
                logger.exception('cross-run learn: a role\'s skill could not be read', extra={'role': role})
                current = None
            if current is not None:
                found[role] = current
        return found

    def _ask(self, flow: str, week: str, digests: Sequence[RunDigest], counted: Figures, model: str,
             skills: Mapping[str, Any]) -> tuple[CrossRunAnswer | None, str, tuple[CoachReply, ...]]:
        """The model's checked answer (None with why not), and its replies (their tokens booked)."""
        prompt, _held = build_prompt(flow, week, counted.view(), [run.prompt_view() for run in digests],
                                     {role: version.skill.content.instructions for role, version in skills.items()},
                                     self.cases, self.fence())
        replies: list[CoachReply] = []

        def booked(reply: CoachReply) -> None:
            replies.append(reply)
            self.budget.record(flow, week, digests[0].repo, reply.model_id, reply.tokens_in, reply.tokens_out)

        try:
            reply = self.model_for(model, booked)(SYSTEM, prompt)
            return read_cross_run_answer(reply.text, len(counted.failures), self.cases), 'answered', tuple(replies)
        except CoachError as refused:
            return None, f'refused: {refused}', tuple(replies)
        except ReadTimeoutError:
            logger.warning('cross-run learn: the call timed out', extra={'flow': flow, 'week': week})
            return None, f'timed_out: the call ran past {READ_TIMEOUT_SECONDS} s (not retried)', tuple(replies)
        except Exception:
            logger.exception('cross-run learn: the call failed', extra={'flow': flow, 'week': week})
            return None, 'failed: the call failed (see the log; not retried)', tuple(replies)

    def _analyse(self, flow: str, week: str, digests: Sequence[RunDigest], counted: Figures,
                 settings: LearnSettings, budget_usd: float | None) -> Analysis:
        if len(digests) < MIN_RUNS_FOR_MODEL:
            return Analysis(f'skipped: fewer than {MIN_RUNS_FOR_MODEL} runs could be read to compare')
        model = settings.model if settings.model in ALLOWED_MODEL_IDS else COACH_MODEL
        refused = self.budget.allows(flow, budget_usd, settings.budget_share, model)
        if refused:
            logger.info('cross-run learn: the budget holds the call', extra={'flow': flow, 'week': week})
            return Analysis(f'skipped: {refused}', model)
        connection = next((run.connection for run in digests if run.connection), '')
        skills = self._skills(connection, counted.failures)
        answer, outcome, replies = self._ask(flow, week, digests, counted, model, skills)
        if answer is None:
            return Analysis(outcome, model, spend=replies)
        answered = replies[-1].model_id if replies else model
        lessons = tuple(self._lesson(connection, (lesson.index, counted.failures[lesson.index - 1]), digests,
                                     lesson.statement) for lesson in answer.lessons)
        coach = tuple(self._propose(connection, (idea.index, counted.failures[idea.index - 1]), digests, idea,
                                    answered, skills.get(counted.failures[idea.index - 1].role))
                      for idea in answer.coach)
        return Analysis(outcome, answered, answer, lessons, coach, replies)

    @staticmethod
    def _newest_run(failure: Recurring, digests: Sequence[RunDigest], connection: str) -> str:
        """The newest of the failure's runs on ``connection``: the proposal's run (its provenance, its coach)."""
        on = {run.run_id for run in digests if run.connection == connection}
        return next((run_id for run_id in failure.runs if run_id in on), '')

    def _lesson(self, connection: str, numbered: tuple[int, Recurring], digests: Sequence[RunDigest],
                statement: str) -> dict[str, Any]:
        """The statement as a lesson draft at the failing role's scope, as the newest such run's coach; an outcome,
        never raised."""
        index, failure = numbered
        line = {'index': index, 'role': failure.role, 'kind': failure.kind, 'statement': statement,
                'connection': connection, 'memory_id': '', 'run_id': ''}
        run_id = self._newest_run(failure, digests, connection) if connection else ''
        if not run_id:
            return {**line, 'outcome': 'not kept: no run of this failure has a connection'}
        try:
            run = RunContext(agent=Actor(f'coach-{run_id}', 'agent', connection=connection), run_id=run_id,
                             role=failure.role)
            memory = MemoryInput(subject=f'{failure.role} {failure.kind.replace("_", " ")} across runs', kind='lesson',
                                 statement=statement, provenance=Provenance(run_id=run_id),
                                 confidence=LESSON_CONFIDENCE)
            kept = self.memory.learn_agent_memory(WORKSPACE, Scope('role', connection=connection, role=failure.role),
                                                  memory, run=run, review_texts=())
        except AgentMemoryError as refused:
            return {**line, 'run_id': run_id, 'outcome': f'not kept: {refused}'}
        except Exception:
            logger.exception('cross-run learn: a lesson could not be written', extra={'run_id': run_id})
            return {**line, 'run_id': run_id, 'outcome': 'not kept: the memory store failed (see the log)'}
        return {**line, 'run_id': run_id, 'memory_id': kept.memory.memory_id,
                'outcome': 'confirmed' if kept.confirmed else 'drafted'}

    def _why_not(self, role: str, run_id: str, current: Any) -> str:
        """Why a skill addition cannot be proposed at all ('' when it can be tried)."""
        if not self.cases:
            return 'no benchmark cases in this deployment'
        if not run_id:
            return 'no run of this failure has a connection'
        return '' if current is not None else f'the {role} role has no skill yet: a person writes its first version'

    def _propose(self, connection: str, numbered: tuple[int, Recurring], digests: Sequence[RunDigest],
                 idea: SkillIdea, model: str, current: Any) -> dict[str, Any]:
        """The idea as a proposed version of the role's skill, through the coach's checks; an outcome, never raised."""
        index, failure = numbered
        line = {'index': index, 'role': failure.role, 'kind': failure.kind, 'connection': connection,
                'add_instructions': list(idea.lines), 'why': idea.why, 'expected_case': idea.expected_case,
                'version': 0, 'run_id': ''}
        run_id = self._newest_run(failure, digests, connection) if connection else ''
        why_not = self._why_not(failure.role, run_id, current)
        if why_not:
            return {**line, 'run_id': run_id, 'outcome': why_not}
        try:
            content = current.skill.content
            text = json.dumps({'instructions': '\n'.join((content.instructions.rstrip('\n'), *idea.lines)),
                               'examples': [{'situation': example.situation, 'action': example.action}
                                            for example in content.examples],
                               'why': idea.why, 'expected_case': idea.expected_case})
            checked = read_answer(text, content, self.cases)
            change = self.skills.propose_version(
                WORKSPACE, connection, failure.role, checked.content(content),
                proposer=Actor(f'coach-{run_id}', 'agent', connection=connection),
                reason=Reason(run_id, REPEATED, checked.why), base=current.ref, expected_case=checked.expected_case,
                made_with=MadeWith(model, CROSS_RUN_PROMPT))
        except REFUSALS as refused:
            return {**line, 'run_id': run_id, 'outcome': str(refused)[:MAX_OUTCOME]}
        except Exception:
            logger.exception('cross-run learn: a skill proposal could not be written', extra={'run_id': run_id})
            return {**line, 'run_id': run_id, 'outcome': 'failed: the skills store failed (see the log)'}
        logger.info('cross-run learn: a skill version proposed', extra={
            'role': failure.role, 'version': change.version.version, 'announcement': change.announcement.id})
        return {**line, 'run_id': run_id, 'version': change.version.version, 'outcome': 'proposed'}

    def _record(self, flow: str, week: str, listed: tuple[Sequence[Indexed], bool], digests: Sequence[RunDigest],
                counted: Figures, analysis: Analysis, budget: Mapping[str, Any]) -> dict[str, Any]:
        """The ``voc-cross-run/1`` record: the figures by rule, then the model's text, labelled."""
        indexed, more = listed
        answer = analysis.answer
        replies = analysis.spend
        cost = sum((self.budget.price(reply.model_id, reply.tokens_in, reply.tokens_out) for reply in replies),
                   Decimal(0))
        share, monthly = budget['budget_share'], budget['monthly_budget_usd']
        record = {
            'schema': SCHEMA, 'flow': flow, 'week': week, 'written_at': self.now().isoformat(), 'by': WRITER,
            'window': {'days': WINDOW_DAYS, 'runs': len(indexed), 'read': len(digests),
                       'unread': len(indexed) - len(digests), 'more': more, 'newest_day': indexed[0].day,
                       'oldest_day': indexed[-1].day},
            'runs': [run.line() for run in digests], **counted.view(),
            'analysis': {'label': MODEL_LABEL, 'outcome': analysis.outcome, 'model': analysis.model,
                         'prompt': CROSS_RUN_PROMPT, 'convergence': answer.convergence if answer else '',
                         'failures': [{'index': note.index, 'note': note.text} for note in answer.notes]
                         if answer else []},
            'proposals': {'label': MODEL_LABEL, 'lessons': list(analysis.lessons), 'coach': list(analysis.coach),
                          'dropped': list(answer.dropped) if answer else []},
            'spend': {'booked_as': booked_as(flow, week), 'cost_usd': str(cost),
                      'tokens_in': sum(reply.tokens_in for reply in replies),
                      'tokens_out': sum(reply.tokens_out for reply in replies), 'budget_share': share,
                      'monthly_budget_usd': monthly,
                      'cap_usd': None if monthly is None else str(
                          (Decimal(str(monthly)) * Decimal(str(share))).quantize(Decimal('0.01')))},
            'model_text': list(MODEL_TEXT)}
        if len(json.dumps(record, sort_keys=True).encode()) > MAX_RECORD_BYTES:
            record['runs'] = record['runs'][:10]   # (the run lines are the one part that grows past the bound)
        return record
