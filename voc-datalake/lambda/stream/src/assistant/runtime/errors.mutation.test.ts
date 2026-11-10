/**
 * Error mapping pins the mutation run found missing: the earlier specs matched
 * the codes only, so the two fixed user-facing messages, the error's `name`,
 * a non-Error value carrying a ThrottlingException name, and every branch of
 * `isClientError` (which decides warn vs error logging) could change unseen.
 */
import { describe, expect, it } from 'vitest';
import { ApiError, ServiceError, ValidationError } from '../../lib/errors.js';
import { UnauthorizedError, isClientError, toRunError } from './errors.js';

const named = (name: string): Error => Object.assign(new Error('internal detail'), { name });

describe('UnauthorizedError', () => {
  it('is a 401 named UnauthorizedError', () => {
    const err = new UnauthorizedError('who');
    expect(err.name).toBe('UnauthorizedError');
    expect(err.statusCode).toBe(401);
  });
});

describe('toRunError — fixed messages never leak internal text', () => {
  it('reports a Bedrock throttle with the busy message', () => {
    expect(toRunError(named('ThrottlingException'))).toStrictEqual({
      message: 'The AI model is busy right now. Please try again in a moment.',
      code: 'throttled',
    });
  });

  it.each([
    ['a 500 ApiError', new ServiceError('table voc-feedback missing')],
    ['another Error', named('InternalServerException')],
    ['a non-Error with a throttle name', { name: 'ThrottlingException' }],
    ['null', null],
  ])('reports %s with the generic message', (_label, err) => {
    expect(toRunError(err)).toStrictEqual({
      message: 'The assistant is temporarily unavailable. Please try again.',
      code: 'service_error',
    });
  });
});

describe('isClientError — only an ApiError below 500', () => {
  it.each<[string, unknown, boolean]>([
    ['400', new ValidationError('bad'), true],
    ['499', new ApiError('gone', 499), true],
    ['500', new ApiError('boom', 500), false],
    ['a plain Error', new Error('x'), false],
    ['a plain object with a 4xx status', { statusCode: 400 }, false],
  ])('%s → %s', (_label, err, expected) => {
    expect(isClientError(err)).toBe(expected);
  });
});
