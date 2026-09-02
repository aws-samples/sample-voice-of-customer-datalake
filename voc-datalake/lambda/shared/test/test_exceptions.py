"""Tests for shared.exceptions module."""

import pytest
from shared.exceptions import (
    ApiError,
    ValidationError,
    NotFoundError,
    ConfigurationError,
    SecretUnreadableError,
    ServiceError,
    AuthorizationError,
    ConflictError,
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


class TestValidationError:
    """Tests for ValidationError."""
    
    def test_status_code_is_400(self):
        error = ValidationError('Field is required')
        assert error.status_code == 400
    
    def test_inherits_from_api_error(self):
        error = ValidationError('Invalid input')
        assert isinstance(error, ApiError)
    
    def test_message_preserved(self):
        error = ValidationError('Email format is invalid')
        assert error.message == 'Email format is invalid'


class TestNotFoundError:
    """Tests for NotFoundError."""
    
    def test_status_code_is_404(self):
        error = NotFoundError('Project not found')
        assert error.status_code == 404
    
    def test_inherits_from_api_error(self):
        error = NotFoundError('Resource missing')
        assert isinstance(error, ApiError)


class TestConfigurationError:
    """Tests for ConfigurationError."""
    
    def test_status_code_is_500(self):
        error = ConfigurationError('Table not configured')
        assert error.status_code == 500
    
    def test_inherits_from_api_error(self):
        error = ConfigurationError('Missing env var')
        assert isinstance(error, ApiError)


class TestSecretUnreadableError:
    """Tests for SecretUnreadableError."""

    def test_status_code_is_500(self):
        error = SecretUnreadableError('Secret could not be read')
        assert error.status_code == 500

    def test_inherits_from_configuration_error(self):
        """The subclassing is the compatibility promise, not an implementation
        detail: `BaseIngestor.__init__` and every plugin handler catch
        `ConfigurationError`, so a sibling type would escape all of them and turn a
        handled misconfiguration into an unhandled crash. It is also why no separate
        `@app.exception_handler` is registered — Powertools resolves one by walking
        the MRO, so the ConfigurationError handler already returns this 500."""
        error = SecretUnreadableError('Throttled')
        assert isinstance(error, ConfigurationError)

    def test_inherits_from_api_error(self):
        error = SecretUnreadableError('Throttled')
        assert isinstance(error, ApiError)


class TestServiceError:
    """Tests for ServiceError."""

    def test_status_code_is_500(self):
        error = ServiceError('DynamoDB operation failed')
        assert error.status_code == 500
    
    def test_inherits_from_api_error(self):
        error = ServiceError('External service down')
        assert isinstance(error, ApiError)


class TestAuthorizationError:
    """Tests for AuthorizationError."""
    
    def test_status_code_is_403(self):
        error = AuthorizationError('Admin access required')
        assert error.status_code == 403
    
    def test_inherits_from_api_error(self):
        error = AuthorizationError('Insufficient permissions')
        assert isinstance(error, ApiError)


class TestConflictError:
    """Tests for ConflictError."""
    
    def test_status_code_is_409(self):
        error = ConflictError('User already exists')
        assert error.status_code == 409
    
    def test_inherits_from_api_error(self):
        error = ConflictError('Duplicate resource')
        assert isinstance(error, ApiError)


class TestExceptionRaising:
    """Tests for raising and catching exceptions."""
    
    def test_can_catch_specific_exception(self):
        with pytest.raises(ValidationError) as exc_info:
            raise ValidationError('Test error')
        assert exc_info.value.message == 'Test error'
    
    def test_can_catch_as_api_error(self):
        """All custom exceptions can be caught as ApiError."""
        exceptions = [
            ValidationError('validation'),
            NotFoundError('not found'),
            ConfigurationError('config'),
            ServiceError('service'),
            AuthorizationError('auth'),
            ConflictError('conflict'),
        ]
        
        for exc in exceptions:
            with pytest.raises(ApiError):
                raise exc
    
    def test_can_catch_as_exception(self):
        """All custom exceptions can be caught as base Exception."""
        with pytest.raises(Exception):
            raise NotFoundError('test')
