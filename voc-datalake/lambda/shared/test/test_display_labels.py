"""Lockstep: ``shared/display_labels.py`` reads ids exactly as ``frontend/src/utils/displayLabels.ts``.

The humanizeId examples and the spelling table are parsed out of the TypeScript files, so a
change on either side without the other fails here.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from shared.display_labels import (
    HOST_PREFIXES,
    SPELLINGS,
    TOP_LEVEL_DOMAINS,
    category_label,
    humanize_id,
    source_label,
    subcategory_label,
)

_UTILS = Path(__file__).resolve().parents[3] / 'frontend' / 'src' / 'utils'
_TS = (_UTILS / 'displayLabels.ts').read_text(encoding='utf-8')
_TS_TEST = (_UTILS / 'displayLabels.test.ts').read_text(encoding='utf-8')


def _ts_humanize_examples() -> list[tuple[str, str]]:
    block = _TS_TEST.split("describe('humanizeId'", 1)[1].split('])(', 1)[0]
    return re.findall(r"\['([^']*)', '([^']*)'\]", block)


def _ts_spellings() -> dict[str, str]:
    block = _TS.split('const SPELLINGS', 1)[1].split('}', 1)[0]
    return dict(re.findall(r"(\w+): '([^']*)'", block))


CATEGORIES = [
    {'name': 'software_firmware', 'description': 'Software & Firmware',
     'subcategories': [{'name': 'firmware_updates', 'description': 'Firmware Updates'}]},
    {'name': 'ease_of_use', 'description': '',
     'subcategories': [{'name': 'installation_setup', 'description': 'Installation & Setup'}]},
    {'name': 'pricing', 'description': 'Everything about price. ' * 5, 'subcategories': []},
]


def test_the_ts_examples_were_found():
    assert len(_ts_humanize_examples()) >= 8


@pytest.mark.parametrize(('value', 'label'), _ts_humanize_examples())
def test_humanize_id_matches_every_ts_example(value, label):
    assert humanize_id(value) == label


def test_the_spelling_table_is_the_ts_one():
    assert dict(SPELLINGS) == _ts_spellings()


def test_category_label_prefers_a_short_configured_name():
    assert category_label('software_firmware', CATEGORIES) == 'Software & Firmware'


def test_category_label_falls_back_like_the_ts_helper():
    assert [category_label('ease_of_use', CATEGORIES), category_label('pricing', CATEGORIES),
            category_label('ux_issues')] == ['Ease of use', 'Pricing', 'UX issues']


def test_subcategory_label_parent_then_anywhere_then_humanised():
    assert [subcategory_label('firmware_updates', 'software_firmware', CATEGORIES),
            subcategory_label('installation_setup', None, CATEGORIES),
            subcategory_label('tac_services', 'software_firmware', CATEGORIES)] == [
        'Firmware Updates', 'Installation & Setup', 'Tac services']


def _ts_source_examples() -> list[tuple[str, str]]:
    block = _TS_TEST.split("describe('sourceLabel'", 1)[1].split('])(', 1)[0]
    return re.findall(r"\['([^']*)', '([^']*)'\]", block)


def _ts_string_set(name: str) -> set[str]:
    block = _TS.split(f'const {name} = new Set([', 1)[1].split('])', 1)[0]
    return set(re.findall(r"'([^']*)'", block))


def test_the_ts_source_examples_were_found():
    assert len(_ts_source_examples()) >= 20


@pytest.mark.parametrize(('value', 'label'), _ts_source_examples())
def test_source_label_matches_every_ts_example(value, label):
    assert source_label(value) == label


def test_the_hostname_tables_are_the_ts_ones():
    assert (set(TOP_LEVEL_DOMAINS), set(HOST_PREFIXES)) == (_ts_string_set('TOP_LEVEL_DOMAINS'),
                                                            _ts_string_set('HOST_PREFIXES'))


def test_source_label_prefers_a_profile_label_ignoring_one_that_repeats_the_id():
    profiles = [{'id': 'web_trustpilot_acme', 'label': 'ACME Airlines'}, {'id': 'radar_example_air', 'label': 'radar_example_air'}]
    assert [source_label('web_trustpilot_acme', profiles), source_label('radar_example_air', profiles),
            source_label('manual_import', profiles)] == ['ACME Airlines', 'Radar example air', 'Manual import']
