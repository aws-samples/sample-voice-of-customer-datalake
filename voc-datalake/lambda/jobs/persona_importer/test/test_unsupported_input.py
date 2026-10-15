"""
Persona importer: an input it cannot read must be REFUSED, never fabricated.

The bug this file pins: for any `input_type` that was not `'image'`, the handler
substituted a placeholder sentence for the file and asked the model to extract a
persona from it. The model complied. A user who uploaded a PDF got a fully
detailed persona with no connection whatsoever to their document, and nothing
anywhere said so.

The API allowlist (lambda/api/test/test_persona_import_boundary.py) stops that at
the click. This layer is separate on purpose: a job row queued before that
allowlist shipped, a replayed async invoke, or any future caller still lands here.

EVERY refusal test also asserts Bedrock was NOT called. A test that only asserted
"it raises" could not tell a refusal from a model call that happened and then
failed — and the model call is both the cost and the fabrication.
"""
from pathlib import Path

import pytest
from shared.exceptions import ServiceError


def _job_event(sample_job_event, import_config: dict) -> dict:
    return {**sample_job_event, 'import_config': import_config}


def _job_error_messages(mock_jobs_table) -> list[str]:
    """Every error string written to the job record.

    This is the user-visible surface: shared/jobs.py::job_handler writes
    f'{error_message}: {str(e)[:200]}' into the record, and the Background Jobs
    panel renders it. Asserting on the raise alone would not show that the reason
    reaches the person who clicked Import.
    """
    return [
        call.kwargs['ExpressionAttributeValues'][':error']
        for call in mock_jobs_table.update_item.call_args_list
        if ':error' in call.kwargs.get('ExpressionAttributeValues', {})
    ]


class TestRefusesUnreadableInput:
    """`pdf` and friends raise, and cost nothing."""

    # `''` is deliberately NOT here: blank means "caller sent no type" and resolves
    # to the long-standing 'text' default, at this layer exactly as at the API.
    # See test_blank_type_defaults_to_text_here_too, which pins that agreement —
    # the two layers holding different opinions about a blank type is precisely the
    # drift shared/persona_import.py exists to prevent.
    @pytest.mark.parametrize('input_type', ['pdf', 'PDF', ' pdf ', 'docx', 'video', 'audio'])
    def test_unsupported_type_raises_without_calling_bedrock(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        sample_job_event, lambda_context, input_type
    ):
        from jobs.persona_importer.handler import lambda_handler

        event = _job_event(sample_job_event, {
            'input_type': input_type,
            'content': 'JVBERi0xLjQK',
            'media_type': 'application/pdf',
        })

        with pytest.raises(ServiceError):
            lambda_handler(event, lambda_context)

        # The point of the test. Fabrication IS the Bedrock call.
        mock_bedrock.converse.assert_not_called()
        # And nothing was written as a persona.
        mock_dynamodb['table'].put_item.assert_not_called()

    def test_refusal_reason_reaches_the_job_record_in_user_terms(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        sample_job_event, lambda_context
    ):
        """The message the user reads says the file could not be read.

        Not "invalid input_type", not a traceback: the person who clicked Import
        never chose an `input_type`, they chose a file.
        """
        from jobs.persona_importer.handler import lambda_handler

        event = _job_event(sample_job_event, {
            'input_type': 'pdf', 'content': 'JVBERi0xLjQK', 'media_type': 'application/pdf',
        })

        with pytest.raises(ServiceError):
            lambda_handler(event, lambda_context)

        errors = _job_error_messages(mock_jobs_table)
        assert errors, 'the failure must be recorded on the job, not only raised'
        reason = ' '.join(errors)
        # Names the format the user chose, says it is "not yet" rather than
        # "never", and points at what they can do instead. No input_type jargon
        # and no traceback: they picked a file, not a field value.
        assert 'PDF' in reason
        assert 'not supported yet' in reason
        assert 'pasted text or an image' in reason
        assert 'input_type' not in reason
        mock_bedrock.converse.assert_not_called()


class TestRefusesEmptyContent:
    """Blank content is the same fabrication by a second route."""

    @pytest.mark.parametrize('content', ['', '   ', '\n\t ', None])
    def test_blank_text_raises_without_calling_bedrock(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        sample_job_event, lambda_context, content
    ):
        """`input_type='text'` with nothing in it leaves the model inventing from
        an empty prompt — a persona out of thin air, which is exactly the failure
        mode the placeholder produced."""
        from jobs.persona_importer.handler import lambda_handler

        event = _job_event(sample_job_event, {
            'input_type': 'text', 'content': content, 'media_type': '',
        })

        with pytest.raises(ServiceError):
            lambda_handler(event, lambda_context)

        mock_bedrock.converse.assert_not_called()
        mock_dynamodb['table'].put_item.assert_not_called()

        reason = ' '.join(_job_error_messages(mock_jobs_table))
        assert 'nothing to read' in reason.lower()

    def test_blank_image_content_is_refused_too(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        sample_job_event, lambda_context
    ):
        """Zero bytes is not a readable image either, and b64decode('') would send
        an empty image block to Bedrock rather than say so."""
        from jobs.persona_importer.handler import lambda_handler

        event = _job_event(sample_job_event, {
            'input_type': 'image', 'content': '', 'media_type': 'image/png',
        })

        with pytest.raises(ServiceError):
            lambda_handler(event, lambda_context)

        mock_bedrock.converse.assert_not_called()


class TestRefusesUnreadableImageFormat:
    """`input_type='image'` does not license any media_type.

    The format in a Converse image block is derived from media_type, so a
    media_type this platform cannot read is a second way to reach the model with
    something it will not understand — including a PDF, by declaring it an image.
    """

    @pytest.mark.parametrize('media_type', [
        'application/pdf',     # the pdf refusal, routed around via input_type
        'image/svg+xml',       # a real image type Converse does not accept
        'image/tiff',
        'text/plain',
        '',                    # no format to derive; guessing it is a silent lie
        None,
    ])
    def test_unreadable_media_type_raises_without_calling_bedrock(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        sample_job_event, lambda_context, media_type
    ):
        from jobs.persona_importer.handler import lambda_handler

        event = _job_event(sample_job_event, {
            'input_type': 'image', 'content': 'aGVsbG8=', 'media_type': media_type,
        })

        with pytest.raises(ServiceError):
            lambda_handler(event, lambda_context)

        mock_bedrock.converse.assert_not_called()
        mock_dynamodb['table'].put_item.assert_not_called()

    @pytest.mark.parametrize('media_type', [
        'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'IMAGE/PNG', ' image/png ',
    ])
    def test_the_four_readable_formats_are_accepted(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock, mock_avatar_generation,
        sample_job_event, mock_bedrock_persona_response, lambda_context, media_type
    ):
        """POSITIVE CONTROL for the parametrised refusals above: without it,
        "rejects application/pdf" is indistinguishable from "rejects every image".
        """
        from jobs.persona_importer.handler import lambda_handler

        mock_bedrock.converse.return_value = mock_bedrock_persona_response
        event = _job_event(sample_job_event, {
            'input_type': 'image', 'content': 'aGVsbG8=', 'media_type': media_type,
        })

        result = lambda_handler(event, lambda_context)

        assert result['success'] is True
        mock_bedrock.converse.assert_called_once()

    def test_converse_gets_the_subtype_not_the_file_extension(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock, mock_avatar_generation,
        sample_job_event, mock_bedrock_persona_response, lambda_context
    ):
        """Converse wants `jpeg`; `jpg` is the S3 file extension and is NOT a valid
        Converse image format. The two live side by side in
        shared/image_limits.py, so reaching for the wrong one is a live mistake.
        """
        from jobs.persona_importer.handler import lambda_handler

        mock_bedrock.converse.return_value = mock_bedrock_persona_response
        event = _job_event(sample_job_event, {
            'input_type': 'image', 'content': 'aGVsbG8=', 'media_type': 'image/jpeg',
        })

        lambda_handler(event, lambda_context)

        blocks = mock_bedrock.converse.call_args.kwargs['messages'][0]['content']
        image_blocks = [b['image'] for b in blocks if 'image' in b]
        assert image_blocks, 'an image import must send an image block'
        assert image_blocks[0]['format'] == 'jpeg'


class TestSupportedInputStillReachesBedrock:
    """POSITIVE CONTROL for every `assert_not_called` above.

    Without this, a mis-wired `mock_bedrock` fixture (a patch target that stopped
    matching, say) would make all of those assertions pass while the handler
    happily fabricated in production.
    """

    def test_text_import_does_call_bedrock_and_writes_a_persona(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock, mock_avatar_generation,
        text_import_event, mock_bedrock_persona_response, lambda_context
    ):
        from jobs.persona_importer.handler import lambda_handler

        mock_bedrock.converse.return_value = mock_bedrock_persona_response

        result = lambda_handler(text_import_event, lambda_context)

        assert result['success'] is True
        mock_bedrock.converse.assert_called_once()
        mock_dynamodb['table'].put_item.assert_called_once()

    @pytest.mark.parametrize('import_config', [
        {'content': 'Name: Sarah Chen'},
        {'input_type': '', 'content': 'Name: Sarah Chen'},
        {'input_type': '   ', 'content': 'Name: Sarah Chen'},
        {'input_type': None, 'content': 'Name: Sarah Chen'},
    ])
    def test_blank_type_defaults_to_text_here_too(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock, mock_avatar_generation,
        sample_job_event, mock_bedrock_persona_response, lambda_context, import_config
    ):
        """Blank means "no type was sent", and resolves to text at BOTH layers.

        The API has defaulted a missing `input_type` to 'text' since long before
        this change, so a job refusing the same input would turn a request the
        boundary accepted into a background failure — the silent disagreement that
        two hand-synchronised allowlists produce.
        """
        from jobs.persona_importer.handler import lambda_handler

        mock_bedrock.converse.return_value = mock_bedrock_persona_response

        result = lambda_handler(_job_event(sample_job_event, import_config), lambda_context)

        assert result['success'] is True
        mock_bedrock.converse.assert_called_once()
        assert mock_dynamodb['table'].put_item.call_args.kwargs['Item']['imported_from'] == 'text'

    def test_a_padded_uppercase_type_is_normalised_rather_than_refused(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock, mock_avatar_generation,
        sample_job_event, mock_bedrock_persona_response, lambda_context
    ):
        """The allowlist normalises, so a legacy job row carrying `'Text'` is read
        rather than refused — the guard must not turn casing into data loss."""
        from jobs.persona_importer.handler import lambda_handler

        mock_bedrock.converse.return_value = mock_bedrock_persona_response
        event = _job_event(sample_job_event, {
            'input_type': ' Text ', 'content': 'Name: Sarah Chen', 'media_type': '',
        })

        result = lambda_handler(event, lambda_context)

        assert result['success'] is True
        mock_bedrock.converse.assert_called_once()
        assert mock_dynamodb['table'].put_item.call_args.kwargs['Item']['imported_from'] == 'text'


class TestPlaceholderIsGoneFromTheSource:
    """The fabricated prompt cannot come back by being retyped.

    A behavioural test cannot catch a placeholder reintroduced on a path no test
    reaches, and this one string is the whole defect, so it is pinned literally.
    """

    def test_placeholder_literal_appears_nowhere_in_the_handler(self):
        from jobs.persona_importer import handler

        source = Path(handler.__file__).read_text(encoding='utf-8')

        # POSITIVE CONTROL: proves the file was actually read and that a substring
        # search over it can succeed, so the assertion below cannot pass vacuously
        # on an empty string or a wrong path.
        assert 'validate_import_config' in source

        assert '[PDF content' not in source
