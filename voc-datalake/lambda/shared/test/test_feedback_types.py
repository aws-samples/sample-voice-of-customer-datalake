"""`shared/feedback_types.py`: the built-in ``feedback_type`` dimension's contract.

The value names are read by the Problems page's Type filter, the SPA's
``feedbackTypes.<value>`` labels and the email-intake aliases, so they are pinned
here exactly, in order.
"""
import pytest

from shared.categorization import MAX_PROMPT_DESCRIPTION_CHARS, build_dimensions_instruction
from shared.dimension_config import DIMENSION_KEY_RE, DIMENSION_VALUE_RE, MAX_LABEL_CHARS, validate_dimensions
from shared.email_intake_settings import ALIASES
from shared.feedback_types import BUILTIN_DIMENSION_KEYS, FEEDBACK_TYPE_KEY, feedback_type_dimension

EXPECTED_VALUES = [
    'bug', 'service_failure', 'feature_request', 'usability', 'performance',
    'pricing_billing', 'support_experience', 'praise', 'question', 'other',
]
VALUES = feedback_type_dimension()['values']


class TestShape:
    def test_the_key_is_feedback_type_and_it_is_the_only_builtin(self):
        assert FEEDBACK_TYPE_KEY == 'feedback_type'
        assert frozenset({'feedback_type'}) == BUILTIN_DIMENSION_KEYS
        assert feedback_type_dimension()['key'] == 'feedback_type'

    def test_the_ten_values_are_exactly_these_in_this_order(self):
        names = [value['name'] for value in feedback_type_dimension()['values']]
        assert names == EXPECTED_VALUES

    def test_it_is_flagged_builtin_and_inferred(self):
        dimension = feedback_type_dimension()
        assert dimension['builtin'] is True
        assert dimension['infer'] is True

    def test_it_has_a_label_and_a_description(self):
        dimension = feedback_type_dimension()
        assert dimension['label'] == 'Feedback type'
        assert dimension['description'].strip()

    def test_it_has_no_parent(self):
        assert 'parent' not in feedback_type_dimension()

    def test_the_fields_are_exactly_the_config_shape_plus_builtin(self):
        assert set(feedback_type_dimension()) == {'key', 'label', 'description', 'infer', 'builtin', 'values'}


class TestValues:
    @pytest.mark.parametrize('value', VALUES, ids=lambda v: v['name'])
    def test_every_value_has_a_label_and_a_description(self, value):
        assert set(value) == {'name', 'label', 'description'}
        assert value['label'].strip()
        assert value['description'].strip()

    @pytest.mark.parametrize('value', VALUES, ids=lambda v: v['name'])
    def test_every_value_name_is_a_valid_dimension_value(self, value):
        assert DIMENSION_VALUE_RE.match(value['name'])
        assert len(value['label']) <= MAX_LABEL_CHARS

    @pytest.mark.parametrize('value', VALUES, ids=lambda v: v['name'])
    def test_every_value_description_fits_the_prompt_bound(self, value):
        assert len(value['description']) <= MAX_PROMPT_DESCRIPTION_CHARS

    def test_the_value_names_are_unique(self):
        names = [value['name'] for value in feedback_type_dimension()['values']]
        assert len(set(names)) == len(names)


class TestDescriptionReachesThePromptWhole:
    def test_the_dimension_description_fits_the_prompt_bound(self):
        assert MAX_PROMPT_DESCRIPTION_CHARS == 300
        assert len(feedback_type_dimension()['description']) <= MAX_PROMPT_DESCRIPTION_CHARS

    def test_the_prompt_line_carries_the_whole_description_and_every_value(self):
        dimension = feedback_type_dimension()
        instruction = build_dimensions_instruction([dimension])
        assert f"- feedback_type ({dimension['description']}): {' | '.join(EXPECTED_VALUES)}" in instruction

    def test_the_description_has_no_characters_the_prompt_would_strip(self):
        description = feedback_type_dimension()['description']
        assert not set(description) & set('{}\n\r\t')


class TestFreshCopy:
    def test_each_call_returns_a_new_equal_object(self):
        first, second = feedback_type_dimension(), feedback_type_dimension()
        assert first == second
        assert first is not second
        assert first['values'] is not second['values']
        assert first['values'][0] is not second['values'][0]

    def test_mutating_one_copy_does_not_change_the_next(self):
        first = feedback_type_dimension()
        first['label'] = 'Changed'
        first['builtin'] = False
        first['values'].append({'name': 'review'})
        first['values'][0]['label'] = 'Changed'
        fresh = feedback_type_dimension()
        assert fresh['label'] == 'Feedback type'
        assert fresh['builtin'] is True
        assert [value['name'] for value in fresh['values']] == EXPECTED_VALUES
        assert fresh['values'][0]['label'] == 'Bug'


class TestOtherContracts:
    def test_the_key_is_a_well_formed_dimension_key(self):
        assert DIMENSION_KEY_RE.match(FEEDBACK_TYPE_KEY)

    def test_validate_dimensions_never_keeps_the_builtin(self):
        assert validate_dimensions([feedback_type_dimension()]) == []

    def test_every_email_alias_type_is_a_builtin_value_or_none(self):
        for alias, value in ALIASES.items():
            assert value is None or value in EXPECTED_VALUES, alias

    def test_the_email_aliases_map_to_these_types(self):
        assert ALIASES == {'feedback': None, 'ideas': 'feature_request', 'bugs': 'bug', 'reviews': None}
