"""Importing a survey export's rows into an imported form (7.67.00, docs/import-wizard.md):
``POST /feedback-forms/{form_id}/import`` (lambda/api/feedback_form_handler.py).

``import_request`` bounds the body: ``rows`` (1 to 5,000 objects of ``{header: cell}`` a call; the wizard sends a big
file in chunks, each its own call), ``mapping`` (``{header: question id | hidden:<id> | date | id | ignore}``,
shared/import_survey.py ``check_mapping``), ``date_order``, ``offset`` (the file row of the first row, so a refusal
names the file's row), ``dry_run``, and the original file once: ``file`` (``{name, format, content}``, at most 2 MB,
an XLSX in base64) on the first call, kept write-once in the bronze layer, or ``file_key`` (the key the first call
answered) on the next ones. ``read_rows`` reads every row as a response (types and ranges checked, never the logic
path) and keeps the refusals by row; ``response_message`` builds the queue message of one accepted row as a widget
response's (``form_answers``, ``form_path``, the revision; the item's rating is the first rating or CSAT, never the
NPS; the text the open answers under their headlines, else ``headline: answer`` lines), dated with the row's own date
and keyed so that importing the same row again is the same item.

Pure: no AWS client, no I/O, no clock.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from shared import forms_v2 as fv2
from shared import forms_v2_responses as fresp
from shared.exceptions import ValidationError
from shared.import_dates import DATE_ORDERS, DEFAULT_DATE_ORDER
from shared.import_survey import ImportedRow, row_answers
from shared.pii_redaction import comprehend_language

__all__ = ['ImportRequest', 'check_redaction_budget', 'file_key_of', 'free_text_paths', 'import_request', 'read_rows',
           'refuse_unredacted', 'response_message']

MAX_IMPORT_ROWS: Final = 5_000
#: The free texts (each row's text, its open answers and a choice's Other, its hidden values) one call may hold under a
#: redacting policy in a language Comprehend reads: each is one Comprehend call with ``PII_COMPREHEND=1``
#: (shared/pii_redaction.py), so a call stays well inside API Gateway's 29 s (the wizard sizes its calls by it:
#: frontend wizardMapping.ts ``MAX_REDACTED_TEXTS``). A form in another language makes no Comprehend call: no bound.
MAX_REDACTED_TEXTS: Final = 250
TOO_MANY_TEXTS: Final = 'too_many_texts'
#: A row refused because Comprehend could not read one of its texts under a redacting policy (after its retries): it
#: is never kept with the patterns' redaction alone (the same row sent again to the same form is taken then).
REDACTION_UNAVAILABLE: Final = 'redaction_unavailable'
#: The original file a call carries: 2 MB, so the call (rows beside it, JSON-escaped twice in the Lambda event) stays
#: inside Lambda's 6 MB synchronous payload.
MAX_FILE_BYTES: Final = 2 * 1024 * 1024
MAX_REFUSALS: Final = 200
MAX_CELL_CHARS: Final = 10_000
MAX_ROW_CELLS: Final = 200
FILE_FORMATS: Final[Mapping[str, str]] = {
    'csv': 'text/csv; charset=utf-8', 'tsv': 'text/tab-separated-values; charset=utf-8',
    'json': 'application/json', 'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
#: The writer named on the kept file and on each response's raw copy (shared/raw_versions.py ``connector``).
IMPORT_WRITER: Final = 'feedback_form_import'
INGESTION_METHOD: Final = 'form_import'
DUPLICATE_ROW: Final = 'duplicate_row'
_RUN_FILE: Final = re.compile(r'[0-9a-f-]{36}\.(csv|tsv|json|xlsx)')


def _fail(message: str, code: str = 'import_invalid') -> ValidationError:
    return ValidationError(message, code=code)


@dataclass(frozen=True)
class OriginalFile:
    """The file the rows came from, as kept: its bytes, its format (the key's extension) and its content type."""

    content: bytes
    fmt: str

    @property
    def content_type(self) -> str:
        return FILE_FORMATS[self.fmt]


@dataclass(frozen=True)
class ImportRequest:
    """A checked import body (see the module docstring)."""

    rows: list[dict[str, Any]]
    mapping: Mapping[str, Any]
    date_order: str = DEFAULT_DATE_ORDER
    offset: int = 0
    dry_run: bool = False
    file: OriginalFile | None = None
    file_key: str | None = None


def _rows(raw: object) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_IMPORT_ROWS:
        raise _fail(f'rows must be a list of 1 to {MAX_IMPORT_ROWS} rows a call: send a longer file in parts')
    for index, row in enumerate(raw):
        if not isinstance(row, dict) or len(row) > MAX_ROW_CELLS or any(
                not isinstance(cell, str | int | float | None) or (isinstance(cell, str) and len(cell) > MAX_CELL_CHARS)
                for cell in row.values()):
            raise _fail(f'rows[{index}] must be an object of at most {MAX_ROW_CELLS} cells, each a text or a number')
    return raw


def _file(raw: object) -> OriginalFile | None:
    if raw is None:
        return None
    if not isinstance(raw, Mapping) or raw.get('format') not in FILE_FORMATS or not isinstance(raw.get('content'), str):
        raise _fail(f'file must be {{name, format ({", ".join(FILE_FORMATS)}), content}}')
    fmt, content = str(raw['format']), str(raw['content'])
    if fmt == 'xlsx':
        try:
            data = base64.b64decode(content, validate=True)
        except (binascii.Error, ValueError) as e:
            raise _fail('file.content of a workbook must be base64') from e
    else:
        data = content.encode('utf-8')
    if not data or len(data) > MAX_FILE_BYTES:
        raise _fail('file must hold 1 byte to 2 MB', 'file_too_large')
    return OriginalFile(data, fmt)


def import_request(body: Mapping[str, Any]) -> ImportRequest:
    """``body`` checked (see the module docstring); a 400 naming the field otherwise."""
    date_order = body.get('date_order', DEFAULT_DATE_ORDER)
    if date_order not in DATE_ORDERS:
        raise _fail(f'date_order must be one of: {", ".join(DATE_ORDERS)}')
    offset = body.get('offset', 0)
    if isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset <= 10_000_000:
        raise _fail('offset must be the file row of the first row, a whole number from 0')
    dry_run = body.get('dry_run', False)
    if not isinstance(dry_run, bool):
        raise _fail('dry_run must be true or false')
    file_key = body.get('file_key')
    if file_key is not None and not isinstance(file_key, str):
        raise _fail('file_key must be the key the first call answered')
    original = _file(body.get('file'))
    if original is not None and file_key is not None:
        raise _fail('Send file on the first call or file_key on the next ones, not both')
    return ImportRequest(_rows(body.get('rows')), body.get('mapping') or {}, str(date_order), offset, dry_run,
                         original, file_key)


def file_key_of(raw_root: str, form_id: str, run_id: str, fmt: str) -> str:
    """Where the original file of a run is kept: ``{raw root}feedback_form/import/{form_id}/{run}.{ext}``."""
    return f'{raw_root}feedback_form/import/{form_id}/{run_id}.{fmt}'


def checked_file_key(key: str, raw_root: str, form_id: str) -> str:
    """A later call's ``file_key``: one run's file of THIS form under the request's own bronze root (a 400 otherwise),
    so a response never points at another form's, or another workspace's, object."""
    prefix = f'{raw_root}feedback_form/import/{form_id}/'
    if not key.startswith(prefix) or not _RUN_FILE.fullmatch(key.removeprefix(prefix)):
        raise _fail("file_key must be the key this form's first import call answered")
    return key


@dataclass
class ReadRows:
    """Every accepted row (with its file row number) and every refusal (``{row, code, question_id?}``), in order."""

    accepted: list[tuple[int, ImportedRow]] = field(default_factory=list)
    refused: list[dict[str, Any]] = field(default_factory=list)


def _cells(row: Mapping[str, Any]) -> dict[str, str]:
    return {str(header): '' if cell is None else str(cell) for header, cell in row.items()}


def read_rows(definition: Mapping[str, Any], mapping: Mapping[str, str], request: ImportRequest, *,
              default_at: str, form_id: str) -> ReadRows:
    """Each row of ``request`` read through ``mapping`` (shared/import_survey.py ``row_answers``): accepted, or refused
    with its code (a row that is the same item as an earlier one of the call is ``duplicate_row``)."""
    out = ReadRows()
    seen: set[str] = set()
    for index, row in enumerate(request.rows):
        number = request.offset + index + 1
        try:
            imported = row_answers(definition, mapping, _cells(row), default_at=default_at,
                                   date_order=request.date_order)
        except ValidationError as e:
            refusal: dict[str, Any] = {'row': number, 'code': e.code or 'answer_invalid'}
            question = (e.details or {}).get('question_id')
            if question:
                refusal['question_id'] = question
            out.refused.append(refusal)
            continue
        key = message_id(form_id, imported, number)
        if key in seen:
            out.refused.append({'row': number, 'code': DUPLICATE_ROW})
            continue
        seen.add(key)
        out.accepted.append((number, imported))
    return out


def message_id(form_id: str, imported: ImportedRow, number: int) -> str:
    """A row's queue id: from the form and the row's own id, else its file row, its own date (never the call's clock,
    which a row without one is dated with) and its answers, so importing the same file into the same form again names
    the same items (the processor's idempotency skips them)."""
    basis = ['form-import-v1', form_id, 'id', imported.row_id] if imported.row_id else [
        'form-import-v1', form_id, 'row', str(number), imported.created_at if imported.dated else '',
        json.dumps(imported.response.answers, sort_keys=True, ensure_ascii=False)]
    return 'fimp_' + hashlib.sha256(json.dumps(basis, ensure_ascii=False).encode('utf-8')).hexdigest()[:32]


def free_text_paths(definition: Mapping[str, Any]) -> frozenset[tuple[str, ...]]:
    """Where a response's own words may sit in its message's metadata: an open answer, a choice's "Other", a hidden
    value (an export's column mapped to a hidden field may hold a name) — the only metadata the redact policy's entity
    model reads (shared/source_policy.py ``FreeText``; never an option code, an id the form made or its name)."""
    paths: set[tuple[str, ...]] = set()
    for question in definition.get('questions') or []:
        if question['type'] == fv2.OPEN_TEXT:
            paths.add(('form_answers', question['id']))
        elif question['type'] in fv2.SELECT_TYPES:
            paths.add(('form_answers', question['id'], 'other'))
    for hidden in definition.get('hidden_fields') or []:
        paths.add(('form_hidden', str(hidden['id'])))
    return frozenset(paths)


def _row_texts(questions: Mapping[str, Mapping[str, Any]], row: ImportedRow) -> int:
    """The texts of one row the entity model reads: its text, each free answer (``fresp.free_text``) and each
    hidden value."""
    answers = sum(1 for qid, answer in row.response.answers.items() if fresp.free_text(questions[qid], answer))
    # (a response's hidden values are never blank: shared/forms_v2_responses.py drops those)
    return 1 + answers + len(row.response.hidden)


def check_redaction_budget(definition: Mapping[str, Any], accepted: Sequence[tuple[int, ImportedRow]]) -> None:
    """Under a redacting policy: a 400 ``too_many_texts`` when the accepted rows, in a language Comprehend reads
    (shared/pii_redaction.py ``comprehend_language``), hold more than ``MAX_REDACTED_TEXTS`` free texts (each row's
    text, its free answers and its hidden values), before any is redacted. Rows in another language make no
    Comprehend call, so they are not bound."""
    questions = {question['id']: question for question in definition.get('questions') or []}
    texts = sum(_row_texts(questions, row) for _number, row in accepted
                if comprehend_language(row.response.language) is not None)
    if texts > MAX_REDACTED_TEXTS:
        raise _fail(f'This source redacts personal data, so a call takes at most {MAX_REDACTED_TEXTS} texts (each '
                    f"row's text, its open answers and its hidden values; these rows hold {texts}): send fewer rows a "
                    'call', TOO_MANY_TEXTS)


def refuse_unredacted(read: ReadRows, form_id: str, unreadable: Sequence[str]) -> None:
    """Move each accepted row whose message (by its id) the entity model could not redact (shared/ingest_archive.py
    ``policy_applied``'s ``unreadable``) to the refusals, as ``REDACTION_UNAVAILABLE``, the refusals in file order."""
    if not unreadable:
        return
    left_out = set(unreadable)
    kept: list[tuple[int, ImportedRow]] = []
    for number, row in read.accepted:
        if message_id(form_id, row, number) in left_out:
            read.refused.append({'row': number, 'code': REDACTION_UNAVAILABLE})
        else:
            kept.append((number, row))
    read.accepted = kept
    read.refused.sort(key=lambda entry: entry['row'])


@dataclass(frozen=True)
class FormContext:
    """What every message of one import shares: the form, its definition and revision, its routing and labels."""

    form_id: str
    form_name: str
    definition: Mapping[str, Any]
    revision: int
    brand_name: str
    category: tuple[str, str]
    labels: Mapping[str, Any]
    run_id: str
    ingested_at: str


def response_message(form: FormContext, number: int, imported: ImportedRow,
                     category: tuple[str, str] | None = None) -> dict[str, Any]:
    """The queue message of one accepted row (see the module docstring). ``category``: the routing of its first
    answered option that maps one (the caller resolves it to names), else the form's own."""
    response = imported.response
    metadata: dict[str, Any] = {
        'form_id': form.form_id, 'form_name': form.form_name, 'form_version': '3.0', 'form_revision': form.revision,
        'form_language': response.language, 'form_ending_id': response.ending_id, 'form_path': response.path,
        'form_answers': response.answers, 'form_import_run': form.run_id,
    }
    if response.hidden:
        metadata['form_hidden'] = response.hidden
    preset_category, preset_subcategory = category or form.category
    message: dict[str, Any] = {
        'id': message_id(form.form_id, imported, number),
        'source_platform': 'feedback_form',
        'source_channel': f'form_{form.form_id}',
        'ingestion_method': INGESTION_METHOD,
        'text': fresp.response_text(form.definition, response),
        'rating': fresp.item_rating(form.definition, response),
        'created_at': imported.created_at,
        'ingested_at': form.ingested_at,
        'brand_name': form.brand_name,
        'preset_category': preset_category,
        'preset_subcategory': preset_subcategory,
        'metadata': metadata,
        **form.labels,
    }
    if imported.row_id:
        message['csv_row_id'] = imported.row_id
    if response.language in fv2.FORM_LOCALES:
        message['language'] = response.language
    return message


def refusal_lines(refused: Sequence[Mapping[str, Any]]) -> list[str]:
    """The refusals as the import run's warning lines (``row 12: answer_invalid (q_plan)``)."""
    return [f"row {entry['row']}: {entry['code']}" + (f" ({entry['question_id']})" if entry.get('question_id') else '')
            for entry in refused]
