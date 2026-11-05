"""
Category Reprocess Job Lambda Handler

Re-categorises stored feedback after an admin changes the category
configuration. Started by ``POST /settings/categories/reprocess`` (settings
API) with an async event ``{job_id, cursor?}``.

Modes:
  * ``processed`` — re-classify category/subcategory from the stored (translated)
    text with the CURRENT category configuration (one small model call per review).
  * ``raw``       — re-run the processor's full enrichment path on the original
    text (Comprehend language + sentiment, Translate, one full model call).
  * ``dimensions`` — re-infer the AI-sourced dimensions only (one small model
    call); values set by the source, its profile or a person are kept.

Invariants:
  * Customer data is never deleted and no new item is ever put: each review is
    UPDATED in place, keeping its id and keys (only ``gsi2pk`` — and in raw
    mode ``gsi3pk`` — follow the new category / urgency).
  * A review whose category was corrected by a person
    (``category_source == 'manual'``) is skipped unless ``include_manual``; the
    update is conditional on that too, so a correction landing mid-run wins.
  * Progress (counters + cursor) is checkpointed on the job every page; the
    worker re-invokes itself before its time budget runs out and stops as soon
    as the job is cancelled.
  * One owner per job: each invocation claims it with a compare-and-set on a
    fresh ``worker_token`` (a hand-over passes its token in the event); a
    duplicate delivery fails the claim or its next checkpoint and exits.
  * Slices (TENETS.md D3, ``shared/reprocess_slices.py``): a job replays the
    reviews of its sources (one Query per source partition), categories and
    processed- or review-date window; everything else is read past uncounted.
  * Cost ceiling: after ``MAX_REPROCESS_ITEMS`` scanned reviews the job ends as
    'partial' (``stopped_at_ceiling``) with a ``resume_from`` cursor, which
    ``POST /settings/categories/reprocess {resume: <job_id>}`` continues.
  * Lineage (D1, D2, D4): before each in-place update the review AS IT WAS is
    kept (``shared.silver_provenance.keep_silver_version``, reason 'reprocess',
    actor the admin who started the job), and the update stamps
    ``provenance(...)`` (pipeline version, mode, the model that answered, prompt
    version), ``updated_by`` / ``updated_at`` / ``change_reason``. The job row
    records the configuration it derived with (``shared.reprocess_lineage``).
  * Raw mode replays the archived raw item; a review with none readable (CSV /
    JSON uploads and other imports archive whole files, not per-item raw items) is
    replayed from its stored text and counted in ``raw_fallback`` (with its
    source in ``raw_fallback_sources``). A summary-only review never gets
    ``normalized_text`` / ``direct_customer_quote`` back (the processor's rule).
  * Every mode also (re)computes the heuristic ``usefulness`` band
    (``shared.usefulness``, no model call) from the stored text, so a reprocess
    backfills reviews stored before the band existed. A review whose category
    and dimensions come out unchanged but whose band is missing or different
    gets a band-only update (counted as ``updated``). docs/data-quality.md.
"""
import json
import os
from datetime import UTC, datetime
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from shared import reprocess_jobs as jobs
from shared import silver_provenance
from shared.aws import (
    get_dynamodb_resource,
    get_s3_client,
    invoke_lambda_async,
    is_conditional_check_failure,
)
from shared.categorization import (
    EnrichmentSteps,
    build_categories_instruction,
    classify_category,
    classify_dimensions,
    comprehend_sentiment,
    detect_language,
    invoke_enrichment_llm,
    load_categories_config,
    resolve_category,
    run_enrichment,
    translate_text,
)
from shared.converse import BedrockThrottlingError
from shared.data_version import bump_data_version
from shared.dimension_config import load_dimensions_config
from shared.feedback_category import CATEGORY_SOURCE_MANUAL
from shared.feedback_dimensions import category_product, reinfer_dimensions
from shared.invocation_cost import instrumented_handler

# No sys.path shim: the asset bundles this file beside `shared/` (see the
# CategoryReprocess bundling in processing-stack-consolidated.ts), and tests
# import it as `jobs.category_reprocess.handler` from the lambda/ root.
from shared.logging import logger, metrics
from shared.reprocess_lineage import AnswerRecorder, change_stamps, job_actor, job_config
from shared.reprocess_slices import ReprocessSlice, read_page, slice_from_job
from shared.reprocess_slices import admits as slice_admits
from shared.source_profiles import PII_SUMMARY_ONLY
from shared.timestamps import now_iso
from shared.usefulness import USEFULNESS_FIELD, USEFULNESS_UNRATED, item_usefulness, stored_band

FEEDBACK_TABLE = os.environ.get('FEEDBACK_TABLE', '')
AGGREGATES_TABLE = os.environ.get('AGGREGATES_TABLE', '')
RAW_DATA_BUCKET = os.environ.get('RAW_DATA_BUCKET', '')
PRIMARY_LANGUAGE = os.environ.get('PRIMARY_LANGUAGE', 'en')

# Items per Scan page — one checkpoint per page, so this bounds how much work a
# crash or a cancel can lose / let through (each item is one model call).
PAGE_SIZE = 25
# Stop and re-invoke when less than this remains of the Lambda's budget
# (15-min timeout → hands over after ~12 minutes).
TIME_RESERVE_MS = 3 * 60 * 1000
# Consecutive hand-overs caused by Bedrock throttling before the job fails.
MAX_THROTTLE_RESTARTS = 3

CATEGORY_SOURCE_REPROCESS = 'reprocess'
SILVER_REASON = 'reprocess'
# The E-C1 enrichment mode each job mode stamps.
ENRICHMENT_MODES = {
    jobs.MODE_PROCESSED: 'reprocess_processed',
    jobs.MODE_RAW: 'reprocess_raw',
    jobs.MODE_DIMENSIONS: 'reprocess_dimensions',
}
# A summary-only source never stores these (processor/handler.py
# SUMMARY_ONLY_DROPPED_FIELDS); of them, raw-mode enrichment writes only these two.
SUMMARY_ONLY_WITHHELD = ('normalized_text', 'direct_customer_quote')

_comprehend = None
_translate = None


def _comprehend_client():
    global _comprehend
    if _comprehend is None:
        _comprehend = boto3.client('comprehend')
    return _comprehend


def _translate_client():
    global _translate
    if _translate is None:
        _translate = boto3.client('translate')
    return _translate


def _tables() -> tuple[Any, Any]:
    dynamodb = get_dynamodb_resource()
    return dynamodb.Table(FEEDBACK_TABLE), dynamodb.Table(AGGREGATES_TABLE)


# ============================================
# Slice read
# ============================================

def scan_page(
    feedback_table: Any, cursor: dict | None, job_slice: ReprocessSlice, window: tuple[str | None, str | None],
) -> dict:
    """One page of the job's slice (a Scan, or a Query per source; ``shared.reprocess_slices``)."""
    return read_page(feedback_table, cursor, job_slice, window, PAGE_SIZE)


# ============================================
# In-place update
# ============================================

def _set_and_remove(attributes: dict, names: dict, values: dict) -> str:
    """``SET ... [REMOVE ...]`` for ``attributes`` (None REMOVEs), filling ``names``/``values``.

    Aliased ``#a<i>`` / ``:v<i>``; the first attribute must be non-None (there is always a SET).
    """
    sets, removes = [], []
    for index, (field, value) in enumerate(attributes.items()):
        names[f'#a{index}'] = field
        if value is None:
            removes.append(f'#a{index}')
        else:
            values[f':v{index}'] = value
            sets.append(f'#a{index} = :v{index}')
    expression = 'SET ' + ', '.join(sets)
    if removes:
        expression += ' REMOVE ' + ', '.join(removes)
    return expression


def build_update(item: dict, attributes: dict, include_manual: bool, now: str) -> dict:
    """``update_item`` kwargs that SET/REMOVE ``attributes`` on ``item`` in place.

    None-valued attributes are REMOVEd (the processor never stores nulls). The
    condition requires the item to exist (never creates one), its category to be
    unchanged since it was read, and — unless ``include_manual`` — that nobody
    corrected it by hand in the meantime.
    """
    stamped = {
        **attributes,
        'category_source': CATEGORY_SOURCE_REPROCESS,
        'category_reprocessed_at': now,
    }
    names: dict = {'#pk': 'pk', '#cat_now': 'category'}
    values: dict = {}
    expression = _set_and_remove(stamped, names, values)

    conditions = _unchanged_guard(item, 'category', ('#cat_now', ':cat_before'), values)
    if not include_manual:
        names['#source'] = 'category_source'
        conditions.append('(attribute_not_exists(#source) OR #source <> :manual)')
        values[':manual'] = CATEGORY_SOURCE_MANUAL
    return _update_kwargs(item, expression, conditions, names, values)


def _unchanged_guard(item: dict, field: str, aliases: tuple[str, str], values: dict) -> list[str]:
    """The item exists and ``field`` is what was read (absent stays absent); fills ``values``."""
    name_alias, value_alias = aliases
    if field not in item:
        return ['attribute_exists(#pk)', f'attribute_not_exists({name_alias})']
    values[value_alias] = item[field]
    return ['attribute_exists(#pk)', f'{name_alias} = {value_alias}']


def _update_kwargs(item: dict, expression: str, conditions: list[str], names: dict, values: dict) -> dict:
    return {
        'Key': {'pk': item['pk'], 'sk': item['sk']},
        'UpdateExpression': expression,
        'ConditionExpression': ' AND '.join(conditions),
        'ExpressionAttributeNames': names,
        'ExpressionAttributeValues': values,
    }


# ============================================
# Per-item work
# ============================================

def _prompt_record(item: dict) -> dict:
    return {
        'text': item.get('original_text', ''),
        'source_platform': item.get('source_platform', 'unknown'),
        'source_channel': item.get('source_channel', 'unknown'),
        'rating': item.get('rating'),
    }


def _raw_record_from_s3(item: dict) -> dict | None:
    """The per-item raw payload the ingestors archive (``raw_item``), when linked."""
    uri = item.get('s3_raw_uri')
    if not RAW_DATA_BUCKET or not isinstance(uri, str) or not uri.startswith('s3://'):
        return None
    # No '/' leaves an empty key, which the prefix check below already rejects.
    bucket, _, key = uri.removeprefix('s3://').partition('/')
    if bucket != RAW_DATA_BUCKET or not key.startswith('raw/'):
        return None
    try:
        body = get_s3_client().get_object(Bucket=bucket, Key=key)['Body'].read()
        payload = json.loads(body)
    except (ClientError, BotoCoreError, ValueError) as e:
        logger.warning(f"Raw object unreadable, using stored original text: {type(e).__name__}")
        return None
    raw_item = payload.get('raw_item') if isinstance(payload, dict) else None
    if not isinstance(raw_item, dict) or not isinstance(raw_item.get('text'), str) or not raw_item['text']:
        return None
    return {
        **_prompt_record(item),
        'text': raw_item['text'],
        'rating': raw_item.get('rating', item.get('rating')),
    }


def raw_record_for(item: dict) -> dict:
    """The input the processor saw: the archived raw item when the review links
    one, else the stored ``original_text`` (kept verbatim at ingestion)."""
    return raw_input_for(item)[0]


def raw_input_for(item: dict) -> tuple[dict, bool]:
    """``raw_record_for`` and whether it is the ARCHIVED raw item (False = the stored-text fallback)."""
    archived = _raw_record_from_s3(item)
    return (archived, True) if archived is not None else (_prompt_record(item), False)


def note_raw_fallback(counters: dict, item: dict) -> None:
    """Count a raw-mode review replayed from its stored text, and remember its source (R1)."""
    counters['raw_fallback'] = counters.get('raw_fallback', 0) + 1
    sources = counters.setdefault('raw_fallback_sources', set())
    if isinstance(sources, set) and len(sources) < jobs.MAX_FALLBACK_SOURCES:
        sources.add(str(item.get('source_platform', 'unknown')))


def processed_attributes(
    item: dict, categories_config: list[dict], recorder: AnswerRecorder | None = None,
) -> dict | None:
    """New category/subcategory from the stored (translated) text; None if unusable.

    ``recorder`` (a ``converse_fn``) remembers the model that answered, for ``llm_metadata``.
    """
    text = item.get('normalized_text') or item.get('original_text') or ''
    if not isinstance(text, str) or not text.strip():
        return None
    resolved = classify_category(_prompt_record(item), text, categories_config, converse_fn=recorder)
    if resolved is None:
        return None
    category, subcategory = resolved
    return {'category': category, 'subcategory': subcategory, 'gsi2pk': f"CATEGORY#{category}"}


def raw_attributes(item: dict, categories_config: list[dict], raw_record: dict | None = None) -> dict | None:
    """Full re-enrichment through the processor's path; None if the model failed.

    ``raw_record`` is the input (default: ``raw_record_for(item)``). A summary-only
    review gets no ``normalized_text`` / ``direct_customer_quote`` (they are
    REMOVEd, as the processor never stores them for such a source: audit S8).
    """
    if raw_record is None:
        raw_record = raw_record_for(item)
    if not raw_record.get('text'):
        return None
    instruction = build_categories_instruction(categories_config)
    steps = EnrichmentSteps(
        detect_language=lambda text: detect_language(_comprehend_client(), text),
        translate_text=lambda text, src, dst: translate_text(_translate_client(), text, src, dst),
        sentiment=lambda text, lang: comprehend_sentiment(_comprehend_client(), text, lang),
        llm=lambda record: invoke_enrichment_llm(record, instruction),
    )
    enrichment = run_enrichment(raw_record, steps, PRIMARY_LANGUAGE, categories_config)
    # An unconfigured model category fails the review (run_enrichment would have
    # filed it under 'other'): a reprocess never overwrites a category with a guess.
    if enrichment.llm_failed or not enrichment.category_valid:
        return None
    attributes = dict(enrichment.attributes)
    resolved = resolve_category(categories_config, attributes['category'], attributes['subcategory'])
    if resolved is None:
        return None
    attributes['category'], attributes['subcategory'] = resolved
    attributes['gsi2pk'] = f"CATEGORY#{attributes['category']}"
    attributes['gsi3pk'] = f"URGENCY#{attributes['urgency']}"
    attributes['llm_metadata'] = enrichment.llm_result.get('metadata', {})
    if item.get('pii_policy') == PII_SUMMARY_ONLY:
        attributes.update(dict.fromkeys(SUMMARY_ONLY_WITHHELD))
    return attributes


def _record(counters: dict, outcome: str) -> None:
    """Every examined review lands in ``scanned`` plus exactly one outcome."""
    counters['scanned'] += 1
    counters[outcome] += 1


def _stored_map(item: dict, field: str) -> dict:
    value = item.get(field)
    return dict(value) if isinstance(value, dict) else {}


def build_dimensions_update(
    item: dict, dimensions: dict, sources: dict, now: str, band: str | None = None,
    stamps: dict | None = None,
) -> dict:
    """``update_item`` kwargs replacing ``dimensions`` / ``dimension_sources`` in place.

    Conditional on the item existing with exactly the dimensions that were read,
    so a manual edit (``PUT /feedback/{id}/dimensions``) landing mid-run wins.
    Empty maps are REMOVEd (the processor never stores empty ones). ``band``, when
    given, is SET as the review's ``usefulness`` too (it reads ``feedback_type``).
    """
    names = {'#pk': 'pk', '#dims': 'dimensions'}
    values: dict = {}
    attributes = {
        'dimensions_reprocessed_at': now,
        'dimensions': dimensions or None,
        'dimension_sources': sources or None,
    }
    if band is not None:
        attributes[USEFULNESS_FIELD] = band
    attributes.update(stamps or {})
    expression = _set_and_remove(attributes, names, values)
    conditions = _unchanged_guard(item, 'dimensions', ('#dims', ':dims_before'), values)
    return _update_kwargs(item, expression, conditions, names, values)


def build_usefulness_update(item: dict, band: str, stamps: dict | None = None) -> dict:
    """``update_item`` kwargs SETting only the review's ``usefulness`` band.

    Conditional on the item existing with the band (or no band) that was read, so
    a concurrent refresh of the review wins (the worker's conditional-failure path
    records it as ``skipped_manual``, like any change made under it).
    """
    names = {'#pk': 'pk', '#use_now': USEFULNESS_FIELD}
    values: dict = {}
    expression = _set_and_remove({USEFULNESS_FIELD: band, **(stamps or {})}, names, values)
    conditions = _unchanged_guard(item, USEFULNESS_FIELD, ('#use_now', ':use_before'), values)
    return _update_kwargs(item, expression, conditions, names, values)


def reprocess_band(item: dict, reprocessed: dict) -> str:
    """The band a reprocess stores for ``item``, rated from ``reprocessed`` (the item as it will be).

    A ``summary_only`` review keeps the band ingestion gave it from the full text: the stored text
    is only the summary, so re-rating it would move the band (and its counters) on every reprocess.
    """
    kept = stored_band(item)
    if item.get('pii_policy') == PII_SUMMARY_ONLY and kept != USEFULNESS_UNRATED:
        return kept
    return item_usefulness(reprocessed)


def keep_then_update(feedback_table: Any, item: dict, update: dict, changed: dict, actor: dict) -> None:
    """Keep the review AS IT WAS (E-C1, never fails the change), then update it in place."""
    changed_fields = sorted(field for field, value in changed.items() if item.get(field) != value)
    silver_provenance.keep_silver_version(item, actor=actor, reason=SILVER_REASON, changed_fields=changed_fields)
    feedback_table.update_item(**update)


def enrichment_stamps(mode: str, actor: dict, now: str, llm_metadata: dict | None) -> dict:
    """The provenance and change stamps of a re-derived review."""
    return {
        **silver_provenance.provenance(ENRICHMENT_MODES[mode], llm_metadata=llm_metadata, at=now),
        **change_stamps(actor, now),
    }


def rate_usefulness(feedback_table: Any, item: dict, band: str, actor: dict | None = None) -> str:
    """Store ``band`` when the review's stored band differs; ``updated`` / ``unchanged``.

    A band-only write re-derives nothing with a model, so it carries the change
    stamps but no new provenance.
    """
    if item.get(USEFULNESS_FIELD) == band:
        return 'unchanged'
    actor = actor or job_actor({})
    update = build_usefulness_update(item, band, change_stamps(actor, now_iso()))
    keep_then_update(feedback_table, item, update, {USEFULNESS_FIELD: band}, actor)
    return 'updated'


def reprocess_dimensions(
    feedback_table: Any, item: dict, dimensions_config: list[dict], categories_config: list[dict],
    actor: dict | None = None,
) -> str:
    """Re-infer one review's AI dimensions (and its usefulness band); the outcome counter to record.

    Locked values (source / profile / manual) are kept (``shared.feedback_dimensions``).
    """
    text = item.get('normalized_text') or item.get('original_text') or ''
    if not isinstance(text, str) or not text.strip():
        return 'failed'
    actor = actor or job_actor({})
    recorder = AnswerRecorder()
    answer = classify_dimensions(_prompt_record(item), text, dimensions_config, converse_fn=recorder)
    dimensions, sources = reinfer_dimensions(
        dimensions_config, item,
        product=category_product(categories_config, item.get('category')), ai=answer,
    )
    band = reprocess_band(item, {**item, 'dimensions': dimensions})
    if dimensions == _stored_map(item, 'dimensions') and sources == _stored_map(item, 'dimension_sources'):
        return rate_usefulness(feedback_table, item, band, actor)
    now = now_iso()
    stamps = enrichment_stamps(jobs.MODE_DIMENSIONS, actor, now, recorder.metadata())
    update = build_dimensions_update(item, dimensions, sources, now, band, stamps)
    changed = {'dimensions': dimensions or None, 'dimension_sources': sources or None, USEFULNESS_FIELD: band}
    keep_then_update(feedback_table, item, update, changed, actor)
    return 'updated'


def reprocess_item(
    feedback_table: Any, item: dict, job: dict, categories_config: list[dict], counters: dict,
    dimensions_config: list[dict] | None = None,
) -> None:
    """Reprocess one review and record its outcome.

    ``BedrockThrottlingError`` propagates with nothing recorded (the caller
    hands over and the review is retried by the next invocation).
    """
    include_manual = job.get('include_manual') is True
    mode = job.get('mode')
    actor = job_actor(job)
    # A manual CATEGORY correction only matters to the modes that move the category.
    if mode != jobs.MODE_DIMENSIONS and item.get('category_source') == CATEGORY_SOURCE_MANUAL \
            and not include_manual:
        _record(counters, 'skipped_manual')
        return
    try:
        if mode == jobs.MODE_DIMENSIONS:
            _record(counters, reprocess_dimensions(
                feedback_table, item, dimensions_config or [], categories_config, actor))
            return
        _record(counters, _recategorise(feedback_table, item, job, categories_config, counters))
    except BedrockThrottlingError:
        raise
    except Exception as e:
        if is_conditional_check_failure(e):
            # Changed under us — in practice a manual correction, which wins.
            _record(counters, 'skipped_manual')
            return
        logger.warning(
            "Reprocess failed for one review",
            extra={'feedback_id': item.get('feedback_id'), 'error_type': type(e).__name__},
        )
        _record(counters, 'failed')


def _recategorise(feedback_table: Any, item: dict, job: dict, categories_config: list[dict], counters: dict) -> str:
    """The processed / raw modes for one review; the outcome counter to record."""
    mode = str(job.get('mode'))
    actor = job_actor(job)
    if mode == jobs.MODE_RAW:
        raw_record, archived = raw_input_for(item)
        if not archived:
            note_raw_fallback(counters, item)
        attributes = raw_attributes(item, categories_config, raw_record)
        llm_metadata = attributes.pop('llm_metadata', None) if attributes else None
    else:
        recorder = AnswerRecorder()
        attributes = processed_attributes(item, categories_config, recorder)
        llm_metadata = recorder.metadata()
        if attributes and attributes['category'] == item.get('category') \
                and attributes['subcategory'] == item.get('subcategory'):
            # The category stays; the band may still be missing (a pre-band review).
            return rate_usefulness(feedback_table, item, reprocess_band(item, item), actor)
    if attributes is None:
        return 'failed'
    attributes = {**attributes, USEFULNESS_FIELD: reprocess_band(item, {**item, **attributes})}
    now = now_iso()
    stamped = {**attributes, **enrichment_stamps(mode, actor, now, llm_metadata)}
    update = build_update(item, stamped, job.get('include_manual') is True, now)
    keep_then_update(feedback_table, item, update, attributes, actor)
    return 'updated'


# ============================================
# Job loop
# ============================================

def _hand_over(
    context: Any, job_id: str, cursor: dict | None, throttle_restarts: int, worker_token: str,
) -> None:
    event: dict = {'job_id': job_id, 'throttle_restarts': throttle_restarts, 'worker_token': worker_token}
    if cursor:
        event['cursor'] = cursor
    invoke_lambda_async(context.function_name, event)


def _time_left(context: Any) -> bool:
    return context.get_remaining_time_in_millis() > TIME_RESERVE_MS


def run_job(event: dict, context: Any) -> dict:
    job_id = event.get('job_id')
    if not isinstance(job_id, str) or not jobs.is_job_id(job_id):
        logger.error("Reprocess event without a valid job_id")
        return {'status': 'ignored'}
    feedback_table, aggregates_table = _tables()

    previous_token = event.get('worker_token')
    token = jobs.new_worker_token()
    job = jobs.claim_job(
        aggregates_table, job_id, token,
        previous_token=previous_token if isinstance(previous_token, str) else None,
    )
    if job is None:
        logger.info("Reprocess job is not active or owned by another delivery; nothing to do",
                    extra={'job_id': job_id})
        return {'status': 'not_active'}

    counters = _job_counters(job)
    cursor = event.get('cursor') or job.get('cursor') or None
    throttle_restarts = int(event.get('throttle_restarts', 0))
    try:
        return _reprocess_pages(
            feedback_table, aggregates_table, context, job_id, job, counters, cursor, throttle_restarts, token,
        )
    except Exception as e:
        # Error type only, like the per-review log: an exception message or traceback
        # can quote review text (a Bedrock/Comprehend refusal echoes its input).
        logger.error("Category reprocess job failed", extra={'job_id': job_id, 'error_type': type(e).__name__})
        jobs.finish_job(aggregates_table, job_id, jobs.STATUS_FAILED, counters=counters,
                        error=f'Reprocess failed ({type(e).__name__})', worker_token=token)
        return {'status': jobs.STATUS_FAILED}
    finally:
        # Completion, hand-over, cancel or failure: whatever this invocation rewrote is
        # visible to cached reads from now on (docs/caching.md).
        bump_data_version(aggregates_table)


def _job_counters(job: dict) -> dict:
    """The job's progress so far: every counter, plus the raw-fallback sources as a set."""
    counters: dict = {name: int(job.get(name, 0)) for name in jobs.ALL_COUNTERS}
    stored = job.get('raw_fallback_sources')
    counters['raw_fallback_sources'] = {s for s in stored if isinstance(s, str)} if isinstance(stored, list) else set()
    return counters


def _reprocess_pages(
    feedback_table: Any, aggregates_table: Any, context: Any, job_id: str, job: dict, counters: dict,
    cursor: dict | None, throttle_restarts: int, token: str,
) -> dict:
    """Walk the scan from ``cursor`` until the job finishes, hands over or is cancelled."""
    categories_config = load_categories_config(aggregates_table)
    dimensions_config = load_dimensions_config(aggregates_table) if job.get('mode') == jobs.MODE_DIMENSIONS else []
    if jobs.record_config(aggregates_table, job, job_config(aggregates_table, categories_config), token) is None:
        logger.info("Reprocess job cancelled or claimed by another delivery", extra={'job_id': job_id})
        return {'status': jobs.STATUS_CANCELLED}
    job_slice = slice_from_job(job)
    window = job_slice.window(datetime.now(UTC))
    while True:
        page = scan_page(feedback_table, cursor, job_slice, window)
        for item in page.get('Items', []):
            if not slice_admits(item, job_slice, window):
                cursor = {'pk': item['pk'], 'sk': item['sk']}
                continue
            if counters['scanned'] >= jobs.MAX_REPROCESS_ITEMS:
                return _finish_at_ceiling(aggregates_table, job_id, counters, token, cursor)
            if not _time_left(context):
                return _checkpoint_and_hand_over(aggregates_table, context, job_id, counters, cursor, 0, token)
            try:
                reprocess_item(feedback_table, item, job, categories_config, counters, dimensions_config)
            except BedrockThrottlingError:
                if throttle_restarts >= MAX_THROTTLE_RESTARTS:
                    jobs.finish_job(aggregates_table, job_id, jobs.STATUS_FAILED, counters=counters,
                                    error='Bedrock kept throttling; try again later', worker_token=token)
                    return {'status': jobs.STATUS_FAILED}
                return _checkpoint_and_hand_over(
                    aggregates_table, context, job_id, counters, cursor, throttle_restarts + 1, token,
                )
            cursor = {'pk': item['pk'], 'sk': item['sk']}
            throttle_restarts = 0
        cursor = page.get('LastEvaluatedKey') or None
        if cursor is None:
            jobs.finish_job(aggregates_table, job_id, jobs.STATUS_COMPLETED, counters=counters,
                            worker_token=token)
            metrics.add_metric(name="CategoryReprocessCompleted", unit="Count", value=1)
            return {'status': jobs.STATUS_COMPLETED, **_result_counters(counters)}
        if jobs.checkpoint(aggregates_table, job_id, counters, cursor, token) is None:
            logger.info("Reprocess job cancelled or claimed by another delivery", extra={'job_id': job_id})
            return {'status': jobs.STATUS_CANCELLED}
        # Each page checkpoint publishes that page's rewrites to the cached reads.
        bump_data_version(aggregates_table)


def _result_counters(counters: dict) -> dict:
    """The counters as the invocation's result (the source set as a sorted list)."""
    return {**counters, 'raw_fallback_sources': sorted(counters.get('raw_fallback_sources') or ())}


def _finish_at_ceiling(aggregates_table: Any, job_id: str, counters: dict, token: str, cursor: dict | None) -> dict:
    """End the job 'partial' at the ceiling; ``cursor`` (the last review done) is where a resume starts."""
    logger.warning("Reprocess job reached its item ceiling", extra={'job_id': job_id})
    jobs.finish_job(aggregates_table, job_id, jobs.STATUS_PARTIAL, counters=counters,
                    worker_token=token, stopped_at_ceiling=True, resume_from=cursor)
    metrics.add_metric(name="CategoryReprocessStoppedAtCeiling", unit="Count", value=1)
    return {'status': jobs.STATUS_PARTIAL, 'stopped_at_ceiling': True, **_result_counters(counters)}


def _checkpoint_and_hand_over(
    aggregates_table: Any, context: Any, job_id: str, counters: dict, cursor: dict | None,
    throttle_restarts: int, token: str,
) -> dict:
    if jobs.checkpoint(aggregates_table, job_id, counters, cursor, token) is None:
        return {'status': jobs.STATUS_CANCELLED}
    _hand_over(context, job_id, cursor, throttle_restarts, token)
    return {'status': 'continued', **_result_counters(counters)}


@instrumented_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return run_job(event, context)
