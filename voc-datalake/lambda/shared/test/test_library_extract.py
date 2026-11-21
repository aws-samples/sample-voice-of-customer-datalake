"""The Documents Library's text extraction and passages (shared/library_extract.py, docs/documents-library.md)."""
from __future__ import annotations

import pytest

from shared import library_extract as ex
from shared.test.library_fixtures import PNG, A, docx, pdf, pptx, xlsx, zipped


def _never(*_args: object) -> ex.Reading:
    raise AssertionError('the model was asked to read a file the standard library reads')


def _format(content_type: str) -> ex.Format:
    fmt = ex.format_of(content_type)
    assert fmt is not None
    return fmt


@pytest.mark.parametrize(('content_type', 'data', 'expected'), [
    ('text/plain', b'\xef\xbb\xbfFirst line\r\nSecond   line', 'First line\nSecond line'),
    ('text/markdown', b'# Title\n\n- a point', '# Title\n\n- a point'),
    ('text/csv', b'name,score\nAda,9\n,\n', 'name | score\nAda | 9'),
    ('text/html', (b'<html><head><title>x</title><style>p{}</style></head><body><h1>Report</h1>'
                   b'<script>alert(1)</script><p>Q3 &amp; Q4 grew</p></body></html>'), 'Report\n\nQ3 & Q4 grew'),
])
def test_text_formats_read_with_the_standard_library(content_type, data, expected):
    extraction = ex.extract(_format(content_type), data, _never)
    assert extraction.text == expected
    assert extraction.pages is None
    assert extraction.method == 'text'


def test_word_paragraphs_become_lines():
    fmt = _format('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    assert ex.extract(fmt, docx('Market report', 'Growth was 12%'), _never).text == 'Market report\nGrowth was 12%'


def test_an_excel_sheet_becomes_rows_under_its_name():
    fmt = _format('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    text = ex.extract(fmt, xlsx('Regions', [['Region', 'Sales'], ['North', '40']]), _never).text
    assert text == '## Regions\nRegion | Sales\nNorth | 40'


def test_a_presentation_is_paged_by_slide_in_number_order():
    fmt = _format('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    archive = zipped({'ppt/slides/slide10.xml': pptx_slide('Ten'), 'ppt/slides/slide2.xml': pptx_slide('Two')})
    extraction = ex.extract(fmt, archive, _never)
    assert extraction.text.split(ex.PAGE_BREAK) == ['Two', 'Ten']
    assert extraction.pages == 2
    assert not ex.is_native(fmt, 10)


def pptx_slide(text: str) -> str:
    return f'<p:sld xmlns:p="p" xmlns:a="{A}"><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:sld>'


def test_the_fixture_presentation_reads_too():
    fmt = _format('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    assert ex.extract(fmt, pptx('One', 'Two'), _never).pages == 2


def test_a_pdf_text_layer_is_read_page_by_page():
    first, second = 'Executive summary of the year for Example Ltd', 'The second page holds the regional results'
    extraction = ex.extract(_format('application/pdf'), pdf(first, second), _never)
    assert extraction.pages == 2
    assert extraction.text.split(ex.PAGE_BREAK) == [first, second]


def test_a_scanned_pdf_is_read_by_the_model_as_a_document():
    seen = []

    def describe(fmt: str, data: bytes, kind: str) -> ex.Reading:
        seen.append((fmt, kind, len(data)))
        return ex.Reading('Transcribed text of the scan')

    extraction = ex.extract(_format('application/pdf'), pdf(''), describe)
    assert extraction.text == 'Transcribed text of the scan'
    assert extraction.method == 'model'
    assert not extraction.truncated
    assert [entry[:2] for entry in seen] == [('pdf', 'document')]


def test_a_transcribed_scan_keeps_its_pages_only_when_the_model_separated_each_one():
    """A citation must not claim p.1 for a whole scan: the model's text is paged only when its form feeds split it
    into exactly the PDF's pages, else it is one text without pages (its form feeds made line breaks)."""
    scan = _format('application/pdf')
    split = ex.extract(scan, pdf('', '', ''), lambda *_: ex.Reading('One\fTwo\fThree'))
    assert (split.pages, split.text.split(ex.PAGE_BREAK)) == (3, ['One', 'Two', 'Three'])
    run_on = ex.extract(scan, pdf('', '', ''), lambda *_: ex.Reading('One Two Three'))
    assert (run_on.pages, run_on.text) == (None, 'One Two Three')
    miscounted = ex.extract(scan, pdf('', '', ''), lambda *_: ex.Reading('One\fTwo and three'))
    assert (miscounted.pages, miscounted.text) == (None, 'One\nTwo and three')
    chunks, _cut = ex.chunk_pages(run_on.text, paged=run_on.pages is not None)
    assert {chunk.page for chunk in chunks} == {None}


@pytest.mark.parametrize('content_type', ['application/pdf', 'image/png', 'application/msword'])
def test_a_model_reading_cut_at_its_token_cap_is_recorded_as_cut(content_type):
    data = pdf('') if content_type == 'application/pdf' else PNG if content_type == 'image/png' else b'legacy'
    cut = ex.extract(_format(content_type), data, lambda *_: ex.Reading('The first part', 'max_tokens'))
    whole = ex.extract(_format(content_type), data, lambda *_: ex.Reading('The first part', 'end_turn'))
    assert (cut.truncated, whole.truncated) == (True, False)


def test_a_scanned_pdf_over_the_model_limit_is_refused():
    big = pdf('') + b'%' * (ex.MAX_NATIVE_DOCUMENT_BYTES + 1)
    with pytest.raises(ex.ExtractionError, match=r'4\.5 MB'):
        ex.extract(_format('application/pdf'), big, _never)


def test_a_broken_pdf_is_refused_with_a_message():
    with pytest.raises(ex.ExtractionError, match='could not be read'):
        ex.extract(_format('application/pdf'), b'%PDF-1.4 nothing else', _never)


def test_an_image_is_described_by_the_model():
    extraction = ex.extract(_format('image/png'), PNG, lambda fmt, _data, kind: ex.Reading(f'{fmt} {kind} described'))
    assert extraction.text == 'png image described'
    assert ex.is_native(_format('image/png'), len(PNG))


@pytest.mark.parametrize(('content_type', 'suggestion'), [('application/msword', '.docx'),
                                                           ('application/vnd.ms-excel', '.xlsx')])
def test_legacy_office_files_are_read_by_the_model_up_to_its_limit(content_type, suggestion):
    fmt = _format(content_type)
    assert ex.extract(fmt, b'legacy', lambda *_: ex.Reading('Legacy text')).text == 'Legacy text'
    with pytest.raises(ex.ExtractionError, match=suggestion):
        ex.extract(fmt, b'x' * (ex.MAX_NATIVE_DOCUMENT_BYTES + 1), _never)


def test_an_xml_part_with_a_doctype_is_refused():
    bomb = zipped({'word/document.xml': '<!DOCTYPE lol [<!ENTITY a "aaaa">]><w:document xmlns:w="w">&a;</w:document>'})
    with pytest.raises(ex.ExtractionError, match='safely'):
        ex.extract(_format('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), bomb, _never)


def test_a_file_that_is_not_a_zip_is_refused():
    with pytest.raises(ex.ExtractionError, match='could not be opened'):
        ex.extract(_format('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), b'no', _never)


def test_a_file_with_no_text_is_refused():
    with pytest.raises(ex.ExtractionError, match='No text'):
        ex.extract(_format('text/plain'), b'   \n', _never)


def test_a_text_past_the_cap_is_cut_and_says_so(monkeypatch):
    monkeypatch.setattr(ex, 'MAX_TEXT_CHARS', 10)
    extraction = ex.extract(_format('text/plain'), b'0123456789ABCDEF', _never)
    assert (extraction.text, extraction.truncated) == ('0123456789', True)


def test_native_needs_a_converse_format_within_its_size():
    pdf_format = _format('application/pdf')
    assert ex.is_native(pdf_format, ex.MAX_NATIVE_DOCUMENT_BYTES)
    assert not ex.is_native(pdf_format, ex.MAX_NATIVE_DOCUMENT_BYTES + 1)
    assert not ex.is_native(_format('image/png'), ex.MAX_NATIVE_IMAGE_BYTES + 1)
    assert ex.format_of('application/zip') is None
    assert ex.format_of(None) is None


def test_passages_are_about_1800_characters_with_200_of_overlap():
    text = ' '.join(f'word{index:04d}' for index in range(1000))
    chunks, cut = ex.chunk_pages(text, paged=False)
    assert not cut
    assert all(len(chunk.text) <= ex.CHUNK_CHARS for chunk in chunks)
    assert len(chunks) > 4
    # Consecutive passages share their boundary text.
    assert chunks[0].text[-100:].split()[-1] in chunks[1].text
    assert all(chunk.page is None for chunk in chunks)


def test_paged_passages_know_their_page():
    chunks, _ = ex.chunk_pages(f'first page{ex.PAGE_BREAK}{ex.PAGE_BREAK}third page', paged=True)
    assert [(chunk.text, chunk.page) for chunk in chunks] == [('first page', 1), ('third page', 3)]


def test_passages_stop_at_the_cap(monkeypatch):
    monkeypatch.setattr(ex, 'MAX_CHUNKS', 2)
    chunks, cut = ex.chunk_pages(f'a{ex.PAGE_BREAK}b{ex.PAGE_BREAK}c', paged=True)
    assert cut
    assert [chunk.text for chunk in chunks] == ['a', 'b']


def test_a_zip_that_unpacks_past_the_total_cap_is_refused(monkeypatch):
    monkeypatch.setattr(ex, 'MAX_ZIP_TOTAL_BYTES', 10)
    with pytest.raises(ex.ExtractionError, match='too large to read once unpacked'):
        ex.extract(_format('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
                   docx('A paragraph longer than ten bytes'), _never)
