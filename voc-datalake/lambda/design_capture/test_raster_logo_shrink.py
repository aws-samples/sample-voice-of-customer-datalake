"""A website's RASTER logo over 2 MB is drawn smaller by the managed browser instead of being refused (``raster_logo``).

Fake CDP (``test_design_capture_worker.FakeCdp``: the page tab is ``s1``, the render tab ``s2``), moto S3.
Pins: only a refusal for SIZE is rendered, the URL policy is checked before the browser gets the URL (a CDP
argument), the PNG is stored and recorded like a rendered SVG, a failed render leaves no preview and a ready
capture, and a logo under 2 MB is downloaded once, as before, with no render tab.
"""
from unittest.mock import MagicMock, patch

import capture_worker as cw
import page_styles as ps
import pytest
import raster_logo
from test_design_capture_worker import ANSWER, REF_ID, FakeCdp, _kit, _styles, table  # noqa: F401 - fixture
from test_svg_logo_render import BOX, LOGO_PNG, png_bytes, s3  # noqa: F401 - fixture

from shared.company_context import get_reference
from shared.http_utils import UnsafeURLError

LOGO = 'https://www.example.com/brand/logo.png'
PREVIEW_KEY = f'company-context/design/logo_preview_{REF_ID}.png'
SMALL_PNG = png_bytes(32, 32)
HUGE_PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 2_000_100


def _site(logo: MagicMock | Exception):
    """The fetch fake: ``logo`` answers the logo URL, a small PNG answers anything else (the favicon copy)."""
    def served(url: str, **_kwargs) -> MagicMock:
        if url != LOGO:
            return MagicMock(status_code=200, content=SMALL_PNG)
        if isinstance(logo, Exception):
            raise logo
        return logo
    return MagicMock(side_effect=served)


def _capture(table, s3, cdp: FakeCdp, logo: MagicMock | Exception, *, policy_ok: bool = True):  # noqa: F811 - fixture parameter
    fetch = _site(logo)
    deps = cw.CaptureDeps(table=table, kit=_kit(cdp, []), summarise_images=MagicMock(return_value=ANSWER),
                          sleep=lambda _s: None, clock=iter(range(1000)).__next__, now=lambda: '2026-11-13T00:00:00+00:00',
                          s3=s3, bucket='raw', logo_fetch=fetch)
    with patch.object(cw, 'validate_url', return_value=(True, '')), \
            patch.object(ps, 'validate_url', return_value=(True, '')), \
            patch.object(raster_logo, 'validate_url', return_value=(policy_ok, 'private address')):
        result = cw.run_capture({'action': 'design_capture', 'ref_id': REF_ID}, deps)
    stored = get_reference(table, REF_ID)
    assert stored is not None
    return result, stored, fetch


def _page() -> str:
    return _styles(logos=[{'url': LOGO, 'kind': 'header'}])


def _logo_downloads(fetch: MagicMock) -> list[str]:
    return [c.args[0] for c in fetch.call_args_list if c.args[0] == LOGO]


def _draws(cdp: FakeCdp) -> list[dict]:
    return [params for method, params in cdp.calls if method == 'Runtime.callFunctionOn']


class TestAnOversizedRasterIsShrunk:
    def test_it_is_drawn_in_a_fresh_tab_and_stored_as_the_rendered_preview(self, table, s3):  # noqa: F811
        cdp = FakeCdp(_page(), render_answer=BOX, logo_png=LOGO_PNG)
        result, stored, fetch = _capture(table, s3, cdp, MagicMock(status_code=200, content=HUGE_PNG))
        assert result == {'status': 'ready'}
        assert stored['extracted_design']['logo'] == {'source_url': LOGO, 'content_type': 'image/png',
                                                      'rendered': True, 'preview_key': PREVIEW_KEY}
        assert s3.get_object(Bucket='raw', Key=PREVIEW_KEY)['Body'].read() == LOGO_PNG
        draw, = _draws(cdp)
        assert draw['arguments'][0] == {'value': LOGO}            # a CDP argument,
        assert LOGO not in draw['functionDeclaration']             # never part of the code
        assert _logo_downloads(fetch) == [LOGO]                    # one download; the rendered PNG is not re-fetched

    def test_a_failed_render_leaves_no_preview_and_the_capture_ready(self, table, s3):  # noqa: F811 - fixtures
        cdp = FakeCdp(_page(), render_answer={'error': 'decode_failed'}, logo_png=LOGO_PNG)
        with patch.object(raster_logo, 'logger'), patch('logo_render.logger') as log:
            result, stored, _ = _capture(table, s3, cdp, MagicMock(status_code=200, content=HUGE_PNG))
        assert result == {'status': 'ready'}
        assert stored['extracted_design']['logo'] == {'source_url': LOGO, 'content_type': 'image/png'}
        assert 'Contents' not in s3.list_objects_v2(Bucket='raw', Prefix=PREVIEW_KEY)
        reasons = [c.kwargs['extra'] for c in log.info.call_args_list if c.args[0] == 'Oversized logo not rendered']
        assert reasons == [{'reason': 'decode_failed'}]
        assert LOGO not in str(log.mock_calls)
        assert cdp.calls[-1][0] == 'Target.closeTarget'

    def test_a_url_the_policy_refuses_is_never_handed_to_the_browser(self, table, s3):  # noqa: F811
        cdp = FakeCdp(_page(), render_answer=BOX, logo_png=LOGO_PNG)
        with patch.object(raster_logo, 'logger') as log:
            result, stored, _ = _capture(table, s3, cdp, MagicMock(status_code=200, content=HUGE_PNG), policy_ok=False)
        assert result == {'status': 'ready'}
        assert cdp.methods().count('Target.createTarget') == 1     # the page tab only
        assert 'rendered' not in stored['extracted_design']['logo']
        log.info.assert_called_once_with('Oversized logo not rendered', extra={'reason': 'url_not_allowed'})


class TestEveryOtherCandidateIsAsBefore:
    @pytest.mark.parametrize('logo', [
        pytest.param(MagicMock(status_code=404, content=b''), id='http-error'),
        pytest.param(MagicMock(status_code=200, content=b'<html>error</html>'), id='not-an-image'),
        pytest.param(UnsafeURLError(LOGO, 'private address'), id='unsafe-address'),
    ])
    def test_a_refusal_for_another_reason_is_not_rendered_and_leaves_no_preview(self, table, s3, logo):  # noqa: F811
        cdp = FakeCdp(_page(), render_answer=BOX, logo_png=LOGO_PNG)
        result, stored, _ = _capture(table, s3, cdp, logo)
        assert result == {'status': 'ready'}
        assert cdp.methods().count('Target.createTarget') == 1
        assert stored['extracted_design']['logo'] == {'source_url': LOGO, 'content_type': 'image/png'}

    def test_a_logo_under_2_mb_is_downloaded_once_and_stored_with_no_render_tab(self, table, s3):  # noqa: F811
        cdp = FakeCdp(_page(), render_answer=BOX, logo_png=LOGO_PNG)
        _, stored, fetch = _capture(table, s3, cdp, MagicMock(status_code=200, content=SMALL_PNG))
        assert stored['extracted_design']['logo'] == {'source_url': LOGO, 'content_type': 'image/png',
                                                      'preview_key': PREVIEW_KEY}
        assert s3.get_object(Bucket='raw', Key=PREVIEW_KEY)['Body'].read() == SMALL_PNG
        assert cdp.methods().count('Target.createTarget') == 1
        assert _logo_downloads(fetch) == [LOGO]
