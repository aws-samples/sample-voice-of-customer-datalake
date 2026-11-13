"""jobs/workspace_export/zip_stream.py: a streaming ZIP64 that Python's zipfile reads back (CRCs checked), cut into
parts and resumed across invocations with the very bytes one writer would have written."""
from __future__ import annotations

import hashlib
import io
import shutil
import struct
import subprocess
import zipfile
import zlib
from datetime import UTC, datetime

import pytest

from jobs.workspace_export.zip_stream import (
    MIN_PART_SIZE,
    PART_SIZE,
    ExportTooLarge,
    PartSink,
    ZipState,
    ZipWriter,
    count_central_records,
)

MODIFIED = datetime(2026, 11, 13, 9, 30, 15, tzinfo=UTC)
#: Small parts for the tests: the sink's rules are the same at any size.
SMALL_PART, SMALL_MIN = 4096, 1024


class Bytes:
    """A sink that keeps everything (one writer, no parts)."""

    def __init__(self) -> None:
        self.data = bytearray()

    def write(self, data: bytes) -> None:
        self.data += data


class Parts:
    """S3's side of one multipart upload: parts by number."""

    def __init__(self) -> None:
        self.parts: dict[int, bytes] = {}

    def upload(self, number: int, body: bytes) -> None:
        assert number not in self.parts, 'a part is uploaded once'
        self.parts[number] = body

    def joined(self) -> bytes:
        assert sorted(self.parts) == list(range(1, len(self.parts) + 1))
        return b''.join(self.parts[number] for number in sorted(self.parts))


def _lines(name: str, count: int) -> list[bytes]:
    """JSONL rows with a digest each, so DEFLATE cannot shrink them to nothing (the zip spans several parts)."""
    return [f'{{"entity":"{name}","n":{n},"id":"{hashlib.sha256(f"{name}{n}".encode()).hexdigest()}"}}\n'.encode()
            for n in range(count)]


FILES = {
    'feedback/feedback-0001.jsonl': _lines('feedback', 400),
    'feedback/feedback-0002.jsonl': _lines('feedback-2', 250),
    'members/members-0001.jsonl': _lines('members', 3),
    'empty/empty-0001.jsonl': [],
    'manifest.json': [b'{"format": "voc-workspace-export"}\n'],
}


def _one_shot() -> bytes:
    sink = Bytes()
    writer = ZipWriter(sink, MODIFIED)
    records = bytearray()
    for name, lines in FILES.items():
        entry = writer.open_entry(name)
        for line in lines:
            entry.write(line)
        records += entry.close()
    writer.finish(bytes(records))
    return bytes(sink.data)


def _read(data: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        assert archive.testzip() is None, 'every CRC checks'
        return {info.filename: archive.read(info) for info in archive.infolist()}


def test_python_reads_every_entry_back_with_its_crc():
    files = _read(_one_shot())
    assert files == {name: b''.join(lines) for name, lines in FILES.items()}


def test_every_entry_is_deflate_utf8_with_a_data_descriptor_and_zip64_extras():
    data = _one_shot()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for info in archive.infolist():
            assert info.compress_type == zipfile.ZIP_DEFLATED
            assert info.flag_bits & 0x0808 == 0x0808
            assert info.extract_version == 45
            assert info.date_time == (2026, 11, 13, 9, 30, 14)
    # The central directory's sizes and offset all point to the ZIP64 extra; the archive ends with the ZIP64 records.
    assert data[-22:-18] == struct.pack('<I', 0x06054B50)
    assert data[-42:-38] == struct.pack('<I', 0x07064B50)
    assert data[-98:-94] == struct.pack('<I', 0x06064B50)
    assert struct.unpack_from('<HHHHIIH', data, len(data) - 18) == (0, 0, 0xFFFF, 0xFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0)


def test_a_sequential_walk_of_the_stream_matches_the_central_directory():
    """A reader that never looks at the central directory first (a streaming unzip): each local header, its raw
    DEFLATE data inflated to its end, then its ZIP64 data descriptor, whose CRC and sizes are the central
    directory's and the data's own."""
    data = _one_shot()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        central = {info.filename: info for info in archive.infolist()}
    position, seen = 0, []
    while data[position:position + 4] == b'PK\x03\x04':
        (_signature, version, flags, method, _time, _date, local_crc, local_compressed, local_size, name_length,
         extra_length) = struct.unpack_from('<IHHHHHIIIHH', data, position)
        name = data[position + 30:position + 30 + name_length].decode('utf-8')
        start = position + 30 + name_length + extra_length
        inflater = zlib.decompressobj(-15)
        body = inflater.decompress(data[start:])
        compressed = len(data) - start - len(inflater.unused_data)
        signature, crc, compressed_size, size = struct.unpack_from('<IIQQ', inflater.unused_data)
        info = central[name]
        assert (version, flags & 0x0808, method) == (45, 0x0808, zipfile.ZIP_DEFLATED)
        assert (local_crc, local_compressed, local_size) == (0, 0xFFFFFFFF, 0xFFFFFFFF)
        assert (signature, crc, compressed_size, size) == (0x08074B50, info.CRC, info.compress_size, info.file_size)
        assert (compressed, len(body), zlib.crc32(body)) == (compressed_size, size, crc)
        seen.append(name)
        position = start + compressed + 24
    assert seen == list(FILES)
    assert data[position:position + 4] == b'PK\x01\x02'


@pytest.mark.skipif(shutil.which('unzip') is None, reason='unzip is not on PATH')
def test_unzip_tests_the_archive(tmp_path):
    path = tmp_path / 'export.zip'
    path.write_bytes(_one_shot())
    unzip = shutil.which('unzip') or 'unzip'
    result = subprocess.run([unzip, '-t', str(path)], capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stdout + result.stderr


def test_a_writer_resumed_across_generations_writes_the_one_shot_bytes():
    """Three or more invocations, each with its own sink and writer: only ZipState, the tail and the records cross."""
    parts = Parts()
    state, tail, next_part, records = ZipState(), b'', 1, bytearray()
    names = list(FILES)
    generations = [names[:1], names[1:2], names[2:4], names[4:]]
    for index, chunk in enumerate(generations):
        sink = PartSink(parts.upload, next_part=next_part, tail=tail, part_size=SMALL_PART, min_part=SMALL_MIN)
        writer = ZipWriter(sink, MODIFIED, state)
        for name in chunk:
            entry = writer.open_entry(name)
            for line in FILES[name]:
                entry.write(line)
            records += entry.close()
        if index < len(generations) - 1:
            state = writer.state
            next_part, tail = sink.hand_over()
            assert len(tail) < SMALL_MIN
        else:
            writer.finish(bytes(records))
            sink.close()
    assert len(parts.parts) >= 3
    joined = parts.joined()
    assert joined == _one_shot()
    assert _read(joined) == {name: b''.join(lines) for name, lines in FILES.items()}


def test_every_part_but_the_last_is_at_least_the_minimum():
    parts = Parts()
    sink = PartSink(parts.upload, part_size=SMALL_PART, min_part=SMALL_MIN)
    sink.write(b'a' * (SMALL_PART + 10))
    assert sink.hand_over() == (2, b'a' * 10)  # 10 bytes stay a tail: below the minimum
    sink = PartSink(parts.upload, next_part=2, tail=b'a' * 10, part_size=SMALL_PART, min_part=SMALL_MIN)
    sink.write(b'b' * SMALL_MIN)
    assert sink.hand_over() == (3, b'')  # at least the minimum: it goes up as a part
    sink = PartSink(parts.upload, next_part=3, part_size=SMALL_PART, min_part=SMALL_MIN)
    sink.write(b'c' * 5)
    uploaded = sink.close()
    assert uploaded == 3
    sizes = [len(parts.parts[number]) for number in sorted(parts.parts)]
    assert sizes == [SMALL_PART, SMALL_MIN + 10, 5]
    assert all(size >= SMALL_MIN for size in sizes[:-1])


def test_a_tiny_zip_is_one_last_part():
    parts = Parts()
    sink = PartSink(parts.upload)
    writer = ZipWriter(sink, MODIFIED)
    record = writer.open_entry('manifest.json').close()
    writer.finish(record)
    uploaded = sink.close()
    assert uploaded == 1
    assert _read(parts.joined()) == {'manifest.json': b''}


def test_the_real_part_sizes_are_s3s():
    assert (PART_SIZE, MIN_PART_SIZE) == (64 * 1024 * 1024, 5 * 1024 * 1024)


def test_more_parts_than_s3_allows_is_refused():
    sink = PartSink(lambda _number, _body: None, part_size=SMALL_PART, min_part=SMALL_MIN, max_parts=2)
    sink.write(b'x' * (2 * SMALL_PART))
    with pytest.raises(ExportTooLarge):
        sink.write(b'x' * SMALL_PART)


def test_forced_zip64_offsets_past_4_gib_are_read_back(tmp_path):
    """A zip whose entries sit past the 32-bit limit (the state of a writer that already wrote 5 GiB): every offset
    lives in the ZIP64 fields, and Python finds each entry through them. The 5 GiB before them are a sparse hole."""
    base = 5 * 1024 ** 3
    sink = Bytes()
    writer = ZipWriter(sink, MODIFIED, ZipState(offset=base, entries=0))
    records = bytearray()
    for name, body in (('a.jsonl', b'{"a":1}\n' * 50), ('b.jsonl', b'{"b":2}\n')):
        entry = writer.open_entry(name)
        entry.write(body)
        records += entry.close()
    writer.finish(bytes(records))
    path = tmp_path / 'shifted.zip'
    with path.open('wb') as file:
        file.seek(base)
        file.write(bytes(sink.data))

    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        assert [info.header_offset > 0xFFFFFFFF for info in infos] == [True, True]
        assert archive.read('a.jsonl') == b'{"a":1}\n' * 50
        assert archive.read('b.jsonl') == b'{"b":2}\n'


def test_the_finish_refuses_records_that_are_not_every_entry():
    sink = Bytes()
    writer = ZipWriter(sink, MODIFIED)
    first = writer.open_entry('a.jsonl').close()
    writer.open_entry('b.jsonl').close()
    with pytest.raises(ValueError, match='every entry'):
        writer.finish(first)
    assert count_central_records(first) == 1
    with pytest.raises(ValueError, match='truncated'):
        count_central_records(first[:-1])


@pytest.mark.parametrize('name', ['', '/abs', 'a//b', '../up', 'a/./b', 'win\\dows', 'nul\x00'])
def test_an_entry_name_is_a_plain_relative_path(name):
    with pytest.raises(ValueError, match='entry name'):
        ZipWriter(Bytes(), MODIFIED).open_entry(name)


def test_one_entry_at_a_time_and_no_state_while_one_is_open():
    writer = ZipWriter(Bytes(), MODIFIED)
    entry = writer.open_entry('a.jsonl')
    with pytest.raises(ValueError, match='already open'):
        writer.open_entry('b.jsonl')
    with pytest.raises(ValueError, match='close it before handing over'):
        _ = writer.state
    entry.close()
    with pytest.raises(ValueError, match='closed'):
        entry.write(b'late')
    assert writer.state.entries == 1


def test_the_state_round_trips_and_refuses_nonsense():
    state = ZipState(offset=123, entries=4)
    assert ZipState.from_json(state.to_json()) == state
    assert ZipState.from_json(None) == ZipState()
    with pytest.raises(ValueError, match='zip state'):
        ZipState.from_json({'offset': -1, 'entries': 0})
