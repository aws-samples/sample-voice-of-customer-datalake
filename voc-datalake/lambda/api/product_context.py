"""
Product/service description input — per-project context that feeds PRD/PR-FAQ generation.

Two pieces (the AI assistant fills the context through its
`update_product_context` approval card, which calls `update_context`):
  1. ProductContext  — single mutable record per project (structured fields + free-form notes),
                       with `field_meta.{field} = {by, sub, at}`: who last wrote each field
                       (7.104.00; `person` for a person and the assistant's approval card, which
                       runs with the person's own token; `assistant` for an MCP client, an agent
                       or a plan step). Read and written through shared/product_proposals.py
                       (`context_state`, `write_context`): one reader, one writer, one rule of a
                       value a person typed.
  2. ProductDoc      — the product sources (shared/product_sources.py, 7.104.00): uploads, links and
                       interview answers. WHAT IS PROCESSED WHERE: images (png/jpeg/gif/webp) and
                       text (.md/.txt) by the S3-triggered extractor at
                       lambda/product_doc_extractor/ (ALLOWED_CONTENT_TYPES); PDF, DOCX and PPTX
                       (SOURCE_CONTENT_TYPES) and links on the projects API's assist twin
                       (shared/product_source_worker.py); answers are saved ready.

`build_product_context_block(project_id) -> str` is consumed by
lambda/jobs/document_generator/handler.py (PRD / PR-FAQ generation) and
projects.autofill_prfaq_questions, and substituted into the {product_context} placeholder.
"""
from __future__ import annotations

import os
import string
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from shared.delete_audit import record_delete
from shared.deleted_sources import DeletedSource, mark_citing_documents
from shared.derivation import DERIVATION_FIELD, build_derivation
from shared.exceptions import (
    ConfigurationError,
    NotFoundError,
    ServiceError,
    ValidationError,
)
from shared.image_limits import IMAGE_CONTENT_TYPE_EXTENSIONS, MAX_IMAGE_BYTES
from shared.logging import logger, tracer
from shared.product_fields import ALL_FIELDS, CURRENT_STATE, FIELD_LABELS, STRING_FIELDS, clean_patch_value
from shared.product_proposals import Actor, context_state, forget_source, write_context
from shared.product_sources import (
    MAX_SOURCE_FILE_BYTES,
    SOURCE_CONTENT_TYPES,
    TWIN_STALL_SECONDS,
    UNTRUSTED_DOC_BEGIN,
    UNTRUSTED_DOC_END,
    UNTRUSTED_DOC_NOTICE,
    checksum_header,
    doc_view,
    fenced,
    heading_name,
    list_sources,
    new_doc_id,
    product_doc_extracted_key,
    product_doc_raw_key,
    product_doc_source_key,
    put_source,
    read_on_twin,
)
from shared.project_keys import PRODUCT_DOC_SK_PREFIX as DOC_SK_PREFIX
from shared.project_keys import document_keys, project_pk
from shared.project_writes import create_counted_project_child
from shared.prompt_safety import data_block
from shared.s3_versions import delete_every_version_of_keys
from shared.tables import get_projects_table
from shared.timestamps import now_iso
from shared.ws_repo import WorkspaceScope

projects_table = get_projects_table()
s3 = None


def _s3():
    """
    Lazy S3 client. Forces SigV4 + the bucket's actual region:
    KMS-encrypted buckets reject SigV2 presigned URLs with HTTP 400
    ("Requests specifying Server Side Encryption with AWS KMS managed keys
    require AWS Signature Version 4."), and boto3's default signature in some
    legacy paths is SigV2. Specifying region_name also avoids the path-style
    redirect that breaks browser PUTs.
    """
    global s3
    if s3 is None:
        import boto3
        from botocore.config import Config
        s3 = boto3.client(
            's3',
            region_name=os.environ.get('AWS_REGION', 'us-east-1'),
            config=Config(signature_version='s3v4'),
        )
    return s3


# ── Schema ────────────────────────────────────────────────────────────────────

# The product context's row (``PRODUCT_CONTEXT_SK``) and the product documents' records, ``DOC_SK_PREFIX``, are spelled
# in shared/project_keys.py, which the workspace export reads them by too; the context's one reader and writer is
# shared/product_proposals.py. Its fields, their caps and
# labels (``STRING_FIELDS``, ``ALL_FIELDS``, ``FIELD_LABELS``, ``clean_patch_value``) are spelled in
# shared/product_fields.py (imported above), which shared code reads them by too.

# ── Upload limits ────────────────────────────────────────────────────────────
# Kept in lockstep with the frontend and with the Converse image caps by
# lambda/shared/test/test_image_limits_lockstep.py.

# General cap, applied to text uploads. Mirrored in
# frontend/src/pages/ProjectDetail/productSourceUpload.ts. A PDF, DOCX or PPTX takes
# MAX_SOURCE_FILE_BYTES (25 MB, shared/product_sources.py), an image MAX_IMAGE_BYTES.
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_EXTRACTED_INJECTION_CHARS = 50_000
# A project's cap of 20 sources, every kind together, is shared/product_sources.py's (MAX_DOCS_PER_PROJECT).

# ── How many visuals one prototype build may name ────────────────────────────
# Enforced at the API boundary (projects_handler.`_validated_product_doc_ids`, which
# imports this) and mirrored in the frontend picker, kept in step by
# lambda/api/test/test_visual_selection_bound_lockstep.py.
#
# Small, and NOT for read cost. The prototype prompt drives ONE set of eight `:root`
# CSS custom properties, and every selected visual contributes a concrete palette for
# those same eight slots — so several mockups with different palettes are
# contradictory instructions rather than more grounding. Four describes one product's
# screens and keeps a coherent palette the likely reading.
#
# Lives HERE, beside the budget it bounds, rather than in projects_handler: the total
# budget below is DERIVED from it, and the two disagreeing is the one failure this
# feature can have that no test would notice (see MAX_VISUAL_BRIEF_TOTAL_CHARS).
MAX_SELECTED_PRODUCT_DOC_IDS = 4

# ── Visual-brief budget (build_visual_brief_block) ───────────────────────────
# Two caps, because neither bounds the section on its own — the same pair, and the
# same reason, as RESEARCH_PER_DOC_CAP / RESEARCH_TOTAL_CAP in
# lambda/jobs/document_generator/handler.py.
#
# Per visual. An image's extracted text is a DESCRIPTION, not a file body: the
# extractor asks for a palette, a component inventory and a layout mode, capped at
# MAX_DESCRIPTION_TOKENS (4096) — so a maximal one is ~16k characters and a typical
# one is a small fraction of that. 3000 is deliberately the figure a reference spec
# document already gets in the prototype prompt (RESEARCH_PER_DOC_CAP, and the
# reference-document slice `_gather_context` applies): a visual is allowed to be as
# loud as one spec document and no louder. It binds only on a description that ran
# long, and what it cuts is the tail — the palette and layout lines the prompt acts
# on come first.
MAX_VISUAL_BRIEF_DOC_CHARS = 3_000
# Across all selected visuals, and DERIVED rather than chosen — this is the fix for a
# real defect, not a tidy-up.
#
# An independent number here can silently contradict the arity bound: at 4 ids x 3000
# chars a hardcoded 9000 refused the FOURTH visual outright (the refusal is
# all-or-nothing, so it is dropped whole), while the picker had offered four and its
# limit note said four. The derivation stayed honest — it records what was used — but
# the UI's promise did not, and nothing anywhere said so. Deriving it means the budget
# can never refuse a selection the boundary accepted, and raising the bound cannot
# reintroduce the gap.
#
# It is still a real bound on the section, because the arity bound is small: 12,000
# characters, the same figure RESEARCH_TOTAL_CAP allows, in a prompt that also carries
# a PRD, a PR/FAQ, research and (on a revision) 24,000 characters of prior HTML.
MAX_VISUAL_BRIEF_TOTAL_CHARS = MAX_SELECTED_PRODUCT_DOC_IDS * MAX_VISUAL_BRIEF_DOC_CHARS

# Text formats we can extract with nothing more than a decode.
TEXT_CONTENT_TYPES = {
    'text/markdown': 'md',
    'text/plain': 'txt',
}

# Image content types are single-sourced from shared.image_limits, which also
# carries the byte/pixel caps the Converse API imposes on them.
IMAGE_CONTENT_TYPES = frozenset(IMAGE_CONTENT_TYPE_EXTENSIONS)

# The uploads the S3-triggered extractor reads (lambda/product_doc_extractor/handler.py,
# its TEXT_CONTENT_TYPES and CONVERSE_IMAGE_FORMATS), each keyed under product_docs/raw/
# by its extension (product_doc_raw_key). A PDF, DOCX or PPTX (SOURCE_CONTENT_TYPES,
# shared/product_sources.py, 7.104.00) is keyed under product_docs/source/ instead and read
# on the assist twin; the boundary accepts the two together (UPLOAD_CONTENT_TYPES) and
# refuses everything else rather than store what nothing would process.
ALLOWED_CONTENT_TYPES = {**IMAGE_CONTENT_TYPE_EXTENSIONS, **TEXT_CONTENT_TYPES}
UPLOAD_CONTENT_TYPES = {**ALLOWED_CONTENT_TYPES, **SOURCE_CONTENT_TYPES}

# Derived so a new accepted type cannot leave the user-facing list stale.
_ACCEPTED_EXTENSIONS_LABEL = ', '.join(
    '.' + ext for ext in sorted(set(UPLOAD_CONTENT_TYPES.values()))
)

# EVERY status a product-doc record may hold — the canonical vocabulary, and the
# one place to add to. `pending` is written here at upload; `extracting`, `ready`
# and `failed` are written by lambda/product_doc_extractor/handler.py, which
# partitions this same set into its NON_TERMINAL_STATUSES / TERMINAL_STATUSES and
# logs a refused write differently for each. A status added here and nowhere else
# would be reported by that handler as a malformed record, so the partition is
# pinned against this tuple by
# lambda/product_doc_extractor/test/test_status_lockstep.py. Mirrored in
# frontend/src/api/types.ts as ProductDocStatus.
PRODUCT_DOC_STATUSES = ('pending', 'extracting', 'ready', 'failed')

# A pending/extracting record older than this is treated as never-extracted and
# transitioned to failed on read. See _fail_if_stalled. A source read on the twin
# waits TWIN_STALL_SECONDS (960, shared/product_sources.py) instead.
EXTRACTION_STALL_SECONDS = 300
STALLABLE_STATUSES = ('pending', 'extracting')

# An image uploaded in a workspace is refused here, before its record is written (3h-S3b, 7.106.00): its description
# reads the model picks (SETTINGS#model), which are not the workspace's yet (3f), and the S3 extractor would only mark
# it failed with this same text (product_doc_extractor/handler.py WORKSPACE_IMAGE_MESSAGE, the stdlib-only Lambda's
# own copy; lambda/api/test/test_product_routes_workspace.py holds the two together). Lifted when the picks move.
WORKSPACE_IMAGE_MESSAGE = "Images can't be described in a workspace yet. Upload the design as a .md or .txt file."

# ── Prompt-injection fence for uploaded-document text ────────────────────────
# The extraction prompt asks the model to reproduce every visible label VERBATIM,
# and that text then flows into PRD / PR-FAQ / prototype prompts. A file whose
# contents read "ignore your instructions and ..." is therefore an
# instruction-shaped string arriving from outside the platform — the textbook
# untrusted-input boundary, and the one place in this path where "validate at the
# boundary" applies to prose rather than to bytes.
#
# The fence (UNTRUSTED_DOC_BEGIN / UNTRUSTED_DOC_END / UNTRUSTED_DOC_NOTICE, the body
# through `fenced`, a source's name through `heading_name`) is spelled in
# shared/product_sources.py since 7.104.00, so an extract's prompt fences a source the
# same way this block does.

def _validate_patch(patch: object) -> dict:
    """
    Validate + truncate a partial product-context update.
    Unknown keys are dropped silently (the LLM sometimes invents fields).
    Over-length strings are truncated.
    """
    if not isinstance(patch, dict):
        raise ValidationError('patch must be an object')

    clean: dict = {}
    for key, value in patch.items():
        if key not in ALL_FIELDS:
            continue
        cleaned = clean_patch_value(key, value)
        if cleaned is not None:
            clean[key] = cleaned
    return clean


# ── ProductContext CRUD ──────────────────────────────────────────────────────

@tracer.capture_method
def get_context(project_id: str, *, workspace: WorkspaceScope | None) -> dict:
    """``{context}``: each of the 12 fields as text ('' when unset; a list stored under the old schema joined by
    lines) and, once the row exists, its ``updated_at`` (shared/product_proposals.py ``context_state``, read
    strongly), in ``workspace`` (None: the deployment). ``field_meta`` is the Product tab's own read (GET
    …/product-proposals/latest)."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    state = context_state(projects_table, project_id, workspace=workspace)
    out: dict[str, object] = dict(state.values)
    if state.exists:
        out['updated_at'] = state.updated_at
    return {'context': out}


@tracer.capture_method
def update_context(project_id: str, body: object, *, actor: Actor, workspace: WorkspaceScope | None) -> dict:
    """Apply a validated patch to the product context, creating the record on its first PUT: ``{context}``, and
    ``conflicts`` beside it when some fields were not written.

    ``body`` is the request body as parsed, unchecked: `_validate_patch` refuses a non-object with its own 'patch
    must be an object'. ``actor`` is the caller (shared/product_proposal_routes.py ``writer_of``: who, and whether an
    autonomous caller whose way of working lets the AI write the product description). The write is
    shared/product_proposals.py ``write_context``: an accept of the values just read, each field recorded in
    ``field_meta`` as the caller's; an MCP client, an agent or a plan step never replaces a value a person typed
    (``person_value`` conflicts, the rest written; 409 ``conflict`` when every field is one). In ``workspace`` (None:
    the deployment), the request's scope.
    """
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    conflicts = write_context(projects_table, project_id, _validate_patch(body or {}), actor, workspace=workspace)
    out = get_context(project_id, workspace=workspace)
    if conflicts:
        out['conflicts'] = conflicts
    return out


# ── ProductDoc — uploads, listing, deletion ──────────────────────────────────


def _human_mb(byte_count: int) -> str:
    """Render a byte cap for a user-facing message. Truncates, never rounds up.

    A raw `3750000` in an error is not an improvement over no message at all. And
    the truncation matters: rounding 3,750,000 to "3.6 MB" would advertise a
    ceiling 24 KB above the real one, so a file just under the advertised figure
    would still be refused — the error would be lying about the limit it names.
    """
    tenths = (byte_count * 10) // (1024 * 1024)
    return f'{tenths // 10}.{tenths % 10} MB'


#: The largest per-type cap, the bound of every declared size (``_declared_size``).
_LARGEST_CAP = max(MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_SOURCE_FILE_BYTES)


def _declared_size(value: object) -> int | None:
    """The client's declared byte count, or None when it is not usable as one.

    A bare ``int(value or 0)`` is not safe on a JSON body: a string, an object, an
    array or a NaN each reach this from a hand-rolled client and raise
    TypeError / ValueError / OverflowError, which surfaces as a 500 for what is
    plainly a bad request. That mattered less when the number was advisory; it is
    now signed into the presigned PUT as ContentLength, so it is part of a
    security control and has to be validated like one.

    Which is also why the value has to be INTEGRAL, not merely convertible:
    ``int(1000.7)`` truncates to 1000, so a client sending a fractional size gets
    ContentLength 1000 signed into the URL and then PUTs 1001 bytes, which S3
    refuses with a signature/length error the caller cannot act on. A byte count
    that is not a whole number of bytes is a bad request, and it is answered here.

    Every unusable shape returns None rather than 0 so the caller's single size
    check answers with exactly the same ValidationError it gives any other
    unusable size — a caller does not need to learn a second vocabulary for "that
    is not a size", and a new message would be a new string to translate.

    ``Decimal`` cannot reach here today — the only caller passes a value straight
    off a JSON body, and json.loads produces int/float, never Decimal. It is
    handled anyway, and at no cost, because the parse below stays in the decimal
    domain: `Decimal('1E+3')` is as integral as `1000`. Worth having for free in a
    module that also reads DynamoDB items, where every number IS a Decimal.
    """
    # bool is a subclass of int, so `int(True)` is 1 and a JSON `true` would
    # otherwise be accepted as a one-byte file. A boolean is not a size.
    if isinstance(value, bool):
        return None
    try:
        # Via str() and Decimal, not float(): exact for a numeric string, and it
        # keeps '1000' working (a client that sent one has always worked) while
        # '1000.7' stays refused.
        number = Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None
    # NaN and ±Infinity are finite-check failures, not parse failures — Decimal
    # accepts both strings happily.
    if not number.is_finite() or number != number.to_integral_value():
        return None
    # RESOURCE-EXHAUSTION GUARD, and the whole point is that it happens HERE, in
    # the DECIMAL domain, before int(). `'1E+999999999'` is 12 bytes of request
    # body that parses fine, is finite, and IS integral — so it passes every check
    # above, and `int()` then materialises an integer of a billion digits (~415 MB)
    # inside the request path. The cost is not linear either: measured on this
    # runtime, int(Decimal('1E+1000000')) already takes ~30s, so a billion digits
    # is a Lambda timeout, not a blip.
    #
    # THE TRAP: bounding after the conversion would be no guard at all, because the
    # conversion IS the cost — the caller's `max_bytes` check runs too late for the
    # same reason. Decimal comparison reads the exponent and coefficient instead of
    # expanding them, so the same value is refused in microseconds. That also
    # covers a long numeric string (`'9' * 10_000_000`), whose parse is linear and
    # cheap but whose int() is not.
    #
    # The range is the widest one any caller can accept — MAX_SOURCE_FILE_BYTES (a
    # PDF's, DOCX's or PPTX's 25 MB) is the largest of the caps, 1 byte the smallest
    # usable size — so nothing the boundary would have accepted is refused here, and
    # everything refused here gets the boundary's own unchanged ValidationError. A
    # negative bound is not decoration: `-1E+999999999` is below every cap, so an
    # upper bound alone would still hand it to int().
    if number < 1 or number > _LARGEST_CAP:
        return None
    return int(number)


def _list_doc_items(project_id: str, *, workspace: WorkspaceScope | None) -> list[dict]:
    """The project's source rows in ``workspace``, read strongly (shared/product_sources.py ``list_sources``, their
    one reader)."""
    if not projects_table:
        return []
    return list_sources(projects_table, project_id, workspace=workspace)


def _age_seconds(created_at) -> float | None:
    """Seconds since an ISO-8601 `created_at`, or None if it cannot be read.

    Defensive on purpose: the value is written by
    `now_iso()`, but a missing or malformed one must
    NOT be treated as old. Failing safe means leaving the record alone — marking a
    document failed because its timestamp was unparseable would be a new lie in
    place of the one this transition removes.
    """
    if not isinstance(created_at, str) or not created_at:
        return None
    try:
        parsed = datetime.fromisoformat(created_at)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return (datetime.now(UTC) - parsed).total_seconds()


#: What a stalled source's ``error`` says: an upload the S3 extractor never finished, and a source the twin never
#: finished (a link, a PDF, DOCX or PPTX: Retry reads it again).
STALLED_MESSAGE = 'Text extraction did not complete. Please delete this document and upload it again.'
STALLED_ON_TWIN_MESSAGE = 'Reading this source did not complete. Try it again, or delete it and add it again.'


def _stall_window(item: dict) -> tuple[object, int, str]:
    """When a record's wait started, how long it may last and what its failure says. The S3 path waits
    EXTRACTION_STALL_SECONDS from ``created_at``; the twin path TWIN_STALL_SECONDS from ``claimed_at`` (a read under
    way) or ``created_at`` (an upload never announced)."""
    if read_on_twin(item):
        return item.get('claimed_at') or item.get('created_at'), TWIN_STALL_SECONDS, STALLED_ON_TWIN_MESSAGE
    return item.get('created_at'), EXTRACTION_STALL_SECONDS, STALLED_MESSAGE


def _fail_if_stalled(project_id: str, item: dict, *, workspace: WorkspaceScope | None) -> dict:
    """Transition a never-extracted document to `failed`, on read.

    WHY ON READ rather than a scheduled sweep: nothing else can do it. The client
    polls for a bounded time and then stops, so it can never write `failed` itself;
    without this a record whose extraction never ran stays `pending` forever and the
    badge reads "Extracting…" for the life of the record.

    WHY A REAL update_item and not a DTO-level substitution: reporting `failed`
    while the stored record still says `pending` is the same class of lie this
    rung exists to remove — the next reader through a different path would see the
    old value. The transition has to persist.

    The write is CONDITIONAL on the status still being the pending/extracting one
    we read (and, for a read on the twin, on its claim's token), so a race with the
    extractor or the twin finishing, or a retry claiming the source again, cannot
    clobber a genuine result with our guess.

    EXTRACTION_STALL_SECONDS (300) must comfortably exceed the extractor Lambda's
    own timeout (120s), and TWIN_STALL_SECONDS (960) the twin's (900s) — a healthy
    read always completes inside its window. Raising either Lambda's timeout past
    its window would start marking successful reads as failed, so they move together.

    The record is ``workspace``'s (None: the deployment's), the one the listing read.
    """
    status = item.get('status')
    if status not in STALLABLE_STATUSES:
        return item

    started, window, message = _stall_window(item)
    age = _age_seconds(started)
    if age is None or age <= window:
        return item

    doc_id = item.get('doc_id')
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    # `status` and `error` are both DynamoDB reserved words — same aliasing pattern as
    # shared/jobs.py::update_job_status.
    names = {'#status': 'status', '#error': 'error'}
    values = {':failed': 'failed', ':error': message, ':expected': status}
    condition = '#status = :expected'
    token = item.get('extract_token')
    if isinstance(token, str) and token:
        names['#token'] = 'extract_token'
        values[':token'] = token
        condition += ' AND #token = :token'
    try:
        projects_table.update_item(
            Key={'pk': project_pk(project_id, workspace=workspace), 'sk': f'{DOC_SK_PREFIX}{doc_id}'},
            UpdateExpression='SET #status = :failed, #error = :error',
            ConditionExpression=condition,
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
    except Exception as e:  # noqa: BLE001 - a read must never fail on this
        # Includes ConditionalCheckFailedException, which is the benign case: the
        # extractor got there first, so the stored record is already correct and
        # the caller should see it unchanged. Anything else is logged and ignored
        # for the same reason — listing documents is not allowed to break because
        # a bookkeeping write did.
        logger.warning(f'Stalled-doc transition skipped for {doc_id}: {e}')
        return item

    return {**item, 'status': 'failed', 'error': message}


def _is_injectable(doc: dict) -> bool:
    """Whether ONE document's extracted text may be put into a prompt.

    Split out of _injectable_docs so that build_product_context_block can apply
    the same predicate to a list it was HANDED as well as to one it read itself.
    Without that, a caller passing an unfiltered list would inject the very image
    descriptions the filter below exists to keep out — the parameter would fail
    open, and it would do so silently.
    """
    return bool(
        doc.get('status') == 'ready'
        and doc.get('s3_extracted_key')
        and doc.get('content_type') not in IMAGE_CONTENT_TYPES
    )


def _injectable_docs(project_id: str, *, workspace: WorkspaceScope | None) -> list[dict]:
    """Ready documents whose extracted text may be put into a prompt.

    IMAGES ARE EXCLUDED, deliberately and temporarily. Rung 1 already wired
    product context into the prototype builder, so without this filter an
    uploaded screenshot's description would reach every product-context-ticked
    prototype build on its own: mixed into `### Internal documents`, ordered by
    `created_at`, sharing one character budget with real documents, and nowhere
    near the eight CSS custom properties the prototype prompt actually acts on.
    That is an un-asked-for behavioural change to every existing project,
    delivered by an upload feature.

    Rung 3 owns explicit per-build selection and a dedicated visual-brief
    placement. Until then an image's description is extracted, stored, listed and
    readable — it is simply not injected, which is what makes rung 3 purely
    additive rather than a correction.

    Shared with generate_report on purpose: its "is there anything to summarize"
    gate and this injection must agree, or the report would refuse to run over
    content it would have used, or run over content it cannot see. Agreeing on the
    PREDICATE is not enough — that gate reads this list ONCE and hands it to
    build_product_context_block, so the two also agree on the DATA.
    """
    return [d for d in _list_doc_items(project_id, workspace=workspace) if _is_injectable(d)]


@tracer.capture_method
def list_docs(project_id: str, *, workspace: WorkspaceScope | None) -> dict:
    """GET …/product-docs: the project's sources in ``workspace`` (None: the deployment), the newest first, a stalled
    read failed on the way (``_fail_if_stalled``)."""
    items = _list_doc_items(project_id, workspace=workspace)
    items.sort(key=lambda i: i.get('created_at', ''), reverse=True)
    return {'docs': [doc_view(_fail_if_stalled(project_id, i, workspace=workspace)) for i in items]}


def _body_text(body: dict | None, key: str) -> str:
    """A stripped string field of the upload body, or '' when absent or not a string.

    A list or object here would otherwise raise on `.strip()` (or, unhashable, on the
    content-type membership tests) and surface as a 500; '' meets the ordinary
    "filename is required" / "Unsupported file type" refusals instead.
    """
    value = (body or {}).get(key)
    return value.strip() if isinstance(value, str) else ''


# A source's object keys (product_doc_raw_key, product_doc_source_key, product_doc_extracted_key) are spelled in
# shared/product_sources.py since 7.104.00 (imported above), which the twin's reading and the saved answers use too.


def _declared_sha256(body: dict | None, *, required: bool) -> str | None:
    """The upload's declared SHA-256 (hex, any case, as the Documents Library takes it), which S3 holds a twin-read
    file's PUT to (signed as its ``ChecksumSHA256``) and its reading checks again: required for a PDF, DOCX or PPTX
    (``required``), else ignored (None); a 400 when it is missing or not one."""
    if not required:
        return None
    value = (body or {}).get('sha256')
    sha = value.lower() if isinstance(value, str) else ''
    if len(sha) != 64 or not set(sha) <= set(string.hexdigits.lower()):
        raise ValidationError('sha256 must be 64 hexadecimal characters', code='sha256_required')
    return sha


def _type_cap(content_type: str) -> tuple[int, str]:
    """Per-type cap: images are bound by what the Bedrock Converse API will accept in a message, which is well under
    the general file cap; a PDF, DOCX or PPTX by the twin's 25 MB. One cap for everything would needlessly refuse
    large documents we handle fine."""
    if content_type in IMAGE_CONTENT_TYPES:
        return MAX_IMAGE_BYTES, 'Images'
    if content_type in SOURCE_CONTENT_TYPES:
        return MAX_SOURCE_FILE_BYTES, 'PDF, Word and PowerPoint files'
    return MAX_FILE_BYTES, 'Files'


@tracer.capture_method
def create_upload_url(project_id: str, body: dict, *, actor: Mapping[str, str] | None = None,
                      workspace: WorkspaceScope | None) -> dict:
    """
    Validate caps and content type, create a pending DDB record, return a presigned PUT URL.
    The frontend uploads the file directly to S3. A Markdown, text or image upload goes under
    product_docs/raw/, which triggers the extractor lambda; a PDF, DOCX or PPTX under
    product_docs/source/, which the frontend then announces (POST …/{doc}/uploaded) for the
    assist twin to read. ``actor`` (shared/delete_audit.py ``actor_from_event``) is recorded
    as the source's ``created_by``. In ``workspace`` (None: the deployment) the record is the workspace's and its key
    takes ``ws/{ws}/``; an image is refused there (400 ``image_in_workspace``, ``WORKSPACE_IMAGE_MESSAGE``).
    """
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    bucket = os.environ.get('RAW_DATA_BUCKET')
    if not bucket:
        raise ConfigurationError('RAW_DATA_BUCKET not configured')

    filename = _body_text(body, 'filename')
    content_type = _body_text(body, 'content_type')
    size_bytes = _declared_size((body or {}).get('size_bytes'))

    # INVARIANT (tested): every rejection below happens BEFORE the put_item, so a
    # refused upload leaves no record behind. A record written and then abandoned
    # is what produced the permanently-"Extracting…" rows this rung removes.
    if not filename:
        raise ValidationError('filename is required')
    if content_type not in UPLOAD_CONTENT_TYPES:
        raise ValidationError(
            f'Unsupported file type. Accepted: {_ACCEPTED_EXTENSIONS_LABEL}.'
        )

    if workspace is not None and content_type in IMAGE_CONTENT_TYPES:
        raise ValidationError(WORKSPACE_IMAGE_MESSAGE, code='image_in_workspace')

    max_bytes, kind = _type_cap(content_type)
    # `_declared_size` answers None or a size of at least 1 byte, so the lower
    # bound needs no second check here.
    if size_bytes is None or size_bytes > max_bytes:
        raise ValidationError(
            f'{kind} must be between 1 byte and {_human_mb(max_bytes)}.'
        )
    on_twin = content_type in SOURCE_CONTENT_TYPES
    sha256 = _declared_sha256(body, required=on_twin)

    doc_id = new_doc_id()
    ext = UPLOAD_CONTENT_TYPES[content_type]
    s3_raw_key = (product_doc_source_key(project_id, doc_id, ext, workspace=workspace) if on_twin
                  else product_doc_raw_key(project_id, doc_id, ext, workspace=workspace))
    now = now_iso()

    item = {
        'pk': project_pk(project_id, workspace=workspace),
        'sk': f'{DOC_SK_PREFIX}{doc_id}',
        'doc_id': doc_id,
        'filename': filename[:255],
        'content_type': content_type,
        'size_bytes': size_bytes,
        's3_raw_key': s3_raw_key,
        's3_extracted_key': None,
        'status': 'pending',
        'error': None,
        'extracted_chars': 0,
        'created_at': now,
        'source_kind': 'file',
    }
    if sha256:
        item['sha256'] = sha256
    if actor:
        item['created_by'] = dict(actor)
    # Within the project's caps (shared/product_sources.py ``put_source``): 400 too_many_sources.
    put_source(projects_table, project_id, item, workspace=workspace)

    params: dict[str, Any] = {
        'Bucket': bucket,
        'Key': s3_raw_key,
        'ContentType': content_type,
        # ContentLength is what makes the size cap above real, and it is not
        # redundant with it. `size_bytes` is a number the CLIENT declares in
        # the JSON body; without it signed into the URL, S3 enforces nothing,
        # so a client could declare 1 byte and then PUT ten gigabytes. Signing
        # it turns the declaration into a commitment: S3 rejects a body whose
        # length differs from what was signed.
        'ContentLength': size_bytes,
    }
    headers = {'Content-Type': content_type}
    if sha256:
        # The same for a twin-read file's content: its declared SHA-256 signed as the PUT's checksum, so S3 itself
        # refuses a body that is not the file declared (the reading checks it again).
        params['ChecksumSHA256'] = headers['x-amz-checksum-sha256'] = checksum_header(sha256)
    presigned = _s3().generate_presigned_url(ClientMethod='put_object', Params=params, ExpiresIn=600)
    # Content-Length is deliberately NOT in `headers`: it is a forbidden header
    # name for fetch/XHR, so the browser refuses to let JS set it and derives it
    # from the body instead. A PUT of the same file the client measured therefore
    # satisfies the signature; a PUT of anything else fails, which is the point.
    return {
        'doc_id': doc_id,
        'presigned_url': presigned,
        'headers': headers,
    }


@tracer.capture_method
def delete_doc(project_id: str, doc_id: str, *, actor: Mapping[str, str] | None = None,
               workspace: WorkspaceScope | None) -> dict:
    """Delete a product doc: the row, then its raw and extracted objects (every version).

    The extracted text is reached by its derivable key too (``product_doc_extracted_key``), since the row names it
    only once the extraction is ready: a document deleted mid-extraction left its text behind before 7.38.00. The
    row goes first, so an extraction that puts its text after this sweep finds the row gone when it marks it ready,
    and deletes that text itself (product_doc_extractor/handler.py ``_delete_own_output``); one that put it before
    is swept here. A failed object delete is logged, as before; the row is deleted either way.

    The delete is recorded (``shared.delete_audit``), a document that used it as a
    visual says so (``shared.deleted_sources``), and every product proposal that cited it
    loses those citations, the words they quoted from it (``forget_source``).

    In ``workspace`` (None: the deployment) every row and object is the workspace's (its keys under ``WS#{ws}#`` and
    ``ws/{ws}/``), and the delete's ``AUDIT#delete`` row names it (its target's ``workspace``).
    """
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    bucket = os.environ.get('RAW_DATA_BUCKET')

    resp = projects_table.get_item(
        Key={'pk': project_pk(project_id, workspace=workspace), 'sk': f'{DOC_SK_PREFIX}{doc_id}'}
    )
    item = resp.get('Item')
    if not item:
        raise NotFoundError('document not found')

    projects_table.delete_item(
        Key={'pk': project_pk(project_id, workspace=workspace), 'sk': f'{DOC_SK_PREFIX}{doc_id}'}
    )

    if bucket:
        stored = (item.get('s3_raw_key'), item.get('s3_extracted_key'))
        keys = [key for key in (*stored, product_doc_extracted_key(project_id, doc_id, workspace=workspace))
                if isinstance(key, str) and key]
        try:
            refused = delete_every_version_of_keys(_s3(), bucket, keys)
        except (ClientError, BotoCoreError) as e:
            logger.warning(f'Failed to delete the objects of product doc {doc_id}: {e}')
        else:
            if refused:
                logger.warning(f'{refused} object version(s) of product doc {doc_id} could not be deleted')
    target = {'project_id': project_id, 'doc_id': doc_id}
    if workspace is not None:
        # ``workspace``, not the messages' ``workspace_id``: an audit target names its scope, it routes nothing.
        target['workspace'] = workspace.ws
    record_delete(projects_table, kind='product_doc', target=target, actor=actor)
    mark_citing_documents(projects_table, project_id, [DeletedSource('product_doc', doc_id)], deleted_at=now_iso(),
                          workspace=workspace)
    # Its words quoted in the project's product proposals go with it (shared/product_proposals.py forget_source).
    forget_source(projects_table, project_id, doc_id, workspace=workspace)
    return {'success': True}


# ── PRD/PR-FAQ injection helper ──────────────────────────────────────────────

def _product_context_included(has_any: object, docs: list[dict] | None) -> bool:
    """Whether a product report's context block actually carries anything.

    The two arguments are exactly what generate_report built the block from, read
    once each — so this answers from the data, not from an argument about the
    data. `docs=None` is "not read", which only happens when `has_any` already
    settled it.

    ITS FALSE CASE IS UNREACHABLE through generate_report: the gate raises before
    a report exists. That is the point rather than a reason to drop it. A literal
    `True` would be a claim nothing verifies, in the one field whose whole job is
    to record what a document was built from, and it would silently become wrong
    the day the gate is relaxed or reordered. Tested directly for that reason —
    see test_product_report_single_read.py.
    """
    return bool(has_any or docs)


@tracer.capture_method
def generate_report(project_id: str, body: dict) -> dict:
    """
    Synthesize the structured product context + uploaded internal docs into a polished
    'Product/Service Description' report and persist it as a ProjectDocument that shows
    up in the Documents tab. The report is what other generators (PRD, PR/FAQ) implicitly
    reference, but having it as a saved doc lets the user read, edit, share, and export it.
    """
    from shared.converse import converse

    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    response_language = (body or {}).get('response_language')
    title_override = ((body or {}).get('title') or '').strip()

    # The deployment's project: the report is a document-generator job, refused in a workspace (3h-S8).
    ctx = get_context(project_id, workspace=None)['context']
    has_any = any(ctx.get(k) for k in STRING_FIELDS) or ctx.get(CURRENT_STATE)
    # ONE read of the document list, handed to BOTH the gate below and the block
    # that follows. Reading it twice was a time-of-check/time-of-use race: the
    # predicate agreed with itself, but the DATA did not have to. A document
    # deleted between the two reads passed the gate and was then absent from the
    # block, so the report was synthesized from the
    # "(No product context provided.)" placeholder — and recorded as having had
    # product context, because the derivation below asserted it.
    #
    # None means NOT READ, and that is the honest value here rather than an empty
    # list: filled fields answer the gate on their own, so no read is needed, and
    # `docs=None` tells build_product_context_block to read for itself exactly as
    # it does for every other caller. Passing `[]` would instead tell it this
    # project HAS no documents and silently drop them from the block.
    #
    # The short-circuit is kept for the same reason it was there — the query only
    # runs when the fields are empty — and it is also where the race lived: `and`
    # short-circuits, so the second read only ever happened on this path, which is
    # exactly the project whose documents are its only content. A project with
    # fields is one query either way; a documents-only project used to be two.
    docs = None if has_any else _injectable_docs(project_id, workspace=None)
    # No fields and no injectable documents? then there is nothing to summarize.
    if not has_any and not docs:
        raise ValidationError(
            'Add at least one product context field or upload an internal document before generating a report.'
        )

    context_block = build_product_context_block(project_id, docs=docs)

    from shared.prompts import get_response_language_instruction
    language_instruction = get_response_language_instruction(response_language)

    system_prompt = (
        "You are a senior product manager writing a clear, concise Product/Service "
        "Description report. The report describes the CURRENT state of the product — "
        "not future features or aspirations. Use the structured input verbatim where "
        "possible; do not invent details that aren't in the input.\n\n"
        + (language_instruction or "")
    ).strip()

    user_prompt = (
        "Write a Product/Service Description report in well-structured Markdown using the input below.\n\n"
        "Required sections (omit a section only if the input has nothing for it):\n"
        "1. **Product overview** — name, one-liner, current state\n"
        "2. **Target users**\n"
        "3. **Problem it solves**\n"
        "4. **Key features**\n"
        "5. **Differentiators**\n"
        "6. **Known limitations**\n"
        "7. **Non-goals**\n"
        "8. **Success metrics**\n"
        "9. **Additional notes** (anything from internal documents that adds context)\n\n"
        "Keep the tone factual and specific. Don't include sections like \"future roadmap\" "
        "or \"go-to-market\" — those belong in PRD/PR-FAQ, not here.\n\n"
        f"INPUT:\n{context_block}"
    )

    try:
        content = converse(
            prompt=user_prompt,
            system_prompt=system_prompt,
            max_tokens=4000,
            temperature=0.2,
            surface='documents',
            step_name='product_report',
        )
    except Exception as e:
        logger.exception(f"Product report generation failed: {e}")
        raise ServiceError('Failed to generate report. Please try again.') from e

    now_dt = datetime.now(UTC)
    now = now_dt.isoformat()
    product_name = ctx.get('product_name') or 'Product'
    title = title_override or f"Product description: {product_name[:80]}"

    def build(report_id: str) -> dict:
        return {
            **document_keys(project_id, f'PRODUCT_REPORT#{report_id}', now, workspace=None),
            'document_id': report_id,
            'document_type': 'product_report',
            'title': title,
            'content': content,
            # This report is synthesized from the project's product-context block
            # (structured fields + extracted internal documents) and nothing else —
            # no project documents, no feedback, no personas. Recording that is what
            # keeps it from reading as "built from nothing".
            #
            # DERIVED from the two inputs the block was actually built from, not
            # asserted as True. The gate above does make the False case unreachable,
            # so a literal would be correct today — and would still be a claim this
            # code does not check, in the one field whose entire job is to say what a
            # document was built from.
            DERIVATION_FIELD: build_derivation(
                product_context_included=_product_context_included(has_any, docs),
            ),
            'created_at': now,
        }

    item = create_counted_project_child(
        projects_table, project_id, 'product_report', build, now=now_dt, workspace=None,
    )
    return {'success': True, 'document': item}


def build_product_context_block(project_id: str, docs: list[dict] | None = None) -> str:
    """
    Build the {product_context} string that is injected into the PRD/PR-FAQ chains.
    Combines the structured context with the extracted text of READY uploaded docs,
    truncated to MAX_EXTRACTED_INJECTION_CHARS total.

    Two things the extracted half is NOT: unfiltered (images are excluded until
    rung 3 selects them deliberately — see _injectable_docs) and undelimited
    (each body is fenced as untrusted quoted content — see UNTRUSTED_DOC_BEGIN).

    `docs` is an ALREADY-READ document list, for a caller that has one and must
    build the block from the same list it inspected rather than from a second
    read of the table — generate_report is the only such caller, and the race it
    closes is described there. Omitted, the list is read here exactly as before,
    so every other caller (projects.py, jobs/document_generator) is unchanged.
    `_is_injectable` is applied either way: a handed-in list is filtered too, so
    the parameter cannot become a back door for the image descriptions rung 3
    owns.

    The deployment's project only: its callers are the jobs and assists (jobs/document_generator, projects.py's
    assists), each refused in a workspace until 3h-S8 threads them and their scope with it.
    """
    ctx_resp = get_context(project_id, workspace=None)
    ctx = ctx_resp['context']

    sections: list[str] = []

    structured_lines: list[str] = []
    for key, label in FIELD_LABELS:
        v = ctx.get(key)
        if not v:
            continue
        if isinstance(v, str) and '\n' in v:
            structured_lines.append(f"**{label}**:\n{v}")
        else:
            structured_lines.append(f"**{label}**: {v}")

    if structured_lines:
        # A DATA block (shared/prompt_safety.py): the fields are a person's or an accepted extract's text, so they
        # reach the PRD, PR/FAQ and prototype prompts as data, never as prompt lines of their own.
        sections.append("### Structured product context\n"
                        + data_block('product_context', '\n\n'.join(structured_lines)))

    bucket = os.environ.get('RAW_DATA_BUCKET')
    if bucket:
        ready = (
            _injectable_docs(project_id, workspace=None) if docs is None
            else [d for d in docs if _is_injectable(d)]
        )
        ready.sort(key=lambda d: d.get('created_at', ''))
        budget = MAX_EXTRACTED_INJECTION_CHARS
        doc_blocks: list[str] = []
        skipped: list[str] = []
        for d in ready:
            if budget <= 0:
                # Outside every fence: one neutralised line, as each heading is (shared/product_sources.py).
                skipped.append(heading_name(d.get('filename')))
                continue
            try:
                obj = _s3().get_object(Bucket=bucket, Key=d['s3_extracted_key'])
                text = obj['Body'].read().decode('utf-8', errors='replace')
            except (ClientError, BotoCoreError) as e:
                logger.warning(f'Failed reading extracted text for {d.get("doc_id")}: {e}')
                continue
            chunk = text[:budget]
            budget -= len(chunk)
            # The budget counts document CHARACTERS. The fence and the filename
            # heading are ours, so they are not charged to it — the point of the
            # budget is bounding how much user content reaches the prompt.
            doc_blocks.append(
                f"#### {heading_name(d.get('filename'))}\n"
                f'{UNTRUSTED_DOC_BEGIN}\n{fenced(chunk)}\n{UNTRUSTED_DOC_END}'
            )
        if doc_blocks:
            sections.append(
                "### Internal documents\n" + UNTRUSTED_DOC_NOTICE + '\n\n'
                + '\n\n'.join(doc_blocks)
            )
        if skipped:
            sections.append(
                "### Additional documents (not included due to size budget)\n- "
                + '\n- '.join(skipped)
            )

    if not sections:
        return "(No product context provided.)"
    return '\n\n'.join(sections)


# ── Visual brief — the SELECTED image documents, for the prototype prompt ─────

def build_visual_brief_block(
    project_id: str, doc_ids: Iterable[object] | None,
) -> tuple[str, list[str]]:
    """The quoted descriptions of the image documents a build SELECTED.

    Returns `(block, used_doc_ids)`: the assembled text (or `''` when nothing
    usable was found) and the ids whose text actually reached that text, in the
    order they appear in it.

    `used_doc_ids` IS THE PROVENANCE RECORD, so it lists what was USED, never what
    was requested — the convention `lambda/shared/derivation.py` documents for
    `sources`. Everything that drops an id (unknown, not an image, not ready,
    unreadable, empty, or refused by the total budget) therefore drops it from this
    list too, so a caller recording it cannot claim a visual the model never saw.

    THIS IS NOT `_injectable_docs`, AND THE TWO MUST NOT BE MERGED. That predicate
    excludes images on purpose (see its docstring); this one accepts nothing else.
    A selected TEXT document is ignored here precisely because it already reaches
    the prompt through `build_product_context_block` — including it in both would
    spend the budget twice for one document and say the same thing in two voices.

    ORDER FOLLOWS `doc_ids`, NOT `created_at`. The caller's order is meaningful:
    the consuming prompt tells the model that where two visuals disagree the first
    one wins, so re-sorting here would silently re-rank the user's choice. Wording
    that precedence is the consumer's job; this function only guarantees the order.

    Args:
        project_id: the project whose documents may be selected.
        doc_ids: the selected `doc_id`s, in precedence order. Any iterable; ids
            that are not non-empty strings, and ids that name nothing in this
            project, are ignored rather than raising — the value arrives from a
            request body, and one bad element must not fail a build.

    NEVER RAISES. An S3 read that fails, or extracted text that is empty or
    whitespace, skips that one visual and continues, logged as a warning exactly as
    the surrounding code does. Nothing on this path is worth failing a build for.
    """
    bucket = os.environ.get('RAW_DATA_BUCKET')
    requested = [d for d in (doc_ids or []) if isinstance(d, str) and d]
    if not bucket or not requested:
        return '', []

    # Keyed by doc_id so the loop below can follow the CALLER's order. Filtered
    # first, so an id naming a text document is as absent as an id naming nothing —
    # one skip path, not two.
    eligible = {
        d.get('doc_id'): d
        # The deployment's project: a prototype build is a document-generator job, refused in a workspace (3h-S8).
        for d in _list_doc_items(project_id, workspace=None)
        if d.get('status') == 'ready'
        and d.get('s3_extracted_key')
        and d.get('content_type') in IMAGE_CONTENT_TYPES
    }

    budget = MAX_VISUAL_BRIEF_TOTAL_CHARS
    blocks: list[str] = []
    used: list[str] = []
    for doc_id in requested:
        doc = eligible.get(doc_id)
        # `doc_id in used` de-duplicates: a repeated id would otherwise be fenced
        # twice, charged twice, and reported twice as its own provenance.
        if doc is None or doc_id in used:
            continue
        try:
            obj = _s3().get_object(Bucket=bucket, Key=doc['s3_extracted_key'])
            text = obj['Body'].read().decode('utf-8', errors='replace')
        except Exception as e:  # noqa: BLE001 - one unreadable visual is not a build failure
            logger.warning(f'Failed reading extracted text for visual {doc_id}: {e}')
            continue

        chunk = text.strip()[:MAX_VISUAL_BRIEF_DOC_CHARS]
        # Spent front-to-back, and ALL-OR-NOTHING per visual: a description that
        # does not fit is skipped whole rather than fenced half-written, because
        # half a palette listing is not a smaller version of the instruction — it is
        # a different one. Front-to-back is safe here in a way it is not in
        # `_research_section` (which shares the budget equally): there, every named
        # report is recorded as used regardless, so dropping the tail made the
        # record a lie. Here the record follows the text, so a skip is honest.
        #
        # `continue`, not `break`: a later small visual still fits after an
        # oversized one was refused, and the ids that do get in keep the caller's
        # relative order either way.
        if not chunk or len(chunk) > budget:
            continue
        budget -= len(chunk)
        # The budget counts the DOCUMENT's characters; the heading and the fence are
        # ours, so they are not charged to it — same accounting as
        # build_product_context_block. `fenced` only ever shrinks the body (the
        # marker is longer than its replacement), so sanitising after the slice
        # cannot push a visual back over its cap.
        blocks.append(
            f"#### {heading_name(doc.get('filename'))}\n"
            f'{UNTRUSTED_DOC_BEGIN}\n{fenced(chunk)}\n{UNTRUSTED_DOC_END}'
        )
        used.append(doc_id)

    if not blocks:
        return '', []

    block = (
        '### Visual references (uploaded images)\n'
        + UNTRUSTED_DOC_NOTICE + '\n\n'
        + '\n\n'.join(blocks)
    )
    return block, used
