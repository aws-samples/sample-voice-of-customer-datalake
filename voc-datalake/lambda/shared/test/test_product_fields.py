"""The product context's fields (shared/product_fields.py): the twelve fields and the PRD / PR-FAQ block's labels, the
summary's cap and a patch value's cleaning, and the TypeScript copy the assistant's card, the plan contract and the
Product tab's form read (lambda/stream/src/assistant/tools/client/allowlists.ts), read as source text and pinned here.
Every other cap is pinned as a literal by api/test/test_product_context_mutation.py (``FIELD_CAPS``)."""
from __future__ import annotations

import re

import pytest

from shared.product_fields import (
    ALL_FIELDS,
    CURRENT_STATE,
    FIELD_LABELS,
    LIFECYCLE_STATES,
    STRING_FIELDS,
    clean_patch_value,
)
from shared.test.repo_paths import repo_root

ALLOWLISTS = 'lambda/stream/src/assistant/tools/client/allowlists.ts'
#: The PRD / PR-FAQ block's order of the fields.
BLOCK_ORDER = [
    'product_name', 'one_liner', 'product_summary', 'current_state', 'target_users', 'problem_solved',
    'key_features', 'differentiators', 'known_limitations', 'non_goals', 'success_metrics', 'free_form_notes',
]


def _allowlists_source() -> str:
    return (repo_root() / ALLOWLISTS).read_text(encoding='utf-8')


def _ts_string_fields() -> dict[str, int]:
    match = re.search(r'export const PRODUCT_CONTEXT_STRING_FIELDS = \{(.*?)\} as const;', _allowlists_source(),
                      re.DOTALL)
    assert match, f'PRODUCT_CONTEXT_STRING_FIELDS not found in {ALLOWLISTS}'
    return {name: int(cap) for name, cap in re.findall(r'(\w+): (\d+),', match.group(1))}


def _ts_lifecycle_states() -> tuple[str, ...]:
    match = re.search(r'export const LIFECYCLE_STATES = \[(.*?)\] as const;', _allowlists_source(), re.DOTALL)
    assert match, f'LIFECYCLE_STATES not found in {ALLOWLISTS}'
    return tuple(re.findall(r"'(\w+)'", match.group(1)))


class TestTheFields:
    def test_twelve_fields_the_text_ones_and_the_lifecycle_state(self):
        assert ALL_FIELDS == set(BLOCK_ORDER) == {*STRING_FIELDS, 'current_state'}
        assert CURRENT_STATE == 'current_state'
        assert LIFECYCLE_STATES == ('idea', 'mvp', 'beta', 'ga', 'mature')

    def test_the_summary_takes_3000_characters(self):
        assert STRING_FIELDS['product_summary'] == 3000

    def test_the_field_list_cannot_be_changed_at_run_time(self):
        with pytest.raises(TypeError):
            STRING_FIELDS['pricing'] = 100  # pyright: ignore[reportIndexIssue]

    def test_every_field_has_one_label_in_the_block_order(self):
        assert [field for field, _label in FIELD_LABELS] == BLOCK_ORDER
        assert dict(FIELD_LABELS)['product_summary'] == 'What it does'


class TestCleanPatchValue:
    def test_the_summary_is_cut_to_its_cap(self):
        assert clean_patch_value('product_summary', 'a' * 3001) == 'a' * 3000
        assert clean_patch_value('product_summary', 'a' * 3000) == 'a' * 3000

    def test_a_null_clears_a_text_field_and_a_non_string_is_dropped(self):
        assert clean_patch_value('product_summary', None) == ''
        assert clean_patch_value('product_summary', ['a']) is None

    @pytest.mark.parametrize('state', ['idea', 'mvp', 'beta', 'ga', 'mature'])
    def test_every_lifecycle_state_is_kept(self, state):
        assert clean_patch_value('current_state', state) == state

    @pytest.mark.parametrize('state', ['GA', '', None, ['ga'], {'state': 'ga'}])
    def test_any_other_state_is_dropped_never_a_crash(self, state):
        assert clean_patch_value('current_state', state) is None


class TestTheTypeScriptCopy:
    def test_the_source_parses(self):
        """The positive control (shared/test/repo_paths.py): the TypeScript copy is there and both constants parse."""
        assert _ts_string_fields()
        assert _ts_lifecycle_states()

    def test_the_text_fields_and_their_caps_are_the_same(self):
        assert _ts_string_fields() == dict(STRING_FIELDS)

    def test_the_lifecycle_states_are_the_same_in_the_same_order(self):
        assert _ts_lifecycle_states() == LIFECYCLE_STATES
