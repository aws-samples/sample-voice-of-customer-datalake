"""
Tests for the product-doc extractor.

The falsifiers here are picked so that a weaker implementation fails rather than
passes for the wrong reason:

  - text pass-through is asserted BYTE-IDENTICALLY, so a handler that summarised
    a .md through the model would fail even though its output "looks extracted";
  - the size cap is asserted against the object's ACTUAL size while the record's
    `size_bytes` claims something small, which is the only arrangement that
    proves the client's declared number is not trusted;
  - the Bedrock `format` token is asserted on the CALL ARGUMENTS, because a
    MagicMock accepts any kwargs and returns the same reply either way — a
    return-value assertion cannot detect a dropped or wrong parameter;
  - every failure path additionally asserts that `ready` was NEVER written, since
    "reached failed" and "never claimed ready" are different guarantees and
    build_product_context_block depends on the second one.
"""
import pytest

from .conftest import (
    DOCUMENTS_DEFAULT_MODEL,
    MAX_IMAGE_BYTES,
    MAX_IMAGE_DIMENSION_PX,
    OTHER_ALLOWED_MODEL,
    gif_header,
    jpeg_header,
    png_header,
    webp_extended_header,
    webp_lossless_header,
    webp_lossy_header,
    written_attributes,
)

RAW_KEY = 'projects/proj_1/product_docs/raw/abc123'
EXTRACTED_KEY = 'projects/proj_1/product_docs/extracted/abc123.txt'


def statuses(projects) -> list:
    return [w.get('status') for w in written_attributes(projects)]


class TestTextPassThrough:
    """Reading the bytes IS the extraction — nothing may reshape them."""

    def test_markdown_reaches_ready_byte_identically(self, extractor, wire, pending_doc, s3_event):
        # Distinctive content: CRLF, a trailing blank line, non-ASCII, and markdown
        # that a summarising implementation would visibly rewrite.
        source = (
            '# Späte Änderungen\r\n'
            '\r\n'
            '- Onboarding: **3 Schritte**\r\n'
            '- Farbe: #0F62FE\r\n'
            '\r\n'
        ).encode()
        mocks = wire(body=source, doc=pending_doc('text/markdown'))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.md', size=len(source)))

        assert len(mocks['s3'].puts) == 1
        put = mocks['s3'].puts[0]
        assert put['Key'] == EXTRACTED_KEY
        # The whole point: identical bytes, not an equivalent-looking string.
        assert put['Body'] == source

        written = written_attributes(mocks['projects'])
        assert len(written) == 1
        assert written[0]['status'] == 'ready'
        assert written[0]['error'] is None
        assert written[0]['s3_extracted_key'] == EXTRACTED_KEY
        assert written[0]['extracted_chars'] == len(source.decode('utf-8'))
        # No model in the loop at all for a text document.
        mocks['bedrock'].converse.assert_not_called()

    def test_plain_text_is_not_normalised(self, extractor, wire, pending_doc, s3_event):
        source = b'  leading and trailing whitespace  \n\n\ttabbed\n'
        mocks = wire(body=source, doc=pending_doc('text/plain'))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.txt', size=len(source)))

        assert mocks['s3'].puts[0]['Body'] == source
        assert statuses(mocks['projects']) == ['ready']

    def test_empty_text_file_fails_rather_than_claiming_ready(
        self, extractor, wire, pending_doc, s3_event,
    ):
        mocks = wire(body=b'   \n\t\n', doc=pending_doc('text/plain'))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.txt', size=6))

        assert statuses(mocks['projects']) == ['failed']
        assert mocks['s3'].puts == []


class TestImageDescription:
    def test_png_reaches_ready_with_the_model_description(
        self, extractor, wire, pending_doc, s3_event,
    ):
        image = png_header(1170, 2532) + b'\x00' * 64
        mocks = wire(body=image, doc=pending_doc('image/png'),
                     model_text='## Palette\n`--primary`: #0F62FE')

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png', size=len(image)))

        written = written_attributes(mocks['projects'])
        assert written[0]['status'] == 'ready'
        assert mocks['s3'].puts[0]['Body'] == b'## Palette\n`--primary`: #0F62FE'
        assert written[0]['extracted_chars'] == len('## Palette\n`--primary`: #0F62FE')

    def test_jpeg_sends_the_converse_format_token_not_the_file_extension(
        self, extractor, wire, pending_doc, s3_event,
    ):
        # `jpg` (the extension in the S3 key) is a bare 400 from Converse. This
        # asserts the CALL, because the MagicMock reply is identical either way.
        image = jpeg_header(1200, 800)
        mocks = wire(body=image, doc=pending_doc('image/jpeg'), model_text='desc')

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.jpg', size=len(image)))

        mocks['bedrock'].converse.assert_called_once()
        kwargs = mocks['bedrock'].converse.call_args.kwargs
        blocks = kwargs['messages'][0]['content']
        assert blocks[0]['image']['format'] == 'jpeg'
        assert blocks[0]['image']['source']['bytes'] == image
        assert blocks[1]['text'] == extractor.IMAGE_EXTRACTION_PROMPT
        # Several allowlisted models reject `temperature` outright.
        assert 'temperature' not in kwargs['inferenceConfig']
        assert statuses(mocks['projects']) == ['ready']

    def test_image_content_type_with_non_image_bytes_fails(
        self, extractor, wire, pending_doc, s3_event,
    ):
        # A .png full of PDF bytes: the declared content type is a claim, the
        # header sniff is the check.
        body = b'%PDF-1.7\n%\xc7\xec\x8f\xa2\n1 0 obj\n<< /Type /Catalog >>'
        mocks = wire(body=body, doc=pending_doc('image/png'))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png', size=len(body)))

        written = written_attributes(mocks['projects'])
        assert [w['status'] for w in written] == ['failed']
        assert written[0]['error']
        # Not "ready with an empty description", and no model call was billed.
        assert 'ready' not in statuses(mocks['projects'])
        mocks['bedrock'].converse.assert_not_called()
        assert mocks['s3'].puts == []

    def test_mismatched_image_type_fails(self, extractor, wire, pending_doc, s3_event):
        # Real image, wrong declared type: a GIF uploaded as image/png.
        body = gif_header(100, 100)
        mocks = wire(body=body, doc=pending_doc('image/png'))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png', size=len(body)))

        assert statuses(mocks['projects']) == ['failed']
        mocks['bedrock'].converse.assert_not_called()

    @pytest.mark.parametrize('model_text', ['', '   \n\t  \n'])
    def test_empty_or_whitespace_description_fails(
        self, extractor, wire, pending_doc, s3_event, model_text,
    ):
        # A `ready` record with no text lies to build_product_context_block: it
        # contributes nothing to the prompt while claiming to be usable.
        image = png_header(800, 600)
        mocks = wire(body=image, doc=pending_doc('image/png'), model_text=model_text)

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png', size=len(image)))

        written = written_attributes(mocks['projects'])
        assert [w['status'] for w in written] == ['failed']
        assert 'ready' not in statuses(mocks['projects'])
        # Nothing written to S3 either — no empty extracted object left behind.
        assert mocks['s3'].puts == []

    def test_bedrock_failure_fails_the_record_without_leaking_internals(
        self, extractor, wire, pending_doc, s3_event,
    ):
        image = png_header(800, 600)
        mocks = wire(body=image, doc=pending_doc('image/png'))
        mocks['bedrock'].converse.side_effect = RuntimeError(
            'ThrottlingException: rate exceeded for arn:aws:bedrock:...'
        )

        # Returns normally: re-raising would buy two Lambda retries of a call
        # that already failed, and overwrite a truthful `failed` record twice.
        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png', size=len(image)))

        written = written_attributes(mocks['projects'])
        assert written[0]['status'] == 'failed'
        assert 'ThrottlingException' not in written[0]['error']
        assert 'arn:aws' not in written[0]['error']


class TestSizeAndDimensionCaps:
    def test_actual_object_size_beats_the_records_claim(
        self, extractor, wire, pending_doc, s3_event,
    ):
        # The record says 1KB; the object is over the cap. The record's number is
        # client-supplied, so the event's size is what may be trusted.
        doc = pending_doc('image/png', size_bytes=1024)
        mocks = wire(body=png_header(400, 400), doc=doc)

        extractor.lambda_handler(
            s3_event(f'{RAW_KEY}.png', size=MAX_IMAGE_BYTES + 1)
        )

        assert statuses(mocks['projects']) == ['failed']
        mocks['bedrock'].converse.assert_not_called()
        # Refused before a single byte was fetched.
        assert mocks['s3'].gets == []

    def test_zero_byte_object_fails(self, extractor, wire, pending_doc, s3_event):
        mocks = wire(body=b'', doc=pending_doc('image/png'))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png', size=0))

        assert statuses(mocks['projects']) == ['failed']

    def test_png_over_the_dimension_cap_is_refused(
        self, extractor, wire, pending_doc, s3_event,
    ):
        oversized = png_header(MAX_IMAGE_DIMENSION_PX + 1, 100)
        mocks = wire(body=oversized, doc=pending_doc('image/png'))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png', size=len(oversized)))

        written = written_attributes(mocks['projects'])
        assert written[0]['status'] == 'failed'
        assert str(MAX_IMAGE_DIMENSION_PX) in written[0]['error']
        mocks['bedrock'].converse.assert_not_called()

    def test_dimension_check_reads_only_a_ranged_header(
        self, extractor, wire, pending_doc, s3_event,
    ):
        # The cheap-rejection property: the first read is a Range request, so a
        # bad file never costs a full download.
        oversized = png_header(MAX_IMAGE_DIMENSION_PX + 1, 100)
        mocks = wire(body=oversized, doc=pending_doc('image/png'))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png', size=len(oversized)))

        assert len(mocks['s3'].gets) == 1
        assert mocks['s3'].gets[0][1] == f'bytes=0-{extractor.HEADER_BYTES - 1}'


class TestHeaderParsing:
    """Real headers, built with struct, parsed to the right dimensions."""

    @pytest.mark.parametrize(('builder', 'fmt', 'width', 'height'), [
        (png_header, 'png', 1170, 2532),
        (gif_header, 'gif', 640, 480),
        (webp_lossy_header, 'webp', 1024, 768),
        (webp_lossless_header, 'webp', 375, 812),
        (webp_extended_header, 'webp', 2048, 1536),
    ])
    def test_header_dimensions(self, extractor, builder, fmt, width, height):
        head = builder(width, height)

        assert extractor._sniff_format(head) == fmt
        assert extractor._dimensions_from_head(fmt, head) == (width, height)

    def test_jpeg_marker_walk(self, extractor):
        data = jpeg_header(1200, 800)

        assert extractor._sniff_format(data) == 'jpeg'
        assert extractor._jpeg_dimensions(data) == (1200, 800)

    def test_header_window_covers_every_non_jpeg_format(self, extractor):
        # HEADER_BYTES has to be wide enough for the LAST field any of these
        # parsers reads (WebP VP8X ends at byte 30). Truncating to the window is
        # what the ranged GET actually delivers.
        for builder in (png_header, gif_header, webp_lossy_header,
                        webp_lossless_header, webp_extended_header):
            head = builder(1234, 567)[:extractor.HEADER_BYTES]
            fmt = extractor._sniff_format(head)
            assert extractor._dimensions_from_head(fmt, head) == (1234, 567)

    @pytest.mark.parametrize('body', [
        b'',
        b'\x89PNG\r\n\x1a\n',                       # signature only, no IHDR
        b'\x89PNG\r\n\x1a\n' + b'\x00' * 16,        # IHDR missing
        b'RIFF' + b'\x00' * 4 + b'WEBPNOPE' + b'\x00' * 16,  # unknown chunk
        b'\xff\xd8\xff' + b'\x00' * 40,             # JPEG with no valid marker
    ])
    def test_truncated_or_corrupt_headers_yield_no_dimensions(self, extractor, body):
        fmt = extractor._sniff_format(body)
        if fmt == 'jpeg':
            assert extractor._jpeg_dimensions(body) is None
        elif fmt is None:
            assert True  # unrecognised is itself a refusal
        else:
            assert extractor._dimensions_from_head(fmt, body) is None


class TestTriggerGuard:
    """The stack wires ONE broad `projects/` prefix rule, so the key pattern is
    the whole defence — including against this Lambda's own output."""

    @pytest.mark.parametrize('key', [
        'projects/proj_1/product_docs/extracted/abc123.txt',  # our own output
        'projects/proj_1/prototypes/index.html',
        'projects/proj_1/product_docs/raw/nested/abc123.png',
        'raw/webscraper/2026/08/13/abc.json',
        'avatars/proj_1/persona_1.png',
        '',
    ])
    def test_non_product_doc_keys_are_ignored(
        self, extractor, wire, pending_doc, s3_event, key,
    ):
        mocks = wire(body=png_header(10, 10), doc=pending_doc('image/png'))

        result = extractor.lambda_handler(s3_event(key))

        assert result == {'processed': 1}
        assert mocks['projects'].updates == []
        assert mocks['s3'].puts == []
        assert mocks['s3'].gets == []
        mocks['bedrock'].converse.assert_not_called()

    def test_missing_record_does_not_raise(self, extractor, wire, s3_event):
        # The user can delete a document while extraction is in flight.
        mocks = wire(body=b'# hi', doc=None)

        assert extractor.lambda_handler(s3_event(f'{RAW_KEY}.md')) == {'processed': 1}
        assert mocks['projects'].updates == []
        assert mocks['s3'].puts == []

    def test_already_terminal_record_is_not_reprocessed(
        self, extractor, wire, pending_doc, s3_event,
    ):
        # A re-delivered notification must not re-bill a Bedrock call.
        doc = pending_doc('image/png', status='ready')
        mocks = wire(body=png_header(100, 100), doc=doc)

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png'))

        assert mocks['projects'].updates == []
        mocks['bedrock'].converse.assert_not_called()

    def test_batch_continues_after_one_bad_record(self, extractor, wire, pending_doc, s3_event):
        mocks = wire(body=b'# real content', doc=pending_doc('text/markdown'))
        event = {'Records': [{'s3': {}}, *s3_event(f'{RAW_KEY}.md')['Records']]}

        assert extractor.lambda_handler(event) == {'processed': 2}
        # The malformed record did not prevent the good one from completing.
        assert statuses(mocks['projects']) == ['ready']

    def test_unsupported_content_type_fails_the_record(
        self, extractor, wire, pending_doc, s3_event,
    ):
        doc = {**pending_doc('text/plain'), 'content_type': 'application/pdf'}
        mocks = wire(body=b'%PDF-1.7', doc=doc)

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.txt'))

        assert statuses(mocks['projects']) == ['failed']


class TestModelResolution:
    """Mirror of shared/model_config.py::get_active_model_id, and it must never
    raise: a model lookup is not allowed to break extraction."""

    def test_per_surface_override_wins(self, extractor, wire):
        wire(settings={'surfaces': {'documents': OTHER_ALLOWED_MODEL},
                       'model_id': DOCUMENTS_DEFAULT_MODEL})

        assert extractor._resolve_model_id() == OTHER_ALLOWED_MODEL

    def test_legacy_global_applies_when_no_surface_override(self, extractor, wire):
        wire(settings={'model_id': OTHER_ALLOWED_MODEL})

        assert extractor._resolve_model_id() == OTHER_ALLOWED_MODEL

    def test_surface_override_outranks_legacy_global(self, extractor, wire):
        wire(settings={'surfaces': {'documents': DOCUMENTS_DEFAULT_MODEL},
                       'model_id': OTHER_ALLOWED_MODEL})

        assert extractor._resolve_model_id() == DOCUMENTS_DEFAULT_MODEL

    def test_non_allowlisted_configured_model_is_ignored(self, extractor, wire):
        # A stale or tampered settings row must never reach Bedrock: a model that
        # is selectable but not granted AccessDenies the whole surface.
        wire(settings={'surfaces': {'documents': 'global.anthropic.claude-not-real'}})

        assert extractor._resolve_model_id() == DOCUMENTS_DEFAULT_MODEL

    def test_non_allowlisted_legacy_global_is_ignored(self, extractor, wire):
        wire(settings={'model_id': 'anthropic.something-unapproved'})

        assert extractor._resolve_model_id() == DOCUMENTS_DEFAULT_MODEL

    def test_dynamodb_failure_falls_back_to_the_default(self, extractor, wire):
        wire(settings_error=RuntimeError('ProvisionedThroughputExceededException'))

        assert extractor._resolve_model_id() == DOCUMENTS_DEFAULT_MODEL

    def test_no_settings_item_falls_back_to_the_default(self, extractor, wire):
        wire(settings=None)

        assert extractor._resolve_model_id() == DOCUMENTS_DEFAULT_MODEL

    def test_resolved_model_reaches_the_bedrock_call(
        self, extractor, wire, pending_doc, s3_event,
    ):
        image = png_header(400, 400)
        mocks = wire(body=image, doc=pending_doc('image/png'),
                     settings={'surfaces': {'documents': OTHER_ALLOWED_MODEL}})

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png', size=len(image)))

        assert mocks['bedrock'].converse.call_args.kwargs['modelId'] == OTHER_ALLOWED_MODEL


class TestExtractionPrompt:
    """The description is the only channel that reaches the prototype builder, so
    the prompt has to ask for values rather than adjectives."""

    CUSTOM_PROPERTIES = (
        '--primary', '--primary-light', '--soft', '--tint',
        '--bg', '--ink', '--gray', '--surface',
    )

    def test_names_all_eight_root_custom_properties(self, extractor):
        for prop in self.CUSTOM_PROPERTIES:
            assert prop in extractor.IMAGE_EXTRACTION_PROMPT, prop

    def test_demands_concrete_hex_values(self, extractor):
        prompt = extractor.IMAGE_EXTRACTION_PROMPT

        assert '#RRGGBB' in prompt
        assert 'hex' in prompt.lower()
        # "sample the colours" rather than "describe the palette": the generator's
        # neutral default is indigo #4F46E5, so a description that merely reads
        # back a plausible palette is indistinguishable from no grounding at all.
        assert 'SAMPLE' in prompt

    def test_asks_for_the_layout_flag_both_ways(self, extractor):
        prompt = extractor.IMAGE_EXTRACTION_PROMPT

        assert '420px' in prompt
        assert 'bottom tab bar' in prompt
        assert 'top navigation bar' in prompt

    def test_asks_for_inventories_verbatim_labels_and_shape(self, extractor):
        prompt = extractor.IMAGE_EXTRACTION_PROMPT

        for heading in ('## Palette', '## Layout', '## Screens',
                        '## Components', '## Labels', '## Shape and type'):
            assert heading in prompt, heading
        assert 'VERBATIM' in prompt
        assert 'ORIGINAL LANGUAGE' in prompt
        assert 'Corner radius' in prompt
        # Offline-first: the prototype can only use the system font stack.
        assert 'Do NOT name a webfont' in prompt
