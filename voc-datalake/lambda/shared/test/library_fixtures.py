"""Files of every Documents Library format, built in memory (fictional content only), for the library's tests."""
from __future__ import annotations

import io
import zipfile

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'


def zipped(parts: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        for name, text in parts.items():
            archive.writestr(name, text)
    return buffer.getvalue()


def docx(*paragraphs: str) -> bytes:
    body = ''.join(f'<w:p><w:r><w:t>{text}</w:t></w:r></w:p>' for text in paragraphs)
    return zipped({'word/document.xml': f'<w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>'})


def pptx(*slides: str) -> bytes:
    parts = {f'ppt/slides/slide{number}.xml':
             f'<p:sld xmlns:p="p" xmlns:a="{A}"><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:sld>'
             for number, text in enumerate(slides, start=1)}
    return zipped(parts)


def xlsx(sheet_name: str, rows: list[list[str]]) -> bytes:
    strings = [cell for row in rows for cell in row]
    shared = ''.join(f'<si><t>{cell}</t></si>' for cell in strings)
    cells, index = [], 0
    for row in rows:
        row_cells = ''
        for _cell in row:
            row_cells += f'<c t="s"><v>{index}</v></c>'
            index += 1
        cells.append(f'<row>{row_cells}</row>')
    return zipped({
        'xl/workbook.xml': f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets>'
                           f'<sheet name="{sheet_name}" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': f'<Relationships xmlns="{REL}">'
                                      '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/sharedStrings.xml': f'<sst xmlns="{S}">{shared}</sst>',
        'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{S}"><sheetData>{"".join(cells)}</sheetData></worksheet>',
    })


def pdf(*pages: str) -> bytes:
    """A small valid PDF, one page per text (Helvetica, one line each)."""
    objects: list[bytes] = []
    kids = ' '.join(f'{3 + index * 2} 0 R' for index in range(len(pages)))
    objects.append(b'<< /Type /Catalog /Pages 2 0 R >>')
    objects.append(f'<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>'.encode())
    font_id = 3 + len(pages) * 2
    for index, text in enumerate(pages):
        content = f'BT /F1 12 Tf 72 720 Td ({text}) Tj ET'.encode()
        objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {4 + index * 2} 0 R '
                       f'/Resources << /Font << /F1 {font_id} 0 R >> >> >>'.encode())
        objects.append(b'<< /Length %d >>\nstream\n' % len(content) + content + b'\nendstream')
    objects.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    out = io.BytesIO()
    out.write(b'%PDF-1.4\n')
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(f'{number} 0 obj\n'.encode() + body + b'\nendobj\n')
    xref = out.tell()
    out.write(f'xref\n0 {len(objects) + 1}\n0000000000 65535 f \n'.encode())
    for offset in offsets:
        out.write(f'{offset:010d} 00000 n \n'.encode())
    out.write(f'trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    return out.getvalue()


#: The smallest PNG (1x1), for an image item.
PNG = bytes.fromhex(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
    '0000000d4944415478da63f8cfc0f01f0005000201a5d6f1c20000000049454e44ae426082')
