"""
Write-time destination checking for webscraper configurations (issue #244).

`shared/http_utils.py` owns the outbound-URL POLICY — what makes one URL a
permitted destination. This module owns the CONFIG shape: which keys of a saved
scraper configuration name a destination the scheduled ingestor will fetch, and
therefore what a write must refuse.

Two keys here name no destination and are checked anyway — `id` and `pagination`
— because the ingestor COMPUTES with them and an unusable value fails silently or
account-wide rather than visibly. Their reasons are recorded on
SCRAPER_ID_FIELD and PAGINATION_INT_BOUNDS.

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

# `pagination` names no destination — its URLs are built from base_url by
# concatenation, so they carry a host this module has already cleared, and the
# ingestor re-checks each one before its request anyway. It is checked here for a
# different reason: it is the one exempted key whose VALUE the ingestor does
# arithmetic with. `range(start + 1, start + max_pages)` raised TypeError on
# `max_pages: '10'`, and `pagination.get(...)` raised AttributeError on a non-dict
# — and both escaped `fetch_new_items`, stopping every config in the account
# rather than costing this one its pages. Both write routes accepted every one of
# those shapes, so the write path was checking the field that cannot hurt it and
# not the field that can. So: exempt from DESTINATION checking, not from SHAPE
# checking.
#
# `max_pages` is bounded the way the editor already bounds it (`min={1} max={50}`
# in frontend/src/pages/Scrapers/ScraperEditor.tsx), which also bounds the
# fetched-URL count — MAX_SCRAPER_URLS caps the URLs a config NAMES, and
# pagination multiplies that, so a config naming one base_url could ask for 1000
# fetches. A stored value outside the bound is refused rather than exempted like
# an over-cap `urls` list: unlike that list, the offender is one number the editor
# puts on screen, and the 400 names it, so it is fixable in-app without a save
# having to succeed first.
PAGINATION_FIELD = 'pagination'
PAGINATION_INT_BOUNDS = {'max_pages': (1, MAX_SCRAPER_URLS), 'start': (0, None)}

# `id` names no destination either, and is required here for the same reason
# `pagination`'s shape is: the ingestor computes with it, and an unusable one
# fails SILENTLY. `_extract_from_jsonld_item` and the CSS extraction path build
# `f"scraper_{config['id']}_{item_id}"`, and that KeyError is swallowed by
# `_scrape_page`'s per-item `except Exception` — so a config without an id fetched
# its pages and then dropped every item while the run reported
# `status: 'completed'`, `errors: []`, `pages_scraped: 1`, `items_found: 0`. That
# is indistinguishable from an empty but healthy run, which is precisely what the
# `outcome`/`pages_scraped` work on this issue was added to eliminate.
#
# It is also the WATERMARK key (`scraper_{id}_last_run`) and the metric name
# (`Scraper_{id}_Items`), so two configs sharing one id share a schedule — two
# id-less configs both read and wrote `scraper_unknown_last_run`, and the second
# was treated as not due. MAX_SCRAPER_ID_LENGTH keeps the metric name inside
# Powertools' 255-character limit, which a 300-character id exceeded (314) and
# which raises at `add_metric` time, i.e. after the items were already yielded.
#
# Only the type, emptiness and length are constrained; the character set
# deliberately is not, because every stored id was generated by a client
# (`scraper_${Date.now()}` in the editor) and refusing a shape that is merely
# unusual would make an existing account unsaveable for no defect.
#
# This is the rule for an id a write CREATES OR CHANGES. It is deliberately
# stricter than what the ingestor can work with, and the two are separate
# functions for a measured reason: `assert_scraper_id` refuses six shapes, and
# only ONE of them lost data. Measured through the real `fetch_new_items` before
# this rule existed, one healthy page each:
#
#   id='s1'      -> 1 item, scraper_s1_<hash>
#   id=7         -> 1 item, scraper_7_<hash>
#   id=''        -> 1 item, scraper__<hash>
#   id 200 chars -> 1 item, scraper_xxx…_<hash>
#   id ABSENT    -> 0 items, and the run still reported `completed`
#
# `f"scraper_{config['id']}_{item_id}"` interpolates any value, so the KeyError
# fired only for a MISSING key. Applying the write rule to stored configs as well
# therefore traded one config's silent loss for four configs' loud loss — an
# account holding an integer id (a shape `_stored_urls_by_id` and
# `_carries_the_stored_list_forward` both anticipate) stopped ingesting on deploy.
# So the ingestor gets `assert_ingestable_scraper_id`, which refuses only what
# cannot work, and a write that carries an unusable id forward untouched is
# exempted here — see `_unusable_stored_id_counts`. New ones are still refused.
SCRAPER_ID_FIELD = 'id'
MAX_SCRAPER_ID_LENGTH = 128


def _config_label(scraper: dict) -> str:
    """
    How to name a config in an error message.

    The array route refuses the whole write, so a message that does not say WHICH
    config is at fault leaves the user with no way to find it among many.

    Truncated because the value is a STORED string of unbounded length and this
    label goes into an error the API returns: naming a 300-character id echoed all
    300 characters back, and the message that does so is the one refusing it for
    being too long.
    """
    for key in ('id', 'name'):
        value = scraper.get(key)
        if isinstance(value, str) and value:
            shown = value if len(value) <= 40 else f"{value[:40]}..."
            return f"{key} {shown!r}"
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


def _assert_pagination_shape(scraper: dict) -> None:
    """
    Refuse a `pagination` the ingestor cannot compute with.

    Shape only — see PAGINATION_INT_BOUNDS for why this key is checked at all
    despite naming no destination. A bool is refused explicitly because
    `isinstance(True, int)` is True in Python, so `max_pages: true` would
    otherwise pass as the integer 1 and silently mean "one page".

    Absent is legal, and so is `{'enabled': False}`: the editor ships a pagination
    object for every scraper whether it is switched on or not. The bounds apply
    regardless of `enabled`, because the value is what gets stored and the toggle
    can be flipped later without re-validating.
    """
    pagination = scraper.get(PAGINATION_FIELD)
    if pagination is None:
        return
    if not isinstance(pagination, dict):
        raise ValidationError(
            f"{PAGINATION_FIELD} must be an object for {_config_label(scraper)}, "
            f"got {type(pagination).__name__}"
        )

    for key, (low, high) in PAGINATION_INT_BOUNDS.items():
        value = pagination.get(key)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValidationError(
                f"{PAGINATION_FIELD}.{key} must be an integer for "
                f"{_config_label(scraper)}, got {type(value).__name__}"
            )
        if value < low or (high is not None and value > high):
            bound = f"{low}-{high}" if high is not None else f"{low} or more"
            raise ValidationError(
                f"{PAGINATION_FIELD}.{key} must be {bound} for "
                f"{_config_label(scraper)}, got {value}"
            )


def assert_scraper_id(scraper: dict) -> None:
    """
    Refuse an `id` a write CREATES OR CHANGES and the ingestor cannot rely on.

    See SCRAPER_ID_FIELD for why this key is checked despite naming no
    destination: an unusable id is silent data loss, not a failed run.

    Refused at the write boundary rather than tolerated downstream because the
    ingestor's three "read the id defensively" sites (`_should_run_scraper`,
    `fetch_new_items`, `_configs_in_fairness_order`) exist to stop one bad config
    aborting the invocation, and cannot make an id-less config WORK — four other
    reads require the key, and defaulting them all to a shared 'unknown' would
    collide two such configs onto one watermark instead.

    NOT applied to an id a write merely carries forward unchanged — see
    `_claims_a_stored_unusable_id`, and `normalize_ingestable_scraper_id` for what
    the ingestor does with the ones already stored.
    """
    scraper_id = scraper.get(SCRAPER_ID_FIELD)
    if not isinstance(scraper_id, str) or isinstance(scraper_id, bool):
        raise ValidationError(
            f"{SCRAPER_ID_FIELD} must be a string for {_config_label(scraper)}, "
            f"got {type(scraper_id).__name__}"
        )
    if not scraper_id:
        # Names the config for the same reason every other refusal here does: the
        # array route refuses the WHOLE write, so a message that does not say which
        # config is at fault leaves the user hunting through the set.
        raise ValidationError(
            f"{SCRAPER_ID_FIELD} must not be empty for {_config_label(scraper)}"
        )
    if len(scraper_id) > MAX_SCRAPER_ID_LENGTH:
        raise ValidationError(
            f"{SCRAPER_ID_FIELD} must be at most {MAX_SCRAPER_ID_LENGTH} "
            f"characters for {_config_label(scraper)}, got {len(scraper_id)}"
        )


def normalize_ingestable_scraper_id(scraper: dict) -> str:
    """
    The id a STORED config can be ingested under, coercing what can be coerced.

    Deliberately WEAKER than `assert_scraper_id`, which is the rule for an id a
    write CREATES. Applying the write rule to stored configs stopped ingestion for
    shapes that worked end to end. Measured through the real `fetch_new_items`
    against one healthy page, before the write rule was applied here:

        id='s1'      -> 1 item, scraper_s1_<hash>
        id=7         -> 1 item, scraper_7_<hash>
        id=''        -> 1 item, scraper__<hash>
        id 200 chars -> 1 item, scraper_xxx…_<hash>
        id ABSENT    -> 0 items, and the run still reported `completed`

    `f"scraper_{config['id']}_{item_id}"` interpolates any value, so the KeyError
    fired only for a MISSING key — that one shape is the silent drop this check
    exists for. Refusing the other four traded one config's silent loss for four
    configs' loud loss, and an account holding an integer id (a shape
    `_stored_urls_by_id` and `_carries_the_stored_list_forward` both anticipate)
    stopped ingesting on deploy.

    So what a stored config must survive is what it already survived:

      * an `int` is COERCED. It stringifies to exactly one thing, and to the same
        thing the item ids and watermark keys already interpolated, so the config
        keeps its identity rather than acquiring a new one.
      * an EMPTY string and an OVER-LONG one are accepted. Both ingested before,
        and neither is repairable from the ingestor. The length is a metric-name
        problem, not an identity problem, so the CALLER bounds the metric name —
        see `_item_metric_name` in the webscraper ingestor. Refusing here instead
        would stop the ingestion the length does not actually prevent.

    Refused: an id that is absent, or one whose `str()` is not an identity anyone
    chose — `None`, a bool, a list, a dict. `str(True)`/`str(['s1'])` would make up
    an identity, and every stored id came from a client that generates
    `scraper_${Date.now()}`, so no real account holds one. That is a behaviour
    change for those shapes and is recorded in the CHANGELOG rather than left to be
    discovered; unlike the absent case it is not silent — the config reports
    `error` with the reason.

    MUTATES `scraper[SCRAPER_ID_FIELD]` when it coerces, because both extraction
    paths read `config['id']` directly to build the item id: returning the string
    alone would leave those reads on the stored value and the coercion would be a
    claim the items do not honour.

    Returns:
        The usable id, as a string.

    Raises:
        ValidationError: the id cannot be used at all. The caller reports the
            config as `error` rather than scraping it, so the failure is visible
            instead of being a page that yielded nothing.
    """
    scraper_id = scraper.get(SCRAPER_ID_FIELD)
    if isinstance(scraper_id, int) and not isinstance(scraper_id, bool):
        scraper_id = str(scraper_id)
        scraper[SCRAPER_ID_FIELD] = scraper_id
    if not isinstance(scraper_id, str):
        raise ValidationError(
            f"{SCRAPER_ID_FIELD} must be a string for {_config_label(scraper)}, "
            f"got {type(scraper_id).__name__}"
        )
    return scraper_id


def validate_scraper_destinations(
    scraper: dict,
    seen: set | None = None,
    enforce_max_urls: bool = True,
    enforce_id: bool = True,
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
        enforce_id: Whether the `id` requirement applies. False for an id this
            write carries forward from the stored array unchanged, for the same
            reason as `enforce_max_urls` and with the same measured failure behind
            it: the array route revalidates every config, so one legacy config the
            rule refuses blocked a rename of an UNRELATED config, and the offender
            could be neither renamed nor deleted. See `_unusable_stored_ids`.
            Everything else about such a config is still checked, and the ingestor
            still normalizes or refuses the id at fetch time — the exemption is
            about not gating unrelated edits, not about trusting the value.

    Raises:
        ValidationError: any destination is not a permitted outbound target, or
            a field does not hold the type it is documented to hold. Names the
            offending URL, because a config can hold several and "one of your
            URLs is invalid" is not actionable. Also raised for an `id` or a
            `pagination` the ingestor could not use — neither key names a
            destination, but both are this boundary's business because the
            ingestor computes with them and an unusable value fails downstream
            without saying so (see SCRAPER_ID_FIELD and PAGINATION_INT_BOUNDS).
    """
    if not isinstance(scraper, dict):
        # A list would sail past `.get()`-based validation as "no URLs to check".
        raise ValidationError('Scraper config must be an object')

    if seen is None:
        seen = set()

    # Before the destinations, so the cheap local answers arrive without a
    # resolver call, and so a config with both problems names one of these — they
    # are the ones a user can act on from the editor.
    if enforce_id:
        assert_scraper_id(scraper)
    _assert_pagination_shape(scraper)

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


def _id_identity(config: dict) -> str:
    """
    A hashable stand-in for a config's `id` VALUE, including "no id at all".

    `repr` rather than the value itself, because an unusable id may be a list or a
    dict and those are unhashable — and because it keeps `7` and `'7'` distinct,
    which matters: exempting one must not exempt the other.
    """
    if SCRAPER_ID_FIELD not in config:
        # Cannot collide with any repr: a stored string '<absent>' reprs with quotes.
        return '<absent>'
    return repr(config[SCRAPER_ID_FIELD])


def _unusable_stored_ids(stored: object) -> dict:
    """
    `{id identity: how many stored configs hold it}`, for ids a write would refuse.

    Why this exists: requiring `id` with no carry-forward exemption made ONE legacy
    config lock the whole array out. Measured with an id-less config stored beside a
    healthy one, through `PUT /integrations/webscraper/credentials` — which persists
    the WHOLE array, so it revalidates every config on every save:

        re-save the array unchanged (a no-op)   REFUSED, naming the legacy config
        edit ONLY the healthy config            REFUSED, naming the legacy config
        remove the legacy config                accepted

    That is the failure MAX_SCRAPER_URLS' exemption exists to prevent, and the
    escape was worse here: `DELETE /scrapers/<id>` compares a path-parameter string,
    so a stored integer id could not be matched by one at all. The offender could
    not be renamed, could not be deleted, and blocked every array write.

    Best-effort, exactly like `_stored_urls_by_id`: an unparseable stored value
    yields no exemptions and the requirement applies as before, so a malformed
    secret cannot become a bypass and cannot fail the write either.

    COUNTED rather than merely collected, so the exemption cannot be used twice: an
    array with one stored `id: 7` may carry that one forward, and a second config
    claiming `id: 7` is a config this write is adding and is refused.
    """
    if not isinstance(stored, str) or not stored:
        return {}
    try:
        configs = json.loads(stored)
    except (json.JSONDecodeError, ValueError):
        return {}
    if not isinstance(configs, list):
        return {}

    counts: dict = {}
    for config in configs:
        if not isinstance(config, dict):
            continue
        try:
            assert_scraper_id(config)
        except ValidationError:
            identity = _id_identity(config)
            counts[identity] = counts.get(identity, 0) + 1
    return counts


def _claims_a_stored_unusable_id(config: object, unusable_ids: dict) -> bool:
    """
    Whether this config carries forward an unusable id the array already holds.

    CONSUMES the claim, so N stored configs with the same unusable id exempt N
    configs in this write and no more. Nothing else about such a config is
    exempted: its destinations, its `pagination` shape and its URL count are all
    still checked, or a legacy config would become a place to park an internal URL
    that no later write would look at.
    """
    if not isinstance(config, dict):
        return False
    identity = _id_identity(config)
    if unusable_ids.get(identity, 0) <= 0:
        return False
    unusable_ids[identity] -= 1
    return True


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
            has it. Absent, nothing is exempt and both the cap and the `id`
            requirement apply as before.

    Raises:
        ValidationError: as `validate_scraper_destinations`.
    """
    stored_urls = _stored_urls_by_id(stored)
    validate_scraper_destinations(
        scraper,
        enforce_max_urls=not _carries_the_stored_list_forward(scraper, stored_urls),
        enforce_id=not _claims_a_stored_unusable_id(
            scraper, _unusable_stored_ids(stored)
        ),
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
            only to tell what this write CREATED from what it is carrying forward
            unchanged — an over-cap `urls` list, and an `id` the requirement
            refuses. This route persists the whole array, so without it a single
            pre-existing offender made every later save fail — including edits to
            unrelated configs — naming a rule broken by a config the user never
            touched, with no in-app way to repair it. The destinations, the
            pagination shape and the id's own downstream handling are unaffected;
            only these two gates are relaxed, and only for a value this write does
            not change.

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
    # One tally for the whole array, mutated as claims are consumed: a config may
    # carry forward an unusable id the stored array holds, and two configs may not
    # both claim the same one.
    unusable_ids = _unusable_stored_ids(stored)
    seen: set = set()
    for config in configs:
        validate_scraper_destinations(
            config,
            seen=seen,
            enforce_max_urls=not _carries_the_stored_list_forward(
                config, stored_urls
            ),
            enforce_id=not _claims_a_stored_unusable_id(config, unusable_ids),
        )
