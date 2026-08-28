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
from urllib.parse import urlparse

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

# Destinations one config may name. Each new HOST costs a synchronous getaddrinfo
# inside the invocation, and both write routes answer through API Gateway, whose
# 29 s integration limit is well below either Lambda's own timeout — so an
# unbounded list is a 504 with nothing saved rather than an actionable 400. Sized
# the way MAX_CREDENTIAL_KEYS_PER_REQUEST is in integrations_handler: far above
# any real config, low enough that the refusal arrives inside the budget.
#
# Applied only to a list this write CHANGES, never to one it merely carries
# forward — see `validate_scraper_configs_json`. The integrations route persists
# the whole array, so enforcing it retroactively meant one pre-existing config
# with more than this many urls blocked saving ANY change to the set, including
# edits to unrelated configs, with no in-app way to trim the offender. That is a
# narrower repeat of the failure `test_value_larger_than_4kib_is_accepted` was
# written to prevent.
MAX_SCRAPER_URLS = 50

# The NUMBER of configs one write may carry is deliberately NOT capped. The
# integrations route writes the whole array at once, and
# `test_value_larger_than_4kib_is_accepted` in test_integrations_security.py
# exists because an earlier per-value size cap made saving fail at around eight
# scrapers; a count cap would retire that guarantee for the same reason in a new
# unit. What bounds the resolver cost instead is deduplication keyed on the
# HOSTNAME: N configs over one host cost one getaddrinfo however many distinct
# paths they name. Keying it on the full URL — which is what this did first — did
# not bound anything, because 400 configs on one site with 400 distinct paths are
# 400 distinct URLs and so were 400 resolver calls inside the 29 s window.


def _config_label(scraper: dict) -> str:
    """
    How to name a config in an error message.

    The array route refuses the whole write, so a message that does not say WHICH
    config is at fault leaves the user with no way to find it among many.
    """
    for key in ('id', 'name'):
        value = scraper.get(key)
        if isinstance(value, str) and value:
            return f"{key} {value!r}"
    return 'config'


def _dedup_key(url: str) -> str | None:
    """
    The hostname whose resolution is memoized for one write, lowercased.

    Only resolution is deduplicated, never the cheap local checks: a bad scheme
    on the second URL of an already-cleared host must still be refused.
    """
    try:
        hostname = urlparse(url).hostname
    except ValueError:
        return None
    return hostname.lower() if hostname else None


def validate_scraper_destinations(
    scraper: dict, seen: set | None = None, enforce_max_urls: bool = True
) -> None:
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
        seen: HOSTNAMES already resolved and cleared during THIS write, so an
            array of configs over a handful of hosts costs a handful of resolver
            calls however many paths it names. Defaults to a FRESH set per call,
            so the bound is what a caller gets without knowing to ask: passing
            nothing used to mean no memo at all, and `POST /scrapers` — which
            passed nothing — spent one lookup per URL for a config naming 50 on
            one host, while both docs said hosts were resolved once per write.
            Pass an explicit set only to share the memo across several configs in
            ONE write. Keyed on the hostname, not the URL:
            resolution is the only expensive step and it is per-host, so keying it
            per-URL memoized nothing for the realistic large array (one site, one
            path per scraper). The cheap per-URL checks — scheme, credentials,
            type, blocked names — still run for every URL, so a bad scheme on the
            second URL of a cleared host is still refused. A set must never
            outlive one request; nothing is cached across invocations, because
            "this host was public a minute ago" is precisely the claim this check
            must not make — which is why the default is built per call rather
            than being a module-level set.
        enforce_max_urls: Whether MAX_SCRAPER_URLS applies. False for a `urls`
            list this write leaves byte-identical to what is already stored — the
            destinations are still checked, but an over-cap list that predates the
            cap must not make the config unsaveable and, via the array route,
            block edits to every other config too.

    Raises:
        ValidationError: any destination is not a permitted outbound target, or
            a field does not hold the type it is documented to hold. Names the
            offending URL, because a config can hold several and "one of your
            URLs is invalid" is not actionable.
    """
    if not isinstance(scraper, dict):
        # A list would sail past `.get()`-based validation as "no URLs to check".
        raise ValidationError('Scraper config must be an object')

    if seen is None:
        seen = set()

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
            if enforce_max_urls and len(value) > MAX_SCRAPER_URLS:
                raise ValidationError(
                    f"Too many URLs in {field} for {_config_label(scraper)}: "
                    f"{len(value)} exceeds the limit of {MAX_SCRAPER_URLS}."
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
            host = _dedup_key(url)
            try:
                if host is not None and host in seen:
                    # This host was resolved and cleared earlier in this write, so
                    # only the local checks need repeating for this URL.
                    assert_outbound_url_allowed(url, skip_resolution=True)
                    continue
                assert_outbound_url_allowed(url)
            except OutboundUrlBlocked as e:
                raise ValidationError(f"{field} '{url}': {e}") from e
            if host is not None:
                seen.add(host)


def _stored_urls_by_id(stored: object) -> dict:
    """
    `{config id: its urls list}` from the currently-stored array.

    Best-effort by design: this only decides whether MAX_SCRAPER_URLS is a NEW
    violation, so anything unparseable or unrecognizable simply yields no
    exemptions and the cap applies. A malformed stored value must not be able to
    turn into a bypass, and must not fail the write either.

    An `id` appearing more than once yields NO exemption, rather than whichever
    occurrence happens to be last. Keying a dict on it meant the same stored
    content accepted or refused the same write depending on array order, and a
    duplicated id is a stored value nobody should be reasoning about — declining
    to exempt it is the same fail-closed choice the unparseable cases make.
    """
    if not isinstance(stored, str) or not stored:
        return {}
    try:
        configs = json.loads(stored)
    except (json.JSONDecodeError, ValueError):
        return {}
    if not isinstance(configs, list):
        return {}

    urls_by_id: dict = {}
    duplicated: set = set()
    for config in configs:
        if not isinstance(config, dict) or not isinstance(config.get('id'), str):
            continue
        if config['id'] in urls_by_id:
            duplicated.add(config['id'])
            continue
        urls_by_id[config['id']] = config.get('urls')
    for config_id in duplicated:
        urls_by_id.pop(config_id, None)
    return urls_by_id


def _carries_the_stored_list_forward(config: object, stored_urls: dict) -> bool:
    """
    Whether this config's `urls` is byte-identical to the stored list for its id.

    Only the URL COUNT is exempted on the strength of this — the destinations of
    such a list are still checked, or an over-cap legacy config would be a place
    to park an internal URL that no later write would look at. Growing an
    already-over-cap list is a change, so it is not carried forward.
    """
    return (
        isinstance(config, dict)
        and isinstance(config.get('id'), str)
        and config['id'] in stored_urls
        and config.get('urls') == stored_urls[config['id']]
    )


def validate_scraper_config_write(scraper: dict, stored: object = None) -> None:
    """
    Check ONE config as a write, exempting a `urls` list it carries forward.

    What `POST /scrapers` calls. `validate_scraper_destinations` is the primitive
    and takes the exemption as a flag; this decides the flag from the stored
    array, so the single-config route and the whole-array route agree. They did
    not: the exemption was wired into the array route alone, so a pre-existing
    over-cap config was refused on EVERY save through `POST /scrapers` — including
    a change to an unrelated field — and trimming it required a save, leaving
    deletion as the only escape from a config that could no longer be edited.

    Args:
        stored: The currently-stored `webscraper_configs` string, if the caller
            has it. Absent, nothing is exempt and the cap applies as before.

    Raises:
        ValidationError: as `validate_scraper_destinations`.
    """
    stored_urls = _stored_urls_by_id(stored)
    validate_scraper_destinations(
        scraper,
        enforce_max_urls=not _carries_the_stored_list_forward(scraper, stored_urls),
    )


def validate_scraper_configs_json(raw: object, stored: object = None) -> None:
    """
    Same check for the serialized ARRAY of configs.

    `PUT /integrations/webscraper/credentials` stores its `configs` value as an
    opaque string, so this is the shape that route has to check. Unparseable
    input is refused rather than ignored: the ingestor's `_load_scraper_configs`
    logs a JSONDecodeError and scrapes nothing, so storing a broken array is a
    silently dead integration, and refusing it costs nothing.

    An empty string means "no configs" and is legal — that is the seeded default
    for the key.

    Args:
        stored: The currently-stored `configs` string, if the caller has it. Used
            only to tell an over-cap `urls` list this write CREATED from one it is
            carrying forward unchanged. This route persists the whole array, so
            without it a single pre-existing over-cap config made every later save
            fail — including edits to unrelated configs — naming a limit on a
            config the user never touched, with no in-app way to trim it. The
            destinations of an exempt list are still checked; only the count is.

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

    stored_urls = _stored_urls_by_id(stored)
    seen: set = set()
    for config in configs:
        validate_scraper_destinations(
            config,
            seen=seen,
            enforce_max_urls=not _carries_the_stored_list_forward(
                config, stored_urls
            ),
        )
