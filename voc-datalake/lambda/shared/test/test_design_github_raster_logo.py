"""A GitHub repository's RASTER logo over the 1 MB company-logo cap goes to the browser to be drawn smaller (7.00.02).

Before, a 1-2 MB raster logo was stored as a plain preview that "Use this logo" then refused (over the 1 MB
cap), and a larger one had no preview at all. Pins: the settings worker downloads the candidate ONCE; up to 1 MB
it is the preview and nothing is handed off; over 1 MB the raw URL (never the bytes) is handed off AFTER the
ready outcome is written, with a plain preview kept meanwhile when it is up to 2 MB; a candidate that cannot be
downloaded (a private repository's anonymous 404) has no preview and no hand-off, as before; a hand-off that cannot
start records the "upload a PNG under 1 MB" note; without a browser nothing changes.
"""
from unittest.mock import MagicMock, patch

import pytest

from shared import design_logo_render
from shared import design_references as dr
from shared.design_logo import COMPANY_LOGO_MAX_BYTES, MAX_LOGO_BYTES, RASTER_SHRINK_MAX_BYTES
from shared.test.test_design_references_mutation import CONTENTS, TREE_HEAD, _Body, _tree, _world

REF_ID = 'ref_0123456789ab'
CSS_PATH = 'src/styles/tokens.css'
LOGO_PATH = 'public/logo.png'
RAW_URL = f'https://raw.githubusercontent.com/acme/ui/HEAD/{LOGO_PATH}'
ITEM = {'id': REF_ID, 'kind': 'github', 'url': 'https://github.com/acme/ui'}
PREVIEW_KEY = f'company-context/design/logo_preview_{REF_ID}.png'
NOTE = 'Upload a PNG under 1 MB'


def _png_of(size: int) -> bytes:
    return b'\x89PNG\r\n\x1a\n' + b'\x00' * (size - 8)


SMALL = _png_of(50_000)
MID = _png_of(1_500_000)
BIG = _png_of(3_000_000)


def _starter(started: bool) -> MagicMock:
    """A ``start_logo_render`` fake answering ``started``; ``_process`` records when it is called."""
    return MagicMock(return_value=started)


def _process(logo: MagicMock, start: MagicMock | None):
    world = _world({TREE_HEAD: _tree(CSS_PATH, LOGO_PATH), f'{CONTENTS}{CSS_PATH}': _Body(b':root{--a:#7c3aed}')},
                   summary='{"summary": "Purple"}')
    world.deps.start_logo_render = start
    world.deps.logo_fetch = fetch = MagicMock(return_value=logo)
    order: list[str] = []
    table = MagicMock()
    table.update_item.side_effect = lambda **_kw: order.append('write')
    if start is not None:
        answer = start.return_value
        start.side_effect = lambda _event: order.append('start') or answer
    outcome = dr.process_reference(table, ITEM, world.deps)
    return outcome, world, table, order, fetch


def _put_keys(world) -> list[str]:
    return [c.kwargs['Key'] for c in world.s3.put_object.call_args_list]


def _served(body: bytes) -> MagicMock:
    return MagicMock(status_code=200, content=body)


class TestALogoOverTheCapIsHandedOff:
    def test_a_1_to_2_mb_logo_keeps_a_plain_preview_and_its_raw_url_is_handed_off_after_the_write(self):
        start = _starter(True)
        outcome, world, _, order, fetch = _process(_served(MID), start)
        assert order == ['write', 'start']
        event = start.call_args.args[0]
        assert event == {'action': design_logo_render.DESIGN_LOGO_RENDER_ACTION, 'kind': 'raster', 'ref_id': REF_ID,
                         'path': 'logo.png', 'source_url': RAW_URL, 'fetched_at': outcome['fetched_at']}
        assert outcome['extracted_design']['logo']['preview_key'] == PREVIEW_KEY   # the admin sees it meanwhile
        assert _put_keys(world) == [PREVIEW_KEY]
        assert fetch.call_count == 1                               # one download
        assert NOTE not in (outcome['extracted_design'].get('guidelines_md') or '')

    def test_a_logo_over_2_mb_has_no_preview_and_is_handed_off(self):
        start = _starter(True)
        outcome, world, _, _, fetch = _process(_served(BIG), start)
        assert start.call_args.args[0]['source_url'] == RAW_URL
        assert 'preview_key' not in outcome['extracted_design']['logo']
        assert _put_keys(world) == []
        assert fetch.call_count == 1                               # not downloaded again

    def test_the_event_parses_back_on_the_capture_side_as_a_raster_with_no_bytes(self):
        start = _starter(True)
        _process(_served(MID), start)
        with patch.object(design_logo_render, 'validate_url', return_value=(True, '')):
            request = design_logo_render.parse_render_event(start.call_args.args[0])
        assert request is not None
        assert request.logo == design_logo_render.RasterLogo('logo.png', RAW_URL)

    def test_a_hand_off_that_cannot_start_records_the_upload_a_png_under_1_mb_note(self):
        outcome, _, table, _, _ = _process(_served(MID), _starter(False))
        assert NOTE in outcome['extracted_design']['guidelines_md']
        assert '`logo.png`' in outcome['extracted_design']['guidelines_md']
        assert table.update_item.call_count == 2


class TestEveryOtherLogoIsAsBefore:
    @pytest.mark.parametrize('body', [pytest.param(SMALL, id='small'),
                                      pytest.param(_png_of(COMPANY_LOGO_MAX_BYTES), id='exactly-1-MB')])
    def test_a_logo_up_to_1_mb_is_the_preview_and_nothing_is_handed_off(self, body):
        start = _starter(True)
        outcome, _, _, _, fetch = _process(_served(body), start)
        start.assert_not_called()
        assert outcome['extracted_design']['logo']['preview_key'] == PREVIEW_KEY
        assert fetch.call_count == 1

    @pytest.mark.parametrize('logo', [
        pytest.param(MagicMock(status_code=404, content=b'404: Not Found'), id='private-repository'),
        pytest.param(_served(b'<html>' + b'x' * 1_500_000), id='not-an-image'),
    ])
    def test_a_logo_that_cannot_be_downloaded_has_no_preview_no_hand_off_and_no_note(self, logo):
        start = _starter(True)
        outcome, _, _, _, fetch = _process(logo, start)
        start.assert_not_called()
        assert 'preview_key' not in outcome['extracted_design']['logo']
        assert NOTE not in (outcome['extracted_design'].get('guidelines_md') or '')
        assert fetch.call_count == 1

    def test_without_a_browser_a_1_to_2_mb_logo_is_only_previewed(self):
        outcome, _, table, _, fetch = _process(_served(MID), None)
        assert outcome['extracted_design']['logo']['preview_key'] == PREVIEW_KEY
        assert table.update_item.call_count == 1
        assert fetch.call_args.kwargs['max_bytes'] == MAX_LOGO_BYTES + 1


class TestTheRasterEvent:
    @staticmethod
    def _event(**overrides) -> dict:
        logo = design_logo_render.RasterLogo('logo.png', RAW_URL)
        return {**design_logo_render.render_event(REF_ID, logo, '2026-11-13T00:00:00+00:00'), **overrides}

    @pytest.mark.parametrize('event', [
        pytest.param({'source_url': 'http://raw.githubusercontent.com/acme/ui/HEAD/logo.png'}, id='http'),
        pytest.param({'source_url': 'https://raw.githubusercontent.com/' + 'a' * 2_100}, id='too-long'),
        pytest.param({'kind': 'gif'}, id='unknown-kind'),
        pytest.param({'kind': 'svg'}, id='svg-without-markup'),
    ])
    def test_a_malformed_raster_event_is_refused(self, event):
        with patch.object(design_logo_render, 'validate_url', return_value=(True, '')):
            assert design_logo_render.parse_render_event(self._event(**event)) is None

    def test_a_url_the_policy_refuses_is_refused(self):
        with patch.object(design_logo_render, 'validate_url', return_value=(False, 'private address')) as policy:
            assert design_logo_render.parse_render_event(self._event()) is None
        policy.assert_called_once_with(RAW_URL)

    def test_the_raster_event_never_carries_bytes(self):
        assert set(self._event()) == {'action', 'kind', 'ref_id', 'path', 'source_url', 'fetched_at'}


def test_the_shrink_cap_is_above_the_preview_download():
    assert len(BIG) < RASTER_SHRINK_MAX_BYTES
