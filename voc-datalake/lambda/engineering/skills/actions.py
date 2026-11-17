"""What an administrator does to a skill version (agents_handler.py's ``POST /agents/engineering/skills/<role>/
versions/<n>/accept|reject|rollback|benchmark``; docs/autonomous-engineering.md, "The administrators' actions").

Each action is the store's own (``SkillStore.accept_version``, ``reject_version``, ``roll_back_to``,
``record_benchmark``): its checks and its transaction are the store's, never re-implemented here. This module adds
what a screen needs before the store runs: the body checked (400), the state the screen showed checked against the
stored one (409 "it changed since you opened it": the scope's current version, the version's status), and the
person's optional reason with its credential-shaped strings redacted. Each answers the version as it is now, the
action's log event and the announcement the store made (``skill.accepted``, ``skill.rolled_back``), which is kept on
the log row: the Agents API does not publish on the engineering bus yet (its role is not one of the bus's
publishers), so publishing it is planned.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from engineering.connectors.identity import WORKSPACE
from engineering.knowledge.store import Actor
from engineering.quality_gate.text import redact
from engineering.skills.model import BENCHMARK_FIELDS, MAX_COMMENT, BenchmarkRun, Reason, SkillError
from engineering.skills.store import (
    ACCEPTED,
    BENCHMARKED,
    CHANGED,
    PROPOSED,
    REJECTED,
    ROLLED_BACK,
    Announcement,
    SkillConflict,
    SkillNotFound,
    SkillStore,
)
from engineering.skills.views import (
    PAGE,
    bundled_content,
    check_connection,
    check_role,
    check_version,
    line_view,
    template_view,
)


def _redacted(value: Any) -> Any:
    """A text with its credential-shaped strings redacted (anything else as it is, for the model to refuse)."""
    return redact(value.strip()) if isinstance(value, str) else value


def _benchmark(body: Mapping[str, Any]) -> BenchmarkRun:
    """An administrator's record of a benchmark run, as they enter it, read as the store's ``BenchmarkRun`` (whose
    own rules refuse a passed verdict whose rate fell, and count a gain only when the rate rose): its reasons and its
    optional reference to the run redacted and bounded as a reason is."""
    data = {name: body[name] for name in BENCHMARK_FIELDS}
    reasons = data['reasons']
    if isinstance(reasons, list):
        data['reasons'] = [_redacted(reason) for reason in reasons]
    if body.get('run_ref', '') != '':
        data['run_ref'] = _redacted(body['run_ref'])
    return BenchmarkRun.from_json(data)


def _reason(body: Mapping[str, Any]) -> str:
    """The person's optional reason: text of at most ``MAX_COMMENT`` characters, credential-shaped strings
    redacted (``''``: none given)."""
    raw = body.get('reason', '')
    if not isinstance(raw, str) or len(raw) > MAX_COMMENT or '\x00' in raw:
        raise SkillError(f'reason is text of at most {MAX_COMMENT} characters')
    return redact(raw.strip())


def _fields(body: Mapping[str, Any], allowed: frozenset[str], shape: str) -> None:
    if not set(body) <= allowed | {'reason'}:
        raise SkillError(f'the body is {shape}')


def _expected_current(body: Mapping[str, Any]) -> int:
    value = body.get('expected_current')
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise SkillError('expected_current is the current version the screen showed (0 for none)')
    return value


def _expected_status(body: Mapping[str, Any]) -> str:
    """The status the screen showed, which is ``proposed``: only a proposed version is accepted, rejected or
    benchmarked (another one is 400, never sent by the screen)."""
    if body.get('expected_status') != PROPOSED:
        raise SkillError('expected_status is proposed: only a proposed version is accepted, rejected or benchmarked')
    return PROPOSED


def _announcement(announcement: Announcement | None) -> dict[str, Any] | None:
    if announcement is None:
        return None
    # (kept on the action's log row; published on the bus once the Agents API may publish there: planned)
    return {'id': announcement.id, 'type': announcement.type, 'summary': announcement.summary, 'published': False}


@dataclass(frozen=True)
class SkillActions:
    #: The skills store on ``voc-engineering``, whose functions every action runs.
    skills: SkillStore
    actor: Actor

    def seed_template(self, role: str) -> dict[str, Any] | None:
        """The shared skill's first version from the role's bundled template, at an administrator's Skills visit
        (7.50.00: ``SkillStore.seed_from_template``), so the coach has a version to propose on; None when the role
        has no template or its shared skill has a history already (a seed never writes over one)."""
        from engineering.skills.templates import bundled
        template = bundled().skill(check_role(role))
        if template is None:
            return None
        seeded = self.skills.seed_from_template(WORKSPACE, template.role, template, by=self.actor)
        return None if seeded is None else {'role': template.role, 'version': seeded.version.version,
                                            'template': template.label}

    def adopt_template(self, connection: str, role: str, body: Mapping[str, Any]) -> dict[str, Any]:
        """``{expected_current, template_version, reason?}`` (7.50.00, "Template updated" → Adopt): the role's bundled
        template as the scope's next version, PROPOSED by this administrator on the version the scope runs (its
        provenance ``template``); never applied here: an administrator accepts it as any other proposal. 409 when
        the scope's current version or the bundled template changed since the screen read them, or when no newer
        template is waiting (one of this version is proposed or accepted already)."""
        from engineering.skills.templates import bundled
        scope, role = check_connection(connection), check_role(role)
        _fields(body, frozenset({'expected_current', 'template_version'}),
                '{expected_current, template_version, reason?}')
        current, reason = _expected_current(body), _reason(body)
        shown = body.get('template_version')
        if isinstance(shown, bool) or not isinstance(shown, int) or shown < 1:
            raise SkillError('template_version is the template version the screen showed')
        template = bundled().skill(role)
        if template is None:
            raise SkillNotFound(f'the {role} role has no bundled template')
        if template.version != shown:
            raise SkillConflict(f'{CHANGED}: the template was v{shown} and is v{template.version} now; read it again')
        self._check_current(scope, role, current)
        waiting = template_view(role, self.skills.lines(WORKSPACE, scope, role, limit=PAGE).lines)
        if not (waiting and waiting['newer']):
            raise SkillConflict(f'{CHANGED}: {template.label} is proposed or accepted already; read it again')
        proposed = self.skills.propose_version(
            WORKSPACE, scope, role, bundled_content(role), proposer=self.actor,
            reason=Reason(comment=reason or f'Adopted the template {template.label}.'),
            base=self.skills.resolved(WORKSPACE, scope, role), template_version=template.version)
        return self._answer(scope, role, proposed.version.version, PROPOSED, proposed.announcement)

    def _scope(self, connection: str, role: str, version: str) -> tuple[str, str, int]:
        return check_connection(connection), check_role(role), check_version(version)

    def _current(self, scope: str, role: str) -> int:
        head = self.skills.head(WORKSPACE, scope, role)
        return head.current_version if head else 0

    def _check_current(self, scope: str, role: str, expected: int) -> None:
        current = self._current(scope, role)
        if current != expected:
            shown = f'v{expected}' if expected else 'none'
            now = f'v{current}' if current else 'none'
            raise SkillConflict(f'{CHANGED}: the current version was {shown} and is {now} now; read it again')

    def _check_status(self, scope: str, role: str, number: int, expected: str) -> None:
        _, line = self.skills.detail(WORKSPACE, scope, role, number)
        if line.status != expected:
            raise SkillConflict(f'{CHANGED}: version {number} was {expected} and is {line.status} now; read it again')

    def _answer(self, scope: str, role: str, number: int, event: str,
                announcement: Announcement | None = None) -> dict[str, Any]:
        """The version as it is now, the action's log event and the announcement."""
        skills = self.skills
        _, line = skills.detail(WORKSPACE, scope, role, number)
        events = skills.events(WORKSPACE, scope, role, number, number)
        done = next(({'event': e.event, 'by': e.by, 'at': e.at, 'comment': e.comment}
                     for e in events if e.event == event), None)
        return {'connection': scope, 'role': role, 'version': line_view(line, events), 'event': done,
                'announcement': _announcement(announcement)}

    def accept(self, connection: str, role: str, version: str, body: Mapping[str, Any]) -> dict[str, Any]:
        """``{expected_status, expected_current, reason?}``: the proposed version becomes the scope's current one."""
        scope, role, number = self._scope(connection, role, version)
        _fields(body, frozenset({'expected_status', 'expected_current'}),
                '{expected_status, expected_current, reason?}')
        status, current, reason = _expected_status(body), _expected_current(body), _reason(body)
        self._check_status(scope, role, number, status)
        self._check_current(scope, role, current)
        change = self.skills.accept_version(WORKSPACE, scope, role, number, self.actor, reason)
        return self._answer(scope, role, number, ACCEPTED, change.announcement)

    def reject(self, connection: str, role: str, version: str, body: Mapping[str, Any]) -> dict[str, Any]:
        """``{expected_status, reason?}``: the proposed version is marked rejected (it stays)."""
        scope, role, number = self._scope(connection, role, version)
        _fields(body, frozenset({'expected_status'}), '{expected_status, reason?}')
        status, reason = _expected_status(body), _reason(body)
        self._check_status(scope, role, number, status)
        self.skills.reject_version(WORKSPACE, scope, role, number, self.actor, reason)
        return self._answer(scope, role, number, REJECTED)

    def roll_back(self, connection: str, role: str, version: str, body: Mapping[str, Any]) -> dict[str, Any]:
        """``{expected_current, reason?}``: a new version of the scope restoring version ``version``, current at
        once; answered as that new version."""
        scope, role, number = self._scope(connection, role, version)
        _fields(body, frozenset({'expected_current'}), '{expected_current, reason?}')
        current, reason = _expected_current(body), _reason(body)
        # (the store compares what the screen showed with what it reads, and holds that one in its transaction)
        change = self.skills.roll_back_to(WORKSPACE, scope, role, number, self.actor, reason, expected_current=current)
        return self._answer(scope, role, change.version.version, ROLLED_BACK, change.announcement)

    def benchmark(self, connection: str, role: str, version: str, body: Mapping[str, Any]) -> dict[str, Any]:
        """``{expected_status, before, after, cases, passed, reasons, failure_case, run_ref?, reason?}``: an
        administrator's record of a benchmark run on the proposed version (its rates, cases and verdict as they enter
        them), recorded once (the store's case rules: a coach's version names its expected case)."""
        scope, role, number = self._scope(connection, role, version)
        shape = '{expected_status, before, after, cases, passed, reasons, failure_case, run_ref?, reason?}'
        _fields(body, BENCHMARK_FIELDS | {'expected_status', 'run_ref'}, shape)
        if not set(body) >= BENCHMARK_FIELDS:
            raise SkillError(f'the body is {shape}')
        status, reason = _expected_status(body), _reason(body)
        run = _benchmark(body)
        self._check_status(scope, role, number, status)
        self.skills.record_benchmark(WORKSPACE, scope, role, number, run, self.actor, reason)
        return self._answer(scope, role, number, BENCHMARKED)
