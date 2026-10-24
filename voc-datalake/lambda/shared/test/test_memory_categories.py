"""``shared.memory_categories.classify_statement``: the one category classifier every memory write uses.

Closed list (the configured ids), labels and subcategory labels map to ids, unknown ids are dropped,
the name match is always merged, and a model failure falls back to the name match (never raises).
"""
import json
from unittest.mock import MagicMock, patch

import pytest

from shared import memory_categories as mc
from shared.converse import ConverseResult

CONFIG = [
    {'name': 'technical_support', 'description': 'Technical Support'},
    {'name': 'hardware_quality', 'description': 'Hardware Quality',
     'subcategories': [{'name': 'component_failure', 'description': 'Component failures'}]},
    {'name': 'pricing', 'description': 'Pricing & Plans'},
]
ABOUT_HARDWARE = 'Broken parts are the most frequently reported issue this quarter'


def _model(text: str) -> MagicMock:
    return MagicMock(return_value=ConverseResult(text=text, requested_tier=None, resolved_tier=None))


def _classify(answer: object, statement: str = ABOUT_HARDWARE, given: object = None, config=CONFIG):
    model = _model(answer if isinstance(answer, str) else json.dumps({'categories': answer}))
    with patch.object(mc, 'converse_detailed', model):
        return mc.classify_statement(statement, config, given), model


def test_the_models_ids_are_kept_and_unknown_ones_dropped():
    tags, _ = _classify(['hardware_quality', 'shipping', 'made_up'])
    assert tags == mc.CategoryTags(['hardware_quality'])


@pytest.mark.parametrize('answer', [['Hardware Quality'], ['Component failures'], ['component_failure'],
                                    [' HARDWARE_QUALITY ']])
def test_a_label_or_subcategory_maps_to_its_category_id(answer):
    assert _classify(answer)[0].ids == ['hardware_quality']


def test_the_names_a_statement_contains_are_merged_with_the_answer():
    tags, _ = _classify(['hardware_quality'], statement='Pricing & Plans questions often follow broken parts')
    assert tags.ids == ['hardware_quality', 'pricing']


def test_a_general_statement_gets_no_tags():
    assert _classify([], statement='The company values short weekly updates')[0] == mc.CategoryTags([])


@pytest.mark.parametrize('reply', ['not json', '{"relations": []}', '{"categories": "pricing"}'])
def test_an_unreadable_answer_falls_back_to_the_name_match(reply):
    tags, _ = _classify(reply, statement='Pricing complaints signal churn')
    assert tags == mc.CategoryTags(['pricing'], model_failed=True)


def test_a_model_error_never_raises_and_keeps_the_name_match():
    with patch.object(mc, 'converse_detailed', MagicMock(side_effect=RuntimeError('throttled'))):
        tags = mc.classify_statement('Technical Support replies are slow', CONFIG)
    assert tags == mc.CategoryTags(['technical_support'], model_failed=True)


def test_given_tags_are_validated_like_the_answer():
    tags, _ = _classify([], given=['Pricing & Plans', 'unknown'])
    assert tags.ids == ['pricing']


def test_without_a_config_there_is_no_model_call_and_given_tags_are_kept():
    tags, model = _classify(['x'], given=['Delivery'], config=[])
    assert (tags, model.call_count) == (mc.CategoryTags(['Delivery']), 0)


def test_the_call_is_one_small_memory_surface_call_with_the_closed_list():
    _, model = _classify(['hardware_quality'])
    kwargs = model.call_args.kwargs
    assert (kwargs['surface'], kwargs['max_tokens'], kwargs['step_name'], kwargs['temperature']) == (
        'memory', 300 + 2048, 'memory_categorise', 0.0)
    assert '- Hardware Quality (id: hardware_quality; subcategories: Component failures)' in kwargs['prompt']
    assert f'<statement>\n{ABOUT_HARDWARE}\n</statement>' in kwargs['prompt']


def test_the_rules_say_closed_list_and_no_tags_for_the_company_in_general():
    prompt = mc.CLASSIFY_SYSTEM_PROMPT
    assert ('Never invent a category' in prompt, 'company in general' in prompt, 'DATA block' in prompt) == (
        True, True, True)
