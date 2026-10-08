"""
Pydantic schemas for processing-queue message validation.

These schemas validate every message on the feedback processing queue before
the processor enriches it. This acts as a security boundary between untrusted
producer output (plugins, the public feedback-form submit, manual imports) and
trusted processing.

WHY THIS LIVES IN ``lambda/shared`` (issue #249): the processor's deployed
bundle is ``processor/*`` + ``shared/`` (processing-stack-consolidated.ts). It
used to live in ``plugins/_shared/schemas.py``, which no processor bundle
contains, so the import failed in every deployed function and validation was
silently off. That module is gone (no re-export shim): every producer test and
the processor import ``shared.ingest_schemas``, the one source of truth.

THE CONTRACT IS THE PRODUCERS (issues #412, #249). ``IngestMessage`` forbids
unknown fields, so every field a real producer sends must be declared here —
and every VALUE shape a producer legitimately sends must be accepted, or
switching validation on rejects (and dead-letters) a whole source. Each
producer's shape is pinned by a test in ``plugins/_shared/test/test_schemas.py``
(``TestProducerShapes``). Adding a field to a producer means adding it here.
"""

import re
import unicodedata
from datetime import UTC, datetime, timedelta

from pydantic import BaseModel, Field, TypeAdapter, ValidationError, field_validator, model_validator

# Imports nothing else from shared/, so the processor bundle's import graph stays the same.
from shared.dimension_config import validate_tags

# ============================================
# Constants
# ============================================

MAX_TEXT_LENGTH = 50_000  # 50KB max for feedback text
MAX_ID_LENGTH = 256
# The public feedback-form submit bounds `page_url` (sent as `url`) at 4096
# (feedback_form_handler.MAX_PAGE_URL_CHARS), so the schema must admit that much.
MAX_URL_LENGTH = 4096
MAX_INGESTION_METHOD_LENGTH = 64
# Feedback-form submissions use `form_<form_id>` and a form id may be 64
# characters (feedback_form_handler.FORM_ID_MAX_LENGTH), i.e. up to 69.
MAX_SOURCE_CHANNEL_LENGTH = 128
# Display names, not just slugs: app-review ingestors send `<app name>_iOS` /
# `<app name>_Android`, s3_import sends `S3 - <folder>`, the webscraper sends the
# scraper's name (or the page's netloc). See the producer tests.
MAX_SOURCE_PLATFORM_LENGTH = 256
MAX_CATEGORY_LENGTH = 128
MAX_METADATA_VALUE_LENGTH = 1000
# Feedback-form custom field answers (feedback_form_handler.MAX_CUSTOM_FIELDS etc.).
MAX_CUSTOM_FIELDS = 20
MAX_CUSTOM_FIELD_KEY_LENGTH = 64
# The numeric feedback-form rating renders buttons 1..10 whatever `rating_max`
# says (static/feedback-widget.js), so ratings above 5 are real submissions.
MAX_RATING = 10
# Producer-supplied dimensions (shared.dimension_config bounds the configured ones the same way).
MAX_MESSAGE_DIMENSIONS = 10
MAX_DIMENSION_KEY_LENGTH = 32
MAX_DIMENSION_VALUE_LENGTH = 64

_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _strip_control_chars(value: str) -> str:
    return _CONTROL_CHARS.sub("", value).strip()


# Unicode categories removed from `source_platform`: Cc (every control, incl.
# tab/newline and C1) and Cf (format: zero-width space/joiners, BOM, bidi
# overrides) — invisible characters that would make two keys look identical.
_INVISIBLE_CATEGORIES = frozenset({"Cc", "Cf"})
# The DynamoDB key separator: `SOURCE#a#b` must not be spellable from a platform.
_KEY_SEPARATOR = "#"


def _normalized_source_platform(value: str) -> str:
    """NFKC-normalise, drop Cc/Cf characters, trim; refuse the key separator, a blank or an over-long result.

    NFKC first, so a compatibility form of '#' (fullwidth U+FF03, small U+FE5F)
    is caught by the separator check rather than slipping past it. The length is
    re-checked because NFKC can expand a character (U+FDFA becomes 18).
    """
    normalized = unicodedata.normalize("NFKC", value)
    visible = "".join(ch for ch in normalized if unicodedata.category(ch) not in _INVISIBLE_CATEGORIES).strip()
    if not visible:
        raise ValueError("must not be blank")
    if _KEY_SEPARATOR in visible:
        raise ValueError(f"must not contain '{_KEY_SEPARATOR}'")
    if len(visible) > MAX_SOURCE_PLATFORM_LENGTH:
        raise ValueError(f"must be at most {MAX_SOURCE_PLATFORM_LENGTH} characters once normalised")
    return visible


_DATETIME_ADAPTER = TypeAdapter(datetime)


def _parses_as_datetime(value: object) -> bool:
    """Whether pydantic would accept ``value`` for a ``datetime`` field (None and blank strings included: it refuses both)."""
    try:
        _DATETIME_ADAPTER.validate_python(value)
    except ValidationError:
        return False
    return True


# ============================================
# Exceptions
# ============================================

class MessageValidationError(Exception):
    """Raised when message validation fails."""
    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__(f"Validation failed: {', '.join(errors)}")


# ============================================
# Metadata Schema
# ============================================

# Keys whose values are declared, typed containers below and are therefore
# exempt from the flat-primitive rule.
_STRUCTURED_METADATA_KEYS = frozenset({"custom_fields"})


def _primitive_value_error(key: str, value: object) -> str | None:
    """Why ``value`` is not an acceptable flat metadata value, or None if it is."""
    if value is None or isinstance(value, bool | int | float):
        return None
    if isinstance(value, str):
        if len(value) > MAX_METADATA_VALUE_LENGTH:
            return f"metadata value for '{key}' exceeds max length"
        return None
    return f"metadata value for '{key}' must be primitive (string, number, boolean, null)"


class MessageMetadata(BaseModel):
    """
    Flat metadata with primitive values only.
    No nested objects allowed for security — except the declared, bounded
    ``custom_fields`` mapping the public feedback form sends.
    """
    model_config = {"extra": "allow"}  # Allow additional fields

    # Common metadata fields
    is_verified: bool | None = None
    location_id: str | None = Field(None, max_length=64)
    reference_id: str | None = Field(None, max_length=64)
    reply_count: int | None = Field(None, ge=0)
    like_count: int | None = Field(None, ge=0)
    business_id: str | None = Field(None, max_length=128)
    business_name: str | None = Field(None, max_length=256)
    author_image: str | None = Field(None, max_length=512)
    # Feedback-form answers to the form's custom questions: a small mapping of
    # short keys to scalars, already bounded by the submit route.
    custom_fields: dict[str, str | int | float | bool | None] | None = Field(
        None, max_length=MAX_CUSTOM_FIELDS,
    )

    # Validators take `cls` without `@classmethod`: pydantic wraps a `cls`-first
    # validator in `classmethod` itself (ensure_classmethod_based_on_signature),
    # so the decorator was a no-op the type checker did not need either.
    @model_validator(mode="before")
    def validate_all_values_primitive(cls, values):
        """Ensure all values are primitives (no nested objects)."""
        if not isinstance(values, dict):
            return values

        errors = []
        for key, value in values.items():
            # Check key format
            if not isinstance(key, str):
                errors.append(f"metadata key must be string, got {type(key)}")
                continue
            if len(key) > 64:
                errors.append(f"metadata key '{key[:20]}...' exceeds max length")
            if key in _STRUCTURED_METADATA_KEYS:
                continue  # typed and bounded by its field declaration
            error = _primitive_value_error(key, value)
            if error:
                errors.append(error)

        if errors:
            raise ValueError("; ".join(errors))

        return values

    @field_validator("custom_fields")
    def bound_custom_fields(cls, v: dict | None) -> dict | None:
        if v is None:
            return v
        for key, value in v.items():
            if not key or len(key) > MAX_CUSTOM_FIELD_KEY_LENGTH:
                raise ValueError(f"custom_fields keys must be 1-{MAX_CUSTOM_FIELD_KEY_LENGTH} characters")
            if isinstance(value, str) and len(value) > MAX_METADATA_VALUE_LENGTH:
                raise ValueError(f"custom_fields value for '{key[:20]}' exceeds max length")
        return v


# ============================================
# Issue-tracker attributes
# ============================================

MAX_ISSUE_LABELS = 30
MAX_LINKED_PRS = 50


class IssueAttributes(BaseModel):
    """Structured fields a software issue tracker adds to a feedback item.

    A closed, typed model rather than free-form ``metadata``: the metrics API
    groups and filters on these (per-version and per-label trends), so their
    shapes are a contract, and ``metadata`` refuses lists by design. Every value
    is computed deterministically by the plugin (no model call), so duplicates of
    one bug share ``error_signature`` / ``component`` and cluster.
    """
    model_config = {"extra": "forbid"}

    kind: str = Field(..., pattern=r"^(issue|comment)$")
    repo: str = Field(..., min_length=3, max_length=140, pattern=r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
    number: int = Field(..., ge=1)
    parent_id: str | None = Field(None, max_length=MAX_ID_LENGTH)
    state: str | None = Field(None, max_length=16)
    state_reason: str | None = Field(None, max_length=32)
    labels: list[str] = Field(default_factory=list, max_length=MAX_ISSUE_LABELS)
    plus_one: int = Field(0, ge=0)
    reactions_total: int = Field(0, ge=0)
    author_association: str | None = Field(None, max_length=32)
    milestone: str | None = Field(None, max_length=256)
    linked_prs: list[int] = Field(default_factory=list, max_length=MAX_LINKED_PRS)
    comment_count: int = Field(0, ge=0)
    updated_at: str | None = Field(None, max_length=40)
    software_version: str | None = Field(None, max_length=64)
    version_source: str | None = Field(None, pattern=r"^(form|label|body)$")
    component: str | None = Field(None, max_length=100)
    error_signature: str | None = Field(None, max_length=200)
    has_repro: bool = False

    @field_validator("labels")
    def bound_labels(cls, v: list[str]) -> list[str]:
        if any(len(label) > 100 for label in v):
            raise ValueError("a label exceeds 100 characters")
        return v


# ============================================
# Message Schema
# ============================================

class IngestMessage(BaseModel):
    """Schema for messages sent to processing queue."""
    model_config = {"extra": "forbid"}  # Reject unknown fields

    # Required fields
    id: str = Field(..., min_length=1, max_length=MAX_ID_LENGTH)
    source_platform: str = Field(..., min_length=1, max_length=MAX_SOURCE_PLATFORM_LENGTH)
    text: str = Field(..., min_length=1, max_length=MAX_TEXT_LENGTH)
    created_at: datetime

    # Optional fields
    # The identifier the source's own export carried, when `id` had to be
    # derived instead (a CSV `id` column is unique only within its file, so it
    # cannot key the item — see CSV_ROW_ID_FIELDS in manual_import_handler).
    csv_row_id: str | None = Field(None, max_length=MAX_ID_LENGTH)
    rating: float | None = Field(None, ge=1, le=MAX_RATING)
    url: str | None = Field(None, max_length=MAX_URL_LENGTH)
    source_url: str | None = Field(None, max_length=MAX_URL_LENGTH)
    source_channel: str | None = Field(None, max_length=MAX_SOURCE_CHANNEL_LENGTH)
    channel: str | None = Field(None, max_length=MAX_SOURCE_CHANNEL_LENGTH)  # Alias for source_channel
    # Manual-import provenance (manual_import_handler: confirm / csv / json paths).
    ingestion_method: str | None = Field(None, max_length=MAX_INGESTION_METHOD_LENGTH)
    source_origin: str | None = Field(None, max_length=MAX_ID_LENGTH)
    manual_import_job_id: str | None = Field(None, max_length=MAX_ID_LENGTH)
    # Feedback-form category routing, read by shared/categorization.run_enrichment.
    # The form sends '' when no category is preset.
    preset_category: str | None = Field(None, max_length=MAX_CATEGORY_LENGTH)
    preset_subcategory: str | None = Field(None, max_length=MAX_CATEGORY_LENGTH)
    author: str | None = Field(None, max_length=256)
    title: str | None = Field(None, max_length=500)
    language: str | None = Field(None, pattern=r"^[a-z]{2}(-[A-Z]{2})?$")
    brand_name: str | None = Field(None, max_length=256)
    brand_handles_matched: list[str] | None = Field(None, max_length=10)
    metadata: MessageMetadata | None = None
    issue_attributes: IssueAttributes | None = None
    # Dimensions and tags the producer already knows (a CSV column, a form's
    # embed option, a scraper's defaults). The processor keeps only what the
    # dimensions config admits (shared.dimension_config.resolve_dimensions).
    dimensions: dict[str, str] | None = Field(None, max_length=MAX_MESSAGE_DIMENSIONS)
    tags: list[str] | None = None
    # The source policy ingestion applied before archiving/queueing (shared.source_profiles).
    pii_policy_applied: str | None = Field(None, pattern=r"^(allow|redact|summary_only)$")

    # Internal fields (set by platform)
    ingested_at: datetime | None = None
    s3_raw_uri: str | None = Field(None, max_length=512)
    raw_data: dict | None = None
    is_webhook: bool | None = None
    is_update: bool | None = None
    is_deleted: bool | None = None

    @field_validator(
        "id", "csv_row_id", "source_platform", "source_channel", "channel",
        "ingestion_method", "source_origin", "manual_import_job_id",
        "preset_category", "preset_subcategory", "author", "title",
    )
    def sanitize_string(cls, v: str | None) -> str | None:
        if v is None:
            return v
        # Remove control characters
        return _strip_control_chars(v)

    @field_validator("id", "source_platform")
    def require_non_blank(cls, v: str) -> str:
        # Runs after sanitize_string: an id or platform made only of whitespace
        # and control characters would otherwise pass min_length and then key
        # the item (or the `SOURCE#` partition) on an empty string.
        if not v:
            raise ValueError("must not be blank")
        return v

    @field_validator("source_platform")
    def normalize_source_platform(cls, v: str) -> str:
        # Runs after the two above. Free text (a display name) that becomes part
        # of DynamoDB keys — `SOURCE#…`, `METRIC#daily_source#…`, `LOGS#…#…` —
        # and the `{source_platform}:{id}` idempotency key, so one spelling must
        # mean one key: see _normalized_source_platform.
        return _normalized_source_platform(v)

    @field_validator("text")
    def sanitize_text(cls, v: str) -> str:
        # Remove control characters except newlines/tabs
        v = _CONTROL_CHARS.sub("", v)
        # Normalize excessive newlines
        v = re.sub(r"\n{3,}", "\n\n", v)
        return v.strip()

    @field_validator("url", "source_url")
    def validate_url(cls, v: str | None) -> str | None:
        if v is None or v == "":
            return None
        if not v.startswith(("http://", "https://")):
            raise ValueError("URL must start with http:// or https://")
        return v

    @field_validator("dimensions")
    def sanitize_dimensions(cls, v: dict[str, str] | None) -> dict[str, str] | None:
        """Control characters stripped from keys and values; an entry with a blank value (an empty CSV cell) dropped."""
        if v is None:
            return v
        cleaned: dict[str, str] = {}
        for raw_key, raw_value in v.items():
            key, value = _strip_control_chars(raw_key), _strip_control_chars(raw_value)
            if not key or len(key) > MAX_DIMENSION_KEY_LENGTH:
                raise ValueError(f"dimension keys must be 1-{MAX_DIMENSION_KEY_LENGTH} characters")
            if len(value) > MAX_DIMENSION_VALUE_LENGTH:
                raise ValueError(f"dimension value for '{key}' exceeds {MAX_DIMENSION_VALUE_LENGTH} characters")
            if value:
                cleaned[key] = value
        return cleaned or None

    @field_validator("tags")
    def normalize_tags(cls, v: list[str] | None) -> list[str] | None:
        # The same rules as the settings rows: shared.dimension_config.validate_tags.
        if v is None:
            return v
        return validate_tags(v) or None

    @model_validator(mode="before")
    def default_unusable_created_at(cls, values):
        """A blank or unparseable ``created_at`` falls back to ingestion time.

        Real producers send both: s3_import sends ``""`` for a file with no date
        column, the CSS webscraper sends the page's date TEXT ("3 days ago"),
        GitHub may send ``None``. Refusing those would dead-letter every item of
        such a source, so the item is kept and dated when it was ingested — the
        same default ``normalized_item_fields`` applies when the key is absent.
        The original value survives in the raw archive. A parseable value is
        never replaced, so the future-date guard below still applies to it.
        """
        if not isinstance(values, dict) or _parses_as_datetime(values.get("created_at")):
            return values
        ingested_at = values.get("ingested_at")
        fallback = ingested_at if _parses_as_datetime(ingested_at) else datetime.now(UTC).isoformat()
        return {**values, "created_at": fallback}

    @model_validator(mode="after")
    def validate_created_at_not_future(self) -> "IngestMessage":
        """Ensure created_at is not too far in the future."""
        if self.created_at.tzinfo is None:
            # Assume UTC if no timezone
            self.created_at = self.created_at.replace(tzinfo=UTC)

        now = datetime.now(UTC)
        if self.created_at > now + timedelta(days=1):
            raise ValueError("created_at cannot be more than 1 day in the future")
        return self


# ============================================
# Validation Functions
# ============================================

def validate_message(raw: dict) -> IngestMessage:
    """
    Validate and parse a raw message.

    Args:
        raw: Raw message dictionary from plugin

    Returns:
        Validated IngestMessage

    Raises:
        MessageValidationError: If validation fails
    """
    try:
        return IngestMessage.model_validate(raw)
    except ValidationError as e:
        errors = [f"{'.'.join(str(x) for x in err['loc'])}: {err['msg']}" for err in e.errors()]
        raise MessageValidationError(errors) from e


def safe_validate_message(raw: dict) -> tuple[IngestMessage | None, list[str]]:
    """
    Safely validate a message, returning errors instead of raising.

    Args:
        raw: Raw message dictionary from plugin

    Returns:
        Tuple of (validated message or None, list of errors)
    """
    try:
        msg = validate_message(raw)
    except MessageValidationError as e:
        return None, e.errors
    else:
        return msg, []
