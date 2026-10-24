"""Generated text never names a category, subcategory or source by its id (shared/prompt_labels.py)."""
import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from shared.memory_categories import category_guide, category_ids
from shared.prompt_labels import LABEL_INSTRUCTION, PromptLabels
from shared.prompt_labels_store import load_prompt_labels

_LAMBDA = Path(__file__).resolve().parents[2]
CATEGORIES = [
    {'name': 'software_firmware', 'description': 'Software & Firmware',
     'subcategories': [{'name': 'firmware_updates', 'description': 'Firmware Updates'}]},
    {'name': 'ease_of_use', 'description': ''},
]


class TestPromptLabels:
    def test_configured_labels_win_and_the_rest_is_humanised(self):
        labels = PromptLabels(categories=CATEGORIES, profiles=[{'id': 'web_trustpilot_acme', 'label': 'ACME'}])
        assert [labels.category('software_firmware'), labels.category('ease_of_use'), labels.category(None),
                labels.subcategory('firmware_updates', 'software_firmware'), labels.subcategory(None),
                labels.source('web_trustpilot_acme'), labels.source('Acme_android'), labels.source('')] == [
            'Software & Firmware', 'Ease of use', 'Other', 'Firmware Updates', '', 'ACME', 'Acme (Android)', 'Unknown']


class TestLoad:
    def test_reads_the_category_config_and_the_source_profiles(self, monkeypatch):
        import shared.api as api
        import shared.prompt_labels_store as loader

        monkeypatch.setattr(api, '_categories_cache', None)
        table = MagicMock()
        table.get_item.side_effect = lambda Key, **_: {'Item': (
            {'categories': CATEGORIES} if Key['pk'] == 'SETTINGS#categories'
            else {'sources': [{'id': 'zara_ios', 'label': 'Example Air app'}]})}
        labels = loader.load_prompt_labels(table)
        assert (labels.category('software_firmware'), labels.source('zara_ios')) == ('Software & Firmware', 'Example Air app')

    def test_an_unreadable_config_falls_back_to_humanised_ids(self, monkeypatch):
        import shared.prompt_labels_store as loader

        monkeypatch.setattr(loader, 'get_raw_categories_config', MagicMock(side_effect=RuntimeError('boom')))
        assert load_prompt_labels(MagicMock()) == PromptLabels()

    def test_no_table_means_no_read(self, monkeypatch):
        monkeypatch.delenv('AGGREGATES_TABLE', raising=False)
        assert load_prompt_labels() == PromptLabels()


@pytest.mark.parametrize('name', ['persona-generation', 'prd-generation', 'prfaq-generation', 'research-analysis'])
def test_every_generation_step_carries_the_label_instruction(name):
    steps = json.loads((_LAMBDA / 'api' / 'prompts' / f'{name}.json').read_text(encoding='utf-8'))['steps']
    assert [step for step, config in steps.items() if LABEL_INSTRUCTION not in config['system_prompt']] == []


def test_the_inline_project_prompts_carry_the_label_instruction():
    source = (_LAMBDA / 'api' / 'projects.py').read_text(encoding='utf-8')
    assert source.count('+ LABEL_INSTRUCTION + "\\n\\n"') == 3


class TestMemoryCategories:
    def test_the_guide_lists_label_and_id(self):
        assert category_guide(CATEGORIES) == (
            '\n\n<categories>\n- Software & Firmware (id: software_firmware; subcategories: Firmware Updates)\n'
            '- Ease of use (id: ease_of_use)\n'
            '</categories>')

    def test_no_config_no_guide(self):
        assert category_guide([]) == ''

    def test_an_answer_maps_labels_and_ids_to_ids_and_drops_the_rest(self):
        assert category_ids(['Software & Firmware', 'ease_of_use', 'Pricing', 3], CATEGORIES) == [
            'software_firmware', 'ease_of_use']

    def test_without_a_config_the_answer_is_kept(self):
        assert (category_ids(['Delivery'], []), category_ids('x', CATEGORIES)) == (['Delivery'], [])
