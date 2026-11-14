"""A website's RASTER logo over the 1 MB company-logo cap is drawn smaller by the managed browser (``raster_logo``).

Fake CDP (``test_design_capture_worker.FakeCdp``: the page tab is ``s1``, the render tab ``s2``), moto S3.
Pins (7.00.02): the logo is downloaded ONCE through the guarded fetch (≤ 5 MB) and typed by its bytes; a logo over
1 MB (not only over 2 MB) is drawn, from a ``data:`` URL of those bytes, so the browser fetches nothing; the PNG is
stored and recorded like a rendered SVG; a failed render keeps a plain preview up to 2 MB, no logo above; over 5 MB
there is no logo and one INFO line; a logo up to 1 MB is stored as downloaded, with no render tab. Since 7.01.00 the
logo is the picked ``<img>`` candidate (``page_logo``), and a candidate refused in the session is no logo at all.
"""
import base64
from unittest.mock import MagicMock, patch

import pytest
import raster_logo
from test_design_capture_worker import (  # noqa: F401 - fixture
    REF_ID,
    FakeCdp,
    LogoAnswers,
    _run,
    _styles,
    candidate,
    page_candidates,
    table,
)
from test_svg_logo_render import BOX, LOGO_PNG, png_bytes, s3  # noqa: F401 - fixture

from shared.design_logo import COMPANY_LOGO_MAX_BYTES, MAX_LOGO_BYTES, RASTER_SHRINK_MAX_BYTES
from shared.http_utils import UnsafeURLError

LOGO = 'https://www.example.com/brand/logo.png'
PREVIEW_KEY = f'company-context/design/logo_preview_{REF_ID}.png'
SMALL_PNG = png_bytes(32, 32)


def _png_of(size: int) -> bytes:
    """``size`` bytes that sniff as a PNG."""
    return b'\x89PNG\r\n\x1a\n' + b'\x00' * (size - 8)


MID_PNG = _png_of(1_500_000)       # over the 1 MB company-logo cap, under the 2 MB preview limit
BIG_PNG = _png_of(3_000_000)       # over 2 MB, under the 5 MB shrink cap
HUGE_PNG = _png_of(RASTER_SHRINK_MAX_BYTES + 100)


def _site(logo: MagicMock | Exception):
    """The fetch fake: ``logo`` answers the logo URL, a small PNG answers anything else (the favicon copy)."""
    def served(url: str, **_kwargs) -> MagicMock:
        if url != LOGO:
            return MagicMock(status_code=200, content=SMALL_PNG)
        if isinstance(logo, Exception):
            raise logo
        return logo
    return MagicMock(side_effect=served)


def _capture(table, s3, cdp: FakeCdp, logo: MagicMock | Exception):  # noqa: F811 - fixture parameter
    """One capture whose page offers ``logo`` → ``(result, stored row, logo fetch)`` (the worker suite's ``_run``)."""
    fetch = _site(logo)
    result, stored, _vision, _sessions = _run(table, cdp, s3=s3, fetch=fetch, now=lambda: '2026-11-13T00:00:00+00:00')
    return result, stored, fetch


def _served(content: bytes) -> MagicMock:
    return MagicMock(status_code=200, content=content)


def _cdp(**kw) -> FakeCdp:
    """A page whose header ``<img>`` (the rules' pick) is ``LOGO``; it cannot be photographed alone (the fake's
    isolation answers ``gone``), so its own file is read."""
    return FakeCdp(_styles(), logo=LogoAnswers(candidates=page_candidates(candidate(url=LOGO))), **kw)


def _logo_downloads(fetch: MagicMock) -> list:
    return [c for c in fetch.call_args_list if c.args[0] == LOGO]


def _draws(cdp: FakeCdp) -> list[dict]:
    return [params for method, params in cdp.calls if method == 'Runtime.callFunctionOn']


def _preview(s3) -> bytes | None:  # noqa: F811 - fixture parameter
    if 'Contents' not in s3.list_objects_v2(Bucket='raw', Prefix=PREVIEW_KEY):
        return None
    return s3.get_object(Bucket='raw', Key=PREVIEW_KEY)['Body'].read()


RENDERED = {'source_url': LOGO, 'content_type': 'image/png', 'rendered': True, 'preview_key': PREVIEW_KEY}


def _assert_refused_once(cdp: FakeCdp, result: dict, stored: dict, fetch: MagicMock) -> None:
    """A candidate refused in the session: the capture is ready, no render tab opened (the page tab only), no
    logo is recorded, and the logo was downloaded exactly once."""
    assert result == {'status': 'ready'}
    assert cdp.methods().count('Target.createTarget') == 1
    assert 'logo' not in stored['extracted_design']
    assert len(_logo_downloads(fetch)) == 1


class TestARasterOverTheCompanyLogoCapIsShrunk:
    @pytest.mark.parametrize('body', [pytest.param(MID_PNG, id='1.5-MB'), pytest.param(BIG_PNG, id='3-MB')])
    def test_it_is_drawn_from_its_own_bytes_and_stored_as_the_rendered_preview(self, table, s3, body):  # noqa: F811
        cdp = _cdp(render_answer=BOX, logo_png=LOGO_PNG)
        result, stored, fetch = _capture(table, s3, cdp, _served(body))
        assert result == {'status': 'ready'}
        assert stored['extracted_design']['logo'] == RENDERED
        assert _preview(s3) == LOGO_PNG
        draw, = _draws(cdp)
        url = draw['arguments'][0]['value']
        assert url.startswith('data:image/png;base64,')          # the browser gets the bytes, never the address
        assert base64.b64decode(url.split(',', 1)[1]) == body
        assert LOGO not in str(cdp.calls)
        download, = _logo_downloads(fetch)                         # one guarded download, capped at 5 MB
        assert download.kwargs['max_bytes'] == RASTER_SHRINK_MAX_BYTES + 1

    def test_a_failed_render_of_a_logo_up_to_2_mb_keeps_it_as_a_plain_preview(self, table, s3):  # noqa: F811
        cdp = _cdp(render_answer={'error': 'decode_failed'}, logo_png=LOGO_PNG)
        result, stored, fetch = _capture(table, s3, cdp, _served(MID_PNG))
        assert result == {'status': 'ready'}
        assert stored['extracted_design']['logo'] == {'source_url': LOGO, 'content_type': 'image/png',
                                                      'preview_key': PREVIEW_KEY}
        assert _preview(s3) == MID_PNG
        assert len(_logo_downloads(fetch)) == 1

    def test_a_failed_render_of_a_logo_over_2_mb_leaves_no_preview_and_no_second_download(self, table, s3):  # noqa: F811
        cdp = _cdp(render_answer={'error': 'decode_failed'}, logo_png=LOGO_PNG)
        with patch('logo_render.logger') as log:
            result, stored, fetch = _capture(table, s3, cdp, _served(BIG_PNG))
        assert result == {'status': 'ready'}
        assert 'logo' not in stored['extracted_design']   # a refused candidate is no logo
        assert _preview(s3) is None
        assert len(_logo_downloads(fetch)) == 1
        reasons = [c.kwargs['extra'] for c in log.info.call_args_list if c.args[0] == 'Oversized logo not rendered']
        assert reasons == [{'reason': 'decode_failed'}]
        methods = [call[0] for call in cdp.calls]
        last_render = max(i for i, m in enumerate(methods) if m == 'Runtime.callFunctionOn')
        assert 'Target.closeTarget' in methods[last_render:]   # the render tab is closed after the failed draw

    def test_a_logo_over_5_mb_is_not_drawn_has_no_preview_and_logs_once(self, table, s3):  # noqa: F811
        cdp = _cdp(render_answer=BOX, logo_png=LOGO_PNG)
        with patch.object(raster_logo, 'logger') as log:
            _assert_refused_once(cdp, *_capture(table, s3, cdp, _served(HUGE_PNG)))
        log.info.assert_called_once_with('Logo candidate not downloaded', extra={'reason': 'over_shrink_cap'})

    def test_a_large_body_that_is_not_a_png_jpeg_or_webp_never_reaches_the_browser(self, table, s3):  # noqa: F811
        cdp = _cdp(render_answer=BOX, logo_png=LOGO_PNG)
        _, stored, _ = _capture(table, s3, cdp, _served(b'GIF89a' + b'\x00' * 1_500_000))
        assert cdp.methods().count('Target.createTarget') == 1
        assert 'logo' not in stored['extracted_design']


class TestEveryOtherCandidateIsAsBefore:
    @pytest.mark.parametrize('logo', [
        pytest.param(MagicMock(status_code=404, content=b''), id='http-error'),
        pytest.param(MagicMock(status_code=200, content=b'<html>error</html>'), id='not-an-image'),
        pytest.param(UnsafeURLError(LOGO, 'private address'), id='unsafe-address'),
    ])
    def test_a_refusal_for_another_reason_is_not_rendered_and_leaves_no_preview(self, table, s3, logo):  # noqa: F811
        cdp = _cdp(render_answer=BOX, logo_png=LOGO_PNG)
        _assert_refused_once(cdp, *_capture(table, s3, cdp, logo))   # store_preview does not try again

    @pytest.mark.parametrize('body', [pytest.param(SMALL_PNG, id='small'),
                                      pytest.param(_png_of(COMPANY_LOGO_MAX_BYTES), id='exactly-1-MB')])
    def test_a_logo_up_to_1_mb_is_downloaded_once_and_stored_with_no_render_tab(self, table, s3, body):  # noqa: F811
        cdp = _cdp(render_answer=BOX, logo_png=LOGO_PNG)
        _, stored, fetch = _capture(table, s3, cdp, _served(body))
        assert stored['extracted_design']['logo'] == {'source_url': LOGO, 'content_type': 'image/png',
                                                      'preview_key': PREVIEW_KEY}
        assert _preview(s3) == body
        assert cdp.methods().count('Target.createTarget') == 1
        assert len(_logo_downloads(fetch)) == 1


def test_the_preview_limit_sits_between_the_cap_and_the_shrink_limit():
    assert COMPANY_LOGO_MAX_BYTES < len(MID_PNG) <= MAX_LOGO_BYTES < len(BIG_PNG) <= RASTER_SHRINK_MAX_BYTES
