"""
Read-time redaction of a scraper run's stored ``errors`` (``SCRAPER_RUN#`` rows).

Every route that returns those rows is open to every signed-in user
(``GET /logs/scraper/<id>`` in logs_handler, ``GET /scrapers/<id>/status`` and
``.../runs`` in scrapers_handler), and rows written before the webscraper
ingestor stopped storing raw ``str(e)`` carry exception text (upstream URLs,
response bodies). A response is therefore built from an allowlist: a run error
is returned as written only when it has the shape the ingestor writes now
(plugins/webscraper/ingestor/handler.py ``_run_error_text``) — anything else is
replaced by a fixed string. ONE implementation for every such route.
"""

import re

# A Python exception class name — the only exception detail a stored error may carry.
ERROR_TYPE_SHAPE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,99}$')
MAX_RETURNED_ERRORS = 50
# `Error scraping <url>: <ExceptionClass>` or a URL-policy refusal, plus one fixed string.
_SCRAPER_ERROR_PREFIX = re.compile(r'^Error scraping (\S{1,2048}): ')
_SCRAPER_POLICY_DETAIL = re.compile(r'^URL blocked by policy \([A-Za-z0-9 /,.\'-]{1,200}\)$')
_FIXED_SCRAPER_ERRORS = frozenset({'No scraper configuration found'})
SCRAPER_ERROR_WITHHELD = 'Scraper error (details withheld)'
SCRAPER_DETAIL_WITHHELD = 'error details withheld'


def redact_scraper_error(error: object) -> str:
    """A run error as the ingestor writes it now; a legacy `str(e)` tail is withheld."""
    if not isinstance(error, str):
        return SCRAPER_ERROR_WITHHELD
    if error in _FIXED_SCRAPER_ERRORS:
        return error
    prefix = _SCRAPER_ERROR_PREFIX.match(error)
    if not prefix:
        return SCRAPER_ERROR_WITHHELD
    detail = error[prefix.end():]
    if ERROR_TYPE_SHAPE.fullmatch(detail) or _SCRAPER_POLICY_DETAIL.fullmatch(detail):
        return error
    return f"{prefix.group(0)}{SCRAPER_DETAIL_WITHHELD}"


def redacted_scraper_errors(errors: object) -> list[str]:
    """The stored ``errors`` list, each entry redacted, at most MAX_RETURNED_ERRORS."""
    if not isinstance(errors, list):
        return []
    return [redact_scraper_error(e) for e in errors[:MAX_RETURNED_ERRORS]]
