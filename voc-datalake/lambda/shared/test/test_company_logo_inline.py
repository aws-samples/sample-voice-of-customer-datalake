"""shared.company_logo.inline_logo where the placeholder sits (review of 7.00.00).

Pins: the no-logo wordmark carries no quotes or attributes (a placeholder inside a double-quoted JS string stays
valid script); only placeholder ``<img>`` tags take one of the two uses (a comment, a CSS ``url()`` or a script
never does, and becomes the blank image); the placeholder matches in any case; the ``<img>`` match is bounded;
the use count is returned, and ``logo_record`` turns it into the derivation's ``company_logo_included``.
"""
import time

import pytest

from shared.company_logo import BLANK_IMAGE, LOGO_PLACEHOLDER, has_logo_placeholder, inline_logo, logo_record

LOGO = 'data:image/png;base64,AAAA'
IMG = f'<img src="{LOGO_PLACEHOLDER}" alt="Company logo">'


class TestTheWordmark:
    def test_inside_a_double_quoted_js_string_it_adds_no_quote(self):
        script = f"<script>el.innerHTML = \"<img src='{LOGO_PLACEHOLDER}' alt='Logo'>\";</script>"
        out, uses = inline_logo(script, None, 'Example "Air"')
        assert out == '<script>el.innerHTML = "<b>Example &quot;Air&quot;</b>";</script>'
        assert uses == 0
        inner = out.split('"', 1)[1].rsplit('"', 1)[0]
        assert '"' not in inner
        assert "'" not in inner

    def test_a_third_use_in_a_js_string_is_the_quote_free_wordmark_too(self):
        script = f'{IMG}{IMG}<script>x = "{IMG}";</script>'
        out, uses = inline_logo(script, LOGO, 'Example Air')
        assert uses == 2
        assert out.endswith('<script>x = "<b>Example Air</b>";</script>')


class TestOnlyImgTagsTakeAUse:
    def test_a_comment_and_a_css_url_never_take_the_header_or_splash_slot(self):
        html = (f'<!-- logo: {LOGO_PLACEHOLDER} --><style>.h{{background:url({LOGO_PLACEHOLDER})}}</style>'
                f'<header>{IMG}</header><main>{IMG}</main>')
        out, uses = inline_logo(html, LOGO, 'Example Air')
        assert uses == 2
        assert out == (f'<!-- logo: {BLANK_IMAGE} --><style>.h{{background:url({BLANK_IMAGE})}}</style>'
                       f'<header><img src="{LOGO}" alt="Company logo"></header>'
                       f'<main><img src="{LOGO}" alt="Company logo"></main>')

    def test_a_bare_placeholder_in_a_script_becomes_the_blank_image(self):
        out, uses = inline_logo(f'<script>const src = "{LOGO_PLACEHOLDER}";</script>', LOGO, 'Example Air')
        assert (out, uses) == (f'<script>const src = "{BLANK_IMAGE}";</script>', 0)

    def test_one_img_naming_the_placeholder_twice_is_one_use(self):
        html = f'<img src="{LOGO_PLACEHOLDER}" srcset="{LOGO_PLACEHOLDER} 2x">{IMG}'
        out, uses = inline_logo(html, LOGO, 'Example Air')
        assert uses == 2
        assert out == f'<img src="{LOGO}" srcset="{LOGO} 2x"><img src="{LOGO}" alt="Company logo">'


class TestCase:
    @pytest.mark.parametrize('spelling', ['__company_logo__', '__Company_Logo__'])
    def test_the_placeholder_matches_in_any_case(self, spelling):
        out, uses = inline_logo(f'<IMG SRC="{spelling}"><p>{spelling}</p>', LOGO, 'Example Air')
        assert (out, uses) == (f'<IMG SRC="{LOGO}"><p>{BLANK_IMAGE}</p>', 1)
        assert has_logo_placeholder(f'<img src="{spelling}">') is True


def test_a_long_run_of_unclosed_img_tags_is_matched_in_linear_time():
    hostile = '<img ' * 20_000 + LOGO_PLACEHOLDER
    started = time.monotonic()
    out, uses = inline_logo(hostile, LOGO, 'Example Air')
    assert time.monotonic() - started < 5   # unbounded `[^>]*` takes minutes here; generous for a loaded CI
    assert (uses, out.endswith(BLANK_IMAGE)) == (0, True)


@pytest.mark.parametrize(('uploaded', 'uses', 'recorded'), [
    pytest.param(True, 1, True, id='inlined'),
    pytest.param(True, 0, False, id='uploaded-but-not-placed'),
    pytest.param(False, 0, None, id='none-uploaded-or-not-read'),
])
def test_logo_record(uploaded, uses, recorded):
    assert logo_record(uploaded, uses) is recorded
