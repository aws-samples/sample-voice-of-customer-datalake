"""A version 2 form's results and responses (``GET /feedback-forms/{id}/results`` and ``…/responses``,
docs/feedback-forms.md "Results"): per question of the current revision, what its responses answered.

Each response is a ``ResultRow``: its answers, the questions its logic path showed, its ending, language, revision,
hidden values and time. Rows come from the form's feedback items (``metadata.form_answers``, ``form_path``,
``form_ending_id``…; a version 1 item's ``rating`` and text through ``legacy_row``, always as ``q_rating`` and
``q_text``) and, with ``include_test``, from its tagged test responses. A question id is stable across revisions, so a
row of an older revision counts towards the same question, scored against the question as its own revision had it
(``revisions``, the form's snapshots): an answer to a revision where the question had another type or range is never
read on the current one (a 5 of 5 stars is no NPS 5) and is counted under the question's ``earlier_version``; a value
that does not fit the question's type is left out, an answer to a question the current revision no longer has is
counted under ``removed_questions``, and a choice code it no longer offers under the question's ``removed_options``.

Per question: ``shown`` (the responses whose path showed it), ``answered``, ``skipped``, ``not_shown`` (the logic
jumped past it) and ``drop_off_rate`` (skipped / shown), plus by type: counts per option code with the latest "Other"
texts, a histogram, NPS / CSAT / CES scores, and the open-text count with the latest answers. Contact details are
counted, never returned here. ``funnel`` (``funnel_counts``, from the daily counter rows) adds how many opened the
form and, of those who left without submitting, at which question; ``None`` when the caller has none for the view (the
counters know no language, ending or hidden value). A matrix counts per row and column, with each row's
average ``score``. ``link_health`` (``link_health``) says how often the view's responses carried each hidden
field, overall and per channel, with a warning for one never or mostly missing. Pure.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from shared.forms_recall import shown_as_ids
from shared.forms_v2 import (
    CES,
    CONSENT,
    CONTACT,
    CSAT,
    MATRIX,
    MULTI,
    NONE_CODE,
    NPS,
    OPEN_TEXT,
    OTHER_CODE,
    RATING,
    SCALE_TYPES,
    SELECT_TYPES,
    SINGLE,
    V1_RATING_ID,
    V1_TEXT_ID,
    answer_shape,
    question_bounds,
    text_in,
)
from shared.forms_v2_responses import CHANNELS

__all__ = ['LEFT_COUNTER_PREFIX', 'ResultRow', 'filter_rows', 'funnel_counts', 'headline', 'legacy_row', 'tally_results']

#: Open-text and "Other" answers returned per question, newest first.
LATEST_ANSWERS: Final = 10
#: Link checks: a hidden field never filled once this many responses came in is a warning...
NEVER_FILLED_AFTER: Final = 5
#: ...and so is one missing from at least this share of them, once this many came in.
MOSTLY_MISSING_AFTER: Final = 10
MOSTLY_MISSING_SHARE: Final = 0.8
#: The ``by_channel`` key of the responses that name no channel (a widget from before 7.04.00).
UNKNOWN_CHANNEL: Final = 'unknown'


@dataclass(frozen=True)
class ResultRow:
    """One response as the results read it (``response_id``: the feedback item's id, or a test response's)."""

    answers: Mapping[str, Any]
    path: Sequence[str]
    ending_id: str | None
    created_at: str
    is_test: bool = False
    hidden: Mapping[str, Any] = field(default_factory=dict)
    response_id: str = ''
    language: str | None = None
    revision: int | None = None
    sentiment: str | None = None
    session: str | None = None
    #: How the widget that sent it ran (``link``, ``iframe``, ``script``; None from before 7.04.00).
    channel: str | None = None


def legacy_row(definition: Mapping[str, Any], rating: object, text: object, created_at: str,
               **extra: Any) -> ResultRow | None:
    """A version 1 submission (a ``rating`` and a text, no ``form_answers``) as a row of the questions its form became,
    ``q_rating`` and ``q_text``, whatever the form holds now: a question since removed counts under
    ``removed_questions``, one since given another type is left out of it (``_fitting``, the row's revision). Its path
    is what it answered plus those of the two the form still has. None for a submission with neither."""
    questions = {question.get('id') for question in definition.get('questions') or [] if isinstance(question, Mapping)}
    answers: dict[str, Any] = {}
    if isinstance(rating, int | float) and not isinstance(rating, bool):
        answers[V1_RATING_ID] = int(rating)
    if isinstance(text, str) and text.strip():
        answers[V1_TEXT_ID] = text.strip()
    if not answers:
        return None
    path = [qid for qid in (V1_RATING_ID, V1_TEXT_ID) if qid in answers or qid in questions]
    return ResultRow(answers, path, None, created_at, **extra)


def filter_rows(rows: Iterable[ResultRow], *, date_from: str = '', date_to: str = '', language: str = '',
                ending: str = '', hidden: Mapping[str, str] | None = None) -> list[ResultRow]:
    """The rows a Results view keeps: answered from ``date_from`` to ``date_to`` (ISO dates or times, inclusive; a
    date ``date_to`` covers its whole day), in ``language``, reaching ``ending``, with each ``hidden`` value."""
    wanted = dict(hidden or {})

    def keep(row: ResultRow) -> bool:
        day = row.created_at[:len(date_to)] if date_to else ''
        return ((not date_from or row.created_at >= date_from) and (not date_to or day <= date_to)
                and (not language or row.language == language) and (not ending or row.ending_id == ending)
                and all(str(row.hidden.get(key, '')) == value for key, value in wanted.items()))
    return [row for row in rows if keep(row)]


def _fitting(question: Mapping[str, Any], value: object) -> object:
    """``value`` when it fits the question's current type, else None (an older revision's other shape)."""
    kind = question['type']
    if value is None:
        return None
    if kind in SCALE_TYPES:
        low, high = question_bounds(question) or (0, 0)
        fits = isinstance(value, int) and not isinstance(value, bool) and low <= value <= high
    elif kind in SELECT_TYPES:
        fits = isinstance(value, Mapping) and ('code' in value or 'codes' in value or 'other' in value)
    elif kind == OPEN_TEXT:
        fits = isinstance(value, str) and bool(value)
    elif kind == CONSENT:
        fits = value is True
    elif kind == MATRIX:
        fits = isinstance(value, Mapping) and isinstance(value.get('rows'), Mapping) and bool(value['rows'])
    else:
        fits = kind == CONTACT and isinstance(value, Mapping) and bool(value)
    return value if fits else None


def _count_keys(question: Mapping[str, Any], value: Any) -> list[str]:
    if question['type'] in SCALE_TYPES:
        return [str(value)]
    if question['type'] in SELECT_TYPES:
        codes = list(value.get('codes') or []) + ([value['code']] if 'code' in value else [])
        return codes + ([OTHER_CODE] if value.get('other') else [])
    return []


@dataclass
class _Tally:
    question: Mapping[str, Any]
    shown: int = 0
    answered: int = 0
    #: Answers to a revision where this question had another type or range: never read on the current one.
    earlier: int = 0
    counts: dict[str, int] = field(default_factory=dict)
    latest: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    other_latest: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    #: A matrix's answers per row code, then per column code.
    cells: dict[str, dict[str, int]] = field(default_factory=dict)

    def add(self, row: ResultRow, asked: Mapping[str, Any] | None = None) -> None:
        """Count ``row`` (``asked``: the question as the row's own revision had it, None when that is this one)."""
        qid = self.question['id']
        if asked is not None and answer_shape(asked) != answer_shape(self.question):
            self.earlier += int(row.answers.get(qid) is not None)
            return
        if qid in row.path or qid in row.answers:
            self.shown += 1
        value = _fitting(self.question, row.answers.get(qid))
        if value is None:
            return
        self.answered += 1
        for key in _count_keys(self.question, value):
            self.counts[key] = self.counts.get(key, 0) + 1
        if self.question['type'] == MATRIX and isinstance(value, Mapping) and isinstance(value.get('rows'), Mapping):
            for code, column in value['rows'].items():
                row_cells = self.cells.setdefault(str(code), {})
                row_cells[str(column)] = row_cells.get(str(column), 0) + 1
        entry = {'response_id': row.response_id, 'created_at': row.created_at, 'is_test': row.is_test}
        if row.sentiment:
            entry['sentiment'] = row.sentiment
        if self.question['type'] == OPEN_TEXT:
            self.latest.append((row.created_at, {'value': str(value), **entry}))
        elif isinstance(value, Mapping) and isinstance(value.get('other'), str):
            self.other_latest.append((row.created_at, {'value': value['other'], **entry}))


def _newest(entries: list[tuple[str, dict[str, Any]]]) -> list[dict[str, Any]]:
    return [entry for _at, entry in sorted(entries, key=lambda pair: pair[0], reverse=True)[:LATEST_ANSWERS]]


def _ratio(part: int, whole: int) -> float:
    return round(part / whole, 4) if whole else 0.0


def _percent(part: int, whole: int) -> float:
    return round(100 * part / whole, 1) if whole else 0.0


def _scores(kind: str, histogram: Mapping[str, int]) -> dict[str, Any]:
    """The NPS (promoters 9-10 minus detractors 0-6, in points), CSAT (% of 4-5) or CES (% of 5-7) of a histogram."""
    total = sum(histogram.values())
    if kind == NPS:
        promoters = histogram.get('9', 0) + histogram.get('10', 0)
        detractors = sum(histogram.get(str(v), 0) for v in range(7))
        return {'nps': {'score': round(_percent(promoters, total) - _percent(detractors, total), 1),
                        'promoters': promoters, 'passives': total - promoters - detractors,
                        'detractors': detractors}}
    if kind == CSAT:
        satisfied = histogram.get('4', 0) + histogram.get('5', 0)
        return {'csat': {'score': _percent(satisfied, total), 'satisfied': satisfied}}
    if kind == CES:
        easy = sum(histogram.get(str(v), 0) for v in (5, 6, 7))
        return {'ces': {'score': _percent(easy, total), 'easy': easy}}
    return {}


def _scale_result(question: Mapping[str, Any], counts: Mapping[str, int]) -> dict[str, Any]:
    low, high = question_bounds(question) or (0, 0)
    histogram = {str(value): counts.get(str(value), 0) for value in range(low, high + 1)}
    total = sum(histogram.values())
    average = round(sum(int(k) * n for k, n in histogram.items()) / total, 2) if total else None
    return {'histogram': histogram, 'average': average, 'scale_max': high, **_scores(question['type'], histogram)}


def _select_result(question: Mapping[str, Any], tally: _Tally) -> dict[str, Any]:
    offered = [option['code'] for option in question.get('options') or []]
    out: dict[str, Any] = {'options': {code: tally.counts.get(code, 0) for code in offered}}
    if (question.get('other') or {}).get('enabled') or tally.counts.get(OTHER_CODE):
        out['other'] = tally.counts.get(OTHER_CODE, 0)
        out['other_latest'] = _newest(tally.other_latest)
    if question['type'] == MULTI and ((question.get('none') or {}).get('enabled') or tally.counts.get(NONE_CODE)):
        out['none'] = tally.counts.get(NONE_CODE, 0)
    removed = {code: n for code, n in tally.counts.items() if code not in offered and code not in {OTHER_CODE,
                                                                                                    NONE_CODE}}
    if removed:
        out['removed_options'] = removed
    return out


def _codes(question: Mapping[str, Any], key: str) -> list[str]:
    return [str(entry['code']) for entry in question.get(key) or [] if isinstance(entry, Mapping) and 'code' in entry]


def _row_average(row_cells: Mapping[str, int], scores: Mapping[str, int]) -> float | None:
    """The mean score of a row's answers whose column has one (None without any)."""
    scored = [(scores[column], n) for column, n in row_cells.items() if column in scores]
    total = sum(n for _score, n in scored)
    return round(sum(score * n for score, n in scored) / total, 2) if total else None


def _matrix_result(question: Mapping[str, Any], cells: Mapping[str, Mapping[str, int]]) -> dict[str, Any]:
    """Per row of the question (in its order): its answers per column and its average score; the answers naming a
    row or a column the revision no longer has, by code."""
    rows, columns = _codes(question, 'rows'), _codes(question, 'columns')
    scores = {str(entry['code']): entry['score'] for entry in question.get('columns') or []
              if isinstance(entry, Mapping) and isinstance(entry.get('score'), int) and not isinstance(entry['score'], bool)}
    out: dict[str, Any] = {'rows': [], 'scored': bool(scores)}
    removed_rows: dict[str, int] = {}
    removed_columns: dict[str, int] = {}
    for row, row_cells in cells.items():
        if row not in rows:
            removed_rows[row] = sum(row_cells.values())
            continue
        for column, n in row_cells.items():
            if column not in columns:
                removed_columns[column] = removed_columns.get(column, 0) + n
    for row in rows:
        row_cells = {column: n for column, n in (cells.get(row) or {}).items() if column in columns}
        out['rows'].append({'code': row, 'answered': sum(row_cells.values()),
                            'counts': {column: row_cells.get(column, 0) for column in columns},
                            'average': _row_average(row_cells, scores)})
    if removed_rows:
        out['removed_rows'] = removed_rows
    if removed_columns:
        out['removed_columns'] = removed_columns
    return out


def _question_result(question: Mapping[str, Any], tally: _Tally, primary: str, responses: int) -> dict[str, Any]:
    skipped = max(tally.shown - tally.answered, 0)
    out: dict[str, Any] = {
        'id': question['id'], 'type': question['type'],
        'headline': shown_as_ids(text_in(question.get('headline'), primary, primary)),
        'shown': tally.shown, 'answered': tally.answered, 'skipped': skipped,
        'not_shown': max(responses - tally.shown - tally.earlier, 0), 'drop_off_rate': _ratio(skipped, tally.shown),
    }
    if tally.earlier:
        out['earlier_version'] = tally.earlier
    kind = question['type']
    if kind in SCALE_TYPES:
        out.update(_scale_result(question, tally.counts))
    elif kind in (SINGLE, MULTI):
        out.update(_select_result(question, tally))
    elif kind == OPEN_TEXT:
        out.update({'count': tally.answered, 'latest': _newest(tally.latest)})
    elif kind == CONSENT:
        out['accepted'] = tally.answered
    elif kind == CONTACT:
        out['contacts'] = tally.answered
    elif kind == MATRIX:
        out.update(_matrix_result(question, tally.cells))
    return out


def _removed_questions(questions: Sequence[Mapping[str, Any]], rows: Sequence[ResultRow]) -> list[dict[str, Any]]:
    """Answers to question ids the current revision no longer has: id and count (their text is in the snapshots)."""
    current = {question['id'] for question in questions}
    counts: dict[str, int] = {}
    for row in rows:
        for qid in row.answers:
            if qid not in current:
                counts[qid] = counts.get(qid, 0) + 1
    return [{'id': qid, 'answered': n} for qid, n in sorted(counts.items())]


#: A day row's ``left`` counter per question: ``left:{question_id}`` (lambda/api/feedback_form_handler.py writes it).
LEFT_COUNTER_PREFIX = 'left:'


def _count(value: object) -> int:
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0


def funnel_counts(daily: Iterable[Mapping[str, Any]], *, include_test: bool) -> dict[str, Any]:
    """The widget's signals, summed over the form's daily counter rows: ``opened``, and ``left`` per question (the
    furthest question of each visit that left without submitting; the handler moves a visit's count when it goes
    further and takes it back when it submits). A question whose total is not above 0 is left out. A test row
    (``is_test``) counts only when ``include_test``."""
    opened, by_question = 0, {}
    for row in daily:
        if row.get('is_test') and not include_test:
            continue
        opened += _count(row.get('opened'))
        for name, value in row.items():
            if name.startswith(LEFT_COUNTER_PREFIX) and len(name) > len(LEFT_COUNTER_PREFIX):
                question_id = name[len(LEFT_COUNTER_PREFIX):]
                by_question[question_id] = by_question.get(question_id, 0) + _count(value)
    return {'opened': opened, 'left': {qid: n for qid, n in by_question.items() if n > 0}}


def _filled(row: ResultRow, hidden_id: str) -> bool:
    value = row.hidden.get(hidden_id)
    return isinstance(value, str) and bool(value.strip())


Declares = Callable[[ResultRow, str], bool]


def _declared_in(definition: Mapping[str, Any], revisions: Mapping[int, Mapping[str, Any]] | None) -> Declares:
    """Whether the revision a row answered declared a hidden field: its snapshot's ``hidden_fields`` (``revisions``),
    the current definition's for a revision with none kept (the current one). A row that names no revision was sent by
    a version 1 widget: revision 1."""
    def ids(source: Mapping[str, Any]) -> frozenset[str]:
        return frozenset(str(field_['id']) for field_ in source.get('hidden_fields') or []
                         if isinstance(field_, Mapping) and isinstance(field_.get('id'), str))
    current = ids(definition)
    by_revision = {int(number): ids(snapshot) for number, snapshot in (revisions or {}).items()}

    def declares(row: ResultRow, hidden_id: str) -> bool:
        number = row.revision if isinstance(row.revision, int) and not isinstance(row.revision, bool) else 1
        return hidden_id in by_revision.get(number, current)
    return declares


def _hidden_counts(ids: Sequence[str], rows: Sequence[ResultRow], declares: Declares) -> dict[str, dict[str, int]]:
    out = {}
    for hid in ids:
        asked = [row for row in rows if declares(row, hid)]
        filled = sum(_filled(row, hid) for row in asked)
        out[hid] = {'filled': filled, 'missing': len(asked) - filled}
    return out


def link_health(definition: Mapping[str, Any], rows: Sequence[ResultRow], *,
                revisions: Mapping[int, Mapping[str, Any]] | None = None) -> dict[str, Any]:
    """Whether the links that bring respondents fill the form's hidden fields: ``{responses, hidden: {id: {filled,
    missing}}, by_channel: {channel: {responses, hidden}}, warnings: [{id, kind, filled, total}]}``. A row counts
    towards a field only when the revision it answered declared it (``revisions``: the form's snapshots), so a field
    added later is never "missing" from the responses sent before it existed; ``total`` is those rows.
    ``never_filled`` once ``NEVER_FILLED_AFTER`` of them came in and none had the field; ``mostly_missing`` once
    ``MOSTLY_MISSING_AFTER`` came in and at least ``MOSTLY_MISSING_SHARE`` lacked it."""
    ids = [str(field_['id']) for field_ in definition.get('hidden_fields') or []
           if isinstance(field_, Mapping) and isinstance(field_.get('id'), str)]
    declares = _declared_in(definition, revisions)
    hidden = _hidden_counts(ids, rows, declares)
    channels: dict[str, list[ResultRow]] = {}
    for row in rows:
        channels.setdefault(row.channel if row.channel in CHANNELS else UNKNOWN_CHANNEL, []).append(row)
    warnings = []
    for hid, counts in hidden.items():
        total = counts['filled'] + counts['missing']
        if total >= NEVER_FILLED_AFTER and counts['filled'] == 0:
            warnings.append({'id': hid, 'kind': 'never_filled', 'filled': 0, 'total': total})
        elif total >= MOSTLY_MISSING_AFTER and counts['missing'] >= MOSTLY_MISSING_SHARE * total:
            warnings.append({'id': hid, 'kind': 'mostly_missing', 'filled': counts['filled'], 'total': total})
    return {'responses': len(rows), 'hidden': hidden,
            'by_channel': {name: {'responses': len(subset), 'hidden': _hidden_counts(ids, subset, declares)}
                           for name, subset in sorted(channels.items())},
            'warnings': warnings}


Asked = Callable[[ResultRow], Mapping[str, Mapping[str, Any]] | None]


def _asked_in(revisions: Mapping[int, Mapping[str, Any]] | None) -> Asked:
    """The questions (by id) of the revision a row answered, from ``revisions``; None when no snapshot is kept for it
    (the current revision has none). A row that names no revision was sent by a version 1 widget: revision 1."""
    by_revision = {int(number): {q['id']: q for q in definition.get('questions') or []
                                 if isinstance(q, Mapping) and isinstance(q.get('id'), str)}
                   for number, definition in (revisions or {}).items()}

    def asked(row: ResultRow) -> Mapping[str, Mapping[str, Any]] | None:
        number = row.revision if isinstance(row.revision, int) and not isinstance(row.revision, bool) else 1
        return by_revision.get(number)
    return asked


def tally_results(definition: Mapping[str, Any], rows: Iterable[ResultRow], funnel: Mapping[str, Any] | None = None,
                  *, revisions: Mapping[int, Mapping[str, Any]] | None = None,
                  test_responses: int | None = None) -> dict[str, Any]:
    """``{responses, test_responses, last_response_at, questions, endings, hidden, removed_questions, funnel,
    link_health}``.

    ``revisions``: the form's earlier revisions' definitions by number (its snapshots), so each row is scored against
    its own. ``test_responses``: the test responses the view admits, counted whether or not ``rows`` include them
    (the page says how many it left out); by default the test rows among ``rows``. ``funnel``: ``funnel_counts``' sums
    for the view, or None when there are none for it (answered as ``null``)."""
    primary = str(definition.get('language') or 'en')
    questions = [question for question in definition.get('questions') or [] if isinstance(question, Mapping)]
    tallies = [_Tally(question) for question in questions]
    endings = {ending['id']: 0 for ending in definition.get('endings') or []}
    hidden = {hidden['id']: 0 for hidden in definition.get('hidden_fields') or []}
    asked_in = _asked_in(revisions)
    kept = list(rows)
    for row in kept:
        asked = asked_in(row)
        for tally in tallies:
            tally.add(row, None if asked is None else asked.get(tally.question['id']))
        if row.ending_id in endings:
            endings[str(row.ending_id)] += 1
        for hid in row.hidden:
            if hid in hidden:
                hidden[hid] += 1
    return {
        'responses': len(kept),
        'test_responses': sum(row.is_test for row in kept) if test_responses is None else test_responses,
        'last_response_at': max((row.created_at for row in kept), default=None),
        'questions': [_question_result(q, t, primary, len(kept)) for q, t in zip(questions, tallies, strict=True)],
        'endings': endings, 'hidden': hidden, 'removed_questions': _removed_questions(questions, kept),
        'funnel': None if funnel is None else {**funnel, 'completed': len(kept)},
        'link_health': link_health(definition, kept, revisions=revisions),
    }


# ── The forms list's headline figure ───────────────────────────────────────────────────────────────────────────

def _measuring_question(definition: Mapping[str, Any]) -> Mapping[str, Any] | None:
    return next((q for q in definition.get('questions') or [] if isinstance(q, Mapping) and q.get('type') in
                 (NPS, CSAT, CES, RATING)), None)


def headline(definition: Mapping[str, Any]) -> Callable[[Iterable[ResultRow]], dict[str, Any] | None]:
    """The form card's headline figure over rows: its first measuring question's NPS score, CSAT %, or average
    (rating, CES), with the count it is over; None for a form with no such question or no answer to it."""
    question = _measuring_question(definition)

    def figure(rows: Iterable[ResultRow]) -> dict[str, Any] | None:
        if question is None:
            return None
        counts: dict[str, int] = {}
        for row in rows:
            value = _fitting(question, row.answers.get(question['id']))
            if value is not None:
                counts[str(value)] = counts.get(str(value), 0) + 1
        total = sum(counts.values())
        if not total:
            return None
        result = _scale_result(question, counts)
        kind = question['type']
        value = result[kind]['score'] if kind in (NPS, CSAT) else result['average']
        return {'question_id': question['id'], 'type': kind, 'value': value, 'count': total,
                'scale_max': result['scale_max']}
    return figure
