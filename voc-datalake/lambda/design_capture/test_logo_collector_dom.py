"""The page collector's logo choice (``page_styles.STYLES_JS``) run in a real DOM: jsdom under node, from the
frontend's node_modules (the ``jsdom_env`` fixture, conftest.py; skipped where either is missing).

Regression (5.39.01): on a site whose cookie-consent banner comes BEFORE the header in the markup and names
its vendor image "… logo", the collector proposed the banner's SVG as the company logo. The consent plugin
also tags <body> with its own class, so a plain ``closest(consent)`` check refused every image on the page.
jsdom has no layout, so each image's box comes from ``data-box="width height top"``. Since 5.48 the same
evaluate also lists the page's icon links and its web manifest (copied locally, ``page_icons``).
"""
import page_styles as ps
import pytest

SITE = 'https://brand.example/'

PAGE = """<!doctype html><html><head>
<link rel="apple-touch-icon" href="/fav.png" sizes="180x180">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="stylesheet" href="/site.css">
<link rel="manifest" href="/site.webmanifest"></head>
<body class="home wcc-consent-banner-active">
<div class="wcc-modal"><img alt="Vendor logo" src="/plugins/consent/vendor.svg" data-box="0 0 0"></div>
<div id="cookie-banner"><img alt="Consent provider logo" src="/plugins/consent/provider.svg" data-box="90 20 5"></div>
<header><div class="site-logo"><a href="/"><img alt="Brand" src="/uploads/brand-logo.svg" data-box="166 52 65"></a></div>
<nav><img alt="Menu icon" src="/uploads/menu.svg" data-box="24 24 70"></nav></header>
<footer><img alt="Brand logo" src="/uploads/brand-logo-footer.svg" data-box="120 40 4400"></footer>
<img alt="Hidden logo" src="/uploads/hidden-logo.svg" data-box="0 0 0">
</body></html>"""


def _collect(env, html: str) -> dict:
    data = env.evaluate(html, ps.styles_expression(), SITE, 'HTMLImageElement')
    assert isinstance(data, dict)
    return {key: data.get(key) for key in ('logos', 'icons', 'manifest')}


def _header_urls(logos: list[dict]) -> list[str]:
    return [logo['url'] for logo in logos if logo['kind'] == 'header']


@pytest.fixture(scope='module')
def collected(jsdom_env) -> dict:
    return _collect(jsdom_env, PAGE)


@pytest.fixture(scope='module')
def logos(collected) -> list[dict]:
    return collected['logos']


def test_the_header_logo_comes_first_and_no_consent_banner_image_is_proposed(logos):
    header = _header_urls(logos)
    assert header[0] == f'{SITE}uploads/brand-logo.svg'
    assert not any('/plugins/consent/' in url for url in header)


def test_a_consent_class_on_body_does_not_hide_the_page_logos(logos):
    assert f'{SITE}uploads/brand-logo-footer.svg' in _header_urls(logos)


def test_hidden_logo_images_are_skipped_and_framed_ones_rank_above_the_rest(logos):
    assert _header_urls(logos) == [f'{SITE}uploads/brand-logo.svg', f'{SITE}uploads/menu.svg',
                                   f'{SITE}uploads/brand-logo-footer.svg']


def test_the_rendered_svg_is_the_site_logo_not_the_touch_icon(logos, monkeypatch):
    # brand.example does not resolve; the URL policy itself is covered by test_svg_logo_render.py.
    monkeypatch.setattr(ps, 'validate_url', lambda _url: (True, ''))
    assert ps.svg_logo_to_render(logos) == f'{SITE}uploads/brand-logo.svg'


def test_every_icon_link_and_the_manifest_are_listed_with_absolute_urls(collected):
    assert collected['icons'] == [
        {'url': f'{SITE}fav.png', 'rel': 'apple-touch-icon', 'sizes': '180x180'},
        {'url': f'{SITE}favicon-32.png', 'rel': 'icon', 'sizes': '32x32'},
        {'url': f'{SITE}favicon.ico', 'rel': 'shortcut icon', 'sizes': ''},
    ]
    assert collected['manifest'] == f'{SITE}site.webmanifest'
