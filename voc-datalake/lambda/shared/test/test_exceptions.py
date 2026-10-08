"""Tests for shared.exceptions module.

The per-class status codes, the `.message` carriage of every subclass and the
"every row is an ApiError" promise are pinned once, as a table, in
`test_exceptions_mutation.py`; this file keeps the tests whose text explains WHY
the module is shaped the way it is.
"""

import pytest

from shared.exceptions import (
    ApiError,
    ConfigurationError,
    NotFoundError,
    SecretUnreadableError,
)


class TestApiError:
    """Tests for base ApiError class."""

    def test_has_message(self):
        error = ApiError('Something went wrong')
        assert error.message == 'Something went wrong'
        assert str(error) == 'Something went wrong'

    def test_default_status_code(self):
        error = ApiError('Error')
        assert error.status_code == 500


class TestSecretUnreadableError:
    """Tests for SecretUnreadableError."""

    def test_inherits_from_configuration_error(self):
        """The subclassing is the compatibility promise, not an implementation
        detail: `BaseIngestor.__init__` and every plugin handler catch
        `ConfigurationError`, so a sibling type would escape all of them and turn a
        handled misconfiguration into an unhandled crash. It is also why no separate
        `@app.exception_handler` is registered — Powertools resolves one by walking
        the MRO, so the ConfigurationError handler already returns this 500."""
        error = SecretUnreadableError('Throttled')
        assert isinstance(error, ConfigurationError)
        assert error.status_code == 500


class TestExceptionRaising:
    """Tests for raising and catching exceptions."""

    def test_can_catch_as_exception(self):
        """All custom exceptions can be caught as base Exception."""
        with pytest.raises(Exception, match=r'^test$') as raised:
            raise NotFoundError('test')
        assert raised.type is NotFoundError
