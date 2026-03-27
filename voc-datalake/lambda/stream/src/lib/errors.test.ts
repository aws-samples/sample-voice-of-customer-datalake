/**
 * Tests for custom error classes.
 */
import { describe, it, expect } from 'vitest';
import {
  ApiError,
  ValidationError,
  NotFoundError,
  ConfigurationError,
  ServiceError,
  isApiError,
} from './errors.js';

describe('ApiError', () => {
  it('defaults to status code 500', () => {
    const err = new ApiError('something broke');
    expect(err.statusCode).toBe(500);
    expect(err.message).toBe('something broke');
    expect(err.name).toBe('ApiError');
  });

  it('accepts a custom status code', () => {
    const err = new ApiError('bad gateway', 502);
    expect(err.statusCode).toBe(502);
  });

  it('extends Error', () => {
    expect(new ApiError('x')).toBeInstanceOf(Error);
  });
});

describe('ValidationError', () => {
  it('has status code 400', () => {
    const err = new ValidationError('invalid input');
    expect(err.statusCode).toBe(400);
    expect(err.name).toBe('ValidationError');
    expect(err.message).toBe('invalid input');
  });

  it('is an instance of ApiError', () => {
    expect(new ValidationError('x')).toBeInstanceOf(ApiError);
  });
});

describe('NotFoundError', () => {
  it('has status code 404', () => {
    const err = new NotFoundError('not here');
    expect(err.statusCode).toBe(404);
    expect(err.name).toBe('NotFoundError');
  });
});

describe('ConfigurationError', () => {
  it('has status code 500', () => {
    const err = new ConfigurationError('missing env');
    expect(err.statusCode).toBe(500);
    expect(err.name).toBe('ConfigurationError');
  });
});

describe('ServiceError', () => {
  it('has status code 500', () => {
    const err = new ServiceError('bedrock down');
    expect(err.statusCode).toBe(500);
    expect(err.name).toBe('ServiceError');
  });
});

describe('isApiError', () => {
  it('returns true for ApiError instances', () => {
    expect(isApiError(new ApiError('x'))).toBe(true);
    expect(isApiError(new ValidationError('x'))).toBe(true);
    expect(isApiError(new NotFoundError('x'))).toBe(true);
  });

  it('returns false for plain Error', () => {
    expect(isApiError(new Error('x'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isApiError(null)).toBe(false);
    expect(isApiError(undefined)).toBe(false);
    expect(isApiError('string')).toBe(false);
    expect(isApiError(42)).toBe(false);
    expect(isApiError({ statusCode: 400 })).toBe(false);
  });
});
