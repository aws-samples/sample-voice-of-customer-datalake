"""Model answers shaped like the ones voc-feedback-processor failed to parse in production.

Each case is the shape behind one recorded "Failed to parse Bedrock response" error:
"Invalid control character" (a raw newline/tab inside a string), "Extra data" (a second
object or a remark after the first), and a fenced object followed by prose. Before
``shared.llm_json`` they all fell back to the default enrichment.
"""
import json
from unittest.mock import MagicMock, patch

import pytest

from shared.categorization import invoke_enrichment_llm, parse_llm_json_response
from shared.llm_json import first_json_object, json_object_or_none

ENRICHED = {'category': 'delivery', 'urgency': 'high', 'problem_summary': 'Late\nparcel'}

RECORDED_SHAPES = [
    # Invalid control character: the model copied the review's line break verbatim.
    '{"category": "delivery", "urgency": "high", "problem_summary": "Late\nparcel"}',
    # Extra data: a second object after the first.
    '{"category": "delivery", "urgency": "high", "problem_summary": "Late\\nparcel"}\n{"note": "x"}',
    # Extra data: a closing remark after the object.
    '{"category": "delivery", "urgency": "high", "problem_summary": "Late\\nparcel"} Hope this helps!',
    # A fence whose closing line is followed by prose (the fence strip cannot see the end).
    '```json\n{"category": "delivery", "urgency": "high", "problem_summary": "Late\\nparcel"}\n```\nDone.',
    # Prose before the object, with a tab inside a string.
    'Here is the JSON: {"category": "delivery", "urgency": "high", "problem_summary": "Late\nparcel", "t": "a\tb"}',
]


@pytest.fixture(autouse=True)
def model():
    with patch('shared.categorization.get_active_model_id', return_value='test-model') as mocked:
        yield mocked


class TestFirstJsonObject:
    @pytest.mark.parametrize('text', RECORDED_SHAPES)
    def test_every_recorded_shape_decodes(self, text: str):
        decoded = first_json_object(text)
        assert {k: decoded[k] for k in ENRICHED} == ENRICHED

    @pytest.mark.parametrize('text', RECORDED_SHAPES)
    def test_the_previous_parse_rejected_every_shape(self, text: str):
        # Pins that the cases are the failing ones: the old path was json.loads(parse_llm_json_response(...)).
        with pytest.raises(json.JSONDecodeError):
            json.loads(parse_llm_json_response(text))

    @pytest.mark.parametrize('text', ['{"a": "cut off', '{"a": 1,', '', 'no json at all'])
    def test_a_truncated_or_missing_object_still_raises(self, text: str):
        with pytest.raises(json.JSONDecodeError):
            first_json_object(text)


class TestEnrichmentParsesRecordedShapes:
    @pytest.mark.parametrize('text', RECORDED_SHAPES)
    def test_enrichment_keeps_the_answer(self, text: str):
        result = invoke_enrichment_llm({'text': 'x'}, 'I', converse_fn=MagicMock(return_value=text))
        assert ('error' in result['metadata'], result['insights']['category']) == (False, 'delivery')

    def test_a_truncated_answer_is_stored_with_the_fallback_and_its_error(self):
        result = invoke_enrichment_llm({'text': 'x'}, 'I', converse_fn=MagicMock(return_value='{"category": "deli'))
        assert (result['insights'], result['metadata']['error'].startswith('Unterminated string')) == ({}, True)

    def test_the_call_names_its_step(self):
        converse_fn = MagicMock(return_value='{}')
        invoke_enrichment_llm({'text': 'x'}, 'I', converse_fn=converse_fn)
        assert converse_fn.call_args.kwargs['step_name'] == 'feedback_enrichment'



@pytest.mark.parametrize(('text', 'expected'), [
    ('{"svg": "<svg/>", "width": 40}', {'svg': '<svg/>', 'width': 40}),
    ('{}', {}),
])
def test_json_object_or_none_returns_the_decoded_object(text, expected):
    assert json_object_or_none(text) == expected


@pytest.mark.parametrize('text', [
    None, 42, b'{"a": 1}', {'a': 1},   # not a string
    '', 'not json', '{"a": 1} trailing', '{"a": "\n"}',  # not strict JSON
    '[1, 2]', '"text"', '3', 'null',   # JSON, but not an object
], ids=lambda value: repr(value)[:20])
def test_json_object_or_none_returns_none_for_anything_but_a_strict_json_object(text):
    assert json_object_or_none(text) is None
