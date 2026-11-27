"""A survey export as an imported Feedback Form v2 (the import wizard, docs/import-wizard.md).

``infer_form`` turns the detected columns of another survey tool's export (shared/import_detect.py) into a form
definition (shared/forms_v2.py ``validate_definition`` passes it) and the import mapping its rows are read with: a
choice column becomes a single select whose options are its distinct values, a multiple choice a multi select, an NPS
column ``nps``, a CSAT column ``csat``, a rating a 5- or 10-point rating, a matrix cell (``Row -- value; …``) a
``matrix`` (7.61.00), open text ``open_text``; the first date and the first id column date and key each response, the
first channel column becomes the hidden field ``channel`` (a second one of each is left out, named in ``problems``, so
the mapping always passes ``check_mapping``); personal data (``email``, ``name``), links and ignored columns are left
out.

``row_answers`` reads one row through that mapping into a response (shared/forms_v2_responses.py
``validate_imported``: types and ranges, never the logic path, which was the other tool's). Its refusals carry the
codes of the form API (``answer_invalid``, ``empty_response``…) plus ``date_invalid`` for a date no order reads.

Pure: no AWS client, no I/O, no clock.
"""
from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from shared import forms_v2 as fv2
from shared import forms_v2_responses as fresp
from shared.exceptions import ValidationError
from shared.import_dates import DEFAULT_DATE_ORDER, normalise_date
from shared.import_detect import as_integer, split_choices, split_matrix

__all__ = ['ImportedRow', 'infer_form', 'row_answers']

DATE_TARGET: Final = 'date'
ID_TARGET: Final = 'id'
IGNORE_TARGET: Final = 'ignore'
HIDDEN_TARGET_PREFIX: Final = 'hidden:'
CHANNEL_FIELD: Final = 'channel'
ENDING_ID: Final = fv2.V1_ENDING_ID   # (the thank-you ending a version 1 form migrates to)
#: The id an imported row is kept under at most (``IngestMessage.csv_row_id``'s bound).
MAX_ROW_ID_CHARS: Final = 256
DATE_INVALID: Final = 'date_invalid'
#: What a ``consent`` cell reads as given, in the app's languages.
_YES: Final = frozenset({'yes', 'y', 'true', '1', 'x', 'si', 'sí', 'tak', 'oui', 'ja', 'sim', '✓'})
_KIND_QUESTIONS: Final[Mapping[str, dict[str, Any]]] = {
    'open_text': {'type': fv2.OPEN_TEXT, 'long': True, 'input_type': 'text'},
    'nps_0_10': {'type': fv2.NPS},
    'csat': {'type': fv2.CSAT},
    'rating_1_5': {'type': fv2.RATING, 'scale': 'star', 'range': 5},
    'rating_1_10': {'type': fv2.RATING, 'scale': 'number', 'range': 10},
}
_CODE_CHARS: Final = 40


@dataclass(frozen=True)
class ColumnChoice:
    """A column as the wizard sends it: its header, the kind a person confirmed and its distinct values (a choice's
    options, a multiple choice's answers, a matrix's cells), read over the whole file."""

    header: str
    kind: str
    values: Sequence[str] = ()


@dataclass
class InferredForm:
    """The definition, the import mapping (``{header: question id | date | id | hidden:<id> | ignore}``) and the
    columns that could not become a question, each with its reason code."""

    definition: dict[str, Any]
    mapping: dict[str, str]
    problems: list[dict[str, str]] = field(default_factory=list)


def slug(text: str, limit: int = _CODE_CHARS) -> str:
    """``text`` as ``[a-z0-9_]``: accents folded, any other run of characters one ``_``, at most ``limit``."""
    plain = unicodedata.normalize('NFKD', text.replace('ł', 'l').replace('Ł', 'L'))
    ascii_text = ''.join(ch for ch in plain if not unicodedata.combining(ch)).lower()
    return re.sub(r'[^a-z0-9]+', '_', ascii_text).strip('_')[:limit].strip('_')


def _unique(base: str, taken: set[str], limit: int) -> str:
    candidate, number = base[:limit], 2
    while candidate in taken:
        suffix = f'_{number}'
        candidate, number = f'{base[:limit - len(suffix)]}{suffix}', number + 1
    taken.add(candidate)
    return candidate


def _coded(labels: Sequence[str], fallback: str) -> list[dict[str, Any]]:
    """``{code, label}`` of each label: its slug (``{fallback}_{n}`` for one with no letter or digit), unique."""
    taken: set[str] = set()
    return [{'code': _unique(slug(label) or f'{fallback}_{index}', taken, _CODE_CHARS), 'label': label[:fv2.LABEL_CHARS]}
            for index, label in enumerate(labels, start=1)]


def _distinct(values: Sequence[str]) -> list[str]:
    seen: dict[str, str] = {}
    for value in values:
        if value.strip():
            seen.setdefault(value.strip().casefold(), value.strip())
    return list(seen.values())


def _matrix_parts(values: Sequence[str]) -> tuple[list[str], list[str]]:
    pairs = [pair for value in values for pair in (split_matrix(value) or [])]
    return _distinct([row for row, _ in pairs]), _distinct([column for _, column in pairs])


def _choice_question(column: ColumnChoice, multi: bool) -> dict[str, Any] | str:
    labels = _distinct([part for value in column.values for part in split_choices(value)[0]] if multi
                       else list(column.values))
    if not labels:
        return 'no_values'
    if len(labels) > fv2.MAX_OPTIONS:
        return 'too_many_options'
    return {'type': fv2.MULTI if multi else fv2.SINGLE, 'options': _coded(labels, 'option')}


def _matrix_question(column: ColumnChoice) -> dict[str, Any] | str:
    rows, columns = _matrix_parts(column.values)
    if not rows or len(columns) < fv2.MIN_MATRIX_COLUMNS:
        return 'no_values'
    if len(rows) > fv2.MAX_MATRIX_ROWS or len(columns) > fv2.MAX_MATRIX_COLUMNS:
        return 'matrix_too_large'
    return {'type': fv2.MATRIX, 'rows': _coded(rows, 'row'), 'columns': _coded(columns, 'col')}


def _question_shape(column: ColumnChoice) -> dict[str, Any] | str | None:
    """The question a column becomes (without id and headline), a problem code, or None for no question."""
    if column.kind in _KIND_QUESTIONS:
        return dict(_KIND_QUESTIONS[column.kind])
    if column.kind in ('choice', 'multi_choice'):
        return _choice_question(column, column.kind == 'multi_choice')
    if column.kind == 'matrix_cell':
        return _matrix_question(column)
    return None


#: A second date, id or channel column is left out with this code (the Confirm step says so): a response has one
#: date, one id and one channel, and ``check_mapping`` takes each target once.
_SECOND_COLUMN: Final[Mapping[str, str]] = {'date': 'extra_date', 'id': 'extra_id', 'channel': 'extra_channel'}


def _non_question_target(kind: str, hidden: list[dict[str, str]], mapping: Mapping[str, str]) -> tuple[str, str | None]:
    """The target of a column that is no question, and the problem code of a second date, id or channel column (the
    first one keeps the target)."""
    targets = {'date': DATE_TARGET, 'id': ID_TARGET, 'channel': f'{HIDDEN_TARGET_PREFIX}{CHANNEL_FIELD}'}
    target = targets.get(kind)
    if target is None:
        return IGNORE_TARGET, None
    if target in mapping.values():
        return IGNORE_TARGET, _SECOND_COLUMN[kind]
    if kind == 'channel':
        hidden.append({'id': CHANNEL_FIELD, 'label': 'Channel'})
    return target, None


def infer_form(columns: Sequence[ColumnChoice], language: str) -> InferredForm:
    """The imported form of ``columns`` in ``language`` (see the module docstring). A ``ValidationError``
    (``no_questions``) when no column becomes a question; at most 30 questions, the rest named in ``problems``."""
    primary = language if language in fv2.FORM_LOCALES else fv2.DEFAULT_LOCALE
    questions: list[dict[str, Any]] = []
    hidden: list[dict[str, str]] = []
    mapping: dict[str, str] = {}
    problems: list[dict[str, str]] = []
    ids: set[str] = set()
    for column in columns:
        shape = _question_shape(column)
        if shape is None or isinstance(shape, str):
            target, problem = (_non_question_target(column.kind, hidden, mapping) if shape is None
                               else (IGNORE_TARGET, shape))
            mapping[column.header] = target
            if problem is not None:
                problems.append({'header': column.header, 'code': problem})
            continue
        if len(questions) >= fv2.MAX_QUESTIONS:
            mapping[column.header] = IGNORE_TARGET
            problems.append({'header': column.header, 'code': 'too_many_questions'})
            continue
        qid = 'q_' + _unique(slug(column.header) or f'col_{len(questions) + 1}', ids, _CODE_CHARS)
        questions.append({'id': qid, 'headline': {primary: column.header[:fv2.HEADLINE_CHARS]}, 'required': False,
                          **{key: _localised(value, primary) for key, value in shape.items()}})
        mapping[column.header] = qid
    if not questions:
        raise ValidationError('None of the columns can be a question: choose a kind for one', code='no_questions')
    definition = {
        'language': primary, 'languages': [primary], 'welcome': {'enabled': False}, 'questions': questions,
        'hidden_fields': hidden, 'endings': [{'id': ENDING_ID, 'title': {primary: fv2.THANK_YOU[primary]}}],
    }
    return InferredForm(fv2.validate_definition(definition), mapping, problems)


def _localised(value: Any, primary: str) -> Any:
    """A shape's option, row and column labels as ``{primary: label}`` (every other value as it is)."""
    if isinstance(value, list):
        return [{**entry, 'label': {primary: entry['label']}} if isinstance(entry, dict) and 'label' in entry
                else entry for entry in value]
    return value


# ── One row ─────────────────────────────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ImportedRow:
    """A row read as a response: the checked response, its date (ISO 8601, UTC), its own id ('' when none) and
    whether the date is the row's own (``dated``) or the call's default."""

    response: fresp.Response
    created_at: str
    row_id: str
    dated: bool = False


def _refuse(message: str, code: str, question_id: str | None = None) -> ValidationError:
    return ValidationError(message, code=code, details={'question_id': question_id} if question_id else None)


def _by_label(entries: Sequence[Mapping[str, Any]], label: str, primary: str) -> str | None:
    wanted = label.strip().casefold()
    for entry in entries:
        if fv2.text_in(entry.get('label'), primary, primary).strip().casefold() == wanted:
            return str(entry['code'])
    return None


def _choice_answer(question: Mapping[str, Any], text: str, primary: str) -> Any:
    options = question.get('options') or []
    if question['type'] == fv2.SINGLE:
        code = _by_label(options, text, primary)
        return {'code': code} if code is not None else {'code': text}
    codes = [_by_label(options, part, primary) or part for part in split_choices(text)[0]]
    return {'codes': codes}


def _matrix_answer(question: Mapping[str, Any], text: str, primary: str) -> Any:
    pairs = split_matrix(text)
    if pairs is None:
        return {'rows': {'?': text}}
    rows = {(_by_label(question.get('rows') or [], row, primary) or row):
            (_by_label(question.get('columns') or [], column, primary) or column) for row, column in pairs}
    return {'rows': rows}


def _cell_answer(question: Mapping[str, Any], text: str, primary: str) -> Any:
    """A cell as the answer a widget would have sent (an unknown option keeps its text, which the check refuses)."""
    kind = question['type']
    if kind in fv2.SCALE_TYPES:
        number = as_integer(text)
        return number if number is not None else text
    if kind in fv2.SELECT_TYPES:
        return _choice_answer(question, text, primary)
    if kind == fv2.MATRIX:
        return _matrix_answer(question, text, primary)
    if kind == fv2.CONSENT:
        return text.strip().casefold() in _YES or None
    return text


def row_answers(definition: Mapping[str, Any], mapping: Mapping[str, str], row: Mapping[str, Any], *,
                default_at: str, date_order: str = DEFAULT_DATE_ORDER) -> ImportedRow:
    """One row through ``mapping`` as a checked response (``ValidationError`` with the refusal's code otherwise).
    ``default_at``: the date of a row with no date column, or an empty one."""
    primary = str(definition.get('language'))
    questions = {question['id']: question for question in definition.get('questions') or []}
    answers: dict[str, Any] = {}
    hidden: dict[str, str] = {}
    created_at, row_id, dated = default_at, '', False
    for header, target in mapping.items():
        raw = row.get(header)
        text = raw.strip() if isinstance(raw, str) else ('' if raw is None else str(raw).strip())
        if not text:
            continue
        if target == DATE_TARGET:
            created_at, dated = normalise_date(text, date_order) or '', True
            if not created_at:
                raise _refuse(f'"{header}" is not a date: {text[:40]}', DATE_INVALID)
        elif target == ID_TARGET:
            row_id = text[:MAX_ROW_ID_CHARS]
        elif target.startswith(HIDDEN_TARGET_PREFIX):
            hidden[target.removeprefix(HIDDEN_TARGET_PREFIX)] = text
        elif target in questions:
            answers[target] = _cell_answer(questions[target], text, primary)
    return ImportedRow(fresp.validate_imported(definition, answers, hidden), created_at, row_id, dated)


def check_mapping(definition: Mapping[str, Any], mapping: object) -> dict[str, str]:
    """An import's ``mapping`` (``{header: target}``): every target a question of the form, one of its hidden
    fields, ``date``, ``id`` or ``ignore``, and no question, ``date`` or ``id`` twice. A 400 naming the first wrong."""
    if not isinstance(mapping, Mapping) or not mapping or len(mapping) > fv2.MAX_QUESTIONS * 10:
        raise ValidationError('mapping must be an object of {header: target}', code='mapping_invalid')
    questions = {question['id'] for question in definition.get('questions') or []}
    hidden = {f'{HIDDEN_TARGET_PREFIX}{entry["id"]}' for entry in definition.get('hidden_fields') or []}
    allowed = questions | hidden | {DATE_TARGET, ID_TARGET, IGNORE_TARGET}
    seen: set[str] = set()
    out: dict[str, str] = {}
    for header, target in mapping.items():
        if not isinstance(header, str) or not isinstance(target, str) or target not in allowed:
            raise ValidationError(f'mapping: "{str(target)[:60]}" is not a question, hidden field, date, id or ignore',
                                  code='mapping_invalid')
        if target != IGNORE_TARGET and target in seen:
            raise ValidationError(f'mapping: two columns go to {target}', code='mapping_invalid')
        seen.add(target)
        out[header] = target
    if not seen & questions:
        raise ValidationError('mapping: no column answers a question of this form', code='mapping_invalid')
    return out
