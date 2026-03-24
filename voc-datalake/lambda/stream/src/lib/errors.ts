/**
 * Custom exceptions for the streaming chat Lambda.
 *
 * Mirrors the Python shared/exceptions.py hierarchy so error handling
 * is consistent across the Python REST API and the Node.js streaming API.
 *
 * Each error carries a statusCode and a human-readable message.
 * The top-level handler catches these and sends a typed SSE error event.
 */

export class ApiError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

export class ValidationError extends ApiError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends ApiError {
  constructor(message: string) {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

export class ConfigurationError extends ApiError {
  constructor(message: string) {
    super(message, 500);
    this.name = 'ConfigurationError';
  }
}

export class ServiceError extends ApiError {
  constructor(message: string) {
    super(message, 500);
    this.name = 'ServiceError';
  }
}

export class AuthorizationError extends ApiError {
  constructor(message: string) {
    super(message, 403);
    this.name = 'AuthorizationError';
  }
}

export class ConflictError extends ApiError {
  constructor(message: string) {
    super(message, 409);
    this.name = 'ConflictError';
  }
}

/**
 * Type guard to check if an unknown value is an ApiError.
 */
export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}
