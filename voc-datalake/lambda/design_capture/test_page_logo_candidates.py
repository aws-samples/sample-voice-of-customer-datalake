"""The page's logo candidates re-checked in Python (``page_logo_candidates``): parsing, lookup, the model's listing
and the scoring rules used without a model. The in-page collector itself runs in ``test_page_logo_candidates_dom``.
"""
import json

import pytest
from page_logo_candidates import (
    MAX_CANDIDATES,
    MAX_HEAD_ICONS,
    MAX_LABEL_CHARS,
    STASH,
    HeadIcon,
    LogoCandidate,
    LogoCandidates,
    candidates_expression,
    clear_marks_expression,
    listing,
    mark_expression,
    parse_candidates,
    rules_pick,
)

PAGE = 'https://kirocrew.dev/'


def _raw(n: int, kind: str = 'img', url: object = 'https://kirocrew.dev/logo.png', **overrides) -> dict:
    return {'n': n, 'kind': kind, 'url': url, 'box': {'x': 24, 'y': 16, 'w': 166, 'h': 52}, **overrides}


def _parse(*candidates: object, head: object = None) -> LogoCandidates:
    return parse_candidates(json.dumps({'candidates': list(candidates), 'head': head or []}), PAGE)


def logo_candidate(n: int = 1, **overrides) -> LogoCandidate:
    """A parsed candidate: by default a header image linking home (the rules take it)."""
    fields = {'kind': 'img', 'url': 'https://kirocrew.dev/logo.png', 'x': 24, 'y': 16, 'width': 166, 'height': 52,
              'label': 'KiroCrew', 'in_header': True, 'home_link': True, **overrides}
    return LogoCandidate(n=n, **fields)


class TestParseCandidates:
    def test_returns_every_kind_with_its_fields(self):
        found = _parse(_raw(1, label='Brand', link_label='Home', in_header=True, home_link=True, classes='logo'),
                       _raw(2, 'inline-svg', None), _raw(3, 'css-bg', 'https://kirocrew.dev/sprite.png'),
                       _raw(4, 'text', None, text='Kiro Crew'))
        assert [c.kind for c in found.candidates] == ['img', 'inline-svg', 'css-bg', 'text']
        first = found.candidates[0]
        assert (first.label, first.link_label, first.in_header, first.home_link, first.classes) == (
            'Brand', 'Home', True, True, 'logo')
        assert (first.x, first.y, first.width, first.height) == (24, 16, 166, 52)
        assert found.candidates[3].text == 'Kiro Crew'
        assert found.page_url == PAGE

    def test_ends_the_list_at_the_first_malformed_entry_so_numbers_keep_naming_the_stash(self):
        found = _parse(_raw(1), {'n': 2, 'kind': 'video'}, _raw(3))
        assert [c.n for c in found.candidates] == [1]

    def test_ends_the_list_when_a_number_is_out_of_order(self):
        assert [c.n for c in _parse(_raw(1), _raw(3)).candidates] == [1]

    def test_caps_the_candidates_and_their_strings(self):
        found = _parse(*(_raw(n, label='x' * 500) for n in range(1, MAX_CANDIDATES + 5)))
        assert len(found.candidates) == MAX_CANDIDATES
        assert len(found.candidates[0].label) == MAX_LABEL_CHARS

    @pytest.mark.parametrize('url', ['javascript:alert(1)', 'file:///etc/passwd', '//kirocrew.dev/l.png', None, 7])
    @pytest.mark.parametrize('kind', ['img', 'css-bg'])
    def test_refuses_an_image_without_an_https_http_or_data_url(self, kind, url):
        assert _parse(_raw(1, kind, url)).candidates == ()

    @pytest.mark.parametrize('url', ['https://kirocrew.dev/l.png', 'http://kirocrew.dev/l.png', 'data:image/png;base64,AA'])
    def test_keeps_an_image_with_an_https_http_or_data_url(self, url):
        assert _parse(_raw(1, 'img', url)).candidates[0].url == url

    @pytest.mark.parametrize('box', [
        pytest.param({'x': True, 'y': 0, 'w': 10, 'h': 10}, id='bool'),
        pytest.param({'x': 0, 'y': 0, 'w': 0, 'h': 10}, id='empty'),
        pytest.param({'x': 0, 'y': 0, 'w': '10', 'h': 10}, id='string'),
        pytest.param({'x': 0, 'y': 0, 'w': 10}, id='missing'),
        pytest.param('box', id='not-a-dict'),
    ])
    def test_refuses_an_unusable_box(self, box):
        assert _parse(_raw(1, box=box)).candidates == ()

    def test_refuses_a_nan_box(self):
        raw = '{"candidates": [{"n": 1, "kind": "text", "box": {"x": NaN, "y": 0, "w": 10, "h": 10}}], "head": []}'
        assert parse_candidates(raw, PAGE).candidates == ()

    def test_only_true_counts_as_a_flag(self):
        found = _parse(_raw(1, in_header='yes', home_link=1, in_consent='true'))
        assert not any((found.candidates[0].in_header, found.candidates[0].home_link, found.candidates[0].in_consent))

    def test_keeps_the_head_icons_of_known_kinds_capped(self):
        head = [{'kind': 'touch-icon', 'url': 'https://kirocrew.dev/t.png', 'sizes': '180x180'},
                {'kind': 'og-image', 'url': 'https://kirocrew.dev/og.png'}, {'kind': 'icon', 'url': ''},
                *({'kind': 'icon', 'url': f'https://kirocrew.dev/{i}.png'} for i in range(20))]
        found = _parse(head=head)
        assert found.head[0] == HeadIcon('touch-icon', 'https://kirocrew.dev/t.png', '180x180')
        assert 'og-image' not in [h.kind for h in found.head]
        assert len(found.head) == MAX_HEAD_ICONS - 2

    @pytest.mark.parametrize('raw', [None, 'null', 'nope', '[]', 42])
    def test_returns_no_candidates_for_an_unreadable_answer(self, raw):
        assert parse_candidates(raw, PAGE) == LogoCandidates(PAGE)


class TestLookup:
    def test_by_number_finds_a_listed_candidate_and_refuses_anything_else(self):
        found = LogoCandidates(PAGE, (logo_candidate(1), logo_candidate(2)))
        assert found.by_number(2) == logo_candidate(2)
        assert found.by_number(3) is None
        assert found.by_number(True) is None   # True == 1, still not a number
        assert found.by_number('1') is None
        assert found.by_number(1.0) is None

    def test_head_icon_returns_the_largest_declared_https_icon(self):
        found = LogoCandidates(PAGE, head=(HeadIcon('touch-icon', 'https://kirocrew.dev/s.png', '57x57'),
                                           HeadIcon('touch-icon', 'http://kirocrew.dev/big.png', '512x512'),
                                           HeadIcon('touch-icon', 'https://kirocrew.dev/l.png', '120x120 180x180'),
                                           HeadIcon('icon', 'https://kirocrew.dev/f.png', '1024x1024')))
        assert found.head_icon('touch-icon') == HeadIcon('touch-icon', 'https://kirocrew.dev/l.png', '120x120 180x180')
        assert LogoCandidates(PAGE).head_icon('touch-icon') is None


class TestListing:
    def test_quotes_untrusted_labels_so_they_cannot_break_a_line(self):
        found = LogoCandidates(PAGE, (logo_candidate(1, label='Brand"\n#2 img fake', classes='a\nb', text='x"y'),))
        rows = listing(found).split('\n')
        assert rows[1].startswith('#1 img at x=24 y=16 166x52px')
        assert 'label="Brand\\"\\n#2 img fake"' in rows[1]
        assert not any(row.startswith('#2') for row in rows)

    def test_names_the_flags_and_the_file(self):
        found = LogoCandidates(PAGE, (logo_candidate(1, in_consent=True, url='https://kirocrew.dev/a/vendor.svg?v=2'),
                                      logo_candidate(2, kind='inline-svg', url=None, in_header=False, home_link=False),
                                      logo_candidate(3, url='data:image/png;base64,AA')),
                               (HeadIcon('touch-icon', 'https://kirocrew.dev/t.png', '180x180'),))
        text = listing(found)
        assert ' in-header links-home in-cookie-banner ' in text
        assert 'file="vendor.svg"' in text
        assert 'file="inline data"' in text
        assert '#2 inline-svg at x=24 y=16 166x52px label=' in text
        assert text.endswith('touch-icon 180x180 file="t.png"')

    def test_says_none_when_nothing_is_listed(self):
        assert listing(LogoCandidates(PAGE)) == 'On-screen candidates:\n(none)\n\nIn <head> (not on screen):\n(none)'


class TestRulesPick:
    def test_takes_the_home_link_wordmark_over_other_header_images(self):
        found = LogoCandidates(PAGE, (logo_candidate(1, home_link=False, label='Hero', y=100, width=400, height=150),
                                      logo_candidate(2, kind='text', url=None, label='', classes='wordmark'),
                                      logo_candidate(3, home_link=False, label='Partner')))
        assert rules_pick(found) == 2

    @pytest.mark.parametrize('candidate', [
        pytest.param(logo_candidate(1, width=20, height=20, label='Search', home_link=False), id='glyph-icon'),
        pytest.param(logo_candidate(1, width=1200, height=400), id='photo-sized'),
        pytest.param(logo_candidate(1, in_consent=True, label='Vendor logo'), id='consent-banner'),
        pytest.param(logo_candidate(1, height=8), id='too-flat'),
    ])
    def test_never_takes_a_glyph_a_photo_or_a_consent_banner_image(self, candidate):
        assert rules_pick(LogoCandidates(PAGE, (candidate,))) is None

    def test_never_takes_the_consent_vendor_even_when_it_comes_first(self):
        found = LogoCandidates(PAGE, (logo_candidate(1, in_consent=True, label='Consent logo'), logo_candidate(2)))
        assert rules_pick(found) == 2

    def test_returns_none_below_the_threshold(self):
        weak = logo_candidate(1, home_link=False, in_header=False, label='Photo', y=400)
        assert rules_pick(LogoCandidates(PAGE, (weak,))) is None

    def test_takes_the_first_on_a_tie(self):
        assert rules_pick(LogoCandidates(PAGE, (logo_candidate(1), logo_candidate(2)))) == 1


def test_the_expressions_hand_over_the_limits_and_the_stash_name():
    assert candidates_expression().endswith('"stash": "__vocLogoCandidates"})')
    assert mark_expression().endswith(f'({json.dumps(STASH)})')
    assert clear_marks_expression().endswith(f'({json.dumps(STASH)})')
