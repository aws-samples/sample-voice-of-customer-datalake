"""A streaming ZIP64 writer that can stop between entries and carry on in another invocation, and the part sink it
writes into (docs/multi-workspace.md, "Export and delete").

Pure: no AWS, no clock (its one import, shared/unicode_categories.py, is a constant). The export job (handler.py) wires it to one S3 multipart upload.

The zip (PKWARE APPNOTE 6.3.x):

* every entry is DEFLATE (or STORE, for bytes already compressed: an image, a zip, a gzip) with a data descriptor
  (flag bit 3) and UTF-8 names (bit 11), so it is written in one pass
  without seeking back: the local header carries zero CRC and sizes, the data descriptor after the data carries
  them (ZIP64 form: 8-byte sizes);
* ZIP64 always: the local header's sizes are 0xFFFFFFFF with a ZIP64 extra field, the central directory's sizes and
  offset are 0xFFFFFFFF with their 8-byte values in its ZIP64 extra field, and the archive ends with the ZIP64 end
  record, its locator and the end record (whose counts and sizes all read 0xFFFF / 0xFFFFFFFF), so no size or offset
  ever overflows (an export may exceed 4 GiB or 65,535 entries);
* every entry is opened, written and closed inside one invocation: the compressor never crosses a hand-over. What
  does is ``ZipState`` (the bytes written so far and the entries closed) and each entry's central-directory record
  (``ZipEntry.close`` returns it; the job keeps them and hands every one back to ``ZipWriter.finish``). Each entry's
  time is the export's own (``modified``), never the clock, so a resumed writer writes exactly the bytes one writer
  would have written in one go.

The part sink: ``PartSink`` cuts the stream into parts of ``PART_SIZE`` (64 MiB; S3's 10,000 parts cap an export at
640 GiB) for an injected ``upload(number, body)``. At a hand-over, ``hand_over`` uploads what is buffered as a part
when it is at least S3's minimum part (5 MiB) and returns the tail otherwise, for the job to keep until the next
invocation starts its sink with it; ``close`` uploads the last part, the only one S3 lets be smaller.
"""
from __future__ import annotations

import struct
import unicodedata
import zlib
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, Protocol

from shared.unicode_categories import DISGUISING_CATEGORIES

__all__ = ['BadEntryName', 'PartSink', 'ZipEntry', 'ZipState', 'ZipWriter', 'entry_name']

PART_SIZE: Final = 64 * 1024 * 1024
#: S3's minimum size of every part but the last.
MIN_PART_SIZE: Final = 5 * 1024 * 1024
#: S3's ceiling on the parts of one upload.
MAX_PARTS: Final = 10_000

_LOCAL_HEADER: Final = struct.Struct('<IHHHHHIIIHH')
_DATA_DESCRIPTOR: Final = struct.Struct('<IIQQ')
_CENTRAL_HEADER: Final = struct.Struct('<IHHHHHHIIIHHHHHII')
_ZIP64_END: Final = struct.Struct('<IQHHIIQQQQ')
_ZIP64_LOCATOR: Final = struct.Struct('<IIQI')
_END: Final = struct.Struct('<IHHHHIIH')
_ZIP64_LOCAL_EXTRA: Final = struct.Struct('<HHQQ')
_ZIP64_CENTRAL_EXTRA: Final = struct.Struct('<HHQQQ')

_LOCAL_HEADER_SIGNATURE: Final = 0x04034B50
_DATA_DESCRIPTOR_SIGNATURE: Final = 0x08074B50
_CENTRAL_HEADER_SIGNATURE: Final = 0x02014B50
_ZIP64_END_SIGNATURE: Final = 0x06064B50
_ZIP64_LOCATOR_SIGNATURE: Final = 0x07064B50
_END_SIGNATURE: Final = 0x06054B50
_ZIP64_EXTRA_ID: Final = 0x0001
#: 4.5: ZIP64. Made by: Unix (3) in the high byte, so the external attributes carry a Unix mode.
_VERSION_ZIP64: Final = 45
_VERSION_MADE_BY: Final = (3 << 8) | _VERSION_ZIP64
#: Bit 3 (sizes and CRC in the data descriptor) and bit 11 (UTF-8 names).
_FLAGS: Final = 0x0808
_DEFLATE: Final = 8
_STORE: Final = 0
_MAX16: Final = 0xFFFF
_MAX32: Final = 0xFFFFFFFF
_FILE_MODE: Final = 0o100644
#: The fixed part of the ZIP64 end record after its size field (APPNOTE 4.3.14.1).
_ZIP64_END_SIZE: Final = _ZIP64_END.size - 12
#: Raw DEFLATE (no zlib header), as a zip entry holds it, at one fixed level: a resumed writer must compress
#: exactly as the one before it did.
_LEVEL: Final = 6
_RAW_DEFLATE: Final = -15


class Sink(Protocol):
    """Where the zip's bytes go, in order."""

    def write(self, data: bytes) -> None: ...


class ExportTooLarge(ValueError):
    """The zip needs more parts than S3 allows in one upload (``MAX_PARTS`` parts of ``PART_SIZE``)."""


def _dos_time(moment: datetime) -> tuple[int, int]:
    """``(time, date)`` in MS-DOS form (2-second resolution, years 1980 to 2107)."""
    year = min(max(moment.year, 1980), 2107)
    date = ((year - 1980) << 9) | (moment.month << 5) | moment.day
    time = (moment.hour << 11) | (moment.minute << 5) | (moment.second // 2)
    return time, date


class BadEntryName(ValueError):
    """A name a zip entry may not carry; its message says which rule (``entry_name``)."""


#: Characters Windows refuses in a file name (beside ``/``, the zip's separator).
_WINDOWS_REFUSED: Final = frozenset('\\:<>"|?*')
#: Windows' reserved device names: a segment that is one of them (any case, with any extension) opens the device.
_WINDOWS_DEVICES: Final = frozenset({'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$',
                                     *(f'COM{n}' for n in range(1, 10)), *(f'LPT{n}' for n in range(1, 10))})


def _plain_segments(name: str) -> bool:
    """Every ``/`` segment of ``name`` is plain: not empty, ``.`` or ``..`` once trailing dots and spaces are dropped
    (as Windows drops them), and not a reserved device name with or without an extension."""
    for segment in name.split('/'):
        trimmed = segment.rstrip('. ')
        if trimmed in ('', '.', '..') or trimmed.split('.', 1)[0].rstrip(' ').upper() in _WINDOWS_DEVICES:
            return False
    return True


def entry_name(name: str) -> bytes:
    """``name`` as stored: no backslash or other character Windows refuses (``\\:<>"|?*``); no control, format (bidi,
    zero-width) or separator character (shared/unicode_categories.py ``DISGUISING_CATEGORIES``: each can disguise a
    name); a relative path of plain segments (``_plain_segments``), also in its NFKC form, which may hold no ``/`` or
    ``\\`` the name does not (a full-width solidus, reverse solidus or dot folds into one when a tool normalises
    it); valid UTF-8; at most 65,535 bytes. ``BadEntryName`` otherwise (an object's key is user data: the export
    skips one that fails and lists it)."""
    if any(char in _WINDOWS_REFUSED for char in name):
        raise BadEntryName('an entry name holds no backslash, nor any of :<>"|?*')
    if any(unicodedata.category(char) in DISGUISING_CATEGORIES for char in name):
        raise BadEntryName('an entry name holds no control, format (bidi, zero-width) or separator character')
    folded = unicodedata.normalize('NFKC', name)
    if any(char in _WINDOWS_REFUSED for char in folded):
        # A full-width colon, angle bracket, quote, bar, question mark or star folds into the character itself.
        raise BadEntryName('an entry name holds no backslash, nor any of :<>"|?*, also once normalised (NFKC)')
    if (not _plain_segments(name) or not _plain_segments(folded)
            or folded.count('/') != name.count('/')):
        raise BadEntryName('an entry name is a relative path of plain segments (no empty, "." or ".." segment, '
                           'nor one that is only dots and spaces, nor a reserved device name), also once '
                           'normalised (NFKC)')
    try:
        encoded = name.encode('utf-8')
    except UnicodeEncodeError:
        raise BadEntryName('an entry name is valid UTF-8') from None
    if len(encoded) > _MAX16:
        raise BadEntryName('an entry name is at most 65,535 bytes')
    return encoded


@dataclass(frozen=True)
class ZipState:
    """What a writer carries from one invocation to the next: the bytes written so far and the entries closed."""

    offset: int = 0
    entries: int = 0

    def to_json(self) -> dict[str, int]:
        return {'offset': self.offset, 'entries': self.entries}

    @classmethod
    def from_json(cls, value: object) -> ZipState:
        if not isinstance(value, dict):
            return cls()
        offset, entries = value.get('offset', 0), value.get('entries', 0)
        if not isinstance(offset, int) or not isinstance(entries, int) or offset < 0 or entries < 0:
            raise ValueError('not a zip state')
        return cls(offset=offset, entries=entries)


class ZipEntry:
    """One open entry: ``write`` its bytes, then ``close`` it (its central-directory record)."""

    def __init__(self, writer: ZipWriter, name: bytes, header_offset: int, method: int) -> None:
        self._writer = writer
        self._name = name
        self._header_offset = header_offset
        self._method = method
        self._compressor: Any = zlib.compressobj(_LEVEL, zlib.DEFLATED, _RAW_DEFLATE) if method == _DEFLATE else None
        self._crc = 0
        self._size = 0
        self._compressed = 0
        self._closed = False

    @property
    def size(self) -> int:
        """The bytes written into the entry so far (before compression)."""
        return self._size

    def write(self, data: bytes) -> None:
        if self._closed:
            raise ValueError('the entry is closed')
        if not data:
            return
        self._crc = zlib.crc32(data, self._crc)
        self._size += len(data)
        self._emit(data if self._compressor is None else self._compressor.compress(data))

    def _emit(self, chunk: bytes) -> None:
        if chunk:
            self._compressed += len(chunk)
            self._writer.emit(chunk)

    def close(self) -> bytes:
        """End the entry: the compressor's last bytes, the data descriptor; its central-directory record."""
        if self._closed:
            raise ValueError('the entry is closed')
        if self._compressor is not None:
            self._emit(self._compressor.flush())
        self._closed = True
        self._writer.emit(_DATA_DESCRIPTOR.pack(_DATA_DESCRIPTOR_SIGNATURE, self._crc, self._compressed, self._size))
        self._writer.entry_closed(self)
        extra = _ZIP64_CENTRAL_EXTRA.pack(_ZIP64_EXTRA_ID, _ZIP64_CENTRAL_EXTRA.size - 4, self._size,
                                          self._compressed, self._header_offset)
        time, date = self._writer.dos_time
        header = _CENTRAL_HEADER.pack(
            _CENTRAL_HEADER_SIGNATURE, _VERSION_MADE_BY, _VERSION_ZIP64, _FLAGS, self._method, time, date, self._crc,
            _MAX32, _MAX32, len(self._name), len(extra), 0, 0, 0, _FILE_MODE << 16, _MAX32)
        return header + self._name + extra


class ZipWriter:
    """A ZIP64 stream into ``sink``, from ``state`` on (a new zip, or one an earlier invocation began)."""

    def __init__(self, sink: Sink, modified: datetime, state: ZipState | None = None) -> None:
        self._sink = sink
        self._state = state or ZipState()
        self.dos_time = _dos_time(modified)
        self._open: ZipEntry | None = None
        self._finished = False

    @property
    def state(self) -> ZipState:
        """What the next invocation starts from; only between entries."""
        if self._open is not None:
            raise ValueError('an entry is open: close it before handing over')
        return self._state

    def emit(self, data: bytes) -> None:
        """Bytes of the stream, in order (the open entry's, or the writer's own)."""
        self._sink.write(data)
        self._state = ZipState(offset=self._state.offset + len(data), entries=self._state.entries)

    def entry_closed(self, entry: ZipEntry) -> None:
        if entry is not self._open:
            raise ValueError('not the open entry')
        self._open = None
        self._state = ZipState(offset=self._state.offset, entries=self._state.entries + 1)

    def open_entry(self, name: str, *, store: bool = False) -> ZipEntry:
        """Write ``name``'s local header and return the entry (one at a time): DEFLATE, or STORE (``store``: bytes
        already compressed, which DEFLATE would only make slower, not smaller)."""
        if self._open is not None or self._finished:
            raise ValueError('an entry is already open, or the zip is finished')
        encoded = entry_name(name)
        extra = _ZIP64_LOCAL_EXTRA.pack(_ZIP64_EXTRA_ID, _ZIP64_LOCAL_EXTRA.size - 4, 0, 0)
        time, date = self.dos_time
        method = _STORE if store else _DEFLATE
        entry = ZipEntry(self, encoded, self._state.offset, method)
        self.emit(_LOCAL_HEADER.pack(_LOCAL_HEADER_SIGNATURE, _VERSION_ZIP64, _FLAGS, method, time, date, 0,
                                     _MAX32, _MAX32, len(encoded), len(extra)) + encoded + extra)
        self._open = entry
        return entry

    def finish(self, central_directory: Iterable[bytes]) -> None:
        """End the zip: the central directory (every entry's record, in the order they were closed, from every
        invocation), the ZIP64 end record and locator, and the end record. ``central_directory`` is streamed chunk by
        chunk (each a whole number of records: one invocation's), so only one chunk is held at a time. ValueError
        when the records are not exactly the entries written (the zip is then unusable: the job fails)."""
        if self._open is not None or self._finished:
            raise ValueError('an entry is open, or the zip is finished')
        entries = self._state.entries
        start = self._state.offset
        records = 0
        for chunk in central_directory:
            records += count_central_records(chunk)
            self.emit(chunk)
        if records != entries:
            raise ValueError('the central directory does not hold every entry')
        end_of_directory = self._state.offset
        self.emit(_ZIP64_END.pack(_ZIP64_END_SIGNATURE, _ZIP64_END_SIZE, _VERSION_MADE_BY, _VERSION_ZIP64, 0, 0,
                                  entries, entries, end_of_directory - start, start))
        self.emit(_ZIP64_LOCATOR.pack(_ZIP64_LOCATOR_SIGNATURE, 0, end_of_directory, 1))
        self.emit(_END.pack(_END_SIGNATURE, 0, 0, _MAX16, _MAX16, _MAX32, _MAX32, 0))
        self._finished = True


def count_central_records(central_directory: bytes) -> int:
    """How many central-directory records ``central_directory`` holds, end to end (ValueError if malformed)."""
    count, position = 0, 0
    while position < len(central_directory):
        if len(central_directory) - position < _CENTRAL_HEADER.size:
            raise ValueError('a truncated central-directory record')
        fields = _CENTRAL_HEADER.unpack_from(central_directory, position)
        if fields[0] != _CENTRAL_HEADER_SIGNATURE:
            raise ValueError('not a central-directory record')
        position += _CENTRAL_HEADER.size + fields[10] + fields[11] + fields[12]
        count += 1
    if position != len(central_directory):
        raise ValueError('a truncated central-directory record')
    return count


class PartSink:
    """The zip's bytes cut into parts for ``upload(number, body)``, numbered from ``next_part`` on, after ``tail``
    (the bytes an earlier invocation kept: smaller than ``min_part``)."""

    def __init__(self, upload: Callable[[int, bytes], None], *, next_part: int = 1, tail: bytes = b'',
                 part_size: int = PART_SIZE, min_part: int = MIN_PART_SIZE, max_parts: int = MAX_PARTS) -> None:
        if not 0 < min_part <= part_size or next_part < 1:
            raise ValueError('a part sink needs 0 < min_part <= part_size and a part number from 1')
        self._upload = upload
        self._next = next_part
        self._buffer = bytearray(tail)
        self._part_size = part_size
        self._min_part = min_part
        self._max_parts = max_parts

    def write(self, data: bytes) -> None:
        self._buffer += data
        while len(self._buffer) >= self._part_size:
            self._send(bytes(self._buffer[:self._part_size]))
            del self._buffer[:self._part_size]

    def _send(self, body: bytes) -> None:
        if self._next > self._max_parts:
            raise ExportTooLarge(f'the export needs more than {self._max_parts} parts')
        self._upload(self._next, body)
        self._next += 1

    def hand_over(self) -> tuple[int, bytes]:
        """Before a hand-over: what is buffered goes up as a part when it is at least ``min_part``; else it is the
        tail to keep. ``(next part number, tail)``."""
        if len(self._buffer) >= self._min_part:
            self._send(bytes(self._buffer))
            self._buffer.clear()
        tail = bytes(self._buffer)
        self._buffer.clear()
        return self._next, tail

    def close(self) -> int:
        """Upload the last part (any size; S3 needs at least one part); how many parts the upload holds."""
        if self._buffer or self._next == 1:
            self._send(bytes(self._buffer))
            self._buffer.clear()
        return self._next - 1
