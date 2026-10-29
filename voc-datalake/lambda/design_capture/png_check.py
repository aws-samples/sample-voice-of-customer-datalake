"""Is a browser screenshot a usable logo PNG? (pure; no AWS, no network, stdlib only).

``png_problem`` answers a short reason code, or None when the bytes are a PNG of at most
``MAX_LOGO_BYTES``, at least ``MIN_SIDE_PX`` on each side, and NOT blank. Blank means every
pixel is fully transparent black (what Chrome paints with a transparent default background
when the image drew nothing): for an 8-bit RGBA PNG the IDAT stream is inflated (bounded to
the size the header announces) and, with the filter byte of each row skipped, all its bytes
are zero. That test is exact: in raster order the first non-zero filtered byte has only zero
bytes before it, so every filter's predictor is zero there and the pixel byte is non-zero too.
Other colour types carry no alpha a transparent background could leave blank, so they pass.
"""
from __future__ import annotations

import struct
import zlib
from typing import Final

from shared.design_logo import MAX_LOGO_BYTES, sniff_image_type

MIN_SIDE_PX: Final = 8
#: Largest side the renderer produces (logo_render); the inflate bound follows from it.
MAX_SIDE_PX: Final = 1024
_SIGNATURE_BYTES: Final = 8
_CHUNK_HEADER_BYTES: Final = 8
_CHUNK_CRC_BYTES: Final = 4
_IHDR_BYTES: Final = 13
_RGBA: Final = 6
_BITS_PER_CHANNEL: Final = 8
_RGBA_BYTES_PER_PIXEL: Final = 4


def _chunks(data: bytes) -> list[tuple[bytes, bytes]]:
    """``[(type, body)]`` of the PNG's chunks; ValueError when one runs past the end."""
    chunks: list[tuple[bytes, bytes]] = []
    offset = _SIGNATURE_BYTES
    while offset + _CHUNK_HEADER_BYTES <= len(data):
        length, kind = struct.unpack('>I4s', data[offset:offset + _CHUNK_HEADER_BYTES])
        start = offset + _CHUNK_HEADER_BYTES
        end = start + length
        if end + _CHUNK_CRC_BYTES > len(data):
            raise ValueError('truncated chunk')
        chunks.append((kind, data[start:end]))
        if kind == b'IEND':
            break
        offset = end + _CHUNK_CRC_BYTES
    return chunks


def _all_transparent(width: int, height: int, idat: bytes) -> bool:
    stride = 1 + width * _RGBA_BYTES_PER_PIXEL
    expected = stride * height
    raw = zlib.decompressobj().decompress(idat, expected)
    if len(raw) < expected:
        raise ValueError('short image data')
    return not any(raw[row * stride + 1:(row + 1) * stride].strip(b'\x00') for row in range(height))


def _pixels_problem(chunks: list[tuple[bytes, bytes]]) -> str | None:
    """The size / blank verdict from the parsed chunks (ValueError / struct.error / zlib.error when unreadable)."""
    header = chunks[0][1] if chunks and chunks[0][0] == b'IHDR' else b''
    if len(header) != _IHDR_BYTES:
        raise ValueError('no IHDR')
    width, height, depth, colour = struct.unpack('>IIBB', header[:10])
    if min(width, height) < MIN_SIDE_PX:
        return 'too_small'
    if max(width, height) > MAX_SIDE_PX:
        return 'too_large'
    if depth == _BITS_PER_CHANNEL and colour == _RGBA:
        idat = b''.join(body for kind, body in chunks if kind == b'IDAT')
        return 'blank' if _all_transparent(width, height, idat) else None
    return None


def png_problem(data: bytes) -> str | None:
    """Why ``data`` is not a usable rendered logo (``not_png``, ``too_large``, ``too_small``, ``blank``,
    ``unreadable_png``), or None."""
    if sniff_image_type(data) != 'image/png':
        return 'not_png'
    if len(data) > MAX_LOGO_BYTES:
        return 'too_large'
    try:
        return _pixels_problem(_chunks(data))
    except (ValueError, struct.error, zlib.error):
        return 'unreadable_png'
