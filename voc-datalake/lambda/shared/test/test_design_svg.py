"""An SVG logo is rebuilt deny-by-default before the browser draws it (shared/design_svg.py).

Pins: script, foreignObject, style, image, links and animation elements are gone WITH their content;
every on* handler, external href and non-local url() is gone; a DOCTYPE / entity is refused before
parsing (no billion laughs); the root always gets a usable size; the output is standalone SVG.
"""
import base64

import pytest

from shared import design_svg as ds

NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'
HOSTILE = (
    f'<svg {NS} viewBox="0 0 120 40" onload="steal()">'
    '<script>alert(1)</script>'
    '<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'
    '<style>@import url(https://tracker.example/a.css);</style>'
    '<image href="https://tracker.example/pixel.png" width="1" height="1"/>'
    '<a href="javascript:alert(1)"><rect width="5" height="5"/></a>'
    '<set attributeName="href" to="javascript:alert(1)"/>'
    '<linearGradient id="g"><stop offset="0" stop-color="#7c3aed"/></linearGradient>'
    '<path d="M0 0h120v40H0z" fill="url(#g)" onclick="x()" style="fill:url(https://tracker.example/f);stroke:#111"/>'
    '<use xlink:href="https://tracker.example/sprite.svg#a"/>'
    '<use href="#g"/>'
    '<rect width="10" height="10" fill="url(https://tracker.example/x)"/>'
    '</svg>'
)


class TestHostileMarkupIsRemoved:
    @pytest.fixture(scope='class')
    def clean(self):
        return ds.sanitize_svg(HOSTILE)

    @pytest.mark.parametrize('needle', [
        'script', 'alert', 'foreignObject', 'xhtml', '<style', '@import', 'image', 'javascript', '<a ', '<set',
        'onload', 'onclick', 'tracker.example', 'steal'])
    def test_nothing_active_or_external_survives(self, clean, needle):
        assert needle not in clean

    def test_the_drawing_survives_with_local_references(self, clean):
        assert '<linearGradient id="g">' in clean
        assert 'fill="url(#g)"' in clean
        assert 'style="stroke:#111"' in clean
        assert '<use href="#g" />' in clean
        assert 'viewBox="0 0 120 40"' in clean

    def test_the_output_is_a_standalone_sized_svg(self, clean):
        assert clean.startswith('<svg xmlns="http://www.w3.org/2000/svg"')
        assert 'width="120" height="40"' in clean


class TestRefusals:
    @pytest.mark.parametrize(('markup', 'reason'), [
        ('<!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><svg>&b;</svg>', 'doctype_or_entity'),
        ('<?xml-stylesheet href="https://tracker.example/a.css"?><svg/>', 'doctype_or_entity'),
        ('<html><body/></html>', 'not_svg'),
        ('<svg><path', 'not_xml'),
        ('', 'empty'),
        (f'<svg {NS} width="10" height="10"><script>x</script></svg>', 'nothing_drawn'),
        (f'<svg {NS}><rect width="1" height="1"/></svg>', 'no_size'),
    ])
    def test_refused(self, markup, reason):
        with pytest.raises(ds.SvgRefused, match=reason):
            ds.sanitize_svg(markup)

    def test_an_entity_reaching_the_parser_is_still_refused(self):
        """The regex pre-check is not the only wall: the expat handlers refuse a DOCTYPE too."""
        with pytest.raises(ds.SvgRefused, match='doctype_or_entity'):
            ds._parse('<!DOCTYPE svg [<!ENTITY a "x">]><svg/>')

    def test_too_many_elements(self):
        rects = '<rect width="1" height="1"/>' * (ds.MAX_ELEMENTS + 1)
        with pytest.raises(ds.SvgRefused, match='too_many_elements'):
            ds.sanitize_svg(f'<svg {NS} width="1" height="1">{rects}</svg>')

    def test_oversized_input_bytes(self):
        with pytest.raises(ds.SvgRefused, match='too_large'):
            ds.sanitize_svg(b' ' * (ds.MAX_SVG_INPUT_BYTES + 1))


class TestSize:
    def test_a_measured_box_sizes_a_root_without_one(self):
        clean = ds.sanitize_svg(f'<svg {NS}><rect width="1" height="1"/></svg>', box=(166, 52))
        assert 'width="166" height="52"' in clean

    def test_its_own_size_wins_over_the_box(self):
        clean = ds.sanitize_svg(f'<svg {NS} width="40px" height="20"><rect width="1" height="1"/></svg>', box=(166, 52))
        assert 'width="40px" height="20"' in clean

    def test_an_unnamespaced_svg_comes_out_namespaced_with_camel_case_kept(self):
        clean = ds.sanitize_svg('<svg viewBox="0 0 8 8"><clipPath id="c"><rect width="8" height="8"/></clipPath>'
                                '<g clip-path="url(#c)"><circle r="4" cx="4" cy="4"/></g></svg>')
        assert clean.startswith('<svg xmlns="http://www.w3.org/2000/svg"')
        assert '<clipPath id="c">' in clean
        assert 'viewBox="0 0 8 8"' in clean


def test_the_data_url_carries_the_markup_and_needs_no_network():
    url = ds.svg_data_url('<svg/>')
    assert url.startswith('data:image/svg+xml;base64,')
    assert base64.b64decode(url.split(',', 1)[1]) == b'<svg/>'
