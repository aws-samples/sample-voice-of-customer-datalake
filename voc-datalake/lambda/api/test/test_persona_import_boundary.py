"""
POST /projects/{id}/personas/import — what the boundary accepts, and what a
refusal must NOT leave behind.

WHY THIS FILE EXISTS: persona import used to accept `input_type='pdf'`. Nothing
in this repo extracts text from a PDF, so the file was never read — the job
handed the model a placeholder sentence and the model invented a persona from it.
The type is now refused HERE, before `create_job`, which is a stronger claim than
"the request 400s": a rejection that still wrote a job row and still invoked the
importer Lambda would show the user a failing background job and spend Bedrock
tokens per attempt. Every refusal test below therefore asserts the absence of
BOTH side effects, not just the status code.

The counterpart is lambda/jobs/persona_importer/test/test_unsupported_input.py,
which holds the same line inside the job for a replayed or pre-existing message.
"""
import json
from unittest.mock import patch

import pytest


def _import_event(api_gateway_event, body: dict | None):
    return api_gateway_event(
        method='POST',
        path='/projects/proj-1/personas/import',
        path_params={'project_id': 'proj-1'},
        body=body,
    )


def _post_import(api_gateway_event, lambda_context, body: dict | None):
    """Drive the route and return (status_code, parsed_body, create_job, invoke).

    Both side effects are patched so a test can assert they did NOT happen. They
    are also what makes the accepted-type tests meaningful without a real table.
    """
    from projects_handler import lambda_handler

    with patch('projects_handler.create_job') as create_job, \
         patch('projects_handler.invoke_lambda_async') as invoke:
        create_job.return_value = ('job_test123', '2026-01-01T00:00:00+00:00')
        response = lambda_handler(_import_event(api_gateway_event, body), lambda_context)

    return response['statusCode'], json.loads(response['body']), create_job, invoke


class TestDeferredPdfImport:
    """`pdf` is refused, and refused before anything is spent on it."""

    def test_pdf_is_refused_with_no_job_and_no_lambda_invoke(
        self, api_gateway_event, lambda_context
    ):
        status, body, create_job, invoke = _post_import(
            api_gateway_event, lambda_context,
            {'input_type': 'pdf', 'content': 'JVBERi0xLjQ=', 'media_type': 'application/pdf'},
        )

        assert status == 400
        assert body['success'] is False
        # The two that matter: asserting only the 4xx above would pass while a job
        # leaked into the table and the importer Lambda ran anyway.
        create_job.assert_not_called()
        invoke.assert_not_called()

    @pytest.mark.parametrize('raw', ['PDF', ' pdf ', 'Pdf'])
    def test_pdf_is_refused_however_it_is_cased_or_padded(
        self, api_gateway_event, lambda_context, raw
    ):
        """Normalisation is part of the guard, not a nicety.

        Without strip/lower, `'PDF'` would miss the deferred branch and be answered
        with the generic "unsupported" message — the user would be told PDF will
        never be supported, which is not what this codebase means.
        """
        status, body, create_job, invoke = _post_import(
            api_gateway_event, lambda_context, {'input_type': raw, 'content': 'x'},
        )

        assert status == 400
        assert 'not supported yet' in body['error']
        create_job.assert_not_called()
        invoke.assert_not_called()

    def test_pdf_message_is_distinguishable_from_the_unsupported_message(
        self, api_gateway_event, lambda_context
    ):
        """"Not yet" and "never" have to read as different answers.

        A caller (and a user) needs to be able to tell a type this platform intends
        to support from one it does not recognise at all — the same distinction
        product_context.DEFERRED_CONTENT_TYPES draws for uploaded product docs. If
        the two messages were one string, the PDF path would be indistinguishable
        from a typo'd input type.
        """
        _, pdf_body, _, _ = _post_import(
            api_gateway_event, lambda_context, {'input_type': 'pdf', 'content': 'x'},
        )
        _, other_body, _, _ = _post_import(
            api_gateway_event, lambda_context, {'input_type': 'spreadsheet', 'content': 'x'},
        )

        pdf_error = pdf_body['error']
        other_error = other_body['error']

        assert 'not supported yet' in pdf_error
        assert 'PDF' in pdf_error
        assert 'Unsupported import type' in other_error
        assert pdf_error != other_error
        # Both name what IS accepted, so neither is a dead end.
        for error in (pdf_error, other_error):
            assert 'text' in error
            assert 'image' in error


class TestUnsupportedImportTypes:
    """Anything that is neither supported nor deferred is refused the same way."""

    @pytest.mark.parametrize('raw', ['spreadsheet', 'docx', 'video', 'audio'])
    def test_unknown_type_is_refused_with_no_side_effects(
        self, api_gateway_event, lambda_context, raw
    ):
        status, body, create_job, invoke = _post_import(
            api_gateway_event, lambda_context, {'input_type': raw, 'content': 'x'},
        )

        assert status == 400
        assert 'Unsupported import type' in body['error']
        create_job.assert_not_called()
        invoke.assert_not_called()

    @pytest.mark.parametrize('raw', [123, True, ['pdf'], {'type': 'pdf'}, 1.5])
    def test_non_string_type_is_refused_rather_than_coerced(
        self, api_gateway_event, lambda_context, raw
    ):
        """A non-string is a bad request, and must answer as one — not as a 500.

        `raw in DEFERRED_IMPORT_TYPES` on an unhashable body value (a list, an
        object) raises TypeError, which would surface as a 500 for a plainly
        malformed request. `str(123)` would be just as wrong the other way: the
        caller never asked for a type called "123".
        """
        status, body, create_job, invoke = _post_import(
            api_gateway_event, lambda_context, {'input_type': raw, 'content': 'x'},
        )

        assert status == 400
        assert 'Unsupported import type' in body['error']
        create_job.assert_not_called()
        invoke.assert_not_called()


class TestSupportedImportTypesStillWork:
    """The control half: without these, "refuses pdf" and "refuses everything"
    look identical."""

    @pytest.mark.parametrize('raw', ['text', 'image'])
    def test_supported_type_creates_a_job_and_invokes_the_importer(
        self, api_gateway_event, lambda_context, raw
    ):
        status, body, create_job, invoke = _post_import(
            api_gateway_event, lambda_context,
            {'input_type': raw, 'content': 'some content', 'media_type': 'image/png'},
        )

        assert status == 200
        assert body['success'] is True
        assert body['job_id'] == 'job_test123'
        create_job.assert_called_once()
        invoke.assert_called_once()
        # The normalised type is what gets stored and what the job will read.
        assert create_job.call_args[0][3]['input_type'] == raw

    @pytest.mark.parametrize('raw', ['TEXT', ' Image '])
    def test_supported_type_is_normalised_before_it_is_stored(
        self, api_gateway_event, lambda_context, raw
    ):
        """Case and padding are accepted and canonicalised, not refused.

        The job compares `input_type` to exact lowercase names, so storing `'TEXT'`
        verbatim would have reached the very fabrication branch this change
        removes.
        """
        status, _, create_job, _ = _post_import(
            api_gateway_event, lambda_context,
            {'input_type': raw, 'content': 'x', 'media_type': 'image/png'},
        )

        assert status == 200
        assert create_job.call_args[0][3]['input_type'] == raw.strip().lower()

    @pytest.mark.parametrize('body', [
        {'content': 'pasted persona notes'},
        {'input_type': None, 'content': 'pasted persona notes'},
        {'input_type': '', 'content': 'pasted persona notes'},
        {'input_type': '   ', 'content': 'pasted persona notes'},
    ])
    def test_missing_or_blank_type_keeps_the_text_default(
        self, api_gateway_event, lambda_context, body
    ):
        """The pre-existing default. An allowlist that broke it would break callers
        that never sent the field."""
        status, response_body, create_job, invoke = _post_import(
            api_gateway_event, lambda_context, body,
        )

        assert status == 200
        assert response_body['success'] is True
        assert create_job.call_args[0][3]['input_type'] == 'text'
        invoke.assert_called_once()


class TestEmptyContentIsRefusedAtTheBoundary:
    """An import with nothing in it must not buy a job row either.

    This was the gap the first cut of this change left: `input_type` was allowlisted
    before `create_job`, but `content` was forwarded unchecked, so a blank upload
    still wrote a job, invoked the importer and failed inside it — the exact cost
    the boundary exists to avoid, and the exact argument used against rejecting
    `pdf` in the job alone.
    """

    @pytest.mark.parametrize('body', [
        {'input_type': 'text', 'content': ''},
        {'input_type': 'text', 'content': '   \n\t '},
        {'input_type': 'text'},
        {'input_type': 'image', 'content': '', 'media_type': 'image/png'},
        {'input_type': 'text', 'content': None},
        {'input_type': 'text', 'content': 12345},
    ])
    def test_blank_content_is_refused_with_no_job_and_no_lambda_invoke(
        self, api_gateway_event, lambda_context, body
    ):
        status, response_body, create_job, invoke = _post_import(
            api_gateway_event, lambda_context, body,
        )

        assert status == 400
        assert 'nothing to read' in response_body['error'].lower()
        create_job.assert_not_called()
        invoke.assert_not_called()

    def test_a_pdf_with_blank_content_is_still_told_it_is_a_pdf(
        self, api_gateway_event, lambda_context
    ):
        """Check order is part of the contract: type before content.

        Otherwise someone who picks a PDF and gets an empty read is told their file
        was empty, which sends them off to fix the wrong thing.
        """
        _, body, create_job, invoke = _post_import(
            api_gateway_event, lambda_context, {'input_type': 'pdf', 'content': ''},
        )

        assert 'not supported yet' in body['error']
        create_job.assert_not_called()
        invoke.assert_not_called()


class TestImageMediaTypeIsAllowlisted:
    """`input_type='image'` is not a licence to send any media_type.

    The job derives the Converse image `format` from media_type, so
    `input_type='image'` with `media_type='application/pdf'` was a way to route a
    PDF straight past the pdf refusal and into the model.
    """

    @pytest.mark.parametrize('media_type', [
        'application/pdf', 'image/svg+xml', 'image/tiff', 'text/plain', '', None, 42,
    ])
    def test_unreadable_media_type_is_refused_before_create_job(
        self, api_gateway_event, lambda_context, media_type
    ):
        status, body, create_job, invoke = _post_import(
            api_gateway_event, lambda_context,
            {'input_type': 'image', 'content': 'aGVsbG8=', 'media_type': media_type},
        )

        assert status == 400
        assert 'could not be read' in body['error']
        create_job.assert_not_called()
        invoke.assert_not_called()

    @pytest.mark.parametrize('media_type', [
        'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'IMAGE/PNG', ' image/png ',
    ])
    def test_the_four_readable_formats_are_accepted(
        self, api_gateway_event, lambda_context, media_type
    ):
        """POSITIVE CONTROL: without it, "refuses application/pdf" and "refuses
        every image" are the same passing test."""
        status, _, create_job, invoke = _post_import(
            api_gateway_event, lambda_context,
            {'input_type': 'image', 'content': 'aGVsbG8=', 'media_type': media_type},
        )

        assert status == 200
        create_job.assert_called_once()
        invoke.assert_called_once()

    def test_a_text_import_is_not_asked_for_a_media_type(
        self, api_gateway_event, lambda_context
    ):
        """The image guard must stay scoped to images.

        Pasted text has no media type and never did; requiring one here would break
        the default path for every caller.
        """
        status, _, create_job, invoke = _post_import(
            api_gateway_event, lambda_context,
            {'input_type': 'text', 'content': 'pasted persona notes'},
        )

        assert status == 200
        create_job.assert_called_once()
        invoke.assert_called_once()


class TestBothLayersShareOneContract:
    """The API and the job must not be able to disagree about what is readable.

    They used to hold two independently maintained tuples, kept in step by a
    comment. The drift that matters is silent: the API accepting something the job
    refuses turns a clear 400 into a background job that fails later.
    """

    def test_the_api_validates_with_the_same_callable_the_job_uses(self):
        import projects_handler
        from jobs.persona_importer import handler as job_handler
        from shared import persona_import

        assert projects_handler.validate_import_config is persona_import.validate_import_config
        assert job_handler.validate_import_config is persona_import.validate_import_config
