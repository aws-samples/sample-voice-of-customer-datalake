"""What the leadership view counts, from a scope's project rows (pure; 7.70.00, docs/leadership-view.md).

voc-adoption-rollup (lambda/jobs/adoption_rollup/handler.py) reads each live project's partition, projected to
``PROJECT_ATTRIBUTES`` (keys, types, dates, how each artifact was made, a decision's verdict, date and evidence ids,
and a validation report's outcomes: never a text, a name or a person), and folds it here into calendar months (UTC):

* ``projects_started``: projects created in the month, and of those, ``with`` each step: personas, research, a PR/FAQ,
  a PRD, a prototype, a validation (a cohort, as the project stands when the rollup runs: "ideas taken to prototype"
  is ``with.prototype / projects_started``);
* ``artifacts``: per type (shared/adoption.py ``ARTIFACT_TYPES``) the artifacts made in the month, ``ai`` (generated,
  revised by the AI, built by the prototype builder) or ``human`` (written by hand from a blank template, imported
  personas); an edit or a restore that made a new version of a versioned series (a PR/FAQ, a PRD, a prototype), and a
  copied persona, are no new artifact, while a persona or research document edited or restored in place is still the
  one artifact it was;
* ``decisions`` by verdict (by ``decided_at``), ``validated_decisions``: those citing a validation report of the
  project with at least one criterion met by real results (shared/adoption_validation.py);
* ``validation_reports`` and ``validation_runs`` (``synthetic`` apart: a run with the personas never counts as met);
* ``cycle_days``: whole days (a histogram ``{days: count}``, so any months merge exactly into a median) from the
  project's evidence (its first personas or research, else its start) to its first PRD, from the first PRD to the
  first prototype, and from the first prototype to the first decision after it; each in the month the step ended,
  a step out of order (a negative span) left out.

Deleted projects are never passed in (their registry row says so). Nothing here reads a table.
"""
from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any, Final

from shared import adoption_validation as av
from shared.adoption import ARTIFACT_TYPES
from shared.decision_records import DECISION_DOCUMENT_TYPE, VERDICTS
from shared.document_versions import VERSIONED_DOCUMENT_TYPES

__all__ = ['COHORT_STEPS', 'CYCLES', 'MonthBuckets', 'month_of', 'months_between', 'project_projection']

#: The steps a project started in a month is counted "with".
COHORT_STEPS: Final = (*ARTIFACT_TYPES, 'validation')
#: The three cycle times, each from its start step to its end step.
CYCLES: Final = ('evidence_to_prd', 'prd_to_prototype', 'prototype_to_decision')
#: The top-level attributes the rollup reads of a project's rows (lib/stacks/adoption-rollup-worker.ts holds its
#: Query to these: ``dynamodb:Attributes``).
PROJECT_ATTRIBUTES: Final = ('pk', 'sk', 'document_type', 'document_id', 'created_at', 'origin', 'edit_kind',
                             'imported_from', 'copied_from', av.SYNTHETIC_FIELD, 'decision',
                             av.META_VALIDATION_FIELD, av.REPORT_RESULTS_FIELD)
_SECONDS_PER_DAY: Final = 86400
#: The edits that make a new version of an artifact without making a new one (shared/document_history.py): only on a
#: versioned series' version rows (shared/document_versions.py VERSIONED_DOCUMENT_TYPES); an unmanaged row (personas,
#: research) is the artifact itself, whatever its last edit was.
_NOT_NEW: Final = frozenset({'edit', 'restore'})
_AI_REVISION: Final = 'revise'
_LEGACY_PREFIX: Final = (('PERSONA#', 'personas'), ('RESEARCH#', 'research'), ('PRFAQ#', 'prfaq'), ('PRD#', 'prd'),
                         ('PROTOTYPE#', 'prototype'))


def project_projection() -> tuple[str, dict[str, str]]:
    """The ``ProjectionExpression`` of a project partition's Query and its ``ExpressionAttributeNames``: the top-level
    attributes of ``PROJECT_ATTRIBUTES``, but of a decision only its verdict, date and evidence document ids, of the
    ``META``'s validation only its report id, and of a report only each criterion's outcome."""
    names = {'#sk': 'sk', '#dt': 'document_type', '#did': 'document_id', '#ca': 'created_at', '#origin': 'origin',
             '#ek': 'edit_kind', '#imp': 'imported_from', '#cop': 'copied_from', '#syn': av.SYNTHETIC_FIELD,
             '#dec': 'decision', '#verdict': 'verdict', '#dat': 'decided_at', '#ev': 'evidence',
             '#dids': 'document_ids', '#val': av.META_VALIDATION_FIELD, '#rdid': 'report_document_id'}
    paths = ['#sk', '#dt', '#did', '#ca', '#origin', '#ek', '#imp', '#cop', '#syn', '#dec.#verdict', '#dec.#dat',
             '#dec.#ev.#dids', '#val.#rdid', *av.report_projection(names)]
    return ', '.join(paths), names


def _moment(value: object) -> datetime | None:
    """An ISO time (or a day) as an aware UTC datetime, None for anything else."""
    if not isinstance(value, str) or len(value) < 10:
        return None
    try:
        moment = datetime.fromisoformat(value.replace('Z', '+00:00')) if len(value) > 10 else datetime.combine(
            date.fromisoformat(value), datetime.min.time())
    except ValueError:
        return None
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment.astimezone(UTC)


def month_of(value: object) -> str | None:
    """The UTC month (``YYYY-MM``) of an ISO time, None when it is not one."""
    moment = _moment(value)
    return None if moment is None else moment.strftime('%Y-%m')


def months_between(first: str, last: str) -> list[str]:
    """Every month from ``first`` to ``last`` (``YYYY-MM``, both included), oldest first."""
    year, month = (int(part) for part in first.split('-'))
    end = tuple(int(part) for part in last.split('-'))
    months: list[str] = []
    while (year, month) <= end:
        months.append(f'{year:04d}-{month:02d}')
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return months


def _artifact_type(row: Mapping[str, Any]) -> str | None:
    """Which of ``ARTIFACT_TYPES`` a row is (its ``document_type``, else a legacy row's sort-key prefix), or None."""
    document_type = row.get('document_type')
    if isinstance(document_type, str):
        return document_type if document_type in ARTIFACT_TYPES else None
    sk = str(row.get('sk', ''))
    return next((kind for prefix, kind in _LEGACY_PREFIX if sk.startswith(prefix)), None)


def _made_with_ai(row: Mapping[str, Any], kind: str) -> bool | None:
    """True for an artifact the AI made, False for one made by hand, None for no new artifact (an edit or a restore that
    made a new version of a versioned series, a copied persona)."""
    edit_kind = row.get('edit_kind')
    if edit_kind in _NOT_NEW and kind in VERSIONED_DOCUMENT_TYPES:
        return None
    if edit_kind == _AI_REVISION:
        return True
    if kind == 'personas':
        if row.get('copied_from') is not None:
            return None
        return row.get('imported_from') is None
    return row.get('origin') != 'human'


def _days(start: datetime, end: datetime) -> int | None:
    """Whole days from ``start`` to ``end`` (rounded), None when the end comes first."""
    seconds = (end - start).total_seconds()
    return None if seconds < 0 else int((seconds + _SECONDS_PER_DAY / 2) // _SECONDS_PER_DAY)


def _decision(row: Mapping[str, Any]) -> tuple[str, datetime, list[str]] | None:
    """A decision row's verdict, when it was decided and the document ids it cites; None for a decision it cannot
    read."""
    record = row.get('decision')
    record = record if isinstance(record, Mapping) else {}
    verdict = record.get('verdict')
    decided = _moment(record.get('decided_at')) or _moment(row.get('created_at'))
    if verdict not in VERDICTS or decided is None:
        return None
    evidence = record.get('evidence')
    ids = evidence.get('document_ids') if isinstance(evidence, Mapping) else None
    return str(verdict), decided, [str(each) for each in ids] if isinstance(ids, list) else []


@dataclass
class _Project:
    """What one project contributes, gathered from its rows before it is folded into months."""

    started: datetime | None = None
    validation_report_id: str | None = None
    first: dict[str, datetime] = field(default_factory=dict)
    artifacts: list[tuple[datetime, str, bool]] = field(default_factory=list)
    decisions: list[tuple[str, datetime, list[str]]] = field(default_factory=list)
    reports: dict[str, tuple[datetime, int]] = field(default_factory=dict)
    runs: list[tuple[datetime, bool]] = field(default_factory=list)

    def first_at(self, step: str, at: datetime) -> None:
        if step not in self.first or at < self.first[step]:
            self.first[step] = at

    def add(self, row: Mapping[str, Any]) -> None:
        at = _moment(row.get('created_at'))
        if row.get('sk') == 'META':   # (the project's own row)
            self.started = at
            validation = row.get(av.META_VALIDATION_FIELD)
            report = validation.get('report_document_id') if isinstance(validation, Mapping) else None
            self.validation_report_id = report if isinstance(report, str) and report else None
            return
        document_type = row.get('document_type')
        if document_type == DECISION_DOCUMENT_TYPE:
            if (decision := _decision(row)) is not None:
                self.decisions.append(decision)
            return
        if at is None:
            return
        if document_type == av.VALIDATION_REPORT_TYPE:
            self.reports[str(row.get('document_id') or row.get('sk'))] = (at, av.met_criteria(row))
            self.first_at('validation', at)
            return
        if document_type == av.VALIDATION_RUN_TYPE:
            self.runs.append((at, av.is_synthetic(row)))
            return
        kind = _artifact_type(row)
        if kind is None:
            return
        self.first_at(kind, at)
        made_with_ai = _made_with_ai(row, kind)
        if made_with_ai is not None:
            self.artifacts.append((at, kind, made_with_ai))


def _bucket() -> dict[str, Any]:
    return {'projects_started': 0, 'with': Counter(), 'artifacts': {kind: Counter() for kind in ARTIFACT_TYPES},
            'decisions': Counter(), 'validated_decisions': 0, 'validation_reports': 0, 'validation_runs': Counter(),
            'cycle_days': {cycle: Counter() for cycle in CYCLES}, 'assistant_conversations': 0, 'agent_runs': 0}


class MonthBuckets:
    """The months ``first`` to ``last`` of one scope, each a bucket of counts; an event outside them is left out."""

    def __init__(self, first: str, last: str) -> None:
        self.months = months_between(first, last)
        self._buckets: dict[str, dict[str, Any]] = {month: _bucket() for month in self.months}

    def _at(self, moment: datetime | None) -> dict[str, Any] | None:
        return None if moment is None else self._buckets.get(moment.strftime('%Y-%m'))

    def add_project(self, rows: Iterable[Mapping[str, Any]]) -> None:
        """Fold one live project's rows in."""
        project = _Project()
        for row in rows:
            project.add(row)
        self._cohort(project)
        for at, kind, made_with_ai in project.artifacts:
            if (bucket := self._at(at)) is not None:
                bucket['artifacts'][kind]['ai' if made_with_ai else 'human'] += 1
        validated_reports = {report for report, (_, met) in project.reports.items() if met > 0}
        for at, _ in project.reports.values():
            if (bucket := self._at(at)) is not None:
                bucket['validation_reports'] += 1
        for at, synthetic in project.runs:
            if (bucket := self._at(at)) is not None:
                bucket['validation_runs']['synthetic' if synthetic else 'real'] += 1
        for verdict, decided, cited in project.decisions:
            if (bucket := self._at(decided)) is not None:
                bucket['decisions'][verdict] += 1
                bucket['validated_decisions'] += int(bool(validated_reports.intersection(cited)))
        self._cycles(project)

    def _cohort(self, project: _Project) -> None:
        bucket = self._at(project.started)
        if bucket is None:
            return
        bucket['projects_started'] += 1
        for step in COHORT_STEPS:
            bucket['with'][step] += int(step in project.first)
        # A META that names its validation report (7.68.00) is validated even before the report row is read.
        if 'validation' not in project.first and project.validation_report_id is not None:
            bucket['with']['validation'] += 1

    def _cycle(self, cycle: str, start: datetime | None, end: datetime | None) -> None:
        if start is None or end is None or (bucket := self._at(end)) is None:
            return
        days = _days(start, end)
        if days is not None:
            bucket['cycle_days'][cycle][str(days)] += 1

    def _cycles(self, project: _Project) -> None:
        first = project.first
        evidence = min((first[step] for step in ('personas', 'research') if step in first), default=project.started)
        self._cycle('evidence_to_prd', evidence, first.get('prd'))
        self._cycle('prd_to_prototype', first.get('prd'), first.get('prototype'))
        prototype = first.get('prototype')
        after = sorted(decided for _, decided, _ in project.decisions if prototype is not None and decided >= prototype)
        self._cycle('prototype_to_decision', prototype, after[0] if after else None)

    def add_count(self, month: str, name: str, count: int) -> None:
        """Add ``count`` to one month's ``assistant_conversations`` or ``agent_runs``."""
        if month in self._buckets and count > 0:
            self._buckets[month][name] += count

    def add_agent_run(self, started: object) -> None:
        """One agent run started at ``started`` (an ISO time)."""
        month = month_of(started)
        if month is not None:
            self.add_count(month, 'agent_runs', 1)

    def stored(self) -> dict[str, dict[str, Any]]:
        """Every month as the rollup item stores it: plain ints and maps, zeros left out (the view reads them as 0)."""
        out: dict[str, dict[str, Any]] = {}
        for month, bucket in self._buckets.items():
            sparse: dict[str, Any] = {}
            for name, value in bucket.items():
                if isinstance(value, int):
                    if value:
                        sparse[name] = value
                    continue
                kept = _non_zero(value)
                if kept:
                    sparse[name] = kept
            out[month] = sparse
        return out


def _non_zero(value: Mapping[str, Any]) -> dict[str, Any]:
    """A map of counts (or of maps of counts) without its zeros."""
    kept: dict[str, Any] = {}
    for name, inner in value.items():
        if isinstance(inner, Mapping):
            if nested := _non_zero(inner):
                kept[name] = nested
        elif inner:
            kept[name] = int(inner)
    return kept
