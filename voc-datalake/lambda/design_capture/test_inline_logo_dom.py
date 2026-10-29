"""The inline-SVG logo collector (``page_inline_logo.INLINE_LOGO_JS``) run in a real DOM: jsdom under node,
from the frontend's node_modules (the ``jsdom_env`` fixture, conftest.py; skipped where either is missing).

jsdom has no layout, so each SVG's box comes from ``data-box="width height top"``. Pins: the logo is the SVG in
a logo / brand container or a link to the site root inside the header, never a small icon, a cookie-banner
image or a nested SVG; a sprite's ``<use href="#id">`` gets its symbol copied in; the answer carries the box.
"""
import json

import page_inline_logo as pil
import pytest

SITE = 'https://brand.example/'

SVG = 'xmlns="http://www.w3.org/2000/svg"'
PAGE = f"""<!doctype html><html><body>
<div id="cookie-banner"><a href="/"><svg {SVG} class="vendor-logo" data-box="90 30 5"><rect width="9" height="3"/></svg></a></div>
<header>
  <button aria-label="Search"><svg {SVG} data-box="16 16 20"><circle r="8"/></svg></button>
  <a href="/" class="home"><svg {SVG} viewBox="0 0 166 52" data-box="166 52 20"><use href="#mark"/>
    <svg {SVG} data-box="40 40 20"><rect width="4" height="4"/></svg></svg></a>
  <nav><svg {SVG} data-box="120 24 22"><path d="M0 0h1"/></svg></nav>
</header>
<svg {SVG} style="display:none"><symbol id="mark" viewBox="0 0 10 10"><path d="M0 0h10v10z"/></symbol></svg>
</body></html>"""


def _collect(env, html: str) -> object:
    return env.evaluate(html, pil.inline_logo_expression(), SITE, 'SVGElement')


@pytest.fixture(scope='module')
def answer(jsdom_env):
    return _collect(jsdom_env, PAGE)


def test_the_root_link_svg_in_the_header_is_the_logo(answer):
    assert isinstance(answer, dict)
    assert (answer['width'], answer['height']) == (166, 52)
    assert 'viewBox="0 0 166 52"' in answer['svg']


def test_the_sprite_symbol_travels_with_it(answer):
    assert '<symbol id="mark"' in answer['svg']


def test_its_parsed_answer_is_usable(answer):
    parsed = pil.parse_inline_logo(json.dumps(answer))
    assert parsed is not None
    assert parsed.width == 166


def test_a_page_with_only_icons_and_a_consent_logo_has_none(jsdom_env):
    html = (f'<!doctype html><html><body><div class="cookie-consent"><a href="/"><svg {SVG} class="logo" '
            f'data-box="90 30 5"><rect width="1" height="1"/></svg></a></div><header><button><svg {SVG} '
            f'class="logo-icon" data-box="16 16 20"><circle r="8"/></svg></button></header></body></html>')
    assert _collect(jsdom_env, html) is None
