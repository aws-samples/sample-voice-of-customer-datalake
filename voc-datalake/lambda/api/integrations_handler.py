"""
Integrations API Lambda - Handles /integrations/*, /sources/*
Manages API credentials and data source schedules.
"""

import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC
from functools import cache
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from shared.api import api_handler, create_api_resolver, require_admin
from shared.aws import get_secrets_client, put_secret_json
from shared.enabled_sources import default_source_ids
from shared.exceptions import (
    ConfigurationError,
    ServiceError,
    ValidationError,
)
from shared.ids import timestamped_id
from shared.logging import logger, tracer
from shared.plugin_identity import PLUGIN_IDENTIFIER_RULES, is_valid_plugin_identifier
from shared.request_body import json_body_value, json_object_body
from shared.snapstart import api_route_warmer, botocore_model_warmer, register_snapshot_hooks

secretsmanager = get_secrets_client()
events_client = boto3.client("events")

SECRETS_ARN = os.environ.get("SECRETS_ARN", "")
AWS_ACCOUNT_ID = os.environ.get("DEPLOY_ACCOUNT_ID", os.environ.get("AWS_ACCOUNT_ID", ""))
AWS_REGION = os.environ.get("DEPLOY_REGION", os.environ.get("AWS_REGION", ""))

# Name PATTERNS handed down by CDK, e.g.
# "stg-voc-ingestor-{source}-123456789012-us-east-1". Both routes below address
# a PER-PLUGIN resource, so a single fixed name will not do — but resolving the
# pattern is infrastructure's job (as with WEBSCRAPER_FUNCTION_NAME in
# scrapers_handler.py), not this handler's. Set only where the derivation below
# would be wrong, so this handler never needs to know a deployment prefix
# exists: prefer the pattern when given one, otherwise derive as before.
INGESTOR_FUNCTION_NAME_PATTERN = os.environ.get("INGESTOR_FUNCTION_NAME_PATTERN", "")
INGEST_SCHEDULE_RULE_NAME_PATTERN = os.environ.get("INGEST_SCHEDULE_RULE_NAME_PATTERN", "")

SOURCE_PLACEHOLDER = "{source}"

# Plugin secret DEFAULTS handed down by CDK as {plugin_id: {key: seeded_value}} —
# the same data ingestion-stack's createApiSecrets() used to seed the shared
# secret, just nested so the plugin id is recoverable.
#
# Two things this handler cannot otherwise know, both of which it needs:
#
#  1. WHICH SOURCES EXIST. Plugin manifests are read at CDK synth time, so an
#     enumerated list in Python is a copy that goes stale the moment a plugin is
#     added — the same reason the ingestor NAME is handed down above rather than
#     rebuilt here. This replaces the hardcoded list that shipped earlier.
#
#  2. WHICH STORED VALUES A HUMAN ACTUALLY ENTERED. This is the load-bearing
#     one. Every key is seeded at deploy time, and several defaults are NON-EMPTY
#     ('[]' for webscraper configs, 'imports/', 'most_recent', '500', '1440'), so
#     "the key holds a truthy value" is true for 4 of 5 sources on a fresh deploy
#     with nothing configured. A seeded default is not an absent value; only a
#     value that DIFFERS from its default tells you a human was here.
#
# Read inside _plugin_secret_defaults() rather than at module scope, so a test
# can set it and clear the cache. It is parsed once per execution context either
# way, which is what the cache is for.
PLUGIN_DEFAULTS_ENV_VAR = "PLUGIN_SECRET_DEFAULTS"

app = create_api_resolver()

# ---------------------------------------------------------------------------
# Credential key validation
#
# We validate the *form* of each key rather than an enumerated per-source
# list, because this Lambda cannot see plugin manifests directly (they are
# resolved at CDK synth time, not at runtime).  The manifest-derived allowlist
# that used to be described here as a follow-up now exists for the `source`
# parameter — see `_validate_source_is_a_known_plugin` — because form validation
# alone left a real cross-plugin credential write open.
#
# That allowlist applies to EVERY route taking a `<source>` path parameter, via
# `_validate_source_parameter`. It was first wired into the two credentials routes
# only, which left five routes turning the same request-supplied value into a
# Secrets Manager key, an ingestor function name or an EventBridge rule name with
# no check at all — an asymmetry that read as deliberate scoping but was just
# where the trail of one reported bug ended.
#
# The character class itself lives in `shared/plugin_identity.py`, NOT here: the
# READ side (`plugins/_shared/plugin_secrets.py`) has to validate the same shape
# on the plugin identity it turns into a namespace prefix, and since issue #251 a
# namespace miss there is a hard failure rather than a silent widening. Two
# copies of the rule is how a value this path accepts becomes one that path
# refuses. `shared/` is the only directory both bundles carry.
#
# The rules that stay here, because they bound a REQUEST rather than validate a
# value — there is no read side to share them with:
#   • At most MAX_CREDENTIAL_KEYS_PER_REQUEST keys per write request.
#   • At most MAX_SOURCES_PER_STATUS_REQUEST distinct sources per status request.
MAX_CREDENTIAL_KEYS_PER_REQUEST = 20

# `GET /sources/status?sources=a,b,c` issues one `describe_rule` per element, so
# unlike every other read in this handler its AWS call count is chosen by the
# caller. A write is not the only thing with a request to bound: a read that fans
# out per list element has one too, and this is the only such read here.
#
# Sized well above the realistic plugin count (five manifests today, and the
# route's own default list is three) so it bounds abuse rather than use — the UI
# asks for at most one source at a time (`api.getSourcesStatus([plugin.id])`).
# Applied AFTER de-duplication, because the bound that matters is the number of
# rules actually described, not the length of a string the caller typed.
MAX_SOURCES_PER_STATUS_REQUEST = 50


def _validate_credential_key(key: object) -> None:
    """Raise ValidationError if *key* does not conform to the allowed form.

    The key preview in the error message is truncated to avoid reflecting
    unbounded caller input back in the response.
    """
    if not is_valid_plugin_identifier(key):
        preview = repr(key[:40]) if isinstance(key, str) else repr(key)
        raise ValidationError(
            f"Invalid credential key {preview}: keys {PLUGIN_IDENTIFIER_RULES}."
        )


def _validate_source(source: object) -> None:
    """Raise ValidationError if *source* does not conform to the allowed form.

    'source' is used as a namespace prefix (f"{source}_"), so it must satisfy
    the same character-class rules as credential keys.  The error message uses
    'source identifier' rather than 'credential key' so it is clear which
    input parameter is invalid when debugging a 400.
    """
    if not is_valid_plugin_identifier(source):
        preview = repr(source[:40]) if isinstance(source, str) else repr(source)
        raise ValidationError(
            f"Invalid source identifier {preview}: source {PLUGIN_IDENTIFIER_RULES}."
        )


def _validate_source_is_a_known_plugin(source: str) -> None:
    """Raise ValidationError unless *source* is a plugin CDK told us about.

    The form check above cannot close the namespace-collision gap, because the
    colliding value is WELL-FORMED. `source` becomes a key prefix, so
    `source='app_reviews'` + key `'ios_app_id'` writes `app_reviews_ios_app_id`
    — which `app_reviews_ios`'s Lambda then reads as its own `app_id`. Since
    issue #251 the prefix scan in `plugins/_shared/plugin_secrets.py` is the
    ENTIRE isolation boundary between plugins (all ingestion Lambdas share one
    IAM role), so a write that lands inside another plugin's namespace is a
    cross-plugin credential injection, not a display quirk. `plugin-loader.ts`
    refuses a manifest id that is a prefix of another's, but that guard is over
    *manifest ids* and cannot see a `source` invented in a request.

    So the namespace a write may address is restricted to the plugin ids
    themselves. `PLUGIN_SECRET_DEFAULTS` is the manifest-derived list this
    handler is already handed for exactly this reason — no new plumbing, and it
    cannot drift from the manifests CDK read.

    Fails OPEN when that variable is absent or malformed: `_plugin_secret_defaults`
    already degrades to `{}` rather than 500ing the Settings page, and turning
    that degradation into "no source may be configured at all" would let one bad
    environment variable break credential management entirely. The form check
    still applies in that case, which is the state this route shipped in.

    Applied through `_validate_source_parameter` on every route that turns
    `<source>` into a secret key, a Lambda function name or an EventBridge rule
    name — not just the two credentials routes it was first written for.
    """
    known = _plugin_secret_defaults()
    if not known:
        logger.warning(
            "PLUGIN_SECRET_DEFAULTS unavailable; accepting any well-formed source"
        )
        return
    if source not in known:
        # Names the rejected source but NOT the known ones: an error caused by a
        # wrong source must not become a directory of the right ones, which is the
        # same discipline `filter_plugin_secrets` applies on the read side.
        raise ValidationError(
            f"Unknown source identifier {source[:40]!r}: it is not a configured plugin."
        )


def _validate_source_parameter(source: str) -> None:
    """Both source checks, for every route that takes a `<source>` path parameter.

    ONE helper rather than two calls per route, because the asymmetry this closed
    was exactly that: the two checks were wired into the credentials routes and
    into nothing else, while five other routes turned the same request-supplied
    `<source>` into a resource name. Every one of them addresses something derived
    from it — a Secrets Manager key (`_get_app_configs_key`), an ingestor function
    name (`_build_ingestor_function_name`) or an EventBridge rule name
    (`_build_rule_name`) — so there is no route on which "is this a real plugin?"
    is the wrong question, and a single call site per route is one thing to
    remember rather than two.

    Order matters: the form check first, so a value that is not even a plausible
    identifier is reported as malformed rather than as unknown.
    """
    _validate_source(source)
    _validate_source_is_a_known_plugin(source)


def _is_addressable_source(source: str) -> bool:
    """The same rule as `_validate_source_parameter`, as a predicate.

    Calls it rather than restating the rule, because a second copy of "is this a
    real plugin?" is how the read side comes to accept a value the write side
    refuses — the drift that put the character class in `shared/plugin_identity.py`
    in the first place.

    Needed because ONE route cannot raise. `GET /sources/status?sources=a,b,c`
    answers about several sources at once, so raising on the first unknown name
    would fail the whole response rather than that one entry — and its own default
    list (`shared.enabled_sources.default_source_ids`) ends with `manual_import`, which
    is a deliberate non-plugin: it is a legitimate `source_platform` (manual
    imports are written with it by `manual_import_handler`) with no manifest, so it is
    absent from `PLUGIN_SECRET_DEFAULTS` and a raising guard would answer 400 to
    the argument-less request `SourceCard.tsx` issues on every Settings render —
    for admins too.

    Skipping the EventBridge call for a source this rejects is OUTPUT-IDENTICAL
    for every input the UI sends. A schedule rule is only ever created per plugin
    (`scheduleRuleName` in `lib/stacks/ingestion-stack.ts` is built from
    `plugin.id`), so for every value rejected here `describe_rule` could only have
    raised `ResourceNotFoundException`, which the route already answers with
    `{'enabled': False, 'exists': False}` — exactly what the default request
    returns for `manual_import`. What changes is that an arbitrary
    value stops reaching EventBridge and stops having a rule name reflected back.

    Inherits the fail-open on an unavailable `PLUGIN_SECRET_DEFAULTS`, because
    `_validate_source_is_a_known_plugin` returns early in that state — so in that
    state this accepts everything the other branch does too, and the deliberate
    disagreement below is a property of the CONFIGURED state only.

    Applies to the `?sources=` branch ONLY. `?run_status=` raises on the same
    `manual_import` this accepts, deliberately: see the comment at that branch for
    why one identifier gets two answers from one route.
    """
    try:
        _validate_source_parameter(source)
    except ValidationError:
        return False
    return True


# Stored strings that carry no configuration, whatever key they sit under.
# '[]' and '{}' matter because save_app_config() below writes `<source>_configs`
# at RUNTIME for the multi-instance app plugins, so no manifest declares those
# keys and there is no seeded default to compare them against — an untouched one
# holds '[]', which is truthy.
_EMPTY_STORED_VALUES = frozenset({'', '[]', '{}'})


def _is_configured_value(value: object, seeded_default: str | None) -> bool:
    """True when *value* holds configuration a human entered.

    Two independent reasons a stored value means "nothing is set up here", and
    neither subsumes the other:

      1. It still equals the default CDK seeded for that key. Needed for the
         non-empty defaults ('imports/', 'most_recent', '500', '1440') that a
         content check cannot distinguish from a real choice.
      2. It is empty or an empty JSON container. Needed for keys with NO declared
         default — the runtime-written `<source>_configs` arrays — where there is
         nothing to compare against.
    """
    # Trusts the annotation rather than re-checking isinstance: the only producer
    # is _plugin_secret_defaults(), which keeps str -> str pairs and drops the rest,
    # and .get() supplies the None for a key with no declared default.
    default = seeded_default.strip() if seeded_default is not None else None

    if not isinstance(value, str):
        # The secret is parsed JSON, so a value need not be a string: a hand-edited
        # console entry can store a real array, object, number or null. Emptiness is
        # judged on the object (so 0, [], {} and None are all unset), then the
        # default comparison is made on its text — an int 1440 beside the seeded
        # '1440' is the same unconfigured state as the string, and skipping the
        # comparison for non-strings would report it as configured.
        return bool(value) and str(value) != default
    stripped = value.strip()
    if stripped in _EMPTY_STORED_VALUES:
        return False
    return stripped != default


@cache
def _plugin_secret_defaults() -> dict[str, dict[str, str]]:
    """Parse PLUGIN_SECRET_DEFAULTS into {plugin_id: {key: seeded_default}}.

    Fails SOFT to an empty mapping: a malformed or absent variable must not turn
    the Settings page into a 500. The visible consequence is that
    /integrations/status reports no sources, which reads as "nothing is set up"
    — wrong, but inert, and it is the same thing the route returned before any
    source list existed.  A hard failure here would take out the enable/disable
    and run routes in the same Lambda, which do not use this at all.

    Entries that are not a str -> str mapping are dropped individually rather
    than voiding the whole variable, so one bad plugin cannot hide the others.
    """
    raw = os.environ.get(PLUGIN_DEFAULTS_ENV_VAR, "")
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except ValueError:
        logger.warning("PLUGIN_SECRET_DEFAULTS is not valid JSON; reporting no sources")
        return {}
    if not isinstance(parsed, dict):
        logger.warning("PLUGIN_SECRET_DEFAULTS is not a JSON object; reporting no sources")
        return {}

    defaults: dict[str, dict[str, str]] = {}
    for source, keys in parsed.items():
        if not isinstance(source, str) or not isinstance(keys, dict):
            logger.warning(f"Ignoring malformed PLUGIN_SECRET_DEFAULTS entry for {source!r}")
            continue
        defaults[source] = {
            key: value for key, value in keys.items()
            if isinstance(key, str) and isinstance(value, str)
        }
    return defaults


def _deploy_suffix() -> str:
    return f"-{AWS_ACCOUNT_ID}-{AWS_REGION}" if AWS_ACCOUNT_ID and AWS_REGION else ""


def _build_rule_name(source: str) -> str:
    """Build the EventBridge rule name for a source's schedule."""
    if INGEST_SCHEDULE_RULE_NAME_PATTERN:
        return INGEST_SCHEDULE_RULE_NAME_PATTERN.replace(SOURCE_PLACEHOLDER, source)
    return f"voc-ingest-{source}-schedule{_deploy_suffix()}"


def _build_ingestor_function_name(source: str) -> str:
    """Build the ingestor Lambda function name for a source."""
    if INGESTOR_FUNCTION_NAME_PATTERN:
        return INGESTOR_FUNCTION_NAME_PATTERN.replace(SOURCE_PLACEHOLDER, source)
    return f"voc-ingestor-{source}{_deploy_suffix()}"


@app.get("/integrations/status")
@tracer.capture_method
def get_integration_status():
    """Get status of all integrations.

    Requires admin access — the response contains names of configured
    credential keys, which reveals what integrations are active.
    """
    require_admin(app.current_event.raw_event)

    if not SECRETS_ARN:
        raise ConfigurationError('Secrets not configured')

    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))

        # Report status for every source CDK told us about.  For each one, scan
        # the shared secret for keys named "{source}_*" — a prefix scan rather
        # than an iteration over declared keys, so a key written via PUT
        # /integrations/<source>/credentials shows up without a manifest change.
        #
        # A key counts as configured only when it holds a value that DIFFERS
        # from the default CDK seeded.  Every key exists from the moment the
        # stack deploys, and several defaults are non-empty, so mere presence
        # (or truthiness) reports a source as connected before anyone has
        # touched it — see the PLUGIN_SECRET_DEFAULTS comment at the top.
        #
        # The strip of the namespace prefix means the frontend sees bare field
        # names ('configs', 'app_id') rather than prefixed ones
        # ('webscraper_configs', 'app_reviews_ios_app_id').
        status = {}
        for source, seeded in _plugin_secret_defaults().items():
            prefix = f"{source}_"
            # CAVEAT: plain prefix match, so if one plugin id were ever a
            # prefix of another ('app_reviews' alongside 'app_reviews_ios') the
            # shorter one would also list the longer one's keys. No current id
            # pair does this, and `loadPlugins` now refuses such a manifest pair at
            # synth time. Iterating `seeded` by declared key instead would remove
            # the caveat here too, at the cost of the write-through property above.
            # This loop is over ids CDK supplied, so it cannot be reached by a
            # request-supplied source — that entrance is closed separately, in
            # _validate_source_is_a_known_plugin.
            configured_keys = sorted(
                key[len(prefix):]
                for key, value in secrets.items()
                if key.startswith(prefix)
                and len(key) > len(prefix)
                and _is_configured_value(value, seeded.get(key[len(prefix):]))
            )
            status[source] = {
                'configured': len(configured_keys) > 0,
                'credentials_set': configured_keys,
            }
    except ConfigurationError:
        raise
    except Exception as e:
        logger.exception(f"Failed to get integration status: {e}")
        raise ServiceError('Failed to retrieve integration status') from e
    else:
        return status


@app.get("/integrations/<source>/credentials")
@tracer.capture_method
def get_credentials(source: str):
    """Get saved configuration values for an integration so the Settings UI
    can pre-populate form fields (e.g. app_name, sort_by, frequency).

    This is NOT returning sensitive API keys — the app review plugins use
    public endpoints with no authentication. The values stored in Secrets
    Manager for these plugins are non-secret configuration like app names,
    package names, and tuning parameters. Secrets Manager is reused as the
    storage backend because the existing plugin infrastructure already
    reads config from there via BaseIngestor._load_secrets().

    The caller must specify which keys to retrieve via the `keys` query
    parameter (comma-separated). Only matching keys are returned.

    Requires admin access — credential management is an administrative operation.

    NOTE: Whether this endpoint needs to return actual values (vs. a
    configured/not-configured status) is an open question.  Returning only
    presence information would be safer and would serve the Settings UI equally
    well, but that changes the frontend contract and should be done as a
    separate change with coordinated frontend work.
    """
    require_admin(app.current_event.raw_event)

    # Validate source before building the namespace prefix.  Without this
    # a caller sending source='foo_bar' + key='baz' would reach the same
    # secret key as source='foo' + key='bar_baz' (namespace collision) — and the
    # form check alone is not sufficient, because the colliding value is
    # well-formed: source='app_reviews' + key='ios_app_id' addresses
    # app_reviews_ios's namespace.
    _validate_source_parameter(source)

    if not SECRETS_ARN:
        raise ConfigurationError('Secrets not configured')

    params = app.current_event.query_string_parameters or {}
    keys_param = params.get('keys', '')
    if not keys_param:
        raise ValidationError('Missing required query parameter: keys')

    requested_keys = [k.strip() for k in keys_param.split(',') if k.strip()]

    # Validate every requested key before touching the secret — mirrors the
    # all-or-nothing validation on the write path.
    for key in requested_keys:
        _validate_credential_key(key)

    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))

        prefix = f"{source}_"
        result = {}
        for key in requested_keys:
            prefixed_key = f"{prefix}{key}"
            # Only look up the namespaced key; no unprefixed fallback.
            # An unprefixed fallback would allow any caller to read keys
            # belonging to other features (e.g. webscraper_api_key written
            # by the scrapers handler as a top-level secret key).
            if secrets.get(prefixed_key):
                result[key] = secrets[prefixed_key]
    except (ConfigurationError, ValidationError):
        raise
    except Exception as e:
        logger.exception(f"Failed to get credentials for {source}: {e}")
        raise ServiceError('Failed to retrieve credentials') from e
    else:
        return result


@app.put("/integrations/<source>/credentials")
@tracer.capture_method
def update_credentials(source: str):
    """Update credentials for an integration.

    Requires admin access — credential management is an administrative operation.

    Each key in the request body must conform to the allowed form (lowercase
    letters, digits, and underscores only; 1-64 characters; no leading/trailing
    underscores).  Unrecognised or malformed keys are rejected with a 400 error
    before any write is attempted.

    At most MAX_CREDENTIAL_KEYS_PER_REQUEST keys may be written per request.

    NOTE: Credential deletion is not currently supported.  Sending null or an
    empty string for a key silently skips it, leaving the stored value unchanged.
    """
    require_admin(app.current_event.raw_event)

    # The write is the dangerous direction: without the allowlist half of this,
    # a caller could inject a value into another plugin's namespace
    # (source='app_reviews' + key 'ios_app_id' → app_reviews_ios_app_id) and that
    # plugin's next run would use it as its own credential.
    _validate_source_parameter(source)

    if not SECRETS_ARN:
        raise ConfigurationError('Secrets not configured')

    body = json_body_value(app)

    # Reject non-dict bodies (list, string, null) before any further processing.
    if not isinstance(body, dict):
        raise ValidationError('Request body must be a JSON object.')

    # Validate key count before touching the secret.
    if len(body) > MAX_CREDENTIAL_KEYS_PER_REQUEST:
        raise ValidationError(
            f"Too many keys in request: {len(body)} exceeds the limit of "
            f"{MAX_CREDENTIAL_KEYS_PER_REQUEST}."
        )

    # Validate every key and value before writing anything — fail fast,
    # all-or-nothing.  Size is NOT checked per value: the bound that matters is
    # the serialized total, enforced once in put_secret_json (see its docstring
    # for why a per-value cap is wrong in both directions).
    for key, value in body.items():
        _validate_credential_key(key)
        if value is not None and not isinstance(value, str):
            raise ValidationError(
                f"Value for key {key[:40]!r} must be a string."
            )

    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))

        prefix = f"{source}_"
        for key, value in body.items():
            # Falsy values (null/empty string) are skipped — sending null or ""
            # does NOT delete the key.  Credential deletion is not currently
            # supported via this endpoint.
            if value:
                secrets[f"{prefix}{key}"] = value

        put_secret_json(secretsmanager, SECRETS_ARN, secrets)
    except (ConfigurationError, ValidationError):
        raise
    except Exception as e:
        logger.exception(f"Failed to update credentials: {e}")
        raise ServiceError('Failed to update credentials') from e
    else:
        return {'success': True, 'message': f'Credentials updated for {source}'}


# ============================================
# App Config CRUD (multi-instance plugins)
# ============================================

APP_CONFIG_PLUGINS = {'app_reviews_ios', 'app_reviews_android'}


def _app_configs_in_secret(source: str) -> tuple[dict, str, list]:
    """The shared secret as stored, the key `source`'s app configs live under, and those configs.

    The read half of every app-config route's read-modify-write; the write half is
    `put_secret_json` on the same `secrets` dict.
    """
    response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
    secrets = json.loads(response.get('SecretString', '{}'))
    configs_key = _get_app_configs_key(source)
    configs = json.loads(secrets.get(configs_key, '[]'))
    return secrets, configs_key, configs


def _get_app_configs_key(source: str) -> str:
    """Get the Secrets Manager key for a plugin's app configs array."""
    return f"{source}_configs"


@app.get("/integrations/<source>/apps")
@tracer.capture_method
def list_app_configs(source: str):
    """List all app configurations for a multi-instance plugin.

    NOT admin-gated, unlike the two write routes below. The Scrapers page renders
    this list for every authenticated user, and an app config holds a public app
    store id and a display name — not a credential. The write routes are the ones
    that reach the shared secret with caller-supplied content.
    """
    # Both source checks even though APP_CONFIG_PLUGINS is narrower and runs
    # below: `source` reaches `_get_app_configs_key` and becomes a Secrets Manager
    # key, so it goes through the same validation as every other route that does
    # that. The two are not redundant in the direction that matters — a value can
    # be a real plugin id and still not support app configs.
    _validate_source_parameter(source)
    if source not in APP_CONFIG_PLUGINS:
        raise ValidationError(f'Source {source} does not support multiple app configs')
    if not SECRETS_ARN:
        return {'apps': []}

    try:
        _secrets, _configs_key, configs = _app_configs_in_secret(source)
    except (ConfigurationError, ValidationError):
        raise
    except (ClientError, BotoCoreError, ValueError, TypeError, AttributeError) as e:
        # An AWS failure, or a secret whose JSON is not the {key: str} shape.
        logger.warning(f"Could not read app configs for {source}: {e}")
        return {'apps': []}
    else:
        return {'apps': configs}


@app.post("/integrations/<source>/apps")
@tracer.capture_method
def save_app_config(source: str):
    """Save (create or update) an app configuration for a multi-instance plugin.

    Admin-gated, matching PUT /integrations/<source>/credentials: this route calls
    `put_secret_json` on the SAME shared API-credentials secret, with content the
    caller supplied. Gating the credentials route while leaving this one open made
    the boundary depend on which key a write happened to land under, and a
    `users`-group caller could write `<source>_configs` on it — measured, 200.
    """
    require_admin(app.current_event.raw_event)
    _validate_source_parameter(source)
    if source not in APP_CONFIG_PLUGINS:
        raise ValidationError(f'Source {source} does not support multiple app configs')
    if not SECRETS_ARN:
        raise ConfigurationError('Secrets not configured')

    body = json_object_body(app)
    app_config = body.get('app')
    if not app_config:
        raise ValidationError('No app config provided')

    # Validate required fields
    if not app_config.get('id'):
        import uuid
        app_config['id'] = str(uuid.uuid4())[:8]
    if not app_config.get('app_name'):
        raise ValidationError('app_name is required')

    try:
        secrets, configs_key, configs = _app_configs_in_secret(source)

        existing_idx = next((i for i, c in enumerate(configs) if c.get('id') == app_config['id']), None)
        if existing_idx is None:
            configs.append(app_config)
        else:
            configs[existing_idx] = app_config

        secrets[configs_key] = json.dumps(configs)
        put_secret_json(secretsmanager, SECRETS_ARN, secrets)
    except (ConfigurationError, ValidationError):
        raise
    except Exception as e:
        logger.exception(f"Failed to save app config for {source}: {e}")
        raise ServiceError('Failed to save app configuration') from e
    else:
        return {'success': True, 'app': app_config}


@app.delete("/integrations/<source>/apps/<app_id>")
@tracer.capture_method
def delete_app_config(source: str, app_id: str):
    """Delete an app configuration from a multi-instance plugin.

    Admin-gated for the same reason as the POST above — it writes the shared
    secret — and additionally because it is destructive: it rewrites
    `<source>_configs` with one entry removed, which stops that app being
    ingested.
    """
    require_admin(app.current_event.raw_event)
    _validate_source_parameter(source)
    if source not in APP_CONFIG_PLUGINS:
        raise ValidationError(f'Source {source} does not support multiple app configs')
    if not SECRETS_ARN:
        raise ConfigurationError('Secrets not configured')

    try:
        secrets, configs_key, configs = _app_configs_in_secret(source)
        configs = [c for c in configs if c.get('id') != app_id]
        secrets[configs_key] = json.dumps(configs)
        put_secret_json(secretsmanager, SECRETS_ARN, secrets)
    except (ConfigurationError, ValidationError):
        raise
    except Exception as e:
        logger.exception(f"Failed to delete app config for {source}: {e}")
        raise ServiceError('Failed to delete app configuration') from e
    else:
        return {'success': True}


@app.post("/sources/<source>/run")
@tracer.capture_method
def run_source(source: str):
    """Manually trigger a data source ingestor Lambda.

    Optionally accepts a JSON body with `app_id` to run a single app
    config instead of all configs for the source.

    Admin-gated: this invokes a Lambda that fetches from a third-party API and
    writes to the data lake, so every call costs money and consumes whatever rate
    limit that API grants. Ungated, a `users`-group caller could invoke it in a
    loop — measured, 200 with a real `lambda:Invoke` and a `SOURCE_RUN#` row
    written. `enable_source`/`disable_source` are gated for the mirror reason:
    disabling a schedule silently stops ingestion.

    `source` is also validated, which it was not: it is interpolated straight into
    `_build_ingestor_function_name`, so an arbitrary value both named a function
    to invoke and wrote a `SOURCE_RUN#<source>` partition that nothing ever reads
    or expires.
    """
    from datetime import datetime

    from shared.tables import get_aggregates_table

    require_admin(app.current_event.raw_event)
    _validate_source_parameter(source)

    function_name = _build_ingestor_function_name(source)

    execution_id = timestamped_id(f'run_{source}', datetime.now(UTC))
    payload: dict = {"manual_trigger": True, "execution_id": execution_id}
    # The body is optional: a missing or malformed one (not JSON, or not an
    # object) runs every app config — deliberately not a 400.
    try:
        body = json_object_body(app)
    except ValidationError:
        body = {}
    if body.get("app_id"):
        payload["app_id"] = body["app_id"]

    # Create initial run status record
    try:
        table = get_aggregates_table()
        if table:
            table.put_item(Item={
                'pk': f'SOURCE_RUN#{source}', 'sk': execution_id,
                'status': 'running', 'items_found': 0,
                'started_at': datetime.now(UTC).isoformat(),
            })
    except (ClientError, BotoCoreError) as e:
        logger.warning(f"Failed to create run status: {e}")

    lambda_client = boto3.client("lambda")
    try:
        response = lambda_client.invoke(
            FunctionName=function_name,
            InvocationType="Event",
            Payload=json.dumps(payload).encode(),
        )
    except lambda_client.exceptions.ResourceNotFoundException as e:
        raise ServiceError(f"Ingestor Lambda not found for source: {source}") from e
    except Exception as e:
        logger.exception(f"Failed to trigger source {source}: {e}")
        raise ServiceError(f"Failed to trigger {source} ingestor") from e
    status_code = response.get("StatusCode", 0)
    if status_code != 202:
        raise ServiceError(f"Lambda invoke returned status {status_code}")
    return {"success": True, "message": f"Triggered {source} ingestor", "source": source, "execution_id": execution_id}


def _get_source_run_status(source: str):
    """Get the latest run status for a data source plugin."""
    from boto3.dynamodb.conditions import Key

    from shared.tables import get_aggregates_table

    table = get_aggregates_table()
    if not table:
        return {'source': source, 'status': 'unknown'}
    try:
        response = table.query(
            KeyConditionExpression=Key('pk').eq(f'SOURCE_RUN#{source}'),
            ScanIndexForward=False, Limit=1,
        )
        items = response.get('Items', [])
        if not items:
            return {'source': source, 'status': 'never_run'}
        run = items[0]
        return {
            'source': source,
            'execution_id': run.get('sk'),
            'status': run.get('status', 'unknown'),
            'started_at': run.get('started_at'),
            'completed_at': run.get('completed_at'),
            'items_found': run.get('items_found', 0),
            'errors': run.get('errors', []),
        }
    except (ClientError, BotoCoreError) as e:
        logger.warning(f"Failed to get source run status: {e}")
        return {'source': source, 'status': 'unknown'}


# Concurrent DescribeRule calls one GET /sources/status makes. The default list
# is a handful of sources; the cap keeps a 50-source request (the per-request
# maximum) from bursting EventBridge's per-account DescribeRule rate.
MAX_PARALLEL_RULE_DESCRIBES = 8


def _schedule_status(source: str) -> dict:
    """One source's schedule state, from its EventBridge rule.

    Deliberate per-item boundary: any failure degrades this source's entry only;
    the batch still answers.
    """
    rule_name = _build_rule_name(source)
    try:
        response = events_client.describe_rule(Name=rule_name)
    except events_client.exceptions.ResourceNotFoundException:
        return {'enabled': False, 'exists': False}
    except Exception:
        logger.exception(f"Failed to get status for source {source}")
        return {'enabled': False, 'error': 'Failed to retrieve status'}
    return {
        'enabled': response.get('State') == 'ENABLED',
        'schedule': response.get('ScheduleExpression'),
        'rule_name': rule_name,
        'exists': True,
    }


@app.get("/sources/status")
@tracer.capture_method
def get_sources_status():
    """Get status of all data source schedules, or run status for a specific source.

    The only route taking a source from the QUERY STRING rather than a `<source>`
    path parameter, which is why it is outside the path-parameter guard the other
    seven share and validates its sources here instead. Both branches derive a
    resource from the value — `_build_rule_name` for an EventBridge rule this
    `describe_rule`s, and a `SOURCE_RUN#` partition key for `_get_source_run_status`
    — so "is this a real plugin?" is as much the question here as on
    `enable`/`disable`, of which this is the read-side mirror.

    The two branches answer it differently because only one of them can raise; see
    `_is_addressable_source`. Open to any authenticated user, deliberately and as
    before: `SourceCard.tsx` and `PluginConfigModal.tsx` both read it for ordinary
    users, and gating it needs the same read/write reasoning applied to
    `list_app_configs`. Validating it closes the arbitrary-rule-enumeration half.

    Validation bounds WHICH rules may be described; it does not bound how MANY
    times, so the batch branch also de-duplicates and caps its list — see
    `MAX_SOURCES_PER_STATUS_REQUEST`. This is the only read in the handler whose
    AWS call count is chosen by the caller.
    """
    params = app.current_event.query_string_parameters or {}

    # If source param provided, return run status for that source
    run_status_source = params.get('run_status')
    if run_status_source:
        # RAISES here, unlike the batch branch below: this answers about a single
        # source, so a 400 names the actual problem instead of reporting an empty
        # status that reads as "never run". Every caller passes a real `plugin.id`
        # (GeneratorConfigModal, SyntheticSourceCard, Scrapers).
        #
        # So the two branches of this ONE route answer `manual_import` differently
        # — 400 here, `{'enabled': False, 'exists': False}` there — and that
        # disagreement is deliberate, because the two branches report different
        # things about it. This one reports a run record, and only `run_source` and
        # `BaseIngestor` write a `SOURCE_RUN#` partition: no CURRENT path writes
        # `SOURCE_RUN#manual_import` while the allowlist is available, since
        # `manual_import` has no ingestor and `run_source` validates against the
        # same allowlist. So on a clean deployment that partition is empty, and a
        # 400 naming the reason beats a 200 saying 'never_run' about a source with
        # nothing to report. The batch branch reports SCHEDULE state, where "no rule
        # exists" is a real answer to a real question, which is why it must not
        # raise — see `_is_addressable_source`, whose docstring argues that half.
        #
        # Two states this stops short of, so no reader concludes such a row is
        # IMPOSSIBLE and skips handling one (`_get_source_run_status` reports
        # whatever it finds):
        #
        #   * neither guard is retroactive. `run_source` on the pre-guard base had
        #     neither `require_admin` nor this validation — measured, a `users`
        #     caller got 200 and wrote `SOURCE_RUN#manual_import` — so a deployment
        #     upgraded from that build may hold a stale row today. Same limitation
        #     the namespace guards in `plugin-loader.ts` carry for secret keys: they
        #     close the entrances, not what is already stored.
        #   * with PLUGIN_SECRET_DEFAULTS unavailable the documented fail-open
        #     admits `manual_import` on BOTH branches, so the asymmetry described
        #     above disappears and an admin can write that partition again. That is
        #     consistent — `_is_addressable_source` inherits the same fail-open —
        #     but it means this whole comment describes the CONFIGURED state.
        #
        # Pinned in BOTH directions by TestTheQueryStringSourceRouteIsValidated, so
        # neither answer can flip silently.
        _validate_source_parameter(run_status_source)
        return _get_source_run_status(run_status_source)

    sources_param = params.get('sources', '')

    # Use requested sources or fall back to defaults
    if sources_param:
        # `dict.fromkeys` rather than `set`: it de-duplicates while KEEPING first
        # appearance order, and the response is a dict the caller reads by name,
        # so the order is part of what a JSON consumer sees.
        #
        # Unobservable to any caller, and that is the point — `status` is keyed by
        # source name, so a repeat overwrote the same entry and could not change
        # the response, while still costing one `describe_rule` each.
        # `?sources=` with one valid name repeated 500 times measured 200 / 500
        # calls / 1 key in the body. `DescribeRule` is throttled per account, so
        # those 499 spare calls came out of a budget the rest of the stack shares.
        sources = list(dict.fromkeys(
            s.strip() for s in sources_param.split(',') if s.strip()
        ))
    else:
        # The deployment's enabled plugins plus `manual_import` (issue #256).
        sources = default_source_ids()

    # Raises, unlike the per-source check below: this is a malformed REQUEST, not
    # an unaddressable source, so there is no per-entry answer to report and no
    # partial response worth returning.
    if len(sources) > MAX_SOURCES_PER_STATUS_REQUEST:
        raise ValidationError(
            f"Too many sources in request: {len(sources)} exceeds the limit of "
            f"{MAX_SOURCES_PER_STATUS_REQUEST}."
        )

    # One DescribeRule per source, in parallel (E2E F10: the loop was serial, so
    # the response waited for every call in turn). boto3 clients are thread-safe;
    # `map` keeps the request order, which the response dict preserves.
    addressable = [source for source in sources if _is_addressable_source(source)]
    with ThreadPoolExecutor(max_workers=max(1, min(len(addressable), MAX_PARALLEL_RULE_DESCRIBES))) as pool:
        described = dict(zip(addressable, pool.map(_schedule_status, addressable), strict=True))  # pragma: no mutate  map over the same list is always equal-length
    # No rule can exist for a source that is not a plugin, so that entry is the
    # answer `describe_rule` would have given — see `_is_addressable_source` for
    # why that makes it output-identical, and why it must not raise.
    status = {source: described.get(source, {'enabled': False, 'exists': False}) for source in sources}

    return {'sources': status}


@app.put("/sources/<source>/enable")
@tracer.capture_method
def enable_source(source: str):
    """Enable a data source schedule.

    Admin-gated and validated — see `run_source`. `source` reaches
    `_build_rule_name`, so an arbitrary value named an EventBridge rule to
    enable.
    """
    require_admin(app.current_event.raw_event)
    _validate_source_parameter(source)

    rule_name = _build_rule_name(source)
    try:
        events_client.enable_rule(Name=rule_name)
    except Exception as e:
        logger.exception(f"Failed to enable source {source}: {e}")
        raise ServiceError('Failed to enable data source') from e
    return {'success': True, 'source': source, 'enabled': True}


@app.put("/sources/<source>/disable")
@tracer.capture_method
def disable_source(source: str):
    """Disable a data source schedule.

    Admin-gated and validated — see `run_source`. This is the direction that
    silently stops ingestion, so leaving it open was a denial-of-data any
    authenticated user could cause.
    """
    require_admin(app.current_event.raw_event)
    _validate_source_parameter(source)

    rule_name = _build_rule_name(source)
    try:
        events_client.disable_rule(Name=rule_name)
    except Exception as e:
        logger.exception(f"Failed to disable source {source}: {e}")
        raise ServiceError('Failed to disable data source') from e
    return {'success': True, 'source': source, 'enabled': False}



# SnapStart (lib/utils/snapstart.ts): the Secrets Manager and EventBridge clients
# are already built at import. Before the snapshot, also parse the plugin defaults,
# the DynamoDB and Lambda model files (the run-status / run routes build that Table
# and client lazily: ~250 ms of model parsing that landed on the first such call
# after every restore) and every route's request model (3.00.00 capacity: the first
# call after a restore ran at 83-93 % CPU). Pure computation: no client, no
# credential, no AWS call. Reseed after restore.
register_snapshot_hooks(_plugin_secret_defaults, botocore_model_warmer('dynamodb', 'lambda'), api_route_warmer(app))


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
