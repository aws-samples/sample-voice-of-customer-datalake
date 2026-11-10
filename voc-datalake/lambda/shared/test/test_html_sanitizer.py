"""shared/html_sanitizer.py: a component's example_html is rebuilt from an allowlist (deny by default)."""
import pytest

from shared.html_sanitizer import clean_attribute, clean_style, sanitize_html


class TestDenied:
    @pytest.mark.parametrize(('raw', 'expected'), [
        ('<img src=x onerror=alert(1)>', '<img>'),
        ('<img src="https://cdn.example/a.png" onerror="alert(1)">', '<img src="https://cdn.example/a.png">'),
        ('<a href="javascript:alert(1)">x</a>', '<a>x</a>'),
        ('<a href="java&#115;cript:alert(1)">x</a>', '<a>x</a>'),
        ('<a href=" jav\tascript:alert(1)">x</a>', '<a>x</a>'),
        ('<a href="http://plain.example/">x</a>', '<a>x</a>'),
        ('<a href="data:text/html,<script>1</script>">x</a>', '<a>x</a>'),
        ('<script>alert(1)</script>Hi', 'Hi'),
        ('<SCRIPT src="https://e.example/x.js"></SCRIPT>Hi', 'Hi'),
        ('<style>body{background:url(x)}</style>Hi', 'Hi'),
        ('<iframe src="https://e.example" srcdoc="<script>1</script>"></iframe>Hi', 'Hi'),
        ('<object data="x"><embed src="y"></object>Hi', 'Hi'),
        ('<form action="https://evil.example"><button formaction="https://e">Go</button></form>',
         '<button>Go</button>'),
        ('<!-- secret --><!DOCTYPE html>Hi', 'Hi'),
        ('<div onclick="x()" onmouseover="y()">Hi</div>', '<div>Hi</div>'),
        ('<svg><use href="#a"></use><foreignObject><div>x</div></foreignObject></svg>', '<svg></svg>'),
        ('<img src="data:image/svg+xml;base64,PHN2Zz4=">', '<img>'),
        ('<div><link rel="stylesheet" href="https://e"><p>ok', '<div><p>ok</p></div>'),
        ('<math><mi>x</mi></math>Hi', 'Hi'),
        ('<textarea><img src=x onerror=1></textarea>Hi', 'Hi'),
    ])
    def test_dangerous_markup_never_survives(self, raw, expected):
        assert sanitize_html(raw) == expected

    def test_unknown_elements_are_unwrapped_keeping_text(self):
        assert sanitize_html('<section class="card"><b>Bold</b> <em>text</em></section>') == 'Bold text'

    def test_text_and_attributes_are_re_escaped(self):
        assert sanitize_html('<p title="x">1 &lt; 2 &amp; "q"</p>') == '<p>1 &lt; 2 &amp; "q"</p>'
        assert sanitize_html('<span class="a&quot; onclick=&quot;x">t</span>') == (
            '<span class="a&quot; onclick=&quot;x">t</span>')


class TestAllowed:
    def test_a_button_card_and_input_keep_their_safe_attributes(self):
        raw = ('<div class="card" role="group" aria-label="Plan"><h3>Pro</h3>'
               '<button type="button" class="btn btn-primary" style="background: #7c3aed; color: #fff">Buy</button>'
               '<input type="email" placeholder="you@example.com"><a href="#top">Top</a>'
               '<a href="https://kiro.dev/docs">Docs</a></div>')
        assert sanitize_html(raw) == raw

    def test_raster_data_images_and_svg_shapes_pass(self):
        assert sanitize_html('<img alt="logo" src="data:image/png;base64,iVBORw0KGgo=">') == (
            '<img alt="logo" src="data:image/png;base64,iVBORw0KGgo=">')
        assert sanitize_html('<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" fill="none"/></svg>') == (
            '<svg viewbox="0 0 24 24"><circle cx="11" cy="11" r="8" fill="none"></circle></svg>')

    def test_unbalanced_markup_is_balanced(self):
        assert sanitize_html('<div><span>a</div></p><li>b') == '<div><span>a</span></div><li>b</li>'


class TestStyle:
    @pytest.mark.parametrize(('raw', 'expected'), [
        ('color: #fff; background: rgb(1, 2, 3)', 'color: #fff; background: rgb(1, 2, 3)'),
        ('background: url(https://e/x.png); color: red', 'color: red'),
        ('width: expression(alert(1))', ''),
        ('background-image: image-set("x.png" 1x)', ''),
        ('color: re\\64', ''),
        ('@import "x"; color: red', ''),
        ('color: red /* c */', ''),
        ('-moz-binding: x', ''),
        ('padding: calc(var(--x) + 2px)', 'padding: calc(var(--x) + 2px)'),
        ('color', ''),
    ])
    def test_declarations(self, raw, expected):
        assert clean_style(raw) == expected

    def test_an_empty_style_is_dropped(self):
        assert clean_attribute('div', 'style', 'background: url(x)') is None
        assert sanitize_html('<div style="background:url(x)">a</div>') == '<div>a</div>'

    @pytest.mark.parametrize('name', ['onclick', 'srcdoc', 'formaction', 'action', 'target', 'xlink:href', 'id'])
    def test_other_attributes_are_denied(self, name):
        assert clean_attribute('div', name, 'x') is None

    def test_svg_values_must_be_geometry(self):
        assert clean_attribute('path', 'd', 'M0 0 L10 10 Z') == 'M0 0 L10 10 Z'
        assert clean_attribute('rect', 'fill', 'url(#gradient)') is None
        assert clean_attribute('div', 'd', 'M0 0') is None
