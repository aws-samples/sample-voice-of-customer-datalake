"""Web-review targets: what an admin saves for the ``web_reviews`` plugin, and its source ids.

One target is one public review page (``https://www.trustpilot.com/review/example.com``)
that the plugin reads with a managed browser (docs/web-reviews.md). Targets are
stored like the app-review connectors, as a JSON array under
``web_reviews_configs`` in the shared API-credentials secret, every value a
string, and are written by ``POST /integrations/web_reviews/apps``.

``max_pages`` 0 reads every page (up to ``MAX_PAGES``) and ``max_reviews`` 0 sets no
review limit: "the latest 10 pages" is 10 / 0, "the latest 200 reviews" 0 / 200,
"everything" 0 / 0.

Shared by both sides of that boundary: ``api/integrations_handler.py`` validates a
target here before it is saved, and the plugin re-validates every stored target
here before it is read (a hand-edited secret must not reach the browser).

Each target is its own source, ``web_<site>_<app_name>``:
``web_review_source_id('www.trustpilot.com', 'Example Air')`` is ``web_trustpilot_example_air``,
which matches ``shared.source_profiles.SOURCE_ID_RE``, so a source profile (PII policy,
retention, restricted) can be set per connector. The id is minted once, when the target is
created, and stored on it as ``source_id`` (``target_source_id``), so a rename does not move
its reviews; a target saved before ``source_id`` existed is minted from its host and name.
"""

import hashlib
import re
from collections.abc import Mapping
from typing import Final, TypeGuard
from urllib.parse import urlparse

from shared.radar_brands import radar_brand_setting
from shared.row_ids import OPAQUE_ID_RE
from shared.source_profiles import SOURCE_ID_RE
from shared.url_policy import validate_url

PLUGIN_ID: Final = 'web_reviews'

MAX_NAME_CHARS: Final = 100
MAX_URL_CHARS: Final = 2048
#: Pages read per target; 0 = every page, up to the hard cap MAX_PAGES.
MIN_PAGES: Final = 0
MAX_PAGES: Final = 100
DEFAULT_PAGES: Final = 10
#: Reviews read per target; 0 = no review limit (the pages and the run cap still apply).
MIN_REVIEWS: Final = 0
MAX_REVIEWS: Final = 5000
DEFAULT_REVIEWS: Final = 0
#: The manifest's ``frequency_minutes`` options (0 = manual runs only).
FREQUENCY_MINUTES: Final = (0, 15, 30, 60, 180, 360, 720, 1440)
DEFAULT_FREQUENCY_MINUTES: Final = 0

NAME_RE: Final = re.compile(r'^[A-Za-z0-9][\w .-]*\Z')
_SOURCE_PREFIX: Final = 'web_'
_SOURCE_ID_MAX: Final = 48
_HASH_CHARS: Final = 8
_WEB_SOURCE_ID_RE: Final = re.compile(r'^web_[a-z0-9_-]{1,44}\Z')
#: Second-level labels a registrable name sits under (``tripadvisor.co.uk``).
_SECOND_LEVEL_LABELS: Final = frozenset({'co', 'com', 'org', 'net', 'ac', 'gov', 'edu'})
_HOST_PREFIXES: Final = ('www.', 'm.')
_DEFAULT_SOURCE_NAME: Final = 'reviews'
_NAME_RUN_RE: Final = re.compile(r'[^a-z0-9]+')
_NOT_SOURCE_CHAR_RE: Final = re.compile(r'[^a-z0-9_-]')


class TargetError(ValueError):
    """A target that may not be saved or read; the message is client-safe."""


def _site(host: str) -> str:
    """The registrable name of *host*: ``www.tripadvisor.co.uk`` and ``uk.tripadvisor.com`` are ``tripadvisor``."""
    cleaned = host.strip().rstrip('.').lower()
    for prefix in _HOST_PREFIXES:
        if cleaned.startswith(prefix):
            cleaned = cleaned[len(prefix):]
            break
    labels = cleaned.split('.')
    if len(labels) > 1:
        labels = labels[:-1]
        if len(labels) >= 2 and labels[-1] in _SECOND_LEVEL_LABELS:
            labels = labels[:-1]
    return labels[-1]


def web_review_source_id(host: str, app_name: str) -> str:
    """The ``source_platform`` of a target's reviews: ``web_<site>_<app_name>``.

    ``('www.trustpilot.com', 'Example Air')`` is ``web_trustpilot_example_air``. Any character
    a source id may not carry becomes ``_``, and an id longer than a source id allows keeps its
    start plus a short hash of the site and name, so two long ids never collide.
    """
    site = _site(host)
    name = _NAME_RUN_RE.sub('_', app_name.lower()).strip('_') or _DEFAULT_SOURCE_NAME
    candidate = _NOT_SOURCE_CHAR_RE.sub('_', f'{_SOURCE_PREFIX}{site}_{name}')
    if len(candidate) > _SOURCE_ID_MAX:
        digest = hashlib.sha256(f'{site}\n{name}'.encode()).hexdigest()[:_HASH_CHARS]
        candidate = f'{candidate[:_SOURCE_ID_MAX - _HASH_CHARS - 1]}_{digest}'
    return candidate


def is_web_review_source_id(value: object) -> TypeGuard[str]:
    """Whether *value* is a source id a web_reviews target may carry."""
    return isinstance(value, str) and bool(_WEB_SOURCE_ID_RE.match(value)) and bool(SOURCE_ID_RE.match(value))


def target_source_id(target: Mapping[str, object]) -> str:
    """*target*'s stored ``source_id``, or (saved before it existed) one minted from its URL's host and name."""
    stored = target.get('source_id')
    if is_web_review_source_id(stored):
        return stored
    url, name = target.get('url'), target.get('app_name')
    host = (urlparse(url).hostname or '') if isinstance(url, str) else ''
    return web_review_source_id(host, name.strip() if isinstance(name, str) else '')


def _text(target: Mapping[str, object], key: str) -> str:
    value = target.get(key)
    if value is None:
        return ''
    if isinstance(value, bool) or not isinstance(value, str | int):
        raise TargetError(f'{key} must be text')
    return str(value).strip()


def _name(target: Mapping[str, object]) -> str:
    name = _text(target, 'app_name')
    if not name:
        raise TargetError('app_name is required')
    if len(name) > MAX_NAME_CHARS or not NAME_RE.match(name):
        raise TargetError(f'app_name must be 1-{MAX_NAME_CHARS} letters, digits, spaces, ".", "_" or "-"')
    return name


def checked_url(url: str) -> str:
    """*url* when it is an https URL the outbound policy allows (public host); else ``TargetError``."""
    if not url:
        raise TargetError('url is required')
    if len(url) > MAX_URL_CHARS:
        raise TargetError(f'url must be at most {MAX_URL_CHARS} characters')
    if urlparse(url).scheme != 'https':
        raise TargetError('Only https URLs are allowed')
    allowed, error = validate_url(url)
    if not allowed:
        raise TargetError(f'URL rejected: {error}')
    return url


def _bounded_int(target: Mapping[str, object], key: str, default: int, low: int, high: int) -> int:
    raw = _text(target, key)
    if raw == '':
        return default
    try:
        value = int(raw)
    except ValueError:
        raise TargetError(f'{key} must be a whole number') from None
    if not low <= value <= high:
        raise TargetError(f'{key} must be between {low} and {high}')
    return value


def _frequency(target: Mapping[str, object]) -> int:
    value = _bounded_int(target, 'frequency_minutes', DEFAULT_FREQUENCY_MINUTES, 0, max(FREQUENCY_MINUTES))
    if value not in FREQUENCY_MINUTES:
        raise TargetError(f'frequency_minutes must be one of {", ".join(map(str, FREQUENCY_MINUTES))}')
    return value


def _enabled(target: Mapping[str, object]) -> str:
    raw = target.get('enabled', True)
    if isinstance(raw, bool):
        return 'true' if raw else 'false'
    if isinstance(raw, str) and raw.strip().lower() in ('true', 'false'):
        return raw.strip().lower()
    raise TargetError('enabled must be true or false')


def validated_target(target: object) -> dict[str, str]:
    """The stored form of *target* (string values only, unknown keys dropped), or ``TargetError``.

    ``id`` is kept when present and well formed (the route mints one otherwise), and so is
    ``source_id`` (the route mints it on create and keeps the stored one on update).
    """
    if not isinstance(target, Mapping):
        raise TargetError('No target provided')
    cleaned = {
        'app_name': _name(target),
        'url': checked_url(_text(target, 'url')),
        'max_pages': str(_bounded_int(target, 'max_pages', DEFAULT_PAGES, MIN_PAGES, MAX_PAGES)),
        'max_reviews': str(_bounded_int(target, 'max_reviews', DEFAULT_REVIEWS, MIN_REVIEWS, MAX_REVIEWS)),
        'frequency_minutes': str(_frequency(target)),
        'enabled': _enabled(target),
    }
    target_id = _text(target, 'id')
    if target_id:
        if not OPAQUE_ID_RE.match(target_id):
            raise TargetError('id must be 1-64 letters, digits, "_" or "-"')
        cleaned['id'] = target_id
    source_id = _text(target, 'source_id')
    if source_id:
        if not is_web_review_source_id(source_id):
            raise TargetError('source_id must be a web review source id')
        cleaned['source_id'] = source_id
    radar_brand = _radar_brand(target)
    if radar_brand:
        cleaned['radar_brand'] = radar_brand
    return cleaned


def _radar_brand(target: Mapping[str, object]) -> str:
    """The Radar brand key the target sends its reviews to (``''`` = one of our own sources)."""
    try:
        return radar_brand_setting(target.get('radar_brand'))
    except ValueError as error:
        raise TargetError(str(error)) from None
