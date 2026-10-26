"""shared/plan_canonical.py — what the mutation run found that the fingerprint fixtures could not see.

The shared TypeScript fixtures pin whole canonical texts, but none of them sits on a boundary of
ECMAScript ``Number#toString`` (one integer digit before the point, ``1e21``, ``1e-7``), on ``-0``, on an
integer one past ``2**53``, on ``true``, or on the message of a refusal. Each case below is the exact text
``String(n)`` / ``JSON.stringify`` writes in JavaScript.
"""

from decimal import Decimal

import pytest

from shared.plan_canonical import CanonicalJsonError, canonical_json


class TestNumbersPrintLikeEcmascript:
    @pytest.mark.parametrize(('value', 'expected'), [
        (0, '0'),
        (0.0, '0'),
        (-0.0, '0'),
        (7, '7'),
        (-7, '-7'),
        (123.0, '123'),
        (-0.5, '-0.5'),
        (0.5, '0.5'),
        (1.5, '1.5'),
        (12.25, '12.25'),
        (1e20, '100000000000000000000'),
        (1e21, '1e+21'),
        (1.25e22, '1.25e+22'),
        (1e-6, '0.000001'),
        (1.5e-6, '0.0000015'),
        (1e-7, '1e-7'),
        (-2.5e-8, '-2.5e-8'),
        (5e-324, '5e-324'),
        (1.7976931348623157e308, '1.7976931348623157e+308'),
    ])
    def test_float_and_int(self, value, expected):
        assert canonical_json(value) == expected

    @pytest.mark.parametrize(('value', 'expected'), [
        (2 ** 53 - 1, '9007199254740991'),
        (2 ** 53, '9007199254740992'),
        (2 ** 53 + 1, '9007199254740992'),
        (-(2 ** 53 + 1), '-9007199254740992'),
        (10 ** 21, '1e+21'),
    ])
    def test_integers_beyond_two_to_the_53_print_as_the_rounded_double(self, value, expected):
        assert canonical_json(value) == expected

    def test_decimals_follow_the_same_rules(self):
        assert canonical_json([Decimal(9007199254740993), Decimal('-0.5'), Decimal('1E-7')]) == '[9007199254740992,-0.5,1e-7]'


class TestScalars:
    def test_booleans_and_null(self):
        assert canonical_json([True, False, None]) == '[true,false,null]'


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize(('value', 'message'), [
        (float('inf'), 'non-finite number'),
        (float('-inf'), 'non-finite number'),
        ('a\udc00', 'lone surrogate in a string'),
        ({'k': 1, 2: 'x'}, 'object keys must be strings'),
        ({1, 2}, 'no canonical form for set'),
        (b'x', 'no canonical form for bytes'),
    ])
    def test_message(self, value, message):
        with pytest.raises(CanonicalJsonError) as raised:
            canonical_json(value)
        assert str(raised.value) == message
