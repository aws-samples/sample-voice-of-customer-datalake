"""What each column of an imported file holds (the import wizard, docs/import-wizard.md; ``POST /scrapers/manual/detect``).

``parse_sample`` reads the first part of a file (at most ``MAX_SAMPLE_BYTES``) as a table: CSV or TSV (a byte-order
mark dropped, the separator found on the header line among ``,`` ``;`` tab and ``|`` unless the caller names it),
JSON (an array of objects, an object holding one, or one object per line) or the rows an XLSX reader gave
(shared/library_extract.py ``xlsx_rows``). ``detect_columns`` then decides one ``KIND`` per column from its header and
its values, deterministically, with a confidence (0 to 1) and its reasons, each a code with parameters
(``{'code': 'values_range', 'params': {'min': 0, 'max': 10}}``) the SPA words in the reader's language, and an English
``reason`` for logs and integrators. Headers are read in the app's languages (English, Spanish, Polish, French, German,
Portuguese and their accents folded), values decide when the header says nothing. ``suggest_target`` says whether the
file is reviews or tickets (``reviews``, through the CSV import) or a survey export (``survey``, an imported form).

Personal data (``email``, ``name``) is detected so it can be dropped by default: nothing it holds reaches a mapping
unless a person changes the kind. Nothing here is stored.

Pure: no AWS client, no I/O, no clock.
"""
from __future__ import annotations

import csv
import io
import json
import re
import statistics
import unicodedata
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from shared.exceptions import ValidationError
from shared.forms_v2_responses import EMAIL_PATTERN
from shared.import_dates import infer_date_order, is_excel_serial, looks_like_date

__all__ = [
    'FORMATS',
    'KINDS',
    'MAX_SAMPLE_BYTES',
    'PERSONAL_KINDS',
    'Column',
    'Table',
    'column_cells',
    'detect_columns',
    'parse_sample',
    'split_choices',
    'split_matrix',
    'suggest_target',
]

FORMATS: Final = ('csv', 'tsv', 'json', 'xlsx')
KINDS: Final = ('id', 'date', 'rating_1_5', 'rating_1_10', 'nps_0_10', 'csat', 'choice', 'multi_choice',
                'matrix_cell', 'open_text', 'email', 'name', 'url', 'channel', 'ignore')
#: Dropped by default: the wizard warns and keeps them out unless a person picks another kind.
PERSONAL_KINDS: Final = frozenset({'email', 'name'})
MAX_SAMPLE_BYTES: Final = 256 * 1024
MAX_COLUMNS: Final = 200
MAX_HEADER_CHARS: Final = 256
#: A choice column has at most this many distinct values (a longer list is open text or an id).
MAX_CHOICE_VALUES: Final = 12
#: The distinct values a column reports (the wizard's card and the inferred options read them).
MAX_REPORTED_VALUES: Final = 50
#: The values of a column the detector reads (the sample's first rows).
MAX_READ_VALUES: Final = 2_000
DELIMITERS: Final = (',', ';', '\t', '|')

_MOST: Final = 0.8
_NEARLY_ALL: Final = 0.9
_SOME: Final = 0.3
_LONG_TEXT_CHARS: Final = 25
_MAX_ID_CHARS: Final = 64
_MAX_NAME_CHARS: Final = 40
#: A multiple-choice column's answers come back: on average this many times each, at least.
_REPEATED: Final = 1.5
_NPS_HIGH: Final = 10
_FIVE: Final = 5
_URL: Final = re.compile(r'https?://\S+', re.IGNORECASE)
_INTEGER: Final = re.compile(r'([+-]?\d{1,9})(?:[.,]0+)?(?:\s*/\s*\d{1,3})?')
_MATRIX_PAIR: Final = re.compile(r'\s*([^;]+?)\s*--\s*([^;]+?)\s*')

# Header words (lower-case, accents folded, matched as the start of a word; one ending in ``.`` as a whole word) by
# kind, in the app's languages.
_HEADER_WORDS: Final[Mapping[str, tuple[str, ...]]] = {
    'nps_0_10': ('recommend', 'recomend', 'polec', 'empfehl', 'recommand', 'nps', 'net promoter'),
    'csat': ('csat', 'satisf', 'zadowol', 'satysfak', 'zufried'),
    'rating_1_5': ('rating', 'rate.', 'rated', 'star', 'score', 'valorac', 'puntuac', 'calificac', 'ocen', 'gwiazd',
                   'bewert', 'avaliac', 'nota.', 'note.'),
    'date': ('date', 'fecha', 'data.', 'datum', 'time.', 'timestamp', 'created', 'submitted', 'enviad', 'wyslan',
             'utworz', 'creado', 'hora', 'czas', 'heure', 'zeit.', 'dia.', 'dzien'),
    'id': ('id.', 'uuid', 'identif', 'identyf', 'kennung', 'ticket', 'nr.'),
    'email': ('email', 'e mail', 'mail.', 'correo', 'courriel'),
    'name': ('name', 'nombre', 'imie', 'nazwisk', 'nom.', 'prenom', 'vorname', 'nachname', 'nome.', 'author',
             'autor', 'apellido', 'full name'),
    'url': ('url', 'link', 'enlace', 'odnosnik', 'lien'),
    'channel': ('channel', 'source', 'platform', 'store', 'canal', 'kanal', 'zrodl', 'origen', 'quelle',
                'plataforma', 'fuente'),
    'open_text': ('comment', 'feedback', 'review', 'text', 'message', 'why', 'reason', 'describ', 'suggest',
                  'improv', 'opinion', 'comentar', 'opini', 'sugerenc', 'por que', 'porque', 'motivo', 'komentarz',
                  'uwag', 'dlaczego', 'sugesti', 'body', 'content', 'kommentar', 'warum', 'pourquoi', 'avis',
                  'mensaje', 'wiadomosc', 'tresc', 'answer', 'respuesta', 'odpowiedz', 'explain', 'tell us'),
}


@dataclass(frozen=True)
class Table:
    """A file's header row and data rows (each a ``{header: text}``), and the separator it was read with."""

    headers: list[str]
    rows: list[dict[str, str]]
    delimiter: str = ','


@dataclass
class Column:
    """One column as detected: its kind, confidence and reasons, and what the wizard shows on its card."""

    header: str
    kind: str
    confidence: float
    reasons: list[dict[str, Any]] = field(default_factory=list)
    values: list[str] = field(default_factory=list)
    filled: int = 0
    date_order: str | None = None
    separator: str | None = None

    def view(self) -> dict[str, Any]:
        """The wire shape of ``POST /scrapers/manual/detect``'s ``columns``."""
        out: dict[str, Any] = {
            'header': self.header, 'kind': self.kind, 'confidence': round(self.confidence, 2),
            'reasons': self.reasons, 'reason': reason_text(self.reasons), 'personal': self.kind in PERSONAL_KINDS,
            'values': self.values, 'filled': self.filled,
        }
        if self.date_order:
            out['date_order'] = self.date_order
        if self.separator:
            out['separator'] = self.separator
        return out


# ── Reading the sample ──────────────────────────────────────────────────────────────────────────────────────────

def _sniff(header_line: str) -> str:
    """The separator the header line uses most, outside quotes (a comma when none appears)."""
    counts = Counter(ch for ch in re.sub(r'"[^"]*"', '', header_line) if ch in DELIMITERS)
    return max(DELIMITERS, key=lambda ch: (counts[ch], -DELIMITERS.index(ch))) if counts else ','


def _headers(raw: Sequence[object]) -> list[str]:
    """The header row, each name trimmed and bounded; a blank or repeated one named by its position."""
    headers: list[str] = []
    for index, name in enumerate(raw[:MAX_COLUMNS], start=1):
        text = str(name or '').strip()[:MAX_HEADER_CHARS] or f'Column {index}'
        headers.append(text if text not in headers else f'{text} ({index})')
    return headers


def _delimited(text: str, delimiter: str | None, *, truncated: bool) -> Table:
    body = text.removeprefix('\ufeff')
    first_line = body.split('\n', 1)[0]
    sep = delimiter if delimiter in DELIMITERS else _sniff(first_line)
    reader = csv.reader(io.StringIO(body), delimiter=str(sep))
    try:
        records = [record for record in reader if any(cell.strip() for cell in record)]
    except csv.Error as e:
        raise ValidationError(f'The file could not be read as delimited text: {e}', code='file_unreadable') from e
    if not records:
        raise ValidationError('The file has no header row', code='file_empty')
    if truncated and len(records) > 1:
        records = records[:-1]  # the sample ends mid-file: its last row may be cut
    headers = _headers(records[0])
    rows = [{header: (record[i].strip() if i < len(record) else '') for i, header in enumerate(headers)}
            for record in records[1:]]
    return Table(headers, rows, str(sep))


def _cell_text(value: object) -> str:
    if value is None:
        return ''
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, list):
        return '; '.join(_cell_text(item) for item in value if item not in (None, ''))
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return str(value).strip()


def _json_lines(body: str) -> list[object]:
    """One JSON object per line (JSON Lines), or a 400."""
    try:
        lines: list[object] = [json.loads(line) for line in body.splitlines() if line.strip()]
    except json.JSONDecodeError as e:
        raise ValidationError('The file is not JSON: an array of objects, or one object per line',
                              code='file_unreadable') from e
    return lines


def _json_records(text: str) -> list[object]:
    body = text.removeprefix('\ufeff').strip()
    try:
        parsed: object = json.loads(body)
    except json.JSONDecodeError:
        return _json_lines(body)
    if isinstance(parsed, dict):
        lists = [value for value in parsed.values() if isinstance(value, list)]
        records: list[object] = lists[0] if len(lists) == 1 else [parsed]
        return records
    if not isinstance(parsed, list):
        raise ValidationError('The JSON holds no list of records', code='file_unreadable')
    return list(parsed)


def _json_table(text: str) -> Table:
    records = [record for record in _json_records(text) if isinstance(record, dict)]
    if not records:
        raise ValidationError('The JSON holds no records', code='file_empty')
    names: list[str] = []
    for record in records:
        names.extend(str(key) for key in record if str(key) not in names)
    headers = _headers(names)
    keys = names[:MAX_COLUMNS]
    rows = [{header: _cell_text(record.get(key)) for header, key in zip(headers, keys, strict=True)}
            for record in records]
    return Table(headers, rows, ',')


def rows_table(rows: Sequence[Sequence[object]]) -> Table:
    """A table from rows of cells, the first the header (an XLSX sheet, shared/library_extract.py ``xlsx_rows``)."""
    filled = [row for row in rows if any(str(cell or '').strip() for cell in row)]
    if not filled:
        raise ValidationError('The sheet is empty', code='file_empty')
    headers = _headers(filled[0])
    return Table(headers, [{header: (_cell_text(row[i]) if i < len(row) else '') for i, header in enumerate(headers)}
                           for row in filled[1:]], ',')


def parse_sample(fmt: str, text: str, *, delimiter: str | None = None, truncated: bool = False) -> Table:
    """The table ``text`` holds as ``fmt`` (``csv``, ``tsv`` or ``json``; an XLSX's rows come through ``rows_table``).
    ``truncated``: the sample is the start of a longer file, so its last delimited row is left out."""
    if fmt == 'json':
        return _json_table(text)
    if fmt in ('csv', 'tsv'):
        return _delimited(text, '\t' if fmt == 'tsv' and delimiter is None else delimiter, truncated=truncated)
    raise ValidationError(f'format must be one of: {", ".join(FORMATS)}', code='format_invalid')


# ── One column ──────────────────────────────────────────────────────────────────────────────────────────────────

def fold(text: str) -> str:
    """``text`` lower-cased with its accents folded and every run of other characters one space (``Ł`` reads ``l``)."""
    decomposed = unicodedata.normalize('NFKD', text.replace('ł', 'l').replace('Ł', 'L'))
    plain = ''.join(ch for ch in decomposed if not unicodedata.combining(ch)).lower()
    return ' '.join(re.sub(r'[^a-z0-9]+', ' ', plain).split())


def _header_word(header: str, kind: str) -> str | None:
    """The first of ``kind``'s header words that starts a word of ``header`` (folded; a word ending in ``.`` is a
    whole word: ``id.`` is "id" but not "idea"), or None."""
    folded = f' {fold(header)} '
    for word in _HEADER_WORDS[kind]:
        whole = word.endswith('.')
        if (f' {word[:-1]} ' if whole else f' {word}') in folded:
            return word.removesuffix('.')
    return None


def split_choices(value: str) -> tuple[list[str], str | None]:
    """A multiple-choice cell's answers: split on ``;`` when it holds one, else on ``,``; and that separator."""
    for separator in (';', ','):
        if separator in value:
            return [part.strip() for part in value.split(separator) if part.strip()], separator
    return ([value.strip()] if value.strip() else []), None


def split_matrix(value: str) -> list[tuple[str, str]] | None:
    """A matrix cell's ``Row -- value; Row 2 -- value`` pairs, or None when any part is not such a pair."""
    parts = [part for part in value.split(';') if part.strip()]
    pairs = [_MATRIX_PAIR.fullmatch(part) for part in parts]
    if not parts or any(match is None for match in pairs):
        return None
    return [(match.group(1), match.group(2)) for match in pairs if match is not None]


def as_integer(value: str) -> int | None:
    """A whole number as an export writes one (``9``, ``9.0``, ``9/10``), or None."""
    match = _INTEGER.fullmatch(value.strip())
    return int(match.group(1)) if match else None


def _share(values: Sequence[str], test: Any) -> float:
    return sum(1 for value in values if test(value)) / len(values) if values else 0.0


def _reason(code: str, **params: Any) -> dict[str, Any]:
    return {'code': code, 'params': params}


def _with_header(kind: str, header: str, confidence: float, reasons: list[dict[str, Any]], *,
                 boost: float = 0.25) -> tuple[str, float, list[dict[str, Any]]]:
    """``kind`` with its confidence raised (and the reason given) when the header names it too."""
    word = _header_word(header, kind)
    if word is None:
        return kind, confidence, reasons
    return kind, min(0.97, confidence + boost), [*reasons, _reason('header_says', word=word)]


def _scale_kind(header: str, low: int, high: int) -> tuple[str, float, list[dict[str, Any]]]:
    """A column of whole numbers from 0 to 10: NPS, CSAT or a rating, by its header first, then its range."""
    reasons = [_reason('values_range', min=low, max=high)]
    if _header_word(header, 'nps_0_10'):
        return _with_header('nps_0_10', header, 0.7, reasons)
    if low >= 1 and high <= _FIVE and _header_word(header, 'csat'):
        return _with_header('csat', header, 0.7, reasons)
    rating_word = _header_word(header, 'rating_1_5')
    if low >= 1 and rating_word:
        return ('rating_1_5' if high <= _FIVE else 'rating_1_10'), 0.95, [
            *reasons, _reason('header_says', word=rating_word)]
    if low == 0:
        return 'nps_0_10', 0.6, [*reasons, _reason('zero_present')]
    return ('rating_1_5' if high <= _FIVE else 'rating_1_10'), 0.6, reasons


def _numeric_kind(header: str, numbers: list[int]) -> tuple[str, float, list[dict[str, Any]]]:
    low, high = min(numbers), max(numbers)
    if len(set(numbers)) == len(numbers) and _header_word(header, 'id'):
        return _with_header('id', header, 0.6, [_reason('unique_values')])
    if low >= 0 and high <= _NPS_HIGH:
        return _scale_kind(header, low, high)
    if len(set(numbers)) == len(numbers):
        return _with_header('id', header, 0.55, [_reason('unique_values')], boost=0.35)
    return 'ignore', 0.4, [_reason('numbers', min=low, max=high)]


def _looks_like_name(value: str) -> bool:
    """Two or three capitalised words of letters (``Anna Kowalska``, ``José de la Cruz`` is not): a person's name."""
    parts = value.split()
    return len(value) <= _MAX_NAME_CHARS and 2 <= len(parts) <= 3 and all(
        part[:1].isupper() and part.replace('-', '').replace("'", '').isalpha() for part in parts)


def _multi_choice(values: list[str]) -> tuple[Counter[str], str] | None:
    """The answers and separator of a multiple-choice column: separated answers in a third of the values or more,
    short ones that come back (a comment with a comma is not one)."""
    tokens, separators = _tokens(values)
    if not separators or _share(values, lambda v: split_choices(v)[1] is not None) < _SOME:
        return None
    if len(tokens) > MAX_REPORTED_VALUES or sum(tokens.values()) < _REPEATED * len(tokens):
        return None
    if statistics.fmean(len(token) for token in tokens) > _LONG_TEXT_CHARS:
        return None
    return tokens, separators.most_common(1)[0][0]


_Kind = tuple[str, float, list[dict[str, Any]], str | None]


def _named_kind(header: str, values: list[str], distinct: set[str]) -> _Kind | None:
    """An id, a multiple choice, a channel or a name, as the header and the values' shape say; None otherwise."""
    if len(distinct) == len(values) and _header_word(header, 'id'):
        return *_with_header('id', header, 0.6, [_reason('unique_values')]), None
    multi = _multi_choice(values)
    if multi is not None:
        tokens, separator = multi
        return 'multi_choice', 0.75, [_reason('separator', separator=separator),
                                      _reason('distinct_values', count=len(tokens))], separator
    if _header_word(header, 'channel') and len(distinct) <= MAX_CHOICE_VALUES:
        return *_with_header('channel', header, 0.6, [_reason('distinct_values', count=len(distinct))]), None
    if _header_word(header, 'name') or (_share(values, _looks_like_name) >= _MOST
                                        and len(distinct) >= _MOST * len(values)):
        return *_with_header('name', header, 0.6, [_reason('personal_data')]), None
    return None


def _text_kind(header: str, values: list[str]) -> _Kind:
    """The kind of a column of words: an id, a multiple choice, a channel, a name, a choice, or open text."""
    distinct = {value.casefold() for value in values}
    named = _named_kind(header, values, distinct)
    if named is not None:
        return named
    average = statistics.fmean(len(value) for value in values)
    long_text = [_reason('long_text', average=round(average))]
    repeats = len(values) >= 2 * len(distinct)
    if not repeats and (_header_word(header, 'open_text') or _share(values, lambda v: ' ' in v) >= _MOST):
        return *_with_header('open_text', header, 0.6, long_text), None
    if len(distinct) <= MAX_CHOICE_VALUES and (repeats or average <= _LONG_TEXT_CHARS):
        return 'choice', 0.7 if repeats else 0.5, [_reason('distinct_values', count=len(distinct))], None
    if average < _LONG_TEXT_CHARS and len(distinct) == len(values) and all(
            ' ' not in v and len(v) <= _MAX_ID_CHARS for v in values):
        return *_with_header('id', header, 0.5, [_reason('unique_values')], boost=0.4), None
    return *_with_header('open_text', header, 0.7 if average >= _LONG_TEXT_CHARS else 0.4, long_text), None


def _tokens(values: Iterable[str]) -> tuple[Counter[str], Counter[str]]:
    tokens: Counter[str] = Counter()
    separators: Counter[str] = Counter()
    for value in values:
        parts, separator = split_choices(value)
        tokens.update(part.casefold() for part in parts)
        if separator:
            separators[separator] += 1
    return tokens, separators


def _distinct(values: Iterable[str]) -> list[str]:
    """The distinct values (first spelling of each, ignoring case) in first-seen order, at most the reported number."""
    seen: dict[str, str] = {}
    for value in values:
        seen.setdefault(value.casefold(), value)
    return list(seen.values())[:MAX_REPORTED_VALUES]


def _reported(kind: str, values: list[str], separator: str | None) -> list[str]:
    """What the card lists: a choice's values, a multiple choice's answers, a matrix's rows then columns."""
    if kind == 'multi_choice':
        return _distinct(part for value in values for part in split_choices(value)[0])
    if kind == 'matrix_cell':
        pairs = [pair for value in values for pair in (split_matrix(value) or [])]
        return _distinct(row for row, _column in pairs) + _distinct(column for _row, column in pairs)
    if kind in ('choice', 'channel') or separator:
        return _distinct(values)
    return [] if kind in PERSONAL_KINDS else _distinct(values)[:3]


def detect_column(header: str, raw_values: Sequence[str]) -> Column:
    """One column's kind, confidence and reasons (see the module docstring)."""
    values = [value.strip() for value in raw_values[:MAX_READ_VALUES] if value and value.strip()]
    if not values:
        return Column(header, 'ignore', 0.9, [_reason('empty')])
    column = _detect(header, values)
    column.values = _reported(column.kind, values, column.separator)
    column.filled = len(values)
    return column


def _detect(header: str, values: list[str]) -> Column:
    if _share(values, EMAIL_PATTERN.fullmatch) >= _MOST:
        return Column(header, 'email', 0.95, [_reason('emails'), _reason('personal_data')])
    if _share(values, _URL.fullmatch) >= _MOST:
        return Column(header, *_with_header('url', header, 0.8, [_reason('urls')]))
    if _share(values, split_matrix) >= _MOST:
        return Column(header, 'matrix_cell', 0.9, [_reason('matrix_pairs')])
    # An Excel serial (a number from 20,000 to 80,000) is a date only under a date header: elsewhere it is a count or
    # an id (``Ticket ID`` 45001…), so there the values must read as dates without it.
    date_header = _header_word(header, 'date') is not None
    serials = date_header and _share(values, is_excel_serial) >= _MOST
    if serials or _share(values, looks_like_date if date_header else _written_date) >= _MOST:
        order = infer_date_order(values)
        reasons = [_reason('excel_serial')] if serials else [_reason('dates', order=order)]
        return Column(header, *_with_header('date', header, 0.75, reasons), date_order=order)
    numbers = [number for value in values if (number := as_integer(value)) is not None]
    if len(numbers) >= _NEARLY_ALL * len(values):
        return Column(header, *_numeric_kind(header, numbers))
    kind, confidence, reasons, separator = _text_kind(header, values)
    return Column(header, kind, confidence, reasons, separator=separator)


def _written_date(value: str) -> bool:
    """A date as written (ISO, slashed, dotted), never a bare Excel serial."""
    return not is_excel_serial(value) and looks_like_date(value)


def column_cells(table: Table, header: str) -> list[str]:
    """A column's distinct non-empty cells as written (first spelling of each, ignoring case), at most
    ``MAX_READ_VALUES``: what a choice's options and a matrix's rows and columns are inferred from."""
    return _distinct_cells(row.get(header, '') for row in table.rows)


def _distinct_cells(values: Iterable[str]) -> list[str]:
    seen: dict[str, str] = {}
    for value in values:
        text = value.strip()
        if text and len(seen) < MAX_READ_VALUES:
            seen.setdefault(text.casefold(), text)
    return list(seen.values())


def detect_columns(table: Table) -> list[Column]:
    """Every column of ``table`` as detected, in the file's order."""
    return [detect_column(header, [row.get(header, '') for row in table.rows]) for header in table.headers]


# ── The whole file ──────────────────────────────────────────────────────────────────────────────────────────────

_SURVEY_KINDS: Final = frozenset({'nps_0_10', 'multi_choice', 'matrix_cell'})
_SCALE_KINDS: Final = frozenset({'rating_1_5', 'rating_1_10', 'csat'})


def suggest_target(columns: Sequence[Column]) -> str:
    """``survey`` for a survey tool's export (an NPS, multiple-choice or matrix column, several scales or open
    questions, or no free text at all), else ``reviews`` (reviews or tickets: one text, at most one rating, the rest
    their labels: a country, a version, a subject)."""
    kinds = Counter(column.kind for column in columns)
    if any(kinds[kind] for kind in _SURVEY_KINDS) or not kinds['open_text']:
        return 'survey'
    if sum(kinds[kind] for kind in _SCALE_KINDS) >= 2 or (kinds['open_text'] >= 2 and kinds['choice'] >= 2):
        return 'survey'
    return 'reviews'


_REASON_TEXT: Final[Mapping[str, str]] = {
    'header_says': "the header says '{word}'",
    'values_range': 'values {min}-{max}',
    'zero_present': 'a 0 appears, which no rating has',
    'distinct_values': '{count} distinct values',
    'separator': "answers separated by '{separator}'",
    'matrix_pairs': "every value is 'row -- answer' pairs",
    'emails': 'values are email addresses',
    'urls': 'values are web addresses',
    'dates': 'values are dates ({order})',
    'excel_serial': 'values are Excel date numbers',
    'long_text': 'free text of {average} characters on average',
    'unique_values': 'every value is different',
    'numbers': 'numbers from {min} to {max}',
    'personal_data': 'personal data: dropped unless you keep it',
    'empty': 'the column is empty',
}


def reason_text(reasons: Sequence[Mapping[str, Any]]) -> str:
    """The reasons as one English sentence (``values 0-10, the header says 'recommend'``)."""
    parts = []
    for reason in reasons:
        template = _REASON_TEXT.get(str(reason.get('code')), str(reason.get('code')))
        raw = reason.get('params')
        params = {str(key): value for key, value in raw.items()} if isinstance(raw, Mapping) else {}
        parts.append(template.format(**params))
    return ', '.join(parts)
