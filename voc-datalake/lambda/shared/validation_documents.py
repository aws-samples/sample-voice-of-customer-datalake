"""The Validate step's documents (7.68.00, docs/project-workspace.md → Validate): a ``DOC#`` row each in the project's
partition, in the Documents section (shared/document_sections.py), with English headings and the person's own words.

* ``validation_plan``: the interview guide and the test script (``plan: {guide, tasks, prototype_document_id,
  persona_ids}``, ``origin``: ``ai`` or ``human``, and the step's ``methodology`` block). A Human-driven person may
  write it by hand from the blank template (``origin: human``, ``evidence: 0``), as the PR/FAQ and PRD templates;
* ``validation_run``: one synthetic run, always ``synthetic: true`` (set here, never from a request): the personas'
  verdict per task and rating per criterion (``run``). A reference, never evidence, and never edited;
* ``validation_report``: per criterion (``results[i]``) the target, the real testers' figure and ``outcome`` (``met`` /
  ``not_met`` / ``not_enough_data``), the synthetic reading beside it; the tasks, the ease and the counts (``report``);
  the real responses it counted are its ``input_feedback_ids`` (lineage: an erasure removes one,
  jobs/retention/lineage.py). It quotes no tester: their "What was missing?" answers are read live, under the reader's
  access, on the Validation tab; the report keeps their ids.

Each records its creator (``created_by_sub``) and time (TENETS.md D4) and bumps the project's ``document_count``.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, Final

from shared.feedback_sampling import INPUT_FEEDBACK_IDS_FIELD
from shared.project_keys import document_keys
from shared.project_validation import (
    MET,
    NOT_ENOUGH_DATA,
    NOT_MET,
    PLAN_TYPE,
    REPORT_TYPE,
    RUN_TYPE,
    target_of,
    to_dynamo,
)
from shared.project_writes import create_counted_project_child
from shared.validation_ai import OUTCOMES

MAX_TITLE_CHARS: Final = 200
_STATUS_WORDS: Final = {MET: 'Met', NOT_MET: 'Not met', NOT_ENOUGH_DATA: 'Not enough data'}
SYNTHETIC_NOTICE: Final = ('Synthetic: personas tried the prototype\'s screens. These are not testers\' answers and '
                           'never count towards a criterion being met.')


def _criteria_lines(criteria: Sequence[Mapping[str, Any]]) -> list[str]:
    return [f"{index}. {criterion['text']} (met at {target_of(criterion):g} of 5)"
            for index, criterion in enumerate(criteria, 1)]


def render_plan(project_name: str, criteria: Sequence[Mapping[str, Any]], plan: Mapping[str, Any],
                personas: Mapping[str, str]) -> str:
    """The plan's markdown: the criteria, the interview guide per criterion with its probes, the test script."""
    lines = [f'# Validation plan: {project_name}', '', '## Success criteria', '', *_criteria_lines(criteria), '',
             '## Interview guide']
    texts = {criterion['id']: criterion['text'] for criterion in criteria}
    for entry in plan.get('guide') or []:
        lines += ['', f"### {texts.get(entry['criterion_id'], entry['criterion_id'])}", '',
                  *[f'- {question}' for question in entry.get('questions') or []]]
        probes = [f"- {personas.get(probe['persona_id'], 'Persona')}: {probe['probe']}"
                  for probe in entry.get('probes') or []]
        if probes:
            lines += ['', 'Probes:', '', *probes]
    lines += ['', '## Test script', '']
    for index, task in enumerate(plan.get('tasks') or [], 1):
        success = f" Success: {task['success']}" if task.get('success') else ''
        lines.append(f"{index}. {task['text']}.{success}")
    return '\n'.join(lines).strip() + '\n'


def blank_plan(project_name: str, criteria: Sequence[Mapping[str, Any]]) -> str:
    """The template a Human-driven person writes the plan from (no AI)."""
    lines = [f'# Validation plan: {project_name}', '', '## Success criteria', '', *_criteria_lines(criteria), '',
             '## Interview guide', '']
    for criterion in criteria:
        lines += [f"### {criterion['text']}", '', '- ', '']
    lines += ['## Test script', '', '1. ', '']
    return '\n'.join(lines)


def run_tallies(verdicts: Sequence[Mapping[str, Any]], tasks: Sequence[Mapping[str, Any]],
                criteria: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Per task the personas' outcomes, per criterion their average rating: the run's figures."""
    task_out = {}
    for task in tasks:
        outcomes = [v['tasks'][task['id']]['outcome'] for v in verdicts if task['id'] in v['tasks']]
        task_out[task['id']] = {**{outcome: outcomes.count(outcome) for outcome in OUTCOMES}, 'n': len(outcomes)}
    criteria_out = {}
    for criterion in criteria:
        ratings = [v['criteria'][criterion['id']]['rating'] for v in verdicts if criterion['id'] in v['criteria']]
        criteria_out[criterion['id']] = {'n': len(ratings),
                                         'average': round(sum(ratings) / len(ratings), 2) if ratings else None}
    return {'tasks': task_out, 'criteria': criteria_out}


def render_run(verdicts: Sequence[Mapping[str, Any]], tallies: Mapping[str, Any], tasks: Sequence[Mapping[str, Any]],
               criteria: Sequence[Mapping[str, Any]]) -> str:
    """The run's markdown, labelled synthetic at the top."""
    lines = ['# Synthetic validation run', '', f'> {SYNTHETIC_NOTICE}', '', '## Tasks', '',
             '| Task | Completed | Struggled | Failed |', '|---|---|---|---|']
    for task in tasks:
        figures = tallies['tasks'].get(task['id']) or {}
        lines.append(f"| {task['text']} | " + ' | '.join(str(figures.get(o, 0)) for o in OUTCOMES) + ' |')
    lines += ['', '## Criteria', '', '| Criterion | Personas\' average of 5 |', '|---|---|']
    for criterion in criteria:
        average = (tallies['criteria'].get(criterion['id']) or {}).get('average')
        lines.append(f"| {criterion['text']} | {'' if average is None else f'{average:g}'} |")
    texts = {**{t['id']: t['text'] for t in tasks}, **{c['id']: c['text'] for c in criteria}}
    for verdict in verdicts:
        lines += ['', f"### {verdict['name']}", '']
        lines += [f"- {texts[tid]}: {entry['outcome']}. {entry['note']}".rstrip() for tid, entry in verdict['tasks'].items()]
        lines += [f"- {texts[cid]}: {entry['rating']:g} of 5. {entry['note']}".rstrip()
                  for cid, entry in verdict['criteria'].items()]
        if verdict.get('summary'):
            lines += ['', str(verdict['summary'])]
    return '\n'.join(lines).strip() + '\n'


def _percent(rate: object) -> str:
    return f'{round(float(rate) * 100)}%' if isinstance(rate, int | float) else '-'


def render_report(project_name: str, results: Sequence[Mapping[str, Any]], report: Mapping[str, Any],
                  summary: str) -> str:
    """The report's markdown: the summary, then the criteria, tasks and ease as computed (no tester's own words)."""
    lines = [f'# Validation report: {project_name}', '']
    if summary:
        lines += [summary, '']
    run = f" (synthetic run {report['synthetic_run_id']})" if report.get('synthetic_run_id') else ''
    lines += [f"Real tester responses: {report['responses']}. Synthetic results{run} are labelled and never count.", '',
              '## Success criteria', '',
              '| Criterion | Target | Real testers (n) | Status | Synthetic (personas) |', '|---|---|---|---|---|']
    for result in results:
        real = result['real']
        average = '-' if real.get('average') is None else f"{real['average']:g}"
        synthetic = result.get('synthetic') or {}
        reading = f"{synthetic['average']:g} (synthetic)" if synthetic.get('average') is not None else '-'
        lines.append(f"| {result['text']} | {result['target']:g} | {average} ({real.get('n', 0)}) | "
                     f"{_STATUS_WORDS[result['outcome']]} | {reading} |")
    lines += ['', '## Tasks', '', '| Task | Real success (n) | Synthetic completed |', '|---|---|---|']
    for task in report.get('tasks') or []:
        synthetic = task.get('synthetic') or {}
        done = f"{synthetic.get('completed', 0)} of {synthetic.get('n', 0)}" if synthetic else '-'
        lines.append(f"| {task['text']} | {_percent(task['real'].get('rate'))} ({task['real'].get('n', 0)}) | {done} |")
    ces = report.get('ces') or {}
    ease = '-' if ces.get('average') is None else f"{ces['average']:g}"
    lines += ['', '## Ease (CES)', '', f"Average {ease} of 7 from {ces.get('n', 0)} tester(s).", '',
              '## What was missing', '',
              f"{report.get('missing_count', 0)} answer(s), shown on the project's Validation tab.", '']
    return '\n'.join(lines)


def create_document(table: Any, project_id: str, document_type: str, title: str, content: str,
                    fields: Mapping[str, Any], *, creator_sub: str) -> dict[str, Any]:
    """Put one Validate document (``DOC#``) and count it on the project; the row. A run is always synthetic."""
    now_dt = datetime.now(UTC)
    now = now_dt.isoformat()
    extra = to_dynamo(dict(fields))
    if document_type == RUN_TYPE:
        extra['synthetic'] = True
    elif document_type == REPORT_TYPE:
        extra[INPUT_FEEDBACK_IDS_FIELD] = list(extra.pop('feedback_ids', []))
    elif document_type != PLAN_TYPE:
        raise ValueError(f'not a Validate document type: {document_type}')

    def build(doc_id: str) -> dict[str, Any]:
        return {**document_keys(project_id, f'DOC#{doc_id}', now, workspace=None), 'document_id': doc_id,
                'document_type': document_type, 'title': title[:MAX_TITLE_CHARS], 'content': content,
                'created_at': now, 'updated_at': now, 'created_by_sub': creator_sub, **extra}

    return create_counted_project_child(table, project_id, 'doc', build, now=now_dt, workspace=None)
