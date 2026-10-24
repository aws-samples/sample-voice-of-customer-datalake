"""
Mutation-hardening suite for the product-doc extractor.

What the mutation run found that the earlier suites could not see: they compared
the handler against its OWN constants (`config.read_timeout ==
BEDROCK_READ_TIMEOUT_SECONDS`, `Range == f'bytes=0-{HEADER_BYTES - 1}'`), so a
changed number moved both sides and stayed green; the fake DynamoDB tables ignore
`Key=`, so the settings row and the `PRODUCT_DOC#` sort key were never checked;
the module-level environment reads were only ever exercised with every variable
set; and the formatter's exclusion set, its `stack` field and its last-resort
rendering were never asserted at all. Every expectation below is a literal.
"""
from __future__ import annotations

import importlib.util
import json
import logging
import struct
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from types import ModuleType
from unittest.mock import MagicMock, patch

import pytest

from .conftest import (
    DOCUMENTS_DEFAULT_MODEL,
    TEST_AGGREGATES_TABLE,
    TEST_BUCKET,
    TEST_PROJECTS_TABLE,
    conditional_check_failed,
    gif_header,
    jpeg_header,
    png_header,
    webp_extended_header,
    webp_lossless_header,
    webp_lossy_header,
    written_attributes,
)

HANDLER_PATH = Path(__file__).resolve().parent.parent / 'handler.py'
RAW_KEY = 'projects/proj_1/product_docs/raw/abc123'

_ENV_NAMES = ('SERVICE_NAME', 'RAW_DATA_BUCKET', 'PROJECTS_TABLE', 'AGGREGATES_TABLE',
              'DEFAULT_MODEL_ID')


@pytest.fixture
def fresh_import(monkeypatch) -> Iterator[Callable[[dict[str, str]], ModuleType]]:
    """Execute handler.py again as a THROWAWAY module under a chosen environment.

    The module reads its configuration into constants at import time, so the only
    way to observe a default is to import it with the variable absent. A separate
    module name keeps the shared module (and its logger) untouched; the throwaway
    logger's handlers are removed afterwards.
    """
    created: list[ModuleType] = []

    def _load(env: dict[str, str]) -> ModuleType:
        for name in _ENV_NAMES:
            monkeypatch.delenv(name, raising=False)
        for name, value in env.items():
            monkeypatch.setenv(name, value)
        module_name = f'product_doc_extractor_fresh_{len(created)}'
        spec = importlib.util.spec_from_file_location(module_name, HANDLER_PATH)
        assert spec is not None
        assert spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        created.append(module)
        return module

    yield _load
    for module in created:
        logging.getLogger(module.__name__).handlers.clear()
        sys.modules.pop(module.__name__, None)


class TestImportTimeConfiguration:
    def test_every_variable_defaults_when_absent(self, fresh_import):
        module = fresh_import({})

        assert module.SERVICE_NAME == 'voc-product-doc-extractor'
        assert module.RAW_DATA_BUCKET == ''
        assert module.PROJECTS_TABLE == ''
        assert module.AGGREGATES_TABLE == ''
        assert module.DEFAULT_MODEL_ID == ''

    def test_every_variable_is_read_from_its_own_name(self, fresh_import):
        module = fresh_import({
            'SERVICE_NAME': 'svc-x', 'RAW_DATA_BUCKET': 'bucket-x',
            'PROJECTS_TABLE': 'projects-x', 'AGGREGATES_TABLE': 'aggregates-x',
            'DEFAULT_MODEL_ID': 'model-x',
        })

        assert module.SERVICE_NAME == 'svc-x'
        assert module.RAW_DATA_BUCKET == 'bucket-x'
        assert module.PROJECTS_TABLE == 'projects-x'
        assert module.AGGREGATES_TABLE == 'aggregates-x'
        assert module.DEFAULT_MODEL_ID == 'model-x'

    def test_the_json_handler_is_installed_under_its_stable_name(self, extractor):
        names = [h.name for h in extractor.logger.handlers]

        assert names.count('voc-product-doc-extractor-json') == 1


def _format(extractor, record: logging.LogRecord) -> str:
    return extractor.JsonFormatter().format(record)


def _record(**attrs) -> logging.LogRecord:
    record = logging.LogRecord('x', logging.INFO, 'f.py', 1, 'hello', (), None)
    record.__dict__.update(attrs)
    return record


class TestTheFormatterWritesOnlyItsFields:
    def test_a_plain_record_carries_exactly_the_four_fields(self, extractor):
        payload = json.loads(_format(extractor, _record()))

        assert set(payload) == {'level', 'message', 'timestamp', 'service'}
        assert payload['level'] == 'INFO'
        assert payload['message'] == 'hello'
        assert payload['service'] == 'voc-product-doc-extractor'

    def test_an_asctime_another_formatter_left_on_the_record_is_not_an_extra(self, extractor):
        payload = json.loads(_format(extractor, _record(asctime='2026-01-01 00:00:00')))

        assert 'asctime' not in payload

    def test_stack_info_is_written_under_stack(self, extractor):
        stack = 'Stack (most recent call last):\n  here'
        payload = json.loads(_format(extractor, _record(stack_info=stack)))

        assert payload['stack'] == stack


class _ReprRaises:
    def __repr__(self) -> str:
        raise RuntimeError('no repr')


class TestTheLastResortRendering:
    def test_a_value_whose_repr_raises_is_named_by_its_type(self, extractor):
        assert extractor._stringify(_ReprRaises()) == '<unrepresentable _ReprRaises>'


def _converse(mocks) -> dict:
    call = mocks['bedrock'].converse.call_args
    assert call is not None, 'Bedrock was not called'
    return call.kwargs


class TestTheExactBedrockRequest:
    @pytest.mark.parametrize(('content_type', 'ext', 'body', 'token'), [
        ('image/png', 'png', png_header(400, 300), 'png'),
        ('image/gif', 'gif', gif_header(400, 300), 'gif'),
        ('image/webp', 'webp', webp_lossy_header(400, 300), 'webp'),
        ('image/jpeg', 'jpg', jpeg_header(400, 300), 'jpeg'),
    ])
    def test_each_image_type_sends_its_converse_token(
        self, extractor, wire, pending_doc, s3_event, content_type, ext, body, token,
    ):
        mocks = wire(body=body, doc=pending_doc(content_type))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.{ext}', size=len(body)))

        assert _converse(mocks)['messages'][0]['content'][0]['image']['format'] == token


class TestTheRangedReads:
    def test_the_header_read_is_the_first_32_bytes(self, extractor, wire, pending_doc, s3_event):
        body = png_header(400, 300)
        mocks = wire(body=body, doc=pending_doc('image/png'))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png', size=len(body)))

        assert mocks['s3'].gets == [(f'{RAW_KEY}.png', 'bytes=0-31'), (f'{RAW_KEY}.png', None)]

    def test_the_jpeg_scan_reads_256_kib(self, extractor, wire, pending_doc, s3_event):
        body = jpeg_header(400, 300)
        mocks = wire(body=body, doc=pending_doc('image/jpeg'))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.jpg', size=len(body)))

        assert mocks['s3'].gets == [
            (f'{RAW_KEY}.jpg', 'bytes=0-31'),
            (f'{RAW_KEY}.jpg', 'bytes=0-262143'),
            (f'{RAW_KEY}.jpg', None),
        ]


class TestTheBedrockClientNumbers:
    def test_80s_read_10s_connect_one_standard_attempt(self, extractor):
        with patch.object(extractor, 'boto3') as mock_boto3:
            extractor._bedrock()
        call = mock_boto3.client.call_args
        config = call.kwargs['config']

        assert call.args == ('bedrock-runtime',)
        assert config.read_timeout == 80
        assert config.connect_timeout == 10
        assert config.retries == {'max_attempts': 1, 'mode': 'standard'}


def _mock_table(extractor, name: str) -> MagicMock:
    """Swap in a MagicMock table that finds nothing, so its `Key=` can be asserted."""
    table = MagicMock()
    table.get_item.return_value = {}
    extractor._clients[f'table:{name}'] = table
    return table


class TestTheKeysThatAreRead:
    def test_the_model_settings_row_is_settings_model_config(self, extractor, wire):
        wire()
        aggregates = _mock_table(extractor, TEST_AGGREGATES_TABLE)

        extractor._resolve_model_id()

        aggregates.get_item.assert_called_once_with(Key={'pk': 'SETTINGS#model', 'sk': 'config'})

    def test_an_event_without_a_bucket_falls_back_to_the_configured_one(
        self, extractor, wire, pending_doc,
    ):
        mocks = wire(body=b'# notes', doc=pending_doc('text/markdown'))
        event = {'Records': [{'s3': {'object': {'key': f'{RAW_KEY}.md', 'size': 7}}}]}

        extractor.lambda_handler(event)

        assert [p['Bucket'] for p in mocks['s3'].puts] == [TEST_BUCKET]


# ── Clients ──────────────────────────────────────────────────────────────────

class TestTheClientFactories:
    def test_s3_is_built_once_and_cached_under_s3(self, extractor):
        with patch.object(extractor, 'boto3') as mock_boto3:
            first = extractor._s3()
            second = extractor._s3()

        mock_boto3.client.assert_called_once_with('s3')
        assert first is mock_boto3.client.return_value
        assert second is first
        assert extractor._clients == {'s3': first}

    def test_a_table_is_a_dynamodb_resource_table_cached_by_name(self, extractor):
        with patch.object(extractor, 'boto3') as mock_boto3:
            first = extractor._table('t1')
            second = extractor._table('t1')

        mock_boto3.resource.assert_called_once_with('dynamodb')
        mock_boto3.resource.return_value.Table.assert_called_once_with('t1')
        assert first is mock_boto3.resource.return_value.Table.return_value
        assert second is first
        assert extractor._clients == {'table:t1': first}


# ── Model resolution messages ───────────────────────────────────────────────

def _messages(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records]


class TestTheAllowlistIsReadQuietly:
    def test_an_absent_allowlist_is_empty_and_logs_nothing(self, extractor, monkeypatch, caplog):
        monkeypatch.delenv('MODEL_ALLOWLIST')

        assert extractor._allowlist() == set()
        assert _messages(caplog) == []

    def test_invalid_json_is_named_in_the_warning(self, extractor, monkeypatch, caplog):
        monkeypatch.setenv('MODEL_ALLOWLIST', '{not json')

        assert extractor._allowlist() == set()
        assert _messages(caplog) == ['MODEL_ALLOWLIST is not valid JSON; ignoring configured models']

    def test_a_rejected_model_id_is_quoted_to_80_characters(self, extractor, caplog):
        model_id = 'm' * 79 + 'XYZ'

        assert extractor._allowlisted(model_id, set()) is None
        assert _messages(caplog) == [f"Configured model '{'m' * 79}X' not in allowlist; ignoring"]

    def test_a_failed_settings_read_says_so(self, extractor, wire, caplog):
        wire(settings_error=RuntimeError('boom'))

        extractor._resolve_model_id()

        assert _messages(caplog) == ['Model settings lookup failed; using default: boom']


# ── Header parsing edges ────────────────────────────────────────────────────

SOI = b'\xff\xd8'


def _sof(marker: int, width: int, height: int) -> bytes:
    return (bytes([0xFF, marker]) + struct.pack('>H', 17) + b'\x08'
            + struct.pack('>HH', height, width) + b'\x03' + b'\x01\x22\x00\x02\x11\x01\x03\x11\x01')


def _segment(marker: int, payload: bytes) -> bytes:
    return bytes([0xFF, marker]) + struct.pack('>H', len(payload) + 2) + payload


class TestTheJpegMarkerWalk:
    @pytest.mark.parametrize('prefix', [
        pytest.param(b'\xff', id='fill-byte'),
        pytest.param(b'\xff\x01', id='TEM'),
        pytest.param(b'\xff\xd0', id='RST0'),
        pytest.param(b'\xff\xd9', id='EOI'),
        pytest.param(_segment(0xDA, b'\x00\x00'), id='SOS-is-a-segment'),
        pytest.param(_segment(0xC4, b'\x00' * 6), id='DHT'),
        pytest.param(_segment(0xC8, b'\x00' * 6), id='JPG'),
        pytest.param(_segment(0xCC, b'\x00' * 6), id='DAC'),
        pytest.param(b'\xff\xe0\x00\x02', id='empty-segment'),
    ])
    def test_what_precedes_the_frame_is_stepped_over(self, extractor, prefix):
        assert extractor._jpeg_dimensions(SOI + prefix + _sof(0xC0, 640, 480)) == (640, 480)

    @pytest.mark.parametrize('marker', [0xC2, 0xCF])
    def test_every_sof_in_the_c_row_carries_the_size(self, extractor, marker):
        assert extractor._jpeg_dimensions(SOI + _sof(marker, 33, 44)) == (33, 44)

    def test_a_frame_that_ends_exactly_at_the_window_is_read(self, extractor):
        assert extractor._jpeg_dimensions((SOI + _sof(0xC0, 7, 9))[:11]) == (7, 9)

    def test_a_one_byte_segment_length_is_corrupt(self, extractor):
        assert extractor._jpeg_dimensions(SOI + b'\xff\xe0\x00\x01' + _sof(0xC0, 7, 9)) is None

    def test_a_stream_with_no_frame_runs_out_cleanly(self, extractor):
        assert extractor._jpeg_dimensions(SOI + _segment(0xE0, b'JFIF\x00' + b'\x00' * 9)) is None


class TestTheFixedHeaderParsers:
    def test_gif87a_is_a_gif(self, extractor):
        assert extractor._sniff_format(b'GIF87a' + b'\x00' * 10) == 'gif'

    @pytest.mark.parametrize('head', [b'RIFF\x00\x00\x00\x00AVI ', b'RIFX\x00\x00\x00\x00WEBP'])
    def test_webp_needs_both_riff_and_webp(self, extractor, head):
        assert extractor._sniff_format(head) is None

    def test_png_needs_exactly_24_bytes(self, extractor):
        head = png_header(12, 34)

        assert extractor._png_dimensions(head[:24]) == (12, 34)
        assert extractor._png_dimensions(head[:23]) is None

    def test_gif_needs_exactly_10_bytes(self, extractor):
        head = gif_header(12, 34)

        assert extractor._gif_dimensions(head[:10]) == (12, 34)
        assert extractor._gif_dimensions(head[:9]) is None

    def test_lossy_webp_edges(self, extractor):
        head = webp_lossy_header(12, 34)
        wrong_sync = head[:23] + b'\x00\x00\x00' + head[26:]

        assert extractor._webp_dimensions(head + b'\xff\xff') == (12, 34)
        assert extractor._webp_dimensions(head[:29]) is None
        assert extractor._webp_dimensions(wrong_sync) is None

    def test_lossless_webp_edges(self, extractor):
        head = webp_lossless_header(12, 34)
        wrong_signature = head[:20] + b'\x2e' + head[21:]

        assert extractor._webp_dimensions(head + b'\xff') == (12, 34)
        assert extractor._webp_dimensions(head[:24]) is None
        assert extractor._webp_dimensions(wrong_signature) is None

    def test_extended_webp_reads_only_its_three_bytes(self, extractor):
        assert extractor._webp_dimensions(webp_extended_header(12, 34) + b'\xff') == (12, 34)


# ── Record reads and writes ─────────────────────────────────────────────────

DOC_KEY = {'pk': 'PROJECT#proj_1', 'sk': 'PRODUCT_DOC#abc123'}
CONDITION = 'attribute_exists(pk) AND #doc_status IN (:s0, :s1)'


class TestTheRecordRead:
    def test_it_reads_the_project_and_product_doc_key(self, extractor, wire):
        wire()
        projects = _mock_table(extractor, TEST_PROJECTS_TABLE)

        assert extractor._get_doc('proj_1', 'abc123') is None
        projects.get_item.assert_called_once_with(Key=DOC_KEY)

    def test_a_failed_read_is_logged_with_the_doc_id(self, extractor, wire, caplog):
        mocks = wire()
        mocks['projects'].get_error = RuntimeError('boom')

        assert extractor._get_doc('proj_1', 'abc123') is None
        assert _messages(caplog) == ['Could not read product doc abc123: boom']


class TestTheExactWrites:
    def test_extracting_then_ready_with_their_full_expressions(
        self, extractor, wire, pending_doc, s3_event,
    ):
        mocks = wire(body=b'# notes', doc=pending_doc('text/markdown'))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.md', size=7))

        assert mocks['projects'].updates == [
            {
                'Key': DOC_KEY,
                'UpdateExpression': 'SET #k0 = :v0',
                'ConditionExpression': CONDITION,
                'ExpressionAttributeNames': {'#k0': 'status', '#doc_status': 'status'},
                'ExpressionAttributeValues': {':v0': 'extracting', ':s0': 'pending', ':s1': 'extracting'},
            },
            {
                'Key': DOC_KEY,
                'UpdateExpression': 'SET #k0 = :v0, #k1 = :v1, #k2 = :v2, #k3 = :v3',
                'ConditionExpression': CONDITION,
                'ExpressionAttributeNames': {
                    '#k0': 'status', '#k1': 'error', '#k2': 's3_extracted_key',
                    '#k3': 'extracted_chars', '#doc_status': 'status',
                },
                'ExpressionAttributeValues': {
                    ':v0': 'ready', ':v1': None,
                    ':v2': 'projects/proj_1/product_docs/extracted/abc123.txt', ':v3': 7,
                    ':s0': 'pending', ':s1': 'extracting',
                },
            },
        ]
        assert mocks['s3'].puts == [{
            'Bucket': TEST_BUCKET,
            'Key': 'projects/proj_1/product_docs/extracted/abc123.txt',
            'Body': b'# notes',
            'ContentType': 'text/plain; charset=utf-8',
        }]


class TestEveryRefusalIsLoggedVerbatim:
    def test_a_deleted_record(self, extractor, wire, caplog):
        wire(doc=None, update_error=conditional_check_failed())

        extractor._update_doc('proj_1', 'abc123', {'status': 'ready'})

        assert _messages(caplog) == ['Product doc abc123 was deleted mid-extraction; write skipped']

    def test_a_record_the_api_failed(self, extractor, wire, pending_doc, caplog):
        wire(doc=pending_doc('text/plain', status='failed'), update_error=conditional_check_failed())

        extractor._update_doc('proj_1', 'abc123', {'status': 'ready', 'error': None})

        assert _messages(caplog) == [
            "Product doc abc123 is already failed; refusing to overwrite ['error', 'status'] onto it"
            ' - the API already gave this document up as stalled and told the user to upload it again'
        ]

    def test_a_malformed_record(self, extractor, wire, pending_doc, caplog):
        wire(doc=pending_doc('text/plain', status='sideways'), update_error=conditional_check_failed())

        extractor._update_doc('proj_1', 'abc123', {'status': 'ready'})

        assert _messages(caplog) == [
            "Product doc abc123 has no usable status ('sideways'); refusing to overwrite ['status']"
            ' onto it - the record is malformed or predates the status field, so no read path put it'
            ' in this state'
        ]

    def test_any_other_write_failure(self, extractor, wire, caplog):
        wire(update_error=RuntimeError('boom'))

        extractor._update_doc('proj_1', 'abc123', {'status': 'ready'})

        assert _messages(caplog) == ['Could not update product doc abc123: boom']


# ── The pipeline, end to end ────────────────────────────────────────────────

def _run(extractor, s3_event, ext: str, size: int, **event) -> None:
    extractor.lambda_handler(s3_event(f'{RAW_KEY}.{ext}', size=size, **event))


def _error(mocks) -> str | None:
    return written_attributes(mocks['projects'])[-1].get('error')


def _statuses(mocks) -> list[str | None]:
    return [w.get('status') for w in written_attributes(mocks['projects'])]


class TestEveryFailureNamesItsCause:
    @pytest.mark.parametrize(('content_type', 'ext', 'body', 'error'), [
        ('image/png', 'png', b'%PDF-1.7 not an image', 'This file is not a readable image.'),
        ('image/png', 'png', gif_header(10, 10), 'This file is not a valid image/png image.'),
        ('image/png', 'png', b'\x89PNG\r\n\x1a\n' + b'\x00' * 24, 'This image file appears to be corrupt.'),
        ('image/jpeg', 'jpg', SOI + _segment(0xE0, b'\x00' * 14), 'This image file appears to be corrupt.'),
        ('image/gif', 'gif', gif_header(0, 5), 'This image file appears to be corrupt.'),
        ('image/gif', 'gif', gif_header(5, 0), 'This image file appears to be corrupt.'),
        ('image/gif', 'gif', gif_header(8001, 1),
         'This image is too large to analyse (8000px maximum per side, this one is 8001x1).'),
        ('image/gif', 'gif', gif_header(1, 8001),
         'This image is too large to analyse (8000px maximum per side, this one is 1x8001).'),
    ])
    def test_the_image_checks(self, extractor, wire, pending_doc, s3_event,
                              content_type, ext, body, error):
        mocks = wire(body=body, doc=pending_doc(content_type))

        _run(extractor, s3_event, ext, len(body))

        assert _statuses(mocks) == ['extracting', 'failed']
        assert _error(mocks) == error

    @pytest.mark.parametrize(('size', 'error'), [
        (0, 'This file is empty.'),
        (3_750_001, 'This image is too large to analyse (3750KB maximum).'),
    ])
    def test_the_object_size_checks(self, extractor, wire, pending_doc, s3_event, size, error):
        mocks = wire(body=png_header(10, 10), doc=pending_doc('image/png'))

        _run(extractor, s3_event, 'png', size)

        assert _error(mocks) == error

    def test_an_event_with_no_size_is_empty(self, extractor, wire, pending_doc):
        mocks = wire(body=png_header(10, 10), doc=pending_doc('image/png'))

        extractor.lambda_handler({'Records': [{'s3': {'object': {'key': f'{RAW_KEY}.png'}}}]})

        assert _error(mocks) == 'This file is empty.'

    @pytest.mark.parametrize('unset', ['MAX_IMAGE_BYTES', 'MAX_IMAGE_DIMENSION_PX'])
    def test_either_missing_cap_refuses_images(
        self, extractor, wire, pending_doc, s3_event, monkeypatch, caplog, unset,
    ):
        monkeypatch.delenv(unset)
        mocks = wire(body=png_header(10, 10), doc=pending_doc('image/png'))

        _run(extractor, s3_event, 'png', 64)

        assert _error(mocks) == 'Image extraction is not available right now.'
        assert 'MAX_IMAGE_BYTES / MAX_IMAGE_DIMENSION_PX are not configured' in _messages(caplog)

    def test_an_unsupported_type(self, extractor, wire, pending_doc, s3_event):
        mocks = wire(body=b'x', doc={**pending_doc('text/plain'), 'content_type': 'application/pdf'})

        _run(extractor, s3_event, 'txt', 1)

        assert _error(mocks) == 'This file type cannot be processed.'

    def test_an_unexpected_error(self, extractor, wire, pending_doc, s3_event, caplog):
        mocks = wire(body=png_header(10, 10), doc=pending_doc('image/png'))
        mocks['bedrock'].converse.side_effect = RuntimeError('boom')

        _run(extractor, s3_event, 'png', 64)

        assert _error(mocks) == 'Text extraction failed. Please try uploading again.'
        assert 'Extraction failed for abc123' in _messages(caplog)

    def test_an_empty_description(self, extractor, wire, pending_doc, s3_event, caplog):
        mocks = wire(body=png_header(10, 10), doc=pending_doc('image/png'), model_text=' ')

        _run(extractor, s3_event, 'png', 64)

        assert _error(mocks) == 'No text could be extracted from this file.'
        assert 'Product doc abc123 failed: No text could be extracted from this file.' in _messages(caplog)


class TestTheBoundariesThatStillPass:
    @pytest.mark.parametrize('size', [1, 3_750_000])
    def test_object_sizes_at_the_edges(self, extractor, wire, pending_doc, s3_event, size):
        mocks = wire(body=png_header(10, 10), doc=pending_doc('image/png'))

        _run(extractor, s3_event, 'png', size)

        assert _statuses(mocks) == ['extracting', 'ready']

    @pytest.mark.parametrize(('width', 'height'), [(1, 1), (8000, 1), (1, 8000)])
    def test_dimensions_at_the_edges(self, extractor, wire, pending_doc, s3_event, width, height):
        body = gif_header(width, height)
        mocks = wire(body=body, doc=pending_doc('image/gif'))

        _run(extractor, s3_event, 'gif', len(body))

        assert _statuses(mocks) == ['extracting', 'ready']

    @pytest.mark.parametrize(('raw', 'expected'), [('0', None), ('1', 1), ('x', None)])
    def test_int_env(self, extractor, monkeypatch, raw, expected):
        monkeypatch.setenv('SOME_LIMIT', raw)

        assert extractor._int_env('SOME_LIMIT') == expected

    def test_int_env_unset(self, extractor, monkeypatch):
        monkeypatch.delenv('SOME_LIMIT', raising=False)

        assert extractor._int_env('SOME_LIMIT') is None


class TestTheSuccessfulPaths:
    def test_the_full_converse_request_and_its_log_line(
        self, extractor, wire, pending_doc, s3_event, caplog,
    ):
        body = png_header(400, 300)
        mocks = wire(body=body, doc=pending_doc('image/png'))

        _run(extractor, s3_event, 'png', len(body))

        converse: MagicMock = mocks['bedrock'].converse
        converse.assert_called_once_with(
            modelId=DOCUMENTS_DEFAULT_MODEL,
            messages=[{'role': 'user', 'content': [
                {'image': {'format': 'png', 'source': {'bytes': body}}},
                {'text': extractor.IMAGE_EXTRACTION_PROMPT},
            ]}],
            inferenceConfig={'maxTokens': 4096},
        )
        assert f'Describing png image 400x300 with {DOCUMENTS_DEFAULT_MODEL}' in _messages(caplog)
        assert 'Product doc abc123 ready (11 chars)' in _messages(caplog)

    def test_text_blocks_are_joined_by_newlines(self, extractor, wire, pending_doc, s3_event):
        mocks = wire(body=png_header(10, 10), doc=pending_doc('image/png'))
        mocks['bedrock'].converse.return_value = {
            'output': {'message': {'content': [{'text': 'a'}, {'text': 'b'}]}},
        }

        _run(extractor, s3_event, 'png', 64)

        assert mocks['s3'].puts[0]['Body'] == b'a\nb'

    def test_undecodable_bytes_are_replaced_not_fatal(self, extractor, wire, pending_doc, s3_event):
        mocks = wire(body=b'ab\xffcd', doc=pending_doc('text/plain'))

        _run(extractor, s3_event, 'txt', 5)

        assert written_attributes(mocks['projects'])[-1]['extracted_chars'] == 5
        assert mocks['s3'].puts[0]['Body'] == b'ab\xffcd'

    def test_the_events_bucket_is_used(self, extractor, wire, pending_doc, s3_event):
        mocks = wire(body=b'# notes', doc=pending_doc('text/markdown'))

        _run(extractor, s3_event, 'md', 7, bucket='other-bucket')

        assert [p['Bucket'] for p in mocks['s3'].puts] == ['other-bucket']


class TestTheSkipLines:
    @pytest.mark.parametrize(('record', 'line'), [
        ({'s3': {}}, 'Ignoring (no key) - not a product-doc upload'),
        ({'s3': {'object': {'key': 'raw/x.json'}}}, 'Ignoring raw/x.json - not a product-doc upload'),
    ])
    def test_a_key_that_is_not_an_upload(self, extractor, wire, caplog, record, line):
        wire()

        extractor.lambda_handler({'Records': [record]})

        assert _messages(caplog)[0] == line

    def test_no_record(self, extractor, wire, s3_event, caplog):
        wire(doc=None)

        _run(extractor, s3_event, 'md', 7)

        assert _messages(caplog)[0] == 'No product doc record for abc123; skipping'

    def test_an_already_terminal_record(self, extractor, wire, pending_doc, s3_event, caplog):
        wire(doc=pending_doc('text/markdown', status='ready'))

        _run(extractor, s3_event, 'md', 7)

        assert _messages(caplog)[0] == 'Product doc abc123 is already ready; skipping'

    def test_a_record_that_raises(self, extractor, wire, caplog):
        wire()

        extractor.lambda_handler({'Records': [{'s3': {'object': {'key': 123}}}]})

        assert _messages(caplog)[0] == 'Unhandled error processing S3 record'


class TestTheCostLineArithmetic:
    def test_cpu_and_wall_are_elapsed_milliseconds(self, extractor, caplog):
        with patch.object(extractor.time, 'process_time', return_value=1.5), \
                patch.object(extractor.time, 'perf_counter', return_value=12.0):
            extractor._log_invocation_cost(None, 1.0, 10.0)

        record = caplog.records[-1]
        assert record.getMessage() == 'invocation_cost'
        assert record.__dict__['cpu_ms'] == 500.0
        assert record.__dict__['wall_ms'] == 2000.0
        assert 'function_memory_size' not in record.__dict__
