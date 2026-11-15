"""A GitHub repository's raster logo over 1 MB, handed off by the settings worker, is drawn smaller here (``logo_job``).

Fake CDP (the render tab is the fake's ``s2``), moto S3, a fake guarded fetch. Pins (7.00.02): the raw URL is
downloaded ONCE through the guarded fetch (at most 5 MB) and the browser draws a ``data:`` URL of those bytes
(it fetches nothing); the PNG is recorded as the rendered logo; a download that fails (a private repository),
is over 5 MB or is not a PNG/JPEG/WebP opens no browser and records the "upload a PNG under 1 MB" note, as does
a failed draw; a policy-refused URL is skipped before anything is fetched.
"""
import base64
from unittest.mock import MagicMock, patch

import logo_job
import pytest
from test_design_capture_worker import REF_ID, FakeCdp, _kit, _styles, table  # noqa: F401 - fixture
from test_inline_and_github_svg_logo import FETCHED, _github_row, _stored
from test_svg_logo_render import BOX, LOGO_PNG, PREVIEW_KEY, s3  # noqa: F401 - fixture

from shared import design_logo_render
from shared.design_logo import RASTER_SHRINK_MAX_BYTES
from shared.design_logo_render import RasterLogo, render_event

RAW_URL = 'https://raw.githubusercontent.com/acme/ui/HEAD/public/logo.png'
NOTE = 'Upload a PNG under 1 MB'


def _png_of(size: int) -> bytes:
    return b'\x89PNG\r\n\x1a\n' + b'\x00' * (size - 8)


MID = _png_of(1_500_000)


def _job(table, s3, cdp: FakeCdp, served: MagicMock | Exception, *, policy_ok: bool = True):  # noqa: F811
    sessions: list[int] = []
    cdp._targets = 1   # no page tab in this job: the render tab is the fake's ``s2``
    fetch = MagicMock(side_effect=served) if isinstance(served, Exception) else MagicMock(return_value=served)
    event = render_event(REF_ID, RasterLogo('logo.png', RAW_URL), FETCHED)
    with patch.object(design_logo_render, 'validate_url', return_value=(policy_ok, 'private address')):
        result = logo_job.run_logo_render(event, table, _kit(cdp, sessions), s3, 'raw', fetch)
    return result, sessions, fetch


def _served(body: bytes, status: int = 200) -> MagicMock:
    return MagicMock(status_code=status, content=body)


class TestTheRasterIsDrawnSmaller:
    def test_it_is_downloaded_once_drawn_from_its_bytes_and_recorded_as_the_rendered_logo(self, table, s3):  # noqa: F811
        _github_row(table)
        cdp = FakeCdp(_styles(), render_answer=BOX, logo_png=LOGO_PNG)
        result, sessions, fetch = _job(table, s3, cdp, _served(MID))
        assert result == {'status': 'rendered'}
        assert sessions == [logo_job.LOGO_SESSION_SECONDS]
        assert _stored(table)['extracted_design']['logo'] == {
            'source_url': RAW_URL, 'content_type': 'image/png', 'rendered': True, 'preview_key': PREVIEW_KEY}
        assert s3.get_object(Bucket='raw', Key=PREVIEW_KEY)['Body'].read() == LOGO_PNG
        fetch.assert_called_once()
        assert fetch.call_args.args[0] == RAW_URL
        assert fetch.call_args.kwargs['max_bytes'] == RASTER_SHRINK_MAX_BYTES + 1
        (_, draw), = [c for c in cdp.calls if c[0] == 'Runtime.callFunctionOn']
        url = draw['arguments'][0]['value']
        assert url.startswith('data:image/png;base64,')
        assert base64.b64decode(url.split(',', 1)[1]) == MID
        assert RAW_URL not in str(cdp.calls)                # the browser never gets the address


class TestARasterThatCannotBeDrawnLeavesTheNote:
    @pytest.mark.parametrize('served', [
        pytest.param(_served(b'404: Not Found', 404), id='private-repository'),
        pytest.param(_served(_png_of(RASTER_SHRINK_MAX_BYTES + 10)), id='over-5-MB'),
        pytest.param(_served(b'GIF89a' + b'\x00' * 1_500_000), id='not-png-jpeg-webp'),
    ])
    def test_a_download_that_fails_opens_no_browser_and_records_the_note(self, table, s3, served):  # noqa: F811
        _github_row(table)
        cdp = FakeCdp(_styles(), render_answer=BOX, logo_png=LOGO_PNG)
        result, sessions, fetch = _job(table, s3, cdp, served)
        assert (result, sessions, cdp.calls) == ({'status': 'not_rendered'}, [], [])
        fetch.assert_called_once()
        design = _stored(table)['extracted_design']
        assert 'logo' not in design
        assert design['guidelines_md'].startswith('## Voice\n\n## Logo')
        assert NOTE in design['guidelines_md']
        assert '`logo.png`' in design['guidelines_md']

    def test_a_failed_draw_records_the_note_and_stores_nothing(self, table, s3):  # noqa: F811
        _github_row(table)
        cdp = FakeCdp(_styles(), render_answer={'error': 'decode_failed'}, logo_png=LOGO_PNG)
        result, _, _ = _job(table, s3, cdp, _served(MID))
        assert result == {'status': 'not_rendered'}
        assert NOTE in _stored(table)['extracted_design']['guidelines_md']
        assert 'Contents' not in s3.list_objects_v2(Bucket='raw')

    def test_a_url_the_policy_refuses_is_skipped_before_anything_is_fetched(self, table, s3):  # noqa: F811
        _github_row(table)
        before = _stored(table)
        cdp = FakeCdp(_styles(), render_answer=BOX, logo_png=LOGO_PNG)
        result, sessions, fetch = _job(table, s3, cdp, _served(MID), policy_ok=False)
        assert (result, sessions) == ({'status': 'skipped'}, [])
        fetch.assert_not_called()
        assert _stored(table) == before
