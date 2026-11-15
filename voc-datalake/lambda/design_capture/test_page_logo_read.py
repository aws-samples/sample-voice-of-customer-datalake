"""The picked logo read in the session (``page_logo``): isolated first, the element's own file as the fallback, the
SVG copy beside it, the marked header photo for the pick, and the stored logo. The browser-side steps
(``isolate_logo``, ``render_svg_logo``, ``read_raster_logo``) are patched; the page tab is a fake.
"""
import base64
import json
from unittest.mock import MagicMock, patch

import boto3
import page_logo as pl
import pytest
from logo_isolate import IsolatedLogo
from logo_pick import LogoPick
from moto import mock_aws
from page_inline_logo import inline_svg_expression
from page_logo_candidates import (
    HeadIcon,
    LogoCandidate,
    LogoCandidates,
    candidates_expression,
    clear_marks_expression,
    mark_expression,
)
from raster_logo import RasterLogo
from rendered_logo import RenderedLogo
from test_design_capture_worker import png_bytes
from test_page_logo_candidates import logo_candidate

from shared import design_logo, design_svg
from shared.http_utils import UnsafeURLError

PAGE = 'https://kirocrew.dev/'
PNG = png_bytes(166, 52)
IMG_URL = 'https://kirocrew.dev/brand/logo.png'
SVG_URL = 'https://kirocrew.dev/brand/logo.svg'
TOUCH = HeadIcon('touch-icon', 'https://kirocrew.dev/apple-touch-icon.png', '180x180')
INLINE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 166 52"><path d="M0 0h166v52H0z" fill="#7c3aed"/></svg>'
SITE_SVG = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 32"><path d="M0 0h120v32H0z"/></svg>'
DATA_PREFIX = 'data:image/svg+xml;base64,'
#: INLINE_SVG_JS's answer for ``INLINE``.
INLINE_ANSWER = {'svg': INLINE, 'width': 166, 'height': 52}
#: Where the re-listing's decoys sit: far from every candidate the tests pick.
DECOY_BOX = {'x': 900, 'y': 10, 'w': 20, 'h': 20}


def _found(*candidates, head=()) -> LogoCandidates:
    return LogoCandidates(PAGE, tuple(candidates), tuple(head))


def _raw(candidate: LogoCandidate) -> dict:
    """``candidate`` as CANDIDATES_JS lists it."""
    return {'n': candidate.n, 'kind': candidate.kind, 'url': candidate.url, 'text': candidate.text,
            'box': {'x': candidate.x, 'y': candidate.y, 'w': candidate.width, 'h': candidate.height}}


def _listing(*listed: LogoCandidate, url: object = PAGE) -> dict:
    """CANDIDATES_JS's answer on ``url`` listing ``listed`` at their numbers, with decoys far from the logo in the
    gaps before them (candidates are numbered 1, 2, 3… as the page stashed them)."""
    at = {c.n: _raw(c) for c in listed}
    decoy = {'kind': 'img', 'url': IMG_URL, 'box': DECOY_BOX}
    rows = [at.get(n) or {**decoy, 'n': n} for n in range(1, max(at, default=0) + 1)]
    return {'url': url, 'candidates': rows, 'head': []}


def _tab_answering(relisted: object, inline: object = None) -> MagicMock:
    """A page tab answering the candidates' re-listing with ``relisted`` (raised when it is an exception) and the
    inline ``<svg>`` copy with ``inline``; every other expression answers True."""
    def evaluate(expression: str) -> object:
        if expression == candidates_expression():
            if isinstance(relisted, Exception):
                raise relisted
            return relisted
        return json.dumps(inline) if 'serializeToString' in expression else True

    tab = MagicMock()
    tab.evaluate.side_effect = evaluate
    return tab


def _tab(*listed: LogoCandidate, url: object = PAGE, inline: object = None) -> MagicMock:
    """A page tab whose candidates, listed again on ``url``, are ``listed`` (see ``_listing``)."""
    return _tab_answering(json.dumps(_listing(*listed, url=url)), inline)


def _read(found: LogoCandidates, pick: LogoPick, *, isolated: IsolatedLogo | None = None, can_isolate: bool = True,
          tab: MagicMock | None = None, fetch=None, svg_png: bytes | None = PNG, raster: RasterLogo | None = None):
    """``read_page_logo`` with the browser steps patched → ``(logo, mocks)``. The page tab lists the same
    candidates again by default (the picked element is found where it was)."""
    tab = tab or _tab(*found.candidates)
    with patch.object(pl, 'isolate_logo', return_value=isolated) as isolate, \
            patch.object(pl, 'render_svg_logo', return_value=svg_png) as render, \
            patch.object(pl, 'read_raster_logo', return_value=raster or RasterLogo()) as read_raster:
        logo = pl.read_page_logo(tab, MagicMock(), found, pick, fetch, can_isolate=can_isolate)
    return logo, {'isolate': isolate, 'render': render, 'raster': read_raster, 'tab': tab}


def _fetch(body: bytes, status: int = 200) -> MagicMock:
    return MagicMock(return_value=MagicMock(status_code=status, content=body))


def _drawn_svg(render: MagicMock) -> str:
    """The markup the render tab was handed, decoded from the ``data:`` URL (asserting it is one)."""
    url = render.call_args.args[1]
    assert url.startswith(DATA_PREFIX)
    return base64.b64decode(url.removeprefix(DATA_PREFIX)).decode('utf-8')


def _moved(n: int = 5) -> MagicMock:
    """A page tab that re-rendered its header: the picked ``<img>`` (``logo_candidate`` default box) is listed again
    as number ``n``, moved by under the slack."""
    return _tab(logo_candidate(n, url=IMG_URL, x=26, y=15))


def _not_found_again(candidate: LogoCandidate, inline: object = None) -> MagicMock:
    """A page tab whose re-listing has no candidate of ``candidate``'s kind at its place (only a decoy)."""
    return _tab(logo_candidate(1, url=IMG_URL, x=candidate.x + 40), inline=inline)


class TestRestashed:
    def test_takes_the_candidate_of_the_same_kind_at_the_same_place(self):
        picked = logo_candidate(1, url=IMG_URL)
        current = pl._restashed(_moved(5), _found(picked), picked)
        assert current is not None
        assert (current.n, current.x, current.y) == (5, 26, 15)

    def test_returns_none_and_logs_when_nothing_matches_the_picked_place(self):
        picked = logo_candidate(1, url=IMG_URL)
        with patch.object(pl, 'logger') as log:
            assert pl._restashed(_not_found_again(picked), _found(picked), picked) is None
        log.info.assert_called_once_with('Picked logo not found again', extra={'kind': 'img'})

    @pytest.mark.parametrize(('stacked', 'expected'), [
        pytest.param((logo_candidate(1, url=SVG_URL), logo_candidate(2, url=IMG_URL)), 2, id='same-number'),
        pytest.param((logo_candidate(3, url=SVG_URL), logo_candidate(4, url=IMG_URL)), 4, id='same-file'),
    ])
    def test_prefers_the_same_number_then_the_same_file_when_two_elements_share_the_place(self, stacked, expected):
        picked = logo_candidate(2, url=IMG_URL)
        current = pl._restashed(_tab(*stacked), _found(picked), picked)
        assert current is not None
        assert current.n == expected

    def test_never_takes_another_kind_at_the_same_place(self):
        picked = logo_candidate(1, url=IMG_URL)
        tab = _tab(logo_candidate(1, kind='css-bg', url=IMG_URL))
        assert pl._restashed(tab, _found(picked), picked) is None

    @pytest.mark.parametrize('url', ['https://evil.example/', 'http://kirocrew.dev/', 'https://kirocrew.dev:8443/', '',
                                     None])
    def test_returns_none_when_the_re_listing_reports_another_origin(self, url):
        picked = logo_candidate(1, url=IMG_URL)
        assert pl._restashed(_tab(picked, url=url), _found(picked), picked) is None

    @pytest.mark.parametrize('answer', ['not json', json.dumps([1]), None, True])
    def test_returns_none_when_the_re_listing_is_unreadable(self, answer):
        picked = logo_candidate(2, url=IMG_URL)
        assert pl._restashed(_tab_answering(answer), _found(picked), picked) is None

    def test_returns_the_stashed_candidate_on_a_cdp_error(self):
        picked = logo_candidate(2, url=IMG_URL)
        assert pl._restashed(_tab_answering(RuntimeError('target closed')), _found(picked), picked) is picked


class TestIsolated:
    def test_isolates_the_element_now_at_the_picked_place_when_the_page_re_rendered(self):
        _, mocks = _read(_found(logo_candidate(1, url=IMG_URL)), LogoPick(number=1), isolated=IsolatedLogo(PNG),
                         tab=_moved(5))
        assert mocks['isolate'].call_args.args[2] == 5

    def test_isolates_the_same_number_when_the_page_lists_it_unchanged(self):
        _, mocks = _read(_found(logo_candidate(3, url=IMG_URL)), LogoPick(number=3), isolated=IsolatedLogo(PNG))
        assert mocks['isolate'].call_args.args[2] == 3

    def test_isolates_on_the_page_url_it_listed_the_candidates_on(self):
        _, mocks = _read(_found(logo_candidate(3, url=IMG_URL)), LogoPick(number=3), isolated=IsolatedLogo(PNG))
        assert mocks['isolate'].call_args.args[3] == PAGE

    def test_takes_a_re_listing_of_the_same_origin_on_another_path(self):
        tab = _tab(logo_candidate(5, url=IMG_URL), url='https://KiroCrew.dev/after-redirect?x=1')
        _, mocks = _read(_found(logo_candidate(1, url=IMG_URL)), LogoPick(number=1), isolated=IsolatedLogo(PNG), tab=tab)
        assert mocks['isolate'].call_args.args[2] == 5

    def test_isolates_the_stashed_candidate_when_the_re_listing_hits_a_cdp_error(self):
        tab = _tab_answering(RuntimeError('Runtime.evaluate timed out'))
        logo, mocks = _read(_found(logo_candidate(2, url=IMG_URL)), LogoPick(number=2), isolated=IsolatedLogo(PNG),
                            tab=tab)
        assert mocks['isolate'].call_args.args[2] == 2
        assert logo == pl.PageLogo(rendered=RenderedLogo(IMG_URL, PNG, None, None))

    def test_serialises_the_inline_svg_copy_with_the_re_listed_number(self):
        tab = _tab(logo_candidate(4, kind='inline-svg', url=None), inline=INLINE_ANSWER)
        logo, mocks = _read(_found(logo_candidate(1, kind='inline-svg', url=None)), LogoPick(number=1),
                            isolated=IsolatedLogo(PNG), tab=tab)
        tab.evaluate.assert_any_call(inline_svg_expression(4))
        assert inline_svg_expression(1) not in [c.args[0] for c in tab.evaluate.call_args_list]
        assert mocks['isolate'].call_args.args[2] == 4
        assert logo.rendered is not None
        assert logo.rendered.svg is not None


class TestNotFoundAgain:
    """Re-listing replaced the stash: without the picked element in it, nothing is serialised or photographed."""

    @pytest.mark.parametrize('tab_for', [
        pytest.param(_not_found_again, id='no-match'),
        pytest.param(lambda c: _tab(c, url='https://evil.example/'), id='another-origin'),
        pytest.param(lambda _c: _tab_answering('not json'), id='unreadable'),
    ])
    def test_reads_a_raster_img_from_its_own_file(self, tab_for):
        picked = logo_candidate(1, url=IMG_URL)
        downloaded = design_logo.DownloadedLogo(IMG_URL, PNG, 'image/png')
        logo, mocks = _read(_found(picked), LogoPick(number=1), isolated=IsolatedLogo(PNG), tab=tab_for(picked),
                            raster=RasterLogo(downloaded=downloaded))
        mocks['isolate'].assert_not_called()
        assert logo == pl.PageLogo(downloaded=downloaded)
        assert mocks['raster'].call_args.args[1] == IMG_URL

    def test_draws_an_svg_img_from_its_own_download(self):
        picked = logo_candidate(1, url=SVG_URL)
        fetch = _fetch(SITE_SVG)
        logo, mocks = _read(_found(picked), LogoPick(number=1), isolated=IsolatedLogo(PNG),
                            tab=_not_found_again(picked), fetch=fetch)
        mocks['isolate'].assert_not_called()
        assert fetch.call_count == 1                  # the file itself, downloaded by the fallback
        assert logo.rendered is not None
        assert (logo.rendered.source_url, logo.rendered.png) == (SVG_URL, PNG)
        assert logo.rendered.svg == _drawn_svg(mocks['render'])

    @pytest.mark.parametrize('picked', [
        pytest.param(logo_candidate(1, kind='inline-svg', url=None), id='inline-svg'),
        pytest.param(logo_candidate(1, kind='css-bg', url=SVG_URL), id='css-bg'),
        pytest.param(logo_candidate(1, kind='text', url=None, text='Kiro Crew'), id='text'),
    ])
    def test_returns_no_logo_for_any_other_kind(self, picked):
        tab = _not_found_again(picked, inline=INLINE_ANSWER)  # a copy would be readable
        fetch = MagicMock()
        logo, mocks = _read(_found(picked), LogoPick(number=1), isolated=IsolatedLogo(PNG), tab=tab, fetch=fetch)
        assert logo == pl.PageLogo()
        mocks['isolate'].assert_not_called()
        mocks['render'].assert_not_called()
        fetch.assert_not_called()
        assert not any('serializeToString' in c.args[0] for c in tab.evaluate.call_args_list)

class TestCopies:
    def test_draws_the_inline_svg_copy_when_the_element_paints_nothing_alone(self):
        picked = logo_candidate(2, kind='inline-svg', url=None)
        tab = _tab(picked, inline=INLINE_ANSWER)
        logo, mocks = _read(_found(picked), LogoPick(number=2), tab=tab)
        assert logo.rendered is not None
        assert (logo.rendered.source_url, logo.rendered.png) == (PAGE, PNG)
        assert mocks['render'].call_args.args[1].startswith('data:image/svg+xml')

    def test_uses_the_candidates_https_url_as_the_source_and_carries_the_backdrop(self):
        logo, mocks = _read(_found(logo_candidate(1, url=IMG_URL)), LogoPick(number=1),
                            isolated=IsolatedLogo(PNG, '#101020'))
        assert logo == pl.PageLogo(rendered=RenderedLogo(IMG_URL, PNG, None, '#101020'))
        mocks['isolate'].assert_called_once()
        assert mocks['isolate'].call_args.args[2] == 1

    @pytest.mark.parametrize('url', [None, 'data:image/png;base64,AA', 'http://kirocrew.dev/l.png'])
    def test_uses_the_page_url_as_the_source_when_the_candidate_has_no_https_file(self, url):
        logo, _ = _read(_found(logo_candidate(1, kind='css-bg' if url else 'text', url=url)), LogoPick(number=1),
                        isolated=IsolatedLogo(PNG))
        assert logo.rendered is not None
        assert logo.rendered.source_url == PAGE

    def test_keeps_the_sanitised_inline_svg_copy_beside_the_png(self):
        picked = logo_candidate(2, kind='inline-svg', url=None)
        tab = _tab(picked, inline=INLINE_ANSWER)
        logo, _ = _read(_found(picked), LogoPick(number=2),
                        isolated=IsolatedLogo(PNG), tab=tab)
        assert logo.rendered is not None
        assert logo.rendered.svg is not None
        assert 'fill="#7c3aed"' in logo.rendered.svg
        tab.evaluate.assert_any_call(inline_svg_expression(2))

    def test_keeps_the_downloaded_svg_file_copy_of_an_img(self):
        fetch = _fetch(SITE_SVG)
        logo, _ = _read(_found(logo_candidate(1, url=SVG_URL)), LogoPick(number=1), isolated=IsolatedLogo(PNG),
                        fetch=fetch)
        assert logo.rendered is not None
        assert logo.rendered.svg is not None
        assert '<path' in logo.rendered.svg
        assert fetch.call_args.args[0] == SVG_URL

    def test_never_downloads_a_css_background_svg_as_the_copy(self):
        fetch = _fetch(SITE_SVG)
        logo, _ = _read(_found(logo_candidate(1, kind='css-bg', url=SVG_URL)), LogoPick(number=1),
                        isolated=IsolatedLogo(PNG), fetch=fetch)
        assert logo.rendered is not None
        assert logo.rendered.svg is None
        fetch.assert_not_called()

    def test_swallows_a_failing_svg_copy_and_keeps_the_png(self):
        tab = MagicMock()
        tab.evaluate.side_effect = RuntimeError('Runtime.evaluate timed out')
        logo, _ = _read(_found(logo_candidate(1, kind='inline-svg', url=None)), LogoPick(number=1),
                        isolated=IsolatedLogo(PNG), tab=tab)
        assert logo == pl.PageLogo(rendered=RenderedLogo(PAGE, PNG, None, None))


class TestTheElementsOwnFile:
    def test_draws_an_svg_img_from_its_sanitised_download_when_it_cannot_be_isolated(self):
        fetch = _fetch(SITE_SVG)
        logo, mocks = _read(_found(logo_candidate(1, url=SVG_URL)), LogoPick(number=1), fetch=fetch)
        assert logo.rendered is not None
        assert (logo.rendered.source_url, logo.rendered.png) == (SVG_URL, PNG)
        assert logo.rendered.svg is not None
        drawn = _drawn_svg(mocks['render'])
        assert drawn == logo.rendered.svg
        assert '<path' in drawn
        assert fetch.call_count == 1                  # the copy read for the isolation is reused, never fetched twice
        assert fetch.call_args.args[0] == SVG_URL

    def test_builds_the_data_url_from_the_guarded_download_without_a_copy(self):
        fetch = _fetch(SITE_SVG)
        with patch.object(pl, 'render_svg_logo', return_value=PNG) as render:
            logo = pl._file_logo(MagicMock(), SVG_URL, fetch, None)
        assert logo.rendered is not None
        expected = pl.downloaded_svg(SVG_URL, _fetch(SITE_SVG))
        assert expected is not None
        assert render.call_args.args[1] == design_svg.svg_data_url(expected)
        assert logo.rendered == RenderedLogo(SVG_URL, PNG, expected)
        assert fetch.call_args.args[0] == SVG_URL

    def test_draws_the_svg_copy_already_read_without_downloading_again(self):
        fetch = MagicMock()
        with patch.object(pl, 'render_svg_logo', return_value=PNG) as render:
            logo = pl._file_logo(MagicMock(), SVG_URL, fetch, INLINE)
        assert render.call_args.args[1] == design_svg.svg_data_url(INLINE)
        assert logo.rendered == RenderedLogo(SVG_URL, PNG, INLINE)
        fetch.assert_not_called()

    @pytest.mark.parametrize('fetch', [
        pytest.param(_fetch(PNG), id='not-an-svg'),
        pytest.param(_fetch(b''), id='empty'),
        pytest.param(_fetch(SITE_SVG, status=404), id='http-error'),
        pytest.param(_fetch(b'<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script>', 200), id='unsanitisable'),
        pytest.param(MagicMock(side_effect=UnsafeURLError(SVG_URL, 'private address')), id='refused-address'),
    ])
    def test_never_draws_an_svg_file_that_was_not_downloaded_and_sanitised(self, fetch):
        logo, mocks = _read(_found(logo_candidate(1, url=SVG_URL)), LogoPick(number=1), fetch=fetch)
        assert logo == pl.PageLogo()
        mocks['render'].assert_not_called()

    def test_returns_no_logo_when_the_svg_cannot_be_drawn(self):
        logo, mocks = _read(_found(logo_candidate(1, url=SVG_URL)), LogoPick(number=1), svg_png=None,
                            fetch=_fetch(SITE_SVG))
        assert logo == pl.PageLogo()
        assert _drawn_svg(mocks['render'])

    def test_reads_a_raster_img_through_the_raster_path(self):
        downloaded = design_logo.DownloadedLogo(IMG_URL, PNG, 'image/png')
        logo, mocks = _read(_found(logo_candidate(1, url=IMG_URL)), LogoPick(number=1),
                            raster=RasterLogo(downloaded=downloaded))
        assert logo == pl.PageLogo(downloaded=downloaded)
        assert mocks['raster'].call_args.args[1] == IMG_URL
        mocks['render'].assert_not_called()

    def test_carries_a_refused_raster_url(self):
        logo, _ = _read(_found(logo_candidate(1, url=IMG_URL)), LogoPick(number=1),
                        raster=RasterLogo(refused_url=IMG_URL))
        assert logo == pl.PageLogo(refused_url=IMG_URL)

    @pytest.mark.parametrize('candidate', [
        pytest.param(logo_candidate(1, kind='css-bg', url='https://kirocrew.dev/sprite.png'), id='css-bg'),
        pytest.param(logo_candidate(1, kind='text', url=None, text='Kiro Crew'), id='text'),
        pytest.param(logo_candidate(1, kind='inline-svg', url=None), id='inline-svg'),
        pytest.param(logo_candidate(1, url='http://kirocrew.dev/logo.png'), id='http-img'),
    ])
    def test_never_downloads_anything_but_an_https_img(self, candidate):
        fetch = MagicMock()
        logo, mocks = _read(_found(candidate), LogoPick(number=1), fetch=fetch)
        assert logo == pl.PageLogo()
        mocks['raster'].assert_not_called()
        mocks['render'].assert_not_called()
        fetch.assert_not_called()

    def test_never_isolates_or_serialises_when_the_page_moved(self):
        tab = _tab(logo_candidate(1, url=SVG_URL), inline=INLINE_ANSWER)
        fetch = _fetch(SITE_SVG)
        logo, mocks = _read(_found(logo_candidate(1, url=SVG_URL)), LogoPick(number=1), can_isolate=False, tab=tab,
                            fetch=fetch)
        mocks['isolate'].assert_not_called()
        tab.evaluate.assert_not_called()
        fetch.assert_called_once()                    # the file itself, through the guarded fetch; no separate copy
        assert fetch.call_args.args[0] == SVG_URL
        assert logo.rendered is not None
        assert logo.rendered.svg == _drawn_svg(mocks['render'])

    def test_draws_nothing_when_the_page_moved_and_the_file_is_not_an_svg(self):
        fetch = _fetch(PNG)
        logo, mocks = _read(_found(logo_candidate(1, url=SVG_URL)), LogoPick(number=1), can_isolate=False, fetch=fetch)
        assert logo == pl.PageLogo()
        mocks['render'].assert_not_called()


class TestHeadIconFallback:
    def test_reads_the_picked_touch_icon_like_a_raster(self):
        downloaded = design_logo.DownloadedLogo(TOUCH.url, PNG, 'image/png')
        logo, mocks = _read(_found(head=(TOUCH,)), LogoPick(fallback='touch-icon'),
                            raster=RasterLogo(downloaded=downloaded))
        assert logo.downloaded == downloaded
        assert mocks['raster'].call_args.args[1] == TOUCH.url
        mocks['isolate'].assert_not_called()

    def test_returns_no_logo_for_a_fallback_the_page_does_not_list(self):
        logo, mocks = _read(_found(head=(TOUCH,)), LogoPick(fallback='icon'))
        assert logo == pl.PageLogo()
        mocks['raster'].assert_not_called()

    def test_returns_no_logo_for_an_empty_pick(self):
        assert _read(_found(logo_candidate(1)), LogoPick())[0] == pl.PageLogo()


class TestMarkedHeader:
    def test_returns_none_without_candidates_and_touches_nothing(self):
        tab = MagicMock()
        assert pl.marked_header(tab, _found(head=(TOUCH,))) is None
        tab.evaluate.assert_not_called()

    def test_photographs_the_marked_band_and_clears_the_marks(self):
        tab = MagicMock()
        tab.evaluate.side_effect = lambda e: {'innerWidth': 1366, 'innerHeight': 900}.get(e, 1)
        with patch.object(pl, 'photograph', return_value='shot') as photograph:
            assert pl.marked_header(tab, _found(logo_candidate(1))) == 'shot'
        assert photograph.call_args.args[1:] == ('header', 0, 1366.0, float(pl.MARKED_HEADER_PX))
        expressions = [c.args[0] for c in tab.evaluate.call_args_list]
        assert expressions.index(mark_expression()) < expressions.index(clear_marks_expression())
        assert expressions[-1] == clear_marks_expression()

    def test_clears_the_marks_even_when_the_photograph_raises(self):
        tab = MagicMock()
        tab.evaluate.side_effect = lambda e: {'innerWidth': 1366, 'innerHeight': 900}.get(e, 1)
        with patch.object(pl, 'photograph', side_effect=RuntimeError('timed out')):
            assert pl.marked_header(tab, _found(logo_candidate(1))) is None
        assert tab.evaluate.call_args_list[-1].args == (clear_marks_expression(),)

    @pytest.mark.parametrize('width', [None, True, 'wide', 4])
    def test_returns_none_for_an_unreadable_viewport_and_still_clears(self, width):
        tab = MagicMock()
        tab.evaluate.side_effect = lambda e: {'innerWidth': width, 'innerHeight': 900}.get(e, 1)
        with patch.object(pl, 'photograph') as photograph:
            assert pl.marked_header(tab, _found(logo_candidate(1))) is None
        photograph.assert_not_called()
        assert tab.evaluate.call_args_list[-1].args == (clear_marks_expression(),)

    def test_keeps_going_when_the_marks_cannot_be_cleared(self):
        def evaluate(expression: str) -> object:
            if expression == clear_marks_expression():
                raise RuntimeError('target closed')
            return {'innerWidth': 1366, 'innerHeight': 300}.get(expression, 1)

        tab = MagicMock()
        tab.evaluate.side_effect = evaluate
        with patch.object(pl, 'photograph', return_value='shot') as photograph:
            assert pl.marked_header(tab, _found(logo_candidate(1))) == 'shot'
        assert photograph.call_args.args[4] == 300.0


REF_ID = 'ref_0123456789ab'


@pytest.fixture
def s3():
    with mock_aws():
        client = boto3.client('s3', region_name='us-east-1')
        client.create_bucket(Bucket='raw')
        yield client


class TestStoredLogo:
    def test_records_the_backdrop_of_a_light_logo(self, s3):
        design = pl.stored_logo({'summary': 'S'}, RenderedLogo(IMG_URL, PNG, None, '#101020'), REF_ID, s3, 'raw')
        assert design is not None
        assert design['logo'] == {'source_url': IMG_URL, 'content_type': 'image/png', 'rendered': True,
                                  'preview_key': f'company-context/design/logo_preview_{REF_ID}.png',
                                  'backdrop': '#101020'}

    def test_records_no_backdrop_for_a_logo_drawn_on_nothing(self, s3):
        design = pl.stored_logo({}, RenderedLogo(IMG_URL, PNG), REF_ID, s3, 'raw')
        assert design is not None
        assert 'backdrop' not in design['logo']

    def test_drops_a_rendered_flag_it_did_not_set(self, s3):
        design = {'logo': {'source_url': IMG_URL, 'rendered': True}}
        assert pl.stored_logo(design, None, REF_ID, s3, 'raw') == {'logo': {'source_url': IMG_URL}}

    def test_returns_a_non_dict_design_unchanged(self, s3):
        assert pl.stored_logo(None, RenderedLogo(IMG_URL, PNG), REF_ID, s3, 'raw') is None
