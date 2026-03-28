"""Tests for shared.exceptions module.

Consolidated: one parametrized test for status codes, one for polymorphic catch.
"""

import pytest
from shared.exceptions import (
    ApiError,
    ValidationError,
    NotFoundError,
    ConfigurationError,
    ServiceError,
    AuthorizationError,
    ConflictError,
)


@pytest.mark.parametrize("exc_class,message,expected_status", [
    (ApiError, "Server error", 500),
    (ValidationError, "Field is required", 400),
    (NotFoundError, "Project not found", 404),
    (ConfigurationError, "Table not configured", 500),
    (ServiceError, "DynamoDB failed", 500),
    (AuthorizationError, "Admin access required", 403),
    (ConflictError, "User already exists", 409),
])
def test_exception_has_correct_status_code_and_message(exc_class, message, expected_status):
    """Each exception type maps to the correct HTTP status code and preserves its message."""
    error = exc_class(message)
    assert error.status_code == expected_status
    assert error.message == message
    assert str(error) == message


def test_all_exceptions_catchable_as_api_error():
    """All custom exceptions can be caught via a single ApiError handler."""
    exception_classes = [
        ValidationError,
        NotFoundError,
        ConfigurationError,
        ServiceError,
        AuthorizationError,
        ConflictError,
    ]
    for exc_class in exception_classes:
        error = exc_class("test")
        assert isinstance(error, ApiError), f"{exc_class.__name__} is not an ApiError subclass"
