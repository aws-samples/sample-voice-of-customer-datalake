"""
VoC Feedback Processor Lambda
Processes raw feedback from SQS, enriches with LLM insights, writes to DynamoDB.
"""
import json
import os
import uuid
import random
import time
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from aws_lambda_powertools.utilities.batch import BatchProcessor, EventType, batch_processor
from aws_lambda_powertools.utilities.batch.exceptions import BatchProcessingError
from aws_lambda_powertools.utilities.data_classes.sqs_event import SQSRecord
from botocore.exceptions import ClientError

# Shared module imports
from shared.logging import logger, tracer, metrics
from shared.aws import get_dynamodb_resource, get_bedrock_client
import boto3

# Retry configuration for Bedrock
BEDROCK_MAX_RETRIES = 5
BEDROCK_BASE_DELAY = 1.0  # seconds
BEDROCK_MAX_DELAY = 30.0  # seconds

# AWS Clients (using shared module for connection reuse)
dynamodb = get_dynamodb_resource()
bedrock_runtime = get_bedrock_client()
comprehend = boto3.client('comprehend')
translate = boto3.client('translate')

# Configuration
FEEDBACK_TABLE = os.environ['FEEDBACK_TABLE']
AGGREGATES_TABLE = os.environ['AGGREGATES_TABLE']
PRIMARY_LANGUAGE = os.environ.get('PRIMARY_LANGUAGE', 'en')
# Processor uses Haiku for cost efficiency (processes many items)
PROCESSOR_MODEL_ID = os.environ.get('BEDROCK_MODEL_ID', 'global.anthropic.claude-haiku-4-5-20250514-v1:0')
PROMPT_VERSION = '1.0.0'

feedback_table = dynamodb.Table(FEEDBACK_TABLE)
aggregates_table = dynamodb.Table(AGGREGATES_TABLE)

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

# Cache for categories config
_categories_cache = None
_categories_cache_time = None
CATEGORIES_CACHE_TTL = 300  # 5 minutes


@tracer.capture_method
def get_categories_config() -> list:
    """Fetch categories configuration from DynamoDB with caching."""
    global _categories_cache, _categories_cache_time
    
    now = datetime.now(timezone.utc).timestamp()
    
    # Return cached if still valid
    if _categories_cache is not None and _categories_cache_time and (now - _categories_cache_time) < CATEGORIES_CACHE_TTL:
        return _categories_cache
    
    try:
        # Fetch from aggregates table (same location as settings API saves)
        response = aggregates_table.get_item(
            Key={'pk': 'SETTINGS#categories', 'sk': 'config'}
        )
        item = response.get('Item')
        
        if item and item.get('categories'):
            _categories_cache = item.get('categories', [])
            _categories_cache_time = now
            logger.info(f"Loaded {len(_categories_cache)} categories from DynamoDB")
            return _categories_cache
    except Exception as e:
        logger.warning(f"Could not fetch categories from DynamoDB: {e}")
    
    # Cache empty result to avoid repeated failed lookups
    _categories_cache = []
    _categories_cache_time = now
    return []


def build_categories_instruction() -> str:
    """Build the categories instruction for the LLM prompt."""
    categories_config = get_categories_config()
    
    # Fallback to defaults if no categories configured
    if not categories_config:
        logger.info("No custom categories configured, using defaults")
        return f"Available categories: {DEFAULT_CATEGORIES}"
    
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
    
    lines.append(f"\nUse ONLY these category values: {' | '.join(category_names)}")
    
    return '\n'.join(lines)

processor = BatchProcessor(event_type=EventType.SQS)


def decimal_default(obj):
    """Convert floats to Decimal for DynamoDB."""
    if isinstance(obj, float):
        return Decimal(str(round(obj, 6)))
    raise TypeError


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
    Invoke Bedrock LLM for structured insights with exponential backoff retry.
    
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
    
    request_body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 800,
        "temperature": 0.1,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_prompt}]
    }
    
    last_exception = None
    
    for attempt in range(BEDROCK_MAX_RETRIES):
        try:
            response = bedrock_runtime.invoke_model(
                modelId=PROCESSOR_MODEL_ID,
                body=json.dumps(request_body),
                contentType='application/json',
                accept='application/json'
            )
            
            response_body = json.loads(response['body'].read())
            content = response_body.get('content', [{}])[0].get('text', '{}')
            llm_result = json.loads(content)
            latency_ms = int((datetime.now(timezone.utc) - start_time).total_seconds() * 1000)
            
            if attempt > 0:
                logger.info(f"Bedrock succeeded after {attempt + 1} attempts")
            
            return {
                'insights': llm_result,
                'metadata': {
                    'model_name': PROCESSOR_MODEL_ID,
                    'prompt_version': PROMPT_VERSION,
                    'latency_ms': latency_ms,
                    'retry_attempts': attempt
                }
            }
            
        except ClientError as e:
            error_code = e.response.get('Error', {}).get('Code', '')
            last_exception = e
            
            # Retry on throttling or service unavailable
            if error_code in ('ThrottlingException', 'ServiceUnavailableException', 'ModelStreamErrorException'):
                if attempt < BEDROCK_MAX_RETRIES - 1:
                    # Exponential backoff with jitter
                    delay = min(BEDROCK_BASE_DELAY * (2 ** attempt) + random.uniform(0, 1), BEDROCK_MAX_DELAY)
                    logger.warning(f"Bedrock throttled (attempt {attempt + 1}/{BEDROCK_MAX_RETRIES}), retrying in {delay:.2f}s")
                    time.sleep(delay)
                    continue
                else:
                    # Max retries exhausted - let SQS handle retry
                    logger.error(f"Bedrock throttled after {BEDROCK_MAX_RETRIES} attempts, raising for SQS retry")
                    if raise_on_throttle:
                        raise BedrockThrottlingError(f"Bedrock throttled after {BEDROCK_MAX_RETRIES} retries") from e
            else:
                # Non-retryable error
                logger.error(f"Bedrock non-retryable error: {error_code} - {e}")
                break
                
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse Bedrock response: {e}")
            last_exception = e
            break
            
        except Exception as e:
            logger.error(f"Unexpected Bedrock error: {e}")
            last_exception = e
            break
    
    # Return empty insights on non-throttling failures
    return {
        'insights': {},
        'metadata': {
            'error': str(last_exception),
            'retry_attempts': attempt + 1
        }
    }


class BedrockThrottlingError(Exception):
    """Raised when Bedrock is throttled after max retries to trigger SQS retry."""
    pass


def generate_deterministic_id(source_platform: str, source_id: str) -> str:
    """Generate a deterministic feedback ID based on source to prevent duplicates."""
    import hashlib
    content = f"{source_platform}:{source_id}"
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
def process_feedback(raw_record: dict) -> dict:
    """Process a single feedback record."""
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    date_str = now.strftime('%Y-%m-%d')
    
    source_platform = raw_record.get('source_platform', 'unknown')
    source_id = raw_record.get('id', '')
    
    # Generate deterministic ID based on source to prevent duplicates
    feedback_id = generate_deterministic_id(source_platform, source_id)
    
    # Check for duplicate before expensive LLM processing
    if check_duplicate(source_platform, feedback_id):
        logger.info(f"Skipping duplicate feedback: {source_platform}/{source_id}")
        metrics.add_metric(name="DuplicatesSkipped", unit="Count", value=1)
        return None
    
    original_text = raw_record.get('text', '')
    original_language = detect_language(original_text)
    normalized_text = translate_text(original_text, original_language, PRIMARY_LANGUAGE)
    sentiment = get_comprehend_sentiment(normalized_text, PRIMARY_LANGUAGE)
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
    
    # Use brand_name for source display (e.g., "Gucci - Trustpilot"), fallback to source_platform
    brand_name = raw_record.get('brand_name', '')
    source_display = brand_name if brand_name else source_platform
    
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
        'normalized_text': normalized_text if original_language != PRIMARY_LANGUAGE else None,
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
    Process a single SQS record.
    
    If Bedrock is throttled after retries, raises exception to keep message in queue.
    SQS visibility timeout will make it available for retry later.
    """
    raw_record = json.loads(record.body)
    source_platform = raw_record.get('source_platform', 'unknown')
    source_id = raw_record.get('id', 'unknown')
    
    logger.info(f"Processing feedback from {source_platform}/{source_id}")
    
    try:
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
        
    except BedrockThrottlingError as e:
        # Re-raise to fail this record - SQS will retry after visibility timeout
        logger.warning(f"Bedrock throttled for {source_platform}, message will be retried by SQS")
        metrics.add_metric(name="BedrockThrottleRetry", unit="Count", value=1)
        raise


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
@batch_processor(record_handler=record_handler, processor=processor)
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return processor.response()
