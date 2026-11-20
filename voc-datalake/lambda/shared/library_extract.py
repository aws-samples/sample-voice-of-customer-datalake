"""A Documents Library item's text, extracted once (docs/documents-library.md "Formats and extraction").

What the library accepts (``FORMATS``), keyed by the content type the upload declares:

* the Converse-native documents (pdf, csv, doc, docx, xls, xlsx, html, txt, md) and images (png, jpeg, gif, webp),
  which the assistant can also be sent as they are (``native``);
* pptx, through its text only (Converse takes no presentation).

Text is extracted here with the standard library (txt, md, csv and html; docx, xlsx and pptx as the zip of XML parts
they are), ``pypdf`` for a PDF's text layer, and Amazon Bedrock where neither can read the file: a PDF with no text
layer (scanned pages), a legacy ``.doc`` / ``.xls`` and an image, each sent once as a Converse document or image block
(``describe``, the caller's model call). Nothing here calls AWS itself.

A document's pages (a PDF's, a presentation's slides) are joined with a form feed (``PAGE_BREAK``), so a passage knows
its page (``chunk_pages``). Every bound below is a refusal or a cut that is recorded, never a silent truncation: a PDF
reads at most ``MAX_PAGES`` pages, a zip part at most ``MAX_ZIP_PART_BYTES``, the whole text at most
``MAX_TEXT_CHARS`` (``Extraction.truncated``).
"""
from __future__ import annotations

import csv
import io
import re
import xml.etree.ElementTree as ET
import zipfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Final, override

__all__ = [
    'FORMATS', 'MAX_NATIVE_IMAGE_BYTES', 'MAX_UPLOAD_BYTES', 'PAGE_BREAK', 'Chunk', 'ExtractionError', 'chunk_pages',
    'extract', 'format_of', 'is_native',
]

#: 25 MB per file (the owner's decision).
MAX_UPLOAD_BYTES: Final = 25 * 1024 * 1024
#: Converse takes a document of at most 4.5 MB and an image of at most 3.75 MB in a message (lambda/stream's
#: attachments.ts and shared/image_limits.py hold the same two numbers).
MAX_NATIVE_DOCUMENT_BYTES: Final = 4_500_000
MAX_NATIVE_IMAGE_BYTES: Final = 3_750_000
#: The 15-minute worker reads at most this many pages of a PDF (the rest is cut and recorded).
MAX_PAGES: Final = 500
#: At most 2,000 passages per item, so at most this much text (each passage holds about 1,600 new characters).
MAX_CHUNKS: Final = 2000
MAX_TEXT_CHARS: Final = 3_200_000
#: A zip part (an Office file's XML) larger than this is refused: a 25 MB upload cannot hold more text than that
#: honestly, and a part that decompresses past it is a zip bomb.
MAX_ZIP_PART_BYTES: Final = 64 * 1024 * 1024
MAX_ZIP_PARTS: Final = 2000
#: Every part together, as the zip declares them (a part that lies about its size is caught by the read's own cap).
MAX_ZIP_TOTAL_BYTES: Final = 256 * 1024 * 1024
#: A PDF whose text layer averages fewer characters a page than this is read as scanned (Bedrock reads it instead).
SCANNED_CHARS_PER_PAGE: Final = 40
PAGE_BREAK: Final = '\f'
#: A passage: about 1,800 characters, the next one starting 200 before its end.
CHUNK_CHARS: Final = 1800
CHUNK_OVERLAP: Final = 200


@dataclass(frozen=True)
class Format:
    """One accepted kind of file: its short name (the Converse document format, ``png`` …), whether Converse takes
    it as a document (``document``) or an image (``image``) or neither (``text_only``, pptx)."""

    name: str
    kind: str


#: Content type → format. LOCKSTEP with frontend/src/pages/Library/libraryFormats.ts (the upload's own check).
FORMATS: Final[dict[str, Format]] = {
    'application/pdf': Format('pdf', 'document'),
    'text/csv': Format('csv', 'document'),
    'application/msword': Format('doc', 'document'),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': Format('docx', 'document'),
    'application/vnd.ms-excel': Format('xls', 'document'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': Format('xlsx', 'document'),
    'text/html': Format('html', 'document'),
    'text/plain': Format('txt', 'document'),
    'text/markdown': Format('md', 'document'),
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': Format('pptx', 'text_only'),
    'image/png': Format('png', 'image'),
    'image/jpeg': Format('jpeg', 'image'),
    'image/gif': Format('gif', 'image'),
    'image/webp': Format('webp', 'image'),
}


def format_of(content_type: object) -> Format | None:
    return FORMATS.get(content_type) if isinstance(content_type, str) else None


def is_native(fmt: Format, size: int) -> bool:
    """Whether the assistant may be sent the file itself: a Converse document of at most 4.5 MB, an image of at most
    3.75 MB."""
    if fmt.kind == 'document':
        return size <= MAX_NATIVE_DOCUMENT_BYTES
    return fmt.kind == 'image' and size <= MAX_NATIVE_IMAGE_BYTES


class ExtractionError(ValueError):
    """The file cannot be read; the message is the person's (the item's ``error``)."""


@dataclass(frozen=True)
class Extraction:
    """The text (pages joined by ``PAGE_BREAK``), its page count when it has pages, and whether it was cut."""

    text: str
    pages: int | None = None
    truncated: bool = False
    #: How the text was read: ``text`` (the standard library or pypdf) or ``model`` (Amazon Bedrock).
    method: str = 'text'


#: The caller's model call: ``(format, data, kind)`` → the text Bedrock read (``kind`` is ``document`` or ``image``).
Describe = Callable[[str, bytes, str], str]


# ── Plain text and HTML ──────────────────────────────────────────────────────────────────────────────────────────


def _decoded(data: bytes) -> str:
    text = data.decode('utf-8-sig', errors='replace')
    return text.replace('\r\n', '\n').replace('\r', '\n').replace(PAGE_BREAK, '\n')


def _csv_text(data: bytes) -> str:
    """Each row as ``a | b | c`` (a model and a reader both follow it better than raw quoting)."""
    rows = csv.reader(io.StringIO(_decoded(data)))
    return '\n'.join(' | '.join(cell.strip() for cell in row) for row in rows if any(cell.strip() for cell in row))


class _HtmlText(HTMLParser):
    """The text of an HTML page: no script, style or template, a line per block element."""

    _SKIPPED: Final = frozenset({'script', 'style', 'template', 'noscript', 'head'})
    _BLOCKS: Final = frozenset({'p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section',
                                'article', 'table', 'ul', 'ol', 'blockquote', 'pre'})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skipping = 0

    @override
    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._SKIPPED:
            self._skipping += 1
        elif tag in self._BLOCKS:
            self.parts.append('\n')

    @override
    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIPPED:
            self._skipping = max(0, self._skipping - 1)
        elif tag in self._BLOCKS:
            self.parts.append('\n')

    @override
    def handle_data(self, data: str) -> None:
        if not self._skipping:
            self.parts.append(data)


def _html_text(data: bytes) -> str:
    parser = _HtmlText()
    parser.feed(_decoded(data))
    parser.close()
    return _tidy(''.join(parser.parts))


def _tidy(text: str) -> str:
    """Spaces collapsed within lines, at most one blank line in a row."""
    lines = [re.sub(r'[ \t\u00a0]+', ' ', line).strip() for line in text.split('\n')]
    return re.sub(r'\n{3,}', '\n\n', '\n'.join(lines)).strip()


# ── Office files: a zip of XML parts ─────────────────────────────────────────────────────────────────────────────

_W: Final = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
_A: Final = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
_S: Final = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
_R_ID: Final = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
_REL: Final = '{http://schemas.openxmlformats.org/package/2006/relationships}Relationship'


def _open_zip(data: bytes, what: str) -> zipfile.ZipFile:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ExtractionError(f'This {what} file could not be opened. Save it again and upload it.') from exc
    parts = archive.infolist()
    if len(parts) > MAX_ZIP_PARTS:
        raise ExtractionError(f'This {what} file has too many parts to read.')
    if sum(part.file_size for part in parts) > MAX_ZIP_TOTAL_BYTES:
        raise ExtractionError('This file is too large to read once unpacked.')
    return archive


def _part(archive: zipfile.ZipFile, name: str) -> ET.Element | None:
    """One XML part, parsed, or None when the file has no such part. A part that declares a DOCTYPE (never in an
    Office file; how an entity expansion starts) or decompresses past ``MAX_ZIP_PART_BYTES`` is refused."""
    try:
        info = archive.getinfo(name)
    except KeyError:
        return None
    if info.file_size > MAX_ZIP_PART_BYTES:
        raise ExtractionError('This file is too large to read once unpacked.')
    with archive.open(info) as handle:
        raw = handle.read(MAX_ZIP_PART_BYTES + 1)
    if len(raw) > MAX_ZIP_PART_BYTES:
        raise ExtractionError('This file is too large to read once unpacked.')
    if b'<!DOCTYPE' in raw[:4096].upper() or b'<!ENTITY' in raw.upper():
        raise ExtractionError('This file could not be read safely.')
    try:
        return ET.fromstring(raw)  # noqa: S314 - DOCTYPE and entities refused above; Python's expat bounds expansion
    except ET.ParseError as exc:
        raise ExtractionError('This file could not be read. Save it again and upload it.') from exc


def _paragraphs(root: ET.Element, paragraph: str, run_text: str) -> list[str]:
    lines: list[str] = []
    for node in root.iter(paragraph):
        text = ''.join(part.text or '' for part in node.iter(run_text))
        if text.strip():
            lines.append(text.strip())
    return lines


def _docx_text(data: bytes) -> str:
    archive = _open_zip(data, 'Word')
    root = _part(archive, 'word/document.xml')
    if root is None:
        raise ExtractionError('This Word file has no document in it.')
    return '\n'.join(_paragraphs(root, f'{_W}p', f'{_W}t'))


def _numbered(names: list[str], pattern: str) -> list[str]:
    """``names`` matching ``pattern`` (one number group), in number order (slide2 before slide10)."""
    found = [(int(match.group(1)), name) for name in names if (match := re.fullmatch(pattern, name))]
    return [name for _number, name in sorted(found)]


def _pptx_pages(data: bytes) -> list[str]:
    archive = _open_zip(data, 'PowerPoint')
    slides = _numbered(archive.namelist(), r'ppt/slides/slide(\d+)\.xml')
    if not slides:
        raise ExtractionError('This PowerPoint file has no slides in it.')
    pages = []
    for name in slides[:MAX_PAGES]:
        root = _part(archive, name)
        pages.append('' if root is None else '\n'.join(_paragraphs(root, f'{_A}p', f'{_A}t')))
    return pages


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    root = _part(archive, 'xl/sharedStrings.xml')
    if root is None:
        return []
    return [''.join(text.text or '' for text in item.iter(f'{_S}t')) for item in root.iter(f'{_S}si')]


def _sheet_targets(archive: zipfile.ZipFile) -> list[tuple[str, str]]:
    """``(sheet name, part name)`` in the workbook's order, through its relationships; by file number when the
    workbook names none."""
    workbook = _part(archive, 'xl/workbook.xml')
    rels = _part(archive, 'xl/_rels/workbook.xml.rels')
    targets = {} if rels is None else {
        rel.get('Id'): rel.get('Target', '') for rel in rels.iter(_REL)}
    sheets: list[tuple[str, str]] = []
    for sheet in ([] if workbook is None else workbook.iter(f'{_S}sheet')):
        target = targets.get(sheet.get(_R_ID), '')
        if target:
            sheets.append((sheet.get('name') or '', 'xl/' + target.removeprefix('/xl/').lstrip('/')))
    if sheets:
        return sheets
    return [('', name) for name in _numbered(archive.namelist(), r'xl/worksheets/sheet(\d+)\.xml')]


def _cell_value(cell: ET.Element, strings: list[str]) -> str:
    kind = cell.get('t')
    if kind == 'inlineStr':
        return ''.join(text.text or '' for text in cell.iter(f'{_S}t'))
    value = cell.find(f'{_S}v')
    raw = '' if value is None or value.text is None else value.text
    if kind == 's' and raw.isdigit() and int(raw) < len(strings):
        return strings[int(raw)]
    return raw


def _xlsx_text(data: bytes) -> str:
    archive = _open_zip(data, 'Excel')
    strings = _shared_strings(archive)
    blocks: list[str] = []
    for name, part in _sheet_targets(archive):
        root = _part(archive, part)
        if root is None:
            continue
        rows = []
        for row in root.iter(f'{_S}row'):
            cells = [_cell_value(cell, strings).strip() for cell in row.iter(f'{_S}c')]
            if any(cells):
                rows.append(' | '.join(cells))
        if rows:
            blocks.append('\n'.join([f'## {name}' if name else '##', *rows]))
    return '\n\n'.join(blocks)


# ── PDF ─────────────────────────────────────────────────────────────────────────────────────────────────────────


def _pdf_pages(data: bytes) -> tuple[list[str], int]:
    """The text of each page read (at most ``MAX_PAGES``) and the document's page count."""
    from pypdf import (
        PdfReader,  # in the projects API's signing-deps layer; imported here, so other formats never load it
    )
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(data))
        locked = reader.is_encrypted and not reader.decrypt('')
        total = 0 if locked else len(reader.pages)
        pages = [] if locked else [(page.extract_text() or '') for page in reader.pages[:MAX_PAGES]]
    except (PdfReadError, ValueError, KeyError, TypeError, AttributeError, IndexError, RecursionError) as exc:
        raise ExtractionError('This PDF could not be read. Save it again and upload it.') from exc
    if locked:
        raise ExtractionError('This PDF is protected by a password. Upload a copy without one.')
    return [_tidy(page) for page in pages], total


def _looks_scanned(pages: list[str]) -> bool:
    return sum(len(page) for page in pages) < SCANNED_CHARS_PER_PAGE * max(1, len(pages))


# ── The dispatch ────────────────────────────────────────────────────────────────────────────────────────────────

_TEXT_READERS: Final[dict[str, Callable[[bytes], str]]] = {
    'txt': lambda data: _tidy(_decoded(data)), 'md': lambda data: _decoded(data).strip(),
    'csv': _csv_text, 'html': _html_text, 'docx': _docx_text, 'xlsx': _xlsx_text,
}
#: Formats only Bedrock reads (no standard-library reader), as a Converse document.
_MODEL_READ_DOCUMENTS: Final = frozenset({'doc', 'xls'})
MODEL_READ_LIMIT_MESSAGE: Final = ('Files of this type are read by the AI model, which takes at most 4.5 MB. '
                                   'Save it as {suggestion} and upload it again.')


def _capped(text: str, pages: int | None, method: str, *, cut: bool = False) -> Extraction:
    if not text.strip():
        raise ExtractionError('No text could be found in this file.')
    if len(text) > MAX_TEXT_CHARS:
        return Extraction(text[:MAX_TEXT_CHARS], pages, True, method)
    return Extraction(text, pages, cut, method)


def _read_pdf(data: bytes, describe: Describe) -> Extraction:
    pages, total = _pdf_pages(data)
    if not _looks_scanned(pages):
        return _capped(PAGE_BREAK.join(pages), len(pages), 'text', cut=total > len(pages))
    if len(data) > MAX_NATIVE_DOCUMENT_BYTES:
        raise ExtractionError('This PDF has no text layer (scanned pages), and the AI model reads such a PDF only '
                              'up to 4.5 MB. Upload a smaller copy, or one with its text.')
    return _capped(describe('pdf', data, 'document'), total or None, 'model', cut=total > MAX_PAGES)


def extract(fmt: Format, data: bytes, describe: Describe) -> Extraction:
    """The text of ``data`` (a file of ``fmt``); ``ExtractionError`` with the person's message when it has none."""
    if fmt.name == 'pdf':
        return _read_pdf(data, describe)
    if fmt.name == 'pptx':
        pages = _pptx_pages(data)
        return _capped(PAGE_BREAK.join(pages), len(pages), 'text')
    reader = _TEXT_READERS.get(fmt.name)
    if reader is not None:
        return _capped(reader(data), None, 'text')
    if fmt.kind == 'image':
        if len(data) > MAX_NATIVE_IMAGE_BYTES:
            raise ExtractionError('Images are described by the AI model, which takes at most 3.75 MB.')
        return _capped(describe(fmt.name, data, 'image'), None, 'model')
    if fmt.name in _MODEL_READ_DOCUMENTS:
        if len(data) > MAX_NATIVE_DOCUMENT_BYTES:
            suggestion = '.docx' if fmt.name == 'doc' else '.xlsx'
            raise ExtractionError(MODEL_READ_LIMIT_MESSAGE.format(suggestion=suggestion))
        return _capped(describe(fmt.name, data, 'document'), None, 'model')
    raise ExtractionError('This file type is not supported.')


# ── Passages ────────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Chunk:
    """One passage: its text and the page it starts on (None for a document without pages)."""

    text: str
    page: int | None


def _cut_at(text: str, start: int) -> int:
    """Where a passage starting at ``start`` ends: at ``CHUNK_CHARS``, moved back to the last paragraph, line or
    sentence end in its second half when there is one."""
    end = start + CHUNK_CHARS
    if end >= len(text):
        return len(text)
    window = text[start + CHUNK_CHARS // 2:end]
    for mark in ('\n\n', '\n', '. ', ' '):
        found = window.rfind(mark)
        if found >= 0:
            return start + CHUNK_CHARS // 2 + found + len(mark)
    return end


def _passages(text: str) -> Iterator[str]:
    start = 0
    while start < len(text):
        end = _cut_at(text, start)
        piece = text[start:end].strip()
        if piece:
            yield piece
        if end >= len(text):
            return
        start = max(end - CHUNK_OVERLAP, start + 1)


def chunk_pages(text: str, *, paged: bool) -> tuple[list[Chunk], bool]:
    """The passages of ``text`` (a paged text's per page, each knowing its page) and whether ``MAX_CHUNKS`` cut it."""
    pages = text.split(PAGE_BREAK) if paged else [text]
    chunks: list[Chunk] = []
    for number, page in enumerate(pages, start=1):
        for piece in _passages(page):
            if len(chunks) >= MAX_CHUNKS:
                return chunks, True
            chunks.append(Chunk(piece, number if paged else None))
    return chunks, False
