"""The product-doc upload boundary accepts exactly what can be processed.

Before this, ALLOWED_CONTENT_TYPES took pdf/docx/md/txt while nothing extracted
any of them: every upload succeeded, every record sat at `status: 'pending'`
forever, and the UI badge read "Extracting…" for the life of the record. The
boundary now accepts images plus .md/.txt, refuses pdf/docx with an explicit
"not yet", caps images at what the Bedrock Converse API will carry, and makes the
declared size binding on S3 instead of advisory.

`create_upload_url` and `ALLOWED_CONTENT_TYPES` had no coverage at all, so
everything here is new.
"""
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest

DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'


def _table(items: list[dict] | None = None) -> MagicMock:
    """A projects table whose query() returns a real dict, as boto3's does.

    A bare MagicMock would make `resp.get('Items', [])` return a MagicMock and
    blow up in `_list_doc_items` for reasons unrelated to the test.
    """
    table = MagicMock()
    table.query.return_value = {'Items': items or []}
    return table


def _create(body: dict, table: MagicMock | None = None):
    """Call create_upload_url with DynamoDB and S3 mocked. Returns (result, table, s3)."""
    import product_context

    table = table if table is not None else _table()
    s3 = MagicMock()
    s3.generate_presigned_url.return_value = 'https://example-bucket.s3.amazonaws.com/signed'
    with patch.object(product_context, 'projects_table', table), \
         patch.object(product_context, '_s3', return_value=s3):
        result = product_context.create_upload_url('proj-1', body)
    return result, table, s3


def _reject(body: dict, table: MagicMock | None = None):
    """Assert the upload is refused; return (message, table) for further assertions."""
    import product_context
    from shared.exceptions import ValidationError

    table = table if table is not None else _table()
    s3 = MagicMock()
    with patch.object(product_context, 'projects_table', table), \
         patch.object(product_context, '_s3', return_value=s3), \
         pytest.raises(ValidationError) as exc:
        product_context.create_upload_url('proj-1', body)
    return exc.value, table


class TestDeferredTypesAreRefusedWithoutLeavingARecord:
    """pdf/docx are refused, and refused BEFORE anything is written.

    Asserting only the error would pass even if a record leaked — which is the
    exact failure mode this rung exists to remove, so the put_item assertion is
    the one that matters.
    """

    def test_pdf_is_refused_with_a_client_error(self):
        error, _ = _reject({'filename': 'spec.pdf', 'content_type': 'application/pdf',
                            'size_bytes': 1000})
        assert error.status_code == 400

    def test_pdf_writes_no_record(self):
        _, table = _reject({'filename': 'spec.pdf', 'content_type': 'application/pdf',
                            'size_bytes': 1000})
        table.put_item.assert_not_called()

    def test_pdf_message_says_not_yet_and_names_what_is_accepted(self):
        error, _ = _reject({'filename': 'spec.pdf', 'content_type': 'application/pdf',
                            'size_bytes': 1000})
        assert 'PDF' in error.message
        assert 'not supported yet' in error.message
        assert '.png' in error.message
        assert '.txt' in error.message

    def test_docx_is_refused_with_a_client_error(self):
        error, _ = _reject({'filename': 'brief.docx', 'content_type': DOCX_MIME,
                            'size_bytes': 1000})
        assert error.status_code == 400

    def test_docx_writes_no_record(self):
        _, table = _reject({'filename': 'brief.docx', 'content_type': DOCX_MIME,
                            'size_bytes': 1000})
        table.put_item.assert_not_called()

    def test_docx_message_says_not_yet_and_names_what_is_accepted(self):
        error, _ = _reject({'filename': 'brief.docx', 'content_type': DOCX_MIME,
                            'size_bytes': 1000})
        assert 'not supported yet' in error.message
        assert '.md' in error.message

    def test_deferred_is_distinguishable_from_never_supported(self):
        """"we will never take this" and "not yet" must read differently."""
        deferred, _ = _reject({'filename': 'a.pdf', 'content_type': 'application/pdf',
                               'size_bytes': 10})
        never, _ = _reject({'filename': 'a.exe', 'content_type': 'application/x-msdownload',
                            'size_bytes': 10})
        assert 'not supported yet' in deferred.message
        assert 'not supported yet' not in never.message
        assert 'Unsupported file type' in never.message

    def test_an_unsupported_type_also_writes_no_record(self):
        _, table = _reject({'filename': 'a.exe', 'content_type': 'application/x-msdownload',
                            'size_bytes': 10})
        table.put_item.assert_not_called()


class TestImagesAreAccepted:
    """These were a ValidationError before this rung, so they are the criterion
    that proves the narrowing actually happened rather than only tightened."""

    @pytest.mark.parametrize(('content_type', 'ext'), [
        ('image/png', 'png'),
        ('image/jpeg', 'jpg'),
        ('image/gif', 'gif'),
        ('image/webp', 'webp'),
    ])
    def test_image_upload_is_accepted_and_keyed_by_extension(self, content_type, ext):
        result, table, _ = _create({'filename': f'screen.{ext}',
                                    'content_type': content_type,
                                    'size_bytes': 50_000})
        assert result['doc_id']
        assert result['presigned_url']
        item = table.put_item.call_args.kwargs['Item']
        assert item['s3_raw_key'].endswith(f'.{ext}')
        assert item['status'] == 'pending'

    @pytest.mark.parametrize('content_type', ['text/markdown', 'text/plain'])
    def test_text_upload_is_still_accepted(self, content_type):
        result, table, _ = _create({'filename': 'notes.md',
                                    'content_type': content_type,
                                    'size_bytes': 2_000})
        assert result['doc_id']
        table.put_item.assert_called_once()


class TestSizeCapsArePerType:
    """Images are bound by the Converse API limit, text by the general file cap."""

    def test_an_image_one_byte_over_the_image_cap_is_refused(self):
        from shared.image_limits import MAX_IMAGE_BYTES

        error, table = _reject({'filename': 'big.png', 'content_type': 'image/png',
                                'size_bytes': MAX_IMAGE_BYTES + 1})
        assert error.status_code == 400
        table.put_item.assert_not_called()

    def test_the_image_error_names_the_image_limit_not_the_file_limit(self):
        """The fixture is over the IMAGE cap but well under the 10 MiB file cap, so
        only one limit can have spoken. A fixture over both could not show which."""
        import product_context
        from shared.image_limits import MAX_IMAGE_BYTES

        error, _ = _reject({'filename': 'big.png', 'content_type': 'image/png',
                            'size_bytes': MAX_IMAGE_BYTES + 1})
        assert MAX_IMAGE_BYTES + 1 < product_context.MAX_FILE_BYTES
        assert error.message == 'Images must be between 1 byte and 3.5 MB.'
        assert '10.0 MB' not in error.message

    def test_an_image_exactly_at_the_cap_is_accepted(self):
        from shared.image_limits import MAX_IMAGE_BYTES

        result, table, _ = _create({'filename': 'edge.png', 'content_type': 'image/png',
                                    'size_bytes': MAX_IMAGE_BYTES})
        assert result['doc_id']
        table.put_item.assert_called_once()

    def test_text_larger_than_the_image_cap_is_accepted(self):
        """The load-bearing test for per-type caps: a file size that is illegal for
        an image but legal for text. If the image cap had simply been applied to
        everything, this would fail."""
        import product_context
        from shared.image_limits import MAX_IMAGE_BYTES

        size = (MAX_IMAGE_BYTES + product_context.MAX_FILE_BYTES) // 2
        assert MAX_IMAGE_BYTES < size < product_context.MAX_FILE_BYTES

        result, table, _ = _create({'filename': 'huge.txt', 'content_type': 'text/plain',
                                    'size_bytes': size})
        assert result['doc_id']
        table.put_item.assert_called_once()

    def test_text_over_the_file_cap_is_refused_naming_the_file_limit(self):
        import product_context

        error, table = _reject({'filename': 'huge.txt', 'content_type': 'text/plain',
                                'size_bytes': product_context.MAX_FILE_BYTES + 1})
        assert error.message == 'Files must be between 1 byte and 10.0 MB.'
        table.put_item.assert_not_called()

    def test_a_zero_byte_upload_is_refused(self):
        _, table = _reject({'filename': 'empty.txt', 'content_type': 'text/plain',
                            'size_bytes': 0})
        table.put_item.assert_not_called()

    @pytest.mark.parametrize('size_bytes', [
        'not-a-number',
        '',
        {'bytes': 1000},
        [1000],
        float('nan'),
        float('inf'),
        None,
    ])
    def test_a_non_numeric_declared_size_is_a_client_error_not_a_crash(self, size_bytes):
        """`size_bytes` is now signed into the presigned PUT as ContentLength, so
        it is part of a security control rather than an advisory field — and a bare
        `int(value)` over a JSON body raises TypeError / ValueError / OverflowError
        on each of these, which surfaces as a 500 for what is plainly a bad
        request. ApiError with a 400 is the whole assertion; the code path that
        produced it is not.
        """
        error, table = _reject({'filename': 'screen.png', 'content_type': 'image/png',
                                'size_bytes': size_bytes})
        assert error.status_code == 400
        table.put_item.assert_not_called()

    def test_the_bad_size_error_reads_like_every_other_bad_size(self):
        """A caller should not need a second vocabulary for "that is not a size":
        the message is the one a zero or an over-cap value gets."""
        unreadable, _ = _reject({'filename': 'screen.png', 'content_type': 'image/png',
                                 'size_bytes': 'enormous'})
        zero, _ = _reject({'filename': 'screen.png', 'content_type': 'image/png',
                           'size_bytes': 0})
        assert unreadable.message == zero.message

    def test_a_numeric_string_is_still_accepted(self):
        """Coercing defensively must not become coercing strictly: a client that
        sends "50000" was working before and has to keep working."""
        result, table, s3 = _create({'filename': 'screen.png', 'content_type': 'image/png',
                                     'size_bytes': '50000'})
        assert result['doc_id']
        # And the SIGNED number is the integer, not the string — a str
        # ContentLength would be signed and then never match the body's length.
        assert s3.generate_presigned_url.call_args.kwargs['Params']['ContentLength'] == 50_000
        assert table.put_item.call_args.kwargs['Item']['size_bytes'] == 50_000

    def test_the_cap_is_reported_in_mb_not_raw_bytes(self):
        from shared.image_limits import MAX_IMAGE_BYTES

        error, _ = _reject({'filename': 'big.png', 'content_type': 'image/png',
                            'size_bytes': MAX_IMAGE_BYTES + 1})
        assert str(MAX_IMAGE_BYTES) not in error.message


class TestADeclaredSizeMustBeAWholeNumberOfBytes:
    """A size that parses but is not integral used to be TRUNCATED: `int(1000.7)`
    is 1000, so the presigned URL was signed with ContentLength 1000 and the
    client then PUT 1001 bytes. S3 refuses that with a signature/length error the
    caller cannot act on, which is strictly worse than the 400 every other
    unusable size produces — and the field is signed into the URL, so it is part
    of a security control and is validated like one.

    `True` is in the rejected list on purpose: bool is a subclass of int, so
    `int(True)` is 1 and a JSON `true` would otherwise have been accepted as a
    one-byte file.
    """

    @pytest.mark.parametrize('size_bytes', [
        1000.7,
        '1000.7',
        0.5,
        True,
        float('nan'),
        float('inf'),
        float('-inf'),
        Decimal('1000.7'),
    ])
    def test_a_non_integral_size_is_refused_before_any_write(self, size_bytes):
        error, table = _reject({'filename': 'screen.png', 'content_type': 'image/png',
                                'size_bytes': size_bytes})
        assert error.status_code == 400
        table.put_item.assert_not_called()

    def test_the_non_integral_error_reads_like_every_other_bad_size(self):
        """The load-bearing half of "no second vocabulary": a fractional size is
        answered with the SAME message as a zero, not a new one. A distinct string
        would be another thing to translate and another shape for a caller to
        handle."""
        fractional, _ = _reject({'filename': 'screen.png', 'content_type': 'image/png',
                                 'size_bytes': 1000.7})
        zero, _ = _reject({'filename': 'screen.png', 'content_type': 'image/png',
                           'size_bytes': 0})
        unreadable, _ = _reject({'filename': 'screen.png', 'content_type': 'image/png',
                                 'size_bytes': 'enormous'})
        assert fractional.message == zero.message == unreadable.message

    @pytest.mark.parametrize('size_bytes', [
        1000,        # the ordinary case
        1000.0,      # integral float — JSON has one number type, so this is common
        '1000',      # a client that has always worked must keep working
        Decimal(1000),     # DynamoDB's number type, in case a record reaches here
        Decimal('1E+3'),   # ...including its exponent form
    ])
    def test_an_integral_size_is_accepted_and_signed_as_a_plain_int(self, size_bytes):
        """Truncation is not the only failure available: signing a float or a str
        ContentLength would also never match the body's length."""
        result, table, s3 = _create({'filename': 'screen.png', 'content_type': 'image/png',
                                     'size_bytes': size_bytes})
        assert result['doc_id']
        signed = s3.generate_presigned_url.call_args.kwargs['Params']['ContentLength']
        assert signed == 1000
        assert type(signed) is int
        assert table.put_item.call_args.kwargs['Item']['size_bytes'] == 1000


class _NeverConvertibleDecimal(Decimal):
    """A Decimal that refuses to become an int.

    This is what lets the tests below fail on the SLOW PATH rather than on the
    return value. Asserting only "returns a 400" would pass just as happily while
    `int()` spent minutes building a 415 MB integer first — the 400 was never the
    part in doubt.

    Patched over `product_context.Decimal`, so the module's own parse produces one
    of these and any conversion raises where a test can see it. Subclassing works
    on the C `_decimal` implementation: the constructor returns the subclass and
    `__int__` is honoured, while comparison, `is_finite()` and
    `to_integral_value()` behave exactly as the base class does.
    """

    def __int__(self):
        raise AssertionError(
            'int() was reached on a declared size whose magnitude had not been '
            'bounded first — that conversion IS the resource exhaustion, so a '
            'bound placed after it guards nothing'
        )


HOSTILE_SIZES = [
    '1E+999999999',    # twelve bytes -> a billion-digit integer
    '1e+999999999',    # lower-case exponent, same value, still parses
    '-1E+999999999',   # below every cap, so an UPPER bound alone misses it
    '9' * 10_000,      # no exponent at all — and int() on a Decimal is not
                       # subject to sys.get_int_max_str_digits(), which is what
                       # stops the same digits arriving as a JSON int
    '1E-999999999',    # negative exponent: the other end of the same trick
    Decimal('1E+999999999'),  # the DynamoDB number type, same magnitude
]


class TestAHostileDeclaredSizeIsNeverMaterialised:
    """A declared size must be bounded in the Decimal domain, before conversion.

    `'1E+999999999'` is twelve bytes of request body. It parses, it is finite and
    it is integral, so every other check in `_declared_size` passes it — and
    `int()` then builds an integer of a billion digits (~415 MB) inside the request
    path, before the caller's `max_bytes` cap is ever consulted. The conversion is
    the cost, so the caller's check comes too late by construction.

    This was a REGRESSION: the original `int(value or 0)` raised ValueError on
    exponent notation and produced a clean 400.
    """

    @pytest.mark.parametrize('size_bytes', HOSTILE_SIZES)
    def test_it_is_refused_with_the_ordinary_bad_size_error(self, size_bytes):
        """No new vocabulary: the caller answers with the message every other
        unusable size gets, so nothing new needs translating."""
        error, table = _reject({'filename': 'screen.png', 'content_type': 'image/png',
                                'size_bytes': size_bytes})
        assert error.status_code == 400
        assert error.message == 'Images must be between 1 byte and 3.5 MB.'
        table.put_item.assert_not_called()

    @pytest.mark.parametrize('size_bytes', HOSTILE_SIZES)
    def test_the_conversion_is_never_reached(self, size_bytes):
        """The load-bearing half. With `int()` booby-trapped, reaching it is an
        AssertionError out of `_declared_size` — so this fails on the work done,
        not on the status code."""
        import product_context

        with patch.object(product_context, 'Decimal', _NeverConvertibleDecimal):
            error, table = _reject({'filename': 'screen.png', 'content_type': 'image/png',
                                    'size_bytes': size_bytes})
        assert error.status_code == 400
        table.put_item.assert_not_called()

    def test_the_trap_fires_on_a_size_that_IS_converted(self):
        """Vacuity guard for the test above: if the module ever stopped parsing
        through its own `Decimal` name, the patch would land on nothing and the
        trap would pass by never firing. A legitimate size must still reach the
        conversion, and therefore must still trip the trap."""
        import product_context

        with patch.object(product_context, 'Decimal', _NeverConvertibleDecimal), \
             pytest.raises(AssertionError, match=r'int\(\) was reached'):
            _create({'filename': 'screen.png', 'content_type': 'image/png',
                     'size_bytes': 1000})

    def test_a_hostile_size_is_refused_inside_a_time_budget(self):
        """Belt and braces, and it survives a rewrite that no longer routes through
        the patched name.

        Not `1E+999999999`: without the bound this must FAIL rather than hang, so
        the exponent has to be one an unbounded implementation still finishes.

        THE BUDGET IS CHOSEN FOR MARGIN ON BOTH SIDES, which is why it is not
        simply "generous". Measured on this runtime: the bounded path is ~10µs,
        and `int(Decimal('1E+1000000'))` costs ~30s. So 5s sits ~500,000x above
        the real cost and ~6x below the failure — a contended runner cannot reach
        it without every other test in this suite timing out first, and an
        unbounded implementation cannot duck under it.

        Widening the budget further would make this test WORSE, not safer: the
        cost being detected is fixed, so every second added moves the threshold
        toward it. That is the trap in treating a timing assertion as merely
        needing more headroom — headroom is bounded above by the thing it detects.
        The deterministic `_NeverConvertibleDecimal` test above is the primary
        guard precisely because it needs no budget at all; this one exists to
        survive a rewrite that no longer routes through the patched name.
        """
        import product_context

        started = time.perf_counter()
        assert product_context._declared_size('1E+1000000') is None
        assert time.perf_counter() - started < 5.0

    def test_a_long_numeric_string_is_refused_by_the_same_bound(self):
        """The parse itself needs no length limit, which is worth recording: a
        10 MB numeric string (the API Gateway body limit, so the worst case a
        client can send) parses in ~24ms and compares in microseconds, because
        libmpdec is linear in the digit count. The superlinear cost is entirely in
        `int()`, and the bound is already in front of that."""
        import product_context

        started = time.perf_counter()
        assert product_context._declared_size('9' * 10_000_000) is None
        # ~24ms actual against 5s, and an unbounded int() on ten million digits is
        # minutes — so the same both-sides margin as the test above.
        assert time.perf_counter() - started < 5.0

    def test_a_size_exactly_at_the_file_cap_is_still_accepted(self):
        """The bound is the WIDEST cap and it is inclusive, so the largest legal
        file is not collateral damage. A guard set one byte low would refuse it
        with the same message the cap gives, which is exactly the kind of change
        that hides in a green suite."""
        import product_context

        result, table, s3 = _create({'filename': 'huge.txt', 'content_type': 'text/plain',
                                     'size_bytes': product_context.MAX_FILE_BYTES})
        assert result['doc_id']
        signed = s3.generate_presigned_url.call_args.kwargs['Params']['ContentLength']
        assert signed == product_context.MAX_FILE_BYTES
        assert table.put_item.call_args.kwargs['Item']['size_bytes'] == product_context.MAX_FILE_BYTES


class TestDeclaredSizeIsBindingOnS3:
    """`size_bytes` is client-declared; without ContentLength in the signature S3
    enforces nothing and the cap is advisory."""

    def test_the_presigned_put_signs_the_declared_content_length(self):
        """Asserted on the CALL, not on a return value: a MagicMock happily
        ignores whatever parameters it is handed, so checking the returned URL
        could not detect ContentLength being dropped from Params."""
        _, _, s3 = _create({'filename': 'screen.png', 'content_type': 'image/png',
                            'size_bytes': 12_345})
        params = s3.generate_presigned_url.call_args.kwargs['Params']
        assert params['ContentLength'] == 12_345

    def test_the_presigned_put_still_signs_the_content_type_and_key(self):
        result, table, s3 = _create({'filename': 'screen.png', 'content_type': 'image/png',
                                     'size_bytes': 999})
        params = s3.generate_presigned_url.call_args.kwargs['Params']
        assert params['ContentType'] == 'image/png'
        assert params['Key'] == table.put_item.call_args.kwargs['Item']['s3_raw_key']
        assert result['headers'] == {'Content-Type': 'image/png'}

    def test_content_length_is_not_returned_as_a_header_for_the_browser(self):
        """It is a forbidden header name for fetch — the browser derives it from
        the body. Returning it would only invite a caller to try to set it."""
        result, _, _ = _create({'filename': 'screen.png', 'content_type': 'image/png',
                                'size_bytes': 999})
        assert 'Content-Length' not in result['headers']


class TestRejectionHappensBeforeAnyWrite:
    """Ordering invariant: a refused upload leaves no trace at all."""

    @pytest.mark.parametrize('body', [
        {'filename': '', 'content_type': 'image/png', 'size_bytes': 10},
        {'filename': 'a.pdf', 'content_type': 'application/pdf', 'size_bytes': 10},
        {'filename': 'a.zip', 'content_type': 'application/zip', 'size_bytes': 10},
        {'filename': 'a.png', 'content_type': 'image/png', 'size_bytes': 0},
        {'filename': 'a.png', 'content_type': 'image/png', 'size_bytes': 99_000_000},
    ])
    def test_no_record_and_no_presign_for_any_rejection(self, body):
        import product_context
        from shared.exceptions import ApiError

        # ApiError rather than Exception: this asserts a *handled* rejection, so a
        # TypeError from a broken fixture must not be mistaken for one.
        table = _table()
        s3 = MagicMock()
        with patch.object(product_context, 'projects_table', table), \
             patch.object(product_context, '_s3', return_value=s3), \
             pytest.raises(ApiError):
            product_context.create_upload_url('proj-1', body)
        table.put_item.assert_not_called()
        s3.generate_presigned_url.assert_not_called()

    def test_the_per_project_cap_also_rejects_before_writing(self):
        import product_context

        full = [{'doc_id': f'd{i}', 'status': 'ready', 'created_at': '2026-01-01T00:00:00+00:00'}
                for i in range(product_context.MAX_DOCS_PER_PROJECT)]
        _, table = _reject({'filename': 'one-more.png', 'content_type': 'image/png',
                            'size_bytes': 100}, table=_table(full))
        table.put_item.assert_not_called()


# ── Stalled-extraction transition ────────────────────────────────────────────

def _iso_ago(seconds: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()


def _doc(**overrides) -> dict:
    item = {
        'pk': 'PROJECT#proj-1',
        'sk': 'PRODUCT_DOC#abc123',
        'doc_id': 'abc123',
        'filename': 'notes.txt',
        'content_type': 'text/plain',
        'size_bytes': 100,
        'status': 'pending',
        'error': None,
        'extracted_chars': 0,
        'created_at': _iso_ago(10),
    }
    item.update(overrides)
    return item


def _list(items: list[dict]):
    """Call list_docs over `items`. Returns (docs, table)."""
    import product_context

    table = _table(items)
    with patch.object(product_context, 'projects_table', table):
        result = product_context.list_docs('proj-1')
    return result['docs'], table


class TestStalledExtractionsAreFailedOnRead:
    """The client cannot do this: its polling has a 60s deadline and then clears
    the interval, so without a server-side transition a never-extracted record
    stays `pending` forever and the badge lies indefinitely."""

    def test_a_pending_record_past_the_window_reads_back_as_failed(self):
        import product_context

        docs, _ = _list([_doc(created_at=_iso_ago(product_context.EXTRACTION_STALL_SECONDS + 60))])
        assert docs[0]['status'] == 'failed'
        assert docs[0]['error']

    def test_the_transition_is_persisted_with_a_real_update_item(self):
        """A DTO-level substitution would report `failed` while the stored record
        still said `pending` — the same lie by another route."""
        import product_context

        _, table = _list([_doc(created_at=_iso_ago(product_context.EXTRACTION_STALL_SECONDS + 60))])
        table.update_item.assert_called_once()
        kwargs = table.update_item.call_args.kwargs
        assert kwargs['Key'] == {'pk': 'PROJECT#proj-1', 'sk': 'PRODUCT_DOC#abc123'}
        assert kwargs['ExpressionAttributeValues'][':failed'] == 'failed'
        assert kwargs['ExpressionAttributeNames'] == {'#status': 'status', '#error': 'error'}

    def test_the_write_is_conditional_on_the_status_it_read(self):
        """Without the condition, an extractor finishing during the read would get
        its `ready` clobbered by our guess."""
        import product_context

        _, table = _list([_doc(created_at=_iso_ago(product_context.EXTRACTION_STALL_SECONDS + 60))])
        kwargs = table.update_item.call_args.kwargs
        assert kwargs['ConditionExpression'] == '#status = :expected'
        assert kwargs['ExpressionAttributeValues'][':expected'] == 'pending'

    def test_an_extracting_record_past_the_window_also_transitions(self):
        import product_context

        docs, table = _list([_doc(status='extracting',
                                  created_at=_iso_ago(product_context.EXTRACTION_STALL_SECONDS + 60))])
        assert docs[0]['status'] == 'failed'
        assert table.update_item.call_args.kwargs['ExpressionAttributeValues'][':expected'] == 'extracting'

    def test_a_pending_record_inside_the_window_is_left_alone(self):
        import product_context

        docs, table = _list([_doc(created_at=_iso_ago(product_context.EXTRACTION_STALL_SECONDS - 60))])
        assert docs[0]['status'] == 'pending'
        table.update_item.assert_not_called()

    def test_a_ready_record_is_never_transitioned(self):
        docs, table = _list([_doc(status='ready', extracted_chars=42,
                                  created_at=_iso_ago(999_999))])
        assert docs[0]['status'] == 'ready'
        table.update_item.assert_not_called()

    def test_an_already_failed_record_is_not_rewritten(self):
        docs, table = _list([_doc(status='failed', error='something else',
                                  created_at=_iso_ago(999_999))])
        assert docs[0]['status'] == 'failed'
        assert docs[0]['error'] == 'something else'
        table.update_item.assert_not_called()

    def test_the_stall_window_exceeds_the_extractor_lambda_timeout(self):
        """300s vs the extractor's 120s. Raising the Lambda timeout past the stall
        window would mark healthy extractions as failed."""
        import product_context

        assert product_context.EXTRACTION_STALL_SECONDS >= 2 * 120

    def test_a_failed_transition_does_not_break_the_listing(self):
        """Includes the benign race (ConditionalCheckFailed): the listing still has
        to return, showing the stored value."""
        import product_context

        table = _table([_doc(created_at=_iso_ago(product_context.EXTRACTION_STALL_SECONDS + 60))])
        table.update_item.side_effect = RuntimeError('ConditionalCheckFailedException')
        with patch.object(product_context, 'projects_table', table):
            result = product_context.list_docs('proj-1')
        assert result['docs'][0]['status'] == 'pending'


class TestMalformedTimestampsFailSafe:
    """A timestamp we cannot read must leave the record alone. Marking a document
    failed because its `created_at` was unparseable would be a new lie in place of
    the one the transition removes."""

    @pytest.mark.parametrize('created_at', [
        None,
        '',
        'not-a-date',
        'yesterday',
        12345,
        '2026-13-45T99:99:99',
    ])
    def test_an_unreadable_created_at_is_not_transitioned(self, created_at):
        docs, table = _list([_doc(created_at=created_at)])
        assert docs[0]['status'] == 'pending'
        table.update_item.assert_not_called()

    def test_a_missing_created_at_key_is_not_transitioned(self):
        item = _doc()
        del item['created_at']
        docs, table = _list([item])
        assert docs[0]['status'] == 'pending'
        table.update_item.assert_not_called()

    def test_a_naive_iso_timestamp_is_read_as_utc_rather_than_ignored(self):
        """Legacy records could carry a tz-less string; treating it as UTC keeps
        them eligible for the transition instead of stranding them at pending."""
        import product_context

        naive = (datetime.now(timezone.utc)
                 - timedelta(seconds=product_context.EXTRACTION_STALL_SECONDS + 60)
                 ).replace(tzinfo=None).isoformat()
        docs, table = _list([_doc(created_at=naive)])
        assert docs[0]['status'] == 'failed'
        table.update_item.assert_called_once()


class TestAllowedContentTypes:
    """The map itself is the contract, so pin its contents."""

    def test_only_processable_types_are_accepted(self):
        import product_context

        assert product_context.ALLOWED_CONTENT_TYPES == {
            'image/png': 'png',
            'image/jpeg': 'jpg',
            'image/gif': 'gif',
            'image/webp': 'webp',
            'text/markdown': 'md',
            'text/plain': 'txt',
        }

    def test_pdf_and_docx_are_deferred_not_allowed(self):
        import product_context

        assert 'application/pdf' not in product_context.ALLOWED_CONTENT_TYPES
        assert DOCX_MIME not in product_context.ALLOWED_CONTENT_TYPES
        assert set(product_context.DEFERRED_CONTENT_TYPES) == {'application/pdf', DOCX_MIME}

    def test_deferred_and_allowed_never_overlap(self):
        """An overlap would make the deferred branch shadow an accepted type,
        refusing something we can process."""
        import product_context

        assert not (set(product_context.DEFERRED_CONTENT_TYPES)
                    & set(product_context.ALLOWED_CONTENT_TYPES))

    def test_the_image_half_is_single_sourced_from_shared(self):
        import product_context
        from shared.image_limits import IMAGE_CONTENT_TYPE_EXTENSIONS

        assert product_context.IMAGE_CONTENT_TYPES == set(IMAGE_CONTENT_TYPE_EXTENSIONS)
        for content_type, ext in IMAGE_CONTENT_TYPE_EXTENSIONS.items():
            assert product_context.ALLOWED_CONTENT_TYPES[content_type] == ext
