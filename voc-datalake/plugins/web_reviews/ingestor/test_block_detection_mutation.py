"""Mutation-hardening for block_detection: every marker, every limit, every precedence rule is pinned.

The earlier suite named one marker per vendor, so mutating any other marker string, a sample length
or the short-page limit by one character survived. Here each marker is tried alone (upper-cased, so the
lower-casing is pinned too), each limit is tried on both sides of its boundary, and the order in which
vendors, the HTTP status and the generic wording are consulted is pinned with pages that carry two
kinds of evidence at once.
"""
import pytest
from block_detection import PageSignals, blocked_by

READABLE = 'A real review page. ' * 200  # 4,000 chars: longer than any wall
WALL_LIMIT = 3000
HTML_SAMPLE = 20000
TEXT_SAMPLE = 4000


def _html_page(html: str, status: int = 200) -> PageSignals:
    return PageSignals(status, '', 'Please wait', html)


def _text_page(text: str, status: int = 200) -> PageSignals:
    return PageSignals(status, '', text, '')


class TestEveryHtmlMarkerNamesItsVendor:
    @pytest.mark.parametrize(('marker', 'vendor'), [
        ('captcha-delivery.com', 'DataDome'),
        ('dd_referrer', 'DataDome'),
        ('datadome', 'DataDome'),
        ('px-captcha', 'HUMAN (PerimeterX)'),
        ('perimeterx', 'HUMAN (PerimeterX)'),
        ('_pxappid', 'HUMAN (PerimeterX)'),
        ('cf-chl', 'Cloudflare'),
        ('__cf_chl', 'Cloudflare'),
        ('challenge-platform', 'Cloudflare'),
        ('gokuprops', 'AWS WAF'),
        ('awswafcookiedomainlist', 'AWS WAF'),
        ('g-recaptcha', 'a CAPTCHA'),
        ('hcaptcha.com', 'a CAPTCHA'),
    ])
    def test_on_a_short_page(self, marker, vendor):
        assert blocked_by(_html_page(f'<div>{marker.upper()}</div>')) == vendor

    def test_not_on_a_long_page(self):
        assert blocked_by(PageSignals(200, 'Reviews', READABLE, '<div class="g-recaptcha"></div>')) is None


class TestEveryWallPhraseNamesItsVendor:
    @pytest.mark.parametrize(('phrase', 'vendor'), [
        ('press & hold', 'HUMAN (PerimeterX)'),
        ('press and hold', 'HUMAN (PerimeterX)'),
        ('just a moment...', 'Cloudflare'),
        ('attention required! | cloudflare', 'Cloudflare'),
        ('blocked by network security', 'Reddit network security'),
        ('verify you are human', 'a CAPTCHA'),
        ('are you a robot', 'a CAPTCHA'),
        ('prove your humanity', 'a CAPTCHA'),
    ])
    def test_in_the_text_even_of_a_long_page(self, phrase, vendor):
        assert blocked_by(_text_page(phrase.upper() + ' ' + READABLE)) == vendor

    def test_in_the_title(self):
        assert blocked_by(PageSignals(200, 'Just a moment...', READABLE, '')) == 'Cloudflare'

    def test_title_and_text_are_not_run_together(self):
        assert blocked_by(PageSignals(200, 'Just a', 'moment...', '')) is None


class TestGenericWording:
    @pytest.mark.parametrize('phrase', ['access denied', 'request blocked', 'unusual traffic'])
    def test_on_a_short_page_is_access_denied(self, phrase):
        assert blocked_by(_text_page(f'We saw {phrase.upper()} from you')) == 'access denied'

    def test_in_the_title_of_a_short_page(self):
        assert blocked_by(PageSignals(200, 'Unusual traffic', 'Sorry', '')) == 'access denied'


class TestLimits:
    def test_html_marker_ending_at_the_sample_edge_counts(self):
        marker = 'datadome'
        assert blocked_by(_html_page('x' * (HTML_SAMPLE - len(marker)) + marker)) == 'DataDome'

    def test_html_marker_past_the_sample_edge_is_ignored(self):
        marker = 'datadome'
        assert blocked_by(_html_page('x' * (HTML_SAMPLE - len(marker) + 1) + marker)) is None

    def test_text_phrase_ending_at_the_sample_edge_counts(self):
        phrase = 'are you a robot'
        assert blocked_by(_text_page('x' * (TEXT_SAMPLE - len(phrase)) + phrase)) == 'a CAPTCHA'

    def test_text_phrase_past_the_sample_edge_is_ignored(self):
        phrase = 'are you a robot'
        assert blocked_by(_text_page('x' * (TEXT_SAMPLE - len(phrase) + 1) + phrase)) is None

    def test_text_of_exactly_the_wall_limit_is_short(self):
        assert blocked_by(PageSignals(200, '', 'y' * WALL_LIMIT, '<i>datadome</i>')) == 'DataDome'

    def test_text_one_over_the_wall_limit_is_long(self):
        assert blocked_by(PageSignals(200, '', 'y' * (WALL_LIMIT + 1), '<i>datadome</i>')) is None

    def test_surrounding_whitespace_does_not_count_towards_the_limit(self):
        text = '   ' + 'y' * WALL_LIMIT + '\n\n'
        assert blocked_by(PageSignals(200, '', text, '<i>datadome</i>')) == 'DataDome'

    @pytest.mark.parametrize(('status', 'expected'), [(399, None), (400, 'HTTP 400'), (404, 'HTTP 404')])
    def test_status_boundary(self, status, expected):
        assert blocked_by(PageSignals(status, 'Reviews', READABLE, '')) == expected


class TestPrecedence:
    def test_an_earlier_vendor_wins_over_a_later_one(self):
        page = PageSignals(200, 'Just a moment...', 'Please wait', '<i>datadome</i>')
        assert blocked_by(page) == 'DataDome'

    def test_a_vendor_wins_over_the_http_status(self):
        assert blocked_by(PageSignals(429, '', 'Press and hold', '')) == 'HUMAN (PerimeterX)'

    def test_the_http_status_wins_over_generic_wording(self):
        assert blocked_by(PageSignals(403, 'Access denied', 'Access denied', '')) == 'HTTP 403'

    def test_a_short_readable_page_is_not_blocked(self):
        assert blocked_by(PageSignals(200, 'Reviews', 'Five stars, would buy again.', '<p>ok</p>')) is None
