"""The inline-SVG copy (``page_inline_logo.INLINE_SVG_JS``) run in a real DOM: jsdom under node, from the frontend's
node_modules (the ``jsdom_env`` fixture, conftest.py; skipped where either is missing).

The collector (``page_logo_candidates.CANDIDATES_JS``) runs first in the same evaluate and stashes the candidates;
the copy then serialises stashed candidate ``n``. jsdom has no layout, so each box comes from
``data-box="width height top"``. Pins: the copy is of exactly that candidate; a sprite's ``<use href="#id">`` gets its
symbol copied in; the answer carries the box; a candidate that is not an ``<svg>`` gives null.
"""
import json

import page_inline_logo as pil
import pytest
from page_logo_candidates import candidates_expression

SITE = 'https://brand.example/'

SVG = 'xmlns="http://www.w3.org/2000/svg"'
PAGE = f"""<!doctype html><html><body>
<header>
  <a href="/" class="home"><img alt="Brand" src="/brand.png" data-box="40 40 10"></a>
  <a href="/" class="home"><svg {SVG} viewBox="0 0 166 52" data-box="166 52 20"><use href="#mark"/></svg></a>
</header>
<svg {SVG} style="display:none"><symbol id="mark" viewBox="0 0 10 10"><path d="M0 0h10v10z"/></symbol></svg>
</body></html>"""


def _copy(env, number: int) -> object:
    """The copy's answer (the runner decodes the JSON string the page returns)."""
    return env.evaluate(PAGE, f'{candidates_expression()}; {pil.inline_svg_expression(number)}', SITE, 'Element')


@pytest.fixture(scope='module')
def answer(jsdom_env):
    return _copy(jsdom_env, 2)


def test_returns_the_picked_svg_with_its_box(answer):
    assert isinstance(answer, dict)
    assert (answer['width'], answer['height']) == (166, 52)
    assert 'viewBox="0 0 166 52"' in answer['svg']


def test_copies_the_sprite_symbol_in(answer):
    assert '<symbol id="mark"' in answer['svg']


def test_its_parsed_answer_is_usable(answer):
    parsed = pil.parse_inline_logo(json.dumps(answer))
    assert parsed is not None
    assert parsed.width == 166


def test_returns_null_when_the_candidate_is_not_an_svg(jsdom_env):
    assert _copy(jsdom_env, 1) is None


def test_returns_null_for_a_number_that_was_never_listed(jsdom_env):
    assert _copy(jsdom_env, 9) is None
