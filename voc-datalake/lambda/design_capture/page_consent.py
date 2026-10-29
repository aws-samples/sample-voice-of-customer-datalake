"""The in-page JavaScript that tells whether an element sits inside a cookie / consent banner.

Both page scripts skip logos inside consent banners: ``page_styles.STYLES_JS`` (logo images) and
``page_inline_logo.INLINE_LOGO_JS`` (inline ``<svg>`` logos). Each puts ``IN_CONSENT_JS`` where its
source has the ``CONSENT_PLACEHOLDER`` comment (``with_consent_check``), so the selector list and the
walk are written once.
"""
from __future__ import annotations

from typing import Final

#: Marks where a page script wants ``IN_CONSENT_JS``.
CONSENT_PLACEHOLDER: Final = '/*IN_CONSENT*/'

#: ``CONSENT`` (the banner selectors) and ``inConsent(el)``. Only containers BELOW <body> count: consent
#: plugins also tag <html> / <body> with their classes.
IN_CONSENT_JS: Final = r"""
    const CONSENT = '[id*=cookie i],[class*=cookie i],[id*=consent i],[class*=consent i],[id*=gdpr i],[class*=gdpr i],[id*=cmp i],[class*=wcc-]';
    const inConsent = (el) => {
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        if (node.matches(CONSENT)) return true;
      }
      return false;
    };
"""


def with_consent_check(script: str) -> str:
    """*script* with ``IN_CONSENT_JS`` in place of its one ``CONSENT_PLACEHOLDER``."""
    if script.count(CONSENT_PLACEHOLDER) != 1:
        raise ValueError('a page script must carry exactly one consent placeholder')
    return script.replace(CONSENT_PLACEHOLDER, IN_CONSENT_JS.strip())
