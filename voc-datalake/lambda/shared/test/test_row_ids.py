"""The key-segment validator and the axis-number check both handlers share."""
import pytest

from shared.exceptions import ValidationError
from shared.row_ids import is_clampable_number, validated_row_id


class TestValidatedRowId:
    def test_strips_and_returns_a_usable_id(self):
        assert validated_row_id('  row-1 ') == 'row-1'

    @pytest.mark.parametrize('raw', [None, '', '   ', 7])
    def test_an_absent_or_blank_value_names_the_field(self, raw):
        with pytest.raises(ValidationError, match='row_id is required'):
            validated_row_id(raw)

    def test_the_value_is_never_echoed(self):
        with pytest.raises(ValidationError) as refusal:
            validated_row_id('secret#value')
        assert 'secret' not in refusal.value.message


class TestIsClampableNumber:
    @pytest.mark.parametrize('value', [0, 5, 99, -4, '3', 2.7, '  7 '])
    def test_numbers_and_numeric_strings_are_clampable(self, value):
        assert is_clampable_number(value) is True

    @pytest.mark.parametrize('value', [True, False, float('inf'), float('-inf'), float('nan'),
                                       'high', None, [], {}, '3.5'])
    def test_flags_non_finite_floats_and_non_numbers_are_refused(self, value):
        assert is_clampable_number(value) is False
