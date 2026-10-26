"""Block detection: each vendor's wall is named; a readable page (even one carrying a vendor's tag) is not blocked."""
import pytest
from block_detection import PageSignals, blocked_by

LONG_TEXT = 'A real review page. ' * 400


@pytest.mark.parametrize(('page', 'vendor'), [
    (PageSignals(403, '', '', '<script src="https://ct.captcha-delivery.com/c.js"></script>'), 'DataDome'),
    (PageSignals(200, 'Access to this page has been denied', 'Press & Hold to confirm you are a human', ''),
     'HUMAN (PerimeterX)'),
    (PageSignals(200, '', 'Please wait', '<div id="px-captcha"></div>'), 'HUMAN (PerimeterX)'),
    (PageSignals(403, 'Just a moment...', 'Checking your browser', ''), 'Cloudflare'),
    (PageSignals(200, '', '', '<script src="/cdn-cgi/challenge-platform/h/b"></script>'), 'Cloudflare'),
    (PageSignals(202, '', '', '<script>window.gokuProps = {"key": "x"}</script>'), 'AWS WAF'),
    (PageSignals(403, 'Blocked', "You've been blocked by network security.", ''), 'Reddit network security'),
    (PageSignals(200, '', 'Please verify you are human', ''), 'a CAPTCHA'),
    (PageSignals(503, 'Error', 'Service unavailable', ''), 'HTTP 503'),
    (PageSignals(200, 'Access Denied', 'Access denied. Reference #18', ''), 'access denied'),
])
def test_names_who_blocked(page, vendor):
    assert blocked_by(page) == vendor


def test_a_readable_page_is_not_blocked():
    assert blocked_by(PageSignals(200, 'Example reviews', LONG_TEXT, '<html><body>ok</body></html>')) is None


def test_a_long_page_carrying_a_vendor_script_is_readable():
    # Trustpilot serves AWS WAF's token script on the pages it lets through.
    page = PageSignals(200, 'Reviews', LONG_TEXT, '<script>window.gokuProps = {}</script><div>reviews</div>')
    assert blocked_by(page) is None


def test_a_long_page_mentioning_access_denied_is_readable():
    assert blocked_by(PageSignals(200, 'Reviews', 'They said access denied at the gate. ' + LONG_TEXT, '')) is None
