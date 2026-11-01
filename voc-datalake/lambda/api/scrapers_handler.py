"""
Scrapers API Lambda - Handles /scrapers/*
Manages web scraper configurations and runs.

Gates (writes and analyze are admin-only; reads stay open):

| Route | Who |
|---|---|
| `GET` routes (list, templates, status, runs) | every authenticated user (list: see `list_scrapers`) |
| `POST /scrapers` (save = create AND update) | admins |
| `POST /scrapers/analyze-url` | admins |
| `DELETE /scrapers/<scraper_id>` | admins |
| `POST /scrapers/<scraper_id>/run` | admins |

Every route that creates, edits, analyzes or runs a scraper is admin-only:
`POST /scrapers` and `DELETE /scrapers/<scraper_id>` both `put_secret_json` the
SAME shared API-credentials secret that `integrations_handler` writes (they
rewrite `webscraper_configs`, a key the webscraper ingestor consumes), a saved
scraper drives the scheduled ingestor (third-party fetches plus Bedrock
enrichment of what it finds), analyze-url fetches a caller-chosen URL and spends
a Bedrock call on it, and run invokes the ingestor directly. Each gate runs
before any secret read, URL fetch or model call.

The admin gate does not replace the input bounds: `_validated_scraper` (URL
policy #244, field types and lengths, URL count, page count, serialized size)
and `_upserted_configs` (scraper count, and a byte budget for the whole
`webscraper_configs` value that leaves the rest of the secret room for
integration credentials) still apply to every save. An admin's schedule
(`enabled` / `frequency_minutes`) is stored as sent.

Delegated callers are never admin: the AI assistant forwards the user's own
claims, and MCP tokens and agents carry an empty `cognito:groups`
(`shared/mcp_delegate.synthetic_claims`, `agents/principal.agent_claims`).

Pinned by `test/test_scrapers_security.py::TestEveryScraperWriteIsAdminGated`,
which parses the decorators so a route added later cannot quietly arrive ungated.

SCOPE — the split above is THIS MODULE's, not the `/scrapers/*` URL prefix's. Five
more routes under that prefix live in `manual_import_handler.py`
(`/scrapers/manual/parse`, `.../parse/<job_id>`, `.../confirm`, `.../csv-upload`,
`.../json-upload`) and none of them calls `require_admin`. That is a DIFFERENT
question rather than the same gap: those routes write feedback CONTENT into the
pipeline (S3 plus the enrichment queue) and touch neither the shared secret nor
any plugin resource — see `test/test_scrapers_security.py`, whose inventory case
asserts that boundary so a reader is not told the prefix is fully covered when
only this handler is. The `ast` pass cannot see across module boundaries, so
nothing else would say so.
"""

import http.client
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from datetime import UTC, datetime
from typing import Any

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import BotoCoreError, ClientError

from shared import assist_jobs
from shared.api import api_handler, create_api_resolver, get_caller_subject, require_admin
from shared.app_connector_listing import connectors_in_secret
from shared.aws import get_secrets_client, put_secret_json
from shared.exceptions import ConfigurationError, ServiceError, ValidationError
from shared.http_utils import MAX_PAGE_BYTES
from shared.ids import timestamped_id
from shared.logging import logger, tracer
from shared.producer_labels import normalise_label_fields
from shared.radar_brands import radar_brand_setting
from shared.request_body import json_object_body
from shared.row_ids import OPAQUE_ID_RE
from shared.scraper_run_errors import redacted_scraper_errors
from shared.tables import get_aggregates_table
from shared.timestamps import now_iso
from shared.url_policy import (
    PRIVATE_ADDRESS_ERROR,
    BlockedDestinationError,
    connect_to_validated_address,
    scraper_url_error,
    validate_url,
)

secretsmanager = get_secrets_client()
lambda_client = boto3.client("lambda")

SECRETS_ARN = os.environ.get("SECRETS_ARN", "")
WEBSCRAPER_FUNCTION_NAME = os.environ.get("WEBSCRAPER_FUNCTION_NAME", "")

#: Answers from a site that refuses plain HTTP clients (a bot wall or a rate limit): the
#: caller's 400 with what to do instead, not the generic 500 "Failed to analyze URL" —
#: nothing failed here, and the AI assistant must learn to use the browser connector.
BOT_WALL_STATUSES = frozenset({403, 429})
BOT_WALL_ERROR = (
    'The site refused a plain HTTP request (HTTP {status}), so its selectors cannot be analyzed. '
    'Sites that block plain fetches can be read with the Web Reviews connector (managed browser) instead.'
)
#: Any other error status the target answers (404, 410, 500, 503...) is that site's answer,
#: not our failure: the caller's 400 naming the status (the assist worker logs it as a
#: WARNING), never the generic "Failed to analyze URL" with a traceback at ERROR.
SITE_REFUSED_ERROR = (
    'The site refused the request (HTTP {status}), so its selectors cannot be analyzed. '
    'Check that the URL is correct and opens in a browser.'
)

def require_webscraper_function():
    """Validate WEBSCRAPER_FUNCTION_NAME is configured."""
    if not WEBSCRAPER_FUNCTION_NAME:
        raise ValueError("WEBSCRAPER_FUNCTION_NAME environment variable is required")
    return WEBSCRAPER_FUNCTION_NAME

app = create_api_resolver()

# The URL policy itself (scheme, userinfo, resolve-and-check every address) is
# `shared/url_policy.py` — the SAME implementation `save_scraper` applies to every
# saved URL and the webscraper ingestor applies before every request (#244).
# What stays here is analyze-url's urllib transport: redirect re-validation and
# connect-time pinning.


class _RedirectRefusedError(urllib.error.HTTPError):
    """A redirect hop that failed `validate_url`. Still an HTTPError (urllib's
    contract for a redirect handler), but its own type, so `_fetch_html` can
    answer the caller's 400 instead of the generic 500 "Failed to analyze URL"."""


class _ValidatingRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only to a URL that passes `validate_url` itself."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        is_valid, error = validate_url(newurl)
        if not is_valid:
            raise _RedirectRefusedError(newurl, code, f'Redirect refused: {error}', headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class _PinnedConnectionMixin:
    """Routes `http.client`'s socket factory hook through `connect_to_validated_address`
    (shared/url_policy.py — the one connect-time pin, also used by the ingestor).

    `self.host` stays the original name, so the Host header — and for HTTPS the
    `server_hostname` TLS wraps the pinned socket with (SNI plus certificate and
    hostname verification) — still use it. OWASP: connect to the validated IP
    while preserving Host, SNI and certificate verification.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._create_connection = connect_to_validated_address


class _PinnedHTTPConnection(_PinnedConnectionMixin, http.client.HTTPConnection):
    pass


class _PinnedHTTPSConnection(_PinnedConnectionMixin, http.client.HTTPSConnection):
    pass


class _PinnedHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req: urllib.request.Request) -> http.client.HTTPResponse:
        return self.do_open(_PinnedHTTPConnection, req)


class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self) -> None:
        # Explicit default context: certificate and hostname verification on.
        # Kept on our own attribute: HTTPSHandler's `_context` is private (and unstubbed).
        self.ssl_context = ssl.create_default_context()
        super().__init__(context=self.ssl_context)

    def https_open(self, req: urllib.request.Request) -> http.client.HTTPResponse:
        return self.do_open(_PinnedHTTPSConnection, req, context=self.ssl_context)


def _build_safe_opener() -> urllib.request.OpenerDirector:
    """Every hop (the first request and each redirect) opens its socket through
    the pinned handlers, and each redirect target is also run through
    `validate_url`. `ProxyHandler({})` replaces the default one that reads
    *_PROXY env vars: through a proxy the pinned socket would be the proxy's, and
    the policy would no longer judge the real target.
    """
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        _PinnedHTTPHandler,
        _PinnedHTTPSHandler,
        _ValidatingRedirectHandler,
    )


_SAFE_OPENER = _build_safe_opener()


def _webscraper_configs_in_secret() -> tuple[dict, list]:
    """The shared secret as stored and the `webscraper_configs` array it holds.

    The read half of every scraper route's read-modify-write; the write half is
    `put_secret_json` on the same `secrets` dict.
    """
    response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
    secrets = json.loads(response.get('SecretString', '{}'))
    configs = json.loads(secrets.get('webscraper_configs', '[]'))
    return secrets, configs


@app.get("/scrapers")
@tracer.capture_method
def list_scrapers():
    """List all scraper configurations. Open to every signed-in user (decision).

    Returns `webscraper_configs` as stored, and that value lives in the shared
    API-credentials secret. It is non-credential today: a config holds URLs,
    selectors, pagination, schedule and labels, and the webscraper ingestor
    builds its own request headers and reads no auth field from it. The
    read-only Scrapers page needs the whole config for a non-admin, so this read
    stays ungated (pinned by `TestTheReadRoutesStayOpen`).

    Re-decide BEFORE a config gains a credential (a cookie, a bearer token,
    basic-auth for an authenticated site): such a field must not come back
    from this route to a non-admin — strip it here for non-admins, or store it
    under its own secret key, rather than adding it to the config (#398).
    """
    if not SECRETS_ARN:
        return {'scrapers': []}
    try:
        _secrets, configs = _webscraper_configs_in_secret()
    except (ClientError, BotoCoreError, ValueError, TypeError, AttributeError) as e:
        # An AWS failure, or a secret whose JSON is not the {key: str} shape.
        logger.warning(f"Could not read scraper configs: {e}")
        return {'scrapers': []}
    return {'scrapers': configs}


# --- Bounds on the save route ---------------------------------------------------
# `POST /scrapers` (admin-only) writes the shared API-credentials secret, so what
# one save may put there is bounded even for an admin: a typo or a runaway client
# must not lock integration credentials out of the secret.
# The editor already stays inside all of these (its max-pages input is max=50).
MAX_SCRAPERS = 50
MAX_SCRAPER_BYTES = 8 * 1024
# The whole `webscraper_configs` value. Secrets Manager caps the secret at 64 KiB
# (`SECRET_STRING_MAX_BYTES`) and integration credentials share it, so scrapers
# alone may not fill it — otherwise scraper configs could lock integration
# credentials out of the secret.
MAX_WEBSCRAPER_CONFIGS_BYTES = 48 * 1024
MAX_URLS_PER_SCRAPER = 25
MAX_URL_LENGTH = 2048
MAX_TEXT_FIELD_LENGTH = 500
MAX_PAGINATION_PARAM_LENGTH = 64
MAX_PAGINATION_PAGES = 50
MAX_PAGINATION_START = 10_000
MAX_FREQUENCY_MINUTES = 30 * 24 * 60
TEXT_FIELDS = (
    'name', 'template', 'container_selector', 'text_selector', 'title_selector',
    'rating_selector', 'rating_attribute', 'date_selector', 'author_selector',
    'link_selector',
)
EXTRACTION_METHODS = ('css', 'jsonld')

def _bounded_int_error(value: object, field: str, low: int, high: int) -> str | None:
    # A real JSON integer: `bool` is an `int` subclass and is refused.
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        return f'{field} must be an integer from {low} to {high}'
    return None


def _text_fields_error(scraper: dict) -> str | None:
    for field in TEXT_FIELDS:
        value = scraper.get(field)
        if value is not None and (not isinstance(value, str) or len(value) > MAX_TEXT_FIELD_LENGTH):
            return f'{field} must be a string of at most {MAX_TEXT_FIELD_LENGTH} characters'
    method = scraper.get('extraction_method')
    if method is not None and method not in EXTRACTION_METHODS:
        return f'extraction_method must be one of {", ".join(EXTRACTION_METHODS)}'
    return None


def _url_fields_error(scraper: dict) -> str | None:
    """Count and length only; the URL policy itself is `shared.url_policy.scraper_url_error`."""
    urls = scraper.get('urls')
    if isinstance(urls, list) and len(urls) > MAX_URLS_PER_SCRAPER:
        return f'A scraper may list at most {MAX_URLS_PER_SCRAPER} urls'
    candidates = [scraper.get('base_url')] + (urls if isinstance(urls, list) else [])
    if any(isinstance(u, str) and len(u) > MAX_URL_LENGTH for u in candidates):
        return f'A scraper URL may be at most {MAX_URL_LENGTH} characters'
    return None


def _pagination_error(pagination: object) -> str | None:
    """`max_pages` is how many pages ONE run of `base_url` fetches."""
    if pagination is None:
        return None
    if not isinstance(pagination, dict):
        return 'pagination must be an object'
    enabled = pagination.get('enabled')
    if enabled is not None and not isinstance(enabled, bool):
        return 'pagination.enabled must be true or false'
    param = pagination.get('param')
    if param is not None and (not isinstance(param, str) or len(param) > MAX_PAGINATION_PARAM_LENGTH):
        return f'pagination.param must be a string of at most {MAX_PAGINATION_PARAM_LENGTH} characters'
    checks = (('max_pages', 1, MAX_PAGINATION_PAGES), ('start', 0, MAX_PAGINATION_START))
    for field, low, high in checks:
        if field in pagination:
            error = _bounded_int_error(pagination[field], f'pagination.{field}', low, high)
            if error is not None:
                return error
    return None


def _schedule_fields_error(scraper: dict) -> str | None:
    enabled = scraper.get('enabled')
    if enabled is not None and not isinstance(enabled, bool):
        return 'enabled must be true or false'
    if 'frequency_minutes' in scraper:
        return _bounded_int_error(scraper['frequency_minutes'], 'frequency_minutes', 0, MAX_FREQUENCY_MINUTES)
    return None


def _scraper_shape_error(scraper: dict) -> str | None:
    """Why `scraper` is malformed or too large to store, else None. Cheap checks
    only; the DNS-resolving URL policy runs after these pass."""
    scraper_id = scraper.get('id')
    if not isinstance(scraper_id, str) or not OPAQUE_ID_RE.fullmatch(scraper_id):
        return 'id must be 1-64 letters, digits, "_" or "-"'
    for check in (_text_fields_error, _url_fields_error, _schedule_fields_error):
        error = check(scraper)
        if error is not None:
            return error
    error = _pagination_error(scraper.get('pagination'))
    if error is not None:
        return error
    # Covers keys this module does not name (e.g. `text_config`), so no field can
    # be used to bloat the shared secret.
    if len(json.dumps(scraper).encode()) > MAX_SCRAPER_BYTES:
        return f'A scraper config may be at most {MAX_SCRAPER_BYTES} bytes'
    return None


def _validated_scraper(body: object) -> dict:
    """The `scraper` of a save request, or a 400 explaining why it cannot be stored."""
    scraper = body.get('scraper') if isinstance(body, dict) else None
    if not scraper:
        raise ValidationError('No scraper config provided')
    if not isinstance(scraper, dict):
        raise ValidationError('Scraper config must be an object')
    error = _scraper_shape_error(scraper) or scraper_url_error(scraper, validate_url)
    if error is not None:
        raise ValidationError(error)
    # Dimension defaults and tags the ingestor stamps on every message it sends.
    normalise_label_fields(get_aggregates_table(), scraper)
    _normalise_radar_brand(scraper)
    return scraper


def _normalise_radar_brand(scraper: dict) -> None:
    """`radar_brand` (a Radar brand key, docs/radar.md) checked in place: kept, dropped when blank, or a 400."""
    try:
        radar_brand = radar_brand_setting(scraper.get('radar_brand'))
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    if radar_brand:
        scraper['radar_brand'] = radar_brand
    else:
        scraper.pop('radar_brand', None)


def _upserted_configs(configs: list, scraper: dict) -> list:
    """`configs` with `scraper` created or replaced by id, stored as sent.

    Raises ValidationError when a create would exceed MAX_SCRAPERS, or the result
    would GROW `webscraper_configs` past MAX_WEBSCRAPER_CONFIGS_BYTES (an edit that
    keeps or shrinks an already-oversized value is allowed, so it can be repaired).
    """
    index = next((i for i, c in enumerate(configs) if isinstance(c, dict) and c.get('id') == scraper['id']), None)
    if index is None:
        if len(configs) >= MAX_SCRAPERS:
            raise ValidationError(f'At most {MAX_SCRAPERS} scrapers can be configured. Delete one first.')
        updated = [*configs, scraper]
    else:
        updated = [*configs[:index], scraper, *configs[index + 1:]]
    before = len(json.dumps(configs).encode())
    after = len(json.dumps(updated).encode())
    if after > MAX_WEBSCRAPER_CONFIGS_BYTES and after > before:
        raise ValidationError(
            f'Scraper configurations would take {after} bytes, over the '
            f'{MAX_WEBSCRAPER_CONFIGS_BYTES}-byte budget. Remove some scrapers or URLs.'
        )
    return updated


@app.post("/scrapers")
@tracer.capture_method
def save_scraper():
    """Create or update a scraper configuration. ADMIN-ONLY.

    Admin-only: the save rewrites `webscraper_configs` in the shared
    API-credentials secret, and a saved scraper drives the scheduled ingestor —
    third-party fetches plus Bedrock enrichment of every review it finds. The gate
    runs before the body is read, so a non-admin's 403 reads and writes no secret.
    An admin's config is stored as sent (schedule included), still bounded by
    `_validated_scraper` (shape, sizes, and every URL through
    `shared/url_policy.validate_url`, #244 — the ingestor re-checks at fetch time)
    and `_upserted_configs` (count and byte budget).
    """
    require_admin(app.current_event.raw_event)
    if not SECRETS_ARN:
        raise ConfigurationError('Secrets not configured')

    scraper = _validated_scraper(json_object_body(app))

    try:
        secrets, configs = _webscraper_configs_in_secret()
        configs = _upserted_configs(configs, scraper)
        secrets['webscraper_configs'] = json.dumps(configs)
        put_secret_json(secretsmanager, SECRETS_ARN, secrets)
    except ValidationError:
        # put_secret_json refuses an over-limit secret, and _upserted_configs a
        # count or budget overrun. Both are a 400 the user can act on ("remove
        # some scrapers"), so they must not be flattened into the generic 500.
        raise
    except Exception as e:
        logger.exception(f"Failed to save scraper: {e}")
        raise ServiceError('Failed to save scraper configuration') from e
    return {'success': True, 'scraper': scraper}


@app.delete("/scrapers/<scraper_id>")
@tracer.capture_method
def delete_scraper(scraper_id: str):
    """Delete a scraper configuration.

    Admin-gated like the save above — it writes the shared secret — and
    destructive besides: it rewrites
    `webscraper_configs` with one entry removed, which stops that site being
    scraped and cannot be undone from the run history.
    """
    require_admin(app.current_event.raw_event)
    if not SECRETS_ARN:
        raise ConfigurationError('Secrets not configured')
    try:
        secrets, configs = _webscraper_configs_in_secret()
        configs = [c for c in configs if c.get('id') != scraper_id]
        secrets['webscraper_configs'] = json.dumps(configs)
        put_secret_json(secretsmanager, SECRETS_ARN, secrets)
    except ValidationError:
        # A delete only ever SHRINKS this key, so the size guard cannot fire on
        # what this route adds. It can still fire on a secret that was ALREADY
        # over the limit — written before the guard existed — and that is exactly
        # the caller who is deleting to get back under it. Flattening that into a
        # 500 would hide the one message telling them what to do.
        raise
    except Exception as e:
        logger.exception(f"Failed to delete scraper: {e}")
        raise ServiceError('Failed to delete scraper configuration') from e
    return {'success': True}


@app.get("/scrapers/connectors")
@tracer.capture_method
def list_app_connectors():
    """The app-review connectors and review pages with their Radar brand (shared/app_connector_listing.py).

    Read-only and open to every signed-in user, like GET /integrations/<source>/apps, which returns
    the same configs in full; this answers only the listed fields. The AI assistant reads it.
    """
    if not SECRETS_ARN:
        return {'connectors': []}
    try:
        # The secret alone: a malformed `webscraper_configs` must not hide the connectors.
        secrets = json.loads(secretsmanager.get_secret_value(SecretId=SECRETS_ARN).get('SecretString', '{}'))
    except (ClientError, BotoCoreError, ValueError, TypeError, AttributeError) as e:
        logger.warning(f"Could not read app connector configs: {e}")
        return {'connectors': []}
    return {'connectors': connectors_in_secret(secrets) if isinstance(secrets, dict) else []}


@app.get("/scrapers/templates")
@tracer.capture_method
def get_templates():
    """Get available scraper templates."""
    templates = [
        {
            'id': 'review_jsonld',
            'name': 'Review JSON-LD',
            'description': 'Extract reviews using JSON-LD structured data.',
            'icon': 'JSON-LD',
            'extraction_method': 'jsonld',
            'url_pattern': '',
            'supports_pagination': True,
            'config': {
                'extraction_method': 'jsonld',
                'template': 'review_jsonld',
                'pagination': {'enabled': True, 'param': 'page', 'max_pages': 10, 'start': 1}
            }
        },
        {
            'id': 'custom_css',
            'name': 'Custom (CSS Selectors)',
            'description': 'Create a custom scraper with CSS selectors.',
            'icon': 'CSS',
            'extraction_method': 'css',
            'url_pattern': '',
            'supports_pagination': True,
            'config': {
                'extraction_method': 'css',
                'container_selector': '.review',
                'text_selector': '.review-text',
                'pagination': {'enabled': False, 'param': 'page', 'max_pages': 10, 'start': 1}
            }
        },
    ]
    return {'templates': templates}


@app.post("/scrapers/<scraper_id>/run")
@tracer.capture_method
def run_scraper(scraper_id: str):
    """Trigger a scraper run.

    Admin-gated for the reason `integrations_handler.run_source` is: this invokes
    the webscraper Lambda, so every call is a billed fetch against a third party's
    rate limit, and ungated it was callable in a loop by anyone with an account —
    measured, 200 with a real `lambda:Invoke` and a `SCRAPER_RUN#` row written.

    `scraper_id` is NOT validated against an allowlist, unlike `<source>` in
    `integrations_handler`: it is not a plugin id and never becomes a secret key
    or a function name. It reaches one `SCRAPER_RUN#` partition and the invoke
    PAYLOAD, where the webscraper resolves it against its own configured list, so
    an unknown id is a run that finds nothing rather than a namespace a caller
    chose. The admin gate is what bounds who can write those partitions.
    """
    require_admin(app.current_event.raw_event)
    execution_id = timestamped_id(f'run_{scraper_id}', datetime.now(UTC))
    try:
        table = get_aggregates_table()
        if table:
            table.put_item(Item={
                'pk': f'SCRAPER_RUN#{scraper_id}', 'sk': execution_id, 'status': 'running',
                'started_at': now_iso(), 'pages_scraped': 0, 'items_found': 0, 'errors': []
            })
        function_name = require_webscraper_function()
        lambda_client.invoke(FunctionName=function_name, InvocationType='Event',
                            Payload=json.dumps({'scraper_id': scraper_id, 'execution_id': execution_id, 'manual_run': True}))
    except Exception as e:
        logger.exception(f"Failed to run scraper: {e}")
        raise ServiceError('Failed to start scraper run') from e
    return {'success': True, 'execution_id': execution_id, 'status': 'running'}


@app.get("/scrapers/<scraper_id>/status")
@tracer.capture_method
def get_scraper_status(scraper_id: str):
    """Get the latest run status for a scraper."""
    table = get_aggregates_table()
    if not table:
        return {'scraper_id': scraper_id, 'status': 'unknown'}
    try:
        response = table.query(KeyConditionExpression=Key('pk').eq(f'SCRAPER_RUN#{scraper_id}'), ScanIndexForward=False, Limit=1)
        items = response.get('Items', [])
        if not items:
            return {'scraper_id': scraper_id, 'status': 'never_run'}
        run = items[0]
        return {'scraper_id': scraper_id, 'execution_id': run.get('sk'), 'status': run.get('status', 'unknown'),
                'started_at': run.get('started_at'), 'completed_at': run.get('completed_at'),
                'pages_scraped': run.get('pages_scraped', 0), 'items_found': run.get('items_found', 0),
                # Readable by every user: redacted exactly as GET /logs/scraper/<id> is.
                'errors': redacted_scraper_errors(run.get('errors'))}
    except (ClientError, BotoCoreError) as e:
        logger.warning(f"Failed to get scraper status: {e}")
        return {'scraper_id': scraper_id, 'status': 'unknown', 'error': 'Failed to retrieve status'}


def _fetch_html(url: str) -> str:
    """GET `url` (already SSRF-validated) and return its body as text.

    Through `_SAFE_OPENER`: a redirect is re-validated hop by hop (a public page
    answering 302 to the Lambda Runtime API or a VPC host is refused), and every
    hop's socket connects only to an address vetted at connect time, so a name
    that re-resolves to a private address after `validate_url` (DNS rebinding)
    is refused with the same 400 `validate_url` gives.
    """
    headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'text/html,application/xhtml+xml'}
    req = urllib.request.Request(url, headers=headers)
    try:
        with _SAFE_OPENER.open(req, timeout=30) as response:
            # Capped (BE-8): the rest of an oversized page is never read.
            return response.read(MAX_PAGE_BYTES).decode('utf-8', errors='ignore')
    except urllib.error.URLError as e:
        if isinstance(e, _RedirectRefusedError):
            raise ValidationError(e.reason) from e
        if isinstance(e.reason, BlockedDestinationError):
            raise ValidationError(PRIVATE_ADDRESS_ERROR) from e
        if isinstance(e, urllib.error.HTTPError):
            raise _site_refused(e.code) from e
        raise


def _site_refused(status: int) -> ValidationError:
    """The caller's 400 for a target that answered an HTTP error status (see SITE_REFUSED_ERROR)."""
    template = BOT_WALL_ERROR if status in BOT_WALL_STATUSES else SITE_REFUSED_ERROR
    # INFO with the site's status: the assist worker (`assist_jobs._failure_text`) already
    # logs the refusal once at WARNING, so this line adds the detail, not a second warning.
    logger.info('analyze-url: the target site answered an HTTP error status',
                extra={'upstream_status': status})
    return ValidationError(template.format(status=status))


def _parse_selectors(response_text: str) -> dict:
    """The first flat JSON object in the model's reply."""
    json_match = re.search(r'\{[^{}]*\}', response_text, re.DOTALL)
    if not json_match:
        raise ServiceError('Could not parse selectors from response')
    return json.loads(json_match.group())


ANALYZE_URL_JOB = 'assist_analyze_url'
ANALYZE_URL_FAILURE = 'Failed to analyze URL'


@app.post("/scrapers/analyze-url")
@tracer.capture_method
def analyze_url():
    """Start auto-detecting CSS selectors for a URL with the model → 202. ADMIN-ONLY.

    Admin-only: it exists only to fill in the scraper editor, which is admin-only, and
    every call is an outbound fetch of a caller-chosen URL plus a Bedrock call
    (spend). The gate runs before the body is read, so a non-admin's 403 fetches
    nothing and calls no model. Its URL protection is unchanged: `validate_url`
    (shared/url_policy.py) on the input — still answered here, synchronously,
    before any job exists — re-run on every redirect hop, plus connect-time
    address pinning in `_SAFE_OPENER`. The fetch and the model call run in the
    scrapers worker (`analyze_url_work`); the caller polls
    `GET /scrapers/jobs/{job_id}` for the old body.
    """
    require_admin(app.current_event.raw_event)
    # A malformed body (not JSON, or JSON that is not an object) is the caller's
    # mistake: a 400, not the unhandled AttributeError that used to escape as a 502.
    body = json_object_body(app)
    url = _validated_analyze_url(body.get('url'))
    subject = get_caller_subject(app.current_event.raw_event)
    return assist_jobs.accepted(assist_jobs.start_owned(subject, ANALYZE_URL_JOB, {'url': url}))


@app.get("/scrapers/jobs/<job_id>")
@tracer.capture_method
def get_scrapers_assist_job(job_id: str):
    """Poll one of the caller's own scraper assists (404 for anyone else's)."""
    return assist_jobs.get(assist_jobs.owner_pk(get_caller_subject(app.current_event.raw_event)), job_id)


def _validated_analyze_url(url: object) -> str:
    """The URL to analyze, or the caller's 400 (missing, or refused by the SSRF policy)."""
    if not isinstance(url, str) or not url:
        raise ValidationError('URL is required')
    is_valid, error_message = validate_url(url)
    if not is_valid:
        raise ValidationError(error_message)
    return url


def analyze_url_work(config: dict) -> dict:
    """The worker side of analyze-url: fetch, ask the model, parse — the route's old 200 body.

    The URL is validated again (DNS may have changed since the request), and every
    hop of the fetch is re-validated and pinned as before.
    """
    url = _validated_analyze_url(config.get('url'))
    try:
        html_sample = _fetch_html(url)[:50000]
        from shared.converse import converse
        prompt = f"""Analyze this HTML and identify CSS selectors for extracting reviews:\n\n```html\n{html_sample}\n```\n\nReturn JSON with: container_selector, text_selector, rating_selector, author_selector, date_selector, confidence (high/medium/low), detected_reviews_count"""

        # 2048: strict-JSON output must fit ONE call (see the strict-JSON
        # doctrine in shared/converse.py).
        response_text = converse(prompt=prompt, max_tokens=2048, surface='utility', step_name='analyze_scraper_url')
        selectors = _parse_selectors(response_text)
    except (ValidationError, ServiceError):
        raise
    except Exception as e:
        logger.exception(f"Failed to analyze URL: {e}")
        raise ServiceError(ANALYZE_URL_FAILURE) from e
    return {'success': True, 'selectors': selectors}


ASSIST_WORK = {ANALYZE_URL_JOB: assist_jobs.Work(analyze_url_work, ANALYZE_URL_FAILURE)}


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    if assist_jobs.is_assist_event(event):
        return assist_jobs.run(event, ASSIST_WORK)
    return app.resolve(event, context)
