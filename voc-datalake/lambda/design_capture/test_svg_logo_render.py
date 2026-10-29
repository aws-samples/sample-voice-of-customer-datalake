"""An SVG-only logo on a live website is drawn by the managed browser and kept ONLY as a PNG.

Fake CDP (``test_design_capture_worker.FakeCdp``: the page tab is ``s1``, the render tab ``s2``), moto S3.
Pins: which logo is rendered (a header SVG beats a touch icon / favicon, a header raster beats a header SVG,
a non-https or policy-refused SVG never is), the URL handed over as a CDP argument and set as a property (never
in a code or markup string), every render failure falling back to the raster candidate with the capture still
ready, the PNG checks, and the stored logo shape.
"""
import json
import struct
import zlib
from unittest.mock import MagicMock, patch

import boto3
import capture_worker as cw
import logo_render
import page_styles as ps
import png_check
import pytest
from test_design_capture_worker import ANSWER, JPEG, REF_ID, FakeCdp, _kit, _styles, table  # noqa: F401 - fixture

from shared.company_context import get_reference

SVG = 'https://kirocrew.dev/brand/logo.svg'
TOUCH = 'https://kirocrew.dev/apple-touch-icon.png'
FAVICON = 'https://kirocrew.dev/favicon.png'
PREVIEW_KEY = f'company-context/design/logo_preview_{REF_ID}.png'
BOX = {'x': 0, 'y': 0, 'width': 240, 'height': 64}


def _chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))


def png_of_rows(width: int, height: int, rows: list[bytes]) -> bytes:
    """A real 8-bit RGBA PNG from its filtered scanlines (each: filter byte + RGBA pixels)."""
    header = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n' + _chunk(b'IHDR', header) + _chunk(b'IDAT', zlib.compress(b''.join(rows)))
            + _chunk(b'IEND', b''))


def png_bytes(width: int, height: int, pixel: bytes = b'\x7c\x3a\xed\xff') -> bytes:
    """A real 8-bit RGBA PNG of one colour (``pixel`` = RGBA)."""
    return png_of_rows(width, height, [b'\x00' + pixel * width] * height)


LOGO_PNG = png_bytes(240, 64)


@pytest.fixture
def s3(table):  # noqa: F811 - the fixture imported above opens mock_aws
    del table
    client = boto3.client('s3', region_name='us-east-1')
    client.create_bucket(Bucket='raw')
    return client


def _capture(table, s3, cdp: FakeCdp, *, svg_allowed: bool = True, answer: str = ANSWER):  # noqa: F811
    raster = MagicMock(return_value=MagicMock(status_code=200, content=png_bytes(32, 32)))
    deps = cw.CaptureDeps(table=table, kit=_kit(cdp, []), summarise_image=MagicMock(return_value=answer),
                          sleep=lambda _s: None, clock=iter(range(1000)).__next__, now=lambda: '2026-10-27T00:00:00+00:00',
                          s3=s3, bucket='raw', logo_fetch=raster)

    def policy(url: str) -> tuple[bool, str]:
        return (svg_allowed or not url.endswith('.svg'), 'private address')

    with patch.object(cw, 'validate_url', return_value=(True, '')), patch.object(ps, 'validate_url', side_effect=policy):
        result = cw.run_capture({'action': 'design_capture', 'ref_id': REF_ID}, deps)
    stored = get_reference(table, REF_ID)
    assert stored is not None
    return result, stored, raster


def _page(*logos: tuple[str, str]) -> str:
    return _styles(logos=[{'url': url, 'kind': kind} for url, kind in logos])


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
    def test_a_header_svg_beats_the_favicon_and_only_its_png_is_stored(self, table, s3):  # noqa: F811
        cdp = FakeCdp(_page((SVG, 'header'), (FAVICON, 'icon')), render_answer=BOX, logo_png=LOGO_PNG)
        result, stored, raster = _capture(table, s3, cdp)
        assert result == {'status': 'ready'}
        assert stored['extracted_design']['logo'] == {
            'source_url': SVG, 'content_type': 'image/png', 'rendered': True, 'preview_key': PREVIEW_KEY}
        obj = s3.get_object(Bucket='raw', Key=PREVIEW_KEY)
        assert (obj['ContentType'], obj['Body'].read()) == ('image/png', LOGO_PNG)
        assert [o['Key'] for o in s3.list_objects_v2(Bucket='raw')['Contents']] == [PREVIEW_KEY]
        raster.assert_not_called()   # the SVG is never downloaded, nor the favicon

    def test_the_render_runs_in_its_own_transparent_tab_and_photographs_the_image_box(self, table, s3):  # noqa: F811
        cdp = FakeCdp(_page((SVG, 'header'), (TOUCH, 'touch-icon')), render_answer=BOX, logo_png=LOGO_PNG)
        _capture(table, s3, cdp)
        calls = _render_calls(cdp)
        assert [m for m, _ in calls] == [
            'Emulation.setDeviceMetricsOverride', 'Emulation.setDefaultBackgroundColorOverride',
            'Runtime.evaluate', 'Runtime.callFunctionOn', 'Page.captureScreenshot']
        assert calls[1][1] == {'color': {'r': 0, 'g': 0, 'b': 0, 'a': 0}}
        assert calls[4][1] == {'format': 'png', 'clip': {**BOX, 'scale': 1}, 'captureBeyondViewport': False}
        assert ('Target.createTarget', {'url': 'about:blank'}) in cdp.calls[-8:]
        assert cdp.calls[-1] == ('Target.closeTarget', {'targetId': 't2'})

    def test_the_url_is_a_call_argument_set_as_a_property_never_in_code_or_markup(self, table, s3):  # noqa: F811
        cdp = FakeCdp(_page((SVG, 'header'), (FAVICON, 'icon')), render_answer=BOX, logo_png=LOGO_PNG)
        _capture(table, s3, cdp)
        (_, draw), = [c for c in cdp.calls if c[0] == 'Runtime.callFunctionOn']
        assert draw['arguments'][0] == {'value': SVG}
        assert SVG not in draw['functionDeclaration']
        assert 'img.src = url' in draw['functionDeclaration']
        assert 'innerHTML' not in logo_render.RENDER_JS
        assert 'Page.setDocumentContent' not in cdp.methods()
        # The URL appears in exactly one place across every command: that argument value.
        assert sum(json.dumps(params).count(SVG) for _, params in _render_calls(cdp)) == 1

    def test_an_og_image_svg_beats_only_a_favicon(self):
        with patch.object(ps, 'validate_url', return_value=(True, '')):
            assert ps.svg_logo_to_render([{'url': FAVICON, 'kind': 'icon'}, {'url': SVG, 'kind': 'og-image'}]) == SVG
            assert ps.svg_logo_to_render([{'url': TOUCH, 'kind': 'touch-icon'}, {'url': SVG, 'kind': 'og-image'}]) is None
            assert ps.svg_logo_to_render([{'url': SVG, 'kind': 'icon'}]) is None   # a favicon SVG is not a logo


class TestTheRasterStillWins:
    def test_a_header_raster_beats_a_header_svg_and_nothing_is_rendered(self, table, s3):  # noqa: F811
        cdp = FakeCdp(_page((SVG, 'header'), ('https://kirocrew.dev/logo.png', 'header')), render_answer=BOX,
                      logo_png=LOGO_PNG)
        _, stored, raster = _capture(table, s3, cdp)
        assert stored['extracted_design']['logo']['source_url'] == 'https://kirocrew.dev/logo.png'
        assert 'rendered' not in stored['extracted_design']['logo']
        assert cdp.methods().count('Target.createTarget') == 1
        raster.assert_called_once()

    @pytest.mark.parametrize('svg', ['http://kirocrew.dev/logo.svg', SVG])
    def test_a_non_https_or_policy_refused_svg_is_never_rendered(self, table, s3, svg):  # noqa: F811
        cdp = FakeCdp(_page((svg, 'header'), (TOUCH, 'touch-icon')), render_answer=BOX, logo_png=LOGO_PNG)
        _, stored, _ = _capture(table, s3, cdp, svg_allowed=False)
        assert cdp.methods().count('Target.createTarget') == 1
        assert stored['extracted_design']['logo']['source_url'] == TOUCH

    @pytest.mark.parametrize(('render_answer', 'logo_png'), [
        pytest.param({'error': 'decode_timeout'}, LOGO_PNG, id='decode-timeout'),
        pytest.param(BOX, JPEG, id='not-png'),
        pytest.param(BOX, LOGO_PNG + b'\x00' * 2_000_000, id='oversized'),
        pytest.param({'x': 0, 'y': 0, 'width': 0, 'height': 0}, LOGO_PNG, id='empty-box'),
        pytest.param(BOX, png_bytes(240, 64, b'\x00\x00\x00\x00'), id='blank'),
        pytest.param({'x': 0, 'y': 0, 'width': 'wide', 'height': 64}, LOGO_PNG, id='bad-box'),
    ])
    def test_a_failed_render_falls_back_to_the_touch_icon_and_the_capture_succeeds(
            self, table, s3, render_answer, logo_png):  # noqa: F811
        cdp = FakeCdp(_page((SVG, 'header'), (TOUCH, 'touch-icon')), render_answer=render_answer, logo_png=logo_png)
        with patch.object(logo_render, 'logger') as log:
            result, stored, raster = _capture(table, s3, cdp)
        assert result == {'status': 'ready'}
        logo = stored['extracted_design']['logo']
        assert logo == {'source_url': TOUCH, 'content_type': 'image/png', 'preview_key': PREVIEW_KEY}
        raster.assert_called_once()
        assert log.info.call_args.args[0] == 'SVG logo not rendered'
        assert SVG not in str(log.mock_calls)
        assert cdp.calls[-1][0] == 'Target.closeTarget'

    def test_a_cdp_error_in_the_render_tab_is_no_logo_never_no_capture(self, table, s3):  # noqa: F811
        cdp = _FailingDrawCdp(_page((SVG, 'header'), (TOUCH, 'touch-icon')))
        result, stored, _ = _capture(table, s3, cdp)
        assert result == {'status': 'ready'}
        assert stored['extracted_design']['logo']['source_url'] == TOUCH

    def test_a_model_proposed_rendered_flag_is_never_kept(self, table, s3):  # noqa: F811
        answer = json.dumps({'summary': 'S', 'logo': {'source_url': SVG, 'content_type': 'image/png',
                                                      'rendered': True, 'preview_key': PREVIEW_KEY}})
        cdp = FakeCdp(_page(('https://kirocrew.dev/logo.png', 'header')))
        _, stored, raster = _capture(table, s3, cdp, answer=answer)
        assert 'rendered' not in stored['extracted_design']['logo']
        raster.assert_called_once()   # downloaded like any candidate (and an SVG there would be refused)


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
