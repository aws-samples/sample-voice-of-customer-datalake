"""
Feedback categorisation and enrichment — ONE copy, shared by the feedback
processor (lambda/processor/handler.py) and the category-reprocess worker
(lambda/jobs/category_reprocess/handler.py).

Why it lives in shared/: each Lambda bundle ships its own entry module as a
top-level ``handler.py`` plus ``shared/`` (see the bundling commands in
lib/stacks), so the worker cannot import the processor module. Everything that
decides how a review is classified — the category instruction built from the
admin's configuration, the prompts, the JSON parsing, and the mapping from the
model/Comprehend output to stored attributes — is here, so re-categorising a
stored review and processing a new one cannot drift apart.

AWS clients and the ``converse`` callable are passed IN rather than created
here: the processor keeps its module-level clients (its tests patch them), and
the worker builds its own.
"""
import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from shared.converse import BedrockThrottlingError, converse
from shared.feedback_dimensions import inferable_dimensions
from shared.logging import logger, tracer
from shared.model_config import get_active_model_id

# Where the settings API stores the admin's category configuration.
CATEGORIES_SETTINGS_KEY = {'pk': 'SETTINGS#categories', 'sk': 'config'}

# Used when no categories are configured (moved verbatim from the processor;
# api/test/test_streaming_categories_lockstep.py pins it against shared/api.py).
DEFAULT_CATEGORIES = "delivery|customer_support|product_quality|pricing|website|app|billing|returns|communication|other"
DEFAULT_CATEGORY_NAMES = tuple(DEFAULT_CATEGORIES.split('|'))

# Bumped when the enrichment prompt changes; recorded on llm_metadata.
PROMPT_VERSION = '1.0.0'

# Every enrichment call resolves its model through the per-surface picker.
ENRICHMENT_SURFACE = 'enrichment'

SYSTEM_PROMPT = """You are an expert customer experience analyst. Analyze feedback and return ONLY valid JSON:
- Be objective and accurate
- Never invent PII
- Use exact enum values specified
- Keep summaries under 500 chars"""

USER_PROMPT_TEMPLATE = """Analyze this feedback and return JSON:

Source: {source_platform} | Channel: {source_channel} | Rating: {rating}
Text: {original_text}

{categories_instruction}{dimensions_instruction}

Return ONLY this JSON structure:
{{"category":"<one of the categories above>","subcategory":"string or null","journey_stage":"awareness|consideration|purchase|delivery|usage|support|retention|advocacy|unknown","sentiment_label":"positive|neutral|negative|mixed","sentiment_score":-1.0 to 1.0,"urgency":"low|medium|high","impact_area":"product|operations|cx|tech|pricing|brand|legal|other","problem_summary":"string or null","problem_root_cause_hypothesis":"string or null","direct_customer_quote":"string or null","persona":{{"name":"string or null","type":"existing_customer|prospect|churn_risk|advocate|unknown|null","attributes":{{"inferred_segment":"string or null","confidence":"low|medium|high"}}}}{dimensions_json}}}"""

# Dimension-only inference of an already-processed review (category reprocess,
# ``mode: 'dimensions'``): the same dimensions instruction as full enrichment.
CLASSIFY_DIMENSIONS_PROMPT_TEMPLATE = """Classify this customer feedback along the dimensions below.

Source: {source_platform} | Channel: {source_channel} | Rating: {rating}
Text: {text}{dimensions_instruction}

Return ONLY this JSON structure:
{{{dimensions_object}}}"""

# Prompt-size bounds for the dimensions instruction: a dimension lists at most this
# many values (a dimension may hold 200), with a note that the rest exist.
MAX_PROMPT_DIMENSION_VALUES = 60
# Output tokens the enrichment call gains per inferred dimension.
DIMENSION_OUTPUT_TOKENS = 20
ENRICHMENT_MAX_TOKENS = 800

# Category-only re-classification of an already-processed review. Same system
# prompt and the same category instruction as full enrichment; only the
# requested output is narrower, so one reprocess call costs a fraction of one
# enrichment call.
CLASSIFY_PROMPT_TEMPLATE = """Classify this customer feedback into exactly one category.

Source: {source_platform} | Channel: {source_channel} | Rating: {rating}
Text: {text}

{categories_instruction}

Return ONLY this JSON structure:
{{"category":"<one of the categories above>","subcategory":"<one of that category's subcategories, or null>"}}"""

# Model input bound, shared by both prompts (unchanged from the processor).
MAX_PROMPT_TEXT_CHARS = 3000
# Comprehend / Translate synchronous text limit used by the processor.
MAX_SERVICE_TEXT_CHARS = 5000
COMPREHEND_SENTIMENT_LANGUAGES = frozenset(
    ['en', 'es', 'fr', 'de', 'it', 'pt', 'ar', 'hi', 'ja', 'ko', 'zh', 'zh-TW']
)
# Comprehend's label -> stored label. NEUTRAL is deliberately absent: it is the
# `.get()` default in comprehend_sentiment, so an entry for it would be unobservable.
_SENTIMENT_LABELS = {'POSITIVE': 'positive', 'NEGATIVE': 'negative', 'MIXED': 'mixed'}
MAX_SUBCATEGORY_CHARS = 100


# ============================================
# Category configuration
# ============================================

def load_categories_config(table: Any) -> list[dict]:
    """Read the configured categories (uncached). Raises on a DynamoDB error.

    Entries without a usable ``name`` are dropped: they cannot be offered to the
    model nor matched against its answer.
    """
    item = table.get_item(Key=CATEGORIES_SETTINGS_KEY).get('Item') or {}
    categories = item.get('categories')
    if not isinstance(categories, list):
        return []
    return [
        cat for cat in categories
        if isinstance(cat, dict) and isinstance(cat.get('name'), str) and cat['name']
    ]


def allowed_category_names(categories_config: list[dict]) -> list[str]:
    """The category values the model may answer with."""
    if not categories_config:
        return list(DEFAULT_CATEGORY_NAMES)
    return [cat['name'] for cat in categories_config]


def _subcategory_names(category: dict) -> list[str]:
    subcategories = category.get('subcategories')
    if not isinstance(subcategories, list):
        return []
    return [
        sub['name'] for sub in subcategories
        if isinstance(sub, dict) and isinstance(sub.get('name'), str) and sub['name']
    ]


# Admin-controlled free text interpolated into a prompt (channel, source, dimension and
# category labels / descriptions) is reduced to one bounded line: no newlines (which
# could open a fake instruction block) and no braces (which could fake the JSON contract).
MAX_PROMPT_LABEL_CHARS = 100
MAX_PROMPT_DESCRIPTION_CHARS = 300
_PROMPT_UNSAFE = re.compile(r'[\r\n\t\v\f\u2028\u2029{}]+')


def prompt_safe(value: object, limit: int = MAX_PROMPT_LABEL_CHARS) -> str:
    """``value`` as one line of at most ``limit`` characters, newlines and braces removed."""
    text = _PROMPT_UNSAFE.sub(' ', str(value))
    return ' '.join(text.split())[:limit]


def build_categories_instruction(categories_config: list[dict]) -> str:
    """Build the categories instruction for the LLM prompt."""
    if not categories_config:
        default_cats = DEFAULT_CATEGORY_NAMES
        return (
            f"Available categories (you MUST use ONLY one of these exact values): {' | '.join(default_cats)}\n\n"
            f"IMPORTANT: The category field MUST be one of: {', '.join(default_cats)}. "
            "Do NOT use any other category value."
        )

    lines = ["Available categories and their subcategories:"]
    category_names = []
    for cat in categories_config:
        cat_name = cat['name']  # load_categories_config guarantees a non-empty name
        cat_desc = prompt_safe(cat.get('description') or cat_name, MAX_PROMPT_DESCRIPTION_CHARS)
        category_names.append(cat_name)
        subcat_names = _subcategory_names(cat)
        if subcat_names:
            lines.append(f"- {cat_name} ({cat_desc}): subcategories = {', '.join(subcat_names)}")
        else:
            lines.append(f"- {cat_name} ({cat_desc})")

    lines.append(f"\nIMPORTANT: The category field MUST be one of these exact values: {' | '.join(category_names)}")
    lines.append("Do NOT use 'other' unless it is explicitly listed above. Do NOT invent new categories.")
    return '\n'.join(lines)


# ============================================
# Dimensions: the admin-defined axes the model may fill in
# ============================================

def _dimension_value_label(value: Mapping[str, Any], parent_key: str | None) -> str:
    # Value names are echoed back verbatim by the model, so they are not rewritten;
    # the contract already forbids whitespace in them (DIMENSION_VALUE_RE).
    name = value['name']
    parent_value = value.get('parent_value')
    return f'{name} ({parent_key}={parent_value})' if parent_key and parent_value else name


def _dimension_line(dimension: Mapping[str, Any]) -> str:
    values = [v for v in dimension.get('values') or [] if isinstance(v, Mapping) and isinstance(v.get('name'), str)]
    parent_key = dimension.get('parent')
    listed = ' | '.join(_dimension_value_label(v, parent_key) for v in values[:MAX_PROMPT_DIMENSION_VALUES])
    about = prompt_safe(dimension.get('description') or dimension.get('label') or dimension['key'],
                        MAX_PROMPT_DESCRIPTION_CHARS)
    line = f"- {dimension['key']} ({about}): {listed}"
    if parent_key:
        line += f"\n  A value marked ({parent_key}=X) is only valid when {parent_key} is X."
    hidden = len(values) - MAX_PROMPT_DIMENSION_VALUES
    if hidden > 0:
        line += f"\n  ({hidden} more values are not listed; answer null if none of the listed values fits.)"
    return line


def build_dimensions_instruction(dimensions_config: Sequence[Mapping[str, Any]]) -> str:
    """The prompt block asking for the inferable dimensions ('' when there are none)."""
    dimensions = inferable_dimensions(dimensions_config)
    if not dimensions:
        return ''
    lines = ['Dimensions (answer each with one of its exact values, or null when the feedback does not say):']
    lines.extend(_dimension_line(dimension) for dimension in dimensions)
    return '\n\n' + '\n'.join(lines)


def _dimensions_object(dimensions_config: Sequence[Mapping[str, Any]]) -> str:
    """``"key":"<value or null>",...`` for the inferable dimensions."""
    return ','.join(f'"{d["key"]}":"<value or null>"' for d in inferable_dimensions(dimensions_config))


def _dimensions_json_field(dimensions_config: Sequence[Mapping[str, Any]]) -> str:
    fields = _dimensions_object(dimensions_config)
    return f',"dimensions":{{{fields}}}' if fields else ''


def resolve_category(
    categories_config: list[dict], category: object, subcategory: object,
) -> tuple[str, str | None] | None:
    """Validate a model answer against the configuration.

    Returns ``(category, subcategory)`` or None when the category is not one of
    the allowed values. A subcategory is kept only when it is one of the
    category's configured subcategories; a category configured without any
    keeps the model's free-text subcategory (bounded), as the processor does.
    """
    if not isinstance(category, str) or category not in allowed_category_names(categories_config):
        return None
    sub = subcategory if isinstance(subcategory, str) and subcategory.strip() else None
    configured = next((c for c in categories_config if c.get('name') == category), None)
    allowed_subs = _subcategory_names(configured) if configured else []
    if allowed_subs:
        return category, sub if sub in allowed_subs else None
    return category, sub[:MAX_SUBCATEGORY_CHARS] if sub else None


# ============================================
# Model output parsing
# ============================================

def parse_llm_json_response(content: str) -> str:
    """Return the JSON object text from an LLM response (markdown fences tolerated)."""
    content = content.strip()

    if content.startswith('```'):
        # find() returns -1 when there is no newline, and content[0:] is content
        # itself, so the first fence line is dropped only when there is one.
        content = content[content.find('\n') + 1:].strip()
        if content.endswith('```'):
            content = content[:-3].strip()

    if not content.startswith('{'):
        json_start = content.find('{')
        json_end = content.rfind('}')
        if json_start != -1 and json_end != -1:
            content = content[json_start:json_end + 1]
            logger.info(f"Extracted JSON from position {json_start} to {json_end}")

    return content


# ============================================
# Comprehend / Translate
# ============================================

@tracer.capture_method
def detect_language(comprehend_client: Any, text: str) -> str:
    """Detect dominant language using Comprehend ('en' on failure)."""
    try:
        response = comprehend_client.detect_dominant_language(Text=text[:MAX_SERVICE_TEXT_CHARS])
        languages = response.get('Languages', [])
        return languages[0]['LanguageCode'] if languages else 'en'
    except Exception as e:
        logger.exception(f"Language detection failed: {e}")
        return 'en'


@tracer.capture_method
def translate_text(translate_client: Any, text: str, source_lang: str, target_lang: str) -> str:
    """Translate text if needed (original text on failure)."""
    if source_lang == target_lang:
        return text
    try:
        response = translate_client.translate_text(
            Text=text[:MAX_SERVICE_TEXT_CHARS],
            SourceLanguageCode=source_lang,
            TargetLanguageCode=target_lang,
        )
        return response['TranslatedText']
    except Exception as e:
        logger.exception(f"Translation failed: {e}")
        return text


@tracer.capture_method
def comprehend_sentiment(comprehend_client: Any, text: str, language: str) -> dict:
    """Sentiment label/score from Comprehend (neutral/0.0 on failure)."""
    try:
        lang = language if language in COMPREHEND_SENTIMENT_LANGUAGES else 'en'
        response = comprehend_client.detect_sentiment(Text=text[:MAX_SERVICE_TEXT_CHARS], LanguageCode=lang)
        scores = response.get('SentimentScore', {})
        score = scores.get('Positive', 0) - scores.get('Negative', 0)
        return {'label': _SENTIMENT_LABELS.get(response['Sentiment'], 'neutral'), 'score': round(score, 3)}
    except Exception as e:
        logger.exception(f"Comprehend sentiment failed: {e}")
        return {'label': 'neutral', 'score': 0.0}


# ============================================
# Bedrock
# ============================================

def _prompt_fields(record: dict) -> dict:
    rating = record.get('rating')
    return {
        'source_platform': prompt_safe(record.get('source_platform', 'unknown')),
        'source_channel': prompt_safe(record.get('source_channel', 'unknown')),
        'rating': prompt_safe(rating) if rating is not None else 'N/A',
    }


@tracer.capture_method
def invoke_enrichment_llm(
    raw_record: dict,
    categories_instruction: str,
    *,
    converse_fn: Callable[..., str] | None = None,
    raise_on_throttle: bool = True,
    dimensions_config: Sequence[Mapping[str, Any]] = (),
) -> dict:
    """Full enrichment call. Returns ``{'insights': {...}, 'metadata': {...}}``.

    With inferable dimensions configured the JSON contract also asks for a
    ``dimensions`` object (see ``build_dimensions_instruction``); without them the
    prompt is byte-identical to the one before dimensions existed.

    ``BedrockThrottlingError`` propagates (callers retry); any other failure
    yields empty insights with ``metadata.error`` so the review is still stored.
    """
    start_time = datetime.now(UTC)
    user_prompt = USER_PROMPT_TEMPLATE.format(
        **_prompt_fields(raw_record),
        original_text=raw_record.get('text', '')[:MAX_PROMPT_TEXT_CHARS],
        categories_instruction=categories_instruction,
        dimensions_instruction=build_dimensions_instruction(dimensions_config),
        dimensions_json=_dimensions_json_field(dimensions_config),
    )
    active_model = get_active_model_id(ENRICHMENT_SURFACE)
    try:
        content = (converse_fn or converse)(
            prompt=user_prompt,
            system_prompt=SYSTEM_PROMPT,
            max_tokens=ENRICHMENT_MAX_TOKENS + DIMENSION_OUTPUT_TOKENS * len(inferable_dimensions(dimensions_config)),
            temperature=0.1,
            model_id=active_model,
            max_retries=5,
            raise_on_throttle=raise_on_throttle,
        )
        llm_result = json.loads(parse_llm_json_response(content))
        latency_ms = int((datetime.now(UTC) - start_time).total_seconds() * 1000)
        return {
            'insights': llm_result if isinstance(llm_result, dict) else {},
            'metadata': {
                'model_name': active_model,
                'prompt_version': PROMPT_VERSION,
                'latency_ms': latency_ms,
            },
        }
    except BedrockThrottlingError:
        raise
    except json.JSONDecodeError as e:
        logger.exception(f"Failed to parse Bedrock response: {e}")
        return {'insights': {}, 'metadata': {'error': str(e)}}
    except Exception as e:
        logger.error(f"Unexpected Bedrock error: {e}", exc_info=True)
        return {'insights': {}, 'metadata': {'error': str(e)}}


@tracer.capture_method
def classify_category(
    record: dict,
    text: str,
    categories_config: list[dict],
    *,
    converse_fn: Callable[..., str] | None = None,
) -> tuple[str, str | None] | None:
    """Re-classify one review's category/subcategory with the CURRENT config.

    Returns None when the answer is unreadable or names a category that is not
    configured. ``BedrockThrottlingError`` propagates.
    """
    prompt = CLASSIFY_PROMPT_TEMPLATE.format(
        **_prompt_fields(record),
        text=text[:MAX_PROMPT_TEXT_CHARS],
        categories_instruction=build_categories_instruction(categories_config),
    )
    parsed = _classification_answer(prompt, 200, converse_fn, 'Category')
    if parsed is None:
        return None
    return resolve_category(categories_config, parsed.get('category'), parsed.get('subcategory'))


def _classification_answer(
    prompt: str, max_tokens: int, converse_fn: Callable[..., str] | None, what: str,
) -> dict[str, Any] | None:
    """One narrow re-classification call's JSON object, or None when unreadable.

    ``BedrockThrottlingError`` propagates (the reprocess worker hands over on it).
    """
    content = (converse_fn or converse)(
        prompt=prompt,
        system_prompt=SYSTEM_PROMPT,
        max_tokens=max_tokens,
        temperature=0.1,
        model_id=get_active_model_id(ENRICHMENT_SURFACE),
        max_retries=5,
        raise_on_throttle=True,
    )
    try:
        parsed = json.loads(parse_llm_json_response(content))
    except json.JSONDecodeError:
        logger.warning(f"{what} classification returned unparseable JSON")
        return None
    return parsed if isinstance(parsed, dict) else None


@tracer.capture_method
def classify_dimensions(
    record: dict,
    text: str,
    dimensions_config: Sequence[Mapping[str, Any]],
    *,
    converse_fn: Callable[..., str] | None = None,
) -> dict[str, Any]:
    """The model's raw dimension answer for one stored review ({} when unreadable).

    Callers pass it through ``shared.feedback_dimensions`` (which validates it).
    No model call when no dimension is inferable. ``BedrockThrottlingError`` propagates.
    """
    fields = _dimensions_object(dimensions_config)
    if not fields:
        return {}
    prompt = CLASSIFY_DIMENSIONS_PROMPT_TEMPLATE.format(
        **_prompt_fields(record),
        text=text[:MAX_PROMPT_TEXT_CHARS],
        dimensions_instruction=build_dimensions_instruction(dimensions_config),
        dimensions_object=fields,
    )
    max_tokens = DIMENSION_OUTPUT_TOKENS * (len(inferable_dimensions(dimensions_config)) + 2)
    return _classification_answer(prompt, max_tokens, converse_fn, 'Dimension') or {}


# ============================================
# Enrichment: model/Comprehend output -> stored attributes
# ============================================

@dataclass(frozen=True)
class EnrichmentSteps:
    """The four enrichment stages, injected so each caller binds its own clients."""
    detect_language: Callable[[str], str]
    translate_text: Callable[[str, str, str], str]
    sentiment: Callable[[str, str], dict]
    llm: Callable[[dict], dict]


@dataclass(frozen=True)
class Enrichment:
    """``attributes`` are the enrichment fields of a feedback item (None = absent);
    ``llm_result`` is the raw ``invoke_enrichment_llm`` result; ``ai_dimensions`` the
    model's unvalidated ``dimensions`` answer; ``category_valid`` whether the model's
    category was a configured one (False = it was replaced by 'other')."""
    attributes: dict
    llm_result: dict
    ai_dimensions: Mapping[str, Any] = field(default_factory=dict)
    category_valid: bool = True

    @property
    def llm_failed(self) -> bool:
        metadata = self.llm_result.get('metadata')
        return isinstance(metadata, dict) and bool(metadata.get('error'))


FALLBACK_CATEGORY = 'other'


def _model_category(
    insights: Mapping[str, Any], categories_config: list[dict],
) -> tuple[str, str | None, bool]:
    """The model's category/subcategory checked against the config; ('other', None, False) when not allowed."""
    resolved = resolve_category(
        categories_config, insights.get('category', FALLBACK_CATEGORY), insights.get('subcategory'))
    if resolved is None:
        return FALLBACK_CATEGORY, None, False
    return resolved[0], resolved[1], True


def run_enrichment(
    raw_record: dict, steps: EnrichmentSteps, primary_language: str,
    categories_config: list[dict] | None = None,
) -> Enrichment:
    """Run the processor's enrichment path on one raw record.

    The model's category goes through ``resolve_category`` against
    ``categories_config`` (the defaults when empty), falling back to 'other', so a
    hallucinated category never reaches the item or its by-category index.
    """
    original_text = raw_record.get('text', '')
    original_language = steps.detect_language(original_text)
    normalized_text = steps.translate_text(original_text, original_language, primary_language)
    sentiment = steps.sentiment(normalized_text, primary_language)
    llm_result = steps.llm(raw_record)
    insights = llm_result.get('insights') or {}
    persona = insights.get('persona') or {}
    category, subcategory, category_valid = _model_category(insights, categories_config or [])

    # A feedback form can preset the category; otherwise the model decides.
    preset_category = raw_record.get('preset_category', '')
    preset_subcategory = raw_record.get('preset_subcategory', '')
    sentiment_score = insights.get('sentiment_score', sentiment['score'])

    attributes = {
        'original_language': original_language,
        'normalized_text': normalized_text if original_language != primary_language else None,
        'category': preset_category or category,
        'subcategory': preset_subcategory or subcategory,
        'journey_stage': insights.get('journey_stage', 'unknown'),
        'sentiment_label': insights.get('sentiment_label', sentiment['label']),
        'sentiment_score': Decimal(str(round(sentiment_score, 3))),
        'urgency': insights.get('urgency', 'low'),
        'impact_area': insights.get('impact_area', 'other'),
        'problem_summary': insights.get('problem_summary'),
        'problem_root_cause_hypothesis': insights.get('problem_root_cause_hypothesis'),
        'direct_customer_quote': insights.get('direct_customer_quote'),
        'persona_name': persona.get('name'),
        'persona_type': persona.get('type'),
        'persona_attributes': persona.get('attributes'),
    }
    ai_dimensions = insights.get('dimensions')
    return Enrichment(
        attributes=attributes, llm_result=llm_result,
        ai_dimensions=ai_dimensions if isinstance(ai_dimensions, Mapping) else {},
        category_valid=category_valid,
    )
