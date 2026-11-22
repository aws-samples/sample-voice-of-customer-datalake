"""shared/import_detect.py and shared/import_dates.py: what each column of an imported file holds (the import wizard,
7.67.00, docs/import-wizard.md).

Fixtures: an app store export, a support-ticket export, a survey export with multiple choice and matrix cells,
Polish and Spanish headers, and a file with a byte-order mark, ``;`` separators and Excel dates. Every person and
company in them is made up (Example Ltd).
"""
from __future__ import annotations

import io
import zipfile

import pytest

from shared.exceptions import ValidationError
from shared.import_dates import infer_date_order, is_excel_serial, normalise_date
from shared.import_detect import (
    KINDS,
    detect_columns,
    fold,
    parse_sample,
    reason_text,
    rows_table,
    split_choices,
    split_matrix,
    suggest_target,
)
from shared.library_extract import ExtractionError, xlsx_rows

STORE_EXPORT = (
    'review_id,date,rating,title,review,country,app_version\n'
    'a1,2026-03-01,5,Love it,Great app for planning my week,US,4.2\n'
    'a2,2026-03-02,1,Crashes,It crashes every time I open the camera,DE,4.2\n'
    'a3,2026-03-02,3,OK,Does the job but sync is slow on weekends,US,4.1\n'
    'a4,2026-03-03,4,Nice,Clean design and the widgets are useful,FR,4.2\n'
    'a5,2026-03-04,2,Meh,Login fails after the update every morning,US,4.1\n'
)
TICKET_EXPORT = (
    'Ticket ID,Created,Channel,Subject,Description,Requester email,Satisfaction\n'
    'T-100,03/14/2026 09:30,email,Refund,I was charged twice for the same order,ana@example.com,2\n'
    'T-101,03/15/2026 10:00,chat,Delivery,The parcel arrived two days late again,bo@example.com,4\n'
    'T-102,03/16/2026 11:00,phone,Login,Cannot log in since the password reset,cy@example.com,1\n'
    'T-103,03/17/2026 12:00,email,Invoice,Please send the invoice with the VAT number,di@example.com,5\n'
)
SURVEY_EXPORT = (
    'Response ID,Submitted,How likely are you to recommend us?,Which plan?,Features used,Rate the workshop,'
    'What could we improve?,Email\n'
    'r1,14/03/2026 09:30,9,Pro,"Reports; Alerts","Content -- Good; Pace -- Too fast",More hands-on time please,'
    'ana@example.com\n'
    'r2,15/03/2026 10:00,6,Free,Alerts,"Content -- Excellent; Pace -- Right",Shorter breaks between parts,'
    'bo@example.com\n'
    'r3,16/03/2026 11:00,10,Pro,Reports,"Content -- Good; Pace -- Right",Nothing to add really,cy@example.com\n'
    'r4,17/03/2026 12:00,0,Team,"Reports; Exports","Content -- Poor; Pace -- Too slow",The room was too cold,'
    'di@example.com\n'
)
POLISH = (
    'Identyfikator;Data wysłania;Jak bardzo prawdopodobne jest, że polecisz nas znajomemu?;Komentarz\n'
    '1;2026-03-01;8;Bardzo dobra obsługa klienta\n'
    '2;2026-03-02;3;Za długo czekałem na odpowiedź\n'
    '3;2026-03-03;10;Wszystko działa bez zarzutu\n'
)
SPANISH = (
    'Fecha,Valoración,Comentario,Nombre\n'
    '45231,5,Muy buen servicio en general,Ana López\n'
    '45232.5,2,La aplicación se cierra sola,Juan Pérez\n'
    '45233,4,Rápido y fácil de usar,Marta Ruiz\n'
)
BOM_SEMICOLONS = (
    '\ufeffFecha de envío;¿Recomendaría Example Ltd?;Motivo\n'
    '46095;9;"Buena atención; rápida"\n'
    '46096,5;4;Precio alto\n'
    '46097;10;Todo bien\n'
)


def _kinds(text: str, fmt: str = 'csv') -> dict[str, str]:
    return {column.header: column.kind for column in detect_columns(parse_sample(fmt, text))}


class TestReadingTheSample:
    def test_a_byte_order_mark_and_semicolons_are_read(self):
        table = parse_sample('csv', BOM_SEMICOLONS)
        assert table.delimiter == ';'
        assert table.headers == ['Fecha de envío', '¿Recomendaría Example Ltd?', 'Motivo']
        assert table.rows[0]['Motivo'] == 'Buena atención; rápida'

    def test_a_tsv_is_read_on_tabs(self):
        table = parse_sample('tsv', 'a\tb\n1\t2\n')
        assert (table.delimiter, table.rows) == ('\t', [{'a': '1', 'b': '2'}])

    def test_a_truncated_sample_drops_its_last_row(self):
        assert len(parse_sample('csv', 'a,b\n1,2\n3,4', truncated=True).rows) == 1

    def test_blank_and_repeated_headers_are_named_by_position(self):
        assert parse_sample('csv', 'a,,a\n1,2,3\n').headers == ['a', 'Column 2', 'a (3)']

    def test_json_arrays_objects_and_lines_are_read(self):
        assert parse_sample('json', '[{"a": 1, "b": ["x", "y"]}]').rows == [{'a': '1', 'b': 'x; y'}]
        assert parse_sample('json', '{"responses": [{"a": true}]}').rows == [{'a': 'true'}]
        assert parse_sample('json', '{"a": 1}\n{"a": 2, "b": null}\n').rows == [{'a': '1', 'b': ''}, {'a': '2', 'b': ''}]

    @pytest.mark.parametrize(('fmt', 'text', 'code'), [
        ('json', 'not json at all', 'file_unreadable'), ('json', '[]', 'file_empty'), ('csv', '\n\n', 'file_empty'),
        ('pdf', 'x', 'format_invalid'),
    ])
    def test_an_unreadable_sample_is_a_coded_refusal(self, fmt, text, code):
        with pytest.raises(ValidationError) as caught:
            parse_sample(fmt, text)
        assert caught.value.code == code

    def test_a_workbook_is_read_by_cell_position(self):
        rows = xlsx_rows(_workbook([('A1', 's', 0), ('B1', 's', 1), ('A2', 'n', '46095'), ('C2', 's', 2)],
                                   ['Date', 'Score', 'Late']), 10)
        assert rows == [['Date', 'Score'], ['46095', '', 'Late']]
        table = rows_table(rows)
        assert table.rows == [{'Date': '46095', 'Score': ''}]

    def test_a_file_that_is_no_workbook_is_refused(self):
        with pytest.raises(ExtractionError):
            xlsx_rows(b'not a zip', 10)


def _workbook(cells: list[tuple[str, str, object]], strings: list[str]) -> bytes:
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    rows: dict[str, list[str]] = {}
    for ref, kind, value in cells:
        cell = f'<c r="{ref}" t="s"><v>{value}</v></c>' if kind == 's' else f'<c r="{ref}"><v>{value}</v></c>'
        rows.setdefault(ref[1:], []).append(cell)
    sheet = f'<worksheet xmlns="{ns}"><sheetData>' + ''.join(
        f'<row r="{number}">{"".join(row)}</row>' for number, row in rows.items()) + '</sheetData></worksheet>'
    shared = f'<sst xmlns="{ns}">' + ''.join(f'<si><t>{text}</t></si>' for text in strings) + '</sst>'
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as archive:
        archive.writestr('xl/worksheets/sheet1.xml', sheet)
        archive.writestr('xl/sharedStrings.xml', shared)
    return data.getvalue()


class TestColumns:
    def test_a_store_export(self):
        assert _kinds(STORE_EXPORT) == {
            'review_id': 'id', 'date': 'date', 'rating': 'rating_1_5', 'title': 'choice', 'review': 'open_text',
            'country': 'choice', 'app_version': 'choice'}
        assert suggest_target(detect_columns(parse_sample('csv', STORE_EXPORT))) == 'reviews'

    def test_a_ticket_export_keeps_its_requesters_out(self):
        columns = {c.header: c for c in detect_columns(parse_sample('csv', TICKET_EXPORT))}
        assert {header: column.kind for header, column in columns.items()} == {
            'Ticket ID': 'id', 'Created': 'date', 'Channel': 'channel', 'Subject': 'choice',
            'Description': 'open_text', 'Requester email': 'email', 'Satisfaction': 'csat'}
        assert columns['Requester email'].view()['personal'] is True
        assert columns['Requester email'].values == []  # no address reaches the answer
        assert columns['Created'].date_order == 'mdy'
        assert suggest_target(list(columns.values())) == 'reviews'

    def test_a_survey_export_with_matrix_cells(self):
        columns = {c.header: c for c in detect_columns(parse_sample('csv', SURVEY_EXPORT))}
        assert {header: column.kind for header, column in columns.items()} == {
            'Response ID': 'id', 'Submitted': 'date', 'How likely are you to recommend us?': 'nps_0_10',
            'Which plan?': 'choice', 'Features used': 'multi_choice', 'Rate the workshop': 'matrix_cell',
            'What could we improve?': 'open_text', 'Email': 'email'}
        nps = columns['How likely are you to recommend us?']
        assert nps.confidence >= 0.9
        assert reason_text(nps.reasons) == "values 0-10, the header says 'recommend'"
        assert columns['Features used'].separator == ';'
        assert columns['Rate the workshop'].values[:2] == ['Content', 'Pace']
        assert suggest_target(list(columns.values())) == 'survey'

    def test_polish_headers(self):
        assert _kinds(POLISH) == {
            'Identyfikator': 'id', 'Data wysłania': 'date',
            'Jak bardzo prawdopodobne jest, że polecisz nas znajomemu?': 'nps_0_10', 'Komentarz': 'open_text'}

    def test_spanish_headers_excel_dates_and_names(self):
        assert _kinds(SPANISH) == {'Fecha': 'date', 'Valoración': 'rating_1_5', 'Comentario': 'open_text',
                                   'Nombre': 'name'}

    def test_an_excel_serial_is_a_date_only_under_a_date_header(self):
        # Five-digit ids and counts fall in the serials' range (20,000 to 80,000): only a date header makes them dates.
        assert _kinds('Ticket ID,Order,Fecha\n45001,45100,45231\n45002,45230,45232\n45003,45231,45233\n') == {
            'Ticket ID': 'id', 'Order': 'id', 'Fecha': 'date'}

    def test_a_bom_semicolons_and_excel_dates(self):
        columns = detect_columns(parse_sample('csv', BOM_SEMICOLONS))
        assert [(c.kind, c.reasons[0]['code']) for c in columns][:2] == [('date', 'excel_serial'),
                                                                         ('nps_0_10', 'values_range')]

    def test_names_are_found_by_their_shape_too(self):
        text = 'Person,Note\nAnna Kowalska,ok\nJan Nowak,fine\nMaria Garcia,good\nLee Chen,bad\nOla Smith,ok\n'
        assert _kinds(text)['Person'] == 'name'

    def test_a_ten_point_rating_and_a_zero_scale(self):
        assert _kinds('Score\n1\n7\n10\n')['Score'] == 'rating_1_10'
        assert _kinds('Q1\n0\n4\n9\n')['Q1'] == 'nps_0_10'

    def test_an_empty_column_is_ignored(self):
        assert _kinds('a,b\nx,\ny,\n')['b'] == 'ignore'

    def test_urls_and_big_numbers(self):
        kinds = _kinds('Link,Count\nhttps://example.com/a,120\nhttps://example.com/b,120\nhttps://example.com/c,450\n')
        assert kinds == {'Link': 'url', 'Count': 'ignore'}

    def test_two_scales_or_no_text_is_a_survey(self):
        assert suggest_target(detect_columns(parse_sample('csv', 'Q1,Q2\n1,5\n2,4\n3,3\n'))) == 'survey'
        assert suggest_target(detect_columns(parse_sample('csv', 'Plan,Size\nPro,S\nFree,M\nPro,S\nFree,L\n'))) == 'survey'

    def test_every_kind_is_known(self):
        kinds = {column.kind for text in (STORE_EXPORT, TICKET_EXPORT, SURVEY_EXPORT, POLISH, SPANISH)
                 for column in detect_columns(parse_sample('csv', text))}
        assert kinds <= set(KINDS)


class TestCells:
    def test_choices_split_on_semicolons_before_commas(self):
        assert split_choices('a; b, c') == (['a', 'b, c'], ';')
        assert split_choices('a, b') == (['a', 'b'], ',')
        assert split_choices('  ') == ([], None)

    def test_matrix_cells(self):
        assert split_matrix('Content -- Good; Pace -- Right') == [('Content', 'Good'), ('Pace', 'Right')]
        assert split_matrix('Content -- Good; Pace') is None

    def test_headers_fold_accents_and_the_polish_l(self):
        assert fold('Data wysłania — ¿Recomendaría?') == 'data wyslania recomendaria'


class TestDates:
    @pytest.mark.parametrize(('value', 'order', 'iso'), [
        ('2026-03-14', 'dmy', '2026-03-14T00:00:00+00:00'),
        ('2026-03-14T09:30:00Z', 'dmy', '2026-03-14T09:30:00+00:00'),
        ('2026-03-14T09:30:00+02:00', 'dmy', '2026-03-14T07:30:00+00:00'),
        ('14/03/2026 9:30', 'dmy', '2026-03-14T09:30:00+00:00'),
        ('03/14/2026 9:30 PM', 'mdy', '2026-03-14T21:30:00+00:00'),
        ('14.03.26', 'dmy', '2026-03-14T00:00:00+00:00'),
        ('46095', 'dmy', '2026-03-14T00:00:00+00:00'),
        ('46095.5', 'dmy', '2026-03-14T12:00:00+00:00'),
    ])
    def test_a_date_reads_as_utc(self, value, order, iso):
        assert normalise_date(value, order) == iso

    @pytest.mark.parametrize('value', ['', 'soon', '31/02/2026', '123', '14/13/2026', None])
    def test_a_value_that_is_no_date(self, value):
        assert normalise_date(value, 'dmy') is None

    def test_the_order_of_a_column(self):
        assert infer_date_order(['03/14/2026', '03/15/2026']) == 'mdy'
        assert infer_date_order(['14/03/2026', '01/02/2026']) == 'dmy'
        assert infer_date_order(['2026/03/14']) == 'ymd'
        assert infer_date_order(['01/02/2026']) == 'dmy'

    def test_excel_serials_are_a_range(self):
        assert is_excel_serial('46095')
        assert not is_excel_serial('12345')
        assert not is_excel_serial('99999')
