"""A version 2 form's responses as a CSV file (``GET /feedback-forms/{id}/responses?format=csv``, docs/feedback-forms.md
"Results and responses"), in one of two layouts:

- ``familiar`` (the default since 7.06.00): what Excel and Sheets open as it is. A UTF-8 BOM, one header row
  (``Submission ID``, ``Submitted On`` in ISO 8601 UTC, ``Locale``, ``Tags``, the hidden fields by label, then one
  column per question by its primary-language headline, a matrix one per row and a contact question one per field it
  shows), choices joined with ``;`` and an "Other" text as ``Other: …``; ``ids`` adds a second header row of ids.
- ``detailed``: 7.04.00's layout, kept unchanged for the scripts that read it (no BOM; two header rows).

Every cell, a header included, is kept from starting a spreadsheet formula (``csv_cell``). A headline's placeholders
read ``[id]`` (shared/forms_recall.py), never a respondent's value. Pure: the rows come in, the text goes out.
"""
from __future__ import annotations

import csv
import io
import re
import unicodedata
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, Final

from shared import forms_v2 as fv2
from shared.forms_v2_responses import headline_of, matrix_label
from shared.forms_v2_results import ResultRow

__all__ = ['LAYOUTS', 'csv_filename', 'detailed_csv', 'familiar_csv']

LAYOUTS: Final = ('familiar', 'detailed')
#: What a spreadsheet reads as the start of a formula.
_FORMULA_START: Final = ('=', '+', '-', '@', '\t', '\r')
BOM: Final = '\ufeff'
#: A contact question's columns (familiar), by field.
CONTACT_HEADERS: Final = {'name': 'Name', 'email': 'Email', 'phone': 'Phone', 'company': 'Company'}
#: The localized "Other" and "None of these" (the widget's own words, lambda/api/static/feedback-widget.js STRINGS).
OTHER_WORDS: Final = {'en': 'Other', 'es': 'Otro', 'fr': 'Autre', 'de': 'Sonstiges', 'pt': 'Outro', 'ja': 'その他',
                      'zh': '其他', 'ko': '기타', 'pl': 'Inne'}
NONE_WORDS: Final = {'en': 'None of these', 'es': 'Ninguna de estas', 'fr': 'Aucune de ces réponses',
                     'de': 'Nichts davon', 'pt': 'Nenhuma destas', 'ja': 'どれも当てはまらない', 'zh': '以上都不是',
                     'ko': '해당 없음', 'pl': 'Żadne z powyższych'}
_MAX_SLUG: Final = 60


def csv_cell(value: object) -> str:
    """A cell as text, never a spreadsheet formula (a leading ``=``, ``+``, ``-``, ``@`` or control is quoted off)."""
    text = '' if value is None else str(value)
    return f"'{text}" if text.startswith(_FORMULA_START) else text


def _write(rows: Sequence[Sequence[object]]) -> str:
    out = io.StringIO()
    writer = csv.writer(out)
    for row in rows:
        writer.writerow([csv_cell(cell) for cell in row])
    return out.getvalue()


def _primary(definition: Mapping[str, Any]) -> str:
    return str(definition.get('language') or fv2.DEFAULT_LOCALE)


def _answered(definition: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    """The questions that take an answer (a statement has none), in the form's order."""
    return [q for q in definition.get('questions') or [] if isinstance(q, Mapping) and q.get('type') != fv2.STATEMENT]


# ── detailed (7.04.00's layout) ─────────────────────────────────────────────────────────────────────────────────

def _detailed_answer(question: Mapping[str, Any], value: object, primary: str) -> str:
    if isinstance(value, Mapping) and question.get('type') in fv2.SELECT_TYPES:
        labels = {o['code']: fv2.text_in(o.get('label'), primary, primary) or o['code']
                  for o in question.get('options') or []}
        codes = list(value.get('codes') or []) + ([value['code']] if 'code' in value else [])
        parts = [labels.get(code, code) for code in codes]
        return '; '.join([*parts, *([f"{fv2.OTHER_CODE}: {value['other']}"] if value.get('other') else [])])
    if isinstance(value, Mapping) and question.get('type') == fv2.MATRIX:
        return '; '.join(f'{matrix_label(question, "rows", str(row), primary)}: '
                         f'{matrix_label(question, "columns", str(column), primary)}'
                         for row, column in (value.get('rows') or {}).items())
    if isinstance(value, Mapping):
        return '; '.join(f'{key}: {item}' for key, item in value.items())
    return '' if value is None else str(value)


def detailed_csv(definition: Mapping[str, Any], rows: Sequence[ResultRow]) -> str:
    """One row per response: time, ids, test flag, revision, language, ending, one column per question (labels in
    the first header row, ids in the second), then the hidden fields."""
    primary = _primary(definition)
    questions = _answered(definition)
    hidden_ids = [field_['id'] for field_ in definition.get('hidden_fields') or []]
    fixed = ['created_at', 'response_id', 'is_test', 'revision', 'language', 'ending_id']
    # The header rows are the author's text (a headline): no cell of the file, header or answer, is ever a formula.
    labels = [*fixed, *(fv2.text_in(q.get('headline'), primary, primary) for q in questions),
              *(f'hidden: {hid}' for hid in hidden_ids)]
    lines: list[Sequence[object]] = [labels, [*fixed, *(q['id'] for q in questions),
                                              *(f'hidden.{hid}' for hid in hidden_ids)]]
    lines.extend([row.created_at, row.response_id, str(row.is_test).lower(), row.revision, row.language,
                  row.ending_id, *(_detailed_answer(q, row.answers.get(q['id']), primary) for q in questions),
                  *(row.hidden.get(hid, '') for hid in hidden_ids)] for row in rows)
    return _write(lines)


# ── familiar ────────────────────────────────────────────────────────────────────────────────────────────────────

def utc_time(value: str) -> str:
    """An ISO 8601 time as UTC with seconds (``2026-11-20T09:30:00Z``); a value that reads as none is kept."""
    try:
        moment = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return value
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%SZ')


def _localized(words: Mapping[str, str], own: object, primary: str) -> str:
    return fv2.text_in(own, primary, primary) or words.get(primary, words['en'])


def _choice_text(question: Mapping[str, Any], value: object, primary: str) -> str:
    """A choice's labels in the primary language joined with ``;``, its "Other" text as ``Other: …`` last."""
    if not isinstance(value, Mapping):
        return ''
    labels = {o['code']: fv2.text_in(o.get('label'), primary, primary) or o['code']
              for o in question.get('options') or [] if isinstance(o, Mapping)}
    labels[fv2.NONE_CODE] = labels.get(fv2.NONE_CODE) or _localized(NONE_WORDS, (question.get('none') or {}).get('label'),
                                                                    primary)
    codes = [*(value.get('codes') or []), *([value['code']] if 'code' in value else [])]
    parts = [labels.get(str(code), str(code)) for code in codes]
    if isinstance(value.get('other'), str) and value['other']:
        other = _localized(OTHER_WORDS, (question.get('other') or {}).get('label'), primary)
        parts.append(f"{other}: {value['other']}")
    return ';'.join(parts)


def _plain(_question: Mapping[str, Any], value: object, _primary: str) -> str:
    return '' if value is None or isinstance(value, Mapping) else str(value)


def _consent(_question: Mapping[str, Any], value: object, _primary: str) -> str:
    return 'Yes' if value is True else ''


_ANSWER_TEXT: Final[Mapping[str, Callable[[Mapping[str, Any], object, str], str]]] = {
    fv2.SINGLE: _choice_text, fv2.MULTI: _choice_text, fv2.CONSENT: _consent,
}


def _columns(question: Mapping[str, Any], primary: str) -> list[tuple[str, str, Callable[[object], str]]]:
    """A question's columns: ``(header, id, cell of an answer)``, one per matrix row and per contact field shown."""
    headline, qid = headline_of(question, primary), str(question['id'])
    if question.get('type') == fv2.MATRIX:
        return [(f'{headline} - {matrix_label(question, "rows", code, primary)}', f'{qid}.{code}',
                 lambda value, code=code: _matrix_cell(question, value, code, primary))
                for code in (str(row['code']) for row in question.get('rows') or [] if isinstance(row, Mapping))]
    if question.get('type') == fv2.CONTACT:
        fields = question.get('fields') or {}
        return [(f'{headline} - {CONTACT_HEADERS[name]}', f'{qid}.{name}',
                 lambda value, name=name: str(value.get(name, '')) if isinstance(value, Mapping) else '')
                for name in fv2.CONTACT_FIELDS if (fields.get(name) or {}).get('show')]
    text = _ANSWER_TEXT.get(str(question.get('type')), _plain)
    return [(headline, qid, lambda value: text(question, value, primary))]


def _matrix_cell(question: Mapping[str, Any], value: object, row: str, primary: str) -> str:
    rows = value.get('rows') if isinstance(value, Mapping) else None
    column = rows.get(row) if isinstance(rows, Mapping) else None
    return matrix_label(question, 'columns', str(column), primary) if isinstance(column, str) else ''


def familiar_csv(definition: Mapping[str, Any], rows: Sequence[ResultRow], *, tags: Sequence[str] = (),
                 ids: bool = False) -> str:
    """The familiar layout: a BOM, the header row (and with ``ids`` the row of ids), one row per response."""
    primary = _primary(definition)
    hidden = [field_ for field_ in definition.get('hidden_fields') or [] if isinstance(field_, Mapping)]
    columns = [(question, column) for question in _answered(definition) for column in _columns(question, primary)]
    header = ['Submission ID', 'Submitted On', 'Locale', 'Tags',
              *(str(field_.get('label') or field_['id']) for field_ in hidden), *(c[0] for _q, c in columns)]
    lines: list[Sequence[object]] = [header]
    if ids:
        lines.append(['submission_id', 'submitted_on', 'locale', 'tags', *(f"hidden.{field_['id']}" for field_ in hidden),
                      *(c[1] for _q, c in columns)])
    form_tags = [str(tag) for tag in tags if str(tag)]
    for row in rows:
        row_tags = [*form_tags, *(['test'] if row.is_test else [])]
        lines.append([row.response_id, utc_time(row.created_at), row.language or '', ';'.join(row_tags),
                      *(row.hidden.get(field_['id'], '') for field_ in hidden),
                      *(cell(row.answers.get(question['id'])) for question, (_h, _i, cell) in columns)])
    return BOM + _write(lines)


#: Letters NFD does not split into a base and a mark (the SPA's frontend/src/pages/FeedbackForms/model/codes.ts).
_FOLDS: Final = str.maketrans({'ł': 'l', 'Ł': 'l', 'ß': 'ss', 'ø': 'o', 'Ø': 'o', 'æ': 'ae', 'Æ': 'ae', 'œ': 'oe',
                               'Œ': 'oe', 'đ': 'd', 'Đ': 'd', '\u0131': 'i', 'þ': 'th', 'ð': 'd'})


def _slug(name: str) -> str:
    """A form's name as a file name's part, as the SPA names the file it downloads (frontend/src/api/
    feedbackFormsCsv.ts: the browser cannot read this header): accents folded, lower case, each run of anything but
    ``a-z`` and ``0-9`` one ``-``, at most 60 characters."""
    folded = ''.join(ch for ch in unicodedata.normalize('NFD', name.translate(_FOLDS))
                     if not unicodedata.category(ch).startswith('M'))
    words = [word for word in re.split(r'[^a-z0-9]+', folded.lower()) if word]
    return '-'.join(words)[:_MAX_SLUG].rstrip('-')


def csv_filename(name: object, form_id: str, today: datetime, layout: str) -> str:
    """``<form-name-slug>-responses-<yyyy-mm-dd>.csv`` (the form id without a slug); detailed's 7.04.00 name."""
    if layout == 'detailed':
        return f'{form_id}-responses.csv'
    slug = _slug(name if isinstance(name, str) else '') or form_id
    return f'{slug}-responses-{today.astimezone(UTC).strftime("%Y-%m-%d")}.csv'
