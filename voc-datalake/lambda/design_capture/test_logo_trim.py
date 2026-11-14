"""An isolated logo shot trimmed to its painted pixels in a fresh about:blank tab (``logo_render.trim_png``).

A fake CDP connection answers the trim tab's commands; the PNGs are real (``png_check`` reads them). Pins: a good
PNG is accepted with the ``backdrop`` it was drawn on (``#rrggbb``, a malformed colour dropped); the shot reaches the page only as a ``data:`` URL argument; a PNG the
check refuses, an error answer or a CDP failure is None; the tab is always closed.
"""
import base64

import logo_render
import pytest
from test_design_capture_worker import png_bytes

from shared.design_logo import COMPANY_LOGO_MAX_BYTES

SHOT = png_bytes(332, 104)
TRIMMED = png_bytes(166, 52)
BACKDROP = {'r': 16, 'g': 16, 'b': 32}


class TrimCdp:
    """The browser: one fresh tab whose TRIM_JS call answers ``answer`` (or raises ``error``)."""

    def __init__(self, answer: object = None, error: Exception | None = None, target: object = 't9'):
        self.answer, self.error, self.target = answer, error, target
        self.calls: list[tuple[str, dict, str | None]] = []

    def call(self, method: str, params: dict | None = None, *, session_id: str | None = None,
             timeout: float = 30.0) -> dict:
        del timeout
        self.calls.append((method, dict(params or {}), session_id))
        if method == 'Target.createTarget':
            return {'targetId': self.target}
        if method == 'Target.attachToTarget':
            return {'sessionId': 'trim-1'}
        if method == 'Runtime.evaluate':
            return {'result': {'objectId': 'doc-9'}}
        if method == 'Runtime.callFunctionOn':
            if self.error is not None:
                raise self.error
            return {'result': {'value': self.answer}}
        return {}

    def closed(self) -> bool:
        return ('Target.closeTarget', {'targetId': self.target}, None) in self.calls


def _answer(png: bytes, backdrop: object = None) -> dict:
    return {'data': base64.b64encode(png).decode(), 'backdrop': backdrop}


def test_returns_the_trimmed_png_and_closes_the_tab():
    cdp = TrimCdp(_answer(TRIMMED, backdrop={'r': 16, 'g': 16, 'b': 32}))
    assert logo_render.trim_png(cdp, SHOT, BACKDROP) == logo_render.TrimmedPng(TRIMMED, '#101020')
    assert cdp.closed()


def test_hands_the_shot_over_as_a_data_url_argument_with_the_backdrop():
    cdp = TrimCdp(_answer(TRIMMED))
    logo_render.trim_png(cdp, SHOT, BACKDROP)
    (_, call, session), = [c for c in cdp.calls if c[0] == 'Runtime.callFunctionOn']
    assert session == 'trim-1'
    assert call['functionDeclaration'] == logo_render.TRIM_JS
    assert call['arguments'][0] == {'value': 'data:image/png;base64,' + base64.b64encode(SHOT).decode()}
    assert call['arguments'][1] == {'value': BACKDROP}
    assert call['arguments'][2] == {'value': logo_render.TRIM_LIMITS}
    assert call['awaitPromise'] is True


@pytest.mark.parametrize('backdrop', [{'r': 300, 'g': 0, 'b': 0}, {'r': True, 'g': 0, 'b': 0}, 'black', [0, 0, 0]])
def test_drops_a_backdrop_that_is_not_an_rgb_colour(backdrop):
    assert logo_render.trim_png(TrimCdp(_answer(TRIMMED, backdrop)), SHOT, None) == logo_render.TrimmedPng(TRIMMED)


@pytest.mark.parametrize('png', [
    pytest.param(png_bytes(166, 52, b'\x00\x00\x00\x00'), id='blank'),
    pytest.param(png_bytes(4, 52), id='too-small'),
    pytest.param(b'\xff\xd8\xff' + b'1' * 64, id='not-png'),
    pytest.param(b'\x89PNG\r\n\x1a\n' + b'\x00' * (2 * COMPANY_LOGO_MAX_BYTES + 1), id='too-large'),
])
def test_returns_none_when_the_png_check_refuses_the_trimmed_png(png):
    cdp = TrimCdp(_answer(png))
    assert logo_render.trim_png(cdp, SHOT, None) is None
    assert cdp.closed()


@pytest.mark.parametrize('answer', [
    pytest.param({'error': 'nothing_painted'}, id='error'),
    pytest.param(None, id='no-answer'),
    pytest.param('PNG', id='not-a-dict'),
    pytest.param({'data': '***', 'backdrop': None}, id='not-base64'),
])
def test_returns_none_for_an_unusable_answer(answer):
    cdp = TrimCdp(answer)
    assert logo_render.trim_png(cdp, SHOT, None) is None
    assert cdp.closed()


def test_returns_none_and_closes_the_tab_on_a_cdp_error():
    cdp = TrimCdp(error=RuntimeError('Runtime.callFunctionOn timed out'))
    assert logo_render.trim_png(cdp, SHOT, None) is None
    assert cdp.closed()


def test_returns_none_when_no_tab_opens():
    cdp = TrimCdp(target=None)
    assert logo_render.trim_png(cdp, SHOT, None) is None
    assert 'Target.closeTarget' not in [c[0] for c in cdp.calls]
