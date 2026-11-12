"""The configurable quality gate step: deterministic checks, up to N review rounds, then the final go.

Each round runs the language packs' checks first. Red checks are the round's blocking findings and no model is
called; green checks are followed by every reviewer (each a fresh, single-turn call with the knowledge pack's
review guide). Blocking findings go back to the reviser (the fixer or builder that wrote the change), which commits
its fix and returns the new diff and what it did about each finding, and the next round starts. A round with green
checks and no blocking finding ends the loop; then a fresh final-go agent, which did not write or review the
change, answers GO or NO-GO on the committed tree.

Blocking findings left after the last round stop the flow at a human decision point with ``loop_exhausted``
(accept, another round, stop); a NO-GO with ``no_fail_path`` (accept, stop); an answer that does not follow its
contract, an oversized diff, a change to the repository's own gate, a repository no check covers or a checkout
with no committed tree with ``verification`` (stop). These are the ``needs_human`` payloads of
docs/autonomous-agents.md "When a run needs a human". The gate record says what happened either way.
"""
from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from engineering.quality_gate.checks import GateError, GateRun, reset_checkout, run_plan, tree_hash
from engineering.quality_gate.models import OPUS, SONNET, CountingModel, ModelClient, ModelRequest
from engineering.quality_gate.packs import OWN_GATE_FILE, GatePlan
from engineering.quality_gate.record import FinalGoRecord, GateRecord, RoundRecord
from engineering.quality_gate.review import (
    FINAL_GO_SYSTEM,
    REVIEWER_SYSTEM,
    Finding,
    Review,
    changed_paths,
    final_go_prompt,
    findings_text,
    parse_final_go,
    parse_review,
    reviewer_prompt,
)
from engineering.quality_gate.runner import CommandRunner
from engineering.quality_gate.text import clip, nonce, redact
from shared.agent_run_decisions import needs_human_payload
from shared.logging import logger

DEFAULT_ROUNDS = 3
MAX_ROUNDS = 5
REVISION_OUTCOMES = frozenset({'fixed', 'disputed', 'deferred'})
NOTE_CHARS = 600
#: What a person may decide at each stop: what shared.agent_run_decisions.allowed_actions answers for the payload.
DECISIONS = {'loop_exhausted': ('accept', 'another_round', 'stop'), 'no_fail_path': ('accept', 'stop'),
             'verification': ('stop',)}
#: The gate's rounds are its loop: the payload names it, so the run view offers another round.
GATE_LOOP_INDEX = 0
FINAL_GO_AGENT = 'final-go'
NO_PATHS: tuple[str, ...] = ()
NO_AUTHORS: frozenset[str] = frozenset()
PARAMS = frozenset({'max_rounds', 'reviewers', 'final_go_model', 'node_id', 'node_title'})
REVIEWER_KEYS = frozenset({'name', 'focus', 'model_id', 'advisory'})
_NAME = re.compile(r'[a-z][a-z0-9-]{0,39}\Z')


class GateConfigError(ValueError):
    """A gate configuration the step refuses (the workflow editor shows the message)."""


@dataclass(frozen=True)
class ReviewerSpec:
    name: str
    focus: str
    model_id: str = SONNET
    advisory: bool = False

    @property
    def agent(self) -> str:
        return f'reviewer:{self.name}'


DEFAULT_REVIEWERS = (
    ReviewerSpec('security', 'Can this change leak a secret, widen access, run untrusted input or lose data? '
                             'Name the input and the outcome.'),
    ReviewerSpec('quality', 'Is this change correct, and is every behaviour it changes pinned by a test that would '
                            'fail if the change were reverted?'),
    ReviewerSpec('first-principles', 'For each thing this change adds: does it need to exist, does it already exist, '
                                     'and does it fix the cause or only the symptom? Suggest only subtractions.',
                 advisory=True),
)


@dataclass(frozen=True)
class GateConfig:
    max_rounds: int = DEFAULT_ROUNDS
    reviewers: tuple[ReviewerSpec, ...] = DEFAULT_REVIEWERS
    final_go_model: str = OPUS
    node_id: str = 'quality_gate'
    node_title: str = 'Quality gate'
    max_diff_chars: int = 150_000

    def __post_init__(self) -> None:
        if not 1 <= self.max_rounds <= MAX_ROUNDS:
            raise GateConfigError(f'max_rounds must be from 1 to {MAX_ROUNDS}')
        if not any(not reviewer.advisory for reviewer in self.reviewers):
            raise GateConfigError('the gate needs at least one reviewer that can block')
        names = [reviewer.name for reviewer in self.reviewers]
        if len(set(names)) != len(names):
            raise GateConfigError('reviewer names must be unique')

    @classmethod
    def from_params(cls, params: Mapping[str, Any]) -> GateConfig:
        """The configuration of a workflow step's ``params`` (``PARAMS``); the rest keeps its default."""
        unknown = set(params) - PARAMS
        if unknown:
            raise GateConfigError(f'unknown quality gate settings: {sorted(unknown)}')
        rounds = params.get('max_rounds', DEFAULT_ROUNDS)
        if not isinstance(rounds, int) or isinstance(rounds, bool):
            raise GateConfigError('max_rounds must be a whole number')
        texts = {key: params.get(key, getattr(cls, key)) for key in ('final_go_model', 'node_id', 'node_title')}
        for key, value in texts.items():
            if not isinstance(value, str) or not value.strip():
                raise GateConfigError(f'{key} must be a non-empty string')
        return cls(max_rounds=rounds, reviewers=_reviewers(params.get('reviewers')), **texts)


def _reviewers(raw: Any) -> tuple[ReviewerSpec, ...]:
    if raw is None:
        return DEFAULT_REVIEWERS
    if not isinstance(raw, list) or not raw:
        raise GateConfigError('reviewers must be a non-empty list')
    return tuple(_reviewer(item) for item in raw)


def _reviewer(item: Any) -> ReviewerSpec:
    if not isinstance(item, dict) or not isinstance(item.get('name'), str) or not item['name']:
        raise GateConfigError('each reviewer needs a name')
    if not _NAME.match(item['name']):
        raise GateConfigError(f'reviewer name "{item["name"]}" must be lowercase letters, digits and dashes')
    unknown = set(item) - REVIEWER_KEYS
    if unknown:
        raise GateConfigError(f'reviewer "{item["name"]}": unknown settings {sorted(unknown)}')
    base = {reviewer.name: reviewer for reviewer in DEFAULT_REVIEWERS}.get(item['name'])
    focus = item.get('focus', base.focus if base else '')
    model_id = item.get('model_id', base.model_id if base else SONNET)
    advisory = item.get('advisory', base.advisory if base else False)
    if not isinstance(focus, str) or not focus or not isinstance(model_id, str) or not model_id:
        raise GateConfigError(f'reviewer "{item["name"]}" needs a focus and a model id')
    if not isinstance(advisory, bool):
        raise GateConfigError(f'reviewer "{item["name"]}": advisory must be true or false')
    return ReviewerSpec(name=item['name'], focus=focus, model_id=model_id, advisory=advisory)


@dataclass(frozen=True)
class GateInput:
    """The change under review. ``authors`` are the agents that wrote it: none of them may review it."""

    task: str
    diff: str
    review_guide: str = ''
    authors: frozenset[str] = NO_AUTHORS
    changed_paths: tuple[str, ...] = NO_PATHS


@dataclass(frozen=True)
class Revision:
    """What the reviser did: the change's new diff (committed), and per finding id ``(outcome, note)``."""

    diff: str
    outcomes: Mapping[str, tuple[str, str]]


class Reviser(Protocol):
    # Fixes ``findings`` and commits the fix; ``check_output`` holds each red check's output by finding id
    # (given to the reviser only, never stored in the record).
    def revise(self, round_no: int, findings: Sequence[Finding], check_output: Mapping[str, str]) -> Revision: ...


@dataclass(frozen=True)
class GateOutcome:
    """The record; when the gate stopped, the ``needs_human`` payload, the decisions it allows and the one
    sentence the run's journal and error show (a ``verification`` payload carries no verdicts)."""

    record: GateRecord
    needs_human: Mapping[str, Any] | None
    actions: tuple[str, ...] = ()
    message: str = ''

    @property
    def go(self) -> bool:
        return self.record.verdict == 'GO'


@dataclass
class _State:
    diff: str
    findings: list[Finding] = field(default_factory=list)
    outcomes: dict[str, tuple[str, str]] = field(default_factory=dict)
    rounds: list[RoundRecord] = field(default_factory=list)
    reviews: list[Review] = field(default_factory=list)
    check_output: dict[str, str] = field(default_factory=dict)
    tool_versions: dict[str, str] = field(default_factory=dict)


class _Stop(Exception):
    def __init__(self, reason: str, objection: str = '') -> None:
        super().__init__(objection)
        self.reason = reason
        self.objection = objection


def _checks_text(state: _State) -> str:
    """The current round's checks (a reviewer and the final go always come after one)."""
    checks = state.rounds[-1].checks
    return '\n'.join(f'{c.get("name")} [{c.get("root") or "."}]: {c.get("status")} ({c.get("reason")})'
                     for c in checks) or 'no checks apply'


def _rounds_text(state: _State) -> str:
    by_id = {finding.id: finding for finding in state.findings}
    return '\n'.join(
        f'Round {r.number}: checks {"passed" if r.checks_passed else "failed"}; '
        f'reviewed: {"yes" if r.reviewed else "no"}; '
        f'blocking findings: {sum(by_id[i].blocking for i in r.finding_ids if i in by_id)}'
        for r in state.rounds)


def _verdict(name: str, score: int, objections: Sequence[str], *, blocking: bool) -> dict[str, Any]:
    """One verdict of the needs_human payload (shared.agent_run_decisions caps the objections), redacted."""
    return {'name': name, 'score': score, 'blocking': blocking,
            'objections': [redact(o) for o in objections if o.strip()]}


class QualityGate:
    """One run of the gate over one change (build it, then call ``run``).

    ``runner`` runs the repository's checks (the runtime's sandbox); ``git_runner`` runs the gate's own git commands
    as the agent (``runner`` when not given, as in a local run). With ``fresh_checkout`` the checkout is put back
    to HEAD before every round (the runtime's gate checkout); off, the gate never touches a file of the checkout,
    as for a person's working copy. ``replan`` plans the checks again from the revised diff after each revision.
    """

    def __init__(self, gate_input: GateInput, *, config: GateConfig, round_plan: GatePlan, runner: CommandRunner,
                 model: ModelClient, final_plan: GatePlan | None = None, reviser: Reviser | None = None,
                 git_runner: CommandRunner | None = None, fresh_checkout: bool = True,
                 replan: Callable[[str], tuple[GatePlan, GatePlan]] | None = None) -> None:
        authors = gate_input.authors
        if FINAL_GO_AGENT in authors or any(r.agent in authors for r in config.reviewers):
            raise GateConfigError('an agent that wrote the change may not review it or give the final go')
        self.input = gate_input
        self.config = config
        self.round_plan = round_plan
        self.final_plan = final_plan or round_plan
        self.runner = runner
        self.git_runner = git_runner or runner
        self.model = CountingModel(model)
        self.reviser = reviser
        self.fresh_checkout = fresh_checkout
        self.replan = replan

    def _preflight(self, state: _State) -> None:
        if not any(c.kind != 'setup' for c in self.final_plan.checks):
            raise _Stop('verification', 'no check applies to this repository: no gate pack covers its languages, '
                                        'or it uses none of their tools (installing dependencies checks nothing)')
        # The input's paths and every path the current diff names (a revision may touch new files).
        if OWN_GATE_FILE in {*self.input.changed_paths, *changed_paths(state.diff)}:
            raise _Stop('verification', f"the change edits the repository's own gate ({OWN_GATE_FILE}): "
                                        'a person reviews that')
        if len(state.diff) > self.config.max_diff_chars:
            raise _Stop('verification', f'the diff has {len(state.diff)} characters, over the review limit of '
                                        f'{self.config.max_diff_chars}: split the change')

    def _checks(self, round_no: int, state: _State) -> tuple[list[dict[str, object]], list[Finding]]:
        """The round's checks, each phase only when the one before passed: the dependency step first (every
        root's setup, before any repository code runs in the round), then the roots the change touches, then the
        rest. With ``fresh_checkout`` the checkout is first put back to HEAD, so nothing planted in it, or written
        by an earlier round's code, reaches the dependency step. Red checks become findings."""
        if self.fresh_checkout:
            try:
                reset_checkout(self.git_runner)
            except GateError as exc:
                raise _Stop('verification', str(exc)) from exc
        packs = self.final_plan.packs
        touched = {c.key for c in self.round_plan.checks}
        phases = (
            GatePlan(checks=tuple(c for c in self.final_plan.checks if c.kind == 'setup'), packs=packs,
                     needs=self.final_plan.needs),
            GatePlan(checks=tuple(c for c in self.round_plan.checks if c.kind != 'setup'), packs=packs),
            GatePlan(checks=tuple(c for c in self.final_plan.checks if c.kind != 'setup' and c.key not in touched),
                     packs=packs),
        )
        results = []
        run = GateRun(results=())
        for phase in phases:
            run = run_plan(phase, self.runner)
            state.tool_versions.update(run.tool_versions)
            results += run.results
            if not run.passed:
                break
        return [r.summary() for r in results], self._check_findings(run, round_no, state)

    @staticmethod
    def _check_findings(run: GateRun, round_no: int, state: _State) -> list[Finding]:
        found = []
        for index, result in enumerate(run.failures, start=1):
            finding = Finding(id=f'R{round_no}-checks-{index}', round=round_no, reviewer='checks',
                              severity='blocking', title=f'{result.name}: {result.status} ({result.reason})',
                              file=result.root or '.', trigger=result.reason)
            state.check_output[finding.id] = result.output
            found.append(finding)
        return found

    def _ask(self, agent: str, model_id: str, system: str, prompt: str, parse: Callable[[str], Any]) -> Any:
        """The parsed answer; one retry when the first does not follow the contract; ``_Stop`` after that, or when
        the model call itself fails (the gate still writes its record)."""
        for _ in range(2):
            request = ModelRequest(agent=agent, model_id=model_id, system=system, prompt=prompt)
            try:
                answer = self.model.complete(request)
            except Exception as exc:   # any model failure stops the gate at a person, with its record
                raise _Stop('verification', f'{agent}: the model call failed ({type(exc).__name__})') from exc
            parsed = parse(answer)
            if parsed is not None:
                return parsed
        raise _Stop('verification', f'{agent} answered twice without following its contract')

    def _review(self, reviewer: ReviewerSpec, round_no: int, state: _State) -> Review:
        prompt = reviewer_prompt(focus=reviewer.focus, task=self.input.task, review_guide=self.input.review_guide,
                                 checks=_checks_text(state), earlier=findings_text(state.findings, state.outcomes),
                                 diff=state.diff, fence=nonce())
        return self._ask(reviewer.agent, reviewer.model_id, REVIEWER_SYSTEM, prompt,
                         lambda answer: parse_review(answer, reviewer=reviewer.name, round_no=round_no,
                                                     diff=state.diff, advisory=reviewer.advisory))

    def _round(self, round_no: int, state: _State) -> list[Finding]:
        """One round: checks, then (when they pass) every reviewer. Returns the round's blocking findings.

        The round's record is kept current as each reviewer answers, so a stop inside the round leaves what it
        found, marked incomplete.
        """
        state.reviews = []
        self._preflight(state)
        checks, found = self._checks(round_no, state)
        state.findings.extend(found)
        state.rounds.append(RoundRecord(number=round_no, checks=tuple(checks), reviewed=not found,
                                        finding_ids=tuple(f.id for f in found), complete=bool(found)))
        if found:
            return found
        for reviewer in self.config.reviewers:
            review = self._review(reviewer, round_no, state)
            state.reviews.append(review)
            state.findings.extend(review.findings)
            found += review.findings
            state.rounds[-1] = RoundRecord(number=round_no, checks=tuple(checks), reviewed=True,
                                           finding_ids=tuple(f.id for f in found), complete=False)
        state.rounds[-1] = RoundRecord(number=round_no, checks=tuple(checks), reviewed=True,
                                       finding_ids=tuple(f.id for f in found))
        return [finding for finding in found if finding.blocking]

    @staticmethod
    def _revise(reviser: Reviser, round_no: int, blocking: list[Finding], state: _State) -> None:
        output = {f.id: state.check_output[f.id] for f in blocking if f.id in state.check_output}
        revision = reviser.revise(round_no, blocking, output)
        known = {finding.id for finding in state.findings}
        for finding_id, (outcome, note) in revision.outcomes.items():
            if finding_id in known and outcome in REVISION_OUTCOMES:
                state.outcomes[finding_id] = (outcome, clip(redact(str(note)), NOTE_CHARS))
        state.diff = revision.diff

    def _final_go(self, state: _State) -> FinalGoRecord:
        prompt = final_go_prompt(task=self.input.task, checks=_checks_text(state), rounds=_rounds_text(state),
                                 findings=findings_text(state.findings, state.outcomes), diff=state.diff,
                                 fence=nonce())
        verdict = self._ask(FINAL_GO_AGENT, self.config.final_go_model, FINAL_GO_SYSTEM, prompt, parse_final_go)
        return FinalGoRecord(agent=FINAL_GO_AGENT, model_id=self.config.final_go_model, go=verdict.go,
                             reasons=verdict.reasons)

    def _loop(self, state: _State) -> tuple[str, FinalGoRecord | None]:
        """The rounds then the final go: ``(stop reason or '', the final go)``."""
        for round_no in range(1, self.config.max_rounds + 1):
            blocking = self._round(round_no, state)
            if not blocking:
                final = self._final_go(state)
                return ('' if final.go else 'no_fail_path'), final
            if round_no == self.config.max_rounds or self.reviser is None:
                break
            self._revise(self.reviser, round_no, blocking, state)
            if self.replan is not None:   # a fix may add a root, a test file or a tool's config
                self.round_plan, self.final_plan = self.replan(state.diff)
        return 'loop_exhausted', None

    def run(self) -> GateOutcome:
        state = _State(diff=self.input.diff)
        final: FinalGoRecord | None = None
        objection = ''
        try:
            stop, final = self._loop(state)
        except _Stop as exc:
            stop, objection = exc.reason, exc.objection
        except Exception as exc:
            # A reviser, a re-plan or a runner that fails still leaves a record and a person's decision.
            logger.exception('quality gate: stopped by an unexpected error')
            stop, objection, final = 'verification', f'the gate stopped on an error ({type(exc).__name__})', None
        try:
            tree = tree_hash(self.git_runner)
        except GateError as exc:
            tree = ''
            if not stop:   # a GO needs the tree it vouches for; a gate already stopped keeps its own reason
                stop, objection, final = 'verification', str(exc), None
        verdict = 'STOPPED' if final is None else 'GO' if final.go else 'NO-GO'
        record = GateRecord(
            verdict=verdict, stop_reason=stop, tree_hash=tree, packs=self.final_plan.packs,
            own_gate=self.final_plan.own_gate, tool_versions=dict(state.tool_versions),
            max_rounds=self.config.max_rounds, rounds=tuple(state.rounds), findings=tuple(state.findings),
            outcomes=dict(state.outcomes), reviewers=tuple(r.name for r in self.config.reviewers),
            model_calls=self.model.calls, final_go=final)
        if not stop:
            return GateOutcome(record=record, needs_human=None)
        title = self.config.node_title
        message = {'loop_exhausted': f'{title}: blocking findings left after {len(state.rounds)} round(s).',
                   'no_fail_path': f'{title}: the final go answered NO-GO.'}.get(stop, f'{title}: {redact(objection)}')
        return GateOutcome(record=record, needs_human=self._needs_human(stop, objection, state, final),
                           actions=DECISIONS[stop], message=message)

    def _needs_human(self, reason: str, objection: str, state: _State,
                     final: FinalGoRecord | None) -> dict[str, Any]:
        verdicts = []
        for review in state.reviews:
            blocking = [f.title for f in review.findings if f.blocking]
            verdicts.append(_verdict(review.reviewer, review.score, blocking, blocking=bool(blocking)))
        last = state.rounds[-1] if state.rounds else None
        if last is not None and not last.reviewed:
            by_id = {finding.id: finding for finding in state.findings}
            verdicts.append(_verdict('checks', 1, [by_id[i].title for i in last.finding_ids], blocking=True))
        if final is not None:
            verdicts.append(_verdict(final.agent, 1, list(final.reasons), blocking=True))
        if objection:
            verdicts.append(_verdict(self.config.node_title, 1, [objection], blocking=True))
        loop = {'loop_index': GATE_LOOP_INDEX, 'max_rounds': self.config.max_rounds} \
            if reason == 'loop_exhausted' else {}
        return needs_human_payload(reason, self.config.node_id, self.config.node_title, verdicts=verdicts, **loop)
