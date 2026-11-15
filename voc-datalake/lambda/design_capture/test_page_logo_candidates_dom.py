"""The logo-candidate collector (``page_logo_candidates.CANDIDATES_JS``) run in a real DOM: jsdom under node, from the
frontend's node_modules (the ``jsdom_env`` fixture, conftest.py; skipped where either is missing).

jsdom has no layout, so every element's box comes from ``data-box="width height top"`` (``element='Element'``).
Regression (5.39.01, kept): a cookie-consent banner that comes BEFORE the header and names its vendor image
"… logo" — its image is listed but flagged ``in_consent``, so the rules never take it (``test_page_logo_candidates``)
and the pick prompt says it is not the logo (``test_logo_pick``); a consent class on <body> flags nothing.
"""
import json

import pytest
from page_logo_candidates import STASH, TOP_PX, candidates_expression, parse_candidates, rules_pick

SITE = 'https://brand.example/'

PAGE = f"""<!doctype html><html><head>
<link rel="apple-touch-icon" href="/touch.png" sizes="180x180"><link rel="icon" href="/favicon-32.png" sizes="32x32">
<meta property="og:image" content="/share-card.png"></head>
<body class="home wcc-consent-banner-active">
<div id="cookie-banner"><img alt="Consent provider logo" src="/plugins/consent/vendor.svg" data-box="90 20 5"></div>
<header>
  <a href="/" aria-label="Home"><img alt="Brand" src="/uploads/brand-logo.png" data-box="166 52 10"></a>
  <a href="/"><svg xmlns="http://www.w3.org/2000/svg" data-box="120 30 12"><path d="M0 0"/></svg></a>
  <div class="brand-logo" style="background-image: url('/sprite.png')" data-box="100 40 14"></div>
  <a href="/" class="wordmark" data-box="90 24 16">Kiro Crew</a>
  <div id="host" data-box="80 30 18"></div>
  <img alt="Hidden" src="/hidden.png" data-box="0 0 20">
</header>
<img alt="Below the band" src="/far.png" data-box="100 100 {TOP_PX + 1}">
</body></html>"""

#: Builds an open shadow root on #host before the collector runs (the runner evaluates the whole expression).
SHADOW = ("(() => { const root = document.getElementById('host').attachShadow({ mode: 'open' });"
          " root.innerHTML = '<img alt=\"Shadow\" src=\"/shadow.png\" data-box=\"60 30 20\">'; })();")


def _collect(env, html: str = PAGE, prefix: str = SHADOW) -> dict:
    """The collector's answer (the runner prints the JSON string the page returns, decoded once)."""
    data = env.evaluate(html, prefix + candidates_expression(), SITE, 'Element')
    assert isinstance(data, dict)
    return data


@pytest.fixture(scope='module')
def collected(jsdom_env) -> dict:
    return _collect(jsdom_env)


def _by_url(collected: dict, url: str) -> dict:
    found, = [c for c in collected['candidates'] if c['url'] == url]
    return found


def test_lists_each_kind_of_candidate_numbered_in_reading_order(collected):
    assert [(c['n'], c['kind']) for c in collected['candidates']] == [
        (1, 'img'), (2, 'img'), (3, 'inline-svg'), (4, 'css-bg'), (5, 'text'), (6, 'img')]


def test_records_the_header_image_with_its_labels_box_and_home_link(collected):
    logo = _by_url(collected, f'{SITE}uploads/brand-logo.png')
    assert logo['box'] == {'x': 0, 'y': 10, 'w': 166, 'h': 52}
    assert (logo['label'], logo['link_label'], logo['in_header'], logo['home_link'], logo['in_consent']) == (
        'Brand', 'Home', True, True, False)


def test_reads_a_css_background_and_a_text_wordmark(collected):
    assert _by_url(collected, f'{SITE}sprite.png')['classes'].startswith('brand-logo < ')   # its class chain
    text, = [c for c in collected['candidates'] if c['kind'] == 'text']
    assert (text['text'], text['home_link'], text['url']) == ('Kiro Crew', True, None)


def test_flags_the_consent_banner_image_and_nothing_else(collected):
    flagged = [c['url'] for c in collected['candidates'] if c['in_consent']]
    assert flagged == [f'{SITE}plugins/consent/vendor.svg']   # the consent class on <body> flags nothing


def test_lists_an_image_inside_an_open_shadow_root(collected):
    shadow = _by_url(collected, f'{SITE}shadow.png')
    assert (shadow['label'], shadow['in_header']) == ('Shadow', True)
    assert '#host' in shadow['classes']


def test_never_lists_og_image_a_hidden_image_or_one_below_the_band(collected):
    urls = [c['url'] for c in collected['candidates']] + [h['url'] for h in collected['head']]
    assert f'{SITE}share-card.png' not in urls
    assert f'{SITE}hidden.png' not in urls
    assert f'{SITE}far.png' not in urls


def test_lists_the_head_icons_apart(collected):
    assert collected['head'] == [{'kind': 'touch-icon', 'url': f'{SITE}touch.png', 'sizes': '180x180'},
                                 {'kind': 'icon', 'url': f'{SITE}favicon-32.png', 'sizes': '32x32'}]


def test_the_rules_take_the_home_link_logo_never_the_consent_vendor(collected):
    found = parse_candidates(json.dumps(collected), SITE)
    assert len(found.candidates) == 6
    assert rules_pick(found) == 2


def test_stashes_the_listed_elements_on_the_window(jsdom_env):
    expression = f'{SHADOW}{candidates_expression()}; window[{json.dumps(STASH)}].map((el) => el.tagName.toLowerCase())'
    assert jsdom_env.evaluate(PAGE, expression, SITE, 'Element') == ['img', 'img', 'svg', 'div', 'a', 'img']


def test_returns_no_candidates_for_a_page_without_any(jsdom_env):
    data = _collect(jsdom_env, '<!doctype html><html><body><p data-box="300 20 10">Hello</p></body></html>', '')
    assert (data['candidates'], data['head']) == ([], [])
