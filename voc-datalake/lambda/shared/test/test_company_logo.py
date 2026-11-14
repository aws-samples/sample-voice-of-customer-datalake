"""shared.company_logo: the uploaded company logo as a prototype's data: URL, and its placeholder."""
import base64
import io
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

from shared import company_logo
from shared.company_logo import (
    BLANK_IMAGE,
    LOGO_MARKER,
    LOGO_PLACEHOLDER,
    MAX_INLINE_LOGO_BYTES,
    MAX_LOGO_USES,
    company_logo_data_url,
    has_logo_placeholder,
    inline_logo,
    logo_keys,
    with_logo_placeholder,
)

PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 32
CURRENT = 'company-context/design/logo_aaaaaaaaaaaa.png'
PENDING = 'company-context/design/logo_bbbbbbbbbbbb.webp'
BUCKET = 'raw-bucket'


def _client(objects: dict[str, bytes]) -> MagicMock:
    """An S3 stand-in answering get_object from ``objects`` (NoSuchKey otherwise), honouring Range."""
    s3 = MagicMock()

    def get_object(Key, Range=None, **_kwargs):
        if Key not in objects:
            raise ClientError({'Error': {'Code': 'NoSuchKey'}}, 'GetObject')
        data = objects[Key]
        if Range:
            end = int(Range.split('-')[1])
            data = data[:end + 1]
        return {'Body': io.BytesIO(data)}

    s3.get_object.side_effect = get_object
    return s3


def _row(**attrs) -> dict:
    return {'pk': 'SETTINGS#design_system', 'sk': 'config', **attrs}


class TestLogoKeys:
    def test_pending_first_then_current(self):
        assert logo_keys(_row(logo_s3_key=CURRENT, logo_pending_s3_key=PENDING)) == [PENDING, CURRENT]

    @pytest.mark.parametrize('row', [None, {}, _row(logo_s3_key='company-context/design/ref_x.png'),
                                     _row(logo_s3_key=7), _row(logo_s3_key='prototypes/logo_x.png'),
                                     # A design reference's logo preview is not the company logo.
                                     _row(logo_s3_key='company-context/design/logo_preview_ref_0123456789ab.png'),
                                     _row(logo_s3_key='company-context/design/logo_aaaaaaaaaaaa.svg')])
    def test_no_key_outside_the_logo_prefix(self, row):
        assert logo_keys(row) == []

    def test_the_same_key_twice_is_tried_once(self):
        assert logo_keys(_row(logo_s3_key=CURRENT, logo_pending_s3_key=CURRENT)) == [CURRENT]


class TestCompanyLogoDataUrl:
    def test_the_current_logo_as_a_png_data_url(self):
        url = company_logo_data_url(_row(logo_s3_key=CURRENT), _client({CURRENT: PNG}), BUCKET)
        assert url == f'data:image/png;{LOGO_MARKER};base64,{base64.b64encode(PNG).decode()}'

    def test_a_landed_pending_upload_wins(self):
        webp = b'RIFF\x00\x00\x00\x00WEBPVP8 ' + b'\x00' * 8
        url = company_logo_data_url(_row(logo_s3_key=CURRENT, logo_pending_s3_key=PENDING),
                                    _client({CURRENT: PNG, PENDING: webp}), BUCKET)
        assert url is not None
        assert url.startswith(f'data:image/webp;{LOGO_MARKER};base64,')

    def test_a_pending_upload_that_never_landed_falls_back_to_the_current_logo(self):
        url = company_logo_data_url(_row(logo_s3_key=CURRENT, logo_pending_s3_key=PENDING),
                                    _client({CURRENT: PNG}), BUCKET)
        assert url is not None
        assert url.startswith(f'data:image/png;{LOGO_MARKER};base64,')

    def test_the_type_comes_from_the_bytes_not_the_extension(self):
        jpeg = b'\xff\xd8\xff\xe0' + b'\x00' * 16
        url = company_logo_data_url(_row(logo_s3_key=CURRENT), _client({CURRENT: jpeg}), BUCKET)
        assert url is not None
        assert url.startswith(f'data:image/jpeg;{LOGO_MARKER};base64,')

    def test_bytes_that_are_no_raster_image_are_refused(self):
        svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        assert company_logo_data_url(_row(logo_s3_key=CURRENT), _client({CURRENT: svg}), BUCKET) is None

    def test_a_logo_over_the_inline_cap_is_left_out(self):
        big = PNG + b'\x00' * MAX_INLINE_LOGO_BYTES
        assert company_logo_data_url(_row(logo_s3_key=CURRENT), _client({CURRENT: big}), BUCKET) is None

    def test_a_logo_exactly_at_the_cap_is_inlined(self):
        exact = PNG + b'\x00' * (MAX_INLINE_LOGO_BYTES - len(PNG))
        assert company_logo_data_url(_row(logo_s3_key=CURRENT), _client({CURRENT: exact}), BUCKET) is not None

    def test_the_read_is_bounded_by_a_range(self):
        s3 = _client({CURRENT: PNG})
        company_logo_data_url(_row(logo_s3_key=CURRENT), s3, BUCKET)
        assert s3.get_object.call_args.kwargs['Range'] == f'bytes=0-{MAX_INLINE_LOGO_BYTES}'

    @pytest.mark.parametrize('row', [None, _row()])
    def test_no_logo_configured_reads_nothing(self, row):
        s3 = _client({})
        assert company_logo_data_url(row, s3, BUCKET) is None
        s3.get_object.assert_not_called()

    def test_no_bucket_configured_reads_nothing(self):
        s3 = _client({CURRENT: PNG})
        assert company_logo_data_url(_row(logo_s3_key=CURRENT), s3, '') is None
        s3.get_object.assert_not_called()

    @pytest.mark.parametrize('error', [
        ClientError({'Error': {'Code': 'AccessDenied'}}, 'GetObject'),
        EndpointConnectionError(endpoint_url='https://s3'),
    ])
    def test_a_failed_read_is_no_logo_and_is_logged(self, error, monkeypatch):
        warnings = MagicMock()
        monkeypatch.setattr(company_logo.logger, 'warning', warnings)
        s3 = MagicMock()
        s3.get_object.side_effect = error
        assert company_logo_data_url(_row(logo_s3_key=CURRENT), s3, BUCKET) is None
        warnings.assert_called_once()


class TestPlaceholder:
    LOGO = f'data:image/png;{LOGO_MARKER};base64,{base64.b64encode(b"x" * 3000).decode()}'

    def test_inline_replaces_every_placeholder(self):
        html = f'<img src="{LOGO_PLACEHOLDER}"><footer><img src="{LOGO_PLACEHOLDER}"></footer>'
        assert inline_logo(html, 'data:image/png;base64,AAAA', 'Example Air') == (
            '<img src="data:image/png;base64,AAAA"><footer><img src="data:image/png;base64,AAAA"></footer>')

    def test_without_a_logo_a_placeholder_img_becomes_the_wordmark_as_text(self):
        html = f'<header><IMG class="logo" src="{LOGO_PLACEHOLDER}" alt="Company logo"></header>'
        assert inline_logo(html, None, 'Example <Air>') == (
            '<header><span class="company-wordmark" style="font-weight:700">Example &lt;Air&gt;</span></header>')

    def test_without_a_logo_a_placeholder_outside_an_img_becomes_a_blank_image(self):
        assert inline_logo(f'.hero{{background:url({LOGO_PLACEHOLDER})}}', None, 'Example Air') == (
            f'.hero{{background:url({BLANK_IMAGE})}}')

    # Review (PR #556): the "at most two places" rule is the model's; the cap is ours.
    def test_only_the_first_two_placeholders_get_the_image_and_the_rest_the_wordmark(self):
        html = ''.join(f'<img src="{LOGO_PLACEHOLDER}">' for _ in range(5))
        out = inline_logo(html, 'data:image/png;base64,AAAA', 'Example Air')
        assert out.count('data:image/png;base64,AAAA') == MAX_LOGO_USES == 2
        assert out.count('class="company-wordmark"') == 3
        assert LOGO_PLACEHOLDER not in out

    def test_html_without_a_placeholder_is_unchanged(self):
        assert inline_logo('<h1>Demo</h1>', 'data:image/png;base64,AAAA', 'Example Air') == '<h1>Demo</h1>'

    def test_the_marked_logo_goes_back_to_the_placeholder(self):
        html = inline_logo(f'<header><img src="{LOGO_PLACEHOLDER}" alt="Company logo"></header>', self.LOGO, 'x')
        assert with_logo_placeholder(html) == f'<header><img src="{LOGO_PLACEHOLDER}" alt="Company logo"></header>'

    # Regression (commit review): every large inline image used to be taken for the logo.
    def test_another_large_inline_image_is_never_taken_for_the_logo(self):
        photo = f'data:image/png;base64,{base64.b64encode(b"y" * 3000).decode()}'
        assert with_logo_placeholder(f'<img src="{photo}" alt="Hero">') == f'<img src="{photo}" alt="Hero">'

    def test_has_logo_placeholder(self):
        assert has_logo_placeholder(f'<img src="{LOGO_PLACEHOLDER}">') is True
        assert has_logo_placeholder('<img src="data:image/png;base64,AAAA">') is False
