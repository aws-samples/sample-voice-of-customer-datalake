"""SVG logos that arrive as MARKUP: a website's picked inline ``<svg>`` (7.01.00: photographed alone, its sanitised
copy kept beside the PNG) and a GitHub repository's ``*logo*.svg`` (5.47.00: drawn to a PNG).

Fake CDP (``test_design_capture_worker.FakeCdp``), moto DynamoDB + S3. Pins: the picked inline SVG is isolated in
the page tab and trimmed in a fresh tab; its copy is serialised for exactly that stashed candidate, sanitised before
it is stored, and stored with the page as its source; no usable copy still keeps the PNG; a failed isolation or trim
is no logo, never no capture. The GitHub job draws the SVG it is sent, records the logo only while the reference
is unchanged, and leaves the "upload a PNG" note when it cannot draw it.
"""
import base64
import json
from unittest.mock import MagicMock, patch

import capture_handler
import capture_worker as cw
import logo_job
import page_inline_logo as pil
import pytest
from logo_render import TRIM_JS
from test_design_capture_worker import (  # noqa: F401 - fixture
    ISOLATED_BOX,
    REF_ID,
    FakeCdp,
    LogoAnswers,
    _kit,
    _styles,
    candidate,
    page_candidates,
    png_bytes,
    table,
    trim_answer,
)
from test_svg_logo_render import (  # noqa: F401 - fixture
    BOX,
    LOGO_PNG,
    PREVIEW_KEY,
    SVG_KEY,
    logo_downloads,
    s3,
)

from shared.company_context import DESIGN_SYSTEM_PK, get_reference
from shared.design_logo_render import SvgLogo, render_event

PAGE = 'https://kirocrew.dev/'
INLINE = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 166 52" onload="steal()">'
          '<script>alert(1)</script><path d="M0 0h166v52H0z" fill="#7c3aed"/></svg>')
RAW_SVG_URL = 'https://raw.githubusercontent.com/acme/ui/HEAD/brand/logo.svg'
FETCHED = '2026-10-29T00:00:00+00:00'


def _inline_page(inline: object, *, isolate: object = ISOLATED_BOX, trim: object = None) -> FakeCdp:
    """A page whose one candidate (the rules' pick) is an inline ``<svg>``; ``inline`` is its serialisation."""
    found = page_candidates(candidate(kind='inline-svg', url=None))
    return FakeCdp(_styles(), logo=LogoAnswers(candidates=found, isolate=isolate,
                                               trim=trim_answer(LOGO_PNG) if trim is None else trim, inline=inline))


def _capture(table, s3, cdp):  # noqa: F811 — pytest fixture parameter named like the imported fixture
    raster = MagicMock(return_value=MagicMock(status_code=200, content=png_bytes(32, 32)))
    deps = cw.CaptureDeps(table=table, kit=_kit(cdp, []), summarise_images=MagicMock(return_value='{"summary": "S"}'),
                          sleep=lambda _s: None, clock=iter(range(1000)).__next__, now=lambda: FETCHED,
                          s3=s3, bucket='raw', logo_fetch=raster, pick_logo=None)
    with patch.object(cw, 'validate_url', return_value=(True, '')):
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


def _inline_expressions(cdp: FakeCdp) -> list[str]:
    return [e for e in cdp.expressions() if e.startswith(f'({pil.INLINE_SVG_JS})')]


class TestTheInlineSvgLogo:
    def test_stores_the_isolated_png_and_the_sanitised_copy_with_the_page_as_its_source(self, table, s3):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        cdp = _inline_page({'svg': INLINE, 'width': 166, 'height': 52})
        result, stored, raster = _capture(table, s3, cdp)
        assert result == {'status': 'ready'}
        assert stored['extracted_design']['logo'] == {
            'source_url': PAGE, 'content_type': 'image/png', 'rendered': True, 'preview_key': PREVIEW_KEY,
            'svg_preview_key': SVG_KEY}
        assert s3.get_object(Bucket='raw', Key=PREVIEW_KEY)['Body'].read() == LOGO_PNG
        assert logo_downloads(raster) == []   # inline markup: nothing to download
        assert _inline_expressions(cdp) == [pil.inline_svg_expression(1)]   # exactly the picked candidate
        markup = s3.get_object(Bucket='raw', Key=SVG_KEY)['Body'].read().decode()
        assert 'script' not in markup
        assert 'onload' not in markup
        assert 'steal' not in markup
        assert 'fill="#7c3aed"' in markup
        (_, trim), = [c for c in cdp.calls if c[0] == 'Runtime.callFunctionOn']
        assert trim['functionDeclaration'] == TRIM_JS
        assert trim['arguments'][0]['value'].startswith('data:image/png;base64,')   # the shot, never markup

    @pytest.mark.parametrize('inline', [
        pytest.param(None, id='no-copy'),
        pytest.param({'svg': '<!DOCTYPE svg [<!ENTITY a "x">]><svg/>', 'width': 166, 'height': 52}, id='refused'),
        pytest.param({'svg': INLINE, 'width': 4, 'height': 4}, id='too-small'),
    ])
    def test_keeps_only_the_png_when_there_is_no_usable_copy(self, table, s3, inline):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        cdp = _inline_page(inline)
        result, stored, raster = _capture(table, s3, cdp)
        assert result == {'status': 'ready'}
        assert len(_inline_expressions(cdp)) == 1
        assert stored['extracted_design']['logo'] == {'source_url': PAGE, 'content_type': 'image/png',
                                                      'rendered': True, 'preview_key': PREVIEW_KEY}
        assert logo_downloads(raster) == []

    @pytest.mark.parametrize(('isolate', 'trim'), [
        pytest.param({'error': 'gone'}, None, id='element-gone'),
        pytest.param(ISOLATED_BOX, {'error': 'decode_failed'}, id='trim-failed'),
    ])
    def test_returns_no_logo_and_a_ready_capture_when_it_cannot_be_photographed_alone(
            self, table, s3, isolate, trim):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        cdp = _inline_page({'svg': INLINE, 'width': 166, 'height': 52}, isolate=isolate, trim=trim)
        result, stored, _ = _capture(table, s3, cdp)
        assert result == {'status': 'ready'}
        assert 'logo' not in stored['extracted_design']
        assert 'Contents' not in s3.list_objects_v2(Bucket='raw', Prefix=PREVIEW_KEY)

    @pytest.mark.parametrize(('raw', 'ok'), [
        (json.dumps({'svg': INLINE, 'width': 166, 'height': 52}), True),
        (json.dumps({'svg': INLINE, 'width': 8, 'height': 8}), True),
        (json.dumps({'svg': INLINE, 'width': 7, 'height': 52}), False),
        (json.dumps({'svg': INLINE, 'width': True, 'height': 52}), False),
        (json.dumps({'svg': '', 'width': 166, 'height': 52}), False),
        (json.dumps({'svg': 'x' * (pil.MAX_INLINE_SVG_CHARS + 1), 'width': 166, 'height': 52}), False),
        (json.dumps([INLINE]), False), ('not json', False), (None, False),
    ])
    def test_the_page_answer_is_re_checked(self, raw, ok):
        assert (pil.parse_inline_logo(raw) is not None) is ok

    def test_serialises_the_stashed_candidate_by_its_number(self):
        expression = pil.inline_svg_expression(3)
        assert expression.endswith(f'({json.dumps(pil.INLINE_LIMITS)}, 3)')
        assert pil.INLINE_LIMITS['stash'] == '__vocLogoCandidates'


# ── A GitHub repository's SVG logo (logo_job) ───────────────────────────────

def _github_row(table, **overrides):  # noqa: F811 — pytest fixture parameter named like the imported fixture
    table.put_item(Item={'pk': DESIGN_SYSTEM_PK, 'sk': f'REF#{REF_ID}', 'id': REF_ID, 'kind': 'github',
                         'title': 'UI', 'url': 'https://github.com/acme/ui', 'status': 'ready', 'created_at': '1',
                         'fetched_at': FETCHED, 'extracted_design': {'source': 'repo_files', 'guidelines_md': '## Voice'},
                         **overrides})


def _event(svg: str = INLINE, fetched_at: str = FETCHED) -> dict:
    return render_event(REF_ID, SvgLogo('brand/logo.svg', RAW_SVG_URL, svg), fetched_at)


def _job(table, s3, cdp, event):  # noqa: F811 — pytest fixture parameter named like the imported fixture
    sessions: list[int] = []
    cdp._targets = 1   # no page tab in this job: the render tab is the fake's ``s2`` (its PNG answer)
    return logo_job.run_logo_render(event, table, _kit(cdp, sessions), s3, 'raw'), sessions


class TestTheGithubSvgLogo:
    def test_the_svg_is_drawn_and_recorded_as_the_rendered_logo(self, table, s3):  # noqa: F811 — pytest fixture parameter named like the imported fixture
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

    def test_an_svg_that_cannot_be_drawn_leaves_the_upload_a_png_note(self, table, s3):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        _github_row(table)
        cdp = FakeCdp(_styles(), render_answer={'error': 'decode_timeout'}, logo_png=LOGO_PNG)
        result, _ = _job(table, s3, cdp, _event())
        assert result == {'status': 'not_rendered'}
        design = _stored(table)['extracted_design']
        assert 'logo' not in design
        assert design['guidelines_md'].startswith('## Voice\n\n## Logo')
        assert '`brand/logo.svg`' in design['guidelines_md']
        assert 'Contents' not in s3.list_objects_v2(Bucket='raw')

    def test_a_refused_svg_opens_no_browser(self, table, s3):  # noqa: F811 — pytest fixture parameter named like the imported fixture
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
    def test_a_changed_reference_is_left_alone_and_no_browser_opens(self, table, s3, row):  # noqa: F811 — pytest fixture parameter named like the imported fixture
        _github_row(table, **row)
        before = _stored(table)
        cdp = FakeCdp(_styles(), render_answer=BOX, logo_png=LOGO_PNG)
        result, sessions = _job(table, s3, cdp, _event())
        assert (result, sessions) == ({'status': 'skipped'}, [])
        assert _stored(table) == before

    def test_a_refresh_landing_during_the_render_wins(self, table, s3):  # noqa: F811 — pytest fixture parameter named like the imported fixture
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
    def test_a_malformed_event_is_skipped(self, table, s3, event):  # noqa: F811 — pytest fixture parameter named like the imported fixture
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
