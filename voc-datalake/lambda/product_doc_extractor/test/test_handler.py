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
    conditional_check_failed,
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
    """Every status this handler wrote, in order.

    A successful or failed extraction now writes TWICE — `extracting` before the
    S3/Bedrock work, then one terminal state — so these assertions are on the full
    walk rather than on a single value. Asserting the sequence is deliberate: it is
    what proves the "Extracting…" badge is actually reachable on every path, which
    it was not while nothing wrote it.
    """
    return [w.get('status') for w in written_attributes(projects)]


def terminal(projects) -> dict:
    """The LAST attribute set written — the terminal one."""
    written = written_attributes(projects)
    assert written, 'nothing was written to the product-doc record'
    return written[-1]


def _recording(table, order: list):
    """Wrap a fake table's update_item so call ORDER against S3 can be asserted."""
    original = table.update_item

    def recorded(**kwargs):
        order.append('update')
        return original(**kwargs)

    return recorded


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
        assert len(written) == 2
        assert written[0] == {'status': 'extracting'}
        assert written[1]['status'] == 'ready'
        assert written[1]['error'] is None
        assert written[1]['s3_extracted_key'] == EXTRACTED_KEY
        assert written[1]['extracted_chars'] == len(source.decode('utf-8'))
        # No model in the loop at all for a text document.
        mocks['bedrock'].converse.assert_not_called()

    def test_plain_text_is_not_normalised(self, extractor, wire, pending_doc, s3_event):
        source = b'  leading and trailing whitespace  \n\n\ttabbed\n'
        mocks = wire(body=source, doc=pending_doc('text/plain'))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.txt', size=len(source)))

        assert mocks['s3'].puts[0]['Body'] == source
        assert statuses(mocks['projects']) == ['extracting', 'ready']

    def test_empty_text_file_fails_rather_than_claiming_ready(
        self, extractor, wire, pending_doc, s3_event,
    ):
        mocks = wire(body=b'   \n\t\n', doc=pending_doc('text/plain'))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.txt', size=6))

        assert statuses(mocks['projects']) == ['extracting', 'failed']
        assert mocks['s3'].puts == []


class TestImageDescription:
    def test_png_reaches_ready_with_the_model_description(
        self, extractor, wire, pending_doc, s3_event,
    ):
        image = png_header(1170, 2532) + b'\x00' * 64
        mocks = wire(body=image, doc=pending_doc('image/png'),
                     model_text='## Palette\n`--primary`: #0F62FE')

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png', size=len(image)))

        assert statuses(mocks['projects']) == ['extracting', 'ready']
        assert mocks['s3'].puts[0]['Body'] == b'## Palette\n`--primary`: #0F62FE'
        assert terminal(mocks['projects'])['extracted_chars'] == len('## Palette\n`--primary`: #0F62FE')

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
        assert statuses(mocks['projects']) == ['extracting', 'ready']

    def test_image_content_type_with_non_image_bytes_fails(
        self, extractor, wire, pending_doc, s3_event,
    ):
        # A .png full of PDF bytes: the declared content type is a claim, the
        # header sniff is the check.
        body = b'%PDF-1.7\n%\xc7\xec\x8f\xa2\n1 0 obj\n<< /Type /Catalog >>'
        mocks = wire(body=body, doc=pending_doc('image/png'))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png', size=len(body)))

        assert statuses(mocks['projects']) == ['extracting', 'failed']
        assert terminal(mocks['projects'])['error']
        # Not "ready with an empty description", and no model call was billed.
        assert 'ready' not in statuses(mocks['projects'])
        mocks['bedrock'].converse.assert_not_called()
        assert mocks['s3'].puts == []

    def test_mismatched_image_type_fails(self, extractor, wire, pending_doc, s3_event):
        # Real image, wrong declared type: a GIF uploaded as image/png.
        body = gif_header(100, 100)
        mocks = wire(body=body, doc=pending_doc('image/png'))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png', size=len(body)))

        assert statuses(mocks['projects']) == ['extracting', 'failed']
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

        assert statuses(mocks['projects']) == ['extracting', 'failed']
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

        failure = terminal(mocks['projects'])
        assert failure['status'] == 'failed'
        assert 'ThrottlingException' not in failure['error']
        assert 'arn:aws' not in failure['error']


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

        assert statuses(mocks['projects']) == ['extracting', 'failed']
        mocks['bedrock'].converse.assert_not_called()
        # Refused before a single byte was fetched.
        assert mocks['s3'].gets == []

    def test_zero_byte_object_fails(self, extractor, wire, pending_doc, s3_event):
        mocks = wire(body=b'', doc=pending_doc('image/png'))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png', size=0))

        assert statuses(mocks['projects']) == ['extracting', 'failed']

    def test_png_over_the_dimension_cap_is_refused(
        self, extractor, wire, pending_doc, s3_event,
    ):
        oversized = png_header(MAX_IMAGE_DIMENSION_PX + 1, 100)
        mocks = wire(body=oversized, doc=pending_doc('image/png'))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png', size=len(oversized)))

        failure = terminal(mocks['projects'])
        assert failure['status'] == 'failed'
        assert str(MAX_IMAGE_DIMENSION_PX) in failure['error']
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
        assert statuses(mocks['projects']) == ['extracting', 'ready']

    def test_unsupported_content_type_fails_the_record(
        self, extractor, wire, pending_doc, s3_event,
    ):
        doc = {**pending_doc('text/plain'), 'content_type': 'application/pdf'}
        mocks = wire(body=b'%PDF-1.7', doc=doc)

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.txt'))

        assert statuses(mocks['projects']) == ['extracting', 'failed']


class TestTheExtractingBadgeIsWritten:
    """`extracting` was declared in three places and written in none.

    The UI renders a distinct "Extracting…" badge for it, `ProductDocStatus`
    declares it, and `product_context.py::STALLABLE_STATUSES` includes it — so
    the stall branch for it, and its test, were exercising a state the system
    could not reach. These assertions are what make all three real.
    """

    def test_it_is_written_before_the_slow_work_starts(self, extractor, wire, pending_doc, s3_event):
        """Order is the whole point: the state is only worth writing if it is
        visible WHILE the S3 reads and the Bedrock call are in flight. Asserted
        against the S3 call log, so "before" means before the work, not merely
        first in the list of writes."""
        image = png_header(400, 400)
        mocks = wire(body=image, doc=pending_doc('image/png'))
        order: list[str] = []
        mocks['projects'].update_item = _recording(mocks['projects'], order)
        original_get = mocks['s3'].get_object
        def tracked_get(**kwargs):
            order.append('s3.get')
            return original_get(**kwargs)
        mocks['s3'].get_object = tracked_get

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png', size=len(image)))

        assert order[0] == 'update'
        assert 's3.get' in order[1:]

    @pytest.mark.parametrize('content_type', ['text/markdown', 'image/png'])
    def test_both_branches_publish_it(self, extractor, wire, pending_doc, s3_event, content_type):
        body = b'# notes' if content_type.startswith('text/') else png_header(400, 400)
        mocks = wire(body=body, doc=pending_doc(content_type))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png', size=len(body)))

        assert statuses(mocks['projects'])[0] == 'extracting'

    def test_it_is_written_on_a_failing_path_too(self, extractor, wire, pending_doc, s3_event):
        """A document that fails was still being analysed. Publishing `extracting`
        only on the happy path would leave the badge stuck on "Uploading…" for
        exactly the documents a user is most likely to be watching."""
        body = b'%PDF-1.7 not an image at all'
        mocks = wire(body=body, doc=pending_doc('image/png'))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png', size=len(body)))

        assert statuses(mocks['projects']) == ['extracting', 'failed']

    def test_it_carries_nothing_but_the_status(self, extractor, wire, pending_doc, s3_event):
        """Not a place to clear `error` or reset `extracted_chars`: this is one
        transition, and a write that quietly touches other attributes is a write
        whose failure has consequences beyond a badge."""
        mocks = wire(body=b'# notes', doc=pending_doc('text/markdown'))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.md', size=7))

        assert written_attributes(mocks['projects'])[0] == {'status': 'extracting'}

    def test_a_failed_badge_write_does_not_stop_the_extraction(
        self, extractor, wire, pending_doc, s3_event,
    ):
        """Bookkeeping must not be able to abort real work. `pending` is stallable
        too, so a document whose badge write was lost is not stranded either."""
        source = b'# real content'
        mocks = wire(body=source, doc=pending_doc('text/markdown'))
        calls = {'n': 0}
        real_update = mocks['projects'].update_item

        def failing_first_update(**kwargs):
            calls['n'] += 1
            if calls['n'] == 1:
                raise RuntimeError('ProvisionedThroughputExceededException')
            return real_update(**kwargs)

        mocks['projects'].update_item = failing_first_update

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.md', size=len(source)))

        # The extraction completed and the terminal write landed.
        assert mocks['s3'].puts[0]['Body'] == source
        assert calls['n'] == 2

    def test_the_stallable_statuses_the_api_watches_are_the_ones_written_here(self):
        """Cross-module: product_context.py fails a record stuck in one of these,
        and this handler is the only thing that writes them. A status in one list
        and not the other is either an unreachable badge (what this finding was)
        or a record the API will never rescue."""
        from api.product_context import STALLABLE_STATUSES

        from product_doc_extractor.handler import NON_TERMINAL_STATUSES

        assert set(NON_TERMINAL_STATUSES) == set(STALLABLE_STATUSES)


class TestALateExtractionCannotClobberAStalledFailure:
    """The API's read path fails a record that has not been extracted within
    EXTRACTION_STALL_SECONDS, with a message telling the user to delete the
    document and upload it again. An extraction that finishes after that — a
    Lambda retry, a cold-start pileup, Bedrock latency — must not overwrite that
    `failed` with `ready`, nor reset its `error` to None: the user has already
    been told to re-upload and may well have done it."""

    def test_every_write_is_conditional_on_the_status_being_non_terminal(
        self, extractor, wire, pending_doc, s3_event,
    ):
        """Asserted on the CALL. A behavioural test cannot reach this: the fake
        table does not evaluate conditions, and the real one only refuses the
        write in a race a test cannot schedule. So the condition itself is the
        assertion — with the two placeholder VALUES checked as well, since a
        condition naming the wrong statuses would still be a condition."""
        image = png_header(400, 400)
        mocks = wire(body=image, doc=pending_doc('image/png'))

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png', size=len(image)))

        assert mocks['projects'].updates, 'no write to inspect'
        for call in mocks['projects'].updates:
            condition = call['ConditionExpression']
            assert 'attribute_exists(pk)' in condition
            values = call['ExpressionAttributeValues']
            status_placeholders = sorted(k for k in values if k.startswith(':s'))
            assert {values[k] for k in status_placeholders} == set(extractor.NON_TERMINAL_STATUSES)
            # Declared AND referenced: a placeholder in the values map that the
            # condition never mentions guards nothing.
            for placeholder in status_placeholders:
                assert placeholder in condition
            assert call['ExpressionAttributeNames']['#doc_status'] == 'status'
            assert '#doc_status IN' in condition

    def test_ready_and_failed_are_not_among_the_statuses_it_may_write_over(self, extractor):
        """The load-bearing exclusion. A condition listing all four statuses would
        satisfy every structural assertion above and protect nothing."""
        assert 'ready' not in extractor.NON_TERMINAL_STATUSES
        assert 'failed' not in extractor.NON_TERMINAL_STATUSES

    def test_a_record_the_api_already_failed_is_never_touched(
        self, extractor, wire, pending_doc, s3_event,
    ):
        """The cheap half of the defence: the record is re-read at the start of
        every invocation, so a retry arriving after the stall transition skips the
        work entirely — no Bedrock re-bill, and no write to refuse."""
        stalled = pending_doc('image/png', status='failed')
        stalled['error'] = ('Text extraction did not complete. Please delete this '
                            'document and upload it again.')
        mocks = wire(body=png_header(400, 400), doc=stalled)

        extractor.lambda_handler(s3_event(f'{RAW_KEY}.png'))

        assert mocks['projects'].updates == []
        mocks['bedrock'].converse.assert_not_called()
        assert mocks['s3'].gets == []

    @pytest.mark.parametrize('by', ['code', 'name'])
    def test_a_refused_write_is_logged_as_the_serious_case_not_the_benign_one(
        self, extractor, wire, pending_doc, s3_event, caplog, by,
    ):
        """A ConditionalCheckFailedException means one of two things, and they are
        not equally interesting: the record was deleted (ordinary), or the API had
        already given the document up (an extraction ran past the stall window,
        and its result has just been discarded). Swallowing both identically —
        which is what the code did — throws away the only signal that the second
        happened.

        Both recognisable shapes of the exception are exercised: boto3 raises a
        dynamically-named ClientError carrying the error code, and a double raises
        the named class with no payload.
        """
        source = b'# late but successful'
        doc = pending_doc('text/markdown')
        wire(body=source, doc=doc, update_error=conditional_check_failed(by=by))

        with caplog.at_level('INFO'):
            extractor.lambda_handler(s3_event(f'{RAW_KEY}.md', size=len(source)))

        messages = [r.message for r in caplog.records]
        refusals = [m for m in messages if 'refusing to overwrite' in m]
        assert refusals, f'no distinguishable refusal log; got {messages}'
        # It names the status that won, and says why this is not routine.
        assert doc['status'] in refusals[-1]
        assert 'stalled' in refusals[-1]
        assert not any('deleted mid-extraction' in m for m in messages)

    def test_a_deleted_record_is_still_logged_as_the_benign_case(
        self, extractor, wire, pending_doc, s3_event, caplog,
    ):
        """The other side of the same branch — and the reason the classification is
        worth the extra get_item. Without this, "record gone" and "the API gave up
        on this document" read identically in CloudWatch."""
        source = b'# deleted while running'
        doc = pending_doc('text/markdown')
        mocks = wire(body=source, doc=doc,
                     update_error=conditional_check_failed())
        # Present for the opening read, gone by the time the write is refused —
        # which is what "deleted mid-extraction" actually means. A table that were
        # empty from the start would make the handler skip before writing at all,
        # and this test would pass while exercising nothing.
        reads = {'n': 0}

        # Capitalised parameter name because it is boto3's own kwarg.
        def vanishing_get(Key=None, **_kwargs):
            reads['n'] += 1
            return {'Item': doc} if reads['n'] == 1 else {}

        mocks['projects'].get_item = vanishing_get

        with caplog.at_level('INFO'):
            extractor.lambda_handler(s3_event(f'{RAW_KEY}.md', size=len(source)))

        messages = [r.message for r in caplog.records]
        assert any('deleted mid-extraction' in m for m in messages), messages
        assert not any('refusing to overwrite' in m for m in messages)

    def test_a_non_conditional_write_failure_is_not_reported_as_a_refusal(
        self, extractor, wire, pending_doc, s3_event, caplog,
    ):
        """Throughput or network failures are not the API having overruled us, and
        must not be logged as if they were — the refusal line is a signal about
        stall timing, so a false one is worse than none."""
        source = b'# notes'
        mocks = wire(body=source, doc=pending_doc('text/markdown'),
                     update_error=RuntimeError('ProvisionedThroughputExceededException'))

        with caplog.at_level('INFO'):
            extractor.lambda_handler(s3_event(f'{RAW_KEY}.md', size=len(source)))

        messages = [r.message for r in caplog.records]
        assert any('Could not update product doc' in m for m in messages), messages
        assert not any('refusing to overwrite' in m for m in messages)
        assert mocks['s3'].puts, 'the extraction itself should still have run'

    def test_the_handler_does_not_raise_when_a_write_is_refused(
        self, extractor, wire, pending_doc, s3_event,
    ):
        """Re-raising would hand the event back for two more retries of work whose
        result is already unwanted."""
        mocks = wire(body=b'# notes', doc=pending_doc('text/markdown'),
                     update_error=conditional_check_failed())

        assert extractor.lambda_handler(s3_event(f'{RAW_KEY}.md', size=7)) == {'processed': 1}
        assert mocks['projects'].updates, 'the write should have been attempted'


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
