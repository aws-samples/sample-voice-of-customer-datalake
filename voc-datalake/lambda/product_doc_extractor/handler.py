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

    The cost of that isolation is this file re-implements three small things that
    exist in `shared/`: model resolution (see _resolve_model_id, which mirrors
    `shared/model_config.py::get_active_model_id` exactly), the reserved-word
    aliasing in the status writes (pattern from `shared/jobs.py`), and structured
    JSON logging with per-record context (see JsonFormatter — powertools' output
    shape and `append_keys` behaviour, in a stdlib Formatter subclass). All three
    are pinned by tests.

    WHAT THE ISOLATION DOES NOT COST is structured logs. Emitting plain text
    because powertools is unavailable would be a non-sequitur: the JSON shape is
    a formatter, not a library.

WHY NO NEW PIP DEPENDENCY
    Image dimensions are read from the file header with `struct` (see
    _sniff_format / _dimensions_from_head), so no Pillow. `imghdr` is NOT an
    option either — it was removed from the standard library in Python 3.13 and
    this function runs on python3.14.
"""
import json
import logging
import os
import re
import struct
from urllib.parse import unquote_plus

import boto3

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
#: otherwise start appearing in the JSON as if it were an extra. `message` and
#: `asctime` are added by Formatter.format and are not present on a fresh record.
_RECORD_ATTRS = frozenset(
    logging.LogRecord('', 0, '', 0, '', (), None).__dict__
) | {'asctime', 'message'}


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
    name = (os.environ.get('LOG_LEVEL') or '').strip().upper()
    return logging.getLevelNamesMapping().get(name, logging.INFO)


#: True inside Lambda. A reserved runtime variable, always present there and
#: never elsewhere, which is the only thing that reliably distinguishes "the
#: handler on the root logger is the runtime's" from "it belongs to whatever is
#: hosting this import". See _configure_logging for why that distinction decides
#: a behaviour rather than a comment.
IN_LAMBDA = bool(os.environ.get('AWS_LAMBDA_FUNCTION_NAME'))


def _configure_logging(target: logging.Logger, *, replace_existing: bool) -> None:
    """Attach a JSON handler to `target`, WITHOUT a second copy of every line.

    THE DUPLICATE: the Lambda runtime pre-installs its own handler on the root
    logger, which emits plain text. Adding ours beside it logs every line twice —
    and a doubled line reads like a retry, not like a formatting mistake, so it
    misleads exactly the person reading the log during a diagnosis. Inside Lambda
    the runtime's handler is therefore detached first.

    WHY THAT IS CONDITIONAL, rather than "take over whatever handler is already
    there": handlers we did not create are not ours to reformat. Setting this
    formatter on the host's handler was tried, and outside Lambda the host is
    pytest — whose capture handler populates `record.message` as a side effect of
    its own formatter, so six unrelated tests started failing with
    AttributeError, and only when the suites ran in one process. Nothing outside
    Lambda pre-installs a plain-text handler on our behalf anyway, so there is no
    duplicate to prevent there and nothing to justify the intrusion.
    """
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    if replace_existing:
        for existing in list(target.handlers):
            target.removeHandler(existing)
    target.addHandler(handler)
    target.setLevel(_log_level())


logger = logging.getLogger()
_configure_logging(logger, replace_existing=IN_LAMBDA)

RAW_DATA_BUCKET = os.environ.get('RAW_DATA_BUCKET', '')
PROJECTS_TABLE = os.environ.get('PROJECTS_TABLE', '')
AGGREGATES_TABLE = os.environ.get('AGGREGATES_TABLE', '')

# Model resolution inputs, all injected by core-stack.ts. MODEL_ALLOWLIST is
# rendered from ALLOWED_MODEL_IDS in lib/utils/model-allowlist.ts at synth time,
# so there is no second copy of the allowlist to rot.
DEFAULT_MODEL_ID = os.environ.get('DEFAULT_MODEL_ID', '')
MODEL_SETTINGS_PK = 'SETTINGS#model'
MODEL_SETTINGS_SK = 'config'
MODEL_SURFACE = 'documents'

# Only product-doc uploads. Anything else under the notification's `projects/`
# prefix is ignored — including this function's OWN output, which lands at
# `projects/{id}/product_docs/extracted/...` and would otherwise re-trigger the
# Lambda in a loop. That is why the guard is not the redundant check it looks
# like: the stack wires ONE broad prefix rule, and this pattern is what makes
# that safe.
RAW_KEY_PATTERN = re.compile(
    r'^projects/(?P<project_id>[^/]+)/product_docs/raw/(?P<doc_id>[^/.]+)\.(?P<ext>[^/.]+)$'
)

DOC_SK_PREFIX = 'PRODUCT_DOC#'

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
CONVERSE_IMAGE_FORMATS = {
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


def _bedrock():
    if 'bedrock' not in _clients:
        _clients['bedrock'] = boto3.client('bedrock-runtime')
    return _clients['bedrock']


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


def _resolve_model_id() -> str:
    """The model id for the `documents` surface. Never raises.

    Same precedence as shared/model_config.py::get_active_model_id:
    per-surface override > legacy global override > built-in default. Any
    failure — no table configured, no item, a read error — resolves to
    DEFAULT_MODEL_ID, because a model lookup is not allowed to break extraction.

    No per-container cache, unlike shared/: this function handles one document
    per invocation rather than a hot inference loop, so a single get_item costs
    nothing worth caching, and a fresh read means a model just changed in
    Settings applies to the very next upload.
    """
    settings: dict = {}
    if AGGREGATES_TABLE:
        try:
            item = _table(AGGREGATES_TABLE).get_item(
                Key={'pk': MODEL_SETTINGS_PK, 'sk': MODEL_SETTINGS_SK}
            ).get('Item')
            if isinstance(item, dict):
                settings = item
        except Exception as e:  # noqa: BLE001 - model lookup must never break extraction
            logger.warning(f'Model settings lookup failed; using default: {e}')

    allowed = _allowlist()
    surfaces = settings.get('surfaces')
    if isinstance(surfaces, dict):
        per_surface = _allowlisted(surfaces.get(MODEL_SURFACE), allowed)
        if per_surface:
            return per_surface
    legacy_global = _allowlisted(settings.get('model_id'), allowed)
    if legacy_global:
        return legacy_global
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
        # SOF0..SOF15, excluding DHT (C4), JPG (C8) and DAC (CC).
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
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

def _get_doc(project_id: str, doc_id: str) -> dict | None:
    """The product-doc record, or None when it is gone.

    The user can delete a document while its extraction is in flight, so a
    missing record is an ordinary outcome, not an error.
    """
    try:
        return _table(PROJECTS_TABLE).get_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': f'{DOC_SK_PREFIX}{doc_id}'}
        ).get('Item')
    except Exception as e:  # noqa: BLE001 - a lost record must not raise
        logger.warning(f'Could not read product doc {doc_id}: {e}')
        return None


def _is_conditional_check_failure(error: Exception) -> bool:
    """True for DynamoDB's ConditionalCheckFailedException, however it arrives.

    The error CODE in the response is the dependable signal — boto3's resource
    layer raises a dynamically-built ClientError subclass, so its type name is a
    botocore implementation detail. The type name is checked as well because a
    test double raises the named exception with no response payload.
    """
    response = getattr(error, 'response', None)
    code = (response.get('Error') or {}).get('Code') if isinstance(response, dict) else None
    return (code == 'ConditionalCheckFailedException'
            or type(error).__name__ == 'ConditionalCheckFailedException')


def _log_refused_write(project_id: str, doc_id: str, values: dict) -> None:
    """Say WHICH of the three causes refused the write. They mean different things.

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
    current = _get_doc(project_id, doc_id)
    if current is None:
        logger.info(f'Product doc {doc_id} was deleted mid-extraction; write skipped')
        return
    status = current.get('status')
    if status in TERMINAL_STATUSES:
        logger.warning(
            f'Product doc {doc_id} is already {status}; refusing to overwrite '
            f'{sorted(values)} onto it - the API already gave this document up as '
            f'stalled and told the user to upload it again'
        )
        return
    # Deliberately shares no vocabulary with the line above: an operator greps for
    # the stall wording, so a malformed record must not match that grep, not even
    # inside a denial.
    logger.warning(
        f'Product doc {doc_id} has no usable status ({status!r}); refusing to '
        f'overwrite {sorted(values)} onto it - the record is malformed or predates '
        f'the status field, so no read path put it in this state'
    )


def _update_doc(project_id: str, doc_id: str, values: dict) -> None:
    """Write `values` onto the record, but ONLY while it is still non-terminal.

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
    status_placeholders = [f':s{i}' for i in range(len(NON_TERMINAL_STATUSES))]
    try:
        _table(PROJECTS_TABLE).update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': f'{DOC_SK_PREFIX}{doc_id}'},
            UpdateExpression=expression,
            ConditionExpression=(
                'attribute_exists(pk) AND #doc_status IN '
                f'({", ".join(status_placeholders)})'
            ),
            ExpressionAttributeNames={**names, '#doc_status': 'status'},
            ExpressionAttributeValues={
                **vals,
                **dict(zip(status_placeholders, NON_TERMINAL_STATUSES)),
            },
        )
    except Exception as e:  # noqa: BLE001 - a bookkeeping write must not fail the batch
        if _is_conditional_check_failure(e):
            _log_refused_write(project_id, doc_id, values)
        else:
            logger.warning(f'Could not update product doc {doc_id}: {e}')


def _mark_extracting(project_id: str, doc_id: str) -> None:
    """Publish the in-flight state, once, before the slow work starts.

    `extracting` was declared in three places and written in none: the UI renders
    a distinct "Extracting…" badge for it (ProductDocsUpload.tsx), ProductDocStatus
    lists it, and product_context.py's STALLABLE_STATUSES includes it — so its
    stall branch could never be reached either. One extra update_item per
    document makes all three mean something, and lets the user tell "still
    uploading" from "being analysed", which for an image is a Bedrock call long
    enough to be worth distinguishing.

    Best-effort by construction: _update_doc swallows its failures, so a lost
    badge write cannot abort the extraction that follows. `pending` is stallable
    too, so a document whose badge never landed is not stranded either.
    """
    _update_doc(project_id, doc_id, {'status': 'extracting'})


def _mark_failed(project_id: str, doc_id: str, message: str) -> None:
    """Terminal failure with a short, user-facing reason.

    `message` is shown in the UI, so it never carries a stack trace, an AWS
    error string or an S3 key — callers pass a sentence, not an exception.
    """
    logger.info(f'Product doc {doc_id} failed: {message}')
    _update_doc(project_id, doc_id, {'status': 'failed', 'error': message})


def _mark_ready(project_id: str, doc_id: str, extracted_key: str, chars: int) -> None:
    _update_doc(project_id, doc_id, {
        'status': 'ready',
        'error': None,
        's3_extracted_key': extracted_key,
        'extracted_chars': chars,
    })


def _extracted_key(project_id: str, doc_id: str) -> str:
    return f'projects/{project_id}/product_docs/extracted/{doc_id}.txt'


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
    raw = os.environ.get(name, '')
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
    if declared != detected:
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
    blocks = response.get('output', {}).get('message', {}).get('content', []) or []
    text = '\n'.join(b['text'] for b in blocks if isinstance(b, dict) and b.get('text'))
    return text, text.encode('utf-8')


# ── Per-record processing ───────────────────────────────────────────────────

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

    match = RAW_KEY_PATTERN.match(key)
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
        _extract_document(project_id, doc_id, bucket, key, obj)
    finally:
        # LOAD-BEARING, not tidiness. A batch loops records (see lambda_handler),
        # so a context left in place would attribute the NEXT document's lines —
        # and lambda_handler's own unhandled-error line — to this doc_id. A field
        # that names the wrong document is worse than no field: it sends the
        # person reading it to the wrong record.
        _log_context.clear()


def _extract_document(project_id: str, doc_id: str, bucket: str, key: str, obj: dict) -> None:
    """Extract ONE registered product document. Split from _process_record so that
    the log context above is set and cleared around the whole of it."""
    doc = _get_doc(project_id, doc_id)
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

    # Before the S3 reads and the Bedrock call, not after: the whole value of the
    # state is that it is visible WHILE the slow part runs.
    _mark_extracting(project_id, doc_id)

    content_type = str(doc.get('content_type') or '')
    try:
        if content_type in TEXT_CONTENT_TYPES:
            text, payload = _extract_text(bucket, key)
        elif content_type in CONVERSE_IMAGE_FORMATS:
            actual_size = int(obj.get('size') or 0)
            text, payload = _extract_image(bucket, key, content_type, actual_size)
        else:
            raise _ExtractionError('This file type cannot be processed.')
    except _ExtractionError as e:
        _mark_failed(project_id, doc_id, str(e))
        return
    except Exception:
        # Every failure is a terminal `failed`: Bedrock throttling, S3 errors,
        # decode failures. The user gets a sentence; the traceback goes to the log
        # only (logger.exception already attaches it).
        logger.exception(f'Extraction failed for {doc_id}')
        _mark_failed(project_id, doc_id, 'Text extraction failed. Please try uploading again.')
        return

    # An empty or whitespace-only extraction is a FAILURE, never `ready`.
    # build_product_context_block injects the extracted text of every `ready`
    # doc into PRD/PR-FAQ prompts, so a `ready` record with nothing in it
    # contributes nothing while claiming to be usable — the same lie, by another
    # route, that this rung exists to remove.
    if not text.strip():
        _mark_failed(project_id, doc_id, 'No text could be extracted from this file.')
        return

    extracted_key = _extracted_key(project_id, doc_id)
    _s3().put_object(
        Bucket=bucket,
        Key=extracted_key,
        Body=payload,
        ContentType='text/plain; charset=utf-8',
    )
    _mark_ready(project_id, doc_id, extracted_key, len(text))
    logger.info(f'Product doc {doc_id} ready ({len(text)} chars)')


def lambda_handler(event, _context=None):
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
    """
    records = event.get('Records') or []
    for record in records:
        try:
            _process_record(record)
        except Exception:
            # One bad record must not fail the batch (see the docstring above).
            logger.exception('Unhandled error processing S3 record')
    return {'processed': len(records)}
