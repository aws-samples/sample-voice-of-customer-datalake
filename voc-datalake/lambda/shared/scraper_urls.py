"""
Write-time destination checking for webscraper configurations (issue #244).

`shared/http_utils.py` owns the outbound-URL POLICY — what makes one URL a
permitted destination. This module owns the CONFIG shape: which keys of a saved
scraper configuration name a destination the scheduled ingestor will fetch, and
therefore what a write must refuse.

It lives in `shared/` rather than beside either caller because there are TWO
persistence paths into the same `webscraper_configs` secret key, in two Lambdas
that cannot import each other (each API bundle stages exactly one handler file
plus all of `shared/` — see `createApiLambdaCode` in lib/stacks/api-stack.ts):

  * `POST /scrapers` in `scrapers_handler.py`, one config object at a time.
  * `PUT /integrations/webscraper/credentials` in `integrations_handler.py`,
    whose `configs` value is the WHOLE array as a JSON string — that is how the
    Settings page's webscraper card saves, and it wrote unchecked.

Checking one of them and not the other is the same bug in a different route, so
the check is stated once here and called from both.
"""

import json

from shared.exceptions import ValidationError
from shared.http_utils import OutboundUrlBlocked, assert_outbound_url_allowed

# Config keys naming a network destination the scheduled ingestor will fetch.
# Kept in lockstep with `_get_urls_to_scrape` in
# plugins/webscraper/ingestor/handler.py, which reads exactly these two — its
# pagination URLs are derived from base_url and so share its host.
# `lambda/api/test/test_scraper_url_fields_lockstep.py` derives that function's
# keys from source and fails if one appears there and not here.
SCRAPER_URL_FIELDS = ('base_url', 'urls')

# Keys in SCRAPER_URL_FIELDS whose value is a LIST of URLs rather than one URL.
# Declared so a wrongly-typed value is named as such instead of being coerced:
# `urls: 'http://x/'` would otherwise validate as one URL, and `urls: [{...}]`
# would reach the policy and come back as the misleading 'URL is required'.
SCRAPER_URL_LIST_FIELDS = frozenset({'urls'})

# Destinations one config may name. Each costs a synchronous getaddrinfo inside
# the invocation, and both write routes answer through API Gateway, whose 29 s
# integration limit is well below either Lambda's own timeout — so an unbounded
# list is a 504 with nothing saved rather than an actionable 400. Sized the way
# MAX_CREDENTIAL_KEYS_PER_REQUEST is in integrations_handler: far above any real
# config, low enough that the refusal arrives inside the budget.
MAX_SCRAPER_URLS = 50

# The NUMBER of configs one write may carry is deliberately NOT capped. The
# integrations route writes the whole array at once, and
# `test_value_larger_than_4kib_is_accepted` in test_integrations_security.py
# exists because an earlier per-value size cap made saving fail at around eight
# scrapers; a count cap would retire that guarantee for the same reason in a new
# unit. What bounds the resolver cost instead is deduplication: identical URLs
# within one write are checked once, and a realistic large array is many configs
# over a handful of hosts.


def validate_scraper_destinations(scraper: dict, seen: set | None = None) -> None:
    """
    Apply the shared outbound-URL policy to every destination in one config.

    Called on WRITE, which is what issue #244 was about: the policy used to run
    only on the analyze/preview route, so a config was persisted unchecked and
    the scheduled ingestor then fetched it. The ingestor re-checks each hop as
    well — a saved host can start resolving internally later — but rejecting the
    write is what keeps an internal target from being scheduled in the first
    place.

    Field types are asserted rather than coerced, mirroring the per-value check
    in `integrations_handler.update_credentials`: letting a type mismatch fall
    through to the policy produces a 400 that names the wrong problem.

    Args:
        seen: URLs already cleared during THIS write, so an array of configs over
            a handful of hosts costs a handful of resolver calls rather than one
            per entry. A set is only shared within one request; nothing is cached
            across invocations, because "this host was public a minute ago" is
            precisely the claim this check must not make.

    Raises:
        ValidationError: any destination is not a permitted outbound target, or
            a field does not hold the type it is documented to hold. Names the
            offending URL, because a config can hold several and "one of your
            URLs is invalid" is not actionable.
    """
    if not isinstance(scraper, dict):
        # A list would sail past `.get()`-based validation as "no URLs to check".
        raise ValidationError('Scraper config must be an object')

    for field in SCRAPER_URL_FIELDS:
        value = scraper.get(field)
        # An absent or empty value is legal: the editor ships base_url: '' and
        # urls: [] for a scraper that is still being written.
        if value is None:
            continue

        if field in SCRAPER_URL_LIST_FIELDS:
            if not isinstance(value, list):
                raise ValidationError(
                    f"{field} must be a list of URLs, got {type(value).__name__}"
                )
            if len(value) > MAX_SCRAPER_URLS:
                raise ValidationError(
                    f"Too many URLs in {field}: {len(value)} exceeds the limit "
                    f"of {MAX_SCRAPER_URLS}."
                )
            candidates = value
        else:
            if not isinstance(value, str):
                raise ValidationError(
                    f"{field} must be a URL string, got {type(value).__name__}"
                )
            candidates = [value]

        for index, url in enumerate(candidates):
            if not url:
                continue
            if not isinstance(url, str):
                raise ValidationError(
                    f"{field}[{index}] must be a URL string, got "
                    f"{type(url).__name__}"
                )
            if seen is not None and url in seen:
                continue
            try:
                assert_outbound_url_allowed(url)
            except OutboundUrlBlocked as e:
                raise ValidationError(f"{field} '{url}': {e}") from e
            if seen is not None:
                seen.add(url)


def validate_scraper_configs_json(raw: object) -> None:
    """
    Same check for the serialized ARRAY of configs.

    `PUT /integrations/webscraper/credentials` stores its `configs` value as an
    opaque string, so this is the shape that route has to check. Unparseable
    input is refused rather than ignored: the ingestor's `_load_scraper_configs`
    logs a JSONDecodeError and scrapes nothing, so storing a broken array is a
    silently dead integration, and refusing it costs nothing.

    An empty string means "no configs" and is legal — that is the seeded default
    for the key.

    Raises:
        ValidationError: the value is not a JSON array of config objects, or any
            config names a destination the policy refuses.
    """
    if raw is None or raw == '':
        return
    if not isinstance(raw, str):
        raise ValidationError(
            f"configs must be a JSON array string, got {type(raw).__name__}"
        )

    try:
        configs = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValidationError(f"configs is not valid JSON: {e.msg}") from e

    if not isinstance(configs, list):
        raise ValidationError(
            f"configs must be a JSON array, got {type(configs).__name__}"
        )

    seen: set = set()
    for config in configs:
        validate_scraper_destinations(config, seen=seen)
