"""The picked logo photographed alone in the page tab (``logo_isolate``): the box answer re-checked, the shot scale,
the retries under the 1 MB company-logo cap, and the page always left as it was. A fake page tab; ``trim_png``
(the fresh-tab trim, covered in ``test_logo_render_cap``) is patched.
"""
import base64
import json
from unittest.mock import MagicMock, patch

import logo_isolate as li
import pytest
from logo_render import TrimmedPng
from test_design_capture_worker import ISOLATED_BOX, png_bytes

from shared.design_logo import COMPANY_LOGO_MAX_BYTES

SHOT = b'\x89PNG-shot'
LOGO = png_bytes(166, 52)


class FakeTab:
    """The page tab: ISOLATE_JS answers ``box``; every screenshot answers ``SHOT`` (or raises ``shot_error``)."""

    def __init__(self, box: object = ISOLATED_BOX, shot_error: Exception | None = None):
        self.box, self.shot_error = box, shot_error
        self.calls: list[tuple[str, dict]] = []
        self.evaluated: list[str] = []

    def call(self, method: str, params: dict | None = None, timeout: float = 30.0) -> dict:
        del timeout
        self.calls.append((method, dict(params or {})))
        if method == 'Page.captureScreenshot':
            if self.shot_error is not None:
                raise self.shot_error
            return {'data': base64.b64encode(SHOT).decode()}
        return {}

    def evaluate(self, expression: str) -> object:
        self.evaluated.append(expression)
        if expression.startswith(f'({li.ISOLATE_JS})'):
            return json.dumps(self.box) if isinstance(self.box, dict) else self.box
        return True

    def shot_scales(self) -> list[float]:
        return [p['clip']['scale'] for m, p in self.calls if m == 'Page.captureScreenshot']

    def left_as_it_was(self) -> bool:
        """UNDO_JS ran and the default background was reset, last."""
        return (li.undo_expression() in self.evaluated
                and self.calls[-1] == ('Emulation.setDefaultBackgroundColorOverride', {}))


def _isolate(tab: FakeTab, *trimmed: TrimmedPng | None):
    with patch.object(li, 'trim_png', side_effect=list(trimmed)) as trim:
        return li.isolate_logo(tab, MagicMock(), 2), trim


class TestParseBox:
    def test_returns_the_box_and_its_backdrop(self):
        box = li.parse_box(json.dumps({**ISOLATED_BOX, 'backdrop': {'r': 16, 'g': 32, 'b': 48}}))
        assert (box.x, box.y, box.width, box.height, box.backdrop) == (24, 16, 166, 52, {'r': 16, 'g': 32, 'b': 48})

    @pytest.mark.parametrize('backdrop', [{'r': 300, 'g': 0, 'b': 0}, {'r': True, 'g': 0, 'b': 0}, 'black', None])
    def test_drops_an_unreadable_backdrop(self, backdrop):
        assert li.parse_box(json.dumps({**ISOLATED_BOX, 'backdrop': backdrop})).backdrop is None

    @pytest.mark.parametrize(('error', 'reason'), [('gone', 'gone'), ('Bad <b>X</b>!; drop', 'adbbdrop'), ('!!', 'error'),
                                                   ('x' * 50, 'x' * 20)])
    def test_sanitises_the_error_code(self, error, reason):
        with pytest.raises(li.IsolateRefused) as refused:
            li.parse_box(json.dumps({'error': error}))
        assert str(refused.value) == reason

    @pytest.mark.parametrize(('raw', 'reason'), [
        pytest.param(None, 'no_answer', id='none'),
        pytest.param('nope', 'no_answer', id='not-json'),
        pytest.param('[1]', 'no_answer', id='not-a-dict'),
        pytest.param(json.dumps({**ISOLATED_BOX, 'width': 3}), 'empty_box', id='empty'),
        pytest.param(json.dumps({**ISOLATED_BOX, 'x': -1}), 'box_outside_viewport', id='left-of-the-screen'),
        pytest.param(json.dumps({**ISOLATED_BOX, 'y': 880}), 'box_outside_viewport', id='below-the-screen'),
        pytest.param(json.dumps({**ISOLATED_BOX, 'width': True}), 'bad_box', id='bool'),
        pytest.param(json.dumps({**ISOLATED_BOX, 'vw': None}), 'bad_box', id='missing'),
        pytest.param(json.dumps(ISOLATED_BOX).replace('166', 'NaN'), 'bad_box', id='nan'),
    ])
    def test_refuses_an_unusable_answer(self, raw, reason):
        with pytest.raises(li.IsolateRefused, match=f'^{reason}$'):
            li.parse_box(raw)


class TestShotScale:
    @pytest.mark.parametrize(('width', 'height', 'scale'), [
        (160, 40, 4.0),          # small: capped at 4x
        (320, 80, 2.0),          # towards 640 px on the longest side
        (640, 100, 1.0),
        (2000, 100, 1.0),        # never below 1x
    ])
    def test_aims_the_longest_side_at_the_target_within_bounds(self, width, height, scale):
        assert li.shot_scale(width, height) == scale

    def test_never_shoots_past_the_shot_cap(self):
        assert li.shot_scale(200, 10) * 200 <= li.MAX_SHOT_SIDE_PX


class TestIsolateLogo:
    def test_returns_the_trimmed_png_and_leaves_the_page_as_it_was(self):
        tab = FakeTab()
        isolated, trim = _isolate(tab, TrimmedPng(LOGO))
        assert isolated == li.IsolatedLogo(LOGO, None)
        assert trim.call_args.args[1:] == (SHOT, None)
        assert li.isolate_expression(2) in tab.evaluated
        assert ('Emulation.setDefaultBackgroundColorOverride', {'color': li.TRANSPARENT}) in tab.calls
        clip = tab.calls[[m for m, _ in tab.calls].index('Page.captureScreenshot')][1]['clip']
        assert clip == {'x': 24, 'y': 16, 'width': 166, 'height': 52, 'scale': li.shot_scale(166, 52)}
        assert tab.left_as_it_was()

    def test_shoots_again_smaller_when_over_the_company_logo_cap(self):
        tab = FakeTab()
        big = TrimmedPng(b'\x89PNG' + b'0' * COMPANY_LOGO_MAX_BYTES)
        isolated, _ = _isolate(tab, big, TrimmedPng(LOGO))
        assert isolated == li.IsolatedLogo(LOGO, None)
        first, second = tab.shot_scales()
        assert second < first
        assert tab.left_as_it_was()

    def test_scales_for_device_pixels_so_a_retina_page_never_shoots_past_the_cap(self):
        tab = FakeTab(box={**ISOLATED_BOX, 'dpr': 2})
        isolated, _ = _isolate(tab, TrimmedPng(LOGO))
        assert isolated is not None
        assert tab.shot_scales() == [li.shot_scale(166 * 2, 52 * 2)]
        assert 166 * 2 * tab.shot_scales()[0] <= li.MAX_SHOT_SIDE_PX

    @pytest.mark.parametrize(('dpr', 'ratio'), [(None, 1.0), (0.5, 1.0), (3, 3.0), (9, li.MAX_DEVICE_PIXEL_RATIO)])
    def test_reads_the_device_pixel_ratio_within_bounds(self, dpr, ratio):
        box = {**ISOLATED_BOX} if dpr is None else {**ISOLATED_BOX, 'dpr': dpr}
        assert li.parse_box(json.dumps(box)).device_pixel_ratio == ratio

    def test_returns_none_when_every_shot_is_over_the_cap(self):
        tab = FakeTab()
        big = TrimmedPng(b'\x89PNG' + b'0' * COMPANY_LOGO_MAX_BYTES)
        isolated, _ = _isolate(tab, big, big, big)
        assert isolated is None
        assert len(tab.shot_scales()) == li.MAX_SHOTS
        assert tab.left_as_it_was()

    def test_returns_none_when_the_trim_fails(self):
        tab = FakeTab()
        assert _isolate(tab, None)[0] is None
        assert tab.left_as_it_was()

    def test_returns_none_when_the_element_is_gone(self):
        tab = FakeTab(box={'error': 'gone'})
        isolated, trim = _isolate(tab)
        assert isolated is None
        trim.assert_not_called()
        assert tab.left_as_it_was()

    def test_returns_none_and_still_undoes_when_the_screenshot_raises(self):
        tab = FakeTab(shot_error=RuntimeError('Page.captureScreenshot timed out'))
        with patch.object(li, 'logger') as log:
            isolated, _ = _isolate(tab)
        assert isolated is None
        assert tab.left_as_it_was()
        log.info.assert_called_once_with('Logo not isolated', extra={'reason': 'cdp_RuntimeError'})

    def test_returns_none_on_a_cdp_error_in_the_isolating_evaluate(self):
        tab = FakeTab()
        tab.evaluate = MagicMock(side_effect=RuntimeError('closed'))
        assert li.isolate_logo(tab, MagicMock(), 1) is None

    @pytest.mark.parametrize('backdrop', ['#101020', None])
    def test_names_the_backdrop_the_trim_drew_the_logo_on(self, backdrop):
        tab = FakeTab(box={**ISOLATED_BOX, 'backdrop': {'r': 16, 'g': 16, 'b': 32}})
        isolated, trim = _isolate(tab, TrimmedPng(LOGO, backdrop))
        assert isolated == li.IsolatedLogo(LOGO, backdrop)
        assert trim.call_args.args[2] == {'r': 16, 'g': 16, 'b': 32}

    def test_refuses_a_screenshot_that_is_not_base64(self):
        tab = FakeTab()
        tab.call = MagicMock(return_value={'data': '***'})
        assert _isolate(tab, TrimmedPng(LOGO))[0] is None
