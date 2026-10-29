"""SVG logos that arrive as MARKUP are drawn to a PNG too: a website's inline ``<svg>`` and a GitHub
repository's ``*logo*.svg`` (5.47.00).

Fake CDP (``test_design_capture_worker.FakeCdp``), moto DynamoDB + S3. Pins: the inline logo is only looked
for when the page names no header logo image; its markup is sanitised before it reaches the browser and is
handed over as a ``data:`` URL argument; it is stored as the rendered preview with the page as its source; a
refused or failed render falls back to the raster candidate. The GitHub job draws the SVG it is sent, records
the logo only while the reference is unchanged, and leaves the "upload a PNG" note when it cannot draw it.
"""
import base64
import json
from unittest.mock import MagicMock, patch

import capture_handler
import capture_worker as cw
import logo_job
import page_inline_logo as pil
import page_styles as ps
import pytest
from test_design_capture_worker import REF_ID, FakeCdp, _kit, _styles, table  # noqa: F401 - fixture
from test_svg_logo_render import (  # noqa: F401 - fixture
    BOX,
    LOGO_PNG,
    PREVIEW_KEY,
    SVG_KEY,
    logo_downloads,
    png_bytes,
    s3,
)

from shared.company_context import DESIGN_SYSTEM_PK, get_reference
from shared.design_logo_render import SvgLogo, render_event

PAGE = 'https://kirocrew.dev/'
TOUCH = 'https://kirocrew.dev/apple-touch-icon.png'
INLINE = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 166 52" onload="steal()">'
          '<script>alert(1)</script><path d="M0 0h166v52H0z" fill="#7c3aed"/></svg>')
RAW_SVG_URL = 'https://raw.githubusercontent.com/acme/ui/HEAD/brand/logo.svg'
FETCHED = '2026-10-29T00:00:00+00:00'


class InlineCdp(FakeCdp):
    """Answers the inline-logo evaluate with ``inline`` (the page's serialisation); records whether it ran."""

    def __init__(self, styles: str, inline: object, **kw):
        super().__init__(styles, **kw)
        self.inline = inline
        self.inline_asked = 0

    def _evaluate(self, expression: str) -> str:
        if expression == pil.inline_logo_expression():
            self.inline_asked += 1
            return json.dumps(self.inline)
        return super()._evaluate(expression)


def _capture(table, s3, cdp):  # noqa: F811
    raster = MagicMock(return_value=MagicMock(status_code=200, content=png_bytes(32, 32)))
    deps = cw.CaptureDeps(table=table, kit=_kit(cdp, []), summarise_images=MagicMock(return_value='{"summary": "S"}'),
                          sleep=lambda _s: None, clock=iter(range(1000)).__next__, now=lambda: FETCHED,
                          s3=s3, bucket='raw', logo_fetch=raster)
    with patch.object(cw, 'validate_url', return_value=(True, '')), patch.object(ps, 'validate_url', return_value=(True, '')):
        result = cw.run_capture({'action': 'design_capture', 'ref_id': REF_ID}, deps)
    stored = _stored(table)
    assert stored is not None
    return result, stored, raster


def _stored(table) -> dict:  # noqa: F811 - the table fixture's name
    item = get_reference(table, REF_ID)
    assert item is not None
    return item


def _draw_argument(cdp: FakeCdp) -> str:
    (_, draw), = [c for c in cdp.calls if c[0] == 'Runtime.callFunctionOn']
    return draw['arguments'][0]['value']


class TestTheInlineSvgLogo:
    def test_an_inline_header_svg_is_sanitised_drawn_and_stored_with_the_page_as_its_source(self, table, s3):  # noqa: F811
        cdp = InlineCdp(_styles(logos=[{'url': TOUCH, 'kind': 'touch-icon'}]),
                        {'svg': INLINE, 'width': 166, 'height': 52}, render_answer=BOX, logo_png=LOGO_PNG)
        result, stored, raster = _capture(table, s3, cdp)
        assert result == {'status': 'ready'}
        assert stored['extracted_design']['logo'] == {
            'source_url': PAGE, 'content_type': 'image/png', 'rendered': True, 'preview_key': PREVIEW_KEY,
            'svg_preview_key': SVG_KEY}
        assert s3.get_object(Bucket='raw', Key=PREVIEW_KEY)['Body'].read() == LOGO_PNG
        assert logo_downloads(raster) == []   # inline markup: nothing to download
        drawn = _draw_argument(cdp)
        assert drawn.startswith('data:image/svg+xml;base64,')
        markup = base64.b64decode(drawn.split(',', 1)[1]).decode()
        assert s3.get_object(Bucket='raw', Key=SVG_KEY)['Body'].read().decode() == markup   # the drawn markup is kept
        assert 'script' not in markup
        assert 'onload' not in markup
        assert 'steal' not in markup
        assert 'fill="#7c3aed"' in markup

    def test_a_header_logo_image_means_the_inline_svg_is_never_looked_for(self, table, s3):  # noqa: F811
        cdp = InlineCdp(_styles(logos=[{'url': 'https://kirocrew.dev/logo.png', 'kind': 'header'}]),
                        {'svg': INLINE, 'width': 166, 'height': 52}, render_answer=BOX, logo_png=LOGO_PNG)
        _, stored, _ = _capture(table, s3, cdp)
        assert cdp.inline_asked == 0
        assert stored['extracted_design']['logo']['source_url'] == 'https://kirocrew.dev/logo.png'

    @pytest.mark.parametrize('inline', [
        pytest.param(None, id='none-on-the-page'),
        pytest.param({'svg': '<!DOCTYPE svg [<!ENTITY a "x">]><svg/>', 'width': 166, 'height': 52}, id='refused'),
        pytest.param({'svg': INLINE, 'width': 4, 'height': 4}, id='too-small'),
    ])
    def test_no_usable_inline_svg_falls_back_to_the_touch_icon(self, table, s3, inline):  # noqa: F811
        cdp = InlineCdp(_styles(logos=[{'url': TOUCH, 'kind': 'touch-icon'}]), inline, render_answer=BOX,
                        logo_png=LOGO_PNG)
        result, stored, raster = _capture(table, s3, cdp)
        assert result == {'status': 'ready'}
        assert cdp.inline_asked == 1
        assert stored['extracted_design']['logo']['source_url'] == TOUCH
        assert 'Runtime.callFunctionOn' not in cdp.methods()
        assert logo_downloads(raster) == [TOUCH]

    def test_a_failed_draw_of_the_inline_svg_keeps_the_capture(self, table, s3):  # noqa: F811
        cdp = InlineCdp(_styles(logos=[{'url': TOUCH, 'kind': 'touch-icon'}]),
                        {'svg': INLINE, 'width': 166, 'height': 52}, render_answer={'error': 'decode_failed'},
                        logo_png=LOGO_PNG)
        result, stored, _ = _capture(table, s3, cdp)
        assert result == {'status': 'ready'}
        assert stored['extracted_design']['logo']['source_url'] == TOUCH

    @pytest.mark.parametrize(('raw', 'ok'), [
        (json.dumps({'svg': INLINE, 'width': 166, 'height': 52}), True),
        (json.dumps({'svg': INLINE, 'width': True, 'height': 52}), False),
        (json.dumps({'svg': 'x' * (pil.MAX_INLINE_SVG_CHARS + 1), 'width': 166, 'height': 52}), False),
        (json.dumps([INLINE]), False), ('not json', False), (None, False),
    ])
    def test_the_page_answer_is_re_checked(self, raw, ok):
        assert (pil.parse_inline_logo(raw) is not None) is ok

    def test_an_http_page_is_never_asked(self):
        assert not pil.wants_inline_logo([], 'http://kirocrew.dev/')
        assert pil.wants_inline_logo([{'kind': 'touch-icon'}], PAGE)


# ── A GitHub repository's SVG logo (logo_job) ───────────────────────────────

def _github_row(table, **overrides):  # noqa: F811
    table.put_item(Item={'pk': DESIGN_SYSTEM_PK, 'sk': f'REF#{REF_ID}', 'id': REF_ID, 'kind': 'github',
                         'title': 'UI', 'url': 'https://github.com/acme/ui', 'status': 'ready', 'created_at': '1',
                         'fetched_at': FETCHED, 'extracted_design': {'source': 'repo_files', 'guidelines_md': '## Voice'},
                         **overrides})


def _event(svg: str = INLINE, fetched_at: str = FETCHED) -> dict:
    return render_event(REF_ID, SvgLogo('brand/logo.svg', RAW_SVG_URL, svg), fetched_at)


def _job(table, s3, cdp, event):  # noqa: F811
    sessions: list[int] = []
    cdp._targets = 1   # no page tab in this job: the render tab is the fake's ``s2`` (its PNG answer)
    return logo_job.run_logo_render(event, table, _kit(cdp, sessions), s3, 'raw'), sessions


class TestTheGithubSvgLogo:
    def test_the_svg_is_drawn_and_recorded_as_the_rendered_logo(self, table, s3):  # noqa: F811
        _github_row(table)
        cdp = FakeCdp(_styles(), render_answer=BOX, logo_png=LOGO_PNG)
        result, sessions = _job(table, s3, cdp, _event())
        assert result == {'status': 'rendered'}
        assert sessions == [logo_job.LOGO_SESSION_SECONDS]
        stored = _stored(table)
        assert stored['extracted_design']['logo'] == {
            'source_url': RAW_SVG_URL, 'content_type': 'image/png', 'rendered': True, 'preview_key': PREVIEW_KEY,
            'svg_preview_key': SVG_KEY}
        assert stored['extracted_design']['guidelines_md'] == '## Voice'
        markup = base64.b64decode(_draw_argument(cdp).split(',', 1)[1]).decode()
        assert 'script' not in markup   # sanitised again on this side of the boundary
        svg = s3.get_object(Bucket='raw', Key=SVG_KEY)
        assert (svg['ContentDisposition'], svg['Body'].read().decode()) == ('attachment; filename="logo.svg"', markup)
        assert 'Page.navigate' not in cdp.methods()   # no page is opened, only the blank render tab

    def test_an_svg_that_cannot_be_drawn_leaves_the_upload_a_png_note(self, table, s3):  # noqa: F811
        _github_row(table)
        cdp = FakeCdp(_styles(), render_answer={'error': 'decode_timeout'}, logo_png=LOGO_PNG)
        result, _ = _job(table, s3, cdp, _event())
        assert result == {'status': 'not_rendered'}
        design = _stored(table)['extracted_design']
        assert 'logo' not in design
        assert design['guidelines_md'].startswith('## Voice\n\n## Logo')
        assert '`brand/logo.svg`' in design['guidelines_md']
        assert 'Contents' not in s3.list_objects_v2(Bucket='raw')

    def test_a_refused_svg_opens_no_browser(self, table, s3):  # noqa: F811
        _github_row(table)
        cdp = FakeCdp(_styles())
        result, sessions = _job(table, s3, cdp, _event(svg='<html/>'))
        assert (result, sessions, cdp.calls) == ({'status': 'not_rendered'}, [], [])

    @pytest.mark.parametrize('row', [
        pytest.param({'fetched_at': '2026-10-30T00:00:00+00:00'}, id='refreshed-since'),
        pytest.param({'status': 'archived'}, id='archived'),
        pytest.param({'status': 'pending'}, id='refresh-running'),
        pytest.param({'extracted_design': None}, id='no-design'),
    ])
    def test_a_changed_reference_is_left_alone_and_no_browser_opens(self, table, s3, row):  # noqa: F811
        _github_row(table, **row)
        before = _stored(table)
        cdp = FakeCdp(_styles(), render_answer=BOX, logo_png=LOGO_PNG)
        result, sessions = _job(table, s3, cdp, _event())
        assert (result, sessions) == ({'status': 'skipped'}, [])
        assert _stored(table) == before

    def test_a_refresh_landing_during_the_render_wins(self, table, s3):  # noqa: F811
        _github_row(table)

        class RefreshingCdp(FakeCdp):
            def call(self, method, params=None, *, session_id=None, timeout=30.0):
                if method == 'Page.captureScreenshot':
                    table.update_item(Key={'pk': DESIGN_SYSTEM_PK, 'sk': f'REF#{REF_ID}'},
                                      UpdateExpression='SET fetched_at = :f', ExpressionAttributeValues={':f': 'later'})
                return super().call(method, params, session_id=session_id, timeout=timeout)

        result, _ = _job(table, s3, RefreshingCdp(_styles(), render_answer=BOX, logo_png=LOGO_PNG), _event())
        assert result == {'status': 'skipped'}
        assert 'logo' not in _stored(table)['extracted_design']

    @pytest.mark.parametrize('event', [
        {**_event(), 'ref_id': 'ref_x'}, {**_event(), 'source_url': 'http://raw.githubusercontent.com/a'},
        {**_event(), 'svg': ''}, {**_event(), 'path': ''}, {**_event(), 'action': 'design_capture'},
    ])
    def test_a_malformed_event_is_skipped(self, table, s3, event):  # noqa: F811
        _github_row(table)
        result, sessions = _job(table, s3, FakeCdp(_styles()), event)
        assert (result, sessions) == ({'status': 'skipped'}, [])

    def test_the_handler_routes_the_render_action(self):
        with patch.object(capture_handler, 'run_logo_render', return_value={'status': 'rendered'}) as job, \
                patch.object(capture_handler, 'run_capture') as capture, \
                patch.object(capture_handler, 'get_dynamodb_resource'), \
                patch.object(capture_handler, 'browser_kit'), \
                patch.dict('os.environ', {'AGGREGATES_TABLE': 't', 'RAW_DATA_BUCKET': ''}):
            assert capture_handler.lambda_handler(_event(), MagicMock()) == {'status': 'rendered'}
            assert capture_handler.lambda_handler({**_event(), 'httpMethod': 'POST'}, MagicMock()) == {'status': 'ignored'}
        job.assert_called_once()
        capture.assert_not_called()
