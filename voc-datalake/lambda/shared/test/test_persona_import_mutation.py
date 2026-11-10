"""Mutation hardening for `shared/persona_import.py`.

`lambda/api/test/test_persona_import_boundary.py` drives the module through
`POST /projects/{id}/personas/import` and pins WHICH branch each request lands
in (a substring of the message, no job row, no Lambda invoke). A mutation run
found what that cannot see:

* the WORDING of every refusal. `projects_handler` returns `exc.message` as the
  400 body, so each sentence is what the user reads in the import modal; the
  boundary tests pass with any padding around them. Every message is pinned here
  as the full literal, including the derived "Accepted:" list — its separator,
  its sorted order and its trailing full stop.
* the return value of `normalise_input_type` for a non-string body value. The
  docstring promises `''`; the boundary only sees that the request is refused
  as unsupported, which any string outside the allowlists would also produce.
"""
import pytest

from shared.exceptions import ValidationError
from shared.persona_import import (
    DEFAULT_INPUT_TYPE,
    DEFERRED_INPUT_TYPES,
    SUPPORTED_INPUT_TYPES,
    deferred_type_message,
    normalise_input_type,
    validate_import_config,
)

ACCEPTS = 'Persona import accepts pasted text or an image.'
UNSUPPORTED_TYPE = f'Unsupported import type. {ACCEPTS}'
PDF_DEFERRED = f'PDF import is not supported yet. {ACCEPTS}'
EMPTY_CONTENT = (
    'There was nothing to read. Paste the persona description, or upload an '
    'image, and try again.'
)
UNREADABLE_IMAGE = (
    'That image could not be read. Accepted: image/gif, image/jpeg, image/png, image/webp.'
)


def _refusal(raw_input_type: object, content: object, media_type: object = None) -> str:
    with pytest.raises(ValidationError) as excinfo:
        validate_import_config(raw_input_type, content, media_type)
    assert excinfo.value.status_code == 400
    return excinfo.value.message


class TestEveryRefusalIsTheExactSentenceTheUserReads:
    @pytest.mark.parametrize(('raw_input_type', 'content', 'media_type', 'message'), [
        ('pdf', 'JVBERi0xLjQ=', 'application/pdf', PDF_DEFERRED),
        (' PDF ', '', None, PDF_DEFERRED),
        ('spreadsheet', 'x', None, UNSUPPORTED_TYPE),
        (123, 'x', None, UNSUPPORTED_TYPE),
        (['pdf'], 'x', None, UNSUPPORTED_TYPE),
        ('text', '', None, EMPTY_CONTENT),
        ('text', ' \n\t ', None, EMPTY_CONTENT),
        ('text', None, None, EMPTY_CONTENT),
        ('text', 12345, None, EMPTY_CONTENT),
        ('image', '', 'image/png', EMPTY_CONTENT),
        ('image', 'aGVsbG8=', 'application/pdf', UNREADABLE_IMAGE),
        ('image', 'aGVsbG8=', 'image/svg+xml', UNREADABLE_IMAGE),
        ('image', 'aGVsbG8=', '', UNREADABLE_IMAGE),
        ('image', 'aGVsbG8=', None, UNREADABLE_IMAGE),
    ])
    def test_message_is_the_full_literal(self, raw_input_type, content, media_type, message):
        assert _refusal(raw_input_type, content, media_type) == message

    def test_the_deferred_message_names_the_type_by_its_label(self):
        assert DEFERRED_INPUT_TYPES == {'pdf': 'PDF'}
        assert deferred_type_message('pdf') == PDF_DEFERRED

    def test_the_two_type_refusals_share_one_accepts_sentence(self):
        """Both end in the same sentence, so neither can drift to a dead end alone."""
        pdf = _refusal('pdf', 'x')
        other = _refusal('docx', 'x')
        assert pdf.endswith(ACCEPTS)
        assert other.endswith(ACCEPTS)
        assert pdf[:-len(ACCEPTS)] == 'PDF import is not supported yet. '
        assert other[:-len(ACCEPTS)] == 'Unsupported import type. '


class TestNormaliseInputType:
    def test_none_is_the_text_default(self):
        assert DEFAULT_INPUT_TYPE == 'text'
        assert normalise_input_type(None) == 'text'

    @pytest.mark.parametrize('raw', ['', '   ', '\t\n'])
    def test_blank_string_is_the_text_default(self, raw):
        assert normalise_input_type(raw) == 'text'

    @pytest.mark.parametrize(('raw', 'expected'), [
        ('TEXT', 'text'),
        (' Image ', 'image'),
        ('Pdf', 'pdf'),
        ('  SpreadSheet\n', 'spreadsheet'),
    ])
    def test_string_is_trimmed_and_lowercased(self, raw, expected):
        assert normalise_input_type(raw) == expected

    @pytest.mark.parametrize('raw', [123, 1.5, True, ['pdf'], {'type': 'pdf'}, b'text', object()])
    def test_non_string_is_the_empty_string_not_a_coercion(self, raw):
        assert normalise_input_type(raw) == ''


class TestAcceptedInputReturnsItsNormalisedType:
    def test_the_allowlist_is_exactly_text_and_image(self):
        assert SUPPORTED_INPUT_TYPES == ('text', 'image')

    @pytest.mark.parametrize(('raw_input_type', 'content', 'media_type', 'expected'), [
        (None, 'pasted persona notes', None, 'text'),
        ('', 'pasted persona notes', None, 'text'),
        ('text', 'pasted persona notes', None, 'text'),
        (' TEXT ', 'pasted persona notes', 'application/pdf', 'text'),
        ('image', 'aGVsbG8=', 'image/png', 'image'),
        ('image', 'aGVsbG8=', 'image/jpeg', 'image'),
        ('image', 'aGVsbG8=', 'image/gif', 'image'),
        ('image', 'aGVsbG8=', 'image/webp', 'image'),
        (' Image ', 'aGVsbG8=', ' IMAGE/PNG ', 'image'),
    ])
    def test_returns_the_normalised_type(self, raw_input_type, content, media_type, expected):
        assert validate_import_config(raw_input_type, content, media_type) == expected
