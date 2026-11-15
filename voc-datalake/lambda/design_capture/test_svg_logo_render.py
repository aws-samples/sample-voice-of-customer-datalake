"""A picked ``<img>`` logo whose file is an SVG, when the element cannot be photographed alone, is downloaded through
the SSRF-guarded fetch, sanitised, and drawn by the managed browser from a ``data:`` URL to a PNG, the sanitised SVG
kept beside it (``page_logo._file_logo`` → ``logo_render``).

Fake CDP (``test_design_capture_worker.FakeCdp``: the page tab is ``s1``, the render tab ``s2``; the isolation
answers ``gone`` by default, so the element's own file is read), moto S3. Pins: the render tab only ever handed a
``data:`` URL as a CDP argument (never the SVG's address, never in a code or markup string), a non-https, refused or
non-SVG file never drawn, every render failure being no logo with the capture still ready, the PNG checks, and the
stored logo shape.
"""
import base64
import json
from unittest.mock import MagicMock, patch

import boto3
import capture_worker as cw
import logo_render
import png_check
import pytest
from logo_pick import ModelAnswer
from test_design_capture_worker import (  # noqa: F401 - fixture
    ANSWER,
    JPEG,
    REF_ID,
    FakeCdp,
    LogoAnswers,
    _kit,
    _styles,
    candidate,
    page_candidates,
    png_bytes,
    png_of_rows,
    table,
)
from test_logo_pick import PICK_MODEL

from shared.company_context import get_reference
from shared.http_utils import UnsafeURLError

SVG = 'https://kirocrew.dev/brand/logo.svg'
RASTER = 'https://kirocrew.dev/logo.png'
PREVIEW_KEY = f'company-context/design/logo_preview_{REF_ID}.png'
SVG_KEY = f'company-context/design/logo_preview_{REF_ID}.svg'
BOX = {'x': 0, 'y': 0, 'width': 240, 'height': 64}
LOGO_PNG = png_bytes(240, 64)
DATA_PREFIX = 'data:image/svg+xml;base64,'


@pytest.fixture
def s3(table):  # noqa: F811 - the fixture imported above opens mock_aws
    del table
    client = boto3.client('s3', region_name='us-east-1')
    client.create_bucket(Bucket='raw')
    return client


#: What the site serves for its SVG logo URL (an Illustrator-style sheet the sanitiser carries over).
SITE_SVG = (b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 32"><style>.a{fill:#7c3aed}</style>'
            b'<script>steal()</script><path class="a" d="M0 0h120v32H0z"/></svg>')


def _server(svg_body: bytes, *, svg_allowed: bool = True):
    """The guarded-fetch fake: ``svg_body`` for an ``.svg`` URL (or the SSRF guard's refusal when not
    ``svg_allowed``), a small PNG for anything else."""
    def served(url: str, **_kwargs) -> MagicMock:
        if url.endswith('.svg') and not svg_allowed:
            raise UnsafeURLError(url, 'private address')
        return MagicMock(status_code=200, content=svg_body if url.endswith('.svg') else png_bytes(32, 32))
    return served


def logo_downloads(fetch: MagicMock) -> list[str]:
    """The URLs fetched for the LOGO (the candidate preview, the SVG copy): not the icon copies' favicon."""
    return [c.args[0] for c in fetch.call_args_list if not c.args[0].endswith('/favicon.ico')]


def _capture(table, s3, cdp: FakeCdp, *, svg_allowed: bool = True, answer: str = ANSWER,  # noqa: F811 — pytest fixture parameter named like the imported fixture
             svg_body: bytes = SITE_SVG, pick_logo=None):
    raster = MagicMock(side_effect=_server(svg_body, svg_allowed=svg_allowed))
    deps = cw.CaptureDeps(table=table, kit=_kit(cdp, []), summarise_images=MagicMock(return_value=answer),
                          sleep=lambda _s: None, clock=iter(range(1000)).__next__, now=lambda: '2026-10-27T00:00:00+00:00',
                          s3=s3, bucket='raw', logo_fetch=raster, pick_logo=pick_logo)
    with patch.object(cw, 'validate_url', return_value=(True, '')):
        result = cw.run_capture({'action': 'design_capture', 'ref_id': REF_ID}, deps)
    stored = get_reference(table, REF_ID)
    assert stored is not None
    return result, stored, raster


def _page_with(*urls: str, **kw) -> FakeCdp:
    """A page whose numbered ``<img>`` candidates are ``urls`` (the first one links home in the header), each at its
    own place in the header (the re-listing finds a candidate by its kind and place)."""
    found = page_candidates(*(candidate(n, url=url, home_link=n == 1, box={'x': 24 + 200 * (n - 1), 'y': 16, 'w': 166,
                                                                             'h': 52})
                              for n, url in enumerate(urls, 1)))
    return FakeCdp(_styles(), logo=LogoAnswers(candidates=found), **kw)


def _render_calls(cdp: FakeCdp) -> list[tuple[str, dict]]:
    return [call for call, (session, _) in zip(cdp.calls, cdp.routed, strict=True) if session == 's2']


class _FailingDrawCdp(FakeCdp):
    """The render tab's draw command times out (what ``cdp_client`` raises is a RuntimeError)."""

    def call(self, method: str, params: dict | None = None, *, session_id: str | None = None,
             timeout: float = 30.0) -> dict:
        if method == 'Runtime.callFunctionOn':
            raise RuntimeError('Runtime.callFunctionOn timed out')
        return super().call(method, params, session_id=session_id, timeout=timeout)


class TestTheSvgLogoIsRendered:
    def test_stores_the_png_as_preview_and_the_sanitised_svg_as_a_download_when_the_picked_img_is_an_svg(
            self, table, s3):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        cdp = _page_with(SVG, render_answer=BOX, logo_png=LOGO_PNG)
        result, stored, raster = _capture(table, s3, cdp)
        assert result == {'status': 'ready'}
        assert stored['extracted_design']['logo'] == {
            'source_url': SVG, 'content_type': 'image/png', 'rendered': True, 'preview_key': PREVIEW_KEY,
            'svg_preview_key': SVG_KEY, 'picked_by': 'rules'}
        obj = s3.get_object(Bucket='raw', Key=PREVIEW_KEY)
        assert (obj['ContentType'], obj['Body'].read()) == ('image/png', LOGO_PNG)
        svg = s3.get_object(Bucket='raw', Key=SVG_KEY)
        assert (svg['ContentType'], svg['ContentDisposition']) == ('image/svg+xml', 'attachment; filename="logo.svg"')
        markup = svg['Body'].read().decode()
        assert 'fill="#7c3aed"' in markup   # the file's own sheet carried over as an attribute
        assert 'script' not in markup
        assert '<style' not in markup
        assert logo_downloads(raster) == [SVG]   # once, through the guarded fetch; the PNG is drawn from those bytes

    def test_draws_in_its_own_transparent_tab_and_photographs_the_image_box(self, table, s3):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        cdp = _page_with(SVG, render_answer=BOX, logo_png=LOGO_PNG)
        _capture(table, s3, cdp)
        calls = _render_calls(cdp)
        assert [m for m, _ in calls] == [
            'Emulation.setDeviceMetricsOverride', 'Emulation.setDefaultBackgroundColorOverride',
            'Runtime.evaluate', 'Runtime.callFunctionOn', 'Page.captureScreenshot']
        assert calls[1][1] == {'color': {'r': 0, 'g': 0, 'b': 0, 'a': 0}}
        assert calls[4][1] == {'format': 'png', 'clip': {**BOX, 'scale': 1}, 'captureBeyondViewport': False}
        assert ('Target.createTarget', {'url': 'about:blank'}) in cdp.calls
        assert ('Target.closeTarget', {'targetId': 't2'}) in cdp.calls

    def test_the_render_tab_only_ever_receives_a_data_url_of_the_guarded_download(self, table, s3):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        cdp = _page_with(SVG, render_answer=BOX, logo_png=LOGO_PNG)
        _, stored, raster = _capture(table, s3, cdp)
        (_, draw), = [c for c in cdp.calls if c[0] == 'Runtime.callFunctionOn']
        url = draw['arguments'][0]['value']
        assert url.startswith(DATA_PREFIX)
        assert url not in draw['functionDeclaration']
        assert 'img.src = url' in draw['functionDeclaration']
        assert 'innerHTML' not in logo_render.RENDER_JS
        assert 'Page.setDocumentContent' not in cdp.methods()
        # The SVG's own address never reaches the render tab: no command carries it, and no navigation happens.
        assert all(SVG not in json.dumps(params) for _, params in _render_calls(cdp))
        assert 'Page.navigate' not in [m for m, _ in _render_calls(cdp)]
        # The drawn bytes are the guarded fetch's download, sanitised (the script gone), and the stored SVG copy.
        assert logo_downloads(raster) == [SVG]
        drawn = base64.b64decode(url.removeprefix(DATA_PREFIX)).decode('utf-8')
        assert 'steal' not in drawn
        assert '<path' in drawn
        stored_svg = s3.get_object(Bucket='raw', Key=stored['extracted_design']['logo']['svg_preview_key'])
        assert stored_svg['Body'].read().decode() == drawn

    def test_draws_nothing_when_the_svg_url_serves_no_svg_and_nothing_was_isolated(self, table, s3):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        cdp = _page_with(SVG, render_answer=BOX, logo_png=LOGO_PNG)
        _, stored, _ = _capture(table, s3, cdp, svg_body=b'<!doctype html><html>blocked</html>')
        assert 'logo' not in stored['extracted_design']
        assert _render_calls(cdp) == []


class TestWhatIsNotRendered:
    def test_downloads_the_raster_the_model_picked_and_renders_nothing(self, table, s3):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        cdp = _page_with(SVG, RASTER, render_answer=BOX, logo_png=LOGO_PNG)
        pick = MagicMock(return_value=ModelAnswer('{"logo": 2}', PICK_MODEL))
        _, stored, raster = _capture(table, s3, cdp, pick_logo=pick)
        logo = stored['extracted_design']['logo']
        assert logo['source_url'] == RASTER
        assert (logo['picked_by'], logo['pick_model']) == ('model', PICK_MODEL)
        assert 'rendered' not in logo
        assert cdp.methods().count('Target.createTarget') == 1
        assert logo_downloads(raster) == [RASTER]

    @pytest.mark.parametrize('svg', ['http://kirocrew.dev/logo.svg', SVG])
    def test_returns_no_logo_when_the_svg_is_not_https_or_refused_by_the_policy(self, table, s3, svg):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        cdp = _page_with(svg, render_answer=BOX, logo_png=LOGO_PNG)
        result, stored, _ = _capture(table, s3, cdp, svg_allowed=False)
        assert result == {'status': 'ready'}
        assert cdp.methods().count('Target.createTarget') == 1
        assert 'logo' not in stored['extracted_design']

    @pytest.mark.parametrize(('render_answer', 'logo_png'), [
        pytest.param({'error': 'decode_timeout'}, LOGO_PNG, id='decode-timeout'),
        pytest.param(BOX, JPEG, id='not-png'),
        pytest.param(BOX, LOGO_PNG + b'\x00' * 2_000_000, id='oversized'),
        pytest.param({'x': 0, 'y': 0, 'width': 0, 'height': 0}, LOGO_PNG, id='empty-box'),
        pytest.param(BOX, png_bytes(240, 64, b'\x00\x00\x00\x00'), id='blank'),
        pytest.param({'x': 0, 'y': 0, 'width': 'wide', 'height': 64}, LOGO_PNG, id='bad-box'),
    ])
    def test_returns_no_logo_and_a_ready_capture_when_the_render_fails(
            self, table, s3, render_answer, logo_png):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        cdp = _page_with(SVG, render_answer=render_answer, logo_png=logo_png)
        with patch.object(logo_render, 'logger') as log:
            result, stored, _ = _capture(table, s3, cdp)
        assert result == {'status': 'ready'}
        assert 'logo' not in stored['extracted_design']
        assert any(c.args[0] == 'SVG logo not rendered' for c in log.info.call_args_list)
        assert SVG not in str(log.mock_calls)
        assert ('Target.closeTarget', {'targetId': 't2'}) in cdp.calls

    def test_returns_no_logo_never_no_capture_on_a_cdp_error_in_the_render_tab(self, table, s3):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        result, stored, _ = _capture(table, s3, _failing())
        assert result == {'status': 'ready'}
        assert 'logo' not in stored['extracted_design']

    def test_never_keeps_a_model_proposed_logo(self, table, s3):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        answer = json.dumps({'summary': 'S', 'logo': {'source_url': SVG, 'content_type': 'image/png',
                                                      'rendered': True, 'preview_key': PREVIEW_KEY}})
        cdp = FakeCdp(_styles(), logo=LogoAnswers(candidates=page_candidates()))
        _, stored, raster = _capture(table, s3, cdp, answer=answer)
        assert 'logo' not in stored['extracted_design']
        assert logo_downloads(raster) == []   # the model's proposal is never downloaded


def _failing() -> FakeCdp:
    """A page picking an SVG ``<img>`` whose render tab times out."""
    return _FailingDrawCdp(_styles(), logo=LogoAnswers(candidates=page_candidates(candidate(url=SVG))))


class TestPngCheck:
    @pytest.mark.parametrize(('data', 'problem'), [
        (LOGO_PNG, None), (png_bytes(8, 8), None), (JPEG, 'not_png'), (png_bytes(7, 64), 'too_small'),
        (png_bytes(1025, 8), 'too_large'), (png_bytes(64, 64, b'\x00\x00\x00\x00'), 'blank'),
        (png_bytes(64, 64, b'\xff\xff\xff\x00')[:40], 'unreadable_png'),
        (b'\x89PNG\r\n\x1a\n' + b'\x00' * 2_000_001, 'too_large'),
    ])
    def test_verdict(self, data, problem):
        assert png_check.png_problem(data) == problem

    def test_a_transparent_image_with_one_visible_pixel_is_not_blank(self):
        rows = [b'\x00' + b'\x00' * 4 * 16] * 15 + [b'\x00' + b'\x00' * 4 * 15 + b'\x00\x00\x00\x01']
        assert png_check.png_problem(png_of_rows(16, 16, rows)) is None
