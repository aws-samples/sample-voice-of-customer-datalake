"""
VoC Feedback Processor Lambda
Processes raw feedback from SQS, enriches with LLM insights, writes to DynamoDB.

Uses Powertools Idempotency to prevent duplicate processing on SQS retries.
Validates incoming messages using Pydantic schemas before processing.

Two paths (docs/multi-workspace.md, phase 2), chosen per message by ``workspace_id`` (shared/ws_repo.py
``message_scope``):

* A message that names a workspace is stored in it: the item ``WS#{ws}#SOURCE#{source}`` / ``FEEDBACK#{id}`` with
  every index partition prefixed (shared/feedback_partitions.py), written, checked for a duplicate and refreshed in
  place through the workspace layer (``ws_table``); its log rows ``WS#{ws}#LOGS#…``; its idempotency key
  ``WS#{ws}#…``, so one source item in two workspaces is two items; its Silver versions and inline raw copy under
  ``ws/{ws}/``. Settings (categories, dimensions, source profiles) are still the deployment's. A message that
  Radar would claim is refused (the record fails, and after its retries the queue's DLQ holds it): Radar is not
  keyed by workspace yet (phase 3), and a workspace's review is never written to the deployment's voc-radar.
* A message that names none is stored deployment-wide exactly as before (``SOURCE#{source}``, ``LOGS#…``), with
  ``gsi4pk`` ``FEEDBACK#{id}`` and ``gsi5pk`` ``CHANNEL#{channel}`` for the two re-keyed indexes.
* A message whose ``workspace_id`` is there but is not a workspace id is rejected like any invalid message
  (``MessageRejectedError``: the DLQ after its retries), never stored deployment-wide instead.
* A message of a workspace that is not active (``deleting``, or no ``META``) is dropped before anything is read or
  written: counted, logged without its content, and acked, never sent to the DLQ (``_drop_for_an_inactive_workspace``
  says why). The status is one GetItem per workspace per 300 s per container (30 s when not active;
  ``workspace_active``).
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
from shared.converse import BedrockThrottlingError, converse_detailed
from shared.csv_datasets import is_csv_replace
from shared.csv_updates import csv_update, csv_update_decision, needs_reenrichment
from shared.data_version import BatchBump, bump_radar_version
from shared.dimension_config import load_dimensions_config, with_builtin_dimensions
from shared.feedback_dimensions import category_product, merged_tags, reinfer_dimensions, resolve_item_dimensions
from shared.feedback_keys import FEEDBACK_ID_LENGTH, feedback_item_id
from shared.feedback_partitions import (
    CHANNEL_INDEX_PARTITION,
    FEEDBACK_ID_INDEX_PARTITION,
    category_partition,
    channel_partition,
    date_partition,
    feedback_id_partition,
    item_key,
    urgency_partition,
)
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
from shared.ingest_tables import table_view, update_with_key
from shared.logging import logger, metrics, tracer
from shared.model_profile import PAYLOAD_KEY, model_profile_scope, profile_from_payload
from shared.processing_logs import PROCESSING_FAILED_MESSAGE, THROTTLED_MESSAGE
from shared.radar_brands import brand_key
from shared.radar_routing import BrandLabels
from shared.raw_fallback import archive_inline_raw
from shared.silver_provenance import (
    REASON_CSV_CORRECTION,
    REASON_SOURCE_UPDATE,
    SYSTEM_ACTOR,
    fields_of_update,
    keep_silver_version,
    provenance,
)
from shared.source_profiles import (
    PII_ALLOW,
    PII_SUMMARY_ONLY,
    SUMMARY_ONLY_DROPPED_FIELDS,
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
from shared.ws_repo import WorkspaceScope, WorkspaceStatusCheck, message_scope

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
# voc-workspaces, read only for a workspace message's META status (shared/ws_repo.py WorkspaceStatusCheck: one
# strongly consistent GetItem per workspace per 300 s, 30 s when not active, per container). A failed read raises, so
# the record fails and SQS retries it.
WORKSPACES_TABLE = os.environ['WORKSPACES_TABLE']
workspace_active = WorkspaceStatusCheck(dynamodb.Table(WORKSPACES_TABLE))
# The Radar brand list, read at most once a minute per container (shared.radar_routing).
radar_brand_labels = BrandLabels()
# Marked by every record that stored a Radar review; flushed once per batch.
radar_changed = BatchBump(bump_radar_version)


def _update_in(scope: WorkspaceScope | None, update_kwargs: dict) -> None:
    """``update_item`` of an update built with its ``Key`` (shared/source_updates.py, shared/csv_updates.py)."""
    update_with_key(table_view(scope, feedback_table), update_kwargs)

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


def _log_row_base(kind: str, source_platform: str, message_id: object, scope: WorkspaceScope | None = None) -> dict:
    now = datetime.now(UTC)
    safe_id = str(message_id)[:MAX_LOGGED_MESSAGE_ID_LENGTH]
    return {
        # A workspace message's row is the workspace's (``GET /logs/*`` reads the deployment's rows only, so far).
        'pk': scope.key('LOGS', kind, source_platform or 'unknown') if scope else f"LOGS#{kind}#{source_platform}",
        'sk': f"{now.isoformat()}#{safe_id[:32]}",
        'source_platform': source_platform,
        'message_id': safe_id,
        'timestamp': now.isoformat(),
        'ttl': int(now.timestamp()) + LOG_ROW_TTL_SECONDS,
    }


def log_validation_failure(source_platform: str, message_id: object, errors: list[str], record_summary: dict,
                           scope: WorkspaceScope | None = None):
    """
    Log a validation failure to DynamoDB for user visibility.

    `errors` must already be `summarize_validation_errors` output and `record_summary`
    `summarize_record` output (or empty, for a row that names no shape of the record): the row is readable by
    every signed-in user.
    Stores in aggregates table with TTL for automatic cleanup; a message of a workspace
    (``scope``) under the workspace.
    """
    if not aggregates_table:
        logger.warning("Cannot log validation failure - aggregates table not configured")
        return

    try:
        log_entry = {
            **_log_row_base('validation', source_platform, message_id, scope),
            'log_type': 'validation_failure',
            'errors': errors,
            **record_summary,
        }
        table_view(scope,aggregates_table).put_item(log_entry)
        logger.info(f"Logged validation failure for {source_platform}/{log_entry['message_id']}")
    except (ClientError, BotoCoreError) as e:
        logger.exception(f"Failed to log validation failure: {e}")


def log_processing_error(source_platform: str, message_id: object, error: BaseException,
                         scope: WorkspaceScope | None = None):
    """
    Log a processing error to DynamoDB for user visibility: the exception's class
    name and a fixed message, never `str(error)` (a workspace message's under the workspace).
    """
    if not aggregates_table:
        return

    try:
        log_entry = {
            **_log_row_base('processing', source_platform, message_id, scope),
            'log_type': 'processing_error',
            'error_type': type(error).__name__,
            'error_message': THROTTLED_MESSAGE if isinstance(error, BedrockThrottlingError) else PROCESSING_FAILED_MESSAGE,
        }
        table_view(scope,aggregates_table).put_item(log_entry)
    except (ClientError, BotoCoreError) as e:
        logger.exception(f"Failed to log processing error: {e}")


def validate_sqs_message(raw_record: dict, scope: WorkspaceScope | None = None) -> tuple[dict | None, list[str]]:
    """
    Validate an SQS message using Pydantic schemas (its failure row under ``scope``, the workspace it names).

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

        log_validation_failure(source_platform, message_id, safe_errors, summarize_record(raw_record), scope)
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
        converse_fn=converse_detailed, raise_on_throttle=raise_on_throttle,
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
def check_duplicate(source_platform: str, feedback_id: str, scope: WorkspaceScope | None = None) -> bool:
    """Check if feedback already exists in DynamoDB (in ``scope``'s workspace for a message of one)."""
    try:
        response = table_view(scope,feedback_table).get_item(
            item_key(scope, source_platform, feedback_id), ProjectionExpression='feedback_id')
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
def load_stored_item(pk: str, sk: str, scope: WorkspaceScope | None = None) -> dict | None:
    """The stored item at (pk, sk), read consistently, or None when there is none (``pk`` in ``scope``)."""
    response = table_view(scope,feedback_table).get_item({'pk': pk, 'sk': sk}, ConsistentRead=True)
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


def _reenrichment_update(stored: dict, raw_record: dict, now_iso: str, scope: WorkspaceScope | None = None) -> dict:
    """Re-run the processor's enrichment for an edited issue; attributes-only when the model failed."""
    enrichment, categories_config = _enrich_again(raw_record)
    if enrichment.llm_failed:
        # Never overwrite a good enrichment with the fallback defaults; the text is
        # left as stored too, so the next copy of the issue tries again.
        count_metric("SourceUpdateEnrichmentFailed")
        return attributes_update(stored, raw_record, now_iso)
    dimensions = _reinferred_dimensions(stored, enrichment, categories_config)
    count_metric("SourceUpdatesReenriched")
    return reenrichment_update(stored, raw_record, enrichment, dimensions, now_iso, scope)


@tracer.capture_method
def refresh_stored_item(stored: dict, raw_record: dict, scope: WorkspaceScope | None = None) -> str:
    """Bring an already-stored issue up to date with a newer copy (see shared/source_updates.py).

    Returns the decision (``apply`` / ``stale`` / ``unchanged``). Raises
    ``ConcurrentSourceUpdateError`` when the item changed under us, so the record
    is retried against the new state. ``scope``: the workspace the item is in, for a message of one.
    """
    pii_policy = pii_policy_for(raw_record)
    decision = update_decision(stored, raw_record, pii_policy)
    if decision != UPDATE_APPLY:
        logger.info(f"Source update {decision}: {stored.get('feedback_id')}")
        count_metric("SourceUpdatesStale" if decision == UPDATE_STALE else "SourceUpdatesUnchanged")
        return decision
    refreshed_at = now_iso()
    if text_changed(stored, raw_record, pii_policy):
        kwargs = _reenrichment_update(stored, raw_record, refreshed_at, scope)
    else:
        kwargs = attributes_update(stored, raw_record, refreshed_at)
    try:
        _update_in(scope, kwargs)
    except ClientError as e:
        if is_conditional_check_failure(e):
            raise ConcurrentSourceUpdateError(f"Feedback {stored.get('feedback_id')} changed during refresh") from e
        raise
    _keep_previous(stored, kwargs, REASON_SOURCE_UPDATE, scope)  # once it landed: a refused one leaves no version
    logger.info(f"Refreshed stored feedback {stored.get('feedback_id')} from a newer source copy")
    count_metric("SourceUpdatesApplied")
    return decision


def _csv_reenriched(stored: dict, raw_record: dict, pii_policy: str,
                    scope: WorkspaceScope | None = None) -> tuple[dict | None, bool]:
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
    fields = reenriched_fields(stored, raw_record, enrichment, dimensions, scope)
    if pii_policy == PII_SUMMARY_ONLY:
        fields.update(dict.fromkeys(SUMMARY_ONLY_DROPPED_FIELDS))
        fields['original_text'] = fields.get('problem_summary') or WITHHELD_TEXT
    return fields, not keeps_stored_category(stored, enrichment)


@tracer.capture_method
def refresh_csv_item(stored: dict, raw_record: dict, scope: WorkspaceScope | None = None) -> str:
    """Apply a confirmed CSV correction to its stored row (shared/csv_updates.py); the decision.

    Raises ``ConcurrentSourceUpdateError`` when the item changed under us (SQS retries), and
    ``CsvReplaceRefusedError`` when the stored item is not this dataset's row. ``scope``: the item's workspace.
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
        _csv_reenriched(stored, raw_record, pii_policy, scope) if wants_reenrichment else (None, False))
    # A failed re-enrichment applies the row's own fields only and keeps the stored digest,
    # so the row still previews as changed and a later confirmed upload retries the text.
    enrichment_failed = wants_reenrichment and reenriched is None
    kwargs = csv_update(stored, raw_record, pii_policy, now_iso(), reenriched, moves_category, enrichment_failed,
                        scope)
    try:
        _update_in(scope, kwargs)
    except ClientError as e:
        if is_conditional_check_failure(e):
            raise ConcurrentSourceUpdateError(f"Feedback {stored.get('feedback_id')} changed during a CSV update") from e
        raise
    _keep_previous(stored, kwargs, REASON_CSV_CORRECTION, scope)  # once it landed: a refused one leaves no version
    logger.info(f"Updated stored feedback {stored.get('feedback_id')} from a corrected CSV row")
    count_metric(_csv_update_metric(wants_reenrichment, enrichment_failed))
    return decision


def _keep_previous(stored: dict, update_kwargs: dict, reason: str, scope: WorkspaceScope | None = None) -> None:
    """Keep ``stored`` as it was before an in-place update that landed (TENETS.md D1; never fails it), under
    ``ws/{ws}/silver/`` for an item of a workspace."""
    keep_silver_version(stored, actor=SYSTEM_ACTOR, reason=reason, changed_fields=fields_of_update(update_kwargs),
                        scope=scope)


def _csv_update_metric(wants_reenrichment: bool, enrichment_failed: bool) -> str:
    """One metric per outcome: a failed re-enrichment (fields only) is not counted as a plain update."""
    if enrichment_failed:
        return "CsvUpdatesFieldsOnly"
    return "CsvUpdatesReenriched" if wants_reenrichment else "CsvUpdatesApplied"


def _refreshable(raw_record: dict) -> bool:
    """A record that may update the item it names: a GitHub issue, or a confirmed CSV correction."""
    return is_update_capable(raw_record) or is_csv_replace(raw_record)


def _refresh(stored: dict, raw_record: dict, scope: WorkspaceScope | None = None) -> str:
    if is_csv_replace(raw_record):
        return refresh_csv_item(stored, raw_record, scope)
    return refresh_stored_item(stored, raw_record, scope)


def _handled_as_existing(raw_record: dict, source_display: str, feedback_id: str,
                         scope: WorkspaceScope | None = None) -> bool:
    """True when the record names an item already stored: refreshed (issues, CSV corrections) or skipped."""
    if _refreshable(raw_record):
        key = item_key(scope, source_display, feedback_id)
        stored = load_stored_item(key['pk'], key['sk'], scope)
        if stored is None:
            return False
        _refresh(stored, raw_record, scope)
        return True
    if check_duplicate(source_display, feedback_id, scope):
        logger.info(f"Skipping duplicate feedback: {source_display}/{raw_record.get('id', '')}")
        count_metric("DuplicatesSkipped")
        return True
    return False


@tracer.capture_method
def process_feedback(raw_record: dict, scope: WorkspaceScope | None = None) -> dict | None:
    """
    Process a single feedback record (``scope``: the workspace its message names, None deployment-wide).

    Idempotency protection lives in the caller, _process_feedback_idempotent,
    keyed on source_platform + source_id (+ a content fingerprint for issue-tracker
    records, + the workspace) so the same copy of a feedback item is never processed twice, even
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
    if _handled_as_existing(raw_record, source_display, feedback_id, scope):
        return None
    return build_feedback_item(raw_record, feedback_id, now, scope)


def feedback_id_of(raw_record: dict) -> str:
    """The record's deterministic feedback id (source id, else a content signature)."""
    return generate_deterministic_id(
        raw_record.get('source_platform', 'unknown'), raw_record.get('id', ''),
        raw_record.get('text', ''), raw_record.get('created_at', ''), raw_record.get('url', ''))


def build_feedback_item(raw_record: dict, feedback_id: str, now: datetime, scope: WorkspaceScope | None = None) -> dict:
    """Enrich ``raw_record`` and build the item to store, under its source's PII policy: keyed in ``scope``'s
    workspace for a message of one (shared/feedback_partitions.py), deployment-wide otherwise."""
    now_iso = now.isoformat()
    date_str = now.strftime('%Y-%m-%d')
    source_platform = raw_record.get('source_platform', 'unknown')
    source_display = raw_record.get('brand_name', '') or source_platform
    source_channel = raw_record.get('source_channel', 'unknown')
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
        **item_key(scope, source_display, feedback_id),

        # GSI1: Query by date
        'gsi1pk': date_partition(scope, date_str),
        'gsi1sk': f"{now_iso}#{feedback_id}",

        # GSI2: Query by category
        'gsi2pk': category_partition(scope, category),
        'gsi2sk': f"{sentiment_score}#{now_iso}",

        # GSI3: Query urgent items
        'gsi3pk': urgency_partition(scope, urgency),
        'gsi3sk': now_iso,

        # GSI4: by feedback id; GSI5: by channel (sort key gsi1sk). Their own partition attributes, so a
        # workspace's id or channel is never found by another workspace's (or the deployment's) read. An empty
        # channel is in no channel partition (no reader asks for one).
        FEEDBACK_ID_INDEX_PARTITION: feedback_id_partition(scope, feedback_id),
        CHANNEL_INDEX_PARTITION: channel_partition(scope, source_channel) if source_channel else None,

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
        'source_channel': source_channel,
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
        # Where the immutable raw object lives (raw/{source}/{y}/{m}/{d}/{id}/{sha16}.json),
        # so a raw-mode category reprocess can re-run enrichment from it. A message that
        # came with `raw_data` inline (the producer's archive write failed) is archived
        # here once (shared/raw_fallback.py, policy-gated). Absent (None-stripped below)
        # when there is still no copy.
        's3_raw_uri': raw_record.get('s3_raw_uri') or archive_inline_raw(raw_record, now, scope),
        # Issue-tracker fields (github_issues): version, labels, component, error
        # signature… computed by the plugin, validated by schemas.IssueAttributes,
        # read by GET /metrics/github and the /feedback version/label filters.
        # Absent (None-stripped) for every other source.
        'issue_attributes': raw_record.get('issue_attributes'),

        # category, sentiment, urgency, persona, language/translation
        **enriched,

        # How this item was made (TENETS.md D2): pipeline version, `llm` or `defaults` (the model
        # call failed and the fallback values are stored), the model that answered, the prompt version.
        **provenance('defaults' if enrichment.llm_failed else 'llm',
                     llm_metadata=llm_result.get('metadata', {}), at=now_iso),
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


def write_to_dynamodb(item: dict, scope: WorkspaceScope | None = None) -> bool:
    """Write a NEW processed feedback item; False when the item is already stored.

    Conditional, never an overwrite: a replayed result (the idempotency store answers
    a redelivery with the item it built then) or a concurrent first ingest must not
    clobber an in-place source refresh or a person's correction made since. An item of a
    workspace (``scope``) is written through it: every partition it carries must be the workspace's.
    """
    try:
        table_view(scope,feedback_table).put_item(item, ConditionExpression='attribute_not_exists(pk)')
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


class WorkspaceRadarRefusedError(Exception):
    """A workspace's message that Radar would claim; the record fails (SQS → DLQ after its retries).

    Radar is not keyed by workspace yet (docs/multi-workspace.md, phase 3): storing the review in the
    deployment's voc-radar would put a workspace's data where every workspace's Radar reads, and storing
    it as the workspace's own feedback would count another brand's review as its own.
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


def _radar_result(raw_record: dict, scope: WorkspaceScope | None) -> dict | None:
    """The record's Radar outcome when Radar claims it, else None (it goes to voc-feedback).

    Radar is not keyed by workspace (phase 3), so a workspace's record is never claimed by it:

    * one that carries its own stamp (``radar_brand_key``: its scraper, connector or page named a Radar brand)
      raises ``WorkspaceRadarRefusedError`` (counted): never written to the deployment's voc-radar, nor as the
      workspace's own feedback. The operator APIs refuse saving such a config in a workspace, so none should come;
    * one without a stamp is the workspace's own feedback, whatever the deployment's source profiles say: a
      profile's ``radar_brand`` is the deployment's Radar setting, not the workspace's (its source_platform may
      also be a scraper name or a page's source id another workspace shares), so it claims no workspace's record.
    """
    if scope is not None:
        if raw_record.get('radar_brand_key'):
            count_metric("WorkspaceRadarRefused")
            raise WorkspaceRadarRefusedError('Radar is not keyed by workspace yet')
        return None
    radar_brand = radar_brand_for(raw_record)
    if not radar_brand:
        return None
    return process_radar_record(raw_record, radar_brand)


def _after_lost_put(raw_record: dict, processed_item: dict, scope: WorkspaceScope | None = None) -> dict:
    """The item appeared between the existence check and the put: refresh it or skip."""
    stored = (load_stored_item(processed_item['pk'], processed_item['sk'], scope)
              if _refreshable(raw_record) else None)
    if stored is None:
        count_metric("DuplicatesSkipped")
        return {"status": "skipped", "reason": "duplicate"}
    return {"status": f"source_update_{_refresh(stored, raw_record, scope)}",
            "feedback_id": processed_item['feedback_id']}


def _refuse_invalid_workspace(raw_record: dict) -> MessageRejectedError:
    """A message whose ``workspace_id`` is there but is not a workspace id: logged deployment-wide (it names no
    workspace one could trust), metered, and returned as the rejection to raise (the DLQ path).

    The deployment-wide row says nothing of the record (no ``summarize_record``, not even its field names or text
    length): only its source, message id and the error, since the message was meant for a workspace."""
    source_platform = str(raw_record.get('source_platform', 'unknown')).replace('#', '_')[:MAX_SOURCE_PLATFORM_LENGTH]
    message_id = raw_record.get('id', 'unknown')
    errors = ['workspace_id: invalid_workspace']
    log_validation_failure(source_platform, message_id, errors, {})
    count_metric("ValidationFailures")
    count_metric("WorkspaceMessagesRefused")
    return MessageRejectedError(source_platform, str(message_id), errors)


def _drop_for_an_inactive_workspace(scope: WorkspaceScope) -> dict:
    """A message of a workspace that is not active (``deleting``, or no ``META``: being or already deleted): nothing
    is written, not even a log row, and the record SUCCEEDS, so SQS deletes the message.

    Acked as dropped, never failed: a failed record goes to the processing DLQ after its retries, and a redrive of
    that queue (an operator's routine fix for a bad batch) would bring the message back, and with it the workspace's
    feedback, once its hard delete had finished. Counted (``WorkspaceMessagesDropped``) and logged with the workspace
    id only, no content of the message."""
    logger.warning("Dropped a message of a workspace that is not active", extra={'workspace_id': scope.ws})
    count_metric("WorkspaceMessagesDropped")
    return {"status": "dropped", "reason": "workspace_not_active"}


def message_idempotency_key(raw_record: dict, scope: WorkspaceScope | None) -> str:
    """``idempotency_key_for`` the record, inside its workspace (``WS#{ws}#…``) for a message of one, so the same
    source item queued in two workspaces is processed in each (a ``source_platform`` holds no ``#``, so no
    deployment-wide key starts ``WS#``)."""
    key = idempotency_key_for(raw_record)
    return key if scope is None else scope.key(key)


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

    # The workspace the message names (docs/multi-workspace.md): one that names none is processed
    # deployment-wide as before; a `workspace_id` that is not a workspace id is rejected, never
    # processed deployment-wide instead (the schema refuses a malformed string too; this also
    # catches an explicit null, which the schema would read as "none").
    refused, scope = message_scope(raw_record)
    if refused:
        logger.warning(f"Workspace refused for {source_platform}/{source_id}: not a workspace id")
        raise _refuse_invalid_workspace(raw_record)
    if scope is not None and not workspace_active(scope):
        return _drop_for_an_inactive_workspace(scope)

    # Validate the message before processing
    validated_record, validation_errors = validate_sqs_message(raw_record, scope)
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
    idempotency_key = message_idempotency_key(raw_record, scope)

    logger.info(f"Processing feedback from {source_platform}/{source_id}")

    try:
        # A Radar source (another brand, docs/radar.md) never reaches voc-feedback.
        radar_result = _radar_result(raw_record, scope)
        if radar_result is not None:
            return radar_result

        # Use idempotent wrapper if configured
        if persistence_layer and idempotency_config:
            processed_item = _process_feedback_idempotent(
                raw_record=raw_record,
                idempotency_key=idempotency_key,
                persistence_store=persistence_layer,
                config=idempotency_config,
                scope=scope,
            )
        else:
            processed_item = process_feedback(raw_record, scope)

        # Skip if duplicate was detected
        if processed_item is None:
            return {"status": "skipped", "reason": "duplicate"}

        if not write_to_dynamodb(processed_item, scope):
            return _after_lost_put(raw_record, processed_item, scope)

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
        log_processing_error(source_platform, source_id, e, scope)
        raise

    except Exception as e:
        # Log unexpected errors for visibility
        logger.exception(f"Unexpected error processing {source_platform}/{source_id}: {e}")
        log_processing_error(source_platform, source_id, e, scope)
        raise


def _process_feedback_idempotent(
    raw_record: dict, idempotency_key: str,
    persistence_store: BasePersistenceLayer, config: IdempotencyConfig,
    scope: WorkspaceScope | None = None,
) -> dict | None:
    """
    Wrapper to apply idempotency decorator dynamically.

    The @idempotent_function decorator ensures this function's result is cached
    and returned on subsequent calls with the same idempotency_key (which names the
    workspace for a message of one: ``message_idempotency_key``).
    """
    @idempotent_function(
        data_keyword_argument="idempotency_key",
        persistence_store=persistence_store,
        config=config,
    )
    # The decorator reads `idempotency_key` from the call's keyword arguments as the
    # payload to hash and passes it through; the body has no use for it.
    def _inner(raw_record: dict, **_idempotency_kwargs) -> dict | None:
        return process_feedback(raw_record, scope)

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
