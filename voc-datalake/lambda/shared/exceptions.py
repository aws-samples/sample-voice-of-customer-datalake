"""
Custom exceptions for VoC API error handling.

These exceptions are caught by the exception handler middleware in api.py
and converted to consistent HTTP error responses.

Usage:
    from shared.exceptions import NotFoundError, ValidationError
    
    raise NotFoundError('Project not found')
    raise ValidationError('Message is required')
"""


class ApiError(Exception):
    """Base exception for all API errors.
    
    Attributes:
        message: Human-readable error message
        status_code: HTTP status code to return
    """
    status_code: int = 500
    
    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


class ValidationError(ApiError):
    """Raised when request validation fails.
    
    Examples:
        - Missing required fields
        - Invalid field values
        - Constraint violations
    
    HTTP Status: 400 Bad Request
    """
    status_code = 400


class NotFoundError(ApiError):
    """Raised when a requested resource doesn't exist.
    
    Examples:
        - Project not found
        - Document not found
        - Persona not found
        - Job not found
    
    HTTP Status: 404 Not Found
    """
    status_code = 404


class ConfigurationError(ApiError):
    """Raised when required configuration is missing.
    
    Examples:
        - Environment variable not set
        - DynamoDB table not configured
        - S3 bucket not configured
    
    HTTP Status: 500 Internal Server Error
    """
    status_code = 500


class ServiceError(ApiError):
    """Raised when an external service call fails.
    
    Examples:
        - DynamoDB operation failed
        - Bedrock API error
        - S3 operation failed
        - SQS send failed
    
    HTTP Status: 500 Internal Server Error
    """
    status_code = 500


class AuthorizationError(ApiError):
    """Raised when user lacks permission for an action.
    
    Examples:
        - User not in admin group
        - Insufficient permissions
    
    HTTP Status: 403 Forbidden
    """
    status_code = 403


class ConflictError(ApiError):
    """Raised when there's a conflict with existing state.
    
    Examples:
        - User already exists
        - Duplicate resource
    
    HTTP Status: 409 Conflict
    """
    status_code = 409
