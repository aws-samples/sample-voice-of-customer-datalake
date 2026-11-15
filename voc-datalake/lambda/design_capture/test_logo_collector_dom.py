"""The page-styles collector (``page_styles.STYLES_JS``) run in a real DOM: jsdom under node, from the frontend's
node_modules (the ``jsdom_env`` fixture, conftest.py; skipped where either is missing).

Since 7.01.00 it no longer looks for the logo (``page_logo_candidates`` does, ``test_page_logo_candidates_dom``): it
lists the page's icon links and web manifest for the local icon copies (``page_icons``), and ``og:image`` is never
one of them. jsdom has no layout, so each image's box comes from ``data-box="width height top"``.
"""
import page_styles as ps
import pytest

SITE = 'https://brand.example/'

PAGE = """<!doctype html><html><head>
<link rel="apple-touch-icon" href="/fav.png" sizes="180x180">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="stylesheet" href="/site.css">
<link rel="manifest" href="/site.webmanifest">
<meta property="og:image" content="/share-card.png"></head>
<body class="home wcc-consent-banner-active">
<div id="cookie-banner"><img alt="Consent provider logo" src="/plugins/consent/provider.svg" data-box="90 20 5"></div>
<header><a href="/"><img alt="Brand" src="/uploads/brand-logo.svg" data-box="166 52 65"></a></header>
</body></html>"""


@pytest.fixture(scope='module')
def collected(jsdom_env) -> dict:
    data = jsdom_env.evaluate(PAGE, ps.styles_expression(), SITE, 'HTMLImageElement')
    assert isinstance(data, dict)
    return data


def test_lists_every_icon_link_and_the_manifest_with_absolute_urls(collected):
    assert collected['icons'] == [
        {'url': f'{SITE}fav.png', 'rel': 'apple-touch-icon', 'sizes': '180x180'},
        {'url': f'{SITE}favicon-32.png', 'rel': 'icon', 'sizes': '32x32'},
        {'url': f'{SITE}favicon.ico', 'rel': 'shortcut icon', 'sizes': ''},
    ]
    assert collected['manifest'] == f'{SITE}site.webmanifest'


def test_returns_no_logo_list_and_never_the_share_card(collected):
    assert 'logos' not in collected
    assert 'share-card' not in str(collected['icons'])
