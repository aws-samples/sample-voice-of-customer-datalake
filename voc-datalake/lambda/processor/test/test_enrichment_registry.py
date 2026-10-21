"""The processor writes registry enrichment fields (shared/enrichment_fields.py)."""
import ast
from pathlib import Path
from unittest.mock import patch

import pytest
from shared.enrichment_fields import ENRICHMENT_FIELDS, field_names

PROCESSOR_SOURCE = Path(__file__).resolve().parents[1] / 'handler.py'


def _item_literal_keys() -> set[str]:
    """String keys of the `item = {...}` literal inside process_feedback."""
    tree = ast.parse(PROCESSOR_SOURCE.read_text(encoding='utf-8'))
    functions = [n for n in ast.walk(tree)
                 if isinstance(n, ast.FunctionDef) and n.name == 'process_feedback']
    assert len(functions) == 1
    for node in ast.walk(functions[0]):
        if (isinstance(node, ast.Assign) and isinstance(node.value, ast.Dict)
                and any(isinstance(t, ast.Name) and t.id == 'item' for t in node.targets)):
            return {k.value for k in node.value.keys
                    if isinstance(k, ast.Constant) and isinstance(k.value, str)}
    raise AssertionError('process_feedback no longer builds `item = {...}`')


def test_no_registry_field_shadows_an_attribute_the_processor_writes():
    # The registry values are spread INTO the item literal, so a name collision
    # would silently replace a core attribute (or a GSI key) with an enum value.
    written = _item_literal_keys()
    assert written, 'parsed no keys from the item literal'
    assert set(field_names()).isdisjoint(written)


def test_prompt_declares_every_registry_field_and_its_guide():
    from processor.handler import USER_PROMPT_TEMPLATE

    prompt = USER_PROMPT_TEMPLATE.format(
        source_platform='s', source_channel='c', rating=5,
        original_text='t', categories_instruction='cats',
    )
    for field in ENRICHMENT_FIELDS:
        assert f'"{field.name}":"{"|".join(field.values)}"' in prompt
        assert f'{field.name} rating guide:' in prompt


@pytest.fixture
def processed(sample_sqs_record):
    """Run process_feedback with the given insights; AWS/LLM calls stubbed."""
    def run(insights: dict) -> dict:
        from processor.handler import process_feedback
        with patch('processor.handler.check_duplicate', return_value=False), \
                patch('processor.handler.detect_language', return_value='en'), \
                patch('processor.handler.translate_text', return_value=sample_sqs_record['text']), \
                patch('processor.handler.get_comprehend_sentiment',
                      return_value={'label': 'neutral', 'score': 0.0}), \
                patch('processor.handler.invoke_bedrock_llm',
                      return_value={'insights': insights, 'metadata': {}}):
            return process_feedback(dict(sample_sqs_record))
    return run


def test_stores_a_valid_usefulness_value_normalized(processed, sample_llm_insights):
    item = processed({**sample_llm_insights, 'usefulness': ' High '})
    assert item['usefulness'] == 'high'


@pytest.mark.parametrize('answer', ['kind of', '', None, 7])
def test_omits_an_out_of_enum_answer_instead_of_defaulting(processed, sample_llm_insights, answer):
    item = processed({**sample_llm_insights, 'usefulness': answer})
    assert 'usefulness' not in item


def test_failed_enrichment_leaves_the_item_unscored(processed):
    # invoke_bedrock_llm returns insights={} on a parse/model error.
    item = processed({})
    assert 'usefulness' not in item
    # Core attributes still have their documented defaults.
    assert item['category'] == 'other'
