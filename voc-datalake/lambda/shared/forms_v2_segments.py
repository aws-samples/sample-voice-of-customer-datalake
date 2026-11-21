"""A version 2 form's results by segment, and its comparison with other forms (7.63.00, docs/feedback-forms.md
"Report"): ``GET /feedback-forms/{id}/results?group_by=…`` (and the report) and ``GET /feedback-forms/{id}/compare``.

A segment is the responses that share one value of what the view groups by (``parse_group_by``): a hidden field
(``hidden.customer``), a single choice (``q_role``: its option code, ``other`` for an Other answer) or one row of a
matrix (``q_phases.hands_on``: the column it was given). Responses without one (the link left the field empty, the
question was skipped) are the ``''`` segment. Each segment gets the rows' compact figures (shared/forms_v2_results.py
``score_summary``: every scale question's average and NPS / CSAT / CES, every matrix row's average score).

Nobody can be picked out of a small group: a segment of fewer than ``MIN_SEGMENT`` responses is never answered on its
own; those segments are merged into one "Other (fewer than 5)" group, whose figures are withheld too while it holds
fewer than ``MIN_SEGMENT`` responses (only its counts are given). Then the view's own figures (the report's KPIs, the
Results) less the named segments' would be the merged group's, so the smallest named segment is withheld with it
(``withheld: 'complement'``, secondary suppression): what is left over is always at least ``MIN_SEGMENT`` + 1
responses.

A comparison (``compare``) lines up forms made for the same purpose, a workshop run for several customers: the base
form's measured questions, matched in each other form by id and what their figures mean (``_measure_shape``: type and
range, and a matrix's column scores: a 5-point rating is never compared with a 10-point one, nor a matrix scored 1-4
with one scored 0-3), each form scored against its own revisions; ``by`` (a hidden field, e.g. ``hidden.event_date``)
splits each compared form's responses further. Every point follows the same minimum size and the same secondary
suppression. Pure: the handler reads the rows, with the caller's access, and the forms.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from shared.exceptions import ValidationError
from shared.forms_v2 import HIDDEN_ID, MATRIX, OTHER_CODE, QUESTION_ID, SINGLE, answer_shape
from shared.forms_v2_responses import headline_of
from shared.forms_v2_results import ResultRow, measured_questions, score_summary

__all__ = ['MIN_SEGMENT', 'FormSide', 'GroupBy', 'compare', 'parse_group_by', 'segment_results']

#: The fewest responses a segment (or a comparison's point) is answered with.
MIN_SEGMENT: Final = 5
#: At most this many other forms in one comparison.
MAX_COMPARED_FORMS: Final = 10
#: At most this many segments are answered by name (the rest go to the merged group).
MAX_SEGMENTS: Final = 50
_HIDDEN_PREFIX: Final = 'hidden.'
INVALID_GROUP_BY: Final = 'group_by_invalid'
#: Why a named segment of ``MIN_SEGMENT`` or more is withheld: with the withheld merged group beside it.
COMPLEMENT: Final = 'complement'


@dataclass(frozen=True)
class GroupBy:
    """What a view groups its responses by: ``hidden`` (a hidden field's value), ``choice`` (a single choice's option
    code) or ``matrix_row`` (the column one matrix row was given). ``raw``: as the request named it."""

    kind: str
    id: str
    raw: str
    row: str | None = None

    def value(self, row: ResultRow) -> str:
        """The segment ``row`` belongs to ('' when it has no value)."""
        if self.kind == 'hidden':
            value = row.hidden.get(self.id)
            return value.strip() if isinstance(value, str) else ''
        answer = row.answers.get(self.id)
        if not isinstance(answer, Mapping):
            return ''
        if self.kind == 'matrix_row':
            rows = answer.get('rows')
            column = rows.get(self.row) if isinstance(rows, Mapping) else None
            return column if isinstance(column, str) else ''
        if isinstance(answer.get('code'), str):
            return answer['code']
        return OTHER_CODE if answer.get('other') else ''


def _refuse(message: str) -> ValidationError:
    return ValidationError(message, code=INVALID_GROUP_BY)


def parse_group_by(definition: Mapping[str, Any], raw: object, *, hidden_only: bool = False) -> GroupBy:
    """``raw`` (``hidden.<id>``, ``q_<id>`` or ``q_<id>.<row code>``) as a GroupBy of ``definition``, or a 400
    ``group_by_invalid`` naming why: a hidden field the form has, one of its single choices, or a row of one of its
    matrices. ``hidden_only``: a comparison's ``by``, a hidden field only."""
    text = raw if isinstance(raw, str) else ''
    if text.startswith(_HIDDEN_PREFIX):
        hidden_id = text.removeprefix(_HIDDEN_PREFIX)
        known = {str(field.get('id')) for field in definition.get('hidden_fields') or [] if isinstance(field, Mapping)}
        if not HIDDEN_ID.fullmatch(hidden_id) or hidden_id not in known:
            raise _refuse(f'{text[:60]} is not a hidden field of this form')
        return GroupBy('hidden', hidden_id, text)
    if hidden_only:
        raise _refuse('by must be hidden.<id>, a hidden field of this form')
    question_id, _dot, row = text.partition('.')
    question = next((q for q in definition.get('questions') or [] if isinstance(q, Mapping)
                     and q.get('id') == question_id), None) if QUESTION_ID.fullmatch(question_id) else None
    if question is not None and question.get('type') == SINGLE and not row:
        return GroupBy('choice', question_id, text)
    if question is not None and question.get('type') == MATRIX and row in {
            str(entry.get('code')) for entry in question.get('rows') or [] if isinstance(entry, Mapping)}:
        return GroupBy('matrix_row', question_id, text, row)
    raise _refuse(f'group_by must be hidden.<id>, a single choice q_<id> or a matrix row q_<id>.<row>; '
                  f'{text[:60]} is none of this form')


def _groups(by: GroupBy, rows: Iterable[ResultRow]) -> dict[str, list[ResultRow]]:
    groups: dict[str, list[ResultRow]] = {}
    for row in rows:
        groups.setdefault(by.value(row), []).append(row)
    return groups


def _split(groups: Mapping[str, list[ResultRow]]) -> tuple[list[tuple[str, list[ResultRow]]], list[list[ResultRow]]]:
    """``(segments answered by name, the small ones)``: the largest first (then by value), at most ``MAX_SEGMENTS``."""
    ordered = sorted(groups.items(), key=lambda pair: (-len(pair[1]), pair[0]))
    named = [(value, members) for value, members in ordered if len(members) >= MIN_SEGMENT][:MAX_SEGMENTS]
    kept = {value for value, _members in named}
    return named, [members for value, members in ordered if value not in kept]


def _complement(named: Sequence[tuple[str, list[ResultRow]]], small: Sequence[list[ResultRow]]) -> str | None:
    """The value of the named segment withheld with the merged group (secondary suppression), or None: the smallest
    (``named`` is the largest first), when the merged group is withheld (fewer than ``MIN_SEGMENT``) but not empty."""
    merged = sum(len(members) for members in small)
    return named[-1][0] if named and 0 < merged < MIN_SEGMENT else None


def _merged(small: Sequence[list[ResultRow]], figure: Any) -> dict[str, Any] | None:
    """The "Other (fewer than 5)" group of the small segments: their count, and their figures once they are at least
    ``MIN_SEGMENT`` responses together (``scores`` None otherwise)."""
    if not small:
        return None
    rows = [row for members in small for row in members]
    scores = figure(rows)['scores'] if len(rows) >= MIN_SEGMENT else None
    return {'segments': len(small), 'responses': len(rows), 'scores': scores}


def segment_results(definition: Mapping[str, Any], rows: Iterable[ResultRow], by: GroupBy, *,
                    revisions: Mapping[int, Mapping[str, Any]] | None = None) -> dict[str, Any]:
    """``{by, min_size, groups: [{value, responses, scores, withheld?}], merged: {segments, responses, scores} | None}``
    of ``rows`` (the view's: the caller's access and filters already applied) grouped by ``by``; the group withheld
    with the merged group has ``scores: None`` and ``withheld: 'complement'``."""
    def figure(members: Iterable[ResultRow]) -> dict[str, Any]:
        return score_summary(definition, members, revisions=revisions)

    def group(value: str, members: list[ResultRow]) -> dict[str, Any]:
        if value == withheld:
            return {'value': value, 'responses': len(members), 'scores': None, 'withheld': COMPLEMENT}
        return {'value': value, 'responses': len(members), 'scores': figure(members)['scores']}
    named, small = _split(_groups(by, rows))
    withheld = _complement(named, small)
    return {'by': by.raw, 'min_size': MIN_SEGMENT, 'groups': [group(value, members) for value, members in named],
            'merged': _merged(small, figure)}


# ── Comparison across forms ──────────────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class FormSide:
    """One form of a comparison, as the handler read it: its id, name, template (``{id, version}`` or None), current
    definition, earlier revisions and the view's rows."""

    form_id: str
    name: str
    template: Mapping[str, Any] | None
    definition: Mapping[str, Any]
    rows: Sequence[ResultRow]
    revisions: Mapping[int, Mapping[str, Any]] | None = None


def _measure_shape(question: Mapping[str, Any]) -> tuple[object, tuple[int, ...]]:
    """What a question's figures mean, for a comparison: its answer shape (shared/forms_v2.py ``answer_shape``: type
    and range) and, for a matrix, its column scores (sorted), so two matrices scored on different scales are never
    lined up. (The lock of an answered form keeps to ``answer_shape``: a matrix's answers are its codes, which a score
    never changes, and Results average every row on the current scores.)"""
    scores: tuple[int, ...] = ()
    if question.get('type') == MATRIX:
        scores = tuple(sorted(column['score'] for column in question.get('columns') or []
                              if isinstance(column, Mapping) and isinstance(column.get('score'), int)
                              and not isinstance(column.get('score'), bool)))
    return answer_shape(question), scores


def _matching(base: Sequence[Mapping[str, Any]], side: FormSide) -> tuple[list[str], dict[str, str]]:
    """``(ids of the base's questions this form asks alike, {id: 'missing' | 'different'} of the rest)``."""
    own = {str(question.get('id')): question for question in measured_questions(side.definition)}
    matched, unmatched = [], {}
    for question in base:
        qid = str(question['id'])
        if qid not in own:
            unmatched[qid] = 'missing'
        elif _measure_shape(own[qid]) != _measure_shape(question):
            unmatched[qid] = 'different'
        else:
            matched.append(qid)
    return matched, unmatched


def _point(side: FormSide, members: Sequence[ResultRow], matched: Sequence[str], value: str | None,
           *, merged: bool = False, withheld: bool = False) -> dict[str, Any]:
    """One point of a comparison: a form (and a value of ``by``), its count and dates, and its figures on the matched
    questions (withheld under ``MIN_SEGMENT`` responses, and for the point withheld with the merged one: ``withheld:
    'complement'``)."""
    times = [row.created_at for row in members if row.created_at]
    scores = score_summary(side.definition, members, revisions=side.revisions, only=matched)['scores'] \
        if len(members) >= MIN_SEGMENT and not withheld else None
    point: dict[str, Any] = {'form_id': side.form_id, 'value': value, 'responses': len(members),
                             'first_response_at': min(times, default=None), 'last_response_at': max(times, default=None),
                             'scores': scores}
    if merged:
        point['merged'] = True
    if withheld:
        point['withheld'] = COMPLEMENT
    return point


def _points(side: FormSide, matched: Sequence[str], by: GroupBy | None) -> list[dict[str, Any]]:
    if by is None:
        return [_point(side, side.rows, matched, None)]
    named, small = _split(_groups(by, side.rows))
    complement = _complement(named, small)
    points = [_point(side, members, matched, value, withheld=value == complement)
              for value, members in sorted(named, key=lambda pair: pair[0])]
    if small:
        points.append(_point(side, [row for members in small for row in members], matched, None, merged=True))
    return points


def compare(base: FormSide, others: Sequence[FormSide], by: GroupBy | None) -> dict[str, Any]:
    """``{by, min_size, questions: [{id, type, headline, scale_max?}], forms: [{form_id, name, template,
    same_template, matched, unmatched}], points: [{form_id, value, responses, first_response_at, last_response_at,
    scores, merged?, withheld?}]}``: the base form first, then ``others`` in the order asked; within a form, by value.
    ``by`` splits the forms compared (the handler asks for at least one other form with it)."""
    questions = measured_questions(base.definition)
    primary = str(base.definition.get('language') or 'en')
    base_template = (base.template or {}).get('id')
    forms, points = [], []
    for side in (base, *others):
        matched, unmatched = _matching(questions, side)
        template_id = (side.template or {}).get('id')
        forms.append({'form_id': side.form_id, 'name': side.name, 'template': side.template,
                      'same_template': base_template is not None and template_id == base_template,
                      'matched': matched, 'unmatched': unmatched})
        points.extend(_points(side, matched, by))
    return {'by': None if by is None else by.raw, 'min_size': MIN_SEGMENT,
            'questions': [{'id': q['id'], 'type': q['type'],
                           'headline': headline_of(q, primary)} for q in questions],
            'forms': forms, 'points': points}
