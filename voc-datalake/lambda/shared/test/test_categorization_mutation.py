"""Mutation hardening for `shared/categorization.py`.

`test_categorization.py` pins the shape of each helper's answer — a configured
subcategory is kept, an unknown category is refused, a preset category wins —
but a mutation run found 155 statements it cannot see, in five groups:

* THE PROMPTS AND THE CALL. Nothing pinned the exact category instruction the
  model reads, the system prompt, the ``Source | Channel | Rating`` header and
  its ``unknown`` / ``N/A`` fallbacks, the 3,000-character text bound, or the
  ``max_tokens`` / ``temperature`` / ``max_retries`` / ``raise_on_throttle``
  values of either Bedrock call. Each is asserted here as a literal.
* THE STORED ATTRIBUTES. ``run_enrichment`` maps fifteen model fields to
  fifteen stored attributes; a renamed key or a changed default (``'low'``,
  ``'unknown'``, ``'other'``) survived because the earlier tests read only the
  handful of keys they cared about. The whole dictionary is compared here, for
  a complete model answer and for an empty one.
* COMPREHEND AND TRANSLATE. Every language in the sentiment allowlist, the
  ``en`` fallback for the rest, the ``Positive - Negative`` score, its
  3-decimal rounding, the 5,000-character service bound, each label mapping
  and each failure fallback had no test in this directory.
* THE RESPONSE PARSER. Fenced prose, a fence without a closing newline, a
  stray ``{`` or ``}`` and the "Extracted JSON" log line were all unobserved.
* METADATA, LOGS AND WRAPPING. ``prompt_version``, ``latency_ms``, every log
  message text, the ``exc_info=True`` on the unexpected-error path, the frozen
  dataclasses and each ``@tracer.capture_method`` wrapper.

The run also showed three unobservable statements, now deleted from the
module: the ``if first_newline != -1`` guard (slicing from ``-1 + 1`` is a
no-op), the inner ``'N/A'`` default in ``_prompt_fields`` (only reached when
the key exists) and the ``''`` default on ``cat.get('name')`` (every caller
goes through ``load_categories_config``, which drops nameless entries).
"""
import dataclasses
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from unittest.mock import MagicMock, call, patch

import pytest

from shared import categorization
from shared.categorization import (
    DEFAULT_CATEGORIES,
    DEFAULT_CATEGORY_NAMES,
    Enrichment,
    EnrichmentSteps,
    build_categories_instruction,
    classify_category,
    comprehend_sentiment,
    detect_language,
    invoke_enrichment_llm,
    parse_llm_json_response,
    resolve_category,
    run_enrichment,
    translate_text,
)

CONFIG = [
    {'name': 'shipping', 'description': 'Shipping issues',
     'subcategories': [{'name': 'late'}, {'name': 'damaged'}]},
    {'name': 'billing'},
]

SYSTEM_PROMPT = (
    'You are an expert customer experience analyst. Analyze feedback and return ONLY valid JSON:\n'
    '- Be objective and accurate\n'
    '- Never invent PII\n'
    '- Use exact enum values specified\n'
    '- Keep summaries under 500 chars'
)

DEFAULT_INSTRUCTION = (
    'Available categories (you MUST use ONLY one of these exact values): '
    'delivery | customer_support | product_quality | pricing | website | app | billing | returns | '
    'communication | other\n\n'
    'IMPORTANT: The category field MUST be one of: delivery, customer_support, product_quality, '
    'pricing, website, app, billing, returns, communication, other. Do NOT use any other category value.'
)

CONFIGURED_INSTRUCTION = (
    'Available categories and their subcategories:\n'
    '- shipping (Shipping issues): subcategories = late, damaged\n'
    '- billing (billing)\n'
    '\nIMPORTANT: The category field MUST be one of these exact values: shipping | billing\n'
    "Do NOT use 'other' unless it is explicitly listed above. Do NOT invent new categories."
)


@pytest.fixture(autouse=True)
def model() -> Iterator[MagicMock]:
    with patch('shared.categorization.get_active_model_id', return_value='test-model') as mocked:
        yield mocked


@pytest.fixture
def logger() -> Iterator[MagicMock]:
    with patch('shared.categorization.logger') as mocked:
        yield mocked


def _rewrite(record: object, field: str, value: object) -> None:
    """Assign through setattr: the type checker refuses a direct write to a
    frozen dataclass, and the runtime FrozenInstanceError is what is asserted."""
    setattr(record, field, value)


class TestDefaultsAreTheDocumentedLiterals:
    def test_default_categories(self):
        assert DEFAULT_CATEGORIES == (
            'delivery|customer_support|product_quality|pricing|website|app|billing|returns|communication|other'
        )
        assert DEFAULT_CATEGORY_NAMES == (
            'delivery', 'customer_support', 'product_quality', 'pricing', 'website',
            'app', 'billing', 'returns', 'communication', 'other',
        )

    def test_bounds(self):
        assert categorization.MAX_PROMPT_TEXT_CHARS == 3000
        assert categorization.MAX_SERVICE_TEXT_CHARS == 5000
        assert categorization.MAX_SUBCATEGORY_CHARS == 100
        assert categorization.PROMPT_VERSION == '1.0.0'
        assert categorization.ENRICHMENT_SURFACE == 'enrichment'

    def test_sentiment_languages(self):
        assert sorted(categorization.COMPREHEND_SENTIMENT_LANGUAGES) == [
            'ar', 'de', 'en', 'es', 'fr', 'hi', 'it', 'ja', 'ko', 'pt', 'zh', 'zh-TW']


class TestInstructionText:
    def test_default_instruction_is_exact(self):
        assert build_categories_instruction([]) == DEFAULT_INSTRUCTION

    def test_configured_instruction_is_exact(self):
        assert build_categories_instruction(CONFIG) == CONFIGURED_INSTRUCTION

    def test_only_named_subcategory_objects_are_offered(self):
        config = [{'name': 'a', 'subcategories': [{'name': 'ok'}, 'junk', {'name': ''}, {}, {'name': 3}]}]
        assert build_categories_instruction(config) == (
            'Available categories and their subcategories:\n'
            '- a (a): subcategories = ok\n'
            '\nIMPORTANT: The category field MUST be one of these exact values: a\n'
            "Do NOT use 'other' unless it is explicitly listed above. Do NOT invent new categories."
        )

    def test_non_list_subcategories_are_ignored(self):
        config = [{'name': 'a', 'subcategories': 'late'}]
        assert build_categories_instruction(config).splitlines()[1] == '- a (a)'


class TestFreeTextSubcategoryBound:
    def test_exactly_100_characters_are_kept(self):
        assert resolve_category(CONFIG, 'billing', 'x' * 100) == ('billing', 'x' * 100)

    def test_the_101st_character_is_cut(self):
        assert resolve_category(CONFIG, 'billing', 'x' * 101) == ('billing', 'x' * 100)


class TestParseLlmJsonResponse:
    @pytest.mark.parametrize(('content', 'expected'), [
        ('```\nnot json\n```', 'not json'),
        ('```json\n{"a": 1}```', '{"a": 1}'),
        ('```json\n{"a": 1}\n```\n', '{"a": 1}'),
        ('x{"a": 1}', '{"a": 1}'),
        ('no braces here', 'no braces here'),
        ('only { open', 'only { open'),
        ('closes } only', 'closes } only'),
        ('{"a": 1} trailing', '{"a": 1} trailing'),
    ])
    def test_returns_the_json_text(self, content, expected):
        assert parse_llm_json_response(content) == expected

    def test_extraction_is_logged_with_its_positions(self, logger: MagicMock):
        parse_llm_json_response('Here is the analysis: {"category": "other"} Hope this helps!')

        logger.info.assert_called_once_with('Extracted JSON from position 22 to 42')

    def test_plain_json_is_not_logged(self, logger: MagicMock):
        parse_llm_json_response('{"category": "other"}')

        logger.info.assert_not_called()


class TestDetectLanguage:
    def test_returns_the_first_language_and_bounds_the_text(self):
        comprehend = MagicMock()
        comprehend.detect_dominant_language.return_value = {
            'Languages': [{'LanguageCode': 'fr', 'Score': 0.9}, {'LanguageCode': 'en', 'Score': 0.1}],
        }

        assert detect_language(comprehend, 'b' * 5001) == 'fr'
        comprehend.detect_dominant_language.assert_called_once_with(Text='b' * 5000)

    def test_exactly_5000_characters_are_sent_whole(self):
        comprehend = MagicMock()
        comprehend.detect_dominant_language.return_value = {'Languages': [{'LanguageCode': 'de'}]}

        assert detect_language(comprehend, 'b' * 5000) == 'de'
        comprehend.detect_dominant_language.assert_called_once_with(Text='b' * 5000)

    @pytest.mark.parametrize('response', [{}, {'Languages': []}])
    def test_no_language_means_en(self, response):
        comprehend = MagicMock()
        comprehend.detect_dominant_language.return_value = response

        assert detect_language(comprehend, 'x') == 'en'

    def test_failure_means_en_and_is_logged(self, logger: MagicMock):
        comprehend = MagicMock()
        comprehend.detect_dominant_language.side_effect = RuntimeError('down')

        assert detect_language(comprehend, 'x') == 'en'
        logger.exception.assert_called_once_with('Language detection failed: down')


class TestTranslateText:
    def test_same_language_is_returned_without_a_call(self):
        translate = MagicMock()

        assert translate_text(translate, 'hello', 'en', 'en') == 'hello'
        translate.translate_text.assert_not_called()

    def test_translates_with_bounded_text(self):
        translate = MagicMock()
        translate.translate_text.return_value = {'TranslatedText': 'hello'}

        assert translate_text(translate, 'b' * 5001, 'fr', 'en') == 'hello'
        translate.translate_text.assert_called_once_with(
            Text='b' * 5000, SourceLanguageCode='fr', TargetLanguageCode='en')

    def test_failure_returns_the_original_and_is_logged(self, logger: MagicMock):
        translate = MagicMock()
        translate.translate_text.side_effect = RuntimeError('down')

        assert translate_text(translate, 'bonjour', 'fr', 'en') == 'bonjour'
        logger.exception.assert_called_once_with('Translation failed: down')


def _comprehend(sentiment: str, positive: float | None, negative: float | None) -> MagicMock:
    scores = {}
    if positive is not None:
        scores['Positive'] = positive
    if negative is not None:
        scores['Negative'] = negative
    client = MagicMock()
    client.detect_sentiment.return_value = {'Sentiment': sentiment, 'SentimentScore': scores}
    return client


class TestComprehendSentiment:
    @pytest.mark.parametrize('language', ['en', 'es', 'fr', 'de', 'it', 'pt', 'ar', 'hi', 'ja', 'ko', 'zh', 'zh-TW'])
    def test_supported_languages_are_sent_as_is(self, language):
        client = _comprehend('NEUTRAL', 0.1, 0.1)

        assert comprehend_sentiment(client, 'b' * 5001, language) == {'label': 'neutral', 'score': 0.0}
        client.detect_sentiment.assert_called_once_with(Text='b' * 5000, LanguageCode=language)

    @pytest.mark.parametrize('language', ['nl', 'sv', 'xx', ''])
    def test_unsupported_languages_fall_back_to_en(self, language):
        client = _comprehend('NEUTRAL', 0.1, 0.1)

        comprehend_sentiment(client, 'x', language)

        client.detect_sentiment.assert_called_once_with(Text='x', LanguageCode='en')

    @pytest.mark.parametrize(('sentiment', 'label'), [
        ('POSITIVE', 'positive'), ('NEGATIVE', 'negative'), ('NEUTRAL', 'neutral'), ('MIXED', 'mixed'),
        ('SOMETHING_NEW', 'neutral'),
    ])
    def test_labels_are_mapped(self, sentiment, label):
        assert comprehend_sentiment(_comprehend(sentiment, 0.5, 0.5), 'x', 'en') == {'label': label, 'score': 0.0}

    @pytest.mark.parametrize(('positive', 'negative', 'score'), [
        (0.7, 0.2, 0.5),
        (0.9, 0.1234, 0.777),
        (0.5, None, 0.5),
        (None, 0.5, -0.5),
        (None, None, 0.0),
    ])
    def test_score_is_positive_minus_negative_to_three_decimals(self, positive, negative, score):
        assert comprehend_sentiment(_comprehend('MIXED', positive, negative), 'x', 'en')['score'] == score

    def test_missing_score_block_means_zero(self):
        client = MagicMock()
        client.detect_sentiment.return_value = {'Sentiment': 'POSITIVE'}

        assert comprehend_sentiment(client, 'x', 'en') == {'label': 'positive', 'score': 0}

    def test_failure_is_neutral_zero_and_logged(self, logger: MagicMock):
        client = MagicMock()
        client.detect_sentiment.side_effect = RuntimeError('down')

        assert comprehend_sentiment(client, 'x', 'en') == {'label': 'neutral', 'score': 0.0}
        logger.exception.assert_called_once_with('Comprehend sentiment failed: down')


class TestEnrichmentCall:
    def test_the_exact_bedrock_call(self, model: MagicMock):
        converse_fn = MagicMock(return_value='{}')

        invoke_enrichment_llm(
            {'source_platform': 'web', 'source_channel': 'email', 'rating': 4, 'text': 'hello'},
            'INSTR', converse_fn=converse_fn,
        )

        model.assert_called_once_with('enrichment')
        kwargs = dict(converse_fn.call_args.kwargs)
        prompt = kwargs.pop('prompt')
        assert kwargs == {
            'system_prompt': SYSTEM_PROMPT, 'max_tokens': 800, 'temperature': 0.1,
            'model_id': 'test-model', 'max_retries': 5, 'raise_on_throttle': True,
        }
        assert prompt.startswith(
            'Analyze this feedback and return JSON:\n\n'
            'Source: web | Channel: email | Rating: 4\n'
            'Text: hello\n\n'
            'INSTR\n\n'
            'Return ONLY this JSON structure:\n{"category":"<one of the categories above>"'
        )

    def test_raise_on_throttle_is_forwarded(self):
        converse_fn = MagicMock(return_value='{}')

        invoke_enrichment_llm({'text': 'x'}, 'I', converse_fn=converse_fn, raise_on_throttle=False)

        assert converse_fn.call_args.kwargs['raise_on_throttle'] is False

    @pytest.mark.parametrize(('record', 'header'), [
        ({}, 'Source: unknown | Channel: unknown | Rating: N/A\nText: \n'),
        ({'rating': None}, 'Source: unknown | Channel: unknown | Rating: N/A\nText: \n'),
        ({'rating': 0}, 'Source: unknown | Channel: unknown | Rating: 0\nText: \n'),
    ])
    def test_prompt_header_fallbacks(self, record, header):
        converse_fn = MagicMock(return_value='{}')

        invoke_enrichment_llm(record, 'I', converse_fn=converse_fn)

        assert header in converse_fn.call_args.kwargs['prompt']

    @pytest.mark.parametrize(('length', 'kept'), [(3000, 3000), (3001, 3000)])
    def test_text_is_bounded_at_3000_characters(self, length, kept):
        converse_fn = MagicMock(return_value='{}')

        invoke_enrichment_llm({'text': 'a' * length}, 'I', converse_fn=converse_fn)

        assert f"Text: {'a' * kept}\n\nI\n" in converse_fn.call_args.kwargs['prompt']

    def test_metadata_carries_model_version_and_latency(self):
        start = datetime(2026, 1, 1, tzinfo=UTC)
        with patch('shared.categorization.datetime') as clock:
            clock.now.side_effect = [start, start + timedelta(milliseconds=1500)]
            result = invoke_enrichment_llm(
                {'text': 'x'}, 'I', converse_fn=MagicMock(return_value='{"category": "billing"}'))

        assert result == {
            'insights': {'category': 'billing'},
            'metadata': {'model_name': 'test-model', 'prompt_version': '1.0.0', 'latency_ms': 1500},
        }
        assert clock.now.call_args_list == [call(UTC), call(UTC)]

    def test_a_non_object_answer_is_empty_insights(self):
        result = invoke_enrichment_llm({'text': 'x'}, 'I', converse_fn=MagicMock(return_value='[1, 2]'))

        assert result['insights'] == {}
        assert result['metadata']['prompt_version'] == '1.0.0'

    def test_bad_json_is_logged_and_reported(self, logger: MagicMock):
        result = invoke_enrichment_llm({'text': 'x'}, 'I', converse_fn=MagicMock(return_value='nope'))

        assert result == {'insights': {}, 'metadata': {'error': 'Expecting value: line 1 column 1 (char 0)'}}
        logger.exception.assert_called_once_with(
            'Failed to parse Bedrock response: Expecting value: line 1 column 1 (char 0)')

    def test_an_unexpected_error_is_logged_with_its_traceback(self, logger: MagicMock):
        result = invoke_enrichment_llm(
            {'text': 'x'}, 'I', converse_fn=MagicMock(side_effect=RuntimeError('boom')))

        assert result == {'insights': {}, 'metadata': {'error': 'boom'}}
        logger.error.assert_called_once_with('Unexpected Bedrock error: boom', exc_info=True)


class TestClassifyCall:
    def test_the_exact_bedrock_call(self, model: MagicMock):
        converse_fn = MagicMock(return_value='{"category": "billing", "subcategory": null}')

        result = classify_category(
            {'source_platform': 'web', 'source_channel': 'email', 'rating': 2},
            'b' * 3001, CONFIG, converse_fn=converse_fn,
        )

        assert result == ('billing', None)
        model.assert_called_once_with('enrichment')
        converse_fn.assert_called_once_with(
            prompt=(
                'Classify this customer feedback into exactly one category.\n\n'
                'Source: web | Channel: email | Rating: 2\n'
                f"Text: {'b' * 3000}\n\n"
                f'{CONFIGURED_INSTRUCTION}\n\n'
                'Return ONLY this JSON structure:\n'
                '{"category":"<one of the categories above>",'
                '"subcategory":"<one of that category\'s subcategories, or null>"}'
            ),
            system_prompt=SYSTEM_PROMPT,
            max_tokens=200,
            temperature=0.1,
            model_id='test-model',
            max_retries=5,
            raise_on_throttle=True,
        )

    def test_the_models_subcategory_is_read_back(self):
        converse_fn = MagicMock(return_value='{"category": "shipping", "subcategory": "late"}')

        assert classify_category({}, 't', CONFIG, converse_fn=converse_fn) == ('shipping', 'late')

    def test_unparseable_json_is_logged(self, logger: MagicMock):
        assert classify_category({}, 't', CONFIG, converse_fn=MagicMock(return_value='nope')) is None
        logger.warning.assert_called_once_with('Category classification returned unparseable JSON')

    def test_a_json_list_is_none_without_a_log(self, logger: MagicMock):
        assert classify_category({}, 't', CONFIG, converse_fn=MagicMock(return_value='[]')) is None
        logger.warning.assert_not_called()


def _mock_steps(insights: dict, language: str = 'en') -> tuple[EnrichmentSteps, dict[str, MagicMock]]:
    mocks = {
        'detect_language': MagicMock(return_value=language),
        'translate_text': MagicMock(return_value='translated'),
        'sentiment': MagicMock(return_value={'label': 'negative', 'score': -0.5}),
        'llm': MagicMock(return_value={'insights': insights, 'metadata': {}}),
    }
    return EnrichmentSteps(**mocks), mocks


def _steps(insights: dict, language: str = 'en') -> EnrichmentSteps:
    return _mock_steps(insights, language)[0]


FULL_INSIGHTS = {
    'category': 'billing', 'subcategory': 'refund', 'journey_stage': 'purchase',
    'sentiment_label': 'mixed', 'sentiment_score': 0.12345, 'urgency': 'high',
    'impact_area': 'pricing', 'problem_summary': 'Charged twice',
    'problem_root_cause_hypothesis': 'Retry on timeout', 'direct_customer_quote': 'I was charged twice',
    'persona': {'name': 'Pat', 'type': 'existing_customer', 'attributes': {'confidence': 'high'}},
}


class TestRunEnrichmentAttributes:
    def test_every_model_field_lands_on_its_attribute(self):
        steps, mocks = _mock_steps(FULL_INSIGHTS, language='fr')
        record = {'text': 'bonjour'}

        enrichment = run_enrichment(record, steps, 'en')

        assert enrichment.attributes == {
            'original_language': 'fr',
            'normalized_text': 'translated',
            'category': 'billing',
            'subcategory': 'refund',
            'journey_stage': 'purchase',
            'sentiment_label': 'mixed',
            'sentiment_score': Decimal('0.123'),
            'urgency': 'high',
            'impact_area': 'pricing',
            'problem_summary': 'Charged twice',
            'problem_root_cause_hypothesis': 'Retry on timeout',
            'direct_customer_quote': 'I was charged twice',
            'persona_name': 'Pat',
            'persona_type': 'existing_customer',
            'persona_attributes': {'confidence': 'high'},
        }
        assert enrichment.llm_result == {'insights': FULL_INSIGHTS, 'metadata': {}}
        mocks['detect_language'].assert_called_once_with('bonjour')
        mocks['translate_text'].assert_called_once_with('bonjour', 'fr', 'en')
        mocks['sentiment'].assert_called_once_with('translated', 'en')
        mocks['llm'].assert_called_once_with(record)

    def test_an_empty_answer_gets_every_default(self):
        enrichment = run_enrichment({}, _steps({}), 'en')

        assert enrichment.attributes == {
            'original_language': 'en',
            'normalized_text': None,
            'category': 'other',
            'subcategory': None,
            'journey_stage': 'unknown',
            'sentiment_label': 'negative',
            'sentiment_score': Decimal('-0.5'),
            'urgency': 'low',
            'impact_area': 'other',
            'problem_summary': None,
            'problem_root_cause_hypothesis': None,
            'direct_customer_quote': None,
            'persona_name': None,
            'persona_type': None,
            'persona_attributes': None,
        }

    def test_a_record_without_text_detects_the_empty_string(self):
        steps, mocks = _mock_steps({})

        run_enrichment({}, steps, 'en')

        mocks['detect_language'].assert_called_once_with('')

    def test_preset_category_alone_keeps_the_model_subcategory(self):
        enrichment = run_enrichment(
            {'text': 'x', 'preset_category': 'shipping'}, _steps({'subcategory': 'late'}), 'en')

        assert enrichment.attributes['category'] == 'shipping'
        assert enrichment.attributes['subcategory'] == 'late'

    @pytest.mark.parametrize(('llm_result', 'failed'), [
        ({'insights': {}, 'metadata': {'error': 'boom'}}, True),
        ({'insights': {}, 'metadata': {'error': ''}}, False),
        ({'insights': {}, 'metadata': {}}, False),
        ({'insights': {}, 'metadata': 'x'}, False),
        ({}, False),
    ])
    def test_llm_failed_reads_a_non_empty_error(self, llm_result, failed):
        assert Enrichment(attributes={}, llm_result=llm_result).llm_failed is failed


class TestImmutability:
    def test_enrichment_is_frozen(self):
        enrichment = Enrichment(attributes={}, llm_result={})

        with pytest.raises(dataclasses.FrozenInstanceError):
            _rewrite(enrichment, 'attributes', {'x': 1})

    def test_steps_are_frozen(self):
        steps = _steps({})

        with pytest.raises(dataclasses.FrozenInstanceError):
            _rewrite(steps, 'llm', MagicMock())


class TestTracing:
    @pytest.mark.parametrize('name', [
        'detect_language', 'translate_text', 'comprehend_sentiment', 'invoke_enrichment_llm', 'classify_category',
    ])
    def test_each_aws_call_is_traced(self, name):
        # Read through the function's __dict__: functools.wraps stores the
        # original there, and a missing key fails just as loudly.
        assert vars(getattr(categorization, name))['__wrapped__'].__qualname__ == name
