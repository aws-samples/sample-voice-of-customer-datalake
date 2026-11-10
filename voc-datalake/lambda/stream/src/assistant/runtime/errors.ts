/**
 * Error → AG-UI RUN_ERROR mapping for the assistant runtime.
 *
 * Client-caused errors (4xx) keep their message — it is written for the
 * caller. Everything else is reported with a fixed, generic message: internal
 * text (stack traces, SDK messages, table names) never reaches the stream.
 */
import { ApiError, isApiError } from '../../lib/errors.js';

/** The caller's identity is missing or unusable (fail closed). */
export class UnauthorizedError extends ApiError {
  constructor(message: string) {
    super(message, 401);
    this.name = 'UnauthorizedError';
  }
}

export interface RunErrorPayload {
  message: string;
  code: 'invalid_request' | 'unauthorized' | 'forbidden' | 'throttled' | 'service_error';
}

const GENERIC_MESSAGE = 'The assistant is temporarily unavailable. Please try again.';
const THROTTLED_MESSAGE = 'The AI model is busy right now. Please try again in a moment.';

export function toRunError(err: unknown): RunErrorPayload {
  if (isApiError(err) && err.statusCode < 500) {
    if (err.statusCode === 401) return { message: err.message, code: 'unauthorized' };
    if (err.statusCode === 403) return { message: err.message, code: 'forbidden' };
    return { message: err.message, code: 'invalid_request' };
  }
  if (err instanceof Error && err.name === 'ThrottlingException') {
    return { message: THROTTLED_MESSAGE, code: 'throttled' };
  }
  return { message: GENERIC_MESSAGE, code: 'service_error' };
}

/** True for errors the caller caused (logged at warn, not error). */
export function isClientError(err: unknown): boolean {
  return isApiError(err) && err.statusCode < 500;
}
