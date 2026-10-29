"""A centred page's side margins never become spacing tokens (example.com: "page-padding 203.25px").

The fixture is example.com as the managed browser measured it at a 1440 px viewport: one centred
column whose computed side margins are equal (``auto``), no spacing custom properties.
"""
import json
from unittest.mock import MagicMock

import capture_worker as cw
import page_styles as ps
import pytest
from page_spacing import grounded_spacing, px_value

from shared.design_vision import PageShot

EXAMPLE_COM = {
    'url': 'https://example.com/', 'title': 'Example Domain', 'status': 200,
    'text': 'This domain is for use in documentation examples. ' * 4, 'html': '<html></html>',
    'vars': {}, 'elements': [{'tag': 'body', 'padding': '0px'}, {'tag': 'p', 'padding': '0px'}],
    'colors': [{'value': 'rgb(0, 0, 0)', 'count': 6}], 'lengths': [{'value': '12.8px', 'count': 2}], 'fonts': [],
    'logos': [], 'auto_margins': ['203.25px', '288px'],
    'components': {'links': [{'padding': '0px 0px 0px 0px', 'gap': 'normal'}]},
}
ANSWER = json.dumps({
    'summary': 'A minimal placeholder page.',
    'spacing': [{'name': 'page-padding', 'value': '203.25px'}, {'name': 'column-gutter', 'value': '288px'},
                {'name': 'paragraph-gap', 'value': '16px'}, {'name': 'note-gap', 'value': '12.8px'},
                {'name': 'section', 'value': '2rem'}, {'name': 'odd', 'value': '37.5px'}],
})


def _page() -> ps.PageStyles:
    styles = ps.parse_page_styles(json.dumps(EXAMPLE_COM), 'https://example.com/')
    assert styles is not None
    return styles


def test_the_centred_pages_margins_are_read_from_the_page():
    styles = _page()
    assert styles.auto_margins == ['203.25px', '288px']
    assert 'centring(s)' in ps.STYLES_JS


def test_example_com_keeps_only_the_spacing_the_page_really_uses():
    _, extracted = cw.design_from_page(
        cw.CapturedPage(_page(), (PageShot('fold', b'png', 'png', 1320, 870),)),
        cw.CaptureDeps(table=None, kit=MagicMock(), summarise_images=MagicMock(return_value=ANSWER)))
    assert extracted is not None
    assert extracted['spacing'] == [{'name': 'paragraph-gap', 'value': '16px'}, {'name': 'note-gap', 'value': '12.8px'},
                                    {'name': 'section', 'value': '2rem'}]


def test_a_fraction_nobody_measured_is_dropped_but_a_measured_one_kept():
    styles = _page()
    styles.auto_margins = []
    kept = grounded_spacing([{'name': 'a', 'value': '203.25px'}, {'name': 'b', 'value': '12.8px'}], styles)
    assert kept == [{'name': 'b', 'value': '12.8px'}]


def test_a_margin_within_half_a_pixel_of_a_centring_margin_is_dropped():
    assert grounded_spacing([{'name': 'gutter', 'value': '288.4px'}, {'name': 'md', 'value': '24px'}], _page()) == [
        {'name': 'md', 'value': '24px'}]


@pytest.mark.parametrize(('value', 'expected'), [('12.5px', 12.5), (' 8px ', 8.0), ('2rem', None), ('auto', None), (3, None)])
def test_px_value(value, expected):
    assert px_value(value) == expected
