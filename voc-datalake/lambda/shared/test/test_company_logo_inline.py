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

    def test_an_img_naming_the_placeholder_twice_takes_two_uses(self):
        # Each embed is a use (commit review, 7.00.02): src + srcset fill both, so the next <img> is the wordmark.
        html = f'<img src="{LOGO_PLACEHOLDER}" srcset="{LOGO_PLACEHOLDER} 2x">{IMG}'
        out, uses = inline_logo(html, LOGO, 'Example Air')
        assert uses == 2
        assert out == f'<img src="{LOGO}" srcset="{LOGO} 2x"><b>Example Air</b>'


class TestCase:
    @pytest.mark.parametrize('spelling', ['__company_logo__', '__Company_Logo__'])
    def test_the_placeholder_matches_in_any_case(self, spelling):
        out, uses = inline_logo(f'<IMG SRC="{spelling}"><p>{spelling}</p>', LOGO, 'Example Air')
        assert (out, uses) == (f'<IMG SRC="{LOGO}"><p>{BLANK_IMAGE}</p>', 1)
        assert has_logo_placeholder(f'<img src="{spelling}">') is True


@pytest.mark.timing
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


# Review (7.00.02) suspected a placeholder in a script that BUILDS an <img> takes no place: the tag text is still in the
# document, so it is inlined (a template literal and an escaped double-quoted string alike).
def test_an_img_built_in_a_script_string_takes_a_logo_place():
    doc = ('<script>a.innerHTML = `<img src="__COMPANY_LOGO__" alt="Logo">`;'
           ' b.innerHTML = "<img src=\\"__COMPANY_LOGO__\\">";</script>')
    out = inline_logo(doc, 'data:image/png;base64,AAAA', 'Example Air')
    assert out.uses == 2
    assert '__COMPANY_LOGO__' not in out.document
    assert out.document.count('data:image/png;base64,AAAA') == 2


# Commit review (7.00.02): one <img> naming the placeholder in src AND srcset embedded the base64 once per occurrence
# while counting one use, so a model could repeat it inside one tag without bound.
def test_a_tag_that_would_embed_the_logo_more_often_than_allowed_becomes_the_wordmark():
    tag = '<img src="__COMPANY_LOGO__" srcset="__COMPANY_LOGO__ 1x, __COMPANY_LOGO__ 2x, __COMPANY_LOGO__ 3x">'
    out = inline_logo(tag + '<img src="__COMPANY_LOGO__">', 'data:image/png;base64,AAAA', 'Example Air')
    assert out.uses == 1
    assert out.document == '<b>Example Air</b><img src="data:image/png;base64,AAAA">'


# Commit review (7.00.02): a backtick or `$` in the name would end or interpolate a template literal holding the tag.
def test_the_wordmark_is_safe_inside_a_template_literal():
    out = inline_logo('<script>a.innerHTML = `<img src="__COMPANY_LOGO__">`</script>', None, 'Pay`${x}` <Air>')
    assert out.document == '<script>a.innerHTML = `<b>Pay&#96;&#36;{x}&#96; &lt;Air&gt;</b>`</script>'

