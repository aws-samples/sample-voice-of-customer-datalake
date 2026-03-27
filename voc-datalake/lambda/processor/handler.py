"""
VoC Feedback Processor Lambda
Processes raw feedback from SQS, enriches with LLM insights, writes to DynamoDB.

Uses Powertools Idempotency to prevent duplicate processing on SQS retries.
Validates incoming messages using Pydantic schemas before processing.
"""
import json
import os

import sys
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from aws_lambda_powertools.utilities.batch import BatchProcessor, EventType, batch_processor
from aws_lambda_powertools.utilities.data_classes.sqs_event import SQSRecord

# Add plugins directory to path for schema imports
plugins_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'plugins')
sys.path.insert(0, plugins_dir)

# Shared module imports
from shared.logging import logger, tracer, metrics
from shared.aws import get_dynamodb_resource
from shared.converse import converse, BedrockThrottlingError
from shared.api import get_raw_categories_config
from shared.idempotency import (
    get_persistence_layer,
    get_idempotency_config,
    idempotent_function,
    IdempotencyAlreadyInProgressError,
)
import boto3

# Import validation schemas from plugins
try:
    from _shared.schemas import safe_validate_message, MessageValidationError
    VALIDATION_ENABLED = True
except ImportError:
    logger.warning("Could not import validation schemas - validation disabled")
    VALIDATION_ENABLED = False
    safe_validate_message = None  # noqa: N816
    MessageValidationError = None  # noqa: N816

# AWS Clients (using shared module for connection reuse)
dynamodb = get_dynamodb_resource()
comprehend = boto3.client('comprehend')
translate = boto3.client('translate')

# Configuration
FEEDBACK_TABLE = os.environ['FEEDBACK_TABLE']
AGGREGATES_TABLE = os.environ['AGGREGATES_TABLE']
IDEMPOTENCY_TABLE = os.environ.get('IDEMPOTENCY_TABLE', '')
PRIMARY_LANGUAGE = os.environ.get('PRIMARY_LANGUAGE', 'en')
# Processor uses Haiku for cost efficiency (processes many items)
PROCESSOR_MODEL_ID = os.environ.get('BEDROCK_MODEL_ID', 'global.anthropic.claude-haiku-4-5-20251001-v1:0')
PROMPT_VERSION = '1.0.0'

# Logs configuration - max entries to keep per source
MAX_LOG_ENTRIES = 100

feedback_table = dynamodb.Table(FEEDBACK_TABLE)
aggregates_table = dynamodb.Table(AGGREGATES_TABLE)

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

def log_validation_failure(source_platform: str, message_id: str, errors: list[str], raw_preview: str):
    """
    Log a validation failure to DynamoDB for user visibility.
    
    Stores in aggregates table with TTL for automatic cleanup.
    """
    if not aggregates_table:
        logger.warning("Cannot log validation failure - aggregates table not configured")
        return
    
    try:
        now = datetime.now(timezone.utc)
        log_entry = {
            'pk': f"LOGS#validation#{source_platform}",
            'sk': f"{now.isoformat()}#{message_id[:32]}",
            'log_type': 'validation_failure',
            'source_platform': source_platform,
            'message_id': message_id,
            'errors': errors,
            'raw_preview': raw_preview[:500],  # Truncate for storage
            'timestamp': now.isoformat(),
            'ttl': int(now.timestamp()) + (7 * 24 * 60 * 60),  # 7 days TTL
        }
        aggregates_table.put_item(Item=log_entry)
        logger.info(f"Logged validation failure for {source_platform}/{message_id}")
    except Exception as e:
        logger.error(f"Failed to log validation failure: {e}")
def log_processing_error(source_platform: str, message_id: str, error_type: str, error_message: str):
    """
    Log a processing error to DynamoDB for user visibility.
    """
    if not aggregates_table:
        return
    
    try:
        now = datetime.now(timezone.utc)
        log_entry = {
            'pk': f"LOGS#processing#{source_platform}",
            'sk': f"{now.isoformat()}#{message_id[:32]}",
            'log_type': 'processing_error',
            'source_platform': source_platform,
            'message_id': message_id,
            'error_type': error_type,
            'error_message': error_message[:1000],
            'timestamp': now.isoformat(),
            'ttl': int(now.timestamp()) + (7 * 24 * 60 * 60),  # 7 days TTL
        }
        aggregates_table.put_item(Item=log_entry)
    except Exception as e:
        logger.error(f"Failed to log processing error: {e}")
def validate_sqs_message(raw_record: dict) -> tuple[dict | None, list[str]]:
    """
    Validate an SQS message using Pydantic schemas.
    
    Returns:
        Tuple of (validated dict or None, list of errors)
    """
    if not VALIDATION_ENABLED:
        return raw_record, []
    
    validated_msg, errors = safe_validate_message(raw_record)
    
    if errors:
        source_platform = raw_record.get('source_platform', 'unknown')
        message_id = raw_record.get('id', 'unknown')
        raw_preview = json.dumps(raw_record, default=str)[:500]
        
        log_validation_failure(source_platform, message_id, errors, raw_preview)
        metrics.add_metric(name="ValidationFailures", unit="Count", value=1)
        
        return None, errors
    
    # Convert validated Pydantic model back to dict
    return validated_msg.model_dump(mode='json', exclude_none=True), []

# LLM Prompts
SYSTEM_PROMPT = """You are an expert customer experience analyst. Analyze feedback and return ONLY valid JSON:
- Be objective and accurate
- Never invent PII
- Use exact enum values specified
- Keep summaries under 500 chars"""

# Default categories (used if DynamoDB config not available)
DEFAULT_CATEGORIES = "delivery|customer_support|product_quality|pricing|website|app|billing|returns|communication|other"

USER_PROMPT_TEMPLATE = """Analyze this feedback and return JSON:

Source: {source_platform} | Channel: {source_channel} | Rating: {rating}
Text: {original_text}

{categories_instruction}

Return ONLY this JSON structure:
{{"category":"<one of the categories above>","subcategory":"string or null","journey_stage":"awareness|consideration|purchase|delivery|usage|support|retention|advocacy|unknown","sentiment_label":"positive|neutral|negative|mixed","sentiment_score":-1.0 to 1.0,"urgency":"low|medium|high","impact_area":"product|operations|cx|tech|pricing|brand|legal|other","problem_summary":"string or null","problem_root_cause_hypothesis":"string or null","direct_customer_quote":"string or null","persona":{{"name":"string or null","type":"existing_customer|prospect|churn_risk|advocate|unknown|null","attributes":{{"inferred_segment":"string or null","confidence":"low|medium|high"}}}}}}"""

# Cache for primary language setting
_language_cache = None
_language_cache_time = None
LANGUAGE_CACHE_TTL = 300  # 5 minutes
@tracer.capture_method
def get_primary_language() -> str:
    """Fetch primary language setting from DynamoDB with caching.
    Falls back to PRIMARY_LANGUAGE env var if not configured."""
    global _language_cache, _language_cache_time

    now = datetime.now(timezone.utc).timestamp()

    if _language_cache is not None and _language_cache_time and (now - _language_cache_time) < LANGUAGE_CACHE_TTL:
        return _language_cache

    try:
        response = aggregates_table.get_item(
            Key={'pk': 'SETTINGS#review', 'sk': 'config'}
        )
        item = response.get('Item')
        if item and item.get('primary_language'):
            _language_cache = item['primary_language']
            _language_cache_time = now
            logger.info(f"Loaded primary language from DynamoDB: {_language_cache}")
            return _language_cache
    except Exception as e:
        logger.warning(f"Could not fetch primary language from DynamoDB: {e}")

    # Fallback to env var
    _language_cache = PRIMARY_LANGUAGE
    _language_cache_time = now
    logger.info(f"Using default primary language: {_language_cache}")
    return _language_cache
@tracer.capture_method
def get_categories_config() -> list:
    """Fetch categories configuration from DynamoDB with caching."""
    return get_raw_categories_config(aggregates_table)
def build_categories_instruction() -> str:
    """Build the categories instruction for the LLM prompt."""
    categories_config = get_categories_config()
    
    # Fallback to defaults if no categories configured
    if not categories_config:
        logger.info("No custom categories configured, using defaults")
        default_cats = DEFAULT_CATEGORIES.split('|')
        return f"Available categories (you MUST use ONLY one of these exact values): {' | '.join(default_cats)}\n\nIMPORTANT: The category field MUST be one of: {', '.join(default_cats)}. Do NOT use any other category value."
    
    # Build detailed instruction with categories and subcategories
    lines = ["Available categories and their subcategories:"]
    category_names = []
    
    for cat in categories_config:
        cat_name = cat.get('name', '')
        cat_desc = cat.get('description', cat_name)
        category_names.append(cat_name)
        
        subcats = cat.get('subcategories', [])
        if subcats:
            subcat_names = [s.get('name', '') for s in subcats]
            lines.append(f"- {cat_name} ({cat_desc}): subcategories = {', '.join(subcat_names)}")
        else:
            lines.append(f"- {cat_name} ({cat_desc})")
    
    lines.append(f"\nIMPORTANT: The category field MUST be one of these exact values: {' | '.join(category_names)}")
    lines.append("Do NOT use 'other' unless it is explicitly listed above. Do NOT invent new categories.")
    
    instruction = '\n'.join(lines)
    logger.info(f"Built categories instruction with {len(category_names)} categories: {category_names}")
    return instruction

processor = BatchProcessor(event_type=EventType.SQS)
@tracer.capture_method
def detect_language(text: str) -> str:
    """Detect dominant language using Comprehend."""
    try:
        response = comprehend.detect_dominant_language(Text=text[:5000])
        languages = response.get('Languages', [])
        return languages[0]['LanguageCode'] if languages else 'en'
    except Exception as e:
        logger.warning(f"Language detection failed: {e}")
        return 'en'
@tracer.capture_method
def translate_text(text: str, source_lang: str, target_lang: str) -> str:
    """Translate text if needed."""
    if source_lang == target_lang:
        return text
    try:
        response = translate.translate_text(
            Text=text[:5000],
            SourceLanguageCode=source_lang,
            TargetLanguageCode=target_lang
        )
        return response['TranslatedText']
    except Exception as e:
        logger.warning(f"Translation failed: {e}")
        return text
@tracer.capture_method
def get_comprehend_sentiment(text: str, language: str) -> dict:
    """Get sentiment from Comprehend."""
    try:
        supported = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ar', 'hi', 'ja', 'ko', 'zh', 'zh-TW']
        lang = language if language in supported else 'en'
        response = comprehend.detect_sentiment(Text=text[:5000], LanguageCode=lang)
        scores = response.get('SentimentScore', {})
        score = scores.get('Positive', 0) - scores.get('Negative', 0)
        sentiment_map = {'POSITIVE': 'positive', 'NEGATIVE': 'negative', 'NEUTRAL': 'neutral', 'MIXED': 'mixed'}
        return {'label': sentiment_map.get(response['Sentiment'], 'neutral'), 'score': round(score, 3)}
    except Exception as e:
        logger.warning(f"Comprehend sentiment failed: {e}")
        return {'label': 'neutral', 'score': 0.0}
@tracer.capture_method
def invoke_bedrock_llm(raw_record: dict, raise_on_throttle: bool = True) -> dict:
    """
    Invoke Bedrock LLM for structured insights using shared converse module.
    
    Args:
        raw_record: The feedback record to analyze
        raise_on_throttle: If True, raise exception on throttling to trigger SQS retry
    """
    start_time = datetime.now(timezone.utc)
    
    # Build categories instruction from DynamoDB config
    categories_instruction = build_categories_instruction()
    
    user_prompt = USER_PROMPT_TEMPLATE.format(
        source_platform=raw_record.get('source_platform', 'unknown'),
        source_channel=raw_record.get('source_channel', 'unknown'),
        rating=raw_record.get('rating', 'N/A'),
        original_text=raw_record.get('text', '')[:3000],
        categories_instruction=categories_instruction
    )
    
    try:
        content = converse(
            prompt=user_prompt,
            system_prompt=SYSTEM_PROMPT,
            max_tokens=800,
            temperature=0.1,
            model_id=PROCESSOR_MODEL_ID,
            max_retries=5,
            raise_on_throttle=raise_on_throttle,
        )
        
        logger.debug(f"Bedrock raw response: {content[:500]}")
        
        # Parse JSON from response
        parsed_content = _parse_llm_json_response(content)
        llm_result = json.loads(parsed_content)
        latency_ms = int((datetime.now(timezone.utc) - start_time).total_seconds() * 1000)
        
        return {
            'insights': llm_result,
            'metadata': {
                'model_name': PROCESSOR_MODEL_ID,
                'prompt_version': PROMPT_VERSION,
                'latency_ms': latency_ms,
            }
        }
        
    except BedrockThrottlingError:
        # Re-raise for SQS retry
        raise
        
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse Bedrock response: {e}")
        return {
            'insights': {},
            'metadata': {'error': str(e)}
        }
        
    except Exception as e:
        logger.error(f"Unexpected Bedrock error: {e}")
        return {
            'insights': {},
            'metadata': {'error': str(e)}
        }
def _parse_llm_json_response(content: str) -> str:
    """
    Parse JSON from LLM response, handling markdown code blocks.
    
    Args:
        content: Raw LLM response text
        
    Returns:
        Cleaned JSON string
    """
    content = content.strip()
    
    # Strip markdown code block wrapper if present
    if content.startswith('```'):
        first_newline = content.find('\n')
        if first_newline != -1:
            content = content[first_newline + 1:]
        content = content.strip()
        if content.endswith('```'):
            content = content[:-3].strip()
    
    # Fallback: find JSON object boundaries
    if not content.startswith('{'):
        json_start = content.find('{')
        json_end = content.rfind('}')
        if json_start != -1 and json_end != -1:
            content = content[json_start:json_end + 1]
            logger.info(f"Extracted JSON from position {json_start} to {json_end}")
    
    return content

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
        # Primary: use source-provided ID (most reliable)
        content = f"{source_platform}:{source_id}"
    else:
        # Fallback: generate ID from content signature
        # Use text hash (first 500 chars to handle minor variations)
        # MD5 used only for content fingerprinting (not security), marked explicitly
        text_hash = hashlib.sha256(text[:500].encode(), usedforsecurity=False).hexdigest()[:16] if text else ''
        # Include created_at (review date) to differentiate reviews with similar text
        # Include URL for additional uniqueness
        content = f"{source_platform}:{created_at}:{text_hash}:{url}"
        logger.info(f"Generated fallback ID for {source_platform} (no source_id): text_hash={text_hash}")
    
    return hashlib.sha256(content.encode()).hexdigest()[:32]
@tracer.capture_method
def check_duplicate(source_platform: str, feedback_id: str) -> bool:
    """Check if feedback already exists in DynamoDB."""
    try:
        response = feedback_table.get_item(
            Key={'pk': f"SOURCE#{source_platform}", 'sk': f"FEEDBACK#{feedback_id}"},
            ProjectionExpression='feedback_id'
        )
        return 'Item' in response
    except Exception as e:
        logger.warning(f"Duplicate check failed: {e}")
        return False
@tracer.capture_method
def process_feedback(raw_record: dict, idempotency_key: str = None) -> dict:
    """
    Process a single feedback record with idempotency protection.
    
    The idempotency_key is derived from source_platform + source_id to ensure
    the same feedback item is never processed twice, even across SQS retries.
    """
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    date_str = now.strftime('%Y-%m-%d')
    
    source_platform = raw_record.get('source_platform', 'unknown')
    source_id = raw_record.get('id', '')
    
    # Resolve source_display early - used as PK for both duplicate check and write
    brand_name = raw_record.get('brand_name', '')
    source_display = brand_name if brand_name else source_platform
    
    # Generate deterministic ID based on source to prevent duplicates
    original_text = raw_record.get('text', '')
    created_at_raw = raw_record.get('created_at', '')
    url = raw_record.get('url', '')
    feedback_id = generate_deterministic_id(source_platform, source_id, original_text, created_at_raw, url)
    
    # Check for duplicate before expensive LLM/Comprehend/Translate processing
    # Uses source_display (brand_name) to match the PK used when writing items
    if check_duplicate(source_display, feedback_id):
        logger.info(f"Skipping duplicate feedback: {source_display}/{source_id}")
        metrics.add_metric(name="DuplicatesSkipped", unit="Count", value=1)
        return None
    
    original_language = detect_language(original_text)
    target_language = get_primary_language()
    normalized_text = translate_text(original_text, original_language, target_language)
    sentiment = get_comprehend_sentiment(normalized_text, target_language)
    llm_result = invoke_bedrock_llm(raw_record)
    insights = llm_result.get('insights', {})
    persona = insights.get('persona', {})
    
    # Use preset category from feedback form if provided, otherwise use LLM result
    preset_category = raw_record.get('preset_category', '')
    preset_subcategory = raw_record.get('preset_subcategory', '')
    category = preset_category if preset_category else insights.get('category', 'other')
    subcategory_from_llm = insights.get('subcategory')
    
    urgency = insights.get('urgency', 'low')
    sentiment_score = insights.get('sentiment_score', sentiment['score'])
    
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
        'source_platform': source_platform,
        'source_channel': raw_record.get('source_channel', 'unknown'),
        'source_url': raw_record.get('url'),
        'brand_name': source_display,
        'source_created_at': raw_record.get('created_at'),
        'ingested_at': raw_record.get('ingested_at'),
        'processed_at': now_iso,
        'date': date_str,
        
        'original_text': original_text,
        'original_language': original_language,
        'normalized_text': normalized_text if original_language != target_language else None,
        'rating': raw_record.get('rating'),
        
        'category': category,
        'subcategory': preset_subcategory if preset_subcategory else subcategory_from_llm,
        'journey_stage': insights.get('journey_stage', 'unknown'),
        'sentiment_label': insights.get('sentiment_label', sentiment['label']),
        'sentiment_score': Decimal(str(round(sentiment_score, 3))),
        'urgency': urgency,
        'impact_area': insights.get('impact_area', 'other'),
        'problem_summary': insights.get('problem_summary'),
        'problem_root_cause_hypothesis': insights.get('problem_root_cause_hypothesis'),
        'direct_customer_quote': insights.get('direct_customer_quote'),
        
        'persona_name': persona.get('name'),
        'persona_type': persona.get('type'),
        'persona_attributes': persona.get('attributes'),
        
        'llm_metadata': llm_result.get('metadata', {}),
        
        # TTL: 1 year
        'ttl': int((now.timestamp()) + 365 * 24 * 60 * 60)
    }
    
    # Remove None values
    item = {k: v for k, v in item.items() if v is not None}
    
    return item
def write_to_dynamodb(item: dict):
    """Write processed feedback to DynamoDB."""
    feedback_table.put_item(Item=item)
    logger.info(f"Wrote feedback {item['feedback_id']} to DynamoDB")
def record_handler(record: SQSRecord) -> dict:
    """
    Process a single SQS record with idempotency protection.
    
    Uses the message body's source_platform + id as the idempotency key to ensure
    the same feedback is never processed twice, even on SQS retries.
    
    If Bedrock is throttled after retries, raises exception to keep message in queue.
    SQS visibility timeout will make it available for retry later.
    """
    raw_record = json.loads(record.body)
    source_platform = raw_record.get('source_platform', 'unknown')
    source_id = raw_record.get('id', 'unknown')
    
    # Validate the message before processing
    validated_record, validation_errors = validate_sqs_message(raw_record)
    if validation_errors:
        logger.warning(f"Validation failed for {source_platform}/{source_id}: {validation_errors}")
        # Emit metric so validation drops are visible in CloudWatch dashboards/alarms
        metrics.add_metric(name="ValidationDropped", unit="Count", value=1)
        metrics.add_dimension(name="SourcePlatform", value=source_platform)
        # Return success to remove from queue - invalid messages shouldn't be retried
        # Validation failures are persisted via log_validation_failure() in validate_sqs_message()
        return {"status": "skipped", "reason": "validation_failed", "errors": validation_errors}
    
    # Use validated record for processing
    raw_record = validated_record
    
    # Create idempotency key from source + id
    idempotency_key = f"{source_platform}:{source_id}"
    
    logger.info(f"Processing feedback from {source_platform}/{source_id}")
    
    try:
        # Use idempotent wrapper if configured
        if persistence_layer and idempotency_config:
            processed_item = _process_feedback_idempotent(
                raw_record=raw_record,
                idempotency_key=idempotency_key
            )
        else:
            processed_item = process_feedback(raw_record)
        
        # Skip if duplicate was detected
        if processed_item is None:
            return {"status": "skipped", "reason": "duplicate"}
        
        write_to_dynamodb(processed_item)
        
        metrics.add_metric(name="FeedbackProcessed", unit="Count", value=1)
        
        # Check if LLM enrichment succeeded
        if processed_item.get('llm_metadata', {}).get('error'):
            metrics.add_metric(name="FeedbackProcessedWithoutLLM", unit="Count", value=1)
        else:
            metrics.add_metric(name="FeedbackProcessedWithLLM", unit="Count", value=1)
        
        return {"status": "success", "feedback_id": processed_item['feedback_id']}
    
    except IdempotencyAlreadyInProgressError:
        # Another Lambda is processing this same record - skip
        logger.info(f"Idempotency: {idempotency_key} already in progress, skipping")
        metrics.add_metric(name="IdempotencySkipped", unit="Count", value=1)
        return {"status": "skipped", "reason": "idempotency_in_progress"}
        
    except BedrockThrottlingError as e:
        # Re-raise to fail this record - SQS will retry after visibility timeout
        logger.warning(f"Bedrock throttled for {source_platform}, message will be retried by SQS")
        metrics.add_metric(name="BedrockThrottleRetry", unit="Count", value=1)
        log_processing_error(source_platform, source_id, "bedrock_throttling", str(e))
        raise
    
    except Exception as e:
        # Log unexpected errors for visibility
        logger.exception(f"Unexpected error processing {source_platform}/{source_id}: {e}")
        log_processing_error(source_platform, source_id, type(e).__name__, str(e))
        raise
def _process_feedback_idempotent(raw_record: dict, idempotency_key: str) -> dict:
    """
    Wrapper to apply idempotency decorator dynamically.
    
    The @idempotent_function decorator ensures this function's result is cached
    and returned on subsequent calls with the same idempotency_key.
    """
    @idempotent_function(
        data_keyword_argument="idempotency_key",
        persistence_store=persistence_layer,
        config=idempotency_config,
    )
    def _inner(raw_record: dict, idempotency_key: str) -> dict:
        return process_feedback(raw_record, idempotency_key)
    
    return _inner(raw_record=raw_record, idempotency_key=idempotency_key)
@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
@batch_processor(record_handler=record_handler, processor=processor)
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return processor.response()
