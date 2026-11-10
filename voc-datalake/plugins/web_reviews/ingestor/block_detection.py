"""Recognise a page that is a bot wall, not the reviews.

The managed browser announces itself honestly ("Amazon-Bedrock-AgentCore-Browser"
in its User-Agent) and runs from AWS addresses, so some review sites answer it
with a challenge instead of the page. A blocked target must be REPORTED as
blocked (the run's errors say ``blocked by <vendor>``), never read as a page with
no reviews. See docs/web-reviews.md for the sites measured.

Two kinds of evidence, matched lower-cased:

* words in the title or visible text that only a wall shows ("press & hold",
  "just a moment") — decisive on their own;
* vendor markers in the HTML (``captcha-delivery.com``, ``px-captcha``,
  ``gokuProps``) — decisive only on a SHORT page, because the same vendors' tags
  also sit on pages that let the browser through (Trustpilot loads AWS WAF's
  token script on every page it serves).

The specific vendors are checked before the generic HTTP-status / "access
denied" fallbacks, so the report names who blocked when it can.
"""

from typing import Final, NamedTuple

#: Characters of HTML / text looked at; a challenge page says what it is at the top.
HTML_SAMPLE_CHARS: Final = 20000
TEXT_SAMPLE_CHARS: Final = 4000
#: First HTTP status of the main document that counts as refused.
BLOCKED_STATUS_FROM: Final = 400
#: Visible text at most this long can be a wall; a real review page is far longer.
WALL_TEXT_MAX_CHARS: Final = 3000


class PageSignals(NamedTuple):
    """What the browser saw of one page, as block detection needs it."""

    status: int
    title: str
    text: str
    html: str


class _Vendor(NamedTuple):
    label: str
    html_markers: tuple[str, ...]
    text_markers: tuple[str, ...]


_VENDORS: Final = (
    _Vendor('DataDome', ('captcha-delivery.com', 'dd_referrer', 'datadome'), ()),
    _Vendor('HUMAN (PerimeterX)', ('px-captcha', 'perimeterx', '_pxappid'), ('press & hold', 'press and hold')),
    _Vendor('Cloudflare', ('cf-chl', '__cf_chl', 'challenge-platform'), ('just a moment...', 'attention required! | cloudflare')),
    _Vendor('AWS WAF', ('gokuprops', 'awswafcookiedomainlist'), ()),
    _Vendor('Reddit network security', (), ('blocked by network security',)),
    _Vendor('a CAPTCHA', ('g-recaptcha', 'hcaptcha.com'), ('verify you are human', 'are you a robot', 'prove your humanity')),
)
_GENERIC_TEXT: Final = ('access denied', 'request blocked', 'unusual traffic')


def _vendor_of(html: str, words: str, short: bool) -> str | None:
    for vendor in _VENDORS:
        if any(marker in words for marker in vendor.text_markers):
            return vendor.label
        if short and any(marker in html for marker in vendor.html_markers):
            return vendor.label
    return None


def blocked_by(page: PageSignals) -> str | None:
    """The vendor that blocked *page* (``'DataDome'``, ``'HTTP 403'``, …), or ``None`` when it is readable."""
    html = page.html[:HTML_SAMPLE_CHARS].lower()
    words = f'{page.title}\n{page.text[:TEXT_SAMPLE_CHARS]}'.lower()  # pragma: no mutate  padding never adds or removes a substring match
    short = len(page.text.strip()) <= WALL_TEXT_MAX_CHARS
    vendor = _vendor_of(html, words, short)
    if vendor is not None:
        return vendor
    if page.status >= BLOCKED_STATUS_FROM:
        return f'HTTP {page.status}'
    if short and any(marker in words for marker in _GENERIC_TEXT):
        return 'access denied'
    return None
