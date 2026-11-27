"""
S3-triggered text extraction for project product documents (visual grounding, rung 2).

WHAT IT DOES
    Fires on every object created under `projects/` in the raw-data bucket, keeps
    only the keys that are product-doc uploads, and turns each one into plain text
    at `projects/{project_id}/product_docs/extracted/{doc_id}.txt`. The DynamoDB
    record written by `lambda/api/product_context.py::create_upload_url` walks
    `pending` -> `extracting` -> exactly one terminal state, `ready` or `failed`.

    Every write is conditional on the record still being NON-terminal, because
    the API's read path can fail a stalled record first and a late extraction must
    not undo that — see _update_doc.

    A workspace's upload (docs/multi-workspace.md, the project plan, 3f) is
    `ws/{ws}/projects/{id}/product_docs/raw/{doc}.{ext}`, notified by the stack's
    `ws/` rules. It is extracted inside that workspace only (its record under
    `WS#{ws}#PROJECT#{id}`, its text under `ws/{ws}/projects/{id}/product_docs/
    extracted/`), and only when the project's claim (`PROJECT_ID#{id}` / `CLAIM`)
    names that same workspace and the workspace is active; see
    _process_workspace_upload. Anything else is refused, and nothing is written.

    Text (.md/.txt): reading the bytes IS the extraction — they are copied through
    byte-for-byte.
    Images (png/jpeg/gif/webp): Bedrock describes the design in enough detail that
    the prototype builder can rebuild it WITHOUT the image (see
    IMAGE_EXTRACTION_PROMPT).

WHY NO aws_lambda_powertools, AND NO `lambda/shared/` IMPORTS
    `shared/model_config.py` imports `shared/logging.py`, which imports
    aws-lambda-powertools. Depending on `shared/` would therefore force this
    function onto a LayerVersion, and building that layer means container bundling
    inside VocCoreStack — a property that stack deliberately protects (its
    signing-key custom resource is written in Node precisely so CoreStack never
    needs Docker). Stdlib + boto3 only, like the two Python handlers CoreStack
    already ships (`lambda/custom_resources/admin_bootstrap.py`, `model_pin.py`).

    The cost of that isolation is this file re-implements four small things that
    exist in `shared/`: model resolution (see _resolve_model_id, which mirrors
    `shared/model_config.py::get_active_model_id` exactly), the reserved-word
    aliasing in the status writes (pattern from `shared/jobs.py`), structured
    JSON logging with per-record context (see JsonFormatter — powertools' output
    shape and `append_keys` behaviour, in a stdlib Formatter subclass, on a named
    logger that does not propagate, which is the shape powertools' own Logger
    takes), and the conditional-check-failure predicate (see
    _is_conditional_check_failure, which mirrors
    `shared/aws.py::is_conditional_check_failure`). All four are pinned by tests.

    WHAT THE ISOLATION DOES NOT COST is structured logs. Emitting plain text
    because powertools is unavailable would be a non-sequitur: the JSON shape is
    a formatter, not a library.

WHY NO NEW PIP DEPENDENCY
    Image dimensions are read from the file header with `struct` (see
    _sniff_format / _dimensions_from_head), so no Pillow. `imghdr` is NOT an
    option either — it was removed from the standard library in Python 3.13 and
    this function runs on python3.15.
"""
from __future__ import annotations

import json
import logging
import os
import re
import struct
import sys
import time
from typing import TYPE_CHECKING, Any
from urllib.parse import unquote_plus

import boto3

if TYPE_CHECKING:
    from mypy_boto3_bedrock_runtime.literals import ImageFormatType

# ── Structured logging (stdlib only, see the module docstring) ───────────────
# Every other Lambda in this app emits powertools JSON. This one cannot import
# powertools, but STRUCTURED LOGGING DOES NOT REQUIRE IT — a Formatter subclass
# is the whole mechanism.
#
# It matters here more than anywhere else: this is the one component whose
# failure reaches the user as a single short sentence and nothing more, so a
# diagnosis happens entirely in CloudWatch. `doc_id` appears in 18 log lines; as
# an f-string substring it is a text search, as a field it is a filter.
#
# SERVICE_NAME rather than POWERTOOLS_SERVICE_NAME on purpose: the name of the
# variable would otherwise promise a library this function deliberately does not
# have. The emitted FIELD is `service`, matching what powertools writes, so an
# operator's query is the same across every function.
SERVICE_NAME = os.environ.get('SERVICE_NAME', 'voc-product-doc-extractor')

#: Fields merged into EVERY log record by JsonFormatter. Set once per S3 record
#: in _process_record and cleared there in a `finally`, which is what gives all
#: 18 existing log lines their identifiers without editing a single call site —
#: the same thing powertools' `Logger.append_keys` does.
_log_context: dict = {}

#: Attribute names logging puts on a record itself, so that everything ELSE in
#: `record.__dict__` can be treated as a caller's `extra=`. Taken from a real
#: LogRecord rather than typed out: a name added by a future Python version would
#: otherwise start appearing in the JSON as if it were an extra. `asctime` is
#: added by another handler's Formatter.format and is not present on a fresh
#: record. (`message` is added the same way, but JsonFormatter writes that key
#: itself first, so the `setdefault` merge already keeps the record's copy out.)
_RECORD_ATTRS = frozenset(logging.makeLogRecord({}).__dict__) | {'asctime'}


def _stringify(value: object) -> str:
    """Last-resort rendering for a value json cannot serialise.

    A log call must never be the thing that breaks an extraction, so this cannot
    raise either — a __repr__ that throws is rare but it is not impossible, and
    the alternative is losing the line.
    """
    try:
        return repr(value)
    except Exception:  # noqa: BLE001 - a log line must not raise
        return f'<unrepresentable {type(value).__name__}>'


class JsonFormatter(logging.Formatter):
    """One JSON object per log record: level, message, timestamp, service, fields.

    `_log_context` is merged at FORMAT time, which is what lets a value set once
    per S3 record reach lines logged arbitrarily deep in the call stack.

    Nothing here may raise. Two defences, for two different failures: `default=`
    handles a value json does not know (it is consulted per value), and the
    fallback below handles a structure json cannot walk AT ALL — a circular
    reference, for which `default=` is never called and json raises ValueError.
    """

    def format(self, record: logging.LogRecord) -> str:
        # What logging.Formatter.format does first, and not decoration: other
        # handlers on the same record read `record.message` (pytest's capture
        # handler is one), so a formatter that skips it leaves them with an
        # AttributeError on a record this one has already formatted.
        record.message = record.getMessage()
        payload: dict = {
            'level': record.levelname,
            'message': record.message,
            'timestamp': self.formatTime(record),
            'service': SERVICE_NAME,
        }
        extras = {k: v for k, v in record.__dict__.items() if k not in _RECORD_ATTRS}
        for key, value in {**_log_context, **extras}.items():
            # setdefault, so a stray `extra={'level': ...}` cannot rewrite the
            # four fields above into something a query no longer matches.
            payload.setdefault(key, value)
        if record.exc_info:
            # logger.exception's whole point. Without this the traceback is lost,
            # which for the extractor's catch-all handlers is the only record of
            # WHY a document failed.
            payload['exception'] = self.formatException(record.exc_info)
        if record.stack_info:
            payload['stack'] = self.formatStack(record.stack_info)
        try:
            return json.dumps(payload, default=_stringify)
        except (TypeError, ValueError):
            flattened = {
                k: v if isinstance(v, (str, int, float, bool, type(None))) else _stringify(v)
                for k, v in payload.items()
            }
            return json.dumps(flattened, default=_stringify)


def _log_level() -> int:
    """The configured level, defaulting to INFO — the app-wide convention."""
    name = os.environ.get('LOG_LEVEL')
    if not name:
        return logging.INFO
    return logging.getLevelNamesMapping().get(name.strip().upper(), logging.INFO)


#: The name given to the handler this module installs, so that a SECOND import
#: can find it. `Handler.set_name` is stdlib and, unlike `isinstance`, it survives
#: a module reload: reloading rebinds `JsonFormatter` to a new class object, and
#: an isinstance check against the new one answers False for the handler the
#: previous generation installed — which is precisely when a duplicate appears.
HANDLER_NAME = 'voc-product-doc-extractor-json'


def _configure_logging(target: logging.Logger) -> None:
    """Give `target` exactly one JSON handler, and keep its lines off the root logger.

    A NAMED logger that does not propagate — the same shape powertools' own
    Logger takes — which settles three things at once:

    NO DOUBLED LINE. The Lambda runtime pre-installs a plain-text handler on the
    ROOT logger, so a record that propagates there is emitted twice: once as JSON
    by ours, once as text by the runtime's. A doubled line reads like a retry
    rather than like a formatting mistake, so it misleads exactly the person
    reading the log during a diagnosis. `propagate = False` is the whole
    mechanism; detaching the runtime's handler (what this function used to do) is
    no longer needed, because our records never reach it — and detaching a handler
    the runtime owns would also have taken away the plain-text destination for
    every OTHER library that logs through root.

    NO SIDE EFFECT ON THE HOST. Configuring the ROOT logger at import time
    reformatted and re-levelled logging for whatever process imported this module;
    under pytest that is every other suite in the run, from one handler module's
    import. A named logger touches only itself.

    IDEMPOTENT. A second import or a reload must not add a second handler — that
    is how one log call becomes N lines, and nothing about the JSON output would
    look wrong while it happened.

    LINES STILL REACH CLOUDWATCH, which is the thing not propagating could
    plausibly have cost: the handler writes to `sys.stdout`, and Lambda forwards
    everything the function process writes there to the log stream. That is where
    powertools writes too. Binding the stream at import time is safe on either
    reading of the runtime — it wraps `sys.stdout` during bootstrap, before it
    imports the handler module, and unwrapped it is still fd 1, which the execution
    environment captures.
    """
    target.propagate = False
    # Re-read on every call, so a reload picks up a changed LOG_LEVEL even when
    # the handler below is already in place.
    target.setLevel(_log_level())
    if any(h.name == HANDLER_NAME for h in target.handlers):
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.set_name(HANDLER_NAME)
    handler.setFormatter(JsonFormatter())
    target.addHandler(handler)


#: NOT the root logger: see _configure_logging.
logger = logging.getLogger(__name__)
_configure_logging(logger)

RAW_DATA_BUCKET = os.environ.get('RAW_DATA_BUCKET', '')
PROJECTS_TABLE = os.environ.get('PROJECTS_TABLE', '')
AGGREGATES_TABLE = os.environ.get('AGGREGATES_TABLE', '')

# Model resolution inputs, all injected by core-stack.ts. MODEL_ALLOWLIST is
# rendered from ALLOWED_MODEL_IDS in lib/utils/model-allowlist.ts at synth time,
# so there is no second copy of the allowlist to rot.
DEFAULT_MODEL_ID = os.environ.get('DEFAULT_MODEL_ID', '')
MODEL_SETTINGS_PK = 'SETTINGS#model'
MODEL_SETTINGS_SK = 'config'
#: The deployment's default model, pinned at deploy (custom_resources/model_pin.py), below the picks.
MODEL_DEFAULT_PK = 'SETTINGS#model_default'
MODEL_SURFACE = 'documents'

# Only product-doc uploads. Anything else under the notification's `projects/`
# prefix is ignored — including this function's OWN output, which lands at
# `projects/{id}/product_docs/extracted/...` and would otherwise re-trigger the
# Lambda in a loop. That is why the guard is not the redundant check it looks
# like: the stack wires ONE broad prefix rule, and this pattern is what makes
# that safe.
RAW_KEY_PATTERN = re.compile(
    r'^projects/(?P<project_id>[^/]+)/product_docs/raw/(?P<doc_id>[^/.]+)\.(?P<ext>[^/.]+)\Z'
)

DOC_SK_PREFIX = 'PRODUCT_DOC#'

# ── A workspace's uploads (docs/multi-workspace.md, the project plan, 3f) ─────
# The stack notifies this function of objects under `ws/` that end in one of
# UPLOAD_EXTENSIONS (one rule per extension: an S3 rule takes one prefix and one
# suffix, and no prefix can name "every workspace's product_docs/raw/"), so most
# `ws/` objects never reach it; the strict pattern below is what keeps every
# other one out, this function's own `.txt` output included.
#
# Every key below is spelled here because this bundle cannot import shared/
# (module docstring). schemas/project-keys-cases.json holds each one, and both
# this function's tests and shared/'s read it, so the two spellings cannot drift:
# the claim (shared/ws_repo.py `project_claim`), the workspace's META
# (`workspace_is_active`), the project partition (shared/project_keys.py
# `project_pk`) and the object keys (api/product_context.py `product_doc_raw_key`).
WORKSPACE_OBJECT_PREFIX = 'ws/'
#: The extensions api/product_context.py ALLOWED_CONTENT_TYPES gives an upload, and the stack's `ws/` suffixes.
UPLOAD_EXTENSIONS = ('gif', 'jpg', 'md', 'png', 'txt', 'webp')
#: `ws_` + a ULID (shared/workspace_ids.py `_WORKSPACE_ID`), as the start of the key and in a claim.
WORKSPACE_ID_REGEX = r'ws_[0-7][0-9A-HJKMNP-TV-Z]{25}'
WORKSPACE_ID_PATTERN = re.compile(WORKSPACE_ID_REGEX)
#: A project or document id: the opaque-id shape (shared/row_ids.py LONG_OPAQUE_ID_RE), so no `.`, `/`, `%` or `#`.
OPAQUE_ID_REGEX = r'[A-Za-z0-9_-]{1,128}'
#: A workspace's upload, matched whole: one workspace id, a project id and a document id of the opaque-id shape (so
#: no `..`, no empty or extra segment and no escaped separator), and one known extension. shared/'s tests hold both
#: id expressions to shared/'s.
WORKSPACE_RAW_KEY_PATTERN = re.compile(
    rf'ws/(?P<workspace_id>{WORKSPACE_ID_REGEX})/projects/(?P<project_id>{OPAQUE_ID_REGEX})'
    rf'/product_docs/raw/(?P<doc_id>{OPAQUE_ID_REGEX})\.(?P<ext>{"|".join(UPLOAD_EXTENSIONS)})'
)
#: A `ws/` key that names a product-doc upload but fails the pattern is refused (logged), not quietly ignored.
_WORKSPACE_UPLOAD_MARKER = '/product_docs/raw/'
#: The deployment-wide claim of a project id (shared/ws_repo.py PROJECT_CLAIM_PREFIX, PROJECT_CLAIM_SORT_KEY), and the
#: one attribute read of it (WORKSPACE_FIELD).
PROJECT_CLAIM_PREFIX = 'PROJECT_ID#'
PROJECT_CLAIM_SORT_KEY = 'CLAIM'
CLAIM_WORKSPACE_FIELD = 'workspace_id'
#: A workspace's META in voc-workspaces (shared/ws_repo.py `workspace_is_active`): read for its status only.
WORKSPACES_TABLE = os.environ.get('WORKSPACES_TABLE', '')
WORKSPACE_META_SORT_KEY = 'META'
WORKSPACE_STATUS_ATTRIBUTES = ('pk', 'sk', 'status')
#: What the extractor reads of a workspace's document record (its GetItem's projection, all its role may read there).
DOC_READ_ATTRIBUTES = ('content_type', 'pk', 's3_raw_key', 'sk', 'status')
WORKSPACE_ACTIVE = 'active'
#: The reason a workspace's image upload fails with, shown to the user (the model picks are the deployment's yet).
WORKSPACE_IMAGE_MESSAGE = "Images can't be described in a workspace yet. Upload the design as a .md or .txt file."

# The statuses this handler may read from AND write over. `ready` and `failed`
# are terminal and deliberately absent: see _update_doc for why writing over a
# terminal record is worse than losing this extraction's result.
NON_TERMINAL_STATUSES = ('pending', 'extracting')

# The other half of the vocabulary, named so a refused write can say WHICH cause
# it hit: a terminal status is the API having failed a stalled record, and that
# is the one worth alerting on. Anything outside either tuple is a malformed or
# legacy record — see _log_refused_write.
#
# The two tuples must therefore PARTITION the whole vocabulary, which lives in
# lambda/api/product_context.py as PRODUCT_DOC_STATUSES (not importable here — it
# reaches powertools through shared/). test/test_status_lockstep.py pins them
# against it, because a status added there and to neither tuple turns a well-formed
# record into a "malformed" log line.
TERMINAL_STATUSES = ('ready', 'failed')

# Content types this handler can turn into text, mirroring ALLOWED_CONTENT_TYPES
# in lambda/api/product_context.py (the upload boundary refuses everything else,
# so an unlisted type here means the two have drifted).
TEXT_CONTENT_TYPES = frozenset({'text/markdown', 'text/plain'})

# Content type -> the Bedrock Converse `format` token. NOT the file extension:
# the S3 key for an image/jpeg ends `.jpg`, but Converse only accepts `jpeg` and
# answers a bare 400 ValidationException for `jpg`. Sending the extension here is
# a silent, uninformative failure, so the mapping is explicit.
CONVERSE_IMAGE_FORMATS: dict[str, ImageFormatType] = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/gif': 'gif',
    'image/webp': 'webp',
}

# Bytes of header needed by the widest non-JPEG parse (WebP VP8X canvas size ends
# at byte 30).
HEADER_BYTES = 32

# JPEG needs far more than a fixed header: the SOFn segment that carries the
# dimensions sits after any APP0/APP1 segments, and a single EXIF block can be
# 64KB on its own. So the JPEG branch — and only the JPEG branch — pulls a larger
# window before walking markers. Still a ranged GET, so a bogus multi-megabyte
# file is rejected without downloading it whole.
JPEG_SCAN_BYTES = 256 * 1024

MAX_DESCRIPTION_TOKENS = 4096

# This Lambda's Bedrock budget. Same invariant as shared/aws.py's — the two numbers
# multiply and the product must stay under this function's own timeout — but sized
# against 120 s rather than the 15-minute jobs, and duplicated rather than imported
# because this handler is stdlib+boto3 only (see the module docstring), like
# _is_conditional_check_failure below. The reasoning lives there.
#
# botocore's DEFAULTS break that invariant here: 60 s with the default retry budget
# outlasts 120 s, so the final attempt is always killed in flight. 80 s x 1 leaves
# time to record the failure, and widens the window for a slow description either
# way. Raising it means re-checking core-stack.ts's timeout, itself bounded by
# product_context.py's EXTRACTION_STALL_SECONDS.
BEDROCK_READ_TIMEOUT_SECONDS = 80
BEDROCK_MAX_ATTEMPTS = 1
BEDROCK_CONNECT_TIMEOUT_SECONDS = 10

# The prototype generator's neutral default palette is indigo #4F46E5 (see
# PROTOTYPE_HTML_SYSTEM_PROMPT in lambda/jobs/document_generator/handler.py). A
# description that comes back with adjectives instead of values leaves the
# generator on that default, which is indistinguishable from no grounding at
# all — the upload appears to work and the prototype looks exactly as it would
# have without it. That is the whole reason concrete hex values are demanded
# below: "a clean modern banking app, mostly blue" survives the round trip as
# indigo; `#0F62FE` does not.
#
# The description is also the ONLY channel that reaches the builder — an image
# attached to a build is dropped from every continuation turn — so this asks for
# each of the generator's own levers by name: the eight `:root` custom
# properties, the mobile-shell/desktop-nav layout flag, screens, components,
# verbatim labels, radius and system-font type treatment. Headed markdown
# sections keep the output stable enough to read back.
IMAGE_EXTRACTION_PROMPT = """You are reverse-engineering a product's visual design from a screenshot, mockup or design file, so that a DIFFERENT model can rebuild it as a single-file HTML prototype WITHOUT ever seeing this image.

That model will never see it. Your description is the only channel, so anything you leave out is lost for good. Be concrete and exhaustive. Never write "modern", "clean" or "professional" where a hex value, a pixel number or a verbatim string would do.

Reply using EXACTLY these markdown sections, in this order, and nothing else.

## Palette
Give a CONCRETE 6-digit hex value for each of the eight CSS custom properties below. SAMPLE the colours from the image — read the actual pixels rather than guessing a plausible brand palette. If a role is genuinely absent from the image, derive it from the colours that are present and mark it "(derived)".
Write one line per property, in this exact form:
`--primary`: #RRGGBB - where it appears in the image
- `--primary`: the dominant brand/action colour (primary buttons, active states)
- `--primary-light`: a lighter variant of the same hue
- `--soft`: a soft muted fill of that hue (badges, selected rows, chips)
- `--tint`: the faintest tint of that hue (section backgrounds)
- `--bg`: the page background
- `--ink`: the primary text colour
- `--gray`: the secondary/muted text colour
- `--surface`: the card/panel surface colour

## Layout
State exactly ONE of these two words on the first line:
- `mobile` - a ~420px phone shell with a sticky bottom tab bar
- `desktop` - a full-width layout with a top navigation bar
Then give the visual evidence for that choice: device frame, status bar, bottom tab bar, side navigation, window chrome, content width relative to the image width.

## Screens
Every distinct screen or view visible in the image, one per line:
name - purpose - the main blocks it contains, top to bottom.

## Components
Every reusable UI component, one per line:
type (button, card, list row, tab bar, input, badge, chart, modal, avatar, ...) - where it appears - its visual treatment (fill, border, elevation, size, icon).

## Labels
Reproduce every piece of visible text VERBATIM, in the ORIGINAL LANGUAGE. Do not translate, correct, shorten or paraphrase, and keep capitalisation, punctuation, currency symbols and digits exactly as shown. Group under these headings: Navigation, Buttons, Headings, Field labels, Other.

## Shape and type
- Corner radius in px for buttons, cards, inputs and avatars — state each; give a range when they differ.
- Type treatment expressible with a system font stack ONLY (-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial): relative sizes, weights, letter-spacing, all-caps usage, alignment. Do NOT name a webfont; the prototype is offline-first and cannot load one.
- Density and depth: spacing rhythm (tight/generous), border vs shadow treatment, and whether surfaces are flat or elevated.

If the image is not a user interface at all, say so on the first line of `## Layout` and still fill in `## Palette` from the colours actually present."""


# ── AWS clients (lazy, so tests can patch at the import boundary) ────────────

_clients: dict = {}


def _s3():
    if 's3' not in _clients:
        _clients['s3'] = boto3.client('s3')
    return _clients['s3']


# EU inference scope (docs/eu-deployment.md). Mirrors
# shared/model_config.py::invocation_model_id, which this Lambda cannot import
# (see the module docstring); test_inference_scope_lockstep.py pins the two.
# Stored and allowlisted ids stay canonical `global.`; only the id on the wire
# becomes `eu.` when the stack sets BEDROCK_INFERENCE_SCOPE=eu, because an EU
# deployment is granted ONLY the `eu.` profiles.
_GLOBAL_MODEL_PREFIX = 'global.'
_SCOPE_MODEL_PREFIXES = {'eu': 'eu.'}


def _invocation_model_id(model_id: str) -> str:
    """``global.x`` -> ``eu.x`` under BEDROCK_INFERENCE_SCOPE=eu; anything else unchanged (idempotent)."""
    scope = os.environ.get('BEDROCK_INFERENCE_SCOPE', '').strip().lower()
    prefix = _SCOPE_MODEL_PREFIXES.get(scope)
    if prefix is None or not model_id.startswith(_GLOBAL_MODEL_PREFIX):
        return model_id
    return prefix + model_id[len(_GLOBAL_MODEL_PREFIX):]


def _scope_model_id_param(params: dict, **_kwargs: object) -> None:
    """botocore ``provide-client-params`` hook (fires before validation): map ``modelId`` in place."""
    model_id = params.get('modelId')
    if isinstance(model_id, str):
        params['modelId'] = _invocation_model_id(model_id)


def _bedrock():
    if 'bedrock' not in _clients:
        from botocore.config import Config
        client = boto3.client('bedrock-runtime', config=Config(
            read_timeout=BEDROCK_READ_TIMEOUT_SECONDS,
            connect_timeout=BEDROCK_CONNECT_TIMEOUT_SECONDS,
            retries={'max_attempts': BEDROCK_MAX_ATTEMPTS, 'mode': 'standard'},
        ))
        client.meta.events.register('provide-client-params.bedrock-runtime', _scope_model_id_param,
                                    unique_id='voc-inference-scope')
        _clients['bedrock'] = client
    return _clients['bedrock']


# ── Usage line (stdlib mirror of shared/usage_meter.py) ─────────────────────
# Each successful Converse or InvokeModel call on a scoped Python client logs one `bedrock_usage` line
# (docs/multi-workspace.md, "Cost per workspace"). This Lambda cannot
# import shared/ (module docstring), so its one Converse call logs the same fields here, counted to UNATTRIBUTED (the
# upload's workspace is not resolved in this Lambda). test/test_usage_lockstep.py pins the fields to the original.
_USAGE_LINE = 'bedrock_usage'
_USAGE_UNREADABLE = 'bedrock_usage_unreadable'
_USAGE_FIELDS = ('workspace_id', 'model_id', 'operation', 'service_tier',
                 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens')
_USAGE_KEYS = ('inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens')
_UNATTRIBUTED = 'UNATTRIBUTED'


def _usage_fields(model_id: str, response: object) -> dict[str, object] | None:
    """The line's fields for one Converse response (numbers and ids only), or None when its usage is unreadable."""
    usage = response.get('usage') if isinstance(response, dict) else None
    if not isinstance(usage, dict) or 'inputTokens' not in usage or 'outputTokens' not in usage:
        return None
    counts = [usage.get(key, 0) for key in _USAGE_KEYS]
    if not all(isinstance(n, int) and not isinstance(n, bool) and n >= 0 for n in counts):
        return None
    tier = response.get('serviceTier') if isinstance(response, dict) else None
    tier_type = tier.get('type') if isinstance(tier, dict) else None
    values = (_UNATTRIBUTED, model_id, 'Converse', tier_type if isinstance(tier_type, str) and tier_type else 'default',
              *counts)
    return dict(zip(_USAGE_FIELDS, values, strict=True))


def _log_usage(model_id: str, response: object) -> None:
    """Never raises: an unreadable response logs the operation only."""
    fields = _usage_fields(model_id, response)
    if fields is None:
        logger.warning(_USAGE_UNREADABLE, extra={'operation': 'Converse', 'reason': 'usage is unreadable'})
    else:
        logger.info(_USAGE_LINE, extra=fields)


def _table(name: str):
    key = f'table:{name}'
    if key not in _clients:
        _clients[key] = boto3.resource('dynamodb').Table(name)
    return _clients[key]


# ── Model resolution (mirror of shared/model_config.py, without the import) ──

def _allowlist() -> set:
    """Allowlisted inference-profile ids, from the env the stack injects.

    Never raises: a missing or malformed MODEL_ALLOWLIST yields an empty set,
    which makes _allowlisted() reject every configured value and resolution fall
    through to DEFAULT_MODEL_ID — the same fail-safe direction shared/ takes.
    """
    try:
        parsed = json.loads(os.environ.get('MODEL_ALLOWLIST', '') or '[]')
    except ValueError:
        logger.warning('MODEL_ALLOWLIST is not valid JSON; ignoring configured models')
        return set()
    return {m for m in parsed if isinstance(m, str)} if isinstance(parsed, list) else set()


def _allowlisted(model_id, allowed: set) -> str | None:
    """model_id when it is an allowlisted string, else None.

    A configured value outside the allowlist (a stale or tampered settings row)
    is logged and IGNORED — it must never reach Bedrock, because a model that is
    selectable but not granted AccessDenies the whole surface.
    """
    if isinstance(model_id, str) and model_id in allowed:
        return model_id
    if model_id:
        logger.warning(f"Configured model '{str(model_id)[:80]}' not in allowlist; ignoring")
    return None


def _model_row(pk: str) -> object:
    """One model row of the aggregates table (``sk`` ``config``), or None; a failed read is logged, never raised."""
    try:
        return _table(AGGREGATES_TABLE).get_item(Key={'pk': pk, 'sk': MODEL_SETTINGS_SK}).get('Item')
    except Exception as e:  # noqa: BLE001 - model lookup must never break extraction
        logger.warning(f'Model settings lookup failed; using default: {e}')
        return None


def _resolve_model_id() -> str:
    """The model id for the `documents` surface. Never raises.

    Same precedence as shared/model_config.py::get_active_model_id:
    per-surface override > legacy global override > the deployment's default
    (SETTINGS#model_default) > built-in default. A failed read of either row
    keeps what the other answered; nothing read (no table configured, no
    item, read errors) resolves to DEFAULT_MODEL_ID, because a model lookup is
    not allowed to break extraction.

    No per-container cache, unlike shared/: this function handles one document
    per invocation rather than a hot inference loop, so its two get_items cost
    nothing worth caching, and a fresh read means a model just changed in
    Settings applies to the very next upload.
    """
    settings: dict = {}
    pinned: dict = {}
    if AGGREGATES_TABLE:
        # Each row read on its own: a failed read of one keeps what the other answered, as in shared/model_config.py.
        item = _model_row(MODEL_SETTINGS_PK)
        if isinstance(item, dict):
            settings = item
        default_item = _model_row(MODEL_DEFAULT_PK)
        if isinstance(default_item, dict):
            pinned = default_item

    allowed = _allowlist()
    surfaces = settings.get('surfaces')
    if isinstance(surfaces, dict):
        per_surface = _allowlisted(surfaces.get(MODEL_SURFACE), allowed)
        if per_surface:
            return per_surface
    legacy_global = _allowlisted(settings.get('model_id'), allowed)
    if legacy_global:
        return legacy_global
    deployment_default = _allowlisted(pinned.get('model_id'), allowed)
    if deployment_default:
        return deployment_default
    return DEFAULT_MODEL_ID


# ── Image header parsing (stdlib only) ───────────────────────────────────────
# One parse, three jobs, which is what makes it worth writing by hand:
#   1. the MAX_IMAGE_DIMENSION_PX cap;
#   2. a real content-type sniff — a .png full of PDF bytes is caught here, and
#      the client's declared content_type is never taken on trust;
#   3. the corrupt/truncated-image detection the acceptance criteria require.

def _sniff_format(head: bytes) -> str | None:
    """The image format the BYTES say this is, or None if unrecognised."""
    if head.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png'
    if head.startswith(b'\xff\xd8\xff'):
        return 'jpeg'
    if head.startswith((b'GIF87a', b'GIF89a')):
        return 'gif'
    if head.startswith(b'RIFF') and head[8:12] == b'WEBP':
        return 'webp'
    return None


def _png_dimensions(head: bytes) -> tuple[int, int] | None:
    # 8-byte signature, 4-byte chunk length, b'IHDR', then width/height as
    # big-endian uint32 — a fixed offset, so no chunk walking is needed.
    if len(head) < 24 or head[12:16] != b'IHDR':
        return None
    width, height = struct.unpack('>II', head[16:24])
    return width, height


def _gif_dimensions(head: bytes) -> tuple[int, int] | None:
    # Logical screen descriptor: little-endian uint16 width/height right after
    # the 6-byte signature.
    if len(head) < 10:
        return None
    width, height = struct.unpack('<HH', head[6:10])
    return width, height


def _webp_dimensions(head: bytes) -> tuple[int, int] | None:
    # RIFF container: 'RIFF' + size + 'WEBP', then one of three bitstream chunks,
    # each storing the canvas size differently.
    chunk = head[12:16]
    if chunk == b'VP8 ':
        # Lossy: 3-byte frame tag, 3-byte sync code, then 14-bit width/height.
        if len(head) < 30 or head[23:26] != b'\x9d\x01\x2a':
            return None
        width, height = struct.unpack('<HH', head[26:30])
        return width & 0x3FFF, height & 0x3FFF
    if chunk == b'VP8L':
        # Lossless: signature byte, then 14 bits of (width-1) and (height-1).
        if len(head) < 25 or head[20] != 0x2F:
            return None
        bits = struct.unpack('<I', head[21:25])[0]
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if chunk == b'VP8X':
        # Extended: flags + reserved, then 24-bit (canvas-1) dimensions.
        if len(head) < 30:
            return None
        width = int.from_bytes(head[24:27], 'little') + 1
        height = int.from_bytes(head[27:30], 'little') + 1
        return width, height
    return None


def _jpeg_dimensions(data: bytes) -> tuple[int, int] | None:
    """Walk JPEG markers to the first SOFn segment, which carries the size."""
    i = 2  # past SOI
    while i + 9 <= len(data):
        if data[i] != 0xFF:
            return None  # lost marker alignment: treat as corrupt
        marker = data[i + 1]
        if marker == 0xFF:
            i += 1  # fill byte
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD9:
            i += 2  # standalone marker, no length field
            continue
        segment_length = struct.unpack('>H', data[i + 2:i + 4])[0]
        if segment_length < 2:
            return None
        # SOF0..SOF15 (the 0xCn row), excluding DHT (C4), JPG (C8) and DAC (CC).
        if marker >> 4 == 0xC and marker not in (0xC4, 0xC8, 0xCC):
            height, width = struct.unpack('>HH', data[i + 5:i + 9])
            return width, height
        i += 2 + segment_length
    return None


def _dimensions_from_head(fmt: str, head: bytes) -> tuple[int, int] | None:
    if fmt == 'png':
        return _png_dimensions(head)
    if fmt == 'gif':
        return _gif_dimensions(head)
    if fmt == 'webp':
        return _webp_dimensions(head)
    return None


# ── DynamoDB record read / terminal writes ──────────────────────────────────

def _project_pk(project_id: str, workspace: str | None) -> str:
    """The project's partition: `PROJECT#{id}`, or `WS#{ws}#PROJECT#{id}` in a workspace (shared/project_keys.py).

    A copy, not an import: this Lambda takes nothing from `shared/` (above), so
    test/test_project_keys_lockstep.py holds it to `project_keys.project_pk`. The
    workspace has no default (since 7.102.00, 3h-S1b): every call names its scope."""
    partition = f'PROJECT#{project_id}'
    return partition if workspace is None else f'WS#{workspace}#{partition}'


def _get_doc(project_id: str, doc_id: str, *, workspace: str | None) -> dict | None:
    """The product-doc record, or None when it is gone.

    The user can delete a document while its extraction is in flight, so a
    missing record is an ordinary outcome, not an error.

    In a workspace the read is projected to DOC_READ_ATTRIBUTES, the attributes
    this function uses, which is all its role may read of a workspace's record;
    the deployment's read is the unprojected one it always sent.
    """
    key = {'pk': _project_pk(project_id, workspace), 'sk': f'{DOC_SK_PREFIX}{doc_id}'}
    projected: dict = {}
    if workspace is not None:
        names = {f'#a{index}': attribute for index, attribute in enumerate(DOC_READ_ATTRIBUTES)}
        projected = {'ProjectionExpression': ', '.join(names), 'ExpressionAttributeNames': names}
    try:
        return _table(PROJECTS_TABLE).get_item(Key=key, **projected).get('Item')
    except Exception as e:  # noqa: BLE001 - a lost record must not raise
        _warn_unread_or_unwritten('Could not read product doc', doc_id, e, workspace)
        return None


def _warn_unread_or_unwritten(what: str, doc_id: str, error: Exception, workspace: str | None) -> None:
    """A failed read or write of the record: the deployment's line as it always was (the error's text included);
    a workspace's names the error's type alone, never its text (which can carry a key or an id)."""
    if workspace is None:
        logger.warning(f'{what} {doc_id}: {error}')
    else:
        logger.warning(what, extra={'error_class': type(error).__name__})


# jscpd:ignore-start — deliberate copy of shared/aws.py::is_conditional_check_failure:
# this Lambda is stdlib+boto3 only and cannot import shared/ (module docstring)
def _is_conditional_check_failure(error: Exception) -> bool:
    """True for DynamoDB's ConditionalCheckFailedException, however it arrives.

    The error CODE in the response is the dependable signal — boto3's resource
    layer raises a dynamically-built ClientError subclass, so its type name is a
    botocore implementation detail. The type name is checked as well because a
    test double raises the named exception with no response payload.

    A copy of `shared/aws.py::is_conditional_check_failure`, which is where every
    other handler gets this predicate. This file cannot import `shared/` — see
    the module docstring — so the duplication is the price of that isolation and
    not a preference. Change both, or neither.
    """
    response = getattr(error, 'response', None)
    code = (response.get('Error') or {}).get('Code') if isinstance(response, dict) else None
    return (code == 'ConditionalCheckFailedException'
            or type(error).__name__ == 'ConditionalCheckFailedException')
# jscpd:ignore-end of the accepted pair


def _log_refused_write(project_id: str, doc_id: str, values: dict, *, workspace: str | None) -> bool:
    """Say WHICH of the three causes refused the write. They mean different things. True when the record is gone.

    A record that is simply gone was deleted mid-flight — ordinary housekeeping,
    logged at INFO.

    A record that is already TERMINAL is not: the API decided this document had
    stalled and told the user to upload it again, so the result this invocation
    just computed is being discarded on purpose. That has to be greppable on its
    own rather than folded into the benign line, because it is also the signal
    that extractions are running past EXTRACTION_STALL_SECONDS and the two
    numbers need looking at.

    A record with NO status attribute, or one nobody recognises, fails the same
    condition and is neither of the above — it is malformed, or it predates the
    field. Logging it as the stall case would name stall timing as the cause of
    something that has nothing to do with timing, and since that line is the
    signal used to detect late extractions, a false positive there misleads
    exactly the person reading it during a diagnosis.

    Costs one extra get_item, and only on a path that is already exceptional.
    """
    current = _get_doc(project_id, doc_id, workspace=workspace)
    if current is None:
        logger.info(f'Product doc {doc_id} was deleted mid-extraction; write skipped')
        return True
    status = current.get('status')
    if status in TERMINAL_STATUSES:
        logger.warning(
            f'Product doc {doc_id} is already {status}; refusing to overwrite '
            f'{sorted(values)} onto it - the API already gave this document up as '
            f'stalled and told the user to upload it again'
        )
        return False
    # Deliberately shares no vocabulary with the line above: an operator greps for
    # the stall wording, so a malformed record must not match that grep, not even
    # inside a denial.
    logger.warning(
        f'Product doc {doc_id} has no usable status ({status!r}); refusing to '
        f'overwrite {sorted(values)} onto it - the record is malformed or predates '
        f'the status field, so no read path put it in this state'
    )
    return False


#: What `_update_doc` answers: the write landed, the record is gone, or it was refused or failed otherwise.
WRITE_LANDED = 'landed'
WRITE_GONE = 'gone'
WRITE_NOT_LANDED = 'not_landed'


def _update_doc(project_id: str, doc_id: str, values: dict, *, workspace: str | None) -> str:
    """Write `values` onto the record, but ONLY while it is still non-terminal. Answers WRITE_LANDED, WRITE_GONE
    (refused: the record was deleted) or WRITE_NOT_LANDED.

    `status` and `error` are DynamoDB reserved words, so they are aliased — same
    pattern as shared/jobs.py::update_job_status. The condition needs its own
    alias for `status` because `status` is usually also one of `values`, and an
    alias may not be reused across an update and a condition clause.

    TWO conditions, guarding two different races:

    `attribute_exists(pk)` — the user can delete a document while its extraction
    is in flight, and an unconditional update_item would resurrect it as a
    key-only item.

    `#doc_status IN (:pending, :extracting)` — product_context.py::_fail_if_stalled
    transitions a record that has not been extracted within
    EXTRACTION_STALL_SECONDS to `failed`, with a message telling the user to
    delete the document and upload it again. An extraction that finishes after
    that point (a Lambda retry, a cold-start pileup, Bedrock latency) must not
    overwrite that `failed` with `ready`, nor reset its `error` back to None.

    Leaving a late success as `failed` costs the user one re-upload. Flipping it
    to `ready` contradicts advice they have already been given and acted on, and
    silently attaches extracted text to a document the UI has already declared
    dead — so the failure that is cheaper to nobody is the one that is chosen.
    """
    names = {f'#k{i}': k for i, k in enumerate(values)}
    vals = {f':v{i}': v for i, v in enumerate(values.values())}
    expression = 'SET ' + ', '.join(f'#k{i} = :v{i}' for i in range(len(values)))
    status_values = {f':s{i}': s for i, s in enumerate(NON_TERMINAL_STATUSES)}
    try:
        _table(PROJECTS_TABLE).update_item(
            Key={'pk': _project_pk(project_id, workspace), 'sk': f'{DOC_SK_PREFIX}{doc_id}'},
            UpdateExpression=expression,
            ConditionExpression=(
                'attribute_exists(pk) AND #doc_status IN '
                f'({", ".join(status_values)})'
            ),
            ExpressionAttributeNames={**names, '#doc_status': 'status'},
            ExpressionAttributeValues={
                **vals,
                **status_values,
            },
        )
    except Exception as e:  # noqa: BLE001 - a bookkeeping write must not fail the batch
        if _is_conditional_check_failure(e):
            gone = _log_refused_write(project_id, doc_id, values, workspace=workspace)
            return WRITE_GONE if gone else WRITE_NOT_LANDED
        _warn_unread_or_unwritten('Could not update product doc', doc_id, e, workspace)
        return WRITE_NOT_LANDED
    return WRITE_LANDED


def _mark_extracting(project_id: str, doc_id: str, *, workspace: str | None) -> str:
    """Publish the in-flight state, once, before the slow work starts.

    `extracting` was declared in three places and written in none: the UI renders
    a distinct "Reading…" state for it (ProductSourceList.tsx, since 7.104.00), ProductDocStatus
    lists it, and product_context.py's STALLABLE_STATUSES includes it — so its
    stall branch could never be reached either. One extra update_item per
    document makes all three mean something, and lets the user tell "still
    uploading" from "being analysed", which for an image is a Bedrock call long
    enough to be worth distinguishing.

    Best-effort by construction: _update_doc swallows its failures, so a lost
    badge write cannot abort the extraction that follows. `pending` is stallable
    too, so a document whose badge never landed is not stranded either. (In a
    workspace the caller stops on a lost write instead: it answers whether it landed.)
    """
    return _update_doc(project_id, doc_id, {'status': 'extracting'}, workspace=workspace)


def _mark_failed(project_id: str, doc_id: str, message: str, *, workspace: str | None) -> None:
    """Terminal failure with a short, user-facing reason.

    `message` is shown in the UI, so it never carries a stack trace, an AWS
    error string or an S3 key — callers pass a sentence, not an exception.
    """
    logger.info(f'Product doc {doc_id} failed: {message}')
    _update_doc(project_id, doc_id, {'status': 'failed', 'error': message}, workspace=workspace)


def _mark_ready(project_id: str, doc_id: str, extracted_key: str, chars: int, *,
                workspace: str | None) -> str:
    return _update_doc(project_id, doc_id, {
        'status': 'ready',
        'error': None,
        's3_extracted_key': extracted_key,
        'extracted_chars': chars,
    }, workspace=workspace)


def _delete_own_output(bucket: str, key: str, version_id: object, doc_id: str) -> None:
    """The record was deleted while this ran, after its delete swept the document's objects (api/product_context.py
    `delete_doc`), so the text just put would outlive it: delete it again, the exact version put when the bucket
    is versioned (a plain delete there would only hide it). Never raises: a failed delete is logged by its type."""
    request: dict[str, Any] = {'Bucket': bucket, 'Key': key}
    if isinstance(version_id, str) and version_id:
        request['VersionId'] = version_id
    try:
        _s3().delete_object(**request)
    except Exception as e:  # noqa: BLE001 - the cleanup of a deleted record's text must not fail the batch
        logger.warning('Could not delete the text of a deleted product doc', extra={'error_class': type(e).__name__})
        return
    logger.info(f'Product doc {doc_id} was deleted mid-extraction; its text was deleted too')


def _extracted_key(project_id: str, doc_id: str, workspace: str | None) -> str:
    """Where the text goes: `projects/{id}/product_docs/extracted/{doc}.txt`, under `ws/{ws}/` in a workspace."""
    key = f'projects/{project_id}/product_docs/extracted/{doc_id}.txt'
    return key if workspace is None else f'{WORKSPACE_OBJECT_PREFIX}{workspace}/{key}'


# ── A workspace's upload: the claim and the status, before anything is written ─

class _Refused(Exception):
    """A workspace upload this function will not touch. Its one argument is the error type, the only thing logged."""


def _claim_key(project_id: str) -> dict[str, str]:
    """The claim of a project id (shared/ws_repo.py `_project_claim_key`); the id is already the opaque-id shape."""
    return {'pk': f'{PROJECT_CLAIM_PREFIX}{project_id}', 'sk': PROJECT_CLAIM_SORT_KEY}


def _workspace_meta_key(workspace: str) -> dict[str, str]:
    """The workspace's META in voc-workspaces (shared/ws_repo.py `control_partition(scope, 'meta')`, LOOKUP_SORT_KEY)."""
    return {'pk': f'WS#{workspace}', 'sk': WORKSPACE_META_SORT_KEY}


def _claimed_workspace(project_id: str) -> str:
    """The workspace the project id is claimed for: a strongly consistent GetItem of the claim, projected to its
    workspace id, as shared/ws_repo.py `project_claim` reads it. `_Refused` when there is no claim (a deployment
    project, or none), when it names no workspace id, or when it cannot be read: never a guess."""
    try:
        item = _table(PROJECTS_TABLE).get_item(
            Key=_claim_key(project_id), ConsistentRead=True,
            ProjectionExpression='#ws', ExpressionAttributeNames={'#ws': CLAIM_WORKSPACE_FIELD},
        ).get('Item')
    except Exception:  # noqa: BLE001 - an unread claim refuses the upload; the error is not logged with it
        raise _Refused('claim_unreadable') from None
    if not isinstance(item, dict):
        raise _Refused('claim_missing')
    workspace = item.get(CLAIM_WORKSPACE_FIELD)
    if not isinstance(workspace, str) or WORKSPACE_ID_PATTERN.fullmatch(workspace) is None:
        raise _Refused('claim_malformed')
    return workspace


def _require_active(workspace: str) -> None:
    """`_Refused` unless the workspace's META says `active` (shared/ws_repo.py `workspace_is_active`: every writer of
    a workspace's data asks before it writes, so a workspace being deleted gets nothing new). One strongly consistent
    GetItem, projected to WORKSPACE_STATUS_ATTRIBUTES; no cache, as this function handles one upload a record."""
    if not WORKSPACES_TABLE:
        raise _Refused('status_unconfigured')
    names = {f'#a{index}': attribute for index, attribute in enumerate(WORKSPACE_STATUS_ATTRIBUTES)}
    try:
        item = _table(WORKSPACES_TABLE).get_item(
            Key=_workspace_meta_key(workspace), ConsistentRead=True,
            ProjectionExpression=', '.join(names), ExpressionAttributeNames=names,
        ).get('Item')
    except Exception:  # noqa: BLE001 - an unread status refuses the upload; the error is not logged with it
        raise _Refused('status_unreadable') from None
    if not isinstance(item, dict) or item.get('status') != WORKSPACE_ACTIVE:
        raise _Refused('workspace_not_active')


def _require_admitted(project_id: str, workspace: str) -> None:
    """`_Refused` unless the project's claim names `workspace` (the one its upload key is under) and that workspace
    is active: an upload placed under another workspace's prefix, or one for a deployment project, gets nothing."""
    if _claimed_workspace(project_id) != workspace:
        raise _Refused('claim_mismatch')
    _require_active(workspace)


def _refuse(error_type: str) -> None:
    """The one line a refused workspace upload logs: its error type, no key, id or exception text (the record's
    log context is cleared first; a refusal ends the record's processing)."""
    _log_context.clear()
    logger.warning('Refused a workspace upload; nothing was written', extra={'error_type': error_type})


class _ExtractionError(Exception):
    """Carries a user-facing message straight to `error` on the record."""


def _int_env(name: str) -> int | None:
    """An integer limit from the environment, or None when it is unusable.

    Deliberately NOT defaulted to a hardcoded number: the caps live in
    lib/utils/model-allowlist.ts and lambda/shared/image_limits.py, and a third
    copy here is exactly the drift those two go to lengths to prevent. A missing
    value is a deploy bug, and the image branch refuses the document rather than
    silently extracting without a cap.
    """
    raw = os.environ.get(name)
    if raw is None:
        return None
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if value > 0 else None


# ── Extraction branches ─────────────────────────────────────────────────────

def _extract_text(bucket: str, key: str) -> tuple[str, bytes]:
    """Text upload: reading the bytes IS the extraction.

    Returns (decoded text, ORIGINAL bytes). The original bytes are what get
    written to the extracted key, byte-identically — no summarising, no
    normalising, no re-encoding. Decoding is only how the character count and the
    emptiness check are computed; `errors='replace'` keeps a stray non-UTF-8 byte
    from failing a document that is otherwise perfectly readable.
    """
    raw = _s3().get_object(Bucket=bucket, Key=key)['Body'].read()
    return raw.decode('utf-8', errors='replace'), raw


def _extract_image(bucket: str, key: str, content_type: str, actual_size: int) -> tuple[str, bytes]:
    """Image upload: describe the design with Bedrock. Returns (text, utf-8 bytes)."""
    max_bytes = _int_env('MAX_IMAGE_BYTES')
    max_dimension = _int_env('MAX_IMAGE_DIMENSION_PX')
    if not max_bytes or not max_dimension:
        logger.error('MAX_IMAGE_BYTES / MAX_IMAGE_DIMENSION_PX are not configured')
        raise _ExtractionError('Image extraction is not available right now.')

    # The size that counts is the OBJECT's, from the S3 event — not the
    # `size_bytes` the client declared when asking for the upload URL. The point
    # of checking here is that the client's number is not trustworthy.
    if actual_size <= 0:
        raise _ExtractionError('This file is empty.')
    if actual_size > max_bytes:
        raise _ExtractionError(
            f'This image is too large to analyse ({max_bytes // 1000}KB maximum).'
        )

    # Ranged GET: a file that is not the image it claims to be is rejected on ~32
    # bytes instead of after pulling megabytes.
    head = _s3().get_object(
        Bucket=bucket, Key=key, Range=f'bytes=0-{HEADER_BYTES - 1}'
    )['Body'].read()
    detected = _sniff_format(head)
    if detected is None:
        raise _ExtractionError('This file is not a readable image.')

    declared = CONVERSE_IMAGE_FORMATS.get(content_type)
    if declared is None or declared != detected:
        raise _ExtractionError(f'This file is not a valid {content_type} image.')

    if detected == 'jpeg':
        scan = _s3().get_object(
            Bucket=bucket, Key=key, Range=f'bytes=0-{JPEG_SCAN_BYTES - 1}'
        )['Body'].read()
        dimensions = _jpeg_dimensions(scan)
    else:
        dimensions = _dimensions_from_head(detected, head)
    if dimensions is None:
        raise _ExtractionError('This image file appears to be corrupt.')

    width, height = dimensions
    if width <= 0 or height <= 0:
        raise _ExtractionError('This image file appears to be corrupt.')
    if width > max_dimension or height > max_dimension:
        raise _ExtractionError(
            f'This image is too large to analyse ({max_dimension}px maximum per side, '
            f'this one is {width}x{height}).'
        )

    image_bytes = _s3().get_object(Bucket=bucket, Key=key)['Body'].read()
    model_id = _resolve_model_id()
    logger.info(f'Describing {detected} image {width}x{height} with {model_id}')
    # Raw converse with an image content block, copied from
    # lambda/jobs/persona_importer/handler.py. shared/converse.py is text-only —
    # and importing it would pull powertools in.
    #
    # No temperature: several allowlisted models reject the parameter outright,
    # and there is no shared helper here to drop it per model.
    response = _bedrock().converse(
        modelId=model_id,
        messages=[{
            'role': 'user',
            'content': [
                {'image': {'format': declared, 'source': {'bytes': image_bytes}}},
                {'text': IMAGE_EXTRACTION_PROMPT},
            ],
        }],
        inferenceConfig={'maxTokens': MAX_DESCRIPTION_TOKENS},
    )
    try:
        _log_usage(_invocation_model_id(model_id), response)
    except Exception as error:  # noqa: BLE001 - counting the call must never fail the extraction
        logger.warning(_USAGE_UNREADABLE, extra={'operation': 'Converse', 'reason': type(error).__name__})
    blocks = response.get('output', {}).get('message', {}).get('content', []) or []
    text = '\n'.join(t for b in blocks if isinstance(b, dict) and (t := b.get('text')))
    return text, text.encode('utf-8')


# ── Per-record processing ───────────────────────────────────────────────────

def _extract_by_type(bucket: str, key: str, content_type: str, obj: dict) -> tuple[str, bytes]:
    """Dispatch on the upload's content type; ``_ExtractionError`` for any other."""
    if content_type in TEXT_CONTENT_TYPES:
        return _extract_text(bucket, key)
    if content_type in CONVERSE_IMAGE_FORMATS:
        return _extract_image(bucket, key, content_type, int(obj.get('size') or 0))
    raise _ExtractionError('This file type cannot be processed.')


def _process_record(record: dict) -> None:
    """Read one S3 notification, then extract that document under its log context.

    The identifiers are not available before the key pattern matches, so the
    context is set here and the work delegated — which is also why the clear can
    be a `finally` around a single call rather than around the whole body.
    """
    s3_event = record.get('s3') or {}
    bucket = (s3_event.get('bucket') or {}).get('name') or RAW_DATA_BUCKET
    obj = s3_event.get('object') or {}
    # S3 event keys are URL-encoded: a filename with a space arrives as `+` or
    # `%20`, and a raw key would then miss both the pattern and the object.
    key = unquote_plus(obj.get('key') or '')

    if key.startswith(WORKSPACE_OBJECT_PREFIX):
        _process_workspace_upload(key, bucket, obj)
        return

    match = RAW_KEY_PATTERN.fullmatch(key)
    if not match:
        logger.info(f'Ignoring {key or "(no key)"} - not a product-doc upload')
        return

    project_id = match.group('project_id')
    doc_id = match.group('doc_id')

    # Attach this document's identifiers to every line logged from here down,
    # including from _resolve_model_id and the branch helpers, without touching
    # any of those call sites.
    _log_context.update({'project_id': project_id, 'doc_id': doc_id, 's3_key': key})
    try:
        # The deployment's upload (`projects/…`): a workspace's went to _process_workspace_upload above.
        _extract_document(project_id, doc_id, bucket, key, obj, workspace=None)
    finally:
        # LOAD-BEARING, not tidiness. A batch loops records (see lambda_handler),
        # so a context left in place would attribute the NEXT document's lines —
        # and lambda_handler's own unhandled-error line — to this doc_id. A field
        # that names the wrong document is worse than no field: it sends the
        # person reading it to the wrong record.
        _log_context.clear()


def _process_workspace_upload(key: str, bucket: str, obj: dict) -> None:
    """A `ws/` object: extract it inside its workspace, or refuse it with nothing written.

    The key must match WORKSPACE_RAW_KEY_PATTERN whole (another `ws/` object, this function's own output included,
    is ignored; a key that names a product-doc upload but does not match is refused). Then, before any write, the
    project's claim must name the key's workspace (so an upload placed under another workspace's prefix, or one for
    a deployment project, is refused) and that workspace must be active. Each refusal logs its error type alone.
    """
    match = WORKSPACE_RAW_KEY_PATTERN.fullmatch(key)
    if match is None:
        if _WORKSPACE_UPLOAD_MARKER in key:
            _refuse('malformed_key')
        else:
            logger.info('Ignoring a workspace object - not a product-doc upload')
        return
    workspace, project_id, doc_id = match.group('workspace_id', 'project_id', 'doc_id')
    try:
        _require_admitted(project_id, workspace)
    except _Refused as refusal:
        _refuse(str(refusal))
        return
    _log_context.update({'workspace_id': workspace, 'project_id': project_id, 'doc_id': doc_id, 's3_key': key})
    try:
        _extract_document(project_id, doc_id, bucket, key, obj, workspace=workspace)
    finally:
        # As in _process_record: the next record must not inherit this one's fields.
        _log_context.clear()


def _workspace_may_extract(project_id: str, doc_id: str, doc: dict, key: str, workspace: str) -> bool:
    """A workspace record's own checks, before the `extracting` write: False (and handled) when the record names
    another object (refused, nothing written) or is an image (marked failed in its workspace with
    WORKSPACE_IMAGE_MESSAGE, no model setting read: never left `pending` for the stall check to advise an upload
    again)."""
    if doc.get('s3_raw_key') != key:
        _refuse('raw_key_mismatch')
        return False
    if str(doc.get('content_type')) in CONVERSE_IMAGE_FORMATS:
        _mark_failed(project_id, doc_id, WORKSPACE_IMAGE_MESSAGE, workspace=workspace)
        return False
    return True


def _still_active(workspace: str) -> bool:
    """The status read again just before the text is put: a workspace set to `deleting` while this ran must not get
    text under its prefix after its delete swept it (refused, nothing more written)."""
    try:
        _require_active(workspace)
    except _Refused as refusal:
        _refuse(str(refusal))
        return False
    return True


def _extract_document(project_id: str, doc_id: str, bucket: str, key: str, obj: dict, *,
                      workspace: str | None) -> None:
    """Extract ONE registered product document. Split from _process_record so that
    the log context above is set and cleared around the whole of it.

    In a workspace (`workspace`, already checked against the project's claim) every
    read and write is that workspace's, and three more checks hold: the record must
    name this very object (`s3_raw_key`), the `extracting` write must land, and the
    workspace must still be active just before the text is put; each refuses with
    nothing more written. An image is marked failed there, with WORKSPACE_IMAGE_MESSAGE:
    describing it reads the model picks (`SETTINGS#model`), which are not per
    workspace yet, and this function never falls back to the deployment's."""
    doc = _get_doc(project_id, doc_id, workspace=workspace)
    if not doc:
        # Deleted mid-flight, or an object nobody registered. Nothing to update.
        logger.info(f'No product doc record for {doc_id}; skipping')
        return
    if doc.get('status') not in NON_TERMINAL_STATUSES:
        # Terminal already (a re-delivered event, a manual re-upload of the same
        # key, or the API having failed it as stalled). Re-running would re-bill a
        # Bedrock call for an answer _update_doc would then refuse to store, so
        # this check and that condition are the same set on purpose.
        logger.info(f'Product doc {doc_id} is already {doc.get("status")}; skipping')
        return

    # A missing type reads as 'None', which no branch accepts, like any other.
    content_type = str(doc.get('content_type'))
    if workspace is not None and not _workspace_may_extract(project_id, doc_id, doc, key, workspace):
        return

    # Before the S3 reads and the Bedrock call, not after: the whole value of the
    # state is that it is visible WHILE the slow part runs. In a workspace a lost
    # write stops the extraction: no text is written for a record that may be gone.
    if _mark_extracting(project_id, doc_id, workspace=workspace) != WRITE_LANDED and workspace is not None:
        _refuse('extracting_not_written')
        return

    try:
        text, payload = _extract_by_type(bucket, key, content_type, obj)
    except _ExtractionError as e:
        _mark_failed(project_id, doc_id, str(e), workspace=workspace)
        return
    except Exception:
        # Every failure is a terminal `failed`: Bedrock throttling, S3 errors,
        # decode failures. The user gets a sentence; the traceback goes to the log
        # only (logger.exception already attaches it).
        logger.exception(f'Extraction failed for {doc_id}')
        _mark_failed(project_id, doc_id, 'Text extraction failed. Please try uploading again.', workspace=workspace)
        return

    # An empty or whitespace-only extraction is a FAILURE, never `ready`.
    # build_product_context_block injects the extracted text of every `ready`
    # doc into PRD/PR-FAQ prompts, so a `ready` record with nothing in it
    # contributes nothing while claiming to be usable — the same lie, by another
    # route, that this rung exists to remove.
    if not text.strip():
        _mark_failed(project_id, doc_id, 'No text could be extracted from this file.', workspace=workspace)
        return

    if workspace is not None and not _still_active(workspace):
        return

    _store_text(project_id, doc_id, bucket, payload, len(text), workspace=workspace)


def _store_text(project_id: str, doc_id: str, bucket: str, payload: bytes, chars: int, *,
                workspace: str | None) -> None:
    """Put the text, then mark the record ready; a record deleted meanwhile gets its text taken back, since its
    delete may already have swept the document's objects."""
    extracted_key = _extracted_key(project_id, doc_id, workspace)
    put = _s3().put_object(
        Bucket=bucket,
        Key=extracted_key,
        Body=payload,
        ContentType='text/plain; charset=utf-8',
    )
    if _mark_ready(project_id, doc_id, extracted_key, chars, workspace=workspace) == WRITE_GONE:
        _delete_own_output(bucket, extracted_key, (put or {}).get('VersionId'), doc_id)
        return
    logger.info(f'Product doc {doc_id} ready ({chars} chars)')


def lambda_handler(event, context=None):
    """S3 OBJECT_CREATED entrypoint.

    DOES NOT RE-RAISE after marking a record `failed`, and that is deliberate.
    Raising would hand the event back to Lambda for two more automatic retries,
    which for the failures that actually occur here — over the size cap, over the
    dimension cap, bytes that are not the declared image, an empty model
    response — are deterministic: the retry re-runs the same work, re-bills the
    same Bedrock call, and arrives at the same answer, having meanwhile
    overwritten a truthful `failed` record with two more identical ones. The
    record IS the durable outcome, so the log plus that record is the whole
    story. Records are processed independently so one bad document cannot take
    its batch-mates down with it.

    Every invocation also logs one `invocation_cost` line (see _log_invocation_cost).
    """
    cpu_start, wall_start = time.process_time(), time.perf_counter()
    try:
        return _process_records(event.get('Records') or [])
    finally:
        _log_invocation_cost(context, cpu_start, wall_start)


def _process_records(records: list) -> dict:
    """Each record on its own: one bad record must not fail the batch (see lambda_handler)."""
    for record in records:
        try:
            _process_record(record)
        except Exception:
            logger.exception('Unhandled error processing S3 record')
    return {'processed': len(records)}


# ── CPU measurement (stdlib mirror of shared/invocation_cost.py) ─────────────
# Every Lambda logs one `invocation_cost` line so the sizing policy's CPU rule
# (docs/lambda-sizing.md) is measurable from Logs Insights. This function cannot
# import shared/ (module docstring), so the two helpers below re-state
# `shared.invocation_cost.memory_mb` / `invocation_cost_fields`;
# test/test_invocation_cost_lockstep.py pins them to the originals.
_COST_LINE = 'invocation_cost'
_MB_PER_VCPU = 1769


def _memory_mb(context: object) -> int | None:
    raw = str(getattr(context, 'memory_limit_in_mb', 0))
    value = int(raw) if raw.isdigit() else 0
    return value or None


def _invocation_cost_fields(memory: int | None, cpu_ms: float, wall_ms: float) -> dict[str, float | int]:
    fields = {'cpu_ms': round(cpu_ms, 1), 'wall_ms': round(wall_ms, 1)}
    if memory is not None:
        fields['function_memory_size'] = memory
        if wall_ms > 0:
            fields['cpu_pct_of_allocation'] = round(cpu_ms / (wall_ms * memory / _MB_PER_VCPU) * 100, 1)
    return fields


def _log_invocation_cost(context: object, cpu_start: float, wall_start: float) -> None:
    """Numbers only — never the event or a document."""
    cpu_ms = (time.process_time() - cpu_start) * 1000
    wall_ms = (time.perf_counter() - wall_start) * 1000
    logger.info(_COST_LINE, extra=_invocation_cost_fields(_memory_mb(context), cpu_ms, wall_ms))
