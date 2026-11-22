"""The import wizard's server side (7.67.00, docs/import-wizard.md): ``POST /scrapers/manual/detect`` and the
``mapping`` of ``POST /scrapers/manual/csv-upload``.

``detect_view`` answers a detect request: the sample read as a table (shared/import_detect.py ``parse_sample``; an
XLSX's first sheet through shared/library_extract.py ``xlsx_rows``, whose rows the answer also carries, since the
browser cannot read a workbook), every column's kind with its confidence and reasons, the suggested target
(``reviews`` or ``survey``), the suggested mapping (``{header: kind}``) and, for a survey, the imported form inferred
from it (shared/import_survey.py ``infer_form``). A request may send the kinds a person chose (``mapping``) and every
distinct value of the choice, multiple-choice and matrix columns over the whole file (``values``), so the form's
options are the file's, not only the sample's. Deterministic and free: nothing is stored, no model is called.

``reviews_fields`` reads one CSV row through a wizard mapping as the CSV import's fields
(lambda/api/manual_import_handler.py): the open-text columns are the text (several are joined under their headers), a
1-5 rating or CSAT is the rating, a 1-10 rating is halved up to 1-5, an NPS stays a metadata value (never a rating:
the queue refuses a 0), the date is normalised (shared/import_dates.py), a choice column mapped to ``dimension:<key>``
is that dimension, every other kept column a metadata value under its header; personal data and ignored columns are
dropped.

Pure: no AWS client, no I/O, no clock.
"""
from __future__ import annotations

import base64
import binascii
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from shared import forms_v2 as fv2
from shared.csv_columns import DIMENSION_PREFIX
from shared.dimension_config import DIMENSION_KEY_RE
from shared.exceptions import ValidationError
from shared.import_dates import DATE_ORDERS, DEFAULT_DATE_ORDER, normalise_date
from shared.import_detect import (
    DELIMITERS,
    FORMATS,
    KINDS,
    MAX_SAMPLE_BYTES,
    PERSONAL_KINDS,
    Column,
    Table,
    as_integer,
    column_cells,
    detect_columns,
    parse_sample,
    rows_table,
    suggest_target,
)
from shared.import_survey import ColumnChoice, infer_form
from shared.library_extract import ExtractionError, xlsx_rows

__all__ = ['check_reviews_mapping', 'detect_view', 'reviews_fields']

#: The rows of a workbook the detect answer carries (the wizard imports at most this many from one).
MAX_TABLE_ROWS: Final = 20_000
#: The kinds whose distinct values a request may send (``values``), and the bounds on them.
VALUE_KINDS: Final = frozenset({'choice', 'multi_choice', 'matrix_cell'})
MAX_VALUE_COLUMNS: Final = 50
MAX_VALUES_PER_COLUMN: Final = 500
MAX_VALUE_CHARS: Final = 1000
_RATING_KINDS: Final = ('rating_1_5', 'csat', 'rating_1_10')
_SCALE_KINDS: Final = frozenset({*_RATING_KINDS, 'nps_0_10'})
_METADATA_KINDS: Final = frozenset({'choice', 'multi_choice', 'matrix_cell', *_SCALE_KINDS})
_FIVE: Final = 5
_TEN: Final = 10


def _sample_table(body: Mapping[str, Any]) -> tuple[Table, str, bool]:
    """``(table, format, the rows travel back)`` of a detect body's ``format`` and ``sample``."""
    fmt, sample = body.get('format'), body.get('sample')
    if fmt not in FORMATS:
        raise ValidationError(f'format must be one of: {", ".join(FORMATS)}', code='format_invalid')
    if not isinstance(sample, str) or not sample.strip():
        raise ValidationError('sample is required: the start of the file', code='sample_required')
    if fmt == 'xlsx':
        try:
            data = base64.b64decode(sample, validate=True)
        except (binascii.Error, ValueError) as e:
            raise ValidationError('sample must be the workbook in base64', code='sample_invalid') from e
        if len(data) > MAX_SAMPLE_BYTES:
            raise ValidationError('This workbook is larger than 256 KB: save it as CSV and import that',
                                  code='sample_too_large')
        try:
            return rows_table(xlsx_rows(data, MAX_TABLE_ROWS + 1)), fmt, True
        except ExtractionError as e:
            raise ValidationError(str(e), code='file_unreadable') from e
    if len(sample.encode('utf-8')) > MAX_SAMPLE_BYTES:
        raise ValidationError('sample must be at most 256 KB: send the start of the file', code='sample_too_large')
    delimiter = body.get('delimiter')
    if delimiter is not None and delimiter not in DELIMITERS:
        raise ValidationError('delimiter must be one of , ; | or a tab', code='delimiter_invalid')
    return parse_sample(fmt, sample, delimiter=delimiter, truncated=body.get('truncated') is True), fmt, False


def _chosen(body: Mapping[str, Any], headers: Sequence[str]) -> dict[str, str]:
    """The kinds a person chose (``mapping``), for headers of this file only."""
    raw = body.get('mapping')
    if raw is None:
        return {}
    if not isinstance(raw, Mapping) or len(raw) > len(headers) + 1:
        raise ValidationError('mapping must be an object of {header: kind}', code='mapping_invalid')
    out: dict[str, str] = {}
    for header, kind in raw.items():
        if kind not in KINDS:
            raise ValidationError(f'mapping: "{str(kind)[:40]}" is not a kind ({", ".join(KINDS)})',
                                  code='mapping_invalid')
        if header in headers:
            out[str(header)] = str(kind)
    return out


def _sent_values(body: Mapping[str, Any]) -> dict[str, list[str]]:
    """The distinct values the wizard read over the whole file (``values``), bounded."""
    raw = body.get('values')
    if raw is None:
        return {}
    if not isinstance(raw, Mapping) or len(raw) > MAX_VALUE_COLUMNS:
        raise ValidationError(f'values must be an object of at most {MAX_VALUE_COLUMNS} columns', code='values_invalid')
    out: dict[str, list[str]] = {}
    for header, values in raw.items():
        if not isinstance(values, list) or len(values) > MAX_VALUES_PER_COLUMN or any(
                not isinstance(value, str) or len(value) > MAX_VALUE_CHARS for value in values):
            raise ValidationError(f'values: at most {MAX_VALUES_PER_COLUMN} texts per column', code='values_invalid')
        out[str(header)] = values
    return out


def _apply_choice(column: Column, kind: str) -> Column:
    if kind == column.kind:
        return column
    reasons = [{'code': 'chosen', 'params': {}}]
    return Column(column.header, kind, 1.0, reasons, column.values, column.filled, column.date_order, column.separator)


def _date_order(body: Mapping[str, Any], columns: Sequence[Column]) -> str:
    if body.get('date_order') in DATE_ORDERS:
        return str(body['date_order'])
    return next((column.date_order for column in columns if column.kind == 'date' and column.date_order),
                DEFAULT_DATE_ORDER)


def _form(columns: Sequence[Column], table: Table, values: Mapping[str, list[str]], language: str) -> dict[str, Any]:
    choices = [ColumnChoice(column.header, column.kind,
                            values.get(column.header) or column_cells(table, column.header)
                            if column.kind in VALUE_KINDS else ())
               for column in columns]
    try:
        inferred = infer_form(choices, language)
    except ValidationError as e:
        return {'form': None, 'form_problem': e.code}
    return {'form': {'definition': inferred.definition, 'mapping': inferred.mapping, 'problems': inferred.problems},
            'form_problem': None}


def detect_view(body: Mapping[str, Any]) -> dict[str, Any]:
    """The answer of ``POST /scrapers/manual/detect`` (see the module docstring)."""
    table, fmt, rows_back = _sample_table(body)
    chosen = _chosen(body, table.headers)
    columns = [_apply_choice(column, chosen.get(column.header, column.kind)) for column in detect_columns(table)]
    language = body.get('language') if body.get('language') in fv2.FORM_LOCALES else fv2.DEFAULT_LOCALE
    target = body.get('target') if body.get('target') in ('reviews', 'survey') else suggest_target(columns)
    out: dict[str, Any] = {
        'format': fmt, 'delimiter': table.delimiter, 'headers': table.headers, 'row_count': len(table.rows),
        'columns': [column.view() for column in columns],
        'suggested': {'target': target, 'mapping': {column.header: column.kind for column in columns},
                      'date_order': _date_order(body, columns),
                      **_form(columns, table, _sent_values(body), str(language))},
    }
    if rows_back:
        out['table'] = {'headers': table.headers,
                        'rows': [[row.get(header, '') for header in table.headers] for row in table.rows[:MAX_TABLE_ROWS]],
                        'truncated': len(table.rows) > MAX_TABLE_ROWS}
    return out


# ── The CSV import's mapping ────────────────────────────────────────────────────────────────────────────────────

def check_reviews_mapping(mapping: object) -> dict[str, str]:
    """A CSV upload's wizard ``mapping`` (``{header: kind | dimension:<key>}``) with at least one open-text column.
    A 400 naming what is wrong otherwise."""
    if not isinstance(mapping, Mapping) or not mapping or len(mapping) > 200:
        raise ValidationError('mapping must be an object of {header: kind}', code='mapping_invalid')
    out: dict[str, str] = {}
    for header, kind in mapping.items():
        is_dimension = isinstance(kind, str) and kind.startswith(DIMENSION_PREFIX) and bool(
            DIMENSION_KEY_RE.match(kind.removeprefix(DIMENSION_PREFIX)))
        if not isinstance(header, str) or not (kind in KINDS or is_dimension):
            raise ValidationError(f'mapping: "{str(kind)[:40]}" is not a kind or dimension:<key>',
                                  code='mapping_invalid')
        out[header] = str(kind)
    if 'open_text' not in out.values():
        raise ValidationError('mapping: choose at least one open-text column: it is the feedback text',
                              code='mapping_no_text')
    return out


@dataclass
class ReviewFields:
    """One row as the CSV import's fields (``csv-row-v1`` reads them in this shape)."""

    text: str = ''
    source_id: str = ''
    rating: str = ''
    created_at: str = ''
    url: str = ''
    channel: str = ''
    dimensions: dict[str, str] = field(default_factory=dict)
    metadata: dict[str, str] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


def five_point(kind: str, value: str) -> str | None:
    """A rating column's value on the 1-5 scale (a 1-10 rating halved up: 9 and 10 are 5), None when out of range."""
    number = as_integer(value)
    if number is None:
        return None
    if kind == 'rating_1_10':
        return str(math.ceil(number / 2)) if 1 <= number <= _TEN else None
    return str(number) if 1 <= number <= _FIVE else None


def _first(fields: ReviewFields, name: str, value: str) -> None:
    if not getattr(fields, name):
        setattr(fields, name, value)


def _put(fields: ReviewFields, header: str, kind: str, text: str, date_order: str) -> None:
    if kind == 'date':
        if not fields.created_at:
            fields.created_at = normalise_date(text, date_order) or ''
            if not fields.created_at:
                fields.warnings.append(f'"{header[:40]}" is not a date — the import date is used')
    elif kind in ('id', 'url', 'channel'):
        _first(fields, {'id': 'source_id'}.get(kind, kind), text)
    elif kind.startswith(DIMENSION_PREFIX):
        fields.dimensions[kind.removeprefix(DIMENSION_PREFIX)] = text
    elif kind in _RATING_KINDS and not fields.rating and (rating := five_point(kind, text)) is not None:
        fields.rating = rating
        if kind == 'rating_1_10':
            fields.metadata[header] = text  # the 1-10 value as the file had it, beside its 1-5 rating
    elif kind in _METADATA_KINDS:
        fields.metadata[header] = text


def reviews_fields(row: Mapping[str, str], mapping: Mapping[str, str], date_order: str) -> ReviewFields:
    """``row`` through ``mapping`` (``check_reviews_mapping``'s) as the CSV import's fields (module docstring)."""
    fields = ReviewFields()
    texts = [(header, (row.get(header) or '').strip()) for header, kind in mapping.items() if kind == 'open_text']
    filled = [(header, text) for header, text in texts if text]
    fields.text = filled[0][1] if len(filled) == 1 else '\n\n'.join(f'{header}\n{text}' for header, text in filled)
    for header, kind in mapping.items():
        text = (row.get(header) or '').strip()
        if text and kind != 'open_text' and kind not in PERSONAL_KINDS and kind != 'ignore':
            _put(fields, header, kind, text, date_order)
    return fields
