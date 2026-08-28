"""
Integrations API Lambda - Handles /integrations/*, /sources/*
Manages API credentials and data source schedules.
"""

import json
import os
import re
from functools import lru_cache
from typing import Any

import boto3
from shared.api import api_handler, create_api_resolver, require_admin
from shared.aws import get_secrets_client, put_secret_json
from shared.exceptions import (
    ConfigurationError,
    ServiceError,
    ValidationError,
)
from shared.logging import logger, tracer
from shared.scraper_urls import validate_scraper_configs_json

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
# way, which is what the lru_cache is for.
PLUGIN_SECRET_DEFAULTS_VAR = "PLUGIN_SECRET_DEFAULTS"

app = create_api_resolver()

# ---------------------------------------------------------------------------
# Credential key validation
#
# We validate the *form* of each key rather than an enumerated per-source
# list, because this Lambda cannot see plugin manifests (they are resolved at
# CDK synth time, not at runtime).  A manifest-derived allowlist is the
# stronger fix and is tracked as a follow-up.
#
# Rules:
#   • Only lowercase letters, digits, and underscores (no dots, slashes,
#     hyphens, or other characters that could escape or re-enter a namespace).
#   • Length: 1–64 characters.
#   • May not start or end with an underscore (prevents confusion with
#     namespace prefixes / internal keys).
#   • At most MAX_CREDENTIAL_KEYS_PER_REQUEST keys per write request.
#
# Single alternative: optional inner body of up to 62 chars means the total
# length is 1 (just the initial char) or 2-64 (initial + inner + final).
# re.fullmatch is used in _validate_credential_key so anchors are not needed.
_CREDENTIAL_KEY_RE = re.compile(r'[a-z0-9](?:[a-z0-9_]{0,62}[a-z0-9])?')
MAX_CREDENTIAL_KEYS_PER_REQUEST = 20

# The one source whose stored value names network destinations the platform will
# fetch on a schedule. Its `configs` key becomes `webscraper_configs`, the same
# key `POST /scrapers` writes, and the ingestor reads it after prefix stripping as
# plain `configs` (`_load_scraper_configs`). Named here so the write below applies
# the outbound-URL policy to it — see the call site.
WEBSCRAPER_SOURCE = 'webscraper'
WEBSCRAPER_CONFIGS_KEY = 'configs'


def _validate_credential_key(key: str) -> None:
    """Raise ValidationError if *key* does not conform to the allowed form.

    Uses re.fullmatch so no explicit anchors are needed in the pattern.
    The key preview in the error message is truncated to avoid reflecting
    unbounded caller input back in the response.
    """
    if not isinstance(key, str) or not _CREDENTIAL_KEY_RE.fullmatch(key):
        preview = repr(key[:40]) if isinstance(key, str) else repr(key)
        raise ValidationError(
            f"Invalid credential key {preview}: keys must contain only lowercase "
            "letters, digits, and underscores, must start and end with a "
            "letter or digit, and must be 1–64 characters long."
        )


def _validate_source(source: str) -> None:
    """Raise ValidationError if *source* does not conform to the allowed form.

    'source' is used as a namespace prefix (f"{source}_"), so it must satisfy
    the same character-class rules as credential keys.  The error message uses
    'source identifier' rather than 'credential key' so it is clear which
    input parameter is invalid when debugging a 400.
    """
    if not isinstance(source, str) or not _CREDENTIAL_KEY_RE.fullmatch(source):
        preview = repr(source[:40]) if isinstance(source, str) else repr(source)
        raise ValidationError(
            f"Invalid source identifier {preview}: source must contain only "
            "lowercase letters, digits, and underscores, must start and end "
            "with a letter or digit, and must be 1–64 characters long."
        )


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


@lru_cache(maxsize=1)
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
    raw = os.environ.get(PLUGIN_SECRET_DEFAULTS_VAR, "")
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
            # ponytail: plain prefix match, so if one plugin id were ever a
            # prefix of another ('app_reviews' alongside 'app_reviews_ios') the
            # shorter one would also list the longer one's keys. No current id
            # pair does this. Upgrade path is to iterate `seeded` by declared
            # key instead, which costs the write-through property above.
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

        return status
    except ConfigurationError:
        raise
    except Exception as e:
        logger.exception(f"Failed to get integration status: {e}")
        raise ServiceError('Failed to retrieve integration status')


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
    # secret key as source='foo' + key='bar_baz' (namespace collision).
    _validate_source(source)

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

        return result
    except (ConfigurationError, ValidationError):
        raise
    except Exception as e:
        logger.exception(f"Failed to get credentials for {source}: {e}")
        raise ServiceError('Failed to retrieve credentials')


@app.put("/integrations/<source>/credentials")
@tracer.capture_method
def update_credentials(source: str):
    """Update credentials for an integration.

    Requires admin access — credential management is an administrative operation.

    Each key in the request body must conform to the allowed form (lowercase
    letters, digits, and underscores only; 1–64 characters; no leading/trailing
    underscores).  Unrecognised or malformed keys are rejected with a 400 error
    before any write is attempted.

    At most MAX_CREDENTIAL_KEYS_PER_REQUEST keys may be written per request.

    NOTE: Credential deletion is not currently supported.  Sending null or an
    empty string for a key silently skips it, leaving the stored value unchanged.
    """
    require_admin(app.current_event.raw_event)

    # Validate source before building the namespace prefix.  Without this
    # a caller sending source='foo_bar' + key='baz' would reach the same
    # secret key as source='foo' + key='bar_baz' (namespace collision).
    _validate_source(source)

    if not SECRETS_ARN:
        raise ConfigurationError('Secrets not configured')

    body = app.current_event.json_body

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

        # This route is the SECOND write path into `webscraper_configs` — the
        # Settings webscraper card saves the whole array through it as one
        # `configs` string, so checking only `POST /scrapers` left the same
        # internal destination reachable through a different route (issue #244).
        # The check is the one in shared/scraper_urls.py, not a second
        # implementation, and it runs before anything is WRITTEN, so a refusal
        # persists nothing.
        #
        # The stored value is handed over so the URL-count cap can tell a list
        # this write created from one it is carrying forward untouched. Without
        # it, one pre-existing over-cap config blocked saving every other config
        # in the array. Reading the secret first is what makes that comparison
        # possible; the ValidationError is re-raised unflattened below.
        if source == WEBSCRAPER_SOURCE and WEBSCRAPER_CONFIGS_KEY in body:
            validate_scraper_configs_json(
                body[WEBSCRAPER_CONFIGS_KEY],
                stored=secrets.get(f"{prefix}{WEBSCRAPER_CONFIGS_KEY}"),
            )

        for key, value in body.items():
            # Falsy values (null/empty string) are skipped — sending null or ""
            # does NOT delete the key.  Credential deletion is not currently
            # supported via this endpoint.
            if value:
                secrets[f"{prefix}{key}"] = value

        put_secret_json(secretsmanager, SECRETS_ARN, secrets)
        return {'success': True, 'message': f'Credentials updated for {source}'}
    except (ConfigurationError, ValidationError):
        raise
    except Exception as e:
        logger.exception(f"Failed to update credentials: {e}")
        raise ServiceError('Failed to update credentials')


# ============================================
# App Config CRUD (multi-instance plugins)
# ============================================

APP_CONFIG_PLUGINS = {'app_reviews_ios', 'app_reviews_android'}


def _get_app_configs_key(source: str) -> str:
    """Get the Secrets Manager key for a plugin's app configs array."""
    return f"{source}_configs"


@app.get("/integrations/<source>/apps")
@tracer.capture_method
def list_app_configs(source: str):
    """List all app configurations for a multi-instance plugin."""
    if source not in APP_CONFIG_PLUGINS:
        raise ValidationError(f'Source {source} does not support multiple app configs')
    if not SECRETS_ARN:
        return {'apps': []}

    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))
        configs_key = _get_app_configs_key(source)
        configs = json.loads(secrets.get(configs_key, '[]'))
        return {'apps': configs}
    except (ConfigurationError, ValidationError):
        raise
    except Exception as e:
        logger.warning(f"Could not read app configs for {source}: {e}")
        return {'apps': []}


@app.post("/integrations/<source>/apps")
@tracer.capture_method
def save_app_config(source: str):
    """Save (create or update) an app configuration for a multi-instance plugin."""
    if source not in APP_CONFIG_PLUGINS:
        raise ValidationError(f'Source {source} does not support multiple app configs')
    if not SECRETS_ARN:
        raise ConfigurationError('Secrets not configured')

    body = app.current_event.json_body or {}
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
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))
        configs_key = _get_app_configs_key(source)
        configs = json.loads(secrets.get(configs_key, '[]'))

        existing_idx = next((i for i, c in enumerate(configs) if c.get('id') == app_config['id']), -1)
        if existing_idx >= 0:
            configs[existing_idx] = app_config
        else:
            configs.append(app_config)

        secrets[configs_key] = json.dumps(configs)
        put_secret_json(secretsmanager, SECRETS_ARN, secrets)
        return {'success': True, 'app': app_config}
    except (ConfigurationError, ValidationError):
        raise
    except Exception as e:
        logger.exception(f"Failed to save app config for {source}: {e}")
        raise ServiceError('Failed to save app configuration')


@app.delete("/integrations/<source>/apps/<app_id>")
@tracer.capture_method
def delete_app_config(source: str, app_id: str):
    """Delete an app configuration from a multi-instance plugin."""
    if source not in APP_CONFIG_PLUGINS:
        raise ValidationError(f'Source {source} does not support multiple app configs')
    if not SECRETS_ARN:
        raise ConfigurationError('Secrets not configured')

    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))
        configs_key = _get_app_configs_key(source)
        configs = json.loads(secrets.get(configs_key, '[]'))
        configs = [c for c in configs if c.get('id') != app_id]
        secrets[configs_key] = json.dumps(configs)
        put_secret_json(secretsmanager, SECRETS_ARN, secrets)
        return {'success': True}
    except (ConfigurationError, ValidationError):
        raise
    except Exception as e:
        logger.exception(f"Failed to delete app config for {source}: {e}")
        raise ServiceError('Failed to delete app configuration')


@app.post("/sources/<source>/run")
@tracer.capture_method
def run_source(source: str):
    """Manually trigger a data source ingestor Lambda.
    
    Optionally accepts a JSON body with `app_id` to run a single app
    config instead of all configs for the source.
    """
    from datetime import datetime, timezone

    from shared.tables import get_aggregates_table

    function_name = _build_ingestor_function_name(source)

    execution_id = f"run_{source}_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    payload: dict = {"manual_trigger": True, "execution_id": execution_id}
    try:
        body = app.current_event.json_body or {}
        if body.get("app_id"):
            payload["app_id"] = body["app_id"]
    except Exception:
        pass

    # Create initial run status record
    try:
        table = get_aggregates_table()
        if table:
            table.put_item(Item={
                'pk': f'SOURCE_RUN#{source}', 'sk': execution_id,
                'status': 'running', 'items_found': 0,
                'started_at': datetime.now(timezone.utc).isoformat(),
            })
    except Exception as e:
        logger.warning(f"Failed to create run status: {e}")

    lambda_client = boto3.client("lambda")
    try:
        response = lambda_client.invoke(
            FunctionName=function_name,
            InvocationType="Event",
            Payload=json.dumps(payload).encode(),
        )
        status_code = response.get("StatusCode", 0)
        if status_code == 202:
            return {"success": True, "message": f"Triggered {source} ingestor", "source": source, "execution_id": execution_id}
        raise ServiceError(f"Lambda invoke returned status {status_code}")
    except lambda_client.exceptions.ResourceNotFoundException:
        raise ServiceError(f"Ingestor Lambda not found for source: {source}")
    except ServiceError:
        raise
    except Exception as e:
        logger.exception(f"Failed to trigger source {source}: {e}")
        raise ServiceError(f"Failed to trigger {source} ingestor")


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
    except Exception as e:
        logger.warning(f"Failed to get source run status: {e}")
        return {'source': source, 'status': 'unknown'}


@app.get("/sources/status")
@tracer.capture_method
def get_sources_status():
    """Get status of all data source schedules, or run status for a specific source."""
    params = app.current_event.query_string_parameters or {}
    
    # If source param provided, return run status for that source
    run_status_source = params.get('run_status')
    if run_status_source:
        return _get_source_run_status(run_status_source)
    
    sources_param = params.get('sources', '')
    
    # Use requested sources or fall back to defaults
    if sources_param:
        sources = [s.strip() for s in sources_param.split(',') if s.strip()]
    else:
        sources = ['webscraper', 'manual_import', 's3_import']
    
    status = {}
    for source in sources:
        rule_name = _build_rule_name(source)
        try:
            response = events_client.describe_rule(Name=rule_name)
            status[source] = {
                'enabled': response.get('State') == 'ENABLED',
                'schedule': response.get('ScheduleExpression'),
                'rule_name': rule_name,
                'exists': True
            }
        except events_client.exceptions.ResourceNotFoundException:
            status[source] = {'enabled': False, 'exists': False}
        except Exception as e:
            logger.warning(f"Failed to get status for source {source}: {e}")
            status[source] = {'enabled': False, 'error': 'Failed to retrieve status'}
    
    return {'sources': status}


@app.put("/sources/<source>/enable")
@tracer.capture_method
def enable_source(source: str):
    """Enable a data source schedule."""
    rule_name = _build_rule_name(source)
    try:
        events_client.enable_rule(Name=rule_name)
        return {'success': True, 'source': source, 'enabled': True}
    except Exception as e:
        logger.exception(f"Failed to enable source {source}: {e}")
        raise ServiceError('Failed to enable data source')


@app.put("/sources/<source>/disable")
@tracer.capture_method
def disable_source(source: str):
    """Disable a data source schedule."""
    rule_name = _build_rule_name(source)
    try:
        events_client.disable_rule(Name=rule_name)
        return {'success': True, 'source': source, 'enabled': False}
    except Exception as e:
        logger.exception(f"Failed to disable source {source}: {e}")
        raise ServiceError('Failed to disable data source')


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
