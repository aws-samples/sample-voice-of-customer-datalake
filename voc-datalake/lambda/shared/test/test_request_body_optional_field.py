"""`shared.request_body.optional_field`: an optional bounded field is its value, None when absent or null,
and the caller's own refusal otherwise (the widget dimensions, `base_etag` and MCP board fields use it)."""
from typing import TypeGuard

import pytest

from shared.exceptions import ValidationError
from shared.request_body import optional_field


def _short_text(value: object) -> TypeGuard[str]:
    return isinstance(value, str) and len(value) <= 3


def _refuse() -> ValidationError:
    return ValidationError('tag must be at most 3 characters')


@pytest.mark.parametrize('body', [{}, {'tag': None}])
def test_returns_none_when_the_field_is_absent_or_null(body):
    assert optional_field(body, 'tag', _short_text, _refuse) is None


@pytest.mark.parametrize('value', ['', 'abc'])
def test_returns_a_value_that_fits_as_it_is(value):
    assert optional_field({'tag': value}, 'tag', _short_text, _refuse) == value


@pytest.mark.parametrize('value', ['abcd', 7, ['a'], False])
def test_raises_the_callers_refusal_for_a_value_that_does_not_fit(value):
    with pytest.raises(ValidationError, match='at most 3 characters'):
        optional_field({'tag': value}, 'tag', _short_text, _refuse)


def test_raises_whatever_exception_the_caller_builds():
    with pytest.raises(LookupError, match='nope'):
        optional_field({'tag': 'toolong'}, 'tag', _short_text, lambda: LookupError('nope'))
