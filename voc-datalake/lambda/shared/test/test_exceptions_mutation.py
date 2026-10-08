"""Mutation hardening for `shared/exceptions.py`.

The module is a table: one base class that carries a message, and eight
subclasses whose only content is the HTTP status the api.py handlers answer
with. A mutation run on it found two things `test_exceptions.py` could not see:

* `PayloadTooLargeError.status_code` had no test at all — `413 → 414` and
  `413 → None` both survived. It is the newest row of the table and the one the
  chat and memory handlers raise for an oversized save; the catch-all
  `handle_api_error` answers with `ex.status_code`, so a drifted value is a
  drifted HTTP response. The whole table is now pinned in ONE parametrized test,
  so the next row added without a test is visible as a missing parameter.
* the subclass hierarchy was asserted class by class, and the list in
  `test_can_catch_as_api_error` omitted `SecretUnreadableError` and
  `PayloadTooLargeError`. The hierarchy is the compatibility promise every
  `except ApiError` / `except ConfigurationError` in the Lambdas relies on, so it
  is pinned for every row.

Each class docstring also states its status in prose (``HTTP Status: 413``);
the prose is checked against the attribute so the two cannot drift apart.
"""
import re

import pytest

from shared import exceptions
from shared.exceptions import (
    ApiError,
    AuthorizationError,
    ConfigurationError,
    ConflictError,
    NotFoundError,
    PayloadTooLargeError,
    SecretUnreadableError,
    ServiceError,
    ServiceUnavailableError,
    ValidationError,
)

# The complete table: every public class and the status api.py answers with.
STATUS_TABLE = [
    (ApiError, 500),
    (ValidationError, 400),
    (NotFoundError, 404),
    (ConfigurationError, 500),
    (SecretUnreadableError, 500),
    (ServiceError, 500),
    (AuthorizationError, 403),
    (ConflictError, 409),
    (PayloadTooLargeError, 413),
    (ServiceUnavailableError, 503),
]
ALL_CLASSES = [cls for cls, _ in STATUS_TABLE]


def _positional(*values: str) -> tuple[str, ...]:
    """Arguments of a length the type checker cannot count: the wrong arities ARE the case under test."""
    return values


def _public_exception_classes() -> set[type]:
    return {
        obj
        for name, obj in vars(exceptions).items()
        if not name.startswith('_')
        and isinstance(obj, type)
        and issubclass(obj, Exception)
    }


class TestEveryClassAnswersItsOwnStatus:
    def test_the_table_is_complete(self):
        """A class added to the module without a row here is a status nobody pins."""
        assert {cls for cls, _ in STATUS_TABLE} == _public_exception_classes()

    @pytest.mark.parametrize(('cls', 'status'), STATUS_TABLE, ids=lambda v: getattr(v, '__name__', v))
    def test_status_code_on_the_class_and_the_instance(self, cls, status):
        assert cls.status_code == status
        assert cls('boom').status_code == status
        assert type(cls.status_code) is int

    @pytest.mark.parametrize(
        ('cls', 'status'),
        [row for row in STATUS_TABLE if row[0] is not ApiError],
        ids=lambda v: getattr(v, '__name__', v),
    )
    def test_the_docstring_states_the_same_status(self, cls, status):
        """`HTTP Status: NNN` in each subclass docstring is the only place a reader
        learns the status without opening api.py; it must match the attribute.
        (The base class documents the attribute itself, not a number.)"""
        match = re.search(r'HTTP Status: (\d+)', cls.__doc__)
        assert match is not None, f'{cls.__name__} docstring names no HTTP status'
        assert int(match.group(1)) == status


class TestTheMessageIsCarriedTwice:
    """`.message` is what the api.py handlers serialize; `str()`/`.args` is what a
    log line or an unhandled traceback shows. Both must be the one string given."""

    @pytest.mark.parametrize('cls', ALL_CLASSES, ids=lambda c: c.__name__)
    def test_message_str_and_args(self, cls):
        error = cls('Project not found')
        assert error.message == 'Project not found'
        assert str(error) == 'Project not found'
        assert error.args == ('Project not found',)

    def test_message_is_the_only_constructor_argument(self):
        with pytest.raises(TypeError):
            ApiError(*_positional())
        with pytest.raises(TypeError):
            ApiError(*_positional('a', 'b'))


class TestEveryRowIsAnApiError:
    @pytest.mark.parametrize('cls', ALL_CLASSES, ids=lambda c: c.__name__)
    def test_catchable_as_api_error_and_exception(self, cls):
        with pytest.raises(ApiError) as caught:
            raise cls('x')
        assert caught.type is cls
        assert issubclass(cls, Exception)

    def test_direct_parent_of_each_row(self):
        """Pins the shape of the tree: every row hangs off ApiError except
        SecretUnreadableError, which must stay under ConfigurationError so the
        existing `except ConfigurationError` sites keep catching it."""
        parents = {cls: cls.__mro__[1] for cls, _ in STATUS_TABLE}
        assert parents == {
            ApiError: Exception,
            ValidationError: ApiError,
            NotFoundError: ApiError,
            ConfigurationError: ApiError,
            SecretUnreadableError: ConfigurationError,
            ServiceError: ApiError,
            AuthorizationError: ApiError,
            ConflictError: ApiError,
            PayloadTooLargeError: ApiError,
            ServiceUnavailableError: ApiError,
        }

    def test_siblings_do_not_catch_each_other(self):
        """A 404 must never be swallowed by a 400 handler (and so on): no two
        leaf classes are related, so `except NotFoundError` sees only its own."""
        leaves = [cls for cls, _ in STATUS_TABLE if cls not in (ApiError, ConfigurationError)]
        for a in leaves:
            for b in leaves:
                if a is not b:
                    assert not issubclass(a, b), f'{a.__name__} would be caught by except {b.__name__}'
