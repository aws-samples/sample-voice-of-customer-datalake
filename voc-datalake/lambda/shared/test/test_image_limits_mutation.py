"""Mutation hardening for `shared/image_limits.py`.

The lockstep files pin the module's CONSTANTS against the TypeScript source and
against each other, and the upload-boundary tests pin the S3 extension map through
``product_context``. A mutation run found the one thing none of them touch:
``converse_image_format`` itself. No test in the module's suite called it, so the
type guard could be inverted (``if isinstance(media_type, str): return None``) and
every test still passed — the function would answer None for every real media type
and raise AttributeError for every non-string, and the persona-import allowlist
that reads it would refuse every image.

Everything the function promises is pinned here as a literal:

* the exact Converse ``format`` for each of the four readable types — including
  'jpeg' for JPEG, the value that is NOT the S3 extension;
* normalisation: surrounding whitespace and letter case do not change the answer;
* None, not an exception, for an unreadable type, for the empty string, for the
  bare subtype or extension, and for every non-string input;
* each entry of both maps as a literal, so the shared module's own tests kill the
  key and value mutants without borrowing the API package's suite.
"""
import pytest

from shared.image_limits import (
    CONVERSE_IMAGE_FORMATS,
    IMAGE_CONTENT_TYPE_EXTENSIONS,
    MAX_IMAGE_BYTES,
    converse_image_format,
)


class TestEveryReadableTypeNamesItsConverseFormat:
    @pytest.mark.parametrize(('media_type', 'fmt'), [
        ('image/png', 'png'),
        ('image/jpeg', 'jpeg'),
        ('image/gif', 'gif'),
        ('image/webp', 'webp'),
    ])
    def test_exact_format_per_media_type(self, media_type, fmt):
        assert converse_image_format(media_type) == fmt

    @pytest.mark.parametrize(('media_type', 'fmt'), [
        (' image/png ', 'png'),
        ('\timage/webp\n', 'webp'),
        ('IMAGE/JPEG', 'jpeg'),
        ('Image/Gif', 'gif'),
        ('  IMAGE/PNG  ', 'png'),
    ])
    def test_whitespace_and_case_are_normalised_before_lookup(self, media_type, fmt):
        assert converse_image_format(media_type) == fmt


class TestEveryUnreadableInputAnswersNoneWithoutRaising:
    @pytest.mark.parametrize('media_type', [
        'application/pdf',
        'image/svg+xml',
        'image/bmp',
        'image/jpg',   # the S3 extension dressed as a MIME type — not a Converse format
        'jpeg',        # bare format, not a media type
        'png',
        '',
        '   ',
        'image/',
        'image/png;charset=binary',
    ])
    def test_unreadable_string_is_none(self, media_type):
        assert converse_image_format(media_type) is None

    @pytest.mark.parametrize('media_type', [
        None,
        7,
        3.5,
        b'image/png',
        ['image/png'],
        {'image/png': 'png'},
        object(),
    ])
    def test_non_string_is_none_not_an_attribute_error(self, media_type):
        assert converse_image_format(media_type) is None


class TestBothMapsHoldExactlyTheseFourEntries:
    def test_storage_extensions_are_these_literals(self):
        assert IMAGE_CONTENT_TYPE_EXTENSIONS == {
            'image/png': 'png',
            'image/jpeg': 'jpg',
            'image/gif': 'gif',
            'image/webp': 'webp',
        }

    def test_converse_formats_are_these_literals(self):
        assert CONVERSE_IMAGE_FORMATS == {
            'image/png': 'png',
            'image/jpeg': 'jpeg',
            'image/gif': 'gif',
            'image/webp': 'webp',
        }

    def test_the_function_reads_the_converse_map_not_the_storage_map(self):
        """Every media type the function accepts yields the map's value, and the
        storage extension differs for exactly one of them."""
        for media_type, fmt in CONVERSE_IMAGE_FORMATS.items():
            assert converse_image_format(media_type) == fmt
        differing = [m for m in CONVERSE_IMAGE_FORMATS
                     if CONVERSE_IMAGE_FORMATS[m] != IMAGE_CONTENT_TYPE_EXTENSIONS[m]]
        assert differing == ['image/jpeg']


class TestImageByteCapIsExact:
    def test_cap_is_the_decimal_three_point_seven_five_mb(self):
        assert MAX_IMAGE_BYTES == 3_750_000
