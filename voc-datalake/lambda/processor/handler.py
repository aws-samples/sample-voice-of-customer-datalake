"""
VoC Feedback Processor Lambda
Processes raw feedback from SQS, enriches with LLM insights, writes to DynamoDB.

Uses Powertools Idempotency to prevent duplicate processing on SQS retries.
Validates incoming messages using Pydantic schemas before processing.
"""
import json
import os
import re
import threading
from datetime import UTC, datetime
from decimal import Decimal

# Shared module imports
import boto3
from aws_lambda_powertools.utilities.data_classes.sqs_event import SQSRecord
from aws_lambda_powertools.utilities.idempotency import IdempotencyConfig
from aws_lambda_powertools.utilities.idempotency.persistence.base import BasePersistenceLayer
from aws_lambda_powertools.utilities.typing import LambdaContext
from botocore.exceptions import BotoCoreError, ClientError
from pydantic import ValidationError

from shared import radar_store
from shared.aws import get_bedrock_client, get_dynamodb_resource, is_conditional_check_failure
from shared.batch import ConcurrentSqsBatchProcessor, batch_lambda_handler
from shared.categorization import (
    Enrichment,
    EnrichmentSteps,
    comprehend_sentiment,
    invoke_enrichment_llm,
    load_categories_config,
    run_enrichment,
)
from shared.categorization import (
    build_categories_instruction as categories_instruction_for,
)
from shared.categorization import (
    detect_language as shared_detect_language,
)
from shared.categorization import (
    translate_text as shared_translate_text,
)
from shared.converse import BedrockThrottlingError, converse
from shared.csv_datasets import is_csv_replace
from shared.csv_updates import csv_update, csv_update_decision, needs_reenrichment
from shared.data_version import BatchBump, bump_radar_version
from shared.dimension_config import load_dimensions_config, with_builtin_dimensions
from shared.feedback_dimensions import category_product, merged_tags, reinfer_dimensions, resolve_item_dimensions
from shared.feedback_keys import FEEDBACK_ID_LENGTH, feedback_item_id
from shared.idempotency import (
    IdempotencyAlreadyInProgressError,
    get_idempotency_config,
    get_persistence_layer,
    idempotent_function,
)

# Unconditional (issue #249). This used to be `from _shared.schemas import` in a
# try/except ImportError that set VALIDATION_ENABLED=False: `_shared` lives under
# plugins/, which the processor bundle never contains, so every deployed function
# ran with validation silently off. The schema now lives in the bundled `shared/`
# tree, and a failure to import it fails the cold start — loud, alarmed by the
# function's error metric, and impossible to mistake for a healthy processor.
from shared.ingest_schemas import MAX_SOURCE_PLATFORM_LENGTH, IngestMessage, safe_validate_message
from shared.logging import logger, metrics, tracer
from shared.model_profile import PAYLOAD_KEY, model_profile_scope, profile_from_payload
from shared.processing_logs import PROCESSING_FAILED_MESSAGE, THROTTLED_MESSAGE
from shared.radar_brands import brand_key
from shared.radar_routing import BrandLabels
from shared.source_profiles import (
    PII_ALLOW,
    PII_SUMMARY_ONLY,
    SourceProfilesUnavailable,
    load_source_profiles,
    profile_for,
)
from shared.source_updates import (
    UPDATE_APPLY,
    UPDATE_STALE,
    attributes_update,
    idempotency_key_for,
    is_update_capable,
    keeps_stored_category,
    reenriched_fields,
    reenrichment_update,
    text_changed,
    update_decision,
)
from shared.timestamps import now_iso
from shared.usefulness import USEFULNESS_FIELD, item_usefulness

# AWS Clients (using shared module for connection reuse)
dynamodb = get_dynamodb_resource()
comprehend = boto3.client('comprehend')
translate = boto3.client('translate')
# Built HERE, not lazily on the first model call: records run on worker threads
# (ENRICHMENT_CONCURRENCY), and boto3's default session is not safe to build a
# client from in several threads at once. Clients themselves are thread-safe.
get_bedrock_client()

# Configuration
FEEDBACK_TABLE = os.environ['FEEDBACK_TABLE']
AGGREGATES_TABLE = os.environ['AGGREGATES_TABLE']
IDEMPOTENCY_TABLE = os.environ.get('IDEMPOTENCY_TABLE', '')
PRIMARY_LANGUAGE = os.environ.get('PRIMARY_LANGUAGE', 'en')
# How many records of one SQS batch are enriched at once. Each record is three
# AWS round-trips plus a model call (~2.5 s) and the records are independent, so
# a batch of 10 used to take ~25 s serially. 5 halves the waves twice over while
# keeping one container's burst against the shared Bedrock quota small; a
# throttled record still fails alone and SQS retries it.
DEFAULT_ENRICHMENT_CONCURRENCY = 5
ENRICHMENT_CONCURRENCY = int(os.environ.get('ENRICHMENT_CONCURRENCY', DEFAULT_ENRICHMENT_CONCURRENCY))
# The enrichment model resolves through the per-surface AI-model picker
# ('enrichment' surface, default Haiku) inside shared/categorization.py.

feedback_table = dynamodb.Table(FEEDBACK_TABLE)
aggregates_table = dynamodb.Table(AGGREGATES_TABLE)
# Other brands' reviews (Radar sources, docs/radar.md) — never voc-feedback.
RADAR_TABLE = os.environ.get('RADAR_TABLE', '')
radar_table = dynamodb.Table(RADAR_TABLE) if RADAR_TABLE else None
# The Radar brand list, read at most once a minute per container (shared.radar_routing).
radar_brand_labels = BrandLabels()
# Marked by every record that stored a Radar review; flushed once per batch.
radar_changed = BatchBump(bump_radar_version)

# Idempotency configuration - prevents duplicate processing on SQS retries
# Records are tracked for 1 hour (3600 seconds) to handle delayed retries
if IDEMPOTENCY_TABLE:
    persistence_layer = get_persistence_layer(IDEMPOTENCY_TABLE)
    idempotency_config = get_idempotency_config(
        expires_after_seconds=3600,  # 1 hour
        use_local_cache=True,
        local_cache_max_items=256,
    )
else:
    persistence_layer = None
    idempotency_config = None
    logger.warning("IDEMPOTENCY_TABLE not configured - duplicate protection disabled")


# ============================================
# Validation Logging
# ============================================

class MessageRejectedError(Exception):
    """A queue message failed IngestMessage validation; the record must fail.

    Carries only the identity and the validation errors — never the body.
    """

    def __init__(self, source_platform: str, message_id: str, errors: list[str]):
        self.errors = errors
        super().__init__(
            f"Message {source_platform}/{message_id} failed validation: {'; '.join(errors)}"
        )


# `LOGS#validation#…` / `LOGS#processing#…` rows are read back by `GET /logs/*`,
# which EVERY signed-in user may call. So a row holds
# no customer content: no raw-record preview (it carried submitter_email/name and
# the review text), no `str(e)` (exception text embeds whatever the failing call
# saw — record values, model output, request ids), and no pydantic `msg` (custom
# validators interpolate the offending input). Full detail stays in the
# processor's own CloudWatch logs (`logger.exception`), which are not user-facing.
# `lambda/api/logs_handler.py` re-redacts on read for rows written before this.
LOG_ROW_TTL_SECONDS = 7 * 24 * 60 * 60
MAX_LOGGED_MESSAGE_ID_LENGTH = 128
MAX_SUMMARY_KEYS = 50
# A field name / location segment that is a plain identifier is schema, not data;
# anything else (a dict key a producer chose, e.g. an email) is masked.
_SAFE_SEGMENT = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,63}\Z')
MASKED_SEGMENT = '*'


def _safe_segment(segment: object) -> str:
    """A validation-location segment or record key, masked unless it is an identifier or index."""
    if isinstance(segment, int) and not isinstance(segment, bool):
        return str(segment)
    if isinstance(segment, str) and _SAFE_SEGMENT.fullmatch(segment):
        return segment
    return MASKED_SEGMENT


def summarize_validation_errors(raw_record: dict) -> list[str]:
    """`<field path>: <pydantic error type>` per error — never the message or the input.

    `safe_validate_message` returns `"<loc>: <msg>"` strings, and a msg can embed the
    rejected value (`custom_fields value for '<key>' …`, `Value error, …`), so the
    structured errors are re-derived here on the (rare) failure path instead.
    """
    try:
        IngestMessage.model_validate(raw_record)
    except ValidationError as e:
        return [
            f"{'.'.join(_safe_segment(s) for s in err['loc']) or '(message)'}: {err['type']}"
            for err in e.errors(include_url=False, include_input=False, include_context=False)
        ]
    return ['(message): invalid']


def summarize_record(raw_record: dict) -> dict:
    """What a validation-failure row may say about the record: its shape, not its content."""
    keys = sorted({_safe_segment(k) for k in raw_record})[:MAX_SUMMARY_KEYS]
    text = raw_record.get('text')
    summary: dict = {'record_keys': keys}
    if isinstance(text, str):
        summary['text_length'] = len(text)
    return summary


def _log_row_base(kind: str, source_platform: str, message_id: object) -> dict:
    now = datetime.now(UTC)
    safe_id = str(message_id)[:MAX_LOGGED_MESSAGE_ID_LENGTH]
    return {
        'pk': f"LOGS#{kind}#{source_platform}",
        'sk': f"{now.isoformat()}#{safe_id[:32]}",
        'source_platform': source_platform,
        'message_id': safe_id,
        'timestamp': now.isoformat(),
        'ttl': int(now.timestamp()) + LOG_ROW_TTL_SECONDS,
    }


def log_validation_failure(source_platform: str, message_id: object, errors: list[str], record_summary: dict):
    """
    Log a validation failure to DynamoDB for user visibility.

    `errors` must already be `summarize_validation_errors` output and `record_summary`
    `summarize_record` output: the row is readable by every signed-in user.
    Stores in aggregates table with TTL for automatic cleanup.
    """
    if not aggregates_table:
        logger.warning("Cannot log validation failure - aggregates table not configured")
        return

    try:
        log_entry = {
            **_log_row_base('validation', source_platform, message_id),
            'log_type': 'validation_failure',
            'errors': errors,
            **record_summary,
        }
        aggregates_table.put_item(Item=log_entry)
        logger.info(f"Logged validation failure for {source_platform}/{log_entry['message_id']}")
    except (ClientError, BotoCoreError) as e:
        logger.exception(f"Failed to log validation failure: {e}")


def log_processing_error(source_platform: str, message_id: object, error: BaseException):
    """
    Log a processing error to DynamoDB for user visibility: the exception's class
    name and a fixed message, never `str(error)`.
    """
    if not aggregates_table:
        return

    try:
        log_entry = {
            **_log_row_base('processing', source_platform, message_id),
            'log_type': 'processing_error',
            'error_type': type(error).__name__,
            'error_message': THROTTLED_MESSAGE if isinstance(error, BedrockThrottlingError) else PROCESSING_FAILED_MESSAGE,
        }
        aggregates_table.put_item(Item=log_entry)
    except (ClientError, BotoCoreError) as e:
        logger.exception(f"Failed to log processing error: {e}")


def validate_sqs_message(raw_record: dict) -> tuple[dict | None, list[str]]:
    """
    Validate an SQS message using Pydantic schemas.

    Returns:
        Tuple of (validated dict or None, list of PII-free errors)
    """
    validated_msg, errors = safe_validate_message(raw_record)

    if errors:
        # `source_platform` failed validation, so it is untrusted here: it becomes part of the
        # LOGS#validation#<source> key, where a '#' would split the key ambiguously.
        source_platform = str(raw_record.get('source_platform', 'unknown')).replace('#', '_')[:MAX_SOURCE_PLATFORM_LENGTH]
        message_id = raw_record.get('id', 'unknown')
        # The returned errors also reach `MessageRejectedError` and the warning log,
        # so they are the redacted form there too.
        safe_errors = summarize_validation_errors(raw_record)

        log_validation_failure(source_platform, message_id, safe_errors, summarize_record(raw_record))
        count_metric("ValidationFailures")

        return None, safe_errors
    if validated_msg is None:
        # safe_validate_message pairs "no model" with at least one error; this
        # keeps the contract total should it ever return neither.
        return None, ['message did not validate']

    # Convert validated Pydantic model back to dict
    return validated_msg.model_dump(mode='json', exclude_none=True), []

# Category instruction, prompts and parsing live in shared/categorization.py
# (shared with the category-reprocess worker). The categories cache below stays
# here: it is this Lambda's per-container state.
_categories_cache = None
_categories_cache_time = None
CATEGORIES_CACHE_TTL = 300  # 5 minutes


@tracer.capture_method
def get_categories_config() -> list:
    """Fetch categories configuration from DynamoDB with caching."""
    global _categories_cache, _categories_cache_time

    now = datetime.now(UTC).timestamp()
    if _categories_cache is not None and _categories_cache_time and (now - _categories_cache_time) < CATEGORIES_CACHE_TTL:
        return _categories_cache

    try:
        categories = load_categories_config(aggregates_table)
        if categories:
            _categories_cache = categories
            _categories_cache_time = now
            logger.info(f"Loaded {len(categories)} categories from DynamoDB")
            return categories
        logger.warning("No categories configured - will use defaults")
    except (ClientError, BotoCoreError) as e:
        logger.exception(f"Could not fetch categories from DynamoDB: {e}")

    # Cache empty result to avoid repeated failed lookups
    _categories_cache = []
    _categories_cache_time = now
    return []


def build_categories_instruction() -> str:
    """Build the categories instruction for the LLM prompt."""
    return categories_instruction_for(get_categories_config())


# Dimensions config and source profiles: the same per-container TTL as the
# categories above, read through this module's aggregates table. A failed read
# is cached as "none" for the TTL too (the review is still stored, without them).
_settings_cache: dict[str, tuple[float, list]] = {}
# The settings whose cached value stands in for a FAILED read (see strict readers).
_failed_settings: set[str] = set()


def _cached_setting(name: str, loader) -> list:
    now = datetime.now(UTC).timestamp()
    cached = _settings_cache.get(name)
    if cached is not None and now - cached[0] < CATEGORIES_CACHE_TTL:
        return cached[1]
    try:
        value = loader(aggregates_table)
        _failed_settings.discard(name)
    except (ClientError, BotoCoreError, ValueError) as e:
        logger.exception(f"Could not read the {name} settings: {type(e).__name__}")
        value = []
        _failed_settings.add(name)
    _settings_cache[name] = (now, value)
    return value


def get_dimensions_config() -> list:
    """The built-in plus the configured dimensions (cached; only the built-ins when the read failed)."""
    return _cached_setting('dimensions', load_dimensions_config) or with_builtin_dimensions([])


def source_profile(source_platform: str) -> dict:
    """The source's profile (cached; the defaults when absent or unreadable)."""
    return profile_for(_cached_setting('sources', load_source_profiles), source_platform)

processor = ConcurrentSqsBatchProcessor(max_workers=ENRICHMENT_CONCURRENCY)

# Powertools' Metrics.add_metric is a read-modify-write of one dict entry, so two
# threads adding the same NEW metric name lose a count. Every processor metric
# goes through this lock.
_metrics_lock = threading.Lock()


def count_metric(name: str) -> None:
    """Add 1 to the Count metric `name` (thread-safe)."""
    with _metrics_lock:
        metrics.add_metric(name=name, unit="Count", value=1)


# Enrichment stages bound to this Lambda's clients; the logic is shared with the
# category-reprocess worker (shared/categorization.py).
def detect_language(text: str) -> str:
    """Detect dominant language using Comprehend."""
    return shared_detect_language(comprehend, text)


def translate_text(text: str, source_lang: str, target_lang: str) -> str:
    """Translate text if needed."""
    return shared_translate_text(translate, text, source_lang, target_lang)


def get_comprehend_sentiment(text: str, language: str) -> dict:
    """Get sentiment from Comprehend."""
    return comprehend_sentiment(comprehend, text, language)


def invoke_bedrock_llm(raw_record: dict, raise_on_throttle: bool = True) -> dict:
    """Invoke Bedrock for structured insights (throttling re-raised for SQS retry)."""
    return invoke_enrichment_llm(
        raw_record, build_categories_instruction(),
        converse_fn=converse, raise_on_throttle=raise_on_throttle,
        dimensions_config=get_dimensions_config(),
    )

def generate_deterministic_id(source_platform: str, source_id: str, text: str = '', created_at: str = '', url: str = '') -> str:
    """
    Generate a deterministic feedback ID based on source to prevent duplicates.

    Priority for ID generation:
    1. source_platform + source_id (if source_id exists) - most reliable
    2. source_platform + created_at + text_hash + url (fallback for scraped content)

    This ensures the same review scraped on different days is deduplicated
    based on its actual content and original date, not the scrape date.
    """
    import hashlib

    if source_id:
        # Primary: use source-provided ID (most reliable). Shared with the CSV
        # dataset preview, which reads the item back by this key.
        return feedback_item_id(source_platform, source_id)
    # Fallback: generate ID from content signature
    # Use text hash (first 500 chars to handle minor variations); the hash is a
    # content fingerprint, not a security control.
    text_hash = hashlib.sha256(text[:500].encode()).hexdigest()[:16] if text else ''
    # Include created_at (review date) to differentiate reviews with similar text
    # Include URL for additional uniqueness
    content = f"{source_platform}:{created_at}:{text_hash}:{url}"
    logger.info(f"Generated fallback ID for {source_platform} (no source_id): text_hash={text_hash}")

    return hashlib.sha256(content.encode()).hexdigest()[:FEEDBACK_ID_LENGTH]


@tracer.capture_method
def check_duplicate(source_platform: str, feedback_id: str) -> bool:
    """Check if feedback already exists in DynamoDB."""
    try:
        response = feedback_table.get_item(
            Key={'pk': f"SOURCE#{source_platform}", 'sk': f"FEEDBACK#{feedback_id}"},
            ProjectionExpression='feedback_id'
        )
    except (ClientError, BotoCoreError) as e:
        logger.warning(f"Duplicate check failed: {e}")
        return False
    return 'Item' in response


class ConcurrentSourceUpdateError(Exception):
    """A stored item changed between the read and the conditional refresh; SQS retries the record."""


class CsvReplaceRefusedError(Exception):
    """A CSV correction names an item its dataset did not store; the record fails (SQS → DLQ).

    Raised before any model call, so a forged or mismatched replace costs no Bedrock invocation
    per retry. The conditional write in ``shared.csv_updates`` stays the authoritative guard.
    """


@tracer.capture_method
def load_stored_item(pk: str, sk: str) -> dict | None:
    """The stored item at (pk, sk), read consistently, or None when there is none."""
    response = feedback_table.get_item(Key={'pk': pk, 'sk': sk}, ConsistentRead=True)
    item = response.get('Item')
    return item if isinstance(item, dict) else None


def _enrich_again(raw_record: dict) -> tuple[Enrichment, list]:
    """The processor's enrichment of an updated copy, and the categories config it ran with."""
    categories_config = get_categories_config()
    enrichment = run_enrichment(
        raw_record,
        EnrichmentSteps(detect_language, translate_text, get_comprehend_sentiment, invoke_bedrock_llm),
        PRIMARY_LANGUAGE,
        categories_config,
    )
    return enrichment, categories_config


def _reinferred_dimensions(stored: dict, enrichment: Enrichment, categories_config: list) -> tuple[dict, dict]:
    """The stored item's dimensions after the re-enrichment (locked values kept)."""
    category = stored.get('category') if keeps_stored_category(stored, enrichment) else enrichment.attributes['category']
    return reinfer_dimensions(
        get_dimensions_config(), stored,
        product=category_product(categories_config, category), ai=enrichment.ai_dimensions,
    )


def _reenrichment_update(stored: dict, raw_record: dict, now_iso: str) -> dict:
    """Re-run the processor's enrichment for an edited issue; attributes-only when the model failed."""
    enrichment, categories_config = _enrich_again(raw_record)
    if enrichment.llm_failed:
        # Never overwrite a good enrichment with the fallback defaults; the text is
        # left as stored too, so the next copy of the issue tries again.
        count_metric("SourceUpdateEnrichmentFailed")
        return attributes_update(stored, raw_record, now_iso)
    dimensions = _reinferred_dimensions(stored, enrichment, categories_config)
    count_metric("SourceUpdatesReenriched")
    return reenrichment_update(stored, raw_record, enrichment, dimensions, now_iso)


@tracer.capture_method
def refresh_stored_item(stored: dict, raw_record: dict) -> str:
    """Bring an already-stored issue up to date with a newer copy (see shared/source_updates.py).

    Returns the decision (``apply`` / ``stale`` / ``unchanged``). Raises
    ``ConcurrentSourceUpdateError`` when the item changed under us, so the record
    is retried against the new state.
    """
    pii_policy = pii_policy_for(raw_record)
    decision = update_decision(stored, raw_record, pii_policy)
    if decision != UPDATE_APPLY:
        logger.info(f"Source update {decision}: {stored.get('feedback_id')}")
        count_metric("SourceUpdatesStale" if decision == UPDATE_STALE else "SourceUpdatesUnchanged")
        return decision
    refreshed_at = now_iso()
    if text_changed(stored, raw_record, pii_policy):
        kwargs = _reenrichment_update(stored, raw_record, refreshed_at)
    else:
        kwargs = attributes_update(stored, raw_record, refreshed_at)
    try:
        feedback_table.update_item(**kwargs)
    except ClientError as e:
        if is_conditional_check_failure(e):
            raise ConcurrentSourceUpdateError(f"Feedback {stored.get('feedback_id')} changed during refresh") from e
        raise
    logger.info(f"Refreshed stored feedback {stored.get('feedback_id')} from a newer source copy")
    count_metric("SourceUpdatesApplied")
    return decision


def _csv_reenriched(stored: dict, raw_record: dict, pii_policy: str) -> tuple[dict | None, bool]:
    """The text + enrichment fields of a corrected CSV row, and whether its category moves.

    Enriched exactly like a new row; under summary-only the text is the model's summary and the
    customer's words are dropped. A FAILED model call returns ``(None, False)``: like an issue
    refresh, the stored enrichment is never overwritten with the fallback defaults.
    """
    enrichment, categories_config = _enrich_again(raw_record)
    if enrichment.llm_failed:
        count_metric("CsvUpdateEnrichmentFailed")
        return None, False
    dimensions = _reinferred_dimensions(stored, enrichment, categories_config)
    fields = reenriched_fields(stored, raw_record, enrichment, dimensions)
    if pii_policy == PII_SUMMARY_ONLY:
        fields.update(dict.fromkeys(SUMMARY_ONLY_DROPPED_FIELDS))
        fields['original_text'] = fields.get('problem_summary') or WITHHELD_TEXT
    return fields, not keeps_stored_category(stored, enrichment)


@tracer.capture_method
def refresh_csv_item(stored: dict, raw_record: dict) -> str:
    """Apply a confirmed CSV correction to its stored row (shared/csv_updates.py); the decision.

    Raises ``ConcurrentSourceUpdateError`` when the item changed under us (SQS retries), and
    ``CsvReplaceRefusedError`` when the stored item is not this dataset's row.
    """
    if stored.get('csv_dataset') != raw_record['csv_dataset']:
        count_metric("CsvUpdatesRefused")
        raise CsvReplaceRefusedError(f"Feedback {stored.get('feedback_id')} was not stored by this CSV dataset")
    decision = csv_update_decision(stored, raw_record)
    if decision != UPDATE_APPLY:
        logger.info(f"CSV update {decision}: {stored.get('feedback_id')}")
        count_metric("CsvUpdatesUnchanged")
        return decision
    pii_policy = pii_policy_for(raw_record)
    wants_reenrichment = needs_reenrichment(stored, raw_record, pii_policy)
    reenriched, moves_category = (
        _csv_reenriched(stored, raw_record, pii_policy) if wants_reenrichment else (None, False))
    # A failed re-enrichment applies the row's own fields only and keeps the stored digest,
    # so the row still previews as changed and a later confirmed upload retries the text.
    enrichment_failed = wants_reenrichment and reenriched is None
    try:
        feedback_table.update_item(**csv_update(
            stored, raw_record, pii_policy, now_iso(), reenriched, moves_category, enrichment_failed))
    except ClientError as e:
        if is_conditional_check_failure(e):
            raise ConcurrentSourceUpdateError(f"Feedback {stored.get('feedback_id')} changed during a CSV update") from e
        raise
    logger.info(f"Updated stored feedback {stored.get('feedback_id')} from a corrected CSV row")
    count_metric(_csv_update_metric(wants_reenrichment, enrichment_failed))
    return decision


def _csv_update_metric(wants_reenrichment: bool, enrichment_failed: bool) -> str:
    """One metric per outcome: a failed re-enrichment (fields only) is not counted as a plain update."""
    if enrichment_failed:
        return "CsvUpdatesFieldsOnly"
    return "CsvUpdatesReenriched" if wants_reenrichment else "CsvUpdatesApplied"


def _refreshable(raw_record: dict) -> bool:
    """A record that may update the item it names: a GitHub issue, or a confirmed CSV correction."""
    return is_update_capable(raw_record) or is_csv_replace(raw_record)


def _refresh(stored: dict, raw_record: dict) -> str:
    return refresh_csv_item(stored, raw_record) if is_csv_replace(raw_record) else refresh_stored_item(stored, raw_record)


def _handled_as_existing(raw_record: dict, source_display: str, feedback_id: str) -> bool:
    """True when the record names an item already stored: refreshed (issues, CSV corrections) or skipped."""
    if _refreshable(raw_record):
        stored = load_stored_item(f"SOURCE#{source_display}", f"FEEDBACK#{feedback_id}")
        if stored is None:
            return False
        _refresh(stored, raw_record)
        return True
    if check_duplicate(source_display, feedback_id):
        logger.info(f"Skipping duplicate feedback: {source_display}/{raw_record.get('id', '')}")
        count_metric("DuplicatesSkipped")
        return True
    return False


@tracer.capture_method
def process_feedback(raw_record: dict) -> dict | None:
    """
    Process a single feedback record.

    Idempotency protection lives in the caller, _process_feedback_idempotent,
    keyed on source_platform + source_id (+ a content fingerprint for issue-tracker
    records) so the same copy of a feedback item is never processed twice, even
    across SQS retries. Returns the new item to write, or None when the id is
    already stored (skipped, or — for an issue — refreshed in place).
    """
    now = datetime.now(UTC)
    # Resolve source_display early — used as PK for both duplicate check and write
    source_display = raw_record.get('brand_name', '') or raw_record.get('source_platform', 'unknown')
    feedback_id = feedback_id_of(raw_record)

    # Check for an existing item before expensive Comprehend/Translate/Bedrock
    # processing. Uses source_display (brand_name) to match the PK used when
    # writing items. An issue-tracker item is refreshed in place instead of skipped.
    if _handled_as_existing(raw_record, source_display, feedback_id):
        return None
    return build_feedback_item(raw_record, feedback_id, now)


def feedback_id_of(raw_record: dict) -> str:
    """The record's deterministic feedback id (source id, else a content signature)."""
    return generate_deterministic_id(
        raw_record.get('source_platform', 'unknown'), raw_record.get('id', ''),
        raw_record.get('text', ''), raw_record.get('created_at', ''), raw_record.get('url', ''))


def build_feedback_item(raw_record: dict, feedback_id: str, now: datetime) -> dict:
    """Enrich ``raw_record`` and build the item to store, under its source's PII policy."""
    now_iso = now.isoformat()
    date_str = now.strftime('%Y-%m-%d')
    source_platform = raw_record.get('source_platform', 'unknown')
    source_display = raw_record.get('brand_name', '') or source_platform
    original_text = raw_record.get('text', '')

    # Same enrichment path as the category-reprocess worker's raw mode. The steps
    # are looked up at call time, so this module's functions stay the seam.
    categories_config = get_categories_config()
    enrichment = run_enrichment(
        raw_record,
        EnrichmentSteps(detect_language, translate_text, get_comprehend_sentiment, invoke_bedrock_llm),
        PRIMARY_LANGUAGE,
        categories_config,
    )
    enriched = enrichment.attributes
    llm_result = enrichment.llm_result
    category = enriched['category']
    urgency = enriched['urgency']
    sentiment_score = enriched['sentiment_score']

    # Build DynamoDB item with GSI keys
    item = {
        # Primary key - use brand_name for better source filtering
        'pk': f"SOURCE#{source_display}",
        'sk': f"FEEDBACK#{feedback_id}",

        # GSI1: Query by date
        'gsi1pk': f"DATE#{date_str}",
        'gsi1sk': f"{now_iso}#{feedback_id}",

        # GSI2: Query by category
        'gsi2pk': f"CATEGORY#{category}",
        'gsi2sk': f"{sentiment_score}#{now_iso}",

        # GSI3: Query urgent items
        'gsi3pk': f"URGENCY#{urgency}",
        'gsi3sk': now_iso,

        # Data fields
        'feedback_id': feedback_id,
        'source_id': raw_record.get('id', ''),
        # The identifier the source's own export carried, when it is not usable
        # as the item id because it is only unique within one file (CSV upload).
        # Optional: absent for every other source, and left out of the item
        # entirely by the "Remove None values" comprehension at the end of this
        # function — keep that step if this block is refactored, or sources that
        # send no identifier start writing null attributes.
        'csv_row_id': raw_record.get('csv_row_id'),
        # A `csv-row-v2` row's dataset and content digest (shared/csv_datasets.py), compared
        # by the next upload of that dataset. Absent (None-stripped) for every other row.
        'csv_dataset': raw_record.get('csv_dataset'),
        'csv_content_hash': raw_record.get('csv_content_hash'),
        'source_platform': source_platform,
        'source_channel': raw_record.get('source_channel', 'unknown'),
        # Ingestion-path provenance (e.g. 'manual', 'csv_upload', 'json_upload').
        # Optional: sources that don't send it omit the field via None-stripping.
        'ingestion_method': raw_record.get('ingestion_method'),
        'source_url': raw_record.get('url'),
        'brand_name': source_display,
        'source_created_at': raw_record.get('created_at'),
        'ingested_at': raw_record.get('ingested_at'),
        'processed_at': now_iso,
        'date': date_str,

        'original_text': original_text,
        'rating': Decimal(str(raw_record['rating'])) if raw_record.get('rating') is not None else None,
        # Where the immutable raw object lives (raw/{source}/{y}/{m}/{d}/{id}.json),
        # so a raw-mode category reprocess can re-run enrichment from it. Absent
        # (None-stripped below) when the ingestor could not archive the raw data.
        's3_raw_uri': raw_record.get('s3_raw_uri'),
        # Issue-tracker fields (github_issues): version, labels, component, error
        # signature… computed by the plugin, validated by schemas.IssueAttributes,
        # read by GET /metrics/github and the /feedback version/label filters.
        # Absent (None-stripped) for every other source.
        'issue_attributes': raw_record.get('issue_attributes'),

        # category, sentiment, urgency, persona, language/translation
        **enriched,

        'llm_metadata': llm_result.get('metadata', {}),
        # No `ttl`: customer feedback is never deleted (the table's TTL is disabled).

        # Producer fields (None-stripped below when the source sent none).
        'author': raw_record.get('author'),
        'title': raw_record.get('title'),
        'metadata': raw_record.get('metadata') or None,
        **classification_attributes(raw_record, categories_config, enrichment),
    }

    # Remove None values
    built = {k: v for k, v in item.items() if v is not None}
    # The heuristic band (shared/usefulness.py): read off the customer's own text and
    # the enrichment, BEFORE the storage policy may reduce the text to its summary.
    built[USEFULNESS_FIELD] = item_usefulness(built)
    return apply_storage_policy(built, pii_policy_for(raw_record))


# A summary-only source keeps derived fields only: these hold (or may quote) the
# customer's own words or identity, so they are never stored for it.
SUMMARY_ONLY_DROPPED_FIELDS = ('normalized_text', 'direct_customer_quote', 'author', 'title', 'metadata')
WITHHELD_TEXT = '[withheld]'


def pii_policy_for(raw_record: dict) -> str:
    """The PII policy ingestion applied; the source profile's when the message does not say.

    FAILS CLOSED on the second branch: a message that carries no
    ``pii_policy_applied`` and whose source profile cannot be read raises
    ``SourceProfilesUnavailable``, so SQS retries it instead of storing it under
    the allow default.
    """
    applied = raw_record.get('pii_policy_applied')
    if isinstance(applied, str) and applied:
        return applied
    profiles = _cached_setting('sources', load_source_profiles)
    if 'sources' in _failed_settings:
        raise SourceProfilesUnavailable
    return profile_for(profiles, raw_record.get('source_platform', 'unknown'))['pii']


def apply_storage_policy(item: dict, pii_policy: str) -> dict:
    """``item`` as stored under ``pii_policy``: tagged with it, and reduced for summary-only."""
    if pii_policy == PII_ALLOW:
        return item
    stored = {**item, 'pii_policy': pii_policy}
    if pii_policy != PII_SUMMARY_ONLY:
        return stored
    for field in SUMMARY_ONLY_DROPPED_FIELDS:
        stored.pop(field, None)
    stored['original_text'] = item.get('problem_summary') or WITHHELD_TEXT
    return stored


def classification_attributes(raw_record: dict, categories_config: list, enrichment: Enrichment) -> dict:
    """``dimensions``, ``dimension_sources`` and ``tags`` (None when empty) for a new review.

    Order per key: the message (its ``dimensions``, then ``metadata`` entries keyed by
    a dimension key), the source profile's defaults, the category's
    configured product, then the model (``shared.feedback_dimensions``).
    """
    profile = source_profile(raw_record.get('source_platform', 'unknown'))
    dimensions, sources = resolve_item_dimensions(
        get_dimensions_config(),
        message=raw_record.get('dimensions'),
        metadata=raw_record.get('metadata'),
        profile_defaults=profile.get('dimension_defaults'),
        product=category_product(categories_config, enrichment.attributes.get('category')),
        ai=enrichment.ai_dimensions,
    )
    tags = merged_tags(raw_record.get('tags'), profile.get('tags'))
    return {
        'dimensions': dimensions or None,
        'dimension_sources': sources or None,
        'tags': tags or None,
    }


def write_to_dynamodb(item: dict) -> bool:
    """Write a NEW processed feedback item; False when the item is already stored.

    Conditional, never an overwrite: a replayed result (the idempotency store answers
    a redelivery with the item it built then) or a concurrent first ingest must not
    clobber an in-place source refresh or a person's correction made since.
    """
    try:
        feedback_table.put_item(Item=item, ConditionExpression='attribute_not_exists(pk)')
    except ClientError as e:
        if not is_conditional_check_failure(e):
            raise
        logger.info(f"Feedback {item['feedback_id']} is already stored; not overwritten")
        return False
    logger.info(f"Wrote feedback {item['feedback_id']} to DynamoDB")
    return True


class RadarTableUnavailableError(Exception):
    """A Radar source's review arrived but ``RADAR_TABLE`` is not configured; SQS retries it.

    Never "store it in voc-feedback instead": that is exactly the leak the
    separate table prevents.
    """


def radar_brand_for(raw_record: dict) -> str | None:
    """The tracked brand's label when the record belongs to Radar, else None.

    A record stamped with ``radar_brand_key`` (its scraper / connector / upload names a
    Radar brand) resolves the key through the brand list (``shared.radar_routing``); an
    unknown key or an unreadable list RAISES, so SQS retries and then dead-letters it.
    Otherwise the legacy path: the record's source profile names the brand.

    FAILS CLOSED: with the source profiles unreadable, no record is stored at
    all (``SourceProfilesUnavailable``, SQS retries), because "not a Radar
    source" cannot be proven and a guess would put another brand's review in
    our own numbers.
    """
    profiles = _cached_setting('sources', load_source_profiles)
    if 'sources' in _failed_settings:
        raise SourceProfilesUnavailable
    key = raw_record.get('radar_brand_key')
    if key:
        if radar_table is None:
            raise RadarTableUnavailableError('RADAR_TABLE is not configured for a Radar brand')
        return radar_brand_labels.label(radar_table, profiles, str(key))
    brand = profile_for(profiles, raw_record.get('source_platform', 'unknown')).get('radar_brand')
    return brand if isinstance(brand, str) and brand else None


def process_radar_record(raw_record: dict, brand_label: str) -> dict:
    """Enrich a Radar source's review exactly like ours and store it in voc-radar only."""
    if radar_table is None:
        raise RadarTableUnavailableError('RADAR_TABLE is not configured for a Radar source')
    brand = brand_key(brand_label)
    feedback_id = feedback_id_of(raw_record)
    stored = not radar_store.is_stored(radar_table, brand, feedback_id) and radar_store.store_item(
        radar_table, brand, radar_store.radar_item(build_feedback_item(raw_record, feedback_id, datetime.now(UTC)),
                                                   brand, brand_label))
    if not stored:
        count_metric("RadarDuplicatesSkipped")
        return {"status": "skipped", "reason": "duplicate", "radar": True}
    count_metric("RadarFeedbackProcessed")
    radar_changed.mark()
    return {"status": "success", "feedback_id": feedback_id, "radar": True}


def _after_lost_put(raw_record: dict, processed_item: dict) -> dict:
    """The item appeared between the existence check and the put: refresh it or skip."""
    stored = load_stored_item(processed_item['pk'], processed_item['sk']) if _refreshable(raw_record) else None
    if stored is None:
        count_metric("DuplicatesSkipped")
        return {"status": "skipped", "reason": "duplicate"}
    return {"status": f"source_update_{_refresh(stored, raw_record)}",
            "feedback_id": processed_item['feedback_id']}


def record_handler(record: SQSRecord) -> dict:
    """One SQS record, under the model profile its (authenticated) importer stamped on it.

    The field is removed before anything else reads the record, so it never reaches
    the idempotency key or the stored item (shared/model_profile.py).
    """
    raw_record = json.loads(record.body)
    profile = profile_from_payload(raw_record)
    if isinstance(raw_record, dict):
        raw_record.pop(PAYLOAD_KEY, None)
    with model_profile_scope(profile):
        return _process_record(raw_record)


def _process_record(raw_record: dict) -> dict:
    """
    Process a single SQS record with idempotency protection.

    Uses ``idempotency_key_for`` (source_platform + id, plus a content fingerprint
    for issue-tracker records) as the idempotency key, so the same copy is never
    processed twice, even on SQS retries, while a newer copy of an issue is.

    If Bedrock is throttled after retries, raises exception to keep message in queue.
    SQS visibility timeout will make it available for retry later.
    """
    source_platform = raw_record.get('source_platform', 'unknown')
    source_id = raw_record.get('id', 'unknown')

    # Validate the message before processing
    validated_record, validation_errors = validate_sqs_message(raw_record)
    if validation_errors or validated_record is None:
        logger.warning(f"Validation failed for {source_platform}/{source_id}: {validation_errors}")
        # Raise, do not return (issue #249): the BatchProcessor turns a raise into
        # a batchItemFailure, so SQS keeps the message and — after the queue's
        # maxReceiveCount — moves it to the processing DLQ, where a rejected
        # message can be inspected and re-driven once its producer or the schema
        # is fixed. Returning "skipped" deleted it, i.e. validation discarded
        # exactly the messages it existed to catch.
        raise MessageRejectedError(source_platform, source_id, validation_errors or ['message did not validate'])

    # Use validated record for processing
    raw_record = validated_record

    # Create idempotency key from source + id (+ a content fingerprint for issues,
    # so a genuinely newer copy is not answered by the first copy's record).
    idempotency_key = idempotency_key_for(raw_record)

    logger.info(f"Processing feedback from {source_platform}/{source_id}")

    try:
        # A Radar source (another brand, docs/radar.md) never reaches voc-feedback.
        radar_brand = radar_brand_for(raw_record)
        if radar_brand:
            return process_radar_record(raw_record, radar_brand)

        # Use idempotent wrapper if configured
        if persistence_layer and idempotency_config:
            processed_item = _process_feedback_idempotent(
                raw_record=raw_record,
                idempotency_key=idempotency_key,
                persistence_store=persistence_layer,
                config=idempotency_config,
            )
        else:
            processed_item = process_feedback(raw_record)

        # Skip if duplicate was detected
        if processed_item is None:
            return {"status": "skipped", "reason": "duplicate"}

        if not write_to_dynamodb(processed_item):
            return _after_lost_put(raw_record, processed_item)

        count_metric("FeedbackProcessed")

        # Check if LLM enrichment succeeded
        if processed_item.get('llm_metadata', {}).get('error'):
            count_metric("FeedbackProcessedWithoutLLM")
        else:
            count_metric("FeedbackProcessedWithLLM")

        return {"status": "success", "feedback_id": processed_item['feedback_id']}

    except IdempotencyAlreadyInProgressError:
        # Another Lambda is processing this same record - skip
        logger.info(f"Idempotency: {idempotency_key} already in progress, skipping")
        count_metric("IdempotencySkipped")
        return {"status": "skipped", "reason": "idempotency_in_progress"}

    except BedrockThrottlingError as e:
        # Re-raise to fail this record - SQS will retry after visibility timeout
        logger.warning(f"Bedrock throttled for {source_platform}, message will be retried by SQS")
        count_metric("BedrockThrottleRetry")
        log_processing_error(source_platform, source_id, e)
        raise

    except Exception as e:
        # Log unexpected errors for visibility
        logger.exception(f"Unexpected error processing {source_platform}/{source_id}: {e}")
        log_processing_error(source_platform, source_id, e)
        raise


def _process_feedback_idempotent(
    raw_record: dict, idempotency_key: str,
    persistence_store: BasePersistenceLayer, config: IdempotencyConfig,
) -> dict | None:
    """
    Wrapper to apply idempotency decorator dynamically.

    The @idempotent_function decorator ensures this function's result is cached
    and returned on subsequent calls with the same idempotency_key.
    """
    @idempotent_function(
        data_keyword_argument="idempotency_key",
        persistence_store=persistence_store,
        config=config,
    )
    # The decorator reads `idempotency_key` from the call's keyword arguments as the
    # payload to hash and passes it through; the body has no use for it.
    def _inner(raw_record: dict, **_idempotency_kwargs) -> dict | None:
        return process_feedback(raw_record)

    return _inner(raw_record=raw_record, idempotency_key=idempotency_key)


# Main Lambda handler (SQS); the decorator stack lives in `shared.batch`.
def _register_idempotency_context(context: LambdaContext) -> None:
    """Give the idempotency config the invocation's remaining time (in-progress claims expire with it)."""
    if idempotency_config is not None:
        idempotency_config.register_lambda_context(context)


def _bump_after_batch() -> None:
    """One Radar version bump per SQS batch that stored a Radar review (docs/caching.md)."""
    radar_changed.flush(radar_table)


lambda_handler = batch_lambda_handler(
    record_handler, processor, on_context=_register_idempotency_context, after_batch=_bump_after_batch)
