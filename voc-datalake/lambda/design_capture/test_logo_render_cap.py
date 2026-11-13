"""A browser-rendered logo always fits the 1 MB company-logo cap, so "Use this logo" can always use it.

A PNG over the cap at 1024 px is drawn again at 768, then 512 px; one still over it is given up (no logo).
"""
from unittest.mock import MagicMock, patch

import logo_render

from shared.design_logo import COMPANY_LOGO_MAX_BYTES

SMALL = b'\x89PNG' + b'0' * 100
BIG = b'\x89PNG' + b'0' * COMPANY_LOGO_MAX_BYTES


def _render(*answers):
    with patch.object(logo_render, '_render_once', side_effect=list(answers)) as once:
        png = logo_render.render_svg_logo(MagicMock(), 'https://www.example.com/logo.png', what='Oversized logo')
    return png, [call.args[3] for call in once.call_args_list]


def test_a_png_within_the_cap_is_drawn_once_at_1024_px():
    assert _render(SMALL) == (SMALL, [1024])


def test_a_png_over_the_cap_is_drawn_again_smaller_until_it_fits():
    assert _render(BIG, SMALL) == (SMALL, [1024, 768])
    assert _render(BIG, BIG, SMALL) == (SMALL, [1024, 768, 512])


def test_a_png_over_the_cap_at_every_size_is_no_logo():
    assert _render(BIG, BIG, BIG) == (None, [1024, 768, 512])


def test_a_failed_render_is_not_retried():
    assert _render(None) == (None, [1024])


def test_the_side_reaches_the_viewport_and_the_in_page_limits():
    tab = MagicMock()
    tab.render.return_value = SMALL
    with patch.object(logo_render, '_RenderTab', return_value=tab):
        assert logo_render._render_once(MagicMock(), 'https://www.example.com/logo.png', 'Logo', 768) == SMALL
    tab.render.assert_called_once_with('https://www.example.com/logo.png', 768)
    tab.close.assert_called_once()
