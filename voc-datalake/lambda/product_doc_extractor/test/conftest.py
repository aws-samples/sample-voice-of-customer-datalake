"""
Fixtures for the product-doc extractor.

AWS is mocked at the IMPORT BOUNDARY: the handler resolves every client through
its `_clients` cache, so a test injects fakes into that dict and no real boto3
client is ever constructed. Nothing here patches boto3 itself.

Environment is set at import time, before the handler module is imported, because
the handler reads its table names and model configuration into module-level
constants (house style for this repo's Lambdas).
"""
import io
import json
import os
import struct

import pytest

# Must precede the handler import. The allowlist and the documents-surface
# default are taken from shared/model_config.py rather than retyped, so a test
# that "passes" cannot be doing so against ids the platform does not actually
# allow. (The stack injects the same values from lib/utils/model-allowlist.ts;
# test_default_model_lockstep.py pins that side.)
from shared.model_config import ALLOWED_MODEL_IDS, SURFACE_DEFAULTS

TEST_BUCKET = 'test-raw-data-bucket'
TEST_PROJECTS_TABLE = 'test-projects'
TEST_AGGREGATES_TABLE = 'test-aggregates'

DOCUMENTS_DEFAULT_MODEL = SURFACE_DEFAULTS['documents']
OTHER_ALLOWED_MODEL = next(m for m in sorted(ALLOWED_MODEL_IDS) if m != DOCUMENTS_DEFAULT_MODEL)

os.environ['RAW_DATA_BUCKET'] = TEST_BUCKET
os.environ['PROJECTS_TABLE'] = TEST_PROJECTS_TABLE
os.environ['AGGREGATES_TABLE'] = TEST_AGGREGATES_TABLE
os.environ['MODEL_ALLOWLIST'] = json.dumps(sorted(ALLOWED_MODEL_IDS))
os.environ['DEFAULT_MODEL_ID'] = DOCUMENTS_DEFAULT_MODEL
os.environ['MAX_IMAGE_BYTES'] = '3750000'
os.environ['MAX_IMAGE_DIMENSION_PX'] = '8000'

MAX_IMAGE_BYTES = int(os.environ['MAX_IMAGE_BYTES'])
MAX_IMAGE_DIMENSION_PX = int(os.environ['MAX_IMAGE_DIMENSION_PX'])


# ── Fakes ────────────────────────────────────────────────────────────────────

class FakeS3:
    """Records every call, and honours `Range` so the ranged header GETs are
    exercised rather than silently handed the whole object."""

    def __init__(self, body: bytes = b''):
        self.body = body
        self.gets: list[tuple[str, str | None]] = []
        self.puts: list[dict] = []

    # Capitalised parameter names because these are boto3's own kwargs.
    def get_object(self, Bucket=None, Key=None, Range=None):
        self.gets.append((Key, Range))
        data = self.body
        if Range:
            start, _, end = Range.removeprefix('bytes=').partition('-')
            data = self.body[int(start):int(end) + 1]
        return {'Body': io.BytesIO(data)}

    def put_object(self, **kwargs):
        self.puts.append(kwargs)
        return {}


class FakeTable:
    """A single-item DynamoDB table stand-in."""

    def __init__(self, item: dict | None = None, get_error: Exception | None = None):
        self.item = item
        self.get_error = get_error
        self.updates: list[dict] = []

    def get_item(self, Key=None, **_kwargs):
        if self.get_error is not None:
            raise self.get_error
        return {'Item': self.item} if self.item is not None else {}

    def update_item(self, **kwargs):
        self.updates.append(kwargs)
        return {}


def written_attributes(table: FakeTable) -> list[dict]:
    """Un-alias each update_item call back into {attribute: value}.

    The handler must alias `status`/`error` (both DynamoDB reserved words), so
    the assertions have to read through the aliases rather than grep the
    expression string — which would also pass if the alias mapping were wrong.
    """
    out = []
    for call in table.updates:
        names = call['ExpressionAttributeNames']
        values = call['ExpressionAttributeValues']
        out.append({name: values[f':v{alias[2:]}'] for alias, name in names.items()})
    return out


# ── Header builders (minimal but REAL headers, per format spec) ──────────────

def png_header(width: int, height: int) -> bytes:
    """8-byte signature, IHDR chunk length, 'IHDR', then big-endian w/h."""
    return (
        b'\x89PNG\r\n\x1a\n'
        + struct.pack('>I', 13) + b'IHDR'
        + struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    )


def gif_header(width: int, height: int) -> bytes:
    """Signature + logical screen descriptor (little-endian uint16 w/h)."""
    return b'GIF89a' + struct.pack('<HH', width, height) + b'\xf7\x00\x00'


def webp_lossy_header(width: int, height: int) -> bytes:
    """RIFF/WEBP + 'VP8 ' chunk: frame tag, sync code, then 14-bit w/h."""
    return (
        b'RIFF' + struct.pack('<I', 1000) + b'WEBP'
        + b'VP8 ' + struct.pack('<I', 900)
        + b'\x00\x00\x00' + b'\x9d\x01\x2a'
        + struct.pack('<HH', width, height)
    )


def webp_lossless_header(width: int, height: int) -> bytes:
    """'VP8L' chunk: 0x2F signature, then 14 bits each of (w-1) and (h-1)."""
    packed = (width - 1) | ((height - 1) << 14)
    return (
        b'RIFF' + struct.pack('<I', 1000) + b'WEBP'
        + b'VP8L' + struct.pack('<I', 900)
        + b'\x2f' + struct.pack('<I', packed)
    )


def webp_extended_header(width: int, height: int) -> bytes:
    """'VP8X' chunk: flags + reserved, then 24-bit (canvas-1) dimensions."""
    return (
        b'RIFF' + struct.pack('<I', 1000) + b'WEBP'
        + b'VP8X' + struct.pack('<I', 10)
        + b'\x00' + b'\x00\x00\x00'
        + (width - 1).to_bytes(3, 'little')
        + (height - 1).to_bytes(3, 'little')
    )


def jpeg_header(width: int, height: int) -> bytes:
    """SOI, a JFIF APP0 segment, then SOF0 — so the marker walk has to skip a
    segment to reach the dimensions, which is the part that can go wrong."""
    app0 = (
        b'\xff\xe0' + struct.pack('>H', 16)
        + b'JFIF\x00' + b'\x01\x01\x00\x00\x01\x00\x01\x00\x00'
    )
    sof0 = (
        b'\xff\xc0' + struct.pack('>H', 17)
        + b'\x08' + struct.pack('>HH', height, width)
        + b'\x03' + b'\x01\x22\x00\x02\x11\x01\x03\x11\x01'
    )
    return b'\xff\xd8' + app0 + sof0


# ── Fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture
def extractor():
    """The handler module with an empty client cache.

    Cleared on both sides so an injected fake can never leak into another test.
    """
    from product_doc_extractor import handler
    handler._clients.clear()
    yield handler
    handler._clients.clear()


@pytest.fixture
def wire(extractor):
    """Inject fakes for S3, DynamoDB and Bedrock; return them for assertions."""
    from unittest.mock import MagicMock

    def _wire(*, body: bytes = b'', doc: dict | None = None,
              model_text: str = 'description', settings: dict | None = None,
              settings_error: Exception | None = None):
        s3 = FakeS3(body)
        projects = FakeTable(doc)
        aggregates = FakeTable(settings, get_error=settings_error)
        bedrock = MagicMock()
        bedrock.converse.return_value = {
            'output': {'message': {'content': [{'text': model_text}]}}
        }
        extractor._clients.update({
            's3': s3,
            'bedrock': bedrock,
            f'table:{TEST_PROJECTS_TABLE}': projects,
            f'table:{TEST_AGGREGATES_TABLE}': aggregates,
        })
        return {'s3': s3, 'projects': projects, 'aggregates': aggregates, 'bedrock': bedrock}

    return _wire


@pytest.fixture
def pending_doc():
    """A product-doc record as create_upload_url writes it."""
    def _doc(content_type: str, *, doc_id: str = 'abc123', size_bytes: int = 1024,
             project_id: str = 'proj_1', status: str = 'pending') -> dict:
        ext = {'text/markdown': 'md', 'text/plain': 'txt', 'image/png': 'png',
               'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp'}[content_type]
        return {
            'pk': f'PROJECT#{project_id}',
            'sk': f'PRODUCT_DOC#{doc_id}',
            'doc_id': doc_id,
            'filename': f'upload.{ext}',
            'content_type': content_type,
            'size_bytes': size_bytes,
            's3_raw_key': f'projects/{project_id}/product_docs/raw/{doc_id}.{ext}',
            's3_extracted_key': None,
            'status': status,
            'error': None,
            'extracted_chars': 0,
            'created_at': '2026-08-13T10:00:00+00:00',
        }
    return _doc


@pytest.fixture
def s3_event():
    """An S3 OBJECT_CREATED notification for one object."""
    def _event(key: str, size: int = 1024, bucket: str = TEST_BUCKET) -> dict:
        return {'Records': [{
            'eventName': 'ObjectCreated:Put',
            's3': {'bucket': {'name': bucket}, 'object': {'key': key, 'size': size}},
        }]}
    return _event
